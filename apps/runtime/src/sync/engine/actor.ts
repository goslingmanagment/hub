import {
  ensurePollRows,
  getSyncPage,
  LiveGateClosedError,
  lockOwnedPage,
  nextOpenWorkDueAt,
  OwnershipLostError,
  pickBeforeGateWork,
  pickCredentialsCheck,
  pickPlanned,
  pickRequests,
  pickUrgent,
  readRouteJournal,
  SYNC_WORK_PICK_LIMIT,
  type Database,
  type SyncPageMode,
  type SyncPageRow,
  type SyncWorkRow,
} from "@agency_hub_core/db";

import {
  AdmissionHeldError,
  admit,
  apply,
  applyLocal,
  capture,
  commitNoHttp,
  deferAfterPlanError,
  deferForRoute,
  drainDueApplies,
  ensureCredentialsVerify,
  errorName,
  markSentBestEffort,
  recoverUnfinished,
  settleNotSent,
  SyncCrashFault,
  type AdmissionRecord,
  type CommitDeps,
  type PickedWork,
  type RequestTurn,
  type SyncFaultPoint,
} from "./commit.ts";
import { routeOfWireId } from "../fansly/routes.ts";
import { heldByScope, holdSetOf, resourceFilesHeld, whyHeld, type HoldSet } from "./admission.ts";
import { CREDENTIALS_CHECK_KEYS, isResourceHoldExempt, resourceFileOf } from "./errors.ts";
import { JITTER_MAX, PacerStoppedError, type Admission, type Pacer, type SlotGrant } from "./pacer.ts";
import {
  CredentialsGenerationChangedError,
  UnsendableRequestError,
  type LivePageSocketRef,
  type OwnershipSession,
  type PageTransport,
  type TransportOutcome,
  type Wake,
} from "./ports.ts";
import {
  beforeGateKeys,
  pollsFor,
  resourceDisabled,
  type EngineRegistry,
  type PlanContext,
  type ResourceModule,
  type StepPlan,
} from "./resource.ts";
import {
  lookaheadInstants,
  routeAdmissionView,
  routeExclusions,
  routeJournalLookbackMs,
  RouteClocks,
  type RouteState,
} from "./route-policy.ts";
import { CYCLE, isPickWait, pick, type ClassWorkSource, type PickWait, type WorkClass } from "./scheduler.ts";
import type { StallTracker } from "./watchdog.ts";

// One page's actor (plan §3, §8; design §3.5): recover → loop (plan → admit →
// send → capture → apply). Strictly sequential: capture and apply of step k
// finish before the slot wait of step k+1 (I2 by construction; both take
// ≪ 100 ms against a pause ≥ 2 s). The actor is the page's only sender while it
// runs; whatever it learns about the world it reads from the database on every
// lap, so a lost NOTIFY costs at most a second. Steps that need no request
// (a deletion carried to the hot table, a closure) run before the HTTP gate
// on every lap (ruling 9, `stepBeforeGate`): a page hold or the pacer delays
// requests only.
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
/** The lock-session liveness ping before an admission (§3.5). */
export const PING_TIMEOUT_MS = 2_000;
/** A commit after a send is retried this many times before the actor gives
 *  up (the host restarts it; recovery then closes the attempt `unknown`). */
export const COMMIT_ATTEMPTS = 3;
/** The wait after a failure that admitted nothing. */
export const FAILURE_BACKOFF_MS = 1_000;
/** A live page whose gates are closed re-checks this often (I17). */
export const LIVE_GATE_RECHECK_MS = 5_000;
/** A page whose hold set holds rows this build cannot read (a route's state,
 *  a kind it does not know) re-reads it this often — its admission stays
 *  closed meanwhile. */
export const ROUTE_STATE_RECHECK_MS = 5_000;
/** Due works planned before the HTTP gate per lap (ruling 9): a burst beyond
 *  it goes on next lap, so a step that leaves its work due at once (an
 *  overflowed deletion batch) never keeps the page from its requests. */
export const STEPS_BEFORE_GATE_PER_LAP = 10;

