// The page holds of the Fansly Sync Engine (plan §9; step 3b ruling 5 and
// amendment A3): ONE pure admission core over the hold columns of `sync_pages`
// (`hold_kind`, `hold_until`, `hold_since`, `hold_detail`). The actor's gate
// and pick, the final admission inside the admission transaction, the
// rollback's hand-back, status/why and the alerts all read a page's holds
// through it; SQL only locks the row and writes what this module decided, and
// never re-states the rule.
//
// A page holds at most two things at once in its one hold slot:
//   - a credentials hold (`auth`, `identity_mismatch`): indefinite, in force
//     until an applied identity proof sent AFTER the latest refusal clears it
//     (`proofClearsCredentialsHold`) — never because a digest moved;
//   - a timed hold (`rate_limit`, `network`): until its end; when it is taken
//     under a credentials hold it rides beside it in `hold_detail.timedHold`
//     (the carried timed hold), and the page is held until the later end.
//
// Under a timed hold in force nothing is admitted. Under a credentials hold
// in force only (A3) a candidate identity check (another session or proxy
// than the one that failed) and the verify of stored credentials whose digest
// differs from the latest refusal's — one verify per digest: its own refusal
// records that digest as the latest and closes the exception.
//
// Dependency-free so the database layer and the runtime can share it.

export const FANSLY_PAGE_HOLD_KINDS = ["rate_limit", "auth", "identity_mismatch", "network"] as const;
export type FanslyPageHoldKind = (typeof FANSLY_PAGE_HOLD_KINDS)[number];
/** A hold that ends at an instant. */
export type FanslyTimedHoldKind = Extract<FanslyPageHoldKind, "rate_limit" | "network">;
/** A hold only an identity proof after the refusal lifts. */
export type FanslyCredentialsHoldKind = Extract<FanslyPageHoldKind, "auth" | "identity_mismatch">;

/** The JS stand-in for a timestamptz `'infinity'` (credentials holds). */
export const INDEFINITE_UNTIL = new Date(8.64e15);

export function isIndefinite(until: Date | null): boolean {
  return until !== null && until.getTime() >= INDEFINITE_UNTIL.getTime();
}

/** Where a credentials hold carries a timed hold beside itself. */
export const CARRIED_TIMED_HOLD_FIELD = "timedHold";

export function isCredentialsHoldKind(kind: FanslyPageHoldKind | null): kind is FanslyCredentialsHoldKind {
  return kind === "auth" || kind === "identity_mismatch";
}

export function isTimedHoldKind(kind: FanslyPageHoldKind | null): kind is FanslyTimedHoldKind {
  return kind === "rate_limit" || kind === "network";
}

/** The hold columns of a `sync_pages` row. */
export interface FanslyPageHoldColumns {
  holdKind: FanslyPageHoldKind | null;
  holdUntil: Date | null;
  holdSince: Date | null;
  holdDetail: Readonly<Record<string, unknown>>;
}

/** The latest refusal of the page's credentials (`hold_detail`, written on
 *  every refusal). */
export interface CredentialsFailure {
  /** The refused attempt (`sync_attempts.id`; a page's attempts are strictly
   *  sequential). Null: a refusal without an attempt (the step-3 switch
   *  imported the legacy engine's auth block) or one written before refusals
   *  carried it. */
  attemptId: number | null;
  /** When the refused request was sent. */
  at: Date | null;
  /** The digest of the credentials the refused request carried. */
  digest: string | null;
}

export interface CredentialsHold {
  kind: FanslyCredentialsHoldKind;
  /** The start of the episode (`hold_since`); a later refusal keeps it. */
  since: Date | null;
  until: Date;
  failure: CredentialsFailure;
}

export interface TimedHold {
  kind: FanslyTimedHoldKind;
  until: Date;
  /** The page's own: `hold_since`; a carried one: the instant its detail
   *  names (`lastRateLimitAt`, `networkSince`). */
  since: Date | null;
  detail: Record<string, unknown>;
  /** Carried beside a credentials hold (`hold_detail.timedHold`). */
  carried: boolean;
}

/** What a page row records, in force or not. */
export interface FanslyPageHolds {
  credentials: CredentialsHold | null;
  timed: TimedHold | null;
}

