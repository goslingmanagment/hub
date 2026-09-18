import { beforeEach, describe, expect, it, vi } from "vitest";

const incidentMocks = vi.hoisted(() => ({
  notifyOfapiGlobalIncident: vi.fn(),
  resolveOfapiGlobalIncident: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/notification-incidents.ts", () => incidentMocks);

import {
  computeRunwayDays,
  evaluateDiskUsage,
  runDbDiskUsageCheck,
} from "../apps/runtime/src/services/db-disk-alert.ts";

const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;

/** Drizzle SQL introspection (same shape as tests/page-dm.repository.test.ts):
 * the db stub never renders SQL, so read the template's chunks directly. */
function extractSqlText(query: { queryChunks?: Array<{ value?: string[] }> }): string {
  const chunks = query.queryChunks ?? [];
  return chunks.flatMap((chunk) => {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        return extractSqlText(chunk as { queryChunks?: Array<{ value?: string[] }> });
      }
      if ("value" in chunk && Array.isArray(chunk.value)) {
        return chunk.value;
      }
    }
    return [];
  }).join("");
}

function extractQueryParams(query: { queryChunks?: unknown[] }): unknown[] {
  const chunks = query.queryChunks ?? [];
  const values: unknown[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "object" && chunk !== null) {
      if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
        values.push(...extractQueryParams(chunk as { queryChunks?: unknown[] }));
        continue;
      }
      if ("value" in chunk) {
        continue;
      }
    }
    values.push(chunk);
  }
  return values;
}

function executeMock(app: unknown) {
  return (app as { db: { execute: ReturnType<typeof vi.fn> } }).db.execute;
}

function statsFor(input: { totalGib: number; availableGib: number }) {
  const bsize = 4096;
  return {
    bsize,
    blocks: (input.totalGib * GIB) / bsize,
    bavail: (input.availableGib * GIB) / bsize,
  };
}

interface FreeSample {
  sampledAt: Date;
  freeBytes: number;
}

/** Hourly `disk_free_bytes` gauges on a straight line: `hours + 1` points
 * ending exactly at `endingAt`, so `freeBytesAtEnd` is the reading "now". */
function hourlyFreeSamples(input: {
  endingAt: Date;
  hours: number;
  freeBytesAtEnd: number;
  bytesPerDay: number;
}): FreeSample[] {
  return Array.from({ length: input.hours + 1 }, (_, index) => {
    const hoursBeforeEnd = input.hours - index;
    return {
      sampledAt: new Date(input.endingAt.getTime() - hoursBeforeEnd * HOUR_MS),
      freeBytes: input.freeBytesAtEnd - (input.bytesPerDay * hoursBeforeEnd) / 24,
    };
  });
}

function toRunwaySamples(samples: FreeSample[]) {
  return samples.map((sample) => ({ valueMs: sample.freeBytes, sampledAt: sample.sampledAt }));
}

/** The db stub answers by SQL shape rather than call order, so a test can add
 * capacity history without renumbering every other query. */
