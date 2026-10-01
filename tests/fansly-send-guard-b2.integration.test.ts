import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceFanslySendPaceCursor,
  captureFanslyPageSendGuard,
  completeFanslySendAttempt,
  confirmFanslySendGuardTerminated,
  createFanslyPage,
  createModel,
  ensureFanslyPageSendGuard,
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  getTelegramSettings,
  readFanslySendPaceCursor,
  type FanslySendHolderIdentity,
} from "@agency_hub_core/db";

import * as socketTransport from "../apps/runtime/src/services/egress/fansly-receiver-socket.ts";
import { confirmFanslySendGuardHostsTerminated } from "../apps/runtime/src/services/fansly-send-guard/index.ts";
import { runFanslySendGuardMonitorPass } from "../apps/runtime/src/services/fansly-send-guard/monitor.ts";
import { buildFanslySendGuardReport } from "../apps/runtime/src/services/fansly-send-guard/report.ts";
import { startFanslyWsWorker, type FanslyWsWorkerTiming } from "../apps/runtime/src/services/fansly-ws/worker.ts";
import { incidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { runNotificationPagingSweep } from "../apps/runtime/src/services/notification-paging-sweep.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { withFanslyScriptSendGuard } from "../scripts/fansly-ws/send-guard.ts";
import {
  resetIntegrationDatabase,
  seedFanslyPage,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { READ_ONLY_ROLE_PASSWORD } from "./helpers/db-context.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// The send guard's second step (plan §2.4 «проверка, а не вера», §2.5, §10) on
// a real Postgres: the journal's lease end, the minutely pace check behind its
// durable cursor, the closed-page alert, the acceptance report, the W0
// scripts' writable guard connection, and the WS receiver waiting on a closed
// page instead of looping.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function app() {
  return createTestAppContext(testDb!, { databaseUrl: testDb!.connectionString });
}

async function seedPage(label = `b2-${randomUUID().slice(0, 8)}`) {
  const model = await createModel(testDb!.db, { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(testDb!.db, { modelId: model!.id, label });
  return page!;
}

function holder(overrides: Partial<FanslySendHolderIdentity> = {}): FanslySendHolderIdentity {
  return {
    host: "test-host", pid: 4242, pidStart: "start", pidNs: null, bootId: null,
    instance: randomUUID(), role: "test", ...overrides,
  };
}

async function openGuard(pageId: number) {
  await ensureFanslyPageSendGuard(testDb!.db, pageId);
  await testDb!.pool.query(
    "update fansly_page_send_guards set last_completed_at = now() - interval '1 hour', next_u = 0 where page_id = $1",
    [pageId],
  );
}

/** Thirty minutes ago: settled and final for the pace check. */
const BASE = Date.now() - 30 * 60_000;

interface JournalRow {
  pageId: number | null;
  sentAt: number | null;
  source?: string;
  settingMs?: number | null;
  capturedAt?: number;
  completedAt?: number | null;
  outcome?: string | null;
  httpStatus?: number | null;
  captureRefusals?: number;
  captureWaitMs?: number;
  leaseUntil?: number | null;
  outcomeDetail?: string | null;
}

/** A journal row as the guard writes it, at explicit instants. */
async function journal(row: JournalRow): Promise<number> {
  const sentAt = row.sentAt;
  const capturedAt = row.capturedAt ?? (sentAt ?? BASE) - 5;
  const completedAt = row.completedAt === undefined ? (sentAt ?? capturedAt) + 40 : row.completedAt;
  const outcome = row.outcome === undefined ? (completedAt === null ? null : "response") : row.outcome;
  const result = await testDb!.pool.query<{ id: string }>(`
    insert into fansly_send_log (
      page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
      setting_ms, capture_wait_ms, capture_refusals, captured_at, sent_at, completed_at, outcome,
      outcome_detail, http_status, lease_until
    ) values ($1, $2, $3, 'messages', 'host-a', 7, 'worker', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    returning id::text as id`, [
    row.pageId, randomUUID(), row.source ?? "sync_stream", randomUUID(),
    row.pageId === null ? null : row.settingMs === undefined ? 2_500 : row.settingMs,
    row.captureWaitMs ?? 0, row.captureRefusals ?? 0,
    new Date(capturedAt), sentAt === null ? null : new Date(sentAt),
    completedAt === null ? null : new Date(completedAt), outcome, row.outcomeDetail ?? null,
    row.httpStatus === undefined ? (outcome === "response" ? 200 : null) : row.httpStatus,
    row.leaseUntil === undefined || row.leaseUntil === null ? null : new Date(row.leaseUntil),
  ]);
  return Number(result.rows[0]!.id);
}

async function paceIncident(pageId: number) {
  return getNotificationIncidentByKey(testDb!.db, incidentKey({
    kind: "sync_silent", platformAccountId: pageId, subKey: "pace_violation",
  }));
}

async function closedIncident(pageId: number) {
  return getNotificationIncidentByKey(testDb!.db, incidentKey({
    kind: "sync_silent", platformAccountId: pageId, subKey: "send_guard_closed",
  }));
}

describe("the journal's lease end (0227)", () => {
  it("is written by the capture statement itself, equal to the guard row's", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await openGuard(page.id);
    const token = randomUUID();
    const result = await captureFanslyPageSendGuard(testDb.db, {
      pageId: page.id, token, source: "sync_stream", operation: "messages", holder: holder(),
      settingMs: 300, leaseMs: 75_000, captureWaitMs: 0, captureRefusals: 0,
    });
    expect(result.kind).toBe("captured");
    const rows = await testDb.pool.query(`
      select l.lease_until = g.lease_until as same,
             extract(epoch from (l.lease_until - l.captured_at)) * 1000 as lease_ms
        from fansly_send_log l join fansly_page_send_guards g on g.holder_token = l.guard_token
       where l.guard_token = $1`, [token]);
    expect(rows.rows[0].same).toBe(true);
    expect(Number(rows.rows[0].lease_ms)).toBeCloseTo(75_000, -1);
  });
});

describe("the pace check (any two sends of a page closer than the setting)", () => {
  it("finds every violating pair once, across sources and batches, behind a durable cursor", async (context) => {
    if (!testDb) return context.skip();
    const runtime = app();
    const page = await seedPage("pace-a");
    const other = await seedPage("pace-b");
    for (const p of [page, other]) await openGuard(p.id);

    await journal({ pageId: page.id, sentAt: BASE });
    await journal({ pageId: page.id, sentAt: BASE + 3_000 });
    // Another page in between pairs with nothing on this one.
    await journal({ pageId: other.id, sentAt: BASE + 3_100 });
    // A refused dispatch sent nothing; a check of an unknown session has no page.
    await journal({ pageId: page.id, sentAt: null, outcome: "aborted_before_send", httpStatus: null });
    await journal({ pageId: null, sentAt: BASE + 3_200, source: "onboarding" });
    const third = await journal({ pageId: page.id, sentAt: BASE + 3_300, source: "ws_connect" });

    const first = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(first.pace.violations.map((violation) => [
      violation.pageId, violation.earlier.source, violation.later.source, Math.round(violation.gapMs), violation.settingMs,
    ])).toEqual([[page.id, "sync_stream", "ws_connect", 300, 2_500]]);
    expect(first.pace).toMatchObject({ afterId: 0, throughId: third, examined: 6, advanced: true });
    const opened = await paceIncident(page.id);
    expect(opened).toMatchObject({ status: "open", kind: "sync_silent", errorCode: "pace_violation" });
    expect(opened?.errorSummary).toContain("closest 300 ms apart (setting 2500 ms)");
    await getTelegramSettings(testDb.db);
    expect(await runNotificationPagingSweep(runtime, { now: new Date() })).toMatchObject({ paged: 1 });
    expect((await getNotificationDeliveryOutboxByIncident(testDb.db, opened!.id))[0]!.messageText)
      .toMatch(/^🚨 Fansly pace violated: two requests of a page closer than the pause setting\nPage: pace-a \(fansly\)/);
    expect(await paceIncident(other.id)).toBeNull();
    expect(await readFanslySendPaceCursor(testDb.db)).toMatchObject({ afterId: third });

    // Nothing new: nothing examined, the latch stays.
    const idle = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(idle.pace).toMatchObject({ examined: 0, violations: [], advanced: false });
    expect((await paceIncident(page.id))?.status).toBe("open");

    // A new send close to one examined before: its neighbour is behind the cursor.
    const fourth = await journal({ pageId: page.id, sentAt: BASE + 3_400, source: "media_download" });
    const late = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(late.pace.violations.map((violation) => [violation.earlier.id, violation.later.id])).toEqual([[third, fourth]]);

    // Sent in another order than captured: still one pair, found once.
    const captured5 = await journal({ pageId: page.id, sentAt: BASE + 10_000 });
    const captured6 = await journal({ pageId: page.id, sentAt: BASE + 9_000, capturedAt: BASE + 8_990 });
    const reordered = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(reordered.pace.violations.map((violation) => [violation.earlier.id, violation.later.id, Math.round(violation.gapMs)]))
      .toEqual([[captured6, captured5, 1_000]]);
    expect((await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 })).pace.violations).toEqual([]);

    // A pair exactly at the setting is not a violation.
    await journal({ pageId: other.id, sentAt: BASE + 3_100 + 2_500 });
    expect((await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 })).pace.violations).toEqual([]);
  });

  it("waits for a request still in flight and never skips it", async (context) => {
    if (!testDb) return context.skip();
    const runtime = app();
    const page = await seedPage();
    await openGuard(page.id);
    const examined = await journal({ pageId: page.id, sentAt: BASE });
    await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    // Captured just now, not completed: the cursor stops before it, even with
    // a final row after it.
    const inFlight = await journal({
      pageId: page.id, sentAt: Date.now() - 1_000, capturedAt: Date.now() - 1_100, completedAt: null,
    });
    await journal({ pageId: page.id, sentAt: Date.now() - 900, capturedAt: Date.now() - 60_000 });
    const blocked = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(blocked.pace).toMatchObject({ afterId: examined, throughId: examined, examined: 0 });

    // Final now (and settled): both examined, and they are 100 ms apart.
    await testDb.pool.query(`update fansly_send_log set captured_at = captured_at - interval '1 minute',
      completed_at = now(), outcome = 'response', http_status = 200 where id = $1`, [inFlight]);
    const released = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(released.pace.examined).toBe(2);
    expect(released.pace.violations).toHaveLength(1);
  });

  it("takes a holder that never completed as it is after five minutes", async (context) => {
    if (!testDb) return context.skip();
    const runtime = app();
    const page = await seedPage();
    await openGuard(page.id);
    await journal({ pageId: page.id, sentAt: BASE, completedAt: null });
    const result = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(result.pace.examined).toBe(1);
  });

  it("clears the latch after an hour without a violation, and restarts from a lost cursor row", async (context) => {
    if (!testDb) return context.skip();
    const runtime = app();
    const page = await seedPage();
    await openGuard(page.id);
    await journal({ pageId: page.id, sentAt: BASE });
    await journal({ pageId: page.id, sentAt: BASE + 100 });
    await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect((await paceIncident(page.id))?.status).toBe("open");

    await testDb.pool.query(`update notification_incidents set last_seen_at = now() - interval '61 minutes',
      opened_at = now() - interval '61 minutes' where incident_key = $1`,
    [incidentKey({ kind: "sync_silent", platformAccountId: page.id, subKey: "pace_violation" })]);
    const quiet = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(quiet.paceCleared).toEqual([page.id]);
    expect((await paceIncident(page.id))?.status).toBe("resolved");

    // The cursor is a compare-and-set, and a lost row starts over from 0.
    const cursor = await readFanslySendPaceCursor(testDb.db);
    expect(await advanceFanslySendPaceCursor(testDb.db, { fromId: cursor.afterId + 1, toId: cursor.afterId + 2 }))
      .toBe(false);
    await testDb.pool.query("delete from fansly_send_pace_cursor");
    expect(await readFanslySendPaceCursor(testDb.db)).toEqual({ afterId: 0, checkedAt: null });
  });
});

