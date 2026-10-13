import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiFeatureStreamFrameSchema,
  clientBootstrapResponseSchema,
  clientConversationFeedResponseSchema,
  clientConversationRecapsResponseSchema,
  clientFanProfileFromGenerationResponseSchema,
  errorResponseSchema,
  type ClientConversationFeedResponse,
  type ClientConversationRecapsResponse,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAiGenerationContent,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import type * as ClientFeaturesModule from "../apps/runtime/src/services/client-features.ts";
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

// chat-extension R20 HF-10: the reads by conversation, through the real routes.
// The shared recaps read, the dossier save from a generation and the archive
// feed name one conversation of one fan. On OnlyFans the chat id IS the fan id;
// on Fansly a chat is a group with an id of its own, which a client that sees
// `conversation-recaps-v1` names as `conversationRef` beside the fan in the
// path. The hub checks the pair against the page's capture (`page_dm_threads`)
// before it reads, and never returns what is stored about another fan.
//
// Every test runs under the no-outbound trap: these routes read the database,
// and the generations below are answered by a stand-in provider.

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// THE HF-2 STAND-IN. At merge `recap` and `preview` exist on OnlyFans only
// (CLIENT_FEATURE_REQUIREMENTS), so every Fansly read here is
// `platform_unsupported` whatever the owner's switches say: that is the first
// test below. R20 HF-2 puts Fansly in the requirements. Until it does, the
// Fansly tests admit the two flags on Fansly the way it will (the rest of the
// evaluation unchanged: the master switch, the page's flag, the binding, the
// served capabilities), so the routes run end to end on a Fansly page.
const hf2 = vi.hoisted(() => ({ admitsFansly: false }));
vi.mock("../apps/runtime/src/services/client-features.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientFeaturesModule>();
  const flags = new Set<string>(["recap", "preview"]);
  const platforms = new Set<string>(["fansly"]);
  const admitted = (flag: string, platform: string) => hf2.admitsFansly && flags.has(flag) && platforms.has(platform);
  return {
    ...actual,
    clientFeatureExistsOn: (flag: Parameters<typeof actual.clientFeatureExistsOn>[0], platform: Parameters<typeof actual.clientFeatureExistsOn>[1]) =>
      admitted(flag, platform) || actual.clientFeatureExistsOn(flag, platform),
    evaluateClientFeature: (input: Parameters<typeof actual.evaluateClientFeature>[0]) => actual.evaluateClientFeature(
      admitted(input.flag, input.page.platform) ? { ...input, page: { ...input.page, platform: "onlyfans" } } : input,
    ),
  };
});

const PASSWORDS = { owner: "owner-secret", grisha: "grisha-secret", nikita: "nikita-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
const OLD_FANSLY_VERSION = "chatgoose-extension/2.10.1";
/** In every seeded generation's prompt blocks: must never leave through a route. */
const PROMPT_SECRET = "PROMPT_BLOCK_SECRET";

// OnlyFans: the chat id is the fan id.
const OF_FAN = "777000777";
const OF_OTHER_FAN = "777000888";
// Fansly ids are 18-digit snowflakes, past 2^53: `Number(FAN) === Number(OTHER_FAN)`,
// so only an exact string comparison tells them apart. Each fan has a group of its own.
const GROUP = "650000000000000001";
const OTHER_GROUP = "650000000000000002";
/** A group the page's capture does not hold yet. */
const NEW_GROUP = "650000000000000009";
const FAN = "700000000000000001";
const OTHER_FAN = "700000000000000002";
/** The archived chat of FAN in GROUP: enough for a full Recap (30). */
const CHAT_MESSAGES = 40;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
/** The chat extension's narrow tokens of two chatters of both pages. */
let grishaToken = "";
let nikitaToken = "";
/** A full device token of the same chatter: the released Fansly extension's and the desktop's. */
let grishaFullToken = "";
let grishaId = 0;
let personaDefinitionId = "";
const pageIds: Record<string, number> = {};

/** What the stand-in provider streams next. */
const script = { text: "" };
const providerCapture: { input?: AiGatewayProviderInput } = {};

function scriptedProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      providerCapture.input = input;
      yield { type: "content_delta", text: script.text };
      yield {
        type: "usage",
        providerResponseId: "msg_conversation_reads",
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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function bearer(token: string, clientVersion: string | null = EXTENSION_VERSION): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(clientVersion === null ? {} : { "x-client-version": clientVersion }) };
}

function query(values: Record<string, string | number | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
}

