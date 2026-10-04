import { describe, expect, it } from "vitest";

import {
  ADMIN_CLIENT_HEALTH_MAX_RANGE_DAYS,
  CLIENT_HEALTH_PERF_METRICS,
  adminClientHealthQuerySchema,
  adminClientHealthResponseSchema,
  clientTokenProfileAllows,
  routeSchemas,
} from "@agency_hub_core/contracts";
import type { ClientHealthPerfTotal } from "@agency_hub_core/db";

import {
  CLIENT_HEALTH_DOM_NODES_BOUNDS,
  CLIENT_HEALTH_FOOTPRINT_BOUNDS,
} from "../apps/runtime/src/services/client-health-intake.ts";
import { CLIENT_HEALTH_MIN_GROUP_SIZE, clientHealthPercentile } from "../apps/runtime/src/services/client-health-perf.ts";
import {
  CLIENT_HEALTH_VIEW_TIME_ZONE,
  buildClientHealthView,
  resolveClientHealthViewRange,
  type ClientHealthViewTotals,
} from "../apps/runtime/src/services/client-health-view.ts";

// The owner's client-health view (chat-extension hub plan H-11c): the pure
// half. The route, the reads and the range against a real database are
// tests/client-health-view.integration.test.ts.

const GROUP = { clientName: "chat-extension", clientVersion: "1.4.2", hostKind: "chatspace", hostBuild: "index-DEVowLko" };
const RANGE = { from: "2026-10-03", to: "2026-10-03", timeZone: CLIENT_HEALTH_VIEW_TIME_ZONE };
const AS_OF = new Date("2026-10-03T12:00:00.000Z");
const NO_TOTALS: ClientHealthViewTotals = { perf: [], contract: [], missing: [], counters: [] };

function bucketsOf(bounds: readonly number[], samples: readonly number[]) {
  const counts = Array.from({ length: bounds.length + 1 }, () => 0);
  for (const sample of samples) {
    const index = bounds.findIndex((bound) => sample <= bound);
    counts[index === -1 ? bounds.length : index]! += 1;
  }
  return counts;
}

/** A merged histogram row as the repository returns one. */
function total(
  metric: string,
  samples: readonly number[],
  overrides: Partial<ClientHealthPerfTotal> = {},
): ClientHealthPerfTotal {
  const registered = (CLIENT_HEALTH_PERF_METRICS as Record<string, { bounds: readonly number[] } | undefined>)[metric];
  const bounds = overrides.bounds ?? [...(registered?.bounds ?? CLIENT_HEALTH_FOOTPRINT_BOUNDS)];
  return {
    ...GROUP,
    metric,
    schemaVersion: 1,
    unit: "ms",
    bounds,
    counts: bucketsOf(bounds, samples),
    count: samples.length,
    sum: samples.reduce((sum, sample) => sum + sample, 0),
    max: samples.length === 0 ? 0 : Math.max(...samples),
    ...overrides,
  };
}

function level(metric: string, values: readonly number[], overrides: Partial<ClientHealthPerfTotal> = {}) {
  const nodes = metric === "footprint.dom-nodes-max";
  return total(metric, values, {
    unit: nodes ? "nodes" : "KB",
    bounds: [...(nodes ? CLIENT_HEALTH_DOM_NODES_BOUNDS : CLIENT_HEALTH_FOOTPRINT_BOUNDS)],
    ...overrides,
    ...(overrides.bounds === undefined ? {} : { counts: bucketsOf(overrides.bounds, values) }),
  });
}

function view(totals: Partial<ClientHealthViewTotals>, metric?: string) {
  return buildClientHealthView({ ...NO_TOTALS, ...totals }, { range: RANGE, asOf: AS_OF, metric });
}

const range = (count: number, from: number, step: number) => Array.from({ length: count }, (_, index) => from + index * step);

