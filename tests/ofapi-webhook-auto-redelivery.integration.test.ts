import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertObservation, setConfigOverride, upsertOfapiWebhookConfig } from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { computeGoldenSignals, runGoldenSignalSample } from "../apps/runtime/src/services/golden-signals.ts";
import { incidentTitleForKind, resolveMessageForIncident } from "../apps/runtime/src/services/notification-incidents.ts";
import { OfapiApiError, type OfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  OFAPI_AUTO_REDELIVERY_EVENT_TYPES, redeliverOfapiWebhook, runOfapiWebhookAutoRedelivery, sweepOfapiWebhookDeliveryHistory,
} from "../apps/runtime/src/services/ofapi-webhook-recovery.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// H2 (amends #265): automatic redelivery of undelivered business webhooks and
// the delivery-history collector's catch-up/coverage signal. Every vendor
// request is a mock; nothing here reaches the network.

let testDb: StartedTestDatabase;
let app: AppContext;
let ownerId: number;
let observationId: number;
let observationReceivedAt: Date;
let historyRows: Record<string, unknown>[];
const read = vi.fn(); const send = vi.fn();
const WEBHOOK = "wh_auto";
const MINUTE = 60_000;
const CAP_KEY = "ofapi_burn_rate:global:auto_redelivery_cap";

async function capture(body: unknown, kind: string) {
  const text = JSON.stringify(body);
  const row = await insertObservation(app.db, { source: "operator", producer: "ofapi:admin", platform: "onlyfans",
    kind, payload: { body: text }, payloadHash: createHash("sha256").update(text).digest(), idempotencyKey: randomUUID() });
  return { body, capture: { observationId: row.observationId, receivedAt: row.receivedAt } };
}
let nextAttemptId = 1;
async function attempt(input: { key: string | null; event?: string; minutesAgo: number; succeeded?: boolean }) {
  const attemptId = nextAttemptId++;
  await testDb.pool.query(`insert into ofapi_webhook_delivery_attempts
    (webhook_id,attempt_id,delivery_uuid,event_type,attempt_number,succeeded,status_code,idempotency_key,ofapi_account_id,
     source_created_at,observation_id,observation_received_at)
    values($1,$2,$3,$4,1,$5,$6,$7,'acct_auto',now()-make_interval(secs => $8),$9,$10)`,
  [WEBHOOK, attemptId, `delivery-${input.key ?? attemptId}`, input.event ?? "messages.received", input.succeeded ?? false,
    input.succeeded ? 200 : 503, input.key, input.minutesAgo * 60, observationId, observationReceivedAt]);
  return attemptId;
}
async function enableAt(minutesAgo: number) {
  app.config.ofapiWebhookAutoRedeliveryEnabled = true;
  await testDb.pool.query(`insert into ofapi_webhook_auto_redelivery_state(id,enabled_at) values(true,now()-make_interval(secs => $1))
    on conflict(id) do update set enabled_at=excluded.enabled_at`, [minutesAgo * 60]);
}
async function intents() {
  return (await testDb.pool.query(`select attempt_id::float8 as attempt_id,origin,actor_user_id::float8 as actor_user_id,business_key,state
    from ofapi_webhook_redelivery_intents order by created_at,attempt_id`)).rows;
}
async function incident(key: string) {
  return (await testDb.pool.query("select status,error_summary from notification_incidents where incident_key=$1", [key])).rows[0];
}
const sentAttempts = () => send.mock.calls.map(call => call[1]);

