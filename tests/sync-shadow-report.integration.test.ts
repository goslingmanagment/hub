import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDb,
  createPool,
  getSyncPage,
  getSyncWork,
  insertAuditEvent,
  insertObservation,
  listSyncPages,
  upsertDemand,
  type Database,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import { buildSyncReportCommandGroup } from "../apps/runtime/src/sync/cli/report.ts";
import { runsIn, type EngineRegistry, type ReplayContext, type ReplayObservation, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { fanEarningsRosterNextDueAt } from "../apps/runtime/src/sync/fansly/resources/fan-earnings.ts";
import { buildShadowReport, type ShadowReport } from "../apps/runtime/src/sync/report/shadow-report.ts";
import { ratePeriodMs } from "../apps/runtime/src/sync/report/shadow-window.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, wsCreated, wsMessage, wsTransaction, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { changedTables, setModeDirect, tableCounts } from "./helpers/sync-engine-host.ts";

// `pnpm cli sync shadow report` (design §3.12) over a fixture: part A in its
// read-only window transaction (demand vs the computed expectation, the legacy
// volume, socket frame → shadow admission vs the legacy arrival, the pacer),
// part B's replay mechanics (newest first, since / at least N, a failing or
// writing replay costs only its own verdict) and the chain and ETA scans.

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

const OWN = "100000000000000001";
const FAN = "200000000000000001";
const GROUP = "300000000000000001";
const TX = "777000000000000001";
const MINUTE = 60_000;
/** Legacy listed the fixture's chats long before any frame of the window. */
const LISTED_BEFORE = () => new Date(Date.now() - 24 * 3_600_000);
const logger = createLogger("silent");

function db(): Database {
  return testDb!.db as unknown as Database;
}

function ctx() {
  return { db: db(), logger };
}

async function shadowPage(): Promise<WsCapturePage> {
  const page = await seedWsCapturePage({ db: db(), pool: testDb!.pool }, { ownRef: OWN, label: "lilly-1" });
  await setModeDirect(testDb!.pool, page.pageId, "shadow");
  await seedWsThread({ db: db(), pool: testDb!.pool }, { pageId: page.pageId, groupId: GROUP, fanRef: FAN, firstSeenAt: LISTED_BEFORE() });
  return page;
}

async function shadowAttempt(
  pageId: number,
  input: { resource: string; workClass: string; subject?: string; at: Date; workId?: number },
): Promise<void> {
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, work_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, operation, request, outcome, apply_state)
     values ($1, true, $6, $2, $3, $4, 1, 2000, 0, 2000, $5, $5::timestamptz + interval '50 milliseconds', 'shadow', 'x', '{}'::jsonb, 'shadow', 'skipped')`,
    [pageId, input.resource, input.subject ?? "", input.workClass, input.at, input.workId ?? null],
  );
}

/** One legacy request of a stream on the page (its own run). */
async function legacyRequest(pageId: number, stream: string, operation: string, at: Date): Promise<void> {
  const run = await testDb!.pool.query<{ id: string }>(
    `insert into sync_runs (page_id, stream, source, outcome, started_at, finished_at, stats)
     values ($1, $2, 'scheduled', 'succeeded', $3, $3, '{}'::jsonb) returning id`,
    [pageId, stream, at],
  );
  await testDb!.pool.query(
    `insert into sync_http_attempts (page_id, sync_run_id, provider, stream, operation, logical_request_id, attempt_number, state, started_at, response_body_bytes)
     values ($1, $2, 'fansly', $3, $4, 'request', 1, 'success', $5, 100)`,
    [pageId, Number(run.rows[0]!.id), stream, operation, at],
  );
}

/** The rows the engine keeps for the keys counted at their rate (a poll or
 *  walk recurring less often than the hour), placed at `placedAt`, each first
 *  run due 10 min before its period is over: on schedule (rule A1.rate-assumed). */
async function placeRateRows(pageId: number, placedAt: Date): Promise<void> {
  for (const spec of FANSLY_RESOURCE_SPECS) {
    const periodMs = ratePeriodMs(spec, { registryOverrides: {} }, 3_600_000)?.periodMs ?? null;
    if (periodMs === null || !runsIn(spec, true)) continue;
    await testDb!.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, created_at, updated_at, due_at)
       values ($1, true, $2, '', $3, $4, $5, $5, $5::timestamptz + make_interval(secs => $6))`,
      [pageId, spec.key, spec.kind, spec.class, placedAt, (periodMs - 10 * MINUTE) / 1_000],
    );
  }
}

/** The live hour of the fixture: [start, start + 1 h), one hour ago. */
async function seedWindow(page: WsCapturePage, start: Date): Promise<void> {
  const at = (ms: number) => new Date(start.getTime() + ms);
  // The page ran in shadow before the window (its settling); the engine
  // placed its rows then.
  await shadowAttempt(page.pageId, { resource: "account.poll", workClass: "planned", at: at(-30 * MINUTE) });
  await placeRateRows(page.pageId, at(-30 * MINUTE));
  // Notification polls every 30 min: one before the window, two in it.
  await shadowAttempt(page.pageId, { resource: "notifications.forward", workClass: "planned", at: at(-20 * MINUTE) });
  await shadowAttempt(page.pageId, { resource: "notifications.forward", workClass: "planned", at: at(10 * MINUTE) });
  await shadowAttempt(page.pageId, { resource: "notifications.forward", workClass: "planned", at: at(40 * MINUTE) });
  // A fan message on the socket, read 6 s later.
  const message = wsMessage({ groupId: GROUP, senderId: FAN });
  await page.capture(wsCreated(message), at(12 * MINUTE));
  await shadowAttempt(page.pageId, { resource: "dm-messages.head", workClass: "urgent", subject: GROUP, at: at(12 * MINUTE + 6_000) });
  // A new ledger row on the socket, read 3 s later; legacy stored it 30 min later.
  await page.capture(wsTransaction(TX, 1), at(20 * MINUTE));
  await shadowAttempt(page.pageId, { resource: "transactions.head", workClass: "urgent", at: at(20 * MINUTE + 3_000) });
  await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
                               gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, created_at)
     values ($1, $2, '2110', 'tip', 'posted', '1', 0, 0, 0, $3, 'fansly:rest', $3::timestamptz + interval '30 minutes')`,
    [page.pageId, TX, at(20 * MINUTE)],
  );
  // A backlog walk.
  for (let i = 0; i < 3; i += 1) {
    await shadowAttempt(page.pageId, { resource: "media-stats.walk", workClass: "planned", at: at((45 + i) * MINUTE) });
  }
  // The legacy engine's socket hints of the hour.
  for (let i = 0; i < 4; i += 1) {
    await testDb!.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                                    captured_at, sent_at)
       values ($1, $2, 'ws_hint', 'messages.page', 'worker-1', 1, 'worker', $3, $4, $4)`,
      [page.pageId, randomUUID(), randomUUID(), at((5 + i) * MINUTE)],
    );
  }
}

