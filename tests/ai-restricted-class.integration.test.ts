import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getNotificationIncidentByKey,
  openNotificationIncident,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createGatewayClosingClassifier } from "../apps/runtime/src/modules/workboard/index.ts";
import type { AiGatewayProvider } from "../apps/runtime/src/services/ai-gateway.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { runAiAcceptanceProjection } from "../apps/runtime/src/services/projections/ai-acceptance.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Stage 29 — the DP 6-A restricted capture class. A completion round-trips
// with its content captured owner-readable and team-lead-unreadable (the
// passport's headline test); acceptance events correlate by generation ref;
// budget breaches deny with the typed outcome; the classifier's internal
// lane lands in the same ledger + capture path.

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let pageId = 0;

function fakeProvider(deltas: string[], overrides?: {
  failAfterFirst?: boolean;
  /** Provider ended the stream without ever reporting usage. */
  omitUsage?: boolean;
  /** Clean iterator end with no terminal message_delta — Anthropic yields a
   * synthetic `done` carrying a null stopReason for exactly this. */
  stopReason?: string | null;
}): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      let first = true;
      for (const text of deltas) {
        yield { type: "content_delta", text };
        if (overrides?.failAfterFirst && first) {
          throw new Error("boom");
        }
        first = false;
      }
      if (!overrides?.omitUsage) {
        yield {
          type: "usage",
          providerResponseId: "msg_fake",
          cacheHit: false,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costMicroUsd: 600,
            costApproximate: false,
          },
        };
      }
      yield {
        type: "done",
        stopReason: overrides?.stopReason === undefined ? "end_turn" : overrides.stopReason,
      };
    },
  };
}

function gatewayBody(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    feature: "fast-reply",
    pageLabel: "resto-of",
    platform: "onlyfans",
    platformUserId: "424242",
    conversationId: "424242",
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

async function sessionCookieFor(username: string, password: string) {
  const login = await apiServer!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  const header = login.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") {
    throw new Error(`login failed for ${username}: ${login.statusCode}`);
  }
  return value.split(";")[0]!;
}

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
  appContext.config.chatMuseAiGatewayEnabled = true;
  const model = await createModel(appContext.db, { slug: "resto", name: "Resto" });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "resto-of" });
  pageId = page.id;
  await storeProxyConfig(appContext.db, page.id, {
    url: "socks5://proxy.example:1080",
    encryptedAuth: null,
    keyVersion: null,
    rateLimitScopeKey: "shared-ai-proxy",
  });

  await createUserAccount(appContext, {
    username: "resto-owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, {
    username: "resto-lead",
    role: "team_lead",
    password: "lead-secret",
  }, { source: "cli" });
  const chatter = await createUserAccount(appContext, {
    username: "resto-chatter",
    role: "chatter",
  }, { source: "cli" });
  if (!chatter) {
    throw new Error("chatter creation failed");
  }
  chatterKey = (await issueChatterDeviceToken(appContext, {
    username: "resto-chatter",
    pageLabel: "resto-of",
  }, { source: "cli" })).key;

  apiServer = await buildApiServer(appContext);
  await apiServer.ready();
});

