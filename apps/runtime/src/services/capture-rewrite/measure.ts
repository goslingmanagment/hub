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
/** Rows the ratio sample reads from the already-copied part of the scope. */
export const COPY_RATIO_SAMPLE_ROWS = 500;

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
  /** Stored catalog bytes per inline byte, observed on rows THIS scope has
   *  already had copied, deduplication included. 1.0 with no sample. */
  copyRatio: number;
  /** The same ratio over the first COPY_PROBE_ROWS rows alone — the floor the
   *  wider sample may not undercut. */
  probeRatio: number | null;
  sampleRatio: number | null;
  ratioSampleRows: number;
  ratioBasis: "observed" | "no_sample";
}

/**
 * What the backfill is about to write, measured rather than prorated.
 *
 * TWO KINDS OF PROBE, AND THEY ASK DIFFERENT QUESTIONS.
 *
 * The SIZE probe reads the head of the remaining work — rows with a body and no
 * reference, in id order — and averages `pg_column_size(body)`, which is the
 * STORED (compressed, possibly TOASTed) size, the same kind of number the
 * catalog will pay. Multiplied by the census's own count it gives the bytes
 * still to copy. Id order is not a random sample and is not pretending to be
 * one: the walk itself goes in id order, so the head of the queue is exactly
 * the population the next batches read.
 *
 * The RATIO probes read the part of the scope a previous run ALREADY copied and
 * compare what the catalog stores against what those rows still carry inline.
 * That comparison is only possible while both copies exist, which is exactly
 * the state a partially-backfilled scope is in. Two windows are measured — the
 * first COPY_PROBE_ROWS rows and the first COPY_RATIO_SAMPLE_ROWS — and THE
 * LARGER RATIO WINS, so a wider sample can only ever make the budget bigger,
 * never smaller than what the narrow probe already saw.
 *
 * DEDUPLICATION IS COUNTED ONCE, WHICH IS THE POINT. The stored side sums each
 * DISTINCT `(bucket_month, object_id)` exactly once while the inline side sums
 * every sampled ROW, so two envelopes that collapsed onto one object show up as
 * the saving they are. Production run 1 turned ~4.2 GB of inline July bodies
 * into 1.81 GB of catalog — 0.43x — and it is that measured number, not an
 * assumption of parity, that decides whether this box can finish the rewrite it
 * already started.
 *
 * THE RATIO HAS A FLOOR AND NO CEILING. `MIN_COPY_RATIO` stops a measurement
 * that has gone wrong (an empty catalog partition, a sample of one) from
 * producing a budget near zero; nothing caps it from above, because a canonical
 * body genuinely can be larger than the jsonb it came from and the gate should
 * believe that when it sees it.
 */
export const MIN_COPY_RATIO = 0.25;

