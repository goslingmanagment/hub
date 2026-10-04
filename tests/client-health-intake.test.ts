import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CLIENT_HEALTH_CODE_PATTERN,
  CLIENT_HEALTH_PERF_METRICS,
  clientHealthReportV1Schema,
  type ClientHealthReportV1,
} from "@agency_hub_core/contracts";
import { clientHealthHour, type ClientHealthPerfRollup } from "@agency_hub_core/db";

import {
  CLIENT_HEALTH_BUILD_UNREAD,
  CLIENT_HEALTH_FOOTPRINT_BOUNDS,
  CLIENT_HEALTH_FOOTPRINT_METRICS,
  CLIENT_HEALTH_PLAUSIBLE_MAX,
  CLIENT_HEALTH_UNCODED,
  clientHealthGroup,
  clientHealthHistogramDropReason,
  foldClientHealthReports,
} from "../apps/runtime/src/services/client-health-intake.ts";
import { clientHealthHistogramFits, clientHealthPercentile } from "../apps/runtime/src/services/client-health-perf.ts";

// client_health intake (chat-extension hub plan H-11b, storage variant B′): the
// pure half. A report is folded into hourly rollups that hold no user; the
// report itself is never stored. The database half (receipts, merging across
// batches, the capture lane, the switch) is
// tests/client-health-intake.integration.test.ts.

type Histogram = ClientHealthReportV1["perf"][number];

/** A histogram on the registry's bounds, built the way the client builds one. */
function histogramFor(metric: keyof typeof CLIENT_HEALTH_PERF_METRICS, samples: number[]): Histogram {
  const entry = CLIENT_HEALTH_PERF_METRICS[metric];
  const bounds = [...entry.bounds];
  const counts: number[] = Array.from({ length: bounds.length + 1 }, () => 0);
  for (const sample of samples) {
    const index = bounds.findIndex((bound) => sample <= bound);
    counts[index === -1 ? bounds.length : index]! += 1;
  }
  return {
    metric,
    unit: entry.unit,
    schemaVersion: entry.schemaVersion,
    bounds,
    counts,
    count: samples.length,
    sum: samples.reduce((total, sample) => total + sample, 0),
    max: samples.length === 0 ? 0 : Math.max(...samples),
  };
}

/** A report as it reaches the fold: parsed by the report schema, as the intake parses it. */
function report(overrides: {
  version?: string;
  build?: string | null;
  hostKind?: string;
  contractOk?: boolean;
  missing?: string[];
  perf?: Histogram[];
  counters?: Record<string, number>;
  cachesKB?: number;
  logsKB?: number;
} = {}): ClientHealthReportV1 {
  return clientHealthReportV1Schema.parse({
    v: 1,
    window: { from: "2026-10-03T10:00:00Z", to: "2026-10-03T10:15:00Z" },
    client: { name: "chat-extension", version: overrides.version ?? "0.1.0", browser: "firefox", browserMajor: 157, os: "macos" },
    host: {
      kind: overrides.hostKind ?? "chatspace",
      build: overrides.build === undefined ? "index-0000test" : overrides.build,
      contractOk: overrides.contractOk ?? true,
      missing: overrides.missing ?? [],
    },
    disabled: [],
    perf: overrides.perf ?? [],
    counters: overrides.counters ?? {},
    footprint: { kind: "owned-estimate", cachesKB: overrides.cachesKB ?? 420, logsKB: overrides.logsKB ?? 900 },
  });
}

const GROUP = { clientName: "chat-extension", clientVersion: "0.1.0", hostKind: "chatspace", hostBuild: "index-0000test" };

function perfRow(rows: readonly ClientHealthPerfRollup[], metric: string): ClientHealthPerfRollup | undefined {
  return rows.find((row) => row.metric === metric);
}

