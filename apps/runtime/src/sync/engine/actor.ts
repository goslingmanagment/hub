import {
  ensurePollRows,
  getSyncAttempt,
  getSyncPage,
  LiveGateClosedError,
  lockOwnedPage,
  markAttemptCommitFailed,
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
  captureSendOf,
  commitNoHttp,
  commitSiteIdentity,
  deferAfterPlanError,
  deferForRoute,
  drainDueApplies,
  ensureCredentialsVerify,
  errorName,
  isAnswerInMemory,
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
import { isFanslyRoute, routeOfWireId, type FanslyRoute } from "../fansly/routes.ts";
import { SITE_OTHER_ROUTE } from "../fansly/route-match.ts";
import { reconcileHeldOutcomes, takeLateHeldOutcomes } from "./held-outcomes.ts";
import { heldByScope, holdSetOf, resourceFilesHeld, whyHeld, type HoldSet } from "./admission.ts";
import { CREDENTIALS_CHECK_KEYS, isResourceHoldExempt, resourceFileOf } from "./errors.ts";
import { JITTER_MAX, PacerStoppedError, type Admission, type Pacer, type SlotGrant } from "./pacer.ts";
import {
  CredentialsGenerationChangedError,
  PageTransportUnavailableError,
  UnsendableRequestError,
  type LivePageSocketRef,
  type OwnershipSession,
  type PageTransport,
  type SiteAdmissionPort,
  type SiteObservation,
  type SiteRequestEnd,
  type TransportOutcome,
  type Wake,
} from "./ports.ts";
import { isSiteSocket, SiteTurns, transportOutcomeOfSite, type ClassifiedSiteRequest } from "./site-admission.ts";
import { admitSite, commitSiteEnd, observedSend, recordObservedSiteSend, settleSiteDecision, siteContextOf, siteEnd } from "./site-slot.ts";
import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";
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
// generation), or when a commit after a send keeps failing — then it marks the
// attempt with why (`commit_failed:<SQLSTATE|name>`, best effort) and exits
// `failed`; the next actor's recovery closes the attempt `unknown` and reads
// the work once more, or quarantines it when its two newest attempts ended so
// within 10 min (bug hunt Д3). A request already
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
/** Variant Б: observed site requests remembered (their attempt, for an end
 *  or an identity proof that comes after); the oldest is forgotten first. */
export const OBSERVED_SITE_KEPT = 512;
/** Variant Б: the site's own sends in an hour past which the owner is warned
 *  (decision Б8: a warning, never a refusal; spec §3's ceiling). */
export const OBSERVED_SITE_HOUR_WARN = 300;

export interface ActorDeps extends CommitDeps {
  pacer: Pacer;
  transport: PageTransport;
  ownership: OwnershipSession;
  wake: Wake;
  /** The page's socket owner (`ws.connect` plans by its state); absent where
   *  no socket owner runs. */
  socket?: LivePageSocketRef;
  /** The page browser's site admission (Project Browser, plan §3.2): the
   *  site's own requests it holds paused. Absent or null: a page without a
   *  browser — nothing of the site path runs. */
  site?: SiteAdmissionPort | null;
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
  /** The site's share of the slots (Project Browser): one per cycle. */
  readonly #siteTurns = new SiteTurns();
  /** The diagnostic of the unreadable hold rows last logged (null: the hold
   *  set reads). */
  #holdSetProblem: string | null = null;
  /** Why the transport last could not take a request (null: it could). */
  #transportProblem: string | null = null;
  #lastEmptySlot: string | null = null;
  #admittedThisLap = false;
  #lapState = { workId: null as string | null, resource: null as string | null, prepare: "not_run", siteCandidate: false, phase: "idle" as ActorPhase };
  /** Steps admitted by this actor (tests, status). */
  admissions = 0;
  /** Variant Б: observed site requests by their browser id. */
  readonly #observed = new Map<string, { attemptId: number | null; route: FanslyRoute; sentWall: Date }>();
  /** Variant Б: the journal of observed facts, one commit at a time, in order. */
  #observedChain: Promise<void> = Promise.resolve();
  /** Variant Б: the monotonic instants of this hour's observed sends. */
  #observedHour: number[] = [];
  #observedWarnedMono = Number.NEGATIVE_INFINITY;

  constructor(deps: ActorDeps) {
    this.#d = deps;
  }

  get deps(): ActorDeps {
    return this.#d;
  }

  /** Run until stopped, ownership is lost, the mode changes or a commit after
   *  a send keeps failing. A `SyncCrashFault` (tests) rejects. */
  async run(signals: ActorSignals): Promise<ActorExit> {
    const site = this.#d.site;
    site?.onObserved?.((event) => this.#onSiteObserved(event));
    try {
      return await this.#runOwned(signals);
    } finally {
      site?.onObserved?.(null);
      await this.#observedChain;
    }
  }

  // ── variant Б: the site's own traffic, observed (plan-b §4.2.2–4.2.3) ──

  /** At once: the pause counts the site's send, and an end lets the next own
   *  slot open. Then, in order, the journal: the attempt, its end with the
   *  holds it sets, the identity proof. */
  #onSiteObserved(event: SiteObservation): void {
    const d = this.#d;
    switch (event.kind) {
      case "sent": {
        d.pacer.observeForeignSend(event.id, event.sentMono);
        this.#countObservedSend(event.sentMono);
        // A route the catalogue does not know is the site's other read.
        const route: FanslyRoute = isFanslyRoute(event.route) ? event.route : SITE_OTHER_ROUTE;
        this.#journalObserved(async () => {
          const { attemptId } = await recordObservedSiteSend(d, { ...event, route, settingMs: FANSLY_PAUSE_MIN_MS });
          this.#rememberObserved(event.id, { attemptId, route, sentWall: event.sentWall });
        });
        return;
      }
      case "ended":
        d.pacer.observeForeignEnd(event.id);
        this.#journalObserved(async () => {
          const sent = this.#observed.get(event.id);
          if (sent?.attemptId == null) return;
          const end: SiteRequestEnd = event.status !== null
            ? { kind: "response", status: event.status, retryAfterMs: event.retryAfterMs }
            : { kind: "transport_error", sent: true, message: event.error ?? "no answer" };
          await commitSiteEnd(d, { attemptId: sent.attemptId, send: observedSend(sent.sentWall, FANSLY_PAUSE_MIN_MS), end, classified: { route: sent.route, exempt: false } });
        });
        return;
      case "identity":
        this.#journalObserved(async () => {
          const sent = this.#observed.get(event.id);
          const generationOf = d.transport.siteCredentialsGeneration;
          if (sent?.attemptId == null || generationOf === undefined) return;
          const credentialsGeneration = await generationOf.call(d.transport, event.sessionFingerprint);
          if (credentialsGeneration === null) return;
          const outcome = await commitSiteIdentity(d, { attemptId: sent.attemptId, accountId: event.accountId, credentialsGeneration, sentNotBefore: event.sentNotBeforeWall });
          d.metrics.increment("sync_site_identity", { outcome });
          if (outcome !== "recorded") {
            d.logger.warn({ pageId: d.pageId, outcome, attemptId: sent.attemptId }, "Fansly sync actor: the site's own account read proves nothing of this page");
          }
        });
        return;
    }
  }

  #journalObserved(commit: () => Promise<void>): void {
    const d = this.#d;
    this.#observedChain = this.#observedChain.then(commit).catch((error: unknown) => {
      if (error instanceof OwnershipLostError) return;
      d.metrics.increment("sync_site_observed_commit_failed", { error: errorName(error) });
      d.logger.warn({ pageId: d.pageId, err: errorName(error) }, "Fansly sync actor: an observed site request could not be journaled");
    });
  }

  #rememberObserved(id: string, entry: { attemptId: number | null; route: FanslyRoute; sentWall: Date }): void {
    this.#observed.delete(id);
    this.#observed.set(id, entry);
    if (this.#observed.size > OBSERVED_SITE_KEPT) this.#observed.delete(this.#observed.keys().next().value!);
  }

  /** Decision Б8: past the hour's ceiling a warning (once per ten minutes) —
   *  the site is never refused; the engine's own work yields in the pacer. */
  #countObservedSend(atMono: number): void {
    const d = this.#d;
    const hourAgo = atMono - 3_600_000;
    this.#observedHour = this.#observedHour.filter((at) => at > hourAgo);
    this.#observedHour.push(atMono);
    d.metrics.increment("sync_site_observed_sends", {});
    if (this.#observedHour.length > OBSERVED_SITE_HOUR_WARN && atMono - this.#observedWarnedMono >= 600_000) {
      this.#observedWarnedMono = atMono;
      d.logger.warn({ pageId: d.pageId, sendsInHour: this.#observedHour.length }, "Fansly sync actor: the site's own requests passed the hour's ceiling (a warning; nothing is refused)");
    }
  }

  async #runOwned(signals: ActorSignals): Promise<ActorExit> {
    const d = this.#d;
    this.#phase("recover");
    try {
      // A sender that keeps its outcomes (a page's browser) is asked about
      // the attempts left unfinished BEFORE the recovery closes them
      // `unknown` (Project Browser plan §3.2; PR 13).
      if (d.transport.held !== undefined) await reconcileHeldOutcomes(d, d.transport.held);
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
    this.#admittedThisLap = false;
    this.#lapState = { workId: null, resource: null, prepare: "not_run", siteCandidate: false, phase: "idle" };
    try {
      return await this.#lapWork(signals);
    } finally {
      if (this.#admittedThisLap) this.#lastEmptySlot = null;
      else if (!signals.stop.aborted) {
        const state = { ...this.#lapState, siteTurns: this.#siteTurns.snapshot() };
        const key = JSON.stringify(state);
        if (key !== this.#lastEmptySlot) {
          this.#lastEmptySlot = key;
          this.#d.logger.info({ pageId: this.#d.pageId, ...state }, "Fansly sync actor: lap ended without an admission");
        }
      }
    }
  }

  async #lapWork(signals: ActorSignals): Promise<ActorExit | null> {
    const d = this.#d;
    this.#phase("applies");
    // The outcomes the sender delivered that nothing waited for (PR 13):
    // committed or kept, then acknowledged — never sent again.
    if (d.transport.held !== undefined) await takeLateHeldOutcomes(d, d.transport.held);
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

    // The site's waiting requests are judged every lap: what must be refused
    // now is, whatever the gate says (spec §3).
    const siteCandidate = d.site ? await this.#siteSweep(owned) : null;
    this.#lapState.siteCandidate = siteCandidate !== null;
    const gate = await this.#gate(owned);
    if (!gate.open) {
      // The owner's manual login passes the page's pause and a credentials
      // hold (plan §3.2): a slot for its request alone.
      if (siteCandidate !== null) return this.#siteOnlySlot(signals);
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
    // Trust in a saved digest outlives Chrome, but the operator's identity
    // confirmation does not. The current start needs its own account.me.
    const confirmingSession = !underCredentials && d.transport.needsSessionConfirmation?.() === true;
    const checksOnly = unverified !== null || confirmingSession;
    const exclusions = pickExclusions(page, d.registry, now, { checksOnly });
    if (d.site && (this.#siteTurns.due() || d.site.pending().some(isSiteSocket))) {
      const served = await this.#trySite(grant, page, holds, clocks, now, checksOnly, signals, !this.#siteTurns.due());
      if (served !== "none") return served;
    }
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
    if (picked === null && checksOnly && await ensureCredentialsVerify(d,
      confirmingSession ? "browser_loaded" : "credentials_changed", unverified ?? await this.#storedDigest())) {
      if (confirmingSession) d.logger.info({ pageId: d.pageId }, "Fansly sync actor: identity verify raised for the current browser start");
      return null;
    }
    if (picked === null && d.site) {
      // A slot the engine leaves empty is the site's.
      const served = await this.#trySite(grant, page, holds, clocks, now, checksOnly, signals);
      if (served !== "none") return served;
    }
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

    this.#lapState.workId = String(picked.work.id);
    this.#lapState.resource = picked.work.resource;
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
      this.#lapState.prepare = "prepared";
    } catch (error) {
      if (error instanceof CredentialsGenerationChangedError) {
        this.#lapState.prepare = "credentials_changed";
        await this.#credentialsUnverified(error, signals.stop);
        return null;
      }
      if (error instanceof PageTransportUnavailableError) {
        // The transport cannot take a request now (a page's browser without
        // its operator): not the platform's failure — nothing is admitted,
        // no hold is written; the actor asks again after the transport's
        // own wait (Project Browser plan §3.2).
        d.metrics.increment("sync_transport_unavailable", { pageId: d.pageId });
        this.#lapState.prepare = error.code;
        this.#transportUnavailable(error.reason);
        // A fresh Chrome can learn its session only through an admitted
        // site GET. This same unused slot may bootstrap it, even while an
        // urgent/planned engine work keeps being picked. All site gates,
        // route budgets and the common pacer still apply.
        if (error.code === "session_unknown" && d.site) {
          const served = await this.#trySite(grant, page, holds, clocks, d.clock.wallNow(), checksOnly, signals);
          if (served !== "none") return served;
        }
        this.#phase("idle");
        await this.#sleep(Math.max(0, Math.min(error.retryInMs, LIVE_GATE_RECHECK_MS)), signals.stop);
        return null;
      }
      if (!(error instanceof UnsendableRequestError)) throw error;
      this.#lapState.prepare = "unsendable";
      // Nothing can ever send it (no secret, a host the engine never calls):
      // the work closes with that answer, nothing is admitted.
      d.metrics.increment("sync_unsendable", { resource: picked.work.resource, reason: error.reason });
      await commitNoHttp(d, picked.work, { kind: "done", reason: error.reason, result: error.result });
      return null;
    }
    this.#transportProblem = null;
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
        // A hold or the owner's pause written after the gate looked: the
        // next lap waits for it.
        d.metrics.increment("sync_admission_page_held", { pageId: d.pageId, kind: error.kind });
        const untilMs = error.until === null ? ACTOR_IDLE_WAIT_MS : error.until.getTime() - d.clock.wallNow().getTime();
        await d.wake.wait(d.pageId, Math.max(0, Math.min(untilMs, ACTOR_IDLE_WAIT_MS)), signals.stop);
        return null;
      }
      throw error;
    }
    if (admission === null) return null;
    this.#admittedThisLap = true;
    this.admissions += 1;
    this.#siteTurns.engineAdmitted();
    await this.#fault("after_admit");

    const armed = d.pacer.arm(grant, admission.attemptId, issuedMono);
    this.#phase("send");
    const outcome = await this.#send(request, armed, signals.abort);
    d.pacer.complete(armed, outcome);
    this.#phase("commit");
    await this.#fault("after_send");
    return this.#commitOutcome(admission, armed, outcome, module);
  }

  // ── a page's own site requests (Project Browser, plan §3.2; PR 8) ─────────

  /** The site's waiting requests at this lap: what must be refused now is
   *  refused; the request a slot would admit, if any. Nothing is admitted. */
  async #siteSweep(page: SyncPageRow): Promise<ClassifiedSiteRequest | null> {
    const d = this.#d;
    // Nothing waits (a page on Node between its logins, PR 15): nothing to
    // judge, and no reads for it.
    if (d.site!.pending().length === 0) return null;
    const now = d.clock.wallNow();
    const holds = holdSetOf(page.holds);
    const clocks = holds.routes.ok ? await this.#routeClocks(holds.routes.state) : null;
    const checksOnly = (await this.#unverifiedStoredDigest(page)) !== null || d.transport.needsSessionConfirmation?.() === true;
    const ctx = await siteContextOf(d, { page, holds, clocks, specs: d.registry.specs, checksOnly, bootstrapOnly: d.transport.needsSiteBootstrap?.() === true, now });
    return settleSiteDecision(d, d.site!, ctx);
  }

  /** A slot for the manual login while the gate is closed to the engine (the
   *  owner's pause, a credentials hold): the pacer's pause still holds. */
  async #siteOnlySlot(signals: ActorSignals): Promise<ActorExit | null> {
    const d = this.#d;
    let grant: SlotGrant;
    this.#phase("slot");
    try {
      grant = await d.pacer.waitForSlot(signals.stop);
    } catch (error) {
      if (isAbort(error, signals.stop)) return { kind: "stopped" };
      throw error;
    }
    if (signals.stop.aborted) return { kind: "stopped" };
    this.#phase("pick");
    const page = await getSyncPage(d.db, d.pageId);
    if (page === null) return { kind: "mode_changed", mode: null };
    const holds = holdSetOf(page.holds);
    if (!holds.routes.ok) {
      await this.#sleep(ROUTE_STATE_RECHECK_MS, signals.stop);
      return null;
    }
    const clocks = await this.#routeClocks(holds.routes.state);
    const checksOnly = (await this.#unverifiedStoredDigest(page)) !== null || d.transport.needsSessionConfirmation?.() === true;
    const served = await this.#trySite(grant, page, holds, clocks, d.clock.wallNow(), checksOnly, signals);
    return served === "none" ? null : served;
  }

  /** The site's slot: the oldest request admissible now, if any ("none":
   *  nothing to admit, the slot is free). */
  async #trySite(
    grant: SlotGrant,
    page: SyncPageRow,
    holds: HoldSet,
    clocks: RouteClocks,
    now: Date,
    checksOnly: boolean,
    signals: ActorSignals,
    urgentOnly = false,
  ): Promise<ActorExit | null | "none"> {
    const d = this.#d;
    const site = d.site!;
    if (site.pending().length === 0) return "none";
    const ctx = await siteContextOf(d, { page, holds, clocks, specs: d.registry.specs, checksOnly, bootstrapOnly: d.transport.needsSiteBootstrap?.() === true, now });
    const classified = settleSiteDecision(d, site, ctx, urgentOnly);
    this.#lapState.siteCandidate = classified !== null;
    if (classified === null) return "none";
    // What the route check just applied, recorded on the attempt (I19).
    const intervals = clocks.intervals(classified.route);

    this.#phase("admit");
    if ((await d.ownership.ping(PING_TIMEOUT_MS)) === "timeout") {
      d.metrics.increment("sync_ping_timeouts", { pageId: d.pageId });
      if (!(await d.ownership.stillHolds(d.pageId))) return { kind: "ownership_lost", foreign: false };
      return null;
    }
    // A cancellation or a new RPC epoch during the ownership ping must
    // not admit a dead choice (including a re-ask of the same id).
    if (!site.pending().includes(classified.request)) return "none";
    // The send window starts BEFORE the admission commit (SK16).
    const issuedMono = d.clock.monoNow();
    let attemptId: number;
    try {
      ({ attemptId } = await admitSite(d, { classified, grant, intervals }));
    } catch (error) {
      if (error instanceof LiveGateClosedError) {
        d.metrics.increment("sync_live_gate_closed", { pageId: d.pageId, reason: error.reason });
        await this.#sleep(LIVE_GATE_RECHECK_MS, signals.stop);
        return null;
      }
      // A hold or the pause written since the decision: the request keeps
      // waiting (or is refused by the next lap's decision).
      if (error instanceof AdmissionHeldError) return null;
      throw error;
    }
    this.#admittedThisLap = true;
    d.metrics.increment("sync_site_admitted", { origin: classified.origin, route: classified.route });
    if (isSiteSocket(classified.request)) {
      d.logger.info({ pageId: d.pageId, requestId: classified.request.id, attemptId, class: "urgent", waitMs: d.clock.monoNow() - classified.request.askedMono, waitRemainingMs: classified.request.waitDeadlineMono === undefined ? null : classified.request.waitDeadlineMono - d.clock.monoNow(), settingMs: grant.settingMs }, "Fansly sync actor: socket admitted ahead of site reads through the common pacer");
    }
    const armed = d.pacer.arm(grant, attemptId, issuedMono);
    // The final word before the browser may send: the same check an engine
    // send passes at `onRequestStart` (ownership alive, within the window,
    // past the floor and the pause), without its send mark (Astra's review
    // of PR 8: a lost ownership must never reach a grant).
    const refusal = d.pacer.checkRemoteGrant(armed);
    let end: SiteRequestEnd;
    if (refusal !== null) {
      site.refuse(classified.request.id, "lease", classified.request);
      d.metrics.increment("sync_site_refused", { reason: "lease" });
      end = { kind: "aborted_before_send", reason: refusal.reason };
    } else {
      const granted = site.grant(classified.request.id, { attemptId, sendWithinMs: Math.max(0, armed.sendDeadlineMono - d.clock.monoNow()) }, classified.request);
      this.#phase("send");
      end = granted === false ? { kind: "aborted_before_send", reason: "request_cancelled" } : await siteEnd(site, classified.request.id, signals.abort);
    }
    // The send counts at the instant the browser reported (PR 12), else at
    // the completion when it may have gone out (the safe upper bound).
    d.pacer.complete(armed, transportOutcomeOfSite(end));
    // A grant is not a send: late/cancelled admissions leave the site's
    // turn intact, as they leave the common pacer's send floor intact.
    if (!isSiteSocket(classified.request) && (end.kind === "response" || (end.kind === "transport_error" && end.sent))) this.#siteTurns.siteAdmitted();
    this.#phase("commit");
    const committed = await this.#committed(() => commitSiteEnd(d, { attemptId, send: captureSendOf(d, armed), end, classified }));
    if (!committed.ok) {
      if (committed.exit.kind === "failed") {
        await markAttemptCommitFailed(d.db, { attemptId, errorClass: `commit_failed:${committed.exit.error}` }).catch(() => false);
      }
      return committed.exit;
    }
    // Committed: the browser may drop the end it kept (PR 14).
    try {
      site.settled?.(classified.request.id, attemptId);
    } catch (error) {
      d.logger.debug({ attemptId, err: errorName(error) }, "Fansly sync actor: the site path's settle failed");
    }
    return null;
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
        // A sender outside the process (a page's browser): the same check
        // without the send mark — the pacer marks the send at the instant
        // the transport reports, or at the completion (I1).
        grant: () => d.pacer.checkRemoteGrant(armed),
      }, abort, {
        attemptId: armed.attemptId,
        ownerGeneration: d.generation,
        issuedMono: armed.issuedMono,
        sendDeadlineMono: armed.sendDeadlineMono,
      });
    } catch (error) {
      // Transports report outcomes, they do not throw; a throw is treated as a
      // failure that may have reached the wire if the check (or the grant)
      // passed.
      return { kind: "transport_error", sent: armed.sentMono !== null || armed.grantedMono !== null, message: errorName(error) };
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
      const settled = await this.#committed(() => settleNotSent(d, admission, outcome));
      if (!settled.ok) await this.#markCommitFailed(admission, settled.exit);
      else this.#settled(admission.attemptId);
      return exitOf(settled);
    }
    const captured = await this.#committed(() => capture(d, admission, captureSendOf(d, armed), outcome, module));
    if (!captured.ok) {
      await this.#markCommitFailed(admission, captured.exit);
      return captured.exit;
    }
    // A sender that keeps outcomes until they are acknowledged (a page's
    // browser, plan §4.2) may drop this one once what it carried is
    // committed: the raw answer, by the capture — or, for a route the
    // journal does not keep (a CDN hop: its bytes reach the describer's
    // handoff in the apply), by the apply, as the attempt's persisted state
    // says (a capture repeated after a lost COMMIT acknowledgement decides
    // nothing, so its `applyNow: false` proves nothing). Otherwise the
    // sender keeps it, and delivers it again.
    const inMemoryOnly = isAnswerInMemory(admission.request.spec);
    if (!inMemoryOnly) this.#settled(admission.attemptId);
    this.#phase("apply");
    await this.#fault("after_capture");
    if (captured.value.applyNow) {
      await apply(d, { attemptId: admission.attemptId, operation: admission.request.spec }, captured.value.inMemory);
    }
    if (inMemoryOnly && await this.#answerCommitted(admission.attemptId)) this.#settled(admission.attemptId);
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

  /** An answer the journal does not keep is committed whole: its attempt is
   *  settled, and applied — or nothing of it was to be applied (an answer
   *  that is not one to apply). A read that fails: not proven. */
  async #answerCommitted(attemptId: number): Promise<boolean> {
    try {
      const attempt = await getSyncAttempt(this.#d.db, attemptId);
      if (attempt === null || attempt.outcome === "admitted" || attempt.outcome === "sent") return false;
      return attempt.applyState === "applied" || attempt.applyState === "none";
    } catch (error) {
      this.#d.logger.debug({ attemptId, err: errorName(error) }, "Fansly sync actor: an attempt's state did not read; its answer stays with the sender");
      return false;
    }
  }

  /** Tell the transport an attempt's outcome is committed (never throws). */
  #settled(attemptId: number): void {
    try {
      this.#d.transport.settled?.(attemptId);
    } catch (error) {
      this.#d.logger.debug({ attemptId, err: errorName(error) }, "Fansly sync actor: the transport's settle failed");
    }
  }

  /** The transport cannot take a request now: one log line per reason. */
  #transportUnavailable(reason: string): void {
    if (this.#transportProblem === reason) return;
    this.#transportProblem = reason;
    this.#d.logger.warn({ pageId: this.#d.pageId, reason }, "Fansly sync actor: the page transport cannot take a request now; nothing is admitted");
  }

  /** The actor gives up on a commit after the request (`failed`): the attempt
   *  says why (`commit_failed:<SQLSTATE|name>`) before recovery closes it
   *  `unknown` — best effort, in its own transaction; without the database
   *  the class stays null. */
  async #markCommitFailed(admission: AdmissionRecord, exit: ActorExit): Promise<void> {
    if (exit.kind !== "failed") return;
    const d = this.#d;
    try {
      await markAttemptCommitFailed(d.db, { attemptId: admission.attemptId, errorClass: `commit_failed:${exit.error}` });
    } catch (error) {
      d.logger.debug({ attemptId: admission.attemptId, err: errorName(error) }, "Fansly sync actor: best-effort commit-failed mark failed");
    }
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
    this.#lapState.phase = phase;
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
