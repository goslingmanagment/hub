import type { AdminClientHealthQuery, AdminClientHealthResponse } from "@agency_hub_core/contracts";
import {
  listClientHealthContractTotals,
  listClientHealthCounterTotals,
  listClientHealthMissingTotals,
  listClientHealthPerfTotals,
  type ClientHealthContractTotal,
  type ClientHealthCounterTotal,
  type ClientHealthMissingTotal,
  type ClientHealthPerfTotal,
} from "@agency_hub_core/db";
import { MOSCOW_TIME_ZONE, businessDateToUtcStart, nextBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  CLIENT_HEALTH_BUILD_UNREAD,
  CLIENT_HEALTH_FOOTPRINT_BOUNDS,
  CLIENT_HEALTH_FOOTPRINT_METRICS,
  CLIENT_HEALTH_GAUGE_COUNTERS,
} from "./client-health-intake.ts";
import { CLIENT_HEALTH_MIN_GROUP_SIZE, clientHealthP50P95, clientHealthPercentile } from "./client-health-perf.ts";

/**
 * The owner's view of the chat extension's health (chat-extension hub-pr-plan
 * H-11c), read from the hourly `client_health` rollups of H-11b.
 *
 * The rollups hold no user, page, fan or device, so the view cannot name a
 * person and does not try to: there is no list of who runs which version.
 *
 * A measurement is shown only for a group of at least
 * CLIENT_HEALTH_MIN_GROUP_SIZE observations in the range asked for. A smaller
 * group shows how many observations it has and nothing of them: a mean, a
 * maximum or a percentile of three observations describes one sitting of one
 * person, not the version.
 *
 * The floor is on the range of one read and no narrower. The days of a range
 * are free, so the sum of a few observations, and their maximum when it is the
 * larger one, come out of two reads of larger ranges: 22 observations on one
 * day and 3 on the next are held back as the second day alone and shown as the
 * two days together. It keeps a thin figure off the page; it does not seal a
 * small group off, and the view must not be described as if it did. Holding a
 * group back whenever one of its days is thin would need the observations
 * counted per day, which no read here does.
 *
 * Contract verdicts and counters are counts of reports and events by client
 * version and host build, not measurements of a sitting, and are shown at any
 * size: a host build that breaks the contract has to be visible from its first
 * report, and such a build may live for a few hours only.
 *
 * Percentiles are read off buckets merged over the whole range (the hours in
 * SQL, the host builds of a footprint row here), never averaged from parts.
 */

/**
 * The zone the range's days are days of: the dashboard's, as in the owner's
 * other reports. Moscow is a whole number of hours from UTC all year, so a day
 * is exactly 24 of the rollups' UTC hours.
 */
export const CLIENT_HEALTH_VIEW_TIME_ZONE = MOSCOW_TIME_ZONE;

/**
 * The unit of the client's own perf histograms, the rows of the view's `perf`.
 * The levels the hub buckets itself are in other units (KB, nodes) and go to
 * the footprint rows.
 */
const PERF_UNIT = "ms";

type FootprintField = "cachesKBp95" | "logsKBp95" | "domNodesP95";

/**
 * The levels the intake buckets itself, one observation per report: what each
 * is called in the rollups, where it goes in a footprint row, and the schema
 * version and bounds the view reads. Rows of a retired version stay in the
 * table and are not shown.
 */
const FOOTPRINT_LEVELS: ReadonlyArray<{
  metric: string;
  field: FootprintField;
  schemaVersion: number;
  bounds: readonly number[];
}> = [
  {
    metric: "footprint.cachesKB",
    field: "cachesKBp95",
    schemaVersion: CLIENT_HEALTH_FOOTPRINT_METRICS["footprint.cachesKB"].schemaVersion,
    bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS,
  },
  {
    metric: "footprint.logsKB",
    field: "logsKBp95",
    schemaVersion: CLIENT_HEALTH_FOOTPRINT_METRICS["footprint.logsKB"].schemaVersion,
    bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS,
  },
  {
    metric: "footprint.dom-nodes-max",
    field: "domNodesP95",
    schemaVersion: CLIENT_HEALTH_GAUGE_COUNTERS["footprint.dom-nodes-max"].schemaVersion,
    bounds: CLIENT_HEALTH_GAUGE_COUNTERS["footprint.dom-nodes-max"].bounds,
  },
];

const FOOTPRINT_METRIC_NAMES: readonly string[] = FOOTPRINT_LEVELS.map((level) => level.metric);

export interface ClientHealthViewRange {
  from: string;
  to: string;
  timeZone: string;
  /** The first hub hour of `from`. */
  fromBound: Date;
  /** The first hub hour after `to`. */
  toExclusiveBound: Date;
}

/**
 * The hub hours a range of days covers. The query schema has checked the days,
 * their order, and that the day after `to` is one the hub can name.
 */
export function resolveClientHealthViewRange(query: Pick<AdminClientHealthQuery, "from" | "to">): ClientHealthViewRange {
  return {
    from: query.from,
    to: query.to,
    timeZone: CLIENT_HEALTH_VIEW_TIME_ZONE,
    fromBound: businessDateToUtcStart(query.from, CLIENT_HEALTH_VIEW_TIME_ZONE),
    toExclusiveBound: businessDateToUtcStart(nextBusinessDate(query.to), CLIENT_HEALTH_VIEW_TIME_ZONE),
  };
}

export interface ClientHealthViewTotals {
  perf: readonly ClientHealthPerfTotal[];
  contract: readonly ClientHealthContractTotal[];
  missing: readonly ClientHealthMissingTotal[];
  counters: readonly ClientHealthCounterTotal[];
}