export interface ActorDeps extends CommitDeps {
  pacer: Pacer;
  transport: PageTransport;
  ownership: OwnershipSession;
  wake: Wake;
  /** The page's socket owner (`ws.connect` plans by its state); absent where
   *  no socket owner runs. */
  socket?: LivePageSocketRef;
  /** TESTS ONLY: the route budgets' time scale (`RoutePolicyOptions`); the
   *  host passes it through from its own test option, `main.ts` never. */
  routeTimeScale?: number;
  /** The stall watchdog's tracker of this actor (`engine/watchdog.ts`): every
   *  phase of a lap moves it, so only a step that never settles goes stale.
   *  Each wait between two marks is bounded far below the stall bound (the
   *  pacer's ≤ 1.2 × S, a wake ≤ 1 s, a request ≤ 20 s). */
  stall?: StallTracker;
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

/** Where an actor is, as the stall watchdog reports it. */
export type ActorPhase =
  | "recover"
  | "applies"
  | "polls"
  | "before_gate"
  | "gate"
  | "idle"
  | "slot"
  | "pick"
  | "lookahead"
  | "plan"
  | "admit"
  | "send"
  | "commit"
  | "commit_retry"
  | "apply"
  | "backoff";

function exitOf(committed: Committed<unknown>): ActorExit | null {
  return committed.ok ? null : committed.exit;
}

type Gate =
  /** `checks`: a credentials hold is in force; only the identity checks it
   *  admits may take the slot — a candidate check (E16) and, with `verify`,
   *  the verify of changed stored credentials (A3). */
  | { open: true; page: SyncPageRow; checks: { verify: boolean } | null }
  | { open: false; waitMs: number };

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"));
}

