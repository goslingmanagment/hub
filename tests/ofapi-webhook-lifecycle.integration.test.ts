import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createModel, createOnlyFansPage, findPageById, findPageSubscription,
  setPageOfapiAccountId, upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { sweepOfapiAccountHealthProjections } from "../apps/runtime/src/services/ofapi-account-health.ts";
import { getOfapiAsyncLifecycle } from "../apps/runtime/src/services/ofapi-async-lifecycle.ts";
import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { OFAPI_WEBHOOK_EVENTS, buildOfapiWebhookEventSet } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const SECRET = "lifecycle-test-secret";
const ACCOUNT = "acct_lifecycle";
let testDb: StartedTestDatabase;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>>;
let pageId: number;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Lifecycle regressions require PostgreSQL");
  testDb = started;
}, 120_000);
afterAll(async () => { await server?.close(); await testDb?.stop(); });
beforeEach(async () => {
  await server?.close();
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb, { ofapiAccountHealthEnabled: true, ofapiAudienceSyncEnabled: true, ofapiPresenceProjectionEnabled: true });
  const model = await createModel(app.db, { slug: "lifecycle-model", name: "Lifecycle" });
  if (!model) throw new Error("Model fixture insert failed");
  const page = await createOnlyFansPage(app.db, { modelId: model.id, label: "lifecycle-of" });
  if (!page) throw new Error("Page fixture insert failed");
  pageId = page.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: ACCOUNT });
  await upsertOfapiWebhookConfig(app.db, {
    externalWebhookId: "wh_lifecycle", endpointUrl: "https://example.test/webhook", accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SECRET, app.config.encryptionKey, app.config.encryptionKeyVersion)),
  });
  server = await buildApiServer(app);
});

async function deliver(event: string, payload: Record<string, unknown>, options: { noKey?: boolean; accountId?: string | null; key?: string; redeliveryOf?: string } = {}) {
  const body = JSON.stringify({ event, ...(options.accountId === null ? {} : { account_id: options.accountId ?? ACCOUNT }), payload });
  const response = await server.inject({ method: "POST", url: "/api/v1/ofapi/webhook", payload: body, headers: {
    "content-type": "application/json", signature: createHmac("sha256", SECRET).update(body).digest("hex"),
    ...(options.noKey ? {} : { "x-ofapi-idempotency-key": options.key ?? randomUUID() }),
    ...(options.redeliveryOf ? { "x-ofapi-redelivery-of": options.redeliveryOf } : {}),
  } });
  expect(response.statusCode).toBe(200);
  const row = (await testDb.pool.query("select * from ofapi_webhook_events order by id desc limit 1")).rows[0]!;
  await processOfapiWebhookEvent(app, Number(row.id));
  return { id: Number(row.id), ack: response.json() };
}

function subscription(at: string, dollars = 10, expiredAt?: string) {
  return { id: `55:${expiredAt ?? at}`, user: { id: 55, name: "Fan", username: "fan55" }, createdAt: at,
    replacePairs: { "{PRICE}": `$${dollars.toFixed(2)}` }, ...(expiredAt ? { expiredAt } : {}) };
}

async function currentSubscription() {
  return findPageSubscription(app.db, { platformAccountId: pageId, platformSubscriptionId: "55" });
}

const at = (minute: string) => `2026-09-06T10:${minute}:00Z`;