describe("restricted capture class (Stage 29)", () => {
  it("captures a completion verbatim, readable by owner and 403 for team_lead", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext.aiGatewayProvider = fakeProvider(["Hel", "lo"]);

    const body = gatewayBody();
    const response = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
    const meta = JSON.parse(
      response.body.split("\n\n").find((block) => block.includes("\"meta\""))!
        .split("data: ")[1]!,
    ) as { requestId: string };

    const { rows } = await testDb.pool.query(
      `select g.generation_ref, g.completion, g.feature, g.page_id::int as page_id,
              g.conversation_ref, g.prompt_blocks, g.params, u.gateway_outcome,
              u.cost_micro_usd::int as cost
       from ai_generation_content g
       join ai_usage_events u on u.id = g.usage_event_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      generation_ref: meta.requestId,
      completion: "Hello",
      feature: "fast-reply",
      page_id: pageId,
      conversation_ref: "424242",
      gateway_outcome: "completed",
      cost: 600,
    });
    expect(rows[0].prompt_blocks).toEqual([
      { role: "system", blocks: [{ text: "system instructions", cache: "1h" }] },
      { role: "user", blocks: [{ text: "conversation context", cache: "5m" }] },
    ]);
    expect(rows[0].params).toMatchObject({ outcome: "completed", stopReason: "end_turn" });

    // The passport's headline: owner reads, team_lead cannot.
    const ownerCookie = await sessionCookieFor("resto-owner", "owner-secret");
    const ownerList = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/restricted/generations",
      headers: { cookie: ownerCookie },
    });
    expect(ownerList.statusCode, ownerList.body).toBe(200);
    expect(ownerList.json().generations).toHaveLength(1);
    expect(ownerList.json().generations[0].completion).toBe("Hello");

    const leadCookie = await sessionCookieFor("resto-lead", "lead-secret");
    const leadList = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/restricted/generations",
      headers: { cookie: leadCookie },
    });
    expect(leadList.statusCode).toBe(403);

    const chatterList = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/restricted/generations",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect([401, 403]).toContain(chatterList.statusCode);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("denies over the per-feature budget with the typed quota_denied outcome", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext.aiGatewayProvider = fakeProvider(["never"]);
    appContext.config.chatMuseAiGatewayFeatureDailyMicroUsdLimits = "{\"fast-reply\": 500}";

    // First request completes and books 600 micro-USD — over the 500 cap.
    const first = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: gatewayBody(),
    });
    expect(first.statusCode, first.body).toBe(200);

    const denied = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: gatewayBody(),
    });
    expect(denied.statusCode, denied.body).toBe(429);
    expect(denied.json()).toMatchObject({ error: "quota_denied" });

    const { rows } = await testDb.pool.query(
      `select count(*)::int as n from ai_usage_events
       where gateway_outcome = 'quota_denied' and quota_accepted = false`,
    );
    expect(rows[0]).toEqual({ n: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("projects desktop.ai_acceptance observations by generation ref, idempotently", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const generationRef = randomUUID();
    const seed = async (payload: Record<string, unknown>, key: string) => {
      await testDb!.pool.query(
        `insert into observations (source, producer, kind, payload, payload_hash,
                                   idempotency_key, observed_at, received_at, parse_version)
         values ('client_capture', 'desktop:capture', 'desktop.ai_acceptance', $1::jsonb,
                 sha256($2::bytea), $2, now(), now(), 0)`,
        [JSON.stringify(payload), key],
      );
    };
    await seed({ generationRef, lifecycle: "inserted" }, "acc-1");
    await seed({ generationRef, lifecycle: "sent" }, "acc-2");
    // No ref / unknown lifecycle rows are skipped, not fatal; 'copied' is a
    // first-class lifecycle since Stage 31 (0074), and a 'sent' with
    // edited=true also books the schema's own 'edited' companion row.
    await seed({ lifecycle: "inserted" }, "acc-3");
    await seed({ generationRef, lifecycle: "copied" }, "acc-4");
    await seed({ generationRef, lifecycle: "sent", edited: true }, "acc-5");
    await seed({ generationRef, lifecycle: "definitely-not-a-lifecycle" }, "acc-6");

    const run = await runAiAcceptanceProjection(appContext);
    expect(run).toMatchObject({ scanned: 6, projected: 5, skippedNoRef: 2 });

    const rerun = await runAiAcceptanceProjection(appContext);
    expect(rerun).toMatchObject({ scanned: 0, projected: 0 });

    const { rows } = await testDb.pool.query(
      `select lifecycle from ai_acceptance_events
       where generation_ref = $1 order by lifecycle`,
      [generationRef],
    );
    expect(rows.map((row) => row.lifecycle)).toEqual(["copied", "edited", "inserted", "sent", "sent"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("runs the closing classifier through the gateway's internal lane", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext.config.anthropicApiKey = "test-key";
    const verdictJson = JSON.stringify({
      verdicts: [
        { id: "m1", state: "buy_signal", needs_reply: true, reason: "accepted PPV offer" },
      ],
    });
    const classifier = createGatewayClosingClassifier(appContext, {
      model: "claude-haiku-4-5",
      providerOverride: fakeProvider([verdictJson]),
    });
    const result = await classifier.classifyBatch([
      { id: "m1", context: [{ role: "fan", text: "yes please" }] },
    ]);
    expect(result.verdicts).toEqual([
      { id: "m1", needsReply: true, state: "buy_signal", reason: "accepted PPV offer" },
    ]);
    expect(result.inputTokens).toBe(100);

    // Spend joined the ledger under the feature, on the system lane.
    const { rows } = await testDb.pool.query(
      `select feature, user_id, gateway_outcome from ai_usage_events`,
    );
    expect(rows).toEqual([
      { feature: "workboard-closing", user_id: null, gateway_outcome: "completed" },
    ]);
    const { rows: content } = await testDb.pool.query(
      `select feature, completion from ai_generation_content`,
    );
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ feature: "workboard-closing", completion: verdictJson });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("classifies and settles an internal gateway stream failure before rethrowing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext.config.anthropicApiKey = "test-key";
    const classifier = createGatewayClosingClassifier(appContext, {
      model: "claude-haiku-4-5",
      providerOverride: fakeProvider(["partial internal output"], { failAfterFirst: true }),
    });

    await expect(classifier.classifyBatch([
      { id: "m1", context: [{ role: "fan", text: "hello" }] },
    ])).rejects.toThrow("boom");

    const { rows } = await testDb.pool.query<{
      gateway_outcome: string | null;
      error_code: string | null;
      failure_phase: string | null;
      provider_http_status: number | null;
    }>(`
      select gateway_outcome, error_code, failure_phase, provider_http_status
      from ai_usage_events
    `);
    expect(rows).toEqual([{
      gateway_outcome: "failed",
      error_code: "provider_stream_failed",
      failure_phase: "stream",
      provider_http_status: null,
    }]);
    const captured = await testDb.pool.query<{
      completion: string;
      outcome: string | null;
    }>(`
      select completion, params ->> 'outcome' as outcome
      from ai_generation_content
    `);
    expect(captured.rows).toEqual([{
      completion: "partial internal output",
      outcome: "failed",
    }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  // The internal lane used to fold frames by hand and default to "completed",
  // so each of these settled as a zero-cost SUCCESS: it resolved the global
  // provider latch and handed the workboard defaults that were then cached.
  // It now shares AiGatewayTerminalStreamConsumer with the SSE pump.
  const unusableTerminals = [
    {
      name: "a stream that never reported usage",
      overrides: { omitUsage: true } as const,
      errorCode: "provider_usage_missing",
    },
    {
      name: "a stream that ended without a usable stop reason",
      overrides: { stopReason: null } as const,
      errorCode: "provider_stream_incomplete",
    },
  ];

  for (const terminal of unusableTerminals) {
    it(`rejects and records ${terminal.name}`, async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      appContext.config.anthropicApiKey = "test-key";
      const classifier = createGatewayClosingClassifier(appContext, {
        model: "claude-haiku-4-5",
        providerOverride: fakeProvider(["[{\"id\":\"m1\"}]"], terminal.overrides),
      });

      await expect(classifier.classifyBatch([
        { id: "m1", context: [{ role: "fan", text: "hello" }] },
      ])).rejects.toThrow(/unusable terminal/);

      const { rows } = await testDb.pool.query<{
        gateway_outcome: string | null;
        error_code: string | null;
      }>("select gateway_outcome, error_code from ai_usage_events");
      expect(rows).toEqual([{
        gateway_outcome: "failed",
        error_code: terminal.errorCode,
      }]);
    }, INTEGRATION_TEST_TIMEOUT_MS);
  }

  it("rejects a stream whose output is empty", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext.config.anthropicApiKey = "test-key";
    const classifier = createGatewayClosingClassifier(appContext, {
      model: "claude-haiku-4-5",
      providerOverride: fakeProvider(["   "]),
    });

    await expect(classifier.classifyBatch([
      { id: "m1", context: [{ role: "fan", text: "hello" }] },
    ])).rejects.toThrow(/unusable terminal/);

    const { rows } = await testDb.pool.query<{ error_code: string | null }>(
      "select error_code from ai_usage_events",
    );
    expect(rows).toEqual([{ error_code: "provider_output_empty" }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not let an unusable terminal clear the global provider latch", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext.config.anthropicApiKey = "test-key";
    const incidentKey = "ai_provider_billing:global";
    await openNotificationIncident(testDb.db, {
      incidentKey,
      kind: "ai_provider_billing",
      platformAccountId: null,
      errorCode: "provider_billing",
      errorSummary: "Anthropic billing rejected AI generation",
      now: new Date("2026-07-24T12:00:00.000Z"),
    });

    const classifier = createGatewayClosingClassifier(appContext, {
      model: "claude-haiku-4-5",
      providerOverride: fakeProvider(["[{\"id\":\"m1\"}]"], { omitUsage: true }),
    });
    await expect(classifier.classifyBatch([
      { id: "m1", context: [{ role: "fan", text: "hello" }] },
    ])).rejects.toThrow(/unusable terminal/);

    // A zero-token non-answer is not proof that billing recovered.
    const incident = await getNotificationIncidentByKey(testDb.db, incidentKey);
    expect(incident).toMatchObject({ status: "open" });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