export class SyncActor {
  readonly #d: ActorDeps;
  #lastPollsMono = Number.NEGATIVE_INFINITY;
  /** The diagnostic of the unreadable hold rows last logged (null: the hold
   *  set reads). */
  #holdSetProblem: string | null = null;
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
    this.#phase("recover");
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
        this.#phase("backoff");
        await this.#sleep(FAILURE_BACKOFF_MS, signals.stop);
      }
    }
  }

  async #lap(signals: ActorSignals): Promise<ActorExit | null> {
    const d = this.#d;
    this.#phase("applies");
    await drainDueApplies(d, APPLIES_PER_LAP);
    if (d.clock.monoNow() - this.#lastPollsMono >= POLL_ROWS_EVERY_MS) {
      this.#phase("polls");
      await this.#ensurePolls();
    }

    this.#phase("gate");
    const owned = await getSyncPage(d.db, d.pageId);
    if (owned === null) return { kind: "mode_changed", mode: null };
    const lost = this.#ownershipExit(owned);
    if (lost !== null) return lost;
    // Ruling 9: what needs no request is not the HTTP gate's to stop — no
    // page hold, no pacer slot; the owner's pause of the page still stops it.
    if (!owned.pausedAll) {
      this.#phase("before_gate");
      await stepBeforeGate(d, owned, signals.stop);
    }

    const gate = await this.#gate(owned);
    if (!gate.open) {
      this.#phase("idle");
      await d.wake.wait(d.pageId, Math.max(0, Math.min(gate.waitMs, ACTOR_IDLE_WAIT_MS)), signals.stop);
      return null;
    }

    let grant: SlotGrant;
    this.#phase("slot");
    try {
      grant = await d.pacer.waitForSlot(signals.stop);
    } catch (error) {
      if (isAbort(error, signals.stop)) return { kind: "stopped" };
      throw error;
    }
    if (signals.stop.aborted) return { kind: "stopped" };
    // The work is chosen at the slot: re-read the page (cycle pointer, pauses,
    // holds, route state) and the route clocks now, not before the wait.
    this.#phase("pick");
    const page = await getSyncPage(d.db, d.pageId);
    if (page === null) return { kind: "mode_changed", mode: null };
    const holds = holdSetOf(page.holds);
    const now = d.clock.wallNow();
    // What holds the page itself now (the gate judged the row before the wait).
    const held = whyHeld(holds, null, {}, now);
    const routeState = holds.routes;
    if (held?.kind === "unreadable" || !routeState.ok) {
      // Rows this build cannot read (a route state that does not read is
      // among them, and `held` names it): nothing is admitted.
      if (held?.kind === "unreadable") this.#holdSetUnreadable(held.diagnostic);
      await this.#sleep(ROUTE_STATE_RECHECK_MS, signals.stop);
      return null;
    }
    this.#holdSetProblem = null;
    const clocks = await this.#routeClocks(routeState.state);
    const underCredentials = gate.checks !== null && held !== null && held.scope === "credentials";
    // G2 from the database, never from memory: while the stored credentials
    // are not the ones the engine trusts, only the identity checks go out.
    const unverified = underCredentials ? null : await this.#unverifiedStoredDigest(page);
    const checksOnly = unverified !== null;
    const exclusions = pickExclusions(page, d.registry, now, { checksOnly });
    const picked = underCredentials
      ? await this.#pickCredentialsCheck(page, gate.checks?.verify === true)
      : await this.#pick(page, holds, held?.until ?? null, now, exclusions, clocks, now.getTime() + grant.settingMs * (1 + JITTER_MAX));
    if (picked !== null && isPickWait(picked)) {
      // The short look-ahead: the slot waits for the class whose turn it is
      // (nothing is reserved; a wake picks again).
      d.metrics.increment("sync_route_lookahead_waits", { workClass: picked.workClass });
      this.#phase("lookahead");
      await d.wake.wait(d.pageId, Math.max(0, picked.waitUntil.getTime() - now.getTime()), signals.stop);
      return null;
    }
    if (picked === null && checksOnly && await ensureCredentialsVerify(d, "credentials_changed", unverified)) return null;
    if (picked === null) {
      // Idle until the next work this pick could take: a paused, switched-off,
      // held or route-closed row is never "due" here, or the actor would lap
      // without sleeping for as long as it stays so.
      const idleExclusions = withRouteExclusions(exclusions, d.registry, clocks, now);
      const due = await nextOpenWorkDueAt(d.db, { pageId: d.pageId, ...idleExclusions });
      const untilDue = due === null ? ACTOR_IDLE_WAIT_MS : due.getTime() - now.getTime();
      this.#phase("idle");
      await d.wake.wait(d.pageId, Math.max(0, Math.min(untilDue, ACTOR_IDLE_WAIT_MS)), signals.stop);
      return null;
    }

    this.#phase("plan");
    const module = await d.registry.module(picked.work.resource);
    let plan: StepPlan;
    try {
      plan = await module.plan(picked.work, planContextOf(d, page, now));
    } catch (error) {
      await deferAfterPlanError(d, picked.work, error);
      return null;
    }
    if (plan.kind === "local") {
      // A write without a request (design §3.3 item 3) of a key that plans at
      // its slot (a walk's stamp between its reads), or of one the bounded
      // step before the gate did not reach this lap: nothing is admitted or
      // sent, so the slot stays open.
      await applyLocal(d, picked.work, module);
      return null;
    }
    if (plan.kind !== "request") {
      await commitNoHttp(d, picked.work, plan);
      return null;
    }
    // The planned request's own route, for every key (a walk over several
    // routes, a probe, the CDN, the Upgrade): a route its budget or hold
    // keeps closed admits nothing — the work is due again when it opens and
    // the slot stays open for other work.
    const route = routeOfWireId(plan.request.spec);
    const checkedAt = d.clock.wallNow();
    const routeHeld = heldByScope(
      holds,
      routeAdmissionView(clocks, d.registry.specs, checkedAt),
      { work: { resource: picked.work.resource }, plannedRoute: route },
      checkedAt,
    ).route;
    if (routeHeld !== null) {
      d.metrics.increment("sync_route_deferred", { resource: picked.work.resource, route });
      await deferForRoute(d, picked.work, routeHeld.until);
      return null;
    }
    // What the route check just applied, recorded on the attempt: the send
    // audit judges the route's and the family's gaps by these numbers (I19).
    const intervals = clocks.intervals(route);

    this.#phase("admit");
    if ((await d.ownership.ping(PING_TIMEOUT_MS)) === "timeout") {
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
      admission = await admit(d, picked, plan.request, grant, intervals, module, request);
    } catch (error) {
      if (error instanceof LiveGateClosedError) {
        d.metrics.increment("sync_live_gate_closed", { pageId: d.pageId, reason: error.reason });
        await this.#sleep(LIVE_GATE_RECHECK_MS, signals.stop);
        return null;
      }
      if (error instanceof AdmissionHeldError) {
        // A hold written after the gate looked: the next lap waits for it.
        d.metrics.increment("sync_admission_page_held", { pageId: d.pageId, kind: error.kind });
        const untilMs = error.until === null ? ACTOR_IDLE_WAIT_MS : error.until.getTime() - d.clock.wallNow().getTime();
        await d.wake.wait(d.pageId, Math.max(0, Math.min(untilMs, ACTOR_IDLE_WAIT_MS)), signals.stop);
        return null;
      }
      throw error;
    }
    if (admission === null) return null;
    this.admissions += 1;
    await this.#fault("after_admit");

    const armed = d.pacer.arm(grant, admission.attemptId, issuedMono);
    this.#phase("send");
    const outcome = await this.#send(request, armed, signals.abort);
    d.pacer.complete(armed, outcome);
    this.#phase("commit");
    await this.#fault("after_send");
    return this.#commitOutcome(admission, armed, outcome, module);
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
          if (refusal === null && armed.sentWall !== null) {
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
  ): Promise<ActorExit | null> {
    const d = this.#d;
    if (outcome.kind === "aborted_before_send") {
      return exitOf(await this.#committed(() => settleNotSent(d, admission, outcome)));
    }
    const captured = await this.#committed(() => capture(d, admission, armed, outcome, module));
    if (!captured.ok) return captured.exit;
    this.#phase("apply");
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
      this.#phase(attempt === 1 ? "commit" : "commit_retry");
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

  /** The page's hold set holds rows this build cannot read: the page admits
   *  nothing while they stand (a metric, and one log line per diagnostic). */
  #holdSetUnreadable(diagnostic: string): void {
    const d = this.#d;
    d.metrics.increment("sync_route_state_unreadable", { pageId: d.pageId });
    if (this.#holdSetProblem === diagnostic) return;
    this.#holdSetProblem = diagnostic;
    d.logger.error({ pageId: d.pageId, diagnostic },
      "Fansly sync actor: the page's hold set has rows this build does not read; nothing is admitted while they stand");
  }

  /** The route clocks at this slot, from the page's journals (its attempts
   *  and the legacy send log): never from memory. */
  async #routeClocks(state: RouteState): Promise<RouteClocks> {
    const d = this.#d;
    const options = d.routeTimeScale === undefined ? {} : { timeScale: d.routeTimeScale };
    const sends = await readRouteJournal(d.db, { pageId: d.pageId, withinMs: routeJournalLookbackMs(state, options) });
    return new RouteClocks({ sends, state, ...options });
  }

  /** Why this actor may not step the page at all (null: it may): another
   *  generation owns it, or it is no longer `live` — the one mode an actor
   *  runs in. */
  #ownershipExit(page: SyncPageRow): ActorExit | null {
    const d = this.#d;
    if (page.owner.generation !== d.generation) return { kind: "ownership_lost", foreign: true };
    if (page.mode !== "live") return { kind: "mode_changed", mode: page.mode };
    return null;
  }

  /** The HTTP gate of a page this actor owns: the owner's pause, then what
   *  holds the page itself (`whyHeld` without a work). */
  async #gate(page: SyncPageRow): Promise<Gate> {
    const d = this.#d;
    if (page.pausedAll) return { open: false, waitMs: ACTOR_IDLE_WAIT_MS };
    const now = d.clock.wallNow();
    const holds = holdSetOf(page.holds);
    const held = whyHeld(holds, null, {}, now);
    if (held === null) return { open: true, page, checks: null };
    const waitMs = held.until === null ? ROUTE_STATE_RECHECK_MS : held.until.getTime() - now.getTime();
    if (held.kind === "unreadable") this.#holdSetUnreadable(held.diagnostic);
    // A network hold in force — alone, or beside a credentials hold — and
    // rows this build cannot read exempt nothing, a candidate identity check
    // included: closed until they end.
    if (held.scope !== "credentials") return { open: false, waitMs };
    // Only the identity checks the hold admits take a slot: a candidate
    // check (another session or proxy than the one refused, E16), and —
    // A3 — the verify of stored credentials whose digest is not the latest
    // refusal's, raised here from the database (one per digest: its own
    // refusal makes the digest the latest).
    const stored = await this.#storedDigest();
    const verify = whyHeld(holds, null, { operation: { kind: "verify", digest: stored } }, now) === null;
    if ((await pickCredentialsCheck(d.db, { pageId: d.pageId, verify })) !== null) return { open: true, page, checks: { verify } };
    if (verify && await ensureCredentialsVerify(d, "credentials_changed", stored)) return { open: false, waitMs: 0 };
    return { open: false, waitMs };
  }

  /** The digest of the page's stored credentials now (null: unknown, or a
   *  transport that stores none). */
  async #storedDigest(): Promise<string | null> {
    const transport = this.#d.transport;
    return transport.storedCredentialsGeneration === undefined ? null : transport.storedCredentialsGeneration();
  }

  /** G2: the digest of the page's stored credentials when they are not the
   *  ones the engine trusts (`sync_pages.credentials_generation`), else null
   *  — read from the database at every pick, so a restart, a failed write or
   *  a verify closed meanwhile can never leave the actor in, or out of,
   *  checks-only by mistake. */
  async #unverifiedStoredDigest(page: SyncPageRow): Promise<string | null> {
    const stored = await this.#storedDigest();
    return stored !== null && stored !== page.credentialsGeneration ? stored : null;
  }

  /** The transport refused a request because the stored credentials are not
   *  the ones the engine verified (G2; a change between the pick and the
   *  build): the verify of the stored digest is raised from the database;
   *  when one waits already, the actor waits a lap instead of spinning. */
  async #credentialsUnverified(error: CredentialsGenerationChangedError, stop: AbortSignal): Promise<void> {
    const d = this.#d;
    d.metrics.increment("sync_credentials_unverified", { pageId: d.pageId });
    if (await ensureCredentialsVerify(d, "credentials_changed", error.storedGeneration)) {
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

  async #pick(
    page: SyncPageRow,
    holds: HoldSet,
    /** The end of what holds the page itself now (null: nothing does). */
    pageHeldUntil: Date | null,
    now: Date,
    exclusions: PickExclusions,
    clocks: RouteClocks,
    lookaheadUntilMs: number,
  ): Promise<PickedWork | PickWait | null> {
    const d = this.#d;
    const eligible = (work: SyncWorkRow): boolean =>
      heldByScope(holds, null, { work: { resource: work.resource } }, now).resource === null;
    // The keys whose routes are all closed at an instant stay out of the pick
    // at that instant (by key, in SQL: a closed key never hides open work
    // behind the candidate limit).
    const byInstant = new Map<number, PickExclusions>();
    const exclusionsAt = (at: Date): PickExclusions => {
      let found = byInstant.get(at.getTime());
      if (found === undefined) {
        found = withRouteExclusions(exclusions, d.registry, clocks, at);
        byInstant.set(at.getTime(), found);
      }
      return found;
    };
    const source: ClassWorkSource<{ work: SyncWorkRow; requestTurn: RequestTurn | null }> = {
      async pickInClass(workClass: WorkClass, _now: Date, admissibleAt?: Date) {
        // Due times are written by the database clock: compare by it too.
        const filter = { pageId: d.pageId, now: null, ...exclusionsAt(admissibleAt ?? now) };
        switch (workClass) {
          case "urgent": {
            const rows = await pickUrgent(d.db, { ...filter, limit: SYNC_WORK_PICK_LIMIT });
            const work = rows.find(eligible);
            return work === undefined ? null : { work, requestTurn: null };
          }
          case "requests": {
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
    const picked = await pick(source, {
      cyclePos: page.cyclePos,
      pausedAll: page.pausedAll,
      pausedRequests: page.pausedRequests,
      holdUntil: pageHeldUntil,
    }, now, lookaheadInstants(d.registry.specs, clocks, now, new Date(lookaheadUntilMs)));
    if (picked === null || isPickWait(picked)) return picked;
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
    await d.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await lockOwnedPage(tx, { pageId: d.pageId, generation: d.generation, lock: "no_key_update" });
      const page = await getSyncPage(tx, d.pageId);
      if (page === null) return;
      await ensurePollRows(tx, { pageId: d.pageId, polls: pollsFor(d.registry, page) });
    });
    this.#lastPollsMono = d.clock.monoNow();
  }

  /** The watchdog's mark: the actor moved on to `phase`. */
  #phase(phase: ActorPhase): void {
    this.#d.stall?.progress(phase);
  }

  async #fault(point: SyncFaultPoint): Promise<void> {
    if (this.#d.faults !== undefined) await this.#d.faults(point);
  }

  async #sleep(ms: number, signal: AbortSignal): Promise<void> {
    await this.#d.clock.sleep(ms, signal).catch(() => undefined);
  }
}