interface ReadInput {
  page?: string | undefined;
  fan?: string | undefined;
  conversationRef?: string | undefined;
  token?: string | undefined;
}

async function recaps(input: ReadInput & { personaDefinitionId?: string } = {}) {
  return server!.inject({
    method: "GET",
    url: `/api/v1/client/pages/${input.page ?? "lora-fansly"}/conversations/${input.fan ?? FAN}/recaps`
      + query({ conversationRef: input.conversationRef, personaDefinitionId: input.personaDefinitionId }),
    headers: bearer(input.token ?? grishaToken),
  });
}

/** A 200 whose body is the declared shape and nothing more. */
async function recapsOk(input: Parameters<typeof recaps>[0] = {}): Promise<ClientConversationRecapsResponse> {
  const response = await recaps(input);
  expect(response.statusCode, response.body).toBe(200);
  const body = clientConversationRecapsResponseSchema.parse(response.json());
  expect(response.json()).toEqual(body);
  expect(response.body).not.toContain(PROMPT_SECRET);
  return body;
}

async function feed(input: ReadInput & { cursor?: string; limit?: number } = {}) {
  return server!.inject({
    method: "GET",
    url: `/api/v1/client/pages/${input.page ?? "lora-fansly"}/conversations/${input.fan ?? FAN}/feed`
      + query({ conversationRef: input.conversationRef, cursor: input.cursor, limit: input.limit }),
    headers: bearer(input.token ?? grishaToken),
  });
}

async function feedOk(input: Parameters<typeof feed>[0] = {}): Promise<ClientConversationFeedResponse> {
  const response = await feed(input);
  expect(response.statusCode, response.body).toBe(200);
  const body = clientConversationFeedResponseSchema.parse(response.json());
  expect(response.json()).toEqual(body);
  return body;
}

async function save(input: ReadInput & { generationRef: string; clientRequestId?: string }) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/client/pages/${input.page ?? "lora-fansly"}/fans/${input.fan ?? FAN}/profile/from-generation`,
    headers: bearer(input.token ?? grishaToken),
    payload: {
      generationRef: input.generationRef,
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
      ...(input.conversationRef === undefined ? {} : { conversationRef: input.conversationRef }),
    },
  });
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
  expect(response.body).not.toContain(PROMPT_SECRET);
}

/** 409 conversation_fan_mismatch, naming none of the ids the hub holds. */
function expectMismatch(response: InjectResponse) {
  expectRefused(response, 409, "conversation_fan_mismatch");
  for (const id of [FAN, OTHER_FAN, GROUP, OTHER_GROUP, OF_FAN, OF_OTHER_FAN]) {
    expect(response.body).not.toContain(id);
  }
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

/** The owner's switches: the extension on, Recap and the preview on every page. */
async function switchReadsOn() {
  await patchConfig([
    { key: "chatExtensionEnabled", value: true },
    { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { recap: true, preview: true } }) },
  ]);
}

/**
 * One stored recap, as the gateway writes a fan-summary: featureParams at the
 * top level of `params`. Grisha's unless `userId` says otherwise.
 */
async function seedRecap(input: {
  text: string;
  at: Date;
  conversationRef: string;
  fanRef: string | null;
  mode?: "full" | "short";
  page?: string;
  userId?: number | null;
}): Promise<string> {
  const generationRef = randomUUID();
  await insertAiGenerationContent(app.db, {
    usageEventId: null,
    generationRef,
    feature: "fan-summary",
    model: "m",
    provider: "anthropic",
    userId: input.userId === undefined ? grishaId : input.userId,
    pageId: pageIds[input.page ?? "lora-fansly"]!,
    conversationRef: input.conversationRef,
    fanRef: input.fanRef,
    promptBlocks: [{ type: "text", text: PROMPT_SECRET }],
    completion: input.text,
    params: {
      summaryMode: input.mode ?? "full",
      personaDefinitionId,
      outcome: "completed",
      stopReason: "end_turn",
    },
  });
  // insertAiGenerationContent has no createdAt input; recency decides the slot.
  await testDb!.pool.query(
    "update ai_generation_content set created_at = $1 where generation_ref = $2",
    [input.at.toISOString(), generationRef],
  );
  return generationRef;
}

/** The page's thread of a group, as the Fansly Sync Engine captures it. */
async function thread(group: string, fan: string | null) {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, unread_count)
     values ($1, $2, $3, 2)`,
    [pageIds["lora-fansly"], group, fan],
  );
}