beforeAll(async () => {
  const started = await startIntegrationTestDatabase(); if (!started) throw new Error("Auto-redelivery tests require PostgreSQL"); testDb = started;
}, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  await testDb.pool.query("insert into ofapi_webhook_collection_policy(id) values(true) on conflict do nothing");
  await createUserAccount(app, { username: "auto-owner", role: "owner", password: "test-owner-password" }, { source: "cli" });
  ownerId = Number((await testDb.pool.query("select id from users where username='auto-owner'")).rows[0].id);
  const evidence = await insertObservation(app.db, { source: "operator", producer: "ofapi:admin", platform: "onlyfans",
    kind: "ofapi_webhook_deliveries", payload: { body: "{}" }, payloadHash: createHash("sha256").update("{}").digest(), idempotencyKey: randomUUID() });
  observationId = evidence.observationId; observationReceivedAt = evidence.receivedAt;
  nextAttemptId = 1; historyRows = [];
  read.mockReset().mockImplementation(async (_id: string, params: { offset: number; limit: number }) => {
    const data = historyRows.slice(params.offset, params.offset + params.limit);
    return capture({ data, _pagination: { next_page: historyRows.length > params.offset + data.length ? "continuation" : null } }, "ofapi_webhook_deliveries");
  });
  send.mockReset().mockImplementation(async (webhookId: string, attemptId: number) =>
    capture({ data: { webhook_id: webhookId, delivery_id: attemptId, redelivery_id: `redelivery-${attemptId}` } }, "ofapi_webhook_redelivery"));
  app.ofapi = {
    getCredentialPreflight: async () => ({ status: "verified", expectedTeam: "test-team", observedTeam: "test-team", credentialFingerprint: "test-fingerprint",
      checkedAt: new Date().toISOString(), reason: null, rosterScope: "unknown" }),
    listWebhookDeliveries: read, redeliverWebhookDelivery: send,
  } as unknown as OfapiClient;
  await upsertOfapiWebhookConfig(app.db, { externalWebhookId: WEBHOOK, endpointUrl: "https://example.test/webhook", accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS], encryptedSigningSecret: JSON.stringify(encryptJson("auto-secret", app.config.encryptionKey, app.config.encryptionKeyVersion)) });
});

