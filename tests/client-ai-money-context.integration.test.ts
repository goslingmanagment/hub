import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertFans,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createBundledPersonalities,
  loadSpendingContext,
  loadSubscriptionContext,
} from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension R20 HF-7г (parity row AI-145): spend and subscription in the
// AI context, through the real database and the real route.
//
// OnlyFans first: its two blocks are pinned as text, read by the loaders from
// seeded rows. The pins were written on hub main 4f02f9e3e, BEFORE the Fansly
// blocks existed, and are not to move with them.

/** The clock of every block pinned below. */
const NOW = "2026-10-13T12:00:00.000Z";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
/** A full device token of a chatter of both pages. */
let token = "";
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

afterEach(() => {
  vi.useRealTimers();
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
