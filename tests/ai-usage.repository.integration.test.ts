import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  createUser,
  finalizeAiGatewayUsageEvent,
  insertAiUsageEvents,
  markStaleAiGatewayReservationsFailed,
  reserveAiGatewayUsageEvent,
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
      error_code: string | null;
      failure_phase: string | null;
      provider_http_status: number | null;
    }>(`
      select page_id,
             provider,
             provider_response_id,
             cost_micro_usd,
             cost_approximate,
             quota_accepted,
             gateway_outcome,
             error_code,
             failure_phase,
             provider_http_status
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
      error_code: null,
      failure_phase: null,
      provider_http_status: null,
    }]);
  });

  it("passes nullable failure detail through the gateway terminal write", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const clientEventId = randomUUID();
    const reservedAt = new Date("2026-07-24T10:00:00.000Z");
    const reserved = await reserveAiGatewayUsageEvent(testDb.db, {
      userId: null,
      event: {
        clientEventId,
        feature: "workboard-closing",
        model: "anthropic:claude-sonnet-4-6",
        pageId: null,
        provider: "anthropic",
        conversationId: null,
        isRegeneration: false,
        reservedAt,
      },
    });
    expect(reserved).toBe(true);

    const usageEventId = await finalizeAiGatewayUsageEvent(testDb.db, {
      userId: null,
      event: {
        clientEventId,
        providerResponseId: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: 0,
        costApproximate: false,
        gatewayOutcome: "failed",
        errorCode: "provider_rate_limited",
        failurePhase: "provider_response",
        providerHttpStatus: 429,
        durationMs: 125,
        isCacheHit: false,
        completedAt: new Date("2026-07-24T10:00:00.125Z"),
      },
    });
    expect(usageEventId).not.toBeNull();

    const rows = await testDb.pool.query<{
      error_code: string | null;
      failure_phase: string | null;
      provider_http_status: number | null;
    }>(`
      select error_code, failure_phase, provider_http_status
      from ai_usage_events
      where client_event_id = $1
    `, [clientEventId]);
    expect(rows.rows).toEqual([{
      error_code: "provider_rate_limited",
      failure_phase: "provider_response",
      provider_http_status: 429,
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

  it("marks stale gateway reservations failed without touching fresh reservations", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const user = await createUser(testDb.db, {
      username: "reservation-chatter",
      role: "chatter",
      passwordHash: null,
    });
    const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model.id,
      label: "lora-of",
    });
    const staleClientRequestId = randomUUID();
    const freshClientRequestId = randomUUID();

    const staleReserved = await reserveAiGatewayUsageEvent(testDb.db, {
      userId: user.id,
      event: {
        clientEventId: staleClientRequestId,
        feature: "fast-reply",
        model: "anthropic:claude-sonnet-4-6",
        pageId: page.id,
        provider: "anthropic",
        conversationId: "123456789",
        isRegeneration: false,
        reservedAt: new Date("2026-06-19T10:00:00.000Z"),
      },
    });
    const freshReserved = await reserveAiGatewayUsageEvent(testDb.db, {
      userId: user.id,
      event: {
        clientEventId: freshClientRequestId,
        feature: "fast-reply",
        model: "anthropic:claude-sonnet-4-6",
        pageId: page.id,
        provider: "anthropic",
        conversationId: "123456789",
        isRegeneration: false,
        reservedAt: new Date("2026-06-19T10:45:00.000Z"),
      },
    });

    expect(staleReserved).toBe(true);
    expect(freshReserved).toBe(true);

    const recovered = await markStaleAiGatewayReservationsFailed(testDb.db, {
      reservedBefore: new Date("2026-06-19T10:30:00.000Z"),
      recoveredAt: new Date("2026-06-19T11:00:00.000Z"),
    });

    expect(recovered).toBe(1);

    const rows = await testDb.pool.query<{
      client_event_id: string;
      gateway_outcome: string | null;
      input_tokens: number;
      output_tokens: number;
      cost_micro_usd: number;
      duration_ms: number | null;
      completed_at: Date;
    }>(`
      select client_event_id,
             gateway_outcome,
             input_tokens::int as input_tokens,
             output_tokens::int as output_tokens,
             cost_micro_usd::int as cost_micro_usd,
             duration_ms::int as duration_ms,
             completed_at
      from ai_usage_events
    `);
    const rowsByClientRequestId = new Map(rows.rows.map((row) => [row.client_event_id, row]));

    expect(rowsByClientRequestId).toEqual(new Map([
      [freshClientRequestId, {
        client_event_id: freshClientRequestId,
        gateway_outcome: null,
        input_tokens: 0,
        output_tokens: 0,
        cost_micro_usd: 0,
        duration_ms: null,
        completed_at: new Date("2026-06-19T10:45:00.000Z"),
      }],
      [staleClientRequestId, {
        client_event_id: staleClientRequestId,
        gateway_outcome: "failed",
        input_tokens: 0,
        output_tokens: 0,
        cost_micro_usd: 0,
        duration_ms: 3_600_000,
        completed_at: new Date("2026-06-19T10:00:00.000Z"),
      }],
    ]));
  });
});