describe("the closed-page alert", () => {
  it("opens within a pass once a lease expired unconfirmed, says what to run, and clears when the page opens", async (context) => {
    if (!testDb) return context.skip();
    const runtime = app();
    const page = await seedPage("closed-a");
    await openGuard(page.id);
    const token = randomUUID();
    await captureFanslyPageSendGuard(testDb.db, {
      pageId: page.id, token, source: "targeted_backfill", operation: "messages",
      holder: holder({ host: "1b311277ddfc", role: "worker" }),
      settingMs: 300, leaseMs: 1, captureWaitMs: 0, captureRefusals: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Right after the api starts, a closed page opens nothing yet.
    const grace = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: Date.now() });
    expect(grace).toMatchObject({ bootGrace: true, closedPages: [] });
    expect(await closedIncident(page.id)).toBeNull();

    const pass = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(pass.closedPages).toEqual([page.id]);
    const incident = await closedIncident(page.id);
    expect(incident).toMatchObject({ status: "open", platformAccountId: page.id, errorCode: "send_guard_closed" });
    expect(incident?.errorSummary).toContain(`fansly-send-guard confirm-terminated --holder-token ${token}`);
    expect(incident?.errorSummary).toContain("worker@1b311277ddfc pid 4242, targeted_backfill/messages");
    // The paging sweep pages it at once, with the title and what to run.
    await getTelegramSettings(testDb.db);
    expect(await runNotificationPagingSweep(runtime, { now: new Date() })).toMatchObject({ paged: 1 });
    const outbox = await getNotificationDeliveryOutboxByIncident(testDb.db, incident!.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.messageText.split("\n")[0])
      .toBe("🚨 Fansly page closed: a request overran its lease, nothing is sent for the page");
    expect(outbox[0]!.messageText).toContain(`--holder-token ${token}`);

    await completeFanslySendAttempt(testDb.db, {
      pageId: page.id, token, nextU: 0, outcome: "response", outcomeDetail: null, httpStatus: 200,
      sentAt: null, sendOffsetMs: null,
    });
    const reopened = await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 });
    expect(reopened.reopenedPages).toEqual([page.id]);
    expect((await closedIncident(page.id))?.status).toBe("resolved");
    // Nothing more to resolve on the next pass.
    expect((await runFanslySendGuardMonitorPass(runtime, { startedAtMs: 0 })).reopenedPages).toEqual([]);
  });
});