/** `count` archived messages of a chat, the newest an hour ago, every other one the fan's. */
async function archive(input: { page: string; platform: string; conversationRef: string; fan: string; count: number; prefix: string }) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
     select $1, $2, $3, $4::text || g::text, case when g % 2 = 1 then $5::text end, g % 2 = 0,
            now() - (g || ' hours')::interval, $4::text || ' message ' || g::text, false, 0
     from generate_series(1, $6::int) g`,
    [pageIds[input.page], input.platform, input.conversationRef, input.prefix, input.fan, input.count],
  );
}

/** Every dossier version of the fan on the page, oldest first. */
async function dossier(fan: string, page = "lora-fansly"): Promise<Array<{ version: number; body: string }>> {
  const { rows } = await testDb!.pool.query<{ version: number; body: string }>(
    `select p.version, p.body from fan_profiles p join fans f on f.id = p.fan_id
     where p.platform_account_id = $1 and f.platform_user_id = $2 order by p.version`,
    [pageIds[page], fan],
  );
  return rows;
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => aiFeatureStreamFrameSchema.parse(JSON.parse(line.slice("data: ".length))) as Frame);
}

/** One AI request on lora-fansly; returns the generation's ref and the prompt the provider was given. */
async function generate(input: {
  feature: string;
  token: string;
  clientVersion?: string;
  clientRequestId?: string;
  capabilities?: string;
  body: Record<string, unknown>;
}) {
  delete providerCapture.input;
  const response = await server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature}`,
    headers: {
      ...bearer(input.token, input.clientVersion ?? EXTENSION_VERSION),
      ...(input.capabilities === undefined ? {} : { "x-kernel-ai-capabilities": input.capabilities }),
    },
    payload: {
      clientRequestId: input.clientRequestId ?? randomUUID(),
      pageLabel: "lora-fansly",
      platform: "fansly",
      ...input.body,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const all = frames(response.body);
  expect(all.at(-1)).toMatchObject({ type: "done" });
  const generationRef = (all[0] as { requestId: string }).requestId;
  const { rows: [record] } = await testDb!.pool.query<{
    conversation_ref: string;
    fan_ref: string | null;
    params: { contextManifest?: Record<string, unknown> };
  }>("select conversation_ref, fan_ref, params from ai_generation_content where generation_ref = $1", [generationRef]);
  // Read through a widened type: the `delete` above narrows the field to undefined.
  const captured = providerCapture.input as AiGatewayProviderInput | undefined;
  return { generationRef, record: record!, prompt: JSON.stringify(captured?.body) };
}