/** A stored host build as the view spells it: the empty string is a build the client could not read. */
function hostBuildOf(stored: string): string | null {
  return stored === CLIENT_HEALTH_BUILD_UNREAD ? null : stored;
}

function sameBounds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((bound, index) => bound === right[index]);
}

function byCode(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Shapes the range's totals into the view. Pure.
 *
 * `metric` narrows `perf` alone. The footprint levels live in the same rollup
 * table as the perf histograms and are never listed among them.
 */
export function buildClientHealthView(
  totals: ClientHealthViewTotals,
  input: {
    range: Pick<ClientHealthViewRange, "from" | "to" | "timeZone">;
    asOf: Date;
    metric?: string | undefined;
    minGroupSize?: number;
  },
): AdminClientHealthResponse {
  const minGroupSize = input.minGroupSize ?? CLIENT_HEALTH_MIN_GROUP_SIZE;

  const perf = totals.perf
    .filter((row) => row.unit === PERF_UNIT && (input.metric === undefined || row.metric === input.metric))
    .map((row) => {
      const { p50, p95, suppressed } = clientHealthP50P95(row, minGroupSize);
      return {
        clientName: row.clientName,
        clientVersion: row.clientVersion,
        hostKind: row.hostKind,
        hostBuild: hostBuildOf(row.hostBuild),
        metric: row.metric,
        schemaVersion: row.schemaVersion,
        count: row.count,
        mean: suppressed || row.count === 0 ? null : row.sum / row.count,
        max: suppressed ? null : row.max,
        p50,
        p95,
        suppressed,
      };
    });

  // A footprint row is one client version on every host build: the levels'
  // buckets are added across the builds before a percentile is read.
  const levels = new Map<string, Map<FootprintField, { counts: number[]; max: number }>>();
  for (const row of totals.perf) {
    const level = FOOTPRINT_LEVELS.find((entry) => entry.metric === row.metric);
    if (level === undefined || row.schemaVersion !== level.schemaVersion || !sameBounds(row.bounds, level.bounds)) {
      continue;
    }
    let version = levels.get(row.clientVersion);
    if (version === undefined) {
      version = new Map();
      levels.set(row.clientVersion, version);
    }
    const merged = version.get(level.field) ?? { counts: level.bounds.map(() => 0).concat(0), max: 0 };
    row.counts.forEach((bucket, index) => {
      merged.counts[index]! += bucket;
    });
    merged.max = Math.max(merged.max, row.max);
    version.set(level.field, merged);
  }
  const footprint = [...levels].sort(([left], [right]) => byCode(left, right)).map(([clientVersion, version]) => {
    const p95Of = (field: FootprintField): number | null => {
      const merged = version.get(field);
      if (merged === undefined || merged.counts.reduce((sum, bucket) => sum + bucket, 0) < minGroupSize) {
        return null;
      }
      const level = FOOTPRINT_LEVELS.find((entry) => entry.field === field)!;
      return clientHealthPercentile({ bounds: level.bounds, counts: merged.counts, max: merged.max }, 0.95);
    };
    return {
      clientVersion,
      cachesKBp95: p95Of("cachesKBp95"),
      logsKBp95: p95Of("logsKBp95"),
      domNodesP95: p95Of("domNodesP95"),
    };
  });

  // Keyed by JSON: a version or a build may be `constructor`.
  const missing = new Map<string, Array<{ anchor: string; reports: number }>>();
  for (const row of totals.missing) {
    const key = JSON.stringify([row.clientVersion, row.hostBuild]);
    const anchors = missing.get(key) ?? [];
    anchors.push({ anchor: row.anchor, reports: row.reports });
    missing.set(key, anchors);
  }
  const contract = totals.contract.map((row) => ({
    clientVersion: row.clientVersion,
    hostBuild: hostBuildOf(row.hostBuild),
    reports: row.reports,
    failedReports: row.failedReports,
    missing: (missing.get(JSON.stringify([row.clientVersion, row.hostBuild])) ?? [])
      .sort((left, right) => right.reports - left.reports || byCode(left.anchor, right.anchor)),
  }));

  return {
    range: { from: input.range.from, to: input.range.to, timeZone: input.range.timeZone },
    minGroupSize,
    perf,
    contract,
    counters: totals.counters.map((row) => ({ code: row.code, total: row.total })),
    footprint,
    asOf: input.asOf.toISOString(),
  };
}

/** Reads the view for a range of days. Database only, and it writes nothing. */
export async function getClientHealthView(
  app: AppContext,
  query: AdminClientHealthQuery,
  now: Date = new Date(),
): Promise<AdminClientHealthResponse> {
  const range = resolveClientHealthViewRange(query);
  const hours = { from: range.fromBound, toExclusive: range.toExclusiveBound, clientName: query.clientName };
  // One snapshot: a report folded between two of the reads would otherwise be
  // counted in the contract rows and missing from the histograms.
  const totals = await app.db.transaction(async (tx): Promise<ClientHealthViewTotals> => ({
    perf: await listClientHealthPerfTotals(tx, {
      ...hours,
      // The footprint levels are always read; `metric` narrows the perf histograms beside them.
      metrics: query.metric === undefined ? undefined : [query.metric, ...FOOTPRINT_METRIC_NAMES],
    }),
    contract: await listClientHealthContractTotals(tx, hours),
    missing: await listClientHealthMissingTotals(tx, hours),
    counters: await listClientHealthCounterTotals(tx, hours),
  }), { isolationLevel: "repeatable read", accessMode: "read only" });

  return buildClientHealthView(totals, { range, asOf: now, metric: query.metric });
}
