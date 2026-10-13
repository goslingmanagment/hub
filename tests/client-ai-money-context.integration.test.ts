import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  deactivatePageSubscriptionsByGeneration,
  insertObservation,
  refreshFanPageSubscriberState,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertArchivedPageSubscriptions,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageSubscriptions,
  upsertTransaction,
} from "@agency_hub_core/db";
import type { FanslySubscriber } from "@agency_hub_core/fansly";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createBundledPersonalities,
  loadFanslySpendingContext,
  loadFanslySubscriptionContext,
  loadSpendingContext,
  loadSubscriptionContext,
} from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { resetCanonicalizeSweepRuntime, runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { buildFanslySubscriptionRows } from "../apps/runtime/src/sync/fansly/lib/audience-rules.ts";
import { mapFanslyTransactionItem } from "../apps/runtime/src/sync/fansly/lib/money-rules.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  REFERENCE_FAN,
  REFERENCE_LEDGER,
  REFERENCE_NOW,
  REFERENCE_SPENDING_DEEP,
  REFERENCE_SPENDING_NONE,
  REFERENCE_SPENDING_QUICK,
  REFERENCE_SUBSCRIPTIONS,
  referenceWalletItem,
  withLedgerTypeNames,
  type ReferenceLedgerRow,
  type ReferenceSubscription,
} from "./helpers/fansly-money-reference.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension R20 HF-7г (parity row AI-145): spend and subscription in the
// AI context, through the real database and the real route.
//
// OnlyFans first: its two blocks are pinned as text, read by the loaders from
// seeded rows. The pins were written on hub main 4f02f9e3e, BEFORE the Fansly
// blocks existed, and are not to move with them. Then Fansly: a request
// without `clientContext` against the released extension's own blocks, and
// the released extension's request, which keeps the blocks it sent.

/** The clock of every block pinned below. */
const NOW = "2026-10-13T12:00:00.000Z";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
/** A full device token of a chatter of both pages. */
let token = "";
let trap: NoOutboundTrap | null = null;
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput; calls: number } = { calls: 0 };

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.calls += 1;
      provider.input = input;
      yield { type: "content_delta", text: "sure thing" };
      yield {
        type: "usage",
        providerResponseId: "msg_money",
        cacheHit: false,
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costMicroUsd: 100,
          costApproximate: false,
        },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await server?.close();
  await resetIntegrationDatabase(testDb.pool);
  resetCanonicalizeSweepRuntime();
  app = createTestAppContext(testDb);
  app.config.chatMuseAiGatewayEnabled = true;
  app.aiGatewayProvider = capturingProvider();
  provider.calls = 0;
  delete provider.input;
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id,
    displayName: persona.name,
    systemBlock: persona.content,
    bundledVersion: persona.builtinVersion!,
  });
  const model = await createModel(app.db, { slug: "money", name: "Money" });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  for (const [label, create] of [
    ["money-fs", createFanslyPage],
    ["money-of", createOnlyFansPage],
  ] as const) {
    const page = await create(app.db, { modelId: model.id, label });
    if (!page) {
      throw new Error(`test setup: page ${label} creation failed`);
    }
    pageIds[label] = page.id;
    await storeProxyConfig(app.db, page.id, {
      url: "socks5://proxy.example:1080",
      encryptedAuth: null,
      keyVersion: null,
      rateLimitScopeKey: "shared-ai-proxy",
    });
  }
  await createUserAccount(app, { username: "money-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "money-chatter", pageLabel: "money-fs" }, { source: "cli" })).key;
  await assignPageToUser(app, { userId: await fixtureUserId(app, "money-chatter"), pageLabel: "money-of" }, { source: "cli" });
  server = await buildApiServer(app);
  await server.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  await trap?.restore();
  trap = null;
});

/** The hub's fan row of a platform account id. */
async function fanId(platform: "fansly" | "onlyfans", ref: string): Promise<number> {
  const [fan] = await upsertFans(app.db, [{ platform, platformUserId: ref }]);
  return fan!.id;
}

