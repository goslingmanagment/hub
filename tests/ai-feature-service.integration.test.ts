import { fixtureUserId } from "./helpers/user-identity.ts";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiFeatureStreamFrameSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAiGenerationContent,
  seedBundledAiPersona,
  setPageOfapiAccountId,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  EMPTY_TRANSCRIPT_TEXT,
  createBundledPersonalities,
  loadFanBio,
  loadFanDisplayName,
  loadTranscriptContext,
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
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
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

    // H-4a: other advertised capabilities never imply the echo, and an
    // oversized header is ignored (200, no frame), never a 400.
    for (const header of ["context-v1, split-all-v1", `debug-input-v1,${" ".repeat(256)}split-all-v1`]) {
      const otherCapabilities = await apiServer!.inject({
        method: "POST",
        url: "/api/v1/ai/features/fast-reply",
        headers: { authorization: `Bearer ${chatterKey}`, "x-kernel-ai-capabilities": header },
        payload: { ...payload, clientRequestId: randomUUID() },
      });
      expect(otherCapabilities.statusCode, otherCapabilities.body).toBe(200);
      expect(aiFrames(otherCapabilities.body).some((frame) => frame.type === "debug_input_v1")).toBe(false);
    }

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
    // Reply features share the Opus 5.5 default at high effort.
    expect(body.model).toBe("anthropic:claude-opus-5-5");
    expect(body.reasoningEffort).toBe("high");
    const lora = createBundledPersonalities()[0]!;
    expect(body.prompt.systemBlocks[1]).toMatchObject({ text: lora.content, cache: "1h" });
    const userText = body.prompt.userBlocks.map((block) => block.text).join("\n");
    expect(userText).toMatch(/\[\d{2}:\d{2}\] Fan: hey babe/);
    expect(userText).toMatch(/\[\d{2}:\d{2}\] Model: hey you/);
    expect(userText).toContain("[Tip: $5.00]");
    expect(userText).toContain("<fan_spending_data>");
    expect(userText).toContain("<fan_subscription_data>");
    expect(userText).not.toContain(EMPTY_TRANSCRIPT_TEXT);
    // The hub's own transcript: dated, UTC, and the task opens with the
    // context's pinned clock and Lora's time in Minsk.
    expect(userText).toMatch(/^--- \d{4}-\d{2}-\d{2} ---$/m);
    const task = body.prompt.userBlocks.at(-1)!.text;
    expect(task).toMatch(/^## Your Task\n\nNow: /);
    expect(task).toContain(
      "Now: Thu 2026-10-15, 04:12 UTC. Transcript times and day lines are UTC. The model's local time: Thu 07:12 (Minsk, UTC+3).\n",
    );

    // Ledger + restricted capture rode along (Stage 29 internals).
    const { rows } = await testDb.pool.query(
      `select g.feature, g.completion, u.gateway_outcome
       from ai_generation_content g join ai_usage_events u on u.id = g.usage_event_id`,
    );
    expect(rows).toEqual([
      { feature: "fast-reply", completion: "sure thing 😘", gateway_outcome: "completed" },
    ]);
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

describe("context_v1 frame (chat-extension H-4b)", () => {
  // The frame tells a client that advertised `context-v1` which transcript
  // snapshot actually served the generation. Nobody else sees it, and nothing
  // about the generation itself changes.
  const OTHER_FAN = "777000888";
  const OFAPI_ACCOUNT = "acct_svc00000000000000000000000000001";

  async function stream(input: {
    capabilities?: string;
    feature?: string;
    body?: Record<string, unknown>;
    capture?: { input?: AiGatewayProviderInput };
  } = {}) {
    appContext.aiGatewayProvider = capturingProvider(input.capture ?? {});
    const response = await apiServer!.inject({
      method: "POST",
      url: `/api/v1/ai/features/${input.feature ?? "fast-reply"}`,
      headers: {
        authorization: `Bearer ${chatterKey}`,
        ...(input.capabilities !== undefined ? { "x-kernel-ai-capabilities": input.capabilities } : {}),
      },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "svc-of",
        platform: "onlyfans",
        conversationRef: FAN,
        messageCount: 50,
        ...input.body,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const frames = aiFrames(response.body);
    return {
      raw: response.body,
      frames,
      types: frames.map((frame) => frame.type),
      context: frames.find((frame) => frame.type === "context_v1"),
    };
  }

  async function seedDmMessage(input: {
    ref: string; mine: boolean; text: string; minutesAgo: number; conversation?: string | null; deleted?: boolean;
  }) {
    const conversation = input.conversation === undefined ? FAN : input.conversation;
    await testDb!.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
         fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain,
         is_tip, tip_amount_mills, deleted_at, source, source_event_type, source_idempotency_key,
         source_journal_id, source_received_at, retain_until)
       values ('onlyfans', $1, $2, $3, $3, $4, $5, $6, $7, $8, false, 0, $9, 'webhook', $10, $11, 1, now(),
         now() + interval '100 years')`,
      [pageId, OFAPI_ACCOUNT, conversation, input.ref, input.mine ? "model" : "fan", input.mine,
        conversation === null ? null : new Date(Date.now() - input.minutesAgo * 60_000), input.text,
        input.deleted ? new Date() : null,
        input.deleted ? "messages.deleted" : input.mine ? "messages.sent" : "messages.received",
        `ctx-frame-${input.ref}`],
    );
  }

  async function seedArchiveMessage(input: {
    ref: string; conversation: string; text: string; minutesAgo: number; deleted?: boolean;
  }) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
         is_sent_by_me, occurred_at, text_plain, deleted_at)
       values ($1, 'onlyfans', $2, $3, $2, false, $4, $5, $6)`,
      [pageId, input.conversation, input.ref, new Date(Date.now() - input.minutesAgo * 60_000), input.text,
        input.deleted ? new Date() : null],
    );
  }

  it("answers an id of another fan's chat as absent, never as included or deleted (critic item 5)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    await setPageOfapiAccountId(appContext.db, { pageId, ofapiAccountId: OFAPI_ACCOUNT });
    // The same page, another fan: live and deleted messages in both stores.
    await seedArchiveMessage({ ref: "8001", conversation: OTHER_FAN, text: "other fan", minutesAgo: 30 });
    await seedArchiveMessage({ ref: "8002", conversation: OTHER_FAN, text: "other fan, deleted", minutesAgo: 29, deleted: true });
    await seedDmMessage({ ref: "8003", conversation: OTHER_FAN, mine: false, text: "other fan, fresh", minutesAgo: 1 });
    await seedDmMessage({ ref: "8004", conversation: OTHER_FAN, mine: false, text: "", minutesAgo: 1, deleted: true });
    // A delete webhook names no chat: alone it proves nothing about this one.
    await seedDmMessage({ ref: "8005", conversation: null, mine: false, text: "", minutesAgo: 0, deleted: true });

    const foreign = ["8001", "8002", "8003", "8004", "8005"];
    const mine = await stream({ capabilities: "context-v1", body: { knownFanMessageIds: [...foreign, "9003"] } });
    expect((mine.context as { knownFanMessages: unknown }).knownFanMessages).toEqual([
      ...foreign.map((id) => ({ id, state: "absent" })),
      { id: "9003", state: "included" },
    ]);
    // None of the other fan's text reached this generation either.
    expect(mine.context).toMatchObject({ source: "union", window: { served: 3 } });

    // Asked for the chat they belong to, the same ids are real.
    const theirs = await stream({
      capabilities: "context-v1",
      body: { conversationRef: OTHER_FAN, knownFanMessageIds: [...foreign, "9003"] },
    });
    expect((theirs.context as { knownFanMessages: unknown }).knownFanMessages).toEqual([
      { id: "8001", state: "included" },
      { id: "8002", state: "deleted" },
      { id: "8003", state: "included" },
      { id: "8004", state: "deleted" },
      { id: "8005", state: "absent" },
      { id: "9003", state: "absent" },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads only the database: no platform request, no queued work, no chat marked read (critic item 8)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    await setPageOfapiAccountId(appContext.db, { pageId, ofapiAccountId: OFAPI_ACCOUNT });
    await seedDmMessage({ ref: "9005", mine: false, text: "still there?", minutesAgo: 5 });
    // An unread chat: reading it through OnlyFans would mark it read there.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, unread_count)
       values ($1, $2, $2, 3)`,
      [pageId, FAN],
    );

    const trap = await armNoOutboundTrap(testDb);
    try {
      const served = await stream({
        capabilities: "context-v1",
        body: { knownFanMessageIds: ["9005", "9004", "9003"] },
      });
      expect(served.context).toMatchObject({ source: "union" });
      // The loader on its own, reading the same union.
      const transcript = await loadTranscriptContext(appContext, {
        pageId, conversationRef: FAN, limit: 1500, unionMode: "serve",
      });
      expect(transcript.served.window.map((message) => message.messageRef)).toEqual(["9001", "9002", "9003", "9005"]);
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
