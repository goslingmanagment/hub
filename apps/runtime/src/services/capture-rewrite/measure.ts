// G5 slice 3c-2 / decision #239 — the MEASUREMENTS the headroom law now takes
// instead of the assumptions it used to make.
//
// scope.ts holds the pure judgements; this file holds the SQL that feeds them.
// It is separate from index.ts and reclaim.ts on purpose: both of those need
// these numbers, the two files are deliberately separable (additive vs
// destructive), and a private helper duplicated in each would be two chances
// for the gate to be computed two different ways.
//
// EVERY PROBE HERE IS BOUNDED. The whole point of the change is a gate that can
// be evaluated on a starved box in seconds; a `sum(pg_column_size(payload))`
// over a 21 GB table would cost more than the operation it is gating.

import { sql } from "drizzle-orm";

import type { CaptureRewriteScope, Database } from "@agency_hub_core/db";

/** Rows a size probe reads. Small enough to be an index-ordered sip, large
 *  enough that one outlier body cannot move the average by much. */
export const COPY_PROBE_ROWS = 200;
/** Rows the compression sample reads from the already-copied part of the scope. */
export const COPY_RATIO_SAMPLE_ROWS = 500;
/** Rows the post-rewrite row-width probe reads. */
export const COMPACT_PROBE_ROWS = 500;

export interface WalEnvironment {
  maxWalSizeBytes: number;
  archiveModeOff: boolean;
  replicationSlots: number;
}

/**
 * The three facts the #239 WAL term rests on, read fresh at gate time.
 *
 * They are read rather than assumed because the term COLLAPSES BACK to the old
 * 1:1 reserve if any of them stops being true — an archiver or a replication
 * slot pins WAL segments without bound, and a bound that is not there any more
 * is not a bound.
 */