/** What a plan reads: the page as the step sees it, the live settings and,
 *  where the process runs one, its socket owner. */
function planContextOf(d: ActorDeps, page: SyncPageRow, now: Date): PlanContext {
  return {
    db: d.db,
    pageId: d.pageId,
    now,
    page,
    registry: d.registry,
    ...(d.settings === undefined ? {} : { settings: d.settings }),
    ...(d.socket === undefined ? {} : { socket: d.socket() }),
  };
}

/**
 * Ruling 9 (step 3b): the steps that need no request run before the page's
 * HTTP gate, so a page hold (auth, identity, 429, network) or the pacer's
 * pause delays only requests — never a socket deletion carried to the hot
 * table and the archive, nor a closure that needs no read. The due work of
 * the keys that plan here (`beforeGateKeys`: those without HTTP first), at
 * most `STEPS_BEFORE_GATE_PER_LAP` rows a lap, is planned on `page` (read
 * this lap, owned by this generation, not paused): a `local` plan commits
 * through `applyLocal` (the generation fence, the erasure fence its entry
 * declares), a closure, a wait or a quarantine through
 * `commitNoHttp` (the generation fence); a plan that asks for a request is
 * left as it is for its slot. Nothing is admitted, sent or paced, and the
 * cycle does not move. Returns the steps committed.
 */
