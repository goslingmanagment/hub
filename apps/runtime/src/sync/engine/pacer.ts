import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";

// The contract module directly, not the package index: the pacer needs
// nothing of the wire layer the index also loads.
import {
  FanslySendRefusedError,
  type FanslySendRefusalReason,
} from "../../../../../packages/fansly/src/send-guard.ts";
import type { Clock, OwnershipSession, PauseSource, Rng, TransportOutcome } from "./ports.ts";

// The pacer: the ONLY admission authority of a Fansly page (plan §2.4, design
// §3.3, invariants I1, I2, I4, I5). Between the actual sends of any two
// requests of one page there is at least S × (1 + u), u ∈ [0, 0.2), where S is
// the owner's setting read at the admission of the later request — a strict
// minimum, not an average. "Actual send" is undici's `onRequestStart`, the
// instant right before the request headers are written, measured on the
// monotonic clock — or, for a sender outside the process (a page's browser,
// Project Browser plan §3.2), the instant it reported the request left
// (`transport_reported`); where neither is known, the completion instant is
// used instead (a safe upper bound). One request is in flight at a time; the
// first send after a takeover waits for a floor computed in the database.
//
// Every doubt closes admission: an unreadable or unusable setting throws, a
// pacer used before its takeover floor is set throws, a second dispatch of one
// admission is refused, a dispatch after the send window or after ownership
// was lost is refused. Refusals never write a byte.
//
// Changing the jitter rule is one line here plus the invariant tests
// (tests/sync-pacer.test.ts, tests/sync-pacer-property.test.ts), plan §12.

/** u ∈ [0, 0.2): each pause is S × (1 + u), 2.0 to 2.4 s at S = 2 s. */
export const JITTER_MAX = 0.2;
/** The first send after a takeover is at least 1.2 × S after the takeover
 *  facts (design §3.6; the floor itself is computed in the database). */
export const TAKEOVER_FACTOR = 1.2;
/** A waiting pacer re-reads S at least this often, so an owner who raises S
 *  lengthens the wait already in progress. */
export const SETTING_RECHECK_MS = 1_000;
/** Decision Б8: prolonged site traffic only warns; it never shortens the
 *  pause or opens an own slot early. Once per wait, after five minutes. */
export const SLOT_WAIT_WARN_MS = 5 * 60_000;
/** Admission issue (monotonic, taken before the admission transaction) →
 *  `onRequestStart`. Later than this, the dispatch is refused: no bytes. */
export const SEND_WINDOW_MS = 15_000;
/** Total budget of one request: connect and proxy tunnel, headers and the
 *  whole body (`AbortSignal.timeout`), plan §8 SIGTERM budget. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Dispatcher connect timeout (the existing http-client value). */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Unfinished attempts older than this cannot still be sending (≫ send window
 *  + request timeout); the takeover floor looks back this far. */
export const FLOOR_LOOKBACK_MS = 600_000;
/** A send of the page's browser on its own (variant Б) that has not ended
 *  holds the next own slot at most this long after it left: an end that is
 *  never told does not stop the page's own work for good. */
export const FOREIGN_IN_FLIGHT_MAX_MS = REQUEST_TIMEOUT_MS;
/** Sends in flight remembered at most; the oldest is forgotten first. */
export const FOREIGN_IN_FLIGHT_KEPT = 256;
/** An end of the browser's own send that holds (its 429, a 5xx naming its
 *  `Retry-After`, a 401 or 403) keeps every own slot closed until its hold
 *  is journaled — at most this long after it was first told (the ladder's
 *  longest step): an end whose commit never comes (an operator gone, an
 *  observation it dropped) does not stop the page's own work for good. */
export const FOREIGN_HOLD_UNJOURNALED_MAX_MS = 300_000;

export interface SlotGrant {
  /** S as read for this admission (≥ FANSLY_PAUSE_MIN_MS in production). */
  settingMs: number;
  /** u ∈ [0, JITTER_MAX). */
  jitterU: number;
  /** ceil(S × (1 + u)): the minimum gap from the previous actual send. */
  pauseMs: number;
  /** The monotonic instant the slot opened at. */
  earliestMono: number;
}

