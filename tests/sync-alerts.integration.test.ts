import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createLiveSyncPage,
  createModel,
  ensureFanslyPageSendGuard,
  ensurePollRows,
  getNotificationIncidentByKey,
  getSyncPage,
  listSyncPages,
  readSyncJournalAlertFacts,
  readSyncPlannedDemandAlertFacts,
  readSyncStepAlertFacts,
  SYNC_ALERT_EVALUATION_RULES,
  upsertDemand,
  upsertDemands,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";
import { createLogger } from "@agency_hub_core/shared";

import { runGoldenSignalSample, SYNC_ENGINE_METRICS_PROBE } from "../apps/runtime/src/services/golden-signals.ts";
import {
  notifySyncEngineIncident,
  SYNC_ENGINE_EVALUATOR_SUBKEY,
  SYNC_ENGINE_PACE_VIOLATION_SUBKEY,
  syncEngineIncidentKey,
  syncEngineRouteSubKey,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { runNotificationPagingSweep } from "../apps/runtime/src/services/notification-paging-sweep.ts";
import { runOpsWatchdogCheck } from "../apps/runtime/src/services/ops-watchdog.ts";
import { buildSyncAlertsCommandGroup } from "../apps/runtime/src/sync/cli/alerts.ts";
import {
  acknowledgeSyncPaceViolations,
  collectPageAlerts,
  createIncidentAlertSink,
  plannedDemandSlos,
  readSyncAlertStatus,
  SYNC_ALERT_CLEAN_MS,
  SYNC_LEDGER_BACKFILL_STALL_MS,
  SyncAlertEvaluator,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import { computeSyncMetrics, sampleSyncEngineMetrics } from "../apps/runtime/src/sync/engine/metrics.ts";
import { createEngineRegistry, demandToUpsert, pollsFor, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { applyAccountMeToPage } from "../apps/runtime/src/sync/fansly/resources/account.ts";
import { purchaseTargetFollowups } from "../apps/runtime/src/sync/fansly/resources/purchases.ts";
import { enqueueOwnerSyncWork } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, wsTransaction, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import {
  makeTestActor,
  okResponse,
  quietLogger,
  ScriptedLiveTransport,
  setModeDirect,
  testConfig,
  waitFor,
} from "./helpers/sync-engine-host.ts";
import { clearPageHolds, replaceHoldRows, resourceBreakerRow, seedPageHold, seedRouteState } from "./helpers/sync-holds.ts";

// The Fansly Sync Engine's alerts and golden signals against a real database
// (plan §10, design §9.5, §9.6): the evaluator opens and resolves latches of
// handover/live pages only, alerts 1–3 wait 10 clean minutes (alert 4 none),
// a route's 429 is its own latch per page+route (D5), the pace latch is the
// owner's to close, alert 5 is the api watchdog's, and the sampler's compact
// set. Alert 4's ledger rule runs on the real rescan and backfill (the
// production actor and transactions module, fixed answers). Alert 4 also
// names a key whose steps keep ending without an outcome (`step_failing`)
// and an answer whose apply hangs (`apply_pending`), and judges a poll by its
// newest applied answer (bug hunt Д3/У2).

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
const registry = createFanslyRegistry();

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

const warnings: string[] = [];
const logger = { ...quietLogger, warn: (_obj: object, msg?: string) => void warnings.push(msg ?? "") };

function evaluator() {
  return new SyncAlertEvaluator({ db: db(), logger, registry });
}

async function pass(instance = evaluator()) {
  const result = await instance.runOnce();
  expect(result, warnings.join("; ")).not.toBeNull();
  return result!;
}

/** A Fansly page with an open receiver socket, an engine row in `mode` and a
 *  beating owner. */
async function enginePage(mode: "shadow" | "live" | "handover" | "off", label?: string, ownRef = OWN): Promise<WsCapturePage> {
  const page = await seedWsCapturePage({ db: db(), pool: testDb!.pool }, { ownRef, ...(label === undefined ? {} : { label }) });
  await setModeDirect(testDb!.pool, page.pageId, mode);
  await testDb!.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [page.pageId]);
  return page;
}

async function incident(subKey: Parameters<typeof syncEngineIncidentKey>[0]["subKey"], pageId: number | null) {
  return getNotificationIncidentByKey(db(), syncEngineIncidentKey({ subKey, pageId }));
}

/** Time passes for a latch: its condition was last seen `ms` earlier. */
async function ageLatch(subKey: Parameters<typeof syncEngineIncidentKey>[0]["subKey"], pageId: number, ms: number): Promise<void> {
  await testDb!.pool.query(
    `update notification_incidents
        set opened_at = opened_at - make_interval(secs => $2::double precision / 1000),
            last_seen_at = last_seen_at - make_interval(secs => $2::double precision / 1000)
      where incident_key = $1`,
    [syncEngineIncidentKey({ subKey, pageId }), ms],
  );
}

/** The evaluator's record of a page (`sync_alert_evaluations`), by rule. */
async function evaluations(pageId: number) {
  return query<{ rule: string; attemptedAt: Date; evaluatedAt: Date | null; failure: string | null; failedSince: Date | null }>(
    `select rule, attempted_at as "attemptedAt", evaluated_at as "evaluatedAt", failure, failed_since as "failedSince"
       from sync_alert_evaluations where page_id = $1 order by rule`,
    [pageId],
  );
}

async function evaluation(pageId: number, rule: string) {
  return (await evaluations(pageId)).find((row) => row.rule === rule);
}

/** Time passes for the evaluator's record: every instant of the page's rows `ms` earlier. */
async function ageEvaluations(pageId: number, ms: number): Promise<void> {
  await testDb!.pool.query(
    `update sync_alert_evaluations
        set attempted_at = attempted_at - make_interval(secs => $2::double precision / 1000),
            evaluated_at = evaluated_at - make_interval(secs => $2::double precision / 1000),
            failed_since = failed_since - make_interval(secs => $2::double precision / 1000)
      where page_id = $1`,
    [pageId, ms],
  );
}

/** Open a page latch of the engine as the evaluator would, its condition last seen `ms` ago. */
async function openPageLatch(page: WsCapturePage, subKey: "stuck" | "freshness", ms: number): Promise<void> {
  await notifySyncEngineIncident({ db: db(), logger }, {
    subKey, pageId: page.pageId, pageLabel: page.label, detail: "request_stalled", errorSummary: "request_stalled", occurredAt: new Date(),
  });
  await ageLatch(subKey, page.pageId, ms);
}

/** A sent attempt of the page's journal; `shadow` makes it a row shadow mode
 *  left behind, which nothing reads. */
async function attempt(input: {
  pageId: number;
  shadow?: boolean;
  sentSecondsAgo: number;
  resource?: string;
  workClass?: string;
  settingMs?: number;
  errorClass?: string | null;
}): Promise<void> {
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, operation, request, outcome, error_class)
     values ($1, $2, $3, '', $4, 1, $5, 0, $5,
             clock_timestamp() - make_interval(secs => $6::double precision + 0.1),
             clock_timestamp() - make_interval(secs => $6::double precision),
             $7, 'notifications.page', '{}'::jsonb, $8, $9)`,
    [
      input.pageId, input.shadow === true, input.resource ?? "notifications.forward", input.workClass ?? "planned",
      input.settingMs ?? 2_000, input.sentSecondsAgo, input.shadow === true ? "shadow" : "request_start",
      input.shadow === true ? "shadow" : "response", input.errorClass ?? null,
    ],
  );
}

describe("the alert evaluator (design §9.6)", () => {
  it("pages a live page's credentials hold, keeps alert 1 for 10 clean minutes, then resolves it", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await seedPageHold(testDb, { pageId: page.pageId, kind: "identity_mismatch", untilSeconds: "infinity" });
    const first = await pass();
    expect(first.opened).toEqual([{ pageId: page.pageId, subKey: "page_stopped", detail: "identity_mismatch" }]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open", errorCode: "identity_mismatch", kind: "fansly_sync_engine" });

    // The hold ended moments ago: the ten clean minutes count from there.
    await clearPageHolds(testDb, page.pageId);
    expect((await pass()).resolved).toEqual([]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open" });

    // Ten clean minutes.
    await ageLatch("page_stopped", page.pageId, SYNC_ALERT_CLEAN_MS);
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "page_stopped" }]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "resolved" });
  });

  it("a route's 429 never stops the page: its own latch per page+route opens, is refreshed (never repeated) and resolves 10 clean minutes after (D5)", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    const shadow = await enginePage("shadow", "route-shadow", "100000000000000002");
    const holdRoute = (pageId: number, route: string, seconds: number) =>
      seedRouteState(testDb!, { pageId, route, holdSeconds: seconds, effectivePerMin: 6, last429AttemptId: 1, last429SecondsAgo: 0 });
    await holdRoute(page.pageId, "messaging.groups", 60);
    await holdRoute(shadow.pageId, "messaging.groups", 60);
    // A 429 attempt in the journal is no page stop either.
    await attempt({ pageId: page.pageId, sentSecondsAgo: 1, errorClass: "rate_limit" });
    const first = await pass();
    expect(first.opened).toEqual([{ pageId: page.pageId, subKey: "route_limited:messaging.groups", detail: "route_held" }]);
    const listKey = syncEngineRouteSubKey("messaging.groups");
    expect(await incident(listKey, page.pageId)).toMatchObject({ status: "open", errorCode: "route_held" });
    expect(await incident("page_stopped", page.pageId)).toBeNull();
    // A page left in shadow runs no actor: its route pages nobody.
    expect(await incident(listKey, shadow.pageId)).toBeNull();

    // A second 429 on the same route refreshes the one latch; another route has its own.
    await holdRoute(page.pageId, "messaging.groups", 120);
    await holdRoute(page.pageId, "media.offer_stats", 60);
    const second = await pass();
    expect(second.opened).toEqual([{ pageId: page.pageId, subKey: "route_limited:media.offer_stats", detail: "route_held" }]);
    expect(await incident(listKey, page.pageId)).toMatchObject({ status: "open" });

    // The holds ended and their 429s are older than the clean window: resolved 10 min after last seen.
    await testDb.pool.query("delete from sync_holds where page_id = $1 and scope = 'route'", [page.pageId]);
    await seedRouteState(testDb, {
      pageId: page.pageId, route: "messaging.groups", holdSeconds: -1, ladderStep: 2, effectivePerMin: 3, last429AttemptId: 2,
      last429SecondsAgo: 11 * 60, revision: 2,
    });
    expect((await pass()).resolved).toEqual([]);
    await ageLatch(listKey, page.pageId, SYNC_ALERT_CLEAN_MS);
    await ageLatch(syncEngineRouteSubKey("media.offer_stats"), page.pageId, SYNC_ALERT_CLEAN_MS);
    const resolved = await pass();
    expect(resolved.resolved).toEqual(expect.arrayContaining([
      { pageId: page.pageId, subKey: "route_limited:messaging.groups" },
      { pageId: page.pageId, subKey: "route_limited:media.offer_stats" },
    ]));
    expect(await incident(listKey, page.pageId)).toMatchObject({ status: "resolved" });
    // The slowdown stays (the owner raises it); the alert status lists nothing now.
    const status = await readSyncAlertStatus(db(), { registry, pages: (await listSyncPages(db())).filter((row) => row.pageId === page.pageId) });
    expect(status.pages[0]!.routes).toEqual([]);
  });

  it("alert 1 opened from the journal alone (the capture path's open lost) resolves 10 min after the refusal", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await attempt({ pageId: page.pageId, sentSecondsAgo: 9 * 60, errorClass: "auth" });
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "page_stopped", detail: "auth" }]);
    // The latch holds as of the answer, not of the pass.
    const latch = await incident("page_stopped", page.pageId);
    const answeredAt = (await query<{ answeredAt: Date }>(
      "select coalesce(completed_at, admitted_at) as \"answeredAt\" from sync_attempts where page_id = $1",
      [page.pageId],
    ))[0]!.answeredAt;
    expect(Math.abs(latch!.lastSeenAt.getTime() - answeredAt.getTime())).toBeLessThan(2);
    await testDb.pool.query("update sync_attempts set admitted_at = admitted_at - interval '2 minutes' where page_id = $1", [page.pageId]);
    await ageLatch("page_stopped", page.pageId, 2 * 60_000);
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "page_stopped" }]);
  });

  it("alerts 2 and 3 resolve only after 10 clean minutes, so a condition that comes and goes keeps one page", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state)
       values ($1, false, 'dm-messages.head', '1', 'trigger', 'urgent', 'quarantined')`,
      [page.pageId],
    );
    const quarantine = (on: boolean) => testDb!.pool.query(
      `update sync_work set state = $2, closed_at = case when $2 = 'done' then clock_timestamp() end
        where page_id = $1 and resource = 'dm-messages.head'`,
      [page.pageId, on ? "quarantined" : "done"],
    );
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "live_degraded", detail: "quarantined" }]);

    // Clear for nine minutes, then back: the same standing latch, no second page.
    await quarantine(false);
    expect(await pass()).toMatchObject({ opened: [], resolved: [] });
    await ageLatch("live_degraded", page.pageId, SYNC_ALERT_CLEAN_MS - 60_000);
    expect(await pass()).toMatchObject({ opened: [], resolved: [] });
    await quarantine(true);
    expect(await pass()).toMatchObject({ opened: [], resolved: [] });
    const latch = await incident("live_degraded", page.pageId);
    expect(latch).toMatchObject({ status: "open", resolvedAt: null });
    // Never reopened: it was opened before the nine clear minutes.
    expect(Date.now() - latch!.openedAt.getTime()).toBeGreaterThan(SYNC_ALERT_CLEAN_MS - 2 * 60_000);

    // Ten clean minutes resolve it, measured from the last pass that saw it.
    await quarantine(false);
    await ageLatch("live_degraded", page.pageId, SYNC_ALERT_CLEAN_MS - 60_000);
    expect((await pass()).resolved).toEqual([]);
    await ageLatch("live_degraded", page.pageId, 60_000);
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "live_degraded" }]);
  });

  it("has no alert for a page left in shadow, and resolves the latches of a page that is off", async (context) => {
    if (!testDb) return context.skip();
    const shadow = await enginePage("shadow");
    await seedPageHold(testDb, { pageId: shadow.pageId, kind: "auth", untilSeconds: "infinity" });
    await attempt({ pageId: shadow.pageId, shadow: true, sentSecondsAgo: 30 });
    await attempt({ pageId: shadow.pageId, shadow: true, sentSecondsAgo: 29.5 });
    expect(await pass()).toMatchObject({ opened: [], paceViolations: 0 });
    expect(await incident("page_stopped", shadow.pageId)).toBeNull();
    // No actor runs it: `sync alerts status` lists the page with nothing to hold.
    const status = await readSyncAlertStatus(db(), { registry, pages: await listSyncPages(db()) });
    expect(status.pages.find((row) => row.mode === "shadow")).toMatchObject({ pages: false, conditions: [], routes: [] });

    await setModeDirect(testDb.pool, shadow.pageId, "live");
    await testDb.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [shadow.pageId]);
    // The rows shadow mode left are no sends of the live page either.
    expect(await pass()).toMatchObject({
      opened: [{ pageId: shadow.pageId, subKey: "page_stopped", detail: "auth" }],
      paceViolations: 0,
    });
    await setModeDirect(testDb.pool, shadow.pageId, "off");
    expect((await pass()).resolved).toEqual([{ pageId: shadow.pageId, subKey: "page_stopped" }]);
  });

  it("alert 3: a socket money frame the ledger lacks after 5 min, a fan message unconfirmed for 15 min", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await seedWsThread({ db: db(), pool: testDb.pool }, { pageId: page.pageId, groupId: GROUP, fanRef: FAN });
    await page.capture(wsTransaction("777000000000000001", 1), new Date(Date.now() - 10 * 60_000));
    // A payout (16012) and a settlement (status 2) are never ledger news.
    await page.capture(wsTransaction("777000000000000002", 1, 16012), new Date(Date.now() - 10 * 60_000));
    await page.capture(wsTransaction("777000000000000003", 2), new Date(Date.now() - 10 * 60_000));
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "freshness", detail: "money_not_in_ledger" }]);

    await testDb.pool.query(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
                                 gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
       values ($1, '777000000000000001', '2110', 'tip', 'posted', '1', 0, 0, 0, clock_timestamp(), 'fansly:rest')`,
      [page.pageId],
    );
    // In the ledger now: resolved after ten clean minutes.
    expect((await pass()).resolved).toEqual([]);
    await ageLatch("freshness", page.pageId, SYNC_ALERT_CLEAN_MS);
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "freshness" }]);

    // A fan message the socket showed 20 min ago that no REST read confirmed.
    // The parity pass has looked and found no copy, so its next look is
    // minutes ahead (`confirm_due_at` is that look, not a deadline).
    const liveMessage = (id: string, groupId: string, visibleMinutesAgo = 20) => testDb!.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
                                     is_sent_by_page, created_at, decoder_version, first_visible_at, confirm_due_at)
       values ($1, $2, $3, $4, false, clock_timestamp() - make_interval(mins => $5::int + 1), 1,
               clock_timestamp() - make_interval(mins => $5::int), clock_timestamp() + interval '194 seconds')`,
      [page.pageId, id, groupId, FAN, visibleMinutesAgo],
    );
    // Shown 10 min ago: not late yet.
    await liveMessage("910000000000000100", GROUP, 10);
    expect((await pass()).opened).toEqual([]);
    // In an excluded chat it does not count.
    await seedWsThread({ db: db(), pool: testDb.pool }, { pageId: page.pageId, groupId: "300000000000000002", fanRef: "200000000000000002", excluded: true });
    await liveMessage("910000000000000101", "300000000000000002");
    expect((await pass()).opened).toEqual([]);
    // Deferred (the parity window passed without a REST copy): no longer awaited.
    await liveMessage("910000000000000103", GROUP, 25 * 60);
    await testDb.pool.query(
      `update dm_live_messages set confirm_due_at = null, confirm_wait_reason = 'age_without_rest'
        where platform_message_id = '910000000000000103'`,
    );
    expect((await pass()).opened).toEqual([]);
    await liveMessage("910000000000000102", GROUP);
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "freshness", detail: "message_unconfirmed" }]);
  });

  it("alert 3: urgent work its own breaker holds pages nobody (row 362195); once the breaker ends, a row no pick takes does", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    const urgentRow = (subject: string, row: { dueMins: number; breakerMins: number; blocked: boolean }) => testDb!.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, due_at, coalesce_until, first_demand_at,
                              failure_count, breaker_until, blocked_by_vendor_at, waiting_reason)
       values ($1, false, 'dm-messages.head', $2, 'trigger', 'urgent', 'open',
               clock_timestamp() + make_interval(mins => $3::int), clock_timestamp() + make_interval(mins => $3::int),
               clock_timestamp() + make_interval(mins => $3::int), case when $5 then 8 else 1 end,
               clock_timestamp() + make_interval(mins => $4::int),
               case when $5 then clock_timestamp() - interval '4 days' end,
               case when $5 then 'blocked_by_vendor' else 'subject_breaker' end)`,
      [page.pageId, subject, row.dueMins, row.breakerMins, row.blocked],
    );
    // The vendor's block as a signal left it before this rule: due at a
    // first-signal cap five days old, the daily probe 16 h ahead. And a
    // subject breaker that holds the row for another minute.
    await urgentRow("blocked", { dueMins: -5 * 24 * 60, breakerMins: 16 * 60, blocked: true });
    await urgentRow("breaker", { dueMins: -10, breakerMins: 1, blocked: false });
    expect(await pass()).toMatchObject({ opened: [] });
    const freshness = async () => (await readSyncAlertStatus(db(), { registry, pages: await listSyncPages(db()) }))
      .pages.find((row) => row.mode === "live")!.conditions.find((entry) => entry.subKey === "freshness");
    expect(await freshness()).toBeUndefined();

    // The daily probe is 3 minutes overdue and no pick took it: it pages, from the probe's instant.
    await testDb.pool.query(
      `update sync_work set breaker_until = clock_timestamp() - interval '3 minutes' where page_id = $1 and subject = 'blocked'`,
      [page.pageId],
    );
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "freshness", detail: "urgent_waiting" }]);
    const [probe] = await query<{ breakerUntil: Date }>(
      `select breaker_until as "breakerUntil" from sync_work where page_id = $1 and subject = 'blocked'`,
      [page.pageId],
    );
    expect(await freshness()).toMatchObject({
      detail: "urgent_waiting",
      since: probe!.breakerUntil,
      reasons: [expect.objectContaining({ context: { works: 1, resources: ["dm-messages.head"] } })],
    });
  });

  it("the pace backstop opens the pace latch from the journal; only the owner's ack closes it, and an older violation never reopens it", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live", "lilly-1");
    await attempt({ pageId: page.pageId, sentSecondsAgo: 120 });
    await attempt({ pageId: page.pageId, sentSecondsAgo: 119.5 });
    const first = await pass();
    expect(first.paceViolations).toBe(1);
    const latch = await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId);
    expect(latch).toMatchObject({ status: "open", errorCode: "pace_violation" });
    // Alert 1's own latch is not the pace latch: it stays closed.
    expect(await incident("page_stopped", page.pageId)).toBeNull();
    expect((await pass()).resolved).toEqual([]);

    const ack = await acknowledgeSyncPaceViolations({ db: db(), logger }, {
      page: { pageId: page.pageId, pageLabel: "lilly-1" },
      actor: "test",
      note: "a test fixture",
    });
    expect(ack.wasOpen).toBe(true);
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "resolved" });
    expect(await query<{ eventType: string }>(
      "select event_type as \"eventType\" from audit_events where platform_account_id = $1",
      [page.pageId],
    )).toEqual([{ eventType: "admin.sync_alerts_ack" }]);

    // A restarted evaluator re-reads the last hour: the acknowledged pair stays closed.
    expect((await pass(evaluator())).paceViolations).toBe(1);
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "resolved" });

    // A new violation (sent after the acknowledgement) reopens it.
    await attempt({ pageId: page.pageId, sentSecondsAgo: -2 });
    await attempt({ pageId: page.pageId, sentSecondsAgo: -2.5 });
    await pass();
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "open" });
  });

  it("the incident sink: a pace violation opens the pace latch at once, resolve is the evaluator's", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    const sink = createIncidentAlertSink({ db: db(), logger });
    await sink.open({ subKey: "page_stopped", pageId: page.pageId, detail: "pace_violation", context: { attemptId: 1 } });
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "open" });
    await sink.open({ subKey: "page_stopped", pageId: page.pageId, detail: "rate_limit" });
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open", errorCode: "rate_limit" });
    await sink.resolve({ subKey: "page_stopped", pageId: page.pageId });
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open" });
    // A route's 429 opens the page+route latch; the next one refreshes it.
    await sink.open({ subKey: "route_limited", pageId: page.pageId, route: "media.offer_stats", detail: "rate_limit" });
    await sink.open({ subKey: "route_limited", pageId: page.pageId, route: "media.offer_stats", detail: "rate_limit" });
    expect(await query("select 1 from notification_incidents where incident_key = $1",
      [syncEngineIncidentKey({ subKey: syncEngineRouteSubKey("media.offer_stats"), pageId: page.pageId })])).toHaveLength(1);
    expect(await incident(syncEngineRouteSubKey("media.offer_stats"), page.pageId)).toMatchObject({ status: "open", errorCode: "rate_limit" });
  });

  it("the evaluator records every rule of a live page; a rule that throws keeps its latch and is recorded failing", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    const [{ before }] = await query<{ before: Date }>("select clock_timestamp() as before") as [{ before: Date }];
    await pass();
    const [{ after }] = await query<{ after: Date }>("select clock_timestamp() as after") as [{ after: Date }];
    const rows = await evaluations(page.pageId);
    expect(rows.map((row) => row.rule)).toEqual([...SYNC_ALERT_EVALUATION_RULES].sort());
    for (const row of rows) {
      expect(row, row.rule).toMatchObject({ failure: null, failedSince: null });
      // The pass's database clock, one instant for the page.
      expect(row.evaluatedAt!.getTime(), row.rule).toBe(row.attemptedAt.getTime());
      expect(row.evaluatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.evaluatedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    }

    // A poll row the stuck rule reads, and a registry whose spec throws for it:
    // the stuck latch the condition no longer holds stays open.
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state)
       values ($1, false, 'notifications.forward', '', 'poll', 'planned', 'open')`,
      [page.pageId],
    );
    await openPageLatch(page, "stuck", 20 * 60_000);
    const broken = {
      specs: registry.specs,
      spec: (resource: string) => {
        if (resource === "notifications.forward") throw new TypeError("the registry is broken");
        return registry.spec(resource);
      },
    };
    const evaluatedBefore = (await evaluation(page.pageId, "stuck"))!.evaluatedAt;
    const failing = await pass(new SyncAlertEvaluator({ db: db(), logger, registry: broken }));
    expect(failing.resolved).toEqual([]);
    expect(failing.unevaluated).toEqual([{ pageId: page.pageId, rule: "stuck", failure: "evaluate: TypeError: the registry is broken" }]);
    expect(await incident("stuck", page.pageId)).toMatchObject({ status: "open" });
    const stuck = (await evaluation(page.pageId, "stuck"))!;
    expect(stuck).toMatchObject({ failure: "evaluate: TypeError: the registry is broken", failedSince: stuck.attemptedAt });
    expect(stuck.evaluatedAt).toEqual(evaluatedBefore);
    expect(stuck.attemptedAt.getTime()).toBeGreaterThan(evaluatedBefore!.getTime());
    // The other rules were judged.
    expect((await evaluations(page.pageId)).filter((row) => row.failure !== null).map((row) => row.rule)).toEqual(["stuck"]);

    // A second failing pass keeps the streak's start.
    await pass(new SyncAlertEvaluator({ db: db(), logger, registry: broken }));
    expect((await evaluation(page.pageId, "stuck"))!.failedSince).toEqual(stuck.failedSince);

    // The registry mended: judged, the latch resolved at once (alert 4).
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "stuck" }]);
    expect(await incident("stuck", page.pageId)).toMatchObject({ status: "resolved" });
    const mended = (await evaluation(page.pageId, "stuck"))!;
    expect(mended).toMatchObject({ failure: null, failedSince: null });
    expect(mended.evaluatedAt).toEqual(mended.attemptedAt);
  });
});

