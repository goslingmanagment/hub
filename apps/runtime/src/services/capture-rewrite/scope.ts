// G5 slice 3c-2 — the pure decisions of the historical rewrite.
//
// Everything in this file is a function of its arguments: no database, no
// clock it does not receive, no filesystem. That is deliberate — these are the
// four judgements the whole slice hangs on (what scope did the operator name,
// is this month safe to touch, does the disk hold the operation, is the verify
// verdict still worth anything), and each of them must be provable by a unit
// test without Docker.

import {
  type CaptureRewriteScope,
  type CaptureRewriteTable,
  CAPTURE_REWRITE_TABLES,
} from "@agency_hub_core/db";

export const CAPTURE_PARKING_SCHEMA = "capture_pending_drop";

/**
 * Why the parked partition does NOT go into Stage 28's `tiered_pending_drop`.
 *
 * The tiering schema means one specific thing to the rest of the system: "this
 * month's rows are NOT in the hot table any more; the lake has them". Three
 * places act on that meaning — the erasure sweeps parked tables as extra delete
 * targets, and both `fansly-replay-projection.ts` and `message-archive.ts`
 * REFUSE to replay a month they find parked there.
 *
 * A partition parked by THIS slice means the opposite: its rows are still live,
 * in a skinny twin attached under the same name. Parking it in
 * `tiered_pending_drop` would make the replay guards refuse a month that is
 * perfectly available — a false refusal, in the exact code path that exists to
 * prevent silent data loss. So the superseded copies get their own schema, and
 * the erasure is taught about it explicitly (services/erasure/index.ts) rather
 * than inheriting a meaning that is wrong for them.
 *
 * The name also gives `capture:drop-parked` a statement-level licence a test
 * can pin: the only relation it may ever destroy is one inside this schema.
 */
export const CAPTURE_PARKED_SUFFIX = "__pre_g5";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ParsedRewriteScopeInput {
  table: string | undefined;
  month: string | undefined;
}

/**
 * Turn the CLI's two strings into a scope, or say exactly why they are not one.
 *
 * `sync_raw_payloads` REJECTS a month rather than ignoring it. The table is not
 * partitioned, so a month could only ever be a filter on `captured_at` — and a
 * verdict produced over a filter cannot gate an act that rewrites the whole
 * relation. Accepting the flag and quietly narrowing the scope would produce
 * exactly that mismatch, months later, with no way to see it in the journal.
 */
export function parseCaptureRewriteScope(input: ParsedRewriteScopeInput): CaptureRewriteScope {
  const table = input.table as CaptureRewriteTable | undefined;
  if (table === undefined || !CAPTURE_REWRITE_TABLES.includes(table)) {
    throw new Error(
      `--table must be one of ${CAPTURE_REWRITE_TABLES.join(" | ")} (got: ${input.table ?? "nothing"})`,
    );
  }
  if (table === "sync_raw_payloads") {
    if (input.month !== undefined) {
      throw new Error(
        "sync_raw_payloads is not partitioned: it takes no --month, and a month-scoped "
          + "verdict could not gate a whole-table act",
      );
    }
    return { table, month: null };
  }
  if (input.month === undefined || !MONTH_PATTERN.test(input.month)) {
    throw new Error(`observations needs --month YYYY-MM (got: ${input.month ?? "nothing"})`);
  }
  return { table, month: input.month };
}

/** `2026-07` → `observations_2026_07`. */
export function observationPartitionName(month: string): string {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`not a YYYY-MM month: ${month}`);
  }
  return `observations_${month.replace("-", "_")}`;
}

/** The name a superseded partition is parked under. Never the original name:
 *  the skinny twin takes that, so the two must not collide. */
