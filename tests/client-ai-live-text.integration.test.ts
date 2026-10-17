import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiFeatureStreamFrameSchema, errorResponseSchema } from "@agency_hub_core/contracts";
import {
  appendFanProfile,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  getFreshestUsableRecapBodies,
  getFreshestUsableRecaps,
  getLatestPromptEligibleFanProfile,
  insertAiGenerationContent,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT,
  AI_LIVE_TEXT_FEATURES,
  OPERATION_FEATURES,
  createBundledPersonalities,
} from "../apps/runtime/src/modules/ai/index.ts";
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

// chat-extension H-4c: `liveTextContext`, the fresh text of the open OnlyFans
// chat, through the real route. A client reads the last confirmed messages off
// the page it shows and sends them with a draft request; the hub merges them
// into the transcript it loaded itself, for that one generation.
//
// The fresh-text tests run under the no-outbound trap: the AI stream with fresh
// text reads the database and nothing else (critic item 8).

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", grisha: "grisha-secret" } as const;
const AUDIT = { source: "cli" } as const;
const FAN = "777000777";
const OTHER_FAN = "777000888";
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** In every fresh-text item of these tests, and in no archive row. */
const MARK = "FRESH-TEXT-ONLY-THE-CLIENT-SAW";
/** The platform account ids of the pages (`pages.external_page_id`). */
const ACCOUNTS = { "lora-of": "100000001", "lora-vip-of": "100000002", "mia-of": "100000003" } as const;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;
interface LiveItem { platformMessageId: string; direction: "fan" | "model"; occurredAt: string; text: string }

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let ownerToken = "";
/** A full device token of a chatter of lora-of, lora-vip-of and lora-fansly (an old client's). */
let grishaToken = "";
/** The narrow chat-extension token of the same chatter. */
let grishaExtensionToken = "";
let personaDefinitionId = "";
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput; calls: number } = { calls: 0 };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.calls += 1;
      provider.input = input;
      yield { type: "content_delta", text: "sure thing" };
      yield {
        type: "usage",
        providerResponseId: "msg_live",
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

async function archive(row: {
  ref: string; mine: boolean; text: string; minutesAgo: number;
  page?: string; fan?: string; deleted?: boolean;
}) {
  const fan = row.fan ?? FAN;
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
       is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills, deleted_at)
     values ($1, 'onlyfans', $2, $3, $4, $5, $6, $7, false, 0, $8)`,
    [pageIds[row.page ?? "lora-of"], fan, row.ref, row.mine ? null : fan, row.mine, minutesAgo(row.minutesAgo),
      row.text, row.deleted ? new Date() : null],
  );
}

/** The OFAPI accounts of the pages, once `bindOfapiAccounts` ran. */
const OFAPI_ACCOUNTS = { "lora-of": "acct_live", "lora-vip-of": "acct_vip", "mia-of": "acct_mia" } as const;

/** Binds the pages to their OFAPI accounts: dm_message_archive is keyed by them. */
async function bindOfapiAccounts() {
  for (const [label, account] of Object.entries(OFAPI_ACCOUNTS)) {
    await testDb!.pool.query("update pages set ofapi_account_id = $1 where id = $2", [account, pageIds[label]]);
  }
}

/**
 * One row of the webhook store (dm_message_archive), which holds a message
 * seconds after the platform sent it, before the archive does. `fan: null` is
 * a delete webhook: it names no chat, so its stub has neither a chat nor a time.
 */
async function webhook(row: {
  ref: string; mine: boolean; text: string; minutesAgo: number;
  page?: keyof typeof OFAPI_ACCOUNTS; fan?: string | null; deleted?: boolean;
}) {
  const page = row.page ?? "lora-of";
  const fan = row.fan === undefined ? FAN : row.fan;
  await testDb!.pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain,
       is_tip, tip_amount_mills, deleted_at, source, source_event_type, source_idempotency_key,
       source_journal_id, source_received_at, retain_until)
     values ('onlyfans', $1, $2, $3, $3, $4, $5, $6, $7, $8, false, 0, $9, 'webhook', $10, $11, 1, now(),
       now() + interval '100 years')`,
    [pageIds[page], OFAPI_ACCOUNTS[page], fan, row.ref, row.mine ? "model" : "fan", row.mine,
      fan === null ? null : minutesAgo(row.minutesAgo), row.text, row.deleted ? new Date() : null,
      row.deleted ? "messages.deleted" : row.mine ? "messages.sent" : "messages.received",
      `live-${page}-${row.ref}`],
  );
}

/** The fan's chat on lora-of as the hub's archive holds it. */
async function seedChat() {
  await archive({ ref: "9001", mine: false, text: "hey babe", minutesAgo: 60 });
  await archive({ ref: "9002", mine: true, text: "hey you", minutesAgo: 55 });
  await archive({ ref: "9003", mine: false, text: "sent you something", minutesAgo: 50 });
}

function fresh(id: string, direction: "fan" | "model", text: string, ago: number): LiveItem {
  return { platformMessageId: id, direction, occurredAt: minutesAgo(ago).toISOString(), text };
}

/** What a client reads off the open chat right after the fan wrote again. */
const freshFanMessage = (ago = 1) => fresh("9004", "fan", `${MARK} are you there?`, ago);

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);
}

