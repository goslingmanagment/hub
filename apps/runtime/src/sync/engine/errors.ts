import type { FanslyWireOutcome, FanslyWireRead, FanslyWireSpec } from "@agency_hub_core/fansly";
import { readFanslyWireResponse } from "@agency_hub_core/fansly";
import { parseRetryAfterDelayMsUnclamped } from "@agency_hub_core/shared";

import type { FanslyRoute } from "../fansly/routes.ts";
import type { SyncAlertSubKey } from "./ports.ts";
import { routeHoldAfter, type RouteHold } from "./route-holds.ts";
import type { RouteStateEntry } from "./route-policy.ts";

// Errors of the Fansly Sync Engine: what an outcome means and what it does
// (plan §9, design §3.8). Two pure halves:
//
//   classifyWireOutcome — one physical request's outcome → an error class;
//   onOutcome           — an error class + the page's and the subject's
//                         current state → every state change and alert, in
//                         ONE place (page hold, route hold, network streak,
//                         subject breaker, resource breaker, quarantine).
//
// The commit transactions write the decisions; nothing here touches the
// database. The pause setting S is never changed by the engine: a 429 holds
// ONLY the route that answered it (owner decision №22, step 3b ruling 2 / A2,
// `route-holds.ts`) — the rest of the page, the route's family included,
// keeps running — slows that route down and opens the route's own incident
// for the owner, who decides on a raise.
//
// Changing the reaction to 429 / 5xx is this file plus tests/sync-errors.test.ts
// (plan §12).

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

/**
 * The identity checks (step-3 §3.5 item 3, G1/G14): the only keys the live
 * transport sends while the page's stored credentials are not the ones the
 * engine verified — they are the check — and the actor picks nothing else
 * meanwhile. `account.identity` work that carries a candidate is also the
 * only work an auth/identity page hold lets through (its request uses the
 * candidate, not the stored credentials that failed, E16).
 */