export interface Admission extends SlotGrant {
  attemptId: number;
  /** Monotonic instant taken by the actor BEFORE the admission transaction. */
  issuedMono: number;
  sendDeadlineMono: number;
  /** One-shot: the first dispatch asks the check, any further one is refused. */
  used: boolean;
  /** The actual send (monotonic), or null while nothing was sent. */
  sentMono: number | null;
  sentWall: Date | null;
  /** How the send instant was taken: at `onRequestStart`; as the sender
   *  outside the process reported it (`transport_reported`, a page's
   *  browser); or the completion instant as the safe upper bound when the
   *  transport gave no such mark. */
  sendMark: "request_start" | "completion_fallback" | "transport_reported" | null;
  /** The instant `checkRemoteGrant` let a sender outside the process go
   *  (monotonic), or null: such a sender never sends before it. */
  grantedMono: number | null;
  /** When that sender let the request go after its own sight of the page's
   *  quiet (plan-b Б12), as it reported — never before the grant, never
   *  after it was told (monotonic); null: not reported. */
  releasedMono: number | null;
  /** This pacer's previous actual send when the admission was armed: the
   *  gap of a send marked later (`transport_reported`) is measured from it. */
  prevSendMono: number | null;
  /** Gap to this pacer's previous actual send (`sync_attempts.gap_prev_ms`). */
  gapPrevMs: number | null;
  /** Why the send check refused the dispatch, if it did. */
  refusal: FanslySendRefusalReason | null;
}

export interface PacerSnapshot {
  initialized: boolean;
  stopping: boolean;
  lastSendMono: number | null;
  lastCompletionMono: number | null;
  floorMono: number;
  inFlight: { attemptId: number; used: boolean; sentMono: number | null } | null;
  pendingU: number | null;
}

export type PacerInvariantReason =
  /** An admission is in flight: the next one waits for its completion (I2). */
  | "in_flight"
  /** No takeover floor yet: the host has not confirmed ownership (I5). */
  | "no_takeover"
  /** The setting is not a finite positive number of milliseconds (I4). */
  | "setting_invalid"
  /** The takeover floor is not a finite number of milliseconds. */
  | "floor_invalid"
  /** The jitter source returned a value outside [0, 1). */
  | "rng_invalid"
  /** The admission's issue instant is not a finite monotonic reading. */
  | "issue_invalid"
  /** `complete` for an admission that is not the one in flight. */
  | "foreign_admission";

/** A pacer precondition failed. Nothing was admitted. */
export class PacerInvariantError extends Error {
  constructor(readonly reason: PacerInvariantReason, detail?: string) {
    super(`Fansly sync pacer refuses to admit (${reason})${detail ? `: ${detail}` : ""}`);
    this.name = "PacerInvariantError";
  }
}

/** The pacer was stopped (shutdown or ownership loss): no new admission. */
export class PacerStoppedError extends Error {
  constructor() {
    super("Fansly sync pacer is stopping: no new admissions");
    this.name = "PacerStoppedError";
  }
}

export interface PacerDeps {
  clock: Clock;
  rng: Rng;
  pause: PauseSource;
  /** The lock session: the send check refuses once it is gone. */
  ownership: Pick<OwnershipSession, "alive">;
  /**
   * TESTS ONLY: the floor S is clamped to (default FANSLY_PAUSE_MIN_MS, the
   * owner's 2 s minimum). The host never passes it — pinned by a grep test in
   * tests/sync-pacer.test.ts — so in production S < 2 000 ms is impossible.
   */
  minSettingMs?: number;
}

interface PacerState {
  /** This pacer's last actual send, monotonic ms. */
  lastSendMono: number | null;
  lastCompletionMono: number | null;
  /** Takeover floor. */
  floorMono: number;
  inFlight: Admission | null;
  /** u of the next pause: kept across re-waits, cleared after a completed send. */
  pendingU: number | null;
  /** Sends of the page's browser on its own not ended yet (variant Б): id →
   *  the instant it left. */
  foreign: Map<string, number>;
  /** Their ends that hold, not journaled yet: key → the instant first told. */
  unjournaledHolds: Map<string, number>;
}

