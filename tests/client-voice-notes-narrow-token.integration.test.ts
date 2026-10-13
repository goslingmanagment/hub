import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  clientBootstrapResponseSchema,
  errorResponseSchema,
  type ClientBootstrapResponse,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAiGenerationContent,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import type { VoiceTtsProvider } from "../apps/runtime/src/services/voice-elevenlabs-provider.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real verify.
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// R20 HF-4б (chat-extension docs/project-unite/plan.md, architecture §11.1,
// §8.8, §9.5): the voice notes in the narrow chat-extension token. The three
// voice-note routes (the paid render, its status, its audio) join the token's
// list behind the page's `voice` flag (a Fansly flag), the hub serves
// `voice-notes-v1`, and the bootstrap offers `voice` only on a page the
// voice-notes lane serves (`lane_off` otherwise).
//
// Predicate of the new behaviour: a narrow chat-extension token, and for
// anything to be reachable, a Fansly page whose `voice` flag the owner sets.
// No page has one (the owner's prod rows below), so nothing turns on at merge.
// A full token (the Fansly extension 2.10.1, the desktop) is never asked.

const AUDIT = { source: "cli" } as const;
const PASSWORDS = { owner: "owner-secret", chatter: "chatter-secret" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** The released Fansly extension's header (its full token). */
const OLD_FANSLY_VERSION = "chatgoose-extension/2.10.1";
/** A Fansly chat: its group and its fan (18-digit ids; the group is not the fan). */
const GROUP = "650000000000000001";
const FAN = "700000000000000001";
/** What the model answers, and what the render's validation admits. */
const SCRIPT = "hello [warmly] world";
const AUDIO = Buffer.from("fake-mp3-bytes-for-hf4b");

/**
 * The owner's `chatExtensionFeatures` rows on prod (read only, 2026-10-13, as
 * in client-ai-fansly-drafts): the two OnlyFans pilot pages, no "*" row, no
 * Fansly page, no `voice` anywhere.
 */
const PILOT_ROW = {
  insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
  recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
};
const PROD_ROWS = { "lora-vip-of": PILOT_ROW, "lora-of": PILOT_ROW };

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let narrowToken = "";
let fullToken = "";
let ownerCookie = "";
let chatterId = 0;
const pageIds: Record<string, number> = {};
const tts = { calls: 0 };

const fakeTts: VoiceTtsProvider = {
  async synthesize() {
    tts.calls += 1;
    return {
      ok: true,
      audio: AUDIO,
      characterCost: SCRIPT.length,
      requestId: "tts-req-hf4b",
      traceId: "tts-trace-hf4b",
      region: "us-east-1",
    };
  },
};

function setSwitches(features: Record<string, Record<string, boolean>>, enabled = true, minVersion = "1.2.0") {
  app.config.chatExtensionEnabled = enabled;
  app.config.chatExtensionFeatures = JSON.stringify(features);
  app.config.chatExtensionMinVersion = minVersion;
}

/** The voice-notes lane as the owner switches it on for lora-1 and lora-3 (lora-3 has no voice profile). */
function laneOn() {
  app.config.voiceNotesEnabled = true;
  app.config.voiceNotesRetrievalEnabled = true;
  app.config.voiceNotesPageAllowlist = "lora-1,lora-3";
  app.config.voiceNotesScriptMaxChars = 600;
  app.config.voiceNotesDailyCharBudget = 100_000;
  app.config.voiceNotesGlobalDailyCharBudget = 100_000;
  app.config.voiceNotesMaxConcurrentSyntheses = 2;
  app.voiceTtsProvider = fakeTts;
}

interface CallOptions {
  token?: string;
  page?: string;
  /** null: no `x-client-version` at all. */
  version?: string | null;
}

function headers(options: CallOptions, fallbackVersion: string): Record<string, string> {
  const version = options.version === undefined ? fallbackVersion : options.version;
  return {
    authorization: `Bearer ${options.token ?? narrowToken}`,
    ...(version === null ? {} : { "x-client-version": version }),
  };
}

function versionFor(options: CallOptions): string {
  return (options.token ?? narrowToken) === fullToken ? OLD_FANSLY_VERSION : EXTENSION_VERSION;
}

async function create(body: Record<string, unknown>, options: CallOptions = {}): Promise<InjectResponse> {
  return server!.inject({
    method: "POST",
    url: `/api/v1/pages/${options.page ?? "lora-1"}/voice-notes`,
    headers: headers(options, versionFor(options)),
    payload: body,
  });
}

async function status(id: number, options: CallOptions = {}): Promise<InjectResponse> {
  return server!.inject({
    method: "GET",
    url: `/api/v1/pages/${options.page ?? "lora-1"}/voice-notes/${id}`,
    headers: headers(options, versionFor(options)),
  });
}

async function audio(id: number, options: CallOptions = {}): Promise<InjectResponse> {
  return server!.inject({
    method: "GET",
    url: `/api/v1/pages/${options.page ?? "lora-1"}/voice-notes/${id}/audio`,
    headers: headers(options, versionFor(options)),
  });
}

async function bootstrapAs(token: string): Promise<ClientBootstrapResponse> {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/client/bootstrap",
    headers: { authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json());
}

/** Each page's `voice` in the narrow token's bootstrap. */
async function voiceByPage(): Promise<Record<string, unknown>> {
  const body = await bootstrapAs(narrowToken);
  return Object.fromEntries(body.pages.map((page) => [page.pageLabel, page.features.voice]));
}

/** The released clients' hint on GET /api/v1/pages (their full token), by page. */
async function hintByPage(): Promise<Record<string, unknown>> {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/pages",
    headers: { authorization: `Bearer ${fullToken}`, "x-client-version": OLD_FANSLY_VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  const pages = response.json<Array<{ label: string; capabilities?: unknown }>>();
  return Object.fromEntries(pages.map((page) => [page.label, page.capabilities ?? null]));
}

function expectFeatureRefused(response: InjectResponse, reason: string, what: string) {
  expect(response.statusCode, `${what}: ${response.body}`).toBe(409);
  expect(errorResponseSchema.parse(response.json()), what).toMatchObject({ error: "client_feature_disabled", reason });
}

function expectLaneCode(response: InjectResponse, statusCode: number, code: string, what: string) {
  expect(response.statusCode, `${what}: ${response.body}`).toBe(statusCode);
  expect(errorResponseSchema.parse(response.json()).error, what).toBe(code);
}

/** A completed voice-script generation of lora-1 for the chatter, as the AI lane records it. */
async function seedScript(refs: { conversationRef: string; fanRef: string }): Promise<string> {
  const generationRef = `gen-${randomUUID()}`;
  await insertAiGenerationContent(app.db, {
    usageEventId: null,
    generationRef,
    feature: "voice-script",
    model: "anthropic:claude-sonnet-4-6",
    provider: "anthropic",
    userId: chatterId,
    pageId: pageIds["lora-1"]!,
    conversationRef: refs.conversationRef,
    fanRef: refs.fanRef,
    promptBlocks: [],
    completion: SCRIPT,
    params: { outcome: "completed" },
  });
  return generationRef;
}

/** The new client's render: the group and the fan apart (R20 HF-4а). */
function newRender(sourceGenerationRef: string) {
  return { clientRequestId: randomUUID(), conversationRef: GROUP, fanRef: FAN, sourceGenerationRef, script: SCRIPT };
}

/** The released Fansly extension's render: the fan's id is the chat, no fanRef. */
function oldRender(sourceGenerationRef: string) {
  return { clientRequestId: randomUUID(), conversationRef: FAN, sourceGenerationRef, script: SCRIPT };
}

async function waitCompleted(id: number, options: CallOptions = {}): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await status(id, options);
    expect(response.statusCode, response.body).toBe(200);
    if (response.json<{ state: string }>().state === "completed") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`voice note ${id} did not complete in time`);
}

