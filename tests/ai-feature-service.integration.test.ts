import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiFeatureStreamFrameSchema } from "@agency_hub_core/contracts";
import {
  AI_PERSONA_BUNDLED_VERSION_KEY,
  archiveAiPersona,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  findAiPersonaByKey,
  insertAiGenerationContent,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertAiPersona,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  EMPTY_TRANSCRIPT_TEXT,
  createBundledPersonalities,
  loadFanBio,
  loadFanDisplayName,
} from "../apps/runtime/src/modules/ai/index.ts";
import type {
  AiGatewayProvider,
  AiGatewayProviderInput,
} from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount, issueChatterApiKey } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Stage 30 pilot — fast-reply through the kernel feature service: context
// loads kernel-side, the MIGRATED builder assembles the prompt, the stream
// rides the Stage 29 gateway (ledger + restricted capture). The prompt
// manifest check is the byte-diff proof for the migrated unit.

const FAN = "777000777";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let pageId = 0;

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
  const bundledPersona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(appContext.db, {
    key: bundledPersona.id,
    displayName: bundledPersona.name,
    systemBlock: bundledPersona.content,
    bundledVersion: bundledPersona.builtinVersion!,
  });
  const model = await createModel(appContext.db, { slug: "svc", name: "Svc" });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "svc-of" });
  if (!page) {
    throw new Error("test setup: page creation failed");
  }
  pageId = page.id;
  await storeProxyConfig(appContext.db, page.id, {
    url: "socks5://proxy.example:1080",
    encryptedAuth: null,
    keyVersion: null,
    rateLimitScopeKey: "shared-ai-proxy",
  });
  // The client-context lane is fansly-only (audit hardening) — its tests run
  // against this page.
  const fanslyPage = await createFanslyPage(appContext.db, { modelId: model.id, label: "svc-fs" });
  if (!fanslyPage) {
    throw new Error("test setup: fansly page creation failed");
  }
  await storeProxyConfig(appContext.db, fanslyPage.id, {
    url: "socks5://proxy.example:1080",
    encryptedAuth: null,
    keyVersion: null,
    rateLimitScopeKey: "shared-ai-proxy",
  });
  const chatter = await createUserAccount(appContext, {
    username: "svc-chatter",
    role: "chatter",
  }, { source: "cli" });
  if (!chatter) {
    throw new Error("chatter creation failed");
  }
  chatterKey = (await issueChatterApiKey(appContext, {
    username: "svc-chatter",
    pageLabel: "svc-of",
  }, { source: "cli" })).key;
  await assignPageToUser(appContext, { username: "svc-chatter", pageLabel: "svc-fs" }, { source: "cli" });

  apiServer = await buildApiServer(appContext);
  await apiServer.ready();
});

async function seedConversation() {
  // Archive rows: fan message + our reply + a tip, all in the fan's thread.
  // Seeded relative to now: the ping-active assertion needs fan messages
  // inside the 5-day window, so fixed dates here are a time bomb.
  const seedAt = (minutes: number) =>
    new Date(Date.now() - 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();
  const rows = [
    { ref: "9001", text: "hey babe", mine: false, at: seedAt(0), tip: 0 },
    { ref: "9002", text: "hey you", mine: true, at: seedAt(5), tip: 0 },
    { ref: "9003", text: "sent you something", mine: false, at: seedAt(10), tip: 5000 },
  ];
  for (const row of rows) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
       values ($1, 'onlyfans', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [pageId, FAN, row.ref, row.mine ? null : FAN, row.mine, row.at, row.text,
        row.tip > 0, row.tip],
    );
  }
  await testDb!.pool.query(
    `insert into fans (platform, platform_user_id, username, display_name)
     values ('onlyfans', $1, 'bigspender', 'Big Spender')`,
    [FAN],
  );
  const fan = await testDb!.pool.query<{ id: string }>(
    `select id::text as id from fans where platform_user_id = $1`, [FAN],
  );
  await testDb!.pool.query(
    `insert into page_fans (fan_id, platform_account_id, is_subscriber, subscriber_since)
     values ($1, $2, true, '2026-06-01T00:00:00Z')`,
    [Number(fan.rows[0]!.id), pageId],
  );
  await testDb!.pool.query(
    `insert into transactions (platform_account_id, fan_id, transaction_id, raw_type,
       canonical_type, transaction_state, raw_status, gross_amount_mills,
       source_destination_amount_mills, creator_net_amount_mills, occurred_at, source)
     values ($1, $2, 'svc-tip-1', 'tip', 'tip', 'posted', 'done', 5000, 5000, 4000,
             $3, 'ofapi:webhook')`,
    [pageId, Number(fan.rows[0]!.id), seedAt(10)],
  );
}

