import type { FanslyWireOutcome, FanslyWireRead, FanslyWireSpec } from "@agency_hub_core/fansly";
import { readFanslyWireResponse } from "@agency_hub_core/fansly";
import { parseRetryAfterDelayMsUnclamped } from "@agency_hub_core/shared";

import type { SyncAlertSubKey } from "./ports.ts";

// Errors of the Fansly Sync Engine: what an outcome means and what it does
// (plan §9, design §3.8). Two pure halves:
//
//   classifyWireOutcome — one physical request's outcome → an error class;
//   onOutcome           — an error class + the page's and the subject's
//                         current state → every state change and alert, in
//                         ONE place (page hold, network streak, subject
//                         breaker, resource breaker, quarantine).
//
// The commit transactions write the decisions; nothing here touches the
// database. The pause setting S is never changed by the engine: a 429 holds
// the page and alerts the owner, who decides.
//
// Changing the reaction to 429 / 5xx is this file plus tests/sync-errors.test.ts
// (plan §12).

/** 429 without `Retry-After`: hold the whole page 2 → 4 → 8 → 30 min. */
export const RATE_LIMIT_HOLD_LADDER_MS = [2, 4, 8, 30].map((minutes) => minutes * 60_000);
/** [A8] The 429 ladder starts over after an hour without a 429. */
export const RATE_LIMIT_LADDER_RESET_MS = 60 * 60_000;
/** Per subject (a chat, a media, a target): 1 min → 10 min → 1 h → 6 h → 24 h. */
export const SUBJECT_BREAKER_LADDER_MS = [60_000, 600_000, 3_600_000, 21_600_000, 86_400_000];
/** At this many consecutive failures the subject is `blocked_by_vendor`. */
export const SUBJECT_BLOCK_AFTER = 5;
/** A blocked subject is probed once a day while demand for it exists. */
export const BLOCKED_PROBE_EVERY_MS = 86_400_000;
/** ≥ this many distinct failing subjects of one resource file … */
export const RESOURCE_BREAKER_SUBJECTS = 5;
/** … within this window hold the whole resource file. */
export const RESOURCE_BREAKER_WINDOW_MS = 600_000;
export const RESOURCE_HOLD_LADDER_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** Resource keys a resource hold never stops: live confirmations continue
 *  while the rest of their file is held (plan §9 "живые сообщения не
 *  останавливаются"). Their failures never start a resource hold either. */
export const RESOURCE_HOLD_EXEMPT_KEYS: ReadonlySet<string> = new Set(["dm-messages.head"]);
/** Consecutive network failures that pause the page … */
export const NETWORK_FAILURES_TO_PAUSE = 3;
/** … for 10 s → 30 s → 1 min → 2 min → 5 min ([A7]; the plan gives only the ends). */
export const NETWORK_PAUSE_LADDER_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
/** A network hold that has lasted longer than this pages the owner. */
export const NETWORK_ALERT_AFTER_MS = 600_000;

/** Statuses that are never a subject's terminal answer, whatever a resource
 *  declares: they are about the page or the wire. */
const NEVER_TERMINAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 429]);

export type ErrorClass =
  | "ok"
  | "rate_limit"
  | "auth"
  | "identity_mismatch"
  | "subject_failure"
  | "subject_terminal"
  | "network"
  | "contract"
  | "cursor_stuck"
  | "envelope_unsuccessful";

/** An error class, or `not_sent`: the send check refused the dispatch (or the
 *  call was cancelled before it), so nothing reached Fansly and nothing about
 *  Fansly is learned. */
export type OutcomeClass = ErrorClass | "not_sent";

export type PageHoldKind = "rate_limit" | "auth" | "identity_mismatch" | "network";

/** The JS stand-in for a timestamptz `'infinity'` (auth and identity holds). */
export const INDEFINITE_UNTIL = new Date(8.64e15);

export function isIndefinite(until: Date | null): boolean {
  return until !== null && until.getTime() >= INDEFINITE_UNTIL.getTime();
}

// ── classification ──────────────────────────────────────────────────────────

export interface ClassifiedOutcome<R> {
  errorClass: OutcomeClass;
  /** The HTTP status, when an answer came back. */
  httpStatus: number | null;
  /** `Retry-After` as the provider stated it (never clamped), in ms from `now`. */
  retryAfterMs: number | null;
  /** The answer read against its spec (envelope, contract), when one came back. */
  read: FanslyWireRead<R> | null;
}

