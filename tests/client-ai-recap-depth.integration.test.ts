import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiFeatureStreamFrameSchema, errorResponseSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  listAiTranscriptUnionMessages,
  listArchiveConversationMessagesForAi,
  seedBundledAiPersona,
  setPageOfapiAccountId,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities, loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension H-6, R20 HF-6: the full Recap reads up to the owner's
// `aiTranscriptDeepMaxRows` (1500, 3000 or 5000), and the notes fill never
// fewer than 3000, for a client that advertises `context-v1` and lets the hub
// load the transcript, on OnlyFans and Fansly alike. Through the real route, on
// chats that hold more than 5000 messages.
//
// Every request here runs under the no-outbound trap: the transcript load of
// the AI stream reads the database and nothing else, at either depth (critic
// item 8).

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", grisha: "grisha-secret" } as const;
const AUDIT = { source: "cli" } as const;
const FAN = "777000777";
const FANSLY_FAN = "700000000000000777";
const FANSLY_GROUP = "700000000000000999";
const EXTENSION_VERSION = "chat-extension/1.4.2";
const OFAPI_ACCOUNT = "acct_depth";
/** Messages of the fixture chat: more than the deepest window. */
const CHAT_MESSAGES = 5200;
/** The notes fill's questionnaire labels, as the Fansly notes panel sends them. */
const NOTE_FIELDS = ["Имя", "Возраст", "Локация", "Работа", "Медиа"];
/** `message_ref` of fixture message `n` (1 = oldest). */
const ref = (n: number) => String(500_000 + n);
/** Message `n` was sent `MINUTES_BACK - n` minutes ago: one a minute, all in the past. */
const MINUTES_BACK = CHAT_MESSAGES + 200;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
/** A full device token of a chatter of lora-of and lora-fansly (a desktop's). */
let grishaToken = "";
/** The narrow chat-extension token of the same chatter. */
let grishaExtensionToken = "";
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput } = {};

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.input = input;
      yield { type: "content_delta", text: "a recap" };
      yield {
        type: "usage",
        providerResponseId: "msg_depth",
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

/**
 * The fixture chat on lora-of as the hub's archive holds it: `CHAT_MESSAGES`
 * messages, `deep-<n>` each (1 = oldest). Odd numbers are the fan's.
 */
async function seedChat() {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
       is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
     select $1, 'onlyfans', $2, (500000 + g)::text, case when g % 2 = 1 then $2 end, g % 2 = 0,
            now() - (($3::int - g) || ' minutes')::interval, 'deep-' || g, false, 0
     from generate_series(1, $4::int) g`,
    [pageIds["lora-of"], FAN, MINUTES_BACK, CHAT_MESSAGES],
  );
}

/** The same chat on lora-fansly: `count` messages in the hub's Fansly archive, `deep-<n>` each. */
async function seedFanslyChat(count = CHAT_MESSAGES) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
       is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
     select $1, 'fansly', $2, (800000 + g)::text, case when g % 2 = 1 then $3 end, g % 2 = 0,
            now() - (($4::int - g) || ' minutes')::interval, 'deep-' || g, false, 0
     from generate_series(1, $5::int) g`,
    [pageIds["lora-fansly"], FANSLY_GROUP, FANSLY_FAN, MINUTES_BACK, count],
  );
}

/**
 * Socket messages of the Fansly chat that the archive does not hold yet,
 * `deep-<n>` for `n` in `from..to`, newer than every archived one: what the
 * live overlay union adds on a page in `fanslyLiveOverlayReadPages`. The
 * chat's thread row is seeded with the pages (the overlay reads known chats).
 */
async function seedFanslySocket(from: number, to: number) {
  await testDb!.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
       is_sent_by_page, created_at, content, decoder_version, first_visible_at, confirm_due_at)
     select $1, (800000 + g)::text, $2, $3, false, now() - (($4::int - g) || ' seconds')::interval, 'deep-' || g, 1,
            now(), now() + interval '1 hour'
     from generate_series($5::int, $6::int) g`,
    [pageIds["lora-fansly"], FANSLY_GROUP, FANSLY_FAN, to + 1, from, to],
  );
}

/** Webhook-store rows (dm_message_archive) for fixture messages `from..to`. */
async function seedWebhookRows(from: number, to: number) {
  await testDb!.pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain,
       is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id,
       source_received_at, retain_until)
     select 'onlyfans', $1, $2, $3, $3, (500000 + g)::text,
            (case when g % 2 = 0 then 'model' else 'fan' end)::dm_sender_role,
            g % 2 = 0, now() - (($4::int - g) || ' minutes')::interval, 'deep-' || g, false, 0, 'webhook',
            'messages.received', 'depth-' || g, 1, now(), now() + interval '100 years'
     from generate_series($5::int, $6::int) g`,
    [pageIds["lora-of"], OFAPI_ACCOUNT, FAN, MINUTES_BACK, from, to],
  );
}

