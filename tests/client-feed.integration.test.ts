import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiFeatureStreamFrameSchema,
  clientBootstrapResponseSchema,
  clientConversationFeedResponseSchema,
  errorResponseSchema,
  type ClientConversationFeedResponse,
} from "@agency_hub_core/contracts";
import {
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAgentKey,
  seedBundledAiPersona,
  setPageOfapiAccountId,
  storeProxyConfig,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { CLIENT_FEED_CURSOR_TTL_MS } from "../apps/runtime/src/services/conversation-feed.ts";
import { frozenFeedPageSchema } from "./helpers/client-feed-frozen.ts";
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

// chat-extension H-9c: GET /api/v1/client/pages/:pageLabel/conversations/:fanRef/feed,
// the archive feed of one conversation. Every test runs under the no-outbound
// trap (critic item 8): the route reads the database and nothing else, so
// nothing leaves the process, no platform request is journaled, no platform
// work is queued and the fixture's unread chat stays unread.

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret", nikita: "nikita-secret" } as const;
const AUDIT = { source: "cli" } as const;
const FAN = "777000777";
const OTHER_FAN = "777000888";
const EXTENSION_VERSION = "chat-extension/1.4.2";
const OFAPI_ACCOUNTS: Record<string, string> = { "lora-of": "acct_feed_lora", "mia-of": "acct_feed_mia" };
/** A live Agent Read Plane key, granted lora-of: its refusal is about the principal kind, not a page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientfeed0000000000`;
/** A media id in the fixture rows: it must never leave through the route. */
const MEDIA_ID = 4242424242;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let ownerToken = "";
let leadToken = "";
/** Narrow chat-extension tokens of two chatters of lora-of. */
let grishaToken = "";
let nikitaToken = "";
/** A full device token of the same chatter (an old client's). */
let grishaFullToken = "";
/** A chatter of mia-of only. */
let svetaToken = "";
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput } = {};

const ago = (ms: number) => new Date(Date.now() - ms);

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.input = input;
      yield { type: "content_delta", text: "a ping" };
      yield {
        type: "usage",
        providerResponseId: "msg_feed",
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

function bearer(token: string, clientVersion: string | null = EXTENSION_VERSION): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(clientVersion === null ? {} : { "x-client-version": clientVersion }) };
}

interface FeedCall {
  pageLabel?: string | undefined;
  fan?: string | undefined;
  /** Query parameters; an undefined one is left out. */
  query?: Record<string, string | number | undefined>;
  clientVersion?: string | null;
}

function feedUrl(input: FeedCall = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return `/api/v1/client/pages/${input.pageLabel ?? "lora-of"}/conversations/${input.fan ?? FAN}/feed${text ? `?${text}` : ""}`;
}

async function feed(token: string, input: FeedCall = {}) {
  return server!.inject({ method: "GET", url: feedUrl(input), headers: bearer(token, input.clientVersion) });
}

/** A 200 whose body is the declared shape, nothing more, and a page the client's frozen schema parses. */
async function feedOk(token: string, input: FeedCall = {}): Promise<ClientConversationFeedResponse> {
  const response = await feed(token, input);
  expect(response.statusCode, response.body).toBe(200);
  const body = clientConversationFeedResponseSchema.parse(response.json());
  // The schema is not strict and would strip a key it does not know: nothing was stripped.
  expect(response.json()).toEqual(body);
  expect(frozenFeedPageSchema.parse(response.json())).toEqual(body);
  // Captions only: no media id ever leaves.
  expect(response.body).not.toContain(String(MEDIA_ID));
  return body;
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
}

function expectCursorRefused(response: InjectResponse) {
  expectRefused(response, 400, "bad_request", "cursor_invalid");
  // One message for every refusal: it never says why.
  expect(response.json<{ message: string }>().message).toBe("cursor is not valid for this request");
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** The owner's switches as a pilot page has them: the extension on, the preview on. */
async function switchPreviewOn() {
  await patchConfig([
    { key: "chatExtensionEnabled", value: true },
    { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { preview: true } }) },
  ]);
}

interface ArchiveSeed {
  ref: string;
  at: Date | null;
  text?: string;
  /** Sent by the page. */
  mine?: boolean;
  role?: string;
  pageLabel?: string;
  fan?: string;
  deleted?: boolean;
  pending?: boolean;
  priceMills?: number | null;
  tipMills?: number;
  media?: Array<Record<string, unknown>>;
}

/** One message_archive row, as the archive projection leaves it. */
async function archiveRow(input: ArchiveSeed) {
  const mine = input.mine === true;
  await testDb!.pool.query(
    `insert into message_archive (
       account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at,
       text_plain, price_mills, is_tip, tip_amount_mills, media_metadata, deleted_at, content_pending, backfill_source
     ) values ($1, 'onlyfans', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, 'seed')`,
    [
      pageIds[input.pageLabel ?? "lora-of"],
      input.fan ?? FAN,
      input.ref,
      input.role ?? (mine ? "model" : "fan"),
      mine,
      input.at,
      input.text ?? `archive ${input.ref}`,
      input.priceMills ?? null,
      input.tipMills !== undefined,
      input.tipMills ?? 0,
      JSON.stringify(input.media ?? []),
      input.deleted ? new Date() : null,
      input.pending ?? false,
    ],
  );
}

