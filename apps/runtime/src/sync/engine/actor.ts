import {
  endpointSpacingRemainingMs,
  ensurePollRows,
  getSyncPage,
  LiveGateClosedError,
  lockOwnedPage,
  nextOpenWorkDueAt,
  OwnershipLostError,
  pickCredentialsCheck,
  pickPlanned,
  pickRequests,
  pickUrgent,
  SYNC_WORK_PICK_LIMIT,
  type Database,
  type SyncPageMode,
  type SyncPageRow,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import { activeFanslyPageHold, verifyAdmittedUnderCredentialsHold } from "@agency_hub_core/shared";

import {
  AdmissionHeldError,
  admit,
  apply,
  applyLocal,
  capture,
  commitNoHttp,
  deferAfterPlanError,
  deferForEndpointSpacing,
  drainDueApplies,
  ensureCredentialsVerify,
  errorName,
  markSentBestEffort,
  recoverUnfinished,
  settleNotSent,
  settleShadow,
  SyncCrashFault,
  type AdmissionRecord,
  type CommitDeps,
  type PickedWork,
  type RequestTurn,
  type SyncFaultPoint,
} from "./commit.ts";
import {
  activeResourceHold,
  CREDENTIALS_CHECK_KEYS,
  endpointRateGroupOfKind,
  endpointRateGroupOfRoute,
  isEndpointRateLimitKind,
  isResourceHoldExempt,
  resourceFileOf,
  type ResourceHoldEntry,
} from "./errors.ts";
import { PacerStoppedError, type Admission, type Pacer, type SlotGrant } from "./pacer.ts";
import {
  CredentialsGenerationChangedError,
  UnsendableRequestError,
  type LivePageSocketRef,
  type OwnershipSession,
  type TransportOutcome,
  type Wake,
} from "./ports.ts";
import {
  pollsFor,
  resourceDisabled,
  runsIn,
  WAIT_RECHECK_MS,
  type EngineRegistry,
  type ResourceModule,
  type ShadowResult,
  type StepPlan,
} from "./resource.ts";
import { CYCLE, pick, type ClassWorkSource, type WorkClass } from "./scheduler.ts";
import type { PageTransport } from "./shadow.ts";

// One page's actor (plan §3, §8; design §3.5): recover → loop (plan → admit →
// send → capture → apply). Strictly sequential: capture and apply of step k
// finish before the slot wait of step k+1 (I2 by construction; both take
// ≪ 100 ms against a pause ≥ 2 s). The actor is the page's only sender while it
// runs; whatever it learns about the world it reads from the database on every
// lap, so a lost NOTIFY costs at most a second.
//
// It leaves its loop when it is told to stop (shutdown, mode change), when its
// ownership is gone (the lock session ended, or a commit met a foreign
// generation), or when a commit after a send keeps failing. A request already
// in flight is always awaited and committed first; the host writes the safe
// release once the actor has returned (design §3.6 "Ownership loss").

/** An actor re-reads the database at least this often while idle (§8). */
export const ACTOR_IDLE_WAIT_MS = 1_000;
/** Poll rows of the registry are re-ensured this often (§4.2). */
export const POLL_ROWS_EVERY_MS = 60_000;
/** Due applies taken per lap; a failing one never blocks the page (§3.7.3). */
export const APPLIES_PER_LAP = 5;
/** The lock-session liveness ping before a live admission (§3.5). */
export const PING_TIMEOUT_MS = 2_000;
/** A commit after a send is retried this many times before the actor gives
 *  up (the host restarts it; recovery then closes the attempt `unknown`). */
export const COMMIT_ATTEMPTS = 3;
/** The wait after a failure that admitted nothing. */
export const FAILURE_BACKOFF_MS = 1_000;
/** A live page whose gates are closed re-checks this often (I17). */
export const LIVE_GATE_RECHECK_MS = 5_000;

/** Routes the page's captured WS receipts into shadow demand, once per lap
 *  (design §3.12, S2-10); the only writer of `ws_router_cursor`. */
export type ShadowFeed = (d: CommitDeps) => Promise<void>;

export interface ActorDeps extends CommitDeps {
  pacer: Pacer;
  transport: PageTransport;
  ownership: OwnershipSession;
  wake: Wake;
  shadowFeed?: ShadowFeed;
  /** The live page's socket owner (`ws.connect` plans by its state); absent
   *  in shadow and where no socket owner runs. */
  socket?: LivePageSocketRef;
}

export type ActorExit =
  | { kind: "stopped" }
  /** The lock session ended (`foreign: false`: this generation is still the
   *  page's and may be released), or a commit met a newer generation. */
  | { kind: "ownership_lost"; foreign: boolean }
  | { kind: "mode_changed"; mode: SyncPageMode | null }
  /** A commit kept failing (database unavailable) after a send. */
  | { kind: "failed"; error: string };

export interface ActorSignals {
  /** No new step after the current one (shutdown, mode change). */
  stop: AbortSignal;
  /** Cancel the request in flight (the shutdown budget ran out). */
  abort: AbortSignal;
}

type Committed<T> = { ok: true; value: T } | { ok: false; exit: ActorExit };

function exitOf(committed: Committed<unknown>): ActorExit | null {
  return committed.ok ? null : committed.exit;
}

type Gate =
  /** `checks`: a credentials hold is in force; only the identity checks it
   *  admits may take the slot — a candidate check (E16) and, with `verify`,
   *  the verify of changed stored credentials (A3). */
  | { open: true; page: SyncPageRow; checks: { verify: boolean } | null }
  | { open: false; waitMs: number }
  | { open: false; exit: ActorExit };

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
}

