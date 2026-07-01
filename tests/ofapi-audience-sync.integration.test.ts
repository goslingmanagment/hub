import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  findPageById,
  findPageSubscription,
  getCheckpoint,
  getOfapiCreditState,
  listPageSyncStates,
  recordOfapiCreditUsage,
  refreshPageSyncDependencies,
  requestPageSync as requestPageSyncRows,
  setPageOfapiAccountId,
  startSyncRun,
  upsertFanPages,
  upsertFans,
  upsertOfapiWebhookConfig,
  upsertPageSubscription,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import { OFAPI_WEBHOOK_EVENTS } from "../apps/runtime/src/services/ofapi-webhooks.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import {
  executeOfapiAudienceChunk,
  pauseDisabledOnlyFansAudienceForPage,
} from "../apps/runtime/src/services/sync/ofapi-audience-sync.ts";
import { resolveExecutorPageContext } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { triggerSyncBlock } from "../apps/runtime/src/services/sync-blocks.ts";
import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const OFAPI_ACCOUNT = "acct_audience_test";
const SIGNING_SECRET = "test-signing-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 7);
const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let idempotencyCounter = 0;

function nextIdempotencyKey() {
  idempotencyCounter += 1;
  return `evt_${String(idempotencyCounter).padStart(40, "0")}`;
}

function fansPage(items: Record<string, unknown>[], hasMore: boolean): OfapiListPage {
  return {
    items,
    hasNextPage: hasMore,
    meta: { creditsUsed: 1, creditBalance: 20_000, isCached: false, rateRemainingMinute: 999 },
  };
}

function activeFanItem(input: {
  id: number;
  username?: string;
  name?: string;
  price?: number;
  subscribeAt?: string;
  expiredAt?: string;
  status?: string;
  lastSeen?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    username: input.username ?? `fan${input.id}`,
    name: input.name ?? `Fan ${input.id}`,
    displayName: "",
    subscribePrice: input.price ?? 4.99,
    lastSeen: input.lastSeen ?? "2026-06-11T10:00:00+00:00",
    subscribedOnData: {
      price: input.price ?? 4.99,
      regularPrice: input.price ?? 4.99,
      subscribeAt: input.subscribeAt ?? "2026-05-01T00:00:00+00:00",
      expiredAt: input.expiredAt ?? "2026-07-01T00:00:00+00:00",
      renewedAt: null,
      status: input.status ?? "Active",
    },
  };
}

function fakeAudienceClient(pagesByOffset: Map<number, OfapiListPage>) {
  const listActiveFans = vi.fn(async (
    _context: unknown,
    _accountId: string,
    params: { offset?: number },
  ) => {
    const page = pagesByOffset.get(params.offset ?? 0);
    if (!page) {
      throw new Error(`Unexpected fans/active offset ${params.offset}`);
    }
    return page;
  });

  const client: OfapiClient = {
    createWebhook: vi.fn(async () => ({ id: "wh" })),
    updateWebhook: vi.fn(async () => ({ id: "wh" })),
    listAccounts: vi.fn(async () => []),
    listChats: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
    listChatMessages: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
    listActiveFans: listActiveFans as never,
    pingBalance: vi.fn(async () => ({ items: [], hasNextPage: false, meta: null })),
  };
  return { client, listActiveFans };
}

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  } as never;
}

async function seedMappedPage(label = "lora-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
  await ensurePageSyncStates(appContext.db, { pageId: page.id });
  return page;
}

async function buildChunkInput(page: { id: number }, options?: { maxRequests?: number }) {
  const run = await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "subscribers",
    trigger: "manual",
  });
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "onlyfans" as const,
      auth: { token: "unused" },
      proxy: null,
      egressKey: "direct",
    } as never,
    streamState: { stream: "subscribers" } as never,
    syncRunId: run.id,
    telemetry: fakeTelemetry(),
    budget: new SyncChunkBudget(options?.maxRequests ?? 10, 60_000),
  };
}

