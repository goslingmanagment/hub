import { fixtureUserId } from "./helpers/user-identity.ts";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  deleteProxyConfig,
  getNotificationDeliveryOutboxByIncident,
  getNotificationIncidentByKey,
  insertAiUsageEvents,
  createModel,
  createOnlyFansPage,
  reserveAiGatewayUsageEvent,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AI_GATEWAY_STALE_RESERVATION_MS,
  type AiGatewayProvider,
  type AiGatewayProviderInput,
} from "../apps/runtime/src/services/ai-gateway.ts";
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
import {
  errorFromProviderHttpFixture,
  providerHttpFailureFixtures,
  providerStreamInterruptionFixture,
} from "./fixtures/provider-failures.ts";

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
  await storeProxyConfig(appContext.db, onlyFansPage.id, {
    url: "socks5://proxy.example:1080",
    encryptedAuth: null,
    keyVersion: null,
    rateLimitScopeKey: "shared-ai-proxy",
  });
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
    userId: await fixtureUserId(appContext, "chatter"),
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

function parseAiSseFrames(body: string) {
  return body
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? null;
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return {
        event,
        data: JSON.parse(data) as Record<string, unknown>,
      };
    });
}

function successfulProvider(
  provider: AiGatewayProvider["provider"] = "anthropic",
): AiGatewayProvider {
  return {
    provider,
    async *stream() {
      yield { type: "content_delta", text: "recovered" };
      yield {
        type: "usage",
        providerResponseId: "msg_recovered",
        cacheHit: false,
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costMicroUsd: 35,
          costApproximate: false,
        },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
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
      message: "ChatMuse AI gateway provider execution is not configured",
    });

    const usageRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(usageRows.rows[0]?.count).toBe(0);
  });

  it("fails closed before quota reservation when the assigned page has no proxy", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield* [];
        throw new Error("provider should not be called");
      },
    };
    await deleteProxyConfig(appContext.db, onlyFansPageId);

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      error: "service_unavailable",
      message: "ChatMuse AI gateway requires a configured page proxy",
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
      error: "quota_denied",
    });

    // Stage 29: the denial itself is a ledger fact (quota_denied row).
    const usageRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(usageRows.rows[0]?.count).toBe(2);
  });

  it("rejects requests whose estimated provider cost exceeds the per-request ceiling", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.config.chatMuseAiGatewayRequestMicroUsdLimit = 1_000;
    let providerCalls = 0;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        providerCalls += 1;
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const response = await streamGateway(gatewayBody({
      model: "anthropic:claude-opus-4-8",
      maxTokens: 100_000,
    }));

    expect(response.statusCode, response.body).toBe(429);
    expect(response.json()).toMatchObject({
      error: "quota_denied",
      message: "ChatMuse AI gateway request cost ceiling exceeded",
    });
    expect(providerCalls).toBe(0);
    // Stage 29: the denial itself is a ledger fact (quota_denied row).
    const usageRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(usageRows.rows[0]?.count).toBe(1);
  });

  it("streams SSE frames from an injected provider after auth and quota pass", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    const providerCapture: { current?: AiGatewayProviderInput } = {};
    let providerCalls = 0;
    const provider: AiGatewayProvider = {
      provider: "anthropic",
      async *stream(input) {
        providerCalls += 1;
        providerCapture.current = input;
        yield { type: "content_delta", text: "hello " };
        yield {
          type: "usage",
          providerResponseId: "msg_test_123",
          cacheHit: true,
          usage: {
            inputTokens: 100,
            outputTokens: 8,
            cacheWriteTokens: 15,
            cacheReadTokens: 20,
            costMicroUsd: 494,
            costApproximate: false,
          },
        };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    appContext.aiGatewayProvider = provider;

    const requestBody = gatewayBody();
    const response = await streamGateway(requestBody);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const frames = parseAiSseFrames(response.body);
    expect(frames.map((frame) => frame.event)).toEqual(["ai", "ai", "ai", "ai"]);
    expect(frames[0]?.data).toMatchObject({
      type: "meta",
      clientRequestId: requestBody.clientRequestId,
      feature: "fast-reply",
      pageLabel: "lora-of",
      model: "anthropic:claude-sonnet-4-6",
      provider: "anthropic",
      providerResponseId: null,
      quota: {
        accepted: true,
        remainingRequestsToday: 200,
        remainingMicroUsdToday: 5_000_000,
      },
    });
    expect(frames[1]?.data).toEqual({ type: "content_delta", text: "hello " });
    expect(frames[2]?.data).toMatchObject({
      type: "usage",
      providerResponseId: "msg_test_123",
      cacheHit: true,
    });
    expect(frames[3]?.data).toEqual({ type: "done", stopReason: "end_turn" });
    const capturedProviderInput = providerCapture.current;
    if (!capturedProviderInput) {
      throw new Error("Expected AI gateway provider to be called");
    }
    expect(capturedProviderInput).toMatchObject({
      requestId: frames[0]?.data.requestId,
      body: requestBody,
      page: {
        id: onlyFansPageId,
        label: "lora-of",
        platform: "onlyfans",
        proxy: {
          url: "socks5://proxy.example:1080",
          username: null,
          password: null,
        },
        egressKey: "shared-ai-proxy",
      },
      quota: {
        accepted: true,
        remainingRequestsToday: 200,
        remainingMicroUsdToday: 5_000_000,
      },
    });
    expect(capturedProviderInput.signal.aborted).toBe(false);

    const usageRows = await testDb!.pool.query<{
      clientEventId: string;
      feature: string;
      model: string;
      provider: string | null;
      providerResponseId: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
      costMicroUsd: number;
      costApproximate: boolean;
      quotaAccepted: boolean | null;
      gatewayOutcome: string | null;
      conversationId: string | null;
      isCacheHit: boolean;
      isRegeneration: boolean;
      durationRecorded: boolean;
    }>(
      `select client_event_id as "clientEventId",
              feature,
              model,
              provider,
              provider_response_id as "providerResponseId",
              input_tokens::int as "inputTokens",
              output_tokens::int as "outputTokens",
              cache_write_tokens::int as "cacheWriteTokens",
              cache_read_tokens::int as "cacheReadTokens",
              cost_micro_usd::int as "costMicroUsd",
              cost_approximate as "costApproximate",
              quota_accepted as "quotaAccepted",
              gateway_outcome as "gatewayOutcome",
              conversation_id as "conversationId",
              is_cache_hit as "isCacheHit",
              is_regeneration as "isRegeneration",
              duration_ms is not null as "durationRecorded"
       from ai_usage_events`,
    );
    expect(usageRows.rows).toEqual([{
      clientEventId: requestBody.clientRequestId,
      feature: "fast-reply",
      model: "anthropic:claude-sonnet-4-6",
      provider: "anthropic",
      providerResponseId: "msg_test_123",
      inputTokens: 100,
      outputTokens: 8,
      cacheWriteTokens: 15,
      cacheReadTokens: 20,
      costMicroUsd: 494,
      costApproximate: false,
      quotaAccepted: true,
      gatewayOutcome: "completed",
      conversationId: "123456789",
      isCacheHit: true,
      isRegeneration: false,
      durationRecorded: true,
    }]);

    const duplicate = await streamGateway(requestBody);
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: "conflict",
      message: "ChatMuse AI gateway request id is already reserved",
    });
    expect(providerCalls).toBe(1);
    const countRows = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ai_usage_events",
    );
    expect(countRows.rows[0]?.count).toBe(1);
  });

  it("converts provider failures to bounded SSE errors without echoing provider text", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield* [];
        throw new Error("raw provider body with prompt: conversation context");
      },
    };

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const frames = parseAiSseFrames(response.body);
    expect(frames[0]?.data).toMatchObject({ type: "meta" });
    expect(frames[1]?.data).toEqual({
      type: "error",
      code: "provider_stream_failed",
      message: "AI gateway provider stream failed",
      retryAfterMs: null,
    });
    expect(response.body).not.toContain("conversation context");

    const usageRows = await testDb!.pool.query<{
      provider: string | null;
      providerResponseId: string | null;
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
      quotaAccepted: boolean | null;
      gatewayOutcome: string | null;
      isCacheHit: boolean;
      errorCode: string | null;
      failurePhase: string | null;
      providerHttpStatus: number | null;
    }>(
      `select provider,
              provider_response_id as "providerResponseId",
              input_tokens::int as "inputTokens",
              output_tokens::int as "outputTokens",
              cost_micro_usd::int as "costMicroUsd",
              quota_accepted as "quotaAccepted",
              gateway_outcome as "gatewayOutcome",
              is_cache_hit as "isCacheHit",
              error_code as "errorCode",
              failure_phase as "failurePhase",
              provider_http_status as "providerHttpStatus"
       from ai_usage_events`,
    );
    expect(usageRows.rows).toEqual([{
      provider: "anthropic",
      providerResponseId: null,
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      quotaAccepted: true,
      gatewayOutcome: "failed",
      isCacheHit: false,
      errorCode: "provider_stream_failed",
      failurePhase: "stream",
      providerHttpStatus: null,
    }]);
  });

  it("turns the Anthropic billing fixture into a precise frame and suppressed global incident", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    const billing = providerHttpFailureFixtures.find(
      (fixture) => fixture.id === "anthropic-billing-400",
    )!;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield* [];
        throw errorFromProviderHttpFixture(billing);
      },
    };

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const frames = parseAiSseFrames(response.body);
    expect(frames[1]?.data).toEqual({
      type: "error",
      code: "provider_billing",
      message: "AI provider billing requires attention",
      retryAfterMs: null,
    });
    expect(response.body).not.toContain(billing.body.error.message);

    const ledger = await testDb!.pool.query<{
      errorCode: string | null;
      failurePhase: string | null;
      providerHttpStatus: number | null;
    }>(`
      select error_code as "errorCode",
             failure_phase as "failurePhase",
             provider_http_status as "providerHttpStatus"
      from ai_usage_events
    `);
    expect(ledger.rows).toEqual([{
      errorCode: "provider_billing",
      failurePhase: "provider_response",
      providerHttpStatus: 400,
    }]);

    const incident = await getNotificationIncidentByKey(
      appContext.db,
      "ai_provider_billing:global",
    );
    expect(incident).toMatchObject({
      kind: "ai_provider_billing",
      platformAccountId: null,
      status: "open",
      errorCode: "provider_billing",
    });
    expect(incident?.errorSummary).not.toContain(billing.body.error.message);
    const openOutbox = await getNotificationDeliveryOutboxByIncident(
      appContext.db,
      incident!.id,
    );
    expect(openOutbox).toEqual([
      expect.objectContaining({
        transition: "opened",
        state: "suppressed",
        suppressionReason: "ai_critical_alerts_disabled",
        attemptCount: 0,
      }),
    ]);

    // The billing/auth incident is one GLOBAL latch: a success through a
    // different provider still resolves it.
    appContext.aiGatewayProvider = successfulProvider("openrouter");
    const recovered = await streamGateway(gatewayBody());
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(await getNotificationIncidentByKey(
      appContext.db,
      "ai_provider_billing:global",
    )).toMatchObject({
      status: "resolved",
    });
  });

  it("opens one page incident after three classified failures, dedupes, and resolves on success", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield* [];
        throw new Error("private provider failure body");
      },
    };
    const incidentKey = `ai_provider_failed:${onlyFansPageId}:provider`;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await streamGateway(gatewayBody());
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(await getNotificationIncidentByKey(appContext.db, incidentKey)).toBeNull();

    const thresholdResponse = await streamGateway(gatewayBody());
    expect(thresholdResponse.statusCode, thresholdResponse.body).toBe(200);
    const opened = await getNotificationIncidentByKey(appContext.db, incidentKey);
    expect(opened).toMatchObject({
      kind: "ai_provider_failed",
      platformAccountId: onlyFansPageId,
      status: "open",
      errorCode: "provider_stream_failed",
    });
    expect(opened?.errorSummary).not.toContain("private provider failure body");
    expect(await getNotificationDeliveryOutboxByIncident(appContext.db, opened!.id)).toHaveLength(1);

    const repeat = await streamGateway(gatewayBody());
    expect(repeat.statusCode, repeat.body).toBe(200);
    const incidentCount = await testDb!.pool.query<{ count: number }>(`
      select count(*)::int as count
      from notification_incidents
      where kind = 'ai_provider_failed'
        and platform_account_id = $1
    `, [onlyFansPageId]);
    expect(incidentCount.rows[0]?.count).toBe(1);
    expect(await getNotificationDeliveryOutboxByIncident(appContext.db, opened!.id)).toHaveLength(1);

    appContext.aiGatewayProvider = successfulProvider();
    const recovered = await streamGateway(gatewayBody());
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(await getNotificationIncidentByKey(appContext.db, incidentKey)).toMatchObject({
      status: "resolved",
    });
    expect(await getNotificationDeliveryOutboxByIncident(appContext.db, opened!.id)).toEqual([
      expect.objectContaining({ transition: "opened", state: "suppressed" }),
      expect.objectContaining({ transition: "resolved", state: "suppressed" }),
    ]);
  });

  it("fails closed after a first chunk: static error and no done frame", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield providerStreamInterruptionFixture.firstFrame;
        throw providerStreamInterruptionFixture.createError();
      },
    };

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const frames = parseAiSseFrames(response.body);
    expect(frames.map((frame) => frame.data.type)).toEqual([
      "meta",
      "content_delta",
      "error",
    ]);
    expect(frames[1]?.data).toEqual(providerStreamInterruptionFixture.firstFrame);
    expect(frames[2]?.data).toEqual({
      type: "error",
      code: "provider_stream_failed",
      message: "AI gateway provider stream failed",
      retryAfterMs: null,
    });
    expect(frames.some((frame) => frame.data.type === "done")).toBe(false);
    expect(response.body).not.toContain("socket closed after first chunk");

    const usageRows = await testDb!.pool.query<{
      gatewayOutcome: string | null;
      errorCode: string | null;
      failurePhase: string | null;
      providerHttpStatus: number | null;
    }>(
      `select gateway_outcome as "gatewayOutcome",
              error_code as "errorCode",
              failure_phase as "failurePhase",
              provider_http_status as "providerHttpStatus"
       from ai_usage_events`,
    );
    expect(usageRows.rows).toEqual([{
      gatewayOutcome: "failed",
      errorCode: "provider_stream_failed",
      failurePhase: "stream",
      providerHttpStatus: null,
    }]);
  });

  it("names a connect-level provider failure provider_proxy_unreachable (dead page proxy)", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield* [];
        // The Anthropic SDK wraps transport failures; the SOCKS handshake
        // failure rides the cause chain (lora-2 incident shape, 2026-07-15).
        const socks = new Error("Proxy connection timed out");
        socks.name = "SocksClientError";
        const wrapped = new Error("Connection error.");
        wrapped.cause = socks;
        throw wrapped;
      },
    };

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const frames = parseAiSseFrames(response.body);
    expect(frames[0]?.data).toMatchObject({ type: "meta" });
    expect(frames[1]?.data).toEqual({
      type: "error",
      code: "provider_proxy_unreachable",
      message: "AI gateway could not reach the page's egress proxy",
      retryAfterMs: null,
    });

    const outcomeRows = await testDb!.pool.query<{ gatewayOutcome: string | null }>(
      "select gateway_outcome as \"gatewayOutcome\" from ai_usage_events",
    );
    expect(outcomeRows.rows).toEqual([{ gatewayOutcome: "failed" }]);
  });

  it("records streamed content without provider usage as failed instead of zero-cost completed", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield { type: "content_delta", text: "billable content" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const frames = parseAiSseFrames(response.body);
    expect(frames.map((frame) => frame.data.type)).toEqual([
      "meta",
      "content_delta",
      "error",
    ]);
    expect(frames[2]?.data).toEqual({
      type: "error",
      code: "provider_usage_missing",
      message: "AI gateway provider ended without usage metadata",
      retryAfterMs: null,
    });

    const usageRows = await testDb!.pool.query<{
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
      gatewayOutcome: string | null;
    }>(
      `select input_tokens::int as "inputTokens",
              output_tokens::int as "outputTokens",
              cost_micro_usd::int as "costMicroUsd",
              gateway_outcome as "gatewayOutcome"
       from ai_usage_events`,
    );
    expect(usageRows.rows).toEqual([{
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      gatewayOutcome: "failed",
    }]);
  });

  it("rejects an empty stream without usage as unusable output", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield { type: "done", stopReason: "end_turn" };
      },
    };

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const frames = parseAiSseFrames(response.body);
    expect(frames.map((frame) => frame.data.type)).toEqual(["meta", "error"]);
    expect(frames[1]?.data).toEqual({
      type: "error",
      code: "provider_output_empty",
      message: "AI gateway provider completed without usable output",
      retryAfterMs: null,
    });

    const outcomeRows = await testDb!.pool.query<{
      gatewayOutcome: string | null;
      generationOutcome: string | null;
      completion: string;
    }>(
      `select u.gateway_outcome as "gatewayOutcome",
              g.params ->> 'outcome' as "generationOutcome",
              g.completion
       from ai_usage_events u
       join ai_generation_content g on g.usage_event_id = u.id`,
    );
    expect(outcomeRows.rows).toEqual([{
      gatewayOutcome: "failed",
      generationOutcome: "failed",
      completion: "",
    }]);
  });

  it("recovers stale gateway reservations before a new provider attempt", async () => {
    appContext.config.chatMuseAiGatewayEnabled = true;
    appContext.aiGatewayProvider = {
      provider: "anthropic",
      async *stream() {
        yield { type: "content_delta", text: "ok" };
        yield {
          type: "usage",
          providerResponseId: "msg_stale_recovery",
          cacheHit: false,
          usage: {
            inputTokens: 10,
            outputTokens: 1,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costMicroUsd: 33,
            costApproximate: false,
          },
        };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const staleClientRequestId = randomUUID();
    const staleReservedAt = new Date(Date.now() - AI_GATEWAY_STALE_RESERVATION_MS - 60_000);
    const reserved = await reserveAiGatewayUsageEvent(appContext.db, {
      userId: chatterUserId,
      event: {
        clientEventId: staleClientRequestId,
        feature: "fast-reply",
        model: "anthropic:claude-sonnet-4-6",
        pageId: onlyFansPageId,
        provider: "anthropic",
        conversationId: "123456789",
        isRegeneration: false,
        reservedAt: staleReservedAt,
      },
    });
    expect(reserved).toBe(true);

    const response = await streamGateway(gatewayBody());

    expect(response.statusCode, response.body).toBe(200);
    const usageRows = await testDb!.pool.query<{
      clientEventId: string;
      gatewayOutcome: string | null;
      durationRecorded: boolean;
    }>(
      `select client_event_id as "clientEventId",
              gateway_outcome as "gatewayOutcome",
              duration_ms is not null as "durationRecorded"
       from ai_usage_events`,
    );
    const rowsByClientRequestId = new Map(
      usageRows.rows.map((row) => [row.clientEventId, row]),
    );
    expect(rowsByClientRequestId.get(staleClientRequestId)).toMatchObject({
      gatewayOutcome: "failed",
      durationRecorded: true,
    });
    expect([...rowsByClientRequestId.values()].filter((row) => row.gatewayOutcome === "completed"))
      .toHaveLength(1);
  });
});