/** One AI request. `capabilities: null` sends no capability header. */
async function ask(input: {
  token?: string;
  feature?: string;
  page?: string;
  platform?: string;
  fan?: string;
  capabilities?: string | null;
  clientVersion?: string;
  live?: LiveItem[];
  body?: Record<string, unknown>;
} = {}) {
  delete provider.input;
  const feature = input.feature ?? "fast-reply";
  const capabilities = input.capabilities === undefined ? "context-v1" : input.capabilities;
  const response = await server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${feature}`,
    headers: {
      authorization: `Bearer ${input.token ?? grishaToken}`,
      ...(capabilities !== null ? { "x-kernel-ai-capabilities": capabilities } : {}),
      ...(input.clientVersion !== undefined ? { "x-client-version": input.clientVersion } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? "lora-of",
      platform: input.platform ?? "onlyfans",
      conversationRef: input.fan ?? FAN,
      ...(feature === "improve-draft" || feature === "voice-script" ? { draftText: "my draft" } : {}),
      ...(feature === "coach-chat" ? { chatterQuestion: "what next?" } : {}),
      ...(feature === "fan-notes-fill" ? { noteFields: ["Имя", "Локация"] } : {}),
      ...(input.live !== undefined
        ? { liveTextContext: { capturedAt: new Date().toISOString(), items: input.live } }
        : {}),
      ...input.body,
    },
  });
  const streamed = response.statusCode === 200 ? frames(response.body) : [];
  for (const frame of streamed) {
    // Every frame is one the SDK of a client would accept.
    expect(aiFeatureStreamFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
  }
  const captured = provider.input as AiGatewayProviderInput | undefined;
  return {
    response,
    status: response.statusCode,
    types: streamed.map((frame) => frame.type),
    context: streamed.find((frame) => frame.type === "context_v1") as
      | (Frame & {
        live: { status: string; accepted: number; rejected: number; matched?: number };
        servedHead: Frame | null;
        window: { served: number };
      })
      | undefined,
    /** Everything the provider was given, or null when no generation ran. */
    prompt: captured ? JSON.stringify(captured.body.prompt) : null,
    transcript: captured ? captured.body.prompt.userBlocks.map((block) => block.text).join("\n") : null,
  };
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode });
  expect(body.reason, response.body).toBe(reason);
  return body;
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  return server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
}

/**
 * The owner's switches as a pilot page has them: the extension on, fresh text
 * on for the given scopes, and the mode stepped up the only way it can be.
 */
async function switchFreshText(
  mode: "shadow" | "serve",
  features: Record<string, Record<string, boolean>> = { "*": { freshText: true } },
) {
  for (const patches of [
    [{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionFeatures", value: JSON.stringify(features) }],
    [{ key: "aiLiveTextContextMode", value: "shadow" }],
    ...(mode === "serve" ? [[{ key: "aiLiveTextContextMode", value: "serve" }]] : []),
  ]) {
    const response = await patchConfig(patches);
    expect(response.statusCode, response.body).toBe(200);
  }
}

interface GenerationRow { feature: string; params: Record<string, unknown>; prompt_blocks: unknown; completion: string }

async function generations(): Promise<GenerationRow[]> {
  const { rows } = await testDb!.pool.query<GenerationRow>(
    "select feature, params, prompt_blocks, completion from ai_generation_content order by id",
  );
  return rows;
}

async function lastGeneration(): Promise<GenerationRow> {
  const rows = await generations();
  return rows[rows.length - 1]!;
}

const liveManifest = (row: GenerationRow) => (
  (row.params.contextManifest as Record<string, unknown> | undefined)?.liveText as Record<string, unknown> | undefined
);

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

describe("AI feature stream with fresh text (liveTextContext)", () => {
  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });
    app.config.chatMuseAiGatewayEnabled = true;
    provider.calls = 0;
    app.aiGatewayProvider = capturingProvider();

    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    const ownerId = await fixtureUserId(app, "owner");
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
    for (const [label, account] of Object.entries(ACCOUNTS)) {
      await testDb.pool.query("update pages set external_page_id = $1 where id = $2", [account, pageIds[label]]);
    }
    // The chatter works both of Lora's OnlyFans pages; mia-of is not theirs.
    for (const pageLabel of ["lora-of", "lora-vip-of", "lora-fansly"]) {
      await assignPageToUser(app, { userId: grishaId, pageLabel }, AUDIT);
    }
    // An unread chat: reading it through OnlyFans would mark it read there.
    await testDb.pool.query(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, $2, 3)",
      [pageIds["lora-of"], FAN],
    );

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
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
    const catalog = await server.inject({
      method: "GET",
      url: "/api/v1/ai/persona-catalog",
      headers: { authorization: `Bearer ${grishaToken}` },
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    personaDefinitionId = catalog.json<{ personas: Array<{ key: string; definitionId: string }> }>()
      .personas.find((entry) => entry.key === persona.id)!.definitionId;

    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  it("is inert at merge: the mode rests off, fresh text is ignored and the generation is what it was", async (context) => {
    if (!server) return context.skip();
    await seedChat();

    const plain = await ask();
    expect(plain.context!.live).toEqual({ status: "not_sent", accepted: 0, rejected: 0 });
    const ignored = await ask({ live: [freshFanMessage()] });
    // Ignored, not refused: a client's bootstrap can be minutes old.
    expect(ignored.status, ignored.response.body).toBe(200);
    expect(ignored.types).toEqual(plain.types);
    expect(ignored.context!.live).toEqual({ status: "disabled", accepted: 0, rejected: 0 });
    expect(ignored.context).toMatchObject({ servedHead: { messageRef: "9003" }, window: { served: 3 } });
    expect(ignored.prompt).not.toContain(MARK);
    expect(ignored.prompt).toBe(plain.prompt);

    // The recorded generation is the one without fresh text, key for key.
    const [first, second] = await generations();
    expect(second!.params).toEqual(first!.params);
    expect(second!.prompt_blocks).toEqual(first!.prompt_blocks);
    expect(JSON.stringify(second)).not.toContain("liveText");
    expect(second!.params).not.toHaveProperty("contextScope");

    // The hub announces that it reads the field; the owner has switched nothing on.
    const bootstrap = await server.inject({
      method: "GET",
      url: "/api/v1/client/bootstrap",
      headers: { authorization: `Bearer ${grishaExtensionToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    const announced = bootstrap.json<{
      capabilities: string[];
      limits: Record<string, number>;
      pages: Array<{ pageLabel: string; features: Record<string, unknown> }>;
    }>();
    expect(announced.capabilities).toContain("live-text-v1");
    expect(announced.limits).toMatchObject({ freshTextMaxItems: 60, freshTextMaxChars: 5000 });
    expect(announced.pages.find((page) => page.pageLabel === "lora-of")!.features.freshText)
      .toEqual({ available: false, reason: "disabled" });
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses fresh text on every feature but the four that draft a message to the fan", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    // The refusal does not depend on the owner's switch: both states.
    for (const switchedOn of [false, true]) {
      if (switchedOn) {
        await switchFreshText("serve");
      }
      for (const feature of OPERATION_FEATURES) {
        const callsBefore = provider.calls;
        const asked = await ask({ feature, live: [freshFanMessage()] });
        if ((AI_LIVE_TEXT_FEATURES as readonly string[]).includes(feature)) {
          expect(asked.status, `${feature}: ${asked.response.body}`).toBe(200);
          expect(asked.context!.live.status, feature).toBe(switchedOn ? "served" : "disabled");
          continue;
        }
        expectRefused(asked.response, 400, "bad_request", "live_text_not_allowed");
        expect(provider.calls, feature).toBe(callsBefore);
      }
      // Both recap sizes.
      expectRefused(
        (await ask({ feature: "fan-summary", live: [freshFanMessage()], body: { summaryMode: "short" } })).response,
        400, "bad_request", "live_text_not_allowed",
      );
    }
    // Nothing a refused request named was recorded.
    expect((await generations()).map((row) => row.feature).sort()).toEqual(
      [...AI_LIVE_TEXT_FEATURES, ...AI_LIVE_TEXT_FEATURES].sort(),
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses it beside clientContext (the released Fansly extension's lane) and from a caller that cannot read the answer", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await switchFreshText("serve");
    const clientContext = { transcript: "Fan: hi", messageCount: 1, fanDisplayName: "Bob" };

    // A Fansly request that brings its own transcript, as the released Fansly
    // extension does: refused as before R20 HF-8б, now for the clientContext.
    const fansly = await ask({ page: "lora-fansly", platform: "fansly", live: [freshFanMessage()], body: { clientContext } });
    expect(expectRefused(fansly.response, 400, "bad_request", "live_text_not_allowed").message)
      .toBe("liveTextContext cannot be combined with clientContext");

    // On OnlyFans clientContext is refused anyway; with fresh text the reason says which field to drop.
    const both = await ask({ live: [freshFanMessage()], body: { clientContext } });
    expect(expectRefused(both.response, 400, "bad_request", "live_text_not_allowed").message)
      .toBe("liveTextContext cannot be combined with clientContext");

    for (const capabilities of [null, "debug-input-v1, split-all-v1", "future-v9"]) {
      const blind = await ask({ capabilities, live: [freshFanMessage()] });
      expectRefused(blind.response, 400, "bad_request", "capability_required");
    }
    // A page the caller cannot see answers as it always did, before any of this.
    expectRefused((await ask({ page: "mia-of", live: [freshFanMessage()] })).response, 404, "not_found");
    expect(provider.calls).toBe(0);
    expect(await generations()).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the owner steps the mode off → shadow → serve; a switch that is off ignores, never refuses", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    const status = async (input: Parameters<typeof ask>[0] = {}) => {
      const asked = await ask({ live: [freshFanMessage()], ...input });
      expect(asked.status, asked.response.body).toBe(200);
      return asked.context!.live.status;
    };

    // Straight to serve is refused: every enable passes through shadow.
    const jump = await patchConfig([{ key: "aiLiveTextContextMode", value: "serve" }]);
    expect(jump.statusCode, jump.body).toBe(400);
    expect(jump.body).toContain("go through shadow first");

    // The mode alone does nothing: the page's flag is off.
    expect((await patchConfig([{ key: "aiLiveTextContextMode", value: "shadow" }])).statusCode).toBe(200);
    expect((await patchConfig([{ key: "aiLiveTextContextMode", value: "serve" }])).statusCode).toBe(200);
    expect(await status()).toBe("disabled");

    // The flag on another page only, then on this one.
    await switchFreshText("serve", { "lora-vip-of": { freshText: true } });
    expect(await status()).toBe("disabled");
    await switchFreshText("serve", { "*": { freshText: true }, "lora-of": { freshText: false } });
    expect(await status()).toBe("disabled");
    await switchFreshText("serve", { "lora-of": { freshText: true } });
    expect(await status()).toBe("served");

    // The master switch, and any rollback of the mode, take effect on the next request.
    expect((await patchConfig([{ key: "chatExtensionEnabled", value: false }])).statusCode).toBe(200);
    expect(await status()).toBe("disabled");
    expect((await patchConfig([{ key: "chatExtensionEnabled", value: true }])).statusCode).toBe(200);
    expect(await status()).toBe("served");
    expect((await patchConfig([{ key: "aiLiveTextContextMode", value: "off" }])).statusCode).toBe(200);
    expect(await status()).toBe("disabled");
    // A page the extension cannot bind a host account to has no fresh text either.
    await switchFreshText("serve");
    await testDb!.pool.query("update pages set external_page_id = null where id = $1", [pageIds["lora-of"]]);
    expect(await status()).toBe("disabled");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shadow: the merge is recorded as ids and counts, and the hub's transcript serves", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await archive({ ref: "9000", mine: false, text: "deleted long ago", minutesAgo: 70, deleted: true });
    await switchFreshText("shadow");

    const plain = await ask();
    const shadow = await ask({
      live: [
        fresh("9003", "fan", `${MARK} sent you something`, 50),
        freshFanMessage(),
        fresh("9000", "fan", `${MARK} deleted long ago`, 70),
      ],
      body: { knownFanMessageIds: ["9004"] },
    });
    expect(shadow.status, shadow.response.body).toBe(200);
    // What was served is the hub's own transcript, to the byte.
    expect(shadow.prompt).toBe(plain.prompt);
    expect(shadow.context).toMatchObject({
      source: "archive",
      servedHead: { messageRef: "9003" },
      window: { served: 3 },
      live: { status: "shadow", accepted: 1, rejected: 1, matched: 1 },
      // The model did not read the fresh message.
      knownFanMessages: [{ id: "9004", state: "absent" }],
    });

    const row = await lastGeneration();
    expect(liveManifest(row)).toEqual({
      source: "client-supplied",
      mode: "shadow",
      status: "shadow",
      sent: 3,
      accepted: 1,
      rejected: 1,
      conflicts: 0,
      matched: 1,
      outsideWindow: 0,
      headRef: "9004",
      archiveSawHead: false,
      acceptedRefs: ["9004"],
      rejectedRefs: ["9000"],
      rejectedReasons: { deleted: 1 },
      conflictRefs: [],
      conflictReasons: {},
    });
    // The client's text reached neither the prompt nor the record (critic item 13).
    expect(JSON.stringify(row)).not.toContain(MARK);
    expect(row.params).not.toHaveProperty("contextScope");
    // Apart from the manifest's new key the record is the plain one's.
    const { liveText: _liveText, ...manifest } = row.params.contextManifest as Record<string, unknown>;
    const [plainRow] = await generations();
    expect({ ...row.params, contextManifest: manifest }).toEqual(plainRow!.params);

    // A snapshot that contradicts the hub is recorded, never thrown: shadow changes no generation.
    const conflicting = await ask({ live: [fresh("9003", "model", `${MARK} wrong side`, 50), freshFanMessage()] });
    expect(conflicting.status, conflicting.response.body).toBe(200);
    expect(conflicting.prompt).toBe(plain.prompt);
    expect(conflicting.context!.live).toEqual({ status: "shadow", accepted: 1, rejected: 1, matched: 0 });
    expect(liveManifest(await lastGeneration())).toMatchObject({
      conflicts: 1, conflictRefs: ["9003"], conflictReasons: { direction: 1 }, acceptedRefs: ["9004"],
    });

    // Nor does a text: a numeric reference past Unicode's range used to throw in
    // the text normalizer and answer 500. Whatever a client's text holds, a
    // shadow generation is the hub's own.
    for (const text of ["lol &#1114112; ok", "&#x110000;", `&#${"9".repeat(400)};`, "&#0; \u0000 \ud800"]) {
      const hostile = await ask({ live: [fresh("9004", "fan", `${MARK} ${text}`, 1)] });
      expect(hostile.status, `${JSON.stringify(text)}: ${hostile.response.body}`).toBe(200);
      expect(hostile.prompt, JSON.stringify(text)).toBe(plain.prompt);
      expect(hostile.context!.live, JSON.stringify(text)).toEqual({ status: "shadow", accepted: 1, rejected: 0, matched: 0 });
    }
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serve: a message the archive does not hold yet reaches the prompt (critic item 13)", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await switchFreshText("serve");

    const served = await ask({
      live: [fresh("9003", "fan", "sent you something", 50), freshFanMessage(), fresh("9005", "model", `${MARK} right here`, 0.5)],
      body: { knownFanMessageIds: ["9004", "9003", "9005"] },
    });
    expect(served.status, served.response.body).toBe(200);
    expect(served.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    // In the transcript the provider received, after the archived rows, in order, on the right sides.
    const transcript = served.transcript!;
    const positions = ["hey babe", "hey you", "sent you something", `${MARK} are you there?`, `${MARK} right here`]
      .map((text) => transcript.indexOf(text));
    expect(positions.every((position) => position >= 0), transcript).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(transcript).toMatch(new RegExp(`Fan: ${MARK} are you there\\?`));
    expect(transcript).toMatch(new RegExp(`Model: ${MARK} right here`));

    expect(served.context).toMatchObject({
      // The hub reader that served is still the archive; the client's text is the `live` block.
      source: "archive",
      servedHead: { messageRef: "9005", isFromFan: false },
      archiveHead: { messageRef: "9003", isFromFan: true },
      window: { served: 5 },
      // 9003 the hub already held (R20 HF-8б: the frame says so too).
      live: { status: "served", accepted: 2, rejected: 0, matched: 1 },
      // The model read the fresh fan message; the model's own message is not a fan message.
      knownFanMessages: [
        { id: "9004", state: "included" }, { id: "9003", state: "included" }, { id: "9005", state: "unknown" },
      ],
    });

    const row = await lastGeneration();
    expect(row.params.contextScope).toBe(AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT);
    expect(liveManifest(row)).toMatchObject({
      source: "client-supplied", mode: "serve", status: "served", sent: 3, accepted: 2, rejected: 0, matched: 1,
      headRef: "9005", archiveSawHead: false, acceptedRefs: ["9004", "9005"],
    });
    // The text lives in the generation's own record, and only in its prompt.
    expect(JSON.stringify(row.prompt_blocks)).toContain(MARK);
    expect(JSON.stringify(row.params)).not.toContain(MARK);

    // Each of the four features reads it.
    for (const feature of AI_LIVE_TEXT_FEATURES) {
      const asked = await ask({ feature, live: [freshFanMessage()] });
      expect(asked.status, `${feature}: ${asked.response.body}`).toBe(200);
      expect(asked.transcript, feature).toContain(`${MARK} are you there?`);
      expect(asked.context!.live, feature).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
      expect((await lastGeneration()).params.contextScope, feature).toBe("principal-draft");
    }
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serve: the hub's row wins, HTML is not a disagreement, a tombstone is never restored", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await archive({ ref: "9000", mine: false, text: "deleted long ago", minutesAgo: 70, deleted: true });
    await switchFreshText("serve");

    // The same messages as the archive holds, as the page renders them.
    const same = await ask({
      live: [
        fresh("9003", "fan", `<p>sent you <b>something</b> ${MARK}</p>`, 50),
        fresh("9002", "model", `${MARK} hey you (edited on the page)`, 55),
      ],
    });
    expect(same.status, same.response.body).toBe(200);
    expect(same.prompt).not.toContain(MARK);
    expect(same.transcript).toContain("sent you something");
    // Served, with nothing of the client's in it: no scope.
    expect(same.context).toMatchObject({ window: { served: 3 } });
    expect(same.context!.live).toEqual({ status: "served", accepted: 0, rejected: 0, matched: 2 });
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    expect(liveManifest(await lastGeneration())).toMatchObject({ matched: 2, accepted: 0, archiveSawHead: true });

    // A fresh message's HTML is normalized like an archive row's (critic item 16).
    const html = await ask({ live: [fresh("9004", "fan", `<p>${MARK} look &amp; tell</p><p>ok?<br><a href="https://x.example/a">this</a></p>`, 1)] });
    expect(html.transcript).toContain(`${MARK} look &amp; tell\nok?\nthis`);
    expect(html.transcript).not.toMatch(/href|x\.example/);
    // A numeric reference that names no character stays the text it was; the
    // request it came in is served (it used to answer 500).
    const reference = await ask({ live: [fresh("9004", "fan", `${MARK} lol &#1114112; ok`, 1)] });
    expect(reference.status, reference.response.body).toBe(200);
    expect(reference.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    expect(reference.transcript).toMatch(new RegExp(`${MARK} lol &(amp;)?#1114112; ok`));

    // A message the hub knows as deleted does not come back through a client.
    const tombstoned = await ask({ live: [fresh("9000", "fan", `${MARK} deleted long ago`, 70)] });
    expect(tombstoned.status, tombstoned.response.body).toBe(200);
    expect(tombstoned.prompt).not.toContain(MARK);
    expect(tombstoned.context!.live).toEqual({ status: "rejected", accepted: 0, rejected: 1, matched: 0 });
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    // Beside a usable item it is only counted.
    const mixed = await ask({ live: [fresh("9000", "fan", `${MARK} deleted long ago`, 70), freshFanMessage()] });
    expect(mixed.context!.live).toEqual({ status: "served", accepted: 1, rejected: 1, matched: 0 });
    expect(mixed.transcript).not.toContain("deleted long ago");
    // A delete webhook names no chat: its stub alone still keeps the message out.
    await testDb!.pool.query("update pages set ofapi_account_id = 'acct_live' where id = $1", [pageIds["lora-of"]]);
    await testDb!.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
         platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills,
         deleted_at, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       values ('onlyfans', $1, 'acct_live', null, '9006', 'fan', false, null, '', false, 0, now(), 'webhook',
         'messages.deleted', 'live-9006', 1, now(), now() + interval '100 years')`,
      [pageIds["lora-of"]],
    );
    const stub = await ask({ live: [fresh("9006", "fan", `${MARK} gone`, 1)] });
    expect(stub.context!.live).toEqual({ status: "rejected", accepted: 0, rejected: 1, matched: 0 });
    expect(stub.prompt).not.toContain(MARK);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serve: a snapshot of another chat, or with a sender swapped, is refused with ids only", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    // Another fan's chat on the same page; a chat on the chatter's other page;
    // a chat on a page that is not the chatter's.
    await archive({ ref: "7001", mine: false, text: "another fan's secret", minutesAgo: 30, fan: OTHER_FAN });
    await archive({ ref: "7002", mine: false, text: "the other page's chat", minutesAgo: 30, page: "lora-vip-of", fan: FAN });
    await archive({ ref: "7003", mine: false, text: "not this chatter's page", minutesAgo: 30, page: "mia-of", fan: FAN });
    await switchFreshText("serve");

    const refuse = async (input: Parameters<typeof ask>[0], ids: string) => {
      const callsBefore = provider.calls;
      const rowsBefore = (await generations()).length;
      const asked = await ask(input);
      const body = expectRefused(asked.response, 400, "context_conflict");
      // Ids only: no word of a fan's text, the hub's or the client's.
      expect(body.message).toBe(
        `liveTextContext conflicts with the hub's transcript of this conversation (message ids: ${ids})`,
      );
      expect(provider.calls).toBe(callsBefore);
      expect((await generations()).length).toBe(rowsBefore);
    };

    // The hub holds 9003 as the fan's; the client says the model wrote it.
    await refuse({ live: [fresh("9003", "model", `${MARK} sent you something`, 50), freshFanMessage()] }, "9003");
    // An id of another fan's chat on the same page.
    await refuse({ live: [freshFanMessage(), fresh("7001", "fan", `${MARK} another fan's secret`, 30)] }, "7001");
    // An id of a chat on another page the caller works: the wrong page for this chat.
    await refuse({ live: [fresh("7002", "fan", `${MARK} the other page's chat`, 30)] }, "7002");
    // Every conflicting id is named, in the client's order.
    await refuse({
      live: [fresh("7002", "fan", "x", 30), fresh("9002", "fan", "y", 55), fresh("7001", "fan", "z", 30)],
    }, "7002, 9002, 7001");

    // A page the caller cannot read is not consulted: the refusal would say that the id exists there.
    const unseen = await ask({ live: [fresh("7003", "fan", `${MARK} elsewhere`, 30)] });
    expect(unseen.status, unseen.response.body).toBe(200);
    expect(unseen.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    // The owner reads every page, so for the owner it is a conflict.
    await refuse({ token: ownerToken, live: [fresh("7003", "fan", `${MARK} elsewhere`, 30)] }, "7003");

    // Two pages of this hub writing to each other: the same message is archived
    // under both, each with the other as its conversation. That is this chat
    // seen from its other side, not a foreign one.
    await archive({ ref: "7100", mine: true, text: "vip to free", minutesAgo: 20, page: "lora-vip-of", fan: ACCOUNTS["lora-of"] });
    const mirror = await ask({
      fan: ACCOUNTS["lora-vip-of"],
      live: [fresh("7100", "fan", `${MARK} vip to free`, 20)],
    });
    expect(mirror.status, mirror.response.body).toBe(200);
    expect(mirror.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serve: a message the hub can place keeps the hub's time, whatever the client's clock says", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await archive({ ref: "8000", mine: false, text: "HUB COPY of an old message", minutesAgo: 90 });
    await archive({ ref: "9010", mine: true, text: "four", minutesAgo: 45 });
    await archive({ ref: "9011", mine: false, text: "five", minutesAgo: 40 });
    await switchFreshText("serve");
    // A window of five: the archive's 8000 lies before it.
    const window = { messageCount: 5 };
    const plain = await ask({ body: window });
    expect(plain.context).toMatchObject({ servedHead: { messageRef: "9011" }, window: { served: 5 } });
    expect(plain.transcript).not.toContain("HUB COPY");

    // The client sends the old message as if it had just arrived, with its own text for it.
    const moved = await ask({ live: [fresh("8000", "fan", `${MARK} CLIENT COPY`, 0.2)], body: window });
    expect(moved.status, moved.response.body).toBe(200);
    // It stays where the hub holds it, before the window: the generation is the plain one.
    expect(moved.prompt).toBe(plain.prompt);
    expect(moved.context).toMatchObject({
      servedHead: { messageRef: "9011" },
      window: { served: 5 },
      // Cut by the window: neither accepted, rejected nor matched.
      live: { status: "served", accepted: 0, rejected: 0, matched: 0 },
    });
    const row = await lastGeneration();
    expect(row.params).not.toHaveProperty("contextScope");
    expect(liveManifest(row)).toMatchObject({ accepted: 0, outsideWindow: 1, matched: 0, acceptedRefs: [], headRef: "8000" });

    // A message so far only in the webhook store, which this reader does not
    // read (the union is off): the client's copy joins, at the hub's time.
    await bindOfapiAccounts();
    await webhook({ ref: "9020", mine: false, text: "the webhook store's copy", minutesAgo: 30 });
    const placed = await ask({
      live: [fresh("9020", "fan", `${MARK} sent half an hour ago`, 0.1), fresh("9021", "fan", `${MARK} sent just now`, 1)],
      body: window,
    });
    expect(placed.status, placed.response.body).toBe(200);
    expect(placed.context).toMatchObject({
      source: "archive",
      // By the client's clock 9020 would be the head.
      servedHead: { messageRef: "9021" },
      live: { status: "served", accepted: 2, rejected: 0, matched: 0 },
    });
    const transcript = placed.transcript!;
    expect(transcript.indexOf(`${MARK} sent half an hour ago`)).toBeGreaterThan(transcript.indexOf("five"));
    expect(transcript.indexOf(`${MARK} sent just now`)).toBeGreaterThan(transcript.indexOf(`${MARK} sent half an hour ago`));
    expect((await lastGeneration()).params.contextScope).toBe("principal-draft");
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serve on top of the union transcript, the mode production runs in", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await bindOfapiAccounts();
    // The union reader serves the archive and the webhook store as one transcript.
    app.config.aiTranscriptFreshUnionMode = "serve";
    // Held by the webhook store alone; and a delete webhook for an archived message.
    await webhook({ ref: "9004", mine: false, text: "the webhook store's copy", minutesAgo: 5 });
    await webhook({ ref: "9001", mine: false, text: "", minutesAgo: 0, fan: null, deleted: true });
    // The same fan's chat on the chatter's other page and on a page that is not
    // theirs, seconds old: only the webhook store holds these.
    await webhook({ ref: "7200", mine: false, text: "the other page's chat", minutesAgo: 2, page: "lora-vip-of" });
    await webhook({ ref: "7300", mine: false, text: "not this chatter's page", minutesAgo: 2, page: "mia-of" });
    await switchFreshText("serve");

    const served = await ask({
      live: [
        fresh("9003", "fan", `${MARK} the client's copy of an archived message`, 50),
        fresh("9004", "fan", `${MARK} the client's copy of a webhook message`, 5),
        fresh("9001", "fan", `${MARK} the client's copy of a deleted message`, 60),
        fresh("9006", "fan", `${MARK} nobody but the client has this yet`, 1),
      ],
      body: { knownFanMessageIds: ["9004", "9001", "9006"] },
    });
    expect(served.status, served.response.body).toBe(200);
    expect(served.context).toMatchObject({
      source: "union",
      servedHead: { messageRef: "9006", isFromFan: true },
      // 9002, 9003 and 9004 of the union (9001 is tombstoned) and the client's 9006.
      window: { served: 4 },
      live: { status: "served", accepted: 1, rejected: 1, matched: 2 },
      knownFanMessages: [
        { id: "9004", state: "included" }, { id: "9001", state: "deleted" }, { id: "9006", state: "included" },
      ],
    });
    // The hub's rows stand, from either store; the tombstoned one is not restored.
    expect(served.transcript).toContain("sent you something");
    expect(served.transcript).toContain("the webhook store's copy");
    expect(served.transcript).toContain(`${MARK} nobody but the client has this yet`);
    expect(served.transcript).not.toContain("hey babe");
    expect(served.transcript).not.toMatch(/the client's copy/);
    const row = await lastGeneration();
    expect(row.params.contextScope).toBe(AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT);
    expect(liveManifest(row)).toMatchObject({
      mode: "serve", status: "served", sent: 4, matched: 2, accepted: 1, rejected: 1, conflicts: 0,
      acceptedRefs: ["9006"], rejectedRefs: ["9001"], rejectedReasons: { deleted: 1 },
    });
    expect(row.params.contextManifest).toMatchObject({ mode: "serve", source: "union" });

    const refuse = async (input: Parameters<typeof ask>[0], ids: string) => {
      const callsBefore = provider.calls;
      const asked = await ask(input);
      expect(expectRefused(asked.response, 400, "context_conflict").message).toBe(
        `liveTextContext conflicts with the hub's transcript of this conversation (message ids: ${ids})`,
      );
      expect(provider.calls).toBe(callsBefore);
    };
    // A sender swapped on a message only the webhook store holds.
    await refuse({ live: [fresh("9004", "model", `${MARK} wrong side`, 5), fresh("9006", "fan", "x", 1)] }, "9004");
    // A snapshot of the same fan's chat on the chatter's other page, made only of
    // messages the archive does not hold yet: the wrong page for this chat.
    await refuse({ live: [fresh("7200", "fan", `${MARK} the other page's chat`, 2)] }, "7200");
    // A page the caller cannot read is not consulted; the owner reads every page.
    const unseen = await ask({ live: [fresh("7300", "fan", `${MARK} elsewhere`, 2)] });
    expect(unseen.status, unseen.response.body).toBe(200);
    expect(unseen.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    await refuse({ token: ownerToken, live: [fresh("7300", "fan", `${MARK} elsewhere`, 2)] }, "7300");
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serve: the Hi gate and the Ping analysis read the merged transcript, so fresh text can only tighten", async (context) => {
    if (!server) return context.skip();
    // Nine archived messages, the fan's last text twenty days old.
    for (let n = 1; n <= 9; n += 1) {
      await archive({ ref: String(9000 + n), mine: n % 2 === 0, text: `archived ${n}`, minutesAgo: 20 * 24 * 60 + (10 - n) });
    }
    const hi = (live?: LiveItem[]) => ask({ feature: "hi-greeting", body: { variantCount: 1 }, ...(live ? { live } : {}) });
    const two = [fresh("9101", "fan", `${MARK} one`, 2), fresh("9102", "fan", `${MARK} two`, 1)];

    // Off and shadow serve the archive: nine messages pass the gate (at most 10).
    expect((await hi(two)).status).toBe(200);
    await switchFreshText("shadow");
    expect((await hi(two)).status).toBe(200);
    const stale = await ask({ feature: "ping", live: two });
    expect(stale.prompt).toContain("Fan silence: the fan's last message was 20 days ago");

    await switchFreshText("serve");
    expect((await hi()).status).toBe(200);
    expect((await hi([two[0]!])).status).toBe(200);
    // Eleven with the client's two: the chat is no longer a cold one.
    const gated = await hi(two);
    expect(expectRefused(gated.response, 400, "gate_hi_greeting_limit").message).toContain("at most 10 messages");
    // Ping sees that the fan has just written.
    const live = await ask({ feature: "ping", live: two });
    expect(live.prompt).toContain("Fan silence: the fan's last message was 0 days ago");
    expect(live.prompt).not.toContain("20 days ago");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("writes the client's text to no store the hub reads back", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await upsertFanPages(app.db, [{
      fanId: (await upsertFans(app.db, [{ platform: "onlyfans", platformUserId: FAN }]))[0]!.id,
      platformAccountId: pageIds["lora-of"]!,
    }]);
    await switchFreshText("serve");
    const tables = [
      "message_archive", "dm_message_archive", "observations", "fan_profiles",
      "page_dm_messages", "page_dm_threads", "domain_events", "fans", "page_fans",
    ];
    const counts = async () => {
      const columns = tables.map((table) => `(select count(*)::int from ${table}) as ${table}`).join(", ");
      return (await testDb!.pool.query<Record<string, number>>(`select ${columns}`)).rows[0]!;
    };
    const before = await counts();

    for (const feature of AI_LIVE_TEXT_FEATURES) {
      const asked = await ask({ feature, live: [freshFanMessage(), fresh("9005", "model", `${MARK} here`, 0.5)] });
      expect(asked.status, `${feature}: ${asked.response.body}`).toBe(200);
      expect(asked.context!.live).toEqual({ status: "served", accepted: 2, rejected: 0, matched: 0 });
    }
    expect(await counts()).toEqual(before);
    // The fresh ids are still unknown to every message store.
    const { rows } = await testDb!.pool.query<{ n: number }>(
      `select (select count(*) from message_archive where message_ref in ('9004', '9005'))::int
            + (select count(*) from dm_message_archive where platform_message_id in ('9004', '9005'))::int
            + (select count(*) from page_dm_messages where platform_message_id in ('9004', '9005'))::int as n`,
    );
    expect(rows[0]!.n).toBe(0);
    // The only place the text exists is the four generations' restricted records.
    const recorded = await generations();
    expect(recorded).toHaveLength(AI_LIVE_TEXT_FEATURES.length);
    for (const row of recorded) {
      expect(JSON.stringify(row.prompt_blocks)).toContain(MARK);
      expect(row.params.contextScope).toBe("principal-draft");
    }
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a row that carries the scope this lane writes is never a shared recap or a dossier's proof", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await switchFreshText("serve");
    expect((await ask({ live: [freshFanMessage()] })).status).toBe(200);
    const scope = (await lastGeneration()).params.contextScope;
    expect(scope).toBe("principal-draft");

    // Fresh text is refused on fan-summary, so no recap can carry the scope
    // today. Should a later lane write one, the readers already skip it: the
    // same scope value on a recap row, beside an older plain one.
    const recap = async (completion: string, minutes: number, scoped: boolean) => {
      const generationRef = randomUUID();
      await insertAiGenerationContent(app.db, {
        usageEventId: null,
        generationRef,
        feature: "fan-summary",
        model: "m",
        provider: "anthropic",
        userId: null,
        pageId: pageIds["lora-of"]!,
        conversationRef: FAN,
        fanRef: FAN,
        promptBlocks: [],
        completion,
        params: {
          summaryMode: "full",
          personaDefinitionId,
          outcome: "completed",
          stopReason: "end_turn",
          ...(scoped ? { contextScope: scope } : {}),
        },
      });
      await testDb!.pool.query(
        "update ai_generation_content set created_at = $1 where generation_ref = $2",
        [minutesAgo(minutes).toISOString(), generationRef],
      );
    };
    await recap("SHARED RECAP", 30, false);
    await recap("ONE PERSON'S DRAFT RECAP", 5, true);
    const selection = { pageId: pageIds["lora-of"]!, conversationRefs: [FAN], personaDefinitionId };
    expect((await getFreshestUsableRecaps(app.db, selection)).full?.completion).toBe("SHARED RECAP");
    expect((await getFreshestUsableRecapBodies(app.db, selection)).full?.completion).toBe("SHARED RECAP");
    const status = await server.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=lora-of&conversationRef=${FAN}&personaDefinitionId=${encodeURIComponent(personaDefinitionId)}`,
      headers: { authorization: `Bearer ${grishaToken}` },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(Date.parse(status.json<{ full: { generatedAt: string } }>().full.generatedAt))
      .toBeLessThan(minutesAgo(20).getTime());

    // A dossier saved from the scoped recap has no proof; the plain one's has.
    const [fan] = await upsertFans(app.db, [{ platform: "onlyfans", platformUserId: FAN }]);
    await upsertFanPages(app.db, [{ fanId: fan!.id, platformAccountId: pageIds["lora-of"]! }]);
    const dossier = { fanId: fan!.id, platformAccountId: pageIds["lora-of"]!, platformUserId: FAN };
    await appendFanProfile(app.db, { ...dossier, source: "chatmuse", body: "ONE PERSON'S DRAFT RECAP" });
    expect(await getLatestPromptEligibleFanProfile(app.db, dossier)).toBeNull();
    await appendFanProfile(app.db, { ...dossier, source: "chatmuse", body: "SHARED RECAP" });
    expect((await getLatestPromptEligibleFanProfile(app.db, dossier))?.body).toBe("SHARED RECAP");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("old clients: without fresh text the recorded params are what they were, whatever the switch says (critic item 13)", async (context) => {
    if (!server) return context.skip();
    for (let n = 1; n <= 40; n += 1) {
      await archive({ ref: String(9000 + n), mine: n % 2 === 0, text: `archived ${n}`, minutesAgo: 10 * 24 * 60 + (50 - n) });
    }
    const requests: Array<NonNullable<Parameters<typeof ask>[0]>> = [
      { feature: "fast-reply" },
      { feature: "improve-draft" },
      { feature: "ping" },
      { feature: "help-me" },
      { feature: "chat-review" },
      // Coach before the recaps: it attaches the freshest one, whose age is not the same twice.
      { feature: "coach-chat" },
      { feature: "fan-summary" },
      { feature: "fan-summary", body: { summaryMode: "short" } },
      // An old client: no capability header at all.
      { feature: "fast-reply", capabilities: null },
    ];
    const record = async () => {
      const before = (await generations()).length;
      for (const request of requests) {
        const asked = await ask(request);
        expect(asked.status, `${request.feature}: ${asked.response.body}`).toBe(200);
      }
      // `params` as the database returns it: jsonb text, byte for byte.
      const { rows } = await testDb!.pool.query<{ feature: string; params: string; prompt: string }>(
        "select feature, params::text as params, prompt_blocks::text as prompt from ai_generation_content order by id offset $1",
        [before],
      );
      return rows;
    };

    const off = await record();
    // The second pass starts where the first did: a Coach turn would otherwise
    // attach the recaps the first pass generated.
    await testDb!.pool.query("delete from ai_generation_content");
    await switchFreshText("serve");
    const on = await record();
    expect(on).toHaveLength(requests.length);
    for (const [index, row] of on.entries()) {
      expect(row.params, `${row.feature} params`).toBe(off[index]!.params);
      expect(row.prompt === off[index]!.prompt, `${row.feature} prompt`).toBe(true);
    }

    // And what they were: only fan-summary carries feature params, and no row a scope.
    const gatewayKeys = ["maxTokens", "temperature", "reasoningEffort", "isRegeneration", "outcome", "stopReason", "contextManifest"];
    const recapKeys = ["summaryMode", "personaDefinitionId", "transcriptCoverage", "requestedCount", "keptCount"];
    for (const row of on) {
      const params = JSON.parse(row.params) as Record<string, unknown>;
      expect(Object.keys(params).sort(), row.feature).toEqual(
        [...gatewayKeys, ...(row.feature === "fan-summary" ? recapKeys : [])].sort(),
      );
      expect(Object.keys(params.contextManifest as Record<string, unknown>), row.feature).not.toContain("liveText");
    }
    expect(on.map((row) => row.feature)).toEqual(requests.map((request) => request.feature));
    expect(JSON.parse(on[6]!.params)).toMatchObject({
      summaryMode: "full", personaDefinitionId, transcriptCoverage: null, requestedCount: 1500, keptCount: 40,
    });
    expect(JSON.parse(on[7]!.params)).toMatchObject({ summaryMode: "short", requestedCount: 300, keptCount: 40 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the extension's narrow token: fresh text end to end, and the owner's switches still decide", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    const extension = { token: grishaExtensionToken, clientVersion: EXTENSION_VERSION, live: [freshFanMessage()] };

    // The extension is switched off as a whole: the narrow token's AI is refused, as before this change.
    expectRefused((await ask(extension)).response, 409, "client_feature_disabled", "disabled");

    await switchFreshText("serve");
    const served = await ask(extension);
    expect(served.status, served.response.body).toBe(200);
    expect(served.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    expect(served.transcript).toContain(`${MARK} are you there?`);
    expect((await lastGeneration()).params).toMatchObject({ clientProfile: "chat-extension", contextScope: "principal-draft" });

    // The extension on, fresh text off for the page: the generation runs on the hub's transcript.
    await switchFreshText("serve", { "*": { freshText: false } });
    const ignored = await ask(extension);
    expect(ignored.status, ignored.response.body).toBe(200);
    expect(ignored.context!.live).toEqual({ status: "disabled", accepted: 0, rejected: 0 });
    expect(ignored.prompt).not.toContain(MARK);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads only the database in every mode: no platform request, no queued work, no chat marked read (critic item 8)", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await archive({ ref: "7001", mine: false, text: "another fan", minutesAgo: 30, fan: OTHER_FAN });
    const snapshot = [fresh("9003", "fan", "sent you something", 50), freshFanMessage()];

    expect((await ask({ live: snapshot })).context!.live.status).toBe("disabled");
    await switchFreshText("shadow");
    expect((await ask({ live: snapshot })).context!.live.status).toBe("shadow");
    await switchFreshText("serve");
    for (const feature of AI_LIVE_TEXT_FEATURES) {
      expect((await ask({ feature, live: snapshot, body: { knownFanMessageIds: ["9004"] } })).context!.live.status).toBe("served");
    }
    expect((await ask({ live: [fresh("7001", "fan", "x", 30)] })).status).toBe(400);
    // The switches were patched through the dashboard route; nothing else left the process.
    await trap!.assertNoOutbound();
    const { rows } = await testDb!.pool.query<{ unread_count: number }>(
      "select unread_count from page_dm_threads where platform_account_id = $1 and platform_conversation_id = $2",
      [pageIds["lora-of"], FAN],
    );
    expect(rows).toEqual([{ unread_count: 3 }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  // ── chat-extension R20 HF-8б: fresh text on a Fansly page ────────────────
  //
  // The new extension asks on Fansly with the group (`conversationRef`) and
  // the fan (`fanRef`), on the hub's own transcript (no clientContext). The
  // predicate of the new behaviour: a Fansly page whose own `freshText` flag is
  // on, under the one `aiLiveTextContextMode`. The page's socket overlay
  // serves the transcript (`live_union`) and is one more store the lookup
  // reads: deletions and other groups only the socket knows.

  /** The Fansly chat: its group, its fan, the creator; 18-digit ids, past what a double holds. */
  const FS = { group: "300000000000000001", otherGroup: "300000000000000009", fan: "400000000000000002", creator: "500000000000000003" } as const;
  const fsId = (n: number) => String(880_000_000_000_000_000n + BigInt(n));

  /** Six days: a chat the fan left longer ago than Ping's active window (five days). */
  const SILENT = 6 * 24 * 60;

  /** lora-fansly as on prod: bound by its account id, its readers on the socket
   *  overlay. `silent` moves the whole chat that many minutes back. */
  async function seedFanslyChat(silent = 0) {
    await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [FS.creator, pageIds["lora-fansly"]]);
    app.config.fanslyLiveOverlayReadPages = "all";
    // An unread chat: fresh text reads the database only, so it stays unread.
    await testDb!.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, unread_count)
       values ($1, $2, $3, 2)`,
      [pageIds["lora-fansly"], FS.group, FS.fan],
    );
    await fanslyArchive({ ref: fsId(1), mine: false, text: "hey babe", minutesAgo: silent + 60 });
    await fanslyArchive({ ref: fsId(2), mine: true, text: "hey you", minutesAgo: silent + 55 });
    // Not archived yet: only the socket holds it so far.
    await socket({ ref: fsId(3), mine: false, text: "sent you something", minutesAgo: silent + 3 });
    // The trap snapshots unread counts when armed: arm it again over this chat too.
    await trap?.restore();
    trap = await armNoOutboundTrap(testDb!);
  }

  async function fanslyArchive(row: {
    ref: string; mine: boolean; text: string; minutesAgo: number; group?: string; page?: string; deleted?: boolean;
  }) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
         is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills, deleted_at)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, false, 0, $8)`,
      [pageIds[row.page ?? "lora-fansly"], row.group ?? FS.group, row.ref, row.mine ? null : FS.fan, row.mine,
        minutesAgo(row.minutesAgo), row.text, row.deleted ? new Date() : null],
    );
  }

  /** A row of the page's socket overlay. `stub`: a deletion frame without a
   *  create (no sender, time or text); `group: null` when the frame named none. */
  async function socket(row: {
    ref: string; mine?: boolean; text?: string; minutesAgo?: number; group?: string | null; deleted?: boolean; stub?: boolean;
  }) {
    const stub = row.stub ?? false;
    await testDb!.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
         is_sent_by_page, created_at, content, decoder_version, first_visible_at, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
      [pageIds["lora-fansly"], row.ref, row.group === undefined ? FS.group : row.group,
        stub ? null : row.mine ? FS.creator : FS.fan, stub ? null : row.mine ?? false,
        stub ? null : minutesAgo(row.minutesAgo ?? 1), stub ? null : row.text ?? "socket", stub ? null : new Date(),
        row.deleted ? new Date() : null],
    );
  }

  /** One Fansly request as the new extension makes it. */
  const askFansly = (input: Parameters<typeof ask>[0] = {}) => ask({
    page: "lora-fansly",
    platform: "fansly",
    fan: FS.group,
    ...input,
    body: { fanRef: FS.fan, ...input.body },
  });
  const fsFresh = (n: number, direction: "fan" | "model", text: string, ago: number) => fresh(fsId(n), direction, text, ago);
  /** The owner's rows of prod (2026-10-13): the OnlyFans pilot pages, no "*" row, no Fansly page. */
  const PROD_ROWS = { "lora-of": { freshText: true }, "lora-vip-of": { freshText: true } };

  it("[R20 HF-8б] is inert at merge: a Fansly page without its own row ignores the tail, whatever the OnlyFans pages have", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat();
    const tail = [fsFresh(4, "fan", `${MARK} are you there?`, 1)];

    const plain = await askFansly();
    expect(plain.status, plain.response.body).toBe(200);
    // Before this change: 400 live_text_not_allowed. Now ignored while the switch is off.
    // R20 HF-2: the same under a "*" row with fresh text on, which reaches no Fansly page.
    for (const rows of [undefined, PROD_ROWS, { ...PROD_ROWS, "*": { freshText: true } }]) {
      if (rows !== undefined) {
        // The mode production runs, and the OnlyFans pilot pages' rows.
        await switchFreshText("serve", rows);
      }
      const ignored = await askFansly({ live: tail });
      expect(ignored.status, ignored.response.body).toBe(200);
      expect(ignored.context!.live).toEqual({ status: "disabled", accepted: 0, rejected: 0 });
      expect(ignored.context).toMatchObject({ source: "live_union", servedHead: { messageRef: fsId(3) } });
      expect(ignored.prompt).toBe(plain.prompt);
      expect(ignored.prompt).not.toContain(MARK);
    }
    // Nothing recorded of it: the record is the one without fresh text.
    const recorded = await generations();
    for (const row of recorded) {
      expect(JSON.stringify(row)).not.toContain("liveText");
      expect(row.params).not.toHaveProperty("contextScope");
    }
    // The bootstrap: the flag exists on the Fansly page, and is off there.
    const bootstrap = await server.inject({
      method: "GET",
      url: "/api/v1/client/bootstrap",
      headers: { authorization: `Bearer ${grishaExtensionToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    const pages = bootstrap.json<{ pages: Array<{ pageLabel: string; features: Record<string, unknown> }> }>().pages;
    expect(pages.find((page) => page.pageLabel === "lora-fansly")!.features.freshText)
      .toEqual({ available: false, reason: "flag_off" });
    expect(pages.find((page) => page.pageLabel === "lora-of")!.features.freshText).toEqual({ available: true });
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] a Fansly tail is accepted: the hub's rows stand, the rest joins, the frame accounts for every item", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat();
    await switchFreshText("serve", { ...PROD_ROWS, "lora-fansly": { freshText: true } });

    const served = await askFansly({
      live: [
        // Held by the archive and by the socket: the hub's rows stand.
        fsFresh(2, "model", `${MARK} hey you`, 55),
        fsFresh(3, "fan", `${MARK} sent you something`, 3),
        // Only the tab has these yet.
        fsFresh(4, "fan", `${MARK} are you there?`, 1),
        fsFresh(5, "model", `${MARK} right here`, 0.5),
      ],
      body: { knownFanMessageIds: [fsId(4)] },
    });
    expect(served.status, served.response.body).toBe(200);
    expect(served.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(served.context).toMatchObject({
      source: "live_union",
      servedHead: { messageRef: fsId(5), isFromFan: false },
      window: { served: 5 },
      knownFanMessages: [{ id: fsId(4), state: "included" }],
      pair: "verified",
    });
    expect(served.context!.live).toEqual({ status: "served", accepted: 2, rejected: 0, matched: 2 });
    const transcript = served.transcript!;
    const positions = ["hey babe", "hey you", "sent you something", `${MARK} are you there?`, `${MARK} right here`]
      .map((text) => transcript.indexOf(text));
    expect(positions.every((position) => position >= 0), transcript).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(transcript).toMatch(new RegExp(`Fan: ${MARK} are you there\\?`));
    expect(transcript).toMatch(new RegExp(`Model: ${MARK} right here`));
    // The client's copies of what the hub holds did not replace the hub's text.
    expect(transcript).not.toContain(`${MARK} hey you`);
    expect(transcript).not.toContain(`${MARK} sent you something`);

    const row = await lastGeneration();
    expect(row.params.contextScope).toBe(AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT);
    // The ids, past 2^53, exactly as the client sent them.
    expect(liveManifest(row)).toMatchObject({
      mode: "serve", status: "served", sent: 4, accepted: 2, rejected: 0, matched: 2, conflicts: 0,
      headRef: fsId(5), archiveSawHead: false, acceptedRefs: [fsId(4), fsId(5)],
    });
    expect(row.params.contextManifest).toMatchObject({ source: "live_union" });
    // Each of the four features reads it. Ping on Fansly is for a fan who went
    // quiet: the fan wrote minutes ago, so it is refused, as without the tail.
    for (const feature of AI_LIVE_TEXT_FEATURES) {
      const asked = await askFansly({ feature, live: [fsFresh(4, "fan", `${MARK} are you there?`, 1)] });
      if (feature === "ping") {
        expectRefused(asked.response, 400, "gate_ping_active");
        continue;
      }
      expect(asked.status, `${feature}: ${asked.response.body}`).toBe(200);
      expect(asked.transcript, feature).toContain(`${MARK} are you there?`);
      expect(asked.context!.live, feature).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    }
    // Shadow: merged and recorded, the hub's own transcript serves.
    await patchConfig([{ key: "aiLiveTextContextMode", value: "shadow" }]);
    const plain = await askFansly();
    const shadow = await askFansly({ live: [fsFresh(3, "fan", "x", 3), fsFresh(4, "fan", `${MARK} are you there?`, 1)] });
    expect(shadow.context!.live).toEqual({ status: "shadow", accepted: 1, rejected: 0, matched: 1 });
    expect(shadow.prompt).toBe(plain.prompt);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] something deleted that only the socket knows is left out as deleted", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat();
    // Sent and deleted within seconds: the archive never held it.
    await socket({ ref: fsId(6), text: "gone in seconds", minutesAgo: 2, deleted: true });
    // A deletion frame before any create, with this group and with none.
    await socket({ ref: fsId(7), stub: true, deleted: true });
    await socket({ ref: fsId(8), stub: true, deleted: true, group: null });
    // Archived, then deleted on the platform: only the socket saw that. The
    // live union hides it, and the client's copy does not bring it back.
    await fanslyArchive({ ref: fsId(9), mine: false, text: "archived then deleted", minutesAgo: 20 });
    await socket({ ref: fsId(9), stub: true, deleted: true });
    await switchFreshText("serve", { "lora-fansly": { freshText: true } });

    const gone = [
      fsFresh(6, "fan", `${MARK} gone in seconds`, 2),
      fsFresh(7, "fan", `${MARK} deleted before the hub saw it`, 2),
      fsFresh(8, "fan", `${MARK} deleted, no group named`, 2),
      fsFresh(9, "fan", `${MARK} archived then deleted`, 20),
    ];
    const rejected = await askFansly({ live: gone });
    expect(rejected.status, rejected.response.body).toBe(200);
    expect(rejected.context!.live).toEqual({ status: "rejected", accepted: 0, rejected: 4, matched: 0 });
    expect(rejected.prompt).not.toContain(MARK);
    expect(rejected.transcript).not.toContain("archived then deleted");
    expect(liveManifest(await lastGeneration())).toMatchObject({
      rejectedRefs: [fsId(6), fsId(7), fsId(8), fsId(9)], rejectedReasons: { deleted: 4 }, conflicts: 0,
    });
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");

    // Beside a message the hub does not know yet, they are only counted.
    const mixed = await askFansly({ live: [...gone, fsFresh(10, "fan", `${MARK} still here`, 1)] });
    expect(mixed.context!.live).toEqual({ status: "served", accepted: 1, rejected: 4, matched: 0 });
    expect(mixed.transcript).toContain(`${MARK} still here`);
    expect(mixed.transcript).not.toMatch(/gone in seconds|deleted before|no group named|archived then deleted/);

    // The owner's overlay switch off for the page: its readers stop reading the
    // socket, and so does this check (as the frame's answers): the archive
    // serves, and what only the socket knew is not known.
    app.config.fanslyLiveOverlayReadPages = "none";
    const off = await askFansly({ live: [fsFresh(6, "fan", `${MARK} gone in seconds`, 2)] });
    expect(off.context).toMatchObject({ source: "archive" });
    expect(off.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] a tail of another group is refused as context_conflict, with ids only", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat();
    // Another chat of the page, seconds old: only the socket holds it.
    await socket({ ref: fsId(11), text: "another fan's secret", minutesAgo: 1, group: FS.otherGroup });
    // Another chat of the page, archived.
    await fanslyArchive({ ref: fsId(12), mine: false, text: "another chat", minutesAgo: 30, group: FS.otherGroup });
    // A deletion frame of another group.
    await socket({ ref: fsId(13), stub: true, deleted: true, group: FS.otherGroup });
    // A second Fansly page of the hub that the chatter does not work, writing to
    // lora-fansly: the same group, so the same chat; and a chat of its own.
    const model = await createModel(app.db, { slug: "mia", name: "Mia" });
    const mia = (await createFanslyPage(app.db, { modelId: model!.id, label: "mia-fansly" }))!;
    pageIds["mia-fansly"] = mia.id;
    await testDb!.pool.query("update pages set external_page_id = '500000000000000004' where id = $1", [mia.id]);
    await fanslyArchive({ ref: fsId(14), mine: true, text: "mia to lora", minutesAgo: 10, page: "mia-fansly" });
    await fanslyArchive({ ref: fsId(15), mine: false, text: "mia's own chat", minutesAgo: 10, page: "mia-fansly", group: FS.otherGroup });
    await switchFreshText("serve", { "lora-fansly": { freshText: true } });

    const refuse = async (input: Parameters<typeof ask>[0], ids: string) => {
      const callsBefore = provider.calls;
      const rowsBefore = (await generations()).length;
      const asked = await askFansly(input);
      const body = expectRefused(asked.response, 400, "context_conflict");
      expect(body.message).toBe(
        `liveTextContext conflicts with the hub's transcript of this conversation (message ids: ${ids})`,
      );
      expect(asked.response.body).not.toMatch(/secret|another chat|MARK|mia/);
      expect(provider.calls).toBe(callsBefore);
      expect((await generations()).length).toBe(rowsBefore);
    };
    const now = fsFresh(4, "fan", `${MARK} are you there?`, 1);
    await refuse({ live: [now, fsFresh(11, "fan", `${MARK} another fan's secret`, 1)] }, fsId(11));
    await refuse({ live: [fsFresh(12, "fan", `${MARK} another chat`, 30)] }, fsId(12));
    await refuse({ live: [fsFresh(13, "fan", `${MARK} deleted elsewhere`, 1), now] }, fsId(13));
    // The hub holds the socket's message as the fan's; the client says the model wrote it.
    await refuse({ live: [fsFresh(3, "model", `${MARK} sent you something`, 3)] }, fsId(3));
    // The other page's chat: the chatter cannot read mia-fansly, so it is not consulted…
    const unseen = await askFansly({ live: [fsFresh(15, "fan", `${MARK} elsewhere`, 10)] });
    expect(unseen.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    // …the owner reads every page: another group there is another chat,
    await refuse({ token: ownerToken, live: [fsFresh(15, "fan", `${MARK} elsewhere`, 10)] }, fsId(15));
    // and the same group there is this chat seen from that page.
    const mirror = await askFansly({ token: ownerToken, live: [fsFresh(14, "fan", `${MARK} mia to lora`, 10)] });
    expect(mirror.status, mirror.response.body).toBe(200);
    expect(mirror.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    // Shadow records the conflict and never throws.
    await patchConfig([{ key: "aiLiveTextContextMode", value: "shadow" }]);
    const shadow = await askFansly({ live: [now, fsFresh(11, "fan", `${MARK} another fan's secret`, 1)] });
    expect(shadow.status, shadow.response.body).toBe(200);
    expect(shadow.context!.live).toEqual({ status: "shadow", accepted: 1, rejected: 1, matched: 0 });
    expect(liveManifest(await lastGeneration())).toMatchObject({
      conflicts: 1, conflictRefs: [fsId(11)], conflictReasons: { foreign_chat: 1 },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] the extension's narrow token on Fansly: drafts lets it ask, freshText lets the tail in", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat();
    const extension = {
      token: grishaExtensionToken, clientVersion: EXTENSION_VERSION, live: [fsFresh(4, "fan", `${MARK} are you there?`, 1)],
    };
    // Fresh text alone does not open a generation on Fansly: that is `drafts` (R20 HF-12).
    await switchFreshText("serve", { "lora-fansly": { freshText: true } });
    expectRefused((await askFansly(extension)).response, 409, "client_feature_disabled", "flag_off");
    // Drafts without fresh text: the generation runs, the tail is ignored.
    await switchFreshText("serve", { "lora-fansly": { drafts: true } });
    const ignored = await askFansly(extension);
    expect(ignored.status, ignored.response.body).toBe(200);
    expect(ignored.context!.live).toEqual({ status: "disabled", accepted: 0, rejected: 0 });
    expect(ignored.prompt).not.toContain(MARK);
    // Both: served.
    await switchFreshText("serve", { "lora-fansly": { drafts: true, freshText: true } });
    const served = await askFansly(extension);
    expect(served.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    expect(served.transcript).toContain(`${MARK} are you there?`);
    expect((await lastGeneration()).params).toMatchObject({ clientProfile: "chat-extension", contextScope: "principal-draft" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] the released Fansly extension (2.10.1, clientContext) is answered as before, whatever the switches", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat();
    // Its real forms (fansly-chat src/background/operations.ts buildConversationRefs):
    // Reply as the fan's id alone, Coach as group/fan, the new-follower Hi as
    // fan/fan; its own transcript; no capability header; never fresh text.
    const clientContext = {
      transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
      messageCount: 35,
      fanDisplayName: "charles",
      fanSpendingData: "Total: $42.00",
      fanSubscriptionData: "Subscribed: yes",
    };
    const forms = [
      { feature: "fast-reply", body: { conversationRef: FS.fan, replyTone: "flirty", replyMode: "default", isRegeneration: false, clientContext } },
      { feature: "coach-chat", body: { conversationRef: FS.group, fanRef: FS.fan, chatterQuestion: "what next?", isRegeneration: false, clientContext } },
      {
        feature: "hi-greeting",
        body: {
          conversationRef: FS.fan, fanRef: FS.fan, variantCount: 1, isRegeneration: false,
          clientContext: { ...clientContext, messageCount: 2, fanUsername: "charles", personalMessageCount: 0, fanSpendingData: "", fanSubscriptionData: "" },
        },
      },
    ];
    const run = async () => {
      const answers: Array<{ feature: string; prompt: string | null }> = [];
      for (const form of forms) {
        const asked = await ask({
          page: "lora-fansly", platform: "fansly", feature: form.feature, capabilities: null,
          clientVersion: "chatgoose-extension/2.10.1", body: form.body,
        });
        expect(asked.status, `${form.feature}: ${asked.response.body}`).toBe(200);
        expect(asked.types, form.feature).toEqual(["meta", "content_delta", "usage", "done"]);
        expect(asked.prompt, form.feature).toContain("CLIENT_LINE_ONE");
        answers.push({ feature: form.feature, prompt: asked.prompt });
      }
      return answers;
    };
    const before = await run();
    await switchFreshText("serve", { ...PROD_ROWS, "lora-fansly": { freshText: true, drafts: true } });
    expect(await run()).toEqual(before);
    // The recorded params name no fresh text and no scope.
    for (const row of await generations()) {
      expect(JSON.stringify(row.params)).not.toContain("liveText");
      expect(row.params).not.toHaveProperty("contextScope");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] Ping and the Hi gate on Fansly read the merged window, so a tail can only tighten them", async (context) => {
    if (!server) return context.skip();
    await seedFanslyChat(SILENT);
    await switchFreshText("serve", { "lora-fansly": { freshText: true } });
    // The fan went quiet six days ago: Ping runs, on the hub's transcript or with the model's own fresh line.
    expect((await askFansly({ feature: "ping" })).status).toBe(200);
    const mine = await askFansly({ feature: "ping", live: [fsFresh(4, "model", `${MARK} miss you`, 1)] });
    expect(mine.status, mine.response.body).toBe(200);
    expect(mine.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0, matched: 0 });
    expect(mine.prompt).toContain("Fan silence: the fan's last message was 6 days ago");
    // The fan has just written on the page: the chat is active, and Ping is refused.
    const active = await askFansly({ feature: "ping", live: [fsFresh(4, "fan", `${MARK} hey`, 1)] });
    expectRefused(active.response, 400, "gate_ping_active");
    // Hi counts the merged window: three messages and eight fresh ones are eleven.
    const eight = Array.from({ length: 8 }, (_, n) => fsFresh(20 + n, "fan", `${MARK} ${n}`, 8 - n));
    expect((await askFansly({ feature: "hi-greeting", body: { variantCount: 1 }, live: eight.slice(0, 7) })).status).toBe(200);
    const gated = await askFansly({ feature: "hi-greeting", body: { variantCount: 1 }, live: eight });
    expect(expectRefused(gated.response, 400, "gate_hi_greeting_limit").message).toContain("at most 10 messages");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-8б] writes the Fansly tail to no store: not the archive, the socket overlay, money or a dossier", async (context) => {
    if (!server) return context.skip();
    // A quiet chat, so that Ping runs too.
    await seedFanslyChat(SILENT);
    await switchFreshText("serve", { "lora-fansly": { freshText: true } });
    const tables = [
      "message_archive", "dm_live_messages", "observations", "fan_profiles", "page_dm_messages", "page_dm_threads",
      "domain_events", "fans", "page_fans", "transactions", "fan_spend_daily", "fan_spend_lifetime", "media_orders",
    ];
    const counts = async () => {
      const columns = tables.map((table) => `(select count(*)::int from ${table}) as ${table}`).join(", ");
      return (await testDb!.pool.query<Record<string, number>>(`select ${columns}`)).rows[0]!;
    };
    const before = await counts();
    for (const feature of AI_LIVE_TEXT_FEATURES) {
      const asked = await askFansly({
        feature, live: [fsFresh(4, "fan", `${MARK} are you there?`, SILENT), fsFresh(5, "model", `${MARK} here`, 0.5)],
      });
      expect(asked.status, `${feature}: ${asked.response.body}`).toBe(200);
      expect(asked.context!.live).toEqual({ status: "served", accepted: 2, rejected: 0, matched: 0 });
    }
    expect(await counts()).toEqual(before);
    const { rows } = await testDb!.pool.query<{ n: number }>(
      `select (select count(*) from message_archive where message_ref = any($1))::int
            + (select count(*) from dm_live_messages where platform_message_id = any($1))::int
            + (select count(*) from page_dm_messages where platform_message_id = any($1))::int as n`,
      [[fsId(4), fsId(5)]],
    );
    expect(rows[0]!.n).toBe(0);
    for (const row of await generations()) {
      expect(JSON.stringify(row.prompt_blocks)).toContain(MARK);
      expect(JSON.stringify(row.params)).not.toContain(MARK);
      expect(row.params.contextScope).toBe("principal-draft");
    }
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  // chat-extension X51: the PPV state of the open chat, read by the client from
  // OnlyMonster's API (`livePpvContext`, context/live-ppv.ts).
  async function paidArchive(ref: string, price: number, opened: boolean | null, minutes: number) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
         is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills, price_mills, is_opened, media_metadata)
       values ($1, 'onlyfans', $2, $3, null, true, $4, 'just for you', false, 0, $5, $6, '[{"type":"video"}]'::jsonb)`,
      [pageIds["lora-of"], FAN, ref, minutesAgo(minutes), price * 1000, opened],
    );
  }
  const livePpv = (items: Array<{ platformMessageId: string; priceUsd: number; purchased: boolean }>) => ({
    livePpvContext: { capturedAt: new Date().toISOString(), items },
  });
  const ppvManifest = (row: GenerationRow) => (
    (row.params.contextManifest as Record<string, unknown> | undefined)?.livePpv as Record<string, unknown> | undefined
  );

  it("[X51] the PPV state is refused where it can never be used, and announced as live-ppv-v1", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    const state = livePpv([{ platformMessageId: "9002", priceUsd: 25, purchased: true }]);
    for (const feature of ["chat-review", "fan-summary", "coach-chat"]) {
      expectRefused((await ask({ feature, body: state })).response, 400, "bad_request", "live_text_not_allowed");
    }
    expectRefused((await ask({ page: "lora-fansly", platform: "fansly", body: state })).response, 400, "bad_request", "live_text_not_allowed");
    const bootstrap = await server.inject({
      method: "GET",
      url: "/api/v1/client/bootstrap",
      headers: { authorization: `Bearer ${grishaExtensionToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(bootstrap.json<{ capabilities: string[] }>().capabilities).toContain("live-ppv-v1");
    expect(provider.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[X51] off it is ignored, in shadow recorded, in serve the prompt says what OnlyFans says now", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await paidArchive("9004", 25, null, 45);
    await paidArchive("9005", 40, false, 40);
    const state = livePpv([
      { platformMessageId: "9004", priceUsd: 25, purchased: true },
      { platformMessageId: "9005", priceUsd: 40, purchased: true },
      { platformMessageId: "9006", priceUsd: 15, purchased: false },
    ]);

    // The archive read keeps no purchase state (context/index.ts): both paid messages read `unknown`.
    const plain = await ask();
    expect(plain.transcript).toContain("Model: [PPV $25.00, unknown] just for you");
    expect(plain.transcript).toContain("Model: [PPV $40.00, unknown] just for you");
    const off = await ask({ body: state });
    expect(off.status, off.response.body).toBe(200);
    expect(off.prompt).toBe(plain.prompt);
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    expect(ppvManifest(await lastGeneration())).toBeUndefined();

    await switchFreshText("shadow");
    const shadow = await ask({ body: state });
    expect(shadow.prompt).toBe(plain.prompt);
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    expect(ppvManifest(await lastGeneration())).toMatchObject({
      source: "client-supplied", mode: "shadow", sent: 3, changed: 2, matched: 0, ignored: 1,
      changedRefs: ["9004", "9005"], ignoredRefs: ["9006"],
    });

    await switchFreshText("serve");
    // The model's paid message the archive has not caught yet comes with the fresh text and gets its mark too.
    const served = await ask({ live: [fresh("9006", "model", `${MARK} one more`, 1)], body: state });
    expect(served.status, served.response.body).toBe(200);
    expect(served.transcript).toContain("Model: [PPV $25.00, purchased] just for you");
    expect(served.transcript).toContain("Model: [PPV $40.00, purchased] just for you");
    expect(served.transcript).toContain(`Model: [PPV $15.00, not purchased] ${MARK} one more`);
    expect(served.transcript!.slice(served.transcript!.indexOf("<transcript>"))).not.toContain(", unknown]");
    const row = await lastGeneration();
    expect(row.params.contextScope).toBe(AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT);
    expect(ppvManifest(row)).toMatchObject({ mode: "serve", sent: 3, changed: 3, ignored: 0 });

    // Alone, without fresh text, it still scopes the generation it changed; a state that changes nothing does not.
    await ask({ body: livePpv([{ platformMessageId: "9004", priceUsd: 25, purchased: true }]) });
    expect((await lastGeneration()).params.contextScope).toBe("principal-draft");
    const outside = await ask({ body: livePpv([{ platformMessageId: "8000", priceUsd: 10, purchased: true }]) });
    expect(outside.prompt).toBe(plain.prompt);
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    expect(ppvManifest(await lastGeneration())).toMatchObject({ mode: "serve", changed: 0, ignored: 1, ignoredRefs: ["8000"] });

    // Nothing of it is stored: the archive still holds what it held.
    const { rows } = await testDb!.pool.query<{ message_ref: string; is_opened: boolean | null }>(
      "select message_ref, is_opened from message_archive where message_ref in ('9004', '9005') order by message_ref",
    );
    expect(rows).toEqual([{ message_ref: "9004", is_opened: null }, { message_ref: "9005", is_opened: false }]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the Hi gate on OnlyFans with automatic messages (critic item 11)", () => {
  // FINDING, pinned here so it is not rediscovered: the hub's archive carries no
  // automation signal. A welcome message and every mass send land in
  // message_archive (and in dm_message_archive) as ordinary messages of the
  // page, and the Hi gate counts them. The chat extension asks for Hi with
  // `variantCount`, never with the deprecated `greetingMode` alias that skips
  // the gate, so a fan who never wrote but received more than ten automatic
  // messages is refused Hi. Fresh text cannot lift it: a client leaves queued
  // (automatic) messages out of its snapshot, and the merge never shrinks the
  // transcript. Lifting it needs the automation flag in the archive: a hub
  // change of its own, before the "new fans" surface ships.
  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });
    app.config.chatMuseAiGatewayEnabled = true;
    provider.calls = 0;
    app.aiGatewayProvider = capturingProvider();
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    const grishaId = await fixtureUserId(app, "grisha");
    const persona = createBundledPersonalities()[0]!;
    await seedBundledAiPersona(app.db, {
      key: persona.id,
      displayName: persona.name,
      systemBlock: persona.content,
      bundledVersion: persona.builtinVersion!,
    });
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(app.db, { modelId: lora!.id, label: "lora-of" });
    pageIds["lora-of"] = page!.id;
    await storeProxyConfig(app.db, page!.id, {
      url: "socks5://proxy.example:1080",
      encryptedAuth: null,
      keyVersion: null,
      rateLimitScopeKey: "shared-ai-proxy",
    });
    await assignPageToUser(app, { userId: grishaId, pageLabel: "lora-of" }, AUDIT);
    grishaToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha client" })).token;
    server = await buildApiServer(app);
    await server.ready();
  }, 120_000);

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("counts a welcome message and mass sends like any message: over ten of them, a silent fan gets no Hi", async (context) => {
    if (!server) return context.skip();
    const automatic = async (count: number, from = 1) => {
      for (let n = from; n < from + count; n += 1) {
        await archive({
          ref: String(8000 + n),
          mine: true,
          text: n === 1 ? "welcome to my page 💋" : `mass message ${n}`,
          minutesAgo: (20 - n) * 24 * 60,
        });
      }
    };
    const hi = (body: Record<string, unknown>) => ask({ feature: "hi-greeting", capabilities: null, body });

    // Ten automatic messages and not a word from the fan: Hi is available.
    await automatic(10);
    expect((await hi({ variantCount: 1 })).status).toBe(200);
    expect((await hi({ variantCount: 3 })).status).toBe(200);

    // The eleventh mass send locks the fan out, though nobody ever wrote to them personally.
    await automatic(1, 11);
    for (const variantCount of [1, 3]) {
      const gated = await hi({ variantCount });
      expect(expectRefused(gated.response, 400, "gate_hi_greeting_limit").message).toBe(
        "hi-greeting is only available for conversations with at most 10 messages",
      );
    }
    // Only the deprecated alias of the released clients skips the gate.
    expect((await hi({ greetingMode: "new-follower", fanRef: FAN })).status).toBe(200);
    expect(provider.calls).toBe(3);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
