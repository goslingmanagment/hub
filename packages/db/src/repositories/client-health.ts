import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/**
 * Hourly rollups of the chat extension's `client_health` reports (migration
 * 0239, chat-extension hub-pr-plan H-11b, storage variant B′).
 *
 * The tables hold no user, page, fan or device and no report body: a report is
 * folded into counts and merged buckets under the hour the hub received it, and
 * only its client event id is kept, so that a resent report is not counted
 * twice. Raw SQL on purpose: these tables stay out of `schema.ts`.
 *
 * Both writes run inside the caller's transaction (the capture lane's), in a
 * fixed order: the receipts, then each rollup table with its rows sorted by
 * key. Two batches that touch the same rows therefore take their row locks in
 * the same order and cannot deadlock.
 */

/** The client group a rollup row is filed under. Codes only, never free text. */
export interface ClientHealthGroup {
  clientName: string;
  /** A code, or the placeholder of a version that is not one. */
  clientVersion: string;
  hostKind: string;
  /** A code, `""` for a build the client could not read, or the placeholder. */
  hostBuild: string;
}

export interface ClientHealthContractRollup extends ClientHealthGroup {
  reports: number;
  /** Reports whose host contract was broken (`contractOk: false`). */
  failedReports: number;
}

export interface ClientHealthMissingRollup extends ClientHealthGroup {
  anchor: string;
  reports: number;
}

export interface ClientHealthCounterRollup extends ClientHealthGroup {
  code: string;
  total: number;
}

