import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
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

function capturingProvider(capture: { input?: AiGatewayProviderInput }): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
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
  it("echoes the exact restricted prompt only for the capability plus live gate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const capture: { input?: AiGatewayProviderInput } = {};
    appContext.aiGatewayProvider = capturingProvider(capture);
    appContext.config.chatMuseAiPromptDebugEchoUsers = "other, SVC-CHATTER";
    appContext.config.chatMuseAiPromptDebugEchoUntil = new Date(
      Date.now() + 60 * 60 * 1000,
    ).toISOString();
    const info = vi.spyOn(appContext.logger, "info");
    const transcript = "x".repeat(300_000);
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
    const debug = frames[1] as {
      systemBlocks: unknown[];
      userBlocks: Array<{ text: string }>;
      contextManifest: unknown;
    };
    expect(debug.userBlocks.some((block) => block.text.includes(transcript))).toBe(true);
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
    expect(JSON.stringify(emission)).not.toContain(transcript.slice(0, 100));

    appContext.config.chatMuseAiPromptDebugEchoUntil = new Date(
      Date.now() - 60 * 1000,
    ).toISOString();
    const expired = await apiServer!.inject({
      method: "POST",
      url: "/api/v1/ai/features/fast-reply",
      headers: {
        authorization: `Bearer ${chatterKey}`,
        "x-kernel-ai-capabilities": "debug-input-v1",
      },
      payload: { ...payload, clientRequestId: randomUUID() },
    });
    expect(expired.statusCode, expired.body).toBe(200);
    expect(aiFrames(expired.body).some((frame) => frame.type === "debug_input_v1")).toBe(false);
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
        personaKey: "milly",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(capture.input!.body.prompt.systemBlocks[1]!.text).toContain("You are Milly.");

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
    expect(put.json()).toMatchObject({ key: "custom-milly", displayName: "Milly" });

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

  it("ages the dossier by its SOURCE generation time, not the hub append time", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    // Delayed re-push scenario: the row was APPENDED just now, but the Scan
    // itself ran 60 days ago — volatile sections must still drop.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await seedFanProfile({
      platform: "onlyfans",
      targetPageId: pageId,
      createdAt: new Date().toISOString(),
      sourceGeneratedAt: sixtyDaysAgo,
    });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("красном Ducati");
    expect(text).not.toContain("Обещала фото с пляжа");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("falls back to created_at for legacy rows without a source time", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedConversation();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await seedFanProfile({ platform: "onlyfans", targetPageId: pageId, createdAt: sixtyDaysAgo });
    const capture: { input?: AiGatewayProviderInput } = {};
    const call = makeCall(capture);

    const reply = await call("fast-reply");
    expect(reply.statusCode, reply.body).toBe(200);
    const text = userText(capture);
    expect(text).toContain("красном Ducati");
    expect(text).not.toContain("Обещала фото с пляжа");
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
    appContext.config.chatMuseAiPromptDebugEchoUsers = "svc-chatter";
    appContext.config.chatMuseAiPromptDebugEchoUntil = new Date(
      Date.now() + 60 * 60 * 1000,
    ).toISOString();
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
