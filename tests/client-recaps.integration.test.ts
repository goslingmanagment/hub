import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientBootstrapResponseSchema,
  clientConversationRecapsResponseSchema,
  errorResponseSchema,
} from "@agency_hub_core/contracts";
import {
  appendFanProfile,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertAgentKey,
  insertAiGenerationContent,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertFanPages,
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

// chat-extension H-13: GET /api/v1/client/pages/:pageLabel/conversations/:fanRef/recaps,
// the shared recaps of one fan with their text. Every test runs under the
// no-outbound trap: the route reads the database and nothing else.

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret", nikita: "nikita-secret" } as const;
const AUDIT = { source: "cli" } as const;
const FAN = "777000777";
const OTHER_FAN = "777000888";
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key, granted lora-of: its refusal is about the principal kind, not a page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientrecaps00000000`;
/** In every seeded generation's prompt blocks: must never leave through the route. */
const PROMPT_SECRET = "PROMPT_BLOCK_SECRET";
const OTHER_PERSONA = `v1:${"b".repeat(43)}`;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

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
let grishaId = 0;
let personaDefinitionId = "";
const pageIds: Record<string, number> = {};
const providerCapture: { input?: AiGatewayProviderInput } = {};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      providerCapture.input = input;
      yield { type: "content_delta", text: "coach answer" };
      yield {
        type: "usage",
        providerResponseId: "msg_recaps",
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

function recapsUrl(pageLabel = "lora-of", fan = FAN, query = "") {
  return `/api/v1/client/pages/${pageLabel}/conversations/${fan}/recaps${query}`;
}

async function recaps(token: string, input: { pageLabel?: string; fan?: string; query?: string; clientVersion?: string | null } = {}) {
  return server!.inject({
    method: "GET",
    url: recapsUrl(input.pageLabel, input.fan, input.query),
    headers: bearer(token, input.clientVersion),
  });
}

/** A 200 whose body is the declared shape and nothing more. */
async function recapsOk(token: string, input: Parameters<typeof recaps>[1] = {}) {
  const response = await recaps(token, input);
  expect(response.statusCode, response.body).toBe(200);
  const body = clientConversationRecapsResponseSchema.parse(response.json());
  // The schema is not strict and would strip a key it does not know: nothing was stripped.
  expect(response.json()).toEqual(body);
  expect(response.body).not.toContain(PROMPT_SECRET);
  return { body, raw: response.body };
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
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

/** The owner's switches as a pilot page has them: the extension on, Recap and Coach on. */
async function switchRecapOn() {
  await patchConfig([
    { key: "chatExtensionEnabled", value: true },
    { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { recap: true, coach: true } }) },
  ]);
}

/**
 * One stored generation, as the gateway writes a fan-summary: featureParams at
 * the top level of `params`. On OnlyFans the conversation ref is the fan id.
 * `rawParams` replaces the params whole (legacy and broken rows).
 */
async function seedRecap(input: {
  mode: "full" | "short";
  text: string;
  at: Date;
  pageLabel?: string;
  fan?: string;
  persona?: string | null;
  userId?: number | null;
  feature?: string;
  params?: Record<string, unknown>;
  rawParams?: Record<string, unknown>;
}): Promise<string> {
  const generationRef = randomUUID();
  const persona = input.persona === undefined ? personaDefinitionId : input.persona;
  await insertAiGenerationContent(app.db, {
    usageEventId: null,
    generationRef,
    feature: input.feature ?? "fan-summary",
    model: "m",
    provider: "anthropic",
    userId: input.userId ?? null,
    pageId: pageIds[input.pageLabel ?? "lora-of"]!,
    conversationRef: input.fan ?? FAN,
    fanRef: null,
    promptBlocks: [{ type: "text", text: PROMPT_SECRET }],
    completion: input.text,
    params: input.rawParams ?? {
      summaryMode: input.mode,
      ...(persona ? { personaDefinitionId: persona } : {}),
      outcome: "completed",
      stopReason: "end_turn",
      ...input.params,
    },
  });
  // insertAiGenerationContent has no createdAt input; recency decides the slot.
  await testDb!.pool.query(
    "update ai_generation_content set created_at = $1 where generation_ref = $2",
    [input.at.toISOString(), generationRef],
  );
  return generationRef;
}

/** The fan as a page's dossier knows them: the fan row and its page membership. */
async function seedFan(pageLabel = "lora-of", fan = FAN) {
  const [row] = await upsertFans(app.db, [{ platform: "onlyfans", platformUserId: fan }]);
  await upsertFanPages(app.db, [{ fanId: row!.id, platformAccountId: pageIds[pageLabel]! }]);
  return { fanId: row!.id, platformAccountId: pageIds[pageLabel]!, source: "chatmuse" };
}

async function recapStatus(token: string, withPersona = true) {
  const persona = withPersona ? `&personaDefinitionId=${encodeURIComponent(personaDefinitionId)}` : "";
  return server!.inject({
    method: "GET",
    url: `/api/v1/ai/recap-status?pageLabel=lora-of&conversationRef=${FAN}${persona}`,
    headers: bearer(token),
  });
}

/** One Coach turn on the fan's chat; returns the prompt the provider received and the meta frame. */
async function coach(token: string) {
  delete providerCapture.input;
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/ai/features/coach-chat",
    headers: bearer(token),
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: "lora-of",
      platform: "onlyfans",
      conversationRef: FAN,
      chatterQuestion: "what should I say next?",
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const meta = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>)[0];
  return { prompt: JSON.stringify(providerCapture.input), meta };
}

describe("GET /api/v1/client/pages/:pageLabel/conversations/:fanRef/recaps", () => {
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
    grishaId = await fixtureUserId(app, "grisha");
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
    // The fan's chat: a few archived messages for Coach, and unread messages
    // so the trap's unread check has something to hold.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
       select $1, 'onlyfans', $2, (9000 + g)::text, case when g % 2 = 1 then $2 end, g % 2 = 0,
              now() - (g || ' hours')::interval, 'archived message ' || g, false, 0
       from generate_series(1, 4) g`,
      [pageIds["lora-of"], FAN],
    );
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, $2, 3)",
      [pageIds["lora-of"], FAN],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: leadId, label: "lead client" })).token;
    svetaToken = (await issueDeviceTokenForUserId(app, { userId: svetaId, label: "sveta client" })).token;
    grishaFullToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha desktop" })).token;
    await insertAgentKey(app.db, {
      name: "client-recaps-probe",
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

    const catalog = await server.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: bearer(grishaToken),
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    personaDefinitionId = catalog.json<{ personas: Array<{ key: string; definitionId: string }> }>()
      .personas.find((entry) => entry.key === persona.id)!.definitionId;

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

  it("is inert at merge: off until the owner switches Recap on, then the owner's switches decide", async (context) => {
    if (!server) return context.skip();
    await seedRecap({ mode: "full", text: "FULL RECAP", at: minutesAgo(5) });
    const recapFeature = async () => {
      const bootstrap = await server!.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers: bearer(grishaToken) });
      const announced = clientBootstrapResponseSchema.parse(bootstrap.json());
      // The hub serves both halves of Recap: the shared read and the dossier save (H-5).
      expect(announced.capabilities).toEqual(expect.arrayContaining(["shared-recaps-v1", "recap-profile-v1"]));
      return announced.pages.find((page) => page.pageLabel === "lora-of")?.features.recap;
    };

    // The hub as it rests: nothing is served until the owner says so.
    for (const token of [grishaToken, grishaFullToken, ownerToken]) {
      const refused = await recaps(token);
      expectRefused(refused, 409, "client_feature_disabled", "disabled");
      expect(refused.body).not.toContain("FULL RECAP");
    }
    expect(await recapFeature()).toEqual({ available: false, reason: "disabled" });

    await switchRecapOn();
    expect(await recapFeature()).toEqual({ available: true });
    expect((await recapsOk(grishaToken)).body.full?.text).toBe("FULL RECAP");
    expectRefused(await recaps(grishaToken, { pageLabel: "lora-fansly" }), 409, "client_feature_disabled", "platform_unsupported");
    // An old client's version, or none, is not the extension: refused, never passed.
    for (const clientVersion of ["chatgoose-extension/2.7.1", "0.1.64", null]) {
      expectRefused(await recaps(grishaFullToken, { clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.5.0" }]);
    expectRefused(await recaps(grishaToken), 409, "client_feature_disabled", "client_outdated");
    await patchConfig([{ key: "chatExtensionMinVersion", value: "1.4.2" }]);
    expect((await recaps(grishaToken)).statusCode).toBe(200);

    // The page's own flag wins over "*"; the master switch ends everything.
    await patchConfig([{
      key: "chatExtensionFeatures",
      value: JSON.stringify({ "*": { recap: true }, "lora-of": { recap: false } }),
    }]);
    expectRefused(await recaps(grishaToken), 409, "client_feature_disabled", "flag_off");
    await patchConfig([
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { recap: true } }) },
      { key: "chatExtensionEnabled", value: false },
    ]);
    expectRefused(await recaps(grishaToken), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("two chatters of one page read the same recap, whoever generated it; text and provenance only", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const fullAt = minutesAgo(90);
    const shortAt = minutesAgo(30);
    // Generated by grisha; an older full of his is superseded.
    await seedRecap({ mode: "full", text: "OLDER FULL", at: minutesAgo(600), userId: grishaId });
    const fullRef = await seedRecap({
      mode: "full",
      text: "FULL RECAP\n\nwith two paragraphs",
      at: fullAt,
      userId: grishaId,
      params: {
        transcriptCoverage: "full-history",
        requestedCount: 1500,
        keptCount: 1432,
        contextManifest: { source: "union", note: "MANIFEST_SECRET" },
      },
    });
    const shortRef = await seedRecap({
      mode: "short",
      text: "SHORT RECAP",
      at: shortAt,
      userId: grishaId,
      params: { transcriptCoverage: "window", requestedCount: 300, keptCount: 300 },
    });
    const before = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from ai_generation_content");

    const mine = await recapsOk(grishaToken);
    expect(mine.body).toEqual({
      full: {
        generationRef: fullRef,
        generatedAt: fullAt.toISOString(),
        personaDefinitionId,
        coverage: { transcriptCoverage: "full-history", requestedCount: 1500, keptCount: 1432 },
        text: "FULL RECAP\n\nwith two paragraphs",
      },
      short: {
        generationRef: shortRef,
        generatedAt: shortAt.toISOString(),
        personaDefinitionId,
        coverage: { transcriptCoverage: "window", requestedCount: 300, keptCount: 300 },
        text: "SHORT RECAP",
      },
      fullSavedToProfile: false,
    });
    // No author, no manifest, no prompt block: the answer does not say who generated it.
    expect(mine.raw).not.toMatch(/MANIFEST_SECRET|userId|contextManifest|promptBlocks/);

    // The other chatter of the page, the team lead, the owner and the same
    // chatter's full token all read the very same bytes.
    for (const token of [nikitaToken, leadToken, ownerToken, grishaFullToken]) {
      expect((await recapsOk(token)).raw).toBe(mine.raw);
    }
    // With the persona named, as the client asks: the same two rows.
    const named = await recapsOk(nikitaToken, { query: `?personaDefinitionId=${encodeURIComponent(personaDefinitionId)}` });
    expect(named.raw).toBe(mine.raw);

    // A read: it generates nothing.
    const after = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from ai_generation_content");
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("selects one persona's recaps when asked, and the freshest of any persona when not", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    await seedRecap({ mode: "full", text: "DEFAULT FULL", at: minutesAgo(50) });
    await seedRecap({ mode: "short", text: "DEFAULT SHORT", at: minutesAgo(20) });
    await seedRecap({ mode: "full", text: "OTHER FULL", at: minutesAgo(40), persona: OTHER_PERSONA });
    // The newest row of all predates personas: it never fills a named slot.
    await seedRecap({ mode: "full", text: "LEGACY FULL", at: minutesAgo(10), persona: null });

    const personaQuery = (id: string) => ({ query: `?personaDefinitionId=${encodeURIComponent(id)}` });
    const forDefault = (await recapsOk(grishaToken, personaQuery(personaDefinitionId))).body;
    expect([forDefault.full?.text, forDefault.short?.text]).toEqual(["DEFAULT FULL", "DEFAULT SHORT"]);
    expect(forDefault.full?.personaDefinitionId).toBe(personaDefinitionId);

    const forOther = (await recapsOk(grishaToken, personaQuery(OTHER_PERSONA))).body;
    expect([forOther.full?.text, forOther.short]).toEqual(["OTHER FULL", null]);
    expect(forOther.full?.personaDefinitionId).toBe(OTHER_PERSONA);

    const unknownPersona = (await recapsOk(grishaToken, personaQuery(`v1:${"z".repeat(43)}`))).body;
    expect(unknownPersona).toEqual({ full: null, short: null, fullSavedToProfile: false });

    // No persona named: the freshest of any, as the recap status answers.
    const any = (await recapsOk(grishaToken)).body;
    expect([any.full?.text, any.short?.text]).toEqual(["LEGACY FULL", "DEFAULT SHORT"]);
    expect(any.full?.personaDefinitionId).toBeNull();

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers both slots whichever is newer: a newer short does not hide the full, nor a newer full the short", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const fullAt = minutesAgo(300);
    const shortAt = minutesAgo(10);
    await seedRecap({ mode: "full", text: "FULL", at: fullAt });
    await seedRecap({ mode: "short", text: "SHORT", at: shortAt });

    const shortNewer = (await recapsOk(grishaToken)).body;
    expect([shortNewer.full?.text, shortNewer.full?.generatedAt]).toEqual(["FULL", fullAt.toISOString()]);
    expect([shortNewer.short?.text, shortNewer.short?.generatedAt]).toEqual(["SHORT", shortAt.toISOString()]);

    const newerFullAt = minutesAgo(1);
    await seedRecap({ mode: "full", text: "NEWER FULL", at: newerFullAt });
    const fullNewer = (await recapsOk(grishaToken)).body;
    expect([fullNewer.full?.text, fullNewer.full?.generatedAt]).toEqual(["NEWER FULL", newerFullAt.toISOString()]);
    expect([fullNewer.short?.text, fullNewer.short?.generatedAt]).toEqual(["SHORT", shortAt.toISOString()]);

    // Only one slot filled: the other is null, not an error.
    const otherFan = (await recapsOk(grishaToken, { fan: OTHER_FAN })).body;
    expect(otherFan).toEqual({ full: null, short: null, fullSavedToProfile: false });
    await seedRecap({ mode: "short", text: "ONLY SHORT", at: minutesAgo(3), fan: OTHER_FAN });
    const onlyShort = (await recapsOk(grishaToken, { fan: OTHER_FAN })).body;
    expect([onlyShort.full, onlyShort.short?.text]).toEqual([null, "ONLY SHORT"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("skips unusable rows, other fans and other pages, and shapes odd provenance as not recorded", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    // Every unusable row is NEWER than the usable ones it must not hide.
    await seedRecap({ mode: "full", text: "USABLE FULL", at: minutesAgo(500) });
    await seedRecap({ mode: "short", text: "USABLE SHORT", at: minutesAgo(490) });
    for (const mode of ["full", "short"] as const) {
      await seedRecap({ mode, text: "EXHAUSTED", at: minutesAgo(60), params: { stopReason: "max_tokens" } });
      await seedRecap({ mode, text: "EXHAUSTED TOO", at: minutesAgo(59), params: { stopReason: "length" } });
      await seedRecap({ mode, text: "FAILED", at: minutesAgo(58), params: { outcome: "failed", stopReason: null } });
      await seedRecap({ mode, text: "NO STOP REASON", at: minutesAgo(57), params: { stopReason: null } });
      await seedRecap({ mode, text: "", at: minutesAgo(56) });
      await seedRecap({ mode, text: " \t\n  ", at: minutesAgo(55) });
      // Not a recap at all: another feature's generation.
      await seedRecap({ mode, text: "COACH ANSWER", at: minutesAgo(54), feature: "coach-chat" });
      // Another fan's chat on this page, and this fan's chat on another page.
      await seedRecap({ mode, text: "OTHER FAN", at: minutesAgo(53), fan: OTHER_FAN });
      await seedRecap({ mode, text: "OTHER PAGE", at: minutesAgo(52), pageLabel: "mia-of" });
    }
    // Legacy: no summaryMode.
    await seedRecap({ mode: "full", text: "LEGACY", at: minutesAgo(51), rawParams: { outcome: "completed", stopReason: "end_turn" } });

    const body = (await recapsOk(grishaToken)).body;
    expect([body.full?.text, body.short?.text]).toEqual(["USABLE FULL", "USABLE SHORT"]);
    // Each page's own recap, never another's: mia-of's chatter reads mia-of's.
    expect((await recapsOk(svetaToken, { pageLabel: "mia-of" })).body.full?.text).toBe("OTHER PAGE");
    expect((await recapsOk(grishaToken, { fan: OTHER_FAN })).body.full?.text).toBe("OTHER FAN");

    // Provenance the gateway did not write as the wire expects reads as null,
    // not as a response the client's schema refuses.
    await seedRecap({
      mode: "full",
      text: "ODD PROVENANCE",
      at: minutesAgo(1),
      persona: null,
      params: {
        personaDefinitionId: 42,
        transcriptCoverage: "x".repeat(65),
        requestedCount: "1500",
        keptCount: 12.5,
      },
    });
    expect((await recapsOk(grishaToken)).body.full).toMatchObject({
      text: "ODD PROVENANCE",
      personaDefinitionId: null,
      coverage: { transcriptCoverage: null, requestedCount: null, keptCount: null },
    });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan-summary with params.contextScope is never selected: not by the status, the Coach attach, this route or the dossier", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    app.config.chatMuseAiFanProfileContextFeatures = "all";
    const sharedFullAt = minutesAgo(5 * 24 * 60);
    const sharedShortAt = minutesAgo(4 * 24 * 60);
    const draftFullAt = minutesAgo(2 * 24 * 60);
    const draftShortAt = minutesAgo(24 * 60);
    await seedRecap({ mode: "full", text: "SHARED_FULL_BODY", at: sharedFullAt });
    await seedRecap({ mode: "short", text: "SHARED_SHORT_BODY", at: sharedShortAt });
    // Newer, and otherwise perfectly usable: generated from context only the
    // caller saw.
    const scope = { contextScope: "principal-draft" };
    await seedRecap({ mode: "full", text: "DRAFT_FULL_BODY", at: draftFullAt, userId: grishaId, params: scope });
    await seedRecap({ mode: "short", text: "DRAFT_SHORT_BODY", at: draftShortAt, userId: grishaId, params: scope });
    // The fan's dossier holds the draft's text: only the scoped row could prove it.
    await appendFanProfile(app.db, { ...await seedFan(), body: "DRAFT_FULL_BODY" });

    const slotTimes = async (token: string) => {
      const response = await recapStatus(token);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ full: { generatedAt: string } | null; short: { generatedAt: string } | null }>();
      return [body.full?.generatedAt, body.short?.generatedAt];
    };

    // Its own author is no exception: nobody is served the draft as a recap.
    for (const token of [grishaToken, nikitaToken]) {
      expect(await slotTimes(token)).toEqual([sharedFullAt.toISOString(), sharedShortAt.toISOString()]);
      const shared = await recapsOk(token);
      expect([shared.body.full?.text, shared.body.short?.text]).toEqual(["SHARED_FULL_BODY", "SHARED_SHORT_BODY"]);
      // The latest dossier is the draft's text, not the shared full recap's.
      expect(shared.body.fullSavedToProfile).toBe(false);
      expect(shared.raw).not.toContain("DRAFT_");

      const turn = await coach(token);
      expect(turn.prompt).toContain("SHARED_FULL_BODY");
      expect(turn.prompt).toContain("SHARED_SHORT_BODY");
      expect(turn.prompt).not.toContain("DRAFT_");
      // The dossier is not injected: its only matching generation carries a scope.
      expect(turn.prompt).not.toContain("## Fan Dossier");
      expect(turn.meta).toMatchObject({
        type: "meta",
        attachedRecaps: {
          full: { generatedAt: sharedFullAt.toISOString() },
          short: { generatedAt: sharedShortAt.toISOString() },
        },
      });
    }

    // The control: the same rows without the key are ordinary shared recaps, so
    // it is the scope, and nothing else in the fixture, that kept them out.
    await testDb!.pool.query("update ai_generation_content set params = params - 'contextScope' where params ? 'contextScope'");
    expect(await slotTimes(nikitaToken)).toEqual([draftFullAt.toISOString(), draftShortAt.toISOString()]);
    const unscoped = await recapsOk(nikitaToken);
    expect([unscoped.body.full?.text, unscoped.body.short?.text]).toEqual(["DRAFT_FULL_BODY", "DRAFT_SHORT_BODY"]);
    expect(unscoped.body.fullSavedToProfile).toBe(true);
    const turn = await coach(nikitaToken);
    // Now proven, the dossier is injected (and stands in for the identical full recap).
    expect(turn.prompt).toContain("## Fan Dossier");
    expect(turn.prompt).toContain("DRAFT_FULL_BODY");
    expect(turn.prompt).toContain("DRAFT_SHORT_BODY");
    expect(turn.prompt).not.toContain("SHARED_");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fullSavedToProfile: the fan's latest dossier on the page has exactly the full recap's text", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    const saved = async (query = "") => (await recapsOk(grishaToken, { query })).body.fullSavedToProfile;

    // No full recap: nothing to have saved, whatever the dossier holds.
    const fan = await seedFan();
    await appendFanProfile(app.db, { ...fan, body: "FULL RECAP" });
    await seedRecap({ mode: "short", text: "FULL RECAP", at: minutesAgo(40) });
    expect(await saved()).toBe(false);

    await seedRecap({ mode: "full", text: "FULL RECAP", at: minutesAgo(30) });
    expect(await saved()).toBe(true);

    // A newer full recap that nobody saved yet.
    await seedRecap({ mode: "full", text: "NEWER FULL RECAP", at: minutesAgo(20) });
    expect(await saved()).toBe(false);
    await appendFanProfile(app.db, { ...fan, body: "NEWER FULL RECAP" });
    expect(await saved()).toBe(true);

    // The latest dossier decides, not an older version; and exactly, not nearly.
    await appendFanProfile(app.db, { ...fan, body: "NEWER FULL RECAP " });
    expect(await saved()).toBe(false);

    // Another persona's full recap is compared with the same dossier.
    await seedRecap({ mode: "full", text: "NEWER FULL RECAP ", at: minutesAgo(25), persona: OTHER_PERSONA });
    expect(await saved(`?personaDefinitionId=${encodeURIComponent(OTHER_PERSONA)}`)).toBe(true);

    // The dossier of this fan on ANOTHER page, and a fan the hub has never seen.
    await seedRecap({ mode: "full", text: "FULL RECAP", at: minutesAgo(5), pageLabel: "mia-of" });
    expect((await recapsOk(svetaToken, { pageLabel: "mia-of" })).body.fullSavedToProfile).toBe(false);
    await seedRecap({ mode: "full", text: "UNSEEN FAN", at: minutesAgo(5), fan: OTHER_FAN });
    expect((await recapsOk(grishaToken, { fan: OTHER_FAN })).body.fullSavedToProfile).toBe(false);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes; another page's recap is never served", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    await seedRecap({ mode: "full", text: "LORA RECAP", at: minutesAgo(5) });
    await seedRecap({ mode: "full", text: "MIA RECAP", at: minutesAgo(5), pageLabel: "mia-of" });

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
          url: recapsUrl(cell.page),
          headers: { ...version, ...cell.headers },
        });
        expect(response.statusCode, `${label}: ${response.body}`).toBe(cell.status);
        if (cell.status === 200) {
          const text = clientConversationRecapsResponseSchema.parse(response.json()).full?.text;
          expect(text, label).toBe(cell.page === "mia-of" ? "MIA RECAP" : "LORA RECAP");
          continue;
        }
        // Every refusal is the declared error body, and none carries a recap.
        const error = errorResponseSchema.parse(response.json());
        expect(error.error, label).toBe(cell.status === 401 ? "unauthorized" : "forbidden");
        expect(response.body, label).not.toContain("RECAP");
      }

      // A page that is not the caller's, and one that does not exist. Enforced,
      // the declared page scope answers before the handler (403, 404); in log
      // mode the hub's own feature check answers both the same.
      for (const token of [grishaToken, grishaFullToken, leadToken]) {
        const foreign = await recaps(token, { pageLabel: "mia-of" });
        const missing = await recaps(token, { pageLabel: "ghost-of" });
        if (mode === "enforce") {
          expectRefused(foreign, 403, "forbidden");
          expectRefused(missing, 404, "not_found");
        } else {
          expectRefused(foreign, 409, "client_feature_disabled", "not_granted");
          expectRefused(missing, 409, "client_feature_disabled", "not_granted");
        }
        expect(foreign.body).not.toContain("RECAP");
      }
      // The page's own chatter still reads it.
      expect((await recapsOk(svetaToken, { pageLabel: "mia-of" })).body.full?.text).toBe("MIA RECAP");
      expectRefused(await recaps(svetaToken), mode === "enforce" ? 403 : 409,
        mode === "enforce" ? "forbidden" : "client_feature_disabled",
        mode === "enforce" ? undefined : "not_granted");
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a malformed request: the fan id's one shape, a strict query, a bounded persona id", async (context) => {
    if (!server) return context.skip();
    await switchRecapOn();
    await seedRecap({ mode: "full", text: "FULL RECAP", at: minutesAgo(5) });

    for (const [fan, query] of [
      ["0777", ""],
      ["group-777", ""],
      ["7".repeat(31), ""],
      [FAN, "?personaDefinitionId=short"],
      [FAN, `?personaDefinitionId=${"p".repeat(101)}`],
      // The page and the fan are the path's; naming them in the query is refused, not ignored.
      [FAN, "?pageLabel=mia-of"],
      [FAN, `?fanRef=${OTHER_FAN}`],
      [FAN, `?conversationRef=${OTHER_FAN}`],
      [FAN, "?userId=1"],
    ] as const) {
      const response = await recaps(grishaToken, { fan, query });
      expect(response.statusCode, `${fan}${query}: ${response.body}`).toBe(400);
      expect(errorResponseSchema.safeParse(response.json()).success, `${fan}${query}`).toBe(true);
      expect(response.body).not.toContain("FULL RECAP");
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the recap status answers data written before this change byte for byte as it did", async (context) => {
    if (!server) return context.skip();
    // Rows as the shipped clients' generations left them: no contextScope key
    // anywhere. A frozen clock makes `ageMs` exact.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    vi.useFakeTimers({ toFake: ["Date"], now });
    const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    await seedRecap({
      mode: "full",
      text: "FULL",
      at: at(90),
      params: { transcriptCoverage: "full-history", requestedCount: 1500, keptCount: 1432, contextManifest: { source: "archive" } },
    });
    await seedRecap({ mode: "short", text: "SHORT", at: at(30), params: { transcriptCoverage: null, requestedCount: 300, keptCount: 280 } });
    await seedRecap({ mode: "short", text: "EXHAUSTED", at: at(20), params: { stopReason: "max_tokens" } });
    await seedRecap({ mode: "full", text: "LEGACY", at: at(10), persona: null });

    const slot = (minutes: number, coverage: string | null, requested: number | null, kept: number | null) => (
      `{"generatedAt":"${at(minutes).toISOString()}","ageMs":${minutes * 60_000},`
      + `"transcriptCoverage":${JSON.stringify(coverage)},"requestedCount":${requested},"keptCount":${kept}}`
    );
    // No recap switch involved, and an old client's full token: nothing of the
    // chat extension gates this route.
    const named = await recapStatus(grishaFullToken);
    expect(named.statusCode, named.body).toBe(200);
    expect(named.body).toBe(`{"full":${slot(90, "full-history", 1500, 1432)},"short":${slot(30, null, 300, 280)}}`);
    const unnamed = await recapStatus(grishaFullToken, false);
    expect(unnamed.body).toBe(`{"full":${slot(10, null, null, null)},"short":${slot(30, null, 300, 280)}}`);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