describe("alert 4: the ledger the rescan's last certified round proved short (bug hunt Д1)", () => {
  // A page born by `createLiveSyncPage` alone (no birth work): the insurance
  // poll stores the newest 200 of 450 rows and escalates; the rescan's 7-day
  // round, certified, proves 250 missing — on its standing poll row, which
  // never closes.
  const OWN_ID = "300000000000000001";
  const LIFETIME = 450;
  const DAY_MS = 86_400_000;
  const BACKFILL = "transactions.backfill";
  const at = Date.now();
  const LEDGER = Array.from({ length: LIFETIME }, (_, index) => ({
    walletId: "wallet-1", transactionId: `tx-${String(index).padStart(4, "0")}`, accountId: OWN_ID, correlationId: null,
    correlationAccountId: null, type: 7001, destination: 1, amount: 10_000, destinationTax: 2_000, destinationAmount: 8_000,
    newBalance: null, newBalance64: 100_000, createdAt: at - (index + 1) * DAY_MS, updatedAt: null, status: 2, senderId: null,
    receiverId: OWN_ID,
  }));

  const param = (req: FanslyWireRequest, name: string) => Number(new URL(req.url).searchParams.get(name));
  /** The ledger as Fansly lists it, `total` always the lifetime's. */
  const ledgerPage = (req: FanslyWireRequest, rows = LEDGER): FanslyWireOutcome =>
    okResponse({ total: LIFETIME, data: rows.slice(param(req, "offset"), param(req, "offset") + param(req, "limit")) });

  async function livePage(label: string): Promise<number> {
    const model = await createModel(db(), { slug: `model-${label}`, name: label });
    const pageId = await testDb!.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const page = await createFanslyPage(tx, { modelId: model!.id, label });
      await applyAccountMeToPage(tx, {
        pageId: page!.id,
        account: { id: OWN_ID, username: "user_001", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 } as never,
        syncType: "light",
      });
      await createLiveSyncPage(tx, {
        pageId: page!.id, by: "onboarding:test", identityAccountId: OWN_ID, identityCheckedAt: new Date(),
        credentialsGeneration: "a".repeat(64),
      });
      return page!.id;
    });
    // The actor's first lap: the insurance due now, every other standing row parked.
    const page = (await getSyncPage(db(), pageId))!;
    await ensurePollRows(db(), {
      pageId, polls: pollsFor(registry, page).map((poll) => ({ ...poll, phase: poll.resource === "transactions.insurance" ? 0 : 0.999 })),
    });
    return pageId;
  }

  async function appliedAttempts(pageId: number, resource: string): Promise<number> {
    return (await query<{ n: number }>(
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'", [pageId, resource],
    ))[0]!.n;
  }

  async function workRow(pageId: number, resource: string) {
    return (await query<{
      state: string; closeReason: string | null; proof: Record<string, unknown> | null; result: Record<string, unknown> | null;
      cursor: Record<string, unknown>; lastServedAt: Date | null;
    }>(
      `select state, close_reason as "closeReason", proof, result, cursor, last_served_at as "lastServedAt"
         from sync_work where page_id = $1 and resource = $2 and not shadow order by id desc limit 1`,
      [pageId, resource],
    ))[0];
  }

  /** A fresh actor (a new owner generation: a restart) until `until`. */
  async function runActor(
    pageId: number,
    until: () => Promise<boolean>,
    respond: (req: FanslyWireRequest) => FanslyWireOutcome = (req) => ledgerPage(req),
    onHit: ((req: FanslyWireRequest) => Promise<void>) | null = null,
  ): Promise<void> {
    const transport = new ScriptedLiveTransport();
    transport.respond = respond;
    transport.onHit = onHit;
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, ownRef: OWN_ID });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await until()) ? true : null), 60_000, "the walk");
    } finally {
      stop.abort();
      await running;
    }
  }

  /** The next rescan round, now. */
  async function rescanRound(pageId: number, respond?: (req: FanslyWireRequest) => FanslyWireOutcome): Promise<void> {
    const before = await appliedAttempts(pageId, "transactions.rescan");
    await testDb!.pool.query(
      "update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'transactions.rescan' and state = 'open'", [pageId],
    );
    await runActor(pageId, async () => (await appliedAttempts(pageId, "transactions.rescan")) > before, respond);
  }

  const stuck = (result: Awaited<ReturnType<typeof pass>>, pageId: number) => ({
    opened: result.opened.filter((entry) => entry.pageId === pageId && entry.subKey === "stuck"),
    resolved: result.resolved.filter((entry) => entry.pageId === pageId && entry.subKey === "stuck"),
  });
  const LEDGER_OPENED = (pageId: number) => ({ opened: [{ pageId, subKey: "stuck", detail: "transactions_ledger_incomplete" }], resolved: [] });

  /** Alert 4's reason now, with its context (null: none). */
  async function ledgerReason(pageId: number) {
    const conditions = await collectPageAlerts(db(), { page: (await getSyncPage(db(), pageId))!, registry });
    return conditions.flatMap((condition) => condition.reasons).find((reason) => reason.detail === "transactions_ledger_incomplete") ?? null;
  }

  async function shortfall(pageId: number) {
    return (await readSyncJournalAlertFacts(db(), {
      pageId, stopLookbackMs: SYNC_ALERT_CLEAN_MS, urgentAfterMs: 120_000, requestStallMs: 1_800_000,
    })).ledgerIncomplete;
  }

  /** (i) The insurance's 200 rows, then a certified rescan round 250 short. */
  async function shortRound(label: string): Promise<{ pageId: number; roundStartedAt: Date }> {
    const pageId = await livePage(label);
    await runActor(pageId, async () => (await appliedAttempts(pageId, "transactions.rescan")) >= 1);
    const rescan = (await workRow(pageId, "transactions.rescan"))!;
    expect(rescan).toMatchObject({ state: "open", proof: { total: LIFETIME, ledgerRows: 200, ledgerIncomplete: 250, earlyStopped: true } });
    const fact = await shortfall(pageId);
    expect(fact).toEqual({ missing: 250, total: LIFETIME, ledgerRows: 200, roundStartedAt: new Date(String(rescan.proof!.walkStartedAt)) });
    expect(await query(`select 1 from sync_work where page_id = $1 and resource = '${BACKFILL}'`, [pageId])).toEqual([]);
    return { pageId, roundStartedAt: fact!.roundStartedAt };
  }

  it("(i)–(iv) a certified short round on the open poll row pages; a moving backfill, then one completed after the round began, explain it; the next whole round clears it", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, roundStartedAt } = await shortRound("ledger-short");
    // (i) Nothing walks the rest: alert 4 opens, since the round began.
    expect(stuck(await pass(), pageId)).toEqual(LEDGER_OPENED(pageId));
    expect(await ledgerReason(pageId)).toEqual({
      detail: "transactions_ledger_incomplete", since: roundStartedAt,
      context: { missing: 250, total: LIFETIME, ledgerRows: 200, backfill: "none" },
    });

    // (ii) The owner's backfill, open and moving (an answer applied just
    // now): explained, the latch resolves at once.
    await enqueueOwnerSyncWork(db(), registry, { pageLabel: "ledger-short", resource: BACKFILL, actor: "test" });
    const whileMoving: Array<ReturnType<typeof stuck>> = [];
    await runActor(pageId, async () => (await workRow(pageId, BACKFILL))?.state === "done", undefined, async () => {
      if ((await appliedAttempts(pageId, BACKFILL)) === 1) whileMoving.push(stuck(await pass(), pageId));
    });
    expect(whileMoving[0]).toEqual({ opened: [], resolved: [{ pageId, subKey: "stuck" }] });

    // (iii) It completed after the round began: the round's proof still says
    // 250, and that is explained until the next round.
    expect(await workRow(pageId, BACKFILL)).toMatchObject({ state: "done", closeReason: "backfill_complete", proof: { fetched: LIFETIME } });
    expect(await shortfall(pageId)).toMatchObject({ missing: 250, roundStartedAt });
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [] });
    expect(await ledgerReason(pageId)).toBeNull();

    // (iv) The next round reads the whole ledger: no shortfall at all.
    await rescanRound(pageId);
    expect((await workRow(pageId, "transactions.rescan"))!.proof).toMatchObject({ total: LIFETIME, ledgerRows: LIFETIME });
    expect(await shortfall(pageId)).toBeNull();
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [] });
  }, 120_000);

  it("(v) a withheld rescan round keeps the last certified round's proof: the alert stays open, through a restart too", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, roundStartedAt } = await shortRound("ledger-withheld");
    expect(stuck(await pass(), pageId)).toEqual(LEDGER_OPENED(pageId));
    const certified = (await workRow(pageId, "transactions.rescan"))!.proof;

    // Three empty answers that still state 450: two restarts, then withheld.
    const empty = () => okResponse({ total: LIFETIME, data: [] });
    for (let round = 0; round < 3; round += 1) await rescanRound(pageId, empty);
    const withheld = (await workRow(pageId, "transactions.rescan"))!;
    expect(withheld.state).toBe("open");
    expect(withheld.result).toMatchObject({ withheld: "total_mismatch", fetched: 0, total: LIFETIME });
    expect(withheld.cursor.last).toEqual(withheld.result);
    expect(withheld.proof).toEqual(certified);
    expect(await shortfall(pageId)).toMatchObject({ missing: 250, roundStartedAt });
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [] });
    expect(await incident("stuck", pageId)).toMatchObject({ status: "open", errorCode: "transactions_ledger_incomplete" });

    // Another actor (each round runs a new one), another empty answer: a
    // restart of the next round, the verdict unchanged.
    await rescanRound(pageId, empty);
    expect((await workRow(pageId, "transactions.rescan"))!.proof).toEqual(certified);
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [] });
    expect(await incident("stuck", pageId)).toMatchObject({ status: "open" });
  }, 120_000);

  it("(vi) a backfill that closed withheld after the round began explains nothing", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await shortRound("ledger-backfill-withheld");
    expect(stuck(await pass(), pageId)).toEqual(LEDGER_OPENED(pageId));
    await enqueueOwnerSyncWork(db(), registry, { pageLabel: "ledger-backfill-withheld", resource: BACKFILL, actor: "test" });
    // The last page is ten rows short of the stated total: withheld at once.
    const short = LEDGER.slice(0, LIFETIME - 10);
    await runActor(pageId, async () => (await workRow(pageId, BACKFILL))?.state === "done", (req) => ledgerPage(req, short));
    expect(await workRow(pageId, BACKFILL)).toMatchObject({
      state: "done", closeReason: "walk_withheld", proof: { withheld: "total_mismatch", fetched: LIFETIME - 10, total: LIFETIME },
    });
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [] });
    expect(await incident("stuck", pageId)).toMatchObject({ status: "open" });
    expect((await ledgerReason(pageId))?.context).toMatchObject({ missing: 250, backfill: "none" });
  }, 120_000);

  it("(vii) a backfill whose every read fails is stalled 30 min after its last applied answer, however recent its admissions", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await shortRound("ledger-backfill-stalled");
    expect(stuck(await pass(), pageId)).toEqual(LEDGER_OPENED(pageId));
    await enqueueOwnerSyncWork(db(), registry, { pageLabel: "ledger-backfill-stalled", resource: BACKFILL, actor: "test" });
    // Just queued: explained.
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [{ pageId, subKey: "stuck" }] });

    // Every backfill read is a network failure; the insurance (made due by
    // each of them) answers in between, so the failure streak restarts and
    // no network hold explains the wait.
    const failed = async () => (await query<{ n: number }>(
      `select count(*)::int as n from sync_attempts where page_id = $1 and resource = '${BACKFILL}' and error_class = 'network'`, [pageId],
    ))[0]!.n;
    await runActor(
      pageId,
      async () => (await failed()) >= 3,
      (req) => param(req, "limit") === 100 ? { kind: "transport_error", sent: true, message: "socket hang up" } : ledgerPage(req),
      async (req) => {
        if (param(req, "limit") !== 100) return;
        await testDb!.pool.query(
          "update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'transactions.insurance' and state = 'open'", [pageId],
        );
      },
    );
    expect(await appliedAttempts(pageId, BACKFILL)).toBe(0);
    expect(await query("select kind from sync_holds where page_id = $1 and scope = 'page'", [pageId])).toEqual([]);
    expect(stuck(await pass(), pageId)).toEqual({ opened: [], resolved: [] });

    // 31 minutes on (the row's own clock: no answer was ever applied). Its
    // admissions are recent — a stall counted from them would stay explained.
    await testDb.pool.query(
      `update sync_work set created_at = created_at - make_interval(secs => $2::double precision / 1000)
        where page_id = $1 and resource = '${BACKFILL}'`,
      [pageId, SYNC_LEDGER_BACKFILL_STALL_MS + 60_000],
    );
    const backfill = (await workRow(pageId, BACKFILL))!;
    expect(backfill.state).toBe("open");
    expect(Date.now() - backfill.lastServedAt!.getTime()).toBeLessThan(SYNC_LEDGER_BACKFILL_STALL_MS);
    expect(stuck(await pass(), pageId)).toEqual(LEDGER_OPENED(pageId));
    expect((await ledgerReason(pageId))?.context).toMatchObject({ missing: 250, backfill: "stalled" });
  }, 120_000);
});