describe("reads by conversation (chat-extension R20 HF-10)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    hf2.admitsFansly = false;
    await resetIntegrationDatabase(testDb.pool);
    script.text = "";
    app = createTestAppContext(testDb);
    app.config.chatMuseAiGatewayEnabled = true;
    app.aiGatewayProvider = scriptedProvider();

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    for (const username of ["grisha", "nikita"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    grishaId = await fixtureUserId(app, "grisha");
    const nikitaId = await fixtureUserId(app, "nikita");
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
    for (const [label, create, account] of [
      ["lora-of", createOnlyFansPage, "100000001"],
      ["lora-fansly", createFanslyPage, "200000000000000001"],
    ] as const) {
      const page = await create(app.db, { modelId: lora!.id, label });
      pageIds[label] = page!.id;
      await storeProxyConfig(app.db, page!.id, {
        url: "socks5://proxy.example:1080",
        encryptedAuth: null,
        keyVersion: null,
        rateLimitScopeKey: "shared-ai-proxy",
      });
      await testDb.pool.query("update pages set external_page_id = $1 where id = $2", [account, page!.id]);
      for (const userId of [grishaId, nikitaId]) {
        await assignPageToUser(app, { userId, pageLabel: label }, AUDIT);
      }
    }

    // OnlyFans: the fan's chat, keyed by the fan.
    await archive({ page: "lora-of", platform: "onlyfans", conversationRef: OF_FAN, fan: OF_FAN, count: 5, prefix: "9" });
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, $2, 3)",
      [pageIds["lora-of"], OF_FAN],
    );
    // Fansly: two fans, each with a group of their own, both known to the page.
    await thread(GROUP, FAN);
    await thread(OTHER_GROUP, OTHER_FAN);
    await archive({ page: "lora-fansly", platform: "fansly", conversationRef: GROUP, fan: FAN, count: CHAT_MESSAGES, prefix: "81" });
    await archive({ page: "lora-fansly", platform: "fansly", conversationRef: OTHER_GROUP, fan: OTHER_FAN, count: 3, prefix: "82" });
    const fans = await upsertFans(app.db, [
      { platform: "fansly", platformUserId: FAN },
      { platform: "fansly", platformUserId: OTHER_FAN },
    ]);
    await upsertFanPages(app.db, fans.map((fan) => ({ fanId: fan.id, platformAccountId: pageIds["lora-fansly"]! })));

    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha fansly extension" })).token;

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
          label: "Firefox · macOS · Fansly",
          mode: "active",
          client: "chat-extension",
        },
      });
      expect(signIn.statusCode, signIn.body).toBe(200);
      const { token } = signIn.json<{ token: string }>();
      if (username === "grisha") {
        grishaToken = token;
      } else {
        nikitaToken = token;
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

    const catalog = await server.inject({ method: "GET", url: "/api/v1/ai/persona-catalog", headers: bearer(grishaToken) });
    expect(catalog.statusCode, catalog.body).toBe(200);
    personaDefinitionId = catalog.json<{ personas: Array<{ key: string; definitionId: string }> }>()
      .personas.find((entry) => entry.key === persona.id)!.definitionId;

    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    hf2.admitsFansly = false;
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("is inert at merge: the capability is served, and nothing on Fansly is reachable until recap and preview exist there", async (context) => {
    if (!server) return context.skip();
    await switchReadsOn();
    const generationRef = await seedRecap({ text: "FAN RECAP", at: minutesAgo(5), conversationRef: GROUP, fanRef: FAN });

    const bootstrap = clientBootstrapResponseSchema.parse(
      (await server.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers: bearer(grishaToken) })).json(),
    );
    expect(bootstrap.capabilities).toContain("conversation-recaps-v1");
    const fanslyPage = bootstrap.pages.find((page) => page.pageLabel === "lora-fansly")!;
    for (const flag of ["recap", "preview"]) {
      expect(fanslyPage.features[flag], flag).toEqual({ available: false, reason: "platform_unsupported" });
    }
    expect(bootstrap.pages.find((page) => page.pageLabel === "lora-of")!.features.recap).toEqual({ available: true });

    // The owner's switches are on, and still: whatever the request names, before anything is read.
    for (const conversationRef of [GROUP, undefined, OTHER_GROUP]) {
      expectRefused(await recaps({ conversationRef }), 409, "client_feature_disabled", "platform_unsupported");
      expectRefused(await feed({ conversationRef }), 409, "client_feature_disabled", "platform_unsupported");
      expectRefused(await save({ generationRef, conversationRef }), 409, "client_feature_disabled", "platform_unsupported");
    }
    expect(await dossier(FAN)).toEqual([]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("OnlyFans: the fan's own chat named as the conversation reads exactly as before; any other is 409", async (context) => {
    if (!server) return context.skip();
    await switchReadsOn();
    await seedRecap({ text: "OF FULL", at: minutesAgo(30), page: "lora-of", conversationRef: OF_FAN, fanRef: null });
    await seedRecap({ text: "OF SHORT", at: minutesAgo(20), page: "lora-of", conversationRef: OF_FAN, fanRef: OF_FAN, mode: "short" });
    const ofRecap = await seedRecap({ text: "OF SAVE ME", at: minutesAgo(10), page: "lora-of", conversationRef: OF_FAN, fanRef: null });

    // The recaps: byte for byte the answer without the field.
    const before = await recaps({ page: "lora-of", fan: OF_FAN });
    expect(before.statusCode, before.body).toBe(200);
    expect(clientConversationRecapsResponseSchema.parse(before.json())).toMatchObject({
      full: { text: "OF SAVE ME" }, short: { text: "OF SHORT" }, fullSavedToProfile: false,
    });
    const named = await recaps({ page: "lora-of", fan: OF_FAN, conversationRef: OF_FAN });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.body).toBe(before.body);

    // The feed: the same walk, and one cursor for both spellings of the request.
    const plain = await feedOk({ page: "lora-of", fan: OF_FAN, limit: 2 });
    const spelled = await feedOk({ page: "lora-of", fan: OF_FAN, conversationRef: OF_FAN, limit: 2 });
    expect(plain.target).toEqual({ pageLabel: "lora-of", fanRef: OF_FAN });
    expect(spelled.target).toEqual({ pageLabel: "lora-of", fanRef: OF_FAN, conversationRef: OF_FAN });
    const walk = (page: ClientConversationFeedResponse) => ({
      source: page.source,
      snapshotRevision: page.snapshotRevision,
      coverage: page.coverage,
      head: page.head,
      newestKnownAt: page.newestKnownAt,
      items: page.items,
      summary: page.summary === null ? null : { ...page.summary, asOf: "<now>" },
    });
    expect(walk(spelled)).toEqual(walk(plain));
    expect(plain.items.map((item) => item.messageId)).toEqual(["91", "92"]);
    const nextPlain = await feedOk({ page: "lora-of", fan: OF_FAN, conversationRef: OF_FAN, cursor: plain.nextOlderCursor!, limit: 2 });
    const nextSpelled = await feedOk({ page: "lora-of", fan: OF_FAN, cursor: spelled.nextOlderCursor!, limit: 2 });
    expect(nextPlain.items.map((item) => item.messageId)).toEqual(["93", "94"]);
    expect(nextSpelled.items).toEqual(nextPlain.items);

    // The dossier save: the field equal to the fan saves as without it.
    const saved = await save({ page: "lora-of", fan: OF_FAN, generationRef: ofRecap, conversationRef: OF_FAN });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(clientFanProfileFromGenerationResponseSchema.parse(saved.json()).outcome).toBe("created");
    const again = await save({ page: "lora-of", fan: OF_FAN, generationRef: ofRecap });
    expect(clientFanProfileFromGenerationResponseSchema.parse(again.json()).outcome).toBe("existing");
    expect((await dossier(OF_FAN, "lora-of")).map((version) => version.body)).toEqual(["OF SAVE ME"]);

    // On OnlyFans the chat IS the fan: another chat named beside the fan is another fan's.
    for (const conversationRef of [OF_OTHER_FAN, GROUP]) {
      expectMismatch(await recaps({ page: "lora-of", fan: OF_FAN, conversationRef }));
      expectMismatch(await feed({ page: "lora-of", fan: OF_FAN, conversationRef }));
      expectMismatch(await save({ page: "lora-of", fan: OF_FAN, generationRef: ofRecap, conversationRef }));
    }
    // A malformed one is the schema's.
    const malformed = await recaps({ page: "lora-of", fan: OF_FAN, conversationRef: "group-900" });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect(errorResponseSchema.safeParse(malformed.json()).success).toBe(true);
    expect((await dossier(OF_FAN, "lora-of")).map((version) => version.body)).toEqual(["OF SAVE ME"]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  describe("Fansly, with recap and preview admitted (the HF-2 stand-in)", () => {
    beforeEach(async () => {
      hf2.admitsFansly = true;
      await switchReadsOn();
    });

    it("a recap the released Fansly extension made (conversation_ref = the group) is the new client's recap of the pair", async (context) => {
      if (!server) return context.skip();
      // The released extension's real Recap requests (fansly-chat 2.10.1, ff30d00:
      // operations.ts buildConversationRefs, kernel-feature-gateway.ts): its full
      // device token, the group and the fan, its own transcript.
      const clientContext = {
        transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
        messageCount: 35,
        fanDisplayName: "charles",
        fanSpendingData: "Total: $42.00",
        fanSubscriptionData: "Subscribed: yes",
      };
      script.text = "OLD FULL RECAP";
      const full = await generate({
        feature: "fan-summary",
        token: grishaFullToken,
        clientVersion: OLD_FANSLY_VERSION,
        body: {
          conversationRef: GROUP, fanRef: FAN, messageCount: 1500, isRegeneration: false,
          clientContext: { ...clientContext, transcriptCoverage: "window" },
        },
      });
      script.text = "OLD SHORT RECAP";
      const short = await generate({
        feature: "fan-summary",
        token: grishaFullToken,
        clientVersion: OLD_FANSLY_VERSION,
        body: { conversationRef: GROUP, fanRef: FAN, summaryMode: "short", isRegeneration: false, clientContext },
      });
      // Stored as the released extension asked, and its lane is not checked (HF-9).
      for (const made of [full, short]) {
        expect(made.record).toMatchObject({ conversation_ref: GROUP, fan_ref: FAN });
        expect(made.record.params.contextManifest ?? {}).not.toHaveProperty("conversationPair");
      }

      // Another chatter of the page, on the new client: the same two recaps, shared.
      const read = await recapsOk({ token: nikitaToken, conversationRef: GROUP, personaDefinitionId });
      expect(read).toMatchObject({
        full: { generationRef: full.generationRef, text: "OLD FULL RECAP", coverage: { transcriptCoverage: "window" } },
        short: { generationRef: short.generationRef, text: "OLD SHORT RECAP" },
        fullSavedToProfile: false,
      });
      // The released extension's own status read names the same two.
      const status = await server!.inject({
        method: "GET",
        url: `/api/v1/ai/recap-status${query({ pageLabel: "lora-fansly", conversationRef: GROUP, fanRef: FAN, personaDefinitionId })}`,
        headers: bearer(grishaFullToken, OLD_FANSLY_VERSION),
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json()).toMatchObject({
        full: { generatedAt: read.full!.generatedAt },
        short: { generatedAt: read.short!.generatedAt },
      });

      // A Fansly read names its conversation: the fan's id names no chat.
      expectRefused(await recaps({ token: nikitaToken }), 400, "bad_request");
      // The other fan has none of it, in their group or in this one.
      expect(await recapsOk({ fan: OTHER_FAN, conversationRef: OTHER_GROUP })).toEqual({ full: null, short: null, fullSavedToProfile: false });
      expectMismatch(await recaps({ fan: OTHER_FAN, conversationRef: GROUP }));
      await trap!.assertNoOutbound();
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("the new client's Fansly Recap becomes the fan's dossier by reference: the group and the fan differ, and the pair is checked", async (context) => {
      if (!server) return context.skip();
      app.config.chatMuseAiFanProfileContextFeatures = "all";
      const recapText = "DOSSIER_MARKER the fan likes hiking and tips on Fridays";

      // The new client's full Recap: its narrow token, no clientContext, the group and the fan.
      script.text = recapText;
      const clientRequestId = randomUUID();
      const recap = await generate({
        feature: "fan-summary",
        token: grishaToken,
        clientRequestId,
        capabilities: "context-v1",
        body: { conversationRef: GROUP, fanRef: FAN },
      });
      // The hub read the group's transcript and vouched for the pair (HF-9).
      expect(recap.record).toMatchObject({ conversation_ref: GROUP, fan_ref: FAN });
      expect(recap.record.params.contextManifest).toMatchObject({ conversationPair: "verified" });
      expect(recap.prompt).toContain("81 message 1");

      // Refused before the generation is read, and nothing is written:
      // the fan's id alone names no chat; another fan's group; this group named for another fan.
      expectRefused(await save({ generationRef: recap.generationRef, clientRequestId }), 400, "bad_request");
      expectMismatch(await save({ generationRef: recap.generationRef, conversationRef: OTHER_GROUP }));
      expectMismatch(await save({ fan: OTHER_FAN, generationRef: recap.generationRef, conversationRef: GROUP }));
      // Of another conversation: a group the hub has not captured yet, the fan's own form.
      for (const conversationRef of [NEW_GROUP, FAN]) {
        expectRefused(await save({ generationRef: recap.generationRef, conversationRef }), 404, "not_found");
      }
      // Another person's generation reads as absent.
      expectRefused(await save({ token: nikitaToken, generationRef: recap.generationRef, conversationRef: GROUP }), 404, "not_found");
      expect(await dossier(FAN)).toEqual([]);
      expect(await dossier(OTHER_FAN)).toEqual([]);

      const created = await save({ generationRef: recap.generationRef, clientRequestId, conversationRef: GROUP });
      expect(created.statusCode, created.body).toBe(200);
      expect(clientFanProfileFromGenerationResponseSchema.parse(created.json())).toMatchObject({
        outcome: "created", profile: { version: 1 },
      });
      const repeat = await save({ generationRef: recap.generationRef, conversationRef: GROUP });
      expect(clientFanProfileFromGenerationResponseSchema.parse(repeat.json()).outcome).toBe("existing");
      // The fan's dossier holds it, and only the fan's.
      expect(await dossier(FAN)).toEqual([{ version: 1, body: recapText }]);
      expect(await dossier(OTHER_FAN)).toEqual([]);

      // Every chatter of the page reads it as saved.
      expect(await recapsOk({ token: nikitaToken, conversationRef: GROUP })).toMatchObject({
        full: { generationRef: recap.generationRef, text: recapText },
        fullSavedToProfile: true,
      });
      // And the prompts use it: the hub proves the dossier by the generation it came from.
      script.text = "a reply";
      const reply = await generate({
        feature: "fast-reply",
        token: grishaFullToken,
        capabilities: "context-v1",
        body: { conversationRef: GROUP, fanRef: FAN, replyTone: "casual" },
      });
      expect(reply.prompt).toContain("## Fan Dossier");
      expect(reply.prompt).toContain(recapText);
      await trap!.assertNoOutbound();
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("the feed captions a Fansly row's media as its transcript labels them; an OnlyFans row keeps its reading (R20 HF-7в)", async (context) => {
      if (!server) return context.skip();
      // The media lists the Fansly material head stores (prod shape): a photo,
      // a tip's attachment (`other`, no media plane row: never shown), and a
      // bundle beside a video (id order, no members known yet).
      const stored = (id: string, type: string) => ({ id, type, canView: true, isReady: null, duration: null });
      for (const [ref, media] of [
        ["811", [stored("810000000000000001", "image/jpeg")]],
        ["812", [stored("840000000000000001", "other")]],
        ["813", [stored("820000000000000001", "bundle"), stored("830000000000000001", "video/mp4")]],
      ] as const) {
        await testDb!.pool.query(
          "update message_archive set media_metadata = $3::jsonb where account_id = $1 and message_ref = $2",
          [pageIds["lora-fansly"], ref, JSON.stringify(media)],
        );
      }
      const fansly = await feedOk({ conversationRef: GROUP, limit: 3 });
      // Read the OnlyFans way, these were `[Media]`, `[Media]` and `[Media Bundle]`.
      expect(fansly.items.map((item) => [item.messageId, item.attachmentLabels])).toEqual([
        ["811", ["[Photo]"]],
        ["812", []],
        ["813", ["[Media Bundle]", "[Video]"]],
      ]);
      // A later page reads its captions the same way.
      await testDb!.pool.query(
        "update message_archive set media_metadata = $3::jsonb where account_id = $1 and message_ref = $2",
        [pageIds["lora-fansly"], "814", JSON.stringify([stored("810000000000000002", "video/mp4")])],
      );
      const next = await feedOk({ conversationRef: GROUP, cursor: fansly.nextOlderCursor!, limit: 1 });
      expect(next.items.map((item) => [item.messageId, item.attachmentLabels])).toEqual([["814", ["[Video]"]]]);

      // OnlyFans: OFAPI's own list, read as before (a MIME type is not one of its words).
      for (const [ref, media] of [["91", [{ id: 7001, type: "photo" }]], ["92", [{ id: 7002, type: "image/jpeg" }]]] as const) {
        await testDb!.pool.query(
          "update message_archive set media_metadata = $3::jsonb where account_id = $1 and message_ref = $2",
          [pageIds["lora-of"], ref, JSON.stringify(media)],
        );
      }
      const onlyFans = await feedOk({ page: "lora-of", fan: OF_FAN, limit: 2 });
      expect(onlyFans.items.map((item) => [item.messageId, item.attachmentLabels])).toEqual([
        ["91", ["[Photo]"]],
        ["92", ["[Media]"]],
      ]);
      await trap!.assertNoOutbound();
    }, INTEGRATION_TEST_TIMEOUT_MS);

    it("two chats and two fans with different ids never leak into each other: recaps, Coach, the dossier save and the feed", async (context) => {
      if (!server) return context.skip();
      // Each row that must not reach FAN is NEWER than the one that must.
      await seedRecap({ text: "FAN RECAP", at: minutesAgo(60), conversationRef: GROUP, fanRef: FAN });
      await seedRecap({ text: "FAN LEGACY SHORT", at: minutesAgo(20), conversationRef: FAN, fanRef: null, mode: "short" });
      await seedRecap({ text: "OTHER FAN RECAP", at: minutesAgo(30), conversationRef: OTHER_GROUP, fanRef: OTHER_FAN });
      await seedRecap({ text: "OTHER LEGACY SHORT", at: minutesAgo(3), conversationRef: OTHER_FAN, fanRef: null, mode: "short" });
      // FAN's group, stored about the other fan (a pair no check stopped), and about nobody.
      const mispaired = await seedRecap({ text: "MISPAIRED RECAP", at: minutesAgo(10), conversationRef: GROUP, fanRef: OTHER_FAN });
      await seedRecap({ text: "MISPAIRED SHORT", at: minutesAgo(2), conversationRef: GROUP, fanRef: OTHER_FAN, mode: "short" });
      const fanless = await seedRecap({ text: "GROUP NO FAN", at: minutesAgo(5), conversationRef: GROUP, fanRef: null });

      // The recaps of each pair, and nothing stored about the other fan or about nobody.
      expect(await recapsOk({ conversationRef: GROUP })).toMatchObject({
        full: { text: "FAN RECAP" }, short: { text: "FAN LEGACY SHORT" },
      });
      expect(await recapsOk({ fan: OTHER_FAN, conversationRef: OTHER_GROUP })).toMatchObject({
        full: { text: "OTHER FAN RECAP" }, short: { text: "OTHER LEGACY SHORT" },
      });
      // A group the page has not captured yet is served (unverified), with this fan's rows only.
      expect(await recapsOk({ conversationRef: NEW_GROUP })).toMatchObject({ full: null, short: { text: "FAN LEGACY SHORT" } });
      // A group named for the other fan is refused whichever way round.
      expectMismatch(await recaps({ fan: OTHER_FAN, conversationRef: GROUP }));
      expectMismatch(await recaps({ conversationRef: OTHER_GROUP }));

      // Coach on the new client's lane (no clientContext): the same recaps as the read.
      script.text = "coach answer";
      const coach = await generate({
        feature: "coach-chat",
        token: grishaFullToken,
        capabilities: "context-v1",
        body: { conversationRef: GROUP, fanRef: FAN, chatterQuestion: "what next?" },
      });
      expect(coach.record.params.contextManifest).toMatchObject({ conversationPair: "verified" });
      expect(coach.prompt).toContain("FAN RECAP");
      expect(coach.prompt).toContain("FAN LEGACY SHORT");
      for (const leaked of ["MISPAIRED RECAP", "MISPAIRED SHORT", "GROUP NO FAN", "OTHER FAN RECAP", "OTHER LEGACY SHORT"]) {
        expect(coach.prompt, leaked).not.toContain(leaked);
      }
      // The released extension's Coach (its own transcript, its lane unchecked)
      // attaches by conversation exactly as it did before this change.
      const oldCoach = await generate({
        feature: "coach-chat",
        token: grishaFullToken,
        clientVersion: OLD_FANSLY_VERSION,
        body: {
          conversationRef: GROUP, fanRef: FAN, chatterQuestion: "what next?", isRegeneration: false,
          clientContext: {
            transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
            messageCount: 35,
            fanDisplayName: "charles",
            fanSpendingData: "Total: $42.00",
            fanSubscriptionData: "Subscribed: yes",
          },
        },
      });
      expect(oldCoach.prompt).toContain("GROUP NO FAN");
      expect(oldCoach.prompt).toContain("MISPAIRED SHORT");

      // The dossier save: a record stored about the other fan, or about nobody, is not FAN's.
      for (const generationRef of [mispaired, fanless]) {
        expectRefused(await save({ generationRef, conversationRef: GROUP }), 404, "not_found");
      }
      expectMismatch(await save({ fan: OTHER_FAN, generationRef: mispaired, conversationRef: GROUP }));
      expect(await dossier(FAN)).toEqual([]);
      expect(await dossier(OTHER_FAN)).toEqual([]);

      // The feed: each group's own messages, its pair in the target, a cursor of its own.
      const fans = await feedOk({ conversationRef: GROUP, limit: 2 });
      expect(fans.target).toEqual({ pageLabel: "lora-fansly", fanRef: FAN, conversationRef: GROUP });
      expect(fans.items.map((item) => item.messageId)).toEqual(["811", "812"]);
      expect(fans.summary?.window.served).toBe(CHAT_MESSAGES);
      const others = await feedOk({ fan: OTHER_FAN, conversationRef: OTHER_GROUP, limit: 2 });
      expect(others.items.map((item) => item.messageId)).toEqual(["821", "822"]);
      expect(JSON.stringify(others)).not.toContain("81 message");
      expect(fans.nextOlderCursor).not.toBeNull();
      const next = await feedOk({ conversationRef: GROUP, cursor: fans.nextOlderCursor!, limit: 2 });
      expect(next.items.map((item) => item.messageId)).toEqual(["813", "814"]);
      // A cursor of FAN's group continues no other walk: another group, the fan alone, another page's spelling.
      expectRefused(
        await feed({ fan: OTHER_FAN, conversationRef: OTHER_GROUP, cursor: fans.nextOlderCursor! }),
        400, "bad_request", "cursor_invalid",
      );
      expectRefused(await feed({ conversationRef: NEW_GROUP, cursor: fans.nextOlderCursor! }), 400, "bad_request", "cursor_invalid");
      expectMismatch(await feed({ fan: OTHER_FAN, conversationRef: GROUP, cursor: fans.nextOlderCursor! }));
      expectMismatch(await feed({ conversationRef: OTHER_GROUP }));
      expectRefused(await feed({}), 400, "bad_request");
      // A group the page has not captured yet is served, empty.
      const fresh = await feedOk({ conversationRef: NEW_GROUP });
      expect(fresh.items).toEqual([]);
      await trap!.assertNoOutbound();
    }, INTEGRATION_TEST_TIMEOUT_MS);
  });
});
