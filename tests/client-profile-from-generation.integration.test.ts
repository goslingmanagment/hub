import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiFeatureStreamFrameSchema,
  clientConversationRecapsResponseSchema,
  clientFanProfileFromGenerationResponseSchema,
  errorResponseSchema,
  fanProfileResponseSchema,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAgentKey,
  insertAiGenerationContent,
  insertAiUsageEvents,
  recordAiGatewayQuotaDenied,
  reserveAiGatewayUsageEvent,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertFans,
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
import { DOSSIER_BODY_MAX_CHARS } from "../apps/runtime/src/services/client-profile-from-generation.ts";
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

// chat-extension H-5: POST /api/v1/client/pages/:pageLabel/fans/:fanRef/profile/from-generation,
// the dossier save from a stored generation. Every test runs under the
// no-outbound trap: the route reads and writes the database and nothing else
// (critic item 8).

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret", nikita: "nikita-secret" } as const;
const AUDIT = { source: "cli" } as const;
const FAN = "777000777";
const OTHER_FAN = "777000888";
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key, granted lora-of: its refusal is about the principal kind, not a page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientdossier0000000`;
/** In every seeded generation's prompt blocks: must never leave through the route. */
const PROMPT_SECRET = "PROMPT_BLOCK_SECRET";
/** The archived chat of FAN on lora-of: enough for a full Recap (30). */
const CHAT_MESSAGES = 40;

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
const userIds: Record<"owner" | "lead" | "grisha" | "nikita" | "sveta", number> = {
  owner: 0, lead: 0, grisha: 0, nikita: 0, sveta: 0,
};
const pageIds: Record<string, number> = {};

/** What the stand-in provider streams next, and how. */
const script: {
  text: string;
  stopReason: string;
  /** Held before the first frame while set: the generation stays in flight. */
  gate: Promise<void> | null;
  /** Told the gateway's request id (the generationRef) once the provider is asked. */
  started: ((requestId: string) => void) | null;
} = { text: "", stopReason: "end_turn", gate: null, started: null };
const providerCapture: { input?: AiGatewayProviderInput } = {};

function scriptedProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      providerCapture.input = input;
      script.started?.(input.requestId);
      if (script.gate) {
        await script.gate;
      }
      yield { type: "content_delta", text: script.text };
      yield {
        type: "usage",
        providerResponseId: "msg_dossier",
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
      yield { type: "done", stopReason: script.stopReason };
    },
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function bearer(token: string, clientVersion: string | null = EXTENSION_VERSION): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(clientVersion === null ? {} : { "x-client-version": clientVersion }) };
}

function saveUrl(pageLabel = "lora-of", fan = FAN) {
  return `/api/v1/client/pages/${pageLabel}/fans/${fan}/profile/from-generation`;
}

interface SaveInput {
  generationRef: string;
  clientRequestId?: string;
  pageLabel?: string;
  fan?: string;
  clientVersion?: string | null;
}

async function save(token: string, input: SaveInput) {
  return server!.inject({
    method: "POST",
    url: saveUrl(input.pageLabel, input.fan),
    headers: bearer(token, input.clientVersion),
    payload: {
      generationRef: input.generationRef,
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
    },
  });
}

/** A 200 whose body is the declared shape and nothing more: the text never travels back. */
async function saveOk(token: string, input: SaveInput) {
  const response = await save(token, input);
  expect(response.statusCode, response.body).toBe(200);
  const body = clientFanProfileFromGenerationResponseSchema.parse(response.json());
  // The schema is not strict and would strip a key it does not know: nothing was stripped.
  expect(response.json()).toEqual(body);
  expect(Object.keys(body.profile).sort()).toEqual(["createdAt", "sourceGeneratedAt", "version"]);
  expect(response.body).not.toContain(PROMPT_SECRET);
  return body;
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
  expect(response.body).not.toContain(PROMPT_SECRET);
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

/** The owner's switches as a pilot page has them: the extension on, Recap on. */
async function switchRecapOn() {
  await patchConfig([
    { key: "chatExtensionEnabled", value: true },
    { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { recap: true } }) },
  ]);
}

/**
 * One stored generation, as the gateway writes a full fan-summary of grisha's:
 * featureParams at the top level of `params`. On OnlyFans the conversation ref
 * is the fan id and no separate fan ref is stored. `rawParams` replaces the
 * params whole (legacy and broken rows).
 */
async function seedGeneration(input: {
  text: string;
  at?: Date;
  userId?: number | null;
  pageLabel?: string;
  conversationRef?: string;
  fanRef?: string | null;
  feature?: string;
  params?: Record<string, unknown>;
  rawParams?: Record<string, unknown>;
}): Promise<string> {
  const generationRef = randomUUID();
  await insertAiGenerationContent(app.db, {
    usageEventId: null,
    generationRef,
    feature: input.feature ?? "fan-summary",
    model: "m",
    provider: "anthropic",
    userId: input.userId === undefined ? userIds.grisha : input.userId,
    pageId: pageIds[input.pageLabel ?? "lora-of"]!,
    conversationRef: input.conversationRef ?? FAN,
    fanRef: input.fanRef ?? null,
    promptBlocks: [{ type: "text", text: PROMPT_SECRET }],
    completion: input.text,
    params: input.rawParams ?? {
      summaryMode: "full",
      outcome: "completed",
      stopReason: "end_turn",
      ...input.params,
    },
  });
  // insertAiGenerationContent has no createdAt input.
  await testDb!.pool.query(
    "update ai_generation_content set created_at = $1 where generation_ref = $2",
    [(input.at ?? minutesAgo(5)).toISOString(), generationRef],
  );
  return generationRef;
}

interface DossierVersion {
  version: number;
  body: string;
  source: string;
  created_by_user_id: number | null;
  source_generated_at: Date | null;
}

/** Every dossier version of the fan on the page, oldest first. */
async function dossier(pageLabel = "lora-of", fan = FAN): Promise<DossierVersion[]> {
  const { rows } = await testDb!.pool.query<DossierVersion>(
    `select p.version, p.body, p.source, p.created_by_user_id::int as created_by_user_id, p.source_generated_at
     from fan_profiles p join fans f on f.id = p.fan_id
     where p.platform_account_id = $1 and f.platform_user_id = $2
     order by p.version`,
    [pageIds[pageLabel], fan],
  );
  return rows;
}

async function count(table: "fan_profiles" | "fans" | "page_fans" | "ai_generation_content"): Promise<number> {
  const { rows } = await testDb!.pool.query<{ count: number }>(`select count(*)::int as count from ${table}`);
  return rows[0]!.count;
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);
}

/** One AI request of the chat extension, as its narrow token asks it. */
function generate(feature: string, clientRequestId: string, body: Record<string, unknown> = {}) {
  delete providerCapture.input;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${feature}`,
    headers: { ...bearer(grishaToken), "x-kernel-ai-capabilities": "context-v1" },
    payload: {
      clientRequestId,
      pageLabel: "lora-of",
      platform: "onlyfans",
      conversationRef: FAN,
      fanRef: FAN,
      ...body,
    },
  });
}

