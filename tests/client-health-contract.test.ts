import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_HEALTH_CODE_PATTERN,
  CLIENT_HEALTH_INGEST_KIND,
  CLIENT_HEALTH_PERF_METRICS,
  CLIENT_HEALTH_VERSION_PATTERN,
  CLIENT_HUB_CAPABILITY_NAMES,
  clientHealthPerfHistogramSchema,
  clientHealthReportV1Schema,
  routeSchemas,
} from "@agency_hub_core/contracts";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { INGEST_KIND_ALLOWLIST } from "../apps/runtime/src/services/ingest-observations.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// client_health v1 (chat-extension hub plan §4.8, H-11a): the chat extension's
// health report. A client→hub shape, so strict, and it admits no free text: the
// hub folds it into rollups without user ids, kept forever (B′, H-11b), keyed on
// the version, the host kind and build, the metric and the codes. Every one of
// those strings is a code or a version, so a sentence or a name with a space
// cannot leak into the rollups through any of them.

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

function validReport(): Record<string, unknown> & {
  client: Record<string, unknown>;
  host: Record<string, unknown>;
  perf: Histogram[];
  counters: Record<string, number>;
} {
  return {
    v: 1,
    window: { from: "2026-10-03T12:00:00.000Z", to: "2026-10-03T12:15:00.000Z" },
    client: { name: "chat-extension", version: "0.1.0", browser: "firefox", browserMajor: 143, os: "macos" },
    host: { kind: "chatspace", build: "index-DEVowLko", contractOk: false, missing: ["composer.sendButton"] },
    disabled: ["insertion", "previewSend"],
    perf: [histogramFor("panelOpenMs", [12, 30, 30, 140, 3100]), histogramFor("handlerMs", [0.05, 0.3, 7])],
    counters: { "CG-HUB-OUTDATED": 1, "p1:insert-prevented": 2 },
    footprint: { kind: "owned-estimate", cachesKB: 512, logsKB: 64 },
  };
}

function refuses(report: unknown) {
  return !clientHealthReportV1Schema.safeParse(report).success;
}