/**
 * Classify one wire outcome (design §3.8 table):
 *
 * | answer                                              | class |
 * |---|---|
 * | the dispatch was refused / cancelled before sending | `not_sent` |
 * | transport error, timeout, 408                       | `network` |
 * | 429; a 5xx naming its own deadline (`Retry-After`)  | `rate_limit` (the provider's pace, page-wide) |
 * | 401 / 403                                           | `auth` |
 * | a status the resource declares terminal             | `subject_terminal` |
 * | any other non-2xx (3xx included: an answer, never a hop) | `subject_failure` |
 * | 2xx without a success envelope                      | `envelope_unsuccessful` |
 * | 2xx the contract refuses                            | `contract` |
 * | 2xx the contract accepts                            | `ok` |
 *
 * `cursor_stuck` and `identity_mismatch` are found by the resource's apply,
 * not here; they go through `onOutcome` all the same.
 */
export function classifyWireOutcome<P, R>(
  outcome: FanslyWireOutcome,
  spec: FanslyWireSpec<P, R>,
  params: P,
  options: { now: Date; terminalStatuses?: readonly number[] },
): ClassifiedOutcome<R> {
  switch (outcome.kind) {
    case "aborted_before_send":
      return { errorClass: "not_sent", httpStatus: null, retryAfterMs: null, read: null };
    case "transport_error":
    case "timeout":
      return { errorClass: "network", httpStatus: null, retryAfterMs: null, read: null };
    case "response":
      break;
  }
  const read = readFanslyWireResponse(spec, params, outcome);
  const status = outcome.status;
  const retryAfterMs = read.kind === "http_error"
    ? parseRetryAfterDelayMsUnclamped(read.retryAfter, options.now.getTime())
    : null;
  const classified = (errorClass: OutcomeClass): ClassifiedOutcome<R> => ({
    errorClass,
    httpStatus: status,
    retryAfterMs,
    read,
  });
  if (status === 429) return classified("rate_limit");
  if (status === 401 || status === 403) return classified("auth");
  if (status === 408) return classified("network");
  switch (read.kind) {
    case "accepted":
      return classified("ok");
    case "contract_violation":
      return classified("contract");
    case "envelope_unsuccessful":
      return classified("envelope_unsuccessful");
    case "http_error":
      if ((options.terminalStatuses ?? []).includes(status) && !NEVER_TERMINAL_STATUSES.has(status)) {
        return classified("subject_terminal");
      }
      // A 5xx that names its own deadline is the provider's pace, about the
      // page, not the subject (the legacy `isSubjectScopedFanslyFailure`
      // split): the whole page waits until that deadline.
      if (status >= 500 && retryAfterMs !== null) return classified("rate_limit");
      return classified("subject_failure");
  }
}

// ── decisions ───────────────────────────────────────────────────────────────

/** `sync_pages.resource_holds[<file>]`. */
export interface ResourceHoldEntry {
  until: string;
  step: number;
  since: string;
}

/** The page fields `onOutcome` reads; names follow the `sync_pages` row. */
export interface PageErrorState {
  holdKind: PageHoldKind | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  /** The 429 ladder position (it survives the hold for the [A8] decay). */
  holdStep: number;
  holdDetail: Readonly<Record<string, unknown>>;
  networkFailureStreak: number;
  resourceHolds: Readonly<Record<string, ResourceHoldEntry>>;
  credentialsGeneration: string | null;
}

/** The breaker of the subject the request was about: the work row's, or the
 *  subject-queue row's for a queue walk (design §4.3). */
export interface SubjectBreakerState {
  failureCount: number;
  breakerUntil: Date | null;
  blockedByVendorAt: Date | null;
}

export interface OutcomeInput {
  errorClass: OutcomeClass;
  now: Date;
  /** The resource key `<file>.<variant>` of the work. */
  resource: string;
  subject: string;
  httpStatus: number | null;
  retryAfterMs: number | null;
  page: PageErrorState;
  /** The newest 429 of the page BEFORE this outcome (from `sync_attempts`),
   *  for the [A8] ladder decay; null when there was none. */
  lastRateLimitAt: Date | null;
  subjectState: SubjectBreakerState;
  /** The work is a subject-queue walk: the breaker belongs to the queue
   *  subject and the walk row goes on with the next subject. */
  subjectQueue: boolean;
  /** Distinct subjects of this resource file (exempt keys excluded) whose
   *  request failed with `subject_failure` within RESOURCE_BREAKER_WINDOW_MS,
   *  this one included. Read only for `subject_failure`. */
  recentFailedSubjects: number;
}

