import { FANSLY_PAUSE_MIN_MS } from "@agency_hub_core/shared";

// The contract module directly, not the package index: the index also loads
// the adapter (and with it undici's fetch), which the pacer never needs.
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
// monotonic clock; where a transport cannot mark it, the completion instant is
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
  /** How the send instant was taken: at `onRequestStart`, or the completion
   *  instant as the safe upper bound when the transport gave no such mark. */
  sendMark: "request_start" | "completion_fallback" | null;
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
  async waitForSlot(signal: AbortSignal): Promise<SlotGrant> {
    for (;;) {
      signal.throwIfAborted();
      this.#assertCanAdmit();
      const settingMs = this.#effectiveSetting(await this.#deps.pause.readSettingMs());
      signal.throwIfAborted();
      this.#assertCanAdmit();
      const jitterU = (this.#st.pendingU ??= this.#drawU());
      const pauseMs = Math.ceil(settingMs * (1 + jitterU));
      const earliestMono = this.#earliestMono(pauseMs);
      const now = this.#deps.clock.monoNow();
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
    this.#markSent(admission, now, "request_start");
    return null;
  }

  /**
   * After the response body was read, or the request failed or was aborted.
   * A request that may have reached the wire without an `onRequestStart`
   * mark is counted as sent at this instant (the safe upper bound).
   */
  complete(admission: Admission, outcome: TransportOutcome): void {
    if (this.#st.inFlight !== admission) throw new PacerInvariantError("foreign_admission");
    const now = this.#deps.clock.monoNow();
    const mayHaveSent = outcome.kind === "response" ||
      outcome.kind === "shadow" ||
      ((outcome.kind === "transport_error" || outcome.kind === "timeout") && outcome.sent);
    if (admission.sentMono === null && mayHaveSent) {
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
    );
  }

  #markSent(admission: Admission, now: number, mark: "request_start" | "completion_fallback"): void {
    admission.gapPrevMs = this.#st.lastSendMono === null ? null : now - this.#st.lastSendMono;
    this.#st.lastSendMono = now;
    admission.sentMono = now;
    admission.sentWall = this.#deps.clock.wallNow();
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