/** One dm_message_archive row, as a message webhook leaves it. `fan: null` is a delete webhook's chat-less stub. */
async function dmRow(input: { ref: string; at: Date | null; text?: string; mine?: boolean; fan?: string | null; deleted?: boolean }) {
  const fan = input.fan === undefined ? FAN : input.fan;
  const mine = input.mine === true;
  await testDb!.pool.query(
    `insert into dm_message_archive (
       platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id,
       platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills,
       deleted_at, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until
     ) values (
       'onlyfans', $1, $2, $3, $3, $4, $5::dm_sender_role, $6, $7, $8, false, 0, $9,
       'webhook', $10, $11, 1, now(), now() + interval '100 years'
     )`,
    [
      pageIds["lora-of"],
      OFAPI_ACCOUNTS["lora-of"],
      fan,
      input.ref,
      fan === null ? "unknown" : mine ? "model" : "fan",
      mine,
      input.at,
      input.text ?? `dm ${input.ref}`,
      input.deleted ? new Date() : null,
      input.deleted && fan === null ? "messages.deleted" : mine ? "messages.sent" : "messages.received",
      `feed-${input.ref}-${input.deleted ? "tomb" : "msg"}`,
    ],
  );
}

/** What the chat list knows of the fixture chat's last message. The row exists from the setup: only its time moves. */
async function setThreadLastMessageAt(at: Date | null, fan = FAN) {
  const updated = await testDb!.pool.query(
    "update page_dm_threads set last_message_at = $1 where platform_account_id = $2 and platform_conversation_id = $3",
    [at, pageIds["lora-of"], fan],
  );
  expect(updated.rowCount).toBe(1);
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);
}

