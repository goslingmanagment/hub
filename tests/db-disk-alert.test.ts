import { beforeEach, describe, expect, it, vi } from "vitest";

const incidentMocks = vi.hoisted(() => ({
  notifyOfapiGlobalIncident: vi.fn(),
  resolveOfapiGlobalIncident: vi.fn(),
}));

vi.mock("../apps/runtime/src/services/notification-incidents.ts", () => incidentMocks);

import {
  evaluateDiskUsage,
  runDbDiskUsageCheck,
} from "../apps/runtime/src/services/db-disk-alert.ts";

const GIB = 1024 ** 3;

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

/** The db stub answers by SQL shape rather than call order, so a test can add
 * capacity history without renumbering every other query. */
function appStub(overrides?: {
  diskUsageAlertPercent?: number;
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
      // The census runs in a transaction; the stub hands the same db back.
      async transaction<T>(this: { execute: unknown }, run: (tx: unknown) => Promise<T>): Promise<T> {
        return run(this);
      },
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as never;
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
    // health upsert + capacity gauges + pg_database_size + its gauge + runway
    // history, then the daily census: day probe, two timeouts, the census
    expect(executeMock(app)).toHaveBeenCalledTimes(9);
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

  it("pages at the alert percent and only records the breach: a full disk refuses nothing", async () => {
    const app = appStub({ diskUsageAlertPercent: 85 });
    const result = await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 4 }),
    });

    expect(result).toMatchObject({ breached: true, healthy: false, thresholdPercent: 85 });
    expect(result).not.toHaveProperty("gatePercent");
    const [healthy, breached] = extractQueryParams(executeMock(app).mock.calls[0]![0] as { queryChunks?: unknown[] });
    expect([healthy, breached]).toEqual([false, true]);
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).toContain("threshold 85%");
    expect(input.errorSummary).not.toContain("OFAPI reads");
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