describe("the acceptance report (fansly-send-guard report)", () => {
  it("prints sends, the closest pair and its setting, guard triggers, statuses and closed periods", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("report-a");
    const quiet = await seedPage("report-b");
    for (const p of [page, quiet]) await openGuard(p.id);
    const since = new Date(BASE - 1_000);
    // Before the window: the first pair's predecessor.
    await journal({ pageId: page.id, sentAt: BASE - 2_000 });
    await journal({ pageId: page.id, sentAt: BASE + 1_000, captureRefusals: 2, captureWaitMs: 2_700 });
    await journal({ pageId: page.id, sentAt: BASE + 4_000, source: "ws_connect", httpStatus: 101 });
    await journal({ pageId: page.id, sentAt: BASE + 4_200, source: "media_download", httpStatus: 429 });
    await journal({ pageId: page.id, sentAt: null, outcome: "aborted_before_send", httpStatus: null, outcomeDetail: "lease_used" });
    // Held past its lease, then confirmed gone: a closed period.
    await journal({
      pageId: page.id, sentAt: BASE + 7_000, leaseUntil: BASE + 60_000, completedAt: BASE + 90_000,
      outcome: "confirmed_terminated", httpStatus: null, outcomeDetail: "host_not_running; confirmed by cli@x pid 1",
    });
    await journal({ pageId: null, sentAt: BASE + 5_000, source: "credentials_verify" });

    const report = await buildFanslySendGuardReport(testDb.db, { since, pageLabel: null });
    const pageReport = report.pages.find((row) => row.page === "report-a")!;
    expect(pageReport).toMatchObject({
      attempts: 5,
      sends: 4,
      inFlight: 0,
      sources: {
        sync_stream: { attempts: 3, sends: 2 },
        ws_connect: { attempts: 1, sends: 1 },
        media_download: { attempts: 1, sends: 1 },
      },
      pace: {
        pairs: 4,
        pairsCloserThanSetting: 1,
        minGapMs: 200,
        minGapSettingMs: 2_500,
        minGapAt: new Date(BASE + 4_200).toISOString(),
        settingMsMin: 2_500,
        settingMsMax: 2_500,
      },
      guard: { triggers: 2, attemptsThatWaited: 1, captureRefusals: 2, sendRefusals: 1, captureWaitMsTotal: 2_700, captureWaitMsMax: 2_700 },
      outcomes: { response: 3, aborted_before_send: 1, confirmed_terminated: 1 },
      httpStatus: { "101": 1, "200": 1, "429": 1 },
      http429: 1,
      http401: 0,
      http403: 0,
      closedNow: false,
    });
    expect(pageReport.closedPeriods).toEqual([expect.objectContaining({
      from: new Date(BASE + 60_000).toISOString(),
      until: new Date(BASE + 90_000).toISOString(),
      outcome: "confirmed_terminated",
      holder: "worker@host-a pid 7",
    })]);
    expect(report.pages.find((row) => row.page === "report-b")).toMatchObject({ attempts: 0, sends: 0, guard: { triggers: 0 } });
    expect(report.violations).toEqual([expect.objectContaining({
      page: "report-a", gapMs: 200, settingMs: 2_500,
      earlier: expect.objectContaining({ source: "ws_connect" }),
      later: expect.objectContaining({ source: "media_download" }),
    })]);
    expect(report.unpacedAttempts).toBe(1);
    expect(report.verdict).toEqual({
      pairsCloserThanSetting: 1, guardTriggers: 2, http429: 1, http401: 0, http403: 0, closedPeriods: 1,
      paceHeld: false, guardTriggered: true, noRejections: false,
    });

    const one = await buildFanslySendGuardReport(testDb.db, { since, pageLabel: "report-b" });
    expect(one.pages.map((row) => row.page)).toEqual(["report-b"]);
    await expect(buildFanslySendGuardReport(testDb.db, { since, pageLabel: "nope" })).rejects.toThrow('No Fansly page "nope"');
  });

  it("shows a page closed right now", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("report-closed");
    await openGuard(page.id);
    await captureFanslyPageSendGuard(testDb.db, {
      pageId: page.id, token: randomUUID(), source: "sync_stream", operation: "messages", holder: holder(),
      settingMs: 300, leaseMs: 1, captureWaitMs: 0, captureRefusals: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const report = await buildFanslySendGuardReport(testDb.db, { since: new Date(Date.now() - 60_000), pageLabel: null });
    expect(report.pages[0]).toMatchObject({ closedNow: true, inFlight: 1 });
    expect(report.pages[0]!.closedPeriods).toEqual([expect.objectContaining({ until: null, source: "sync_stream" })]);
  });
});