export function parkedRelationName(partition: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${partition}${CAPTURE_PARKED_SUFFIX}_${stamp}`;
}

/** The name the skinny copy is built under before it takes the real one. */
export function shadowRelationName(partition: string): string {
  return `${partition}__skinny`;
}

export function monthUtcRange(month: string): { from: string; to: string } {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`not a YYYY-MM month: ${month}`);
  }
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const next = index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

// ---------------------------------------------------------------------------
// The current-month refusal

export type CurrentMonthVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * A month whose partition is still receiving rows may not be rewritten.
 *
 * The skinny copy is a snapshot: rows that land in the source between the copy
 * and the swap are in the parked partition and NOT in the attached twin. For a
 * closed month that window is empty by construction (nothing writes a
 * `received_at` in a month that has passed — the partition key IS the capture
 * time). For the current month it is exactly the traffic the system is built to
 * capture. There is no lock cheap enough to close that window and no reason to
 * try: waiting one month costs nothing, and losing a day of capture costs
 * everything (DP 7).
 *
 * The future is refused for the same reason from the other side: a partition
 * ahead of today holds no rows worth reclaiming and would be re-populated the
 * moment it arrives.
 */
export function currentMonthVerdict(month: string, now: Date): CurrentMonthVerdict {
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  if (month === current) {
    return {
      ok: false,
      reason:
        `${month} is the CURRENT UTC month and is still being written; a skinny copy of it `
          + "would silently drop every row captured between the copy and the swap",
    };
  }
  if (month > current) {
    return { ok: false, reason: `${month} is in the future (current UTC month is ${current})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §9.1's headroom law

export interface HeadroomInput {
  /** `statfs` free bytes on the volume Postgres lives on. */
  freeBytes: number;
  /** `pg_total_relation_size` of the source partition — heap + TOAST + indexes. */
  sourceTotalBytes: number;
  /** `pg_indexes_size` of the source partition. */
  sourceIndexBytes: number;
  /** Fraction of the scope's rows that carry a catalog reference, i.e. the
   *  fraction whose body the skinny copy will NOT carry. 0..1. */
  referencedFraction: number;
}

export interface HeadroomVerdict {
  ok: boolean;
  freeBytes: number;
  sourceTotalBytes: number;
  /** What the skinny twin is expected to occupy once built. */
  shadowEstimateBytes: number;
  /** What the copy is expected to write to WAL. */
  walReserveBytes: number;
  /** The inequality's right-hand side. */
  requiredBytes: number;
  reason: string;
}

/**
 * §9.1, verbatim: "Это требует временного headroom минимум под одну старую
 * partition, новую skinny partition, WAL… Если headroom нет, операция не
 * начинается."
 *
 * THE OLD PARTITION IS COUNTED EVEN THOUGH IT IS ALREADY ON DISK, and that is
 * not double counting — it is the safety margin the doc asks for by name. The
 * operation's whole shape is "both copies exist at once, then one is dropped";
 * budgeting for the source a second time is what leaves room to abort, to roll
 * back, and for the ordinary churn of a live system during the hours the two
 * copies coexist. On a box whose free space is the reason this project exists,
 * a tight-but-technically-sufficient estimate is the wrong kind of clever.
 *
 * The skinny estimate is measured, not guessed: heap+TOAST scales down by the
 * fraction of rows whose body the copy drops, and the indexes come across
 * whole (no index in this schema indexes a body, so none of them shrinks).
 *
 * WAL is budgeted at the full size of the copy. `wal_level` is `replica` in
 * production, so the INSERT … SELECT is fully logged; assuming the `minimal`
 * optimisation would be assuming a setting this project does not control.
 */
export function reclaimHeadroomVerdict(input: HeadroomInput): HeadroomVerdict {
  const fraction = Math.min(1, Math.max(0, input.referencedFraction));
  const heapToastBytes = Math.max(0, input.sourceTotalBytes - input.sourceIndexBytes);
  const shadowEstimateBytes = Math.round(heapToastBytes * (1 - fraction)) + input.sourceIndexBytes;
  const walReserveBytes = shadowEstimateBytes;
  const requiredBytes = input.sourceTotalBytes + shadowEstimateBytes + walReserveBytes;
  const ok = input.freeBytes >= requiredBytes;
  return {
    ok,
    freeBytes: input.freeBytes,
    sourceTotalBytes: input.sourceTotalBytes,
    shadowEstimateBytes,
    walReserveBytes,
    requiredBytes,
    reason: ok
      ? `free ${gib(input.freeBytes)} >= required ${gib(requiredBytes)}`
      : `free ${gib(input.freeBytes)} < required ${gib(requiredBytes)} `
        + `(source ${gib(input.sourceTotalBytes)} + skinny ${gib(shadowEstimateBytes)} `
        + `+ WAL ${gib(walReserveBytes)})`,
  };
}

/**
 * The FLOOR the whole slice keeps its hands off (decision #223).
 *
 * §9.1's inequality says what an operation needs; it says nothing about what
 * the rest of the box needs while that operation runs. On a VPS where Postgres,
 * its WAL, the container images and the logs share one volume, "the copy fits"
 * and "the machine survives the copy" are different sentences, and only the
 * second one matters at 03:00. Five GiB is the smallest number that is
 * comfortably more than a WAL burst plus a log rotation plus the slack an
 * autovacuum needs to finish, and it is deliberately NOT config: it is a
 * containment threshold, exactly like the runway days in db-disk-alert.ts, and
 * a tunable containment threshold is a containment threshold somebody turns off
 * the night it would have fired.
 */
export const CAPTURE_REWRITE_FREE_FLOOR_BYTES = 5 * 1024 ** 3;

/**
 * §9.1's law, applied to the act that RUNS FIRST and used to have no gate at
 * all: the backfill.
 *
 * THE ORDER WAS THE BUG. `capture:backfill` writes a full catalog copy of every
 * body it walks plus a second heap tuple per stamped row, on the two largest
 * tables in the system — and the headroom law was checked afterwards, by the
 * reclaim, which is the step that GIVES space back. A run admitted in that
 * order can fill the volume before anything is in a position to refuse, and the
 * refusal it eventually meets is the reclaim declining to clean up the mess the
 * backfill made.
 *
 * WHAT IT ASKS FOR, and why each term is there:
 *
 *   * THE BODIES STILL TO COPY. Only the unreferenced share of the scope's
 *     heap+TOAST — the referenced share is already in the catalog and the
 *     dedup means this is a worst case, not an estimate. Indexes are excluded:
 *     the catalog's own indexes are over digests, not bodies, and do not scale
 *     with this.
 *   * THE SAME AGAIN FOR WAL. `wal_level = replica` in production, so every one
 *     of those inserts is fully logged; assuming the `minimal` optimisation
 *     would be assuming a setting this project does not control (the same
 *     sentence reclaimHeadroomVerdict makes, for the same reason).
 *   * THE FLOOR, untouched. See above.
 *
 * The UPDATE's dead tuples are deliberately NOT budgeted separately: an UPDATE
 * that changes only narrow columns reuses the row's TOAST pointer rather than
 * copying the body, so its cost is a main-heap tuple — small beside the copy,
 * and comfortably inside the floor this reserves.
 */
export function backfillHeadroomVerdict(input: {
  freeBytes: number;
  sourceTotalBytes: number;
  sourceIndexBytes: number;
  /** Fraction of the scope's rows that still need a catalog copy. 0..1. */
  unreferencedFraction: number;
}): HeadroomVerdict {
  const fraction = Math.min(1, Math.max(0, input.unreferencedFraction));
  const heapToastBytes = Math.max(0, input.sourceTotalBytes - input.sourceIndexBytes);
  const catalogCopyBytes = Math.round(heapToastBytes * fraction);
  const walReserveBytes = catalogCopyBytes;
  const requiredBytes = catalogCopyBytes + walReserveBytes + CAPTURE_REWRITE_FREE_FLOOR_BYTES;
  const ok = input.freeBytes >= requiredBytes;
  return {
    ok,
    freeBytes: input.freeBytes,
    sourceTotalBytes: input.sourceTotalBytes,
    shadowEstimateBytes: catalogCopyBytes,
    walReserveBytes,
    requiredBytes,
    reason: ok
      ? `free ${gib(input.freeBytes)} >= required ${gib(requiredBytes)}`
      : `free ${gib(input.freeBytes)} < required ${gib(requiredBytes)} `
        + `(catalog copy ${gib(catalogCopyBytes)} + WAL ${gib(walReserveBytes)} `
        + `+ ${gib(CAPTURE_REWRITE_FREE_FLOOR_BYTES)} floor)`,
  };
}

/**
 * The MID-RUN check, and why it asks a different question than the pre-flight.
 *
 * A pre-flight admits a walk that then runs for hours on a box that is doing
 * other things. Re-evaluating the full inequality every N batches would be
 * arithmetic theatre — the estimate it re-derives is the same estimate, and the
 * scope's remaining share is exactly what the walk has been consuming. What
 * genuinely has to stay true is the floor: if free space has reached it,
 * something is eating the disk faster than this run budgeted for and the honest
 * response is to stop where it stands. The walk is resumable with no cursor, so
 * stopping costs nothing but the time already spent.
 */
export function captureBackfillMidRunVerdict(freeBytes: number): FreshnessVerdict {
  if (freeBytes >= CAPTURE_REWRITE_FREE_FLOOR_BYTES) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `free space fell to ${gib(freeBytes)}, at or below the `
      + `${gib(CAPTURE_REWRITE_FREE_FLOOR_BYTES)} floor this slice keeps clear — stopping the `
      + "walk here; it resumes with no cursor once the volume has room",
  };
}