async function listSubscriptions(pageId: number) {
  const { rows } = await testDb!.pool.query<{
    platform_subscription_id: string;
    canonical_status: string;
    is_current: boolean;
    price_mills: string;
    auto_renew: boolean | null;
    renew_date: string | null;
    ends_at: string | null;
  }>(
    `select platform_subscription_id, canonical_status, is_current, price_mills::text,
            auto_renew, renew_date::text, ends_at::text
     from page_subscriptions where platform_account_id = $1
     order by platform_subscription_id`,
    [pageId],
  );
  return rows;
}

async function seedWebhookConfigAndServer() {
  await upsertOfapiWebhookConfig(appContext.db, {
    externalWebhookId: "wh_test",
    endpointUrl: "https://hub.example.com/api/v1/ofapi/webhook",
    accountScope: "global",
    events: [...OFAPI_WEBHOOK_EVENTS],
    encryptedSigningSecret: JSON.stringify(encryptJson(SIGNING_SECRET, ENCRYPTION_KEY, 1)),
  });
  server = await buildApiServer(appContext);
  await server.ready();
}

async function deliverAndProcess(envelope: Record<string, unknown>) {
  if (!server) {
    throw new Error("server not started");
  }

  const body = JSON.stringify(envelope);
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/ofapi/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", SIGNING_SECRET).update(body).digest("hex"),
      "x-ofapi-idempotency-key": nextIdempotencyKey(),
    },
  });
  expect(response.statusCode).toBe(200);

  const { rows } = await testDb!.pool.query<{ id: number }>(
    "select max(id)::int as id from ofapi_webhook_events",
  );
  const eventId = rows[0]!.id;
  await processOfapiWebhookEvent(appContext, eventId);
  return eventId;
}

