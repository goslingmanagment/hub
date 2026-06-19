import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  insertAiUsageEvents,
  createModel,
  createOnlyFansPage,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let chatterUserId = 0;
let onlyFansPageId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await apiServer?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await apiServer?.close();
  await resetIntegrationDatabase(testDb.pool);

  appContext = createTestAppContext(testDb);
  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const onlyFansPage = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: "lora-of",
  });
  onlyFansPageId = onlyFansPage.id;
  await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: "lora-vip-of",
  });
  await createFanslyPage(appContext.db, {
    modelId: model.id,
    label: "lora-fansly",
  });

  const chatter = await createUserAccount(appContext, {
    username: "chatter",
    role: "chatter",
  }, { source: "cli" });
  if (!chatter) {
    throw new Error("Expected chatter user to be created");
  }
  chatterUserId = chatter.id;
  chatterKey = (await issueChatterApiKey(appContext, {
    username: "chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  apiServer = await buildApiServer(appContext);
  await apiServer.ready();
});

function gatewayBody(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    feature: "fast-reply",
    pageLabel: "lora-of",
    platform: "onlyfans",
    platformUserId: "123456789",
    conversationId: "123456789",
    model: "anthropic:claude-sonnet-4-6",
    reasoningEffort: "low",
    isRegeneration: false,
    prompt: {
      systemBlocks: [{ text: "system instructions", cache: "1h" }],
      userBlocks: [{ text: "conversation context", cache: "5m" }],
    },
    ...overrides,
  };
}

function streamGateway(body: Record<string, unknown>, key = chatterKey) {
  return apiServer!.inject({
    method: "POST",
    url: "/api/v1/ai/gateway/stream",
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
}

describe("ChatMuse AI gateway runtime gate", () => {
  it("requires a chatter API key and fails closed while the staged flag is disabled", async () => {
    const anonymous = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      payload: gatewayBody(),
    });
    expect(anonymous.statusCode, anonymous.body).toBe(401);

    const response = await streamGateway(gatewayBody({
      pageLabel: "definitely-not-a-page",
    }));
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      error: "service_unavailable",
    });

    const usageRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(usageRows.rows[0]?.count).toBe(0);
  });

  it("checks page authorization only after the gateway flag is enabled", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;

    const unassigned = await streamGateway(gatewayBody({
      pageLabel: "lora-vip-of",
    }));
    expect(unassigned.statusCode, unassigned.body).toBe(404);

    const platformMismatch = await streamGateway(gatewayBody({
      pageLabel: "lora-fansly",
      platform: "onlyfans",
    }));
    expect(platformMismatch.statusCode, platformMismatch.body).toBe(404);

    const assigned = await streamGateway(gatewayBody());
    expect(assigned.statusCode, assigned.body).toBe(503);
    expect(assigned.json()).toMatchObject({
      error: "service_unavailable",
    });

    const usageRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(usageRows.rows[0]?.count).toBe(0);
  });

  it("rejects over-quota requests before provider execution without writing a new ledger row", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.config.chatMuseAiGatewayDailyRequestLimit = 1;
    appContext.config.chatMuseAiGatewayDailyMicroUsdLimit = 5_000_000;

    await insertAiUsageEvents(appContext.db, {
      userId: chatterUserId,
      events: [{
        clientEventId: randomUUID(),
        feature: "fast-reply",
        model: "anthropic:claude-sonnet-4-6",
        pageId: onlyFansPageId,
        provider: "anthropic",
        providerResponseId: "msg_prior",
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: 1,
        costApproximate: false,
        quotaAccepted: true,
        gatewayOutcome: "completed",
        conversationId: "123456789",
        durationMs: 10,
        isCacheHit: false,
        isRegeneration: false,
        completedAt: new Date(),
      }],
    });

    const response = await streamGateway(gatewayBody());
    expect(response.statusCode, response.body).toBe(429);
    expect(response.json()).toMatchObject({
      error: "rate_limit_exceeded",
    });

    const usageRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(usageRows.rows[0]?.count).toBe(1);
  });
});
