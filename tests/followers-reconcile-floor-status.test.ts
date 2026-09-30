import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

// Every status reader over one page whose followers_reconcile request waits
// out the daily full-walk floor. The floor is policy, not a fault: each reader
// must report that page exactly as it reports the same page with nothing
// outstanding, and none may count the held request as queued, late or retrying.

const dbMocks = vi.hoisted(() => ({
  ensurePageSyncStates: vi.fn(),
  getConfigOverrides: vi.fn(),
  getOfapiFinancialTruthSummaries: vi.fn(),
  getLatestSyncRunPerPage: vi.fn(),
  listVisiblePages: vi.fn(),
  listPageSyncStates: vi.fn(),
  listCheckpointStates: vi.fn(),
  listSyncMonitorStreamRows: vi.fn(),
  listSyncMonitorRecentEvents: vi.fn(),
  countUnresolvedProjectionDebtByAccount: vi.fn(),
  countConversationSyncFailuresByAccount: vi.fn(),
  countDistinctFansForPages: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async () => {
  const actual = await vi.importActual<typeof DbModule>("@agency_hub_core/db");
  return { ...actual, ...dbMocks };
});

import { getPublicSyncHealth } from "../apps/runtime/src/services/health.ts";
import { getPageSyncBlocks, getSyncBlocksOverview } from "../apps/runtime/src/services/sync-blocks.ts";
import { getPageStreamSyncUxByStream, getSyncMonitorSnapshot } from "../apps/runtime/src/services/sync-monitor.ts";
import { renderSyncMonitor } from "../apps/runtime/src/services/sync-monitor-view.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import { getSyncStatusSummarySnapshot } from "../apps/runtime/src/services/sync-summary.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const WALK_STARTED_AT = at(-5 * HOUR_MS);
const FLOOR_UNTIL = at(19 * HOUR_MS);
const FLOOR = "followers_reconcile_min_interval";
const FLOOR_MARKER = {
  followersReconcileFloorUntil: FLOOR_UNTIL.toISOString(),
  followersReconcileFloorAnchor: WALK_STARTED_AT.toISOString(),
};
const COMPLETED_WALK = {
  revision: 7, generation: 40, fullSweepStartedAt: WALK_STARTED_AT.toISOString(), offset: 0,
  observedCount: 120, pageCount: 2, sourceFollowerCount: 120, snapshotRestartCount: 0,
  verificationPending: false,
};
const STREAMS = [
  "light", "transactions", "top_spenders", "subscribers", "followers", "followers_reconcile",
  "dm_conversations", "dm_messages",
] as const;
const WORK_CLASS: Record<string, string> = {
  top_spenders: "maintenance", followers_reconcile: "maintenance", dm_messages: "history",
};
const app = {
  db: {},
  config: { healthSyncLightMaxAgeMinutes: 180, healthSyncFollowerMaxAgeMinutes: 1080 },
} as never;

function page() {
  return {
    id: 7, label: "lora-1", platform: "fansly", username: "lora", displayName: "Lora",
    followerCount: 120, subscriberCount: 40, lastLightSyncAt: at(-10 * MINUTE_MS),
    lastFollowerSyncAt: at(-10 * MINUTE_MS), ofapiAccountId: null, ofapiAuthStatus: null,
    ofapiAuthChangedAt: null, modelSlug: "lora", modelName: "Lora", hasCredentials: true,
    proxyUrl: "http://proxy.example.test:8080", egressKey: "http://proxy.example.test:8080", proxyHasAuth: true,
  };
}

function task(stream: string, overrides: Record<string, unknown> = {}) {
  const done = at(-10 * MINUTE_MS);
  return {
    pageId: 7, stream, status: "idle", requestSeq: 7, leasedSeq: null, appliedSeq: 7,
    requestSource: "scheduled", dispatchSource: "scheduled", requestPayload: {},
    cadenceSeconds: 3600, slotOffsetSeconds: 0, lastScheduledSlot: Math.floor(NOW.getTime() / 3_600_000),
    requestedAt: done, enqueuedAt: done, startedAt: done, progressedAt: done, finishedAt: done,
    succeededAt: done, failedAt: null, retryKind: null, retryAt: null, blockerKind: null,
    blockerCode: null, blockerMessage: null, blockedAt: null, phase: null,
    workClass: WORK_CLASS[stream] ?? "live", progress: {}, leaseOwner: null, leaseToken: null,
    leaseHeartbeatAt: null, leaseExpiresAt: null, consecutiveFailures: 0, lastErrorCode: null,
    lastErrorSummary: null, createdAt: done, updatedAt: done,
    ...overrides,
  };
}

function monitorRow(stream: string, overrides: Record<string, unknown> = {}) {
  const done = at(-10 * MINUTE_MS);
  return {
    pageId: 7, pageLabel: "lora-1", platform: "fansly", modelSlug: "lora", modelName: "Lora",
    username: "lora", displayName: "Lora", fanCount: 300, followerCount: 120, subscriberCount: 40,
    transactionCount: 900, dmConversationCount: 50, dmMessageCount: 4000, dmEligibleConversationCount: 50,
    dmBackfillCompleteConversationCount: 50, dmLaggingConversationCount: 0,
    dmDeepBackfillPendingConversationCount: 0, dmDeepBackfillPendingPageEstimate: 0,
    dmDeepBackfillSpenderPendingConversationCount: 0, dmDeepBackfillSpenderPendingPageEstimate: 0,
    dmDeepBackfillRegularPendingConversationCount: 0, dmDeepBackfillRegularPendingPageEstimate: 0,
    dmDeepBackfillRecentRequestCount: 0, dmDeepBackfillLastCompletedAt: null,
    stream, status: "idle", blockerKind: null, cadenceSeconds: 3600, nextDueAt: at(HOUR_MS),
    requestSeq: 7, appliedSeq: 7, requestedAt: done, retryAt: null, lastEnqueuedAt: done,
    lastStartedAt: done, lastFinishedAt: done, succeededAt: done, failedAt: null, consecutiveFailures: 0,
    lastErrorCode: null, lastErrorSummary: null, checkpointCursorText: null, checkpointCursorTimestamp: null,
    checkpointState: null, cursorLastSucceededAt: null, cursorLastSucceededRunId: null,
    runningRunId: null, runningTrigger: null, runningStartedAt: null, runningLastActivityAt: null,
    runningStats: null, runningErrorSummary: null, lastCompletedRunId: 1, lastCompletedTrigger: "scheduled",
    lastCompletedStatus: "success", lastCompletedStartedAt: done, lastCompletedFinishedAt: done,
    lastCompletedDurationMs: 1000, lastCompletedStats: {}, lastCompletedErrorSummary: null,
    recentRunningCount: 0, recentSuccessCount: 1, recentPartialCount: 0, recentFailedCount: 0,
    recentSkippedCount: 0, recent429Count: 0, recent5xxCount: 0, recentFailedAttemptCount: 0,
    recentRetryCount: 0, recentPhysicalAttemptCount: 0, recentPhysicalSuccessCount: 0,
    stalePhysicalAttemptCount: 0, physicalAttemptsSinceLastSuccess: 0, lastPhysicalSuccessAt: null,
    last429At: null, last5xxAt: null, providerNextAvailableAt: null, providerMinSpacingMs: null,
    ...overrides,
  };
}

function boundedDmCheckpoint() {
  const full = at(-20 * MINUTE_MS).toISOString();
  return {
    version: 2, mode: "bounded", generation: 7, completedAt: at(-10 * MINUTE_MS).toISOString(),
    offset: 300, observedCount: 300, pageCount: 3, unchangedPageStreak: 3, providerTotalMode: "present",
    providerReportedTotal: 500, fullSweepStartedAt: at(-25 * MINUTE_MS).toISOString(),
    lastFullSweepCompletedAt: full,
    polling: { anchorSlot: 100, slotOffsetSeconds: 0, lastCertifiedFull: {
      anchorSlot: 100, startedAt: at(-25 * MINUTE_MS).toISOString(), completedAt: full,
    } },
    previousTimestampMs: null, stopInvalidated: false,
  };
}

type Reconcile = { task: Record<string, unknown>; monitor: Record<string, unknown> };

// The page right after the walk that started five hours ago completed.
const settled: Reconcile = {
  task: { succeededAt: at(-4.8 * HOUR_MS), progress: { generation: 40 } },
  monitor: { checkpointState: COMPLETED_WALK, succeededAt: at(-4.8 * HOUR_MS) },
};

// An hourly count mismatch asked for the next walk four hours ago; its one
// zero-request chunk held it until a day after the last walk began.
const held: Reconcile = {
  task: {
    status: "pending", requestSeq: 8, requestSource: "anomaly", requestedAt: at(-4 * HOUR_MS),
    startedAt: at(-4 * HOUR_MS), finishedAt: at(-4 * HOUR_MS), progressedAt: at(-4.8 * HOUR_MS),
    succeededAt: at(-4.8 * HOUR_MS), retryAt: FLOOR_UNTIL, progress: FLOOR_MARKER,
  },
  monitor: {
    status: "pending", requestSeq: 8, requestedAt: at(-4 * HOUR_MS), retryAt: FLOOR_UNTIL,
    succeededAt: at(-4.8 * HOUR_MS), checkpointState: COMPLETED_WALK,
    lastCompletedStatus: "partial", lastCompletedFinishedAt: at(-4 * HOUR_MS),
    lastCompletedStats: { yieldReason: null, chunkBudget: { requestCount: 0, elapsedMs: 12 }, ...FLOOR_MARKER, deferral: FLOOR },
  },
};

function mockPage(reconcile: Reconcile) {
  dbMocks.listPageSyncStates.mockResolvedValue(STREAMS.map((stream) =>
    task(stream, stream === "followers_reconcile" ? reconcile.task : {})));
  dbMocks.listSyncMonitorStreamRows.mockResolvedValue(STREAMS.map((stream) =>
    monitorRow(stream, stream === "followers_reconcile" ? reconcile.monitor : {})));
}

async function readAll(reconcile: Reconcile) {
  mockPage(reconcile);
  const status = await getSyncStatusSnapshot(app, { pageIds: [7], now: NOW });
  const blocks = await getPageSyncBlocks(app, { pageLabel: "lora-1", now: NOW });
  const overview = await getSyncBlocksOverview(app, { pageIds: [7], now: NOW });
  const health = await getPublicSyncHealth(app, { now: NOW, pageIds: [7] });
  const summary = await getSyncStatusSummarySnapshot(app, { pageIds: [7], now: NOW });
  const monitor = await getSyncMonitorSnapshot(app, { pageIds: [7], now: NOW });
  const streamUx = await getPageStreamSyncUxByStream(app, { pageId: 7, streams: ["followers_reconcile"], now: NOW });
  return { status, blocks, overview, health, summary, monitor, streamUx };
}

describe("a followers_reconcile request held by the daily floor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    dbMocks.ensurePageSyncStates.mockImplementation(() => {
      throw new Error("status reads must not seed page_sync_states");
    });
    dbMocks.getConfigOverrides.mockResolvedValue(new Map());
    dbMocks.getOfapiFinancialTruthSummaries.mockResolvedValue(new Map());
    dbMocks.getLatestSyncRunPerPage.mockResolvedValue([]);
    dbMocks.listVisiblePages.mockResolvedValue([page()]);
    dbMocks.listCheckpointStates.mockImplementation(async (_db: unknown, _ids: unknown, stream: string) =>
      stream === "dm_conversations" ? [{ pageId: 7, state: boundedDmCheckpoint() }] : []);
    dbMocks.listSyncMonitorRecentEvents.mockResolvedValue([]);
    dbMocks.countUnresolvedProjectionDebtByAccount.mockResolvedValue([]);
    dbMocks.countConversationSyncFailuresByAccount.mockResolvedValue([]);
    dbMocks.countDistinctFansForPages.mockResolvedValue(300);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reads as scheduled for later in the sync status blocks, with no retry and no queue delay", async () => {
    const baseline = await readAll(settled);
    const views = await readAll(held);
    const audience = views.status.pages[0]!.blocks.audience;

    expect(baseline.status.pages[0]!.blocks.audience.state).toBe("up_to_date");
    expect(audience).toMatchObject({ state: "up_to_date", needsAttention: false, nextRetryAt: null });
    expect(audience.substreams.find((row) => row.stream === "followers_reconcile")).toMatchObject({
      state: "scheduled", needsAttention: false, nextRetryAt: null, nextDueAt: FLOOR_UNTIL.toISOString(),
      statusReason: { code: FLOOR }, error: null,
    });
    expect(views.status.pages[0]!.syncUx).toEqual(baseline.status.pages[0]!.syncUx);
    expect(views.status.pages[0]!.syncUx.state).toBe("healthy");
  });

  it("raises no sync diagnosis on the page blocks the dashboard reads", async () => {
    const baseline = await readAll(settled);
    const views = await readAll(held);

    expect(views.blocks.page.diagnosis).toBeNull();
    expect(views.overview.diagnosis).toBeNull();
    expect(views.blocks.page.blocks.audience.state).toBe(baseline.blocks.page.blocks.audience.state);
    expect(views.blocks.page.blocks.audience.nextRetryAt).toBeNull();
  });

  it("keeps /health/sync exactly as it reads with nothing outstanding", async () => {
    const baseline = await readAll(settled);
    const views = await readAll(held);

    expect(views.health.statusCode).toBe(baseline.health.statusCode);
    expect(views.health.body.overall).toEqual(baseline.health.body.overall);
    expect(views.health.body.pages).toEqual(baseline.health.body.pages);
    expect(views.health.body.overall.pendingStreams).toBe(0);
  });

  it("keeps the overview and connection summary healthy", async () => {
    const baseline = await readAll(settled);
    const views = await readAll(held);

    expect(baseline.summary.pages[0]!.syncUx.state).toBe("healthy");
    expect(views.summary.pages[0]!.syncUx).toEqual(baseline.summary.pages[0]!.syncUx);
  });

  it("is neither pending nor catching up in the sync monitor and its CLI table", async () => {
    const baseline = await readAll(settled);
    const views = await readAll(held);
    const page = views.monitor.pages[0]!;
    const stream = page.streams.find((row) => row.stream === "followers_reconcile")!;

    expect(stream).toMatchObject({ pending: false, stalled: false, retryAt: null });
    expect(stream.syncUx).toMatchObject({ state: "healthy", requiresAction: false, nextRetryAt: null });
    expect(views.streamUx.get("followers_reconcile")).toEqual(stream.syncUx);
    expect(page.summary).toEqual(baseline.monitor.pages[0]!.summary);
    // The held row has no walk of its own to report progress on, so the page
    // label falls to another stream's; the verdict is the same.
    expect({ ...page.syncUx, progressLabel: null })
      .toEqual({ ...baseline.monitor.pages[0]!.syncUx, progressLabel: null });
    expect(views.monitor.overall.pendingStreams).toBe(0);

    const rendered = renderSyncMonitor(views.monitor, NOW);
    expect(rendered).toContain("Pending=0 Retrying=0");
    const row = rendered.split("\n").find((line) => line.includes("followers_reconcile"));
    expect(row?.trimEnd().endsWith(" -")).toBe(true);
  });

  it("reads as ordinary queued work again once a manual request clears the hold", async () => {
    const views = await readAll({
      task: { ...held.task, requestSeq: 9, requestSource: "manual", requestedAt: NOW, retryAt: null },
      monitor: { ...held.monitor, requestSeq: 9, requestedAt: NOW, retryAt: null },
    });
    const stream = views.monitor.pages[0]!.streams.find((row) => row.stream === "followers_reconcile")!;

    expect(stream.pending).toBe(true);
    expect(views.status.pages[0]!.blocks.audience.substreams.find((row) => row.stream === "followers_reconcile"))
      .toMatchObject({ state: "scheduled", statusReason: null, nextRetryAt: null });
  });

  it.each([
    // The floor ended a minute ago and the planner has not leased the walk yet.
    ["waiting for its first lease", { retryAt: at(-MINUTE_MS), startedAt: at(-23 * HOUR_MS) }],
    // The walk the floor let through is between two of its chunks.
    ["between two chunks of its walk", {
      retryAt: null, startedAt: at(-MINUTE_MS), progress: { generation: 41, pageCount: 3, offset: 300 },
    }],
  ])("does not count the hours it was held as a queue delay once the walk is due: %s", async (_name, overrides) => {
    const views = await readAll({
      task: { ...held.task, requestedAt: at(-23 * HOUR_MS), ...overrides },
      monitor: { ...held.monitor, requestedAt: at(-23 * HOUR_MS), retryAt: overrides.retryAt },
    });
    const audience = views.status.pages[0]!.blocks.audience;
    const reconcile = audience.substreams.find((row) => row.stream === "followers_reconcile");

    expect(reconcile).toMatchObject({ state: "scheduled", needsAttention: false });
    expect(reconcile?.statusReason?.code).not.toBe("queue_delayed");
    expect(audience.statusReason?.code).not.toBe("queue_delayed");
  });
});
