import { OFAPI_WEBHOOK_CANONICALIZER_VERSION } from "../apps/runtime/src/services/canonicalize/ofapi-webhook.ts";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModel, createOnlyFansPage, insertObservation, setPageOfapiAccountId, upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { createOfapiClient, OfapiApiError, type OfapiClient, type OfapiWebhookRegistrationInput } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { getOfapiAsyncLifecycle } from "../apps/runtime/src/services/ofapi-async-lifecycle.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  applyOfapiWebhookCollectionPolicy, listOfapiWebhookDeliveryHistory, redeliverOfapiWebhook, replayLocalOfapiWebhook,
  saveOfapiWebhookCollectionPolicy, sweepOfapiWebhookDeliveryHistory, syncOfapiWebhookDeliveries, webhookCollectionPolicyStatus,
} from "../apps/runtime/src/services/ofapi-webhook-recovery.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>>;
let ownerId: number;
let cookie: string;
let from: string; let to: string;
let rows: Record<string, unknown>[];
let remoteEvents: string[];
const read = vi.fn(); const send = vi.fn();
const SECRET = "recovery-test-secret";

async function capture(body: unknown, kind = "ofapi_webhook_deliveries") {
  const text = JSON.stringify(body);
  const row = await insertObservation(app.db, { source: "operator", producer: "ofapi:admin", platform: "onlyfans",
    kind, payload: { body: text }, payloadHash: createHash("sha256").update(text).digest(), idempotencyKey: randomUUID() });
  return { body, capture: { observationId: row.observationId, receivedAt: row.receivedAt } };
}
function attempt(id: number, succeeded = false, deliveryUuid = "delivery-original") {
  return { id, delivery_uuid: deliveryUuid, event: "subscriptions.new", attempt: id,
    succeeded, status_code: succeeded ? 200 : 503, error_type: succeeded ? null : "ServerException",
    error_message: "never expose secret-token-from-url", idempotency_key: "evt_delivery_original",
    payload: { event: "subscriptions.new", account_id: "acct_recovery", payload: { privateText: "never expose fan content" } },
    url: "https://example.test/webhook?secret=private", redelivered_from: null,
    created_at: new Date(Date.now() - 60_000 + id).toISOString() };
}
async function scan(id = randomUUID(), maxPages = 20) {
  return syncOfapiWebhookDeliveries(app, { id, from, to, maxPages, actorUserId: ownerId });
}

beforeAll(async () => {
  const started = await startIntegrationTestDatabase(); if (!started) throw new Error("Recovery tests require PostgreSQL"); testDb = started;
}, 120_000);
afterAll(async () => { await server?.close(); await testDb?.stop(); });
afterEach(()=>vi.unstubAllGlobals());
beforeEach(async () => {
  await server?.close(); await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb, { ofapiAccountHealthEnabled: true });
  await testDb.pool.query("insert into ofapi_webhook_collection_policy(id) values(true) on conflict do nothing");
  await createUserAccount(app, { username: "recovery-owner", role: "owner", password: "test-owner-password" }, { source: "cli" });
  ownerId = Number((await testDb.pool.query("select id from users where username='recovery-owner'")).rows[0].id);
  remoteEvents = [...OFAPI_WEBHOOK_EVENTS]; rows = [attempt(1), attempt(2), attempt(3, true)];
  from = new Date(Date.now() - 3600_000).toISOString(); to = new Date().toISOString();
  read.mockReset().mockImplementation(async (_id: string, params: { offset: number; limit: number }) => {
    const data = rows.slice(params.offset, params.offset + params.limit);
    return capture({ data, _pagination: { next_page: rows.length > params.offset + data.length ? "continuation" : null } });
  });
  send.mockReset().mockImplementation(async (webhookId: string, attemptId: number) => capture({ data: { webhook_id: webhookId, delivery_id: attemptId, redelivery_id: "redelivery-new" } }, "ofapi_webhook_redelivery"));
  app.ofapi = {
    getCredentialPreflight: async () => ({ status: "verified", expectedTeam: "test-team", observedTeam: "test-team", credentialFingerprint: "test-fingerprint", checkedAt: new Date().toISOString(), reason: null, rosterScope: "unknown" }),
    listWebhookDeliveries: read, redeliverWebhookDelivery: send,
    listAccounts: async () => [],
    getWebhook: async (id: string) => ({ id, endpoint_url: "https://example.test/webhook", account_scope: "global", events: remoteEvents }),
    updateWebhook: async (id: string, registration: OfapiWebhookRegistrationInput) => { remoteEvents = registration.events; return { id }; },
  } as unknown as OfapiClient;
  await upsertOfapiWebhookConfig(app.db, { externalWebhookId: "wh_recovery", endpointUrl: "https://example.test/webhook", accountScope: "global", events: remoteEvents,
    encryptedSigningSecret: JSON.stringify(encryptJson(SECRET, app.config.encryptionKey, app.config.encryptionKeyVersion)) });
  server = await buildApiServer(app);
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "recovery-owner", password: "test-owner-password" } });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});