/** A delete webhook for fixture message `n`: it names no chat, so its stub has none. */
async function seedDeleteWebhook(n: number) {
  await testDb!.pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_message_id,
       sender_role, is_sent_by_me, text_plain, is_tip, tip_amount_mills, deleted_at, source, source_event_type,
       source_idempotency_key, source_journal_id, source_received_at, retain_until)
     values ('onlyfans', $1, $2, $3, 'unknown', false, '', false, 0, now(), 'webhook', 'messages.deleted', $4, 1,
       now(), now() + interval '100 years')`,
    [pageIds["lora-of"], OFAPI_ACCOUNT, ref(n), `depth-tomb-${n}`],
  );
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);
}

interface AskInput {
  /**
   * Who asks. `desktop` (the default) is the chatter's full device token: a
   * released desktop without the capability header, or one whose SDK advertises
   * `context-v1`. `extension` is the chat extension as it signs in and asks:
   * its narrow token and its version header.
   */
  as?: "desktop" | "extension";
  feature?: string;
  /** `null` sends no capability header, as a released client does. */
  capabilities?: string | null;
  body?: Record<string, unknown>;
}

/** One AI request, as the hub answered it. */
async function send(input: AskInput = {}): Promise<InjectResponse> {
  delete provider.input;
  const feature = input.feature ?? "fan-summary";
  const capabilities = input.capabilities === undefined ? "context-v1" : input.capabilities;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${feature}`,
    headers: {
      ...(input.as === "extension"
        ? { authorization: `Bearer ${grishaExtensionToken}`, "x-client-version": EXTENSION_VERSION }
        : { authorization: `Bearer ${grishaToken}` }),
      ...(capabilities !== null ? { "x-kernel-ai-capabilities": capabilities } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: "lora-of",
      platform: "onlyfans",
      conversationRef: FAN,
      ...(feature === "coach-chat" ? { chatterQuestion: "what next?" } : {}),
      ...(feature === "fan-notes-fill" ? { noteFields: NOTE_FIELDS } : {}),
      ...input.body,
    },
  });
}

/** One AI request that generates: what was streamed and what the provider was given. */
async function ask(input: AskInput = {}) {
  const response = await send(input);
  expect(response.statusCode, response.body).toBe(200);
  const streamed = frames(response.body);
  for (const frame of streamed) {
    // Every frame is one the SDK of a client would accept.
    expect(aiFeatureStreamFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
  }
  const prompt = provider.input!.body.prompt;
  const text = prompt.userBlocks.map((block) => block.text).join("\n");
  return {
    types: streamed.map((frame) => frame.type),
    context: streamed.find((frame) => frame.type === "context_v1") as
      | (Frame & { source: string; servedHead: Frame | null; window: { requested: number; served: number } })
      | undefined,
    /** Everything the provider was given. */
    prompt: JSON.stringify(prompt),
    /** The fixture messages whose line the provider received, oldest first. */
    read: [...text.matchAll(/^\[\d\d:\d\d\] (?:Fan|Model): deep-(\d+)$/gm)].map((match) => Number(match[1])),
  };
}

/** The owner's switch refused the request, with this reason, before anything was read. */
function expectFeatureRefused(response: InjectResponse, reason: string) {
  expect(response.statusCode, response.body).toBe(409);
  expect(errorResponseSchema.parse(response.json())).toMatchObject({ error: "client_feature_disabled", reason });
  expect(provider.input).toBeUndefined();
}

/** The numbers `from..to`, both included. */
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

async function patchConfig(key: string, value: unknown) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches: [{ key, value }] },
  });
  return response;
}

/** The owner sets the depth. 3000 is production's value since 2026-10-13 (X37). */
async function raiseDepth(value: "1500" | "3000" | "5000" = "3000") {
  const response = await patchConfig("aiTranscriptDeepMaxRows", value);
  expect(response.statusCode, response.body).toBe(200);
}

/** The owner's Recap flag of the extension on lora-of. */
async function setRecapFlag(on: boolean) {
  const response = await patchConfig("chatExtensionFeatures", JSON.stringify({ "lora-of": { recap: on } }));
  expect(response.statusCode, response.body).toBe(200);
}

