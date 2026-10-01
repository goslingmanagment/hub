import { fixtureUserId } from "./helpers/user-identity.ts";
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
  upsertVoiceProfile,
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
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
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
const COACH_SITUATION_PRESET_QUESTION =
  "Разбери текущую ситуацию в переписке: что происходит у фана, что я упускаю и какой следующий ход. Дай два готовых варианта следующего сообщения: первый спокойный и тёплый, второй более флиртовый и эскалирующий.";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let pageId = 0;
let fanslyPageId = 0;

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
  fanslyPageId = fanslyPage.id;
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
  chatterKey = (await issueChatterDeviceToken(appContext, {
    username: "svc-chatter",
    pageLabel: "svc-of",
  }, { source: "cli" })).key;
  await assignPageToUser(appContext, { userId: await fixtureUserId(appContext, "svc-chatter"), pageLabel: "svc-fs" }, { source: "cli" });

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

async function defaultPersonaDefinitionId(): Promise<string> {
  const personaKey = createBundledPersonalities()[0]!.id;
  const catalog = await apiServer!.inject({
    method: "GET",
    url: "/api/v1/ai/persona-catalog",
    headers: { authorization: `Bearer ${chatterKey}` },
  });
  if (catalog.statusCode !== 200) {
    throw new Error(`persona catalog lookup failed: ${catalog.statusCode} ${catalog.body}`);
  }
  const definitionId = catalog.json().personas.find(
    (persona: { key: string }) => persona.key === personaKey,
  )?.definitionId;
  if (typeof definitionId !== "string") {
    throw new Error(`default persona ${personaKey} missing from catalog`);
  }
  return definitionId;
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

// Streams more visible output than the 64k coach transport ceiling. The pump
// must abort mid-stream: error frame, NO done frame, failed terminal outcome —
// the usage and done frames below are never reached.
function overCeilingProvider(capture: { calls?: number }): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      capture.calls = (capture.calls ?? 0) + 1;
      yield { type: "content_delta", text: "OVERSTART" + "x".repeat(40_000) };
      yield { type: "content_delta", text: "y".repeat(40_000) };
      yield {
        type: "usage",
        providerResponseId: "msg_over",
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

// Streams content + usage, then a SYNTHETIC done with stopReason=null — exactly
// what the Anthropic provider yields on a clean iterator EOF that never saw a
// terminal message_delta. The pump must fail closed: an error frame, NO done
// frame, failed terminal outcome (P1-2).
function prematureEofProvider(capture: { calls?: number }): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      capture.calls = (capture.calls ?? 0) + 1;
      yield { type: "content_delta", text: "partial coach answer" };
      yield {
        type: "usage",
        providerResponseId: "msg_eof",
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
      yield { type: "done", stopReason: null };
    },
  };
}