describe("the owner's CLI: `sync alerts status | ack` (`cli/alerts.ts`)", () => {
  /** One `pnpm cli sync …` call on the test database; what it printed. */
  async function sync(argv: string[]): Promise<string[]> {
    const printed: string[] = [];
    const command = buildSyncAlertsCommandGroup({
      openContext: async () => ({ db: db(), logger: createLogger("silent"), close: async () => undefined }),
      print: (line) => void printed.push(line),
    });
    await command.parseAsync(argv, { from: "user" });
    return printed;
  }

  it("status prints what holds per page as JSON; ack closes the page's pace latch and records it; the page is required", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live", "lilly-1");
    await enginePage("shadow", "lilly-2", "100000000000000002");
    await attempt({ pageId: page.pageId, sentSecondsAgo: 120 });
    await attempt({ pageId: page.pageId, sentSecondsAgo: 119.5 });
    expect((await pass()).paceViolations).toBe(1);
    const paceKey = syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId: page.pageId });

    const status = JSON.parse((await sync(["alerts", "status"]))[0]!) as {
      pages: Array<{ page: string; mode: string; pages: boolean; openLatches: Array<{ key: string }> }>;
    };
    expect(status.pages.map((row) => [row.page, row.mode, row.pages, row.openLatches.map((latch) => latch.key)])).toEqual([
      ["lilly-1", "live", true, [paceKey]],
      ["lilly-2", "shadow", false, []],
    ]);
    const one = JSON.parse((await sync(["alerts", "status", "--page", "lilly-2"]))[0]!) as { pages: Array<{ page: string }> };
    expect(one.pages.map((row) => row.page)).toEqual(["lilly-2"]);

    await expect(sync(["alerts", "ack"])).rejects.toThrow("required option '--page <label>' not specified");
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "open" });
    expect((await sync(["alerts", "ack", "--page", "lilly-1", "--note", "looked"]))[0]).toMatch(/^lilly-1: pace latch resolved at /);
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "resolved" });
    expect(await query<{ eventType: string; note: string; actor: string }>(
      `select event_type as "eventType", metadata ->> 'note' as note, metadata ->> 'actor' as actor
         from audit_events where platform_account_id = $1`,
      [page.pageId],
    )).toEqual([{ eventType: "admin.sync_alerts_ack", note: "looked", actor: expect.stringMatching(/^cli@.+ pid \d+$/) }]);
    expect((await sync(["alerts", "ack", "--page", "lilly-1"]))[0]).toMatch(/^lilly-1: pace latch was not open at /);
  });

  it("is all that is left of the observability CLI: the shadow report is no command (step 4, S4-22)", async () => {
    await expect(sync(["shadow", "report", "--part", "b"])).rejects.toThrow(/unknown command/);
  });
});

