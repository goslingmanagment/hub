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
  /** What the operation is expected to leave RESIDENT in pg_wal. */
  walReserveBytes: number;
  /** How that WAL number was arrived at (decision #239). Absent on the
   *  verdicts that still budget the copy again by construction. */
  walBasis?: WalReserve["basis"];
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
  // Deliberately NOT the #239 bounded term: this verdict already counts the
  // source a second time as its safety margin, and layering a second relaxation
  // on top of a budget that is generous by construction buys nothing. It is
  // also the one verdict that has never refused a scope in production.
  const shadowWalBytes = shadowEstimateBytes;
  const requiredBytes = input.sourceTotalBytes + shadowEstimateBytes + shadowWalBytes;
  const ok = input.freeBytes >= requiredBytes;
  return {
    ok,
    freeBytes: input.freeBytes,
    sourceTotalBytes: input.sourceTotalBytes,
    shadowEstimateBytes,
    walReserveBytes: shadowWalBytes,
    requiredBytes,
    reason: ok
      ? `free ${gib(input.freeBytes)} >= required ${gib(requiredBytes)}`
      : `free ${gib(input.freeBytes)} < required ${gib(requiredBytes)} `
        + `(source ${gib(input.sourceTotalBytes)} + skinny ${gib(shadowEstimateBytes)} `
        + `+ WAL ${gib(shadowWalBytes)})`,
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

// ---------------------------------------------------------------------------
// The WAL term (decision #239)

/**
 * How much WAL a bulk copy can leave ON DISK at once, expressed in
 * `max_wal_size`.
 *
 * The old model reserved the size of the copy itself, on the stated ground that
 * `wal_level = replica` makes every insert fully logged. That sentence is true
 * and the conclusion does not follow: full logging says how many WAL BYTES ARE
 * WRITTEN, not how many are RESIDENT. WAL is resident only until the segment
 * that holds it is no longer needed, and on this box nothing holds a segment
 * back — `archive_mode` is off, so no archiver is behind; there are no
 * replication slots, so no consumer is behind; there is no standby. The only
 * thing that keeps a segment is the checkpointer, which is bounded by
 * `max_wal_size`.
 *
 * `max_wal_size` is a SOFT target, not a cap: a burst that outruns the
 * checkpointer overshoots it, and the observed overshoot on this box during a
 * heavy delete was 168 MB → 1.00 GiB against a 1 GiB target. Four times the
 * target is comfortably above that and is still measured in gigabytes rather
 * than the tens of gigabytes the 1:1 reserve asked for.
 *
 * `wal_keep_size` IS ADDED ON TOP, not folded in. It is a floor on retention
 * that the checkpointer does not get to remove — segments are kept for a
 * would-be standby whether or not `max_wal_size` says they could go — so it is
 * resident WAL that exists in ADDITION to the checkpointer's working set, and
 * `min(copy, 4 × max_wal_size + wal_keep_size)` is the honest shape. On this box
 * it reads 0 today; the term exists so that setting it later cannot silently
 * invalidate a gate nobody re-derived.
 *
 * THE ASSERTIONS ARE PART OF THE ARITHMETIC. If the archiver or a slot ever
 * appears, segments accumulate without bound and the only honest reserve is the
 * whole copy again — so this falls back to exactly the old term rather than to
 * a smaller guess, and it does the same if either setting cannot be READ at all
 * (a missing `pg_settings` row; a legitimate zero is a value, not a failure).
 *
 * AND IT IS A BUDGET, NOT A GUARANTEE. Nothing here can promise what the
 * checkpointer will actually leave on the volume — only what it is reasonable
 * to reserve for. The thing that actually stops a walk eating the disk is the
 * mid-run floor check (`captureBackfillMidRunVerdict`), which now reads the
 * volume EVERY batch once free space is below
 * `CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES`. That is the hard backstop; this
 * term is the estimate it stands behind.
 */
export const WAL_RESERVE_MAX_WAL_SIZE_FACTOR = 4;

export interface WalReserveInput {
  /** Bytes the operation is about to write. */
  copyBytes: number;
  /** `max_wal_size` from `pg_settings`, in bytes. */
  maxWalSizeBytes: number;
  /** `wal_keep_size` from `pg_settings`, in bytes. NULL means the setting could
   *  not be READ (no such row) — a legitimate 0 is a value, not a failure. */
  walKeepSizeBytes: number | null;
  /** `archive_mode = off`? */
  archiveModeOff: boolean;
  /** `select count(*) from pg_replication_slots` */
  replicationSlots: number;
}

export interface WalReserve {
  bytes: number;
  /** Why this number — it travels into the tombstone and the refusal text. */
  basis: "bounded_by_max_wal_size" | "full_copy_fallback";
  reason: string;
}

export function walReserveBytes(input: WalReserveInput): WalReserve {
  const copyBytes = Math.max(0, input.copyBytes);
  const keepUnreadable = input.walKeepSizeBytes === null
    || !Number.isFinite(input.walKeepSizeBytes)
    || input.walKeepSizeBytes < 0;
  if (
    !input.archiveModeOff
    || input.replicationSlots > 0
    || input.maxWalSizeBytes <= 0
    || keepUnreadable
  ) {
    return {
      bytes: copyBytes,
      basis: "full_copy_fallback",
      reason: !input.archiveModeOff
        ? "archive_mode is not off — WAL segments are retained until archived, so the reserve is the "
          + "whole copy again"
        : input.replicationSlots > 0
          ? `${input.replicationSlots} replication slot(s) exist — a lagging consumer pins WAL, so the `
            + "reserve is the whole copy again"
          : input.maxWalSizeBytes <= 0
            ? "max_wal_size is unreadable — falling back to the whole copy again"
            : "wal_keep_size is unreadable — it retains WAL independently of the checkpointer, so a "
              + "bound that cannot see it is not a bound; falling back to the whole copy again",
    };
  }
  const keepBytes = input.walKeepSizeBytes ?? 0;
  const bounded = WAL_RESERVE_MAX_WAL_SIZE_FACTOR * input.maxWalSizeBytes + keepBytes;
  const bytes = Math.min(copyBytes, bounded);
  return {
    bytes,
    basis: "bounded_by_max_wal_size",
    reason: `archive_mode off, 0 replication slots: resident WAL is bounded by the checkpointer at `
      + `${WAL_RESERVE_MAX_WAL_SIZE_FACTOR} x max_wal_size plus wal_keep_size ${gib(keepBytes)} `
      + `(${gib(bounded)}), so the reserve is min(copy ${gib(copyBytes)}, ${gib(bounded)}) `
      + `= ${gib(bytes)}. A BUDGET, NOT A GUARANTEE — the mid-run floor check is the backstop`,
  };
}

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
 * WHAT IT ASKS FOR, and why each term is what it is (decision #239):
 *
 *   * THE BODIES STILL TO COPY, MEASURED. The old term prorated the scope's
 *     whole heap+TOAST by the unreferenced ROW fraction and then assumed the
 *     catalog copy would be the same size as the source. Both halves were
 *     wrong in the same direction. The row fraction is not the byte fraction
 *     (the referenced rows are the ones a previous run already walked, and a
 *     partial walk is ordered by id, not by size); and the catalog copy is
 *     content-addressed and pglz-compressed, so it is SMALLER — production run
 *     1 turned ~4.2 GB of inline July bodies into 1.81 GB of catalog, a
 *     measured 0.43x. The term is now `inlineBytesToCopy x copyRatio`, where
 *     both come from bounded SQL probes at gate time (`measureBackfillCopy` in
 *     ./index.ts): a sampled average body size times the census's own
 *     unreferenced count, and a ratio observed over rows THIS SCOPE has already
 *     had copied. A scope with no sample to learn from gets 1.0 — the old
 *     assumption, kept as the fallback rather than as the rule.
 *   * WAL, BOUNDED BY WHAT CAN ACTUALLY STAY ON DISK. See walReserveBytes.
 *   * THE FLOOR, untouched. See above.
 *
 * WHAT THIS IS NOT. It is not a bypass and it does not weaken the inequality:
 * every term is still a conservative PEAK, and the two that changed are now
 * MEASURED where they used to be assumed. The old arithmetic asked 40.41 GiB
 * free for `sync_raw_payloads` on a 79 GiB disk holding a 55 GiB database —
 * a gate no amount of lawful reclaiming could ever satisfy, which is a gate
 * that has stopped governing and started forbidding.
 *
 * The UPDATE's dead tuples are deliberately NOT budgeted separately: an UPDATE
 * that changes only narrow columns reuses the row's TOAST pointer rather than
 * copying the body, so its cost is a main-heap tuple — small beside the copy,
 * and comfortably inside the floor this reserves.
 */
export function backfillHeadroomVerdict(input: {
  freeBytes: number;
  sourceTotalBytes: number;
  /** Measured inline body bytes the walk still has to copy. */
  inlineBytesToCopy: number;
  /** Observed stored-catalog / inline ratio for this scope; 1.0 with no sample. */
  copyRatio: number;
  maxWalSizeBytes: number;
  walKeepSizeBytes: number | null;
  archiveModeOff: boolean;
  replicationSlots: number;
}): HeadroomVerdict {
  // An unusable ratio is not a reason to guess: fall back to the OLD
  // assumption (byte-for-byte parity), never to something smaller.
  const copyRatio = Number.isFinite(input.copyRatio) && input.copyRatio > 0
    ? input.copyRatio
    : 1;
  const catalogCopyBytes = Math.round(Math.max(0, input.inlineBytesToCopy) * copyRatio);
  const wal = walReserveBytes({
    copyBytes: catalogCopyBytes,
    maxWalSizeBytes: input.maxWalSizeBytes,
    walKeepSizeBytes: input.walKeepSizeBytes,
    archiveModeOff: input.archiveModeOff,
    replicationSlots: input.replicationSlots,
  });
  const requiredBytes = catalogCopyBytes + wal.bytes + CAPTURE_REWRITE_FREE_FLOOR_BYTES;
  const ok = input.freeBytes >= requiredBytes;
  return {
    ok,
    freeBytes: input.freeBytes,
    sourceTotalBytes: input.sourceTotalBytes,
    shadowEstimateBytes: catalogCopyBytes,
    walReserveBytes: wal.bytes,
    walBasis: wal.basis,
    requiredBytes,
    reason: ok
      ? `free ${gib(input.freeBytes)} >= required ${gib(requiredBytes)} `
        + `(catalog copy ${gib(catalogCopyBytes)} at ratio ${copyRatio.toFixed(2)} `
        + `+ WAL ${gib(wal.bytes)} + ${gib(CAPTURE_REWRITE_FREE_FLOOR_BYTES)} floor)`
      : `free ${gib(input.freeBytes)} < required ${gib(requiredBytes)} `
        + `(catalog copy ${gib(catalogCopyBytes)} at ratio ${copyRatio.toFixed(2)} `
        + `+ WAL ${gib(wal.bytes)} + ${gib(CAPTURE_REWRITE_FREE_FLOOR_BYTES)} floor)`,
  };
}

/**
 * Free space below which the walk stops trusting a ten-batch gap.
 *
 * The floor is 5 GiB and the cadence is what decides how much can be spent
 * BETWEEN two readings of it. Ten batches at `--batch 2000` on the raw table is
 * tens of thousands of bodies — comfortable when the volume has room, and
 * exactly the wrong bet when it does not, because the size the walk consumes per
 * batch is the one thing this system has repeatedly measured wrong (a 3.4x
 * probe bias, dedup that does not transfer between cohorts). Three GiB of
 * margin over the floor is the point past which a stale reading stops being a
 * detail: below it every batch pays one `statvfs` — microseconds against a
 * batch measured in seconds — and above it the cheap cadence stands.
 */
export const CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES = 8 * 1024 ** 3;

/**
 * Is the walk due to re-read the volume?
 *
 * `lastFreeBytes` is the most recent reading — the pre-flight's on the first
 * batch, and every mid-walk check's after that. An UNKNOWN reading is treated as
 * tight, not as roomy: a gate whose input is missing must not be the reason a
 * check was skipped.
 */
export function headroomRecheckDue(input: {
  batchesDone: number;
  lastFreeBytes: number | null;
  cadenceBatches: number;
}): boolean {
  if (input.batchesDone <= 0) {
    return false;
  }
  if (input.lastFreeBytes === null || !Number.isFinite(input.lastFreeBytes)) {
    return true;
  }
  if (input.lastFreeBytes < CAPTURE_BACKFILL_TIGHT_RECHECK_FREE_BYTES) {
    return true;
  }
  return input.batchesDone % Math.max(1, input.cadenceBatches) === 0;
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
 * The safety factor over the measured compact estimate.
 *
 * The estimate is a projection: `sum(pg_column_size(...))` over the columns a
 * post-`null-bodies` row still carries, plus the current index size, plus the
 * inline bodies the codec refused. It cannot see page fill, per-tuple and
 * per-page overhead, TOAST chunking of the survivors, or the fact that the
 * rebuilt indexes are built fresh and pack differently. Doubling it is the
 * cheapest honest answer to all of that at once, and it keeps the shape of the
 * sentence this verdict was born with ("the whole thing twice over") while
 * applying it to WHAT IS ACTUALLY WRITTEN.
 */
export const VACUUM_FULL_COMPACT_SAFETY_FACTOR = 2;

/**
 * The `sync_raw_payloads` variant, re-derived in decision #239.
 *
 * WHAT WAS WRONG. `VACUUM FULL` writes a complete new copy of the relation and
 * its indexes before dropping the old one — true — and the old model therefore
 * budgeted `relationTotalBytes x 2`, i.e. the CURRENT size of the relation
 * twice. But this verdict gates the rewrite that runs AFTER
 * `--phase null-bodies`, whose entire purpose is that the surviving tuples no
 * longer carry their bodies. The new copy is sized by the LIVE tuples, and
 * `pg_total_relation_size` of the old relation is sized by the live tuples PLUS
 * every dead version the nulling UPDATE just created PLUS the TOAST those
 * bodies used to occupy. Measured on production 2026-08-26: `sync_raw_payloads`
 * is 22.13 GB and its body-free compact estimate is ~0.57 GB — a factor of 39.
 * So the gate asked for 44.26 GiB free on a 79 GiB disk holding a 55 GiB
 * database, and `--phase null-bodies` checks the SAME verdict before it nulls
 * anything (#223), which means the route was closed at both ends: unsatisfiable
 * by any amount of lawful reclaiming, and therefore not a gate at all.
 *
 * WHAT IT ASKS FOR NOW: the measured compact estimate with a safety factor,
 * the #239 WAL term, and the same 5 GiB floor the rest of the slice keeps
 * clear — which this verdict never had, and which is exactly the containment
 * threshold an ACCESS EXCLUSIVE rewrite on a starved box should be holding.
 * `relationTotalBytes` stays in the verdict for the journal, not the
 * inequality: it is the number the operator wants when reading the tombstone.
 */
export function vacuumFullHeadroomVerdict(input: {
  freeBytes: number;
  relationTotalBytes: number;
  /** Measured bytes the rewritten relation is expected to occupy: body-free
   *  heap + indexes + the inline bodies that survive. */
  compactEstimateBytes: number;
  maxWalSizeBytes: number;
  walKeepSizeBytes: number | null;
  archiveModeOff: boolean;
  replicationSlots: number;
}): HeadroomVerdict {
  const compact = Math.max(0, input.compactEstimateBytes);
  // A compact estimate that came back larger than the relation is a measurement
  // that has gone wrong; take the relation, which is the number that cannot be.
  const budgeted = Math.round(
    Math.min(input.relationTotalBytes, compact) * VACUUM_FULL_COMPACT_SAFETY_FACTOR,
  );
  const wal = walReserveBytes({
    copyBytes: budgeted,
    maxWalSizeBytes: input.maxWalSizeBytes,
    walKeepSizeBytes: input.walKeepSizeBytes,
    archiveModeOff: input.archiveModeOff,
    replicationSlots: input.replicationSlots,
  });
  const requiredBytes = budgeted + wal.bytes + CAPTURE_REWRITE_FREE_FLOOR_BYTES;
  const ok = input.freeBytes >= requiredBytes;
  const terms = `(compact ${gib(compact)} x${VACUUM_FULL_COMPACT_SAFETY_FACTOR} `
    + `+ WAL ${gib(wal.bytes)} + ${gib(CAPTURE_REWRITE_FREE_FLOOR_BYTES)} floor; `
    + `relation on disk ${gib(input.relationTotalBytes)})`;
  return {
    ok,
    freeBytes: input.freeBytes,
    sourceTotalBytes: input.relationTotalBytes,
    shadowEstimateBytes: budgeted,
    walReserveBytes: wal.bytes,
    walBasis: wal.basis,
    requiredBytes,
    reason: ok
      ? `free ${gib(input.freeBytes)} >= required ${gib(requiredBytes)} ${terms}`
      : `free ${gib(input.freeBytes)} < required ${gib(requiredBytes)} ${terms}`,
  };
}

// ---------------------------------------------------------------------------
// The completion forecast (decision #239)

export interface CaptureRewriteForecast {
  /** Rows the backfill still has to stamp. */
  rowsToStamp: number;
  /** Bytes the backfill is expected to ADD (the catalog copy). */
  backfillGrowthBytes: number;
  /** Bytes the reclaim is expected to RETURN once the parked copy is dropped. */
  reclaimReturnBytes: number;
  /** reclaimReturn - backfillGrowth: what the whole ritual is worth. */
  netBytes: number;
  /** One line an operator can read without doing arithmetic. */
  line: string;
}

/**
 * WHY A FORECAST BELONGS IN THE CENSUS.
 *
 * The gate answers "may this step run". It has never answered "is finishing
 * this worth starting", and the difference is what stranded July: run 1 was
 * admitted, wrote 1.8 GB of catalog, was interrupted, and the reclaim that was
 * supposed to CONSUME those bytes was refused the next morning — so the ritual's
 * one executed step left the box strictly worse off, permanently, and nothing
 * in its output had said that was the risk.
 *
 * Both halves are honest about what they are. The growth is the same measured
 * copy the gate just budgeted. The return is the source relation minus what the
 * skinny twin will weigh (its indexes come across whole; no index here indexes a
 * body) — the drop of the parked copy is where the bytes actually come back, so
 * a net that is negative until O5 is stated rather than discovered.
 */
export function captureRewriteForecast(input: {
  census: { rows: number; referenced: number; unreferencedWithBody: number };
  copyBytes: number;
  sourceTotalBytes: number;
  sourceIndexBytes: number;
}): CaptureRewriteForecast {
  const rowsToStamp = Math.max(0, input.census.unreferencedWithBody);
  const backfillGrowthBytes = Math.max(0, input.copyBytes);
  // After a complete backfill every row is referenced, so the skinny twin is
  // its indexes plus the bodies the codec refused — which this cannot know
  // before the walk, and which are a rounding error when it can (3 rows in the
  // July run). Indexes alone is the conservative floor on what stays.
  const skinnyBytes = Math.min(input.sourceTotalBytes, Math.max(0, input.sourceIndexBytes));
  const reclaimReturnBytes = Math.max(0, input.sourceTotalBytes - skinnyBytes);
  const netBytes = reclaimReturnBytes - backfillGrowthBytes;
  return {
    rowsToStamp,
    backfillGrowthBytes,
    reclaimReturnBytes,
    netBytes,
    line: `forecast: backfill stamps ${rowsToStamp} row(s) and ADDS ~${gib(backfillGrowthBytes)}; `
      + `the reclaim then RETURNS ~${gib(reclaimReturnBytes)} when the parked copy is dropped; `
      + `net ${netBytes >= 0 ? "+" : "-"}${gib(Math.abs(netBytes))}. Until that drop the scope is `
      + "BIGGER on disk, not smaller — run the steps as one sitting.",
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