export class Pacer {
  readonly #deps: PacerDeps;
  readonly #minSettingMs: number;
  readonly #st: PacerState = {
    lastSendMono: null,
    lastCompletionMono: null,
    floorMono: Number.POSITIVE_INFINITY,
    inFlight: null,
    pendingU: null,
    foreign: new Map(),
    unjournaledHolds: new Map(),
  };
  #initialized = false;
  #stopping = false;

  constructor(deps: PacerDeps) {
    const minSettingMs = deps.minSettingMs ?? FANSLY_PAUSE_MIN_MS;
    if (!Number.isFinite(minSettingMs) || minSettingMs <= 0) {
      throw new PacerInvariantError("setting_invalid", `minimum ${minSettingMs} ms`);
    }
    this.#deps = deps;
    this.#minSettingMs = minSettingMs;
  }

  /**
   * Takeover (once per ownership generation, before the first admission):
   * no send before `floorDelayMs` from now. The delay comes from the database
   * (`paceFloorFromDb`: 1.2 × S after the latest of the takeover instant, the
   * last recorded send, unfinished attempts and the legacy guard's last
   * completion). In-memory facts of this process are kept: the next slot is
   * the latest of all of them, so a takeover never shortens a pause.
   */
  initTakeover(floorDelayMs: number): void {
    if (this.#st.inFlight) throw new PacerInvariantError("in_flight");
    if (!Number.isFinite(floorDelayMs)) {
      throw new PacerInvariantError("floor_invalid", String(floorDelayMs));
    }
    this.#st.floorMono = this.#deps.clock.monoNow() + Math.max(0, floorDelayMs);
    this.#initialized = true;
  }

  /**
   * A later takeover fact learnt after the takeover (a page's browser: the
   * operator's `quiesced` names the last send it saw, plan §4.7, §4.13): no
   * send before `atMono`. Only ever raises the floor — a takeover never
   * shortens a pause.
   */
  raiseTakeoverFloor(atMono: number): void {
    if (!Number.isFinite(atMono)) throw new PacerInvariantError("floor_invalid", String(atMono));
    if (!this.#initialized) throw new PacerInvariantError("no_takeover");
    this.#st.floorMono = Math.max(this.#st.floorMono, atMono);
  }

  /**
   * A send the page's browser made on its own (variant Б: the site's own
   * request or socket handshake — observed, never admitted, owner decision
   * Б2): the next own slot waits S from it as from an own send, and none
   * opens while it has not ended (at most `FOREIGN_IN_FLIGHT_MAX_MS`).
   * `atMono` on this pacer's clock. An own admission in flight is not
   * touched: its gap stays the one it was armed with.
   */
  observeForeignSend(id: string, atMono: number): void {
    if (!Number.isFinite(atMono)) throw new PacerInvariantError("floor_invalid", String(atMono));
    if (this.#st.lastSendMono === null || atMono > this.#st.lastSendMono) this.#st.lastSendMono = atMono;
    this.#st.foreign.delete(id);
    this.#st.foreign.set(id, atMono);
    if (this.#st.foreign.size > FOREIGN_IN_FLIGHT_KEPT) this.#st.foreign.delete(this.#st.foreign.keys().next().value!);
  }

  /**
   * The end of a send `observeForeignSend` was told of (an unknown id:
   * nothing). An end that holds names its `holdKey`: no own slot opens until
   * `foreignHoldJournaled(holdKey)` says its hold is in the journal (at most
   * `FOREIGN_HOLD_UNJOURNALED_MAX_MS` after it was first told) — the slot
   * waits for the hold, never opens ahead of it. A commit that fails keeps
   * it closed; the operator tells the end again.
   */
  observeForeignEnd(id: string, holdKey?: string): void {
    this.#st.foreign.delete(id);
    if (holdKey === undefined || this.#st.unjournaledHolds.has(holdKey)) return;
    this.#st.unjournaledHolds.set(holdKey, this.#deps.clock.monoNow());
    if (this.#st.unjournaledHolds.size > FOREIGN_IN_FLIGHT_KEPT) {
      this.#st.unjournaledHolds.delete(this.#st.unjournaledHolds.keys().next().value!);
    }
  }

  /** The hold of an end `observeForeignEnd` named is journaled: it no
   *  longer keeps the slot closed (an unknown key: nothing). */
  foreignHoldJournaled(holdKey: string): void {
    this.#st.unjournaledHolds.delete(holdKey);
  }

  /** No new admission from now on; a dispatch not yet started is refused. */
  stop(): void {
    this.#stopping = true;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /**
   * Wait until the page's next slot is open. Runs BEFORE the scheduler picks
   * work ("работа выбирается в момент слота"). S is re-read on every turn (at
   * least every SETTING_RECHECK_MS), so a raised setting lengthens a wait in
   * progress; u is drawn once per send and kept across re-waits.
   */
  async waitForSlot(signal: AbortSignal, observers: {
    /** Each loop turn, including when site sends keep extending the wait. */
    onWaiting?: () => void;
    /** Once per wait longer than SLOT_WAIT_WARN_MS; admission stays closed. */
    onLongWait?: (waitMs: number) => void;
  } = {}): Promise<SlotGrant> {
    const startedMono = this.#deps.clock.monoNow();
    let warned = false;
    for (;;) {
      signal.throwIfAborted();
      this.#assertCanAdmit();
      observers.onWaiting?.();
      const settingMs = this.#effectiveSetting(await this.#deps.pause.readSettingMs());
      signal.throwIfAborted();
      this.#assertCanAdmit();
      const jitterU = (this.#st.pendingU ??= this.#drawU());
      const pauseMs = Math.ceil(settingMs * (1 + jitterU));
      const earliestMono = this.#earliestMono(pauseMs);
      const now = this.#deps.clock.monoNow();
      if (!warned && now - startedMono > SLOT_WAIT_WARN_MS) {
        warned = true;
        observers.onLongWait?.(now - startedMono);
      }
      if (now >= earliestMono) {
        return { settingMs, jitterU, pauseMs, earliestMono };
      }
      await this.#deps.clock.sleep(Math.min(earliestMono - now, SETTING_RECHECK_MS), signal);
    }
  }

  /**
   * After the admission transaction committed: the admission is in flight
   * from here until `complete`. `issuedMono` is the monotonic instant the
   * actor took BEFORE that transaction, so the send window also covers the
   * time the commit took (design §3.3, SK16).
   */
  arm(grant: SlotGrant, attemptId: number, issuedMono: number): Admission {
    if (this.#st.inFlight) throw new PacerInvariantError("in_flight");
    if (!Number.isFinite(issuedMono)) {
      throw new PacerInvariantError("issue_invalid", String(issuedMono));
    }
    const admission: Admission = {
      ...grant,
      attemptId,
      issuedMono,
      sendDeadlineMono: issuedMono + SEND_WINDOW_MS,
      used: false,
      sentMono: null,
      sentWall: null,
      sendMark: null,
      grantedMono: null,
      releasedMono: null,
      prevSendMono: this.#st.lastSendMono,
      gapPrevMs: null,
      refusal: null,
    };
    this.#st.inFlight = admission;
    return admission;
  }

  /**
   * The synchronous send check, composed onto the dispatcher for this request
   * only and called by undici at `onRequestStart`, immediately before the
   * header bytes are written. A non-null result aborts the dispatch: nothing
   * is written. Passing it IS the actual send.
   */
  check(admission: Admission): FanslySendRefusedError | null {
    if (admission.used) {
      // A redirect hop, a hidden re-send, a programming error: one admission
      // is one physical request (I3).
      return this.#refuse(admission, "lease_used");
    }
    admission.used = true;
    if (this.#st.inFlight !== admission) return this.#refuse(admission, "lease_inactive");
    if (this.#stopping || !this.#deps.ownership.alive()) return this.#refuse(admission, "lease_inactive");
    const now = this.#deps.clock.monoNow();
    if (now >= admission.sendDeadlineMono) return this.#refuse(admission, "send_deadline_passed");
    if (now < this.#st.floorMono) return this.#refuse(admission, "takeover_floor");
    // Belts: `waitForSlot` already waited for both. They fire only on a bug.
    if (this.#st.lastCompletionMono !== null && now < this.#st.lastCompletionMono) {
      return this.#refuse(admission, "pace");
    }
    if (this.#st.lastSendMono !== null && now - this.#st.lastSendMono < admission.pauseMs) {
      return this.#refuse(admission, "pace");
    }
    // A send of the browser on its own still in flight (variant Б).
    if (this.#foreignUntil() > now) return this.#refuse(admission, "pace");
    this.#markSent(admission, now, "request_start");
    return null;
  }

  /**
   * The send check of an admission the page's browser sends (Project
   * Browser: a site request, or the engine's own request through the
   * browser transport), right before the browser is told it may send: every
   * condition of `check` — one grant per admission, in flight, not stopping,
   * ownership alive, within the send window, past the takeover floor and the
   * pause — but no send mark. The browser sends later, within the window it
   * is given (it may not send at all: a session that changed, a deadline the
   * gate passed); `complete` marks the send at the instant the browser
   * reports (`transport_reported`), else at the completion (the safe upper
   * bound) when the request may have gone out.
   */
  checkRemoteGrant(admission: Admission): FanslySendRefusedError | null {
    if (admission.used) return this.#refuse(admission, "lease_used");
    admission.used = true;
    if (this.#st.inFlight !== admission) return this.#refuse(admission, "lease_inactive");
    if (this.#stopping || !this.#deps.ownership.alive()) return this.#refuse(admission, "lease_inactive");
    const now = this.#deps.clock.monoNow();
    if (now >= admission.sendDeadlineMono) return this.#refuse(admission, "send_deadline_passed");
    if (now < this.#st.floorMono) return this.#refuse(admission, "takeover_floor");
    if (this.#st.lastCompletionMono !== null && now < this.#st.lastCompletionMono) {
      return this.#refuse(admission, "pace");
    }
    if (this.#st.lastSendMono !== null && now - this.#st.lastSendMono < admission.pauseMs) {
      return this.#refuse(admission, "pace");
    }
    // A send of the browser on its own still in flight (variant Б).
    if (this.#foreignUntil() > now) return this.#refuse(admission, "pace");
    admission.grantedMono = now;
    return null;
  }

  /** A sender outside the process let the granted request go at `atMono`
   *  (its report of the release, plan-b Б12): kept between the grant and
   *  now. Before a grant, or once more: nothing. */
  noteReleased(admission: Admission, atMono: number): void {
    if (admission.grantedMono === null || admission.releasedMono !== null || !Number.isFinite(atMono)) return;
    admission.releasedMono = Math.min(Math.max(atMono, admission.grantedMono), this.#deps.clock.monoNow());
  }

  /**
   * After the response body was read, or the request failed or was aborted.
   * A request whose sender reported when it left (`transport_reported`: a
   * page's browser) is marked sent at that instant — never before this
   * process let it go (its grant or check), never after now. One that may
   * have reached the wire without either mark is counted as sent at this
   * instant (the safe upper bound).
   */
  complete(admission: Admission, outcome: TransportOutcome): void {
    if (this.#st.inFlight !== admission) throw new PacerInvariantError("foreign_admission");
    const now = this.#deps.clock.monoNow();
    const mayHaveSent = outcome.kind === "response" ||
      ((outcome.kind === "transport_error" || outcome.kind === "timeout") && outcome.sent);
    const reported = mayHaveSent ? reportedSendMono(outcome) : null;
    if (reported !== null) {
      const floor = admission.sentMono ?? admission.grantedMono ?? admission.issuedMono;
      this.#markSent(admission, Math.min(Math.max(reported, floor), now), "transport_reported", now);
    } else if (admission.sentMono === null && mayHaveSent) {
      this.#markSent(admission, now, "completion_fallback");
    } else if (outcome.kind === "response" && outcome.sendMark === "completion_fallback") {
      // The transport says it had no `onRequestStart` mark although the check
      // passed: trust the later instant.
      this.#st.lastSendMono = now;
      admission.sentMono = now;
      admission.sentWall = this.#deps.clock.wallNow();
      admission.sendMark = "completion_fallback";
    }
    if (admission.sentMono !== null || outcome.kind === "transport_error" || outcome.kind === "timeout") {
      this.#st.lastCompletionMono = now;
    }
    if (admission.sentMono !== null) {
      this.#st.pendingU = null;
    }
    this.#st.inFlight = null;
  }

  /** The monotonic instant the next slot opens at for `settingMs`, assuming
   *  the pending u (or the largest one when none is drawn yet). For status. */
  slotOpensAtMono(settingMs: number): number {
    const u = this.#st.pendingU ?? JITTER_MAX;
    return this.#earliestMono(Math.ceil(Math.max(this.#minSettingMs, settingMs) * (1 + u)));
  }

  snapshot(): PacerSnapshot {
    const inFlight = this.#st.inFlight;
    return {
      initialized: this.#initialized,
      stopping: this.#stopping,
      lastSendMono: this.#st.lastSendMono,
      lastCompletionMono: this.#st.lastCompletionMono,
      floorMono: this.#st.floorMono,
      inFlight: inFlight
        ? { attemptId: inFlight.attemptId, used: inFlight.used, sentMono: inFlight.sentMono }
        : null,
      pendingU: this.#st.pendingU,
    };
  }

  #assertCanAdmit(): void {
    if (this.#stopping) throw new PacerStoppedError();
    if (this.#st.inFlight) throw new PacerInvariantError("in_flight");
    if (!this.#initialized) throw new PacerInvariantError("no_takeover");
  }

  /** max(S, the 2 s floor); an unusable value closes admission (I4). */
  #effectiveSetting(readMs: number): number {
    if (typeof readMs !== "number" || !Number.isFinite(readMs) || readMs <= 0) {
      throw new PacerInvariantError("setting_invalid", `${String(readMs)} ms`);
    }
    return Math.max(this.#minSettingMs, readMs);
  }

  #drawU(): number {
    const r = this.#deps.rng.next();
    if (!(r >= 0 && r < 1)) throw new PacerInvariantError("rng_invalid", String(r));
    return r * JITTER_MAX;
  }

  #earliestMono(pauseMs: number): number {
    return Math.max(
      this.#st.lastSendMono === null ? Number.NEGATIVE_INFINITY : this.#st.lastSendMono + pauseMs,
      this.#st.lastCompletionMono ?? Number.NEGATIVE_INFINITY,
      this.#st.floorMono,
      this.#foreignUntil(),
    );
  }

  /** While a send of the browser on its own is in flight, or an end of one
   *  that holds is not journaled: the latest bound of them (each send at most
   *  `FOREIGN_IN_FLIGHT_MAX_MS` after it left, each end at most
   *  `FOREIGN_HOLD_UNJOURNALED_MAX_MS` after it was told; an expired one is
   *  forgotten). */
  #foreignUntil(): number {
    const now = this.#deps.clock.monoNow();
    let until = Number.NEGATIVE_INFINITY;
    const bounded = (kept: Map<string, number>, maxMs: number) => {
      for (const [key, at] of kept) {
        const bound = at + maxMs;
        if (bound <= now) kept.delete(key);
        else if (bound > until) until = bound;
      }
    };
    bounded(this.#st.foreign, FOREIGN_IN_FLIGHT_MAX_MS);
    bounded(this.#st.unjournaledHolds, FOREIGN_HOLD_UNJOURNALED_MAX_MS);
    return until;
  }

  /** The send of `admission` at `at` (monotonic); `now` is the instant of
   *  marking — a send reported for an earlier instant gets the wall time of
   *  that instant. */
  #markSent(
    admission: Admission,
    at: number,
    mark: "request_start" | "completion_fallback" | "transport_reported",
    now: number = at,
  ): void {
    admission.gapPrevMs = admission.prevSendMono === null ? null : at - admission.prevSendMono;
    // Never earlier than a send of the browser on its own told meanwhile
    // (variant Б): the pause runs from the latest send of any origin.
    this.#st.lastSendMono = this.#st.lastSendMono === null ? at : Math.max(this.#st.lastSendMono, at);
    admission.sentMono = at;
    const wall = this.#deps.clock.wallNow();
    admission.sentWall = at === now ? wall : new Date(wall.getTime() - (now - at));
    admission.sendMark = mark;
  }

  #refuse(admission: Admission, reason: FanslySendRefusalReason): FanslySendRefusedError {
    admission.refusal ??= reason;
    return new FanslySendRefusedError(reason);
  }
}

export function createPacer(deps: PacerDeps): Pacer {
  return new Pacer(deps);
}

/** The send instant a transport reported (`transport_reported`), on the
 *  pacer's clock, or null: none, or not a finite reading. */
function reportedSendMono(outcome: TransportOutcome): number | null {
  if (outcome.kind === "response") {
    return outcome.sendMark === "transport_reported" && Number.isFinite(outcome.sentMono) ? outcome.sentMono! : null;
  }
  if (outcome.kind === "transport_error" || outcome.kind === "timeout") {
    return outcome.sent && Number.isFinite(outcome.sentMono) ? outcome.sentMono! : null;
  }
  return null;
}