export class SyncActor {
  readonly #d: ActorDeps;
  #lastPollsMono = Number.NEGATIVE_INFINITY;
  /** Steps admitted by this actor (tests, status). */
  admissions = 0;

  constructor(deps: ActorDeps) {
    this.#d = deps;
  }

  get deps(): ActorDeps {
    return this.#d;
  }

  /** Run until stopped, ownership is lost, the mode changes or a commit after
   *  a send keeps failing. A `SyncCrashFault` (tests) rejects. */
  async run(signals: ActorSignals): Promise<ActorExit> {
    const d = this.#d;
    try {
      await recoverUnfinished(d);
    } catch (error) {
      if (error instanceof OwnershipLostError) return { kind: "ownership_lost", foreign: true };
      throw error;
    }
    for (;;) {
      if (signals.stop.aborted) return { kind: "stopped" };
      if (!d.ownership.alive()) return { kind: "ownership_lost", foreign: false };
      try {
        const exit = await this.#lap(signals);
        if (exit !== null) return exit;
      } catch (error) {
        if (error instanceof SyncCrashFault) throw error;
        if (error instanceof OwnershipLostError) return { kind: "ownership_lost", foreign: true };
        if (error instanceof PacerStoppedError) return { kind: "ownership_lost", foreign: false };
        if (isAbort(error, signals.stop)) return { kind: "stopped" };
        // Nothing was admitted on this path: log, back off, go on.
        d.metrics.increment("sync_actor_errors", { error: errorName(error) });
        d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync actor: lap failed before an admission");
        await this.#sleep(FAILURE_BACKOFF_MS, signals.stop);
      }
    }
  }