describe("the Docker-level confirmation of a deploy", () => {
  it("releases a live lease only for a capture older than the listing of the running hosts", async (context) => {
    if (!testDb) return context.skip();
    const before = await seedPage("deploy-before");
    const after = await seedPage("deploy-after");
    for (const page of [before, after]) await openGuard(page.id);
    const capture = async (pageId: number) => {
      const token = randomUUID();
      await captureFanslyPageSendGuard(testDb!.db, {
        pageId, token, source: "sync_stream", operation: "messages", holder: holder({ host: "old-api" }),
        settingMs: 300, leaseMs: 600_000, captureWaitMs: 0, captureRefusals: 0,
      });
      return token;
    };
    await capture(before.id);
    // Instants are compared at millisecond precision (the deploy's `date`
    // gives milliseconds); keep the three apart.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const listedAt = (await testDb.pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A container that starts after the listing and captures: not in the list,
    // but alive.
    const late = await capture(after.id);
    const outcomes = await confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: ["api-now", "worker-now"], ownHost: "api-now", confirmer: "test",
      includeUnexpired: true, capturedBefore: listedAt, dryRun: false,
    });
    expect(outcomes.map((row) => [row.pageId, row.released])).toEqual([[before.id, true]]);
    const held = await testDb.pool.query(
      "select page_id::int as page_id, holder_token from fansly_page_send_guards where holder_token is not null",
    );
    expect(held.rows).toEqual([{ page_id: after.id, holder_token: late }]);
  });
});

