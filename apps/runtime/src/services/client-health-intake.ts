import {
  CLIENT_HEALTH_CODE_PATTERN,
  CLIENT_HEALTH_PERF_METRICS,
  clientHealthReportV1Schema,
  type ClientHealthPerfHistogram,
  type ClientHealthPerfMetricName,
  type ClientHealthReportV1,
} from "@agency_hub_core/contracts";
import {
  claimClientHealthReceipts,
  clientHealthHour,
  mergeClientHealthRollups,
  type ClientHealthContractRollup,
  type ClientHealthCounterRollup,
  type ClientHealthGroup,
  type ClientHealthMissingRollup,
  type ClientHealthPerfRollup,
  type ClientHealthRollups,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { clientHealthHistogramFits } from "./client-health-perf.ts";
import { loadClientSwitches } from "./client-switches.ts";

/**
 * The intake of the chat extension's `client_health` reports (chat-extension
 * hub-pr-plan H-11b, storage variant B′).
 *
 * A report arrives on the authenticated capture lane, so the hub sees who sent
 * it. It must not keep that: the `observations` journal stores the payload and
 * the user forever and carries both into the lake. So the capture lane hands
 * this kind here instead of journaling it, and the intake keeps only hourly
 * rollups with no user in them (packages/db/src/repositories/client-health.ts):
 * the report is folded into counts and merged buckets under the hour the HUB
 * received it, and the report itself is dropped.
 *
 * Nothing here refuses a batch. A report that does not parse is dropped on its
 * own and logged by the name of the field it failed on; a histogram the hub
 * cannot merge safely is left out and the rest of its report still counts. While the owner's switch is off
 * a report is accepted and not kept at all.
 */

/** The group value of a client version or host build that is not a code. Not a
 *  code itself (parentheses), so no client can send it. */
export const CLIENT_HEALTH_UNCODED = "(other)";
/** The group value of a host build the client could not read (`build: null`). */
export const CLIENT_HEALTH_BUILD_UNREAD = "";

/**
 * A histogram above this many observations, or with a value above this, is not
 * a measurement of a 15-minute window (the cap is a billion: observations, or
 * milliseconds = 11 days, or kilobytes = 1 TB). The report schema allows any
 * safe integer and any finite double, as the client's does; summed into a row
 * that lives forever, a few such reports would overflow it and fail every
 * later batch of the hour.
 */
export const CLIENT_HEALTH_PLAUSIBLE_MAX = 1_000_000_000;

/**
 * The client's own storage, as two histograms the hub builds itself: one
 * observation per report, so that a p95 over reports can be read later without
 * keeping any report. Bounds in KB; a new set of bounds is a new schemaVersion.
 */
export const CLIENT_HEALTH_FOOTPRINT_METRICS = {
  "footprint.cachesKB": { field: "cachesKB", unit: "KB", schemaVersion: 1 },
  "footprint.logsKB": { field: "logsKB", unit: "KB", schemaVersion: 1 },
} as const satisfies Record<string, { field: keyof ClientHealthReportV1["footprint"]; unit: "KB"; schemaVersion: number }>;

/** 16 KB … 256 MB, doubling. */
export const CLIENT_HEALTH_FOOTPRINT_BOUNDS: readonly number[] = [
  16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144,
];

/** 64 … 65 536 DOM nodes, doubling. */
export const CLIENT_HEALTH_DOM_NODES_BOUNDS: readonly number[] = [
  64, 128, 256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536,
];

/**
 * Counter codes that are a level, not a count. The report has no field for the
 * client's DOM nodes, so the client sends them among its counters: the largest
 * number of its own nodes a tab reported in the window (its
 * `footprint.dom-nodes-max`). Added up over reports and installs that is no
 * number at all, and the reports are not kept to take it apart again. So such a
 * code never reaches the counter rollup: the hub buckets it like the two
 * storage sizes, one observation per report that carries it, under the client's
 * own code as the metric name.
 *
 * A counter the client means as a level must be listed here before the client
 * sends it; one that is not is summed like any count.
 */
export const CLIENT_HEALTH_GAUGE_COUNTERS = {
  "footprint.dom-nodes-max": { unit: "nodes", schemaVersion: 1, bounds: CLIENT_HEALTH_DOM_NODES_BOUNDS },
} as const satisfies Record<string, { unit: "nodes"; schemaVersion: number; bounds: readonly number[] }>;

export type ClientHealthHistogramDropReason =
  /** The hub's registry has no such metric (a newer client's). */
  | "unknown_metric"
  /** A schema version of the metric the registry does not hold. */
  | "unknown_schema_version"
  /** Not the bounds the registry holds for this metric and version. */
  | "bounds_mismatch"
  /** Beyond CLIENT_HEALTH_PLAUSIBLE_MAX. */
  | "implausible"
  /** Its max or sum is not one its buckets can hold (clientHealthHistogramFits). */
  | "does_not_fit";

function codeOrPlaceholder(value: string): string {
  return CLIENT_HEALTH_CODE_PATTERN.test(value) ? value : CLIENT_HEALTH_UNCODED;
}

/**
 * The group a report is filed under. The version and the build are the
 * client's bounded strings, not codes: one that is not a code (a space, a
 * slash, a sentence) goes under the placeholder, so no free text ever becomes a
 * key of a table kept forever.
 */
export function clientHealthGroup(report: ClientHealthReportV1): ClientHealthGroup {
  return {
    clientName: report.client.name,
    clientVersion: codeOrPlaceholder(report.client.version),
    hostKind: report.host.kind,
    hostBuild: report.host.build === null ? CLIENT_HEALTH_BUILD_UNREAD : codeOrPlaceholder(report.host.build),
  };
}

/**
 * Why a perf histogram is left out of the rollups, or null when it merges. The
 * metric is looked up as an own key: a code may name an inherited property
 * (`constructor`), which is no metric.
 *
 * The registry holds one schema version per metric, and exactly that one is
 * merged. A rollup row is keyed by metric AND schema version and carries its
 * bounds, so two versions never share buckets. The PR that gives a metric new
 * bounds (a new schemaVersion in the registry) must also keep the retired
 * version's bounds here, or the reports of clients not yet updated lose that
 * metric as `unknown_schema_version` until they update.
 */
export function clientHealthHistogramDropReason(
  histogram: ClientHealthPerfHistogram,
): ClientHealthHistogramDropReason | null {
  if (!Object.hasOwn(CLIENT_HEALTH_PERF_METRICS, histogram.metric)) {
    return "unknown_metric";
  }
  const registered = CLIENT_HEALTH_PERF_METRICS[histogram.metric as ClientHealthPerfMetricName];
  if (histogram.schemaVersion !== registered.schemaVersion) {
    return "unknown_schema_version";
  }
  const bounds: readonly number[] = registered.bounds;
  if (histogram.bounds.length !== bounds.length || histogram.bounds.some((bound, index) => bound !== bounds[index])) {
    return "bounds_mismatch";
  }
  if (histogram.count > CLIENT_HEALTH_PLAUSIBLE_MAX || histogram.max > CLIENT_HEALTH_PLAUSIBLE_MAX) {
    return "implausible";
  }
  return clientHealthHistogramFits(histogram) ? null : "does_not_fit";
}

export interface ClientHealthFold {
  rollups: ClientHealthRollups;
  /** Histograms left out, by metric and reason. Codes only: safe to log. */
  dropped: Array<{ metric: string; reason: ClientHealthHistogramDropReason }>;
}

type HistogramInput = Pick<ClientHealthPerfRollup, "metric" | "schemaVersion" | "unit" | "bounds" | "counts" | "count" | "sum" | "max">;

/**
 * Folds reports into the rows to add to one hour. Pure.
 *
 * Every accumulator is a Map keyed by the JSON of the row's key: a counter code
 * or an anchor may be `constructor` or `toString`, which a plain object would
 * read off its prototype.
 */
export function foldClientHealthReports(reports: readonly ClientHealthReportV1[]): ClientHealthFold {
  const contract = new Map<string, ClientHealthContractRollup>();
  const missing = new Map<string, ClientHealthMissingRollup>();
  const counters = new Map<string, ClientHealthCounterRollup>();
  const perf = new Map<string, ClientHealthPerfRollup>();
  const dropped: ClientHealthFold["dropped"] = [];

  function row<T>(rows: Map<string, T>, key: readonly (string | number)[], start: () => T): T {
    const id = JSON.stringify(key);
    let found = rows.get(id);
    if (found === undefined) {
      found = start();
      rows.set(id, found);
    }
    return found;
  }

  function addHistogram(group: ClientHealthGroup, groupKey: readonly string[], histogram: HistogramInput) {
    const merged = row(perf, [...groupKey, histogram.metric, histogram.schemaVersion], () => ({
      ...group,
      metric: histogram.metric,
      schemaVersion: histogram.schemaVersion,
      unit: histogram.unit,
      bounds: [...histogram.bounds],
      counts: histogram.counts.map(() => 0),
      count: 0,
      sum: 0,
      max: 0,
    }));
    histogram.counts.forEach((bucket, index) => {
      merged.counts[index]! += bucket;
    });
    merged.count += histogram.count;
    merged.sum += histogram.sum;
    merged.max = Math.max(merged.max, histogram.max);
  }

  /** One report's level (a storage size, a node count) as one observation of a histogram the hub builds itself. */
  function addObservation(
    group: ClientHealthGroup,
    groupKey: readonly string[],
    metric: string,
    spec: { unit: string; schemaVersion: number; bounds: readonly number[] },
    value: number,
  ) {
    if (value > CLIENT_HEALTH_PLAUSIBLE_MAX) {
      dropped.push({ metric, reason: "implausible" });
      return;
    }
    const bucket = spec.bounds.findIndex((bound) => value <= bound);
    const counts = Array.from({ length: spec.bounds.length + 1 }, () => 0);
    counts[bucket === -1 ? spec.bounds.length : bucket] = 1;
    addHistogram(group, groupKey, {
      metric,
      schemaVersion: spec.schemaVersion,
      unit: spec.unit,
      bounds: [...spec.bounds],
      counts,
      count: 1,
      sum: value,
      max: value,
    });
  }

  for (const report of reports) {
    const group = clientHealthGroup(report);
    const groupKey = [group.clientName, group.clientVersion, group.hostKind, group.hostBuild];

    const verdict = row(contract, groupKey, () => ({ ...group, reports: 0, failedReports: 0 }));
    verdict.reports += 1;
    if (!report.host.contractOk) {
      verdict.failedReports += 1;
    }

    // An anchor a report names twice is still one report that missed it.
    for (const anchor of new Set(report.host.missing)) {
      row(missing, [...groupKey, anchor], () => ({ ...group, anchor, reports: 0 })).reports += 1;
    }

    // Zeroes are kept: the client always sends its P1 counters, and "reported, none" is the answer the owner wants.
    for (const [code, value] of Object.entries(report.counters)) {
      // An own key: a code may name an inherited property (`constructor`), which is no gauge.
      if (Object.hasOwn(CLIENT_HEALTH_GAUGE_COUNTERS, code)) {
        addObservation(group, groupKey, code, CLIENT_HEALTH_GAUGE_COUNTERS[code as keyof typeof CLIENT_HEALTH_GAUGE_COUNTERS], value);
        continue;
      }
      row(counters, [...groupKey, code], () => ({ ...group, code, total: 0 })).total += value;
    }

    for (const histogram of report.perf) {
      if (histogram.count === 0) {
        continue;
      }
      const reason = clientHealthHistogramDropReason(histogram);
      if (reason !== null) {
        dropped.push({ metric: histogram.metric, reason });
        continue;
      }
      addHistogram(group, groupKey, histogram);
    }

    for (const [metric, spec] of Object.entries(CLIENT_HEALTH_FOOTPRINT_METRICS)) {
      addObservation(group, groupKey, metric, { ...spec, bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS }, report.footprint[spec.field]);
    }
  }

  return {
    rollups: {
      contract: [...contract.values()],
      missing: [...missing.values()],
      counters: [...counters.values()],
      perf: [...perf.values()],
    },
    dropped,
  };
}

const REPORT_FIELDS: ReadonlySet<string> = new Set(Object.keys(clientHealthReportV1Schema.shape));

/**
 * The top-level fields a refused report failed on, for the log. Never the issue
 * paths or messages themselves: a path can carry the very text the schema
 * refused (a counter key that is a sentence).
 */
function refusedFields(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  return [...new Set(issues.map((issue) => {
    const head = issue.path[0];
    return typeof head === "string" && REPORT_FIELDS.has(head) ? head : "(report)";
  }))].sort();
}

/** Whether the hub keeps health reports right now: the owner's live switch, read per batch. */
export async function clientHealthIngestEnabled(app: AppContext): Promise<boolean> {
  return (await loadClientSwitches(app)).healthIngestEnabled;
}

export interface ClientHealthIntakeEvent {
  clientEventId: string;
  payload: Record<string, unknown>;
}

/**
 * Takes the `client_health` events of one capture batch, inside the batch's
 * transaction. Returns how they count toward the lane's answer:
 *
 * - the switch is off: accepted, nothing is read or kept;
 * - the report does not parse: dropped and logged, accepted (the client must
 *   not resend it: it would fail the same way);
 * - its client event id was folded before, or twice in this batch: a duplicate;
 * - otherwise folded into the hour's rollups: accepted.
 *
 * It never writes `observations` and never throws on a report's content.
 */
export async function intakeClientHealthReports(
  app: AppContext,
  tx: Database,
  input: {
    events: readonly ClientHealthIntakeEvent[];
    enabled: boolean;
    /** When the hub received the batch; the reports are filed under its UTC hour. */
    receivedAt?: Date;
  },
): Promise<{ accepted: number; duplicates: number }> {
  if (input.events.length === 0 || !input.enabled) {
    return { accepted: input.events.length, duplicates: 0 };
  }

  let accepted = 0;
  let duplicates = 0;
  let refused = 0;
  /** Report field → how many refused reports failed on it. The keys are the schema's own, never the client's. */
  const refusedOn = new Map<string, number>();
  const reports = new Map<string, ClientHealthReportV1>();
  for (const event of input.events) {
    const parsed = clientHealthReportV1Schema.safeParse(event.payload);
    if (!parsed.success) {
      refused += 1;
      for (const field of refusedFields(parsed.error.issues)) {
        refusedOn.set(field, (refusedOn.get(field) ?? 0) + 1);
      }
      accepted += 1;
      continue;
    }
    const id = event.clientEventId.toLowerCase();
    if (reports.has(id)) {
      duplicates += 1;
      continue;
    }
    reports.set(id, parsed.data);
  }
  if (refused > 0) {
    // One line per batch, however many reports it dropped.
    app.logger?.warn(
      { dropped: refused, fields: Object.fromEntries(refusedOn) },
      "client_health reports dropped: they do not match the v1 report schema",
    );
  }

  const hour = clientHealthHour(input.receivedAt ?? new Date());
  const claimed = await claimClientHealthReceipts(tx, { clientEventIds: [...reports.keys()], hour });
  const fresh = [...reports].filter(([id]) => claimed.has(id)).map(([, report]) => report);
  duplicates += reports.size - fresh.length;
  accepted += fresh.length;
  if (fresh.length === 0) {
    return { accepted, duplicates };
  }

  const fold = foldClientHealthReports(fresh);
  if (fold.dropped.length > 0) {
    // One line per batch: each metric and reason once, with how many histograms it cost.
    const leftOut = new Map<string, { metric: string; reason: ClientHealthHistogramDropReason; histograms: number }>();
    for (const { metric, reason } of fold.dropped) {
      const id = JSON.stringify([metric, reason]);
      const entry = leftOut.get(id) ?? { metric, reason, histograms: 0 };
      entry.histograms += 1;
      leftOut.set(id, entry);
    }
    app.logger?.warn(
      { dropped: [...leftOut.values()] },
      "client_health histograms left out of the rollups; the rest of their reports counted",
    );
  }
  const { unmergedPerf } = await mergeClientHealthRollups(tx, { hour, rollups: fold.rollups });
  if (unmergedPerf.length > 0) {
    app.logger?.error(
      { unmerged: unmergedPerf },
      "client_health histograms not merged: the stored rows of this hour hold other bounds for the same "
        + "metric and schema version (the bounds registry changed without a new schemaVersion)",
    );
  }
  return { accepted, duplicates };
}