  async #lap(signals: ActorSignals): Promise<ActorExit | null> {
    const d = this.#d;
    const shadow = d.mode === "shadow";
    await drainDueApplies(d, APPLIES_PER_LAP);
    if (shadow && d.shadowFeed !== undefined) {
      try {
        await d.shadowFeed(d);
      } catch (error) {
        if (error instanceof OwnershipLostError) throw error;
        d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync shadow: the WS demand feed failed");
      }
    }
    if (d.clock.monoNow() - this.#lastPollsMono >= POLL_ROWS_EVERY_MS) await this.#ensurePolls();

    const gate = await this.#gate();
    if (!gate.open) {
      if ("exit" in gate) return gate.exit;
      await d.wake.wait(d.pageId, Math.max(0, Math.min(gate.waitMs, ACTOR_IDLE_WAIT_MS)), signals.stop);
      return null;
    }

    let grant: SlotGrant;
    try {
      grant = await d.pacer.waitForSlot(signals.stop);
    } catch (error) {
      if (isAbort(error, signals.stop)) return { kind: "stopped" };
      throw error;
    }
    if (signals.stop.aborted) return { kind: "stopped" };
    // The work is chosen at the slot: re-read the page (cycle pointer, pauses,
    // holds) now, not before the wait.
    const page = await getSyncPage(d.db, d.pageId);
    if (page === null) return { kind: "mode_changed", mode: null };
    const now = d.clock.wallNow();
    const held = activeFanslyPageHold(page, now);
    const underCredentials = gate.checks !== null && held !== null && held.credentials !== null && held.timed === null;
    // G2 from the database, never from memory: while the stored credentials
    // are not the ones the engine trusts, only the identity checks go out.
    const checksOnly = !underCredentials && !shadow && await this.#checksOnly(page);
    const exclusions = pickExclusions(page, d.registry, shadow, now, { checksOnly });
    const picked = underCredentials
      ? await this.#pickCredentialsCheck(page, gate.checks?.verify === true)
      : await this.#pick(page, now, exclusions);
    if (picked === null && checksOnly && await ensureCredentialsVerify(d, "credentials_changed")) return null;
    if (picked === null) {
      // Idle until the next work this pick could take: a paused, switched-off
      // or held row is never "due" here, or the actor would lap without
      // sleeping for as long as it stays so.
      const due = await nextOpenWorkDueAt(d.db, { pageId: d.pageId, shadow, ...exclusions });
      const untilDue = due === null ? ACTOR_IDLE_WAIT_MS : due.getTime() - now.getTime();
      await d.wake.wait(d.pageId, Math.max(0, Math.min(untilDue, ACTOR_IDLE_WAIT_MS)), signals.stop);
      return null;
    }

    const module = await d.registry.module(picked.work.resource);
    let plan: StepPlan;
    try {
      plan = await module.plan(picked.work, {
        db: d.db,
        pageId: d.pageId,
        shadow,
        now,
        page,
        registry: d.registry,
        ...(d.settings === undefined ? {} : { settings: d.settings }),
        ...(shadow || d.socket === undefined ? {} : { socket: d.socket() }),
      });
    } catch (error) {
      await deferAfterPlanError(d, picked.work, error);
      return null;
    }
    if (plan.kind === "local") {
      // A write without a request (design §3.3 item 3): picked at a slot like
      // any work, but nothing is admitted or sent, so the slot stays open.
      await applyLocal(d, picked.work, module);
      return null;
    }
    if (plan.kind !== "request") {
      await commitNoHttp(d, picked.work, plan);
      return null;
    }
    // Owner decision №20: an endpoint group with a quota of its own (the
    // media statistics) takes at most one request per its spacing on this
    // page, on top of the pause S — whatever key, demand or restart asks.
    // Nothing is admitted; the slot stays open for other work.
    const spacedUntil = await this.#endpointSpacedUntil(plan.request.spec, now);
    if (spacedUntil !== null) {
      d.metrics.increment("sync_endpoint_spaced", { resource: picked.work.resource, shadow });
      await deferForEndpointSpacing(d, picked.work, spacedUntil);
      return null;
    }

    if (!shadow && (await d.ownership.ping(PING_TIMEOUT_MS)) === "timeout") {
      // A slow lock session is not a lost one: skip this admission (nothing
      // was written) unless the lock is provably gone.
      d.metrics.increment("sync_ping_timeouts", { pageId: d.pageId });
      if (!(await d.ownership.stillHolds(d.pageId))) return { kind: "ownership_lost", foreign: false };
      return null;
    }

    let request: Awaited<ReturnType<PageTransport["prepare"]>>;
    try {
      request = await d.transport.prepare(plan.request, { work: picked.work });
    } catch (error) {
      if (error instanceof CredentialsGenerationChangedError) {
        await this.#credentialsUnverified(error, signals.stop);
        return null;
      }
      if (!(error instanceof UnsendableRequestError)) throw error;
      // Nothing can ever send it (no secret, a host the engine never calls):
      // the work closes with that answer, nothing is admitted.
      d.metrics.increment("sync_unsendable", { resource: picked.work.resource, reason: error.reason });
      await commitNoHttp(d, picked.work, { kind: "done", reason: error.reason, result: error.result });
      return null;
    }
    // The send window starts BEFORE the admission commit (SK16).
    const issuedMono = d.clock.monoNow();
    let admission: AdmissionRecord | null;
    try {
      admission = await admit(d, picked, plan.request, grant, module, request);
    } catch (error) {
      if (error instanceof LiveGateClosedError) {
        d.metrics.increment("sync_live_gate_closed", { pageId: d.pageId, reason: error.reason });
        await this.#sleep(LIVE_GATE_RECHECK_MS, signals.stop);
        return null;
      }
      if (error instanceof AdmissionHeldError) {
        // A hold written after the gate looked: the next lap waits for it.
        d.metrics.increment("sync_admission_page_held", { pageId: d.pageId, kind: error.kind });
        const untilMs = error.until.getTime() - d.clock.wallNow().getTime();
        await d.wake.wait(d.pageId, Math.max(0, Math.min(untilMs, ACTOR_IDLE_WAIT_MS)), signals.stop);
        return null;
      }
      throw error;
    }
    if (admission === null) return null;
    this.admissions += 1;
    await this.#fault("after_admit");

    const armed = d.pacer.arm(grant, admission.attemptId, issuedMono);
    const outcome = await this.#send(request, armed, signals.abort);
    d.pacer.complete(armed, outcome);
    await this.#fault("after_send");
    return this.#commitOutcome(admission, armed, outcome, module, page);
  }