function appStub(overrides?: {
  diskUsageAlertPercent?: number;
  diskUsageGatePercent?: number;
  databaseBytes?: number;
  history?: FreeSample[];
}) {
  const historyRows = (overrides?.history ?? []).map((sample) => ({
    metric: "disk_free_bytes",
    quantile: "p50",
    value_ms: String(sample.freeBytes),
    sampled_at: sample.sampledAt,
  }));
  return {
    config: {
      diskUsageAlertPercent: overrides?.diskUsageAlertPercent ?? 80,
      ...(overrides?.diskUsageGatePercent === undefined
        ? {}
        : { diskUsageGatePercent: overrides.diskUsageGatePercent }),
    },
    db: {
      execute: vi.fn(async (query: unknown) => {
        const text = extractSqlText(query as { queryChunks?: Array<{ value?: string[] }> });
        if (text.includes("pg_database_size")) {
          return { rows: [{ bytes: String(overrides?.databaseBytes ?? 2 * GIB) }] };
        }
        if (text.includes("from ops_metric_samples")) {
          return { rows: historyRows };
        }
        return { rows: [] };
      }),
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as never;
}

function latchCalls(mock: { mock: { calls: unknown[][] } }, subKey: string) {
  return mock.mock.calls
    .map((call) => call[1] as { subKey?: string | null; errorSummary?: string })
    .filter((input) => input.subKey === subKey);
}

function subKeyedCallCount(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls
    .filter((call) => (call[1] as { subKey?: string | null }).subKey != null).length;
}

beforeEach(() => {
  incidentMocks.notifyOfapiGlobalIncident.mockReset();
  incidentMocks.resolveOfapiGlobalIncident.mockReset();
});

describe("evaluateDiskUsage", () => {
  it("computes used percent from blocks/bavail and breaches at the threshold inclusively", () => {
    const usage = evaluateDiskUsage(statsFor({ totalGib: 100, availableGib: 10 }), 90);
    expect(usage.usedPercent).toBeCloseTo(90, 5);
    expect(usage.totalBytes).toBe(100 * GIB);
    expect(usage.availableBytes).toBe(10 * GIB);
    expect(usage.breached).toBe(true);

    expect(evaluateDiskUsage(statsFor({ totalGib: 100, availableGib: 10 }), 95).breached).toBe(false);
    expect(evaluateDiskUsage({ bsize: 4096, blocks: 0, bavail: 0 }, 80).breached).toBe(false);
  });
});

describe("runDbDiskUsageCheck", () => {
  it("opens the db_disk_usage incident when usage crosses the threshold", async () => {
    const app = appStub();
    const now = new Date("2026-07-05T12:15:00.000Z");
    const result = await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 10 }),
    });

    expect(result).toMatchObject({ breached: true, thresholdPercent: 80, databaseBytes: 2 * GIB });
    expect(result).toMatchObject({ healthy: false, usedBytes: 90 * GIB, availableBytes: 10 * GIB });
    // health upsert + capacity gauges + pg_database_size + runway history
    expect(executeMock(app)).toHaveBeenCalledTimes(4);
    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input).toMatchObject({ kind: "db_disk_usage", occurredAt: now });
    expect(input.errorSummary).toContain("90.0% used");
    expect(input.errorSummary).toContain("threshold 80%");
    expect(input.errorSummary).toContain("Postgres 2.0 GiB");
  });

  it("resolves the incident when usage is back under the threshold", async () => {
    const app = appStub();
    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 50 }),
    });

    expect(result).toMatchObject({ breached: false });
    expect(incidentMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(incidentMocks.resolveOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    expect(incidentMocks.resolveOfapiGlobalIncident.mock.calls[0]![1]).toMatchObject({
      kind: "db_disk_usage",
    });
  });

  // Decision 372: the page and the OFAPI read gate share one measurement but
  // not one threshold. Unset, the gate equals the alert (the 2026-09-18
  // coupling that cut the desktop's chat reads the moment the owner was paged).
  it("closes the storage-health gate together with the alert when no gate percent is set", async () => {
    const app = appStub();
    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 10 }),
    });

    expect(result).toMatchObject({ breached: true, gateBreached: true, healthy: false, gatePercent: 80 });
    const [healthy, breached] = extractQueryParams(executeMock(app).mock.calls[0]![0] as { queryChunks?: unknown[] });
    expect([healthy, breached]).toEqual([false, true]);
  });

  it("pages at the alert percent but keeps OFAPI reads admitted until the gate percent", async () => {
    const app = appStub({ diskUsageAlertPercent: 85, diskUsageGatePercent: 95 });
    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 10 }),
    });

    expect(result).toMatchObject({
      breached: true,
      gateBreached: false,
      healthy: true,
      thresholdPercent: 85,
      gatePercent: 95,
    });
    // The persisted row is what reserveOfapiRequestAttempt reads: still healthy.
    const [healthy, breached] = extractQueryParams(executeMock(app).mock.calls[0]![0] as { queryChunks?: unknown[] });
    expect([healthy, breached]).toEqual([true, false]);
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).toContain("threshold 85%");
    expect(input.errorSummary).toContain("OFAPI reads still admitted (gate 95%)");
  });

  it("refuses OFAPI reads once the gate percent itself is reached", async () => {
    const app = appStub({ diskUsageAlertPercent: 85, diskUsageGatePercent: 95 });
    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 4 }),
    });

    expect(result).toMatchObject({ breached: true, gateBreached: true, healthy: false });
    const [healthy, breached] = extractQueryParams(executeMock(app).mock.calls[0]![0] as { queryChunks?: unknown[] });
    expect([healthy, breached]).toEqual([false, true]);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).toContain("OFAPI reads refused (gate 95%)");
  });

  it("never lets the gate close below the alert: a lower gate percent is clamped up", async () => {
    const app = appStub({ diskUsageAlertPercent: 90, diskUsageGatePercent: 80 });
    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 15 }),
    });

    // 85% used: under the alert, so under the (clamped) gate as well.
    expect(result).toMatchObject({ breached: false, gateBreached: false, healthy: true, gatePercent: 90 });
    expect(incidentMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
  });

  it("still alerts when pg_database_size is unavailable", async () => {
    const app = appStub();
    executeMock(app)
      .mockResolvedValueOnce({ rows: [] }) // health upsert
      .mockResolvedValueOnce({ rows: [] }) // capacity gauges
      .mockRejectedValueOnce(new Error("db down")); // pg_database_size
    await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 5 }),
    });

    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).not.toContain("Postgres");
  });

  it("records the three capacity gauges as integers stamped with the check time", async () => {
    const app = appStub();
    const now = new Date("2026-07-05T12:15:00.000Z");
    await runDbDiskUsageCheck(app, {
      now,
      // 62.5% used — a percent that is NOT a whole number in basis points
      // terms would round away without the ×100 scaling.
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 37.5 }),
    });

    const gaugeQuery = executeMock(app).mock.calls[1]![0] as { queryChunks?: unknown[] };
    const sqlText = extractSqlText(gaugeQuery as { queryChunks?: Array<{ value?: string[] }> });
    expect(sqlText).toContain("insert into ops_metric_samples");
    expect(sqlText).toContain("(metric, value_ms, quantile, sampled_at)");

    // One row per gauge: (metric, value, quantile, sampled_at).
    expect(extractQueryParams(gaugeQuery)).toEqual([
      "disk_free_bytes", 37.5 * GIB, "p50", now,
      "disk_used_bytes", 62.5 * GIB, "p50", now,
      "disk_used_percent_bp", 6250, "p50", now,
    ]);
    for (const value of [37.5 * GIB, 62.5 * GIB, 6250]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    // Sampling only: no incident is raised or resolved by the gauges.
    expect(incidentMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
  });

  it("keeps the disk alert working when the capacity-gauge insert fails", async () => {
    const app = appStub();
    executeMock(app)
      .mockResolvedValueOnce({ rows: [] }) // health upsert
      .mockRejectedValueOnce(new Error("ops_metric_samples unavailable")); // gauges

    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 5 }),
    });

    expect(result).toMatchObject({ breached: true, healthy: false });
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    expect((app as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn)
      .toHaveBeenCalledTimes(1);
  });

  it("persists and alerts an unhealthy sample when the filesystem cannot be statted", async () => {
    const app = appStub();
    const now = new Date("2026-07-05T12:15:00.000Z");
    const result = await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => {
        throw new Error("statfs failed");
      },
    });

    expect(result).toMatchObject({
      healthy: false,
      breached: false,
      checkedAt: now,
      usedBytes: null,
      availableBytes: null,
      error: "statfs failed",
    });
    // Only the unhealthy health row — no capacity gauges when there is nothing
    // to measure (a fabricated 0 would poison the days-to-full history).
    expect(executeMock(app)).toHaveBeenCalledTimes(1);
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledWith(app, {
      kind: "db_disk_usage",
      errorSummary: "Disk health unavailable: statfs failed",
      occurredAt: now,
    });
    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
  });
});