/** The holds in force at one instant. */
export interface FanslyPageHoldInForce {
  /** The credentials hold when one is in force, else the timed hold's. */
  kind: FanslyPageHoldKind;
  /** The later end of the holds in force (indefinite under a credentials hold). */
  until: Date;
  credentials: CredentialsHold | null;
  /** Nothing is admitted before it ends, a candidate identity check included. */
  timed: TimedHold | null;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function attemptIdOf(value: unknown): number | null {
  const id = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function carriedSince(kind: FanslyTimedHoldKind, detail: Readonly<Record<string, unknown>>): Date | null {
  return dateOf(kind === "rate_limit" ? detail.lastRateLimitAt : detail.networkSince);
}

/** The adapter over the hold columns: what the row records. An end that is
 *  not an instant (a driver's `'infinity'` read without normalisation) holds
 *  indefinitely — an unreadable hold closes the page, never opens it. */
export function readFanslyPageHolds(columns: FanslyPageHoldColumns): FanslyPageHolds {
  const { holdKind, holdDetail } = columns;
  if (holdKind === null || columns.holdUntil === null) return { credentials: null, timed: null };
  const holdUntil = Number.isNaN(columns.holdUntil.getTime()) ? INDEFINITE_UNTIL : columns.holdUntil;
  if (isTimedHoldKind(holdKind)) {
    return {
      credentials: null,
      timed: { kind: holdKind, until: holdUntil, since: columns.holdSince, detail: { ...holdDetail }, carried: false },
    };
  }
  const credentials: CredentialsHold = {
    kind: holdKind,
    since: columns.holdSince,
    until: holdUntil,
    failure: {
      attemptId: attemptIdOf(holdDetail.failedAttemptId),
      at: dateOf(holdDetail.failedAt),
      digest: typeof holdDetail.credentialsGeneration === "string" && holdDetail.credentialsGeneration.length > 0
        ? holdDetail.credentialsGeneration
        : null,
    },
  };
  const carried = holdDetail[CARRIED_TIMED_HOLD_FIELD];
  if (typeof carried !== "object" || carried === null) return { credentials, timed: null };
  const { kind, until } = carried as Record<string, unknown>;
  const end = dateOf(until);
  if ((kind !== "rate_limit" && kind !== "network") || typeof until !== "string" || end === null) {
    return { credentials, timed: null };
  }
  const detail = recordOf((carried as Record<string, unknown>).detail);
  return { credentials, timed: { kind, until: end, since: carriedSince(kind, detail), detail, carried: true } };
}

/** The holds of `holds` in force at `now`, or null when none is. */
export function fanslyPageHoldInForce(holds: FanslyPageHolds, now: Date): FanslyPageHoldInForce | null {
  const at = now.getTime();
  const credentials = holds.credentials !== null && holds.credentials.until.getTime() > at ? holds.credentials : null;
  const timed = holds.timed !== null && holds.timed.until.getTime() > at ? holds.timed : null;
  if (credentials !== null) {
    const until = timed !== null && timed.until.getTime() > credentials.until.getTime() ? timed.until : credentials.until;
    return { kind: credentials.kind, until, credentials, timed };
  }
  return timed === null ? null : { kind: timed.kind, until: timed.until, credentials: null, timed };
}

/** `fanslyPageHoldInForce` straight from the row. */
export function activeFanslyPageHold(columns: FanslyPageHoldColumns, now: Date): FanslyPageHoldInForce | null {
  return fanslyPageHoldInForce(readFanslyPageHolds(columns), now);
}

// ── admission ───────────────────────────────────────────────────────────────

/** What a request is, to the page holds. */
export type FanslyPageHoldOperation =
  /** Any request of the page with its stored credentials (the socket's
   *  Upgrade and a CDN hop included). */
  | { kind: "request" }
  /** An identity check of a candidate session or proxy: not the credentials
   *  that failed, and its own 401/403 is the candidate's (E16). */
  | { kind: "candidate_check" }
  /** The identity check of the stored credentials (`account.verify`), with
   *  the digest its request carries. */
  | { kind: "verify"; digest: string | null };

export type FanslyPageHoldAdmission =
  | { admitted: true; exception: "candidate_check" | "verify" | null }
  | { admitted: false; scope: "timed" | "credentials"; kind: FanslyPageHoldKind; until: Date };

/**
 * A3: the verify of stored credentials runs under a credentials hold only
 * when their digest is not the latest refusal's — one verify per digest (its
 * own refusal makes it the latest). A refusal whose digest is unknown admits
 * the verify of any known digest once, for the same reason.
 */
export function verifyAdmittedUnderCredentialsHold(hold: CredentialsHold, digest: string | null): boolean {
  return digest !== null && digest !== hold.failure.digest;
}

/** May `operation` be sent under the page's holds at `now`? */
export function admitUnderFanslyPageHolds(
  holds: FanslyPageHolds,
  operation: FanslyPageHoldOperation,
  now: Date,
): FanslyPageHoldAdmission {
  const held = fanslyPageHoldInForce(holds, now);
  if (held === null) return { admitted: true, exception: null };
  if (held.timed !== null) return { admitted: false, scope: "timed", kind: held.timed.kind, until: held.timed.until };
  const credentials = held.credentials!;
  if (operation.kind === "candidate_check") return { admitted: true, exception: "candidate_check" };
  if (operation.kind === "verify" && verifyAdmittedUnderCredentialsHold(credentials, operation.digest)) {
    return { admitted: true, exception: "verify" };
  }
  return { admitted: false, scope: "credentials", kind: credentials.kind, until: credentials.until };
}

// ── clearing ────────────────────────────────────────────────────────────────

/** An applied identity proof: an `/account/me` answer of the page's own
 *  account, by its attempt. */
export interface CredentialsProof {
  attemptId: number;
  /** When it was sent (else admitted: an earlier, safe stand-in). */
  sentAt: Date;
}

/**
 * Ruling 5: a credentials hold clears only by a proof whose request was sent
 * after the LATEST refusal — by attempt order when the refusal names its
 * attempt, else by the send instant against the later of the refusal's and the
 * episode's start. A hold without either instant is never cleared by a proof.
 */
export function proofClearsCredentialsHold(hold: CredentialsHold, proof: CredentialsProof): boolean {
  if (hold.failure.attemptId !== null) return proof.attemptId > hold.failure.attemptId;
  const failedAt = hold.failure.at;
  const since = hold.since;
  const after = failedAt === null ? since : since === null || failedAt.getTime() > since.getTime() ? failedAt : since;
  return after !== null && proof.sentAt.getTime() > after.getTime();
}

// ── writing ─────────────────────────────────────────────────────────────────

/** The hold columns to write (`'infinity'` for a credentials hold). */
export interface FanslyPageHoldWrite {
  kind: FanslyPageHoldKind;
  until: Date | "infinity";
  detail: Record<string, unknown>;
}

/** `hold_detail` of a credentials refusal: the latest refused attempt, its
 *  send instant and the digest it carried, beside `extra`. */
export function credentialsFailureDetail(
  failure: CredentialsFailure,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...extra,
    credentialsGeneration: failure.digest,
    failedAttemptId: failure.attemptId,
    failedAt: failure.at === null ? null : failure.at.toISOString(),
  };
}

function carriedDetail(hold: TimedHold): Record<string, unknown> {
  return { kind: hold.kind, until: hold.until.toISOString(), detail: hold.detail };
}

function withoutCarried(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...detail };
  delete rest[CARRIED_TIMED_HOLD_FIELD];
  return rest;
}

