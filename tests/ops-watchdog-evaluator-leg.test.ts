import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as IncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";

const fake = vi.hoisted(() => ({
  heartbeat: vi.fn(), latestSample: vi.fn(), inEngine: vi.fn(), unevaluated: vi.fn(),
  notifySync: vi.fn(), resolveSync: vi.fn(), notifyGlobal: vi.fn(), resolveGlobal: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async (original) => ({
  ...await original<typeof DbModule>(),
  hasFreshInstanceHeartbeat: fake.heartbeat,
  getLatestOpsMetricSampleAt: fake.latestSample,
  hasSyncPageInEngine: fake.inEngine,
  readUnevaluatedSyncAlertRules: fake.unevaluated,
}));
vi.mock("../apps/runtime/src/services/notification-incidents.ts", async (original) => ({
  ...await original<typeof IncidentsModule>(),
  notifySyncEngineIncident: fake.notifySync,
  resolveSyncEngineIncident: fake.resolveSync,
  notifyOfapiGlobalIncident: fake.notifyGlobal,
  resolveOfapiGlobalIncident: fake.resolveGlobal,
}));

import type { SyncUnevaluatedAlertRule } from "@agency_hub_core/db";
import { runOpsWatchdogCheck, unevaluatedSummary } from "../apps/runtime/src/services/ops-watchdog.ts";

// Bug hunt Д11: the api watchdog's evaluator leg, its own failure, and its
// summary. The latch against a real database is in
// tests/sync-alerts.integration.test.ts.

const now = new Date("2026-10-10T10:30:00Z");
const pastGrace = now.getTime() - 10 * 60_000;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const app = { db: {}, config: {}, logger } as never;

function pair(overrides: Partial<SyncUnevaluatedAlertRule>): SyncUnevaluatedAlertRule {
  return {
    pageId: 1, pageLabel: "lora-1", rule: "freshness", evaluatedAt: new Date("2026-10-10T10:00:00Z"),
    attemptedAt: now, failure: null, failedSince: null, recorded: true, ...overrides,
  };
}

const evaluatorCalls = (mock: typeof fake.notifySync) =>
  mock.mock.calls.filter(([, input]) => input.subKey === "evaluator");

beforeEach(() => {
  vi.clearAllMocks();
  fake.heartbeat.mockResolvedValue(true);
  fake.latestSample.mockResolvedValue(now);
  fake.inEngine.mockResolvedValue(true);
  fake.unevaluated.mockResolvedValue([]);
  fake.notifySync.mockResolvedValue(true);
  fake.resolveSync.mockResolvedValue({ status: "unchanged" });
  fake.notifyGlobal.mockResolvedValue(true);
  fake.resolveGlobal.mockResolvedValue(undefined);
});

describe("the api watchdog's evaluator leg (bug hunt Д11)", () => {
  it("the watchdog leg's own failure leaves the check intact", async () => {
    fake.unevaluated.mockRejectedValue(new Error("relation \"sync_alert_evaluations\" does not exist"));
    await expect(runOpsWatchdogCheck(app, { startedAtMs: pastGrace, now })).resolves.toEqual({
      bootGrace: false, schedulerFresh: true, samplerFresh: true, syncEngineSilent: false,
    });
    expect(evaluatorCalls(fake.notifySync)).toEqual([]);
    expect(evaluatorCalls(fake.resolveSync)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![1]).toMatch(/sync alert evaluation check failed/);
  });

  it("judges only while sync beats, opens only past the boot grace, resolves when every pair is fresh", async () => {
    fake.unevaluated.mockResolvedValue([pair({ recorded: false, evaluatedAt: null, attemptedAt: null })]);
    // Silent: alert 5's; the leg reads nothing.
    fake.heartbeat.mockImplementation(async (_db, { role }) => role !== "sync");
    expect(await runOpsWatchdogCheck(app, { startedAtMs: pastGrace, now })).toMatchObject({ syncEngineSilent: true });
    expect(fake.unevaluated).not.toHaveBeenCalled();
    fake.heartbeat.mockResolvedValue(true);
    // Inside the grace: nothing opens.
    await runOpsWatchdogCheck(app, { startedAtMs: now.getTime(), now });
    expect(evaluatorCalls(fake.notifySync)).toEqual([]);
    await runOpsWatchdogCheck(app, { startedAtMs: pastGrace, now });
    expect(evaluatorCalls(fake.notifySync)).toEqual([[app, expect.objectContaining({
      pageId: null, detail: "unrecorded", errorSummary: "lora-1: freshness — never recorded", occurredAt: now,
    })]]);
    fake.unevaluated.mockResolvedValue([]);
    await runOpsWatchdogCheck(app, { startedAtMs: now.getTime(), now });
    expect(evaluatorCalls(fake.resolveSync)).toEqual([[app, { subKey: "evaluator", pageId: null, pageLabel: null, recoveredAt: now }]]);
  });

  it("summarizes the heaviest first, one group per state and failure", () => {
    const failing = "money: database query failed (57014)";
    const failedSince = new Date("2026-10-10T10:02:00Z");
    const stale = [
      pair({ pageId: 2, pageLabel: "lora-2", rule: "stuck", evaluatedAt: new Date("2026-10-10T10:20:00Z") }),
      ...[1, 2, 3, 4, 5, 6].map((pageId) => pair({ pageId, pageLabel: `p-${pageId}`, failure: failing, failedSince })),
      pair({ pageId: 7, pageLabel: "lilly-1", rule: "pace_audit", recorded: false, evaluatedAt: null }),
    ];
    expect(unevaluatedSummary(stale)).toBe(
      "6 pages: freshness — money: database query failed (57014) since 10:02Z; "
        + "lilly-1: pace_audit — never recorded; lora-2: stuck — not judged since 10:20Z",
    );
  });
});