describe("OFAPI webhook auto-redelivery", () => {
  it("is off by default, persists the moment it is first seen on, and forgets it when switched off", async () => {
    await attempt({ key: "evt_before", minutesAgo: 30 });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false });
    expect((await testDb.pool.query("select count(*)::int n from ofapi_webhook_auto_redelivery_state where enabled_at is not null")).rows[0].n).toBe(0);

    app.config.ofapiWebhookAutoRedeliveryEnabled = true;
    await runOfapiWebhookAutoRedelivery(app);
    const first = (await testDb.pool.query("select enabled_at, now()-enabled_at < interval '1 minute' as fresh from ofapi_webhook_auto_redelivery_state")).rows[0];
    expect(first.fresh).toBe(true);
    await runOfapiWebhookAutoRedelivery(app);
    expect((await testDb.pool.query("select enabled_at from ofapi_webhook_auto_redelivery_state")).rows[0].enabled_at).toEqual(first.enabled_at);
    // The failure happened before the switch was seen on: never automatic.
    expect(send).not.toHaveBeenCalled();
    expect((await testDb.pool.query("select event_type,actor_user_id from audit_events where event_type like 'system.ofapi_webhook_auto_redelivery_%'")).rows)
      .toEqual([{ event_type: "system.ofapi_webhook_auto_redelivery_enabled", actor_user_id: null }]);

    app.config.ofapiWebhookAutoRedeliveryEnabled = false;
    await runOfapiWebhookAutoRedelivery(app);
    expect((await testDb.pool.query("select enabled_at from ofapi_webhook_auto_redelivery_state")).rows).toEqual([{ enabled_at: null }]);
    // Switching on again records a new moment; the old failure stays manual.
    app.config.ofapiWebhookAutoRedeliveryEnabled = true;
    await runOfapiWebhookAutoRedelivery(app);
    const second = (await testDb.pool.query("select enabled_at from ofapi_webhook_auto_redelivery_state")).rows[0].enabled_at;
    expect(second.getTime()).toBeGreaterThan(first.enabled_at.getTime());
    expect((await testDb.pool.query("select event_type from audit_events where event_type like 'system.ofapi_webhook_auto_redelivery_%' order by id")).rows
      .map(row => row.event_type)).toEqual(["system.ofapi_webhook_auto_redelivery_enabled", "system.ofapi_webhook_auto_redelivery_disabled",
      "system.ofapi_webhook_auto_redelivery_enabled"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("reads the switch and the cap through the live config overlay", async () => {
    await setConfigOverride(app.db, { key: "ofapiWebhookAutoRedeliveryEnabled", value: true, userId: ownerId, groupId: randomUUID() });
    await setConfigOverride(app.db, { key: "ofapiWebhookAutoRedeliveryDailyCap", value: 1, userId: ownerId, groupId: randomUUID() });
    await runOfapiWebhookAutoRedelivery(app);
    expect((await testDb.pool.query("select count(*)::int n from ofapi_webhook_auto_redelivery_state where enabled_at is not null")).rows[0].n).toBe(1);
    await testDb.pool.query("update ofapi_webhook_auto_redelivery_state set enabled_at=now()-interval '2 hours'");
    await attempt({ key: "evt_live_first", minutesAgo: 60 });
    await attempt({ key: "evt_live_second", minutesAgo: 30 });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: true });
  });

  it("selects only quiet, retained, receipt-less business failures after the enable moment, nearest to expiry first", async () => {
    await enableAt(9 * 24 * 60);
    const older = await attempt({ key: "evt_renewed", event: "subscriptions.renewed", minutesAgo: 50 });
    await attempt({ key: "evt_received", minutesAgo: 40 });
    const newest = await attempt({ key: "evt_received", minutesAgo: 30 });
    await attempt({ key: "evt_presence", event: "users.online", minutesAgo: 30 });
    await attempt({ key: "evt_recent", event: "messages.sent", minutesAgo: 5 });
    await attempt({ key: "evt_spans_enable", event: "tips.received", minutesAgo: 9 * 24 * 60 + 60 });
    await attempt({ key: "evt_spans_enable", event: "tips.received", minutesAgo: 30 });
    await attempt({ key: "evt_recovered", event: "transactions.new", minutesAgo: 30 });
    await attempt({ key: "evt_recovered", event: "transactions.new", minutesAgo: 20, succeeded: true });
    await attempt({ key: "evt_receipt", event: "subscriptions.new", minutesAgo: 30 });
    await testDb.pool.query(`insert into ofapi_webhook_events (idempotency_key,event_type,ofapi_account_id,payload,status,received_at,processed_at)
      values ('evt_receipt','subscriptions.new','acct_auto','{}','processed',now(),now())`);
    const manual = await attempt({ key: "evt_manual", event: "messages.deleted", minutesAgo: 30 });
    await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,state)
      values($1,$2,$3,$4,'accepted')`, [randomUUID(), WEBHOOK, manual, ownerId]);
    await attempt({ key: null, minutesAgo: 30 });
    await attempt({ key: "evt_expired", event: "messages.ppv.unlocked", minutesAgo: 7 * 24 * 60 + 5 });
    const ppv = await attempt({ key: "evt_ppv", event: "messages.ppv.unlocked", minutesAgo: 11 });

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 3, capReached: false });
    // Nearest to provider expiry first; the business key's newest attempt.
    expect(sentAttempts()).toEqual([older, newest, ppv]);
    expect(send.mock.calls.every(call => call[0] === WEBHOOK)).toBe(true);
    expect((await intents()).filter(row => row.origin === "auto")).toEqual([
      { attempt_id: older, origin: "auto", actor_user_id: null, business_key: "evt_renewed", state: "accepted" },
      { attempt_id: newest, origin: "auto", actor_user_id: null, business_key: "evt_received", state: "accepted" },
      { attempt_id: ppv, origin: "auto", actor_user_id: null, business_key: "evt_ppv", state: "accepted" },
    ]);
    expect((await testDb.pool.query("select count(*)::int n from audit_events where event_type='system.ofapi_webhook_auto_redelivery_requested' and actor_user_id is null")).rows[0].n).toBe(3);
    expect(OFAPI_AUTO_REDELIVERY_EVENT_TYPES).not.toContain("users.online");

    // Dedup by business key: a new failed attempt after an accepted redelivery
    // is not requested again automatically.
    await attempt({ key: "evt_received", minutesAgo: 15 });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("never retries an indeterminate or rejected POST, including an interrupted dispatch", async () => {
    await enableAt(120);
    const lost = await attempt({ key: "evt_lost", minutesAgo: 60 });
    const refused = await attempt({ key: "evt_refused", event: "messages.sent", minutesAgo: 50 });
    const interrupted = await attempt({ key: "evt_interrupted", event: "tips.received", minutesAgo: 40 });
    await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state,created_at)
      values($1,$2,$3,'auto','evt_interrupted','dispatching',now()-interval '5 minutes')`, [randomUUID(), WEBHOOK, interrupted]);
    send.mockRejectedValueOnce(new OfapiApiError("transport lost", null, null));
    send.mockRejectedValueOnce(new OfapiApiError("paused", 409, "{}"));

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 2, capReached: false });
    expect(sentAttempts()).toEqual([lost, refused]);
    expect((await intents()).map(row => [row.business_key, row.state])).toEqual([
      ["evt_interrupted", "indeterminate"], ["evt_lost", "indeterminate"], ["evt_refused", "rejected"],
    ]);
    for (let tick = 0; tick < 3; tick += 1) await runOfapiWebhookAutoRedelivery(app);
    expect(send).toHaveBeenCalledTimes(2);
    // The owner's manual action cannot resend an attempt whose automatic
    // outcome is unknown either.
    await expect(redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: lost, actorUserId: ownerId, dryRun: false }))
      .rejects.toThrow("earlier redelivery");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the manual limit of 20 per UTC day on its own counter", async () => {
    await enableAt(120);
    for (let index = 0; index < 20; index += 1) {
      const id = await attempt({ key: `evt_auto_${index}`, minutesAgo: 60 });
      await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state)
        values($1,$2,$3,'auto',$4,'accepted')`, [randomUUID(), WEBHOOK, id, `evt_auto_${index}`]);
    }
    // Twenty automatic requests today do not consume the manual allowance.
    const first = await attempt({ key: "evt_manual_first", minutesAgo: 200 });
    expect(await redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: first, actorUserId: ownerId, dryRun: false }))
      .toMatchObject({ state: "accepted" });
    expect((await intents()).find(row => row.attempt_id === first)).toMatchObject({ origin: "manual", actor_user_id: ownerId, business_key: "evt_manual_first" });
    for (let index = 1; index < 20; index += 1) {
      const id = await attempt({ key: `evt_manual_${index}`, minutesAgo: 200 });
      await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,state)
        values($1,$2,$3,$4,'accepted')`, [randomUUID(), WEBHOOK, id, ownerId]);
    }
    const blocked = await attempt({ key: "evt_manual_blocked", minutesAgo: 200 });
    await expect(redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: blocked, actorUserId: ownerId, dryRun: false }))
      .rejects.toThrow("Daily manual redelivery limit reached (20)");
    // Twenty manual requests today do not consume the automatic cap.
    const automatic = await attempt({ key: "evt_auto_after_manual", minutesAgo: 30 });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: false });
    expect(sentAttempts()).toEqual([first, automatic]);
  });

  it("enforces origin and actor shape in the schema", async () => {
    const id = await attempt({ key: "evt_shape", minutesAgo: 30 });
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,origin,business_key,state)
      values($1,$2,$3,$4,'auto','evt_shape','accepted')`, [randomUUID(), WEBHOOK, id, ownerId])).rejects.toThrow("actor_check");
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,state)
      values($1,$2,$3,'accepted')`, [randomUUID(), WEBHOOK, id])).rejects.toThrow("actor_check");
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,state)
      values($1,$2,$3,'auto','rejected')`, [randomUUID(), WEBHOOK, id])).rejects.toThrow("auto_key_check");
    await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state)
      values($1,$2,$3,'auto','evt_shape','rejected')`, [randomUUID(), WEBHOOK, id]);
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state)
      values($1,$2,$3,'auto','evt_shape','rejected')`, [randomUUID(), WEBHOOK, id])).rejects.toThrow("auto_business_key_uniq");
  });

  it("stops at the daily cap, raises the existing burn-rate incident under its own key, and clears it below the cap", async () => {
    await enableAt(120);
    app.config.ofapiWebhookAutoRedeliveryDailyCap = 1;
    const warn = vi.spyOn(app.logger, "warn");
    const first = await attempt({ key: "evt_cap_first", minutesAgo: 60 });
    await attempt({ key: "evt_cap_second", event: "messages.sent", minutesAgo: 30 });

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: true });
    expect(sentAttempts()).toEqual([first]);
    expect(await incident(CAP_KEY)).toMatchObject({ status: "open" });
    expect((await incident(CAP_KEY)).error_summary).toContain("daily cap (1/1");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: "ofapi_webhook_auto_redelivery", cap: 1, dispatchedToday: 1 }),
      "OFAPI webhook auto-redelivery daily cap reached");
    // The generic burn-rate latch is a different condition with its own texts.
    expect(await incident("ofapi_burn_rate:global")).toBeUndefined();
    expect(incidentTitleForKind({ kind: "ofapi_burn_rate", subKey: "auto_redelivery_cap" })).toBe("OFAPI webhook auto-redelivery daily cap reached");
    expect(incidentTitleForKind({ kind: "ofapi_burn_rate" })).toBe("OFAPI credit burn rate high");
    expect(resolveMessageForIncident({ kind: "ofapi_burn_rate", subKey: "auto_redelivery_cap", pageLabel: null, platform: null }))
      .toContain("auto-redelivery below its daily cap again");

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await incident(CAP_KEY)).toMatchObject({ status: "open" });

    // A new UTC day: the waiting key goes out, then the day is at its cap
    // again with nothing waiting — the latch stays as it is.
    await testDb.pool.query("update ofapi_webhook_redelivery_intents set created_at=created_at-interval '1 day'");
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: false });
    expect(await incident(CAP_KEY)).toMatchObject({ status: "open" });
    await testDb.pool.query("update ofapi_webhook_redelivery_intents set created_at=created_at-interval '1 day'");
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false });
    expect(await incident(CAP_KEY)).toMatchObject({ status: "resolved" });
  });

  it("waits without claiming when verified redelivery access is unavailable", async () => {
    await enableAt(120);
    await attempt({ key: "evt_wait", minutesAgo: 60 });
    app.ofapi!.getCredentialPreflight = async () => ({ status: "unknown", expectedTeam: "test-team", observedTeam: null,
      credentialFingerprint: "test-fingerprint", checkedAt: new Date().toISOString(), reason: "preflight_unavailable", rosterScope: "unknown" });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false });
    expect(await intents()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("OFAPI delivery-history collector catch-up", () => {
  async function completeScan(input: { endMinutesAgo: number; updatedMinutesAgo: number; state?: string }) {
    const id = randomUUID();
    await testDb.pool.query(`insert into ofapi_webhook_delivery_scans
      (id,webhook_id,credential_fingerprint,observed_team,window_start,window_end,state,next_offset,captured_attempts,created_at,updated_at,completed_at)
      values($1,$2,'test-fingerprint','test-team',date_trunc('second',now()-make_interval(secs => $3)),date_trunc('second',now()-make_interval(secs => $4))+interval '999 milliseconds',
        $5,0,0,now()-make_interval(secs => $6),now()-make_interval(secs => $6),case when $5='complete' then now()-make_interval(secs => $6) end)`,
    [id, WEBHOOK, (input.endMinutesAgo + 60) * 60, input.endMinutesAgo * 60, input.state ?? "complete", input.updatedMinutesAgo * 60]);
    return id;
  }
  function history(count: number) {
    historyRows = Array.from({ length: count }, (_, index) => ({ id: 10_000 + index, delivery_uuid: `history-${index}`, event: "users.online",
      attempt: 1, succeeded: true, status_code: 200, idempotency_key: `evt_history_${index}`, payload: { account_id: "acct_auto" },
      redelivered_from: null, created_at: new Date(Date.now() - 50 * MINUTE + index * 1000).toISOString() }));
  }
  const offsets = () => read.mock.calls.map(call => call[1].offset);
  const newest = async () => (await testDb.pool.query("select state,next_offset from ofapi_webhook_delivery_scans order by created_at desc limit 1")).rows[0];
  beforeEach(async () => {
    await testDb.pool.query("update ofapi_webhook_collection_policy set history_enabled=true");
  });

  it("keeps one page every five minutes while coverage is fresh", async () => {
    history(350);
    await completeScan({ endMinutesAgo: 10, updatedMinutesAgo: 1 });
    await sweepOfapiWebhookDeliveryHistory(app);
    expect(read).not.toHaveBeenCalled();
    await testDb.pool.query("update ofapi_webhook_delivery_scans set updated_at=now()-interval '6 minutes'");
    await sweepOfapiWebhookDeliveryHistory(app);
    expect(offsets()).toEqual([0]);
    expect(await newest()).toMatchObject({ state: "pending", next_offset: 100 });
  });

  it("catches up page by page, bounded per tick, once coverage is more than 30 minutes old", async () => {
    history(730);
    await completeScan({ endMinutesAgo: 45, updatedMinutesAgo: 1 });
    await sweepOfapiWebhookDeliveryHistory(app);
    // Five persisted pages in one tick despite the five-minute cadence.
    expect(offsets()).toEqual([0, 100, 200, 300, 400]);
    expect(await newest()).toMatchObject({ state: "pending", next_offset: 500 });
    expect((await testDb.pool.query("select count(*)::int n from ofapi_webhook_delivery_attempts")).rows[0].n).toBe(500);
    // Still behind: the next minute continues the same frozen window.
    await sweepOfapiWebhookDeliveryHistory(app);
    expect(offsets()).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
    expect(await newest()).toMatchObject({ state: "complete", next_offset: 730 });
    // Coverage is fresh again: back to the five-minute cadence.
    await sweepOfapiWebhookDeliveryHistory(app);
    expect(read).toHaveBeenCalledTimes(8);
  });

  it("keeps the five-minute pause after a failed page even while behind", async () => {
    history(10);
    await completeScan({ endMinutesAgo: 90, updatedMinutesAgo: 20 });
    await completeScan({ endMinutesAgo: 1, updatedMinutesAgo: 1, state: "failed" });
    await testDb.pool.query("update ofapi_webhook_delivery_scans set completed_at=null where state='failed'");
    await sweepOfapiWebhookDeliveryHistory(app);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports the coverage age as a golden signal that latches over 45 minutes", async () => {
    const metric = "ofapi_delivery_history_age";
    await testDb.pool.query("update ofapi_webhook_collection_policy set history_enabled=false");
    expect((await computeGoldenSignals(app)).samples.filter(sample => sample.metric === metric)).toEqual([]);

    await testDb.pool.query("update ofapi_webhook_collection_policy set history_enabled=true");
    await completeScan({ endMinutesAgo: 50, updatedMinutesAgo: 49 });
    const { samples } = await computeGoldenSignals(app);
    const age = samples.find(sample => sample.metric === metric && sample.quantile === "p95")!.valueMs;
    expect(age).toBeGreaterThan(50 * MINUTE - 5_000);
    expect(age).toBeLessThan(51 * MINUTE);
    expect((await runGoldenSignalSample(app)).breaches).toContain(metric);
    expect(await incident(`golden_signal_lag:global:${metric}`)).toMatchObject({ status: "open" });

    await completeScan({ endMinutesAgo: 3, updatedMinutesAgo: 2 });
    expect((await runGoldenSignalSample(app)).resolved).toContain(metric);
    expect(await incident(`golden_signal_lag:global:${metric}`)).toMatchObject({ status: "resolved" });
  });

  it("counts a collector without any completed window as uncovered since its first scan", async () => {
    await completeScan({ endMinutesAgo: 0, updatedMinutesAgo: 70, state: "pending" });
    await testDb.pool.query("update ofapi_webhook_delivery_scans set completed_at=null");
    const age = (await computeGoldenSignals(app)).samples.find(sample => sample.metric === "ofapi_delivery_history_age")!.valueMs;
    expect(age).toBeGreaterThan(69 * MINUTE);
  });
});
