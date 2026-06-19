import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  createUser,
  insertAiUsageEvents,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

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
});

describe("AI usage ledger repository", () => {
  it("keeps direct desktop events on default gateway ledger values", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const user = await createUser(testDb.db, {
      username: "direct-chatter",
      role: "chatter",
      passwordHash: null,
    });

    const inserted = await insertAiUsageEvents(testDb.db, {
      userId: user.id,
      events: [{
        clientEventId: "direct-usage-001",
        feature: "fast-reply",
        model: "gpt-4o",
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        isCacheHit: false,
        isRegeneration: false,
        completedAt: new Date("2026-06-19T10:00:00.000Z"),
      }],
    });

    expect(inserted).toBe(1);

    const rows = await testDb.pool.query<{
      page_id: string | null;
      provider: string | null;
      provider_response_id: string | null;
      cost_micro_usd: number;
      cost_approximate: boolean;
      quota_accepted: boolean | null;
      gateway_outcome: string | null;
    }>(`
      select page_id,
             provider,
             provider_response_id,
             cost_micro_usd,
             cost_approximate,
             quota_accepted,
             gateway_outcome
      from ai_usage_events
      where client_event_id = 'direct-usage-001'
    `);

    expect(rows.rows).toEqual([{
      page_id: null,
      provider: null,
      provider_response_id: null,
      cost_micro_usd: 0,
      cost_approximate: false,
      quota_accepted: null,
      gateway_outcome: null,
    }]);
  });

  it("persists gateway metadata and dedupes by client request id per chatter", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const user = await createUser(testDb.db, {
      username: "gateway-chatter",
      role: "chatter",
      passwordHash: null,
    });
    const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "lora-of",
    });
    const clientRequestId = randomUUID();
    const completedAt = new Date("2026-06-19T11:00:00.000Z");

    const event = {
      clientEventId: clientRequestId,
      feature: "fast-reply" as const,
      model: "anthropic:claude-sonnet-4-6",
      pageId: page.id,
      provider: "anthropic" as const,
      providerResponseId: "msg_012345",
      inputTokens: 100,
      outputTokens: 25,
      cacheWriteTokens: 40,
      cacheReadTokens: 12,
      costMicroUsd: 1234,
      costApproximate: true,
      quotaAccepted: true,
      gatewayOutcome: "completed" as const,
      conversationId: "123456789",
      durationMs: 875,
      isCacheHit: true,
      isRegeneration: true,
      completedAt,
    };

    const firstInsert = await insertAiUsageEvents(testDb.db, {
      userId: user.id,
      events: [event],
    });
    const replayInsert = await insertAiUsageEvents(testDb.db, {
      userId: user.id,
      events: [event],
    });

    expect(firstInsert).toBe(1);
    expect(replayInsert).toBe(0);

    const rows = await testDb.pool.query<{
      client_event_id: string;
      page_id: string;
      provider: string;
      provider_response_id: string;
      cost_micro_usd: number;
      cost_approximate: boolean;
      quota_accepted: boolean;
      gateway_outcome: string;
      conversation_id: string;
      duration_ms: number;
    }>(`
      select client_event_id,
             page_id::text as page_id,
             provider,
             provider_response_id,
             cost_micro_usd,
             cost_approximate,
             quota_accepted,
             gateway_outcome,
             conversation_id,
             duration_ms
      from ai_usage_events
    `);

    expect(rows.rows).toEqual([{
      client_event_id: clientRequestId,
      page_id: String(page.id),
      provider: "anthropic",
      provider_response_id: "msg_012345",
      cost_micro_usd: 1234,
      cost_approximate: true,
      quota_accepted: true,
      gateway_outcome: "completed",
      conversation_id: "123456789",
      duration_ms: 875,
    }]);
  });
});