export type PageHoldDecision =
  | { action: "keep" }
  | {
    action: "set";
    kind: PageHoldKind;
    until: Date | "infinity";
    /** `sync_pages.hold_step` to store. */
    step: number;
    detail: Record<string, unknown>;
  }
  /** Lift an expired hold; `resetStep` also restarts the 429 ladder. */
  | { action: "clear"; resetStep: boolean };

export type WorkDecision =
  /** A 2xx-ok answer: the apply transaction settles the work. */
  | { action: "apply" }
  /** Back to `open`. `dueAt` null = keep the row's due time. */
  | { action: "reopen"; dueAt: Date | null; waitingReason: WaitingReasonForError | null; waitingUntil: Date | null }
  | { action: "quarantine"; reason: string }
  | { action: "close"; closeReason: string };

export type WaitingReasonForError = "page_hold" | "subject_breaker" | "blocked_by_vendor" | "resource_hold";

export interface SubjectBreakerDecision extends SubjectBreakerState {
  /** The subject's final answer (terminal) — no breaker, close with a receipt. */
  terminal: boolean;
}

export type ResourceHoldDecision =
  | { action: "keep" }
  | { action: "set"; file: string; until: Date; step: number }
  | { action: "clear"; file: string };

export interface AlertDecision {
  subKey: Extract<SyncAlertSubKey, "page_stopped" | "live_degraded">;
  detail: string;
}

export interface OutcomeDecision {
  errorClass: OutcomeClass;
  /** `sync_attempts.error_class`; null for `ok`. */
  attemptErrorClass: OutcomeClass | null;
  pageHold: PageHoldDecision;
  /** The new `sync_pages.network_failure_streak`; null = unchanged. */
  networkFailureStreak: number | null;
  work: WorkDecision;
  /** The subject's breaker to write; null = unchanged. */
  subjectBreaker: SubjectBreakerDecision | null;
  resourceHold: ResourceHoldDecision;
  /** The attempt's apply state is `quarantined` (contract, cursor, identity). */
  quarantineAttempt: boolean;
  alerts: AlertDecision[];
}

export function resourceFileOf(resource: string): string {
  const dot = resource.indexOf(".");
  return dot < 0 ? resource : resource.slice(0, dot);
}

export function isResourceHoldExempt(resource: string): boolean {
  return RESOURCE_HOLD_EXEMPT_KEYS.has(resource);
}

/** The resource hold that stops `resource` now, or null. Exempt keys are
 *  never stopped by their file's hold. */
export function activeResourceHold(
  holds: Readonly<Record<string, ResourceHoldEntry>>,
  resource: string,
  now: Date,
): { file: string; until: Date; step: number } | null {
  if (isResourceHoldExempt(resource)) return null;
  const file = resourceFileOf(resource);
  const entry = holds[file];
  if (!entry) return null;
  const until = new Date(entry.until);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) return null;
  return { file, until, step: entry.step };
}

/**
 * The page hold in force now, or null. An auth or identity hold is
 * indefinite until the page's credentials generation differs from the one
 * the hold was taken under (`hold_detail.credentialsGeneration`); the actor
 * then lifts it and queues an urgent identity check (plan §9).
 */
export function activePageHold(
  page: Pick<PageErrorState, "holdKind" | "holdUntil" | "holdDetail" | "credentialsGeneration">,
  now: Date,
): { kind: PageHoldKind; until: Date } | null {
  if (page.holdKind === null || page.holdUntil === null) return null;
  if (page.holdUntil.getTime() <= now.getTime()) return null;
  if (page.holdKind === "auth" || page.holdKind === "identity_mismatch") {
    const heldUnder = page.holdDetail.credentialsGeneration;
    if (typeof heldUnder === "string" && page.credentialsGeneration !== null && heldUnder !== page.credentialsGeneration) {
      return null;
    }
  }
  return { kind: page.holdKind, until: page.holdUntil };
}

/** The 429 ladder position to use now: the stored one, or 0 after an hour
 *  without a 429 ([A8]). */
export function rateLimitStep(holdStep: number, lastRateLimitAt: Date | null, now: Date): number {
  if (lastRateLimitAt === null) return 0;
  if (now.getTime() - lastRateLimitAt.getTime() >= RATE_LIMIT_LADDER_RESET_MS) return 0;
  return Math.max(0, Math.trunc(holdStep));
}

