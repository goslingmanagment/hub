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
      | (Frame & { live: { status: string; accepted: number; rejected: number }; servedHead: Frame | null; window: { served: number } })
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

  it("refuses it for a Fansly page, beside clientContext and from a caller that cannot read the answer", async (context) => {
    if (!server) return context.skip();
    await seedChat();
    await switchFreshText("serve");
    const clientContext = { transcript: "Fan: hi", messageCount: 1, fanDisplayName: "Bob" };

    const fansly = await ask({ page: "lora-fansly", platform: "fansly", live: [freshFanMessage()], body: { clientContext } });
    expectRefused(fansly.response, 400, "bad_request", "live_text_not_allowed");
    const fanslyAlone = await ask({ page: "lora-fansly", platform: "fansly", live: [freshFanMessage()] });
    expectRefused(fanslyAlone.response, 400, "bad_request", "live_text_not_allowed");

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
      live: { status: "shadow", accepted: 1, rejected: 1 },
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
    expect(conflicting.context!.live).toEqual({ status: "shadow", accepted: 1, rejected: 1 });
    expect(liveManifest(await lastGeneration())).toMatchObject({
      conflicts: 1, conflictRefs: ["9003"], conflictReasons: { direction: 1 }, acceptedRefs: ["9004"],
    });
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
      live: { status: "served", accepted: 2, rejected: 0 },
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
      expect(asked.context!.live, feature).toEqual({ status: "served", accepted: 1, rejected: 0 });
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
    expect(same.context).toMatchObject({ window: { served: 3 }, live: { status: "served", accepted: 0, rejected: 0 } });
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    expect(liveManifest(await lastGeneration())).toMatchObject({ matched: 2, accepted: 0, archiveSawHead: true });

    // A fresh message's HTML is normalized like an archive row's (critic item 16).
    const html = await ask({ live: [fresh("9004", "fan", `<p>${MARK} look &amp; tell</p><p>ok?<br><a href="https://x.example/a">this</a></p>`, 1)] });
    expect(html.transcript).toContain(`${MARK} look &amp; tell\nok?\nthis`);
    expect(html.transcript).not.toMatch(/href|x\.example/);

    // A message the hub knows as deleted does not come back through a client.
    const tombstoned = await ask({ live: [fresh("9000", "fan", `${MARK} deleted long ago`, 70)] });
    expect(tombstoned.status, tombstoned.response.body).toBe(200);
    expect(tombstoned.prompt).not.toContain(MARK);
    expect(tombstoned.context!.live).toEqual({ status: "rejected", accepted: 0, rejected: 1 });
    expect((await lastGeneration()).params).not.toHaveProperty("contextScope");
    // Beside a usable item it is only counted.
    const mixed = await ask({ live: [fresh("9000", "fan", `${MARK} deleted long ago`, 70), freshFanMessage()] });
    expect(mixed.context!.live).toEqual({ status: "served", accepted: 1, rejected: 1 });
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
    expect(stub.context!.live).toEqual({ status: "rejected", accepted: 0, rejected: 1 });
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
    expect(unseen.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0 });
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
    expect(mirror.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0 });
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
      expect(asked.context!.live).toEqual({ status: "served", accepted: 2, rejected: 0 });
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
    expect(served.context!.live).toEqual({ status: "served", accepted: 1, rejected: 0 });
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