  async #send(
    request: Awaited<ReturnType<PageTransport["prepare"]>>,
    armed: Admission,
    abort: AbortSignal,
  ): Promise<TransportOutcome> {
    const d = this.#d;
    try {
      return await d.transport.send(request, {
        check: () => {
          const refusal = d.pacer.check(armed);
          if (refusal === null && d.mode === "live" && armed.sentWall !== null) {
            markSentBestEffort(d, armed.attemptId, armed.sentWall);
          }
          return refusal;
        },
      }, abort);
    } catch (error) {
      // Transports report outcomes, they do not throw; a throw is treated as a
      // failure that may have reached the wire if the check passed.
      return { kind: "transport_error", sent: armed.sentMono !== null, message: errorName(error) };
    }
  }

  async #commitOutcome(
    admission: AdmissionRecord,
    armed: Admission,
    outcome: TransportOutcome,
    module: ResourceModule,
    page: SyncPageRow,
  ): Promise<ActorExit | null> {
    const d = this.#d;
    if (outcome.kind === "aborted_before_send") {
      return exitOf(await this.#committed(() => settleNotSent(d, admission, outcome)));
    }
    if (outcome.kind === "shadow") {
      if (d.mode !== "shadow") throw new Error("a shadow outcome on a live page");
      let result: ShadowResult;
      try {
        result = await module.shadow(admission.work, admission.request, {
          db: d.db,
          pageId: d.pageId,
          now: d.clock.wallNow(),
          page,
          ...(d.settings === undefined ? {} : { settings: d.settings }),
        });
      } catch (error) {
        d.metrics.increment("sync_shadow_errors", { resource: admission.work.resource });
        d.logger.warn({ pageId: d.pageId, resource: admission.work.resource, err: errorName(error) },
          "Fansly sync shadow: a resource's estimate failed; the work waits");
        result = {
          work: { satisfiesRevision: false, nextDueAt: new Date(d.clock.wallNow().getTime() + WAIT_RECHECK_MS) },
          followups: [],
        };
      }
      return exitOf(await this.#committed(() => settleShadow(d, admission, armed, outcome.simulatedLatencyMs, result)));
    }
    if (d.mode !== "live") throw new Error("a live outcome on a shadow page");
    const captured = await this.#committed(() => capture(d, admission, armed, outcome, module));
    if (!captured.ok) return captured.exit;
    await this.#fault("after_capture");
    if (captured.value.applyNow) {
      await apply(d, { attemptId: admission.attemptId, operation: admission.request.spec }, captured.value.inMemory);
    }
    await this.#fault("after_apply");
    return null;
  }

  /** A commit after the request: retried a few times (the answer is in
   *  memory), then the actor gives up and the host restarts it. */
  async #committed<T>(commit: () => Promise<T>): Promise<Committed<T>> {
    const d = this.#d;
    let last: unknown = null;
    for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt += 1) {
      try {
        return { ok: true, value: await commit() };
      } catch (error) {
        if (error instanceof SyncCrashFault) throw error;
        if (error instanceof OwnershipLostError) return { ok: false, exit: { kind: "ownership_lost", foreign: true } };
        last = error;
        d.logger.warn({ pageId: d.pageId, attempt, err: errorName(error) }, "Fansly sync actor: commit failed; retrying");
        if (attempt < COMMIT_ATTEMPTS) await d.clock.sleep(FAILURE_BACKOFF_MS).catch(() => undefined);
      }
    }
    return { ok: false, exit: { kind: "failed", error: errorName(last) } };
  }

  /** When the page may next admit a request on `route`'s endpoint group, if
   *  that is later than now; null: now (or the route has no spacing). Read
   *  from the attempt journal by the database clock, so a demand bump, a
   *  restarted walk or a restarted process never shortens it. */
  async #endpointSpacedUntil(route: string, now: Date): Promise<Date | null> {
    const d = this.#d;
    const group = endpointRateGroupOfRoute(route);
    if (group === null || group.spacingMs === null) return null;
    const remainingMs = await endpointSpacingRemainingMs(d.db, {
      pageId: d.pageId,
      shadow: d.mode === "shadow",
      operations: [...group.routes],
      spacingMs: group.spacingMs,
    });
    return remainingMs > 0 ? new Date(now.getTime() + remainingMs) : null;
  }

  async #gate(): Promise<Gate> {
    const d = this.#d;
    const page = await getSyncPage(d.db, d.pageId);
    if (page === null) return { open: false, exit: { kind: "mode_changed", mode: null } };
    if (page.owner.generation !== d.generation) return { open: false, exit: { kind: "ownership_lost", foreign: true } };
    if (page.mode !== d.mode) return { open: false, exit: { kind: "mode_changed", mode: page.mode } };
    if (page.pausedAll) return { open: false, waitMs: ACTOR_IDLE_WAIT_MS };
    const now = d.clock.wallNow();
    const hold = activeFanslyPageHold(page, now);
    if (hold === null) return { open: true, page, checks: null };
    // A 429/network hold in force — the page's own, or one carried beside a
    // credentials hold — exempts nothing, a candidate identity check
    // included: closed until it ends.
    if (hold.timed !== null) return { open: false, waitMs: hold.timed.until.getTime() - now.getTime() };
    if (d.mode === "live" && hold.credentials !== null) {
      // Only the identity checks the hold admits take a slot: a candidate
      // check (another session or proxy than the one refused, E16), and —
      // A3 — the verify of stored credentials whose digest is not the latest
      // refusal's, raised here from the database (one per digest: its own
      // refusal makes the digest the latest).
      const verify = verifyAdmittedUnderCredentialsHold(hold.credentials, await this.#storedDigest());
      if ((await pickCredentialsCheck(d.db, { pageId: d.pageId, verify })) !== null) return { open: true, page, checks: { verify } };
      if (verify && await ensureCredentialsVerify(d, "credentials_changed")) return { open: false, waitMs: 0 };
    }
    return { open: false, waitMs: hold.until.getTime() - now.getTime() };
  }

  /** The digest of the page's stored credentials now (null: unknown, or a
   *  transport that stores none). */
  async #storedDigest(): Promise<string | null> {
    const transport = this.#d.transport;
    return transport.storedCredentialsGeneration === undefined ? null : transport.storedCredentialsGeneration();
  }

  /** G2: the page's stored credentials are not the ones the engine trusts
   *  (`sync_pages.credentials_generation`) — read from the database at every
   *  pick, so a restart, a failed write or a verify closed meanwhile can
   *  never leave the actor in, or out of, checks-only by mistake. */
  async #checksOnly(page: SyncPageRow): Promise<boolean> {
    const stored = await this.#storedDigest();
    return stored !== null && stored !== page.credentialsGeneration;
  }

  /** The transport refused a request because the stored credentials are not
   *  the ones the engine verified (G2; a change between the pick and the
   *  build): the verify of the stored digest is raised from the database;
   *  when one waits already, the actor waits a lap instead of spinning. */
  async #credentialsUnverified(error: CredentialsGenerationChangedError, stop: AbortSignal): Promise<void> {
    const d = this.#d;
    d.metrics.increment("sync_credentials_unverified", { pageId: d.pageId });
    if (await ensureCredentialsVerify(d, "credentials_changed")) {
      d.logger.info({ pageId: d.pageId, verified: error.verifiedGeneration !== null },
        "Fansly sync actor: the stored credentials are not verified; only the identity checks go out until the verify passes");
      return;
    }
    await this.#sleep(ACTOR_IDLE_WAIT_MS, stop);
  }

  /** The slot under a credentials hold: the oldest identity check the hold
   *  admits, at the next urgent position of the cycle. */
  async #pickCredentialsCheck(page: SyncPageRow, verify: boolean): Promise<PickedWork | null> {
    const work = await pickCredentialsCheck(this.#d.db, { pageId: this.#d.pageId, verify });
    if (work === null) return null;
    let slot = page.cyclePos;
    for (let k = 0; k < CYCLE.length; k += 1) {
      const at = (page.cyclePos + k) % CYCLE.length;
      if (CYCLE[at] === "U") {
        slot = at;
        break;
      }
    }
    return { work, workClass: "urgent", slot, nextCyclePos: (slot + 1) % CYCLE.length, requestTurn: null };
  }

  async #pick(page: SyncPageRow, now: Date, exclusions: PickExclusions): Promise<PickedWork | null> {
    const d = this.#d;
    const shadow = d.mode === "shadow";
    const eligible = (work: SyncWorkRow): boolean =>
      activeResourceHold(page.resourceHolds as Record<string, ResourceHoldEntry>, work.resource, now) === null;
    const source: ClassWorkSource<{ work: SyncWorkRow; requestTurn: RequestTurn | null }> = {
      async pickInClass(workClass: WorkClass) {
        // Due times are written by the database clock: compare by it too.
        const filter = { pageId: d.pageId, shadow, now: null, ...exclusions };
        switch (workClass) {
          case "urgent": {
            const rows = await pickUrgent(d.db, { ...filter, limit: SYNC_WORK_PICK_LIMIT });
            const work = rows.find(eligible);
            return work === undefined ? null : { work, requestTurn: null };
          }
          case "requests": {
            // History requests exist only on live pages (the intake refuses
            // every other page): a shadow page has no requests class.
            if (shadow) return null;
            const picked = await pickRequests(d.db, filter);
            return picked !== null && eligible(picked.work)
              ? { work: picked.work, requestTurn: { requestId: picked.requestId, itemId: picked.itemId } }
              : null;
          }
          case "planned": {
            const picked = await pickPlanned(d.db, { ...filter, plannedRr: page.plannedRr });
            return picked !== null && eligible(picked.work) ? { work: picked.work, requestTurn: null } : null;
          }
        }
      },
    };
    const hold = activeFanslyPageHold(page, now);
    const picked = await pick(source, {
      cyclePos: page.cyclePos,
      pausedAll: page.pausedAll,
      pausedRequests: page.pausedRequests,
      holdUntil: hold === null ? null : hold.until,
    }, now);
    if (picked === null) return null;
    return {
      work: picked.work.work,
      workClass: picked.workClass,
      slot: picked.slot,
      nextCyclePos: picked.nextCyclePos,
      requestTurn: picked.work.requestTurn,
    };
  }

  async #ensurePolls(): Promise<void> {
    const d = this.#d;
    const shadow = d.mode === "shadow";
    await d.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) return;
      await ensurePollRows(tx, { pageId: d.pageId, shadow, polls: pollsFor(d.registry, page, shadow) });
    });
    this.#lastPollsMono = d.clock.monoNow();
  }

  async #fault(point: SyncFaultPoint): Promise<void> {
    if (this.#d.faults !== undefined) await this.#d.faults(point);
  }

  async #sleep(ms: number, signal: AbortSignal): Promise<void> {
    await this.#d.clock.sleep(ms, signal).catch(() => undefined);
  }
}