describe("client_health v1 report contract", () => {
  it("accepts a report built on the registry's bounds", () => {
    const parsed = clientHealthReportV1Schema.parse(validReport());
    expect(parsed.perf[0]).toMatchObject({ metric: "panelOpenMs", count: 5, max: 3100 });
    // 3100 ms lies above the last panelOpenMs bound: it lands in the overflow bucket.
    expect(parsed.perf[0]!.counts.at(-1)).toBe(1);
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

      const build = validReport();
      build.host.build = bad;
      expect(refuses(build), `host.build ${JSON.stringify(bad)}`).toBe(true);

      const metric = validReport();
      metric.perf[0]!.metric = bad;
      expect(refuses(metric), `metric ${JSON.stringify(bad)}`).toBe(true);
    }
    for (const ok of ["composer.sendButton", "CG-HUB-OUTDATED", "anchor:router_v2", "x".repeat(80)]) {
      expect(CLIENT_HEALTH_CODE_PATTERN.test(ok), ok).toBe(true);
    }
  });

  it("refuses free text in the version, the host and the metric names: the rollups' keys", () => {
    // B′: H-11b keys its forever-kept rollups on these; each probe once parsed under plan §4.8's open strings.
    for (const [field, value] of [
      ["version", "jane doe"],
      ["version", "hello world fan 12345"],
      ["kind", "Jane Doe chats"],
      ["build", "Fan Jane Doe +1 555 0100 said hi"],
      ["metric", "Jane Doe fan 123"],
    ] as const) {
      const report = validReport();
      if (field === "version") report.client.version = value;
      if (field === "kind") report.host.kind = value;
      if (field === "build") report.host.build = value;
      if (field === "metric") report.perf[0]!.metric = value;
      expect(refuses(report), `${field} ${JSON.stringify(value)}`).toBe(true);
    }
    // Names beyond the open-token length: metric and host kind stay within 64.
    const longKind = validReport();
    longKind.host.kind = "k".repeat(65);
    expect(refuses(longKind)).toBe(true);
    const nullBuild = validReport();
    nullBuild.host.build = null;
    expect(refuses(nullBuild)).toBe(false);
  });

  it("takes a version in Firefox's add-on form with an optional build suffix", () => {
    for (const ok of ["0.1.0", "1", "1.2", "1.2.3.4", "0.1.0-dev", "0.1.0-rc.1+sha.5114f85", "123456789.0.0"]) {
      expect(CLIENT_HEALTH_VERSION_PATTERN.test(ok), ok).toBe(true);
      const report = validReport();
      report.client.version = ok;
      expect(refuses(report), ok).toBe(false);
    }
    for (const bad of ["", "v0.1.0", "1.2.3.4.5", "0.1.0-", "0.1.0 beta", "0.1.0-" + "x".repeat(21), "1234567890.0"]) {
      const report = validReport();
      report.client.version = bad;
      expect(refuses(report), bad).toBe(true);
    }
  });

  it("refuses codes that name an inherited object property", () => {
    // A `__proto__` key would vanish in the parsed record instead of being refused,
    // and a naive merge into a plain object would read `constructor` as a function.
    expect(refuses({ ...validReport(), counters: JSON.parse('{"__proto__": 5}') })).toBe(true);
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__defineGetter__"]) {
      expect(refuses({ ...validReport(), counters: { [name]: 1 } }), `counter ${name}`).toBe(true);
      expect(refuses({ ...validReport(), disabled: [name] }), `disabled ${name}`).toBe(true);
    }
    expect(refuses({ ...validReport(), counters: { "constructor.missing": 1 } })).toBe(false);
  });

  it("refuses a window that is not two real instants in order", () => {
    for (const window of [
      { from: "yesterday", to: "2026-10-03T12:15:00.000Z" },
      { from: "2026-10-03", to: "2026-10-03T12:15:00.000Z" },
      { from: "2026-10-03T12:00:00", to: "2026-10-03T12:15:00.000Z" },
      { from: "2026-10-03T12:15:00.000Z", to: "2026-10-03T12:00:00.000Z" },
    ]) {
      expect(refuses({ ...validReport(), window }), JSON.stringify(window)).toBe(true);
    }
    expect(refuses({ ...validReport(), window: { from: "2026-10-03T15:00:00+03:00", to: "2026-10-03T12:00:00Z" } }))
      .toBe(false);
  });

  it("caps the window at 24 hours", () => {
    const window = (to: string) => ({ ...validReport(), window: { from: "2026-10-03T12:00:00Z", to } });
    expect(refuses(window("2026-10-04T12:00:00Z"))).toBe(false);
    expect(refuses(window("2026-10-04T12:00:00.001Z"))).toBe(true);
    expect(refuses(window("2126-10-03T12:00:00Z"))).toBe(true);
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

  it("refuses a max outside the highest non-empty bucket", () => {
    // In range: the highest non-empty bucket (10, 20] holds max.
    expect(histogramParses(smallHistogram({ counts: [1, 1, 0], count: 2, sum: 20, max: 15 }))).toBe(true);
    // max above the last bound while the overflow bucket is empty.
    expect(histogramParses(smallHistogram({ counts: [1, 0, 0], count: 1, sum: 5, max: 9999 }))).toBe(false);
    // An observation in the overflow bucket, max at or below the last bound.
    expect(histogramParses(smallHistogram({ counts: [0, 0, 1], count: 1, sum: 20, max: 20 }))).toBe(false);
    // count > 0 with max 0 above the first bucket.
    expect(histogramParses(smallHistogram({ counts: [0, 3, 0], count: 3, sum: 0, max: 0 }))).toBe(false);
    // max inside a lower bucket than the highest non-empty one.
    expect(histogramParses(smallHistogram({ counts: [1, 1, 0], count: 2, sum: 10, max: 9 }))).toBe(false);
    // All observations 0 ms: the first bucket, max 0, sum 0.
    expect(histogramParses(smallHistogram({ counts: [4, 0, 0], count: 4, sum: 0, max: 0 }))).toBe(true);
  });

  it("refuses a sum the buckets and max cannot hold", () => {
    // Two observations in (10, 20] and the max, 30, in the overflow: sum lies in (50, 70].
    const fields = { counts: [0, 2, 1], count: 3, max: 30 };
    expect(histogramParses(smallHistogram({ ...fields, sum: 65 }))).toBe(true);
    expect(histogramParses(smallHistogram({ ...fields, sum: 71 }))).toBe(false);
    expect(histogramParses(smallHistogram({ ...fields, sum: 1e300 }))).toBe(false);
    expect(histogramParses(smallHistogram({ ...fields, sum: 51 }))).toBe(true);
    expect(histogramParses(smallHistogram({ ...fields, sum: 49 }))).toBe(false);
    // The sum holds the max itself.
    expect(histogramParses(smallHistogram({ counts: [2, 0, 0], count: 2, sum: 4, max: 6 }))).toBe(false);
    // The registry-built histograms of validReport() carry floating-point sums and pass.
    expect(refuses(validReport())).toBe(false);
  });

  it("caps a bucket at 1 000 000, as a counter", () => {
    expect(histogramParses(smallHistogram({ counts: [1_000_000, 0, 0], count: 1_000_000, sum: 5_000_000, max: 5 })))
      .toBe(true);
    expect(histogramParses(smallHistogram({ counts: [1_000_001, 0, 0], count: 1_000_001, sum: 5_000_005, max: 5 })))
      .toBe(false);
    const huge = 4.5e15;
    expect(histogramParses(smallHistogram({ counts: [huge, huge, 0], count: 2 * huge, sum: 20 * huge, max: 15 })))
      .toBe(false);
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
    report.host.kind = "fansly-web";
    expect(refuses(report)).toBe(false);
  });

  it("holds a registry the client can build on: ms, increasing positive bounds, at most 32", () => {
    expect(Object.keys(CLIENT_HEALTH_PERF_METRICS).sort()).toEqual([
      "boardOpenMs", "composerInputDelayMs", "firstChunkPaintMs", "handlerMs",
      "insertMs", "panelOpenMs", "requestOverheadMs", "routeToDockMs",
    ]);
    for (const [metric, entry] of Object.entries(CLIENT_HEALTH_PERF_METRICS)) {
      expect(CLIENT_HEALTH_CODE_PATTERN.test(metric), metric).toBe(true);
      expect(entry.unit, metric).toBe("ms");
      expect(entry.schemaVersion, metric).toBe(1);
      expect(entry.bounds.length, metric).toBeGreaterThanOrEqual(1);
      expect(entry.bounds.length, metric).toBeLessThanOrEqual(32);
      expect(entry.bounds[0], metric).toBeGreaterThan(0);
      for (let index = 1; index < entry.bounds.length; index += 1) {
        expect(entry.bounds[index]!, `${metric}[${index}]`).toBeGreaterThan(entry.bounds[index - 1]!);
      }
      const empty = histogramFor(metric as keyof typeof CLIENT_HEALTH_PERF_METRICS, []);
      expect(clientHealthPerfHistogramSchema.safeParse(empty).success, metric).toBe(true);
    }
  });

  it("is a shape only: no route, no served capability, never a journaled ingest kind", () => {
    // §5 item 15 / B′: a journaled report would keep the user and the payload
    // forever and carry them into the lake. The intake (H-11b) takes the kind
    // on a branch of its own; the allowlist that journals kinds never holds it.
    expect(CLIENT_HEALTH_INGEST_KIND).toBe("client_health");
    expect(INGEST_KIND_ALLOWLIST.has(CLIENT_HEALTH_INGEST_KIND)).toBe(false);
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("client-health-perf-v1");
    expect(SERVED_CLIENT_CAPABILITIES).not.toContain("client-health-perf-v1");
    expect(Object.keys(routeSchemas).filter((key) => /health/i.test(key) && key.startsWith("client"))).toEqual([]);
  });

  it("re-exports the report schema and the registry from the generated SDK", () => {
    // The client vendors @kernel/sdk only, builds histograms on the registry and
    // checks its R01 copy of the shape against these.
    for (const name of [
      "CLIENT_HEALTH_CODE_PATTERN",
      "CLIENT_HEALTH_INGEST_KIND",
      "CLIENT_HEALTH_PERF_METRICS",
      "CLIENT_HEALTH_VERSION_PATTERN",
      "clientHealthPerfHistogramSchema",
      "clientHealthReportV1Schema",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });
});
