import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getNotificationIncidentByKey, listSyncPages, type Database } from "@agency_hub_core/db";

import { runGoldenSignalSample, SYNC_ENGINE_METRICS_PROBE } from "../apps/runtime/src/services/golden-signals.ts";
import { SYNC_ENGINE_PACE_VIOLATION_SUBKEY, syncEngineIncidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { runOpsWatchdogCheck } from "../apps/runtime/src/services/ops-watchdog.ts";
import {
  acknowledgeSyncPaceViolations,
  createIncidentAlertSink,
  readSyncAlertStatus,
  SYNC_ALERT_CLEAN_MS,
  SyncAlertEvaluator,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import { computeSyncMetrics, sampleSyncEngineMetrics } from "../apps/runtime/src/sync/engine/metrics.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, wsTransaction, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { quietLogger, setModeDirect, testConfig } from "./helpers/sync-engine-host.ts";

// The Fansly Sync Engine's alerts and golden signals against a real database
// (plan §10, design §9.5, §9.6): the evaluator opens and resolves latches of
// handover/live pages only, alerts 1–3 wait 10 clean minutes (alert 4 none),
// the pace latch is the owner's to close, alert 5 is the api watchdog's, and
// the sampler's compact set.

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
async function enginePage(mode: "shadow" | "live" | "handover" | "off", label?: string): Promise<WsCapturePage> {
  const page = await seedWsCapturePage({ db: db(), pool: testDb!.pool }, { ownRef: OWN, ...(label === undefined ? {} : { label }) });
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

async function attempt(input: {
  pageId: number;
  shadow: boolean;
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
      input.pageId, input.shadow, input.resource ?? "notifications.forward", input.workClass ?? "planned",
      input.settingMs ?? 2_000, input.sentSecondsAgo, input.shadow ? "shadow" : "request_start",
      input.shadow ? "shadow" : "response", input.errorClass ?? null,
    ],
  );
}

describe("the alert evaluator (design §9.6)", () => {
  it("pages a live page's 429 hold, keeps alert 1 for 10 clean minutes, then resolves it", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await testDb.pool.query(
      `update sync_pages set hold_kind = 'rate_limit', hold_until = clock_timestamp() + interval '1 minute',
              hold_since = clock_timestamp() where page_id = $1`,
      [page.pageId],
    );
    const first = await pass();
    expect(first.opened).toEqual([{ pageId: page.pageId, subKey: "page_stopped", detail: "rate_limit" }]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open", errorCode: "rate_limit", kind: "fansly_sync_engine" });

    // The hold ended, but a 429 answered 5 min ago: not clean yet.
    await testDb.pool.query("update sync_pages set hold_kind = null, hold_until = null, hold_since = null where page_id = $1", [page.pageId]);
    await attempt({ pageId: page.pageId, shadow: false, sentSecondsAgo: 300, errorClass: "rate_limit" });
    expect((await pass()).resolved).toEqual([]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open" });

    // The 429 is 11 min old, but the hold was seen in force moments ago: the
    // ten clean minutes count from there.
    await testDb.pool.query("update sync_attempts set admitted_at = admitted_at - interval '6 minutes' where page_id = $1", [page.pageId]);
    expect((await pass()).resolved).toEqual([]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open" });

    // Ten clean minutes.
    await ageLatch("page_stopped", page.pageId, SYNC_ALERT_CLEAN_MS);
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "page_stopped" }]);
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "resolved" });
  });

  it("alert 1 opened from the journal alone (the capture path's open lost) resolves 10 min after the 429", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    await attempt({ pageId: page.pageId, shadow: false, sentSecondsAgo: 9 * 60, errorClass: "rate_limit" });
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "page_stopped", detail: "rate_limit" }]);
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

  it("alerts 2 and 3 resolve only after 10 clean minutes, so a condition that comes and goes keeps one page; alert 4 resolves at once", async (context) => {
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

    // Alert 4: progress resumes ⇒ resolved on the next pass.
    const rescan = (proof: Record<string, unknown>) => testDb!.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, proof, closed_at)
       values ($1, false, 'transactions.rescan', '', 'goal', 'planned', 'done', $2::jsonb, clock_timestamp())`,
      [page.pageId, JSON.stringify(proof)],
    );
    await rescan({ ledgerIncomplete: 3 });
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "stuck", detail: "transactions_ledger_incomplete" }]);
    await rescan({});
    expect((await pass()).resolved).toEqual([{ pageId: page.pageId, subKey: "stuck" }]);
  });

  it("pages nothing for a shadow page, and resolves the latches of a page set back to shadow or off", async (context) => {
    if (!testDb) return context.skip();
    const shadow = await enginePage("shadow");
    await testDb.pool.query(
      `update sync_pages set hold_kind = 'auth', hold_until = 'infinity', hold_since = clock_timestamp() where page_id = $1`,
      [shadow.pageId],
    );
    expect((await pass()).opened).toEqual([]);
    expect(await incident("page_stopped", shadow.pageId)).toBeNull();
    // Its conditions are visible to the owner as metrics and in `sync alerts status`.
    const status = await readSyncAlertStatus(db(), { registry, pages: await listSyncPages(db()) });
    expect(status.pages.find((row) => row.mode === "shadow")).toMatchObject({
      pages: false,
      conditions: [expect.objectContaining({ subKey: "page_stopped", detail: "auth" })],
    });

    await setModeDirect(testDb.pool, shadow.pageId, "live");
    await testDb.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [shadow.pageId]);
    expect((await pass()).opened).toEqual([{ pageId: shadow.pageId, subKey: "page_stopped", detail: "auth" }]);
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
    await liveMessage("910000000000000102", GROUP);
    expect((await pass()).opened).toEqual([{ pageId: page.pageId, subKey: "freshness", detail: "message_unconfirmed" }]);
  });

  it("the pace backstop opens the pace latch from the journal; only the owner's ack closes it, and an older violation never reopens it", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live", "lilly-1");
    await attempt({ pageId: page.pageId, shadow: false, sentSecondsAgo: 120 });
    await attempt({ pageId: page.pageId, shadow: false, sentSecondsAgo: 119.5 });
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
    await attempt({ pageId: page.pageId, shadow: false, sentSecondsAgo: -2 });
    await attempt({ pageId: page.pageId, shadow: false, sentSecondsAgo: -2.5 });
    await pass();
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "open" });
  });

  it("the incident sink: a shadow alert pages nothing, a live pace violation opens the pace latch at once, resolve is the evaluator's", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("live");
    const sink = createIncidentAlertSink({ db: db(), logger });
    await sink.open({ subKey: "page_stopped", pageId: page.pageId, detail: "rate_limit", shadow: true });
    expect(await query("select 1 from notification_incidents")).toEqual([]);
    await sink.open({ subKey: "page_stopped", pageId: page.pageId, detail: "pace_violation", shadow: false, context: { attemptId: 1 } });
    expect(await incident(SYNC_ENGINE_PACE_VIOLATION_SUBKEY, page.pageId)).toMatchObject({ status: "open" });
    await sink.open({ subKey: "page_stopped", pageId: page.pageId, detail: "rate_limit", shadow: false });
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open", errorCode: "rate_limit" });
    await sink.resolve({ subKey: "page_stopped", pageId: page.pageId });
    expect(await incident("page_stopped", page.pageId)).toMatchObject({ status: "open" });
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

    await setModeDirect(testDb.pool, page.pageId, "shadow");
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

describe("the golden signals (design §9.5)", () => {
  it("computes one page's pace and queue families, and the sampler's compact set per journal", async (context) => {
    if (!testDb) return context.skip();
    const page = await enginePage("shadow");
    await attempt({ pageId: page.pageId, shadow: true, sentSecondsAgo: 30, workClass: "urgent", resource: "dm-messages.head" });
    await attempt({ pageId: page.pageId, shadow: true, sentSecondsAgo: 29 });
    await attempt({ pageId: page.pageId, shadow: true, sentSecondsAgo: 20 });
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, breaker_until)
       values ($1, true, 'dm-messages.head', '1', 'trigger', 'urgent', 'open', clock_timestamp() + interval '1 hour')`,
      [page.pageId],
    );
    const [row] = await listSyncPages(db());
    const metrics = await computeSyncMetrics(db(), { page: row!, windowMs: 3_600_000 });
    expect(metrics).toMatchObject({
      journal: "shadow",
      sends: { urgent: 1, planned: 2, total: 3, byResource: { "dm-messages.head": 1, "notifications.forward": 2 } },
      paceViolations: 1,
      breakersOpen: 1,
    });
    expect(metrics.minSendGapMs).toBeGreaterThan(900);
    expect(metrics.minSendGapMs).toBeLessThan(1_100);

    const samples = await sampleSyncEngineMetrics(db(), { registry, settingMs: 2_000 });
    const value = (metric: string) => samples.find((sample) => sample.metric === metric && sample.quantile === "p95")?.valueMs;
    expect(value("sync_setting_ms")).toBe(2_000);
    expect(value("sync_shadow_sends")).toBe(3);
    expect(value("sync_shadow_pace_violations")).toBe(1);
    expect(value("sync_shadow_breakers_open")).toBe(1);
    expect(value("sync_shadow_min_send_gap_ms")).toBeLessThan(1_100);
    // No page is switched: no live journal series.
    expect(samples.some((sample) => sample.metric === "sync_sends")).toBe(false);

    // The worker records them only when asked (every 5 minutes).
    const app = { db: db(), config: testConfig(testDb.connectionString), logger: { ...quietLogger, warn: () => {} } } as never;
    await runGoldenSignalSample(app);
    expect(await query("select 1 from ops_metric_samples where metric = 'sync_shadow_sends'")).toEqual([]);
    const sampled = await runGoldenSignalSample(app, { syncEngine: true });
    expect(sampled.breaches).not.toContain(SYNC_ENGINE_METRICS_PROBE);
    expect(await query<{ value: string }>(
      "select value_ms::text as value from ops_metric_samples where metric = 'sync_shadow_sends' and quantile = 'p95'",
    )).toEqual([{ value: "3" }]);
  });
});