/** One Ping generation of the fixture chat through the real route, by a client that advertises `context-v1`. */
async function ping(input: { fan?: string; messageCount?: number } = {}) {
  delete provider.input;
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/ai/features/ping",
    headers: { authorization: `Bearer ${grishaFullToken}`, "x-kernel-ai-capabilities": "context-v1" },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: "lora-of",
      platform: "onlyfans",
      conversationRef: input.fan ?? FAN,
      ...(input.messageCount === undefined ? {} : { messageCount: input.messageCount }),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const streamed = frames(response.body);
  for (const frame of streamed) {
    expect(aiFeatureStreamFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
  }
  const context = streamed.find((frame) => frame.type === "context_v1") as
    | (Frame & {
      source: string;
      coverage: string;
      servedHead: { messageRef: string; occurredAt: string | null; isFromFan: boolean } | null;
      window: { requested: number; served: number };
    })
    | undefined;
  expect(context, response.body).toBeDefined();
  const prompt = provider.input!.body.prompt;
  return {
    context: context!,
    /** Everything the provider was given, as text. */
    prompt: [...prompt.systemBlocks, ...prompt.userBlocks].map((block) => block.text).join("\n"),
  };
}

/** The feed's head in the words of a generation's `context_v1.servedHead`. */
function asServedHead(head: ClientConversationFeedResponse["head"]) {
  return head === null ? null : { messageRef: head.messageRef, occurredAt: head.at, isFromFan: head.sender === "fan" };
}

async function count(table: string): Promise<number> {
  const { rows } = await testDb!.pool.query<{ count: number }>(`select count(*)::int as count from ${table}`);
  return rows[0]!.count;
}

/** Every page of one walk, following the cursor the hub hands out. */
async function walk(token: string, input: {
  limit: number;
  fan?: string;
  between?: (pageIndex: number) => Promise<void>;
}): Promise<ClientConversationFeedResponse[]> {
  const pages: ClientConversationFeedResponse[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await feedOk(token, { fan: input.fan, query: { limit: input.limit, cursor } });
    pages.push(page);
    if (page.nextOlderCursor === null) {
      return pages;
    }
    expect(page.items).toHaveLength(input.limit);
    cursor = page.nextOlderCursor;
    await input.between?.(pages.length);
    if (pages.length > 1000) throw new Error("walk did not terminate");
  }
}

describe("GET /api/v1/client/pages/:pageLabel/conversations/:fanRef/feed", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

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
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    for (const username of ["grisha", "nikita", "sveta"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    const ownerId = await fixtureUserId(app, "owner");
    const leadId = await fixtureUserId(app, "lead");
    const grishaId = await fixtureUserId(app, "grisha");
    const nikitaId = await fixtureUserId(app, "nikita");
    const svetaId = await fixtureUserId(app, "sveta");
    // A chatter is created without a password and sets one later; it ends every
    // sign-in, so it comes before the tokens below.
    await setUserPassword(app, { userId: grishaId, password: PASSWORDS.grisha }, AUDIT);
    await setUserPassword(app, { userId: nikitaId, password: PASSWORDS.nikita }, AUDIT);

    const persona = createBundledPersonalities()[0]!;
    await seedBundledAiPersona(app.db, {
      key: persona.id,
      displayName: persona.name,
      systemBlock: persona.content,
      bundledVersion: persona.builtinVersion!,
    });
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, create] of [
      ["lora-of", createOnlyFansPage],
      ["mia-of", createOnlyFansPage],
      ["lora-fansly", createFanslyPage],
    ] as const) {
      const page = await create(app.db, { modelId: lora!.id, label });
      pageIds[label] = page!.id;
      await storeProxyConfig(app.db, page!.id, {
        url: "socks5://proxy.example:1080",
        encryptedAuth: null,
        keyVersion: null,
        rateLimitScopeKey: "shared-ai-proxy",
      });
    }
    await testDb.pool.query("update pages set external_page_id = '100000001' where id = $1", [pageIds["lora-of"]]);
    await testDb.pool.query("update pages set external_page_id = '100000002' where id = $1", [pageIds["mia-of"]]);
    // dm_message_archive is keyed by the page's OFAPI account.
    for (const [label, ofapiAccountId] of Object.entries(OFAPI_ACCOUNTS)) {
      await setPageOfapiAccountId(app.db, { pageId: pageIds[label]!, ofapiAccountId });
    }
    for (const [userId, labels] of [
      [grishaId, ["lora-of", "lora-fansly"]],
      [nikitaId, ["lora-of"]],
      [leadId, ["lora-of"]],
      [svetaId, ["mia-of"]],
    ] as const) {
      for (const pageLabel of labels) {
        await assignPageToUser(app, { userId, pageLabel }, AUDIT);
      }
    }
    // The fixture chat is unread: reading it through OnlyFans would mark it
    // read there, and the trap holds the count.
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, $2, 3)",
      [pageIds["lora-of"], FAN],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: leadId, label: "lead client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: svetaId, label: "sveta client" })).token;
    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha desktop" })).token;
    await insertAgentKey(app.db, {
      name: "client-feed-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:messages"],
      pageIds: [pageIds["lora-of"]!],
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();

    // The extension's own token: the real password sign-in with `client`.
    for (const username of ["grisha", "nikita"] as const) {
      const signIn = await server.inject({
        method: "POST",
        url: "/api/v1/auth/device-tokens/password",
        headers: { "x-client-version": EXTENSION_VERSION },
        payload: {
          username,
          password: PASSWORDS[username],
          label: "Firefox · macOS · ChatSpace",
          mode: "active",
          client: "chat-extension",
        },
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      expect(signIn.json()).toMatchObject({ client: "chat-extension" });
      if (username === "grisha") {
        grishaToken = signIn.json<{ token: string }>().token;
      } else {
        nikitaToken = signIn.json<{ token: string }>().token;
      }
    }
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
    vi.useRealTimers();
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("is inert at merge: off until the owner switches the preview on, then the owner's switches decide", async (context) => {
    if (!server) return context.skip();
    await archiveRow({ ref: "9001", at: ago(HOUR_MS), text: "ARCHIVED TEXT" });
    const previewFeature = async () => {
      const bootstrap = await server!.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers: bearer(grishaToken) });
      const announced = clientBootstrapResponseSchema.parse(bootstrap.json());
      // The hub serves the preview's one route, and announces the page size it enforces.
      expect(announced.capabilities).toContain("archive-feed-v1");
      expect(announced.limits.feedMax).toBe(100);
      return announced.pages.find((page) => page.pageLabel === "lora-of")?.features.preview;
    };

    // The hub as it rests: nothing is served until the owner says so.
    for (const token of [grishaToken, grishaFullToken, ownerToken]) {
      const refused = await feed(token);
      expectRefused(refused, 409, "client_feature_disabled", "disabled");
      expect(refused.body).not.toContain("ARCHIVED TEXT");
    }
    expect(await previewFeature()).toEqual({ available: false, reason: "disabled" });

    // The extension on, the preview still off.
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expectRefused(await feed(grishaToken), 409, "client_feature_disabled", "flag_off");
    expect(await previewFeature()).toEqual({ available: false, reason: "flag_off" });

    await switchPreviewOn();
    expect(await previewFeature()).toEqual({ available: true });
    expect((await feedOk(grishaToken)).items.map((item) => item.text)).toEqual(["ARCHIVED TEXT"]);
    expectRefused(await feed(grishaToken, { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    // An old client's version, or none, is not the extension: refused, never passed.
    for (const clientVersion of ["chatgoose-extension/2.7.1", "0.1.64", null]) {
      expectRefused(await feed(grishaFullToken, { clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.5.0" }]);
    expectRefused(await feed(grishaToken), 409, "client_feature_disabled", "client_outdated");
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.4.2" }]);
    expect((await feed(grishaToken)).statusCode).toBe(200);

    // The page's own flag wins over "*"; the master switch ends everything.
    await patchConfig([{
      key: "chatExtensionFeatures",
      value: JSON.stringify({ "*": { preview: true }, "lora-of": { preview: false } }),
    }]);
    expectRefused(await feed(grishaToken), 409, "client_feature_disabled", "flag_off");
    await patchConfig([
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { preview: true } }) },
      { key: "chatExtensionEnabled", value: false },
    ]);
    expectRefused(await feed(grishaToken), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serves the conversation as the stores hold it: newest first, deleted rows flagged, money in mills, captions for media", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    const base = Math.floor(Date.now() / 1000) * 1000;
    const at = (hours: number) => new Date(base - hours * HOUR_MS);
    await archiveRow({ ref: "9001", at: at(7), text: "hi there" });
    await archiveRow({ ref: "9002", at: at(6), text: "hey you", mine: true });
    // A tip: OnlyFans sends one number, stored as the price too.
    await archiveRow({ ref: "9003", at: at(5), text: "for you", tipMills: 5000, priceMills: 5000 });
    await archiveRow({
      ref: "9004", at: at(4), text: "", mine: true, priceMills: 15_000,
      media: [{ id: MEDIA_ID, type: "photo", canView: false }],
    });
    await archiveRow({ ref: "9005", at: at(3), text: "said then deleted", deleted: true });
    await archiveRow({
      ref: "9006", at: at(2), text: "look", mine: true, priceMills: 0,
      media: [{ id: MEDIA_ID, type: "photo" }, { id: MEDIA_ID + 1, type: "photo" }, { id: MEDIA_ID + 2, type: "video" }],
    });
    await archiveRow({ ref: "9007", at: null, text: "undated" });
    await archiveRow({ ref: "9008", at: at(1), text: "a system line", role: "system" });
    // Never served: a content-pending stub, another fan's chat, the same fan on another page.
    await archiveRow({ ref: "9009", at: null, text: "", pending: true });
    await archiveRow({ ref: "9100", at: at(0.5), text: "OTHER FAN TEXT", fan: OTHER_FAN });
    await archiveRow({ ref: "9200", at: at(0.5), text: "OTHER PAGE TEXT", pageLabel: "mia-of" });
    const before = { archive: await count("message_archive"), generations: await count("ai_generation_content"), usage: await count("ai_usage_events") };

    const startedAt = Date.now();
    const body = await feedOk(grishaToken);
    const plain = { automatic: null, deleted: false, tipMills: null, priceMills: null, attachmentLabels: [] };
    expect(body.items).toEqual([
      { ...plain, messageId: "9008", at: at(1).toISOString(), sender: "system", text: "a system line" },
      { ...plain, messageId: "9006", at: at(2).toISOString(), sender: "model", text: "look", attachmentLabels: ["[Media Bundle: 2 Photos, 1 Video]"] },
      { ...plain, messageId: "9005", at: at(3).toISOString(), sender: "fan", text: "said then deleted", deleted: true },
      { ...plain, messageId: "9004", at: at(4).toISOString(), sender: "model", text: "", priceMills: 15_000, attachmentLabels: ["[Photo]"] },
      { ...plain, messageId: "9003", at: at(5).toISOString(), sender: "fan", text: "for you", tipMills: 5000 },
      { ...plain, messageId: "9002", at: at(6).toISOString(), sender: "model", text: "hey you" },
      { ...plain, messageId: "9001", at: at(7).toISOString(), sender: "fan", text: "hi there" },
      // A message without a time comes last.
      { ...plain, messageId: "9007", at: null, sender: "fan", text: "undated" },
    ]);
    expect(body).toMatchObject({
      target: { pageLabel: "lora-of", fanRef: FAN },
      source: "archive",
      coverage: "unknown",
      // A generation reads a system line as the fan's; so does the head.
      head: { messageRef: "9008", at: at(1).toISOString(), sender: "fan" },
      newestKnownAt: at(1).toISOString(),
      nextOlderCursor: null,
    });
    expect(body.snapshotRevision).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(body.asOf)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(body.asOf)).toBeLessThanOrEqual(Date.now());

    // Every chatter of the page, the team lead, the owner and an old client's
    // full token read the same conversation.
    for (const token of [nikitaToken, leadToken, ownerToken, grishaFullToken]) {
      const other = await feedOk(token);
      expect(other.items).toEqual(body.items);
      expect(other.head).toEqual(body.head);
      expect(other.snapshotRevision).toBe(body.snapshotRevision);
    }
    // Another fan of the page, and the same fan on another page, are other conversations.
    expect((await feedOk(grishaToken, { fan: OTHER_FAN })).items.map((item) => item.text)).toEqual(["OTHER FAN TEXT"]);
    expect((await feedOk(ownerToken, { pageLabel: "mia-of" })).items.map((item) => item.text)).toEqual(["OTHER PAGE TEXT"]);

    // A read: nothing is written, generated or spent.
    expect({ archive: await count("message_archive"), generations: await count("ai_generation_content"), usage: await count("ai_usage_events") })
      .toEqual(before);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers an empty, a partial and a complete archive for what each is", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();

    // A fan the hub has never seen: an empty feed, and nothing vouched for.
    const unseen = await feedOk(grishaToken, { fan: OTHER_FAN });
    expect(unseen).toMatchObject({
      target: { pageLabel: "lora-of", fanRef: OTHER_FAN },
      source: "archive",
      coverage: "unknown",
      head: null,
      newestKnownAt: null,
      nextOlderCursor: null,
      items: [],
      // What a Ping generation is given for an empty window; `coverage` says how much that is.
      summary: { pingSegment: "segment-b", fanSilenceDays: null, window: { requested: 100, served: 0 }, coverage: "unknown" },
    });
    expect(unseen.summary!.asOf).toBe(unseen.asOf);

    // The chat list knows of a message the stores do not hold yet: still empty,
    // and the feed says how far behind it is.
    const listed = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60_000);
    await setThreadLastMessageAt(listed);
    expect(await feedOk(grishaToken)).toMatchObject({ head: null, newestKnownAt: listed.toISOString(), items: [] });

    const headAt = new Date(listed.getTime() - HOUR_MS);
    await archiveRow({ ref: "9001", at: new Date(headAt.getTime() - HOUR_MS), text: "first" });
    await archiveRow({ ref: "9002", at: headAt, text: "second", mine: true });
    // Behind the chat: the newest known message is later than the head.
    expect(await feedOk(grishaToken)).toMatchObject({
      coverage: "unknown",
      head: { messageRef: "9002", at: headAt.toISOString(), sender: "model" },
      newestKnownAt: listed.toISOString(),
    });
    // Caught up: the chat list names the head itself, or something older.
    for (const known of [headAt, new Date(headAt.getTime() - DAY_MS), null]) {
      await setThreadLastMessageAt(known);
      expect((await feedOk(grishaToken)).newestKnownAt).toBe(headAt.toISOString());
    }

    // The history proof of the capture lane decides the coverage, of the page and of the summary alike.
    const coverage = async (fan = FAN) => {
      const body = await feedOk(grishaToken, { fan });
      expect(body.summary!.coverage).toBe(body.coverage);
      return body.coverage;
    };
    await testDb!.pool.query(
      `insert into ofapi_message_coverage (
         page_id, chat_id, classification, source, frozen_head_id, oldest_message_id, target, target_hash,
         page_chain_hash, raw_count, accepted_count, boundary_duplicate_count, explicitly_irrelevant_count,
         rejected_count, parse_debt, required_serving_high_water, proof_observation_id,
         proof_observation_received_at, proof_policy_version, source_contract_version, parser_version,
         source_account_seq
       ) values ($1, $2, 'continuous_history', 'pagination_exhausted', '9002', '9001', '{}'::jsonb, $3, $4,
         2, 2, 0, 0, 0, 0, 2, 1, now(), $5, 'ofapi-capture-v1', 'ofapi-capture-parser-v1', 1)`,
      [pageIds["lora-of"], FAN, "a".repeat(64), "b".repeat(64), OFAPI_CAPTURE_PROOF_POLICY_VERSION],
    );
    // The archive has not projected what the proof covers yet.
    expect(await coverage()).toBe("partial");
    await testDb!.pool.query(
      "insert into projection_seq_watermarks (projection, account_id, high_seq) values ('message_archive', $1, 2)",
      [pageIds["lora-of"]],
    );
    expect(await coverage()).toBe("complete");
    // The same word a generation's context frame uses for the same chat.
    expect((await ping()).context.coverage).toBe("complete");
    // Another fan's proof is not this fan's.
    expect(await coverage(OTHER_FAN)).toBe("unknown");
    await testDb!.pool.query("update ofapi_message_coverage set revoked_at = now() where page_id = $1", [pageIds["lora-of"]]);
    expect(await coverage()).toBe("unknown");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts the Ping summary by the generation's own rule: the same last date, one fan text or three, is segment B or A", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    const days = (count: number, minutes = 0) => ago(count * DAY_MS + HOUR_MS + minutes * 60_000);
    // FAN: three text messages of the fan, the last 10 days ago; then only the page wrote.
    await archiveRow({ ref: "9001", at: days(30), text: "hi" });
    await archiveRow({ ref: "9002", at: days(20), text: "how are you" });
    await archiveRow({ ref: "9003", at: days(10), text: "busy week" });
    // Not text: a tip and a photo of the fan, both newer. Neither moves the silence.
    await archiveRow({ ref: "9004", at: days(9), text: "", tipMills: 5000, priceMills: 5000 });
    await archiveRow({ ref: "9005", at: days(8), text: "", media: [{ id: MEDIA_ID, type: "photo" }] });
    for (let index = 0; index < 6; index += 1) {
      await archiveRow({ ref: String(9010 + index), at: days(7, -index), text: `miss you ${index}`, mine: true });
    }
    // OTHER_FAN: the same dates, one text message of the fan.
    await archiveRow({ ref: "9101", at: days(10), text: "busy week", fan: OTHER_FAN });
    await archiveRow({ ref: "9110", at: days(7), text: "miss you", fan: OTHER_FAN, mine: true });

    const three = await feedOk(grishaToken);
    const one = await feedOk(grishaToken, { fan: OTHER_FAN });
    expect(three.summary).toMatchObject({ pingSegment: "segment-a", fanSilenceDays: 10, window: { requested: 100, served: 11 } });
    expect(one.summary).toMatchObject({ pingSegment: "segment-b", fanSilenceDays: 10, window: { requested: 100, served: 2 } });
    // The summary is counted at the answer's own instant.
    expect(three.summary!.asOf).toBe(three.asOf);

    // A Ping generation of the same chat is given the same segment and silence, and read the same head.
    const generated = await ping();
    expect(generated.prompt).toContain("Fan silence: the fan's last message was 10 days ago.");
    expect(generated.prompt).toContain("Segment A.");
    expect(generated.context).toMatchObject({ source: three.source, servedHead: asServedHead(three.head) });
    const generatedOne = await ping({ fan: OTHER_FAN });
    expect(generatedOne.prompt).toContain("Fan silence: the fan's last message was 10 days ago.");
    expect(generatedOne.prompt).toContain("Segment B.");

    // The window is the caller's: the newest six messages are the page's own.
    const narrow = await feedOk(grishaToken, { query: { summaryWindow: 6 } });
    expect(narrow.summary).toMatchObject({ pingSegment: "segment-b", fanSilenceDays: null, window: { requested: 6, served: 6 } });
    // The head does not depend on the window, nor on the page size.
    expect(narrow.head).toEqual(three.head);
    expect((await feedOk(grishaToken, { query: { limit: 1 } })).head).toEqual(three.head);

    // A fan who wrote inside the last five days is active.
    await archiveRow({ ref: "9020", at: ago(2 * DAY_MS + HOUR_MS), text: "back" });
    const active = await feedOk(grishaToken);
    expect(active.summary).toMatchObject({ pingSegment: "active", fanSilenceDays: 2 });
    expect(active.head).toMatchObject({ messageRef: "9020", sender: "fan" });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("follows the generation's reader switch: off, shadow and serve give a head and a summary from one reader, the generation's servedHead", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    const archiveHeadAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 12 * DAY_MS - HOUR_MS);
    await archiveRow({ ref: "9001", at: new Date(archiveHeadAt.getTime() - 2 * DAY_MS), text: "hi" });
    await archiveRow({ ref: "9002", at: new Date(archiveHeadAt.getTime() - DAY_MS), text: "how are you" });
    await archiveRow({ ref: "9003", at: archiveHeadAt, text: "busy week" });
    // Only the webhook store has these yet: the fan wrote an hour ago, and an
    // older message of his was deleted on the platform (the webhook names no chat).
    const freshAt = new Date(Math.floor(Date.now() / 1000) * 1000 - HOUR_MS);
    await dmRow({ ref: "9004", at: freshAt, text: "are you there?" });
    await dmRow({ ref: "9002", at: null, fan: null, deleted: true });

    const fromArchive = {
      source: "archive",
      head: { messageRef: "9003", at: archiveHeadAt.toISOString(), sender: "fan" },
      summary: { pingSegment: "segment-a", fanSilenceDays: 12, window: { requested: 100, served: 3 } },
    };
    const fromUnion = {
      source: "union",
      head: { messageRef: "9004", at: freshAt.toISOString(), sender: "fan" },
      // The deleted message is in no transcript: two of the fan's texts and the fresh one.
      summary: { pingSegment: "active", fanSilenceDays: 0, window: { requested: 100, served: 3 } },
    };
    const revisions = new Set<string>();
    // The owner's live switch, stepped the only way it moves: off → shadow → serve → off.
    for (const [mode, expected] of [
      [null, fromArchive], ["shadow", fromArchive], ["serve", fromUnion], ["off", fromArchive],
    ] as const) {
      if (mode !== null) {
        await patchConfig([{ key: "aiTranscriptFreshUnionMode", value: mode }]);
      }
      const body = await feedOk(grishaToken);
      expect(body, String(mode)).toMatchObject(expected);
      expect(body.newestKnownAt, String(mode)).toBe(expected.head.at);
      expect(body.items.map((item) => [item.messageId, item.deleted]), String(mode)).toEqual(
        expected.source === "union"
          ? [["9004", false], ["9003", false], ["9002", true], ["9001", false]]
          : [["9003", false], ["9002", false], ["9001", false]],
      );
      // One snapshot, one head: a generation served right now reports this reader and this head.
      const generated = await ping();
      expect(generated.context, String(mode)).toMatchObject({
        source: body.source,
        servedHead: asServedHead(body.head),
        window: { served: body.summary!.window.served },
      });
      revisions.add(`${body.source}:${body.snapshotRevision}`);
    }
    // The two readers never share a snapshot's name.
    expect(revisions.size).toBe(2);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it.for(["archive", "union"] as const)("%s: walks 3200 messages by 100 without a hole or a duplicate while messages arrive and get deleted", { timeout: 180_000 }, async (source, context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    if (source === "union") {
      app.config.aiTranscriptFreshUnionMode = "serve";
    }
    const total = 3200;
    const ref = (g: number) => String(1_000_000 + g);
    const base = new Date(Math.floor(Date.now() / 1000) * 1000 - 40 * DAY_MS);
    // Time grows with g, so the walk visits g = 3200 … 1. In the union the
    // archive holds 1..3000 and the webhook store 2801..3200.
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select $1, 'onlyfans', $2, (1000000 + g)::text, case when g % 2 = 0 then 'model' else 'fan' end, g % 2 = 0,
              $3::timestamptz + (g || ' seconds')::interval, 'archive ' || g, 'seed'
       from generate_series(1, $4::int) g`,
      [pageIds["lora-of"], FAN, base, source === "union" ? 3000 : total],
    );
    if (source === "union") {
      await testDb!.pool.query(
        `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
         select 'onlyfans', $1, $2, $3, $3, (1000000 + g)::text, (case when g % 2 = 0 then 'model' else 'fan' end)::dm_sender_role, g % 2 = 0,
                $4::timestamptz + (g || ' seconds')::interval, 'dm ' || g, false, 0, 'webhook', 'messages.received', 'walk-' || g, 1, now(), now() + interval '100 years'
         from generate_series(2801, $5::int) g`,
        [pageIds["lora-of"], OFAPI_ACCOUNTS["lora-of"], FAN, base, total],
      );
    }
    const deleteMessage = async (messageRef: string) => {
      if (source === "archive") {
        await testDb!.pool.query(
          "update message_archive set deleted_at = now() where account_id = $1 and message_ref = $2 and deleted_at is null",
          [pageIds["lora-of"], messageRef],
        );
        return;
      }
      // The webhook store: in place when it holds the message, otherwise the
      // chat-less stub a delete webhook leaves.
      const updated = await testDb!.pool.query(
        "update dm_message_archive set deleted_at = now() where platform_account_id = $1 and platform_message_id = $2",
        [pageIds["lora-of"], messageRef],
      );
      if (updated.rowCount === 0) {
        await dmRow({ ref: messageRef, at: null, fan: null, deleted: true });
      }
    };
    // Deleted before the walk starts; the newest message of all is one of them.
    const deletedBefore = new Set([500, 1500, 2900, 3100, total].map(ref));
    for (const deleted of deletedBefore) {
      await deleteMessage(deleted);
    }

    const deletedAhead = new Set<string>();
    const intruders = new Set<string>();
    const at = (seconds: number) => new Date(base.getTime() + seconds * 1000);
    const pages = await walk(grishaToken, {
      limit: 100,
      between: async (pageIndex) => {
        // The webhook, projection and backfill workers, running beside the walk:
        // a new message, a late backfill of an old one, and deletions.
        const arrival = `20${String(pageIndex).padStart(5, "0")}`;
        const backfill = `90${String(pageIndex).padStart(5, "0")}`;
        intruders.add(arrival).add(backfill);
        await archiveRow({ ref: arrival, at: at(10_000 + pageIndex) });
        await archiveRow({ ref: backfill, at: at(-pageIndex) });
        if (source === "union") {
          const dmArrival = `30${String(pageIndex).padStart(5, "0")}`;
          intruders.add(dmArrival);
          await dmRow({ ref: dmArrival, at: at(10_000 + pageIndex) });
        }
        const cursorG = total - pageIndex * 100;
        const ahead = cursorG - 50;
        if (ahead >= 1) {
          deletedAhead.add(ref(ahead));
          await deleteMessage(ref(ahead));
        }
        // Already served: deleting it must not bring it back.
        await deleteMessage(ref(cursorG + 50));
        // The chat list hears of the new message: the walk keeps the time it started with.
        await setThreadLastMessageAt(at(10_000 + pageIndex));
      },
    });

    expect(pages).toHaveLength(total / 100);
    const items = pages.flatMap((page) => page.items);
    const refs = items.map((item) => item.messageId);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual(Array.from({ length: total }, (_unused, index) => ref(total - index)));
    expect(refs.filter((visited) => intruders.has(visited))).toEqual([]);
    expect(new Set(items.filter((item) => item.deleted).map((item) => item.messageId)))
      .toEqual(new Set([...deletedBefore, ...deletedAhead]));

    // One walk, one snapshot: every page repeats what the first one learned.
    const first = pages[0]!;
    expect(first.source).toBe(source);
    // The newest message was deleted: the head is the newest LIVE one.
    expect(first.items[0]).toMatchObject({ messageId: ref(total), deleted: true });
    expect(first.head).toEqual({ messageRef: ref(total - 1), at: at(total - 1).toISOString(), sender: "fan" });
    expect(first.summary).toMatchObject({ window: { requested: 100, served: 100 } });
    for (const page of pages.slice(1)) {
      expect(page.summary).toBeNull();
      expect({
        source: page.source, snapshotRevision: page.snapshotRevision, asOf: page.asOf, coverage: page.coverage,
        head: page.head, newestKnownAt: page.newestKnownAt, target: page.target,
      }).toEqual({
        source: first.source, snapshotRevision: first.snapshotRevision, asOf: first.asOf, coverage: first.coverage,
        head: first.head, newestKnownAt: first.newestKnownAt, target: first.target,
      });
    }

    expect(first.newestKnownAt).toBe(first.head!.at);

    // The next walk from the first page has what arrived meanwhile.
    const next = await feedOk(grishaToken, { query: { limit: 3 } });
    expect(next.snapshotRevision).not.toBe(first.snapshotRevision);
    expect(intruders.has(next.items[0]!.messageId)).toBe(true);
    expect(next.head!.messageRef).toBe(next.items[0]!.messageId);
    expect(next.newestKnownAt).toBe(at(10_000 + pages.length - 1).toISOString());

    await trap!.assertNoOutbound();
  });

  it("binds a cursor to its page, fan, person, reader and archive generation; anything else reads cursor_invalid", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    for (let index = 1; index <= 7; index += 1) {
      await archiveRow({ ref: String(9000 + index), at: ago((10 - index) * HOUR_MS), text: `FEED TEXT ${index}`, mine: index % 2 === 0 });
      await archiveRow({ ref: String(9100 + index), at: ago((10 - index) * HOUR_MS), fan: OTHER_FAN });
      await archiveRow({ ref: String(9200 + index), at: ago((10 - index) * HOUR_MS), pageLabel: "mia-of" });
    }

    const first = await feedOk(grishaToken, { query: { limit: 2 } });
    expect(first.items.map((item) => item.messageId)).toEqual(["9007", "9006"]);
    const cursor = first.nextOlderCursor!;
    // Opaque: the token names the position in the feed and nothing internal.
    const signed = Buffer.from(cursor, "base64url").toString("utf8");
    expect(signed).toContain("9006");
    expect(signed).not.toMatch(/pageId|userId|fanRef|archiveGeneration/);
    expect(signed).not.toContain(FAN);

    // The walk goes on; the page size may change, a summary window is not read on a later page.
    const second = await feedOk(grishaToken, { query: { cursor, limit: 3, summaryWindow: 5 } });
    expect(second.items.map((item) => item.messageId)).toEqual(["9005", "9004", "9003"]);
    expect(second.summary).toBeNull();
    expect(second.snapshotRevision).toBe(first.snapshotRevision);
    // Bound to the person, not to the token: the same chatter's other client continues the walk.
    expect((await feedOk(grishaFullToken, { query: { cursor, limit: 3 } })).items).toEqual(second.items);
    // A cursor is not consumed: the same page reads the same.
    expect((await feedOk(grishaToken, { query: { cursor, limit: 3 } })).items).toEqual(second.items);
    const last = await feedOk(grishaToken, { query: { cursor: second.nextOlderCursor!, limit: 100 } });
    expect(last.items.map((item) => item.messageId)).toEqual(["9002", "9001"]);
    expect(last.nextOlderCursor).toBeNull();

    // Not a cursor of this hub: cut, altered, or made up.
    const flipped = `${cursor.slice(0, 40)}${cursor[40] === "A" ? "B" : "A"}${cursor.slice(41)}`;
    for (const forged of [cursor.slice(0, -1), `${cursor}A`, flipped, "not-a-cursor", "e30", "c".repeat(2048)]) {
      expectCursorRefused(await feed(grishaToken, { query: { cursor: forged } }));
    }
    // Another fan of the page, another page, another person.
    expectCursorRefused(await feed(grishaToken, { fan: OTHER_FAN, query: { cursor } }));
    const ownerCursor = (await feedOk(ownerToken, { query: { limit: 2 } })).nextOlderCursor!;
    expect((await feed(ownerToken, { query: { cursor: ownerCursor } })).statusCode).toBe(200);
    expectCursorRefused(await feed(ownerToken, { pageLabel: "mia-of", query: { cursor: ownerCursor } }));
    for (const token of [nikitaToken, leadToken, ownerToken]) {
      const refused = await feed(token, { query: { cursor } });
      expectCursorRefused(refused);
      expect(refused.body).not.toContain("FEED TEXT");
    }

    // The owner moves the reader: a walk does not change readers midway.
    app.config.aiTranscriptFreshUnionMode = "serve";
    expectCursorRefused(await feed(grishaToken, { query: { cursor } }));
    const unionFirst = await feedOk(grishaToken, { query: { limit: 2 } });
    expect(unionFirst.source).toBe("union");
    app.config.aiTranscriptFreshUnionMode = "off";
    expectCursorRefused(await feed(grishaToken, { query: { cursor: unionFirst.nextOlderCursor! } }));
    expect((await feed(grishaToken, { query: { cursor } })).statusCode).toBe(200);

    // The archive was rebuilt: its row ids now name other rows, and every cursor from before is refused.
    await testDb!.pool.query(
      `insert into archive_generation (id, generation, reason) values (1, 1, 'test rebuild')
       on conflict (id) do update set generation = archive_generation.generation + 1`,
    );
    expectCursorRefused(await feed(grishaToken, { query: { cursor } }));
    const rebuilt = await feedOk(grishaToken, { query: { limit: 2 } });
    expect(rebuilt.snapshotRevision).not.toBe(first.snapshotRevision);
    expect((await feed(grishaToken, { query: { cursor: rebuilt.nextOlderCursor! } })).statusCode).toBe(200);

    // A walk does not go on for days: the cursor lives a day.
    const issuedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: issuedAt });
    const fresh = (await feedOk(grishaToken, { query: { limit: 2 } })).nextOlderCursor!;
    vi.setSystemTime(issuedAt + CLIENT_FEED_CURSOR_TTL_MS - 60_000);
    expect((await feed(grishaToken, { query: { cursor: fresh } })).statusCode).toBe(200);
    vi.setSystemTime(issuedAt + CLIENT_FEED_CURSOR_TTL_MS + 60_000);
    expectCursorRefused(await feed(grishaToken, { query: { cursor: fresh } }));
    // The answer to a refused cursor: the first page again.
    expect((await feedOk(grishaToken, { query: { limit: 2 } })).items.map((item) => item.messageId)).toEqual(["9007", "9006"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes; another page's conversation is never served", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    await archiveRow({ ref: "9001", at: ago(HOUR_MS), text: "LORA TEXT" });
    await archiveRow({ ref: "9201", at: ago(HOUR_MS), text: "MIA TEXT", pageLabel: "mia-of" });

    const cookieOf = async (username: "owner" | "lead" | "grisha") => {
      const login = await server!.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username, password: PASSWORDS[username] },
      });
      expect(login.statusCode, login.body).toBe(200);
      const header = login.headers["set-cookie"];
      return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    };
    const version = { "x-client-version": EXTENSION_VERSION };
    const cells: Array<{ who: string; headers: Record<string, string>; page?: string; status: number }> = [
      { who: "anonymous", headers: {}, status: 401 },
      { who: "unknown bearer", headers: { authorization: "Bearer agency_hub_device_not-a-real-token" }, status: 401 },
      { who: "owner cookie", headers: { cookie: await cookieOf("owner") }, status: 403 },
      { who: "team_lead cookie", headers: { cookie: await cookieOf("lead") }, status: 403 },
      { who: "chatter cookie", headers: { cookie: await cookieOf("grisha") }, status: 403 },
      // Live and granted lora-of: refused by kind.
      { who: "agent key", headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` }, status: 403 },
      { who: "owner device token", headers: bearer(ownerToken), status: 200 },
      // The owner is granted every page.
      { who: "owner device token, mia-of", headers: bearer(ownerToken), page: "mia-of", status: 200 },
      { who: "team_lead device token", headers: bearer(leadToken), status: 200 },
      { who: "chatter device token", headers: bearer(grishaFullToken), status: 200 },
      { who: "chatter chat-extension token", headers: bearer(grishaToken), status: 200 },
    ];

    for (const mode of ["log", "enforce"] as const) {
      app.config.authPolicyEnforcement = mode;
      for (const cell of cells) {
        const label = `${mode} mode, ${cell.who}`;
        const response = await server.inject({
          method: "GET",
          url: feedUrl({ pageLabel: cell.page }),
          headers: { ...version, ...cell.headers },
        });
        expect(response.statusCode, `${label}: ${response.body}`).toBe(cell.status);
        if (cell.status === 200) {
          const texts = clientConversationFeedResponseSchema.parse(response.json()).items.map((item) => item.text);
          expect(texts, label).toEqual([cell.page === "mia-of" ? "MIA TEXT" : "LORA TEXT"]);
          continue;
        }
        // Every refusal is the declared error body, and none carries a message.
        const error = errorResponseSchema.parse(response.json());
        expect(error.error, label).toBe(cell.status === 401 ? "unauthorized" : "forbidden");
        expect(response.body, label).not.toContain("TEXT");
      }

      // A page that is not the caller's, and one that does not exist. Enforced,
      // the declared page scope answers before the handler (403, 404); in log
      // mode the hub's own feature check answers both the same.
      for (const token of [grishaToken, grishaFullToken, leadToken]) {
        const foreign = await feed(token, { pageLabel: "mia-of" });
        const missing = await feed(token, { pageLabel: "ghost-of" });
        if (mode === "enforce") {
          expectRefused(foreign, 403, "forbidden");
          expectRefused(missing, 404, "not_found");
        } else {
          expectRefused(foreign, 409, "client_feature_disabled", "not_granted");
          expectRefused(missing, 409, "client_feature_disabled", "not_granted");
        }
        expect(foreign.body).not.toContain("TEXT");
      }
      // The page's own chatter still reads it.
      expect((await feedOk(svetaToken, { pageLabel: "mia-of" })).items.map((item) => item.text)).toEqual(["MIA TEXT"]);
      expectRefused(await feed(svetaToken), mode === "enforce" ? 403 : 409,
        mode === "enforce" ? "forbidden" : "client_feature_disabled",
        mode === "enforce" ? undefined : "not_granted");
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a malformed request: the fan id's one shape, a strict query, bounded limits", async (context) => {
    if (!server) return context.skip();
    await switchPreviewOn();
    await archiveRow({ ref: "9001", at: ago(HOUR_MS), text: "ARCHIVED TEXT" });

    for (const [fan, query] of [
      ["0777", {}],
      ["group-777", {}],
      ["7".repeat(31), {}],
      [FAN, { limit: 0 }],
      [FAN, { limit: 101 }],
      [FAN, { limit: "ten" }],
      [FAN, { summaryWindow: 4 }],
      [FAN, { summaryWindow: 1501 }],
      // The deep read is the full Recap's alone (critic item 15).
      [FAN, { summaryWindow: 3000 }],
      [FAN, { cursor: "c".repeat(2049) }],
      // The page and the fan are the path's; naming them in the query is refused, not ignored.
      [FAN, { pageLabel: "mia-of" }],
      [FAN, { fanRef: OTHER_FAN }],
      [FAN, { conversationRef: OTHER_FAN }],
      [FAN, { userId: 1 }],
      [FAN, { offset: 50 }],
    ] as const) {
      const response = await feed(grishaToken, { fan, query });
      const label = `${fan} ${JSON.stringify(query)}`;
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(errorResponseSchema.safeParse(response.json()).success, label).toBe(true);
      expect(response.body, label).not.toContain("ARCHIVED TEXT");
    }
    // The bounds themselves are served.
    expect((await feedOk(grishaToken, { query: { limit: 1, summaryWindow: 5 } })).summary!.window.requested).toBe(5);
    expect((await feedOk(grishaToken, { query: { limit: 100, summaryWindow: 1500 } })).summary!.window.requested).toBe(1500);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