function untilOf(until: Date): Date | "infinity" {
  return isIndefinite(until) ? "infinity" : until;
}

/**
 * The hold to write when the page takes `incoming` over what its row holds
 * (one slot, at most two holds):
 * - a credentials hold over a timed hold in force (the row's own or one it
 *   carries) carries that hold beside itself; a later refusal replaces the
 *   failure it names, the episode start stays (`setPageHold`);
 * - a timed hold under a credentials hold in force is carried beside it — the
 *   credentials hold stays, and a carried hold that ends later keeps its end;
 * - a timed hold over another one in force keeps the later end;
 * - anything else replaces the row's hold (a hold no longer in force is
 *   history).
 */
export function combineFanslyPageHold(
  current: FanslyPageHoldColumns,
  incoming: FanslyPageHoldWrite,
  now: Date,
): FanslyPageHoldWrite {
  const held = fanslyPageHoldInForce(readFanslyPageHolds(current), now);
  const timed = held?.timed ?? null;
  if (isCredentialsHoldKind(incoming.kind)) {
    if (timed === null) return { ...incoming, detail: withoutCarried(incoming.detail) };
    return { ...incoming, detail: { ...withoutCarried(incoming.detail), [CARRIED_TIMED_HOLD_FIELD]: carriedDetail(timed) } };
  }
  const incomingUntil = incoming.until === "infinity" ? INDEFINITE_UNTIL : incoming.until;
  const next: TimedHold = timed !== null && timed.until.getTime() > incomingUntil.getTime()
    ? timed
    : { kind: incoming.kind as FanslyTimedHoldKind, until: incomingUntil, since: now, detail: incoming.detail, carried: false };
  const credentials = held?.credentials ?? null;
  if (credentials !== null) {
    return {
      kind: credentials.kind,
      until: untilOf(credentials.until),
      detail: { ...withoutCarried(current.holdDetail), [CARRIED_TIMED_HOLD_FIELD]: carriedDetail(next) },
    };
  }
  return next === timed ? { kind: next.kind, until: next.until, detail: next.detail } : incoming;
}

/** What clearing the row's credentials hold leaves: the timed hold it carried
 *  while that is still in force, else nothing (null). */
export function fanslyPageHoldAfterCredentials(current: FanslyPageHoldColumns, now: Date): FanslyPageHoldWrite | null {
  const holds = readFanslyPageHolds(current);
  const carried = holds.credentials !== null ? holds.timed : null;
  if (carried === null || carried.until.getTime() <= now.getTime()) return null;
  return { kind: carried.kind, until: carried.until, detail: carried.detail };
}