describe("the shadow report (design §3.12)", () => {
  it("part A: demand vs its expectation, the legacy volume, the live-path decisions and the pacer, in one read-only snapshot", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    await seedWindow(page, start);
    const at = (ms: number) => new Date(start.getTime() + ms);
    // A fan message in a chat excluded from message sync: no key reads it.
    const excluded = "300000000000000009";
    await seedWsThread({ db: db(), pool: testDb.pool }, {
      pageId: page.pageId, groupId: excluded, fanRef: "200000000000000009", excluded: true, firstSeenAt: LISTED_BEFORE(),
    });
    await page.capture(wsCreated(wsMessage({ groupId: excluded, senderId: "200000000000000009" })), at(30 * MINUTE));
    // A message the chain confirmed by a capture before its frame: no key reads it.
    const confirmed = "300000000000000008";
    await seedWsThread({ db: db(), pool: testDb.pool }, {
      pageId: page.pageId, groupId: confirmed, fanRef: "200000000000000008", firstSeenAt: LISTED_BEFORE(),
      headConfirmedId: "400000000000000002", headConfirmedAt: at(34 * MINUTE),
    });
    await page.capture(
      wsCreated(wsMessage({ id: "400000000000000001", groupId: confirmed, senderId: "200000000000000008" })),
      at(35 * MINUTE),
    );
    // A new fan's first message: legacy lists the chat 2 min after the frame,
    // so the router did not know it then and the shadow finds the chat 4 s later.
    const fresh = "300000000000000007";
    await page.capture(wsCreated(wsMessage({ groupId: fresh, senderId: "200000000000000007" })), at(25 * MINUTE));
    await seedWsThread({ db: db(), pool: testDb.pool }, {
      pageId: page.pageId, groupId: fresh, fanRef: "200000000000000007", firstSeenAt: at(27 * MINUTE),
    });
    await shadowAttempt(page.pageId, { resource: "dm-conversations.find", workClass: "urgent", subject: fresh, at: at(25 * MINUTE + 4_000) });
    // The daily stats: one snapshot sequence of 11 requests, 3 s apart.
    for (let i = 0; i < 11; i += 1) {
      await shadowAttempt(page.pageId, { resource: "stats.daily", workClass: "planned", at: at(15 * MINUTE + i * 3_000) });
    }
    // The hourly followers head: its run done 4.5 min before the window, none in it.
    await shadowAttempt(page.pageId, { resource: "followers.head", workClass: "planned", at: at(-4.5 * MINUTE) });
    // The daily follower reconcile: one walk of 24 steps, its row closed in the window.
    const walk = await testDb.pool.query<{ id: string }>(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, closed_at, close_reason)
       values ($1, true, 'followers.reconcile', '', 'goal', 'planned', 'done', $2, 'shadow') returning id`,
      [page.pageId, at(50 * MINUTE)],
    );
    for (let i = 0; i < 24; i += 1) {
      await shadowAttempt(page.pageId, { resource: "followers.reconcile", workClass: "planned", at: at(48 * MINUTE + i * 4_000), workId: Number(walk.rows[0]!.id) });
    }
    // Legacy requests of two streams on the page (rule A1.floor's per-page
    // counterparts): the account light poll in the window, its shadow poll
    // only before it (the page's history counts); the fan earnings 2 h
    // before, no roster walk in the page's 1.5 h of shadow history yet.
    for (const [stream, operation, startedAt] of [["light", "account.me", at(5 * MINUTE)], ["fan_earnings", "earnings.fan", at(-2 * 60 * MINUTE)]] as const) {
      const run = await testDb.pool.query<{ id: string }>(
        `insert into sync_runs (page_id, stream, source, outcome, started_at, finished_at, stats)
         values ($1, $2, 'scheduled', 'succeeded', $3, $3, '{}'::jsonb) returning id`,
        [page.pageId, stream, startedAt],
      );
      await testDb.pool.query(
        `insert into sync_http_attempts (page_id, sync_run_id, provider, stream, operation, logical_request_id, attempt_number, state, started_at, response_body_bytes)
         values ($1, $2, 'fansly', $3, $4, 'request', 1, 'success', $5, 100)`,
        [page.pageId, Number(run.rows[0]!.id), stream, operation, startedAt],
      );
    }
    // The describer's CDN download of the legacy engine: live-only in the registry.
    await testDb.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                                    captured_at, sent_at)
       values ($1, $2, 'media_download', 'media.download', 'worker-1', 1, 'worker', $3, $4, $4)`,
      [page.pageId, randomUUID(), randomUUID(), at(33 * MINUTE)],
    );
    const report = await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()),
      registry: createStubRegistry(),
      window: { start, end: new Date(start.getTime() + 3_600_000) },
      journal: null,
      maxListed: 50,
    });
    const window = report.window!;
    expect(window.coverage).toEqual([{
      page: "lilly-1", mode: "shadow", firstShadowAdmissionAt: new Date(start.getTime() - 30 * MINUTE), covered: true, reason: null,
    }]);
    const demand = window.demand[0]!;
    const row = (resource: string) => demand.resources.find((entry) => entry.resource === resource);
    // Polls are judged in runs (rule A1.poll-schedule).
    expect(row("notifications.forward")).toMatchObject({ observed: 2, runs: { runs: 2, attemptsPerRun: [1, 1], early: [], late: [], overdue: null }, verdict: "ok" });
    // A snapshot sequence of 11 requests is one run.
    expect(row("stats.daily")).toMatchObject({ observed: 11, runs: { runs: 1, attemptsPerRun: [11] }, rate: { runSize: 11 }, verdict: "ok" });
    // An hourly run just before the window, none in it: on schedule.
    expect(row("followers.head")).toMatchObject({ observed: 0, runs: { runs: 0, overdue: null }, verdict: "ok" });
    expect(row("dm-messages.head")).toMatchObject({ class: "urgent", observed: 1, expected: 1, verdict: "ok" });
    expect(row("transactions.head")).toMatchObject({ observed: 1, expected: 1, verdict: "ok" });
    // The new chat's frame implies finding the chat, not reading its head.
    expect(row("dm-conversations.find")).toMatchObject({ class: "urgent", observed: 1, expected: 1, verdict: "ok" });
    // A 30-minute poll that never ran is listed with its reason.
    expect(row("dm-conversations.head")).toMatchObject({ observed: 0, verdict: "outside", reason: expect.stringContaining("overdue: ") });
    expect(demand.scheduleFaults).toContainEqual(expect.stringMatching(/^dm-conversations\.head: overdue: /));
    // The daily reconcile counts at its rate: 24 steps per 24 h (rule A1.rate).
    expect(row("followers.reconcile")).toMatchObject({ observed: 24, rate: { runSize: 24, counted: 1 }, verdict: "not_modelled" });
    expect(demand.walks).toContainEqual({ resource: "media-stats.walk", observed: 3, oneTimeBacklog: true });
    expect(demand.attempts).toEqual({ urgent: 3, requests: 0, planned: 40 });
    // urgent 3 + notifications 2 + stats.daily 11 + the reconcile 24 observed;
    // at their rates 3 + 2 + 11/24 + 24/24.
    expect(demand.steadyStateRaw).toBe(40);
    // + the single-request polls that never ran at one request a period
    // (rule A1.rate-assumed): 1/22 + 1/6.
    expect(demand.steadyState).toBe(6.67);
    expect(demand.assumedRunSize).toEqual([
      { resource: "stats.hourly", steps: 1, periodMs: 22 * 3_600_000 },
      { resource: "top-spenders.window", steps: 1, periodMs: 6 * 3_600_000 },
    ]);
    // The longer multi-step polls that never ran, without an estimate (the
    // stub registry's modules give none), leave the ceiling unknown.
    expect(demand.unknownRunSize).toEqual(["catalog.fixed", "dm-conversations.full", "payouts.daily", "posts.refresh"]);
    expect(demand).toMatchObject({ ceiling: "unknown", inBand: false, passes: false });
    expect(demand.floor).toMatchObject({
      below: true,
      holds: false,
      // The socket hints' and the light poll's counterparts ran on this page in
      // its 1.5 h of shadow history; the daily roster walk is not due yet.
      counterparts: {
        lacking: [],
        pending: [{ ref: "stream:fan_earnings", why: expect.stringMatching(/^not yet judgeable: legacy 1 on its A2 basis, the shadow none in 1\.5 h of shadow history on the page; /) }],
        onDemand: [],
        notInShadow: [{ ref: "sender:media_download", why: "live_only" }],
      },
    });

    expect(window.livePath.fanMessages).toMatchObject({
      frames: 2,
      notRead: 2,
      notReadReasons: { excluded_chat: 1, confirmed_before_frame: 1 },
      shadowAdmissionLagMs: { p50: 4_000, p95: 6_000 },
      withoutShadowAdmission: 0,
      withoutLegacyArrival: 2,
      meetsTarget: true,
    });
    expect(window.livePath.transactions).toMatchObject({
      frames: 1,
      shadowAdmissionLagMs: { p50: 3_000, p95: 3_000 },
      legacyArrivalLagMs: { p50: 30 * MINUTE, p95: 30 * MINUTE },
      meetsTarget: true,
    });
    // Too few frames in the hour: the routing decisions of the day before are replayed offline.
    expect(window.livePath.offline).toMatchObject({ receipts: 0, byResource: [] });

    const hints = window.legacy.find((entry) => entry.ref === "sender:ws_hint")!;
    expect(hints).toMatchObject({ basis: "window", legacy: 4, explained: true });
    expect(hints.shadowKeys).toEqual(expect.arrayContaining(["dm-messages.head"]));
    // A stream of daily keys is compared as rates (rule A2.rate): the shadow
    // over its 1.5 h of history, in requests.
    expect(window.legacy.find((entry) => entry.ref === "stream:stats_snapshot")).toMatchObject({
      basis: "7d_rate", legacy: 0, shadow: 7.33, shadowHours: 1.5, explained: false,
    });
    // A live-only sender is listed, never unexplained (rule A2.live-only).
    expect(window.legacy.find((entry) => entry.ref === "sender:media_download")).toMatchObject({
      basis: "live_only", legacy: 1, shadow: 0, ratio: null, explained: true,
    });

    expect(window.pacer).toMatchObject({ violations: 0, pages: [{ page: "lilly-1", sends: 43, violations: 0 }] });
    expect(window.verdict).toMatchObject({ covered: true, a1: false, a2: false, a3: true, a4: true });
    expect(window.rules.map((rule) => rule.id)).toEqual([
      "A1.rate", "A1.rate-assumed", "A1.ceiling", "A1.floor", "A1.floor-scheduled", "A1.floor-queue", "A1.floor-idle", "A1.poll-schedule",
      "A2.rate", "A2.legacy-regime", "A2.live-only",
    ]);
    expect(report.summary).toContain("Coverage: every page in shadow from at least 10 min before the start");
    expect(report.summary).toContainEqual(expect.stringMatching(/^Rule A1\.floor: Below 40 an hour a page passes only when /));
    expect(report.summary).toContainEqual(expect.stringMatching(
      /^A1 lilly-1: steady 6\.67 per hour \(observed 40; at their rate: followers\.reconcile 24\/24 h, stats\.daily 11\/24 h\); ceiling 100: UNKNOWN — no finished run to size it and no assumed size of catalog\.fixed, .*; below 40: the floor's exception FAILS \(rule A1\.floor; outside: .*dm-conversations\.head.*; OFF SCHEDULE or RUNAWAY \(rules A1\.poll-schedule, A1\.rate\): .* — FAIL$/,
    ));
    expect(report.summary).toContainEqual(expect.stringMatching(/^A2 legacy volume: unexplained: stream:fan_earnings \(7d_rate: .*\), stream:light \(window: legacy 1, shadow 0, ratio 0\.00\), stream:stats_snapshot \(7d_rate: legacy 0, shadow 7\.33\); live-only, not in shadow \(rule A2\.live-only\): sender:media_download 1$/));
    expect(report.verdict.accepted).toBe(false);
    expect(report.summary.at(-1)).toContain("not accepted");
  });

  it("part A: a stream not yet run on the page is scheduled when its recurring key's work row is on schedule at the window end (rule A1.floor-scheduled)", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    const end = new Date(start.getTime() + 3_600_000);
    await seedWindow(page, start);
    const at = (ms: number) => new Date(start.getTime() + ms);
    // A legacy fan earnings request 2 h before the window; the shadow's
    // roster walk has not run on the page in its 1.5 h of history.
    const run = await testDb.pool.query<{ id: string }>(
      `insert into sync_runs (page_id, stream, source, outcome, started_at, finished_at, stats)
       values ($1, 'fan_earnings', 'scheduled', 'succeeded', $2, $2, '{}'::jsonb) returning id`,
      [page.pageId, at(-2 * 60 * MINUTE)],
    );
    await testDb.pool.query(
      `insert into sync_http_attempts (page_id, sync_run_id, provider, stream, operation, logical_request_id, attempt_number, state, started_at, response_body_bytes)
       values ($1, $2, 'fansly', 'fan_earnings', 'earnings.fan', 'request', 1, 'success', $3, 100)`,
      [page.pageId, Number(run.rows[0]!.id), at(-2 * 60 * MINUTE)],
    );
    // The roster's row, placed at the shadow's start, due 20 h later: within
    // its placement + 24 h + 2 min.
    const roster = await testDb.pool.query<{ id: string }>(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, created_at, due_at)
       values ($1, true, 'fan-earnings.roster', '', 'goal', 'planned', $2, $2::timestamptz + interval '20 hours') returning id`,
      [page.pageId, at(-30 * MINUTE)],
    );
    // A row closed before the window end is not open at it.
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, created_at, due_at, state, closed_at, close_reason)
       values ($1, true, 'fan-earnings.roster', 'old', 'goal', 'planned', $2, $2, 'cancelled', $3, 'test')`,
      [page.pageId, at(-40 * MINUTE), at(-35 * MINUTE)],
    );
    const report = async () => {
      const built = await buildShadowReport(ctx(), {
        pages: await listSyncPages(db()),
        registry: createStubRegistry(),
        window: { start, end },
        journal: null,
        maxListed: 50,
      });
      return built;
    };
    const scheduled = await report();
    expect(scheduled.window!.demand[0]!.floor.counterparts).toMatchObject({
      lacking: [],
      pending: [],
      scheduled: [{
        ref: "stream:fan_earnings",
        why: `legacy 1 on its A2 basis, the shadow none yet in 1.5 h of shadow history on the page; on its schedule: fan-earnings.roster due ${
          new Date(at(-30 * MINUTE).getTime() + 20 * 3_600_000).toISOString()} (placed ${at(-30 * MINUTE).toISOString()} + 24 h + 2 min = ${
          new Date(at(-30 * MINUTE).getTime() + 24 * 3_600_000 + 2 * MINUTE).toISOString()})`,
      }],
    });
    expect(scheduled.summary).toContainEqual(expect.stringMatching(/; scheduled, first run not yet due \(rule A1\.floor-scheduled\): stream:fan_earnings \(/));
    expect(scheduled.summary).toContainEqual(expect.stringMatching(/^Rule A1\.floor-scheduled: /));
    // Its due time passed inside the window and no read was admitted: not yet judgeable.
    await testDb.pool.query(`update sync_work set due_at = $2 where id = $1`, [Number(roster.rows[0]!.id), at(30 * MINUTE)]);
    const overdue = await report();
    expect(overdue.window!.demand[0]!.floor.counterparts).toMatchObject({
      scheduled: [],
      pending: [{
        ref: "stream:fan_earnings",
        why: expect.stringMatching(new RegExp(`; not on its schedule \\(rule A1\\.floor-scheduled\\): fan-earnings\\.roster: due ${
          at(30 * MINUTE).toISOString().replace(/\./g, "\\.")}, not admitted by the window end$`)),
      }],
    });
    // Read after the window end by its bound (its due time moved on): on schedule again.
    await testDb.pool.query(`update sync_work set due_at = $2 where id = $1`, [Number(roster.rows[0]!.id), new Date(end.getTime() + 30 * 3_600_000)]);
    await shadowAttempt(page.pageId, { resource: "fan-earnings.roster", workClass: "planned", at: new Date(end.getTime() + 5 * MINUTE), workId: Number(roster.rows[0]!.id) });
    const read = await report();
    expect(read.window!.demand[0]!.floor.counterparts).toMatchObject({ pending: [], scheduled: [{ ref: "stream:fan_earnings" }] });
    expect(read.window!.demand[0]!.floor.counterparts.scheduled[0]!.why)
      .toContain(`fan-earnings.roster first read admitted ${new Date(end.getTime() + 5 * MINUTE).toISOString()}, by its bound`);
  });

  it("part A: a queue walk whose queue holds nothing due is idle; a due subject makes the next transactions step ask for the walk (rule A1.floor-queue)", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    const end = new Date(start.getTime() + 3_600_000);
    await seedWindow(page, start);
    await legacyRequest(page.pageId, "fan_earnings", "earnings.fan", new Date(start.getTime() - 2 * 3_600_000));
    // Two spenders, both windows read 3 days ago, no mark: due again 156 h
    // after the read.
    const readAt = new Date(Date.now() - 3 * 24 * 3_600_000);
    const spenders = ["200000000000000101", "200000000000000102"];
    for (const fanRef of spenders) {
      const fan = await testDb.pool.query<{ id: string }>(
        "insert into fans (platform, platform_user_id, first_seen_at) values ('fansly', $1, now()) returning id",
        [fanRef],
      );
      await testDb.pool.query(
        "insert into page_fans (fan_id, platform_account_id, total_creator_net_mills) values ($1, $2, 5000)",
        [Number(fan.rows[0]!.id), page.pageId],
      );
      for (const plane of ["fan_earnings_lifetime", "fan_earnings_monthly"]) {
        await testDb.pool.query(
          `insert into subject_refresh_state (page_id, plane, subject_ref, last_visited_at, created_at, updated_at)
           values ($1, $2, $3, $4, $4, $4)`,
          [page.pageId, plane, fanRef, readAt],
        );
      }
    }
    const insurance = await createFanslyRegistry().module("transactions.insurance");
    const step = async () => (await insurance.shadow({ cursor: null } as unknown as SyncWorkRow, { spec: "transactions.page", params: {} } as never, {
      db: db(), pageId: page.pageId, now: new Date(), page: (await getSyncPage(db(), page.pageId))!,
    })).followups;
    // A transactions step asks for no walk: nothing is due.
    expect(await step()).toEqual([]);
    const report = await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()), registry: createFanslyRegistry(), window: { start, end }, journal: null, maxListed: 50,
    });
    const counterparts = report.window!.demand[0]!.floor.counterparts;
    expect(counterparts.pending).toEqual([]);
    expect(counterparts.lacking).toEqual([]);
    expect(counterparts.idle).toEqual([{
      ref: "stream:fan_earnings",
      why: `legacy 1 on its A2 basis, the shadow none in 1.5 h of shadow history on the page; nothing due: fan-earnings.roster: queue idle, its next subject due ${
        new Date(readAt.getTime() + 156 * 3_600_000).toISOString()}`,
    }]);
    expect(report.summary).toContainEqual(expect.stringMatching(
      /; idle, nothing due on the page — looked on time, which subjects a due rule takes not verified while legacy reads first \(rules A1\.floor-queue, A1\.floor-idle\): stream:fan_earnings \(/,
    ));
    expect(report.summary).toContainEqual(expect.stringMatching(/^Rule A1\.floor-queue: /));
    // The real registry sizes every rate key before its first run: the
    // ceiling is known, on assumed sizes (rule A1.rate-assumed).
    expect(report.window!.demand[0]).toMatchObject({ unknownRunSize: [], ceiling: "ok", ceilingBasis: "assumed" });
    expect(report.summary).toContainEqual(expect.stringMatching(
      /ceiling 100 ok \(on assumed sizes, no finished run yet: catalog\.fixed 6\/24 h, dm-conversations\.full 1\/24 h, .*stats\.daily 15\/24 h.*; rule A1\.rate-assumed\)/,
    ));
    // A mark makes one subject due: the next step asks for the walk.
    await testDb.pool.query(
      "update subject_refresh_state set next_due_at = now(), updated_at = now() where page_id = $1 and plane = 'fan_earnings_lifetime' and subject_ref = $2",
      [page.pageId, spenders[0]],
    );
    expect((await step()).map((signal) => signal.resource)).toEqual(["fan-earnings.roster"]);
    const queue = await fanEarningsRosterNextDueAt(db(), { pageId: page.pageId, at: new Date(Date.now() + MINUTE), shadow: true });
    expect("nextDueAt" in queue && queue.nextDueAt !== null && queue.nextDueAt.getTime() <= Date.now()).toBe(true);
  });

  it("part A: a queue walk's queue is judged as it stood at the window end — a subject legacy read after it leaves the stream not yet judgeable, never idle (rule A1.floor-queue)", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    const end = new Date(start.getTime() + 3_600_000);
    await seedWindow(page, start);
    await legacyRequest(page.pageId, "fan_earnings", "earnings.fan", new Date(start.getTime() - 2 * 3_600_000));
    // One spender, both windows last read 156 h + 30 min before the window
    // end: due 30 min before it, and no walk row asked for.
    const fanRef = "200000000000000201";
    const fan = await testDb.pool.query<{ id: string }>(
      "insert into fans (platform, platform_user_id, first_seen_at) values ('fansly', $1, now()) returning id",
      [fanRef],
    );
    await testDb.pool.query(
      "insert into page_fans (fan_id, platform_account_id, total_creator_net_mills) values ($1, $2, 5000)",
      [Number(fan.rows[0]!.id), page.pageId],
    );
    const readAt = new Date(end.getTime() - 30 * MINUTE - 156 * 3_600_000);
    for (const plane of ["fan_earnings_lifetime", "fan_earnings_monthly"]) {
      await testDb.pool.query(
        `insert into subject_refresh_state (page_id, plane, subject_ref, last_visited_at, created_at, updated_at)
         values ($1, $2, $3, $4, $4, $4)`,
        [page.pageId, plane, fanRef, readAt],
      );
    }
    const counterparts = async () => (await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()), registry: createFanslyRegistry(), window: { start, end }, journal: null, maxListed: 50,
    })).window!.demand[0]!.floor.counterparts;
    // Untouched since: the subject was due 30 min before the end, the driver
    // had 7.5 min to ask for the walk — no counterpart.
    const missed = await counterparts();
    expect(missed).toMatchObject({ idle: [], pending: [] });
    expect(missed.lacking[0]!.why).toContain(
      `(rule A1.floor-queue): fan-earnings.roster: a subject due ${new Date(end.getTime() - 30 * MINUTE).toISOString()} and no walk row by the window end`,
    );
    // Legacy read it 10 min after the window end: as it stands now it is due
    // in 156 h, but the queue at the window end is not known — not idle.
    const legacyRead = new Date(end.getTime() + 10 * MINUTE);
    await testDb.pool.query(
      "update subject_refresh_state set last_visited_at = $2, updated_at = $2 where page_id = $1 and plane = 'fan_earnings_lifetime'",
      [page.pageId, legacyRead],
    );
    const moved = await counterparts();
    expect(moved).toMatchObject({ idle: [], lacking: [] });
    expect(moved.pending).toEqual([{
      ref: "stream:fan_earnings",
      why: expect.stringContaining(
        `(rule A1.floor-queue): fan-earnings.roster: 1 roster subject row changed after ${end.toISOString()} (the newest ${legacyRead.toISOString()}): `
          + "the queue as it stood then is not known — its queue at the window end is not judgeable; report a window that ends after it",
      ),
    }]);
  });

  it("rule A1.rate-assumed: a key that ran before is not counted at its estimate — a reconcile whose walk closed 40 h before the window end stays unknown", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    const end = new Date(start.getTime() + 3_600_000);
    await seedWindow(page, start);
    const report = async () => (await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()), registry: createFanslyRegistry(), window: { start, end }, journal: null, maxListed: 50,
    }));
    // Never run, its row on schedule: assumed.
    const fresh = await report();
    expect(fresh.window!.demand[0]).toMatchObject({ unknownRunSize: [], ceiling: "ok", ceilingBasis: "assumed" });
    expect(fresh.window!.demand[0]!.assumedRunSize.map((entry) => entry.resource)).toContain("followers.reconcile");
    // A row closed without an attempt is no run.
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, created_at, state, closed_at, close_reason)
       values ($1, true, 'followers.reconcile', '', 'goal', 'planned', $2, 'cancelled', $2, 'test')`,
      [page.pageId, new Date(end.getTime() - 50 * 3_600_000)],
    );
    expect((await report()).window!.demand[0]!.unknownRunSize).toEqual([]);
    // Its one 3-step walk, closed 40 h before the window end: the key ran.
    const closedAt = new Date(end.getTime() - 40 * 3_600_000);
    const walk = await testDb.pool.query<{ id: string }>(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, created_at, state, closed_at, close_reason)
       values ($1, true, 'followers.reconcile', '', 'goal', 'planned', $2, 'done', $2, 'shadow') returning id`,
      [page.pageId, closedAt],
    );
    for (let i = 0; i < 3; i += 1) {
      await shadowAttempt(page.pageId, { resource: "followers.reconcile", workClass: "planned", at: new Date(closedAt.getTime() - (3 - i) * 4_000), workId: Number(walk.rows[0]!.id) });
    }
    const ran = await report();
    const demand = ran.window!.demand[0]!;
    expect(demand).toMatchObject({ unknownRunSize: ["followers.reconcile"], ceiling: "unknown", passes: false });
    expect(demand.resources.find((entry) => entry.resource === "followers.reconcile")!.reason).toBe(
      `a walk at most every 24 h: no finished walk to size it yet and not counted at its estimate, followers.reconcile: a run of it closed ${
        closedAt.toISOString()} — a key that ran is sized by its runs (rule A1.rate-assumed)`,
    );
    expect(ran.summary).toContainEqual(expect.stringMatching(/ceiling 100: UNKNOWN — no finished run to size it and no assumed size of followers\.reconcile \(rules A1\.rate, A1\.rate-assumed\)/));
  });

  it("part A: a standing walk that looked and found nothing due is idle; its pick re-run at the look naming a due subject untouched since lacks a counterpart (rule A1.floor-idle)", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    const end = new Date(start.getTime() + 3_600_000);
    const at = (ms: number) => new Date(start.getTime() + ms);
    await seedWindow(page, start);
    await legacyRequest(page.pageId, "post_replies", "post.replies", at(10 * MINUTE));
    // The replies walk, placed at the shadow's start, looked 20 min into the
    // window and found nothing due: its next look 6 h on.
    const look = at(20 * MINUTE);
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, created_at, updated_at, due_at, waiting_reason)
       values ($1, true, 'post-replies.walk', '', 'goal', 'planned', $2, $3, $3::timestamptz + interval '6 hours', 'not_due')`,
      [page.pageId, at(-30 * MINUTE), look],
    );
    // A post walked yesterday: not due again for days.
    const queued = async (subjectRef: string, lastVisitedAt: Date | null, updatedAt: Date) => testDb!.pool.query(
      `insert into subject_refresh_state (page_id, plane, subject_ref, last_visited_at, created_at, updated_at)
       values ($1, 'post_replies', $2, $3, $4, $4)
       on conflict (page_id, plane, subject_ref) do update set last_visited_at = excluded.last_visited_at, updated_at = excluded.updated_at`,
      [page.pageId, subjectRef, lastVisitedAt, updatedAt],
    );
    await queued("950000000000000001", at(-24 * 60 * MINUTE), at(-24 * 60 * MINUTE));
    const report = async () => (await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()), registry: createFanslyRegistry(), window: { start, end }, journal: null, maxListed: 50,
    })).window!.demand[0]!.floor.counterparts;
    const idle = await report();
    expect(idle).toMatchObject({ lacking: [], pending: [], idle: [{ ref: "stream:post_replies" }] });
    // 5 years on, its own pick takes the one queued post (its due rule reads).
    expect(idle.idle[0]!.why).toBe(`legacy 1 on its A2 basis, the shadow none in 1.5 h of shadow history on the page; nothing due: post-replies.walk looked ${
      look.toISOString()}, nothing due (its pick re-run there: none due and untouched since; 5 years on it takes 1 of the 1 queued); next look ${
      new Date(look.getTime() + 6 * 3_600_000).toISOString()} (by the look + 6 h + 2 min)`);
    // A post queued before the look, never walked and untouched since: the
    // look missed due work — no counterpart, at once.
    await queued("950000000000000002", null, at(10 * MINUTE));
    const missed = await report();
    expect(missed).toMatchObject({ idle: [], pending: [] });
    expect(missed.lacking).toEqual([{
      ref: "stream:post_replies",
      why: `legacy 1 on its A2 basis, the shadow none in 1.5 h of shadow history on the page; not on its schedule (rule A1.floor-idle): post-replies.walk: looked ${
        look.toISOString()} and found nothing due, yet its own pick re-run there finds 1 due and untouched since (950000000000000002)`,
    }]);
    // Legacy walked it after the look: it stands as it does now, not as the look saw it.
    await queued("950000000000000002", new Date(), new Date());
    expect(await report()).toMatchObject({ lacking: [], idle: [{ ref: "stream:post_replies" }] });

    // The report's own calls of the module's check: a pick that takes none of
    // the queued posts even 5 years on is a due rule that never reads — no
    // counterpart, at once.
    const real = createFanslyRegistry();
    const withCheck = (dueAtLook: NonNullable<ResourceModule["dueAtLook"]>): Pick<EngineRegistry, "module"> => ({
      module: async (key) => key === "post-replies.walk" ? { ...(await real.module(key)), dueAtLook } : real.module(key),
    });
    const reportWith = async (registry: Pick<EngineRegistry, "module">) => (await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()), registry, window: { start, end }, journal: null, maxListed: 50,
    })).window!.demand[0]!.floor.counterparts;
    const never = await reportWith(withCheck(async () => ({ count: 0, examples: [], queued: 2 })));
    expect(never).toMatchObject({ idle: [], pending: [] });
    expect(never.lacking[0]!.why).toMatch(/\(rule A1\.floor-idle\): post-replies\.walk: looked .* takes none of the 2 subjects on its queue even 5 years after the look: its due rule never reads$/);
    // A check whose statement fails costs only its own verdict (its savepoint
    // rolls back; the report's read-only transaction goes on).
    const failing = await reportWith(withCheck(async (_work, checkCtx) => {
      await checkCtx.db.execute("select * from no_such_table");
      return { count: 0, examples: [], queued: 0 };
    }));
    expect(failing).toMatchObject({ lacking: [], idle: [] });
    expect(failing.pending[0]!.why).toMatch(/\(rule A1\.floor-idle\): post-replies\.walk: looked .*; its look check failed: .*no_such_table/);
  });

  it("rule A1.rate-assumed: each module's estimate is the steps its shadow run takes, over the page's own facts", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    // 1 bound thread + 120 more visible chats; 250 followers; 20 posts of the
    // last 14 days.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id)
       select $1, (310000000000000000 + g)::text from generate_series(1, 120) g`,
      [page.pageId],
    );
    await testDb.pool.query("update pages set follower_count = 250 where id = $1", [page.pageId]);
    await testDb.pool.query(
      `insert into creator_posts (account_id, platform, platform_post_id, text_plain, published_at, first_observed_at, last_observed_at,
                                  content_hash, attachment_count, source_event_id, source_observation_id, source_account_seq)
       select $1, 'fansly', (960000000000000000 + g)::text, 'a post', now() - make_interval(hours => g), now(), now(),
              repeat('d', 64), 0, 9000 + g, 9000 + g, 100 + g
         from generate_series(1, 20) g`,
      [page.pageId],
    );
    const registry = createFanslyRegistry();
    const syncPage = (await getSyncPage(db(), page.pageId))!;
    const runSteps = async (key: string) => {
      const spec = fanslyResourceSpec(key)!;
      const module = await registry.module(key);
      const created = await upsertDemand(db(), { pageId: page.pageId, shadow: true, resource: key, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
      let work = (await getSyncWork(db(), created.id))!;
      const estimate = await module.estimateRunSteps!({ cursor: work.cursor }, { db: db(), pageId: page.pageId, now: new Date(), page: syncPage });
      for (let steps = 1; steps <= 500; steps += 1) {
        const now = new Date();
        const plan = await module.plan(work, { db: db(), pageId: page.pageId, shadow: true, now, page: syncPage, registry });
        if (plan.kind !== "request") throw new Error(`${key}: step ${steps} planned ${JSON.stringify(plan)}`);
        const result = await module.shadow(work, plan.request, { db: db(), pageId: page.pageId, now, page: syncPage });
        if (result.work.close !== undefined) return { estimate, steps };
        work = { ...work, cursor: result.work.cursor ?? work.cursor };
      }
      throw new Error(`${key}: no close in 500 steps`);
    };
    // 121 visible chats at 100 a page, the list stating no total.
    expect(await runSteps("dm-conversations.full")).toEqual({ estimate: 2, steps: 2 });
    // 250 followers at 100 a page + the start and verify reads.
    expect(await runSteps("followers.reconcile")).toEqual({ estimate: 5, steps: 5 });
    // 20 posts of the look-back at 15 a page + the closing page, each followed by its tips read.
    expect(await runSteps("posts.refresh")).toEqual({ estimate: 6, steps: 6 });
    // 10 reads, the discovery list's second page, both broadcast lists not at
    // their floor (no legacy walk to start from): 3 pages each.
    expect(await runSteps("stats.daily")).toEqual({ estimate: 15, steps: 15 });
    expect(await runSteps("catalog.fixed")).toEqual({ estimate: 6, steps: 6 });
    expect(await runSteps("payouts.daily")).toEqual({ estimate: 2, steps: 2 });
  });

  it("part B: replays newest first since a date and at least N per kind; a failing or writing replay costs only its verdict", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const now = Date.now();
    const observe = async (verdict: string, receivedAt: Date) => {
      const payload = { verdict };
      await insertObservation(db(), {
        source: "pull",
        producer: "test",
        platform: "fansly",
        accountId: page.pageId,
        nativeAccountRef: OWN,
        kind: "account_me",
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `test:${randomUUID()}`,
        receivedAt,
      });
    };
    for (const [i, verdict] of ["match", "match", "mismatch", "write", "match"].entries()) {
      await observe(verdict, new Date(now - (30 + i) * MINUTE));
    }
    for (const [i, verdict] of ["throw", "match", "match"].entries()) {
      await observe(verdict, new Date(now - (180 + i) * MINUTE));
    }
    const report = await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()),
      registry: createStubRegistry(),
      window: null,
      journal: {
        replaySince: new Date(now - 2 * 3_600_000),
        replayMinPerKind: 7,
        replayMaxPerKind: 1_000,
        chainsSince: new Date(now - 24 * 3_600_000),
        pacing: { batchRows: 3, sleepMs: 0, maxDurationMs: null, forceWindow: true },
        expectedCounterexampleRawIds: [],
      },
      maxListed: 10,
    });
    const journal = report.journal!;
    const accountMe = journal.replay.find((row) => row.kind === "account_me")!;
    // 5 since the date + 2 older to reach 7; the oldest observation is left out.
    expect(accountMe).toMatchObject({ resource: "account.poll", total: 7, matched: 4, mismatched: 3, notReplayable: 0, meetsTarget: false });
    expect(accountMe.mismatches.map((row) => row.reason).sort()).toEqual(["differs", "replay_failed:25006", "replay_failed:Error"]);
    expect(accountMe.mismatches.every((row) => row.page === "lilly-1")).toBe(true);
    // Kinds without a single observation are listed as such.
    expect(journal.replay.find((row) => row.kind === "dm_messages")).toMatchObject({ total: 0, notReplayableReasons: { no_observation: 1 } });

    expect(journal.chains).toEqual([expect.objectContaining({ page: "lilly-1" })]);
    const chain = journal.chains[0]!;
    expect("error" in chain.rebuild ? chain.rebuild.error : chain.rebuild.scan.completed).toBe(true);
    expect("error" in chain.endRule ? chain.endRule.error : chain.endRule.emptyPageSoundness.hits).toEqual([]);
    expect(journal.septemberSixteen).toEqual({ expected: [], listed: [], missing: [] });
    expect(journal.eta).toHaveLength(1);
    expect(report.verdict).toMatchObject({ a1: null, b5: false, b6: true, b7: true, accepted: false });
  });

  it("part B: a kind with observations of which none was judged fails B5; legacy's own refusals leave the ratio", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const now = Date.now();
    const observe = async (kind: string, verdict: string, minutesAgo: number) => {
      const payload = { verdict, nonce: randomUUID() };
      await insertObservation(db(), {
        source: "pull",
        producer: "test",
        platform: "fansly",
        accountId: page.pageId,
        nativeAccountRef: OWN,
        kind,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `test:${randomUUID()}`,
        receivedAt: new Date(now - minutesAgo * MINUTE),
      });
    };
    const report = async () => buildShadowReport(ctx(), {
      pages: await listSyncPages(db()),
      registry: createStubRegistry(),
      window: null,
      journal: {
        replaySince: new Date(now - 2 * 3_600_000),
        replayMinPerKind: 1,
        replayMaxPerKind: 1_000,
        chainsSince: new Date(now - 24 * 3_600_000),
        pacing: { batchRows: 10, sleepMs: 0, maxDurationMs: null, forceWindow: true },
        expectedCounterexampleRawIds: [],
      },
      maxListed: 10,
    });
    // Three matches and one body legacy itself refused: 3 / 3.
    for (const [i, verdict] of ["match", "match", "skip:legacy_refused_body_trimmed", "match"].entries()) {
      await observe("account_me", verdict, 10 + i);
    }
    const passing = await report();
    expect(passing.journal!.replay.find((row) => row.kind === "account_me")).toMatchObject({
      total: 4, matched: 3, mismatched: 0, notReplayable: 1, excused: 1, ratio: 1, meetsTarget: true,
    });
    expect(passing.verdict).toMatchObject({ b5: true, b6: true, b7: true });

    // A kind whose every observation was not judged (here: no page identity)
    // is no pass, whatever the other kinds say.
    await observe("followers", "skip:page_account_unknown", 5);
    await observe("followers", "skip:page_account_unknown", 6);
    const failing = await report();
    expect(failing.journal!.replay.find((row) => row.kind === "followers")).toMatchObject({
      total: 2, matched: 0, notReplayable: 2, excused: 0, ratio: 0, meetsTarget: false,
      notReplayableReasons: { page_account_unknown: 2 },
    });
    expect(failing.verdict).toMatchObject({ b5: false, accepted: false });
    expect(failing.summary).toContainEqual(expect.stringMatching(/below 99\.9 %: followers 0\.00 %/));
    expect(failing.summary).toContainEqual(
      "B5 not replayable: account_me legacy_refused_body_trimmed 1 (legacy refusal, left out); followers page_account_unknown 2",
    );

    // Not judged counts as not matched: 3 matches of 4 observations.
    await observe("account_me", "skip:body_unavailable", 1);
    const partial = (await report()).journal!.replay.find((row) => row.kind === "account_me");
    expect(partial).toMatchObject({ total: 5, matched: 3, excused: 1, ratio: 0.75, meetsTarget: false, matchedVia: {} });

    // A match through a named legacy rule stays a match, counted per rule and
    // listed; a page legacy never stored leaves the ratio under its own name.
    await observe("dm_messages", "match", 3);
    await observe("dm_messages", "match:via:legacy_unstored_below_window", 4);
    await observe("dm_messages", "skip:legacy_unstored_below_complete_claim", 7);
    const named = await report();
    expect(named.journal!.replay.find((row) => row.kind === "dm_messages")).toMatchObject({
      total: 3, matched: 2, notReplayable: 1, excused: 1, ratio: 1, meetsTarget: true,
      matchedVia: { legacy_unstored_below_window: 1 },
    });
    expect(named.summary).toContainEqual("B5 matched through a legacy rule: dm_messages legacy_unstored_below_window 1");
    expect(named.summary).toContainEqual(expect.stringContaining(
      "dm_messages legacy_unstored_below_complete_claim 1 (legacy journal-only read, older than every stored row of a chat "
        + "legacy claims complete: LEGACY COVERAGE DEFECT, left out)",
    ));
  });

  it("a window that starts before the deploy is no acceptance window; the whole report runs on a read-only connection", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedWsCapturePage({ db: db(), pool: testDb.pool }, { ownRef: OWN, label: "lilly-1" });
    await seedWsThread({ db: db(), pool: testDb.pool }, { pageId: page.pageId, groupId: GROUP, fanRef: FAN, firstSeenAt: LISTED_BEFORE() });
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    const at = (ms: number) => new Date(start.getTime() + ms);
    // The legacy receiver captured the whole hour; the deploy put the page in
    // shadow 25 min in, and its actor routed the frames of the routing horizon
    // on its first lap.
    for (const minute of [5, 15, 30, 50]) {
      await page.capture(wsCreated(wsMessage({ groupId: GROUP, senderId: FAN })), at(minute * MINUTE));
    }
    await page.capture(wsTransaction(TX, 1), at(8 * MINUTE));
    const deploy = at(25 * MINUTE);
    await testDb.pool.query("update sync_pages set mode = 'shadow', mode_changed_at = $2, mode_changed_by = 'test' where page_id = $1", [page.pageId, deploy]);
    for (const minute of [26, 30, 50]) {
      await shadowAttempt(page.pageId, { resource: "dm-messages.head", workClass: "urgent", subject: GROUP, at: at(minute * MINUTE + 5_000) });
    }
    await shadowAttempt(page.pageId, { resource: "transactions.head", workClass: "urgent", at: at(26 * MINUTE) });
    // A legacy observation for part B's replay.
    const payload = { nonce: randomUUID() };
    await insertObservation(db(), {
      source: "pull", producer: "test", platform: "fansly", accountId: page.pageId, nativeAccountRef: OWN, kind: "account_me",
      payload, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(), idempotencyKey: `test:${randomUUID()}`,
      receivedAt: at(MINUTE),
    });

    // The production command (real registry, both parts) on a connection
    // whose every transaction is read-only: any write would fail the run.
    const url = new URL(testDb.connectionString);
    url.searchParams.set("options", "-c default_transaction_read_only=on");
    const readOnlyPool = createPool(url.toString());
    await expect(readOnlyPool.query("update sync_pages set updated_at = updated_at")).rejects.toThrow(/read-only transaction/);
    const before = await tableCounts(testDb.pool);
    const printed: string[] = [];
    try {
      await buildSyncReportCommandGroup({
        openContext: async () => ({ db: createDb(readOnlyPool) as unknown as Database, logger, close: async () => undefined }),
        print: (line) => void printed.push(line),
        writeFile: async () => undefined,
        now: () => new Date(),
      }).parseAsync([
        "shadow", "report", "--window", `${start.toISOString()}/${at(60 * MINUTE).toISOString()}`, "--force-window",
        "--sleep-ms", "0", "--replay-min", "1", "--journal-since", at(-24 * 60 * MINUTE).toISOString(),
      ], { from: "user" });
    } finally {
      await readOnlyPool.end();
    }
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual([]);

    const report = JSON.parse(printed.at(-1)!) as ShadowReport;
    expect(report.window!.coverage).toEqual([{
      page: "lilly-1", mode: "shadow", firstShadowAdmissionAt: at(26 * MINUTE).toISOString(), covered: false, reason: "mode_changed",
    }]);
    // Frames before the deploy were read only when the actor started: their
    // lag is the deploy's, which the coverage names.
    expect(report.window!.livePath.fanMessages).toMatchObject({ frames: 4, withoutShadowAdmission: 0, meetsTarget: false });
    expect(report.journal!.replay.find((row) => row.kind === "account_me")).toMatchObject({ total: 1 });
    expect(report.verdict).toMatchObject({ covered: false, accepted: false });
    expect(report.summary).toContainEqual(expect.stringMatching(
      /^Coverage: NOT an acceptance window — lilly-1 mode_changed \(first shadow admission .+\); the window must start once every page has run in shadow for 10 min$/,
    ));
    expect(report.summary.at(-1)).toMatch(/^Verdict: coverage FAIL, .* — not accepted$/);
  });

  it("the CLI: `sync shadow report --part a` and `sync alerts ack`", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    await seedWindow(page, start);
    const printed: string[] = [];
    const written: Array<{ path: string; text: string }> = [];
    const command = () => buildSyncReportCommandGroup({
      openContext: async () => ({ ...ctx(), close: async () => undefined }),
      print: (line) => void printed.push(line),
      writeFile: async (path, text) => void written.push({ path, text }),
      now: () => new Date(),
    });
    await command().parseAsync([
      "shadow", "report", "--part", "a", "--window", `${start.toISOString()}/${new Date(start.getTime() + 3_600_000).toISOString()}`,
      "--out", "/tmp/shadow-report.json",
    ], { from: "user" });
    const report = JSON.parse(printed.at(-1)!) as ShadowReport;
    expect(report.verdict).toMatchObject({ a4: true, b5: null });
    expect(written).toEqual([{ path: "/tmp/shadow-report.json", text: `${printed.at(-1)}\n` }]);

    await command().parseAsync(["alerts", "ack", "--page", "lilly-1", "--note", "looked"], { from: "user" });
    expect(printed.at(-1)).toMatch(/^lilly-1: pace latch was not open at /);
    await expect(command().parseAsync(["shadow", "report", "--part", "a"], { from: "user" })).rejects.toThrow(/--window/);
  });
});

/** Every key replays by the fixture payload's `verdict` (`skip:<reason>`: not replayable). */
function createStubRegistry(): Pick<EngineRegistry, "module"> {
  const module = {
    async replay(observation: ReplayObservation, replayCtx: ReplayContext) {
      const verdict = (observation.payload as { verdict?: string } | null)?.verdict;
      if (verdict === "throw") throw new Error("boom");
      if (verdict === "write") await insertAuditEvent(replayCtx.db, { source: "test", eventType: "test.replay_write" });
      if (verdict?.startsWith("skip:") === true) return { kind: "not_replayable" as const, reason: verdict.slice("skip:".length) };
      if (verdict?.startsWith("match:via:") === true) return { kind: "match" as const, via: [verdict.slice("match:via:".length)] };
      return verdict === "match" ? { kind: "match" as const } : { kind: "mismatch" as const, reason: "differs" };
    },
  } as unknown as ResourceModule;
  return { module: async () => module };
}
