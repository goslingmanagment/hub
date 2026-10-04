// The page holds of the Fansly Sync Engine (plan §9; step 3b ruling 5 and
// amendment A3; step 4 owner decision №26): ONE pure admission core over the
// page-scope rows of a page's hold set (`sync_holds`). The actor's gate and
// pick, the final admission inside the admission transaction, status/why and
// the alerts all read a page's holds through it (composed with the route and
// resource holds by `apps/runtime/src/sync/engine/admission.ts`); SQL only
// locks the row and writes what this module decided, and never re-states the
// rule.
//
// A page holds at most two things at once, each a row of its own:
//   - a credentials hold (`auth`, `identity_mismatch`): indefinite, in force
//     until an applied identity proof sent AFTER the latest refusal clears it
//     (`proofClearsCredentialsHold`) — never because a digest moved;
//   - a network hold (`network`): until its end. It stands beside a
//     credentials hold when a check under that hold failed on the network,
//     and the page is held until the later end.
//
// Under a network hold in force nothing is admitted. Under a credentials hold
// in force only (A3) a candidate identity check (another session or proxy
// than the one that failed) and the verify of stored credentials whose digest
// differs from the latest refusal's — one verify per digest: its own refusal
// records that digest as the latest and closes the exception.
//
// A 429 holds its route, never the page (`engine/route-holds.ts`).
//
// Dependency-free: the engine and the services that show a page's state
// share it.

export const FANSLY_PAGE_HOLD_KINDS = ["auth", "identity_mismatch", "network"] as const;
export type FanslyPageHoldKind = (typeof FANSLY_PAGE_HOLD_KINDS)[number];
/** A hold that ends at an instant. */
export type FanslyTimedHoldKind = Extract<FanslyPageHoldKind, "network">;
/** A hold only an identity proof after the refusal lifts. */
export type FanslyCredentialsHoldKind = Extract<FanslyPageHoldKind, "auth" | "identity_mismatch">;

/** The JS stand-in for a timestamptz `'infinity'` (credentials holds). */
export const INDEFINITE_UNTIL = new Date(8.64e15);

export function isIndefinite(until: Date | null): boolean {
  return until !== null && until.getTime() >= INDEFINITE_UNTIL.getTime();
}

export function isFanslyPageHoldKind(kind: string): kind is FanslyPageHoldKind {
  return (FANSLY_PAGE_HOLD_KINDS as readonly string[]).includes(kind);
}

export function isCredentialsHoldKind(kind: string | null): kind is FanslyCredentialsHoldKind {
  return kind === "auth" || kind === "identity_mismatch";
}

export function isTimedHoldKind(kind: string | null): kind is FanslyTimedHoldKind {
  return kind === "network";
}

/** A page-scope row of a page's hold set, of a kind this core knows. */
export interface FanslyPageHoldRow {
  kind: FanslyPageHoldKind;
  /** Null: a row that names no end — it holds indefinitely. */
  until: Date | null;
  since: Date | null;
  detail: Readonly<Record<string, unknown>>;
}

/** The latest refusal of the page's credentials (the hold's detail, written
 *  on every refusal). */
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
  /** The start of the episode; a later refusal keeps it. */
  since: Date | null;
  until: Date;
  failure: CredentialsFailure;
}

export interface TimedHold {
  kind: FanslyTimedHoldKind;
  until: Date;
  since: Date | null;
  detail: Record<string, unknown>;
}

/** What a page's rows record, in force or not. */
export interface FanslyPageHolds {
  credentials: CredentialsHold | null;
  timed: TimedHold | null;
}

export const NO_FANSLY_PAGE_HOLDS: FanslyPageHolds = { credentials: null, timed: null };

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

/** An end that is not an instant (a row without one, a driver's `'infinity'`
 *  read without normalisation) holds indefinitely — an unreadable hold closes
 *  the page, never opens it. */
function endOf(until: Date | null): Date {
  return until === null || Number.isNaN(until.getTime()) ? INDEFINITE_UNTIL : until;
}

/** The adapter over the page-scope rows of a hold set: what they record. */
export function readFanslyPageHolds(rows: readonly FanslyPageHoldRow[]): FanslyPageHolds {
  let credentials: CredentialsHold | null = null;
  let timed: TimedHold | null = null;
  for (const row of rows) {
    if (isCredentialsHoldKind(row.kind)) {
      const { detail } = row;
      credentials = {
        kind: row.kind,
        since: row.since,
        until: endOf(row.until),
        failure: {
          attemptId: attemptIdOf(detail.failedAttemptId),
          at: dateOf(detail.failedAt),
          digest: typeof detail.credentialsGeneration === "string" && detail.credentialsGeneration.length > 0
            ? detail.credentialsGeneration
            : null,
        },
      };
    } else {
      timed = { kind: row.kind, until: endOf(row.until), since: row.since, detail: { ...row.detail } };
    }
  }
  return { credentials, timed };
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
 * Clearing it lifts that row alone: a network hold beside it stands.
 */
export function proofClearsCredentialsHold(hold: CredentialsHold, proof: CredentialsProof): boolean {
  if (hold.failure.attemptId !== null) return proof.attemptId > hold.failure.attemptId;
  const failedAt = hold.failure.at;
  const since = hold.since;
  const after = failedAt === null ? since : since === null || failedAt.getTime() > since.getTime() ? failedAt : since;
  return after !== null && proof.sentAt.getTime() > after.getTime();
}

// ── writing ─────────────────────────────────────────────────────────────────

/** The detail of a credentials refusal: the latest refused attempt, its send
 *  instant and the digest it carried, beside `extra`. */
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