/**
 * The `sync_raw_payloads` variant. `VACUUM FULL` writes a complete new copy of
 * the relation and its indexes before dropping the old one, so the requirement
 * is the whole relation twice over plus the WAL of the rewrite.
 */
export function vacuumFullHeadroomVerdict(input: {
  freeBytes: number;
  relationTotalBytes: number;
}): HeadroomVerdict {
  const shadowEstimateBytes = input.relationTotalBytes;
  const walReserveBytes = input.relationTotalBytes;
  const requiredBytes = input.relationTotalBytes + walReserveBytes;
  const ok = input.freeBytes >= requiredBytes;
  return {
    ok,
    freeBytes: input.freeBytes,
    sourceTotalBytes: input.relationTotalBytes,
    shadowEstimateBytes,
    walReserveBytes,
    requiredBytes,
    reason: ok
      ? `free ${gib(input.freeBytes)} >= required ${gib(requiredBytes)}`
      : `free ${gib(input.freeBytes)} < required ${gib(requiredBytes)} `
        + `(a VACUUM FULL writes a full new copy of ${gib(input.relationTotalBytes)} before `
        + "dropping the old one)",
  };
}

export function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

// ---------------------------------------------------------------------------
// Verdict freshness

/**
 * How long a `capture:verify-backfill` blessing is worth anything.
 *
 * Not forever, and the reason is concrete: between a verify and a reclaim, the
 * live dual write can stamp new references, an erasure can delete a body, and
 * the operator can run a second backfill. Each of those changes the very thing
 * the verify measured. A day is long enough for the ritual to be done across
 * two sittings and short enough that nothing large happens inside it unnoticed.
 */