describe("alert 5: the api watchdog (design §9.6)", () => {
  const app = () => ({ db: db(), config: { telegramEnabled: false }, logger: { info: () => {}, warn: () => {}, error: () => {} } }) as never;
  const pastGrace = () => Date.now() - 10 * 60_000;

  it("pages when a page is in the engine and no sync process beats; resolves on a beat or with every page off", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("off");
    expect(await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() })).toMatchObject({ syncEngineSilent: false });
    expect(await incident("process", null)).toBeNull();

    // A page left in shadow is not in the engine: no actor runs it.
    await setModeDirect(testDb.pool, page.pageId, "shadow");
    expect(await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() })).toMatchObject({ syncEngineSilent: false });
    expect(await incident("process", null)).toBeNull();

    await setModeDirect(testDb.pool, page.pageId, "live");
    // Inside the boot grace a silence opens nothing.
    expect(await runOpsWatchdogCheck(app(), { startedAtMs: Date.now() })).toMatchObject({ syncEngineSilent: true });
    expect(await incident("process", null)).toBeNull();
    await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
    expect(await incident("process", null)).toMatchObject({ status: "open", platformAccountId: null, errorCode: "heartbeat_silent" });

    await testDb.pool.query(
      "insert into runtime_instances (role, instance_id, started_at, last_seen_at, running) values ('sync', $1, now(), now(), '{}'::jsonb)",
      [randomUUID()],
    );
    expect(await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() })).toMatchObject({ syncEngineSilent: false });
    expect(await incident("process", null)).toMatchObject({ status: "resolved" });
  });
});