export async function measureBackfillCopy(
  db: Database,
  scope: CaptureRewriteScope,
  relation: string,
  unreferencedWithBody: number,
): Promise<BackfillCopyMeasurement> {
  const body = scope.table === "observations" ? "payload" : "response_payload";
  const probe = await db.execute<{ n: string; bytes: string | null }>(sql`
    with head as (
      select pg_column_size(${sql.raw(`e.${body}`)}) as bytes
      from ${sql.raw(`"${relation}"`)} e
      where e.payload_object_id is null and ${sql.raw(`e.${body}`)} is not null
      order by e.id asc
      limit ${COPY_PROBE_ROWS}
    )
    select count(*)::text as n, coalesce(sum(bytes), 0)::text as bytes from head
  `);
  const probeRows = Number(probe.rows[0]?.n ?? 0);
  const probeBytes = Number(probe.rows[0]?.bytes ?? 0);
  const avgInlineBytes = probeRows === 0 ? 0 : probeBytes / probeRows;

  // One pass produces both windows: `rank` orders the already-copied head, the
  // inline side sums every row in the window and the stored side sums each
  // distinct object in it exactly once.
  const ratio = await db.execute<{
    window_rows: string;
    inline_bytes: string;
    stored_bytes: string;
    window_size: string;
  }>(sql`
    with sample as (
      select row_number() over (order by e.id asc) as rank,
             e.payload_bucket_month as bucket_month,
             e.payload_object_id as object_id,
             pg_column_size(${sql.raw(`e.${body}`)}) as inline_bytes
      from ${sql.raw(`"${relation}"`)} e
      where e.payload_object_id is not null and ${sql.raw(`e.${body}`)} is not null
      order by e.id asc
      limit ${COPY_RATIO_SAMPLE_ROWS}
    ), windows as (
      select ${COPY_PROBE_ROWS}::bigint as window_size
      union all
      select ${COPY_RATIO_SAMPLE_ROWS}::bigint
    )
    select w.window_size::text as window_size,
           (select count(*) from sample s where s.rank <= w.window_size)::text as window_rows,
           coalesce(
             (select sum(s.inline_bytes) from sample s where s.rank <= w.window_size), 0
           )::text as inline_bytes,
           coalesce((
             select sum(pg_column_size(b.body))
             from (
               select distinct s.bucket_month, s.object_id
               from sample s where s.rank <= w.window_size
             ) d
             join capture_json_hot_bodies b
               on b.bucket_month = d.bucket_month and b.object_id = d.object_id
           ), 0)::text as stored_bytes
    from windows w
    order by w.window_size asc
  `);

  const observedRatio = (windowSize: number): { rows: number; ratio: number | null } => {
    const row = ratio.rows.find((candidate) => Number(candidate.window_size) === windowSize);
    const rows = Number(row?.window_rows ?? 0);
    const inline = Number(row?.inline_bytes ?? 0);
    const stored = Number(row?.stored_bytes ?? 0);
    return { rows, ratio: rows > 0 && inline > 0 ? stored / inline : null };
  };
  const narrow = observedRatio(COPY_PROBE_ROWS);
  const wide = observedRatio(COPY_RATIO_SAMPLE_ROWS);
  const observed = narrow.ratio === null && wide.ratio === null
    ? null
    : Math.max(narrow.ratio ?? 0, wide.ratio ?? 0);

  const copyRatio = observed === null ? 1 : Math.max(MIN_COPY_RATIO, observed);
  return {
    avgInlineBytes,
    probeRows,
    inlineBytesToCopy: Math.round(avgInlineBytes * Math.max(0, unreferencedWithBody)),
    copyRatio,
    probeRatio: narrow.ratio,
    sampleRatio: wide.ratio,
    ratioSampleRows: wide.rows,
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

/**
 * What `sync_raw_payloads` is expected to WEIGH after the rewrite — the number
 * `vacuumFullHeadroomVerdict` needs and `pg_total_relation_size` cannot give.
 *
 * `pg_total_relation_size` measures the relation as it is: live tuples, plus
 * every dead version the nulling UPDATE minted, plus the TOAST the removed
 * bodies used to occupy. `VACUUM FULL` writes none of that. So the estimate is
 * built from what a surviving ROW costs — probed over the head of the table
 * with the body column excluded — times the row count, plus the indexes (which
 * are rebuilt at their current logical size; no index in this schema indexes a
 * body), plus the bodies that are still inline because nothing referenced them
 * or the codec refused them.
 *
 * The survivor sum is NOT probed. It is a `sum(pg_column_size(...))` over the
 * rows that still carry a body, which after `null-bodies` is a small minority —
 * and it is the one term where being wrong means the copy is bigger than
 * budgeted, so it is measured exactly.
 */
export async function measureSyncRawPayloadsCompact(
  db: Database,
  indexBytes: number,
): Promise<CompactMeasurement> {
  const probe = await db.execute<{ n: string; bytes: string | null; rows: string }>(sql`
    with head as (
      select pg_column_size((
        e.id, e.page_id, e.sync_run_id, e.stream, e.request_seq, e.source, e.endpoint,
        e.request_params, e.mapper_version, e.payload_kind, e.status_code, e.error_message,
        e.captured_at, e.retain_until, e.payload_bucket_month, e.payload_object_id,
        e.response_tips
      )) as bytes
      from sync_raw_payloads e
      order by e.id desc
      limit 2000
    )
    select count(*)::text as n,
           coalesce(sum(bytes), 0)::text as bytes,
           (select count(*)::text from sync_raw_payloads) as rows
    from head
  `);
  const probeRows = Number(probe.rows[0]?.n ?? 0);
  const probeBytes = Number(probe.rows[0]?.bytes ?? 0);
  const rows = Number(probe.rows[0]?.rows ?? 0);
  // +28 for the tuple header the row constructor above does not include.
  const avgRowBytesWithoutBody = probeRows === 0 ? 0 : probeBytes / probeRows + 28;

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