export async function stepBeforeGate(d: ActorDeps, page: SyncPageRow, stop: AbortSignal): Promise<number> {
  const resources = beforeGateKeys(d.registry, page);
  if (resources.length === 0) return 0;
  const works = await pickBeforeGateWork(d.db, { pageId: d.pageId, resources, limit: STEPS_BEFORE_GATE_PER_LAP });
  let committed = 0;
  for (const work of works) {
    if (stop.aborted) break;
    const module = await d.registry.module(work.resource);
    let plan: StepPlan;
    try {
      plan = await module.plan(work, planContextOf(d, page, d.clock.wallNow()));
    } catch (error) {
      await deferAfterPlanError(d, work, error);
      continue;
    }
    if (plan.kind === "request") continue;
    if (plan.kind === "local") await applyLocal(d, work, module);
    else await commitNoHttp(d, work, plan);
    committed += 1;
    d.metrics.increment("sync_steps_before_gate", { resource: work.resource, plan: plan.kind });
  }
  return committed;
}

/**
 * What a pick must leave out (design §3.4), in SQL so a paused or held key
 * can never hide runnable work behind the candidate limit: the owner's paused
 * keys, keys switched off for the page, and the files whose breaker is in
 * force — except a key a hold never stops
 * (`dm-messages.head`): its file's other known keys are listed one by one.
 * The owner's requests pause leaves the whole requests class out. (A route
 * hold leaves out the keys all of whose routes it closes:
 * `withRouteExclusions`.)
 */