describe("client_health group: codes only", () => {
  it("keeps a version and a build that are codes", () => {
    expect(clientHealthGroup(report())).toEqual(GROUP);
    expect(clientHealthGroup(report({ version: "1.4.2-beta.1", build: "index-DEVowLko" })))
      .toMatchObject({ clientVersion: "1.4.2-beta.1", hostBuild: "index-DEVowLko" });
  });

  it("files a version or a build that is not a code under one placeholder", () => {
    // The report schema takes these: they are the client's bounded strings.
    for (const version of ["1.4.2 (dev build)", "v1/4", "Маша", "1.4.2\n"]) {
      expect(clientHealthGroup(report({ version })).clientVersion, version).toBe(CLIENT_HEALTH_UNCODED);
    }
    for (const build of ["index DEVowLko", "https://cdn.example/app.js", "Привет, Маша", ""]) {
      expect(clientHealthGroup(report({ build })).hostBuild, build).toBe(CLIENT_HEALTH_UNCODED);
    }
    // No client can send the placeholder as a code, so it never collides with a real group.
    expect(CLIENT_HEALTH_CODE_PATTERN.test(CLIENT_HEALTH_UNCODED)).toBe(false);
  });

  it("files a build the client could not read under its own value", () => {
    expect(clientHealthGroup(report({ build: null })).hostBuild).toBe(CLIENT_HEALTH_BUILD_UNREAD);
    expect(CLIENT_HEALTH_BUILD_UNREAD).not.toBe(CLIENT_HEALTH_UNCODED);
    expect(CLIENT_HEALTH_CODE_PATTERN.test(CLIENT_HEALTH_BUILD_UNREAD)).toBe(false);
  });
});

