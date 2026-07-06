import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
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
} from "../apps/runtime/src/modules/ai/index.ts";
import type {
  AiGatewayProvider,
  AiGatewayProviderInput,
} from "../apps/runtime/src/services/ai-gateway.ts";
import { createUserAccount, issueChatterApiKey } from "../apps/runtime/src/services/auth.ts";
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
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "svc-of" });
  pageId = page.id;
  await storeProxyConfig(appContext.db, page.id, {
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

  apiServer = await buildApiServer(appContext);
  await apiServer.ready();
});

async function seedConversation() {
  // Archive rows: fan message + our reply + a tip, all in the fan's thread.
  const rows = [
    { ref: "9001", text: "hey babe", mine: false, at: "2026-07-06T10:00:00.000Z", tip: 0 },
    { ref: "9002", text: "hey you", mine: true, at: "2026-07-06T10:05:00.000Z", tip: 0 },
    { ref: "9003", text: "sent you something", mine: false, at: "2026-07-06T10:10:00.000Z", tip: 5000 },
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
             '2026-07-06T10:10:00Z', 'ofapi:webhook')`,
    [pageId, Number(fan.rows[0]!.id)],
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

describe("AI feature service pilot (Stage 30)", () => {
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
    expect(userText).toContain("[10:00] Fan: hey babe");
    expect(userText).toContain("[10:05] Model: hey you");
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
    const review = await call("chat-review");
    expect(review.statusCode).toBe(400);

    // ping derives its segment kernel-side; an ACTIVE conversation (fresh
    // fan messages in the seed) is blocked — desktop CG-FLOW-05 parity.
    const pingActive = await call("ping");
    expect(pingActive.statusCode, pingActive.body).toBe(400);
    expect(pingActive.json().message).toContain("active");

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
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("prompt migration manifest (Stage 30)", () => {
  const root = join(__dirname, "..", "apps", "runtime", "src", "modules", "ai", "prompts");
  const manifest = JSON.parse(readFileSync(join(root, "prompt-manifest.json"), "utf8")) as {
    files: Record<string, { coreSha256: string; byteIdenticalToSource: boolean }>;
  };

  it("every migrated file matches its recorded hash (drift pin)", () => {
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const digest = createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
      expect(digest, rel).toBe(entry.coreSha256);
    }
  });

  it("prompt templates are byte-identical to their desktop sources", () => {
    const templates = Object.entries(manifest.files).filter(([rel]) => rel.startsWith("templates/"));
    expect(templates.length).toBeGreaterThanOrEqual(7);
    for (const [rel, entry] of templates) {
      expect(entry.byteIdenticalToSource, rel).toBe(true);
    }
    // And no template exists outside the manifest.
    for (const file of readdirSync(join(root, "templates"))) {
      expect(manifest.files[`templates/${file}`], file).toBeDefined();
    }
  });
});