/** The frames of a generation that streamed to its end; every one is one a client's SDK accepts. */
function streamed(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  const all = frames(response.body);
  for (const frame of all) {
    expect(aiFeatureStreamFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
  }
  expect(all.at(-1)).toMatchObject({ type: "done" });
  return { generationRef: (all[0] as { requestId: string }).requestId, types: all.map((frame) => frame.type) };
}

/** The older write (`PUT …/fans/:id/profile`): the text and its time are the client's. */
async function olderWrite(token: string, body: string, generatedAt?: Date) {
  return server!.inject({
    method: "PUT",
    url: `/api/v1/pages/lora-of/fans/${FAN}/profile`,
    headers: bearer(token, "0.1.64"),
    payload: { body, ...(generatedAt ? { generatedAtMs: generatedAt.getTime() } : {}) },
  });
}

describe("POST /api/v1/client/pages/:pageLabel/fans/:fanRef/profile/from-generation", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    Object.assign(script, { text: "", stopReason: "end_turn", gate: null, started: null });
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });
    app.config.chatMuseAiGatewayEnabled = true;
    app.aiGatewayProvider = scriptedProvider();

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    for (const username of ["grisha", "nikita", "sveta"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
    }
    for (const username of ["owner", "lead", "grisha", "nikita", "sveta"] as const) {
      userIds[username] = await fixtureUserId(app, username);
    }
    // A chatter is created without a password and sets one later; it ends every
    // sign-in, so it comes before the tokens below.
    await setUserPassword(app, { userId: userIds.grisha, password: PASSWORDS.grisha }, AUDIT);
    await setUserPassword(app, { userId: userIds.nikita, password: PASSWORDS.nikita }, AUDIT);

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
      ["lora-vip-of", createOnlyFansPage],
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
    for (const [label, account] of [["lora-of", "100000001"], ["lora-vip-of", "100000002"], ["mia-of", "100000003"]]) {
      await testDb.pool.query("update pages set external_page_id = $1 where id = $2", [account, pageIds[label!]]);
    }
    for (const [userId, labels] of [
      [userIds.grisha, ["lora-of", "lora-vip-of", "lora-fansly"]],
      [userIds.nikita, ["lora-of"]],
      [userIds.lead, ["lora-of"]],
      [userIds.sveta, ["mia-of"]],
    ] as const) {
      for (const pageLabel of labels) {
        await assignPageToUser(app, { userId, pageLabel }, AUDIT);
      }
    }
    // The fan's chat: enough archived messages for a full Recap, and unread
    // messages so the trap's unread check has something to hold.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
       select $1, 'onlyfans', $2, (9000 + g)::text, case when g % 2 = 1 then $2 end, g % 2 = 0,
              now() - (g || ' hours')::interval, 'archived message ' || g, false, 0
       from generate_series(1, $3::int) g`,
      [pageIds["lora-of"], FAN, CHAT_MESSAGES],
    );
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, $2, 3)",
      [pageIds["lora-of"], FAN],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: userIds.owner, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: userIds.lead, label: "lead client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: userIds.sveta, label: "sveta client" })).token;
    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: userIds.grisha, label: "grisha desktop" })).token;
    await insertAgentKey(app.db, {
      name: "client-dossier-probe",
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
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("is inert at merge: nothing is saved until the owner switches Recap on, and the owner's switches decide after", async (context) => {
    if (!server) return context.skip();
    const generationRef = await seedGeneration({ text: "FULL RECAP" });

    for (const token of [grishaToken, grishaFullToken]) {
      expectRefused(await save(token, { generationRef }), 409, "client_feature_disabled", "disabled");
    }
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expectRefused(await save(grishaToken, { generationRef }), 409, "client_feature_disabled", "flag_off");
    // The switch answers before the generation is looked at: an unknown one reads the same.
    expectRefused(await save(grishaToken, { generationRef: randomUUID() }), 409, "client_feature_disabled", "flag_off");
    expect(await count("fan_profiles")).toBe(0);
    expect(await count("fans")).toBe(0);

    await switchRecapOn();
    // The feature exists on OnlyFans only.
    expectRefused(await save(grishaToken, { generationRef, pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    // An old client's version, or none, is not the extension: refused, never passed.
    for (const clientVersion of ["chatgoose-extension/2.7.1", "0.1.64", null]) {
      expectRefused(await save(grishaFullToken, { generationRef, clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.5.0" }]);
    expectRefused(await save(grishaToken, { generationRef }), 409, "client_feature_disabled", "client_outdated");
    // The page's own flag wins over "*".
    await patchConfig([
      { key: "chatExtensionMinVersion", value: "1.4.2" },
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { recap: true }, "lora-of": { recap: false } }) },
    ]);
    expectRefused(await save(grishaToken, { generationRef }), 409, "client_feature_disabled", "flag_off");
    expect(await count("fan_profiles")).toBe(0);

    await patchConfig([{ key: "chatExtensionFeatures", value: JSON.stringify({ "*": { recap: true } }) }]);
    expect((await saveOk(grishaToken, { generationRef })).outcome).toBe("created");
    // The master switch ends everything, a saved dossier's repeat included.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    expectRefused(await save(grishaToken, { generationRef }), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the extension's full Recap becomes the fan's dossier by reference, once, and the prompts use it", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    app.config.chatMuseAiFanProfileContextFeatures = "all";
    const recapText = "DOSSIER_MARKER the fan likes hiking and tips on Fridays";

    // The full Recap as the extension asks for it: its narrow token, the fan in both refs.
    script.text = recapText;
    const clientRequestId = randomUUID();
    const recap = streamed(await generate("fan-summary", clientRequestId));
    expect(recap.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    const generatedAt = (await testDb!.pool.query<{ created_at: Date }>(
      "select created_at from ai_generation_content where generation_ref = $1",
      [recap.generationRef],
    )).rows[0]!.created_at;
    // The hub had never seen this fan: no fan row, no dossier.
    expect(await count("fans")).toBe(0);

    const created = await saveOk(grishaToken, { generationRef: recap.generationRef, clientRequestId });
    expect(created).toEqual({
      outcome: "created",
      profile: { version: 1, createdAt: expect.any(String), sourceGeneratedAt: generatedAt.toISOString() },
    });
    // The hub copied the text from its own record: byte for byte the model's output,
    // stamped with the hub's time of the generation and its author.
    expect(await dossier()).toEqual([{
      version: 1,
      body: recapText,
      source: "chatmuse",
      created_by_user_id: userIds.grisha,
      source_generated_at: generatedAt,
    }]);

    // Asked again (a lost answer, a second tab, a reload): the same version, nothing written.
    for (const repeat of [{ clientRequestId }, {}]) {
      expect(await saveOk(grishaToken, { generationRef: recap.generationRef, ...repeat }))
        .toEqual({ outcome: "existing", profile: created.profile });
    }
    // The same person's full token saves by reference as well.
    expect((await saveOk(grishaFullToken, { generationRef: recap.generationRef })).outcome).toBe("existing");
    expect(await dossier()).toHaveLength(1);

    // An installed client reads it through the route it always used, in the shape it always had.
    const read = await server.inject({
      method: "GET",
      url: `/api/v1/pages/lora-of/fans/${FAN}/profile`,
      headers: bearer(grishaFullToken, "0.1.64"),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(fanProfileResponseSchema.parse(read.json()).profile).toEqual({
      version: 1,
      body: recapText,
      source: "chatmuse",
      createdAt: created.profile.createdAt,
      sourceGeneratedAt: generatedAt.toISOString(),
      createdByUserId: userIds.grisha,
    });
    // The shared recaps read says the full recap is saved, to every chatter of the page.
    const shared = await server.inject({
      method: "GET",
      url: `/api/v1/client/pages/lora-of/conversations/${FAN}/recaps`,
      headers: bearer(nikitaToken),
    });
    expect(clientConversationRecapsResponseSchema.parse(shared.json())).toMatchObject({
      full: { generationRef: recap.generationRef, text: recapText },
      fullSavedToProfile: true,
    });

    // The dossier is one the prompts may use: the hub proves it by the very
    // generation it was saved from, so the next reply reads it.
    script.text = "a reply";
    const reply = streamed(await generate("fast-reply", randomUUID(), { replyTone: "casual" }));
    const prompt = JSON.stringify(providerCapture.input!.body.prompt);
    expect(prompt).toContain("## Fan Dossier");
    expect(prompt).toContain(recapText);
    const replyRecord = await testDb!.pool.query<{ params: { contextManifest: { fanProfile: unknown } } }>(
      "select params from ai_generation_content where generation_ref = $1",
      [reply.generationRef],
    );
    expect(replyRecord.rows[0]!.params.contextManifest.fanProfile)
      .toMatchObject({ version: 1, generatedAt: generatedAt.toISOString() });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a generation still in flight answers generation_not_ready to its own request id, and 404 to anyone else", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    script.text = "IN FLIGHT RECAP";
    let release!: () => void;
    script.gate = new Promise<void>((resolve) => { release = resolve; });
    const asked = new Promise<string>((resolve) => { script.started = resolve; });

    const clientRequestId = randomUUID();
    // `.then` sends the request; the provider holds it before its first frame.
    const streaming = generate("fan-summary", clientRequestId).then((response) => response);
    const generationRef = await asked;
    expect(await count("ai_generation_content")).toBe(0);

    // The gateway admitted the request and has not recorded the generation yet.
    expectRefused(await save(grishaToken, { generationRef, clientRequestId }), 409, "generation_not_ready");
    expectRefused(await save(grishaFullToken, { generationRef, clientRequestId }), 409, "generation_not_ready");
    // Without its request id the hub cannot tell it from a generation that never was.
    expectRefused(await save(grishaToken, { generationRef }), 404, "not_found");
    // The request id is the caller's own: another chatter of the page, even with both ids, learns nothing.
    expectRefused(await save(nikitaToken, { generationRef, clientRequestId }), 404, "not_found");
    // A request of another page of the caller's never becomes this page's dossier.
    expectRefused(await save(grishaToken, { generationRef, clientRequestId, pageLabel: "lora-vip-of" }), 404, "not_found");
    expect(await count("fan_profiles")).toBe(0);
    expect(await count("fans")).toBe(0);

    release();
    expect(streamed(await streaming).generationRef).toBe(generationRef);
    // Recorded: the very same request now saves.
    expect((await saveOk(grishaToken, { generationRef, clientRequestId })).outcome).toBe("created");
    expect((await dossier()).map((version) => version.body)).toEqual(["IN FLIGHT RECAP"]);

    // A record that was never written (its insert failed after the ledger
    // settled) answers not-ready for good: the client bounds its repeats.
    script.gate = null;
    script.started = null;
    script.text = "LOST RECAP";
    const lostRequestId = randomUUID();
    const lost = streamed(await generate("fan-summary", lostRequestId));
    await testDb!.pool.query("delete from ai_generation_content where generation_ref = $1", [lost.generationRef]);
    expectRefused(await save(grishaToken, { generationRef: lost.generationRef, clientRequestId: lostRequestId }), 409, "generation_not_ready");
    expectRefused(await save(grishaToken, { generationRef: lost.generationRef }), 404, "not_found");

    // A request the gateway never admitted leaves no record to wait for: a
    // quota refusal, and a usage row an older client reported itself.
    const usage = {
      feature: "fan-summary" as const,
      model: "m",
      pageId: pageIds["lora-of"]!,
      isRegeneration: false,
    };
    const denied = randomUUID();
    await recordAiGatewayQuotaDenied(app.db, {
      userId: userIds.grisha,
      event: { ...usage, clientEventId: denied, provider: null, reservedAt: new Date() },
    });
    const reported = randomUUID();
    await insertAiUsageEvents(app.db, {
      userId: userIds.grisha,
      events: [{
        ...usage,
        clientEventId: reported,
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        isCacheHit: false,
        completedAt: new Date(),
      }],
    });
    for (const neverAdmitted of [denied, reported, randomUUID()]) {
      expectRefused(await save(grishaToken, { generationRef: randomUUID(), clientRequestId: neverAdmitted }), 404, "not_found");
    }
    // An admitted request of the other page is in flight there, and only there.
    const elsewhere = randomUUID();
    expect(await reserveAiGatewayUsageEvent(app.db, {
      userId: userIds.grisha,
      event: { ...usage, clientEventId: elsewhere, pageId: pageIds["lora-vip-of"]!, provider: "anthropic", reservedAt: new Date() },
    })).toBe(true);
    expectRefused(await save(grishaToken, { generationRef: randomUUID(), clientRequestId: elsewhere }), 404, "not_found");
    expectRefused(
      await save(grishaToken, { generationRef: randomUUID(), clientRequestId: elsewhere, pageLabel: "lora-vip-of" }),
      409,
      "generation_not_ready",
    );
    expect(await dossier()).toHaveLength(1);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("finds only the caller's own generation of this page and this fan; anything else is 404, the owner's reach included", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const nikitas = await seedGeneration({ text: "NIKITA RECAP", userId: userIds.nikita, at: minutesAgo(60) });
    const authorless = await seedGeneration({ text: "AUTHORLESS RECAP", userId: null });
    const otherFan = await seedGeneration({ text: "OTHER FAN RECAP", conversationRef: OTHER_FAN, at: minutesAgo(50) });
    const otherPage = await seedGeneration({ text: "VIP PAGE RECAP", pageLabel: "lora-vip-of" });
    // Records whose chat and fan differ. The transcript is read by the
    // conversation and the fan's data by the fan, so each mixes two fans.
    const aboutOtherFan = await seedGeneration({ text: "ABOUT OTHER FAN", conversationRef: FAN, fanRef: OTHER_FAN, at: minutesAgo(40) });
    const otherChat = await seedGeneration({ text: "OTHER CHAT RECAP", conversationRef: OTHER_FAN, fanRef: FAN, at: minutesAgo(35) });
    // A conversation with an id of its own, about FAN: no OnlyFans chat has one.
    const groupChat = await seedGeneration({ text: "GROUP CHAT RECAP", conversationRef: "group-900", fanRef: FAN, at: minutesAgo(20) });
    // The record as the extension's own requests make it: the fan in both refs.
    const bothRefs = await seedGeneration({ text: "BOTH REFS RECAP", conversationRef: FAN, fanRef: FAN, at: minutesAgo(10) });

    const unknown = await save(grishaToken, { generationRef: randomUUID() });
    expectRefused(unknown, 404, "not_found");
    // Another person's generation reads exactly as one that does not exist, to
    // a chatter of the same page, to the team lead and to the owner alike.
    for (const token of [grishaToken, grishaFullToken, leadToken, ownerToken]) {
      const refused = await save(token, { generationRef: nikitas });
      expectRefused(refused, 404, "not_found");
      expect(refused.json()).toEqual(unknown.json());
    }
    for (const token of [grishaToken, nikitaToken, ownerToken]) {
      expectRefused(await save(token, { generationRef: authorless }), 404, "not_found");
    }
    // The caller's own, of another fan or another page.
    expectRefused(await save(grishaToken, { generationRef: otherFan }), 404, "not_found");
    expectRefused(await save(grishaToken, { generationRef: otherPage }), 404, "not_found");
    expectRefused(await save(grishaToken, { generationRef: nikitas, pageLabel: "lora-vip-of" }), 404, "not_found");
    // A record that mixes two fans is neither fan's dossier: not the one whose
    // chat was read, not the one it was stored about.
    for (const mixed of [aboutOtherFan, otherChat, groupChat]) {
      for (const fan of [FAN, OTHER_FAN]) {
        expectRefused(await save(grishaToken, { generationRef: mixed, fan }), 404, "not_found");
      }
    }
    // The AI route records what a request asks, and nothing makes a Recap's
    // two refs agree there. So the extension's own token can make such a
    // record; it still saves it for nobody.
    script.text = "RECAP OF ONE CHAT NAMING ANOTHER FAN";
    const askedId = randomUUID();
    const asked = streamed(await generate("fan-summary", askedId, { fanRef: OTHER_FAN }));
    const { rows: [recorded] } = await testDb!.pool.query<{ conversation_ref: string; fan_ref: string | null }>(
      "select conversation_ref, fan_ref from ai_generation_content where generation_ref = $1",
      [asked.generationRef],
    );
    expect(recorded).toEqual({ conversation_ref: FAN, fan_ref: OTHER_FAN });
    for (const fan of [FAN, OTHER_FAN]) {
      expectRefused(await save(grishaToken, { generationRef: asked.generationRef, clientRequestId: askedId, fan }), 404, "not_found");
      expectRefused(await save(grishaFullToken, { generationRef: asked.generationRef, fan }), 404, "not_found");
    }
    expect(await count("fan_profiles")).toBe(0);
    expect(await count("fans")).toBe(0);
    expect(await count("page_fans")).toBe(0);

    // Each is saved where it belongs, by its author.
    expect((await saveOk(nikitaToken, { generationRef: nikitas })).outcome).toBe("created");
    expect((await saveOk(grishaToken, { generationRef: bothRefs })).outcome).toBe("created");
    expect((await saveOk(grishaToken, { generationRef: otherFan, fan: OTHER_FAN })).outcome).toBe("created");
    expect((await saveOk(grishaToken, { generationRef: otherPage, pageLabel: "lora-vip-of" })).outcome).toBe("created");
    expect((await dossier()).map((version) => [version.body, version.created_by_user_id])).toEqual([
      ["NIKITA RECAP", userIds.nikita],
      ["BOTH REFS RECAP", userIds.grisha],
    ]);
    expect((await dossier("lora-of", OTHER_FAN)).map((version) => version.body)).toEqual(["OTHER FAN RECAP"]);
    expect((await dossier("lora-vip-of")).map((version) => version.body)).toEqual(["VIP PAGE RECAP"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses what is not a usable full recap with generation_not_eligible and the reason, and writes nothing", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const refusals: Array<[string, Parameters<typeof seedGeneration>[0]]> = [
      ["not_full_summary", { text: "SHORT RECAP", params: { summaryMode: "short" } }],
      ["not_full_summary", { text: "CHAT REVIEW", feature: "chat-review", rawParams: { outcome: "completed", stopReason: "end_turn" } }],
      ["not_full_summary", { text: "COACH ANSWER", feature: "coach-chat" }],
      // A recap that predates the mode.
      ["not_full_summary", { text: "LEGACY RECAP", rawParams: { outcome: "completed", stopReason: "end_turn" } }],
      ["not_completed", { text: "PARTIAL", params: { outcome: "failed", stopReason: null } }],
      ["not_completed", { text: "PARTIAL TOO", params: { outcome: "cancelled", stopReason: null } }],
      ["stop_reason_missing", { text: "NO STOP REASON", params: { stopReason: null } }],
      ["output_exhausted", { text: "EXHAUSTED", params: { stopReason: "max_tokens" } }],
      ["output_exhausted", { text: "EXHAUSTED TOO", params: { stopReason: "length" } }],
      ["empty", { text: "" }],
      ["empty", { text: " \t\n  " }],
      // Generated from context only its caller saw: that person's draft, never a dossier.
      ["context_scope", { text: "DRAFT RECAP", params: { contextScope: "principal-draft" } }],
      ["too_long", { text: "x".repeat(DOSSIER_BODY_MAX_CHARS + 1) }],
    ];
    for (const [reason, generation] of refusals) {
      const generationRef = await seedGeneration(generation);
      const refused = await save(grishaToken, { generationRef });
      expectRefused(refused, 409, "generation_not_eligible", reason);
      // The refusal never carries the generation's text.
      if (generation.text.trim().length > 0) {
        expect(refused.body, reason).not.toContain(generation.text.slice(0, 40));
      }
    }
    // Not the dossier, and not a fan row either: a refusal leaves no trace.
    expect(await count("fan_profiles")).toBe(0);
    expect(await count("fans")).toBe(0);
    expect(await count("page_fans")).toBe(0);

    // The longest text a dossier may have is saved.
    const longest = await seedGeneration({ text: "y".repeat(DOSSIER_BODY_MAX_CHARS) });
    expect((await saveOk(grishaToken, { generationRef: longest })).outcome).toBe("created");

    // A fan the platform sync flagged deleted keeps the 404 of every dossier write.
    await upsertFans(app.db, [{ platform: "onlyfans", platformUserId: OTHER_FAN }]);
    await testDb!.pool.query("update fans set deleted_detected_at = now() where platform_user_id = $1", [OTHER_FAN]);
    const deletedFans = await seedGeneration({ text: "DELETED FAN RECAP", conversationRef: OTHER_FAN });
    expectRefused(await save(grishaToken, { generationRef: deletedFans, fan: OTHER_FAN }), 404, "not_found");
    expect(await dossier("lora-of", OTHER_FAN)).toEqual([]);
    expect(await count("page_fans")).toBe(1);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is idempotent across versions: a text the dossier already has is `existing`, and an older generation never supersedes a newer dossier", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const recapAAt = minutesAgo(120);
    const recapA = await seedGeneration({ text: "RECAP A", at: recapAAt });
    const first = await saveOk(grishaToken, { generationRef: recapA });
    expect(first).toMatchObject({ outcome: "created", profile: { version: 1, sourceGeneratedAt: recapAAt.toISOString() } });

    // An installed client writes a version in between, the older way: the text
    // and its time are the client's. That write stays, for the full token.
    const scanAt = minutesAgo(60);
    const scan = await olderWrite(grishaFullToken, "DESKTOP SCAN", scanAt);
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json()).toMatchObject({ version: 2, source: "chatmuse" });
    // The extension's token never writes the older way: it saves by reference only.
    expect((await olderWrite(grishaToken, "EXTENSION TEXT")).statusCode).toBe(403);

    // Recap A again, after the intermediate version: still version 1, nothing appended.
    expect(await saveOk(grishaToken, { generationRef: recapA })).toEqual({ outcome: "existing", profile: first.profile });
    expect(await dossier()).toHaveLength(2);

    // A generation older than the dossier's latest text is superseded for good.
    const stale = await seedGeneration({ text: "STALE RECAP", at: minutesAgo(90) });
    expectRefused(await save(grishaToken, { generationRef: stale }), 409, "generation_not_eligible", "superseded");
    expect(await dossier()).toHaveLength(2);

    // A newer one becomes the next version.
    const recapBAt = minutesAgo(30);
    const recapB = await seedGeneration({ text: "RECAP B", at: recapBAt });
    const third = await saveOk(grishaToken, { generationRef: recapB });
    expect(third).toMatchObject({ outcome: "created", profile: { version: 3, sourceGeneratedAt: recapBAt.toISOString() } });

    // Asked several times at once, a generation is written once.
    const racedAt = minutesAgo(20);
    const raced = await seedGeneration({ text: "RACED RECAP", at: racedAt });
    const answers = await Promise.all(Array.from({ length: 4 }, () => saveOk(grishaToken, { generationRef: raced })));
    expect(answers.map((answer) => answer.outcome).sort()).toEqual(["created", "existing", "existing", "existing"]);
    expect(new Set(answers.map((answer) => JSON.stringify(answer.profile))).size).toBe(1);
    expect(answers[0]!.profile).toMatchObject({ version: 4, sourceGeneratedAt: racedAt.toISOString() });

    // Another generation with the very same text as an older version: the dossier already has it.
    const sameText = await seedGeneration({ text: "RECAP B", at: minutesAgo(10) });
    expect(await saveOk(grishaToken, { generationRef: sameText })).toEqual({ outcome: "existing", profile: third.profile });
    // So does one whose text an installed client had written itself; that version keeps the client's time.
    const scanned = await seedGeneration({ text: "DESKTOP SCAN", at: minutesAgo(8) });
    expect(await saveOk(grishaToken, { generationRef: scanned }))
      .toMatchObject({ outcome: "existing", profile: { version: 2, sourceGeneratedAt: scanAt.toISOString() } });
    // A version written without a generation time answers null for it.
    expect((await olderWrite(grishaFullToken, "LEGACY SCAN")).json()).toMatchObject({ version: 5 });
    const legacy = await seedGeneration({ text: "LEGACY SCAN", at: minutesAgo(1) });
    expect(await saveOk(grishaToken, { generationRef: legacy }))
      .toMatchObject({ outcome: "existing", profile: { version: 5, sourceGeneratedAt: null } });

    expect((await dossier()).map((version) => version.body))
      .toEqual(["RECAP A", "DESKTOP SCAN", "RECAP B", "RACED RECAP", "LEGACY SCAN"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes; a page that is not the caller's saves nothing", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const own = {
      owner: await seedGeneration({ text: "OWNER RECAP", userId: userIds.owner, at: minutesAgo(50) }),
      ownerMia: await seedGeneration({ text: "OWNER MIA RECAP", userId: userIds.owner, pageLabel: "mia-of", at: minutesAgo(20) }),
      lead: await seedGeneration({ text: "LEAD RECAP", userId: userIds.lead, at: minutesAgo(40) }),
      grisha: await seedGeneration({ text: "GRISHA RECAP", at: minutesAgo(30) }),
      grishaMia: await seedGeneration({ text: "GRISHA MIA RECAP", pageLabel: "mia-of" }),
      sveta: await seedGeneration({ text: "SVETA RECAP", userId: userIds.sveta, pageLabel: "mia-of", at: minutesAgo(10) }),
    };

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
    const cells: Array<{ who: string; headers: Record<string, string>; generationRef: string; page?: string; status: number }> = [
      { who: "anonymous", headers: {}, generationRef: own.grisha, status: 401 },
      { who: "unknown bearer", headers: { authorization: "Bearer agency_hub_device_not-a-real-token" }, generationRef: own.grisha, status: 401 },
      { who: "owner cookie", headers: { cookie: await cookieOf("owner") }, generationRef: own.owner, status: 403 },
      { who: "team_lead cookie", headers: { cookie: await cookieOf("lead") }, generationRef: own.lead, status: 403 },
      { who: "chatter cookie", headers: { cookie: await cookieOf("grisha") }, generationRef: own.grisha, status: 403 },
      // Live and granted lora-of: refused by kind.
      { who: "agent key", headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` }, generationRef: own.grisha, status: 403 },
      { who: "owner device token", headers: bearer(ownerToken), generationRef: own.owner, status: 200 },
      // The owner is granted every page.
      { who: "owner device token, mia-of", headers: bearer(ownerToken), generationRef: own.ownerMia, page: "mia-of", status: 200 },
      { who: "team_lead device token", headers: bearer(leadToken), generationRef: own.lead, status: 200 },
      { who: "chatter device token", headers: bearer(grishaFullToken), generationRef: own.grisha, status: 200 },
      { who: "chatter chat-extension token", headers: bearer(grishaToken), generationRef: own.grisha, status: 200 },
    ];

    for (const mode of ["log", "enforce"] as const) {
      app.config.authPolicyEnforcement = mode;
      for (const cell of cells) {
        const label = `${mode} mode, ${cell.who}`;
        const response = await server.inject({
          method: "POST",
          url: saveUrl(cell.page),
          headers: { ...version, ...cell.headers },
          payload: { generationRef: cell.generationRef },
        });
        expect(response.statusCode, `${label}: ${response.body}`).toBe(cell.status);
        if (cell.status === 200) {
          expect(clientFanProfileFromGenerationResponseSchema.safeParse(response.json()).success, label).toBe(true);
          continue;
        }
        // Every refusal is the declared error body.
        const error = errorResponseSchema.parse(response.json());
        expect(error.error, label).toBe(cell.status === 401 ? "unauthorized" : "forbidden");
      }

      // A page that is not the caller's, and one that does not exist. Enforced,
      // the declared page scope answers before the handler (403, 404); in log
      // mode the hub's own feature check answers both the same. Either way the
      // caller's own generation on a page that was taken from it saves nothing.
      for (const token of [grishaToken, grishaFullToken]) {
        const foreign = await save(token, { generationRef: own.grishaMia, pageLabel: "mia-of" });
        const missing = await save(token, { generationRef: own.grisha, pageLabel: "ghost-of" });
        if (mode === "enforce") {
          expectRefused(foreign, 403, "forbidden");
          expectRefused(missing, 404, "not_found");
        } else {
          expectRefused(foreign, 409, "client_feature_disabled", "not_granted");
          expectRefused(missing, 409, "client_feature_disabled", "not_granted");
        }
      }
      // The page's own chatter still saves there.
      expect(["created", "existing"]).toContain((await saveOk(svetaToken, { generationRef: own.sveta, pageLabel: "mia-of" })).outcome);
    }

    // Each author's own text, once, where it belongs; nothing of grisha's on mia-of.
    expect((await dossier()).map((entry) => [entry.body, entry.created_by_user_id])).toEqual([
      ["OWNER RECAP", userIds.owner],
      ["LEAD RECAP", userIds.lead],
      ["GRISHA RECAP", userIds.grisha],
    ]);
    expect((await dossier("mia-of")).map((entry) => entry.body)).toEqual(["OWNER MIA RECAP", "SVETA RECAP"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a malformed request: the fan id's one shape and a strict body that carries no text", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const generationRef = await seedGeneration({ text: "FULL RECAP" });

    const requests: Array<[string, unknown]> = [
      ["0777", { generationRef }],
      ["group-777", { generationRef }],
      ["7".repeat(31), { generationRef }],
      [FAN, {}],
      [FAN, { generationRef: "" }],
      [FAN, { generationRef: "g".repeat(101) }],
      [FAN, { generationRef, clientRequestId: "not-a-request-id" }],
      // The text, its time, the fan and the page are never the client's to send here.
      [FAN, { generationRef, body: "a dossier the client wrote" }],
      [FAN, { generationRef, generatedAtMs: Date.now() }],
      [FAN, { generationRef, fanRef: OTHER_FAN }],
      [FAN, { generationRef, pageLabel: "mia-of" }],
    ];
    for (const [fan, payload] of requests) {
      const response = await server.inject({ method: "POST", url: saveUrl("lora-of", fan), headers: bearer(grishaToken), payload: payload as object });
      const label = `${fan} ${JSON.stringify(payload)}`;
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(errorResponseSchema.safeParse(response.json()).success, label).toBe(true);
    }
    expect(await count("fan_profiles")).toBe(0);
    // The request id in the client's own form (any 8-4-4-4-12 hex) is taken.
    expect((await saveOk(grishaToken, { generationRef, clientRequestId: "11111111-1111-1111-1111-111111111111" })).outcome).toBe("created");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