export interface PickExclusions {
  excludeResources: string[];
  excludeFiles: string[];
  excludeClasses: WorkClass[];
}

export function pickExclusions(
  page: Pick<SyncPageRow, "pausedResources" | "registryOverrides" | "holds"> & Partial<Pick<SyncPageRow, "pausedRequests">>,
  registry: EngineRegistry,
  now: Date,
  /** `checksOnly`: the page's stored credentials are not verified — only the
   *  identity checks may be picked (G2). */
  options: { checksOnly?: boolean } = {},
): PickExclusions {
  const resources = new Set(page.pausedResources);
  for (const spec of registry.specs) {
    if (resourceDisabled(page, spec.key)) resources.add(spec.key);
    if (options.checksOnly === true && !CREDENTIALS_CHECK_KEYS.has(spec.key)) resources.add(spec.key);
  }
  for (const key of Object.keys(page.registryOverrides)) {
    if (resourceDisabled(page, key)) resources.add(key);
  }
  const files: string[] = [];
  for (const file of resourceFilesHeld(holdSetOf(page.holds), now)) {
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

/** `exclusions` plus the keys none of whose routes admits a send at `at`
 *  (`routeExclusions`). */
export function withRouteExclusions(
  exclusions: PickExclusions,
  registry: Pick<EngineRegistry, "specs">,
  clocks: RouteClocks,
  at: Date,
): PickExclusions {
  const closed = routeExclusions(registry.specs, clocks, at);
  if (closed.length === 0) return exclusions;
  return { ...exclusions, excludeResources: [...new Set([...exclusions.excludeResources, ...closed])].sort() };
}