describe("computeRunwayDays", () => {
  const now = new Date("2026-08-12T12:15:00.000Z");

  it("fits a straight decline exactly", () => {
    const runway = computeRunwayDays(
      toRunwaySamples(hourlyFreeSamples({
        endingAt: now,
        hours: 24,
        freeBytesAtEnd: 48 * GIB,
        bytesPerDay: -2 * GIB,
      })),
      now,
    );

    expect(runway).not.toBeNull();
    // 48 GiB left, shrinking 2 GiB/day => 24 days.
    expect(runway!.days).toBeCloseTo(24, 4);
    expect(runway!.bytesPerDay / GIB).toBeCloseTo(-2, 6);
  });

  it("projects from `now`, not from the newest sample", () => {
    // Series stops 3h short of `now`; the fitted line keeps falling.
    const stale = new Date(now.getTime() - 3 * HOUR_MS);
    const runway = computeRunwayDays(
      toRunwaySamples(hourlyFreeSamples({
        endingAt: stale,
        hours: 24,
        freeBytesAtEnd: 24 * GIB,
        bytesPerDay: -1 * GIB,
      })),
      now,
    );

    expect(runway!.days).toBeCloseTo(24 - 3 / 24, 4);
  });

  it("returns null until the series spans six hours", () => {
    const shortSeries = hourlyFreeSamples({
      endingAt: now,
      hours: 5,
      freeBytesAtEnd: 10 * GIB,
      bytesPerDay: -1 * GIB,
    });
    expect(computeRunwayDays(toRunwaySamples(shortSeries), now)).toBeNull();
    expect(computeRunwayDays([], now)).toBeNull();
    expect(computeRunwayDays(toRunwaySamples(shortSeries.slice(0, 1)), now)).toBeNull();

    // Six hours exactly is enough — the boundary is inclusive.
    const boundary = hourlyFreeSamples({
      endingAt: now,
      hours: 6,
      freeBytesAtEnd: 10 * GIB,
      bytesPerDay: -1 * GIB,
    });
    expect(computeRunwayDays(toRunwaySamples(boundary), now)!.days).toBeCloseTo(10, 4);
  });

  it("returns null when free space is flat or growing", () => {
    for (const bytesPerDay of [0, 1 * GIB, 5 * GIB]) {
      const samples = hourlyFreeSamples({
        endingAt: now,
        hours: 24,
        freeBytesAtEnd: 10 * GIB,
        bytesPerDay,
      });
      expect(computeRunwayDays(toRunwaySamples(samples), now)).toBeNull();
    }
  });
});