export async function readWalEnvironment(db: Database): Promise<WalEnvironment> {
  const settings = await db.execute<{ name: string; setting: string; unit: string | null }>(sql`
    select name, setting, unit from pg_settings where name in ('max_wal_size', 'archive_mode')
  `);
  const slots = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from pg_replication_slots
  `);
  let maxWalSizeBytes = 0;
  let archiveModeOff = false;
  for (const row of settings.rows) {
    if (row.name === "max_wal_size") {
      // pg_settings reports max_wal_size in its unit (`MB` in every supported
      // build); multiply rather than trust a bare number.
      const unitBytes = row.unit === "MB"
        ? 1024 ** 2
        : row.unit === "kB"
          ? 1024
          : row.unit === "GB"
            ? 1024 ** 3
            : row.unit === "8kB"
              ? 8 * 1024
              : 1;
      maxWalSizeBytes = Number(row.setting) * unitBytes;
    }
    if (row.name === "archive_mode") {
      archiveModeOff = row.setting === "off";
    }
  }
  return {
    maxWalSizeBytes,
    archiveModeOff,
    replicationSlots: Number(slots.rows[0]?.n ?? 0),
  };
}

export interface BackfillCopyMeasurement {
  /** Average stored size of a body the walk still has to copy. */
  avgInlineBytes: number;
  /** How many rows that average was taken over. */
  probeRows: number;
  /** avgInlineBytes x the census's unreferenced count. */
  inlineBytesToCopy: number;
  /** compressionRatio x dedupFactor — what one inline byte costs in the
   *  catalog. 1.0 when there is nothing to learn from. */
  copyRatio: number;
  /** Catalog bytes per inline byte for ONE body, sampled 1:1. */
  compressionRatio: number | null;
  /** The same over the narrow window alone — the floor the wider one may not
   *  undercut. */
  compressionRatioNarrow: number | null;
  compressionSampleRows: number;
  /** distinctObjects / referencedRows over the whole already-copied cohort.
   *  EXACT, not sampled — see below. */
  dedupFactor: number | null;
  dedupReferencedRows: number;
  dedupDistinctObjects: number;
  ratioBasis: "observed" | "no_sample";
}

/**
 * What the backfill is about to write, measured rather than prorated.
 *
 * THREE MEASUREMENTS, AND THE THIRD IS THE ONE SAMPLING CANNOT MAKE.
 *
 * **Size.** `pg_column_size(body)` is the STORED (compressed, possibly TOASTed)
 * size, the same kind of number the catalog will pay, and the census already
 * knows how many rows are left. What it needs is a representative average —
 * and THE HEAD OF THE QUEUE IS NOT ONE. Measured on production
 * `observations_2026_07` 2026-08-26: the first 200 unreferenced rows average
 * **3,264 B** while the whole 548,350-row remainder averages **11,072 B**, a
 * 3.4x under-estimate, because a previous partial walk stopped in the middle of
 * a month whose body mix changes over time. So the probe SPREADS its picks
 * evenly across the remaining id range — 200 index probes, each an
 * `id >= target … limit 1` — which measured **11,935 B**, 7.8 % HIGH. High is
 * the side to be wrong on.
 *
 * **Compression.** Catalog bytes per inline byte for ONE body, sampled 1:1 with
 * no dedup in it. Two windows are measured and THE LARGER RATIO WINS, so a
 * wider sample can only make the budget bigger than what the narrow probe
 * already saw. (On production July this is ~1.00: the canonical body and the
 * jsonb it came from compress to the same size, which is worth knowing — the
 * saving in this system is not compression.)
 *
 * **Dedup, and it is EXACT because a sample cannot see it.** Two envelopes
 * carrying identical bytes collapse onto one catalog object, and that collapse
 * is the entire saving: July's 362,804 referenced rows hold **206,659** distinct
 * objects, a factor of **0.5696**. A row sample cannot measure it — 500 picks
 * spread over 362,804 rows almost never draw two rows sharing an object, so the
 * sampled ratio came back **0.99 against a true 0.49**. So the dedup factor is
 * counted rather than sampled: `count(distinct (bucket_month, object_id)) /
 * count(*)` over the already-copied rows, which is an aggregate over two narrow
 * columns and measured 2.1 s on the July partition and 0.67 s on
 * `sync_raw_payloads` (index-only). A gate guarding an hours-long walk can
 * afford two seconds.
 *
 * The product over-budgets the July cohort by ~16 % against its measured truth
 * (0.5701 modelled vs 0.4915 actual), which is the direction a gate should err.
 *
 * NO SAMPLE MEANS 1.0. A scope nothing has copied yet has no dedup factor and
 * no compression sample, and it gets byte-for-byte parity — the assumption this
 * whole change replaced, kept as the FALLBACK rather than as the rule. So does
 * any factor that comes back zero, negative, NaN or infinite.
 *
 * THE RATIO HAS A FLOOR AND NO CEILING. `MIN_COPY_RATIO` stops a measurement
 * that has gone wrong from producing a budget near zero; nothing caps it from
 * above, because a canonical body genuinely can be larger than the jsonb it came
 * from and the gate should believe that when it sees it.
 */
export const MIN_COPY_RATIO = 0.25;

/** A finite, strictly positive number, or null. */
function usable(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

export async function measureBackfillCopy(
  db: Database,
  scope: CaptureRewriteScope,
  relation: string,
  unreferencedWithBody: number,
): Promise<BackfillCopyMeasurement> {
  const body = sql.raw(scope.table === "observations" ? "e.payload" : "e.response_payload");
  const rel = sql.raw(`"${relation}"`);

  // --- size: spread across the REMAINING work, never its head -------------
  const probe = await db.execute<{ n: string; bytes: string | null }>(sql`
    with bounds as (
      select min(e.id) as lo, max(e.id) as hi
      from ${rel} e
      where e.payload_object_id is null and ${body} is not null
    ), picks as (
      select (bounds.lo + (bounds.hi - bounds.lo) * g / ${COPY_PROBE_ROWS}::numeric)::bigint as target
      from bounds, generate_series(0, ${COPY_PROBE_ROWS - 1}) g
      where bounds.lo is not null
    ), spread as (
      select (
        select pg_column_size(${body})
        from ${rel} e
        where e.id >= picks.target and e.payload_object_id is null and ${body} is not null
        order by e.id asc
        limit 1
      ) as bytes
      from picks
    )
    select count(bytes)::text as n, coalesce(sum(bytes), 0)::text as bytes from spread
  `);
  const probeRows = Number(probe.rows[0]?.n ?? 0);
  const probeBytes = Number(probe.rows[0]?.bytes ?? 0);
  const avgInlineBytes = probeRows === 0 ? 0 : probeBytes / probeRows;

  // --- compression: one body against its own object, 1:1, two windows -----
  const compression = await db.execute<{
    window_size: string;
    rows: string;
    inline_bytes: string;
    stored_bytes: string;
  }>(sql`
    with bounds as (
      select min(e.id) as lo, max(e.id) as hi
      from ${rel} e
      where e.payload_object_id is not null and ${body} is not null
    ), picks as (
      select g,
             (bounds.lo + (bounds.hi - bounds.lo) * g / ${COPY_RATIO_SAMPLE_ROWS}::numeric)::bigint as target
      from bounds, generate_series(0, ${COPY_RATIO_SAMPLE_ROWS - 1}) g
      where bounds.lo is not null
    ), sample as (
      select picks.g as rank,
             pg_column_size(row_of.body_value) as inline_bytes,
             (
               select pg_column_size(b.body)
               from capture_json_hot_bodies b
               where b.bucket_month = row_of.bucket_month and b.object_id = row_of.object_id
             ) as stored_bytes
      from picks
      cross join lateral (
        select ${body} as body_value,
               e.payload_bucket_month as bucket_month,
               e.payload_object_id as object_id
        from ${rel} e
        where e.id >= picks.target and e.payload_object_id is not null and ${body} is not null
        order by e.id asc
        limit 1
      ) row_of
    ), windows as (
      select ${COPY_PROBE_ROWS}::bigint as window_size
      union all
      select ${COPY_RATIO_SAMPLE_ROWS}::bigint
    )
    select w.window_size::text as window_size,
           (select count(*) from sample s
             where s.rank < w.window_size and s.stored_bytes is not null)::text as rows,
           coalesce((select sum(s.inline_bytes) from sample s
             where s.rank < w.window_size and s.stored_bytes is not null), 0)::text as inline_bytes,
           coalesce((select sum(s.stored_bytes) from sample s
             where s.rank < w.window_size), 0)::text as stored_bytes
    from windows w
    order by w.window_size asc
  `);
  const windowRatio = (windowSize: number): { rows: number; ratio: number | null } => {
    const row = compression.rows.find((one) => Number(one.window_size) === windowSize);
    const rows = Number(row?.rows ?? 0);
    const inline = Number(row?.inline_bytes ?? 0);
    const stored = Number(row?.stored_bytes ?? 0);
    return { rows, ratio: usable(rows > 0 && inline > 0 ? stored / inline : null) };
  };
  const narrow = windowRatio(COPY_PROBE_ROWS);
  const wide = windowRatio(COPY_RATIO_SAMPLE_ROWS);
  const compressionRatio = narrow.ratio === null && wide.ratio === null
    ? null
    : Math.max(narrow.ratio ?? 0, wide.ratio ?? 0);

  // --- dedup: counted, because it cannot be sampled ------------------------
  const dedup = await db.execute<{ rows: string; objects: string }>(sql`
    select count(*)::text as rows,
           count(distinct (e.payload_bucket_month, e.payload_object_id))::text as objects
    from ${rel} e
    where e.payload_object_id is not null
  `);
  const dedupReferencedRows = Number(dedup.rows[0]?.rows ?? 0);
  const dedupDistinctObjects = Number(dedup.rows[0]?.objects ?? 0);
  const dedupFactor = usable(
    dedupReferencedRows > 0
      ? Math.min(1, dedupDistinctObjects / dedupReferencedRows)
      : null,
  );

  const observed = compressionRatio !== null && dedupFactor !== null
    ? compressionRatio * dedupFactor
    : null;
  const copyRatio = observed === null ? 1 : Math.max(MIN_COPY_RATIO, observed);

  return {
    avgInlineBytes,
    probeRows,
    inlineBytesToCopy: Math.round(avgInlineBytes * Math.max(0, unreferencedWithBody)),
    copyRatio,
    compressionRatio,
    compressionRatioNarrow: narrow.ratio,
    compressionSampleRows: wide.rows,
    dedupFactor,
    dedupReferencedRows,
    dedupDistinctObjects,
    ratioBasis: observed === null ? "no_sample" : "observed",
  };
}

export interface CompactMeasurement {
  /** Body-free heap + current indexes + the inline bodies that survive. */
  compactEstimateBytes: number;
  rows: number;
  probeRows: number;
  avgRowBytesWithoutBody: number;
  survivingInlineBytes: number;
  indexBytes: number;
}

/** Per-tuple header the row constructor in the probe does not include. */
const TUPLE_HEADER_BYTES = 28;

/**
 * What `sync_raw_payloads` is expected to WEIGH after the rewrite — the number
 * `vacuumFullHeadroomVerdict` needs and `pg_total_relation_size` cannot give.
 *
 * `pg_total_relation_size` measures the relation as it IS: live tuples, plus
 * every dead version the nulling UPDATE minted, plus the TOAST the removed
 * bodies used to occupy. `VACUUM FULL` writes none of that. So the estimate is
 * built from what a surviving ROW costs — probed with the body column excluded
 * — times the row count, plus the indexes (rebuilt at their current logical
 * size; no index in this schema indexes a body), plus the bodies that are still
 * inline because nothing referenced them or the codec refused them.
 *
 * THE PROBE SPREADS, for the same reason the size probe does. An `order by id
 * desc limit 2000` reads the newest rows, which are the pointer-only ones, and
 * on production 2026-08-26 that measured 267 B/row against 226 B/row spread
 * across the table. That particular bias happened to be conservative; a bias
 * that is only accidentally in the right direction is not a property to build a
 * gate on, so both probes spread.
 *
 * The survivor sum is NOT probed. It is a `sum(pg_column_size(...))` over the
 * rows that still carry a body, and it is the one term where being wrong makes
 * the copy BIGGER than budgeted — so it is measured exactly.
 */
export async function measureSyncRawPayloadsCompact(
  db: Database,
  indexBytes: number,
): Promise<CompactMeasurement> {
  const probe = await db.execute<{ n: string; bytes: string | null; rows: string }>(sql`
    with bounds as (select min(id) as lo, max(id) as hi from sync_raw_payloads),
    picks as (
      select (bounds.lo + (bounds.hi - bounds.lo) * g / ${COMPACT_PROBE_ROWS}::numeric)::bigint as target
      from bounds, generate_series(0, ${COMPACT_PROBE_ROWS - 1}) g
      where bounds.lo is not null
    ), spread as (
      select (
        select pg_column_size((
          e.id, e.page_id, e.sync_run_id, e.stream, e.request_seq, e.source, e.endpoint,
          e.request_params, e.mapper_version, e.payload_kind, e.status_code, e.error_message,
          e.captured_at, e.retain_until, e.payload_bucket_month, e.payload_object_id,
          e.response_tips
        ))
        from sync_raw_payloads e
        where e.id >= picks.target
        order by e.id asc
        limit 1
      ) as bytes
      from picks
    )
    select count(bytes)::text as n,
           coalesce(sum(bytes), 0)::text as bytes,
           (select count(*)::text from sync_raw_payloads) as rows
    from spread
  `);
  const probeRows = Number(probe.rows[0]?.n ?? 0);
  const probeBytes = Number(probe.rows[0]?.bytes ?? 0);
  const rows = Number(probe.rows[0]?.rows ?? 0);
  const avgRowBytesWithoutBody = probeRows === 0
    ? 0
    : probeBytes / probeRows + TUPLE_HEADER_BYTES;

  const surviving = await db.execute<{ bytes: string | null }>(sql`
    select coalesce(sum(pg_column_size(e.response_payload)), 0)::text as bytes
    from sync_raw_payloads e
    where e.response_payload is not null
  `);
  const survivingInlineBytes = Number(surviving.rows[0]?.bytes ?? 0);

  return {
    compactEstimateBytes: Math.round(
      avgRowBytesWithoutBody * rows + survivingInlineBytes + indexBytes,
    ),
    rows,
    probeRows,
    avgRowBytesWithoutBody,
    survivingInlineBytes,
    indexBytes,
  };
}
