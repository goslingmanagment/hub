import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertObservation, setConfigOverride, upsertOfapiWebhookConfig } from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { computeGoldenSignals, runGoldenSignalSample } from "../apps/runtime/src/services/golden-signals.ts";
import { getOfapiCreditsSummary } from "../apps/runtime/src/services/ofapi-credit-report.ts";
import { incidentTitleForKind, resolveMessageForIncident } from "../apps/runtime/src/services/notification-incidents.ts";
import {
  OfapiApiError, OfapiCreditAccountingUnavailableError, OfapiCredentialNotReadyError, type OfapiClient,
} from "../apps/runtime/src/services/ofapi.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import {
  OFAPI_AUTO_REDELIVERY_EVENT_TYPES, listOfapiWebhookDeliveryHistory, redeliverOfapiWebhook, runOfapiWebhookAutoRedelivery,
  selectOfapiAutoRedeliveryCandidates, sweepOfapiWebhookDeliveryHistory,
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
async function completeScan(input: { endMinutesAgo: number; updatedMinutesAgo: number; state?: string }) {
  const id = randomUUID();
  await testDb.pool.query(`insert into ofapi_webhook_delivery_scans
    (id,webhook_id,credential_fingerprint,observed_team,window_start,window_end,state,next_offset,captured_attempts,created_at,updated_at,completed_at)
    values($1,$2,'test-fingerprint','test-team',date_trunc('second',now()-make_interval(secs => $3)),date_trunc('second',now()-make_interval(secs => $4))+interval '999 milliseconds',
      $5,0,0,now()-make_interval(secs => $6),now()-make_interval(secs => $6),case when $5='complete' then now()-make_interval(secs => $6) end)`,
  [id, WEBHOOK, (input.endMinutesAgo + 60) * 60, input.endMinutesAgo * 60, input.state ?? "complete", input.updatedMinutesAgo * 60]);
  return id;
}
// Proof of a live receiver (a later successful delivery) and complete history
// coverage up to now: the preconditions every automatic request needs.
async function ready() {
  await completeScan({ endMinutesAgo: 0, updatedMinutesAgo: 0 });
  await attempt({ key: `evt_alive_${nextAttemptId}`, event: "users.online", minutesAgo: 1, succeeded: true });
}
async function pause() {
  return (await testDb.pool.query(`select pause_count,pause_reason,
    extract(epoch from paused_until-now())/60 as minutes from ofapi_webhook_auto_redelivery_state`)).rows[0];
}
const expirePause = () => testDb.pool.query("update ofapi_webhook_auto_redelivery_state set paused_until=now()-interval '1 second'");

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
    await ready();
    await attempt({ key: "evt_before", minutesAgo: 30 });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false, pausedUntil: null });
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
    await ready();
    await setConfigOverride(app.db, { key: "ofapiWebhookAutoRedeliveryEnabled", value: true, userId: ownerId, groupId: randomUUID() });
    await setConfigOverride(app.db, { key: "ofapiWebhookAutoRedeliveryDailyCap", value: 1, userId: ownerId, groupId: randomUUID() });
    await runOfapiWebhookAutoRedelivery(app);
    expect((await testDb.pool.query("select count(*)::int n from ofapi_webhook_auto_redelivery_state where enabled_at is not null")).rows[0].n).toBe(1);
    await testDb.pool.query("update ofapi_webhook_auto_redelivery_state set enabled_at=now()-interval '2 hours'");
    await attempt({ key: "evt_live_first", minutesAgo: 60 });
    await attempt({ key: "evt_live_second", minutesAgo: 30 });
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 1, capReached: true });
  });

  it("selects only quiet, retained, receipt-less business failures after the enable moment, nearest to expiry first", async () => {
    await enableAt(9 * 24 * 60);
    await ready();
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

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 3, capReached: false, pausedUntil: null });
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
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 0, capReached: false });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("requires a live receiver after the failure and history coverage past its quiet period", async () => {
    await enableAt(120);
    await completeScan({ endMinutesAgo: 0, updatedMinutesAgo: 0 });
    const early = await attempt({ key: "evt_early", minutesAgo: 30 });
    const late = await attempt({ key: "evt_late", event: "messages.sent", minutesAgo: 12 });
    const select = async () => (await selectOfapiAutoRedeliveryCandidates(app.db, { webhookId: WEBHOOK,
      enabledAt: new Date(Date.now() - 120 * MINUTE), limit: 10 })).map(candidate => candidate.attemptId);
    // Nothing proves the receiver came back after either failure.
    expect(await select()).toEqual([]);
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 0 });
    expect(send).not.toHaveBeenCalled();
    // A successful delivery 20 minutes ago proves it for the earlier failure only.
    await attempt({ key: "evt_ok", event: "users.offline", minutesAgo: 20, succeeded: true });
    expect(await select()).toEqual([early]);
    // A local receipt received after the later failure proves it for both.
    await testDb.pool.query(`insert into ofapi_webhook_events (idempotency_key,event_type,ofapi_account_id,payload,status,received_at,processed_at)
      values ('evt_other_receipt','users.online','acct_auto','{}','processed',now()-interval '5 minutes',now())`);
    expect(await select()).toEqual([early, late]);

    // Coverage: completed history must reach ten minutes past the failure.
    await testDb.pool.query("update ofapi_webhook_delivery_scans set window_end=now()-interval '20 minutes'");
    expect(await select()).toEqual([early]);
    await testDb.pool.query("update ofapi_webhook_delivery_scans set state='running',completed_at=null");
    expect(await select()).toEqual([]);
    await completeScan({ endMinutesAgo: 1, updatedMinutesAgo: 0 });
    expect(await select()).toEqual([early, late]);
  });

  it("stops at the first request that is not accepted and backs off, spending at most one key per pause", async () => {
    await enableAt(120);
    await ready();
    const lost = await attempt({ key: "evt_lost", minutesAgo: 60 });
    const refused = await attempt({ key: "evt_refused", event: "messages.sent", minutesAgo: 50 });
    const unknown = await attempt({ key: "evt_unknown", event: "tips.received", minutesAgo: 45 });
    const fine = await attempt({ key: "evt_fine", event: "transactions.new", minutesAgo: 40 });
    const interrupted = await attempt({ key: "evt_interrupted", event: "subscriptions.new", minutesAgo: 30 });
    await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state,created_at)
      values($1,$2,$3,'auto','evt_interrupted','dispatching',now()-interval '5 minutes')`, [randomUUID(), WEBHOOK, interrupted]);
    const warn = vi.spyOn(app.logger, "warn");

    // Transport loss: the outcome is unknown, the tick stops at once.
    send.mockRejectedValueOnce(new OfapiApiError("transport lost", null, null));
    const first = await runOfapiWebhookAutoRedelivery(app);
    expect(first).toMatchObject({ dispatched: 1, capReached: false });
    expect(first.pausedUntil).not.toBeNull();
    expect(sentAttempts()).toEqual([lost]);
    expect(await pause()).toMatchObject({ pause_count: 1, pause_reason: "indeterminate:provider_outcome_unknown" });
    expect(Number((await pause()).minutes)).toBeGreaterThan(14);
    expect(Number((await pause()).minutes)).toBeLessThan(16);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: "ofapi_webhook_auto_redelivery", attemptId: lost, state: "indeterminate" }),
      "OFAPI webhook auto-redelivery paused after a request that was not accepted");
    // While paused nothing is sent.
    for (let tick = 0; tick < 3; tick += 1) expect((await runOfapiWebhookAutoRedelivery(app)).pausedUntil).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);

    // A paused webhook (409) costs one more key and the pause doubles.
    await expirePause();
    send.mockRejectedValueOnce(new OfapiApiError("paused", 409, "{}"));
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 1 });
    expect(await pause()).toMatchObject({ pause_count: 2, pause_reason: "rejected:webhook_paused_or_disabled" });
    expect(Number((await pause()).minutes)).toBeGreaterThan(29);
    // A failure after the provider may have answered is never "not sent".
    await expirePause();
    send.mockRejectedValueOnce(new Error("capture persistence failed after the response"));
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 1 });
    expect(await pause()).toMatchObject({ pause_count: 3 });
    expect(Number((await pause()).minutes)).toBeGreaterThan(59);
    // Recovery: an accepted request resets the backoff.
    await expirePause();
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 1, pausedUntil: null });
    expect((await pause()).pause_count).toBe(0);

    expect(sentAttempts()).toEqual([lost, refused, unknown, fine]);
    expect((await intents()).map(row => [row.business_key, row.state])).toEqual([
      ["evt_interrupted", "indeterminate"], ["evt_lost", "indeterminate"], ["evt_refused", "rejected"],
      ["evt_unknown", "indeterminate"], ["evt_fine", "accepted"],
    ]);
    // None of those keys is ever requested again, and the owner cannot resend
    // an attempt whose automatic outcome is unknown either.
    for (let tick = 0; tick < 2; tick += 1) await runOfapiWebhookAutoRedelivery(app);
    expect(send).toHaveBeenCalledTimes(4);
    await expect(redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: lost, actorUserId: ownerId, dryRun: false }))
      .rejects.toThrow("earlier redelivery");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("does not spend a key's one shot on a request refused locally before egress", async () => {
    await enableAt(120);
    await ready();
    app.config.ofapiWebhookAutoRedeliveryDailyCap = 1;
    const local = await attempt({ key: "evt_local", minutesAgo: 60 });
    send.mockRejectedValueOnce(new OfapiCreditAccountingUnavailableError());
    const first = await runOfapiWebhookAutoRedelivery(app);
    expect(first).toMatchObject({ dispatched: 0, capReached: false });
    expect(first.pausedUntil).not.toBeNull();
    await expirePause();
    send.mockRejectedValueOnce(new OfapiCredentialNotReadyError("unknown", "preflight_unavailable"));
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 0 });
    await expirePause();
    // Neither refusal counted toward the cap of one or used the key.
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: false, pausedUntil: null });
    expect(sentAttempts()).toEqual([local, local, local]);
    expect((await testDb.pool.query("select state,error_code from ofapi_webhook_redelivery_intents order by created_at")).rows).toEqual([
      { state: "not_sent", error_code: "local_credit_accounting_unavailable" },
      { state: "not_sent", error_code: "local_credential_not_verified" },
      { state: "accepted", error_code: null },
    ]);
  });

  it("proves key-scope readiness before claiming anything", async () => {
    await enableAt(120);
    await ready();
    await attempt({ key: "evt_scope", minutesAgo: 60 });
    const fingerprint = createHash("sha256").update(app.config.ofapiApiKey ?? "").digest("hex");
    await testDb.pool.query(`insert into ofapi_key_scope_declarations(credential_fingerprint,version,capabilities,visibility,actor_user_id)
      values($1,1,'["reads"]'::jsonb,'declared_restricted',$2)`, [fingerprint, ownerId]);
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false, pausedUntil: null });
    expect(await intents()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    await testDb.pool.query(`update ofapi_key_scope_declarations set capabilities='["reads","webhooks"]'::jsonb`);
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 1 });
  });

  it("re-checks each key under the reservation lock", async () => {
    await enableAt(120);
    await ready();
    const first = await attempt({ key: "evt_first", minutesAgo: 60 });
    await attempt({ key: "evt_second", event: "messages.sent", minutesAgo: 50 });
    // The second key's receipt lands while the first request is in flight.
    send.mockImplementationOnce(async (webhookId: string, attemptId: number) => {
      await testDb.pool.query(`insert into ofapi_webhook_events (idempotency_key,event_type,ofapi_account_id,payload,status,received_at,processed_at)
        values ('evt_second','messages.sent','acct_auto','{}','processed',now(),now())`);
      return capture({ data: { webhook_id: webhookId, delivery_id: attemptId, redelivery_id: "redelivery-first" } }, "ofapi_webhook_redelivery");
    });
    expect(await runOfapiWebhookAutoRedelivery(app)).toMatchObject({ dispatched: 1 });
    expect(sentAttempts()).toEqual([first]);
  });

  it("guards the manual action by business key and shows the key's request in history", async () => {
    await enableAt(120);
    const sibling = await attempt({ key: "evt_shared", minutesAgo: 50 });
    const redelivered = await attempt({ key: "evt_shared", minutesAgo: 40 });
    await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state,redelivery_uuid,created_at)
      values($1,$2,$3,'auto','evt_shared','accepted','redelivery-shared',now()-interval '20 minutes')`, [randomUUID(), WEBHOOK, redelivered]);
    // Another attempt of the same key while the automatic request owns it.
    await expect(redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: sibling, actorUserId: ownerId, dryRun: false }))
      .rejects.toThrow("earlier redelivery for this business key");
    expect(send).not.toHaveBeenCalled();
    const history = await listOfapiWebhookDeliveryHistory(app, { limit: 25, offset: 0 });
    expect(history.attempts.find(row => row.attemptId === sibling)).toMatchObject({ redeliveryState: "accepted", redeliveryUuid: "redelivery-shared" });
    // Once the provider reports a newer failure after that request, the owner
    // may redeliver that newer attempt.
    const after = await attempt({ key: "evt_shared", minutesAgo: 15 });
    expect(await redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: after, actorUserId: ownerId, dryRun: false }))
      .toMatchObject({ state: "accepted" });
    expect(sentAttempts()).toEqual([after]);
  });

  it("keeps the manual limit of 20 per UTC day on its own counter", async () => {
    await enableAt(120);
    await ready();
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
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: false, pausedUntil: null });
    expect(sentAttempts()).toEqual([first, automatic]);
  });

  it("enforces origin, actor and one-shot shape in the schema", async () => {
    const id = await attempt({ key: "evt_shape", minutesAgo: 30 });
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,actor_user_id,origin,business_key,state)
      values($1,$2,$3,$4,'auto','evt_shape','accepted')`, [randomUUID(), WEBHOOK, id, ownerId])).rejects.toThrow("actor_check");
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,state)
      values($1,$2,$3,'accepted')`, [randomUUID(), WEBHOOK, id])).rejects.toThrow("actor_check");
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,state)
      values($1,$2,$3,'auto','rejected')`, [randomUUID(), WEBHOOK, id])).rejects.toThrow("auto_key_check");
    // Local refusals do not hold the key's automatic shot.
    for (let index = 0; index < 2; index += 1) {
      await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state)
        values($1,$2,$3,'auto','evt_shape','not_sent')`, [randomUUID(), WEBHOOK, id]);
    }
    await testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state)
      values($1,$2,$3,'auto','evt_shape','rejected')`, [randomUUID(), WEBHOOK, id]);
    await expect(testDb.pool.query(`insert into ofapi_webhook_redelivery_intents(id,webhook_id,attempt_id,origin,business_key,state)
      values($1,$2,$3,'auto','evt_shape','rejected')`, [randomUUID(), WEBHOOK, id])).rejects.toThrow("auto_business_key_uniq");
  });

  it("stops at the daily cap, raises the existing burn-rate incident under its own key, and clears it below the cap", async () => {
    await enableAt(120);
    await ready();
    app.config.ofapiWebhookAutoRedeliveryDailyCap = 1;
    const warn = vi.spyOn(app.logger, "warn");
    const first = await attempt({ key: "evt_cap_first", minutesAgo: 60 });
    await attempt({ key: "evt_cap_second", event: "messages.sent", minutesAgo: 30 });

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: true, pausedUntil: null });
    expect(sentAttempts()).toEqual([first]);
    expect(await incident(CAP_KEY)).toMatchObject({ status: "open" });
    expect((await incident(CAP_KEY)).error_summary).toContain("daily cap (1/1");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ operation: "ofapi_webhook_auto_redelivery", cap: 1, dispatchedToday: 1 }),
      "OFAPI webhook auto-redelivery daily cap reached");
    // The generic burn-rate latch is a different condition with its own texts,
    // and the credits page receives a display kind that names the cap.
    expect(await incident("ofapi_burn_rate:global")).toBeUndefined();
    expect((await getOfapiCreditsSummary(app)).incidents.map(row => row.kind)).toEqual(["ofapi_burn_rate:auto_redelivery_cap"]);
    expect(incidentTitleForKind({ kind: "ofapi_burn_rate", subKey: "auto_redelivery_cap" })).toBe("OFAPI webhook auto-redelivery daily cap reached");
    expect(incidentTitleForKind({ kind: "ofapi_burn_rate" })).toBe("OFAPI credit burn rate high");
    expect(resolveMessageForIncident({ kind: "ofapi_burn_rate", subKey: "auto_redelivery_cap", pageLabel: null, platform: null }))
      .toContain("auto-redelivery below its daily cap again");

    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: true, pausedUntil: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await incident(CAP_KEY)).toMatchObject({ status: "open" });

    // A new UTC day: the waiting key goes out, then the day is at its cap
    // again with nothing waiting — the latch stays as it is.
    await testDb.pool.query("update ofapi_webhook_redelivery_intents set created_at=created_at-interval '1 day'");
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 1, capReached: false, pausedUntil: null });
    expect(await incident(CAP_KEY)).toMatchObject({ status: "open" });
    await testDb.pool.query("update ofapi_webhook_redelivery_intents set created_at=created_at-interval '1 day'");
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false, pausedUntil: null });
    expect(await incident(CAP_KEY)).toMatchObject({ status: "resolved" });
  });

  it("waits without claiming when verified redelivery access is unavailable", async () => {
    await enableAt(120);
    await ready();
    await attempt({ key: "evt_wait", minutesAgo: 60 });
    app.ofapi!.getCredentialPreflight = async () => ({ status: "unknown", expectedTeam: "test-team", observedTeam: null,
      credentialFingerprint: "test-fingerprint", checkedAt: new Date().toISOString(), reason: "preflight_unavailable", rosterScope: "unknown" });
    expect(await runOfapiWebhookAutoRedelivery(app)).toEqual({ dispatched: 0, capReached: false, pausedUntil: null });
    expect(await intents()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("OFAPI delivery-history collector catch-up", () => {
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
    // No collection, no coverage to age: a neutral zero.
    expect((await computeGoldenSignals(app)).samples.filter(sample => sample.metric === metric).map(sample => sample.valueMs)).toEqual([0, 0]);

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

  it("resolves an open coverage latch when collection is switched off", async () => {
    const metric = "ofapi_delivery_history_age";
    await completeScan({ endMinutesAgo: 50, updatedMinutesAgo: 49 });
    expect((await runGoldenSignalSample(app)).breaches).toContain(metric);
    expect(await incident(`golden_signal_lag:global:${metric}`)).toMatchObject({ status: "open" });
    await testDb.pool.query("update ofapi_webhook_collection_policy set history_enabled=false");
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