describe("OFAPI lifecycle audit regressions", () => {
  it("W1 accepts each signed no-key ephemeral receipt, fans out, and quarantines missing money identity", async () => {
    for (const [event, payload, frameType] of [
      ["users.typing", { id: 55 }, "typing"],
      ["users.online", { fan: { id: 55 }, observed_at: at("01"), last_seen_online_at: at("01") }, "presence"],
      ["users.offline", { fan: { id: 55 }, observed_at: at("02"), last_seen_online_at: at("01") }, "presence"],
    ] as const) {
      const first = await deliver(event, payload, { noKey: true });
      const second = await deliver(event, payload, { noKey: true });
      expect(first.id).not.toBe(second.id);
      expect(second.ack.duplicate).toBe(false);
      const row = (await testDb.pool.query("select capture_state,sync_event,raw_body from ofapi_webhook_events where id=$1", [second.id])).rows[0];
      expect(row.capture_state).toBe("accepted");
      expect(row.sync_event.type).toBe(frameType);
      expect(row.raw_body.length).toBeGreaterThan(0);
    }
    const money = await deliver("transactions.new", { id: "transaction-1" }, { noKey: true });
    expect((await testDb.pool.query("select capture_state from ofapi_webhook_events where id=$1", [money.id])).rows[0].capture_state).toBe("quarantined_malformed");
  });

  it("W2 preserves newer price and retirement against a delayed initial subscription", async () => {
    await deliver("subscriptions.renewed", subscription(at("10"), 10));
    await deliver("subscriptions.new", subscription(at("00"), 4));
    expect(await currentSubscription()).toMatchObject({ priceMills: 10000n, sourceUpdatedAt: new Date(at("10")), isCurrent: true });
    await testDb.pool.query("update page_subscriptions set is_current=false,last_seen_at=$1 where platform_account_id=$2", [at("20"), pageId]);
    await testDb.pool.query("update page_fans set is_subscriber=false where platform_account_id=$1", [pageId]);
    await deliver("subscriptions.new", subscription(at("15"), 4));
    expect(await currentSubscription()).toMatchObject({ priceMills: 10000n, isCurrent: false });
    expect((await testDb.pool.query("select is_subscriber from page_fans where platform_account_id=$1", [pageId])).rows[0].is_subscriber).toBe(false);
  });

  it("keeps both lapse history and a later renewal, then refuses stale renewed/new reactivation", async () => {
    await deliver("subscriptions.renewed", subscription(at("20"), 10));
    await deliver("subscriptions.expired", subscription(at("30"), 4, at("10")));
    expect(await currentSubscription()).toMatchObject({ isCurrent: true, canonicalStatus: "active", priceMills: 10000n });
    await deliver("subscriptions.expired", subscription(at("40"), 4, at("30")));
    await deliver("subscriptions.new", subscription(at("25"), 4));
    expect(await currentSubscription()).toMatchObject({ isCurrent: false, canonicalStatus: "expired", priceMills: 10000n, endsAt: new Date(at("30")) });
    await runCanonicalization(app, { kinds: ["subscriptions.expired", "subscriptions.renewed"] });
    const history = (await testDb.pool.query("select type,occurred_at from domain_events where account_id=$1 order by occurred_at", [pageId])).rows;
    expect(history.map(row => row.type)).toEqual(["subscription.ended", "subscription.renewed", "subscription.ended"]);
  });

  it("W3 orders account failures by authentication attempt and suppresses stale failure SSE", async () => {
    await deliver("accounts.reconnected", { latestAuthAttempt: { started_at: at("10"), completed_at: at("11") } });
    const stale = await deliver("accounts.authentication_failed", { latestAuthAttempt: { started_at: at("00"), completed_at: at("01") } });
    expect((await findPageById(app.db, pageId))?.page.ofapiAuthStatus).toBe("reconnected");
    expect((await testDb.pool.query("select sync_event from ofapi_webhook_events where id=$1", [stale.id])).rows[0].sync_event).toBeNull();
    await deliver("accounts.disconnected", { account_id: ACCOUNT, disconnected_at: at("20") });
    expect((await findPageById(app.db, pageId))?.page.ofapiAuthStatus).toBe("disconnected");
  });

  it("W4 retries a settled recovery after projection rollback and survives duplicate processing", async () => {
    await deliver("accounts.authentication_failed", { latestAuthAttempt: { started_at: at("00") } });
    await testDb.pool.query(`create function lifecycle_test_failure() returns trigger language plpgsql as $$ begin raise exception 'temporary lifecycle DB failure'; end $$;
      create trigger lifecycle_test_failure before update of ofapi_auth_status on pages for each row execute function lifecycle_test_failure()`);
    let recoveryId: number;
    try {
      recoveryId = (await deliver("accounts.reconnected", { latestAuthAttempt: { started_at: at("10") } })).id;
      const row = (await testDb.pool.query("select status,projection_status from ofapi_webhook_events where id=$1", [recoveryId])).rows[0];
      expect(row).toEqual({ status: "processed", projection_status: "failed" });
      expect((await findPageById(app.db, pageId))?.page.ofapiAuthStatus).toBe("authentication_failed");
    } finally {
      await testDb.pool.query("drop trigger lifecycle_test_failure on pages; drop function lifecycle_test_failure()");
    }
    expect(await sweepOfapiAccountHealthProjections(app)).toBe(1);
    await processOfapiWebhookEvent(app, recoveryId!);
    const row = (await testDb.pool.query("select projection_status,projection_attempts from ofapi_webhook_events where id=$1", [recoveryId!])).rows[0];
    expect(row).toEqual({ projection_status: "projected", projection_attempts: 2 });
    expect((await findPageById(app.db, pageId))?.page.ofapiAuthStatus).toBe("reconnected");
  });

  it("records all export transitions without account_id and retains completed without claiming import", async () => {
    for (const status of ["completed", "calculating_credits", "calculating_credits_completed", "calculating_credits_failed", "in_progress", "failed", "cancelled"]) {
      await deliver(`data_exports.${status}`, { id: "data_export_lifecycle", account_ids: [ACCOUNT], status, created_at: at("00"), credit_cost: 12 }, { accountId: null });
    }
    const state = await getOfapiAsyncLifecycle(app, { resourceKind: "data_export", resourceId: "data_export_lifecycle", ofapiAccountId: ACCOUNT });
    expect(state?.rank).toBe(4);
    expect(state?.conflictingTerminal).toBe(true);
    await runCanonicalization(app, { kinds: ["data_exports.completed"] });
    const events = (await testDb.pool.query("select type,data from domain_events where account_id=$1", [pageId])).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "data_export.status_changed", data: { status: "completed", artifactAccepted: false } });
    expect(await getOfapiAsyncLifecycle(app, { resourceKind: "data_export", resourceId: "data_export_lifecycle", ofapiAccountId: "acct_other" })).toBeNull();
  });

  it("distinguishes upload completed from media readiness and preserves redelivery provenance", async () => {
    const key = randomUUID();
    const payload = { id: "ofapi_media_lifecycle", account_id: ACCOUNT, status: "completed", media_id: 123, media: { isReady: false }, completed_at: at("10") };
    await deliver("media_uploads.completed", payload, { key, redeliveryOf: "delivery-original" });
    const repeat = await deliver("media_uploads.completed", payload, { key });
    expect(repeat.ack.duplicate).toBe(true);
    const state = await getOfapiAsyncLifecycle(app, { resourceKind: "media_upload", resourceId: "ofapi_media_lifecycle", ofapiAccountId: ACCOUNT });
    expect(state).toMatchObject({ status: "completed", mediaReady: false, mediaId: "123" });
    const row = (await testDb.pool.query("select capture_headers from ofapi_webhook_events where id=$1", [state!.eventId])).rows[0];
    expect(row.capture_headers.redeliveryOf).toBe("delivery-original");
    expect(buildOfapiWebhookEventSet()).toEqual([...OFAPI_WEBHOOK_EVENTS]);
    expect(buildOfapiWebhookEventSet(["account_lifecycle", "subscription_expiry"])).toContain("accounts.disconnected");
    expect(buildOfapiWebhookEventSet()).not.toContain("data_exports.completed");
  });
});