export const VERIFY_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type FreshnessVerdict = { ok: true } | { ok: false; reason: string };

export function verifyVerdictFreshness(input: {
  verifiedAt: Date | null;
  verifyVerdict: string | null;
  backfillCompletedAt: Date | null;
  now: Date;
}): FreshnessVerdict {
  if (input.verifiedAt === null || input.verifyVerdict === null) {
    return { ok: false, reason: "no settled capture:verify-backfill run for this scope" };
  }
  if (input.verifyVerdict !== "ok") {
    return { ok: false, reason: `the last verify run for this scope said "${input.verifyVerdict}"` };
  }
  const ageMs = input.now.getTime() - input.verifiedAt.getTime();
  if (ageMs > VERIFY_VERDICT_MAX_AGE_MS) {
    return {
      ok: false,
      reason: `the verify verdict is ${Math.round(ageMs / 3_600_000)}h old `
        + `(max ${VERIFY_VERDICT_MAX_AGE_MS / 3_600_000}h) — re-run capture:verify-backfill`,
    };
  }
  if (
    input.backfillCompletedAt !== null
    && input.backfillCompletedAt.getTime() > input.verifiedAt.getTime()
  ) {
    return {
      ok: false,
      reason: "a capture:backfill run finished AFTER the verify verdict; the verdict describes "
        + "a scope that has since changed",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Index reconciliation

/**
 * Normalise a `pg_indexes.indexdef` so two definitions can be compared without
 * their names or their relation getting in the way.
 *
 * The skinny copy is built with `LIKE observations INCLUDING ALL`, which brings
 * across every index the PARENT declares. Two indexes in this schema are NOT
 * declared on the parent in the ordinary way — 0096's and 0126's partial
 * expression indexes are created `ON ONLY observations` and then built and
 * attached per leaf, so a fresh `LIKE` child gets the parent's metadata index
 * but the leaf-level index still has to be created before the attach (PostgreSQL
 * would otherwise build it DURING `ATTACH PARTITION`, holding ACCESS EXCLUSIVE
 * for the length of a full heap scan — which is precisely the short lock this
 * operation is designed around).
 *
 * So the shadow's index set is reconciled against the SOURCE PARTITION's actual
 * `pg_indexes`, and this function is how "the same index" is decided.
 */
export function normalizeIndexDef(indexDef: string, relation: string, shadow: string): string {
  return indexDef
    // CREATE [UNIQUE] INDEX <name> ON <schema>.<relation> …  → drop the name.
    .replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+/i, (match) =>
      match.replace(/INDEX\s+\S+\s+ON/i, "INDEX ON"))
    .replaceAll(`"${shadow}"`, "<rel>")
    .replaceAll(`"${relation}"`, "<rel>")
    .replaceAll(`public.${shadow}`, "<rel>")
    .replaceAll(`public.${relation}`, "<rel>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