describe("the owner's client-health view: contract", () => {
  it("is an owner-session GET with no page scope, a strict query and 200/400/401/403", () => {
    const route = routeSchemas.adminClientHealth as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      params?: unknown;
      querystring?: unknown;
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "owner-session" });
    expect(route.tags).toEqual(["admin"]);
    expect(route.body).toBeUndefined();
    expect(route.params).toBeUndefined();
    expect(route.querystring).toBe(adminClientHealthQuerySchema);
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403"]);
  });

  it("is on no narrow token's list: a dashboard route, never the extension's", () => {
    expect(clientTokenProfileAllows("chat-extension", "adminClientHealth")).toBe(false);
  });

  it("takes two real days in order, and nothing it does not know", () => {
    const ok = { from: "2026-09-27", to: "2026-10-03" };
    expect(adminClientHealthQuerySchema.parse(ok)).toEqual(ok);
    expect(adminClientHealthQuerySchema.parse({ ...ok, to: ok.from }).to).toBe(ok.from);
    expect(adminClientHealthQuerySchema.parse({ ...ok, clientName: "chat-extension", metric: "insertMs" }))
      .toEqual({ ...ok, clientName: "chat-extension", metric: "insertMs" });

    for (const bad of [
      {},
      { from: ok.from },
      { to: ok.to },
      { from: "2026-10-03", to: "2026-09-27" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "03.10.2026", to: "2026-10-03" },
      { ...ok, clientName: "" },
      { ...ok, metric: "m".repeat(65) },
      { ...ok, userId: "7" },
      { ...ok, username: "grisha" },
      { ...ok, pageLabel: "lora-of" },
    ]) {
      expect(adminClientHealthQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("caps the range at a year of days", () => {
    expect(ADMIN_CLIENT_HEALTH_MAX_RANGE_DAYS).toBe(366);
    // 2025-10-03 … 2026-10-03 is 366 days, both ends counted.
    expect(adminClientHealthQuerySchema.safeParse({ from: "2025-10-03", to: "2026-10-03" }).success).toBe(true);
    expect(adminClientHealthQuerySchema.safeParse({ from: "2025-10-02", to: "2026-10-03" }).success).toBe(false);
  });

  it("has no place for a person: no list of who runs what, no user in any row", () => {
    const shape = adminClientHealthResponseSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(["asOf", "contract", "counters", "footprint", "minGroupSize", "perf", "range"]);
    // Every row key, pinned: a group is a client, its version, the host and its build, and nothing nearer a person.
    const rowKeys = (section: "perf" | "contract" | "counters" | "footprint") =>
      Object.keys(shape[section].element.shape).sort();
    expect(rowKeys("perf")).toEqual([
      "clientName", "clientVersion", "count", "hostBuild", "hostKind", "max", "mean", "metric", "p50", "p95",
      "schemaVersion", "suppressed",
    ]);
    expect(rowKeys("contract")).toEqual(["clientVersion", "failedReports", "hostBuild", "missing", "reports"]);
    expect(Object.keys(shape.contract.element.shape.missing.element.shape).sort()).toEqual(["anchor", "reports"]);
    expect(rowKeys("counters")).toEqual(["code", "total"]);
    expect(rowKeys("footprint")).toEqual(["cachesKBp95", "clientVersion", "domNodesP95", "logsKBp95"]);
  });
});

describe("the owner's client-health view: range", () => {
  it("reads whole Moscow days as hub hours", () => {
    expect(CLIENT_HEALTH_VIEW_TIME_ZONE).toBe("Europe/Moscow");
    const oneDay = resolveClientHealthViewRange({ from: "2026-10-03", to: "2026-10-03" });
    expect(oneDay.fromBound.toISOString()).toBe("2026-10-02T21:00:00.000Z");
    expect(oneDay.toExclusiveBound.toISOString()).toBe("2026-10-03T21:00:00.000Z");
    expect(oneDay).toMatchObject({ from: "2026-10-03", to: "2026-10-03", timeZone: "Europe/Moscow" });

    const week = resolveClientHealthViewRange({ from: "2026-09-27", to: "2026-10-03" });
    expect((week.toExclusiveBound.getTime() - week.fromBound.getTime()) / 3_600_000).toBe(7 * 24);
  });
});

describe("the owner's client-health view: perf", () => {
  it("reads the mean, the max and both percentiles of a group off its merged buckets", () => {
    const samples = range(40, 5, 3); // 5, 8, … 122 ms
    const row = total("insertMs", samples);
    const [perf] = view({ perf: [row] }).perf;

    expect(perf).toEqual({
      ...GROUP,
      metric: "insertMs",
      schemaVersion: 1,
      count: 40,
      mean: samples.reduce((sum, sample) => sum + sample, 0) / 40,
      max: 122,
      p50: clientHealthPercentile(row, 0.5),
      p95: clientHealthPercentile(row, 0.95),
      suppressed: false,
    });
    expect(perf!.p50).toBeGreaterThan(50);
    expect(perf!.p50).toBeLessThanOrEqual(75);
    expect(perf!.p95).toBeLessThanOrEqual(122);
  });

  it("shows only the size of a group under the minimum: no mean, no max, no percentile", () => {
    expect(CLIENT_HEALTH_MIN_GROUP_SIZE).toBe(20);
    const result = view({
      perf: [
        total("insertMs", range(19, 10, 1)),
        total("panelOpenMs", range(20, 10, 1)),
        total("boardOpenMs", [640]),
      ],
    });

    expect(result.minGroupSize).toBe(20);
    expect(result.perf.map((row) => [row.metric, row.count, row.suppressed])).toEqual([
      ["insertMs", 19, true],
      ["panelOpenMs", 20, false],
      ["boardOpenMs", 1, true],
    ]);
    for (const row of result.perf.filter((entry) => entry.suppressed)) {
      expect([row.mean, row.max, row.p50, row.p95], row.metric).toEqual([null, null, null, null]);
    }
    // Nothing of the lone 640 ms observation is in the answer.
    expect(JSON.stringify(result)).not.toContain("640");
    const shown = result.perf.find((row) => row.metric === "panelOpenMs")!;
    expect([shown.mean, shown.max]).toEqual([19.5, 29]);
    expect(shown.p50).not.toBeNull();
    expect(shown.p95).not.toBeNull();
  });

  it("spells a build the client could not read as null and keeps the placeholder of one that is not a code", () => {
    const result = view({
      perf: [
        total("insertMs", range(20, 10, 1), { hostBuild: "" }),
        total("insertMs", range(20, 10, 1), { hostBuild: "(other)", clientVersion: "(other)" }),
      ],
    });
    expect(result.perf.map((row) => [row.clientVersion, row.hostBuild])).toEqual([["1.4.2", null], ["(other)", "(other)"]]);
  });

  it("keeps two schema versions of one metric as two rows", () => {
    const result = view({
      perf: [
        total("insertMs", range(20, 10, 1)),
        total("insertMs", range(30, 10, 1), { schemaVersion: 2, bounds: [10, 100] }),
      ],
    });
    expect(result.perf.map((row) => [row.metric, row.schemaVersion, row.count])).toEqual([["insertMs", 1, 20], ["insertMs", 2, 30]]);
  });

  it("narrows perf to one metric and leaves the other sections whole", () => {
    const totals = {
      perf: [
        total("insertMs", range(20, 10, 1)),
        total("panelOpenMs", range(20, 10, 1)),
        level("footprint.cachesKB", range(20, 100, 10)),
      ],
      contract: [{ clientVersion: "1.4.2", hostBuild: "index-DEVowLko", reports: 20, failedReports: 0 }],
      counters: [{ code: "p1.insert-misplaced", total: 0 }],
    };
    const narrowed = view(totals, "insertMs");
    expect(narrowed.perf.map((row) => row.metric)).toEqual(["insertMs"]);
    expect(narrowed.footprint).toEqual(view(totals).footprint);
    expect(narrowed.footprint[0]!.cachesKBp95).not.toBeNull();
    expect(narrowed.contract).toHaveLength(1);
    expect(narrowed.counters).toHaveLength(1);
    expect(view(totals, "noSuchMetric").perf).toEqual([]);
  });
});

describe("the owner's client-health view: footprint", () => {
  it("never lists a level among the perf rows", () => {
    const result = view({
      perf: [
        level("footprint.cachesKB", range(20, 100, 10)),
        level("footprint.logsKB", range(20, 100, 10)),
        level("footprint.dom-nodes-max", range(20, 1000, 100)),
      ],
    });
    expect(result.perf).toEqual([]);
    expect(result.footprint).toHaveLength(1);
  });

  it("reads one row per client version, its host builds merged before the percentile", () => {
    const first = level("footprint.cachesKB", range(12, 100, 10));
    const second = level("footprint.cachesKB", range(12, 5000, 100), { hostBuild: "index-Bq81xZ0a" });
    const older = level("footprint.cachesKB", range(25, 40, 1), { clientVersion: "1.4.1" });
    const result = view({ perf: [first, second, older] });

    const merged = {
      bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS,
      counts: first.counts.map((bucket, index) => bucket + second.counts[index]!),
      max: 6100,
    };
    expect(result.footprint).toEqual([
      {
        clientVersion: "1.4.1",
        cachesKBp95: clientHealthPercentile({ bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS, counts: older.counts, max: 64 }, 0.95),
        logsKBp95: null,
        domNodesP95: null,
      },
      { clientVersion: "1.4.2", cachesKBp95: clientHealthPercentile(merged, 0.95), logsKBp95: null, domNodesP95: null },
    ]);
    // Neither build alone has 20 reports; together they do, and the p95 sits among the larger build's sizes.
    expect(result.footprint[1]!.cachesKBp95).toBeGreaterThan(4096);
  });

  it("shows no percentile under the minimum of reports, level by level", () => {
    const result = view({
      perf: [
        level("footprint.cachesKB", range(20, 100, 10)),
        level("footprint.logsKB", range(19, 100, 10)),
        // Only reports that carried the counter are observations of the node count.
        level("footprint.dom-nodes-max", [5200, 4800, 5100]),
      ],
    });
    expect(result.footprint).toHaveLength(1);
    expect(result.footprint[0]!.cachesKBp95).not.toBeNull();
    expect(result.footprint[0]).toMatchObject({ clientVersion: "1.4.2", logsKBp95: null, domNodesP95: null });
    expect(JSON.stringify(result)).not.toMatch(/5200|4800|5100/);
  });

  it("reads the node count in its own bounds", () => {
    const nodes = level("footprint.dom-nodes-max", range(24, 3000, 100));
    const result = view({ perf: [nodes] });
    expect(result.footprint[0]!.domNodesP95)
      .toBe(clientHealthPercentile({ bounds: CLIENT_HEALTH_DOM_NODES_BOUNDS, counts: nodes.counts, max: nodes.max }, 0.95));
    expect(result.footprint[0]!.domNodesP95).toBeGreaterThan(4096);
  });

  it("leaves out a level stored under a schema version or bounds the view does not read", () => {
    const result = view({
      perf: [
        level("footprint.cachesKB", range(30, 100, 10), { schemaVersion: 2 }),
        level("footprint.logsKB", range(30, 100, 10), { bounds: [100, 1000] }),
      ],
    });
    expect(result.footprint).toEqual([]);
  });
});

describe("the owner's client-health view: contract and counters", () => {
  it("lists each client version and host build with the anchors its reports missed, the most missed first", () => {
    const result = view({
      contract: [
        { clientVersion: "1.4.2", hostBuild: "", reports: 3, failedReports: 3 },
        { clientVersion: "1.4.2", hostBuild: "index-DEVowLko", reports: 412, failedReports: 7 },
        { clientVersion: "constructor", hostBuild: "toString", reports: 1, failedReports: 0 },
      ],
      missing: [
        { clientVersion: "1.4.2", hostBuild: "", anchor: "composer.editor", reports: 3 },
        { clientVersion: "1.4.2", hostBuild: "index-DEVowLko", anchor: "composer.editor", reports: 2 },
        { clientVersion: "1.4.2", hostBuild: "index-DEVowLko", anchor: "chat.list", reports: 7 },
        { clientVersion: "1.4.2", hostBuild: "index-DEVowLko", anchor: "chat.header", reports: 2 },
      ],
    });
    expect(result.contract).toEqual([
      { clientVersion: "1.4.2", hostBuild: null, reports: 3, failedReports: 3, missing: [{ anchor: "composer.editor", reports: 3 }] },
      {
        clientVersion: "1.4.2",
        hostBuild: "index-DEVowLko",
        reports: 412,
        failedReports: 7,
        missing: [
          { anchor: "chat.list", reports: 7 },
          { anchor: "chat.header", reports: 2 },
          { anchor: "composer.editor", reports: 2 },
        ],
      },
      { clientVersion: "constructor", hostBuild: "toString", reports: 1, failedReports: 0, missing: [] },
    ]);
  });

  it("passes the counter totals through, zeroes included", () => {
    const counters = [{ code: "footprint.other", total: 0 }, { code: "p1.insert-misplaced", total: 2 }];
    expect(view({ counters }).counters).toEqual(counters);
  });

  it("answers an empty range with empty sections that still parse", () => {
    const result = view({});
    expect(result).toEqual({
      range: RANGE,
      minGroupSize: 20,
      perf: [],
      contract: [],
      counters: [],
      footprint: [],
      asOf: "2026-10-03T12:00:00.000Z",
    });
    expect(adminClientHealthResponseSchema.parse(result)).toEqual(result);
  });
});
