import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
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

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// Stage 29 — the DP 6-A restricted capture class. A completion round-trips
// with its content captured owner-readable and team-lead-unreadable (the
// passport's headline test); acceptance events correlate by generation ref;
// budget breaches deny with the typed outcome. The raw prompt route that drives
// these generations is owner-session only since the persona cutover, so the
// owner's cookie sends them; clients generate through the feature lane.

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let pageId = 0;

function fakeProvider(deltas: string[]): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      for (const text of deltas) {
        yield { type: "content_delta", text };
      }
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
      yield { type: "done", stopReason: "end_turn" };
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
      headers: { cookie: await sessionCookieFor("resto-owner", "owner-secret") },
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
      headers: { cookie: await sessionCookieFor("resto-owner", "owner-secret") },
      payload: gatewayBody(),
    });
    expect(first.statusCode, first.body).toBe(200);

    const denied = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/gateway/stream",
      headers: { cookie: await sessionCookieFor("resto-owner", "owner-secret") },
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
});