describe("the evaluator's own latch: the api watchdog reads its record (bug hunt Д11)", () => {
  const app = () => ({ db: db(), config: { telegramEnabled: false }, logger: { info: () => {}, warn: () => {}, error: () => {} } }) as never;
  const pastGrace = () => Date.now() - 10 * 60_000;
  const MINUTE = 60_000;

  /** A live page that went live 10 min ago. */
  async function livePage(label: string): Promise<WsCapturePage> {
    const page = await enginePage("live", label);
    await testDb!.pool.query("update sync_pages set mode_changed_at = clock_timestamp() - interval '10 minutes' where page_id = $1", [page.pageId]);
    return page;
  }

  /** A `sync` process beating now, started `startedMs` ago. */
  async function syncBeats(startedMs = 0): Promise<string> {
    const instanceId = randomUUID();
    await testDb!.pool.query(
      `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
       values ('sync', $1, now() - make_interval(secs => $2::double precision / 1000), now(), '{}'::jsonb)`,
      [instanceId, startedMs],
    );
    return instanceId;
  }

  const evaluatorLatch = () => incident(SYNC_ENGINE_EVALUATOR_SUBKEY, null);

  it("the api watchdog pages when a live page's alerts went unevaluated for 5 minutes, and resolves once they are evaluated", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("lora-1");
    const instance = await syncBeats();
    // Nothing recorded yet: inside the api's boot grace nothing opens.
    expect(await runOpsWatchdogCheck(app(), { startedAtMs: Date.now() })).toMatchObject({ syncEngineSilent: false });
    expect(await evaluatorLatch()).toBeNull();
    await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
    expect(await evaluatorLatch()).toMatchObject({
      status: "open", platformAccountId: null, errorCode: "unrecorded", kind: "fansly_sync_engine",
      errorSummary: expect.stringContaining("lora-1: page_stopped, live_degraded, freshness, stuck, route_limited, pace_audit — never recorded"),
    });

    // One real pass of the evaluator: the next check resolves it.
    await pass();
    await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
    expect(await evaluatorLatch()).toMatchObject({ status: "resolved" });

    // A `sync` restarted a minute ago over rows older than 5 minutes: the
    // restart resets nothing, the latch opens (`late`).
    await ageEvaluations(page.pageId, 6 * MINUTE);
    await testDb.pool.query("update runtime_instances set started_at = now() - interval '1 minute' where instance_id = $1", [instance]);
    await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
    expect(await evaluatorLatch()).toMatchObject({ status: "open", errorCode: "late", errorSummary: expect.stringContaining("lora-1: ") });

    // A failing rule is the heaviest; the summary names the page, the rule and the error.
    await testDb.pool.query(
      `update sync_alert_evaluations set failure = 'journal: database query failed (57014)', failed_since = attempted_at
        where page_id = $1 and rule = 'stuck'`,
      [page.pageId],
    );
    await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
    const failing = await evaluatorLatch();
    expect(failing).toMatchObject({ status: "open", errorCode: "failing" });
    expect(failing!.errorSummary).toMatch(/^lora-1: stuck — journal: database query failed \(57014\) since \d\d:\d\dZ; lora-1: /);

    // `sync` silent: alert 5's; the evaluator latch is left as it is.
    await testDb.pool.query("update runtime_instances set last_seen_at = now() - interval '10 minutes' where instance_id = $1", [instance]);
    const seen = failing!.lastSeenAt;
    expect(await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() })).toMatchObject({ syncEngineSilent: true });
    expect(await incident("process", null)).toMatchObject({ status: "open" });
    expect(await evaluatorLatch()).toMatchObject({ status: "open", errorCode: "failing", lastSeenAt: seen });
  });

  it("a resolve that keeps failing wakes the api watchdog, and the condition's return pages again once the latch has closed", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage("lora-2");
    await syncBeats();
    await pass();
    const evaluatedAt = (await evaluation(page.pageId, "stuck"))!.evaluatedAt;
    expect(evaluatedAt).not.toBeNull();

    // A stuck latch, paged, whose condition has not held for 20 minutes …
    await openPageLatch(page, "stuck", 20 * MINUTE);
    const stuckKey = syncEngineIncidentKey({ subKey: "stuck", pageId: page.pageId });
    const sweepApp = { db: db(), logger: quietLogger } as never;
    await runNotificationPagingSweep(sweepApp, { now: new Date() });
    // … and a resolve that cannot land (its recovery tombstone refused).
    await testDb.pool.query(`create function refuse_stuck_recovery() returns trigger language plpgsql as $$
      begin if new.incident_key like '%:stuck' then raise exception 'injected deadlock' using errcode = '40P01'; end if; return new; end $$;
      create trigger refuse_stuck_recovery before insert or update on notification_incident_recoveries
        for each row execute function refuse_stuck_recovery()`);
    try {
      const failing = await pass();
      expect(failing.resolved).toEqual([]);
      expect(failing.unevaluated).toEqual([{ pageId: page.pageId, rule: "stuck", failure: "resolve: database query failed (40P01)" }]);
      expect(await incident("stuck", page.pageId)).toMatchObject({ status: "open" });
      expect(await evaluation(page.pageId, "stuck")).toMatchObject({ failure: "resolve: database query failed (40P01)", evaluatedAt });

      // Five minutes on: the watchdog opens its latch.
      await ageEvaluations(page.pageId, 6 * MINUTE);
      await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
      const latch = await evaluatorLatch();
      expect(latch).toMatchObject({ status: "open", errorCode: "failing" });
      expect(latch!.errorSummary).toContain("lora-2: stuck — resolve: database query failed (40P01)");
    } finally {
      await testDb.pool.query("drop trigger refuse_stuck_recovery on notification_incident_recoveries; drop function refuse_stuck_recovery()");
    }

    // The resolve lands: the pass closes `stuck`, the watchdog its own latch.
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "stuck" }]);
    expect(await evaluation(page.pageId, "stuck")).toMatchObject({ failure: null, failedSince: null });
    await runOpsWatchdogCheck(app(), { startedAtMs: pastGrace() });
    expect(await evaluatorLatch()).toMatchObject({ status: "resolved" });

    // The sweep closes the page after the recovery hold; the condition's
    // return then pages again.
    const resolvedAt = (await incident("stuck", page.pageId))!.resolvedAt!;
    await runNotificationPagingSweep(sweepApp, { now: new Date(resolvedAt.getTime() + 6 * MINUTE) });
    await notifySyncEngineIncident({ db: db(), logger }, {
      subKey: "stuck", pageId: page.pageId, pageLabel: page.label, detail: "request_stalled", errorSummary: "request_stalled", occurredAt: new Date(),
    });
    await runNotificationPagingSweep(sweepApp, { now: new Date(resolvedAt.getTime() + 7 * MINUTE) });
    const outbox = await query<{ transition: string }>(
      `select o.transition from notification_delivery_outbox o
         join notification_incidents n on n.id = o.notification_incident_id
        where n.incident_key = $1 order by o.id`,
      [stuckKey],
    );
    expect(outbox.map((row) => row.transition)).toEqual(["opened", "resolved", "reopened"]);
  });
});