async function voiceNoteCount(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from voice_notes");
  return rows[0]!.count;
}

async function spentChars(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ total: string }>(
    "select coalesce(sum(spent_chars), 0)::text as total from voice_char_budget",
  );
  return Number(rows[0]!.total);
}

/** A render of the chatter's, admitted and completed through the narrow token with the flag on. */
async function narrowRender(): Promise<{ id: number; body: Record<string, unknown> }> {
  const body = newRender(await seedScript({ conversationRef: GROUP, fanRef: FAN }));
  const response = await create(body);
  expect(response.statusCode, response.body).toBe(202);
  const id = Number(response.json<{ voiceNoteId: number }>().voiceNoteId);
  await waitCompleted(id);
  return { id, body };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.chatMuseAiGatewayEnabled = true;
  app.aiGatewayProvider = {
    provider: "anthropic",
    async *stream() {
      yield { type: "content_delta", text: SCRIPT };
      yield {
        type: "usage",
        providerResponseId: "msg_hf4b",
        cacheHit: false,
        usage: { inputTokens: 40, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 90, costApproximate: false },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  tts.calls = 0;
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id, displayName: persona.name, systemBlock: persona.content, bundledVersion: persona.builtinVersion!,
  });
  await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
  await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
  chatterId = await fixtureUserId(app, "grisha");
  await setUserPassword(app, { userId: chatterId, password: PASSWORDS.chatter }, AUDIT);

  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  for (const [label, createPage, externalId, granted] of [
    ["lora-of", createOnlyFansPage, "100000001", true],
    ["lora-vip-of", createOnlyFansPage, "100000002", true],
    // Every Fansly page on prod has its platform account id (2026-10-13).
    ["lora-1", createFanslyPage, "500000000000000001", true],
    // A Fansly page the chatter is not granted.
    ["lora-2", createFanslyPage, "500000000000000002", false],
    // A Fansly page on the lane's allowlist with no voice profile.
    ["lora-3", createFanslyPage, "500000000000000003", true],
  ] as const) {
    const page = await createPage(app.db, { modelId: model!.id, label });
    pageIds[label] = page!.id;
    await storeProxyConfig(app.db, page!.id, {
      url: "socks5://proxy.example:1080", encryptedAuth: null, keyVersion: null, rateLimitScopeKey: "hf4b-proxy",
    });
    await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [page!.id, externalId]);
    if (granted) {
      await assignPageToUser(app, { userId: chatterId, pageLabel: label }, AUDIT);
    }
  }
  // The Fansly chat of lora-1: its thread (the group with its fan) and one archived fan line.
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, true)`,
    [pageIds["lora-1"], GROUP, FAN],
  );
  await testDb.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     values ($1, 'fansly', $2, '600000000000000001', $3, false, now() - interval '10 minutes', 'miss you')`,
    [pageIds["lora-1"], GROUP, FAN],
  );
  await upsertVoiceProfile(app.db, {
    platformAccountId: pageIds["lora-1"]!,
    voiceId: "voice-hf4b",
    model: "eleven_v3",
    settings: {},
    outputFormat: "mp3_44100_128",
  });
  laneOn();
  setSwitches(PROD_ROWS);

  server = await buildApiServer(app);
  await server.ready();
  const signIn = async (body: Record<string, unknown>, clientVersion: string) => {
    const response = await server!.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": clientVersion },
      payload: { username: "grisha", password: PASSWORDS.chatter, label: "voice device", mode: "active", ...body },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ token: string }>().token;
  };
  narrowToken = await signIn({ client: "chat-extension" }, EXTENSION_VERSION);
  fullToken = await signIn({}, OLD_FANSLY_VERSION);
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "owner", password: PASSWORDS.owner },
  });
  expect(login.statusCode, login.body).toBe(200);
  const cookie = login.headers["set-cookie"];
  ownerCookie = (Array.isArray(cookie) ? cookie[0] : cookie)!.split(";")[0]!;
}, 120_000);