describe("the W0 scripts' guard connection", () => {
  it("journals the script's capture through a writable connection of its own", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("w0-guard");
    await openGuard(page.id);
    const config = { ...app().config, databaseUrl: testDb.connectionString };
    const outcome = await withFanslyScriptSendGuard(config, {
      pageId: page.id, source: "ws_probe", applicationName: "hub-test-w0-guard",
    }, async (guard) => {
      const lease = await guard.acquire({ operation: "ws_probe", requestTimeoutMs: 1_000 });
      await lease.complete({ outcome: "response", httpStatus: 101 });
      return lease.token;
    });
    const rows = await testDb.pool.query(
      "select source, holder_role, outcome, http_status from fansly_send_log where guard_token = $1", [outcome],
    );
    expect(rows.rows).toEqual([{ source: "ws_probe", holder_role: "script", outcome: "response", http_status: 101 }]);
    const sessions = await testDb.pool.query(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and application_name = 'hub-test-w0-guard'`,
    );
    expect(sessions.rows[0].n).toBe(0);
  });

  it("fails closed for a role that cannot write: nothing journaled, nothing to send", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("w0-read-only");
    await openGuard(page.id);
    await testDb.pool.query("grant usage on schema public to read_only");
    await testDb.pool.query("grant select on fansly_page_send_guards, fansly_send_log, config_settings to read_only");
    const connection = new URL(testDb.connectionString);
    connection.username = "read_only";
    connection.password = READ_ONLY_ROLE_PASSWORD;
    const config = { ...app().config, databaseUrl: connection.toString() };
    const work = vi.fn();
    await expect(withFanslyScriptSendGuard(config, {
      pageId: page.id, source: "binding_preflight", applicationName: "hub-test-w0-read-only",
    }, work)).rejects.toThrow("fansly_send_guard_not_writable");
    expect(work).not.toHaveBeenCalled();
    expect((await testDb.pool.query("select count(*)::int as n from fansly_send_log")).rows[0].n).toBe(0);
  });
});

describe("the WS receiver on a closed page", () => {
  const scaled: FanslyWsWorkerTiming = {
    configPollMs: 1_000, configStaleMs: 2_000, pagePauseMs: 300, backoffBaseMs: 150,
    authTimeoutMs: 1_000, checkMs: 500, guardStaleMs: 1_500, pingMs: 2_000, pongTimeoutMs: 3_000,
    drainMs: 2_000, applyDrainMs: 1_500,
  };

  it("waits on the page pause without connecting, then connects once the page opens", async (context) => {
    if (!testDb) return context.skip();
    const runtime = app();
    const { page } = await seedFanslyPage(runtime.db, runtime.config.encryptionKey);
    if (!page) throw new Error("seed failed");
    await saveProxy(runtime, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
    await testDb.pool.query("update pages set external_page_id='999' where id=$1", [page.id]);
    // Another process holds the page past its lease, unconfirmed.
    await openGuard(page.id);
    const stuck = randomUUID();
    await captureFanslyPageSendGuard(testDb.db, {
      pageId: page.id, token: stuck, source: "sync_stream", operation: "messages", holder: holder({ host: "elsewhere" }),
      settingMs: 0, leaseMs: 1, captureWaitMs: 0, captureRefusals: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const open = vi.spyOn(socketTransport, "openFanslyReceiverSocket").mockImplementation(() => {
      const socket = Object.assign(new EventTarget(), { send: vi.fn() });
      return { socket, stop: vi.fn() } as unknown as ReturnType<typeof socketTransport.openFanslyReceiverSocket>;
    });
    runtime.config.fanslyWsCaptureEnabled = true;
    runtime.config.fanslyWsCapturePageAllowlist = page.label;
    const worker = startFanslyWsWorker(runtime, { timing: scaled });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(open).not.toHaveBeenCalled();
      // No connection attempt was recorded for a refused capture.
      expect((await testDb.pool.query("select count(*)::int as n from fansly_ws_connections")).rows[0].n).toBe(0);
      expect(await confirmFanslySendGuardTerminated(testDb.db, {
        pageId: page.id, token: stuck, evidence: "test", requireExpiredLease: true,
      })).toBe(true);
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce(), { timeout: 5_000 });
      const journalRows = await testDb.pool.query(
        "select source from fansly_send_log where page_id = $1 and source = 'ws_connect'", [page.id],
      );
      expect(journalRows.rows).toHaveLength(1);
    } finally {
      await worker.stop();
      open.mockRestore();
    }
  }, 20_000);
});