function whitespaceOnlyProvider(capture: { calls?: number }): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      capture.calls = (capture.calls ?? 0) + 1;
      yield { type: "content_delta", text: " \t\n " };
      yield {
        type: "usage",
        providerResponseId: "msg_empty",
        cacheHit: false,
        usage: {
          inputTokens: 50,
          outputTokens: 1,
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
    // Reply features default to Sonnet 5 at low effort (owner, 2026-09-30).
    expect(body.model).toBe("anthropic:claude-sonnet-5");
    expect(body.reasoningEffort).toBe("low");
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
    expect(aiFrames(response.body)[0]).not.toHaveProperty("attachedRecaps");

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

    // Decision #295: OnlyFans manual ping accepts an ACTIVE conversation,
    // keeping the kernel-derived segment truthful. Pin recency explicitly
    // because the seed's fixed timestamps age out of the active window.
    await testDb.pool.query(
      `update message_archive set occurred_at = now()
       where account_id = $1 and is_sent_by_me = false`,
      [pageId],
    );
    const pingActive = await call("ping");
    expect(pingActive.statusCode, pingActive.body).toBe(200);
    expect(capture.input!.body.feature).toBe("ping");
    const activePingText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(activePingText).toContain("Active conversation: the fan wrote recently.");
    expect(activePingText).toContain("Fan silence: the fan's last message was 0 days ago.");
    expect(activePingText).toContain("The chatter chose to reach out now.");
    expect(activePingText).not.toContain("Segment A");
    expect(activePingText).not.toContain("to send to a fan who has gone quiet");
    expect(activePingText).not.toContain("The fan has not said anything recently");
    expect(activePingText).not.toContain("This segment should not be used for ping generation");

    // Older conversations still accept ping. The extra
    // hour keeps the whole-days floor at 10 under small DB/Node clock drift.
    await testDb.pool.query(
      `update message_archive set occurred_at = now() - interval '10 days 1 hour'
       where account_id = $1 and is_sent_by_me = false`,
      [pageId],
    );
    const ping = await call("ping");
    expect(ping.statusCode, ping.body).toBe(200);
    expect(capture.input!.body.feature).toBe("ping");
    // Decision #127: the silence line comes from the SAME analysis call that
    // selected the segment on the kernel-owned OnlyFans context path.
    const pingText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(pingText).toContain("Fan silence: the fan's last message was 10 days ago");
    // Restore recency for the later hi-greeting assertions.
    await testDb.pool.query(
      `update message_archive set occurred_at = now()
       where account_id = $1 and is_sent_by_me = false`,
      [pageId],
    );

    // help-me (analysis preamble) streams.
    const helpMe = await call("help-me");
    expect(helpMe.statusCode, helpMe.body).toBe(200);
    expect(capture.input!.body).toMatchObject({
      feature: "help-me",
      model: "anthropic:claude-sonnet-5",
      reasoningEffort: "low",
    });

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

describe("voice-script feature (voice notes lane)", () => {
  const voiceCall = (extra: Record<string, unknown> = {}) =>
    apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/voice-script",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-fs",
        platform: "fansly",
        conversationRef: FAN,
        fanRef: FAN,
        clientContext: {
          transcript: "Fan: hey babe\nCreator: hey you",
          messageCount: 2,
          fanDisplayName: "Fan",
          fanSpendingData: "",
          fanSubscriptionData: "",
        },
        ...extra,
      },
    });

  async function enableVoiceLane(opts?: { provider?: boolean; profile?: boolean }) {
    appContext.config.voiceNotesEnabled = true;
    appContext.config.voiceNotesPageAllowlist = "svc-fs";
    if (opts?.provider !== false) {
      appContext.voiceTtsProvider = {
        async synthesize() {
          throw new Error("voice-script gate must not invoke TTS");
        },
      };
    }
    if (opts?.profile !== false) {
      await upsertVoiceProfile(appContext.db, {
        platformAccountId: fanslyPageId,
        voiceId: "voice-feature-test",
        model: "eleven_v3",
        settings: {},
        outputFormat: "mp3_44100_128",
      });
    }
  }

  it("gates on the draft, then adapts it into a spoken script over the stream", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    // Decision #174: voice-script rides the voice-notes lane — enable the live
    // flag and allowlist this page so the paid generation is admitted.
    await enableVoiceLane();
    const capture: { input?: AiGatewayProviderInput; calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);

    // requiresDraft: no draft is a product gate, not a stream (fires before the
    // voice-lane gate).
    const noDraft = await voiceCall();
    expect(noDraft.statusCode, noDraft.body).toBe(400);
    expect(noDraft.json().error).toBe("gate_draft_required");
    expect(capture.calls).toBeUndefined();

    // With a draft it streams the script through the gateway.
    const scripted = await voiceCall({ draftText: "omg u looked so good today 😍 ily" });
    expect(scripted.statusCode, scripted.body).toBe(200);
    expect(scripted.body).toContain("sure thing");
    expect(capture.input!.body.feature).toBe("voice-script");
    // Delegates model + reasoning selection to fast-reply (Sonnet 5, low).
    expect(capture.input!.body.model).toBe("anthropic:claude-sonnet-5");
    const userText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(userText).toContain("## Current Draft");
    expect(userText).toContain("omg u looked so good today");
    expect(userText).toContain("AT MOST 1-2 audio tags");
    // includesEarnings: false — no spend/subscription blocks in a voice script.
    expect(userText).not.toContain("<fan_spending_data>");
    expect(userText).not.toContain("<fan_subscription_data>");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses unsupported or ambiguous voice identity before gateway spend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    await enableVoiceLane();

    const onlyFans = await voiceCall({
      pageLabel: "svc-of",
      platform: "onlyfans",
      clientContext: undefined,
      draftText: "hi",
    });
    expect(onlyFans.statusCode, onlyFans.body).toBe(400);
    expect(onlyFans.json().error).toBe("gate_voice_unsupported_platform");

    const missingFan = await voiceCall({ fanRef: undefined, draftText: "hi" });
    expect(missingFan.statusCode, missingFan.body).toBe(400);
    expect(missingFan.json().error).toBe("gate_voice_identity_required");

    const mismatchedFan = await voiceCall({ fanRef: "different-fan", draftText: "hi" });
    expect(mismatchedFan.statusCode, mismatchedFan.body).toBe(400);
    expect(mismatchedFan.json().error).toBe("gate_voice_identity_required");
    expect(capture.calls).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses before gateway spend when TTS provider or page profile is unavailable", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);

    await enableVoiceLane({ profile: false });
    const noProfile = await voiceCall({ draftText: "hi" });
    expect(noProfile.statusCode, noProfile.body).toBe(400);
    expect(noProfile.json().error).toBe("gate_voice_no_profile");

    await upsertVoiceProfile(appContext.db, {
      platformAccountId: fanslyPageId,
      voiceId: "voice-feature-test",
      model: "eleven_v3",
      settings: {},
      outputFormat: "mp3_44100_128",
    });
    appContext.voiceTtsProvider = undefined;
    const noProvider = await voiceCall({ draftText: "hi" });
    expect(noProvider.statusCode, noProvider.body).toBe(400);
    expect(noProvider.json().error).toBe("gate_voice_provider_unavailable");
    expect(capture.calls).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses (no gateway spend) when the voice-notes lane is disabled — Decision #174 inertness", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const capture: { input?: AiGatewayProviderInput; calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    // Default-off: no flag set. A draft is present so the request clears the
    // draft gate and reaches the voice-lane admission check.
    const disabled = await voiceCall({ draftText: "hi" });
    expect(disabled.statusCode, disabled.body).toBe(400);
    expect(disabled.json().error).toBe("gate_voice_disabled");
    expect(capture.calls).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses when the page is enabled but not on the voice allowlist (fails closed)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const capture: { input?: AiGatewayProviderInput; calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    appContext.config.voiceNotesEnabled = true;
    appContext.config.voiceNotesPageAllowlist = "some-other-page";
    const notListed = await voiceCall({ draftText: "hi" });
    expect(notListed.statusCode, notListed.body).toBe(400);
    expect(notListed.json().error).toBe("gate_voice_disabled");
    expect(capture.calls).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("OnlyFans new-follower generation", () => {
  it("uses the server transcript and profile with one draft, preserving all identity gates", async (context) => {
    if (!testDb) { context.skip(); return; }
    await seedConversation();
    await testDb.pool.query(`update fans set metadata = '{"about":"I love hiking"}' where platform='onlyfans' and platform_user_id=$1`, [FAN]);
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, is_sent_by_me, occurred_at, text_plain)
       select $1, 'onlyfans', $2, ('8000'::int + n)::text, $2, false, now() - interval '1 hour', 'earlier automatic context'
       from generate_series(1, 12) n`, [pageId, FAN],
    );
    const capture: { input?: AiGatewayProviderInput; calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const definitionId = await defaultPersonaDefinitionId();
    const body = { clientRequestId: randomUUID(), pageLabel: "svc-of", platform: "onlyfans", conversationRef: FAN, fanRef: FAN, greetingMode: "new-follower", expectedPersonaDefinitionId: definitionId };
    const call = (extra: Record<string, unknown> = {}, feature = "hi-greeting") => apiServer!.inject({
      method: "POST", url: `/api/v1/ai/features/${feature}`, headers: { authorization: `Bearer ${chatterKey}` },
      payload: { ...body, clientRequestId: randomUUID(), ...extra },
    });
    const response = await call();
    expect(response.statusCode, response.body).toBe(200);
    const prompt = capture.input!.body.prompt.userBlocks.map(block => block.text).join("\n");
    expect(prompt).toContain("exactly ONE");
    expect(prompt).toContain("Big Spender");
    expect(prompt).toContain("I love hiking");
    expect(prompt).toContain("hey babe");
    expect(capture.calls).toBe(1);
    // Decision 379: an explicit variantCount wins over the alias for the count
    // while the alias still skips the gate (15 archived messages here).
    const aliasThree = await call({ variantCount: 3 });
    expect(aliasThree.statusCode, aliasThree.body).toBe(200);
    expect(capture.input!.body.prompt.userBlocks.map(block => block.text).join("\n")).toContain("Write exactly 3 different greeting variants");
    expect(capture.calls).toBe(2);
    // Without the alias the OnlyFans kernel-context lane has no automation
    // evidence, so the gate keeps counting every message, whatever the count.
    const gated = await call({ greetingMode: undefined, variantCount: 1 });
    expect(gated.statusCode, gated.body).toBe(400);
    expect(gated.json().error).toBe("gate_hi_greeting_limit");
    expect(gated.json().message).toContain("at most 10 messages");
    const rejected = [
      [{ greetingMode: undefined }, "hi-greeting", 400],
      [{ greetingMode: undefined, variantCount: 3 }, "fast-reply", 400],
      [{ fanRef: "123" }, "hi-greeting", 400],
      [{ fanRef: null }, "hi-greeting", 400],
      [{ fanRef: "name", conversationRef: "name" }, "hi-greeting", 400],
      [{ fanRef: "000777", conversationRef: "000777" }, "hi-greeting", 400],
      [{ clientContext: { transcript: "fabricated", messageCount: 0, fanDisplayName: "fake" } }, "hi-greeting", 400],
      [{ expectedPersonaDefinitionId: "wrong-definition-id" }, "hi-greeting", 409],
      [{ platform: "fansly" }, "hi-greeting", 404],
      [{ pageLabel: "missing-of" }, "hi-greeting", 404],
      [{}, "fast-reply", 400],
    ] as const;
    for (const [extra, feature, status] of rejected) {
      const denied = await call(extra, feature);
      expect(denied.statusCode, denied.body).toBe(status);
    }
    expect(capture.calls).toBe(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("client-context path (Stage 32)", () => {
  it("fences follower send custody by human authentication, assigned page and platform", async (context) => {
    if (!testDb) { context.skip(); return; }
    const payload = { fanRef: "123", attemptId: randomUUID(), action: "reserve" };
    const url = "/api/v1/pages/svc-fs/follower-outreach/attempt";
    const anonymous = await apiServer!.inject({ method: "POST", url, payload });
    expect(anonymous.statusCode).toBe(401);
    const headers = { authorization: `Bearer ${chatterKey}` };
    const claim = await apiServer!.inject({ method: "POST", url, headers, payload });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json()).toMatchObject({ owned: true, state: "reserved" });
    const wrongPlatform = await apiServer!.inject({ method: "POST", url: "/api/v1/pages/svc-of/follower-outreach/attempt", headers, payload });
    expect(wrongPlatform.statusCode).toBe(404);
    const model = await createModel(appContext.db, { slug: "unassigned", name: "Unassigned" });
    if (!model) throw new Error("model fixture missing");
    await createFanslyPage(appContext.db, { modelId: model.id, label: "unassigned-fs" });
    const forbidden = await apiServer!.inject({ method: "POST", url: "/api/v1/pages/unassigned-fs/follower-outreach/attempt", headers, payload });
    expect([403, 404]).toContain(forbidden.statusCode);
    const noReceipt = await apiServer!.inject({ method: "POST", url, headers, payload: { ...payload, action: "sent" } });
    expect(noReceipt.statusCode).toBe(400);
  });
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

    const newFollowerContext = { ...baseContext, fanBio: "loves cats", fanUsername: "catfan", fanCustomName: "Charles", fanAvatarUrl: "https://cdn3.fansly.com/avatar.jpg" };
    const newFollower = await call("hi-greeting", newFollowerContext, { greetingMode: "new-follower", fanRef: FAN });
    expect(newFollower.statusCode, newFollower.body).toBe(200);
    expect(capture.input!.body.prompt.images).toEqual([{ url: newFollowerContext.fanAvatarUrl }]);
    const newFollowerText = capture.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(newFollowerText).toContain("exactly ONE");
    expect(newFollowerText).toContain("catfan");
    expect(newFollowerText).toContain("loves cats");
    expect((await call("fast-reply", newFollowerContext, { greetingMode: "new-follower", fanRef: FAN })).statusCode).toBe(400);

    // Decision 379: the greeting parameters are orthogonal. An alias-only request
    // (released clients) renders exactly the prompt of an explicit variantCount 1.
    const aliasBlocks = capture.input!.body.prompt.userBlocks;
    const oneDraft = await call("hi-greeting", { ...newFollowerContext, messageCount: 2 }, { variantCount: 1, fanRef: FAN });
    expect(oneDraft.statusCode, oneDraft.body).toBe(200);
    expect(capture.input!.body.prompt.userBlocks).toEqual(aliasBlocks);
    expect(capture.input!.body.prompt.images).toEqual([{ url: newFollowerContext.fanAvatarUrl }]);

    // The chat Hi button: no alias, avatar + username + saved name accepted, three
    // variants, and the gate counts PERSONAL messages (35 in total, 2 personal).
    const chatHi = await call("hi-greeting", { ...newFollowerContext, personalMessageCount: 2 }, { variantCount: 3 });
    expect(chatHi.statusCode, chatHi.body).toBe(200);
    expect(capture.input!.body.prompt.images).toEqual([{ url: newFollowerContext.fanAvatarUrl }]);
    const chatHiBlocks = capture.input!.body.prompt.userBlocks;
    const chatHiText = chatHiBlocks.map((block) => block.text).join("\n");
    expect(chatHiText).toContain("Write exactly 3 different greeting variants separated by [VARIANT].");
    expect(chatHiText).not.toContain("exactly ONE");
    expect(chatHiText).toContain("Username: catfan");
    expect(chatHiText).toContain("Name the chatter saved for this fan: Charles");
    // One template: the cached static prefix is the same block for both counts.
    expect(chatHiBlocks[0]).toEqual(aliasBlocks[0]);
    expect(chatHiBlocks[0]?.cache).toBe("1h");
    // A long PERSONAL history still locks, and says which count it used.
    const personalLocked = await call("hi-greeting", { ...newFollowerContext, personalMessageCount: 11 }, { variantCount: 3 });
    expect(personalLocked.statusCode, personalLocked.body).toBe(400);
    expect(personalLocked.json().error).toBe("gate_hi_greeting_limit");
    expect(personalLocked.json().message).toContain("at most 10 personal messages");
    // No personal count (released clients): the total decides, wording unchanged.
    const totalLocked = await call("hi-greeting", newFollowerContext, { variantCount: 3 });
    expect(totalLocked.statusCode, totalLocked.body).toBe(400);
    expect(totalLocked.json().error).toBe("gate_hi_greeting_limit");
    expect(totalLocked.json().message).toContain("at most 10 messages");
    // personalMessageCount above messageCount never reaches the service.
    expect((await call("hi-greeting", { ...baseContext, messageCount: 2, personalMessageCount: 3 })).statusCode).toBe(400);
    // Every greeting parameter is refused on any other feature.
    for (const [clientContext, extra] of [
      [baseContext, { variantCount: 3 }],
      [{ ...baseContext, personalMessageCount: 1 }, {}],
      [{ ...baseContext, fanAvatarUrl: newFollowerContext.fanAvatarUrl }, {}],
      [{ ...baseContext, fanUsername: "catfan" }, {}],
    ] as const) {
      const refused = await call("fast-reply", clientContext, extra);
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error).toBe("bad_request");
    }

    // ping demands the client-computed segment, honors the active block, and
    // proceeds on a quiet segment.
    const pingNoSegment = await call("ping", baseContext);
    expect(pingNoSegment.statusCode, pingNoSegment.body).toBe(400);
    expect(pingNoSegment.json().message).toContain("pingSegment");
    const pingActive = await call("ping", { ...baseContext, pingSegment: "active" });
    expect(pingActive.statusCode, pingActive.body).toBe(400);
    expect(pingActive.json().message).toContain("active");
    expect(pingActive.json().error).toBe("gate_ping_active");
    const ping = await call("ping", { ...baseContext, pingSegment: "segment-a" });
    expect(ping.statusCode, ping.body).toBe(200);
    const pingWithoutSilence = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(pingWithoutSilence).not.toContain("Fan silence:");
    const pingWithSilence = await call("ping", {
      ...baseContext,
      pingSegment: "segment-a",
      fanSilenceDays: 45,
    });
    expect(pingWithSilence.statusCode, pingWithSilence.body).toBe(200);
    const pingSilenceText = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(pingSilenceText).toContain(
      "Fan silence: the fan's last message was 45 days ago (about 6 weeks).",
    );

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

  it("rejects a preset combined with a non-empty chatterQuestion", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { calls?: number } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({
        preset: "situation",
        chatterQuestion: "разбери ситуацию",
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toBe("coach-chat preset forbids chatterQuestion");
    expect(capture.calls).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("streams a situation preset with an absent or whitespace-only question", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    for (const questionFields of [{}, { chatterQuestion: "  \n " }]) {
      const capture: { input?: AiGatewayProviderInput } = {};
      appContext.aiGatewayProvider = capturingProvider(capture);
      const res = await apiServer!.inject({
        method: "POST",
        url: "/api/v1/ai/features/coach-chat",
        headers: { authorization: `Bearer ${chatterKey}` },
        payload: coachPayload({
          preset: "situation",
          coachHistory: [{ question: "а до этого?", answer: "старый разбор" }],
          ...questionFields,
        }),
      });
      expect(res.statusCode, res.body).toBe(200);
      const prompt = capture.input!.body.prompt.userBlocks
        .map((block) => block.text)
        .join("\n");
      expect(prompt).toContain(COACH_SITUATION_PRESET_QUESTION);
      expect(prompt).toContain("## Preset Turn");
      expect(prompt).toContain("старый разбор");
      const frames = aiFrames(res.body);
      const meta = frames.find((frame) => frame.type === "meta");
      expect(meta).toMatchObject({
        type: "meta",
        presetQuestion: COACH_SITUATION_PRESET_QUESTION,
      });
      expect(aiFeatureStreamFrameSchema.safeParse(meta).success).toBe(true);
      expect(frames.at(-1)?.type).toBe("done");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("requires fanRef for coach-chat on fansly (Blocker 2)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // chatterQuestion is present so the fanRef gate is the tripwire, not the
    // question gate. Canonical Fansly conversationRef is the groupId, so without
    // fanRef the stored record's fan_ref would be a non-fan id and the row would
    // survive fan-scope erasure.
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ chatterQuestion: "как продать ppv?", fanRef: undefined }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/fanRef/);
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

    const presetRes = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ preset: "situation" }),
    });
    expect(presetRes.statusCode, presetRes.body).toBe(400);
    expect(presetRes.json().message).toBe("fast-reply does not accept coach fields");
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

  it("accepts a large-answer history and replays only its projected head+tail", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Option "c": the 120k aggregate gate is GONE. A ~30k answer (well within
    // the 64k transport ceiling) is accepted, and core projects it to a ≤10k
    // head+tail before assembly — the mid-string sentinel never reaches the
    // prompt, but the head and tail (and the omission marker) do.
    const answer =
      "HEADSENTINEL"
      + "h".repeat(6_500)
      + "MIDSENTINEL"
      + "m".repeat(20_000)
      + "t".repeat(4_000)
      + "TAILSENTINEL";
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({
        chatterQuestion: "и что дальше?",
        coachHistory: [{ question: "старый вопрос", answer }],
      }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const prompt = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(prompt).toContain("HEADSENTINEL");
    expect(prompt).toContain("TAILSENTINEL");
    expect(prompt).toContain("chars omitted");
    expect(prompt).not.toContain("MIDSENTINEL");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("accepts a 20-entry maximal history and sheds deterministically, never rejects", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // 20 entries × a 60k answer ≈ 1.2MB body — over Fastify's 1MB default, so
    // this also proves the scoped route bodyLimit. Every entry is schema-valid
    // (≤64k) and the request is ACCEPTED (never a 400/413): projection + the
    // 60k newest-first budget do the bounding.
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({
        chatterQuestion: "финальный вопрос",
        coachHistory: Array.from({ length: 20 }, (_, i) => ({
          question: `вопрос ${i}`,
          answer: `ANSWER${i} ` + "a".repeat(60_000),
        })),
      }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const prompt = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    // The newest entry survives; the oldest is shed under the 60k budget.
    expect(prompt).toContain("ANSWER19");
    expect(prompt).not.toContain("ANSWER0 ");
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
        draftText: "черновик <wip> & не отправлен",
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
    const meta = frames.find((frame) => frame.type === "meta");
    expect(meta?.feature).toBe("coach-chat");
    expect(meta).not.toHaveProperty("presetQuestion");
    expect(capture.input!.body).toMatchObject({
      feature: "coach-chat",
      model: "anthropic:claude-sonnet-5",
      reasoningEffort: "low",
    });
    expect(aiFeatureStreamFrameSchema.safeParse(meta).success).toBe(true);
    expect(frames.at(-1)?.type).toBe("done");
    // The capturing provider saw the assembled prompt with the question and the
    // coverage note (the extension's coach question rode client-side context).
    const prompt = JSON.stringify(capture.input);
    expect(prompt).toContain("как продать ppv?");
    expect(prompt).toContain("нащупай боль");
    expect(prompt).toContain("most recent window only");
    expect(prompt).not.toContain("## Preset Turn");
    // Decision #179 end-to-end pin: body.draftText survives the SERVICE layer
    // (features/index.ts forwards it unguarded — buildPrompt-level tests would
    // stay green if that line ever got feature-gated away) and lands escaped
    // inside the builder's wrapper.
    expect(prompt).toContain("<chatter_draft>");
    expect(prompt).toContain("черновик &lt;wip&gt; &amp; не отправлен");
    // …and the restricted-store audit row records the draft as INCLUDED with
    // its supplied size (review round 4 — mirrors the recapAttach pin).
    const { rows: draftRows } = await testDb.pool.query<{
      params: { contextManifest?: { chatterDraft?: { chars: number; included: boolean } } };
    }>(
      `select params from ai_generation_content
       where feature = 'coach-chat' order by id desc limit 1`,
    );
    expect(draftRows[0]?.params.contextManifest?.chatterDraft).toEqual({
      chars: "черновик <wip> & не отправлен".length,
      included: true,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("aborts a coach stream that crosses the transport ceiling: error, no done, failed outcome", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { calls?: number } = {};
    appContext.aiGatewayProvider = overCeilingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ chatterQuestion: "напиши мне роман" }),
    });
    expect(res.statusCode, res.body).toBe(200); // the SSE stream itself opened 200
    const frames = aiFrames(res.body);
    // The ceiling error is emitted, and the stream ends WITHOUT a done frame so
    // no client can treat the over-ceiling answer as a committed result.
    expect(
      frames.some(
        (frame) => frame.type === "error" && frame.code === "coach_output_too_long",
      ),
    ).toBe(true);
    expect(frames.some((frame) => frame.type === "done")).toBe(false);

    // The attempt is terminal-recorded as FAILED (never completed): it can never
    // be attached/committed as a usable coach answer.
    const { rows } = await testDb.pool.query<{ gateway_outcome: string; cost_micro_usd: string }>(
      `select u.gateway_outcome, u.cost_micro_usd::text as cost_micro_usd
       from ai_generation_content g join ai_usage_events u on u.id = g.usage_event_id
       order by g.id desc limit 1`,
    );
    expect(rows[0]!.gateway_outcome).toBe("failed");
    // Blocker 1 (P1-1/P2-6): the ceiling aborts BEFORE the provider's usage
    // frame (which the fake places after the crossing), so real token counts
    // never arrive — but the request spent provider budget. The terminal record
    // must fall back to the cost estimator, NOT record zero, or the spend
    // escapes both the per-user daily $ cap and the per-feature global ceiling.
    expect(Number(rows[0]!.cost_micro_usd)).toBeGreaterThan(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fails a coach stream that reaches EOF without a terminal stopReason (P1-2)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { calls?: number } = {};
    appContext.aiGatewayProvider = prematureEofProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ chatterQuestion: "и что дальше?" }),
    });
    expect(res.statusCode, res.body).toBe(200); // the SSE stream itself opened 200
    const frames = aiFrames(res.body);
    // The incomplete-stream error is emitted, and the stream ends WITHOUT a done
    // frame so no client can treat the truncated coach answer as committed.
    expect(
      frames.some(
        (frame) => frame.type === "error" && frame.code === "provider_stream_incomplete",
      ),
    ).toBe(true);
    expect(frames.some((frame) => frame.type === "done")).toBe(false);

    // The attempt is terminal-recorded as FAILED (never completed).
    const { rows } = await testDb.pool.query<{ gateway_outcome: string }>(
      `select u.gateway_outcome
       from ai_generation_content g join ai_usage_events u on u.id = g.usage_event_id
       order by g.id desc limit 1`,
    );
    expect(rows[0]!.gateway_outcome).toBe("failed");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fails whitespace-only output before it can be recorded as completed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { calls?: number } = {};
    appContext.aiGatewayProvider = whitespaceOnlyProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ chatterQuestion: "что ответить?" }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const frames = aiFrames(res.body);
    expect(frames).toContainEqual({
      type: "error",
      code: "provider_output_empty",
      message: expect.any(String),
      retryAfterMs: null,
    });
    expect(frames.some((frame) => frame.type === "done")).toBe(false);

    // Restricted capture still records the failed attempt as an audit fact,
    // but it can no longer become a completed/attachable recap row.
    const { rows } = await testDb.pool.query<{ outcome: string | null; completion: string }>(
      `select params ->> 'outcome' as outcome, completion
       from ai_generation_content order by id desc limit 1`,
    );
    expect(rows[0]).toEqual({ outcome: "failed", completion: " \t\n " });
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
    // P1-1: a short fansly recap now REQUIRES fanRef, so supply it here.
    const { res, capture } = await postFanSummary({ summaryMode: "short", fanRef: "fan-42" });
    expect(res.statusCode, res.body).toBe(200);
    // The 2048 cap reaches the provider on the gateway body (honored by both
    // providers as input.maxTokens ?? tuning.maxTokens).
    expect(capture.input!.body.maxTokens).toBe(2048);
    // ...and adaptive summarized thinking is disabled so 2048 is a PURE output
    // budget (the default fan-summary model is adaptive; Anthropic counts
    // thinking inside max_tokens). The provider input carries the off-switch;
    // that it drops the `thinking` block is proven in ai-gateway-anthropic.test.
    expect(capture.input!.disableAdaptiveThinking).toBe(true);
    const promptText = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(promptText).toContain("COMPACT RECAP");
    expect(promptText).toContain("fresh beach message");
    const { rows } = await testDb.pool.query<{ params: Record<string, unknown> }>(
      `select params from ai_generation_content
       where feature = 'fan-summary' order by id desc limit 1`,
    );
    expect(rows[0]?.params["personaDefinitionId"]).toBe(
      await defaultPersonaDefinitionId(),
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves maxTokens unset and keeps adaptive thinking without summaryMode", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { res, capture } = await postFanSummary();
    expect(res.statusCode, res.body).toBe(200);
    expect(capture.input!.body.maxTokens).toBeUndefined();
    // The full summary keeps the provider's adaptive tuning (no off-switch).
    expect(capture.input!.disableAdaptiveThinking).toBeUndefined();
    const promptText = capture.input!.body.prompt.userBlocks
      .map((block) => block.text)
      .join("\n");
    expect(promptText).not.toContain("COMPACT RECAP");
    expect(promptText).toContain("detailed fan profile review");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects a short clientContext window over 300, accepts exactly 300 (Blocker 3)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // P1-3/P2-8: the compact template promises "300 recent messages max", and
    // coach/short-recap ships ONLY on the clientContext (fansly) lane — so the
    // window is gated on the same client-asserted messageCount the minMessages
    // and hi-greeting gates already trust.
    const over = await postFanSummary({
      summaryMode: "short",
      fanRef: "fan-42",
      clientContext: { ...shortContext, messageCount: 301 },
    });
    expect(over.res.statusCode, over.res.body).toBe(400);
    expect(over.res.json().message).toMatch(/300/);

    const exact = await postFanSummary({
      summaryMode: "short",
      fanRef: "fan-42",
      clientContext: { ...shortContext, messageCount: 300 },
    });
    expect(exact.res.statusCode, exact.res.body).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("requires fanRef for a short fan-summary on fansly (P1-1)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // P1-1 broadens the coach-chat fanRef gate: on Fansly the conversationRef is
    // the canonical groupId, so a short recap keyed only by conversation_ref
    // would survive fan-scope erasure. A short recap WITHOUT fanRef is rejected.
    const { res } = await postFanSummary({ summaryMode: "short" }); // no fanRef
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/fanRef/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("persists fan_ref from the EXPLICIT fanRef on a short fansly recap (P1-1 writer path)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The writer path the report demanded: conversationRef is a canonical groupId
    // (≠ the fan), and the required fanRef carries the fan identity, so the stored
    // fan_ref is the REAL fan id — not the groupId. Combined with the erasure
    // repository test (a groupId + fan_ref row is deleted via fan_ref), a short
    // recap generated this way is reachable by that fan's erasure.
    const { res } = await postFanSummary({
      summaryMode: "short",
      conversationRef: "group-777",
      fanRef: "fan-42",
    });
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await testDb.pool.query<{
      conversation_ref: string | null;
      fan_ref: string | null;
    }>(
      `select conversation_ref, fan_ref from ai_generation_content
       where feature = 'fan-summary' order by id desc limit 1`,
    );
    expect(rows[0]?.conversation_ref).toBe("group-777");
    expect(rows[0]?.fan_ref).toBe("fan-42");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("persists a NULL fan_ref when a fansly request omits fanRef; erasure still reaches it via conversation_ref (P1-3)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Round-4 P1-3 reverses the old fallback: a legacy fansly request carrying
    // only conversationRef (= the fanAccountId) persists fan_ref = NULL, not the
    // conversationRef. The fallback added nothing — the erasure predicate's
    // conversation_ref arm already reaches such a row — while poisoning canonical
    // rows with a groupId in fan_ref. The erasure-repository test proves this
    // exact legacy shape (conversation_ref = fanId, fan_ref = NULL) is still
    // deleted via conversation_ref.
    const { res } = await postFanSummary(); // conversationRef = FAN, no fanRef
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await testDb.pool.query<{
      conversation_ref: string | null;
      fan_ref: string | null;
    }>(
      `select conversation_ref, fan_ref from ai_generation_content
       where feature = 'fan-summary' order by id desc limit 1`,
    );
    expect(rows[0]?.conversation_ref).toBe(FAN);
    expect(rows[0]?.fan_ref).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("fan-summary short variant input window (Blocker 4)", () => {
  // The compact template promises "300 recent messages max"; the ARCHIVE lane
  // (OnlyFans — no clientContext) must clamp the transcript loader to 300 under
  // short mode instead of the deep default (1500) or a caller-supplied count.
  // The loader's actual pull is observable as contextManifest.archiveCount,
  // which the gateway persists on the restricted generation row.
  async function runArchiveFanSummary(over: Record<string, unknown> = {}) {
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fan-summary",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        ...over,
      },
    });
    return { res };
  }

  async function lastFanSummaryArchiveCount(): Promise<number> {
    const { rows } = await testDb!.pool.query<{ params: Record<string, unknown> }>(
      `select params from ai_generation_content where feature = 'fan-summary'
       order by id desc limit 1`,
    );
    const manifest = (
      rows[0]?.params as { contextManifest?: { archiveCount?: number } } | undefined
    )?.contextManifest;
    return manifest?.archiveCount ?? -1;
  }

  it("clamps the archive loader to 300 under short mode; full mode stays deep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation(); // fan + page_fans + 3 archive rows
    // Push the fan's thread well past 300 so the clamp is observable. The AI
    // shaper drops rows with a non-numeric message_ref, so keep refs numeric.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain)
       select $1, 'onlyfans', $2, (1000000 + g)::text, $2, false,
              now() - (g || ' minutes')::interval, 'archived message ' || g
       from generate_series(1, 320) g`,
      [pageId, FAN],
    );

    // Short mode with no explicit count: clamped to exactly 300.
    const short = await runArchiveFanSummary({ summaryMode: "short" });
    expect(short.res.statusCode, short.res.body).toBe(200);
    expect(await lastFanSummaryArchiveCount()).toBe(300);

    // A smaller caller-supplied count wins (the clamp is Math.min, not a floor).
    const shortSmaller = await runArchiveFanSummary({ summaryMode: "short", messageCount: 50 });
    expect(shortSmaller.res.statusCode, shortSmaller.res.body).toBe(200);
    expect(await lastFanSummaryArchiveCount()).toBe(50);

    // Full mode is untouched: it keeps the deep default and pulls the whole
    // thread (>300), proving the clamp is short-specific.
    const full = await runArchiveFanSummary();
    expect(full.res.statusCode, full.res.body).toBe(200);
    expect(await lastFanSummaryArchiveCount()).toBeGreaterThan(300);
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
    personaDefinitionId?: string | null;
  }): Promise<void> {
    const generationRef = randomUUID();
    const personaDefinitionId = input.personaDefinitionId === undefined
      ? await defaultPersonaDefinitionId()
      : input.personaDefinitionId;
    await insertAiGenerationContent(testDb!.db, {
      usageEventId: null,
      generationRef,
      feature: "fan-summary",
      model: "m",
      provider: "anthropic",
      userId: null,
      pageId: input.pageId,
      conversationRef,
      fanRef,
      promptBlocks: [],
      completion: input.completion,
      params: {
        summaryMode: input.mode,
        ...(personaDefinitionId ? { personaDefinitionId } : {}),
        outcome: "completed",
        stopReason: "end_turn",
      },
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
    return { res, promptText: JSON.stringify(capture.input), frames: aiFrames(res.body) };
  }

  it("(a) only a full recap exists -> full attached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    const fullCreatedAt = daysAgo(2);
    await seedRecap({ pageId, mode: "full", completion: "FULL_ONLY_BODY", createdAt: fullCreatedAt });
    const { res, promptText, frames } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).toContain("Full recap");
    expect(promptText).toContain("FULL_ONLY_BODY");
    expect(promptText).not.toContain("Short recap");
    expect(frames[0]).toMatchObject({
      type: "meta",
      attachedRecaps: {
        full: {
          generatedAt: fullCreatedAt.toISOString(),
          ageMs: expect.any(Number),
        },
        short: null,
      },
    });
    expect(aiFeatureStreamFrameSchema.safeParse(frames[0]).success).toBe(true);
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

  it("does not attach a recap from another persona or a legacy unscoped row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    await seedRecap({
      pageId,
      mode: "full",
      completion: "OTHER_PERSONA_BODY",
      createdAt: daysAgo(2),
      personaDefinitionId: `v1:${"x".repeat(43)}`,
    });
    await seedRecap({
      pageId,
      mode: "short",
      completion: "LEGACY_UNSCOPED_BODY",
      createdAt: daysAgo(1),
      personaDefinitionId: null,
    });

    const { res, promptText, frames } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).not.toContain("OTHER_PERSONA_BODY");
    expect(promptText).not.toContain("LEGACY_UNSCOPED_BODY");
    expect(promptText).not.toContain("## Fan Recaps");
    expect(frames[0]).toMatchObject({
      type: "meta",
      attachedRecaps: { full: null, short: null },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("(c) both exist, short newer -> BOTH attached, and (f) the manifest records both ages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    const fullCreatedAt = daysAgo(5);
    const shortCreatedAt = daysAgo(1);
    await seedRecap({ pageId, mode: "full", completion: "FULLBODY_C", createdAt: fullCreatedAt });
    await seedRecap({ pageId, mode: "short", completion: "SHORTBODY_C", createdAt: shortCreatedAt });
    const { res, promptText, frames } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).toContain("Full recap");
    expect(promptText).toContain("FULLBODY_C");
    expect(promptText).toContain("Short recap");
    expect(promptText).toContain("SHORTBODY_C");
    expect(frames[0]).toMatchObject({
      type: "meta",
      attachedRecaps: {
        full: {
          generatedAt: fullCreatedAt.toISOString(),
          ageMs: expect.any(Number),
        },
        short: {
          generatedAt: shortCreatedAt.toISOString(),
          ageMs: expect.any(Number),
        },
      },
    });
    // (f) contextManifest.recapAttach is observable on the restricted-store row.
    // The canonical Fansly shape also persists a SEPARATE fan_ref alongside the
    // groupId conversation_ref (Blocker 1) so fan-scope erasure can reach it.
    const { rows } = await testDb.pool.query<{
      params: Record<string, unknown>;
      conversation_ref: string | null;
      fan_ref: string | null;
    }>(
      `select params, conversation_ref, fan_ref from ai_generation_content
       where feature = 'coach-chat' order by id desc limit 1`,
    );
    const recapAttach = (
      rows[0]?.params as {
        contextManifest?: { recapAttach?: { full: number | null; short: number | null } };
      }
    )?.contextManifest?.recapAttach;
    expect(typeof recapAttach?.full).toBe("number");
    expect(typeof recapAttach?.short).toBe("number");
    expect(rows[0]?.conversation_ref).toBe(conversationRef);
    expect(rows[0]?.fan_ref).toBe(fanRef);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports recaps as absent when the whole-prompt budget sheds them", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    // Round-7 pin: an injected-then-shed dossier must report included=false.
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('fansly', $1, 'shed-fan', 'Shed Fan')
       on conflict do nothing`,
      [fanRef],
    );
    const { rows: shedFanRows } = await testDb.pool.query<{ id: string }>(
      `select id::text as id from fans where platform = 'fansly' and platform_user_id = $1`,
      [fanRef],
    );
    await testDb.pool.query(
      `insert into fan_profiles (fan_id, platform_account_id, version, body, source, source_generated_at)
       values ($1, $2, 1, 'DOSSIER_SHED_BY_PROMPT_BUDGET', 'chatmuse', now())`,
      [Number(shedFanRows[0]!.id), pageId],
    );
    // The dossier loader requires a usable full fan-summary PROOF whose
    // completion equals the profile body (round 8 — without it the dossier is
    // never injected and the included=false pin below is vacuous). Older than
    // the recap-attach candidates so it never wins the attach itself.
    await seedRecap({
      pageId,
      mode: "full",
      completion: "DOSSIER_SHED_BY_PROMPT_BUDGET",
      createdAt: daysAgo(9),
    });
    appContext.config.chatMuseAiFanProfileContextFeatures = "all";
    await seedRecap({
      pageId,
      mode: "full",
      completion: "FULL_SHED_BY_PROMPT_BUDGET",
      createdAt: daysAgo(5),
    });
    await seedRecap({
      pageId,
      mode: "short",
      completion: "SHORT_SHED_BY_PROMPT_BUDGET",
      createdAt: daysAgo(1),
    });
    const amp = "&";
    const { res, promptText, frames } = await runCoach({
      chatterQuestion: amp.repeat(2_000),
      // Worst-legal draft: shed whole at step 2b under the same pressure. The
      // audit row must record it as supplied-but-NOT-included (review round 4).
      draftText: "DRAFT_PRESSURE " + amp.repeat(19_980),
      clientContext: {
        transcript:
          "OLDEST_RECAP_PRESSURE\n"
          + amp.repeat(299_950)
          + "\nNEWEST_RECAP_PRESSURE",
        messageCount: 5_000,
        fanDisplayName: "Bob",
        fanSpendingData: amp.repeat(20_000),
        fanSubscriptionData: amp.repeat(20_000),
        fanBio: amp.repeat(5_000),
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(promptText).not.toContain("FULL_SHED_BY_PROMPT_BUDGET");
    expect(promptText).not.toContain("SHORT_SHED_BY_PROMPT_BUDGET");
    expect(promptText).toContain("NEWEST_RECAP_PRESSURE");
    expect(promptText).not.toContain("OLDEST_RECAP_PRESSURE");
    expect(frames[0]).toMatchObject({
      type: "meta",
      attachedRecaps: { full: null, short: null },
    });

    const { rows } = await testDb.pool.query<{
      params: { contextManifest?: { recapAttach?: { full: number | null; short: number | null } } };
    }>(
      `select params from ai_generation_content
       where feature = 'coach-chat' order by id desc limit 1`,
    );
    expect(rows[0]?.params.contextManifest?.recapAttach).toEqual({
      full: null,
      short: null,
    });
    expect(promptText).not.toContain("DRAFT_PRESSURE");
    expect(promptText).not.toContain("<chatter_draft>");
    expect(promptText).toContain("(the chatter attached a working draft");
    expect(
      (rows[0]?.params.contextManifest as { chatterDraft?: { chars: number; included: boolean } })
        ?.chatterDraft,
    ).toEqual({ chars: ("DRAFT_PRESSURE " + amp.repeat(19_980)).length, included: false });
    expect(promptText).not.toContain("DOSSIER_SHED_BY_PROMPT_BUDGET");
    expect(
      (rows[0]?.params.contextManifest as { fanProfile?: { included?: boolean } })?.fanProfile
        ?.included,
    ).toBe(false);
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
    const { res, promptText, frames } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    // The dossier is injected...
    expect(promptText).toContain("## Fan Dossier");
    // ...and the duplicate full recap is dropped (no recap section at all).
    expect(promptText).not.toContain("## Fan Recaps");
    expect(promptText).not.toContain("Full recap");
    expect(frames[0]).toMatchObject({
      type: "meta",
      attachedRecaps: { full: null, short: null },
    });
    // Round-6/7 pin: the kept dossier reports included=true on the audit row.
    const { rows: dossierRows } = await testDb.pool.query<{
      params: { contextManifest?: { fanProfile?: { included?: boolean } } };
    }>(
      `select params from ai_generation_content
       where feature = 'coach-chat' order by id desc limit 1`,
    );
    expect(dossierRows[0]?.params.contextManifest?.fanProfile?.included).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("(g) dedupe fires on a REAL sectioned recap even though compilation drops its financial section (P2-10)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    // A REAL fan-summary body: markdown sections including the FINANCIAL PROFILE
    // the dossier compiler ALWAYS drops. So the compiled dossier body is NOT
    // byte-identical to this raw body — the old compiled-vs-raw dedupe would miss
    // it and attach the recap twice. The fix compares raw-vs-raw.
    const sectionedBody = [
      "## 1. ДОСЬЕ",
      "- Ездит на красном Ducati, живёт в Остине",
      "",
      "## 5. ФИНАНСОВЫЙ ПРОФИЛЬ",
      "- FINSENTINEL кит, типсует каждый вечер",
      "",
      "## 6. ОТКРЫТЫЕ ПЕТЛИ",
      "- Обещала фото с пляжа",
    ].join("\n");
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('fansly', $1, 'sectioned-fan', 'Sectioned Fan')`,
      [fanRef],
    );
    const { rows: fanRows } = await testDb.pool.query<{ id: string }>(
      `select id::text as id from fans where platform = 'fansly' and platform_user_id = $1`,
      [fanRef],
    );
    await testDb.pool.query(
      `insert into fan_profiles (fan_id, platform_account_id, version, body, source, source_generated_at)
       values ($1, $2, 1, $3, 'chatmuse', now())`,
      [Number(fanRows[0]!.id), pageId, sectionedBody],
    );
    // The recap completion is the SAME raw summary the dossier was built from.
    await seedRecap({ pageId, mode: "full", completion: sectionedBody, createdAt: daysAgo(2) });
    appContext.config.chatMuseAiFanProfileContextFeatures = "all";
    const { res, promptText } = await runCoach();
    expect(res.statusCode, res.body).toBe(200);
    // The dossier is injected, keeping the non-financial section...
    expect(promptText).toContain("## Fan Dossier");
    expect(promptText).toContain("красном Ducati");
    // ...compilation dropped the financial section (its content is nowhere)...
    expect(promptText).not.toContain("FINSENTINEL");
    // ...and the raw-vs-raw dedupe fired, so the recap is NOT re-attached.
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
    proofCreatedAt?: string;
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
    const body = input.body ?? DOSSIER_BODY;
    await testDb!.pool.query(
      `insert into fan_profiles (fan_id, platform_account_id, version, body, source, created_at, source_generated_at)
       values ($1, $2, 1, $3, 'chatmuse', $4, $5)`,
      [
        fanId,
        input.targetPageId,
        body,
        input.createdAt ?? new Date().toISOString(),
        input.sourceGeneratedAt ?? null,
      ],
    );
    const proofRef = randomUUID();
    const proofIdentity = {
      onlyfans: { conversationRef: FAN, fanRef: null },
      fansly: { conversationRef: `dossier-group-${proofRef}`, fanRef: FAN },
    }[input.platform];
    await insertAiGenerationContent(testDb!.db, {
      usageEventId: null,
      generationRef: proofRef,
      feature: "fan-summary",
      model: "test-model",
      provider: "anthropic",
      userId: null,
      pageId: input.targetPageId,
      conversationRef: proofIdentity.conversationRef,
      fanRef: proofIdentity.fanRef,
      promptBlocks: [],
      completion: body,
      params: {
        summaryMode: "full",
        outcome: "completed",
        stopReason: "end_turn",
      },
    });
    if (input.proofCreatedAt) {
      await testDb!.pool.query(
        "update ai_generation_content set created_at = $1 where generation_ref = $2",
        [input.proofCreatedAt, proofRef],
      );
    }
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
    // The dossier lives in the per-fan dynamic block, not the 1h static prefix.
    const dynamicBlock = capture.input!.body.prompt.userBlocks[1];
    expect(dynamicBlock?.cache).toBe("none");
    expect(dynamicBlock?.text).toContain("## Fan Dossier");
    const staticBlock = capture.input!.body.prompt.userBlocks.find((block) => block.cache === "1h");
    expect(staticBlock?.text).not.toContain("## Fan Dossier");

    // hi-greeting is policy-excluded (a cold opener must not show familiarity).
    const hi = await call("hi-greeting");
    expect(hi.statusCode, hi.body).toBe(200);
    expect(userText(capture)).not.toContain("## Fan Dossier");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("falls back to an older proven dossier instead of injecting a newer unproven profile", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    await seedFanProfile({
      platform: "onlyfans",
      targetPageId: pageId,
      body: "PROVEN_DOSSIER_BODY",
    });
    const fan = await testDb.pool.query<{ id: string }>(
      "select id::text as id from fans where platform = 'onlyfans' and platform_user_id = $1",
      [FAN],
    );
    await testDb.pool.query(
      `insert into fan_profiles (fan_id, platform_account_id, version, body, source)
       values ($1, $2, 2, 'UNPROVEN_PRE_GUARD_BODY', 'chatmuse')`,
      [Number(fan.rows[0]!.id), pageId],
    );
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("PROVEN_DOSSIER_BODY");
    expect(text).not.toContain("UNPROVEN_PRE_GUARD_BODY");
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

  it("dates the dossier by Core's successful generation proof, not client or Hub timestamps", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    // The profile row claims today, but the matching successful full summary is
    // 60 days old. Only Core's terminal ledger is trusted for prompt age.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const proofDate = sixtyDaysAgo.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    await seedFanProfile({
      platform: "onlyfans",
      targetPageId: pageId,
      createdAt: new Date().toISOString(),
      sourceGeneratedAt: new Date().toISOString(),
      proofCreatedAt: sixtyDaysAgo.toISOString(),
    });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("красном Ducati");
    // Volatile sections stay in now; the disclaimer carries the source date.
    expect(text).toContain("Обещала фото с пляжа");
    expect(text).toContain(`generated on ${proofDate}`);
    expect(text).not.toContain(`generated on ${today}`);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not trust an old profile created_at when the successful proof is fresh", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const oldProfileDate = sixtyDaysAgo.toISOString().slice(0, 10);
    const proofDate = new Date().toISOString().slice(0, 10);
    await seedFanProfile({
      platform: "onlyfans",
      targetPageId: pageId,
      createdAt: sixtyDaysAgo.toISOString(),
      proofCreatedAt: new Date().toISOString(),
    });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("красном Ducati");
    expect(text).toContain("Обещала фото с пляжа");
    expect(text).toContain(`generated on ${proofDate}`);
    expect(text).not.toContain(`generated on ${oldProfileDate}`);
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
    personaDefinitionId?: string | null;
  }): Promise<void> {
    const generationRef = randomUUID();
    const personaDefinitionId = input.personaDefinitionId === undefined
      ? await defaultPersonaDefinitionId()
      : input.personaDefinitionId;
    await insertAiGenerationContent(testDb!.db, {
      usageEventId: null,
      generationRef,
      feature: "fan-summary",
      model: "m",
      provider: "anthropic",
      userId: null,
      pageId: input.pageId,
      conversationRef,
      fanRef,
      promptBlocks: [],
      completion: input.completion,
      params: {
        summaryMode: input.mode,
        ...(personaDefinitionId ? { personaDefinitionId } : {}),
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
      url: `/api/v1/ai/recap-status?pageLabel=${fanslyPageLabel}&conversationRef=${conversationRef}&fanRef=${fanRef}&personaDefinitionId=${encodeURIComponent(await defaultPersonaDefinitionId())}`,
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

  it("surfaces writer-populated requestedCount/keptCount through recap-status (archive lane, P2-5)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The writer→reader gap the report flagged: an archive-lane OnlyFans short
    // recap resolves a 300-message window and a real kept count, yet both used
    // to persist as null (requestedCount from body.messageCount, keptCount from
    // clientContext — neither present on the archive lane). Generate one through
    // the real endpoint, then read it back through recap-status.
    await seedConversation(); // OnlyFans page (svc-of); 3 archive rows so far
    // fan-summary needs ≥30 messages; seed enough archive rows on the OF page.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain)
       select $1, 'onlyfans', $2, (3000000 + g)::text, $2, false,
              now() - (g || ' minutes')::interval, 'archived message ' || g
       from generate_series(1, 40) g`,
      [pageId, FAN],
    );
    appContext.aiGatewayProvider = capturingProvider({});

    const gen = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fan-summary",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN, // OnlyFans: conversationRef IS the fan id
        summaryMode: "short",
      },
    });
    expect(gen.statusCode, gen.body).toBe(200);

    const res = await apiServer!.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=svc-of&conversationRef=${FAN}&personaDefinitionId=${encodeURIComponent(await defaultPersonaDefinitionId())}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.short, res.body).not.toBeNull();
    // requestedCount is the RESOLVED short window (300); keptCount is the actual
    // archive count the loader returned — both non-null (the P2-5 fix).
    expect(body.short.requestedCount).toBe(300);
    expect(typeof body.short.keptCount).toBe("number");
    expect(body.short.keptCount).toBeGreaterThan(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("filters status by persona definition and excludes legacy unscoped rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = await svcFsPageId();
    await seedRecap({
      pageId,
      mode: "full",
      completion: "OTHER_PERSONA_BODY",
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      personaDefinitionId: `v1:${"x".repeat(43)}`,
    });
    await seedRecap({
      pageId,
      mode: "short",
      completion: "LEGACY_UNSCOPED_BODY",
      createdAt: new Date(Date.now() - 60 * 1000),
      personaDefinitionId: null,
    });
    const personaDefinitionId = await defaultPersonaDefinitionId();
    const res = await apiServer!.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=${fanslyPageLabel}&conversationRef=${conversationRef}&fanRef=${fanRef}&personaDefinitionId=${encodeURIComponent(personaDefinitionId)}`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ full: null, short: null });
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

describe("Fansly live overlay in the kernel context (plan §7.11)", () => {
  // A Fansly request without clientContext reads the kernel archive. A page
  // in `fanslyLiveOverlayReadPages` reads the archive ∪ its socket messages
  // the archive does not hold yet; `none` keeps the archive only.
  const group = "880001";

  async function seedLiveChat() {
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
       values ($1, $2, $3)`,
      [fanslyPageId, group, FAN],
    );
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain)
       values ($1, 'fansly', $2, '7701', $3, false, now() - interval '10 minutes', 'archived hello')`,
      [fanslyPageId, group, FAN],
    );
    await testDb!.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id,
         sender_platform_user_id, is_sent_by_page, created_at, content, decoder_version, first_visible_at)
       values ($1, '7702', $2, $3, false, now() - interval '5 seconds', 'LIVE_SOCKET_LINE', 1, now())`,
      [fanslyPageId, group, FAN],
    );
  }

  async function runKernelFastReply() {
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    const res = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-fs",
        platform: "fansly",
        conversationRef: group,
        fanRef: FAN,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await testDb!.pool.query<{ params: { contextManifest?: Record<string, unknown> } }>(
      `select params from ai_generation_content where feature = 'fast-reply' order by id desc limit 1`,
    );
    return { promptText: JSON.stringify(capture.input), manifest: rows[0]?.params.contextManifest };
  }

  it("serves socket messages only while the page is listed", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedLiveChat();

    const off = await runKernelFastReply();
    expect(off.promptText).toContain("archived hello");
    expect(off.promptText).not.toContain("LIVE_SOCKET_LINE");
    expect(off.manifest).toMatchObject({ source: "archive", liveOverlay: "off", liveCount: null });

    appContext.config.fanslyLiveOverlayReadPages = "svc-fs";
    const served = await runKernelFastReply();
    expect(served.promptText).toContain("archived hello");
    expect(served.promptText).toContain("LIVE_SOCKET_LINE");
    expect(served.manifest).toMatchObject({ source: "live_union", liveOverlay: "serve", liveCount: 1, liveError: false });

    // The key is live: an override of `none` is the kill-switch, no restart.
    await testDb.pool.query(
      `insert into config_settings (scope_type, scope_id, key, value, version)
       values ('global', 0, 'fanslyLiveOverlayReadPages', '"none"'::jsonb, 1)`,
    );
    const killed = await runKernelFastReply();
    expect(killed.promptText).not.toContain("LIVE_SOCKET_LINE");
    expect(killed.manifest).toMatchObject({ source: "archive", liveOverlay: "off" });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