export const CREDENTIALS_CHECK_KEYS: ReadonlySet<string> = new Set(["account.verify", "account.identity"]);

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
 * | 429; a 5xx naming its own deadline (`Retry-After`)  | `rate_limit` (the provider's pace: the route that answered it) |
 * | 401 / 403 the resource declares about its subject   | `subject_terminal` (design G16: a CDN hop's signed URL, an excluded chat) |
 * | 401 / 403                                           | `auth` |
 * | a status the resource declares terminal             | `subject_terminal` |
 * | any other non-2xx (3xx included: an answer, never a hop) | `subject_failure` |
 * | 2xx without a success envelope                      | `envelope_unsuccessful` |
 * | 2xx the contract refuses                            | `contract` |
 * | 2xx the contract accepts                            | `ok` |
 *
 * `cursor_stuck` and `identity_mismatch` are found by the resource's apply,
 * not here; they go through `onOutcome` all the same. A `Retry-After` that is
 * an HTTP-date is measured against the answer's own `Date` too, and the later
 * of the two counts: a local clock ahead of the provider's never shortens it.
 */
export function classifyWireOutcome<P, R>(
  outcome: FanslyWireOutcome,
  spec: FanslyWireSpec<P, R>,
  params: P,
  options: {
    now: Date;
    terminalStatuses?: readonly number[];
    /** 401/403 this resource's answer is about its subject, never the page's
     *  session (`EngineResourceSpec.subjectScopedAuthStatuses`). */
    subjectScopedAuthStatuses?: readonly number[];
  },
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
  const retryAfterMs = read.kind === "http_error" ? retryAfterDelayMs(read.retryAfter, outcome.headers.date ?? null, options.now) : null;
  const classified = (errorClass: OutcomeClass): ClassifiedOutcome<R> => ({
    errorClass,
    httpStatus: status,
    retryAfterMs,
    read,
  });
  if (status === 429) return classified("rate_limit");
  if (status === 401 || status === 403) {
    // Before the page-wide `auth`: a status the resource declares about its
    // subject closes that subject with a receipt and holds nothing (G16).
    return classified((options.subjectScopedAuthStatuses ?? []).includes(status) ? "subject_terminal" : "auth");
  }
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
      // A 5xx that names its own deadline is the provider's pace, not the
      // subject's failure (the legacy `isSubjectScopedFanslyFailure` split):
      // the route that answered it waits until that deadline.
      if (status >= 500 && retryAfterMs !== null) return classified("rate_limit");
      return classified("subject_failure");
  }
}

/** `Retry-After` in ms from `now`; an HTTP-date also from the answer's own
 *  `Date` (the later of the two), never clamped. */
function retryAfterDelayMs(retryAfter: string | null, served: string | null, now: Date): number | null {
  const local = parseRetryAfterDelayMsUnclamped(retryAfter, now.getTime());
  if (local === null || served === null) return local;
  const servedAt = Date.parse(served);
  if (Number.isNaN(servedAt)) return local;
  const fromServed = parseRetryAfterDelayMsUnclamped(retryAfter, servedAt);
  return fromServed === null ? local : Math.max(local, fromServed);
}

// ── decisions ───────────────────────────────────────────────────────────────

/** `sync_pages.resource_holds[<file>]`: the §9 resource breaker of the file. */
export interface ResourceHoldEntry {
  until: string;
  step: number;
  since: string;
}

export type ResourceHoldKind = "breaker";

/** The page fields `onOutcome` reads; names follow the `sync_pages` row. */
export interface PageErrorState {
  holdKind: PageHoldKind | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  /** `sync_pages.hold_step`, carried with a hold (no ladder of its own: a 429
   *  holds its route, `route-holds.ts`). */
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

/** The route a request went out on, as a 429 needs it. */
export interface RouteOutcomeInput {
  route: FanslyRoute;
  /** Its entry in the page's route state (null: none yet). */
  entry: RouteStateEntry | null;
  /** The attempt the answer is of (a 429 is recorded once). */
  attemptId: number;
  /** A unit draw in [0, 1) for a ladder step's jitter. */
  jitter: () => number;
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
  /** The route the request went out on. Absent: an apply's own finding, or a
   *  page whose route state this build cannot read (its admission is closed;
   *  nothing is written there). */
  route?: RouteOutcomeInput;
  subjectState: SubjectBreakerState;
  /** The work is a subject-queue walk: the breaker belongs to the queue
   *  subject and the walk row goes on with the next subject. */
  subjectQueue: boolean;
  /** Distinct subjects of this resource file (exempt keys excluded) whose
   *  request failed with `subject_failure` within RESOURCE_BREAKER_WINDOW_MS,
   *  this one included. Read only for `subject_failure`. */
  recentFailedSubjects: number;
  /** The digest of the credentials the request carried
   *  (`sync_attempts.request.credentialsGeneration`): an auth/identity hold
   *  is keyed on the digest that FAILED (step-3 §3.5 item 3, G1/G14), so it
   *  lifts when the stored credentials the engine trusts change. Absent: the
   *  page's verified digest. */
  requestCredentialsGeneration?: string | null;
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
  /** Lift a hold no longer in force; `resetStep` also zeroes `hold_step`. */
  | { action: "clear"; resetStep: boolean };

export type WorkDecision =
  /** A 2xx-ok answer: the apply transaction settles the work. */
  | { action: "apply" }
  /** Back to `open`. `dueAt` null = keep the row's due time. */
  | { action: "reopen"; dueAt: Date | null; waitingReason: WaitingReasonForError | null; waitingUntil: Date | null }
  | { action: "quarantine"; reason: string }
  /** Close the work; `result` is what its waiter reads (a resource's own
   *  account of the subject's final answer, set by its outcome hook). */
  | { action: "close"; closeReason: string; result?: unknown };

export type WaitingReasonForError = "page_hold" | "subject_breaker" | "blocked_by_vendor" | "resource_hold";

export interface SubjectBreakerDecision extends SubjectBreakerState {
  /** The subject's final answer (terminal) — no breaker, close with a receipt. */
  terminal: boolean;
}

export type ResourceHoldDecision =
  | { action: "keep" }
  | { action: "set"; file: string; until: Date; step: number }
  | { action: "clear"; file: string };

/** A route's new state (`writeSyncRouteState`, a compare-and-set on its
 *  revision), or nothing. */
export type RouteHoldDecision = { action: "keep" } | ({ action: "set" } & RouteHold);

export type AlertDecision =
  | { subKey: Extract<SyncAlertSubKey, "page_stopped" | "live_degraded">; detail: string }
  /** The route's own incident (D5): opened on its first 429, refreshed — never
   *  repeated — by the next ones. */
  | { subKey: Extract<SyncAlertSubKey, "route_limited">; detail: "rate_limit" | "unavailable"; route: FanslyRoute };

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
  routeHold: RouteHoldDecision;
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

function inForce(entry: ResourceHoldEntry | undefined, now: Date): Date | null {
  if (entry === undefined) return null;
  const until = new Date(entry.until);
  return Number.isNaN(until.getTime()) || until.getTime() <= now.getTime() ? null : until;
}

/** The resource hold that stops `resource` now, or null: its file's breaker
 *  (exempt keys are never stopped by it). */
export function activeResourceHold(
  holds: Readonly<Record<string, ResourceHoldEntry>>,
  resource: string,
  now: Date,
): { file: string; until: Date; step: number; kind: ResourceHoldKind } | null {
  if (isResourceHoldExempt(resource)) return null;
  const file = resourceFileOf(resource);
  const entry = holds[file];
  const until = inForce(entry, now);
  return until === null ? null : { file, until, step: entry!.step, kind: "breaker" };
}

/** A page hold that ends at an instant: a 429 or the network. */
export type TimedPageHoldKind = Extract<PageHoldKind, "rate_limit" | "network">;
/** A page hold that only new credentials lift. */
export type CredentialsPageHoldKind = Extract<PageHoldKind, "auth" | "identity_mismatch">;

/**
 * Where an auth/identity hold carries a 429/network hold beside itself
 * (`hold_detail.timedHold = {kind, until, detail}`). The page row has one hold
 * slot, but the two holds stop the page for different reasons and end
 * differently: an auth hold taken over a 429 hold in force (the switch's
 * import I.4: a legacy auth blocker over the carried legacy 429) must not end
 * the 429, and a 429 or network failure of a candidate identity check under
 * an auth hold (E16) must neither replace nor lift the auth hold. The page is
 * held until the later of the two ends; while the timed one is in force
 * nothing is admitted — not even a candidate identity check (a 429 hold
 * exempts nothing).
 */
export const CARRIED_TIMED_HOLD_FIELD = "timedHold";

export function isCredentialsHoldKind(kind: PageHoldKind | null): kind is CredentialsPageHoldKind {
  return kind === "auth" || kind === "identity_mismatch";
}

export function isTimedHoldKind(kind: PageHoldKind | null): kind is TimedPageHoldKind {
  return kind === "rate_limit" || kind === "network";
}

export interface TimedPageHold {
  kind: TimedPageHoldKind;
  until: Date;
  detail: Record<string, unknown>;
}

type HoldView = Pick<PageErrorState, "holdKind" | "holdUntil" | "holdDetail" | "credentialsGeneration">;

/** The 429/network hold an auth/identity hold of the row carries, in force
 *  or not (null: none). */
export function carriedTimedHold(page: Pick<PageErrorState, "holdKind" | "holdDetail">): TimedPageHold | null {
  if (!isCredentialsHoldKind(page.holdKind)) return null;
  const carried = page.holdDetail[CARRIED_TIMED_HOLD_FIELD];
  if (typeof carried !== "object" || carried === null) return null;
  const { kind, until, detail } = carried as Record<string, unknown>;
  if ((kind !== "rate_limit" && kind !== "network") || typeof until !== "string") return null;
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return null;
  return { kind, until: at, detail: typeof detail === "object" && detail !== null ? { ...(detail as Record<string, unknown>) } : {} };
}

/** The 429/network hold in force now: the row's own, or the one an
 *  auth/identity hold carries beside itself. */
export function activeTimedHold(page: Pick<PageErrorState, "holdKind" | "holdUntil" | "holdDetail">, now: Date): TimedPageHold | null {
  if (isTimedHoldKind(page.holdKind)) {
    return page.holdUntil !== null && page.holdUntil.getTime() > now.getTime()
      ? { kind: page.holdKind, until: page.holdUntil, detail: { ...page.holdDetail } }
      : null;
  }
  const carried = carriedTimedHold(page);
  return carried !== null && carried.until.getTime() > now.getTime() ? carried : null;
}

/**
 * The auth or identity hold in force now, or null. It is indefinite until
 * the credentials digest the engine trusts (`credentials_generation`, written
 * after a matching identity check) differs from the one whose request failed
 * (`hold_detail.credentialsGeneration`, step-3 §3.5 item 3). A stored digest
 * that changed out of band is the actor's to notice (`SyncActor` lifts the
 * hold for one `account.verify`).
 */
export function activeCredentialsHold(page: HoldView, now: Date): { kind: CredentialsPageHoldKind; until: Date } | null {
  if (!isCredentialsHoldKind(page.holdKind) || page.holdUntil === null) return null;
  if (page.holdUntil.getTime() <= now.getTime()) return null;
  const heldUnder = page.holdDetail.credentialsGeneration;
  if (typeof heldUnder === "string" && page.credentialsGeneration !== null && heldUnder !== page.credentialsGeneration) {
    return null;
  }
  return { kind: page.holdKind, until: page.holdUntil };
}

export interface ActivePageHold {
  /** The auth/identity hold when one is in force, else the timed hold. */
  kind: PageHoldKind;
  /** The later end of the holds in force (indefinite for an auth/identity
   *  hold). */
  until: Date;
  /** The 429/network hold in force — the page's own or the one carried beside
   *  an auth/identity hold: nothing is admitted before it ends, a candidate
   *  identity check included. */
  timed: { kind: TimedPageHoldKind; until: Date } | null;
}

/**
 * The page hold in force now, or null: an auth/identity hold by its
 * credentials rule (`activeCredentialsHold`) and a 429/network hold until its
 * end (`activeTimedHold`) — both when the row carries both, the page then
 * held until the later of them ends.
 */
export function activePageHold(page: HoldView, now: Date): ActivePageHold | null {
  const timed = activeTimedHold(page, now);
  const credentials = activeCredentialsHold(page, now);
  const timedView = timed === null ? null : { kind: timed.kind, until: timed.until };
  if (credentials !== null) {
    const until = timed !== null && timed.until.getTime() > credentials.until.getTime() ? timed.until : credentials.until;
    return { kind: credentials.kind, until, timed: timedView };
  }
  return timed === null ? null : { kind: timed.kind, until: timed.until, timed: timedView };
}

type PageHoldSet = Extract<PageHoldDecision, { action: "set" }>;

function carriedDetail(hold: TimedPageHold): Record<string, unknown> {
  return { kind: hold.kind, until: hold.until.toISOString(), detail: hold.detail };
}

function withoutCarried(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...detail };
  delete rest[CARRIED_TIMED_HOLD_FIELD];
  return rest;
}

/**
 * The hold to write when `incoming` is taken over the row's current hold
 * (pure; one slot, at most two holds):
 * - an auth/identity hold over a 429/network hold in force (the row's own or
 *   one it carries) carries that hold beside itself;
 * - a 429/network hold under an auth/identity hold in force is carried beside
 *   it — the auth/identity hold stays, and a carried hold that ends later
 *   keeps its end;
 * - a 429/network hold over another one in force keeps the later end;
 * - anything else replaces the row's hold (a hold no longer in force is
 *   history).
 */
export function combinePageHold(page: PageErrorState, incoming: PageHoldSet, now: Date): PageHoldSet {
  const timed = activeTimedHold(page, now);
  if (isCredentialsHoldKind(incoming.kind)) {
    if (timed === null) return incoming;
    return { ...incoming, detail: { ...withoutCarried(incoming.detail), [CARRIED_TIMED_HOLD_FIELD]: carriedDetail(timed) } };
  }
  const incomingUntil = incoming.until === "infinity" ? INDEFINITE_UNTIL : incoming.until;
  const next: TimedPageHold = timed !== null && timed.until.getTime() > incomingUntil.getTime()
    ? timed
    : { kind: incoming.kind as TimedPageHoldKind, until: incomingUntil, detail: incoming.detail };
  const credentials = activeCredentialsHold(page, now);
  if (credentials !== null) {
    return {
      action: "set",
      kind: credentials.kind,
      until: isIndefinite(credentials.until) ? "infinity" : credentials.until,
      step: incoming.step,
      detail: { ...withoutCarried(page.holdDetail), [CARRIED_TIMED_HOLD_FIELD]: carriedDetail(next) },
    };
  }
  return next === timed ? { action: "set", kind: next.kind, until: next.until, step: incoming.step, detail: next.detail } : incoming;
}

/**
 * What lifting an auth/identity hold leaves on the row (the stored
 * credentials changed out of band, G14 (a)): the 429/network hold it carried
 * while that is still in force, else nothing.
 */
export function afterCredentialsHold(page: PageErrorState, now: Date): PageHoldDecision {
  const carried = carriedTimedHold(page);
  if (carried !== null && carried.until.getTime() > now.getTime()) {
    return { action: "set", kind: carried.kind, until: carried.until, step: page.holdStep, detail: carried.detail };
  }
  return { action: "clear", resetStep: false };
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
const KEEP_ROUTE: RouteHoldDecision = { action: "keep" };

/**
 * The next resource hold of `resource`'s file on the 30 m → 2 h → 6 h ladder
 * (plan §9): the resource breaker, and a wrong transactions writer found by an
 * apply (design §3.7.3, §5.6). A hold still in force is kept; an expired entry
 * still on the row means the trouble came back before any success cleared it,
 * so the ladder climbs. Exempt keys never take a hold.
 */
export function escalateResourceHold(
  holds: Readonly<Record<string, ResourceHoldEntry>>,
  resource: string,
  now: Date,
): ResourceHoldDecision {
  if (isResourceHoldExempt(resource)) return KEEP_RESOURCE;
  const file = resourceFileOf(resource);
  const current = holds[file];
  if (inForce(current, now) !== null) return KEEP_RESOURCE;
  const step = current === undefined ? 0 : Math.max(0, current.step);
  return { action: "set", file, until: later(now, ladder(RESOURCE_HOLD_LADDER_MS, step)), step: step + 1 };
}

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
    routeHold: KEEP_ROUTE,
    quarantineAttempt: false,
    alerts: [],
  } satisfies Omit<OutcomeDecision, "work">;
  // Any answer proves the network works: the streak ends.
  const streakReset = page.networkFailureStreak === 0 ? null : 0;
  const reopenNow: WorkDecision = { action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null };

  switch (input.errorClass) {
    case "ok": {
      // A hold still in force is never lifted by an answer (none is admitted
      // under one but a candidate identity check under an auth hold, whose
      // answer leaves the hold to the credentials rule). A recorded hold that is no longer
      // in force — expired, or an auth/identity hold of older credentials — is
      // cleared, with a `hold_step` an older build's page-wide 429 ladder left.
      // A route's hold and slowdown are not an answer's to lift.
      const holdInForce = activePageHold(page, now) !== null;
      const staleStep = page.holdStep !== 0;
      const staleHold = page.holdKind !== null && !holdInForce;
      const file = resourceFileOf(input.resource);
      const entry = page.resourceHolds[file];
      const resourceExpired = entry !== undefined && inForce(entry, now) === null;
      const breakerSet = input.subjectState.failureCount !== 0 ||
        input.subjectState.breakerUntil !== null ||
        input.subjectState.blockedByVendorAt !== null;
      return {
        ...base,
        pageHold: !holdInForce && (staleHold || staleStep) ? { action: "clear", resetStep: staleStep } : KEEP_HOLD,
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
      // went away rides along in the detail so "> 10 min" is measurable (also
      // from a network hold carried beside an auth hold).
      const carried = carriedTimedHold(page);
      const priorSince = page.holdKind === "network"
        ? sinceOf(page.holdDetail.networkSince) ?? page.holdSince
        : carried?.kind === "network" ? sinceOf(carried.detail.networkSince) : null;
      const networkSince = priorSince ?? now;
      const alerts: AlertDecision[] = now.getTime() - networkSince.getTime() > NETWORK_ALERT_AFTER_MS
        ? [{ subKey: "page_stopped", detail: "network" }]
        : [];
      return {
        ...base,
        networkFailureStreak: streak,
        pageHold: combinePageHold(page, {
          action: "set",
          kind: "network",
          until,
          step: page.holdStep,
          detail: { streak, networkSince: networkSince.toISOString() },
        }, now),
        work: { action: "reopen", dueAt: null, waitingReason: "page_hold", waitingUntil: until },
        alerts,
      };
    }

    case "rate_limit": {
      // The route that answered waits (`route-holds.ts`); the page, the
      // route's family and the work's other routes do not. The work is due
      // again at once: the route admission keeps a key all of whose routes
      // are held out of the pick, and the final check defers a plan on a
      // held route until it opens.
      const route = input.route;
      const hold = route === undefined
        ? null
        : routeHoldAfter({
          route: route.route,
          entry: route.entry,
          now,
          httpStatus: input.httpStatus ?? 429,
          retryAfterMs: input.retryAfterMs,
          attemptId: route.attemptId,
          jitter: route.jitter,
        });
      return {
        ...base,
        networkFailureStreak: streakReset,
        routeHold: hold === null ? KEEP_ROUTE : { action: "set", ...hold },
        work: reopenNow,
        alerts: route === undefined
          ? []
          : [{ subKey: "route_limited", detail: input.httpStatus === 429 ? "rate_limit" : "unavailable", route: route.route }],
      };
    }

    case "auth":
      return {
        ...base,
        networkFailureStreak: streakReset,
        pageHold: combinePageHold(page, {
          action: "set",
          kind: "auth",
          until: "infinity",
          step: page.holdStep,
          detail: { status: input.httpStatus, credentialsGeneration: failedGeneration(input) },
        }, now),
        work: { action: "reopen", dueAt: null, waitingReason: "page_hold", waitingUntil: null },
        alerts: [{ subKey: "page_stopped", detail: "auth" }],
      };

    case "identity_mismatch":
      return {
        ...base,
        networkFailureStreak: streakReset,
        pageHold: combinePageHold(page, {
          action: "set",
          kind: "identity_mismatch",
          until: "infinity",
          step: page.holdStep,
          detail: { credentialsGeneration: failedGeneration(input) },
        }, now),
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
      const resourceHold = input.recentFailedSubjects >= RESOURCE_BREAKER_SUBJECTS
        ? escalateResourceHold(page.resourceHolds, input.resource, now)
        : KEEP_RESOURCE;
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

/** The digest an auth/identity hold is keyed on: the request's, else the
 *  page's verified one. */
function failedGeneration(input: OutcomeInput): string | null {
  return input.requestCredentialsGeneration ?? input.page.credentialsGeneration;
}

function sinceOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