function loadFixtureEnvelope(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }

  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiAudienceSyncEnabled: true,
    ofapiDmSyncEnabled: true,
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("OFAPI audience sweep", () => {
  it("sweeps fans/active into page_subscriptions with the Fansly generational expiry", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();

    // A previously-synced subscriber who no longer appears in the sweep.
    const [staleFan] = await upsertFans(appContext.db, [{
      platform: "onlyfans",
      platformUserId: "999",
      username: "gone-fan",
    }]);
    await upsertPageSubscription(appContext.db, {
      platformSubscriptionId: "999",
      platformAccountId: page.id,
      fanId: staleFan!.id,
      rawStatus: 0,
      canonicalStatus: "active",
      priceMills: 4990n,
      renewPriceMills: 4990n,
      lastSeenGeneration: 0,
    });
    await upsertFanPages(appContext.db, [{
      fanId: staleFan!.id,
      platformAccountId: page.id,
      isSubscriber: true,
    }]);

    const { client, listActiveFans } = fakeAudienceClient(new Map([
      [0, fansPage([
        activeFanItem({ id: 101, price: 4.99, status: "Active" }),
        activeFanItem({ id: 102, price: 10, status: "Set to Expire" }),
      ], true)],
      [2, fansPage([activeFanItem({ id: 103, price: 0 })], false)],
    ]));
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiAudienceChunk(appContext, await buildChunkInput(page));
    expect(result.satisfied).toBe(true);
    expect(result.stats).toMatchObject({ fullSweepCompleted: true, processedFans: 3 });
    expect(listActiveFans).toHaveBeenCalledTimes(2);

    const subscriptions = await listSubscriptions(page.id);
    expect(subscriptions).toHaveLength(4);
    const byId = new Map(subscriptions.map((row) => [row.platform_subscription_id, row]));
    expect(byId.get("101")).toMatchObject({
      canonical_status: "active",
      is_current: true,
      price_mills: "4990",
      auto_renew: true,
    });
    expect(byId.get("102")).toMatchObject({
      is_current: true,
      price_mills: "10000",
      auto_renew: false,
    });
    expect(byId.get("103")).toMatchObject({ is_current: true, price_mills: "0" });
    // The stale subscription was expired by the generational sweep.
    expect(byId.get("999")).toMatchObject({ is_current: false });

    // page_fans subscriber state + presence landed for swept fans, cleared for the stale one.
    const { rows: fanPages } = await testDb.pool.query<{
      platform_user_id: string;
      is_subscriber: boolean;
      external_presence_at: string | null;
    }>(
      `select f.platform_user_id, pf.is_subscriber, pf.external_presence_at::text
       from page_fans pf join fans f on f.id = pf.fan_id
       where pf.platform_account_id = $1
       order by f.platform_user_id`,
      [page.id],
    );
    const fanPageById = new Map(fanPages.map((row) => [row.platform_user_id, row]));
    expect(fanPageById.get("101")?.is_subscriber).toBe(true);
    expect(fanPageById.get("101")?.external_presence_at).not.toBeNull();
    expect(fanPageById.get("999")?.is_subscriber).toBe(false);

    // Checkpoint records the completed sweep; credits were recorded per request.
    const checkpoint = await getCheckpoint(appContext.db, page.id, "subscribers");
    expect(checkpoint?.state).toMatchObject({
      mode: "ofapi_audience",
      generation: 1,
      sweepStartedAt: null,
    });
    const credit = await getOfapiCreditState(appContext.db);
    expect(credit.spentToday).toBe(2);
    expect(credit.lastBalance).toBe(20_000);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("skips when the sweep interval has not elapsed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const { client, listActiveFans } = fakeAudienceClient(new Map([
      [0, fansPage([activeFanItem({ id: 101 })], false)],
    ]));
    appContext = { ...appContext, ofapi: client };

    const first = await executeOfapiAudienceChunk(appContext, await buildChunkInput(page));
    expect(first.satisfied).toBe(true);

    const second = await executeOfapiAudienceChunk(appContext, await buildChunkInput(page));
    expect(second.satisfied).toBe(true);
    expect(second.stats).toMatchObject({ skipped: "sweep_not_due" });
    expect(listActiveFans).toHaveBeenCalledTimes(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("yields on the audience request cap and resumes the walk mid-sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiAudienceSyncEnabled: true,
      ofapiAudienceMaxRequestsPerRun: 1,
    });
    const page = await seedMappedPage();
    const { client, listActiveFans } = fakeAudienceClient(new Map([
      [0, fansPage([activeFanItem({ id: 101 }), activeFanItem({ id: 102 })], true)],
      [2, fansPage([activeFanItem({ id: 103 })], false)],
    ]));
    appContext = { ...appContext, ofapi: client };

    const first = await executeOfapiAudienceChunk(appContext, await buildChunkInput(page));
    expect(first.satisfied).toBe(false);
    expect(first.yieldReason).toBe("request_budget");
    expect(first.stats).toMatchObject({ ofapiBudgetBlock: "ofapi_request_budget" });
    expect(listActiveFans).toHaveBeenCalledTimes(1);

    // No expiry ran mid-sweep: the first page's fans are current, nothing else.
    expect((await listSubscriptions(page.id)).every((row) => row.is_current)).toBe(true);

    const second = await executeOfapiAudienceChunk(appContext, await buildChunkInput(page));
    expect(second.satisfied).toBe(true);
    expect(second.stats).toMatchObject({ fullSweepCompleted: true });
    expect(listActiveFans).toHaveBeenCalledTimes(2);
    expect(await listSubscriptions(page.id)).toHaveLength(3);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("parks the stream when the audience daily credit budget is exhausted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiAudienceSyncEnabled: true,
      ofapiAudienceDailyCreditBudget: 5,
    });
    const page = await seedMappedPage();
    // Ledger off -> the guard falls back to the global day counter.
    await recordOfapiCreditUsage(appContext.db, { creditsUsed: 10, balance: 20_000 });

    const { client, listActiveFans } = fakeAudienceClient(new Map());
    appContext = { ...appContext, ofapi: client };

    const result = await executeOfapiAudienceChunk(appContext, await buildChunkInput(page));
    expect(result.satisfied).toBe(false);
    expect(result.stats).toMatchObject({ ofapiBudgetBlock: "ofapi_daily_credit_budget" });
    expect(result.continuationRetryAt).toBeInstanceOf(Date);
    expect(result.continuationRequestSource).toBe("scheduled");
    expect(listActiveFans).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses destructive finalization when the first page is unexpectedly empty", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const [fan] = await upsertFans(appContext.db, [{
      platform: "onlyfans",
      platformUserId: "555",
    }]);
    await upsertPageSubscription(appContext.db, {
      platformSubscriptionId: "555",
      platformAccountId: page.id,
      fanId: fan!.id,
      rawStatus: 0,
      canonicalStatus: "active",
      priceMills: 0n,
      renewPriceMills: 0n,
      lastSeenGeneration: 0,
    });

    const { client } = fakeAudienceClient(new Map([[0, fansPage([], false)]]));
    appContext = { ...appContext, ofapi: client };

    await expect(
      executeOfapiAudienceChunk(appContext, await buildChunkInput(page)),
    ).rejects.toThrow("refusing destructive finalization");
    expect((await listSubscriptions(page.id))[0]).toMatchObject({ is_current: true });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("OFAPI live subscription projection", () => {
  it("projects subscriptions.new into page_subscriptions without a sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await seedWebhookConfigAndServer();

    const envelope = loadFixtureEnvelope("subscriptions_new.json");
    envelope.account_id = OFAPI_ACCOUNT;
    await deliverAndProcess(envelope);

    const subscription = await findPageSubscription(appContext.db, {
      platformAccountId: page.id,
      platformSubscriptionId: "1000032",
    });
    expect(subscription).not.toBeNull();
    expect(subscription).toMatchObject({
      canonicalStatus: "active",
      isCurrent: true,
    });
    expect(subscription?.sourceCreatedAt).toEqual(new Date("2026-06-10T18:40:00+00:00"));

    // The journal row is marked projected (audience flag on).
    const { rows } = await testDb.pool.query<{ projection_status: string }>(
      "select projection_status from ofapi_webhook_events order by id desc limit 1",
    );
    expect(rows[0]!.projection_status).toBe("projected");

    // page_fans flips isSubscriber and presence lands from user.lastSeen.
    const { rows: fanPages } = await testDb.pool.query<{
      is_subscriber: boolean;
      external_presence_at: string | null;
    }>(
      `select pf.is_subscriber, pf.external_presence_at::text
       from page_fans pf join fans f on f.id = pf.fan_id
       where pf.platform_account_id = $1 and f.platform_user_id = '1000032'`,
      [page.id],
    );
    expect(fanPages[0]).toMatchObject({ is_subscriber: true });
    expect(fanPages[0]!.external_presence_at).not.toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("applies renewals forward-only and prices from the formatted pair", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    await seedWebhookConfigAndServer();

    const renewed = loadFixtureEnvelope("unverified_subscriptions_renewed.json");
    renewed.account_id = OFAPI_ACCOUNT;
    await deliverAndProcess(renewed);

    const subscription = await findPageSubscription(appContext.db, {
      platformAccountId: page.id,
      platformSubscriptionId: "34547118",
    });
    expect(subscription).not.toBeNull();
    expect(subscription?.priceMills).toBe(4000n);
    const updatedAfterFirst = subscription!.sourceUpdatedAt;

    // Replaying the same (older) event never regresses the timestamp.
    const replay = loadFixtureEnvelope("unverified_subscriptions_renewed.json");
    replay.account_id = OFAPI_ACCOUNT;
    await deliverAndProcess(replay);
    const after = await findPageSubscription(appContext.db, {
      platformAccountId: page.id,
      platformSubscriptionId: "34547118",
    });
    expect(after?.sourceUpdatedAt).toEqual(updatedAfterFirst);
    expect(after?.isCurrent).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves subscription rows pending when the audience flag is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, { ofapiAudienceSyncEnabled: false });
    const page = await seedMappedPage();
    await seedWebhookConfigAndServer();

    const envelope = loadFixtureEnvelope("subscriptions_new.json");
    envelope.account_id = OFAPI_ACCOUNT;
    await deliverAndProcess(envelope);

    expect(await findPageSubscription(appContext.db, {
      platformAccountId: page.id,
      platformSubscriptionId: "1000032",
    })).toBeNull();

    // Stamped pending regardless of the flag, so enabling later back-projects.
    const { rows } = await testDb.pool.query<{ projection_status: string }>(
      "select projection_status from ofapi_webhook_events order by id desc limit 1",
    );
    expect(rows[0]!.projection_status).toBe("pending");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("audience stream plumbing", () => {
  it("resolves OFAPI audience streams without legacy OnlyFans credentials", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();

    await expect(resolveExecutorPageContext(appContext, page.id, "subscribers"))
      .resolves.toMatchObject({
        platform: "onlyfans",
        page: {
          id: page.id,
          ofapiAccountId: OFAPI_ACCOUNT,
        },
      });
    await expect(resolveExecutorPageContext(appContext, page.id, "transactions"))
      .rejects.toThrow(`Page "${page.id}" has no stored platform credentials`);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("exposes the audience block for eligible OnlyFans pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const boss = { send: vi.fn(async () => "job") };
    const result = await triggerSyncBlock(appContext, boss as never, {
      pageLabel: "lora-of",
      block: "audience",
    });
    expect(result.requests.map((request) => request.stream)).toContain("subscribers");

    const states = await listPageSyncStates(appContext.db, {
      pageId: page.id,
      streams: ["subscribers"],
    });
    expect(states[0]?.status).not.toBe("paused");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("force-pauses the audience stream for non-eligible pages and never blocks DM streams on it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // DM sync on, audience OFF — the exact decision-#49 configuration that must
    // keep working when the subscribers row appears for OnlyFans pages.
    appContext = createTestAppContext(testDb, {
      ofapiAudienceSyncEnabled: false,
      ofapiDmSyncEnabled: true,
    });
    const page = await seedMappedPage();

    const paused = await pauseDisabledOnlyFansAudienceForPage(appContext, page.id);
    expect(paused).toBe(true);

    await requestPageSyncRows(appContext.db, {
      pageId: page.id,
      streams: ["light", "transactions", "dm_conversations", "dm_messages"],
      source: "manual",
    });
    await refreshPageSyncDependencies(appContext.db, { pageId: page.id });

    const states = await listPageSyncStates(appContext.db, { pageId: page.id });
    const byStream = new Map(states.map((state) => [state.stream, state]));
    expect(byStream.get("subscribers")?.status).toBe("paused");
    // OFAPI-fed OnlyFans DM must not wait on legacy light/financial/audience
    // streams: these pages can intentionally run without stored platform creds.
    expect(byStream.get("dm_conversations")?.status).toBe("pending");
    expect(byStream.get("dm_conversations")?.blockerMessage).toBeNull();
    expect(byStream.get("dm_messages")?.status).toBe("blocked");
    expect(byStream.get("dm_messages")?.blockerMessage).toBe("Waiting for dm_conversations");
    expect(byStream.get("dm_messages")?.blockerMessage ?? "").not.toContain("light");
    expect(byStream.get("dm_messages")?.blockerMessage ?? "").not.toContain("transactions");
    expect(byStream.get("dm_conversations")?.blockerMessage ?? "").not.toContain("subscribers");
    expect(byStream.get("dm_messages")?.blockerMessage ?? "").not.toContain("subscribers");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports the audience block not_available unless flag+mapping are active (audit B1)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const mapped = await seedMappedPage();
    const unmappedModel = await createModel(appContext.db, {
      slug: "model-lora-of-unmapped",
      name: "Model lora-of-unmapped",
    });
    const unmapped = await createOnlyFansPage(appContext.db, {
      modelId: unmappedModel.id,
      label: "lora-of-unmapped",
    });
    await ensurePageSyncStates(appContext.db, { pageId: unmapped.id });

    // Flag on: only the OFAPI-mapped page exposes a live audience block.
    const enabled = await getSyncStatusSnapshot(appContext, {
      pageIds: [mapped.id, unmapped.id],
    });
    const enabledByLabel = new Map(enabled.pages.map((page) => [page.pageLabel, page]));
    expect(enabledByLabel.get("lora-of")?.blocks.audience.state).not.toBe("not_available");
    expect(enabledByLabel.get("lora-of-unmapped")?.blocks.audience.state).toBe("not_available");
    expect(enabledByLabel.get("lora-of-unmapped")?.blocks.messages_live.state).not.toBe("not_available");

    // Flag off: even the mapped page must read not_available instead of
    // nagging about a sync that is intentionally not running.
    const disabledContext = createTestAppContext(testDb, {
      ofapiAudienceSyncEnabled: false,
      ofapiDmSyncEnabled: true,
    });
    const disabled = await getSyncStatusSnapshot(disabledContext, { pageIds: [mapped.id] });
    expect(disabled.pages[0]?.blocks.audience.state).toBe("not_available");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
