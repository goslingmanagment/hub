import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  pages: vi.fn(), incidents: vi.fn(), journal: vi.fn(), live: vi.fn(), chats: vi.fn(), sends: vi.fn(),
  notify: vi.fn(), resolve: vi.fn(), money: vi.fn(), heartbeatStop: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async (original) => ({
  ...await original<typeof import("@agency_hub_core/db")>(),
  listSyncPages: fake.pages,
  listNotificationIncidents: fake.incidents,
  readSyncJournalAlertFacts: fake.journal,
  readSyncLivePathFacts: fake.live,
  readSyncChatAlertFacts: fake.chats,
  readFanslySendAudit: fake.sends,
}));
vi.mock("../apps/runtime/src/services/notification-incidents.ts", async (original) => ({
  ...await original<typeof import("../apps/runtime/src/services/notification-incidents.ts")>(),
  notifySyncEngineIncident: fake.notify,
  resolveSyncEngineIncident: fake.resolve,
}));
vi.mock("../apps/runtime/src/sync/fansly/ws/money-frames.ts", async (original) => ({
  ...await original<typeof import("../apps/runtime/src/sync/fansly/ws/money-frames.ts")>(),
  readMoneyFrames: fake.money,
}));
vi.mock("../apps/runtime/src/services/runtime-heartbeat.ts", async (original) => ({
  ...await original<typeof import("../apps/runtime/src/services/runtime-heartbeat.ts")>(),
  publishCaptureCasSettingsAtStartup: async () => undefined,
  startRuntimeHeartbeat: () => ({ instanceId: "local-audit-no-network", stop: fake.heartbeatStop }),
}));

import type { Database, SyncPageRow } from "@agency_hub_core/db";
import { SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";
import { SyncStallWatchdog } from "../apps/runtime/src/sync/engine/watchdog.ts";
import type { SyncContext } from "../apps/runtime/src/sync/context.ts";
import { startSyncRuntime } from "../apps/runtime/src/sync/main.ts";

const now = new Date("2026-10-09T15:00:00Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const db = {} as Database;
const registry = { spec: () => null };
const journal = { lastStopAttempt: null, quarantined: {}, urgentWaiting: [], polls: [], ledgerIncomplete: null, stalledRequests: [] };
function page(pageId: number): SyncPageRow {
  return {
    pageId, pageLabel: `page-${pageId}`, dbNow: now, mode: "live", modeChangedAt: new Date(0),
    holds: [], pausedAll: false, pausedRequests: false, pausedResources: [], registryOverrides: {},
    owner: { generation: 1n, instance: "local", host: "local", pid: 1, pidStart: null, pidNs: null, bootId: null,
      acquiredAt: new Date(0), heartbeatAt: now, releasedAt: null, releaseGeneration: null,
      stopConfirmedAt: null, stopConfirmedBy: null },
  } as SyncPageRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.pages.mockResolvedValue([page(1), page(2)]);
  fake.incidents.mockResolvedValue([]);
  fake.journal.mockResolvedValue(journal);
  fake.live.mockImplementation(async (_db, { pageId }) => ({
    socket: { up: pageId !== 2, lastAliveAt: pageId === 2 ? new Date(now.getTime() - 6 * 60_000) : now },
    decode: { receipts: 1, debt: 0 }, unconfirmed: { count: 0, oldestVisibleAt: null },
    unconfirmedWithoutThread: { count: 0, oldestVisibleAt: null },
  }));
  fake.chats.mockResolvedValue({ unavailable: 0, refused: { chats: 0, firstOpenedAt: null } });
  fake.sends.mockResolvedValue([]);
  fake.money.mockResolvedValue([]);
  fake.notify.mockResolvedValue(undefined);
  fake.resolve.mockResolvedValue(undefined);
  fake.heartbeatStop.mockResolvedValue(undefined);
});

describe("local audit: evaluator isolation and shutdown signalling", () => {
  it("control: the healthy database exposes page 2's six-minute socket outage", async () => {
    const evaluator = new SyncAlertEvaluator({ db, logger, registry });
    expect((await evaluator.runOnce())?.opened).toContainEqual({ pageId: 2, subKey: "live_degraded", detail: "socket_down" });
    expect(fake.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pageId: 2, detail: "socket_down" }));
  });

  it("one page's repeated fact-read timeout must not silence the other page or the success watchdog", async () => {
    let monotonic = 0;
    const exit = vi.fn();
    const watchdog = new SyncStallWatchdog({ clock: { monoNow: () => monotonic }, exit, writeStderr: vi.fn() });
    const evaluator = new SyncAlertEvaluator({ db, logger, registry, watchdog });
    fake.journal.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      return journal;
    });
    for (let pass = 0; pass < 12; pass++) {
      expect(await evaluator.runOnce()).toBeNull();
      monotonic += 30_000;
      expect(watchdog.tracked).toBe(0);
      expect(watchdog.check()).toBeNull();
    }
    expect(logger.warn).toHaveBeenCalledTimes(12);
    expect(exit).not.toHaveBeenCalled();
    expect(fake.journal.mock.calls.map((args) => args[1].pageId)).toEqual(Array(12).fill(1));
    // This expected contract fails: all 12 passes skip page 2 entirely. The
    // process and stall watchdog can stay healthy while its outage is hidden.
    expect(fake.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pageId: 2, detail: "socket_down" }));
  });

  it("shutdown must signal the host while an alert read is still draining", async () => {
    let release!: () => void;
    fake.journal.mockImplementationOnce(() => new Promise<typeof journal>((resolve) => { release = () => resolve(journal); }));
    const evaluator = new SyncAlertEvaluator({ db, logger, registry });
    const host = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const runtime = await startSyncRuntime({ db, logger } as unknown as SyncContext, {
      host, alerts: { async start() { void evaluator.runOnce(); }, stop: () => evaluator.stop() },
      publicLookup: null, watchdog: null,
    });
    // Reach the pending journal query without timers or external resources.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = runtime.stop();
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(host.stop).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await stopping;
    }
  });
});