describe("runDbDiskUsageCheck runway latches", () => {
  const now = new Date("2026-08-12T12:15:00.000Z");

  it("opens runway_warning under 30 days and leaves runway_critical resolved", async () => {
    const app = appStub({
      history: hourlyFreeSamples({
        endingAt: now,
        hours: 24,
        freeBytesAtEnd: 50 * GIB,
        bytesPerDay: -2.5 * GIB,
      }),
    });
    const result = await runDbDiskUsageCheck(app, {
      now,
      // 50% used: the percent latch is quiet, only the slope pages.
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 50 }),
    });

    expect(result).toMatchObject({ breached: false });
    expect((result as { runwayDays: number }).runwayDays).toBeCloseTo(20, 4);

    const warnings = latchCalls(incidentMocks.notifyOfapiGlobalIncident, "runway_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.errorSummary).toContain("Disk fills in ~20.0 days");
    expect(warnings[0]!.errorSummary).toContain("threshold 30 days");
    expect(warnings[0]!.errorSummary).toContain("24h slope -2.50 GiB/day");
    expect(warnings[0]!.errorSummary).toContain("free 50.0 GiB of 100.0 GiB");
    expect(incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]![1]).toMatchObject({
      kind: "db_disk_usage",
      occurredAt: now,
    });
    // Nothing else paged: no percent breach, and critical is still far off.
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    expect(latchCalls(incidentMocks.resolveOfapiGlobalIncident, "runway_critical"))
      .toHaveLength(1);
    // The percent latch keeps resolving on its own key, untouched by runway.
    expect(subKeyedCallCount(incidentMocks.resolveOfapiGlobalIncident)).toBe(1);
    expect(incidentMocks.resolveOfapiGlobalIncident).toHaveBeenCalledTimes(2);
  });

  it("resolves both runway latches once the slope flattens", async () => {
    const app = appStub({
      history: hourlyFreeSamples({
        endingAt: now,
        hours: 24,
        freeBytesAtEnd: 50 * GIB,
        bytesPerDay: 0,
      }),
    });
    const result = await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 50 }),
    });

    expect((result as { runwayDays: number | null }).runwayDays).toBeNull();
    expect(incidentMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
    // A measured non-shrinking disk clears BOTH latches — symmetry, so an open
    // runway_critical cannot outlive the burn that opened it.
    expect(latchCalls(incidentMocks.resolveOfapiGlobalIncident, "runway_warning"))
      .toHaveLength(1);
    expect(latchCalls(incidentMocks.resolveOfapiGlobalIncident, "runway_critical"))
      .toHaveLength(1);
  });

  it("resolves runway_warning when the runway recovers above 30 days", async () => {
    const app = appStub({
      history: hourlyFreeSamples({
        endingAt: now,
        hours: 24,
        freeBytesAtEnd: 50 * GIB,
        bytesPerDay: -1 * GIB, // 50 days
      }),
    });
    await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 50 }),
    });

    expect(incidentMocks.notifyOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(latchCalls(incidentMocks.resolveOfapiGlobalIncident, "runway_warning"))
      .toHaveLength(1);
  });

  it("opens runway_critical under 7 days (and warning with it: one extra page)", async () => {
    const app = appStub({
      history: hourlyFreeSamples({
        endingAt: now,
        hours: 24,
        freeBytesAtEnd: 5 * GIB,
        bytesPerDay: -2.5 * GIB,
      }),
    });
    await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 5 }),
    });

    const critical = latchCalls(incidentMocks.notifyOfapiGlobalIncident, "runway_critical");
    expect(critical).toHaveLength(1);
    expect(critical[0]!.errorSummary).toContain("Disk fills in ~2.0 days");
    expect(critical[0]!.errorSummary).toContain("threshold 7 days");
    // Escalation pages twice on purpose: warning stays open beside critical.
    expect(latchCalls(incidentMocks.notifyOfapiGlobalIncident, "runway_warning"))
      .toHaveLength(1);
    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();

    // The 95% percent alert carries the runway as context on its own latch.
    const [percentAlert] = incidentMocks.notifyOfapiGlobalIncident.mock.calls
      .map((call) => call[1] as { subKey?: string | null; errorSummary: string })
      .filter((input) => input.subKey == null);
    expect(percentAlert!.errorSummary).toContain("95.0% used");
    expect(percentAlert!.errorSummary).toContain("runway ~2.0 days");
    expect(percentAlert!.errorSummary).toContain("24h slope -2.50 GiB/day");
    expect(percentAlert!.errorSummary).toContain("7d ~2.0 days");
  });

  it("touches no runway latch when history is too short to fit", async () => {
    const app = appStub({
      history: hourlyFreeSamples({
        endingAt: now,
        hours: 2,
        freeBytesAtEnd: 1 * GIB,
        bytesPerDay: -10 * GIB, // would be a screaming critical with real history
      }),
    });
    const result = await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 5 }),
    });

    expect((result as { runwayDays: number | null }).runwayDays).toBeNull();
    // Unknown is not a state: it neither opens nor resolves a runway latch, so
    // a pruned/restarted series cannot silently clear an open critical.
    expect(subKeyedCallCount(incidentMocks.notifyOfapiGlobalIncident)).toBe(0);
    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    // The pre-existing percent alert is unchanged apart from its context text.
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).toContain("95.0% used");
    expect(input.errorSummary).toContain("runway insufficient history");
  });

  it("keeps the disk alert working when the history read fails", async () => {
    const app = appStub();
    executeMock(app).mockImplementation(async (query: unknown) => {
      const text = extractSqlText(query as { queryChunks?: Array<{ value?: string[] }> });
      if (text.includes("from ops_metric_samples")) {
        throw new Error("ops_metric_samples unavailable");
      }
      return { rows: text.includes("pg_database_size") ? [{ bytes: String(2 * GIB) }] : [] };
    });

    const result = await runDbDiskUsageCheck(app, {
      now,
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 5 }),
    });

    expect(result).toMatchObject({ breached: true });
    expect(subKeyedCallCount(incidentMocks.notifyOfapiGlobalIncident)).toBe(0);
    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    expect((app as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn)
      .toHaveBeenCalledTimes(1);
  });
});