describe("client_health fold", () => {
  it("counts reports and broken contracts per group", () => {
    const { rollups } = foldClientHealthReports([
      report(),
      report({ contractOk: false, missing: ["fansMap"] }),
      report({ version: "0.2.0" }),
      report({ build: null, contractOk: false }),
    ]);
    expect(rollups.contract).toEqual([
      { ...GROUP, reports: 2, failedReports: 1 },
      { ...GROUP, clientVersion: "0.2.0", reports: 1, failedReports: 0 },
      { ...GROUP, hostBuild: "", reports: 1, failedReports: 1 },
    ]);
  });

  it("counts an anchor once per report that missed it", () => {
    const { rollups } = foldClientHealthReports([
      report({ contractOk: false, missing: ["fansMap", "composer", "fansMap"] }),
      report({ contractOk: false, missing: ["fansMap"] }),
    ]);
    expect(rollups.missing).toEqual([
      { ...GROUP, anchor: "fansMap", reports: 2 },
      { ...GROUP, anchor: "composer", reports: 1 },
    ]);
  });

  it("sums counters through a Map: a code may name an inherited object property", () => {
    const { rollups } = foldClientHealthReports([
      report({ counters: { constructor: 2, toString: 1, hasOwnProperty: 4, "CG-SEND-UNCERTAIN": 1, "p1.insert-misplaced": 0 } }),
      report({ counters: { constructor: 3, valueOf: 5, "p1.insert-misplaced": 0 } }),
    ]);
    expect(rollups.counters).toEqual([
      { ...GROUP, code: "constructor", total: 5 },
      { ...GROUP, code: "toString", total: 1 },
      { ...GROUP, code: "hasOwnProperty", total: 4 },
      { ...GROUP, code: "CG-SEND-UNCERTAIN", total: 1 },
      // A zero is kept: "reported, none" is not "not reported".
      { ...GROUP, code: "p1.insert-misplaced", total: 0 },
      { ...GROUP, code: "valueOf", total: 5 },
    ]);
    for (const row of rollups.counters) {
      expect(typeof row.total, row.code).toBe("number");
    }
  });

  it("keeps the counters of two groups apart", () => {
    const { rollups } = foldClientHealthReports([
      report({ counters: { "CG-HUB-UNAVAILABLE": 2 } }),
      report({ version: "0.2.0", counters: { "CG-HUB-UNAVAILABLE": 7 } }),
    ]);
    expect(rollups.counters).toEqual([
      { ...GROUP, code: "CG-HUB-UNAVAILABLE", total: 2 },
      { ...GROUP, clientVersion: "0.2.0", code: "CG-HUB-UNAVAILABLE", total: 7 },
    ]);
  });

  it("merges histograms bucket by bucket, so a percentile is read off the whole", () => {
    const first = histogramFor("insertMs", [10, 40, 90]);
    const second = histogramFor("insertMs", [10, 12, 700, 1500]);
    const { rollups, dropped } = foldClientHealthReports([report({ perf: [first] }), report({ perf: [second] })]);

    expect(dropped).toEqual([]);
    const merged = perfRow(rollups.perf, "insertMs")!;
    expect(merged).toMatchObject({ ...GROUP, metric: "insertMs", schemaVersion: 1, unit: "ms", count: 7, sum: 2362, max: 1500 });
    expect(merged.bounds).toEqual([...CLIENT_HEALTH_PERF_METRICS.insertMs.bounds]);
    expect(merged.counts).toEqual(first.counts.map((bucket, index) => bucket + second.counts[index]!));
    expect(merged.counts.reduce((total, bucket) => total + bucket, 0)).toBe(merged.count);
    expect(clientHealthHistogramFits(merged)).toBe(true);
    expect(clientHealthPercentile(merged, 1)).toBe(1500);
    // The inputs are not touched.
    expect(first.counts).toEqual(histogramFor("insertMs", [10, 40, 90]).counts);
  });

  it("leaves out one bad histogram and keeps the rest of the report", () => {
    const good = histogramFor("routeToDockMs", [3, 5]);
    const badSum = { ...histogramFor("insertMs", [10, 40, 90]), sum: 5_000 };
    const { rollups, dropped } = foldClientHealthReports([
      report({ perf: [good, badSum], counters: { "p1.send-without-human": 1 }, contractOk: false, missing: ["fansMap"] }),
    ]);

    expect(dropped).toEqual([{ metric: "insertMs", reason: "does_not_fit" }]);
    expect(rollups.perf.map((row) => row.metric).sort()).toEqual(["footprint.cachesKB", "footprint.logsKB", "routeToDockMs"]);
    expect(rollups.contract).toEqual([{ ...GROUP, reports: 1, failedReports: 1 }]);
    expect(rollups.counters).toEqual([{ ...GROUP, code: "p1.send-without-human", total: 1 }]);
    expect(rollups.missing).toEqual([{ ...GROUP, anchor: "fansMap", reports: 1 }]);
  });

  it("skips an empty histogram without a word", () => {
    const { rollups, dropped } = foldClientHealthReports([report({ perf: [histogramFor("insertMs", [])] })]);
    expect(dropped).toEqual([]);
    expect(perfRow(rollups.perf, "insertMs")).toBeUndefined();
  });

  it("buckets the client's own storage itself, one observation per report", () => {
    const { rollups } = foldClientHealthReports([
      report({ cachesKB: 0, logsKB: 16 }),
      report({ cachesKB: 420, logsKB: 17 }),
      report({ cachesKB: 300_000, logsKB: 900 }),
    ]);
    const caches = perfRow(rollups.perf, "footprint.cachesKB")!;
    const logs = perfRow(rollups.perf, "footprint.logsKB")!;

    expect(caches).toMatchObject({ ...GROUP, unit: "KB", schemaVersion: 1, count: 3, sum: 300_420, max: 300_000 });
    expect(caches.bounds).toEqual([...CLIENT_HEALTH_FOOTPRINT_BOUNDS]);
    // 0 → the first bucket; 420 → (256, 512]; 300 000 → above the last bound.
    expect(caches.counts[0]).toBe(1);
    expect(caches.counts[CLIENT_HEALTH_FOOTPRINT_BOUNDS.indexOf(512)]).toBe(1);
    expect(caches.counts.at(-1)).toBe(1);
    // A value on a bound belongs to that bound's bucket; the next one starts above it.
    expect(logs.counts[0]).toBe(1);
    expect(logs.counts[1]).toBe(1);
    expect(logs).toMatchObject({ count: 3, sum: 933, max: 900 });
    for (const row of [caches, logs]) {
      expect(row.counts).toHaveLength(row.bounds.length + 1);
      expect(clientHealthHistogramFits(row)).toBe(true);
    }
  });

  it("leaves out a storage size no browser profile holds", () => {
    const { rollups, dropped } = foldClientHealthReports([
      report({ cachesKB: CLIENT_HEALTH_PLAUSIBLE_MAX + 1, logsKB: CLIENT_HEALTH_PLAUSIBLE_MAX }),
    ]);
    expect(dropped).toEqual([{ metric: "footprint.cachesKB", reason: "implausible" }]);
    expect(perfRow(rollups.perf, "footprint.cachesKB")).toBeUndefined();
    expect(perfRow(rollups.perf, "footprint.logsKB")).toMatchObject({ count: 1, max: CLIENT_HEALTH_PLAUSIBLE_MAX });
  });

  it("holds footprint bounds a histogram can be built on, under names no client metric has", () => {
    expect(CLIENT_HEALTH_FOOTPRINT_BOUNDS.length).toBeLessThanOrEqual(32);
    CLIENT_HEALTH_FOOTPRINT_BOUNDS.forEach((bound, index) => {
      expect(bound).toBeGreaterThan(index === 0 ? 0 : CLIENT_HEALTH_FOOTPRINT_BOUNDS[index - 1]!);
    });
    for (const [metric, spec] of Object.entries(CLIENT_HEALTH_FOOTPRINT_METRICS)) {
      expect(CLIENT_HEALTH_CODE_PATTERN.test(metric), metric).toBe(true);
      expect(Object.hasOwn(CLIENT_HEALTH_PERF_METRICS, metric), metric).toBe(false);
      expect(spec.unit).toBe("KB");
    }
  });
});