/** One AI request of the new client: refs only, the hub loads the context. */
async function ask(input: {
  feature?: string;
  page: string;
  platform: string;
  body: Record<string, unknown>;
}): Promise<InjectResponse> {
  delete provider.input;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature ?? "fast-reply"}`,
    headers: { authorization: `Bearer ${token}`, "x-kernel-ai-capabilities": "context-v1" },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page,
      platform: input.platform,
      ...input.body,
    },
  });
}

/** The user side of the prompt the provider was given. */
function userText(): string {
  return provider.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
}

/** The body of one `<tag>` section of the prompt, or null when it is absent. */
function section(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text);
  return match ? match[1]! : null;
}

// ── OnlyFans ────────────────────────────────────────────────────────────────

const OF_WHALE = "5550001";
const OF_LAPSED = "5550002";
const OF_FOLLOWER = "5550003";
const OF_UNKNOWN = "5550004";
const OF_CAPPED = "5550005";

/** One OnlyFans ledger row, as the OFAPI writers store it. */
async function onlyFansLedger(
  fan: number,
  row: { id: string; type: string; gross: number; at: string; active?: boolean },
) {
  await testDb!.pool.query(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
       canonical_type, transaction_state, raw_status, gross_amount_mills,
       source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
     values ($1, $2, $3, $4, $5, 'posted', 'done', $6, $6, $7, $8, 'ofapi:webhook', $9)`,
    [pageIds["money-of"], fan, row.id, row.type, row.type, row.gross, (row.gross * 8) / 10, row.at, row.active ?? true],
  );
}

async function onlyFansPageFan(
  fan: number,
  state: {
    subscriber: boolean;
    since?: string;
    expires?: string;
    autoRenew?: boolean;
    autoRenewOffAt?: string;
  },
) {
  await testDb!.pool.query(
    `insert into page_fans (fan_id, platform_account_id, is_subscriber, subscriber_since,
       subscription_expires_at, auto_renew, auto_renew_off_detected_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fan, pageIds["money-of"], state.subscriber, state.since ?? null, state.expires ?? null,
      state.autoRenew ?? null, state.autoRenewOffAt ?? null,
    ],
  );
}

async function seedOnlyFansMoney() {
  const whale = await fanId("onlyfans", OF_WHALE);
  await onlyFansPageFan(whale, {
    subscriber: true,
    since: "2026-03-01T10:00:00Z",
    expires: "2026-11-01T10:00:00Z",
    autoRenew: false,
    autoRenewOffAt: "2026-10-05T09:00:00Z",
  });
  for (const row of [
    { id: "of-1", type: "subscription", gross: 9990, at: "2026-03-01T10:00:00Z" },
    { id: "of-2", type: "subscription", gross: 9990, at: "2026-04-01T10:00:00Z" },
    { id: "of-3", type: "tip", gross: 25000, at: "2026-04-15T20:30:00Z" },
    { id: "of-4", type: "message_purchase", gross: 15000, at: "2026-05-02T08:00:00Z" },
    { id: "of-5", type: "post_purchase", gross: 7000, at: "2026-05-03T08:00:00Z" },
    { id: "of-6", type: "stream_tip", gross: 3000, at: "2026-06-01T08:00:00Z" },
    { id: "of-7", type: "refund", gross: -15000, at: "2026-06-02T08:00:00Z" },
    { id: "of-8", type: "other", gross: 1005, at: "2026-06-03T08:00:00Z" },
    // A deactivated row is not money.
    { id: "of-9", type: "tip", gross: 99000, at: "2026-06-04T08:00:00Z", active: false },
  ]) {
    await onlyFansLedger(whale, row);
  }

  const lapsed = await fanId("onlyfans", OF_LAPSED);
  await onlyFansPageFan(lapsed, { subscriber: false, since: "2026-06-01T00:00:00Z", expires: "2026-09-01T00:00:00Z" });
  await onlyFansLedger(lapsed, { id: "of-lapsed-1", type: "tip", gross: 5000, at: "2026-06-10T08:00:00Z" });

  const follower = await fanId("onlyfans", OF_FOLLOWER);
  await onlyFansPageFan(follower, { subscriber: false });

  // 501 tips of $1: the OnlyFans block reads the newest 500 rows.
  const capped = await fanId("onlyfans", OF_CAPPED);
  await onlyFansPageFan(capped, { subscriber: true, since: "2026-09-01T00:00:00Z", expires: "2026-10-20T00:00:00Z", autoRenew: true });
  await testDb!.pool.query(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
       canonical_type, transaction_state, raw_status, gross_amount_mills,
       source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
     select $1, $2, 'of-capped-' || g, 'tip', 'tip', 'posted', 'done', 1000, 1000, 800,
            timestamptz '2026-09-01T00:00:00Z' + (g || ' minutes')::interval, 'ofapi:webhook'
     from generate_series(1, 501) g`,
    [pageIds["money-of"], capped],
  );
}

/** Both blocks of an OnlyFans fan, read by the loaders at `NOW`. */
async function onlyFansBlocks(fanRef: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  try {
    const input = { pageId: pageIds["money-of"]!, fanRef };
    return {
      spending: (await loadSpendingContext(app, input)).block,
      subscription: (await loadSubscriptionContext(app, input)).block,
    };
  } finally {
    vi.useRealTimers();
  }
}