function capturingProvider(capture: {
  input?: AiGatewayProviderInput;
  calls?: number;
}): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      capture.calls = (capture.calls ?? 0) + 1;
      capture.input = input;
      yield { type: "content_delta", text: "sure thing 😘" };
      yield {
        type: "usage",
        providerResponseId: "msg_svc",
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

function aiFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("AI feature service pilot (Stage 30)", () => {
  it("echoes the exact restricted prompt only for the capability plus live kill-switch", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    appContext.config.chatMuseAiPromptDebugEchoEnabled = true;
    const info = vi.spyOn(appContext.logger, "info");
    // Worst case on purpose: the wire cap is 300k chars, but every "&" escapes
    // to "&amp;" (×5) INTO ONE dynamic block — the echo frame must still fit the
    // feature-lane block bound and survive the real SDK parser.
    const transcript = "&".repeat(300_000);
    const escapedTranscript = "&amp;".repeat(300_000);
    const payload = {
      clientRequestId: randomUUID(),
      pageLabel: "svc-fs",
      platform: "fansly",
      conversationRef: FAN,
      clientContext: {
        transcript,
        messageCount: 12,
        fanDisplayName: "Large Context Fan",
        fanSpendingData: "",
        fanSubscriptionData: "",
      },
    };

    const withoutCapability = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload,
    });
    expect(withoutCapability.statusCode, withoutCapability.body).toBe(200);
    expect(aiFrames(withoutCapability.body).some((frame) => frame.type === "debug_input_v1")).toBe(false);

    const echoed = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "x-kernel-ai-capabilities": "other, debug-input-v1",
      },
      payload: { ...payload, clientRequestId: randomUUID() },
    });
    expect(echoed.statusCode, echoed.body).toBe(200);
    expect(echoed.headers["cache-control"]).toContain("no-store");
    const frames = aiFrames(echoed.body);
    expect(frames[0]?.type).toBe("meta");
    expect(frames[1]?.type).toBe("debug_input_v1");
    // Parse through the SAME schema the vendored SDK uses: a frame the kernel
    // can emit but the client rejects is a broken stream, not an echo.
    const debug = aiFeatureStreamFrameSchema.parse(frames[1]) as {
      systemBlocks: Array<{ text: string; cache: string }>;
      userBlocks: Array<{ text: string; cache: string }>;
      contextManifest: unknown;
    };
    const dynamicBlock = debug.userBlocks.find((block) => block.text.includes(escapedTranscript));
    expect(dynamicBlock).toBeDefined();
    expect(dynamicBlock!.text.length).toBeGreaterThan(1_500_000);
    expect(debug.contextManifest).toBeNull();

    const { rows } = await testDb.pool.query<{
      prompt_blocks: Array<{ role: string; blocks: unknown[] }>;
    }>(
      `select prompt_blocks from ai_generation_content order by id desc limit 1`,
    );
    expect(rows[0]!.prompt_blocks).toEqual([
      { role: "system", blocks: debug.systemBlocks },
      { role: "user", blocks: debug.userBlocks },
    ]);
    const emission = info.mock.calls.find((call) => call[1] === "ai prompt debug echo emitted");
    expect(emission?.[0]).toEqual({
      feature: "fast-reply",
      pageId: expect.any(Number),
      userId: expect.any(Number),
      username: "svc-chatter",
    });
    expect(JSON.stringify(emission)).not.toContain(escapedTranscript.slice(0, 100));

    // Kill-switch off → no frame even with the capability header.
    appContext.config.chatMuseAiPromptDebugEchoEnabled = false;
    const disabled = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "x-kernel-ai-capabilities": "debug-input-v1",
      },
      payload: { ...payload, clientRequestId: randomUUID() },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(aiFrames(disabled.body).some((frame) => frame.type === "debug_input_v1")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("assembles fast-reply kernel-side and streams through the gateway", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);

    const response = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        replyTone: "casual",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("sure thing");
    expect(aiFrames(response.body)[0]).not.toHaveProperty("personaDefinitionId");

    // The provider received the KERNEL-assembled prompt: migrated persona
    // as system block #2 (1h cache), formatted transcript + spending in
    // the user blocks.
    const body = capture.input!.body;
    expect(body.feature).toBe("fast-reply");
    expect(body.model).toBe("anthropic:claude-sonnet-4-6");
    const lora = createBundledPersonalities()[0]!;
    expect(body.prompt.systemBlocks[1]).toMatchObject({ text: lora.content, cache: "1h" });
    const userText = body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(userText).toMatch(/\[\d{2}:\d{2}\] Fan: hey babe/);
    expect(userText).toMatch(/\[\d{2}:\d{2}\] Model: hey you/);
    expect(userText).toContain("[Tip: $5.00]");
    expect(userText).toContain("<fan_spending_data>");
    expect(userText).toContain("<fan_subscription_data>");
    expect(userText).not.toContain(EMPTY_TRANSCRIPT_TEXT);

    // Ledger + restricted capture rode along (Stage 29 internals).
    const { rows } = await testDb.pool.query(
      `select g.feature, g.completion, u.gateway_outcome
       from ai_generation_content g join ai_usage_events u on u.id = g.usage_event_id`,
    );
    expect(rows).toEqual([
      { feature: "fast-reply", completion: "sure thing 😘", gateway_outcome: "completed" },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never falls back to source prompt bytes when the default DB persona is archived", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const bundled = createBundledPersonalities()[0]!;
    const catalog = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    const definitionId = catalog.json().personas.find(
      (persona: { key: string }) => persona.key === bundled.id,
    ).definitionId as string;
    const stored = await findAiPersonaByKey(appContext.db, bundled.id);
    expect(stored).toBeDefined();
    await archiveAiPersona(appContext.db, bundled.id, stored!.revision);
    const capture: { input?: AiGatewayProviderInput; calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);

    const response = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      error: "bad_request",
      message: expect.stringContaining("Default persona builtin:lora is unavailable"),
    });

    const definitionAware = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        expectedPersonaDefinitionId: definitionId,
      },
    });
    expect(definitionAware.statusCode, definitionAware.body).toBe(409);
    expect(definitionAware.json()).toMatchObject({
      error: "persona_definition_changed",
      statusCode: 409,
    });
    expect(capture.calls).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("uses a stored persona when personaKey is given and 404s unknown features", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    await upsertAiPersona(appContext.db, {
      key: "milly",
      displayName: "Milly",
      systemBlock: "## Who you are\nYou are Milly.",
    });
    const catalog = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    const definitionId = catalog.json().personas.find(
      (persona: { key: string }) => persona.key === "milly",
    ).definitionId as string;
    const capture: { input?: AiGatewayProviderInput; calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);

    const response = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        personaKey: "milly",
        expectedPersonaDefinitionId: definitionId,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(capture.input!.body.prompt.systemBlocks[1]!.text).toContain("You are Milly.");
    expect(aiFrames(response.body)[0]).toMatchObject({
      type: "meta",
      personaDefinitionId: definitionId,
    });

    const stale = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        personaKey: "milly",
        expectedPersonaDefinitionId: `v1:${"x".repeat(43)}`,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toEqual({
      error: "persona_definition_changed",
      message: "AI persona definition changed; refresh the persona catalog and retry",
      statusCode: 409,
    });
    expect(capture.calls).toBe(1);
    const usageAfterConflict = await testDb!.pool.query<{ count: string }>(
      "select count(*)::text as count from ai_usage_events",
    );
    expect(usageAfterConflict.rows[0]!.count).toBe("1");

    const current = await findAiPersonaByKey(appContext.db, "milly");
    expect(current).toBeDefined();
    await archiveAiPersona(appContext.db, "milly", current!.revision);
    const archived = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        personaKey: "milly",
        expectedPersonaDefinitionId: definitionId,
      },
    });
    expect(archived.statusCode, archived.body).toBe(409);
    expect(archived.json()).toMatchObject({
      error: "persona_definition_changed",
      statusCode: 409,
    });

    const missing = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        personaKey: "missing-after-catalog",
        expectedPersonaDefinitionId: definitionId,
      },
    });
    expect(missing.statusCode, missing.body).toBe(409);
    expect(missing.json()).toMatchObject({
      error: "persona_definition_changed",
      statusCode: 409,
    });
    expect(capture.calls).toBe(1);

    const legacyMissing = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        personaKey: "missing-after-catalog",
      },
    });
    expect(legacyMissing.statusCode, legacyMissing.body).toBe(400);
    expect(legacyMissing.json()).toMatchObject({
      error: "bad_request",
      message: "Unknown persona: missing-after-catalog",
    });

    const unknown = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/definitely-not-a-feature",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
      },
    });
    expect(unknown.statusCode).toBe(404);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("kernel personas (Stage 31 Task 3)", () => {
  it("lists and upserts personas over the apiKey lane", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await upsertAiPersona(appContext.db, {
      key: "builtin:lora",
      displayName: "Lora",
      systemBlock: "## Who you are",
    });

    const put = await apiServer!.inject({
      method: "PUT",
      url: "/api/v1/ai/personas/custom-milly",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: { displayName: "Milly", systemBlock: "## Who you are\nMilly." },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      key: "custom-milly",
      displayName: "Milly",
      version: expect.any(Number),
    });

    const list = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/personas",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().personas.map((persona: { key: string }) => persona.key).sort())
      .toEqual(["builtin:lora", "custom-milly"]);

    const anonymous = await apiServer!.inject({ method: "GET", url: "/api/v1/ai/personas" });
    expect(anonymous.statusCode).toBe(401);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("catalogs tombstones while create-only stays strict and legacy replay may resurrect", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = `custom-tombstone-${randomUUID()}`;
    const created = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Tombstone regression",
        systemBlock: "Must remain archived",
        expectedVersion: null,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const createdVersion = (created.json() as { version: number }).version;

    const archived = await apiServer!.inject({
      method: "DELETE",
      url: `/api/v1/ai/personas/${key}?expectedVersion=${createdVersion}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({ archived: true, version: createdVersion + 1 });

    const state = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json().personas).toContainEqual({
      status: "archived",
      key,
      displayName: "Tombstone regression",
      version: createdVersion + 1,
      definitionId: expect.any(String),
    });
    expect(state.body).not.toContain("Must remain archived");

    const staleCreate = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Stale desktop cache",
        systemBlock: "Must not unarchive",
        expectedVersion: null,
      },
    });
    expect(staleCreate.statusCode, staleCreate.body).toBe(409);

    // v0.1.41 and older omit expectedVersion. Preserve their shipped LWW
    // behavior until the preservation/read-only client rollout completes.
    const legacyPut = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Legacy stale desktop cache",
        systemBlock: "Legacy resurrection remains transitional",
      },
    });
    expect(legacyPut.statusCode, legacyPut.body).toBe(200);

    const after = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(after.json().personas).toContainEqual({
      status: "active",
      key,
      displayName: "Legacy stale desktop cache",
      version: createdVersion + 2,
      definitionId: expect.any(String),
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("allows exactly one expected-version winner and rejects stale numeric writers", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = `custom-cas-${randomUUID()}`;
    const created = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "CAS seed",
        systemBlock: "initial",
        expectedVersion: null,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const createdVersion = (created.json() as { version: number }).version;

    const [left, right] = await Promise.all([
      apiServer!.inject({
        method: "PUT",
        url: `/api/v1/ai/personas/${key}`,
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: {
          displayName: "Left writer",
          systemBlock: "left won",
          expectedVersion: createdVersion,
        },
      }),
      apiServer!.inject({
        method: "PUT",
        url: `/api/v1/ai/personas/${key}`,
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: {
          displayName: "Right writer",
          systemBlock: "right won",
          expectedVersion: createdVersion,
        },
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const winner = left.statusCode === 200 ? left : right;
    expect(winner.json()).toMatchObject({ version: createdVersion + 1 });

    const stale = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Stale retry",
        systemBlock: "must not overwrite the winner",
        expectedVersion: createdVersion,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const state = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/personas",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(state.statusCode, state.body).toBe(200);
    const winnerBody = winner.json() as {
      displayName: string;
      systemBlock: string;
      version: number;
    };
    expect(state.json().personas).toContainEqual({
      key,
      displayName: winnerBody.displayName,
      systemBlock: winnerBody.systemBlock,
      updatedAt: expect.any(String),
      version: createdVersion + 1,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps identical legacy replay revision-idempotent while divergent content remains LWW", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = `custom-legacy-cas-${randomUUID()}`;
    const created = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Legacy seed",
        systemBlock: "version one",
        expectedVersion: null,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const createdBody = created.json() as { version: number; updatedAt: string };
    const versionOne = createdBody.version;

    const identicalReplay = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: { displayName: "Legacy seed", systemBlock: "version one" },
    });
    expect(identicalReplay.statusCode, identicalReplay.body).toBe(200);
    expect(identicalReplay.json()).toMatchObject({
      version: versionOne,
      updatedAt: createdBody.updatedAt,
    });

    const newer = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Device B",
        systemBlock: "version two",
        expectedVersion: versionOne,
      },
    });
    expect(newer.statusCode, newer.body).toBe(200);
    const versionTwo = (newer.json() as { version: number }).version;

    const staleLegacy = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: { displayName: "Legacy seed", systemBlock: "version one" },
    });
    expect(staleLegacy.statusCode, staleLegacy.body).toBe(200);
    expect(staleLegacy.json()).toMatchObject({ version: versionTwo + 1 });

    const state = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/personas",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(state.json().personas).toContainEqual({
      key,
      displayName: "Legacy seed",
      systemBlock: "version one",
      updatedAt: expect.any(String),
      version: versionTwo + 1,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps omitted-version legacy archive while numeric stale archives conflict", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = `custom-archive-cas-${randomUUID()}`;
    const created = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Archive seed",
        systemBlock: "version one",
        expectedVersion: null,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const versionOne = (created.json() as { version: number }).version;

    const newer = await apiServer!.inject({
      method: "PUT",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        displayName: "Device B",
        systemBlock: "version two",
        expectedVersion: versionOne,
      },
    });
    expect(newer.statusCode, newer.body).toBe(200);
    const versionTwo = (newer.json() as { version: number }).version;

    const staleDelete = await apiServer!.inject({
      method: "DELETE",
      url: `/api/v1/ai/personas/${key}?expectedVersion=${versionOne}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(staleDelete.statusCode, staleDelete.body).toBe(409);

    const legacyDelete = await apiServer!.inject({
      method: "DELETE",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(legacyDelete.statusCode, legacyDelete.body).toBe(200);
    expect(legacyDelete.json()).toEqual({ archived: true, version: versionTwo + 1 });

    const staleAfterArchive = await apiServer!.inject({
      method: "DELETE",
      url: `/api/v1/ai/personas/${key}?expectedVersion=${versionTwo}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(staleAfterArchive.statusCode, staleAfterArchive.body).toBe(409);

    const legacyReplay = await apiServer!.inject({
      method: "DELETE",
      url: `/api/v1/ai/personas/${key}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(legacyReplay.statusCode, legacyReplay.body).toBe(404);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("seeds bundled personas create-only and never overwrites an existing key", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const key = `builtin:seed-policy-${randomUUID()}`;
    const created = await seedBundledAiPersona(appContext.db, {
      key,
      displayName: "Bundled v2",
      systemBlock: "bundled version two",
      bundledVersion: 2,
    });
    expect(created).toMatchObject({ action: "created", persona: { revision: 1 } });

    const customized = await upsertAiPersona(appContext.db, {
      key,
      displayName: "User-edited name",
      systemBlock: "customized by user",
      expectedVersion: created.persona.revision,
    });
    expect(customized.revision).toBe(2);
    expect(customized.featureOverrides[AI_PERSONA_BUNDLED_VERSION_KEY]).toBe(2);

    const sameVersion = await seedBundledAiPersona(appContext.db, {
      key,
      displayName: "Bundled v2",
      systemBlock: "bundled version two",
      bundledVersion: 2,
    });
    expect(sameVersion).toMatchObject({
      action: "preserved",
      persona: {
        displayName: "User-edited name",
        systemBlock: "customized by user",
        revision: 2,
      },
    });
    const repeated = await seedBundledAiPersona(appContext.db, {
      key,
      displayName: "Bundled v2",
      systemBlock: "bundled version two",
      bundledVersion: 2,
    });
    expect(repeated.persona.revision).toBe(2);

    const upgraded = await seedBundledAiPersona(appContext.db, {
      key,
      displayName: "Bundled v3",
      systemBlock: "bundled version three",
      bundledVersion: 3,
    });
    expect(upgraded).toMatchObject({
      action: "preserved",
      persona: {
        displayName: "User-edited name",
        systemBlock: "customized by user",
        revision: 2,
      },
    });
    expect(upgraded.persona.featureOverrides[AI_PERSONA_BUNDLED_VERSION_KEY]).toBe(2);

    const legacyKey = `builtin:seed-adopt-${randomUUID()}`;
    const legacy = await upsertAiPersona(appContext.db, {
      key: legacyKey,
      displayName: "Already customized",
      systemBlock: "pre-metadata customization",
      expectedVersion: null,
    });
    const adopted = await seedBundledAiPersona(appContext.db, {
      key: legacyKey,
      displayName: "Bundled v2",
      systemBlock: "must not replace legacy customization",
      bundledVersion: 2,
    });
    expect(adopted).toMatchObject({
      action: "preserved",
      persona: {
        displayName: legacy.displayName,
        systemBlock: legacy.systemBlock,
        revision: legacy.revision,
      },
    });
    expect((await findAiPersonaByKey(appContext.db, legacyKey))?.revision).toBe(legacy.revision);

    const archived = await archiveAiPersona(appContext.db, legacyKey, legacy.revision);
    expect(archived?.archivedAt).not.toBeNull();
    const archivedSeed = await seedBundledAiPersona(appContext.db, {
      key: legacyKey,
      displayName: "Bundled must not restore",
      systemBlock: "must not replace archived owner content",
      bundledVersion: 99,
    });
    expect(archivedSeed).toMatchObject({
      action: "preserved",
      persona: {
        displayName: legacy.displayName,
        systemBlock: legacy.systemBlock,
        revision: legacy.revision + 1,
        archivedAt: expect.any(Date),
      },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("AI feature registry gates (Stage 30 Task 4)", () => {
  it("enforces the desktop product gates across the seven features", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const call = (feature: string, extra: Record<string, unknown> = {}) =>
      apiServer!.inject({
        method: "POST",
        url: `/api/v1/ai/features/${feature}`,
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: {
          clientRequestId: randomUUID(),
          pageLabel: "svc-of",
          platform: "onlyfans",
          conversationRef: FAN,
          ...extra,
        },
      });

    // improve-draft demands a draft, then embeds it.
    const noDraft = await call("improve-draft");
    expect(noDraft.statusCode, noDraft.body).toBe(400);
    expect(noDraft.json().error).toBe("gate_draft_required");
    const withDraft = await call("improve-draft", { draftText: "hey love, sup" });
    expect(withDraft.statusCode, withDraft.body).toBe(200);
    expect(capture.input!.body.feature).toBe("improve-draft");
    expect(
      capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n"),
    ).toContain("hey love, sup");

    // Deep features gate on the minimum window (3 messages < 30).
    const summary = await call("fan-summary");
    expect(summary.statusCode, summary.body).toBe(400);
    expect(summary.json().message).toContain("at least 30");
    expect(summary.json().error).toBe("gate_min_messages");
    const review = await call("chat-review");
    expect(review.statusCode).toBe(400);

    // ping derives its segment kernel-side; an ACTIVE conversation is
    // blocked — desktop CG-FLOW-05 parity. The seed's fixed 2026-07-06
    // timestamps age out of the 5-day active window by calendar, so pin
    // recency explicitly to keep the gate deterministic.
    await testDb.pool.query(
      `update message_archive set occurred_at = now()
       where account_id = $1 and is_sent_by_me = false`,
      [pageId],
    );
    const pingActive = await call("ping");
    expect(pingActive.statusCode, pingActive.body).toBe(400);
    expect(pingActive.json().message).toContain("active");
    expect(pingActive.json().error).toBe("gate_ping_active");

    // Age the fan's messages past the 5-day window: ping unblocks.
    await testDb.pool.query(
      `update message_archive set occurred_at = now() - interval '10 days'
       where account_id = $1 and is_sent_by_me = false`,
      [pageId],
    );
    const ping = await call("ping");
    expect(ping.statusCode, ping.body).toBe(200);
    expect(capture.input!.body.feature).toBe("ping");
    // Restore recency for the later hi-greeting assertions.
    await testDb.pool.query(
      `update message_archive set occurred_at = now()
       where account_id = $1 and is_sent_by_me = false`,
      [pageId],
    );

    // help-me (analysis preamble) streams.
    const helpMe = await call("help-me");
    expect(helpMe.statusCode, helpMe.body).toBe(200);

    // hi-greeting: allowed on a short conversation, WITHOUT earnings blocks.
    const hi = await call("hi-greeting");
    expect(hi.statusCode, hi.body).toBe(200);
    expect(capture.input!.body.feature).toBe("hi-greeting");
    const hiText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(hiText).not.toContain("<fan_spending_data>");

    // hi-greeting locks once the conversation outgrows the legacy cap (10).
    for (let extra = 0; extra < 12; extra += 1) {
      await testDb.pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref,
           fan_native_id, is_sent_by_me, occurred_at, text_plain)
         values ($1, 'onlyfans', $2, $3, $2, false, now(), 'more chatter')`,
        [pageId, FAN, String(9100 + extra)],
      );
    }
    const hiLocked = await call("hi-greeting");
    expect(hiLocked.statusCode, hiLocked.body).toBe(400);
    expect(hiLocked.json().message).toContain("at most 10");
    expect(hiLocked.json().error).toBe("gate_hi_greeting_limit");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("client-context path (Stage 32)", () => {
  it("uses client-loaded values verbatim and runs the gates on client counts", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation(); // archive has only 3 messages
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const call = (feature: string, clientContext: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      apiServer!.inject({
        method: "POST",
        url: `/api/v1/ai/features/${feature}`,
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: {
          clientRequestId: randomUUID(),
          pageLabel: "svc-fs",
          platform: "fansly",
          conversationRef: FAN,
          clientContext,
          ...extra,
        },
      });

    const baseContext = {
      transcript: "[10:00] Fan: fresh client-side message about the beach",
      messageCount: 35,
      fanDisplayName: "Charles",
      fanSpendingData: "Total: $42.00",
      fanSubscriptionData: "Subscribed: yes",
    };

    // fan-summary needs ≥30 messages — the CLIENT count satisfies it even
    // though the kernel archive only has 3 (the freshness rationale).
    const summary = await call("fan-summary", baseContext);
    expect(summary.statusCode, summary.body).toBe(200);
    const summaryText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(summaryText).toContain("fresh client-side message about the beach");
    expect(summaryText).toContain("Total: $42.00");

    // hi-greeting locks on the client count (35 > 10)…
    const hiLocked = await call("hi-greeting", baseContext);
    expect(hiLocked.statusCode, hiLocked.body).toBe(400);
    expect(hiLocked.json().message).toContain("at most 10");
    // …and passes with a short client conversation, ignoring earnings data.
    const hi = await call("hi-greeting", { ...baseContext, messageCount: 2, fanBio: "loves cats" });
    expect(hi.statusCode, hi.body).toBe(200);
    const hiText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(hiText).not.toContain("<fan_spending_data>");

    // ping demands the client-computed segment, honors the active block, and
    // proceeds on a quiet segment.
    const pingNoSegment = await call("ping", baseContext);
    expect(pingNoSegment.statusCode, pingNoSegment.body).toBe(400);
    expect(pingNoSegment.json().message).toContain("pingSegment");
    const pingActive = await call("ping", { ...baseContext, pingSegment: "active" });
    expect(pingActive.statusCode, pingActive.body).toBe(400);
    expect(pingActive.json().message).toContain("active");
    const ping = await call("ping", { ...baseContext, pingSegment: "segment-a" });
    expect(ping.statusCode, ping.body).toBe(200);

    // Audit hardening: OnlyFans context is kernel-fresh — client-fabricated
    // context is refused there (fansly-only lane).
    const onlyfansContext = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fan-summary",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        clientContext: baseContext,
      },
    });
    expect(onlyfansContext.statusCode, onlyfansContext.body).toBe(400);
    expect(onlyfansContext.json().message).toContain("only accepted for fansly");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("coach-chat gates", () => {
  // These gates fire in prepareAiFeatureStream BEFORE any page/context load,
  // so they assert on the request shape alone — the seeded fansly page is used
  // only to satisfy the chatter's access, never actually loaded here.
  const fanslyPageLabel = "svc-fs";
  const coachPayload = (over: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(),
    pageLabel: fanslyPageLabel,
    platform: "fansly",
    conversationRef: "group-777",
    fanRef: "fan-42",
    clientContext: { transcript: "fan: hi", messageCount: 1, fanDisplayName: "Bob" },
    ...over,
  });

  it("requires chatterQuestion for coach-chat", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload(),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/chatterQuestion/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects coach fields on other features", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ chatterQuestion: "hm?" }),
    });
    expect(res.statusCode, res.body).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects summaryMode outside fan-summary", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/help-me",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ summaryMode: "short" }),
    });
    expect(res.statusCode, res.body).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects oversized aggregate history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({
        chatterQuestion: "q",
        coachHistory: Array.from({ length: 13 }, () => ({
          question: "q".repeat(1000),
          answer: "a".repeat(9000),
        })), // 13 * 10000 = 130k > 120k
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/coachHistory/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects unknown features with a structured code", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/nope",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_ai_feature");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("streams coach-chat and carries the question into the assembled prompt", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({
        chatterQuestion: "как продать ppv?",
        coachHistory: [{ question: "с чего начать?", answer: "нащупай боль" }],
        clientContext: {
          transcript: "[10:00] Fan: hey babe",
          messageCount: 3,
          fanDisplayName: "Bob",
          fanSpendingData: "Total: $42.00",
          fanSubscriptionData: "Subscribed: yes",
          transcriptCoverage: "window",
        },
      }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const frames = aiFrames(res.body);
    expect(frames.find((frame) => frame.type === "meta")?.feature).toBe("coach-chat");
    expect(frames.at(-1)?.type).toBe("done");
    // The capturing provider saw the assembled prompt with the question and the
    // coverage note (the extension's coach question rode client-side context).
    const prompt = JSON.stringify(capture.input);
    expect(prompt).toContain("как продать ppv?");
    expect(prompt).toContain("нащупай боль");
    expect(prompt).toContain("most recent window only");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("fan-summary short variant cap (Task 8)", () => {
  // The compact recap rides the client-context (fansly) lane; messageCount 35
  // clears fan-summary's deep-feature minimum without a seeded archive.
  const shortContext = {
    transcript: "[10:00] Fan: fresh beach message",
    messageCount: 35,
    fanDisplayName: "Charles",
    fanSpendingData: "Total: $42.00",
    fanSubscriptionData: "Subscribed: yes",
    transcriptCoverage: "window" as const,
  };

  async function postFanSummary(over: Record<string, unknown> = {}) {
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fan-summary",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-fs",
        platform: "fansly",
        conversationRef: FAN,
        clientContext: shortContext,
        ...over,
      },
    });
    return { res, capture };
  }

  it("caps output at 2048 tokens and selects the compact template", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { res, capture } = await postFanSummary({ summaryMode: "short" });
    expect(res.statusCode, res.body).toBe(200);
    // The 2048 cap reaches the provider on the gateway body (honored by both
    // providers as input.maxTokens ?? tuning.maxTokens).
    expect(capture.input!.body.maxTokens).toBe(2048);
    const promptText = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(promptText).toContain("COMPACT RECAP");
    expect(promptText).toContain("fresh beach message");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves maxTokens unset and uses the full template without summaryMode", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { res, capture } = await postFanSummary();
    expect(res.statusCode, res.body).toBe(200);
    expect(capture.input!.body.maxTokens).toBeUndefined();
    const promptText = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(promptText).not.toContain("COMPACT RECAP");
    expect(promptText).toContain("detailed fan profile review");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("coach-chat recap attach (spec §5)", () => {
  // Exercises the six attach branches in prepareAiFeatureStream by seeding
  // fan-summary recap rows (as the recap reader in ai-recap-selection does) and
  // asserting on the assembled prompt the capturing provider saw. The recap
  // reader searches conversationRefs [conversationRef, fanRef]; rows are seeded
  // under the conversationRef.
  const conversationRef = "group-777";
  const fanRef = "fan-42";
  const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function svcFsPageId(): Promise<number> {
    const { rows } = await testDb!.pool.query<{ id: string }>(
      `select id::text as id from pages where label = 'svc-fs'`,
    );
    return Number(rows[0]!.id);
  }

  async function seedRecap(input: {
    pageId: number;
    mode: "full" | "short";
    completion: string;
    createdAt: Date;
  }): Promise<void> {
    const generationRef = randomUUID();
    await insertAiGenerationContent(testDb!.db, {
      usageEventId: null,
      generationRef,
      feature: "fan-summary",
      model: "m",
      provider: "anthropic",
      userId: null,
      pageId: input.pageId,
      conversationRef,
      promptBlocks: [],
      completion: input.completion,
      params: { summaryMode: input.mode, outcome: "completed", stopReason: "end_turn" },
    });
    // insertAiGenerationContent has no createdAt input; set it directly so the
    // full-vs-short recency the attach rule compares is deterministic.
    await testDb!.pool.query(
      `update ai_generation_content set created_at = $1 where generation_ref = $2`,
      [input.createdAt.toISOString(), generationRef],
    );
  }

  async function runCoach(over: Record<string, unknown> = {}) {
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-fs",
        platform: "fansly",
        conversationRef,
        fanRef,
        chatterQuestion: "как продать ppv?",
        clientContext: {
          transcript: "[10:00] Fan: hey babe",
          messageCount: 3,
          fanDisplayName: "Bob",
          fanSpendingData: "Total: $42.00",
          fanSubscriptionData: "Subscribed: yes",
        },
        ...over,
      },
    });
    return { res, promptText: JSON.stringify(capture.input) };
  }

  it("(a) only a full recap exists -> full attached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    await seedRecap({ pageId, mode: "full", completion: "FULL_ONLY_BODY", createdAt: daysAgo(2) });
    const { res, promptText } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).toContain("Full recap");
    expect(promptText).toContain("FULL_ONLY_BODY");
    expect(promptText).not.toContain("Short recap");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("(b) only a short recap exists -> short attached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    await seedRecap({ pageId, mode: "short", completion: "SHORT_ONLY_BODY", createdAt: daysAgo(1) });
    const { res, promptText } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).toContain("Short recap");
    expect(promptText).toContain("SHORT_ONLY_BODY");
    expect(promptText).not.toContain("Full recap");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("(c) both exist, short newer -> BOTH attached, and (f) the manifest records both ages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    await seedRecap({ pageId, mode: "full", completion: "FULLBODY_C", createdAt: daysAgo(5) });
    await seedRecap({ pageId, mode: "short", completion: "SHORTBODY_C", createdAt: daysAgo(1) });
    const { res, promptText } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).toContain("Full recap");
    expect(promptText).toContain("FULLBODY_C");
    expect(promptText).toContain("Short recap");
    expect(promptText).toContain("SHORTBODY_C");
    // (f) contextManifest.recapAttach is observable on the restricted-store row.
    const { rows } = await testDb.pool.query<{ params: Record<string, unknown> }>(
      `select params from ai_generation_content where feature = 'coach-chat' order by id desc limit 1`,
    );
    const recapAttach = (
      rows[0]?.params as {
        contextManifest?: { recapAttach?: { full: number | null; short: number | null } };
      }
    )?.contextManifest?.recapAttach;
    expect(typeof recapAttach?.full).toBe("number");
    expect(typeof recapAttach?.short).toBe("number");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("(d) both exist, full newer -> full only", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    await seedRecap({ pageId, mode: "full", completion: "FULLBODY_D", createdAt: daysAgo(1) });
    await seedRecap({ pageId, mode: "short", completion: "SHORTBODY_D", createdAt: daysAgo(5) });
    const { res, promptText } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).toContain("Full recap");
    expect(promptText).toContain("FULLBODY_D");
    expect(promptText).not.toContain("Short recap");
    expect(promptText).not.toContain("SHORTBODY_D");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("(e) full recap identical to the injected dossier -> attached once (dedupe)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    // A plain, heading-less body compiles to itself (compileDossierForPrompt
    // drops/truncates nothing), so the LOADED dossier body equals the raw body
    // equals the seeded recap completion — the exact-match dedupe fires.
    const body = "Charles rides a red Ducati and lives in Austin. Big tipper.";
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('fansly', $1, 'dedupe-fan', 'Dedupe Fan')`,
      [fanRef],
    );
    const { rows: fanRows } = await testDb.pool.query<{ id: string }>(
      `select id::text as id from fans where platform = 'fansly' and platform_user_id = $1`,
      [fanRef],
    );
    await testDb.pool.query(
      `insert into fan_profiles (fan_id, platform_account_id, version, body, source, source_generated_at)
       values ($1, $2, 1, $3, 'chatmuse', now())`,
      [Number(fanRows[0]!.id), pageId, body],
    );
    await seedRecap({ pageId, mode: "full", completion: body, createdAt: daysAgo(2) });
    // The dossier path is off by default; the env allowlist enables it here.
    appContext.config.chatMuseAiFanProfileContextFeatures = "all";
    const { res, promptText } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    // The dossier is injected...
    expect(promptText).toContain("## Fan Dossier");
    // ...and the duplicate full recap is dropped (no recap section at all).
    expect(promptText).not.toContain("## Fan Recaps");
    expect(promptText).not.toContain("Full recap");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("fan-dossier context (Decision #136)", () => {
  // Production shape: fan-summary writes RUSSIAN markdown (## N. ЗАГОЛОВОК).
  const DOSSIER_BODY = [
    "# ПРОФИЛЬ ФАНАТА: Charles",
    "",
    "## 1. ДОСЬЕ",
    "- Ездит на красном Ducati, живёт в Остине",
    "",
    "## 5. ФИНАНСОВЫЙ ПРОФИЛЬ",
    "- Кит, типсует каждый вечер",
    "",
    "## 6. ОТКРЫТЫЕ ПЕТЛИ",
    "- Обещала фото с пляжа",
  ].join("\n");

  async function seedFanProfile(input: {
    platform: "onlyfans" | "fansly";
    targetPageId: number;
    body?: string;
    createdAt?: string;
    sourceGeneratedAt?: string | null;
  }): Promise<void> {
    const existing = await testDb!.pool.query<{ id: string }>(
      `select id::text as id from fans where platform = $1 and platform_user_id = $2`,
      [input.platform, FAN],
    );
    let fanId: number;
    if (existing.rows.length > 0) {
      fanId = Number(existing.rows[0]!.id);
    } else {
      const inserted = await testDb!.pool.query<{ id: string }>(
        `insert into fans (platform, platform_user_id, username, display_name)
         values ($1, $2, 'dossier-fan', 'Dossier Fan') returning id::text as id`,
        [input.platform, FAN],
      );
      fanId = Number(inserted.rows[0]!.id);
    }
    await testDb!.pool.query(
      `insert into fan_profiles (fan_id, platform_account_id, version, body, source, created_at, source_generated_at)
       values ($1, $2, 1, $3, 'chatmuse', $4, $5)`,
      [
        fanId,
        input.targetPageId,
        input.body ?? DOSSIER_BODY,
        input.createdAt ?? new Date().toISOString(),
        input.sourceGeneratedAt ?? null,
      ],
    );
  }

  function makeCall(capture: { input?: AiGatewayProviderInput }) {
    // Default rollout flag is "none" — these tests exercise the injection.
    appContext.config.chatMuseAiFanProfileContextFeatures = "all";
    appContext.aiGatewayProvider = capturingProvider(capture);
    return (feature: string, extra: Record<string, unknown> = {}) =>
      apiServer!.inject({
        method: "POST",
        url: `/api/v1/ai/features/${feature}`,
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: {
          clientRequestId: randomUUID(),
          pageLabel: "svc-of",
          platform: "onlyfans",
          conversationRef: FAN,
          ...extra,
        },
      });
  }

  const userText = (capture: { input?: AiGatewayProviderInput }) =>
    capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");

  it("injects the dossier into policy features (kernel path) and keeps excluded features clean", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    await seedFanProfile({ platform: "onlyfans", targetPageId: pageId });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("## Fan Dossier");
    expect(text).toContain("красном Ducati");
    expect(text).toContain("generated on");
    expect(text).toContain("the transcript is authoritative");
    // The financial section never rides along — fresh spend data has its own block.
    expect(text).not.toContain("типсует");
    // The dossier lives in the ephemeral dynamic block, not the 1h static prefix.
    const dynamicBlock = capture.input!.body.prompt.userBlocks.find((block) => block.cache === "5m");
    expect(dynamicBlock?.text).toContain("## Fan Dossier");
    const staticBlock = capture.input!.body.prompt.userBlocks.find((block) => block.cache === "1h");
    expect(staticBlock?.text).not.toContain("## Fan Dossier");

    // hi-greeting is policy-excluded (a cold opener must not show familiarity).
    const hi = await call("hi-greeting");
    expect(hi.statusCode, hi.body).toBe(200);
    expect(userText(capture)).not.toContain("## Fan Dossier");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("degrades silently when no profile exists or the fan is marked deleted", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const noProfile = await call("fast-reply");
    expect(noProfile.statusCode, noProfile.body).toBe(200);
    expect(userText(capture)).not.toContain("## Fan Dossier");

    await seedFanProfile({ platform: "onlyfans", targetPageId: pageId });
    await testDb.pool.query(
      `update fans set deleted_detected_at = now() where platform_user_id = $1`,
      [FAN],
    );
    const deletedFan = await call("fast-reply");
    expect(deletedFan.statusCode, deletedFan.body).toBe(200);
    expect(userText(capture)).not.toContain("## Fan Dossier");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("honors the runtime allowlist (staged rollout and no-deploy rollback)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    await seedFanProfile({ platform: "onlyfans", targetPageId: pageId });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    appContext.config.chatMuseAiFanProfileContextFeatures = "none";
    const rolledBack = await call("fast-reply");
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);
    expect(userText(capture)).not.toContain("## Fan Dossier");

    appContext.config.chatMuseAiFanProfileContextFeatures = "ping";
    const notListed = await call("fast-reply");
    expect(notListed.statusCode, notListed.body).toBe(200);
    expect(userText(capture)).not.toContain("## Fan Dossier");

    appContext.config.chatMuseAiFanProfileContextFeatures = "fast-reply";
    const listed = await call("fast-reply");
    expect(listed.statusCode, listed.body).toBe(200);
    expect(userText(capture)).toContain("## Fan Dossier");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("dates the dossier by its SOURCE generation time, not the hub append time", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    // Delayed re-push scenario: the row was APPENDED just now, but the Scan
    // itself ran 60 days ago. Sections are no longer age-dropped (#136 addendum) —
    // instead the disclaimer must stamp the SOURCE date, not today's append date.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const sourceDate = sixtyDaysAgo.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    await seedFanProfile({
      platform: "onlyfans",
      targetPageId: pageId,
      createdAt: new Date().toISOString(),
      sourceGeneratedAt: sixtyDaysAgo.toISOString(),
    });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("красном Ducati");
    // Volatile sections stay in now; the disclaimer carries the source date.
    expect(text).toContain("Обещала фото с пляжа");
    expect(text).toContain(`generated on ${sourceDate}`);
    expect(text).not.toContain(`generated on ${today}`);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("falls back to created_at for legacy rows without a source time", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const createdDate = sixtyDaysAgo.toISOString().slice(0, 10);
    await seedFanProfile({ platform: "onlyfans", targetPageId: pageId, createdAt: sixtyDaysAgo.toISOString() });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("красном Ducati");
    expect(text).toContain("Обещала фото с пляжа");
    expect(text).toContain(`generated on ${createdDate}`);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("injects on the fansly clientContext path alongside the client transcript", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const fanslyPage = await testDb.pool.query<{ id: string }>(
      `select id::text as id from pages where label = 'svc-fs'`,
    );
    await seedFanProfile({ platform: "fansly", targetPageId: Number(fanslyPage.rows[0]!.id) });
    appContext.config.chatMuseAiFanProfileContextFeatures = "all";
    appContext.config.chatMuseAiPromptDebugEchoEnabled = true;
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);

    const response = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "x-kernel-ai-capabilities": "debug-input-v1",
      },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-fs",
        platform: "fansly",
        conversationRef: FAN,
        clientContext: {
          transcript: "[10:00] Fan: fresh client-side message about the beach",
          messageCount: 12,
          fanDisplayName: "Charles",
          fanSpendingData: "Total: $42.00",
          fanSubscriptionData: "Subscribed: yes",
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("fresh client-side message about the beach");
    expect(text).toContain("## Fan Dossier");
    expect(text).toContain("красном Ducati");
    const debug = aiFrames(response.body).find((frame) => frame.type === "debug_input_v1");
    expect(debug?.contextManifest).toMatchObject({
      fanProfile: { version: 1, ageDays: 0, truncated: false },
    });

    // The dossier audit rides params.contextManifest on the clientContext
    // path too (it has no transcript manifest of its own).
    const { rows } = await testDb.pool.query(
      `select params from ai_generation_content order by id desc limit 1`,
    );
    expect(rows[0]?.params?.contextManifest?.fanProfile).toMatchObject({
      version: 1,
      truncated: false,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("fan context platform scoping (review R3-2)", () => {
  it("fan name/bio lookups are platform-scoped (native ids can collide across platforms)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, display_name, metadata)
       values ('onlyfans', '999000111', 'OF Fan', '{"about":"onlyfans bio"}'),
              ('fansly',   '999000111', 'Fansly Fan', '{"about":"fansly bio"}')`,
    );
    await expect(
      loadFanDisplayName(appContext, { pageId: 0, fanRef: "999000111", platform: "fansly" }),
    ).resolves.toBe("Fansly Fan");
    await expect(
      loadFanBio(appContext, { fanRef: "999000111", platform: "onlyfans" }),
    ).resolves.toBe("onlyfans bio");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("prompt migration manifest (Stage 30)", () => {
  const root = join(__dirname, "..", "apps", "runtime", "src", "modules", "ai", "prompts");
  const manifest = JSON.parse(readFileSync(join(root, "prompt-manifest.json"), "utf8")) as {
    files: Record<string, { coreSha256: string; byteIdenticalToSource: boolean; note?: string }>;
  };

  it("every migrated file matches its recorded hash (drift pin)", () => {
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const digest = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
      expect(digest, rel).toBe(entry.coreSha256);
    }
  });

  it("prompt templates match the frozen sources or carry a documented post-freeze note", () => {
    const templates = Object.entries(manifest.files).filter(([rel]) => rel.startsWith("templates/"));
    expect(templates.length).toBeGreaterThanOrEqual(7);
    for (const [rel, entry] of templates) {
      // Stage 30 froze templates byte-identical to the desktop snapshot. The
      // desktop twin is deleted (kernel files are the living copy), so
      // post-freeze evolution is allowed — but ONLY with a note naming the
      // decision that changed the template (first use: #127, ping fanSilenceDays).
      if (!entry.byteIdenticalToSource) {
        expect(
          entry.note,
          `${rel}: template diverged from the frozen source without a documenting note`,
        ).toBeTruthy();
      }
    }
    // And no template exists outside the manifest.
    for (const file of readdirSync(join(root, "templates"))) {
      expect(manifest.files[`templates/${file}`], file).toBeDefined();
    }
  });
});

describe("recap-status read (Task 9)", () => {
  // Metadata-only read (spec §3): surfaces the freshest usable full + short
  // recap for one conversation — no generation, no AI spend. Rows are seeded as
  // the fan-summary gateway writes them (featureParams spread at the top level
  // of `params`), under the canonical conversationRef the reader searches first.
  const fanslyPageLabel = "svc-fs";
  const conversationRef = "group-777";
  const fanRef = "fan-42";

  async function svcFsPageId(): Promise<number> {
    const { rows } = await testDb!.pool.query<{ id: string }>(
      `select id::text as id from pages where label = 'svc-fs'`,
    );
    return Number(rows[0]!.id);
  }

  async function seedRecap(input: {
    pageId: number;
    mode: "full" | "short";
    completion: string;
    createdAt: Date;
    params?: Record<string, unknown>;
  }): Promise<void> {
    const generationRef = randomUUID();
    await insertAiGenerationContent(testDb!.db, {
      usageEventId: null,
      generationRef,
      feature: "fan-summary",
      model: "m",
      provider: "anthropic",
      userId: null,
      pageId: input.pageId,
      conversationRef,
      promptBlocks: [],
      completion: input.completion,
      params: {
        summaryMode: input.mode,
        outcome: "completed",
        stopReason: "end_turn",
        ...input.params,
      },
    });
    // insertAiGenerationContent has no createdAt input; set it directly so the
    // ageMs the endpoint reports is deterministic and non-zero.
    await testDb!.pool.query(
      `update ai_generation_content set created_at = $1 where generation_ref = $2`,
      [input.createdAt.toISOString(), generationRef],
    );
  }

  it("returns both slots with metadata and creates no generation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    const before = await testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from ai_generation_content",
    );
    await seedRecap({
      pageId,
      mode: "full",
      completion: "FULL_BODY",
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      params: { transcriptCoverage: "full-history", requestedCount: 200, keptCount: 180 },
    });
    await seedRecap({
      pageId,
      mode: "short",
      completion: "SHORT_BODY",
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      params: { transcriptCoverage: "window", requestedCount: 40, keptCount: 35 },
    });

    const res = await apiServer!.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=${fanslyPageLabel}&conversationRef=${conversationRef}&fanRef=${fanRef}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.full?.generatedAt).toBeTruthy();
    expect(typeof body.full?.ageMs).toBe("number");
    expect(body.full.ageMs).toBeGreaterThan(0);
    expect(body.full.transcriptCoverage).toBe("full-history");
    expect(body.full.requestedCount).toBe(200);
    expect(body.full.keptCount).toBe(180);
    expect(body.short).toBeDefined();
    expect(body.short.transcriptCoverage).toBe("window");
    expect(body.short.requestedCount).toBe(40);
    expect(body.short.keptCount).toBe(35);

    // §3 invariant: a metadata read spends nothing — no new generation row.
    const after = await testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from ai_generation_content",
    );
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count) + 2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("returns null slots (not an error) when no usable recap exists", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=${fanslyPageLabel}&conversationRef=no-such-convo`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ full: null, short: null });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("404s an unknown page label", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ai/recap-status?pageLabel=nope&conversationRef=g",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode).toBe(404);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("404s a page the chatter cannot access (indistinguishable from unknown)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const otherModel = await createModel(appContext.db, { slug: "other-svc", name: "Other Svc" });
    const otherPage = await createFanslyPage(appContext.db, {
      modelId: otherModel!.id,
      label: "other-fs",
    });
    expect(otherPage).not.toBeNull();
    const res = await apiServer!.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=other-fs&conversationRef=${conversationRef}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode).toBe(404);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects an anonymous caller", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const res = await apiServer!.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=${fanslyPageLabel}&conversationRef=${conversationRef}`,
    });
    expect(res.statusCode).toBe(401);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