/**
 * What a pick must leave out (design §3.4), in SQL so a paused or held key
 * can never hide runnable work behind the candidate limit: the owner's paused
 * keys, keys switched off for the page, live-only keys in shadow, and the
 * files under a live resource hold — except a key a hold never stops
 * (`dm-messages.head`): its file's other known keys are listed one by one.
 * An endpoint group's own 429 hold stops only the group's keys (the keys that
 * can only read the list, `LIST_RATE_LIMIT_HELD_KEYS`; the media-stats walk),
 * whatever their file. The
 * owner's requests pause leaves the whole requests class out.
 */
export interface PickExclusions {
  excludeResources: string[];
  excludeFiles: string[];
  excludeClasses: WorkClass[];
}

export function pickExclusions(
  page: Pick<SyncPageRow, "pausedResources" | "registryOverrides" | "resourceHolds"> & Partial<Pick<SyncPageRow, "pausedRequests">>,
  registry: EngineRegistry,
  shadow: boolean,
  now: Date,
  /** `checksOnly`: the page's stored credentials are not verified — only the
   *  identity checks may be picked (G2). */
  options: { checksOnly?: boolean } = {},
): PickExclusions {
  const resources = new Set(page.pausedResources);
  for (const spec of registry.specs) {
    if (!runsIn(spec, shadow) || resourceDisabled(page, spec.key)) resources.add(spec.key);
    if (options.checksOnly === true && !CREDENTIALS_CHECK_KEYS.has(spec.key)) resources.add(spec.key);
  }
  for (const key of Object.keys(page.registryOverrides)) {
    if (resourceDisabled(page, key)) resources.add(key);
  }
  const files: string[] = [];
  const holds = page.resourceHolds as Record<string, ResourceHoldEntry>;
  for (const [file, entry] of Object.entries(holds)) {
    if (!(new Date(entry.until).getTime() > now.getTime())) continue;
    if (isEndpointRateLimitKind(entry.kind)) {
      const group = endpointRateGroupOfKind(entry.kind);
      for (const spec of registry.specs) {
        if (group.heldKeys.has(spec.key)) resources.add(spec.key);
      }
      continue;
    }
    const fileKeys = registry.specs.filter((spec) => resourceFileOf(spec.key) === file);
    if (fileKeys.some((spec) => isResourceHoldExempt(spec.key))) {
      for (const spec of fileKeys) {
        if (!isResourceHoldExempt(spec.key)) resources.add(spec.key);
      }
    } else {
      files.push(file);
    }
  }
  return {
    excludeResources: [...resources].sort(),
    excludeFiles: files.sort(),
    excludeClasses: page.pausedRequests === true || options.checksOnly === true ? ["requests"] : [],
  };
}
