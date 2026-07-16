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

function statsFor(input: { totalGib: number; availableGib: number }) {
  const bsize = 4096;
  return {
    bsize,
    blocks: (input.totalGib * GIB) / bsize,
    bavail: (input.availableGib * GIB) / bsize,
  };
}

function appStub(overrides?: { diskUsageAlertPercent?: number; executeRows?: unknown[] }) {
  return {
    config: { diskUsageAlertPercent: overrides?.diskUsageAlertPercent ?? 80 },
    db: {
      execute: vi.fn().mockResolvedValue({
        rows: overrides?.executeRows ?? [{ bytes: String(2 * GIB) }],
      }),
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
    expect((app as { db: { execute: ReturnType<typeof vi.fn> } }).db.execute).toHaveBeenCalledTimes(2);
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

  it("still alerts when pg_database_size is unavailable", async () => {
    const app = appStub();
    (app as { db: { execute: ReturnType<typeof vi.fn> } }).db.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("db down"));
    await runDbDiskUsageCheck(app, {
      statfsImpl: async () => statsFor({ totalGib: 100, availableGib: 5 }),
    });

    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledTimes(1);
    const [, input] = incidentMocks.notifyOfapiGlobalIncident.mock.calls[0]!;
    expect(input.errorSummary).not.toContain("Postgres");
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
    expect((app as { db: { execute: ReturnType<typeof vi.fn> } }).db.execute).toHaveBeenCalledTimes(1);
    expect(incidentMocks.notifyOfapiGlobalIncident).toHaveBeenCalledWith(app, {
      kind: "db_disk_usage",
      errorSummary: "Disk health unavailable: statfs failed",
      occurredAt: now,
    });
    expect(incidentMocks.resolveOfapiGlobalIncident).not.toHaveBeenCalled();
  });
});