afterEach(async () => {
  await server?.close();
  server = null;
});

afterAll(async () => {
  await testDb?.stop();
});

describe("[R20 HF-4б] the narrow token's voice notes on Fansly", () => {
  it("with the page's voice flag and the lane on: the script, the paid render, its status and its audio", async (context) => {
    if (!server) return context.skip();
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } });

    const bootstrap = await bootstrapAs(narrowToken);
    expect(bootstrap.capabilities).toContain("voice-notes-v1");
    expect(bootstrap.pages.find((page) => page.pageLabel === "lora-1")?.features.voice).toEqual({ available: true });

    // The script, as the new client asks for it: the group and the fan apart, no clientContext.
    const script = await server.inject({
      method: "POST",
      url: "/api/v1/ai/features/voice-script",
      headers: { ...headers({}, EXTENSION_VERSION), "x-kernel-ai-capabilities": "context-v1" },
      payload: {
        clientRequestId: randomUUID(),
        pageLabel: "lora-1",
        platform: "fansly",
        conversationRef: GROUP,
        fanRef: FAN,
        replyTone: "flirty",
        draftText: "miss you",
        isRegeneration: false,
      },
    });
    expect(script.statusCode, script.body).toBe(200);
    const meta = script.body.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; requestId?: string })
      .find((frame) => frame.type === "meta");
    const generationRef = String(meta?.requestId);
    const deadline = Date.now() + 5_000;
    while ((await testDb!.pool.query(
      "select 1 from ai_generation_content where generation_ref = $1 and params->>'outcome' = 'completed'",
      [generationRef],
    )).rowCount !== 1) {
      expect(Date.now(), "the voice-script generation record").toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // The paid render, its status and its audio, all through the narrow token.
    const body = newRender(generationRef);
    const admitted = await create(body);
    expect(admitted.statusCode, admitted.body).toBe(202);
    const id = Number(admitted.json<{ voiceNoteId: number }>().voiceNoteId);
    await waitCompleted(id);
    const read = await status(id);
    expect(read.json()).toMatchObject({ voiceNoteId: id, state: "completed", scriptChars: SCRIPT.length, billed: true });
    const bytes = await audio(id);
    expect(bytes.statusCode, bytes.body).toBe(200);
    expect(bytes.headers["content-type"]).toBe("audio/mpeg");
    expect(bytes.rawPayload.equals(AUDIO)).toBe(true);
    expect(tts.calls).toBe(1);

    // The same request replays the same render: no second synthesis.
    const replay = await create(body);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({ voiceNoteId: id, state: "completed" });
    expect(tts.calls).toBe(1);
    const { rows } = await testDb!.pool.query<{ user_id: number; conversation_ref: string }>(
      "select user_id::int as user_id, conversation_ref from voice_notes",
    );
    expect(rows).toEqual([{ user_id: chatterId, conversation_ref: GROUP }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("without the page's voice flag: 409 flag_off on all three routes, a replay's included; nothing admitted, nothing rendered", async (context) => {
    if (!server) return context.skip();
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } });
    const earlier = await narrowRender();
    const rendersBefore = await voiceNoteCount();
    const spentBefore = await spentChars();
    const callsBefore = tts.calls;

    // The owner's rows as on prod: no Fansly page has a row. Then a row false.
    for (const rows of [PROD_ROWS, { ...PROD_ROWS, "lora-1": { voice: false } }]) {
      setSwitches(rows);
      expect((await voiceByPage())["lora-1"]).toEqual({ available: false, reason: "flag_off" });
      const fresh = newRender(await seedScript({ conversationRef: GROUP, fanRef: FAN }));
      expectFeatureRefused(await create(fresh), "flag_off", "a new render");
      expectFeatureRefused(await create(earlier.body), "flag_off", "a replay");
      expectFeatureRefused(await status(earlier.id), "flag_off", "status");
      expectFeatureRefused(await audio(earlier.id), "flag_off", "audio");
      // Another flag of the page opens nothing of voice.
      setSwitches({ ...rows, "lora-1": { drafts: true, notesFill: true } });
      expectFeatureRefused(await create(fresh), "flag_off", "a new render under drafts");
    }
    expect(await voiceNoteCount()).toBe(rendersBefore);
    expect(await spentChars()).toBe(spentBefore);
    expect(tts.calls).toBe(callsBefore);

    // The flag back: the same id replays the same render, never a second one.
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } });
    const replay = await create(earlier.body);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({ voiceNoteId: earlier.id, state: "completed" });
    expect((await audio(earlier.id)).statusCode).toBe(200);
    expect(tts.calls).toBe(callsBefore);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("with the flag: still the master switch, the version, the page grant and the platform, before the lane", async (context) => {
    if (!server) return context.skip();
    const everything = {
      ...PROD_ROWS,
      "lora-1": { voice: true },
      "lora-2": { voice: true },
      "lora-of": { ...PILOT_ROW, voice: true },
      "*": { voice: true },
    };
    setSwitches(everything);
    const earlier = await narrowRender();
    const rendersBefore = await voiceNoteCount();
    const callsBefore = tts.calls;
    const fresh = newRender(await seedScript({ conversationRef: GROUP, fanRef: FAN }));

    const cases: Array<{ what: string; reason: string; options: CallOptions; setup?: () => void }> = [
      { what: "master switch off", reason: "disabled", options: {}, setup: () => setSwitches(everything, false) },
      { what: "below the minimum", reason: "client_outdated", options: { version: "chat-extension/1.1.9" } },
      { what: "another client's header", reason: "client_outdated", options: { version: OLD_FANSLY_VERSION } },
      { what: "no version", reason: "client_outdated", options: { version: null } },
      { what: "a Fansly page not granted", reason: "not_granted", options: { page: "lora-2" } },
      { what: "a page that does not exist", reason: "not_granted", options: { page: "ghost-fansly" } },
      // `voice` does not exist on OnlyFans, whatever the rows say.
      { what: "an OnlyFans page", reason: "platform_unsupported", options: { page: "lora-of" } },
    ];
    for (const testCase of cases) {
      setSwitches(everything);
      testCase.setup?.();
      expectFeatureRefused(await create(fresh, testCase.options), testCase.reason, `${testCase.what}: create`);
      expectFeatureRefused(await status(earlier.id, testCase.options), testCase.reason, `${testCase.what}: status`);
      expectFeatureRefused(await audio(earlier.id, testCase.options), testCase.reason, `${testCase.what}: audio`);
    }
    expect(await voiceNoteCount()).toBe(rendersBefore);
    expect(tts.calls).toBe(callsBefore);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[R20 HF-4б] the bootstrap's voice follows the voice-notes lane", () => {
  it("a page the lane does not serve reads lane_off with the flag on; a call is answered by the lane's own code", async (context) => {
    if (!server) return context.skip();
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true }, "lora-3": { voice: true } });
    const source = await seedScript({ conversationRef: GROUP, fanRef: FAN });

    // lora-1 is served; lora-3 is allowlisted but has no voice profile.
    expect(await voiceByPage()).toEqual({
      "lora-1": { available: true },
      "lora-3": { available: false, reason: "lane_off" },
      "lora-of": { available: false, reason: "platform_unsupported" },
      "lora-vip-of": { available: false, reason: "platform_unsupported" },
    });
    // The released clients' hint says the same of the same pages.
    expect(await hintByPage()).toMatchObject({ "lora-1": { voiceNotes: true }, "lora-3": null, "lora-of": null });

    const laneOff: Array<{ what: string; off: () => void; status: number; code: string }> = [
      { what: "the lane's switch off", off: () => { app.config.voiceNotesEnabled = false; }, status: 403, code: "voice_disabled" },
      { what: "lora-1 off the allowlist", off: () => { app.config.voiceNotesPageAllowlist = "lora-3"; }, status: 403, code: "voice_not_allowlisted" },
      { what: "an empty allowlist", off: () => { app.config.voiceNotesPageAllowlist = " , "; }, status: 403, code: "voice_not_allowlisted" },
      { what: "no synthesis provider", off: () => { app.voiceTtsProvider = undefined; }, status: 503, code: "voice_provider_unavailable" },
    ];
    for (const testCase of laneOff) {
      laneOn();
      testCase.off();
      expect((await voiceByPage())["lora-1"], testCase.what).toEqual({ available: false, reason: "lane_off" });
      expect((await hintByPage())["lora-1"], testCase.what).toBeNull();
      // Past the switch the lane answers with its own code, as for every client.
      expectLaneCode(await create(newRender(source)), testCase.status, testCase.code, `${testCase.what}: narrow`);
      expectLaneCode(await create(oldRender(source), { token: fullToken }), testCase.status, testCase.code, `${testCase.what}: full`);
    }
    expect(await voiceNoteCount()).toBe(0);
    expect(tts.calls).toBe(0);

    // The lane decides only what the flag would offer: off flag, master switch off, another platform answer first.
    app.config.voiceNotesEnabled = false;
    setSwitches({ ...PROD_ROWS });
    expect((await voiceByPage())["lora-1"]).toEqual({ available: false, reason: "flag_off" });
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } }, false);
    expect((await voiceByPage())["lora-1"]).toEqual({ available: false, reason: "disabled" });

    // Back on: available again.
    laneOn();
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } });
    expect((await voiceByPage())["lora-1"]).toEqual({ available: true });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the owner's change of a lane switch moves the configRevision; the bootstrap reads only the database", async (context) => {
    if (!server) return context.skip();
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } });
    const trap = await armNoOutboundTrap(testDb!);
    try {
      const before = await bootstrapAs(narrowToken);
      expect(before.pages.find((page) => page.pageLabel === "lora-1")?.features.voice).toEqual({ available: true });

      const patched = await server.inject({
        method: "PATCH",
        url: "/api/v1/admin/config",
        headers: { cookie: ownerCookie },
        payload: { patches: [{ key: "voiceNotesPageAllowlist", value: "lora-3" }] },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      const after = await bootstrapAs(narrowToken);
      expect(after.configRevision).toBeGreaterThan(before.configRevision);
      expect(after.pages.find((page) => page.pageLabel === "lora-1")?.features.voice)
        .toEqual({ available: false, reason: "lane_off" });
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[R20 HF-4б] unchanged: the full token and OnlyFans", () => {
  it("the Fansly extension 2.10.1's render, status and audio answer the same whatever the chat-extension switches say", async (context) => {
    if (!server) return context.skip();
    const states: Array<[string, () => void]> = [
      ["at rest", () => {
        app.config.chatExtensionEnabled = false;
        app.config.chatExtensionFeatures = "{}";
        app.config.chatExtensionMinVersion = "0.0.0";
      }],
      ["the owner's prod rows", () => setSwitches(PROD_ROWS)],
      ["voice on everywhere", () => setSwitches({ ...PROD_ROWS, "*": { voice: true }, "lora-1": { voice: true } })],
      ["voice off on the page, the master switch off", () => setSwitches({ "lora-1": { voice: false } }, false)],
      ["a minimum above every version", () => setSwitches({ ...PROD_ROWS, "lora-1": { voice: true } }, true, "99.0.0")],
    ];
    const observed: unknown[] = [];
    for (const [what, apply] of states) {
      apply();
      const full = { token: fullToken };
      const body = oldRender(await seedScript({ conversationRef: FAN, fanRef: FAN }));
      const admitted = await create(body, full);
      expect(admitted.statusCode, `${what}: ${admitted.body}`).toBe(202);
      const id = Number(admitted.json<{ voiceNoteId: number }>().voiceNoteId);
      await waitCompleted(id, full);
      const read = await status(id, full);
      const bytes = await audio(id, full);
      const replay = await create(body, full);
      // Another chatter's id, and a page the chatter is not granted: the lane's own answers.
      const foreign = await status(id + 1000, full);
      const notGranted = await create(oldRender(body.sourceGenerationRef), { ...full, page: "lora-2" });
      const strip = (value: Record<string, unknown>) => ({ ...value, voiceNoteId: "id", createdAt: "at" });
      observed.push({
        admitted: [admitted.statusCode, strip(admitted.json())],
        read: [read.statusCode, strip(read.json())],
        audio: [bytes.statusCode, bytes.headers["content-type"], bytes.rawPayload.equals(AUDIO)],
        replay: [replay.statusCode, replay.json<{ voiceNoteId: number }>().voiceNoteId === id],
        foreign: [foreign.statusCode, foreign.json()],
        notGranted: [notGranted.statusCode, notGranted.json()],
      });
    }
    for (const entry of observed.slice(1)) {
      expect(entry).toEqual(observed[0]);
    }
    expect(observed[0]).toMatchObject({
      admitted: [202, { state: "dispatched" }],
      read: [200, { state: "completed", billed: true }],
      audio: [200, "audio/mpeg", true],
      replay: [202, true],
      foreign: [404, { error: "not_found" }],
      notGranted: [404, { error: "not_found" }],
    });
    expect(tts.calls).toBe(states.length);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("OnlyFans pages: every flag evaluates the same whether the voice lane serves or not; voice does not exist there", async (context) => {
    if (!server) return context.skip();
    const rows = { ...PROD_ROWS, "lora-of": { ...PILOT_ROW, voice: true }, "*": { voice: true } };
    setSwitches(rows);
    // Allowlist the OnlyFans pages too: the lane renders for Fansly alone.
    app.config.voiceNotesPageAllowlist = "lora-1,lora-3,lora-of,lora-vip-of";
    await upsertVoiceProfile(app.db, {
      platformAccountId: pageIds["lora-of"]!, voiceId: "voice-of", model: "eleven_v3", settings: {}, outputFormat: "mp3_44100_128",
    });
    const onlyFansLabels = ["lora-of", "lora-vip-of"];
    const onlyFansPages = async () => (await bootstrapAs(narrowToken)).pages
      .filter((page) => onlyFansLabels.includes(page.pageLabel))
      .map((page) => [page.pageLabel, page.features]);

    const served = await onlyFansPages();
    expect(served.map(([label]) => label)).toEqual(onlyFansLabels);
    app.config.voiceNotesEnabled = false;
    const notServed = await onlyFansPages();
    expect(notServed).toEqual(served);
    for (const [label, features] of served as Array<[string, Record<string, unknown>]>) {
      expect(features.voice, label).toEqual({ available: false, reason: "platform_unsupported" });
      expect(Object.keys(features).sort(), label).toEqual([...CLIENT_FEATURE_FLAG_NAMES].sort());
      // The pilot flags the hub serves read available, as before.
      for (const flag of ["insertion", "review", "coach", "recap", "stats", "newcomers"]) {
        expect(features[flag], `${label} ${flag}`).toEqual({ available: true });
      }
    }
    // The released clients' hint never names an OnlyFans page.
    laneOn();
    app.config.voiceNotesPageAllowlist = "lora-1,lora-of";
    expect((await hintByPage())["lora-of"]).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