describe("client_health histogram checks against the registry", () => {
  it("merges every registry metric built the client's way", () => {
    for (const metric of Object.keys(CLIENT_HEALTH_PERF_METRICS) as Array<keyof typeof CLIENT_HEALTH_PERF_METRICS>) {
      const bounds = CLIENT_HEALTH_PERF_METRICS[metric].bounds;
      const samples = [bounds[0], bounds[0] / 2, bounds.at(-1)!, bounds.at(-1)! * 3];
      expect(clientHealthHistogramDropReason(histogramFor(metric, samples)), metric).toBeNull();
    }
  });

  it("drops a metric the registry does not hold, an inherited property name included", () => {
    const base = histogramFor("insertMs", [10]);
    for (const metric of ["someFutureMs", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(clientHealthHistogramDropReason({ ...base, metric }), metric).toBe("unknown_metric");
    }
  });

  it("drops a schema version or bounds the registry does not hold for the metric", () => {
    const base = histogramFor("insertMs", [10]);
    expect(clientHealthHistogramDropReason({ ...base, schemaVersion: 2 })).toBe("unknown_schema_version");

    // Another metric's bounds, of the same length: routeToDockMs has 13, insertMs 11.
    const shifted = base.bounds.map((bound) => bound + 1);
    expect(clientHealthHistogramDropReason({ ...base, bounds: shifted })).toBe("bounds_mismatch");
    const shorter = { ...base, bounds: base.bounds.slice(0, -1), counts: base.counts.slice(0, -1) };
    expect(clientHealthHistogramDropReason(shorter)).toBe("bounds_mismatch");
  });

  it("drops a histogram whose max or sum its buckets cannot hold", () => {
    const base = histogramFor("insertMs", [10, 40, 90]);
    expect(clientHealthHistogramDropReason({ ...base, max: 5_000 })).toBe("does_not_fit");
    expect(clientHealthHistogramDropReason({ ...base, sum: 1 })).toBe("does_not_fit");
  });

  it("drops a histogram too large to be a 15-minute window, before it can overflow a row kept forever", () => {
    const bounds = [...CLIENT_HEALTH_PERF_METRICS.insertMs.bounds];
    const counts = bounds.map(() => 0);
    const huge = CLIENT_HEALTH_PLAUSIBLE_MAX + 1;
    // The report schema takes both: any safe integer, any finite double.
    const tooMany = { metric: "insertMs", unit: "ms" as const, schemaVersion: 1, bounds, counts: [huge, ...counts], count: huge, sum: huge * 2, max: 4 };
    const tooLong = { metric: "insertMs", unit: "ms" as const, schemaVersion: 1, bounds, counts: [...counts, 1], count: 1, sum: 1e300, max: 1e300 };
    for (const histogram of [tooMany, tooLong]) {
      expect(clientHealthReportV1Schema.safeParse({ ...report(), perf: [histogram] }).success).toBe(true);
      expect(clientHealthHistogramFits(histogram)).toBe(true);
      expect(clientHealthHistogramDropReason(histogram)).toBe("implausible");
    }
    const atTheCap = { ...tooMany, counts: [CLIENT_HEALTH_PLAUSIBLE_MAX, ...counts], count: CLIENT_HEALTH_PLAUSIBLE_MAX, sum: CLIENT_HEALTH_PLAUSIBLE_MAX * 2 };
    expect(clientHealthHistogramDropReason(atTheCap)).toBeNull();
  });
});

describe("client_health hour", () => {
  it("is the UTC hour the hub received the report", () => {
    expect(clientHealthHour(new Date("2026-10-03T10:59:59.999Z")).toISOString()).toBe("2026-10-03T10:00:00.000Z");
    expect(clientHealthHour(new Date("2026-10-03T11:00:00.000Z")).toISOString()).toBe("2026-10-03T11:00:00.000Z");
    // 02:30 in Moscow is 23:30 UTC of the day before.
    expect(clientHealthHour(new Date("2026-10-04T02:30:00+03:00")).toISOString()).toBe("2026-10-03T23:00:00.000Z");
  });
});

describe("client_health rollups migration", () => {
  // The number is retaken at the last rebase (hub-pr-plan §3.0 rule 10), so the tests find the file by name.
  const file = readdirSync("packages/db/migrations").filter((name) => /^\d{4}_client_health_rollups\.sql$/.test(name));
  const sql = file.length === 1 ? readFileSync(`packages/db/migrations/${file[0]}`, "utf8") : "";
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  /** The column names of one `create table`, constraints left out. */
  function columnsOf(table: string): string[] {
    const body = new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`).exec(statements)?.[1] ?? "";
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^(constraint|primary key|check)\b/.test(line))
      .map((line) => line.split(/\s+/)[0]!);
  }

  it("is one migration, listed as rollback-compatible", () => {
    expect(file).toHaveLength(1);
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0]).toContain(`"${file[0]}"`);
  });

  it("creates the receipts and four hourly rollups, with no user, page, fan or report body in any of them", () => {
    const group = ["hour", "client_name", "client_version", "host_kind", "host_build"];
    expect(columnsOf("client_health_receipts")).toEqual(["client_event_id", "received_hour"]);
    expect(columnsOf("client_health_contract_hourly")).toEqual([...group, "reports", "failed_reports"]);
    expect(columnsOf("client_health_missing_hourly")).toEqual([...group, "anchor", "reports"]);
    expect(columnsOf("client_health_counters_hourly")).toEqual([...group, "code", "total"]);
    expect(columnsOf("client_health_perf_hourly")).toEqual([
      ...group, "metric", "schema_version", "unit", "bounds", "counts", "count", "sum", "max",
    ]);
    expect(statements.match(/create table/g)).toHaveLength(5);
    // B′: nothing that names a person, a page, a fan or a device, no report body, no foreign key.
    expect(statements).not.toMatch(/\b(user_id|actor|principal|page_id|account_id|fan_ref|device|payload|jsonb)\b/);
    expect(statements).not.toMatch(/\breferences\b/);
  });

  it("holds every group column to a code or a placeholder, in the database itself", () => {
    const code = "'^[A-Za-z0-9._:-]{1,80}$'";
    expect(CLIENT_HEALTH_CODE_PATTERN.source).toBe(code.slice(1, -1));
    for (const table of ["contract", "missing", "counters", "perf"]) {
      const name = `client_health_${table}_hourly`;
      expect(statements, name).toContain(`constraint ${name}_name_check check (client_name ~ ${code})`);
      expect(statements, name).toContain(`check (client_version = '${CLIENT_HEALTH_UNCODED}' or client_version ~ ${code})`);
      expect(statements, name).toContain(`constraint ${name}_kind_check check (host_kind ~ ${code})`);
      expect(statements, name).toContain(
        `check (host_build in ('${CLIENT_HEALTH_BUILD_UNREAD}', '${CLIENT_HEALTH_UNCODED}') or host_build ~ ${code})`,
      );
      expect(statements, name).toContain(`constraint ${name}_hour_check check (mod(extract(epoch from hour), 3600) = 0)`);
    }
    expect(statements).toContain(`constraint client_health_missing_hourly_anchor_check check (anchor ~ ${code})`);
    expect(statements).toContain(`constraint client_health_counters_hourly_code_check check (code ~ ${code})`);
    expect(statements).toContain(`constraint client_health_perf_hourly_metric_check check (metric ~ ${code})`);
  });
});
