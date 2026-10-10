import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type * as IncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";
import type * as MoneyFramesModule from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";

const fake = vi.hoisted(() => ({
  pages: vi.fn(), incidents: vi.fn(), journal: vi.fn(), live: vi.fn(), chats: vi.fn(), steps: vi.fn(), demand: vi.fn(), sends: vi.fn(),
  notify: vi.fn(), resolve: vi.fn(), money: vi.fn(), record: vi.fn(), passFailed: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async (original) => ({
  ...await original<typeof DbModule>(),
  listSyncPages: fake.pages,
  listNotificationIncidents: fake.incidents,
  readSyncJournalAlertFacts: fake.journal,
  readSyncLivePathFacts: fake.live,
  readSyncChatAlertFacts: fake.chats,
  readSyncStepAlertFacts: fake.steps,
  readSyncPlannedDemandAlertFacts: fake.demand,
  readFanslySendAudit: fake.sends,
  recordSyncAlertEvaluation: fake.record,
  markSyncAlertEvaluationPassFailed: fake.passFailed,
}));
vi.mock("../apps/runtime/src/services/notification-incidents.ts", async (original) => ({
  ...await original<typeof IncidentsModule>(),
  notifySyncEngineIncident: fake.notify,
  resolveSyncEngineIncident: fake.resolve,
}));
vi.mock("../apps/runtime/src/sync/fansly/ws/money-frames.ts", async (original) => ({
  ...await original<typeof MoneyFramesModule>(),
  readMoneyFrames: fake.money,
}));

import type { Database, FanslySendAuditRow, SyncPageRow } from "@agency_hub_core/db";
import { SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";

// Bug hunt Д11: one failing read, rule, open, resolve or record of the alert
// evaluator never silences the rest of its pass, and every handover/live page
// records each rule's outcome (`sync_alert_evaluations`) for the api
// watchdog. The database is mocked: page 2's socket has been down 6 min, so a
// pass that reaches page 2 opens `live_degraded/socket_down`.

const MINUTE = 60_000;
const now = new Date("2026-10-09T15:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const db = {} as Database;
const registry = { spec: () => null, specs: [] };
const journal = {
  lastStopAttempt: null, quarantined: {}, urgentWaiting: [], polls: [], ledgerIncomplete: null,
  transactionsBackfill: { openProgressAt: null, lastCompletedAt: null }, stalledRequests: [],
};
const steps = { failing: [], applyPending: [] };
const HEALTHY = { page_stopped: null, live_degraded: null, freshness: null, stuck: null, route_limited: null, pace_audit: null };
const PAGE_ALERTS = ["page_stopped", "live_degraded", "freshness", "stuck"] as const;

function page(pageId: number): SyncPageRow {
  return {
    pageId, pageLabel: `page-${pageId}`, dbNow: now, mode: "live", modeChangedAt: new Date(0),
    holds: [], pausedAll: false, pausedRequests: false, pausedResources: [], registryOverrides: {},
    owner: { generation: 1n, instance: "local", host: "local", pid: 1, pidStart: null, pidNs: null, bootId: null,
      acquiredAt: new Date(0), heartbeatAt: now, releasedAt: null, releaseGeneration: null,
      stopConfirmedAt: null, stopConfirmedBy: null },
  } as unknown as SyncPageRow;
}

/** A driver error as Drizzle throws it: the SQL and its parameters in the
 *  message, the SQLSTATE on the cause. */
function queryError(code: string, message: string): Error {
  return Object.assign(new Error(`Failed query: select secret_column from sync_work where page_id = $1\nparams: 1`), {
    cause: Object.assign(new Error(message), { code }),
  });
}

/** An open latch of the engine, its condition last seen `msAgo`. */
function openLatch(pageId: number, subKey: string, msAgo: number) {
  return { kind: "fansly_sync_engine", incidentKey: `fansly_sync_engine:${pageId}:${subKey}`, lastSeenAt: ago(msAgo) };
}

/** The outcome of each rule of the page's latest record. */
function lastRecord(pageId: number): Record<string, string | null> {
  const input = fake.record.mock.calls.filter(([, call]) => call.pageId === pageId).at(-1)?.[1] as
    | { outcomes: Array<{ rule: string; failure: string | null }> }
    | undefined;
  return Object.fromEntries((input?.outcomes ?? []).map((outcome) => [outcome.rule, outcome.failure]));
}

function notified(pageId: number, subKey: string) {
  return fake.notify.mock.calls.filter(([, input]) => input.pageId === pageId && input.subKey === subKey).map(([, input]) => input);
}

function resolvedKeys() {
  return fake.resolve.mock.calls.map(([, input]) => `${input.pageId}:${input.subKey}`);
}

/** A send of page 1's engine journal `msAgo` with a 2 s pause. */
function send(ref: number, msAgo: number, gapPrevMs: number | null): FanslySendAuditRow {
  return {
    journal: "engine", source: null, ref, operation: "notifications.page", ownerGeneration: 1n,
    admittedAt: ago(msAgo + 100), sentAt: ago(msAgo), countedAt: ago(msAgo), settingMs: 2_000, pauseMs: 2_000,
    gapPrevMs, routeIntervalMs: null, familyIntervalMs: null, httpStatus: 200, completedAt: ago(msAgo - 50),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.pages.mockResolvedValue([page(1), page(2)]);
  fake.incidents.mockResolvedValue([]);
  fake.journal.mockResolvedValue(journal);
  fake.live.mockImplementation(async (_db, { pageId }) => ({
    socket: { up: pageId !== 2, lastAliveAt: pageId === 2 ? ago(6 * MINUTE) : now },
    decode: { receipts: 1, debt: 0 }, unconfirmed: { count: 0, oldestVisibleAt: null },
    unconfirmedWithoutThread: { count: 0, oldestVisibleAt: null },
  }));
  fake.chats.mockResolvedValue({ unavailable: 0, refused: { chats: 0, firstOpenedAt: null } });
  fake.steps.mockResolvedValue(steps);
  fake.demand.mockResolvedValue({ stale: [] });
  fake.sends.mockResolvedValue([]);
  fake.money.mockResolvedValue([]);
  // An open that landed, a resolve that moved the latch.
  fake.notify.mockResolvedValue(true);
  fake.resolve.mockResolvedValue({ status: "resolved" });
  fake.record.mockResolvedValue(undefined);
  fake.passFailed.mockResolvedValue(undefined);
});

describe("the alert evaluator's failure boundaries (bug hunt Д11)", () => {
  it("control: a healthy pass opens page 2's socket outage and records all six rules of both pages", async () => {
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(result?.opened).toEqual([{ pageId: 2, subKey: "live_degraded", detail: "socket_down" }]);
    expect(result?.unevaluated).toEqual([]);
    expect(lastRecord(1)).toEqual(HEALTHY);
    expect(lastRecord(2)).toEqual(HEALTHY);
    // At the pass's database clock.
    expect(fake.record).toHaveBeenCalledWith(db, expect.objectContaining({ pageId: 1, at: now }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a failed read on one page never silences another page", async () => {
    fake.journal.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw queryError("57014", "canceling statement due to statement timeout");
      return journal;
    });
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(result).not.toBeNull();
    // The first pass already opens page 2's outage.
    expect(notified(2, "live_degraded")).toEqual([expect.objectContaining({ detail: "socket_down" })]);
    expect(result!.opened).toContainEqual({ pageId: 2, subKey: "live_degraded", detail: "socket_down" });
    // Page 1: its routes and its pace backstop are judged; the four alerts
    // that read the journal are recorded failing, by part and SQLSTATE.
    const recorded = lastRecord(1);
    expect(recorded).toMatchObject({ route_limited: null, pace_audit: null });
    for (const subKey of PAGE_ALERTS) expect(recorded[subKey], subKey).toBe("journal: database query failed (57014)");
    expect(result!.unevaluated.map((entry) => `${entry.pageId}:${entry.rule}`)).toEqual(PAGE_ALERTS.map((subKey) => `1:${subKey}`));
    expect(lastRecord(2)).toEqual(HEALTHY);
  });

  it("a failed money read keeps every other reason and resolves nothing it feeds", async () => {
    fake.money.mockRejectedValue(queryError("57014", "canceling statement due to statement timeout"));
    fake.incidents.mockResolvedValue([openLatch(1, "freshness", 20 * MINUTE), openLatch(1, "stuck", 20 * MINUTE)]);
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(result!.opened).toContainEqual({ pageId: 2, subKey: "live_degraded", detail: "socket_down" });
    // No reason holds on page 1: `stuck` (journal alone) resolves, `freshness`
    // (which reads the money) does not.
    expect(resolvedKeys()).toEqual(["1:stuck"]);
    expect(result!.resolved).toEqual([{ pageId: 1, subKey: "stuck" }]);
    for (const pageId of [1, 2]) {
      expect(lastRecord(pageId)).toEqual({ ...HEALTHY, freshness: "money: database query failed (57014)" });
    }
  });

  it("a condition that holds on the readable parts still opens", async () => {
    fake.chats.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw queryError("57014", "canceling statement due to statement timeout");
      return { unavailable: 0, refused: { chats: 0, firstOpenedAt: null } };
    });
    fake.live.mockImplementation(async (_db, { pageId }) => ({
      socket: { up: true, lastAliveAt: now },
      decode: { receipts: 1, debt: 0 },
      unconfirmed: pageId === 1 ? { count: 1, oldestVisibleAt: ago(20 * MINUTE) } : { count: 0, oldestVisibleAt: null },
      unconfirmedWithoutThread: { count: 0, oldestVisibleAt: null },
    }));
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(result!.opened).toEqual([{ pageId: 1, subKey: "freshness", detail: "message_unconfirmed" }]);
    // The summary says which part it could not see.
    expect(notified(1, "freshness")).toEqual([expect.objectContaining({
      detail: "message_unconfirmed",
      errorSummary: expect.stringContaining('"blind":["chats"]'),
    })]);
    expect(lastRecord(1)).toEqual({ ...HEALTHY, freshness: "chats: database query failed (57014)" });
    expect(lastRecord(2)).toEqual(HEALTHY);
  });

  it("a failed steps read blinds alert 4 alone: never resolved, the other rules judged (bug hunt Д3/У2)", async () => {
    fake.steps.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw queryError("57014", "canceling statement due to statement timeout");
      return steps;
    });
    fake.incidents.mockResolvedValue([openLatch(1, "stuck", 20 * MINUTE)]);
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(resolvedKeys()).toEqual([]);
    expect(lastRecord(1)).toEqual({ ...HEALTHY, stuck: "steps: database query failed (57014)" });
    expect(result!.opened).toEqual([{ pageId: 2, subKey: "live_degraded", detail: "socket_down" }]);
    expect(lastRecord(2)).toEqual(HEALTHY);
  });

  it("a failed demand read blinds alert 4 alone: never resolved, the other rules judged (bug hunt Д5)", async () => {
    fake.demand.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw queryError("57014", "canceling statement due to statement timeout");
      return { stale: [] };
    });
    fake.incidents.mockResolvedValue([openLatch(1, "stuck", 20 * MINUTE)]);
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(resolvedKeys()).toEqual([]);
    expect(lastRecord(1)).toEqual({ ...HEALTHY, stuck: "demand: database query failed (57014)" });
    expect(result!.opened).toEqual([{ pageId: 2, subKey: "live_degraded", detail: "socket_down" }]);
    expect(lastRecord(2)).toEqual(HEALTHY);
  });

  it("the summary of an opened stuck names its keys (bug hunt Д3/У2)", async () => {
    fake.steps.mockImplementation(async (_db, { pageId }) => (pageId === 1
      ? { failing: [{ resource: "dm-live.deletions", works: 1, failingSince: ago(6 * MINUTE), errorClasses: ["local:57014"] }], applyPending: [] }
      : steps));
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(result!.opened).toContainEqual({ pageId: 1, subKey: "stuck", detail: "step_failing" });
    expect(notified(1, "stuck")).toEqual([expect.objectContaining({
      detail: "step_failing",
      errorSummary: expect.stringContaining('"resources":["dm-live.deletions"]'),
    })]);
    expect(lastRecord(1)).toEqual(HEALTHY);
  });

  it("a rule whose evaluation throws blinds itself alone", async () => {
    fake.journal.mockImplementation(async (_db, { pageId }) => (pageId === 1
      ? { ...journal, polls: [{ resource: "notifications.forward", lastAppliedAt: now, createdAt: ago(60 * MINUTE) }] }
      : journal));
    fake.incidents.mockResolvedValue([openLatch(1, "stuck", 20 * MINUTE)]);
    const broken = { spec: () => { throw new TypeError("spec is broken"); }, specs: [] };
    const result = await new SyncAlertEvaluator({ db, logger, registry: broken }).runOnce();
    // Its old latch stays open; the other three alerts and page 2 are as in the control.
    expect(resolvedKeys()).toEqual([]);
    expect(lastRecord(1)).toEqual({ ...HEALTHY, stuck: "evaluate: TypeError: spec is broken" });
    expect(result!.opened).toEqual([{ pageId: 2, subKey: "live_degraded", detail: "socket_down" }]);
    expect(lastRecord(2)).toEqual(HEALTHY);
  });

  it("an open that did not land is no evaluation; the pace backstop reads its sends again", async () => {
    fake.notify.mockResolvedValue(false);
    fake.sends.mockImplementation(async (_db, { pageId }) => (pageId === 1 ? [send(1, 120_000, null), send(2, 119_500, 500)] : []));
    const evaluator = new SyncAlertEvaluator({ db, logger, registry });
    const first = await evaluator.runOnce();
    expect(first!.paceViolations).toBe(1);
    expect(first!.opened).toEqual([]);
    expect(lastRecord(2)).toEqual({ ...HEALTHY, live_degraded: "open: the latch was not written" });
    expect(lastRecord(1)).toEqual({ ...HEALTHY, pace_audit: "open: the latch was not written" });
    // The backstop's cursor did not move: the next pass reads from the same instant.
    await evaluator.runOnce();
    const since = fake.sends.mock.calls.filter(([, input]) => input.pageId === 1).map(([, input]) => input.since.getTime());
    expect(since).toHaveLength(2);
    expect(since[1]).toBe(since[0]);
    // Once it lands, the cursor moves on.
    fake.notify.mockResolvedValue(true);
    await evaluator.runOnce();
    await evaluator.runOnce();
    const later = fake.sends.mock.calls.filter(([, input]) => input.pageId === 1).map(([, input]) => input.since.getTime());
    expect(later[3]).toBeGreaterThan(later[2]!);
    expect(lastRecord(1)).toEqual(HEALTHY);
  });

  it("a record that cannot be written does not stop the pass", async () => {
    fake.record.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw queryError("40P01", "deadlock detected");
    });
    const result = await new SyncAlertEvaluator({ db, logger, registry }).runOnce();
    expect(result).not.toBeNull();
    expect(result!.opened).toEqual([{ pageId: 2, subKey: "live_degraded", detail: "socket_down" }]);
    expect(lastRecord(2)).toEqual(HEALTHY);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls[0])).toContain("record: database query failed (40P01)");
  });

  it("a failing rule is logged on change, not every pass", async () => {
    fake.journal.mockImplementation(async (_db, { pageId }) => {
      if (pageId === 1) throw queryError("57014", "canceling statement due to statement timeout");
      return journal;
    });
    const evaluator = new SyncAlertEvaluator({ db, logger, registry });
    for (let pass = 0; pass < 3; pass++) expect(await evaluator.runOnce()).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logger.warn.mock.calls[0]);
    expect(line).toContain("57014");
    expect(line).toContain("stuck");
    expect(line).not.toContain("Failed query");
    expect(line).not.toContain("secret_column");

    fake.journal.mockResolvedValue(journal);
    await evaluator.runOnce();
    await evaluator.runOnce();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const recovered = logger.info.mock.calls.filter(([, message]) => message === "Fansly sync alerts: rules evaluated again");
    expect(recovered).toHaveLength(1);
    expect(JSON.stringify(recovered[0])).toContain("stuck");
  });

  it("a resolve that did not land is no evaluation", async () => {
    fake.incidents.mockResolvedValue([openLatch(1, "stuck", 20 * MINUTE)]);
    fake.resolve.mockResolvedValue({ status: "failed", error: queryError("40P01", "deadlock detected") });
    const evaluator = new SyncAlertEvaluator({ db, logger, registry });
    for (let pass = 0; pass < 3; pass++) {
      const result = await evaluator.runOnce();
      expect(result!.resolved).toEqual([]);
      expect(lastRecord(1)).toEqual({ ...HEALTHY, stuck: "resolve: database query failed (40P01)" });
      expect(lastRecord(2)).toEqual(HEALTHY);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Closed meanwhile (by the owner, say): nothing to do is no failure.
    fake.resolve.mockResolvedValue({ status: "unchanged" });
    const result = await evaluator.runOnce();
    expect(result!.resolved).toEqual([]);
    expect(lastRecord(1)).toEqual(HEALTHY);
  });

  it("a pass that cannot read its frame marks the recorded rules failed, best effort", async () => {
    fake.pages.mockRejectedValue(queryError("57P01", "terminating connection due to administrator command"));
    const evaluator = new SyncAlertEvaluator({ db, logger, registry });
    expect(await evaluator.runOnce()).toBeNull();
    expect(fake.passFailed).toHaveBeenCalledWith(db, { failure: "pass: database query failed (57P01)" });
    fake.passFailed.mockRejectedValue(new Error("the database is gone"));
    expect(await evaluator.runOnce()).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    fake.pages.mockResolvedValue([page(1), page(2)]);
    expect(await evaluator.runOnce()).not.toBeNull();
    expect(logger.info.mock.calls.filter(([, message]) => message === "Fansly sync alerts: rules evaluated again")).toHaveLength(1);
  });
});