function ladder(values: readonly number[], index: number): number {
  return values[Math.min(Math.max(0, index), values.length - 1)]!;
}

function later(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

/** The subject breaker after one more failure (plan §9). */
export function nextSubjectBreaker(state: SubjectBreakerState, now: Date): SubjectBreakerDecision {
  const failureCount = Math.max(0, state.failureCount) + 1;
  if (failureCount >= SUBJECT_BLOCK_AFTER) {
    return {
      failureCount,
      breakerUntil: later(now, Math.max(BLOCKED_PROBE_EVERY_MS, ladder(SUBJECT_BREAKER_LADDER_MS, failureCount - 1))),
      blockedByVendorAt: state.blockedByVendorAt ?? now,
      terminal: false,
    };
  }
  return {
    failureCount,
    breakerUntil: later(now, ladder(SUBJECT_BREAKER_LADDER_MS, failureCount - 1)),
    blockedByVendorAt: null,
    terminal: false,
  };
}

const KEEP_HOLD: PageHoldDecision = { action: "keep" };
const KEEP_RESOURCE: ResourceHoldDecision = { action: "keep" };

/**
 * Every consequence of one outcome (design §3.8 "one place"). Pure: the
 * caller writes the decision in the transaction that records the outcome
 * (capture, or the apply's error settlement) and opens the alerts (a shadow
 * page records them as metrics only).
 */
export function onOutcome(input: OutcomeInput): OutcomeDecision {
  const { now, page } = input;
  const base = {
    errorClass: input.errorClass,
    attemptErrorClass: input.errorClass === "ok" ? null : input.errorClass,
    pageHold: KEEP_HOLD,
    networkFailureStreak: null,
    subjectBreaker: null,
    resourceHold: KEEP_RESOURCE,
    quarantineAttempt: false,
    alerts: [],
  } satisfies Omit<OutcomeDecision, "work">;
  // Any answer proves the network works: the streak ends.
  const streakReset = page.networkFailureStreak === 0 ? null : 0;
  const reopenNow: WorkDecision = { action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null };

  switch (input.errorClass) {
    case "ok": {
      // A hold still in force is never lifted by an answer (none is admitted
      // under one; an identity check under new credentials runs only after
      // the actor lifted the old auth hold). A recorded hold that is no longer
      // in force — expired, or an auth/identity hold of older credentials — is
      // cleared, and the 429 ladder restarts after an hour without a 429.
      const holdInForce = activePageHold(page, now) !== null;
      const decayed = rateLimitStep(page.holdStep, input.lastRateLimitAt, now) === 0 && page.holdStep !== 0;
      const staleHold = page.holdKind !== null && !holdInForce;
      const file = resourceFileOf(input.resource);
      const entry = page.resourceHolds[file];
      const resourceExpired = entry !== undefined && !(new Date(entry.until).getTime() > now.getTime());
      const breakerSet = input.subjectState.failureCount !== 0 ||
        input.subjectState.breakerUntil !== null ||
        input.subjectState.blockedByVendorAt !== null;
      return {
        ...base,
        pageHold: !holdInForce && (staleHold || decayed) ? { action: "clear", resetStep: decayed } : KEEP_HOLD,
        networkFailureStreak: streakReset,
        work: { action: "apply" },
        subjectBreaker: breakerSet
          ? { failureCount: 0, breakerUntil: null, blockedByVendorAt: null, terminal: false }
          : null,
        resourceHold: resourceExpired && !isResourceHoldExempt(input.resource)
          ? { action: "clear", file }
          : KEEP_RESOURCE,
      };
    }

    case "not_sent":
      // Nothing reached Fansly: no breaker, no streak, no hold. The work is
      // admitted again through a new slot.
      return { ...base, attemptErrorClass: "not_sent", work: reopenNow };

    case "network": {
      const streak = Math.max(0, page.networkFailureStreak) + 1;
      if (streak < NETWORK_FAILURES_TO_PAUSE) {
        return { ...base, networkFailureStreak: streak, work: reopenNow };
      }
      const until = later(now, ladder(NETWORK_PAUSE_LADDER_MS, streak - NETWORK_FAILURES_TO_PAUSE));
      // The hold is re-taken after every failed retry; the instant the network
      // went away rides along in the detail so "> 10 min" is measurable.
      const priorSince = page.holdKind === "network" ? sinceOf(page.holdDetail.networkSince) ?? page.holdSince : null;
      const networkSince = priorSince ?? now;
      const alerts: AlertDecision[] = now.getTime() - networkSince.getTime() > NETWORK_ALERT_AFTER_MS
        ? [{ subKey: "page_stopped", detail: "network" }]
        : [];
      return {
        ...base,
        networkFailureStreak: streak,
        pageHold: {
          action: "set",
          kind: "network",
          until,
          step: page.holdStep,
          detail: { streak, networkSince: networkSince.toISOString() },
        },
        work: { action: "reopen", dueAt: null, waitingReason: "page_hold", waitingUntil: until },
        alerts,
      };
    }

    case "rate_limit": {
      const step = rateLimitStep(page.holdStep, input.lastRateLimitAt, now);
      const holdMs = input.retryAfterMs ?? ladder(RATE_LIMIT_HOLD_LADDER_MS, step);
      const until = later(now, Math.max(0, holdMs));
      return {
        ...base,
        networkFailureStreak: streakReset,
        pageHold: {
          action: "set",
          kind: "rate_limit",
          until,
          step: step + 1,
          detail: {
            status: input.httpStatus,
            retryAfterMs: input.retryAfterMs,
            lastRateLimitAt: now.toISOString(),
          },
        },
        work: { action: "reopen", dueAt: null, waitingReason: "page_hold", waitingUntil: until },
        alerts: [{ subKey: "page_stopped", detail: "rate_limit" }],
      };
    }

    case "auth":
      return {
        ...base,
        networkFailureStreak: streakReset,
        pageHold: {
          action: "set",
          kind: "auth",
          until: "infinity",
          step: page.holdStep,
          detail: { status: input.httpStatus, credentialsGeneration: page.credentialsGeneration },
        },
        work: { action: "reopen", dueAt: null, waitingReason: "page_hold", waitingUntil: null },
        alerts: [{ subKey: "page_stopped", detail: "auth" }],
      };

    case "identity_mismatch":
      return {
        ...base,
        networkFailureStreak: streakReset,
        pageHold: {
          action: "set",
          kind: "identity_mismatch",
          until: "infinity",
          step: page.holdStep,
          detail: { credentialsGeneration: page.credentialsGeneration },
        },
        work: { action: "quarantine", reason: "identity_mismatch" },
        quarantineAttempt: true,
        alerts: [
          { subKey: "page_stopped", detail: "identity_mismatch" },
          { subKey: "live_degraded", detail: "quarantined" },
        ],
      };

    case "contract":
    case "cursor_stuck":
      // The raw answer is journaled; after a fix the owner re-applies it from
      // the journal without a request (`sync work requeue --quarantined`).
      return {
        ...base,
        networkFailureStreak: streakReset,
        work: { action: "quarantine", reason: input.errorClass },
        quarantineAttempt: true,
        alerts: [{ subKey: "live_degraded", detail: "quarantined" }],
      };

    case "subject_terminal":
      return {
        ...base,
        networkFailureStreak: streakReset,
        work: input.subjectQueue
          ? reopenNow
          : { action: "close", closeReason: `subject_terminal:${input.httpStatus ?? "?"}` },
        subjectBreaker: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null, terminal: true },
      };

    case "subject_failure":
    case "envelope_unsuccessful": {
      const breaker = nextSubjectBreaker(input.subjectState, now);
      const reason: WaitingReasonForError = breaker.blockedByVendorAt !== null ? "blocked_by_vendor" : "subject_breaker";
      const file = resourceFileOf(input.resource);
      const current = page.resourceHolds[file];
      const holdActive = current !== undefined && new Date(current.until).getTime() > now.getTime();
      let resourceHold: ResourceHoldDecision = KEEP_RESOURCE;
      if (
        !isResourceHoldExempt(input.resource) &&
        !holdActive &&
        input.recentFailedSubjects >= RESOURCE_BREAKER_SUBJECTS
      ) {
        // An expired entry still on the row means the storm came back before
        // any success cleared it: the ladder climbs.
        const step = current === undefined ? 0 : Math.max(0, current.step);
        resourceHold = {
          action: "set",
          file,
          until: later(now, ladder(RESOURCE_HOLD_LADDER_MS, step)),
          step: step + 1,
        };
      }
      return {
        ...base,
        networkFailureStreak: streakReset,
        work: input.subjectQueue
          ? reopenNow
          : { action: "reopen", dueAt: breaker.breakerUntil, waitingReason: reason, waitingUntil: breaker.breakerUntil },
        subjectBreaker: breaker,
        resourceHold,
      };
    }
  }
}

function sinceOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
