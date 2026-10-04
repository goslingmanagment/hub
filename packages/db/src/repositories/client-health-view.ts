import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { ClientHealthGroup } from "./client-health.ts";

/**
 * Reads of the chat extension's `client_health` hourly rollups for the owner's
 * view (chat-extension hub-pr-plan H-11c). The writes and the tables are in
 * `client-health.ts` (migration 0239).
 *
 * Every read adds the hours of a range up in SQL and returns one row per group,
 * so its size follows the number of client versions and host builds, not the
 * length of the range. The range walks the tables' primary keys, which start
 * with the hour. Nothing here writes, and the tables hold no user, page, fan or
 * device to return.
 *
 * Totals come back as numbers. A total is a count of reports, observations or
 * events; one beyond 2^53 is capped there instead of failing the read.
 */

export interface ClientHealthHourRange {
  /** The first hub hour (UTC) read. */
  from: Date;
  /** The hub hour the range stops before. */
  toExclusive: Date;
  /** Only this client's rows. */
  clientName?: string | undefined;
}

/** One histogram of one client group, its hours merged bucket by bucket. */
export interface ClientHealthPerfTotal extends ClientHealthGroup {
  metric: string;
  schemaVersion: number;
  unit: string;
  bounds: number[];
  /** One more entry than `bounds`. */
  counts: number[];
  count: number;
  sum: number;
  max: number;
}

export interface ClientHealthContractTotal {
  clientVersion: string;
  hostBuild: string;
  reports: number;
  failedReports: number;
}

export interface ClientHealthMissingTotal {
  clientVersion: string;
  hostBuild: string;
  anchor: string;
  reports: number;
}

export interface ClientHealthCounterTotal {
  code: string;
  total: number;
}

function toTotal(value: string | number): number {
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
}

function inRange(input: ClientHealthHourRange): SQL {
  const hours = sql`hour >= ${input.from.toISOString()}::timestamptz and hour < ${input.toExclusive.toISOString()}::timestamptz`;
  return input.clientName === undefined ? hours : sql`${hours} and client_name = ${input.clientName}`;
}

interface PerfTotalRow extends Record<string, unknown> {
  client_name: string;
  client_version: string;
  host_kind: string;
  host_build: string;
  metric: string;
  schema_version: number;
  unit: string;
  bounds: number[];
  counts: string[];
  count: string;
  sum: number;
  max: number;
}

/**
 * The histograms of the range, one per client group, metric, schema version and
 * set of bounds: buckets added element by element, the largest max, the sums
 * added up. `metrics` narrows the read to those metric names.
 *
 * Rows of one metric and schema version with other bounds are never added
 * together (they stay two rows): that only happens when the bounds registry was
 * edited without a new schema version, and buckets that mean different ranges
 * have no sum.
 */
export async function listClientHealthPerfTotals(
  db: Database,
  input: ClientHealthHourRange & { metrics?: readonly string[] | undefined },
): Promise<ClientHealthPerfTotal[]> {
  const metrics = input.metrics === undefined
    ? sql``
    : sql`and metric = any(${sql.param([...input.metrics])}::text[])`;
  const group = sql`client_name, client_version, host_kind, host_build, metric, schema_version, unit, bounds`;
  // The buckets are added up under a number per group (`gid`), not under the
  // group's columns: unnesting multiplies the rows by the bucket count, and
  // grouping that many rows by six strings and an array sorts them on disk
  // (measured: 2 s for 40 000 hourly rows, 0.2 s this way).
  const rows = await db.execute<PerfTotalRow>(sql`
    with picked as (
      select dense_rank() over (order by ${group}) as gid, ${group}, counts, count, sum, max
      from client_health_perf_hourly
      where ${inRange(input)} ${metrics}
    ),
    buckets as (
      select picked.gid, bucket.position, sum(bucket.held) as held
      from picked cross join lateral unnest(picked.counts) with ordinality as bucket(held, position)
      group by picked.gid, bucket.position
    ),
    merged as (
      select gid, array_agg(held::text order by position) as counts
      from buckets
      group by gid
    ),
    totals as (
      select gid, ${group}, sum(count)::text as count, sum(sum) as sum, max(max) as max
      from picked
      group by gid, ${group}
    )
    select ${group}, merged.counts, totals.count, totals.sum, totals.max
    from totals join merged using (gid)
    order by client_name collate "C", client_version collate "C", host_kind collate "C", host_build collate "C",
      metric collate "C", schema_version, bounds
  `);
  return rows.rows.map((row) => ({
    clientName: row.client_name,
    clientVersion: row.client_version,
    hostKind: row.host_kind,
    hostBuild: row.host_build,
    metric: row.metric,
    schemaVersion: Number(row.schema_version),
    unit: row.unit,
    bounds: row.bounds.map(Number),
    counts: row.counts.map(toTotal),
    count: toTotal(row.count),
    sum: Number(row.sum),
    max: Number(row.max),
  }));
}

/** Reports and reports with a broken host contract, by client version and host build. */
export async function listClientHealthContractTotals(
  db: Database,
  input: ClientHealthHourRange,
): Promise<ClientHealthContractTotal[]> {
  const rows = await db.execute<{ client_version: string; host_build: string; reports: string; failed_reports: string }>(sql`
    select client_version, host_build, sum(reports)::text as reports, sum(failed_reports)::text as failed_reports
    from client_health_contract_hourly
    where ${inRange(input)}
    group by client_version, host_build
    order by client_version collate "C", host_build collate "C"
  `);
  return rows.rows.map((row) => ({
    clientVersion: row.client_version,
    hostBuild: row.host_build,
    reports: toTotal(row.reports),
    failedReports: toTotal(row.failed_reports),
  }));
}

/** How many reports missed each anchor of the host contract, by client version and host build. */
export async function listClientHealthMissingTotals(
  db: Database,
  input: ClientHealthHourRange,
): Promise<ClientHealthMissingTotal[]> {
  const rows = await db.execute<{ client_version: string; host_build: string; anchor: string; reports: string }>(sql`
    select client_version, host_build, anchor, sum(reports)::text as reports
    from client_health_missing_hourly
    where ${inRange(input)}
    group by client_version, host_build, anchor
    order by client_version collate "C", host_build collate "C", anchor collate "C"
  `);
  return rows.rows.map((row) => ({
    clientVersion: row.client_version,
    hostBuild: row.host_build,
    anchor: row.anchor,
    reports: toTotal(row.reports),
  }));
}

/** Counters summed over the range, by code. */
export async function listClientHealthCounterTotals(
  db: Database,
  input: ClientHealthHourRange,
): Promise<ClientHealthCounterTotal[]> {
  const rows = await db.execute<{ code: string; total: string }>(sql`
    select code, sum(total)::text as total
    from client_health_counters_hourly
    where ${inRange(input)}
    group by code
    order by code collate "C"
  `);
  return rows.rows.map((row) => ({ code: row.code, total: toTotal(row.total) }));
}