describe("the golden signals (design §9.5)", () => {
  it("computes one page's pace and queue families, and the sampler's compact set over the engine's pages", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await attempt({ pageId: page.pageId, sentSecondsAgo: 30, workClass: "urgent", resource: "dm-messages.head" });
    await attempt({ pageId: page.pageId, sentSecondsAgo: 29 });
    await attempt({ pageId: page.pageId, sentSecondsAgo: 20 });
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, breaker_until)
       values ($1, false, 'dm-messages.head', '1', 'trigger', 'urgent', 'open', clock_timestamp() + interval '1 hour')`,
      [page.pageId],
    );
    // A credentials hold, a network hold beside it and a file's breaker in
    // force: each is counted (a breaker that ended is not).
    await seedPageHold(testDb, { pageId: page.pageId, kind: "auth", untilSeconds: "infinity" });
    await seedPageHold(testDb, { pageId: page.pageId, kind: "network", untilSeconds: 60 });
    await replaceHoldRows(testDb, page.pageId, "resource", [
      resourceBreakerRow("transactions", new Date(Date.now() + 60_000)),
      resourceBreakerRow("posts", new Date(Date.now() - 1_000)),
    ]);
    // What shadow mode left behind — on this page and on one still in shadow —
    // is in no family.
    const left = await enginePage("shadow", "left-in-shadow", "100000000000000002");
    for (const pageId of [page.pageId, left.pageId]) {
      await attempt({ pageId, shadow: true, sentSecondsAgo: 25 });
      await attempt({ pageId, shadow: true, sentSecondsAgo: 24.9 });
      await testDb.pool.query(
        `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, breaker_until)
         values ($1, true, 'dm-messages.head', '1', 'trigger', 'urgent', 'open', clock_timestamp() + interval '1 hour')`,
        [pageId],
      );
    }
    const row = (await listSyncPages(db())).find((candidate) => candidate.pageId === page.pageId);
    const metrics = await computeSyncMetrics(db(), { page: row!, windowMs: 3_600_000 });
    expect(metrics).toMatchObject({
      mode: "live",
      sends: { urgent: 1, planned: 2, total: 3, byResource: { "dm-messages.head": 1, "notifications.forward": 2 } },
      paceViolations: 1,
      holds: { page: ["auth", "network"], resources: ["transactions"] },
      breakersOpen: 1,
    });
    expect(metrics).not.toHaveProperty("journal");
    expect(metrics.minSendGapMs).toBeGreaterThan(900);
    expect(metrics.minSendGapMs).toBeLessThan(1_100);

    const samples = await sampleSyncEngineMetrics(db(), { registry, settingMs: 2_000 });
    const value = (metric: string) => samples.find((sample) => sample.metric === metric && sample.quantile === "p95")?.valueMs;
    expect(value("sync_setting_ms")).toBe(2_000);
    expect(value("sync_sends")).toBe(3);
    expect(value("sync_pace_violations")).toBe(1);
    expect(value("sync_holds")).toBe(3);
    expect(value("sync_breakers_open")).toBe(1);
    expect(value("sync_min_send_gap_ms")).toBeLessThan(1_100);
    // The shadow families are gone with the mode.
    expect(samples.filter((sample) => sample.metric.startsWith("sync_" + "shadow"))).toEqual([]);

    // The worker records them only when asked (every 5 minutes).
    const app = { db: db(), config: testConfig(testDb.connectionString), logger: { ...quietLogger, warn: () => {} } } as never;
    await runGoldenSignalSample(app);
    expect(await query("select 1 from ops_metric_samples where metric = 'sync_sends'")).toEqual([]);
    const sampled = await runGoldenSignalSample(app, { syncEngine: true });
    expect(sampled.breaches).not.toContain(SYNC_ENGINE_METRICS_PROBE);
    expect(await query<{ value: string }>(
      "select value_ms::text as value from ops_metric_samples where metric = 'sync_sends' and quantile = 'p95'",
    )).toEqual([{ value: "3" }]);
  });
});

describe("alert 4: a work failing without an outcome (bug hunt Д3/У2)", () => {
  // The real actor, commit paths and evaluator; only the module step under
  // test is wrapped to fail (SIL-2 of the bug hunt).
  const MINUTE = 60_000;

  /** A live page the actor can step: an open receiver socket, a beating
   *  owner, the send guard the engine's and a known identity. */
  async function actorPage(): Promise<WsCapturePage> {
    const page = await enginePage("live");
    await ensureFanslyPageSendGuard(db(), page.pageId);
    await testDb!.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [page.pageId]);
    await testDb!.pool.query(
      "update pages set metadata = $2::jsonb, last_verified_at = clock_timestamp() where id = $1",
      [page.pageId, JSON.stringify({ accountCreatedAt: "2026-08-15T00:00:00.000Z" })],
    );
    return page;
  }

  function registryWith(overrides: Record<string, (real: ResourceModule) => ResourceModule>): EngineRegistry {
    return createEngineRegistry(FANSLY_RESOURCE_SPECS.map((spec) => {
      const wrap = overrides[spec.key];
      if (wrap === undefined || spec.module === undefined) return spec;
      const load = spec.module;
      return { ...spec, module: async () => wrap(await load()) };
    }));
  }

  /** Every standing row of the page, parked (the step under test alone runs). */
  async function parkStandingRows(pageId: number): Promise<void> {
    const page = await getSyncPage(db(), pageId);
    await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
  }

  async function makeDue(pageId: number, resource: string, extra: { subject?: string; messageIds?: string[] } = {}) {
    const spec = fanslyResourceSpec(resource)!;
    return upsertDemand(db(), {
      pageId,
      resource,
      kind: spec.kind,
      class: spec.class,
      ...(extra.subject === undefined ? {} : { subject: extra.subject }),
      ...(extra.messageIds === undefined ? {} : { demand: { messageIds: extra.messageIds, txIds: [], reasons: ["test"], overflow: false } }),
    });
  }

  async function workRow(pageId: number, resource: string, subject = "") {
    return (await query<{
      state: string; waitingReason: string | null; lastErrorClass: string | null; failingSince: Date | null; dueInMs: number;
    }>(
      `select state, waiting_reason as "waitingReason", last_error_class as "lastErrorClass", failing_since as "failingSince",
              (extract(epoch from due_at - updated_at) * 1000)::float8 as "dueInMs"
         from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow order by id desc limit 1`,
      [pageId, resource, subject],
    ))[0] ?? null;
  }

  /** The actor (a new owner generation) until `until` holds. */
  async function runActor(
    pageId: number,
    actorRegistry: EngineRegistry,
    until: () => Promise<boolean>,
    respond: (req: FanslyWireRequest) => FanslyWireOutcome = () => okResponse(),
  ): Promise<void> {
    const transport = new ScriptedLiveTransport();
    transport.respond = respond;
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry: actorRegistry, transport, ownRef: OWN });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await until()) ? true : null), 30_000, "the step");
    } finally {
      stop.abort();
      await running;
    }
    // The owner beats on (alert 1 is not under test).
    await testDb!.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [pageId]);
  }

  /** Alert 4's reasons now (detail and context). */
  async function stuckReasons(pageId: number) {
    const conditions = await collectPageAlerts(db(), { page: (await getSyncPage(db(), pageId))!, registry });
    return conditions.find((condition) => condition.subKey === "stuck")?.reasons ?? [];
  }

  const opened = (result: Awaited<ReturnType<typeof pass>>, pageId: number) =>
    result.opened.filter((entry) => entry.pageId === pageId && entry.subKey === "stuck");
  const resolved = (result: Awaited<ReturnType<typeof pass>>, pageId: number) =>
    result.resolved.filter((entry) => entry.pageId === pageId && entry.subKey === "stuck");

  async function ageFailing(pageId: number, resource: string, ms: number): Promise<void> {
    await testDb!.pool.query(
      "update sync_work set failing_since = failing_since - make_interval(secs => $3::double precision / 1000) where page_id = $1 and resource = $2",
      [pageId, resource, ms],
    );
  }

  it("a plan that keeps throwing pages step_failing after 5 min, naming its key; a plan with an outcome ends it and the latch closes", async (context) => {
    if (!testDb) return context.skip();
    const page = await actorPage();
    let broken = true;
    const actorRegistry = registryWith({
      "dm-conversations.find": (real) => ({
        ...real,
        plan: async (work, ctx) => {
          if (broken) throw new TypeError("a bug in the plan");
          return { kind: "wait", reason: "not_due", until: new Date(ctx.now.getTime() + 60 * MINUTE) };
        },
      }),
    });
    await parkStandingRows(page.pageId);
    await makeDue(page.pageId, "dm-conversations.find", { subject: GROUP, messageIds: ["910000000000000011"] });
    await runActor(page.pageId, actorRegistry, async () =>
      (await workRow(page.pageId, "dm-conversations.find", GROUP))?.lastErrorClass === "plan:TypeError");
    const failing = (await workRow(page.pageId, "dm-conversations.find", GROUP))!;
    expect(failing).toMatchObject({ state: "open", waitingReason: "dependency" });
    expect(failing.failingSince).not.toBeNull();
    expect(failing.dueInMs).toBeGreaterThan(59_000);
    expect(failing.dueInMs).toBeLessThan(61_000);
    // Younger than 5 min: nothing yet.
    expect(opened(await pass(), page.pageId)).toEqual([]);

    await ageFailing(page.pageId, "dm-conversations.find", 6 * MINUTE);
    expect(opened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "step_failing" }]);
    expect((await incident("stuck", page.pageId))!.errorSummary).toContain("dm-conversations.find");
    expect(await stuckReasons(page.pageId)).toEqual([expect.objectContaining({
      detail: "step_failing",
      context: { works: 1, resources: ["dm-conversations.find"], errors: ["plan:TypeError"] },
    })]);

    // The plan is fixed: its next step has an outcome (a wait), the series ends.
    broken = false;
    await testDb.pool.query("update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'dm-conversations.find'", [page.pageId]);
    await runActor(page.pageId, actorRegistry, async () =>
      (await workRow(page.pageId, "dm-conversations.find", GROUP))?.failingSince === null);
    expect(await workRow(page.pageId, "dm-conversations.find", GROUP)).toMatchObject({ state: "open", failingSince: null });
    expect(resolved(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck" }]);
  }, 90_000);

  it("a local step that keeps failing transiently (57014) pages step_failing after 5 min", async (context) => {
    if (!testDb) return context.skip();
    const page = await actorPage();
    let failures = 0;
    const actorRegistry = registryWith({
      "dm-live.deletions": (real) => ({
        ...real,
        applyLocal: async () => {
          failures += 1;
          throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        },
      }),
    });
    await parkStandingRows(page.pageId);
    await makeDue(page.pageId, "dm-live.deletions", { subject: GROUP, messageIds: ["910000000000000031"] });
    await runActor(page.pageId, actorRegistry, async () =>
      failures >= 1 && (await workRow(page.pageId, "dm-live.deletions", GROUP))?.lastErrorClass === "local:57014");
    const row = (await workRow(page.pageId, "dm-live.deletions", GROUP))!;
    expect(row).toMatchObject({ state: "open", waitingReason: "dependency" });
    expect(row.failingSince).not.toBeNull();

    await ageFailing(page.pageId, "dm-live.deletions", 6 * MINUTE);
    expect(opened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "step_failing" }]);
    expect(await stuckReasons(page.pageId)).toEqual([expect.objectContaining({
      detail: "step_failing",
      context: { works: 1, resources: ["dm-live.deletions"], errors: ["local:57014"] },
    })]);
  }, 90_000);

  it("a journaled answer whose apply keeps failing transiently pages apply_pending 5 min after its admission", async (context) => {
    if (!testDb) return context.skip();
    const page = await actorPage();
    let failures = 0;
    const actorRegistry = registryWith({
      "transactions.head": (real) => ({
        ...real,
        apply: async () => {
          failures += 1;
          throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
        },
      }),
    });
    await parkStandingRows(page.pageId);
    await makeDue(page.pageId, "transactions.head");
    const tx = {
      walletId: "wallet-1", transactionId: "tx-head-1", accountId: OWN, correlationId: null, correlationAccountId: null,
      type: 7001, destination: 1, amount: 10_000, destinationTax: 2_000, destinationAmount: 8_000, newBalance: null,
      newBalance64: 100_000, createdAt: Date.now() - 3_600_000, updatedAt: null, status: 1, senderId: null, receiverId: OWN,
    };
    await runActor(page.pageId, actorRegistry, async () => failures >= 1 && (await query<{ n: number }>(
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'transactions.head' and apply_state = 'deferred'",
      [page.pageId],
    ))[0]!.n === 1, () => okResponse({ total: 1, data: [tx] }));
    expect(await workRow(page.pageId, "transactions.head")).toMatchObject({ state: "running" });
    // The deferral counts nothing and no step failed: no series, no step_failing.
    expect((await workRow(page.pageId, "transactions.head"))!.failingSince).toBeNull();
    expect(opened(await pass(), page.pageId)).toEqual([]);

    await testDb.pool.query(
      "update sync_attempts set admitted_at = admitted_at - interval '6 minutes' where page_id = $1 and resource = 'transactions.head'",
      [page.pageId],
    );
    expect(opened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "apply_pending" }]);
    const attempts = await query<{ id: number }>("select id::int from sync_attempts where page_id = $1 and resource = 'transactions.head'", [page.pageId]);
    expect(await stuckReasons(page.pageId)).toEqual([expect.objectContaining({
      detail: "apply_pending",
      context: { attempts: attempts.map((row) => row.id), resources: ["transactions.head"] },
    })]);
    expect((await incident("stuck", page.pageId))!.errorSummary).toContain("transactions.head");
  }, 90_000);

  it("a paused key's failing works never hide another key's failure", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    const catchup = fanslyResourceSpec("dm-messages.catchup")!;
    await upsertDemands(db(), Array.from({ length: 201 }, (_, index) => ({
      pageId: page.pageId,
      resource: "dm-messages.catchup",
      subject: `4000000000${String(index).padStart(8, "0")}`,
      kind: catchup.kind,
      class: catchup.class,
    })));
    await testDb.pool.query(
      `update sync_work set failing_since = clock_timestamp() - interval '10 minutes', last_error_class = 'local:57014'
        where page_id = $1 and resource = 'dm-messages.catchup'`,
      [page.pageId],
    );
    await testDb.pool.query("update sync_pages set paused_resources = array['dm-messages.catchup'] where page_id = $1", [page.pageId]);
    await makeDue(page.pageId, "dm-live.deletions", { subject: GROUP, messageIds: ["910000000000000041"] });
    await testDb.pool.query(
      `update sync_work set failing_since = clock_timestamp() - interval '6 minutes', last_error_class = 'local:57014'
        where page_id = $1 and resource = 'dm-live.deletions'`,
      [page.pageId],
    );

    // One fact row per key, however many works the paused one has.
    const facts = await readSyncStepAlertFacts(db(), { pageId: page.pageId, failingAfterMs: 5 * MINUTE, applyPendingAfterMs: 5 * MINUTE });
    expect(facts.failing.map((row) => ({ resource: row.resource, works: row.works, errorClasses: row.errorClasses }))).toEqual([
      { resource: "dm-messages.catchup", works: 201, errorClasses: ["local:57014"] },
      { resource: "dm-live.deletions", works: 1, errorClasses: ["local:57014"] },
    ]);
    expect(facts.applyPending).toEqual([]);

    expect(opened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "step_failing" }]);
    expect(await stuckReasons(page.pageId)).toEqual([expect.objectContaining({
      detail: "step_failing",
      context: { works: 1, resources: ["dm-live.deletions"], errors: ["local:57014"] },
    })]);
    const summary = (await incident("stuck", page.pageId))!.errorSummary;
    expect(summary).toContain("dm-live.deletions");
    expect(summary).not.toContain("dm-messages.catchup");
  }, 60_000);

  it("the owner's requests pause explains a failing history read; lifted, it pages", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    await makeDue(page.pageId, "dm-messages.history", { subject: GROUP });
    await testDb.pool.query(
      `update sync_work set failing_since = clock_timestamp() - interval '6 minutes', last_error_class = 'plan:TypeError'
        where page_id = $1 and resource = 'dm-messages.history'`,
      [page.pageId],
    );
    await testDb.pool.query("update sync_pages set paused_requests = true where page_id = $1", [page.pageId]);
    expect(opened(await pass(), page.pageId)).toEqual([]);
    expect(await stuckReasons(page.pageId)).toEqual([]);

    await testDb.pool.query("update sync_pages set paused_requests = false where page_id = $1", [page.pageId]);
    expect(opened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "step_failing" }]);
    expect(await stuckReasons(page.pageId)).toEqual([expect.objectContaining({
      detail: "step_failing",
      context: { works: 1, resources: ["dm-messages.history"], errors: ["plan:TypeError"] },
    })]);
  }, 60_000);

  it("controls: a repair's real wait for the work it spawned ends a series and pages nothing; a paused key pages nothing", async (context) => {
    if (!testDb) return context.skip();
    const page = await actorPage();
    await parkStandingRows(page.pageId);
    // The repair's pass spawned a chat head that has not been served yet.
    await makeDue(page.pageId, "dm-messages.head", { subject: GROUP, messageIds: ["910000000000000051"] });
    await testDb.pool.query(
      "update sync_work set due_at = clock_timestamp() + interval '1 hour' where page_id = $1 and resource = 'dm-messages.head'",
      [page.pageId],
    );
    await makeDue(page.pageId, "repair.ws-gap");
    await testDb.pool.query(
      `update sync_work
          set cursor = $2::jsonb,
              failing_since = clock_timestamp() - interval '10 minutes',
              due_at = clock_timestamp()
        where page_id = $1 and resource = 'repair.ws-gap'`,
      [page.pageId, JSON.stringify({
        phase: "wait",
        pass: { since: new Date(Date.now() - 60 * MINUTE).toISOString(), targets: [], startedRevision: 1 },
        offset: 0,
        pageCount: 1,
        spawned: [{ resource: "dm-messages.head", subject: GROUP }],
        waitStartedAt: new Date().toISOString(),
      })],
    );
    await runActor(page.pageId, registry, async () => (await workRow(page.pageId, "repair.ws-gap"))?.waitingReason === "dependency");
    expect(await workRow(page.pageId, "repair.ws-gap")).toMatchObject({ state: "open", waitingReason: "dependency", failingSince: null });
    expect(opened(await pass(), page.pageId)).toEqual([]);
    expect(await stuckReasons(page.pageId)).toEqual([]);

    // A failing key the owner paused pages nothing.
    await makeDue(page.pageId, "dm-live.deletions", { subject: GROUP, messageIds: ["910000000000000052"] });
    await testDb.pool.query(
      "update sync_work set failing_since = clock_timestamp() - interval '6 minutes' where page_id = $1 and resource = 'dm-live.deletions'",
      [page.pageId],
    );
    await testDb.pool.query("update sync_pages set paused_resources = array['dm-live.deletions'] where page_id = $1", [page.pageId]);
    expect(opened(await pass(), page.pageId)).toEqual([]);
    expect(await stuckReasons(page.pageId)).toEqual([]);
  }, 90_000);

  it("planned_stale judges a poll by its newest applied answer, not by its admissions", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    const [insurance] = await query<{ id: number }>(
      "select id::int from sync_work where page_id = $1 and resource = 'transactions.insurance' and state = 'open'", [page.pageId],
    );
    // Admitted a minute ago, its newest applied answer 5 min past the SLO
    // (the registry's: 45 min since the owner's decision of 09.10, У8).
    const appliedAgoS = (fanslyResourceSpec("transactions.insurance")!.slo!.staleAfterMs! + 5 * MINUTE) / 1000;
    await testDb.pool.query(
      `update sync_work set last_served_at = clock_timestamp() - interval '1 minute', created_at = clock_timestamp() - interval '1 day'
        where id = $1`,
      [insurance!.id],
    );
    await testDb.pool.query(
      `insert into sync_attempts (page_id, work_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                  admitted_at, sent_at, send_mark, completed_at, operation, request, outcome, http_status,
                                  apply_state, applied_at)
       values ($1, $2, 'transactions.insurance', '', 'planned', 1, 2000, 0, 2000,
               clock_timestamp() - make_interval(secs => $3::float8 + 1), clock_timestamp() - make_interval(secs => $3::float8 + 1),
               'request_start', clock_timestamp() - make_interval(secs => $3::float8), 'transactions.page', '{}'::jsonb, 'response', 200,
               'applied', clock_timestamp() - make_interval(secs => $3::float8))`,
      [page.pageId, insurance!.id, appliedAgoS],
    );
    expect(opened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "planned_stale" }]);
    expect(await stuckReasons(page.pageId)).toEqual([expect.objectContaining({
      detail: "planned_stale",
      context: { resources: ["transactions.insurance"] },
    })]);
    expect((await incident("stuck", page.pageId))!.errorSummary).toContain('"resources":["transactions.insurance"]');
  }, 60_000);
});

describe("bug hunt Д5: planned demand past its SLO; a file breaker's arms", () => {
  // Alert 4's `planned_stale` judges a planned goal or trigger with an SLO by
  // its demand: unserved past the SLO while the key applied no answer for as
  // long. A file's breaker explains a wait on its first arm only.
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  /** The planned goal/trigger keys with an SLO alert 4 judges by their demand. */
  const DEMAND_KEYS = ["dm-messages.catchup", "fan-earnings.roster", "followers.reconcile", "purchases.targets"];
  /** The standing walks: an SLO declared, not judged (plan §3.4). */
  const STANDING_WALKS = ["catalog.vault", "media-stats.walk", "post-replies.walk", "posts.engagement"];
  const PURCHASES = "purchases.targets";

  /** Every standing row of the page, parked. */
  async function parkStandingRows(pageId: number): Promise<void> {
    const page = await getSyncPage(db(), pageId);
    await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
  }

  /** A demand of `resource` (reason `test`), as its trigger would leave the row. */
  async function makeDue(pageId: number, resource: string, subject?: string, messageIds: string[] = []) {
    const spec = fanslyResourceSpec(resource)!;
    return upsertDemand(db(), {
      pageId,
      resource,
      kind: spec.kind,
      class: spec.class,
      ...(subject === undefined ? {} : { subject }),
      demand: { messageIds, reasons: ["test"] },
    });
  }

  /** A demand signal of purchases as its producer emits it (`purchaseTargetFollowups`). */
  async function purchaseDemand(pageId: number, targetId: string, reason: string) {
    const [signal] = purchaseTargetFollowups([{ kind: "media", id: targetId }], reason);
    return upsertDemand(db(), demandToUpsert(signal!, fanslyResourceSpec(PURCHASES)!, { pageId, now: new Date() })!);
  }

  /** Time passes for a work row: demanded, created and due `ms` earlier. */
  async function ageDemand(workId: number, ms: number): Promise<void> {
    await testDb!.pool.query(
      `update sync_work set first_demand_at = clock_timestamp() - make_interval(secs => $2::double precision / 1000),
              created_at = clock_timestamp() - make_interval(secs => $2::double precision / 1000),
              due_at = clock_timestamp() - make_interval(secs => $2::double precision / 1000)
        where id = $1`,
      [workId, ms],
    );
  }

  /** Another walk of purchases, closed, whose answer applied `ms` ago: the key moves. */
  async function closedWalkApplied(pageId: number, targetId: string, ms: number): Promise<void> {
    const { id } = await makeDue(pageId, PURCHASES, `media:${targetId}`);
    await testDb!.pool.query(
      `update sync_work set state = 'done', closed_at = clock_timestamp(), close_reason = 'empty_page', applied_revision = demand_revision
        where id = $1`,
      [id],
    );
    await testDb!.pool.query(
      `insert into sync_attempts (page_id, work_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                  admitted_at, sent_at, send_mark, completed_at, operation, request, outcome, http_status,
                                  apply_state, applied_at)
       values ($1, $2, $3, $4, 'planned', 1, 2000, 0, 2000,
               clock_timestamp() - make_interval(secs => $5::double precision / 1000 + 1),
               clock_timestamp() - make_interval(secs => $5::double precision / 1000 + 1),
               'request_start', clock_timestamp() - make_interval(secs => $5::double precision / 1000),
               'media.order_history', '{}'::jsonb, 'response', 200,
               'applied', clock_timestamp() - make_interval(secs => $5::double precision / 1000))`,
      [pageId, id, PURCHASES, `media:${targetId}`, ms],
    );
  }

  /** Time passes for the key's attempts: every instant `ms` earlier. */
  async function ageAttempts(pageId: number, resource: string, ms: number): Promise<void> {
    await testDb!.pool.query(
      `update sync_attempts
          set admitted_at = admitted_at - make_interval(secs => $3::double precision / 1000),
              sent_at = sent_at - make_interval(secs => $3::double precision / 1000),
              completed_at = completed_at - make_interval(secs => $3::double precision / 1000),
              applied_at = applied_at - make_interval(secs => $3::double precision / 1000)
        where page_id = $1 and resource = $2`,
      [pageId, resource, ms],
    );
  }

  /** An open chat-unavailability episode of the thread, as the actor leaves it. */
  async function episode(threadId: number, state: "refusing" | "established"): Promise<void> {
    await testDb!.pool.query(
      `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, refusals, last_refusal_at,
              last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
              first_observation_received_at, last_observation_id, last_observation_received_at)
       values ($1, $2::text, now() - interval '7 hours', case when $2::text = 'established' then now() - interval '1 hour' end,
               case when $2::text = 'established' then 5 else 1 end, now() - interval '1 hour', 500,
               case when $2::text = 'established' then now() + interval '23 hours' end,
               41, 45, 901, now() - interval '7 hours', 905, now() - interval '1 hour')`,
      [threadId, state],
    );
  }

  /** What `sync alerts status` says holds for the page now. */
  async function conditionsOf(pageId: number) {
    const status = await readSyncAlertStatus(db(), { registry, pages: (await listSyncPages(db())).filter((row) => row.pageId === pageId) });
    return status.pages[0]!.conditions;
  }

  async function reasonOf(pageId: number, subKey: string, detail: string) {
    return (await conditionsOf(pageId)).find((entry) => entry.subKey === subKey)?.reasons.find((entry) => entry.detail === detail) ?? null;
  }

  /** Alert 4's `planned_stale` now (null: none). */
  async function plannedStale(pageId: number): Promise<{ since: Date | null; resources: string[] } | null> {
    const reason = await reasonOf(pageId, "stuck", "planned_stale");
    return reason === null ? null : { since: reason.since, resources: reason.context!.resources as string[] };
  }

  const stuckOpened = (result: Awaited<ReturnType<typeof pass>>, pageId: number) =>
    result.opened.filter((entry) => entry.pageId === pageId && entry.subKey === "stuck");

  it("the four demand-driven keys page planned_stale past their SLO; the standing walks do not", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    await makeDue(page.pageId, "fan-earnings.roster");
    await makeDue(page.pageId, "followers.reconcile");
    await makeDue(page.pageId, PURCHASES, "media:910000000000000001");
    await makeDue(page.pageId, "dm-messages.catchup", GROUP);
    // Every one of them, the four walks and the poll `stats.daily`: demanded,
    // created, admitted and due 4 days ago; no applied answer on the page.
    const aged = [...DEMAND_KEYS, ...STANDING_WALKS, "stats.daily"];
    await testDb.pool.query(
      `update sync_work set first_demand_at = clock_timestamp() - interval '4 days', created_at = clock_timestamp() - interval '4 days',
              last_served_at = clock_timestamp() - interval '4 days', due_at = clock_timestamp() - interval '4 days'
        where page_id = $1 and resource = any($2::text[])`,
      [page.pageId, aged],
    );
    expect(await query("select 1 from sync_work where page_id = $1 and resource = any($2::text[]) and state = 'open'", [page.pageId, aged]))
      .toHaveLength(aged.length);
    const stale = await plannedStale(page.pageId);
    expect(new Set(stale?.resources)).toEqual(new Set([...DEMAND_KEYS, "stats.daily"]));
    for (const walk of STANDING_WALKS) expect(stale?.resources).not.toContain(walk);
  }, 60_000);

  it("an overdue demand the vendor, a refused chat, a pause or its key's progress explains pages nobody", async (context) => {
    if (!testDb) return context.skip();
    let pages = 0;
    /** A clean live page with one demand of `resource`, 2 days old. */
    async function overdue(resource: string, subject: string): Promise<{ pageId: number; workId: number }> {
      pages += 1;
      const page = await enginePage("live", `d5-${pages}`, `10000000000000${1000 + pages}`);
      await parkStandingRows(page.pageId);
      const { id } = await makeDue(page.pageId, resource, subject);
      await ageDemand(id, 2 * DAY);
      return { pageId: page.pageId, workId: id };
    }
    const setWork = (workId: number, set: string) => testDb!.pool.query(`update sync_work set ${set} where id = $1`, [workId]);
    const TARGET = "media:910000000000000001";

    // Control: as it stands, it pages.
    const control = await overdue(PURCHASES, TARGET);
    expect(await plannedStale(control.pageId)).toMatchObject({ resources: [PURCHASES] });

    // The vendor blocks the subject.
    const blocked = await overdue(PURCHASES, TARGET);
    await setWork(blocked.workId, "blocked_by_vendor_at = clock_timestamp() - interval '1 day'");
    expect(await plannedStale(blocked.pageId)).toBeNull();
    // Its own breaker stands for another hour.
    const held = await overdue(PURCHASES, TARGET);
    await setWork(held.workId, "breaker_until = clock_timestamp() + interval '1 hour'");
    expect(await plannedStale(held.pageId)).toBeNull();
    // Its own breaker ended an hour ago: it waits from there, not from its first demand.
    const ended = await overdue(PURCHASES, TARGET);
    await setWork(ended.workId, "breaker_until = clock_timestamp() - interval '1 hour'");
    expect(await plannedStale(ended.pageId)).toBeNull();
    // A chat with an open unavailability episode, refusing or established.
    for (const state of ["refusing", "established"] as const) {
      const refused = await overdue("dm-messages.catchup", GROUP);
      expect(await plannedStale(refused.pageId), state).toMatchObject({ resources: ["dm-messages.catchup"] });
      await episode(await seedWsThread({ db: db(), pool: testDb.pool }, { pageId: refused.pageId, groupId: GROUP, fanRef: FAN }), state);
      expect(await plannedStale(refused.pageId), state).toBeNull();
    }
    // The owner's pause of the key, of the page; a network hold of the page.
    const paused = await overdue(PURCHASES, TARGET);
    await testDb.pool.query("update sync_pages set paused_resources = array['purchases.targets'] where page_id = $1", [paused.pageId]);
    expect(await plannedStale(paused.pageId)).toBeNull();
    const pausedAll = await overdue(PURCHASES, TARGET);
    await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [pausedAll.pageId]);
    expect(await plannedStale(pausedAll.pageId)).toBeNull();
    const network = await overdue(PURCHASES, TARGET);
    await seedPageHold(testDb, { pageId: network.pageId, kind: "network", untilSeconds: 60 });
    expect(await plannedStale(network.pageId)).toBeNull();
    // The key applied an answer within its SLO (another, closed walk of it).
    const moving = await overdue(PURCHASES, TARGET);
    await closedWalkApplied(moving.pageId, "910000000000000002", HOUR);
    expect(await plannedStale(moving.pageId)).toBeNull();
    // Control: that answer admitted 13 h ago (SLO 12 h) is no progress.
    await ageAttempts(moving.pageId, PURCHASES, 12 * HOUR);
    expect(await plannedStale(moving.pageId)).toMatchObject({ resources: [PURCHASES] });
  }, 120_000);

  it("a paused key's overdue rows never hide another key's overdue demand", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    const purchases = fanslyResourceSpec(PURCHASES)!;
    await upsertDemands(db(), Array.from({ length: 201 }, (_, index) => ({
      pageId: page.pageId,
      resource: PURCHASES,
      subject: `media:9100000000${String(index).padStart(8, "0")}`,
      kind: purchases.kind,
      class: purchases.class,
      demand: { reasons: ["test"] },
    })));
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '2 days' where page_id = $1 and resource = $2",
      [page.pageId, PURCHASES],
    );
    await testDb.pool.query("update sync_pages set paused_resources = array['purchases.targets'] where page_id = $1", [page.pageId]);
    const { id } = await makeDue(page.pageId, "dm-messages.catchup", GROUP);
    await ageDemand(id, 7 * HOUR);

    // One fact row per key, however many rows the paused one has.
    const facts = await readSyncPlannedDemandAlertFacts(db(), { pageId: page.pageId, slos: plannedDemandSlos(registry) });
    expect(facts.stale.map((row) => ({ resource: row.resource, works: row.works }))).toEqual([
      { resource: PURCHASES, works: 201 },
      { resource: "dm-messages.catchup", works: 1 },
    ]);

    expect(stuckOpened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "planned_stale" }]);
    expect((await plannedStale(page.pageId))?.resources).toEqual(["dm-messages.catchup"]);
    const summary = (await incident("stuck", page.pageId))!.errorSummary;
    expect(summary).toContain("dm-messages.catchup");
    expect(summary).not.toContain(PURCHASES);
  }, 60_000);

  it("a sale merged into a history load's row waits behind the load, not from the load's start", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    // The history load's demand for the target, 13 h ago (SLO 12 h); the load
    // moves: another target's walk applied its answer 10 min ago.
    const { id } = await purchaseDemand(page.pageId, "910000000000000001", "transactions.backfill");
    await ageDemand(id, 13 * HOUR);
    await closedWalkApplied(page.pageId, "910000000000000002", 10 * MINUTE);
    // A new sale of the target, as the socket router signals it, merges into
    // the load's row: its first demand stays the load's.
    const sale = await purchaseDemand(page.pageId, "910000000000000001", "ws:order");
    const [row] = await query<{ firstDemandAt: Date; reasons: string[] }>(
      `select first_demand_at as "firstDemandAt", demand -> 'reasons' as reasons from sync_work where id = $1`,
      [id],
    );
    expect(sale).toMatchObject({ id, created: false, demandRevision: 2 });
    expect([...row!.reasons].sort()).toEqual(["transactions.backfill", "ws:order"]);
    expect(Date.now() - row!.firstDemandAt.getTime()).toBeGreaterThan(13 * HOUR - MINUTE);
    expect(await plannedStale(page.pageId)).toBeNull();

    // Control: the load's last applied answer admitted 13 h ago — it stopped,
    // and the row pages from its first demand.
    await ageAttempts(page.pageId, PURCHASES, 13 * HOUR);
    expect(await plannedStale(page.pageId)).toEqual({ since: row!.firstDemandAt, resources: [PURCHASES] });
  }, 60_000);

  it("a walk that resumes after the vendor's block is not stale while its pages apply", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await ensureFanslyPageSendGuard(db(), page.pageId);
    await testDb.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [page.pageId]);
    await testDb.pool.query(
      "update pages set metadata = $2::jsonb, last_verified_at = clock_timestamp() where id = $1",
      [page.pageId, JSON.stringify({ accountCreatedAt: "2026-08-15T00:00:00.000Z" })],
    );
    await parkStandingRows(page.pageId);
    const targetId = "880000000000000002";
    const { id } = await makeDue(page.pageId, PURCHASES, `media:${targetId}`);
    // Demanded 2 days ago; the vendor blocked it a day ago and its daily probe is due now.
    await ageDemand(id, 2 * DAY);
    await testDb.pool.query(
      `update sync_work set failure_count = 5, blocked_by_vendor_at = clock_timestamp() - interval '1 day',
              breaker_until = clock_timestamp() - interval '1 second', due_at = clock_timestamp() - interval '1 second',
              waiting_reason = 'blocked_by_vendor'
        where id = $1`,
      [id],
    );
    // Fansly answers with a page of orders, and with older ones below each:
    // the walk goes on, its row open with unserved demand.
    const order = (orderId: number) => ({
      orderId: String(orderId), accountId: "500000000000000011", accountMediaId: targetId, createdAt: Math.floor(Date.now() / 1000) - 60, type: 1,
    });
    const transport = new ScriptedLiveTransport();
    transport.respond = (req) => {
      const before = new URL(req.url).searchParams.get("before");
      const head = before === null ? 9_100 : Number(before) - 1;
      return okResponse({ accountMediaOrderHistory: [order(head), order(head - 1)] });
    };
    const applied = async () => (await query<{ n: number }>(
      "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'", [page.pageId, PURCHASES],
    ))[0]!.n;
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId: page.pageId, registry, transport, ownRef: OWN });
    const running = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await applied()) >= 1 ? true : null), 30_000, "the probe's applied page");
    } finally {
      stop.abort();
      await running;
    }
    await testDb.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [page.pageId]);

    // The applied page lifted the vendor's block and the breaker; the walk goes on below it.
    const [row] = await query<{
      state: string; blockedByVendorAt: Date | null; breakerUntil: Date | null; appliedRevision: number; demandRevision: number;
      cursor: { before?: unknown };
    }>(
      `select state, blocked_by_vendor_at as "blockedByVendorAt", breaker_until as "breakerUntil",
              applied_revision::int as "appliedRevision", demand_revision::int as "demandRevision", cursor
         from sync_work where id = $1`,
      [id],
    );
    expect(row).toMatchObject({ blockedByVendorAt: null, breakerUntil: null });
    expect(["open", "running"]).toContain(row!.state);
    expect(row!.appliedRevision).toBeLessThan(row!.demandRevision);
    expect(row!.cursor.before).toEqual(expect.any(String));
    // Its demand is 2 days old and nothing holds it any more, but the key applies.
    expect(stuckOpened(await pass(), page.pageId)).toEqual([]);
    expect(await plannedStale(page.pageId)).toBeNull();

    // Control: its applied pages 13 h old (SLO 12 h).
    await ageAttempts(page.pageId, PURCHASES, 13 * HOUR);
    expect(await plannedStale(page.pageId)).toMatchObject({ resources: [PURCHASES] });
  }, 90_000);

  it("the evaluator opens stuck for an overdue catch-up and resolves it once served", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    const { id } = await makeDue(page.pageId, "dm-messages.catchup", GROUP);
    await ageDemand(id, 7 * HOUR);
    expect(stuckOpened(await pass(), page.pageId)).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "planned_stale" }]);
    expect((await incident("stuck", page.pageId))!.errorSummary).toContain('"resources":["dm-messages.catchup"]');

    // Served: the next pass resolves the latch at once (alert 4).
    await testDb.pool.query("update sync_work set applied_revision = demand_revision where id = $1", [id]);
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "stuck" }]);
    expect(await incident("stuck", page.pageId)).toMatchObject({ status: "resolved" });
  }, 60_000);

  it("a file breaker explains the waits on its first arm only", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await parkStandingRows(page.pageId);
    // A new chat's find due 10 min ago, and the list head unread for 2 h (SLO 90 min).
    await makeDue(page.pageId, "dm-conversations.find", GROUP, ["910000000000000007"]);
    await testDb.pool.query(
      `update sync_work set due_at = clock_timestamp() - interval '10 minutes', first_demand_at = clock_timestamp() - interval '10 minutes',
              waiting_reason = null
        where page_id = $1 and resource = 'dm-conversations.find'`,
      [page.pageId],
    );
    await testDb.pool.query(
      `update sync_work set created_at = clock_timestamp() - interval '2 hours', last_served_at = clock_timestamp() - interval '2 hours'
        where page_id = $1 and resource = 'dm-conversations.head'`,
      [page.pageId],
    );
    const breaker = (step: number) =>
      replaceHoldRows(testDb!, page.pageId, "resource", [resourceBreakerRow("dm-conversations", new Date(Date.now() + 25 * MINUTE), { step })]);

    // The first arm (30 min): a short trouble of the file explains both waits.
    await breaker(1);
    const first = await conditionsOf(page.pageId);
    expect(first.find((entry) => entry.subKey === "freshness")).toBeUndefined();
    expect(first.find((entry) => entry.subKey === "stuck")).toBeUndefined();

    // Back before any success (2 h): nobody else pages for the file, so its keys do.
    await breaker(2);
    expect((await reasonOf(page.pageId, "freshness", "urgent_waiting"))?.context).toMatchObject({ resources: ["dm-conversations.find"] });
    expect(await plannedStale(page.pageId)).toMatchObject({ resources: ["dm-conversations.head"] });
  }, 60_000);
});