describe("OFAPI delivery recovery", () => {
  it("captures the vendor event catalog before local diagnostics and never enables an unknown event", async () => {
    const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[{value:"messages.received",description:"Message received"},{value:"subscriptions.expired",description:"Subscription expired"},{value:"new_family.future_event",description:"Unrecognized future event"}]})));
    vi.stubGlobal("fetch",fetch);
    app.ofapi=createOfapiClient({apiKey:"synthetic",restDelayMs:0,...ofapiCredentialPolicy(app.db,app.config,app.logger)});
    const url="/api/v1/admin/ofapi/webhook/event-catalog";
    expect((await server.inject({method:"POST",url:`${url}/refresh`,payload:{}})).statusCode).toBe(401);
    expect((await server.inject({method:"GET",url,headers:{cookie}})).json()).toMatchObject({state:"never",events:[]});
    expect(fetch).not.toHaveBeenCalled();
    const result=await server.inject({method:"POST",url:`${url}/refresh`,headers:{cookie},payload:{}});
    expect(result.statusCode,result.body).toBe(200);
    expect(result.json()).toMatchObject({state:"captured",events:[{value:"messages.received",requested:true,supported:true},{value:"subscriptions.expired",requested:false,supported:true,optionalGroup:"subscription_expiry"},{value:"new_family.future_event",requested:false,supported:false}]});
    expect((await testDb.pool.query("select payload->>'body' body from observations where kind='ofapi_webhook_event_catalog'")).rows[0].body).toContain("new_family.future_event");
    expect((await server.inject({method:"GET",url,headers:{cookie}})).json()).toEqual(result.json());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await testDb.pool.query("select events from ofapi_webhook_config")).rows[0].events).toEqual(remoteEvents);
    fetch.mockImplementation(async()=>new Response(JSON.stringify({data:[{value:"malformed"}]})));
    expect((await server.inject({method:"POST",url:`${url}/refresh`,headers:{cookie},payload:{}})).json()).toMatchObject({state:"invalid",events:[]});
    expect((await testDb.pool.query("select count(*)::int n from observations where kind='ofapi_webhook_event_catalog'")).rows[0].n).toBe(2);
  });
  it("retains every attempt and presents a recovered delivery without leaking vendor payloads", async () => {
    const result = await scan(); expect(result).toMatchObject({ state: "complete", capturedAttempts: 3 });
    await scan();
    const history = await listOfapiWebhookDeliveryHistory(app, { limit: 25, offset: 0 });
    expect(history.attempts).toHaveLength(3);
    expect(history.attempts.every(row => row.deliveryRecovered)).toBe(true);
    expect(history.attempts.filter(row => row.succeeded)).toHaveLength(1);
    const failures = await listOfapiWebhookDeliveryHistory(app, { limit: 25, offset: 0, failedOnly: true });
    expect(failures.attempts).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain("private");
    expect(JSON.stringify(history)).not.toContain("secret-token");
    expect(read.mock.calls.every(call => !("succeeded" in call[1]))).toBe(true);
  });

  it("persists bounded page progress and resumes the same frozen window", async () => {
    rows = Array.from({ length: 101 }, (_, index) => attempt(index + 1));
    const id = randomUUID(); const first = await scan(id, 1);
    expect(first).toMatchObject({ state: "pending", nextOffset: 100, capturedAttempts: 100 });
    const second = await scan(id, 1);
    expect(second).toMatchObject({ state: "complete", nextOffset: 101, capturedAttempts: 101 });
    expect(read.mock.calls.map(call => call[1].offset)).toEqual([0, 100]);
    await expect(syncOfapiWebhookDeliveries(app, { id, from: new Date(Date.now() - 7200_000).toISOString(), to })).rejects.toThrow("different window");
  });

  it("leaves invalid page evidence captured and retries without losing its offset", async () => {
    read.mockImplementationOnce(async () => capture({ data: [{ id: 1 }] }));
    const id = randomUUID(); expect((await scan(id)).state).toBe("failed");
    expect((await testDb.pool.query("select count(*)::int n from observations where kind='ofapi_webhook_deliveries'")).rows[0].n).toBe(1);
    expect((await scan(id)).state).toBe("complete");
    expect(read.mock.calls.map(call => call[1].offset)).toEqual([0, 0]);
  });

  it("keeps new automatic history collection off and reports desired versus applied event settings", async () => {
    await sweepOfapiWebhookDeliveryHistory(app); expect(read).not.toHaveBeenCalled();
    const saved = await saveOfapiWebhookCollectionPolicy(app, { expectedVersion: 0, groups: ["subscription_expiry"], historyEnabled: false, actorUserId: ownerId });
    expect(saved).toMatchObject({ desiredGroups: ["subscription_expiry"], appliedGroups: [], applyState: "pending" });
    expect(remoteEvents).not.toContain("subscriptions.expired");
    await expect(saveOfapiWebhookCollectionPolicy(app, { expectedVersion: 0, groups: [], historyEnabled: false, actorUserId: ownerId })).rejects.toThrow("version");
    const applied = await applyOfapiWebhookCollectionPolicy(app, { expectedVersion: saved.version, actorUserId: ownerId });
    expect(applied).toMatchObject({ applyState: "applied", appliedGroups: ["subscription_expiry"] });
    expect(remoteEvents).toContain("subscriptions.expired");
  });

  it("does not claim remote application when readback disagrees", async () => {
    await saveOfapiWebhookCollectionPolicy(app, { expectedVersion: 0, groups: ["media_uploads"], historyEnabled: false, actorUserId: ownerId });
    app.ofapi!.updateWebhook = async id => ({ id });
    expect(await applyOfapiWebhookCollectionPolicy(app, { expectedVersion: 1, actorUserId: ownerId })).toMatchObject({ applyState: "failed", appliedGroups: [] });
  });

  it("previews free, queues one remote redelivery, and treats acceptance as a pending outcome", async () => {
    await scan(); const id = randomUUID();
    await redeliverOfapiWebhook(app, { id, attemptId: 1, actorUserId: ownerId, dryRun: true }); expect(send).not.toHaveBeenCalled();
    const result = await redeliverOfapiWebhook(app, { id, attemptId: 1, actorUserId: ownerId, dryRun: false });
    expect(result).toMatchObject({ state: "accepted", redeliveryUuid: "redelivery-new", projected: false });
    await redeliverOfapiWebhook(app, { id, attemptId: 1, actorUserId: ownerId, dryRun: false }); expect(send).toHaveBeenCalledTimes(1);
    await expect(redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: 1, actorUserId: ownerId, dryRun: false })).rejects.toThrow("earlier redelivery");
    expect((await listOfapiWebhookDeliveryHistory(app, { limit: 25, offset: 0 })).attempts.find(row => row.attemptId === 1))
      .toMatchObject({ redeliveryState: "accepted", redeliveryUuid: "redelivery-new", redeliverySucceeded: null, localEventId: null });
    rows.push(attempt(4, true, "redelivery-new")); await scan();
    expect((await listOfapiWebhookDeliveryHistory(app, { limit: 25, offset: 0 })).attempts.find(row => row.attemptId === 1))
      .toMatchObject({ redeliverySucceeded: true, localEventId: null, projectionStatus: null });
  });

  it("never retries a transport-indeterminate POST and names a paused webhook rejection", async () => {
    await scan(); send.mockRejectedValueOnce(new OfapiApiError("transport lost", null, null));
    const id = randomUUID();
    expect((await redeliverOfapiWebhook(app, { id, attemptId: 1, actorUserId: ownerId, dryRun: false })).state).toBe("indeterminate");
    await redeliverOfapiWebhook(app, { id, attemptId: 1, actorUserId: ownerId, dryRun: false }); expect(send).toHaveBeenCalledTimes(1);
    send.mockRejectedValueOnce(new OfapiApiError("paused", 409, "{}"));
    expect(await redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: 2, actorUserId: ownerId, dryRun: false })).toMatchObject({ state: "rejected", errorCode: "webhook_paused_or_disabled" });
  });

  it("uses exact local replay without paid redelivery or replaying a neighboring fact", async () => {
    const model = await createModel(app.db, { slug: "recovery-model", name: "Recovery" }); if (!model) throw new Error("model missing");
    const page = await createOnlyFansPage(app.db, { modelId: model.id, label: "recovery-page" }); if (!page) throw new Error("page missing");
    await setPageOfapiAccountId(app.db, { pageId: page.id, ofapiAccountId: "acct_recovery" });
    async function intake(key: string) {
      const body = JSON.stringify({ event: "accounts.reconnected", account_id: "acct_recovery", payload: {} });
      const response = await server.inject({ method: "POST", url: "/api/v1/ofapi/webhook", payload: body,
        headers: { "content-type": "application/json", signature: createHmac("sha256", SECRET).update(body).digest("hex"), "x-ofapi-idempotency-key": key } });
      expect(response.statusCode).toBe(200);
      return Number((await testDb.pool.query("select id from ofapi_webhook_events where idempotency_key=$1", [key])).rows[0].id);
    }
    const first = await intake("evt_delivery_original"); await processOfapiWebhookEvent(app, first);
    const neighbor = await intake("evt_neighbor");
    const seq = (await testDb.pool.query("select fanout_seq from ofapi_webhook_events where id=$1", [first])).rows[0].fanout_seq;
    await testDb.pool.query("update ofapi_webhook_events set projection_status='failed',projection_attempts=5 where id=$1", [first]);
    await replayLocalOfapiWebhook(app, { eventId: first, actorUserId: ownerId, dryRun: false });
    expect((await testDb.pool.query("select fanout_seq,projection_status,projection_attempts from ofapi_webhook_events where id=$1", [first])).rows[0]).toEqual({ fanout_seq: seq, projection_status: "projected", projection_attempts: 6 });
    expect((await testDb.pool.query("select status from ofapi_webhook_events where id=$1", [neighbor])).rows[0].status).toBe("pending");
    const parsed = (await testDb.pool.query("select k.idempotency_key,o.parse_version from observations o join observation_keys k on k.observation_id=o.id and k.received_at=o.received_at where o.source='webhook' order by o.id")).rows;
    expect(parsed).toEqual([{ idempotency_key: "evt_delivery_original", parse_version: OFAPI_WEBHOOK_CANONICALIZER_VERSION }, { idempotency_key: "evt_neighbor", parse_version: 0 }]);
    await scan(); await expect(redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: 1, actorUserId: ownerId, dryRun: false })).rejects.toThrow("retained locally");
    expect(send).not.toHaveBeenCalled();
  });

  it("requires an owner session at every recovery endpoint and returns validated safe history", async () => {
    const unauthenticated = await server.inject({ method: "GET", url: "/api/v1/admin/ofapi/webhook/deliveries" }); expect(unauthenticated.statusCode).toBe(401);
    await scan();
    const result = await server.inject({ method: "GET", url: "/api/v1/admin/ofapi/webhook/deliveries", headers: { cookie } });
    expect(result.statusCode).toBe(200); expect(result.json().attempts).toHaveLength(3);
    expect(result.body).not.toContain("private");
    expect(await webhookCollectionPolicyStatus(app)).toMatchObject({ historyEnabled: false });
  });

  it("erases exclusive recovery and export evidence while reporting shared bytes and fencing replay", async () => {
    const model = await createModel(app.db, { slug: "erase-recovery", name: "Erase recovery" }); if (!model) throw new Error("model missing");
    const a = await createOnlyFansPage(app.db, { modelId: model.id, label: "erase-recovery-a" });
    const b = await createOnlyFansPage(app.db, { modelId: model.id, label: "erase-recovery-b" });
    if (!a || !b) throw new Error("page missing");
    await setPageOfapiAccountId(app.db, { pageId: a.id, ofapiAccountId: "acct_recovery" });
    await setPageOfapiAccountId(app.db, { pageId: b.id, ofapiAccountId: "acct_bystander" });
    rows = [attempt(1)]; await scan();
    await redeliverOfapiWebhook(app, { id: randomUUID(), attemptId: 1, actorUserId: ownerId, dryRun: false });
    rows = [attempt(2), { ...attempt(3), payload: { account_id: "acct_bystander" } }]; await scan();
    for (const [resourceId, refs] of [["exclusive", ["acct_recovery"]], ["shared", ["acct_recovery", "acct_bystander"]]] as const) {
      const body = JSON.stringify({ event: "data_exports.completed", payload: { id: resourceId, status: "completed", account_ids: refs } });
      const response = await server.inject({ method: "POST", url: "/api/v1/ofapi/webhook", payload: body,
        headers: { "content-type": "application/json", signature: createHmac("sha256", SECRET).update(body).digest("hex"), "x-ofapi-idempotency-key": `evt_erase_${resourceId}` } });
      expect(response.statusCode).toBe(200);
      const eventId = Number((await testDb.pool.query("select id from ofapi_webhook_events where idempotency_key=$1", [`evt_erase_${resourceId}`])).rows[0].id);
      await processOfapiWebhookEvent(app, eventId);
    }
    await runCanonicalization(app, { kinds: ["data_exports.completed"] });
    expect(await getOfapiAsyncLifecycle(app, { resourceKind: "data_export", resourceId: "shared", ofapiAccountId: "acct_recovery" })).not.toBeNull();
    const scope = { scopeType: "page" as const, pageLabel: a.label };
    const plan = await planErasure(app, scope); expect(plan.sharedObservations).toBe(2);
    await executeErasure(app, scope, { initiatedBy: ownerId });
    expect((await testDb.pool.query("select attempt_id::float8 as attempt_id from ofapi_webhook_delivery_attempts")).rows).toEqual([{ attempt_id: 3 }]);
    expect((await testDb.pool.query("select count(*)::int n from ofapi_webhook_redelivery_intents")).rows[0].n).toBe(0);
    expect((await testDb.pool.query("select idempotency_key from ofapi_webhook_events order by id")).rows).toEqual([{ idempotency_key: "evt_erase_shared" }]);
    expect((await testDb.pool.query("select count(*)::int n from observations where kind='ofapi_webhook_deliveries'")).rows[0].n).toBe(1);
    expect(await getOfapiAsyncLifecycle(app, { resourceKind: "data_export", resourceId: "shared", ofapiAccountId: "acct_recovery" })).toBeNull();
    expect(await getOfapiAsyncLifecycle(app, { resourceKind: "data_export", resourceId: "shared", ofapiAccountId: "acct_bystander" })).not.toBeNull();
    await testDb.pool.query("update observations set parse_version=0 where kind='data_exports.completed'");
    await runCanonicalization(app, { kinds: ["data_exports.completed"] });
    expect((await testDb.pool.query("select count(*)::int n from domain_events where account_id=$1", [a.id])).rows[0].n).toBe(0);
    expect((await testDb.pool.query("select count(*)::int n from domain_events where account_id=$1", [b.id])).rows[0].n).toBe(1);
    await scan();
    expect((await testDb.pool.query("select attempt_id::float8 as attempt_id from ofapi_webhook_delivery_attempts")).rows).toEqual([{ attempt_id: 3 }]);
  });
});