export interface ClientHealthPerfRollup extends ClientHealthGroup {
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

export interface ClientHealthRollups {
  contract: ClientHealthContractRollup[];
  missing: ClientHealthMissingRollup[];
  counters: ClientHealthCounterRollup[];
  perf: ClientHealthPerfRollup[];
}

/** The UTC hour an instant falls in: the bucket a report received then is filed under. */
export function clientHealthHour(receivedAt: Date): Date {
  const hourMs = 3_600_000;
  return new Date(Math.floor(receivedAt.getTime() / hourMs) * hourMs);
}

/**
 * Claims the receipts of reports about to be folded. Returns the ids that were
 * new; every other id is a report already folded (by an earlier batch, or by a
 * concurrent one that committed first: the insert waits for it).
 */
export async function claimClientHealthReceipts(
  db: Database,
  input: { clientEventIds: readonly string[]; hour: Date },
): Promise<Set<string>> {
  const ids = [...new Set(input.clientEventIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length === 0) {
    return new Set();
  }
  const claimed = await db.execute<{ client_event_id: string }>(sql`
    insert into client_health_receipts (client_event_id, received_hour)
    select id, ${input.hour.toISOString()}::timestamptz
    from unnest(${sql.param(ids)}::uuid[]) with ordinality as claimed(id, position)
    order by position
    on conflict (client_event_id) do nothing
    returning client_event_id::text as client_event_id
  `);
  return new Set(claimed.rows.map((row) => row.client_event_id));
}

const GROUP_COLUMNS = sql`client_name text, client_version text, host_kind text, host_build text`;

/**
 * Adds a batch's rollups to the hour's rows. Returns the perf rows it could NOT
 * merge: a stored row of the same metric and schema version with other bounds.
 * That only happens when the bounds registry was edited without a new schema
 * version; the stored buckets are left as they are instead of being added to
 * buckets that mean something else.
 */
export async function mergeClientHealthRollups(
  db: Database,
  input: { hour: Date; rollups: ClientHealthRollups },
): Promise<{ unmergedPerf: Array<{ metric: string; schemaVersion: number }> }> {
  const hour = sql`${input.hour.toISOString()}::timestamptz`;
  const { contract, missing, counters, perf } = input.rollups;

  if (contract.length > 0) {
    await db.execute(sql`
      insert into client_health_contract_hourly as stored
        (hour, client_name, client_version, host_kind, host_build, reports, failed_reports)
      select ${hour}, x.client_name, x.client_version, x.host_kind, x.host_build, x.reports, x.failed_reports
      from jsonb_to_recordset(${JSON.stringify(contract.map((row) => ({
        client_name: row.clientName,
        client_version: row.clientVersion,
        host_kind: row.hostKind,
        host_build: row.hostBuild,
        reports: row.reports,
        failed_reports: row.failedReports,
      })))}::jsonb) as x(${GROUP_COLUMNS}, reports bigint, failed_reports bigint)
      order by x.client_name, x.client_version, x.host_kind, x.host_build
      on conflict (hour, client_name, client_version, host_kind, host_build) do update set
        reports = stored.reports + excluded.reports,
        failed_reports = stored.failed_reports + excluded.failed_reports
    `);
  }

  if (missing.length > 0) {
    await db.execute(sql`
      insert into client_health_missing_hourly as stored
        (hour, client_name, client_version, host_kind, host_build, anchor, reports)
      select ${hour}, x.client_name, x.client_version, x.host_kind, x.host_build, x.anchor, x.reports
      from jsonb_to_recordset(${JSON.stringify(missing.map((row) => ({
        client_name: row.clientName,
        client_version: row.clientVersion,
        host_kind: row.hostKind,
        host_build: row.hostBuild,
        anchor: row.anchor,
        reports: row.reports,
      })))}::jsonb) as x(${GROUP_COLUMNS}, anchor text, reports bigint)
      order by x.client_name, x.client_version, x.host_kind, x.host_build, x.anchor
      on conflict (hour, client_name, client_version, host_kind, host_build, anchor) do update set
        reports = stored.reports + excluded.reports
    `);
  }

  if (counters.length > 0) {
    await db.execute(sql`
      insert into client_health_counters_hourly as stored
        (hour, client_name, client_version, host_kind, host_build, code, total)
      select ${hour}, x.client_name, x.client_version, x.host_kind, x.host_build, x.code, x.total
      from jsonb_to_recordset(${JSON.stringify(counters.map((row) => ({
        client_name: row.clientName,
        client_version: row.clientVersion,
        host_kind: row.hostKind,
        host_build: row.hostBuild,
        code: row.code,
        total: row.total,
      })))}::jsonb) as x(${GROUP_COLUMNS}, code text, total bigint)
      order by x.client_name, x.client_version, x.host_kind, x.host_build, x.code
      on conflict (hour, client_name, client_version, host_kind, host_build, code) do update set
        total = stored.total + excluded.total
    `);
  }

  if (perf.length === 0) {
    return { unmergedPerf: [] };
  }
  // The update is skipped, and the row not returned, when the stored bounds
  // differ: the returned keys are the rows that did land.
  const merged = await db.execute<ClientHealthPerfKeyRow>(sql`
    insert into client_health_perf_hourly as stored
      (hour, client_name, client_version, host_kind, host_build, metric, schema_version, unit,
       bounds, counts, count, sum, max)
    select ${hour}, x.client_name, x.client_version, x.host_kind, x.host_build, x.metric, x.schema_version, x.unit,
      array(select bound.value::double precision
            from jsonb_array_elements_text(x.bounds) with ordinality as bound(value, position)
            order by bound.position),
      array(select bucket.value::bigint
            from jsonb_array_elements_text(x.counts) with ordinality as bucket(value, position)
            order by bucket.position),
      x.count, x.sum, x.max
    from jsonb_to_recordset(${JSON.stringify(perf.map((row) => ({
      client_name: row.clientName,
      client_version: row.clientVersion,
      host_kind: row.hostKind,
      host_build: row.hostBuild,
      metric: row.metric,
      schema_version: row.schemaVersion,
      unit: row.unit,
      bounds: row.bounds,
      counts: row.counts,
      count: row.count,
      sum: row.sum,
      max: row.max,
    })))}::jsonb) as x(${GROUP_COLUMNS}, metric text, schema_version integer, unit text,
      bounds jsonb, counts jsonb, count bigint, sum double precision, max double precision)
    order by x.client_name, x.client_version, x.host_kind, x.host_build, x.metric, x.schema_version
    on conflict (hour, client_name, client_version, host_kind, host_build, metric, schema_version) do update set
      counts = array(select pair.held + pair.added
                     from unnest(stored.counts, excluded.counts) with ordinality as pair(held, added, position)
                     order by pair.position),
      count = stored.count + excluded.count,
      sum = stored.sum + excluded.sum,
      max = greatest(stored.max, excluded.max)
    where stored.bounds = excluded.bounds and stored.unit = excluded.unit
    returning client_name, client_version, host_kind, host_build, metric, schema_version
  `);
  const landed = new Set(merged.rows.map((row) => perfKey({
    clientName: row.client_name,
    clientVersion: row.client_version,
    hostKind: row.host_kind,
    hostBuild: row.host_build,
    metric: row.metric,
    schemaVersion: Number(row.schema_version),
  })));
  return {
    unmergedPerf: perf
      .filter((row) => !landed.has(perfKey(row)))
      .map((row) => ({ metric: row.metric, schemaVersion: row.schemaVersion })),
  };
}

interface ClientHealthPerfKeyRow extends Record<string, unknown> {
  client_name: string;
  client_version: string;
  host_kind: string;
  host_build: string;
  metric: string;
  schema_version: number;
}

function perfKey(row: ClientHealthGroup & { metric: string; schemaVersion: number }): string {
  return JSON.stringify([row.clientName, row.clientVersion, row.hostKind, row.hostBuild, row.metric, row.schemaVersion]);
}