async function bootstrap() {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/client/bootstrap",
    headers: { authorization: `Bearer ${grishaExtensionToken}`, "x-client-version": EXTENSION_VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{
    configRevision: number;
    limits: Record<string, unknown>;
    pages: Array<{ pageLabel: string; features: Record<string, { available: boolean; reason?: string }> }>;
  }>();
}

/** The extension's Recap feature on lora-of, as the bootstrap tells it. */
async function recapFeature() {
  return (await bootstrap()).pages.find((page) => page.pageLabel === "lora-of")?.features.recap;
}

async function generationCount(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from ai_generation_content");
  return rows[0]!.count;
}

interface GenerationRow { feature: string; params: Record<string, unknown> }

async function lastGeneration(): Promise<GenerationRow> {
  const { rows } = await testDb!.pool.query<GenerationRow>(
    "select feature, params from ai_generation_content order by id desc limit 1",
  );
  return rows[0]!;
}

const manifestOf = (row: GenerationRow) => row.params.contextManifest as Record<string, unknown>;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

describe("full Recap transcript depth (aiTranscriptDeepMaxRows)", () => {
  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });
    app.config.chatMuseAiGatewayEnabled = true;
    app.aiGatewayProvider = capturingProvider();

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    const grishaId = await fixtureUserId(app, "grisha");
    await setUserPassword(app, { userId: grishaId, password: PASSWORDS.grisha }, AUDIT);

    const persona = createBundledPersonalities()[0]!;
    await seedBundledAiPersona(app.db, {
      key: persona.id,
      displayName: persona.name,
      systemBlock: persona.content,
      bundledVersion: persona.builtinVersion!,
    });
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, create] of [["lora-of", createOnlyFansPage], ["lora-fansly", createFanslyPage]] as const) {
      const page = await create(app.db, { modelId: lora!.id, label });
      pageIds[label] = page!.id;
      await storeProxyConfig(app.db, page!.id, {
        url: "socks5://proxy.example:1080",
        encryptedAuth: null,
        keyVersion: null,
        rateLimitScopeKey: "shared-ai-proxy",
      });
      await assignPageToUser(app, { userId: grishaId, pageLabel: label }, AUDIT);
    }
    await testDb.pool.query("update pages set external_page_id = '100000001' where id = $1", [pageIds["lora-of"]]);
    // dm_message_archive is keyed by the page's OFAPI account.
    await setPageOfapiAccountId(app.db, { pageId: pageIds["lora-of"]!, ofapiAccountId: OFAPI_ACCOUNT });
    // An unread chat: reading it through OnlyFans would mark it read there.
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, $2, 3)",
      [pageIds["lora-of"], FAN],
    );
    // The Fansly chat, unread as well: its fan is the thread's partner.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, unread_count)
       values ($1, $2, $3, 2)`,
      [pageIds["lora-fansly"], FANSLY_GROUP, FANSLY_FAN],
    );

    grishaToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha desktop" })).token;

    server = await buildApiServer(app);
    await server.ready();

    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": EXTENSION_VERSION },
      payload: {
        username: "grisha",
        password: PASSWORDS.grisha,
        label: "Firefox · macOS · ChatSpace",
        mode: "active",
        client: "chat-extension",
      },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    grishaExtensionToken = signIn.json<{ token: string }>().token;
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: PASSWORDS.owner },
    });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    ownerCookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;

    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  it("is inert at merge: the value rests at 1500, and a Recap that asks for 3000 or 5000 reads 1500", async (context) => {
    if (!server) return context.skip();
    await seedChat();

    expect((await bootstrap()).limits.deepMax).toBe(1500);

    for (const messageCount of [3000, 5000]) {
      const recap = await ask({ body: { messageCount } });
      expect(recap.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
      // The newest 1500 of the chat's 5200, oldest first.
      expect(recap.read).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));
      expect(recap.context).toMatchObject({
        source: "archive",
        servedHead: { messageRef: ref(CHAT_MESSAGES) },
        window: { requested: messageCount, served: 1500 },
      });
      const recorded = await lastGeneration();
      expect(recorded.params).toMatchObject({ summaryMode: "full", requestedCount: messageCount, keptCount: 1500 });
      expect(manifestOf(recorded)).toMatchObject({ source: "archive", archiveCount: 1500 });
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes exactly 1500, 3000 or 5000 from the owner, audited, and the bootstrap announces it", async (context) => {
    if (!server) return context.skip();
    const before = await bootstrap();
    expect(before.limits.deepMax).toBe(1500);

    for (const refused of ["2000", "4000", "5001", "6000", 3000, 5000, true]) {
      const response = await patchConfig("aiTranscriptDeepMaxRows", refused);
      expect(response.statusCode, `${String(refused)}: ${response.body}`).toBe(400);
    }
    expect((await bootstrap()).limits.deepMax).toBe(1500);

    // Production's override since 2026-10-13 stays a valid value.
    await raiseDepth("3000");
    const atThree = await bootstrap();
    expect(atThree.limits.deepMax).toBe(3000);
    // A client that cached the old limits sees the revision move.
    expect(atThree.configRevision).toBeGreaterThan(before.configRevision);

    await raiseDepth("5000");
    const atFive = await bootstrap();
    expect(atFive.limits.deepMax).toBe(5000);
    expect(atFive.configRevision).toBeGreaterThan(atThree.configRevision);
    const audit = await testDb!.pool.query<{ key: string; new_value: unknown }>(
      "select key, new_value from config_audit_log where key = 'aiTranscriptDeepMaxRows' order by id",
    );
    expect(audit.rows).toEqual([
      { key: "aiTranscriptDeepMaxRows", new_value: "3000" },
      { key: "aiTranscriptDeepMaxRows", new_value: "5000" },
    ]);

    // Back down is one write as well: the rollback of the deeper read.
    expect((await patchConfig("aiTranscriptDeepMaxRows", "1500")).statusCode).toBe(200);
    const lowered = await bootstrap();
    expect(lowered.limits.deepMax).toBe(1500);
    expect(lowered.configRevision).toBeGreaterThan(atFive.configRevision);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("at production's 3000, the full Recap of a context-v1 client reads the 3000 newest messages", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await raiseDepth("3000");

    const recap = await ask({ body: { messageCount: 3000 } });
    expect(recap.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(recap.read).toEqual(range(CHAT_MESSAGES - 2999, CHAT_MESSAGES));
    expect(recap.context).toMatchObject({
      source: "archive",
      servedHead: { messageRef: ref(CHAT_MESSAGES), isFromFan: false },
      window: { requested: 3000, served: 3000 },
    });
    const recorded = await lastGeneration();
    expect(recorded.params).toMatchObject({ summaryMode: "full", requestedCount: 3000, keptCount: 3000 });
    expect(manifestOf(recorded)).toMatchObject({ source: "archive", archiveCount: 3000 });

    // A client that asks for more is served the owner's 3000, and the frame says so.
    const more = await ask({ body: { messageCount: 5000 } });
    expect(more.read).toEqual(range(CHAT_MESSAGES - 2999, CHAT_MESSAGES));
    expect(more.context!.window).toEqual({ requested: 5000, served: 3000 });

    // The window is still the client's to choose: fewer is fewer.
    expect((await ask({ body: { messageCount: 2000 } })).read).toEqual(range(CHAT_MESSAGES - 1999, CHAT_MESSAGES));
    // A request that names no window keeps the deep default of 1500.
    const unnamed = await ask();
    expect(unnamed.read).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));
    expect(unnamed.context!.window).toEqual({ requested: 1500, served: 1500 });

    // Lowered again, the same request is back at 1500 from the next generation on.
    expect((await patchConfig("aiTranscriptDeepMaxRows", "1500")).statusCode).toBe(200);
    expect((await ask({ body: { messageCount: 3000 } })).read).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("raised to 5000, the full Recap of a context-v1 client reads the 5000 newest messages, and says so", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await raiseDepth("5000");

    const recap = await ask({ body: { messageCount: 5000 } });
    expect(recap.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(recap.read).toEqual(range(CHAT_MESSAGES - 4999, CHAT_MESSAGES));
    // The frame names what was actually read: all 5000.
    expect(recap.context).toMatchObject({
      source: "archive",
      servedHead: { messageRef: ref(CHAT_MESSAGES), isFromFan: false },
      window: { requested: 5000, served: 5000 },
    });
    const recorded = await lastGeneration();
    expect(recorded.params).toMatchObject({ summaryMode: "full", requestedCount: 5000, keptCount: 5000 });
    expect(manifestOf(recorded)).toMatchObject({ source: "archive", archiveCount: 5000 });

    // A chat shorter than the window is read whole: the frame says what it held.
    expect((await ask({ body: { messageCount: 3000 } })).context!.window).toEqual({ requested: 3000, served: 3000 });
    // The schema's own bound: 5001 is refused before anything is read.
    const tooDeep = await send({ body: { messageCount: 5001 } });
    expect(tooDeep.statusCode, tooDeep.body).toBe(400);
    expect(provider.input).toBeUndefined();

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serves the chat extension itself: its narrow token's full Recap reads 5000, behind the page's Recap switch", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await raiseDepth("5000");
    // The extension's full Recap as its request builder sends it: the fan in
    // both refs, and a window cut to the `limits.deepMax` of its bootstrap.
    const extensionRecap = async (): Promise<AskInput> => ({
      as: "extension",
      body: { fanRef: FAN, isRegeneration: false, messageCount: (await bootstrap()).limits.deepMax },
    });
    expect((await extensionRecap()).body).toMatchObject({ messageCount: 5000 });

    // The depth is raised, but the owner has not switched the extension on:
    // its Recap is refused before anything is read.
    expectFeatureRefused(await send(await extensionRecap()), "disabled");
    expect((await patchConfig("chatExtensionEnabled", true)).statusCode).toBe(200);
    // The extension is on, its Recap is not: still refused, still nothing read.
    expect(await recapFeature()).toEqual({ available: false, reason: "flag_off" });
    expectFeatureRefused(await send(await extensionRecap()), "flag_off");
    expect(await generationCount()).toBe(0);

    // Recap on for the page: the narrow token passes the owner's switch and
    // reads the deep window.
    await setRecapFlag(true);
    expect(await recapFeature()).toEqual({ available: true });
    const recap = await ask(await extensionRecap());
    expect(recap.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(recap.read).toEqual(range(CHAT_MESSAGES - 4999, CHAT_MESSAGES));
    expect(recap.context).toMatchObject({
      source: "archive",
      servedHead: { messageRef: ref(CHAT_MESSAGES) },
      window: { requested: 5000, served: 5000 },
    });
    const recorded = await lastGeneration();
    expect(recorded.params).toMatchObject({
      clientProfile: "chat-extension",
      summaryMode: "full",
      requestedCount: 5000,
      keptCount: 5000,
    });
    expect(manifestOf(recorded)).toMatchObject({ source: "archive", archiveCount: 5000 });

    // The short Recap of the same token stays at 300.
    const short = await ask({ as: "extension", body: { fanRef: FAN, summaryMode: "short", messageCount: 5000 } });
    expect(short.read).toEqual(range(CHAT_MESSAGES - 299, CHAT_MESSAGES));

    // Lowered to production's 3000: the bootstrap tells the extension 3000,
    // and one that still holds the old limits and asks for 5000 reads 3000.
    await raiseDepth("3000");
    expect((await extensionRecap()).body).toMatchObject({ messageCount: 3000 });
    const stale = await ask({ as: "extension", body: { fanRef: FAN, messageCount: 5000 } });
    expect(stale.read).toEqual(range(CHAT_MESSAGES - 2999, CHAT_MESSAGES));
    expect(stale.context!.window).toEqual({ requested: 5000, served: 3000 });
    // At rest, 1500.
    expect((await patchConfig("aiTranscriptDeepMaxRows", "1500")).statusCode).toBe(200);
    expect((await extensionRecap()).body).toMatchObject({ messageCount: 1500 });
    expect((await ask({ as: "extension", body: { fanRef: FAN, messageCount: 5000 } })).context!.window)
      .toEqual({ requested: 5000, served: 1500 });

    // The owner's Recap switch still decides, whatever the depth says.
    await raiseDepth("5000");
    await setRecapFlag(false);
    expectFeatureRefused(await send(await extensionRecap()), "flag_off");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves a released client at 1500: it asks for 3000 and gets what it got before", async (context) => {
    if (!server) return context.skip();
    await seedChat();

    // A desktop whose deep window is set to its maximum: messageCount 3000, no
    // capability header.
    const before = await ask({ capabilities: null, body: { messageCount: 3000 } });
    expect(before.types).toEqual(["meta", "content_delta", "usage", "done"]);
    expect(before.read).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));
    const paramsBefore = (await lastGeneration()).params;

    for (const value of ["3000", "5000"] as const) {
      await raiseDepth(value);
      const after = await ask({ capabilities: null, body: { messageCount: 3000 } });
      expect(after.types, value).toEqual(before.types);
      expect(after.read, value).toEqual(before.read);
      // Byte for byte the prompt it had, and the same recorded provenance.
      expect(after.prompt, value).toBe(before.prompt);
      const paramsAfter = (await lastGeneration()).params;
      expect(paramsAfter, value).toMatchObject({ requestedCount: 3000, keptCount: 1500 });
      expect(paramsAfter, value).toEqual(paramsBefore);
    }

    // A capability that is not context-v1 does not unlock the depth either,
    // nor does a notes fill without it.
    for (const capabilities of ["debug-input-v1", "split-all-v1", "debug-input-v1, split-all-v1"]) {
      expect((await ask({ capabilities, body: { messageCount: 5000 } })).read, capabilities).toHaveLength(1500);
    }
    expect((await ask({ feature: "fan-notes-fill", capabilities: null, body: { messageCount: 5000 } })).read)
      .toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps every other feature at 1500 for a context-v1 client, the short Recap at 300", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await raiseDepth("5000");

    for (const feature of ["chat-review", "help-me", "fast-reply"]) {
      const asked = await ask({ feature, body: { messageCount: 5000 } });
      expect(asked.read, feature).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));
      expect(asked.context!.window, feature).toEqual({ requested: 5000, served: 1500 });
      expect(manifestOf(await lastGeneration()), feature).toMatchObject({ archiveCount: 1500 });
    }

    // Coach: the loader read 1500 (its prompt budget may then cut the oldest lines).
    const coach = await ask({ feature: "coach-chat", body: { messageCount: 5000 } });
    expect(coach.read.at(-1)).toBe(CHAT_MESSAGES);
    expect(coach.read.length).toBeLessThanOrEqual(1500);
    expect(manifestOf(await lastGeneration())).toMatchObject({ archiveCount: 1500 });

    // The short Recap promises its model 300 messages at most.
    const short = await ask({ body: { summaryMode: "short", messageCount: 5000 } });
    expect(short.read).toEqual(range(CHAT_MESSAGES - 299, CHAT_MESSAGES));
    expect((await lastGeneration()).params).toMatchObject({ summaryMode: "short", requestedCount: 300, keptCount: 300 });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads the notes fill of a context-v1 client to at least 3000, up to the owner's 5000", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    const fill = (messageCount?: number) => ask({
      feature: "fan-notes-fill",
      body: messageCount === undefined ? {} : { messageCount },
    });

    // At rest the Recap reads 1500, the notes fill 3000: as deep as the
    // released Fansly extension fills its notes.
    const resting = await fill(5000);
    expect(resting.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(resting.read).toEqual(range(CHAT_MESSAGES - 2999, CHAT_MESSAGES));
    expect(resting.context).toMatchObject({ source: "archive", window: { requested: 5000, served: 3000 } });
    expect(resting.prompt).toContain(NOTE_FIELDS.join("\\n"));
    expect((await lastGeneration())).toMatchObject({ feature: "fan-notes-fill" });
    expect(manifestOf(await lastGeneration())).toMatchObject({ archiveCount: 3000 });
    // It is still the client's window: fewer is fewer, none named is the deep default.
    expect((await fill(2000)).read).toEqual(range(CHAT_MESSAGES - 1999, CHAT_MESSAGES));
    expect((await fill()).context!.window).toEqual({ requested: 1500, served: 1500 });

    await raiseDepth("3000");
    expect((await fill(5000)).context!.window).toEqual({ requested: 5000, served: 3000 });

    await raiseDepth("5000");
    const deepest = await fill(5000);
    expect(deepest.read).toEqual(range(CHAT_MESSAGES - 4999, CHAT_MESSAGES));
    expect(deepest.context!.window).toEqual({ requested: 5000, served: 5000 });
    expect(manifestOf(await lastGeneration())).toMatchObject({ archiveCount: 5000 });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[AI-143] Fansly: one setting for both platforms on the hub's own transcript, and the old extension's own transcript untouched", async (context) => {
    if (!server) return context.skip();
    const fansly = { pageLabel: "lora-fansly", platform: "fansly", conversationRef: FANSLY_GROUP, fanRef: FANSLY_FAN };
    // The released Fansly extension (2.10.1, fansly-chat@ff30d00
    // src/background/operations.ts): it reads the chat itself and sends up to
    // 3000 messages in `clientContext`, with no capability header. Its full
    // Recap and its notes fill, in its own request forms.
    const transcript = Array.from({ length: 3000 }, (_, n) =>
      `[10:${String(n % 60).padStart(2, "0")}] Fan: fansly line ${n}`).join("\n");
    const oldClientContext = {
      transcript,
      messageCount: 3000,
      fanDisplayName: "Fansly Fan",
      fanSpendingData: "Total: $12.00",
      fanSubscriptionData: "Subscribed: yes",
    };
    const oldRecap = () => ask({
      capabilities: null,
      body: { ...fansly, isRegeneration: false, messageCount: 3000, clientContext: oldClientContext },
    });
    const oldNotesFill = () => ask({
      feature: "fan-notes-fill",
      capabilities: null,
      body: {
        ...fansly,
        isRegeneration: false,
        messageCount: 3000,
        noteFields: NOTE_FIELDS,
        clientContext: { ...oldClientContext, fanBio: "gym, Texas", transcriptCoverage: "full-history" },
      },
    });
    // The hub's own Fansly archive, for a context-v1 request that brings no transcript.
    await seedFanslyChat();
    const hubRecap = (capabilities?: string | null) => ask({
      ...(capabilities !== undefined ? { capabilities } : {}),
      body: { ...fansly, messageCount: 5000 },
    });
    const hubFill = () => ask({ feature: "fan-notes-fill", body: { ...fansly, messageCount: 5000 } });

    // Resting: the old forms as they are today; the hub's Fansly transcript at 1500, the notes fill at 3000.
    const oldRecapBefore = await oldRecap();
    const oldRecapParams = (await lastGeneration()).params;
    const oldFillBefore = await oldNotesFill();
    const oldFillParams = (await lastGeneration()).params;
    expect(oldRecapBefore.types).toEqual(["meta", "content_delta", "usage", "done"]);
    expect(oldRecapBefore.prompt).toContain("fansly line 2999");
    expect(oldRecapParams).toMatchObject({ summaryMode: "full", requestedCount: 3000, keptCount: 3000 });
    expect(oldFillBefore.prompt).toContain("fansly line 2999");
    expect((await hubRecap()).read).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));
    expect((await hubFill()).read).toEqual(range(CHAT_MESSAGES - 2999, CHAT_MESSAGES));

    for (const value of ["3000", "5000"] as const) {
      await raiseDepth(value);
      // The old forms: byte for byte the prompt they had, the same provenance.
      const oldRecapAfter = await oldRecap();
      expect(oldRecapAfter.types, value).toEqual(oldRecapBefore.types);
      expect(oldRecapAfter.prompt, value).toBe(oldRecapBefore.prompt);
      expect((await lastGeneration()).params, value).toEqual(oldRecapParams);
      const oldFillAfter = await oldNotesFill();
      expect(oldFillAfter.prompt, value).toBe(oldFillBefore.prompt);
      expect((await lastGeneration()).params, value).toEqual(oldFillParams);

      // The hub's own Fansly transcript reads what the owner set, as OnlyFans does.
      const depth = Number(value);
      const recap = await hubRecap();
      expect(recap.read, value).toEqual(range(CHAT_MESSAGES - depth + 1, CHAT_MESSAGES));
      expect(recap.context, value).toMatchObject({
        source: "archive",
        servedHead: { messageRef: String(800_000 + CHAT_MESSAGES) },
        window: { requested: 5000, served: depth },
      });
      expect(manifestOf(await lastGeneration()), value).toMatchObject({ source: "archive", archiveCount: depth });
      expect((await hubFill()).context!.window, value).toEqual({ requested: 5000, served: depth });
    }

    // Without context-v1 the hub's Fansly transcript stays at its own cap.
    expect((await hubRecap(null)).read).toEqual(range(CHAT_MESSAGES - 1499, CHAT_MESSAGES));

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("Fansly live overlay: the live_union path takes the same depth, socket messages included", async (context) => {
    if (!server) return context.skip();
    const fansly = { pageLabel: "lora-fansly", platform: "fansly", conversationRef: FANSLY_GROUP, fanRef: FANSLY_FAN };
    await seedFanslyChat();
    // Ten messages the socket delivered and the archive does not hold yet.
    const newest = CHAT_MESSAGES + 10;
    await seedFanslySocket(CHAT_MESSAGES + 1, newest);
    app.config.fanslyLiveOverlayReadPages = "all";
    const hubRecap = () => ask({ body: { ...fansly, messageCount: 5000 } });

    const resting = await hubRecap();
    expect(resting.context).toMatchObject({ source: "live_union", window: { requested: 5000, served: 1500 } });
    expect(resting.read).toEqual(range(newest - 1499, newest));

    for (const depth of [3000, 5000] as const) {
      await raiseDepth(String(depth) as "3000" | "5000");
      const recap = await hubRecap();
      expect(recap.context, String(depth)).toMatchObject({
        source: "live_union",
        servedHead: { messageRef: String(800_000 + newest) },
        window: { requested: 5000, served: depth },
      });
      // The newest `depth` messages: the ten socket ones and the archive's below them.
      expect(recap.read, String(depth)).toEqual(range(newest - depth + 1, newest));
      expect(manifestOf(await lastGeneration()), String(depth)).toMatchObject({
        source: "live_union", liveOverlay: "serve", liveCount: 10, liveError: false, archiveCount: depth,
      });
    }

    // The loader itself: the union takes the raised cap, and only when it is given one.
    const load = (maxRows?: number) => loadTranscriptContext(app, {
      pageId: pageIds["lora-fansly"]!,
      conversationRef: FANSLY_GROUP,
      limit: 5000,
      liveOverlay: "serve",
      ...(maxRows !== undefined ? { maxRows } : {}),
    });
    const deep = await load(5000);
    expect(deep.served.source).toBe("live_union");
    expect(deep.messages).toHaveLength(5000);
    expect(deep.contextManifest).toMatchObject({ liveError: false, liveCount: 10, archiveCount: 5000 });
    const ordinary = await load();
    expect(ordinary.messages).toHaveLength(1500);
    expect(ordinary.contextManifest).toMatchObject({ liveError: false, liveCount: 10, archiveCount: 1500 });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resolves tombstones, stubs and duplicates before the 5000 cap, in both readers", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    // The webhook store holds the newest 400 archived messages a second time,
    // and 100 the archive does not have yet.
    await seedWebhookRows(CHAT_MESSAGES - 399, CHAT_MESSAGES + 100);
    // Deleted in the archive (the webhook copy of each is still live).
    const deletedInArchive = range(CHAT_MESSAGES - 10, CHAT_MESSAGES);
    await testDb!.pool.query(
      "update message_archive set deleted_at = now() where account_id = $1 and message_ref = any($2)",
      [pageIds["lora-of"], deletedInArchive.map(ref)],
    );
    // Deleted by a webhook that names no chat: only the union's cross-store arm sees it.
    const deletedByWebhook = range(1000, 1009);
    for (const n of deletedByWebhook) {
      await seedDeleteWebhook(n);
    }
    // Stubs whose content has not arrived never serve.
    const stubs = range(2000, 2004);
    await testDb!.pool.query(
      "update message_archive set content_pending = true where account_id = $1 and message_ref = any($2)",
      [pageIds["lora-of"], stubs.map(ref)],
    );
    await raiseDepth("5000");

    const newest = (live: number[], count: number) => live.slice(-count);
    const dead = new Set([...deletedInArchive, ...stubs]);
    const archiveLive = range(1, CHAT_MESSAGES).filter((n) => !dead.has(n));
    const unionDead = new Set([...dead, ...deletedByWebhook]);
    const unionLive = range(1, CHAT_MESSAGES + 100).filter((n) => !unionDead.has(n));

    // The archive reader serves: 5000 live messages, not 5000 rows minus the dead ones.
    const fromArchive = await ask({ body: { messageCount: 5000 } });
    expect(fromArchive.context).toMatchObject({ source: "archive", window: { requested: 5000, served: 5000 } });
    expect(fromArchive.read).toEqual(newest(archiveLive, 5000));

    // The union serves: one line per message though 389 live ones sit in both stores.
    app.config.aiTranscriptFreshUnionMode = "serve";
    const fromUnion = await ask({ body: { messageCount: 5000 } });
    expect(fromUnion.context).toMatchObject({
      source: "union",
      servedHead: { messageRef: ref(CHAT_MESSAGES + 100) },
      window: { requested: 5000, served: 5000 },
    });
    expect(fromUnion.read).toEqual(newest(unionLive, 5000));
    expect(new Set(fromUnion.read).size).toBe(5000);
    expect(manifestOf(await lastGeneration())).toMatchObject({
      mode: "serve", source: "union", archiveCount: 5000, unionCount: 5000, unionError: false,
    });

    // The same chat for a released client: the same rules at its own cap.
    const released = await ask({ capabilities: null, body: { messageCount: 3000 } });
    expect(released.read).toEqual(newest(unionLive, 1500));

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the readers stop at 1500 for a caller that passes no maxRows, and at 5000 for any caller", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await seedWebhookRows(CHAT_MESSAGES - 399, CHAT_MESSAGES + 100);
    const pageId = pageIds["lora-of"]!;
    const readers = {
      archive: (input: { limit?: number; maxRows?: number }) =>
        listArchiveConversationMessagesForAi(app.db, { accountId: pageId, conversationRef: FAN, ...input }),
      union: (input: { limit?: number; maxRows?: number }) =>
        listAiTranscriptUnionMessages(app.db, { pageId, conversationRef: FAN, ...input }),
    };
    for (const [name, read] of Object.entries(readers)) {
      const head = name === "union" ? ref(CHAT_MESSAGES + 100) : ref(CHAT_MESSAGES);
      // What every caller before this change did, and every other caller still does.
      expect(await read({}), name).toHaveLength(100);
      expect(await read({ limit: 5000 }), name).toHaveLength(1500);
      expect(await read({ limit: 100_000 }), name).toHaveLength(1500);
      // Raised: up to 5000, never past it, and never more than was asked for.
      const deep = await read({ limit: 5000, maxRows: 5000 });
      expect(deep, name).toHaveLength(5000);
      expect(deep[0]!.messageRef, name).toBe(head);
      expect(new Set(deep.map((row) => row.messageRef)).size, name).toBe(5000);
      expect(await read({ limit: 100_000, maxRows: 100_000 }), name).toHaveLength(5000);
      expect(await read({ limit: 5000, maxRows: 3000 }), name).toHaveLength(3000);
      expect(await read({ limit: 2000, maxRows: 5000 }), name).toHaveLength(2000);
      expect(await read({ limit: 100, maxRows: 5000 }), name).toHaveLength(100);
      expect(await read({ maxRows: 5000 }), name).toHaveLength(100);
      // A value that would lower the cap does not: a caller asks for fewer rows with `limit`.
      expect(await read({ limit: 5000, maxRows: 10 }), name).toHaveLength(1500);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
