import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_HEALTH_CODE_PATTERN,
  CLIENT_HEALTH_INGEST_KIND,
  CLIENT_HEALTH_PERF_METRICS,
  CLIENT_HUB_CAPABILITY_NAMES,
  clientHealthPerfHistogramSchema,
  clientHealthReportV1Schema,
  routeSchemas,
} from "@agency_hub_core/contracts";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { INGEST_KIND_ALLOWLIST } from "../apps/runtime/src/services/ingest-observations.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// client_health v1 (chat-extension hub plan §4.8, H-11a): the chat extension's
// health report. The client froze it in its contracts v1.0.0
// (`ClientHealthV1Schema`, `PERF_METRICS` in packages/contracts/src/telemetry.ts),
// so the hub's schema accepts every report the client's own schema accepts: a
// refused report would be lost with its P1 counters. The hub's extra checks are
// ones such a report always meets. Codes (anchors, switched-off features,
// counter keys, host kind, metric) admit no free text, as on the client.

/** The client's `PERF_METRICS`, contracts v1.0.0, copied as it stands. */
const CLIENT_PERF_METRICS = {
  routeToDockMs: { schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000] },
  panelOpenMs: { schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500] },
  requestOverheadMs: { schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250, 500] },
  ttfcMs: { schemaVersion: 1, bounds: [250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 20000, 30000, 60000] },
  firstChunkPaintMs: { schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500] },
  insertMs: { schemaVersion: 1, bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000] },
  boardOpenMs: { schemaVersion: 1, bounds: [8, 16, 32, 50, 75, 100, 150, 250, 500, 1000, 2500] },
  searchMs: { schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250, 500] },
  handlerMs: { schemaVersion: 1, bounds: [0.1, 0.5, 1, 2, 4, 8, 16, 50, 100] },
  eventLatencyMs: { schemaVersion: 1, bounds: [8, 16, 24, 32, 50, 75, 100, 150, 250, 500, 1000] },
  composerInputDelayMs: { schemaVersion: 1, bounds: [1, 2, 4, 8, 16, 32, 50, 100, 250] },
};

/**
 * The client's valid `clientHealth` fixture (packages/contracts/test/fixtures/
 * samples.ts, contracts v1.0.0), serialized as the client builds it. The client
 * moves `kind` into the ingest envelope; the rest is the hub's report body.
 */