describe("OnlyFans keeps its spend and subscription blocks (golden, pinned before HF-7г)", () => {
  it("a subscriber with every kind of ledger row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedOnlyFansMoney();
    const blocks = await onlyFansBlocks(OF_WHALE);
    expect(blocks.spending).toMatchInlineSnapshot(`
      "FAN SPENDING DATA:
      Fan ID: 5550001
      Total gross (all-time): $55.98
      Type breakdown (all-time):
      - Tips: $25.00
      - Subscriptions: $19.98
      - Paid messages: $15.00
      - Paid posts: $7.00"
    `);
    expect(blocks.subscription).toMatchInlineSnapshot(`
      "FAN SUBSCRIPTION DATA:
      Status: Active
      Subscribed since: Mar 1, 2026 (226 days ago)
      Current period ends: Nov 1, 2026 (in 18 days)
      Auto-renew: Off — will NOT renew (churn risk)"
    `);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan whose subscription ran out, a fan who never subscribed, a fan the hub does not know", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedOnlyFansMoney();
    expect(await onlyFansBlocks(OF_LAPSED)).toMatchInlineSnapshot(`
      {
        "spending": "FAN SPENDING DATA:
      Fan ID: 5550002
      Total gross (all-time): $5.00
      Type breakdown (all-time):
      - Tips: $5.00",
        "subscription": "FAN SUBSCRIPTION DATA:
      Status: Expired (ended Sep 1, 2026 — 42 days ago)
      Was subscribed for: 92 days
      Subscribed since: Jun 1, 2026 (134 days ago)",
      }
    `);
    expect(await onlyFansBlocks(OF_FOLLOWER)).toMatchInlineSnapshot(`
      {
        "spending": "",
        "subscription": "FAN SUBSCRIPTION DATA:
      Status: Expired",
      }
    `);
    expect(await onlyFansBlocks(OF_UNKNOWN)).toMatchInlineSnapshot(`
      {
        "spending": "",
        "subscription": "FAN SUBSCRIPTION DATA:
      Status: Not subscribed",
      }
    `);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan with more than 500 ledger rows reads the newest 500", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedOnlyFansMoney();
    expect(await onlyFansBlocks(OF_CAPPED)).toMatchInlineSnapshot(`
      {
        "spending": "FAN SPENDING DATA:
      Fan ID: 5550005
      Total gross (all-time): $500.00
      Type breakdown (all-time):
      - Tips: $500.00",
        "subscription": "FAN SUBSCRIPTION DATA:
      Status: Active
      Subscribed since: Sep 1, 2026 (42 days ago)
      Current period ends: Oct 20, 2026 (in 6 days)
      Auto-renew: On",
      }
    `);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the route gives the model exactly these blocks, quick and deep feature alike", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedOnlyFansMoney();
    // 30 archived messages: the deep features ask for that many.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
         is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
       select $1, 'onlyfans', $2, (700000 + g)::text, case when g % 2 = 1 then $2 end, g % 2 = 0,
              now() - ((40 - g) || ' minutes')::interval, 'line-' || g, false, 0
       from generate_series(1, 30) g`,
      [pageIds["money-of"], OF_WHALE],
    );
    const input = { pageId: pageIds["money-of"]!, fanRef: OF_WHALE };
    for (const feature of ["fast-reply", "fan-summary"]) {
      // The same loaders, read on the request's own clock.
      const spending = (await loadSpendingContext(app, input)).block;
      const subscription = (await loadSubscriptionContext(app, input)).block;
      const response = await ask({ feature, page: "money-of", platform: "onlyfans", body: { conversationRef: OF_WHALE } });
      expect(response.statusCode, `${feature}: ${response.body}`).toBe(200);
      expect(section(userText(), "fan_spending_data"), feature).toBe(spending);
      expect(section(userText(), "fan_subscription_data"), feature).toBe(subscription);
      expect(spending, feature).toContain(`Fan ID: ${OF_WHALE}`);
      expect(spending, feature).not.toContain("Monthly");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

// ── Fansly ──────────────────────────────────────────────────────────────────
//
// A request of the new chat-extension carries no `clientContext`: the hub
// loads the context itself. Its two blocks are compared with the released
// Fansly extension's own (helpers/fansly-money-reference.ts: the texts
// fansly-chat 2.10.1 produces for the same wallet rows and subscription),
// through the hub's real writers: Fansly's wallet rows by the ledger's own
// money rule, a `/subscribers` item by the audience rule, the walks' writes.

const FS_PAGE_REF = "600000000000000002";
const FS_GROUP = "650000000000000001";
const FS_FAN = REFERENCE_FAN;
const FS_OTHER_FAN = "700000000000000002";
const REFERENCE_CLOCK = Date.parse(REFERENCE_NOW);

/** The fan's chat on money-fs: `count` archived messages and the page's thread. */
async function seedFanslyChat(count = 30, fan = FS_FAN, group = FS_GROUP, firstRef = 800000) {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, true)`,
    [pageIds["money-fs"], group, fan],
  );
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
       is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
     select $1, 'fansly', $2, ($5::int + g)::text, case when g % 2 = 1 then $3 end, g % 2 = 0,
            now() - ((40 - g) || ' minutes')::interval, 'line-' || g, false, 0
     from generate_series(1, $4::int) g`,
    [pageIds["money-fs"], group, fan, count, firstRef],
  );
}

/** Wallet rows into the ledger as the transactions walk writes them. */
async function seedFanslyLedger(ledger: readonly ReferenceLedgerRow[], fan = FS_FAN, firstIndex = 0) {
  const fanRow = await fanId("fansly", fan);
  for (const [index, row] of ledger.entries()) {
    const item = { ...referenceWalletItem(row, firstIndex + index), correlationAccountId: fan, senderId: fan };
    await upsertTransaction(app.db, {
      platformAccountId: pageIds["money-fs"]!,
      source: "fansly:rest",
      fanId: fanRow,
      ...mapFanslyTransactionItem(item, 0.2).row,
    });
  }
}

/** A `/subscribers` item of a fan, as Fansly serves it. */
function subscriberItem(subscription: ReferenceSubscription, fan = FS_FAN): FanslySubscriber {
  return {
    id: `81${fan.slice(2)}`,
    historyId: null,
    subscriberId: fan,
    subscriptionTierId: "820000000000000001",
    subscriptionTierName: subscription.tierName,
    subscriptionTierColor: null,
    planId: "830000000000000001",
    status: subscription.status,
    price: subscription.renewPrice,
    renewPrice: subscription.renewPrice,
    autoRenew: subscription.autoRenew === null ? null : subscription.autoRenew ? 1 : 0,
    billingCycle: subscription.billingCycle,
    duration: null,
    renewDate: null,
    createdAt: subscription.createdAt === null ? null : Date.parse(subscription.createdAt),
    updatedAt: null,
    endsAt: subscription.endsAt === null ? null : Date.parse(subscription.endsAt),
  };
}

/**
 * One page of a subscribers walk, written as the walk writes it: `active` is
 * the hourly walk of the active list (generation `generation`), `expired` the
 * walk of the expired list. The page's fan rows follow, as after every walk.
 */
async function subscribersWalk(mode: "active" | "expired", items: FanslySubscriber[], generation = 1) {
  const pageId = pageIds["money-fs"]!;
  const fanMap = new Map<string, number>();
  for (const item of items) {
    fanMap.set(item.subscriberId, await fanId("fansly", item.subscriberId));
  }
  const rows = buildFanslySubscriptionRows({ platformAccountId: pageId, generation, mode, items, fanMap });
  if (mode === "active") {
    await upsertPageSubscriptions(app.db, rows.subscriptions);
    await upsertFanPages(app.db, rows.fanPages);
    // What the walk did not see is no longer current.
    await deactivatePageSubscriptionsByGeneration(app.db, { platformAccountId: pageId, generation });
  } else {
    await upsertArchivedPageSubscriptions(app.db, rows.subscriptions);
  }
  await refreshFanPageSubscriberState(app.db, pageId);
}

async function fanslyBlocks(fanRef: string, deep = false) {
  const pageId = pageIds["money-fs"]!;
  return {
    spending: (await loadFanslySpendingContext(app, { pageId, fanRef, deep })).block,
    subscription: (await loadFanslySubscriptionContext(app, { pageId, fanRef, now: REFERENCE_CLOCK })).block,
  };
}

/** What `page_fans` holds of a fan's subscription: all the old loader read. */
async function pageFanState(fan: string) {
  const { rows } = await testDb!.pool.query<{ is_subscriber: boolean; subscriber_since: Date | null; subscription_expires_at: Date | null }>(
    `select pf.is_subscriber, pf.subscriber_since, pf.subscription_expires_at
     from page_fans pf join fans f on f.id = pf.fan_id
     where pf.platform_account_id = $1 and f.platform = 'fansly' and f.platform_user_id = $2`,
    [pageIds["money-fs"], fan],
  );
  return rows[0] ?? null;
}

describe("[AI-145] Fansly spend from the hub's ledger, without clientContext", () => {
  it("the reference fan: the extension's block with the ledger's type names, quick and deep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedFanslyLedger(REFERENCE_LEDGER);
    expect((await fanslyBlocks(FS_FAN)).spending).toBe(withLedgerTypeNames(REFERENCE_SPENDING_QUICK));
    expect((await fanslyBlocks(FS_FAN, true)).spending).toBe(withLedgerTypeNames(REFERENCE_SPENDING_DEEP));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads this fan's active rows on this page only, whatever else the ledger holds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedFanslyLedger(REFERENCE_LEDGER);
    // Another fan of the page, a deactivated row of this fan, and a fan of
    // the OnlyFans page who carries the same account id.
    await seedFanslyLedger([{ type: 7101, gross: 777000, net: 621600, at: "2026-10-02T10:00:00.000Z" }], FS_OTHER_FAN, 500);
    await seedFanslyLedger([{ type: 7101, gross: 888000, net: 710400, at: "2026-10-02T11:00:00.000Z" }], FS_FAN, 600);
    await testDb.pool.query(
      `update transactions set is_active = false, inactive_reason = 'missing_from_sync_window', inactivated_at = now()
       where platform_account_id = $1 and gross_amount_mills = 888000`,
      [pageIds["money-fs"]],
    );
    await onlyFansLedger(await fanId("onlyfans", FS_FAN), { id: "of-same-id", type: "tip", gross: 999000, at: "2026-10-02T12:00:00Z" });

    expect((await fanslyBlocks(FS_FAN, true)).spending).toBe(withLedgerTypeNames(REFERENCE_SPENDING_DEEP));
    expect((await fanslyBlocks(FS_OTHER_FAN)).spending).toBe([
      "FAN SPENDING DATA:",
      `Correlation account ID: ${FS_OTHER_FAN}`,
      "Total gross (all-time): $777.00",
      "Total net (all-time): $621.60",
      "Type breakdown (all-time):",
      "- Tips: $777.00",
      "Monthly totals:",
      "- Oct 2026: $777.00",
    ].join("\n"));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan without a ledger row reads the zero totals; an account the hub does not know reads nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await fanId("fansly", FS_FAN);
    expect((await fanslyBlocks(FS_FAN, true)).spending).toBe(REFERENCE_SPENDING_NONE);
    // No fan row: the hub cannot say this account spent nothing. An OnlyFans
    // fan with the same id does not make it known.
    await fanId("onlyfans", FS_OTHER_FAN);
    expect(await fanslyBlocks(FS_OTHER_FAN, true)).toEqual({ spending: "", subscription: "" });
    expect(await fanslyBlocks(FS_GROUP)).toEqual({ spending: "", subscription: "" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan with more than 500 ledger rows reads them all", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // 600 tips of $1, one a minute across the turn of a month.
    await testDb.pool.query(
      `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
         canonical_type, transaction_state, raw_status, gross_amount_mills,
         source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
       select $1, $2, 'fs-many-' || g, '7101', 'tip', 'posted', '2', 1000, 800, 800,
              timestamptz '2026-09-30T19:00:00Z' + (g || ' minutes')::interval, 'fansly:rest'
       from generate_series(1, 600) g`,
      [pageIds["money-fs"], await fanId("fansly", FS_FAN)],
    );
    expect((await fanslyBlocks(FS_FAN, true)).spending).toBe([
      "FAN SPENDING DATA:",
      `Correlation account ID: ${FS_FAN}`,
      "Total gross (all-time): $600.00",
      "Total net (all-time): $480.00",
      "Type breakdown (all-time):",
      "- Tips: $600.00",
      "Monthly totals:",
      "- Oct 2026: $301.00",
      "- Sep 2026: $299.00",
      "Monthly breakdown by type:",
      "- Oct 2026: Tips $301.00",
      "- Sep 2026: Tips $299.00",
    ].join("\n"));
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[AI-145] Fansly subscription from the hub's capture, without clientContext", () => {
  it("a subscriber the active list serves: the extension's block", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    for (const name of ["active", "activeNoRenew", "lapsedPeriod", "bare", "yearly"] as const) {
      const reference = REFERENCE_SUBSCRIPTIONS[name];
      await subscribersWalk("active", [subscriberItem(reference.subscription)]);
      expect((await fanslyBlocks(FS_FAN)).subscription, name).toBe(reference.block);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an ex-subscriber the expired list served: when it ended and how long it lasted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const reference = REFERENCE_SUBSCRIPTIONS.expired;
    await subscribersWalk("expired", [subscriberItem(reference.subscription)]);
    expect((await fanslyBlocks(FS_FAN)).subscription).toBe(reference.block);
    expect(reference.block).toContain("Status: Expired (ended Sep 1, 2026 — 42 days ago)");
    expect(reference.block).toContain("Was subscribed for: 92 days");
    // The expired walk writes no page link: a fan the page knows only as a
    // past subscriber has no `page_fans` row for the old loader to read.
    expect(await pageFanState(FS_FAN)).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a subscriber who left since the expired list was read: the same block, from the retired row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // He was on the active list at one walk and is gone at the next. The row
    // keeps what the first walk saw, status 3 included.
    const reference = REFERENCE_SUBSCRIPTIONS.expired;
    await subscribersWalk("active", [subscriberItem({ ...reference.subscription, status: 3 })], 1);
    expect(await pageFanState(FS_FAN)).toMatchObject({ is_subscriber: true });
    await subscribersWalk("active", [subscriberItem(REFERENCE_SUBSCRIPTIONS.active.subscription, FS_OTHER_FAN)], 2);

    expect((await fanslyBlocks(FS_FAN)).subscription).toBe(reference.block);
    // `page_fans` forgot the subscription with its last current row: the
    // dates the block reads exist only in `page_subscriptions`.
    expect(await pageFanState(FS_FAN)).toEqual({ is_subscriber: false, subscriber_since: null, subscription_expires_at: null });
    // The fan who is on the list is untouched by it.
    expect((await fanslyBlocks(FS_OTHER_FAN)).subscription)
      .toBe(REFERENCE_SUBSCRIPTIONS.active.block.replace(FS_FAN, FS_OTHER_FAN));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a returning subscriber reads the current subscription, not the ended one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await subscribersWalk("expired", [{ ...subscriberItem(REFERENCE_SUBSCRIPTIONS.expired.subscription), id: "810000000000000777" }]);
    await subscribersWalk("active", [subscriberItem(REFERENCE_SUBSCRIPTIONS.active.subscription)]);
    expect((await fanslyBlocks(FS_FAN)).subscription).toBe(REFERENCE_SUBSCRIPTIONS.active.block);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan who never subscribed gets no block, a follower of the page included", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await upsertFanPages(app.db, [{
      fanId: await fanId("fansly", FS_FAN),
      platformAccountId: pageIds["money-fs"]!,
      isFollower: true,
      followerSince: new Date("2026-09-01T00:00:00Z"),
    }]);
    expect((await fanslyBlocks(FS_FAN)).subscription).toBe("");
    expect((await fanslyBlocks(FS_OTHER_FAN)).subscription).toBe("");
    // A subscription of the same account id on the OnlyFans page is not his.
    const sameId = await fanId("onlyfans", FS_FAN);
    await testDb.pool.query(
      `insert into page_subscriptions (platform_subscription_id, platform_account_id, fan_id, raw_status,
         canonical_status, price_mills, renew_price_mills, is_current)
       values ('of-sub-1', $1, $2, 1, 'active', 9990, 9990, true)`,
      [pageIds["money-of"], sameId],
    );
    expect((await fanslyBlocks(FS_FAN)).subscription).toBe("");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[AI-145] the route gives a Fansly request the two blocks", () => {
  const quick: Array<{ feature: string; body?: Record<string, unknown> }> = [
    { feature: "fast-reply" },
    { feature: "improve-draft", body: { draftText: "hey you" } },
    { feature: "help-me" },
    { feature: "coach-chat", body: { chatterQuestion: "what next?" } },
  ];
  const deep: Array<{ feature: string; body?: Record<string, unknown> }> = [
    { feature: "fan-summary" },
    { feature: "fan-summary", body: { summaryMode: "short" } },
    { feature: "chat-review" },
    { feature: "fan-notes-fill", body: { noteFields: ["Имя", "Возраст"] } },
  ];

  it("spend by the feature's depth, the subscription, and not one request to Fansly", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedFanslyChat();
    await seedFanslyLedger(REFERENCE_LEDGER);
    await subscribersWalk("active", [subscriberItem(REFERENCE_SUBSCRIPTIONS.active.subscription)]);
    trap = await armNoOutboundTrap(testDb);

    for (const [requests, spending] of [
      [quick, withLedgerTypeNames(REFERENCE_SPENDING_QUICK)],
      [deep, withLedgerTypeNames(REFERENCE_SPENDING_DEEP)],
    ] as const) {
      for (const request of requests) {
        const name = `${request.feature} ${JSON.stringify(request.body ?? {})}`;
        // The subscription block counts days from the request's own clock.
        const subscription = (await loadFanslySubscriptionContext(app, { pageId: pageIds["money-fs"]!, fanRef: FS_FAN })).block;
        const response = await ask({
          feature: request.feature,
          page: "money-fs",
          platform: "fansly",
          body: { conversationRef: FS_GROUP, fanRef: FS_FAN, ...request.body },
        });
        expect(response.statusCode, `${name}: ${response.body}`).toBe(200);
        expect(section(userText(), "fan_spending_data"), name).toBe(spending);
        expect(section(userText(), "fan_subscription_data"), name).toBe(subscription);
        expect(subscription, name).toContain(
          `FAN SUBSCRIPTION DATA:\nSource: /api/v1/subscribers\nSubscriber account ID: ${FS_FAN}\nTier: Gold Tier ($13.99/month)\nStatus: Active\nSubscribed since: Aug 27, 2026 (`,
        );
      }
    }
    await trap.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an ex-subscriber and a fan who never subscribed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedFanslyChat();
    await seedFanslyChat(30, FS_OTHER_FAN, "650000000000000002", 810000);
    await subscribersWalk("expired", [subscriberItem(REFERENCE_SUBSCRIPTIONS.expired.subscription)]);

    const left = await ask({ page: "money-fs", platform: "fansly", body: { conversationRef: FS_GROUP, fanRef: FS_FAN } });
    expect(left.statusCode, left.body).toBe(200);
    const block = section(userText(), "fan_subscription_data");
    expect(block).toMatch(/^FAN SUBSCRIPTION DATA:\nSource: \/api\/v1\/subscribers\nSubscriber account ID: 700000000000000001\nTier: Gold Tier \(\$13\.99\/month\)\nStatus: Expired \(ended Sep 1, 2026 — \d+ days ago\)\nWas subscribed for: 92 days\nSubscribed since: Jun 1, 2026 \(\d+ days ago\)\nBilling cycle: 30 days$/);
    // No wallet row: the zero totals, as the extension's block.
    expect(section(userText(), "fan_spending_data")).toBe(REFERENCE_SPENDING_NONE);

    // A fan the hub knows who never subscribed and never paid.
    await fanId("fansly", FS_OTHER_FAN);
    const never = await ask({ page: "money-fs", platform: "fansly", body: { conversationRef: "650000000000000002", fanRef: FS_OTHER_FAN } });
    expect(never.statusCode, never.body).toBe(200);
    expect(userText()).not.toContain("fan_subscription_data");
    expect(userText()).not.toContain("FAN SUBSCRIPTION DATA");
    expect(section(userText(), "fan_spending_data")).toBe(REFERENCE_SPENDING_NONE.replace(FS_FAN, FS_OTHER_FAN));

    // A request that names no fan: the group's id is not a fan's, so the hub
    // claims nothing about spend or subscription.
    const unnamed = await ask({ page: "money-fs", platform: "fansly", body: { conversationRef: FS_GROUP } });
    expect(unnamed.statusCode, unnamed.body).toBe(200);
    expect(userText()).not.toContain("fan_spending_data");
    expect(userText()).not.toContain("fan_subscription_data");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-145] a tip is labelled `[Tip: $X]` in the transcript, through the real canonicalizer", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = pageIds["money-fs"]!;
    await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, FS_PAGE_REF]);
    await upsertPageDmConversation(app.db, {
      platformAccountId: pageId, fanId: await fanId("fansly", FS_FAN), platformConversationId: FS_GROUP,
      partnerPlatformUserId: FS_FAN, partnerUsername: null, partnerDisplayName: null,
      conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
      lastMessageId: null, lastUnreadMessageId: null, lastMessageAt: new Date(),
      lastMessageSenderId: FS_FAN, lastMessageSenderRole: "fan", lastMessagePreview: null,
      messageCoverageStatus: "complete", newestStoredMessageId: null, oldestStoredMessageId: null,
      storedMessageCount: 0, lastMessageSyncAt: new Date(), isVisible: true, lastSeenGeneration: 1, metadata: {},
    });
    // A DM page as Fansly serves it: `totalTipAmount` in mills on the message.
    const base = Date.now() - 60 * 60_000;
    const message = (id: string, seconds: number, fields: Record<string, unknown>) => ({
      id, groupId: FS_GROUP, senderId: FS_FAN, content: `<p>line ${id}</p>`, createdAt: (base + seconds * 1000) / 1000,
      attachments: [], inReplyTo: null, inReplyToRoot: null, type: 1, correlationId: "0", totalTipAmount: 0,
      ...fields,
    });
    const payload = {
      messages: [
        message("900000000000000001", 0, { content: "<p>hey</p>" }),
        message("900000000000000002", 10, { content: "<p>for you</p>", totalTipAmount: 5000 }),
        message("900000000000000003", 20, { content: "<p>thank you baby</p>", senderId: FS_PAGE_REF }),
        message("900000000000000004", 30, { content: "", totalTipAmount: 12345 }),
      ],
    };
    await insertObservation(app.db, {
      source: "pull", producer: "sync:fansly:dm_messages", platform: "fansly",
      accountId: pageId, kind: "dm_messages", payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: "money-tips-1", receivedAt: new Date(),
    });
    await runCanonicalization(app, { kinds: ["dm_messages"], accountId: pageId });
    await runMessageArchiveProjection(app, { accountId: pageId });

    const response = await ask({ page: "money-fs", platform: "fansly", body: { conversationRef: FS_GROUP, fanRef: FS_FAN } });
    expect(response.statusCode, response.body).toBe(200);
    const lines = userText().split("\n").filter((line) => /^\[\d{2}:\d{2}\] (Fan|Model): /.test(line))
      .map((line) => line.replace(/^\[\d{2}:\d{2}\] /, ""));
    // The extension's own labels: `[Tip: $` + mills / 1000 to two places + `]`,
    // before the text; no label on a message without a tip.
    expect(lines).toEqual([
      "Fan: hey",
      "Fan: [Tip: $5.00] for you",
      "Model: thank you baby",
      "Fan: [Tip: $12.35]",
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the released Fansly extension (fansly-chat 2.10.1, clientContext) is answered as before", () => {
  // Its blocks are its own: whatever the hub's ledger and capture hold for the
  // fan, the prompt carries the two texts the client sent, byte for byte, and
  // the stream is the same.
  const clientContext = {
    transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
    messageCount: 35,
    fanDisplayName: "charles",
    fanSpendingData: REFERENCE_SPENDING_DEEP,
    fanSubscriptionData: REFERENCE_SUBSCRIPTIONS.activeNoRenew.block,
  };
  const forms: Array<{ name: string; feature: string; body: Record<string, unknown> }> = [
    {
      name: "group/fan coach-chat",
      feature: "coach-chat",
      body: { conversationRef: FS_GROUP, fanRef: FS_FAN, chatterQuestion: "what next?", isRegeneration: false, clientContext },
    },
    {
      name: "group/fan fan-summary (full)",
      feature: "fan-summary",
      body: { conversationRef: FS_GROUP, fanRef: FS_FAN, messageCount: 1500, isRegeneration: false, clientContext: { ...clientContext, transcriptCoverage: "window" } },
    },
    {
      name: "group/fan fan-notes-fill",
      feature: "fan-notes-fill",
      body: { conversationRef: FS_GROUP, fanRef: FS_FAN, noteFields: ["Имя", "Возраст"], isRegeneration: false, clientContext },
    },
    {
      name: "fan fast-reply",
      feature: "fast-reply",
      body: { conversationRef: FS_FAN, replyTone: "flirty", replyMode: "default", isRegeneration: false, clientContext },
    },
    {
      name: "fan/fan fast-reply",
      feature: "fast-reply",
      body: { conversationRef: FS_FAN, fanRef: FS_FAN, isRegeneration: false, clientContext },
    },
  ];

  /** The stream with what differs per request by design (ids, the quota left) masked. */
  const comparable = (raw: string) => raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/"(remainingRequestsToday|remainingMicroUsdToday)":\d+/g, '"$1":<n>');

  it("every form prompts and streams the same with no money in the hub and with the fan's ledger and subscription", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const states = [
      { name: "nothing held", seed: async () => undefined },
      {
        name: "ledger and subscription held",
        seed: async () => {
          await seedFanslyLedger([{ type: 7101, gross: 777000, net: 621600, at: "2026-10-02T10:00:00.000Z" }]);
          await subscribersWalk("active", [subscriberItem(REFERENCE_SUBSCRIPTIONS.active.subscription)]);
        },
      },
    ];
    const answers = new Map<string, Array<{ raw: string; prompt: string }>>();
    for (const state of states) {
      // Each state starts without a recap of the earlier one for Coach to attach.
      await testDb.pool.query("delete from ai_generation_content");
      await state.seed();
      for (const form of forms) {
        delete provider.input;
        // The released client advertises no capability.
        const response = await server!.inject({
          method: "POST",
          url: `/api/v1/ai/features/${form.feature}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { clientRequestId: randomUUID(), pageLabel: "money-fs", platform: "fansly", ...form.body },
        });
        expect(response.statusCode, `${form.name}, ${state.name}: ${response.body}`).toBe(200);
        expect(section(userText(), "fan_spending_data"), form.name).toBe(REFERENCE_SPENDING_DEEP);
        expect(section(userText(), "fan_subscription_data"), form.name).toBe(REFERENCE_SUBSCRIPTIONS.activeNoRenew.block);
        const list = answers.get(form.name) ?? [];
        list.push({ raw: comparable(response.body), prompt: JSON.stringify(provider.input!.body.prompt) });
        answers.set(form.name, list);
      }
    }
    for (const [name, list] of answers) {
      expect(list, name).toHaveLength(states.length);
      expect(list[1], name).toEqual(list[0]);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