const CLIENT_FIXTURE = {
  kind: "client_health",
  v: 1,
  window: { from: "2026-10-03T10:00:00Z", to: "2026-10-03T10:15:00Z" },
  client: { name: "chat-extension", version: "0.1.0", browser: "firefox", browserMajor: 157, os: "macos" },
  host: { kind: "chatspace", build: "index-0000test", contractOk: false, missing: ["fansMap"] },
  disabled: ["previewSend"],
  perf: [
    {
      metric: "insertMs", unit: "ms", schemaVersion: 1,
      bounds: [4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000],
      counts: [0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
      count: 3, sum: 142, max: 90,
    },
    {
      metric: "routeToDockMs", unit: "ms", schemaVersion: 1,
      bounds: [1, 2, 4, 8, 16, 32, 50, 75, 100, 150, 250, 500, 1000],
      counts: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      count: 1, sum: 3, max: 3,
    },
  ],
  counters: { "CG-SEND-UNCERTAIN": 1, "p1.insert-misplaced": 0 },
  footprint: { kind: "owned-estimate", cachesKB: 420, logsKB: 900 },
} as const;

type Histogram = {
  metric: string;
  unit: "ms";
  schemaVersion: number;
  bounds: number[];
  counts: number[];
  count: number;
  sum: number;
  max: number;
};

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

/** A histogram over bounds [10, 20] (buckets ≤10, (10,20], >20) with the given fields. */
function smallHistogram(fields: Partial<Histogram>): Histogram {
  return { metric: "insertMs", unit: "ms", schemaVersion: 1, bounds: [10, 20], counts: [0, 0, 0], count: 0, sum: 0, max: 0, ...fields };
}

function histogramParses(histogram: Histogram) {
  return clientHealthPerfHistogramSchema.safeParse(histogram).success;
}

/** The client fixture's report body, as a fresh mutable copy. */
function validReport(): Record<string, unknown> & {
  window: Record<string, unknown>;
  client: Record<string, unknown>;
  host: Record<string, unknown>;
  perf: Histogram[];
  counters: Record<string, number>;
} {
  const { kind: _kind, ...body } = structuredClone(CLIENT_FIXTURE) as unknown as Record<string, unknown>;
  return body as ReturnType<typeof validReport>;
}

function refuses(report: unknown) {
  return !clientHealthReportV1Schema.safeParse(report).success;
}

describe("client_health v1 report contract", () => {
  it("accepts the client's fixture, its kind being the ingest kind", () => {
    const { kind, ...body } = CLIENT_FIXTURE;
    expect(kind).toBe(CLIENT_HEALTH_INGEST_KIND);
    const parsed = clientHealthReportV1Schema.parse(body);
    expect(parsed).toEqual(body);
    // The kind belongs to the envelope; the body never carries it.
    expect(refuses(CLIENT_FIXTURE)).toBe(true);
  });

  it("holds the client's metric registry: the same names, schemaVersions and bounds", () => {
    expect(Object.keys(CLIENT_HEALTH_PERF_METRICS)).toEqual(Object.keys(CLIENT_PERF_METRICS));
    for (const [metric, entry] of Object.entries(CLIENT_HEALTH_PERF_METRICS)) {
      const { unit, ...fixed } = entry;
      expect(unit, metric).toBe("ms");
      expect(fixed, metric).toEqual(CLIENT_PERF_METRICS[metric as keyof typeof CLIENT_PERF_METRICS]);
    }
  });

  it("accepts reports the client's schema accepts beyond its fixture", () => {
    // Each probe parsed under the client's ClientHealthV1Schema (contracts v1.0.0)
    // when this test was written; the hub's first draft refused all but the first.
    const probes: Record<string, (report: ReturnType<typeof validReport>) => void> = {
      "every metric of the registry": (report) => {
        report.perf = Object.keys(CLIENT_HEALTH_PERF_METRICS).map((metric, index) =>
          histogramFor(metric as keyof typeof CLIENT_HEALTH_PERF_METRICS, [index + 0.5, 3 * (index + 1)]));
      },
      "codes that start with a sign or name an inherited property": (report) => {
        report.host.missing = [":anchor", "_x", ".y", "-z"];
        report.host.kind = "fansly-web";
        report.disabled = ["toString", "constructor", "__proto__"];
        report.counters = { _internal: 1, ".x": 0, "-y": 2, constructor: 1, valueOf: 3 };
      },
      "a version and a build in free text": (report) => {
        report.client.version = "0.1.0 beta (dev)";
        report.host.build = "some build name, with spaces";
      },
      "an empty build": (report) => {
        report.host.build = "";
      },
      "a null build and a whole host contract": (report) => {
        Object.assign(report.host, { build: null, contractOk: true, missing: [] });
      },
      "a window that runs backwards": (report) => {
        Object.assign(report.window, { from: "2026-10-03T12:15:00Z", to: "2026-10-03T12:00:00Z" });
      },
      "a window over 24 hours, with offsets and nine fraction digits": (report) => {
        Object.assign(report.window, { from: "2026-10-01T00:00:00+03:00", to: "2026-10-03T12:00:00.123456789-05:30" });
      },
      "a window that matches the pattern but not the calendar": (report) => {
        Object.assign(report.window, { from: "2026-02-30T25:61:61Z", to: "2026-13-01T00:00:00Z" });
      },
      "a bucket over a million": (report) => {
        report.perf = [{ ...histogramFor("insertMs", []), counts: [2_000_000, ...Array<number>(11).fill(0)], count: 2_000_000, sum: 4_000_000, max: 2 }];
      },
      "a max outside the highest non-empty bucket": (report) => {
        report.perf = [{ ...histogramFor("insertMs", [3]), max: 9999 }];
      },
      "a sum the buckets cannot hold": (report) => {
        report.perf = [{ ...histogramFor("insertMs", [3, 5]), sum: 1e9 }];
      },
    };
    for (const [name, probe] of Object.entries(probes)) {
      const report = validReport();
      probe(report);
      const result = clientHealthReportV1Schema.safeParse(report);
      expect(result.success, `${name}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it("drops an own __proto__ counter, as the client's record does, and keeps the rest", () => {
    const parsed = clientHealthReportV1Schema.parse({ ...validReport(), counters: JSON.parse('{"__proto__": 5, "CG-X": 1}') });
    expect(Object.keys(parsed.counters)).toEqual(["CG-X"]);
    expect(Object.hasOwn(parsed.counters, "__proto__")).toBe(false);
  });

  it("refuses free text where a code belongs", () => {
    for (const bad of ["Send button not found", "composer/send", "", "x".repeat(81), "кнопка", "a\nb"]) {
      const missing = validReport();
      missing.host.missing = [bad];
      expect(refuses(missing), `missing ${JSON.stringify(bad)}`).toBe(true);

      const disabled = validReport();
      disabled.disabled = [bad];
      expect(refuses(disabled), `disabled ${JSON.stringify(bad)}`).toBe(true);

      const counters = validReport();
      counters.counters = { [bad]: 1 };
      expect(refuses(counters), `counter ${JSON.stringify(bad)}`).toBe(true);

      const kind = validReport();
      kind.host.kind = bad;
      expect(refuses(kind), `host.kind ${JSON.stringify(bad)}`).toBe(true);

      const metric = validReport();
      metric.perf[0]!.metric = bad;
      expect(refuses(metric), `metric ${JSON.stringify(bad)}`).toBe(true);
    }
    for (const ok of ["composer.sendButton", "CG-HUB-OUTDATED", "anchor:router_v2", "_x", "x".repeat(80)]) {
      expect(CLIENT_HEALTH_CODE_PATTERN.test(ok), ok).toBe(true);
    }
    // Growing names stay within the open-token length.
    const longKind = validReport();
    longKind.host.kind = "k".repeat(65);
    expect(refuses(longKind)).toBe(true);
  });

  it("takes the client's bounded strings for the version and the build", () => {
    const version = (value: string) => refuses({ ...validReport(), client: { ...validReport().client, version: value } });
    expect(version("v".repeat(32))).toBe(false);
    expect(version("")).toBe(true);
    expect(version("v".repeat(33))).toBe(true);
    const build = (value: string | null) => refuses({ ...validReport(), host: { ...validReport().host, build: value } });
    expect(build("b".repeat(80))).toBe(false);
    expect(build(null)).toBe(false);
    expect(build("b".repeat(81))).toBe(true);
  });

  it("refuses a window instant outside the client's ISO pattern", () => {
    for (const instant of [
      "yesterday",
      "2026-10-03",
      "2026-10-03T12:00:00",
      "2026-10-03T12:00:00+0300",
      "2026-10-03 12:00:00Z",
      "2026-10-03T12:00:00.1234567890Z",
    ]) {
      const report = validReport();
      report.window.from = instant;
      expect(refuses(report), instant).toBe(true);
    }
  });

  it("refuses histograms whose counts and bounds disagree in length", () => {
    const longer = validReport();
    longer.perf[0]!.counts.push(0);
    expect(refuses(longer)).toBe(true);

    const shorter = validReport();
    shorter.perf[0]!.counts.pop();
    shorter.perf[0]!.count = shorter.perf[0]!.counts.reduce((total, bucket) => total + bucket, 0);
    expect(refuses(shorter)).toBe(true);
  });

  it("refuses a histogram whose count is not the sum of its counts", () => {
    const report = validReport();
    report.perf[0]!.count += 1;
    expect(refuses(report)).toBe(true);
  });

  it("refuses an empty histogram with a sum or a max", () => {
    expect(histogramParses(smallHistogram({}))).toBe(true);
    expect(histogramParses(smallHistogram({ sum: 5 }))).toBe(false);
    expect(histogramParses(smallHistogram({ max: 7 }))).toBe(false);
  });

  it("refuses a bucket or a count beyond the safe integers, and a negative or fractional one", () => {
    expect(histogramParses(smallHistogram({ counts: [2 ** 53, 0, 0], count: 2 ** 53, sum: 1, max: 1 }))).toBe(false);
    expect(histogramParses(smallHistogram({ counts: [-1, 1, 0], count: 0, sum: 0, max: 0 }))).toBe(false);
    expect(histogramParses(smallHistogram({ counts: [0.5, 0.5, 0], count: 1, sum: 1, max: 1 }))).toBe(false);
  });

  it("refuses a metric twice in one report", () => {
    const report = validReport();
    report.perf = [histogramFor("insertMs", [5]), histogramFor("insertMs", [7])];
    expect(refuses(report)).toBe(true);
    // The same metric under another schemaVersion is still the same metric in one report.
    report.perf = [histogramFor("insertMs", [5]), { ...histogramFor("insertMs", [7]), schemaVersion: 2 }];
    expect(refuses(report)).toBe(true);
  });

  it("refuses bounds that do not strictly increase", () => {
    for (const bounds of [[1, 1, 4], [1, 4, 2]]) {
      const histogram = { ...histogramFor("panelOpenMs", []), bounds, counts: [0, 0, 0, 0] };
      expect(clientHealthPerfHistogramSchema.safeParse(histogram).success, JSON.stringify(bounds)).toBe(false);
    }
  });

  it("caps counters at 200 codes and 1 000 000 per code", () => {
    const counters = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, index) => [`CG-${index}`, 1]));
    expect(refuses({ ...validReport(), counters: counters(200) })).toBe(false);
    expect(refuses({ ...validReport(), counters: counters(201) })).toBe(true);
    expect(refuses({ ...validReport(), counters: { "CG-X": 1_000_000 } })).toBe(false);
    for (const value of [1_000_001, -1, 1.5]) {
      expect(refuses({ ...validReport(), counters: { "CG-X": value } }), String(value)).toBe(true);
    }
  });

  it("caps the lists: 16 histograms, 64 codes", () => {
    const histograms = (n: number) =>
      Array.from({ length: n }, (_, index) => ({ ...histogramFor("insertMs", [5]), metric: `metric${index}Ms` }));
    expect(refuses({ ...validReport(), perf: histograms(16) })).toBe(false);
    expect(refuses({ ...validReport(), perf: histograms(17) })).toBe(true);
    const codes = (n: number) => Array.from({ length: n }, (_, index) => `anchor.${index}`);
    expect(refuses({ ...validReport(), disabled: codes(64) })).toBe(false);
    expect(refuses({ ...validReport(), disabled: codes(65) })).toBe(true);
    const missing = validReport();
    missing.host.missing = codes(65);
    expect(refuses(missing)).toBe(true);
  });

  it("is strict at every level: an unknown key is a malformed report", () => {
    expect(refuses({ ...validReport(), note: "x" })).toBe(true);
    const host = validReport();
    host.host.url = "https://chat.example/";
    expect(refuses(host)).toBe(true);
    const histogram = validReport();
    (histogram.perf[0] as Record<string, unknown>).fanId = "100000001";
    expect(refuses(histogram)).toBe(true);
    expect(refuses({ ...validReport(), v: 2 })).toBe(true);
    expect(refuses({ ...validReport(), footprint: { kind: "heap", cachesKB: 1, logsKB: 1 } })).toBe(true);
  });

  it("keeps growing names open: an unknown metric or host kind still parses", () => {
    const report = validReport();
    report.perf = [{ ...histogramFor("insertMs", [5]), metric: "someFutureMs", schemaVersion: 3 }];
    report.host.kind = "someFutureHost";
    expect(refuses(report)).toBe(false);
  });

  it("holds a registry the client can build on: ms, increasing positive bounds, at most 32", () => {
    for (const [metric, entry] of Object.entries(CLIENT_HEALTH_PERF_METRICS)) {
      expect(CLIENT_HEALTH_CODE_PATTERN.test(metric), metric).toBe(true);
      expect(metric.length, metric).toBeLessThanOrEqual(64);
      expect(entry.bounds.length, metric).toBeGreaterThanOrEqual(1);
      expect(entry.bounds.length, metric).toBeLessThanOrEqual(32);
      expect(entry.bounds[0], metric).toBeGreaterThan(0);
      for (let index = 1; index < entry.bounds.length; index += 1) {
        expect(entry.bounds[index]!, `${metric}[${index}]`).toBeGreaterThan(entry.bounds[index - 1]!);
      }
      const empty = histogramFor(metric as keyof typeof CLIENT_HEALTH_PERF_METRICS, []);
      expect(clientHealthPerfHistogramSchema.safeParse(empty).success, metric).toBe(true);
    }
    expect(Object.keys(CLIENT_HEALTH_PERF_METRICS).length).toBeLessThanOrEqual(16);
  });

  it("has no route of its own, is never a journaled ingest kind, and its capability is no standing one", () => {
    // §5 item 15 / B′: a journaled report would keep the user and the payload
    // forever and carry them into the lake. The intake (H-11b) takes the kind
    // on a branch of its own; the allowlist that journals kinds never holds it.
    expect(CLIENT_HEALTH_INGEST_KIND).toBe("client_health");
    expect(INGEST_KIND_ALLOWLIST.has(CLIENT_HEALTH_INGEST_KIND)).toBe(false);
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("client-health-perf-v1");
    // The capability follows the owner's live switch (clientBootstrapCapabilities),
    // so the standing list never holds it.
    expect(SERVED_CLIENT_CAPABILITIES).not.toContain("client-health-perf-v1");
    expect(Object.keys(routeSchemas).filter((key) => /health/i.test(key) && key.startsWith("client"))).toEqual([]);
  });

  it("re-exports the report schema and the registry from the generated SDK", () => {
    for (const name of [
      "CLIENT_HEALTH_CODE_PATTERN",
      "CLIENT_HEALTH_INGEST_KIND",
      "CLIENT_HEALTH_PERF_METRICS",
      "clientHealthPerfHistogramSchema",
      "clientHealthReportV1Schema",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
    expect("CLIENT_HEALTH_VERSION_PATTERN" in sdk).toBe(false);
  });
});
