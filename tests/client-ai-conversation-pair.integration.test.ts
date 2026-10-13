import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aiFeatureStreamFrameSchema, errorResponseSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension R20 HF-9: the pair `groupId ↔ fanRef` of a Fansly AI request,
// through the real route. On Fansly a chat is a group with an id of its own; a
// request whose transcript the hub loads itself (no `clientContext`: the new
// chat-extension's path) names the group as `conversationRef` and the fan as
// `fanRef`, and the page's capture (`page_dm_threads`) says whose chat the
// group is. The released Fansly extension (fansly-chat 2.10.1) sends its own
// transcript (`clientContext`) and is answered exactly as before.

// Fansly ids are 18-digit snowflakes, past 2^53: the two fans are one double
// (`Number(FAN) === Number(OTHER_FAN)`), so only an exact string comparison
// tells them apart.
const GROUP = "650000000000000001";
const NEW_GROUP = "650000000000000009";
const FAN = "700000000000000001";
const OTHER_FAN = "700000000000000002";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
/** A full device token of a chatter of every page below. */
let token = "";
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput; calls: number } = { calls: 0 };

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.calls += 1;
      provider.input = input;
      yield { type: "content_delta", text: "sure thing" };
      yield {
        type: "usage",
        providerResponseId: "msg_pair",
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

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await server?.close();
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.chatMuseAiGatewayEnabled = true;
  app.aiGatewayProvider = capturingProvider();
  provider.calls = 0;
  delete provider.input;
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id,
    displayName: persona.name,
    systemBlock: persona.content,
    bundledVersion: persona.builtinVersion!,
  });
  const model = await createModel(app.db, { slug: "pair", name: "Pair" });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  for (const [label, create] of [
    ["pair-fs", createFanslyPage],
    ["pair-fs2", createFanslyPage],
    ["pair-of", createOnlyFansPage],
  ] as const) {
    const page = await create(app.db, { modelId: model.id, label });
    if (!page) {
      throw new Error(`test setup: page ${label} creation failed`);
    }
    pageIds[label] = page.id;
    await storeProxyConfig(app.db, page.id, {
      url: "socks5://proxy.example:1080",
      encryptedAuth: null,
      keyVersion: null,
      rateLimitScopeKey: "shared-ai-proxy",
    });
  }
  await createUserAccount(app, { username: "pair-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "pair-chatter", pageLabel: "pair-fs" }, { source: "cli" })).key;
  const userId = await fixtureUserId(app, "pair-chatter");
  for (const pageLabel of ["pair-fs2", "pair-of"]) {
    await assignPageToUser(app, { userId, pageLabel }, { source: "cli" });
  }
  server = await buildApiServer(app);
  await server.ready();
});

afterEach(async () => {
  await trap?.restore();
  trap = null;
});

/** The page's thread of a group, as the Fansly Sync Engine captures it. */
async function thread(input: { group: string; fan: string | null; page?: string; visible?: boolean }) {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, $4)`,
    [pageIds[input.page ?? "pair-fs"], input.group, input.fan, input.visible ?? true],
  );
}

/** One archived fan message in a group of pair-fs, so the transcript is not empty. */
async function archived(group: string, fan: string, ref: string) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     values ($1, 'fansly', $2, $3, $4, false, now() - interval '10 minutes', $5)`,
    [pageIds["pair-fs"], group, ref, fan, `hello from ${ref}`],
  );
}

/** One AI request. `capabilities: null` sends no capability header. */
async function ask(input: {
  feature?: string;
  page?: string;
  platform?: string;
  capabilities?: string | null;
  body: Record<string, unknown>;
}): Promise<InjectResponse> {
  delete provider.input;
  const capabilities = input.capabilities === undefined ? "context-v1" : input.capabilities;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature ?? "fast-reply"}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(capabilities !== null ? { "x-kernel-ai-capabilities": capabilities } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? "pair-fs",
      platform: input.platform ?? "fansly",
      ...input.body,
    },
  });
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => aiFeatureStreamFrameSchema.parse(JSON.parse(line.slice("data: ".length))) as Frame);
}

/** A served request: its frames, its context frame, and the recorded manifest. */
async function served(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  const all = frames(response.body);
  expect(all.at(-1)?.type).toBe("done");
  const meta = all.find((frame) => frame.type === "meta");
  const { rows } = await testDb!.pool.query<{ params: { contextManifest?: Record<string, unknown> } }>(
    `select params from ai_generation_content where generation_ref = $1`,
    [meta!["requestId"]],
  );
  return {
    types: all.map((frame) => frame.type),
    context: all.find((frame) => frame.type === "context_v1"),
    manifest: rows[0]?.params.contextManifest,
  };
}

async function generationRows() {
  const { rows } = await testDb!.pool.query<{ content: string; usage: string }>(
    `select (select count(*) from ai_generation_content)::text as content,
            (select count(*) from ai_usage_events)::text as usage`,
  );
  return { content: Number(rows[0]!.content), usage: Number(rows[0]!.usage) };
}

/** The stream with what differs per request by design (ids, the quota left) masked. */
function comparable(raw: string) {
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/"(remainingRequestsToday|remainingMicroUsdToday)":\d+/g, '"$1":<n>');
}

describe("the new client's pair on Fansly (no clientContext)", () => {
  it("refuses a pair the page's capture contradicts: 409 conversation_fan_mismatch, nothing generated or recorded", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread({ group: GROUP, fan: FAN });
    await archived(GROUP, FAN, "8001");
    trap = await armNoOutboundTrap(testDb);

    for (const request of [
      { feature: "fast-reply" },
      { feature: "fast-reply", capabilities: null },
      { feature: "improve-draft", body: { draftText: "hey you" } },
      { feature: "fan-summary" },
      { feature: "chat-review" },
      { feature: "coach-chat", body: { chatterQuestion: "what next?" } },
    ]) {
      const response = await ask({
        feature: request.feature,
        ...(request.capabilities !== undefined ? { capabilities: request.capabilities } : {}),
        body: { conversationRef: GROUP, fanRef: OTHER_FAN, ...request.body },
      });
      expect(response.statusCode, `${request.feature}: ${response.body}`).toBe(409);
      const error = errorResponseSchema.parse(response.json());
      expect(error.error).toBe("conversation_fan_mismatch");
      // The answer names neither id: never the fan the hub holds for the group.
      expect(response.body).not.toContain(FAN);
      expect(response.body).not.toContain(OTHER_FAN);
      expect(response.body).not.toContain(GROUP);
    }
    expect(provider.calls).toBe(0);
    expect(await generationRows()).toEqual({ content: 0, usage: 0 });
    await trap.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses it whatever else the page holds: a hidden thread, the fan's id given as the group", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // A chat out of the list is still that fan's.
    await thread({ group: GROUP, fan: FAN, visible: false });
    const hidden = await ask({ body: { conversationRef: GROUP, fanRef: OTHER_FAN } });
    expect(hidden.statusCode, hidden.body).toBe(409);
    expect(hidden.json().error).toBe("conversation_fan_mismatch");

    // A group named as its own fan is not that group's fan either.
    const groupAsFan = await ask({ body: { conversationRef: GROUP, fanRef: GROUP } });
    expect(groupAsFan.statusCode, groupAsFan.body).toBe(409);
    expect(groupAsFan.json().error).toBe("conversation_fan_mismatch");
    expect(provider.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serves a pair the page's capture vouches for: `pair: verified` in the frame and the manifest", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread({ group: GROUP, fan: FAN });
    await archived(GROUP, FAN, "8001");
    trap = await armNoOutboundTrap(testDb);

    const verified = await served(await ask({ body: { conversationRef: GROUP, fanRef: FAN } }));
    expect(verified.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(verified.context).toMatchObject({ pair: "verified", source: "archive", window: { served: 1 } });
    expect(verified.manifest).toMatchObject({ conversationPair: "verified" });
    expect(JSON.stringify(provider.input)).toContain("hello from 8001");

    // Without the capability there is no frame to carry it; the record still says it.
    const plain = await served(await ask({ capabilities: null, body: { conversationRef: GROUP, fanRef: FAN } }));
    expect(plain.types).toEqual(["meta", "content_delta", "usage", "done"]);
    expect(plain.manifest).toMatchObject({ conversationPair: "verified" });
    await trap.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("serves a pair new to the hub, marked `pair: unverified`", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The group of another page and its other fan: the pair is checked on the page the request names.
    await thread({ group: NEW_GROUP, fan: OTHER_FAN, page: "pair-fs2" });
    // A thread whose fan the hub does not know yet.
    await thread({ group: GROUP, fan: null });
    trap = await armNoOutboundTrap(testDb);

    // No thread of the group on the page: a chat the hub has not captured yet.
    const fresh = await served(await ask({ body: { conversationRef: NEW_GROUP, fanRef: FAN } }));
    expect(fresh.context).toMatchObject({ pair: "unverified" });
    expect(fresh.manifest).toMatchObject({ conversationPair: "unverified" });

    const unknownFan = await served(await ask({ body: { conversationRef: GROUP, fanRef: FAN } }));
    expect(unknownFan.context).toMatchObject({ pair: "unverified" });
    expect(unknownFan.manifest).toMatchObject({ conversationPair: "unverified" });
    expect(provider.calls).toBe(2);
    await trap.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("checks no pair when the request names no fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread({ group: GROUP, fan: FAN });
    await archived(GROUP, FAN, "8001");

    for (const fanRef of [undefined, null]) {
      const groupOnly = await served(await ask({ body: { conversationRef: GROUP, ...(fanRef === null ? { fanRef } : {}) } }));
      expect(groupOnly.context).toBeDefined();
      expect(groupOnly.context).not.toHaveProperty("pair");
      expect(groupOnly.manifest).not.toHaveProperty("conversationPair");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the released Fansly extension (fansly-chat 2.10.1, clientContext) is answered as before", () => {
  // Its real request forms (fansly-chat ff30d00, src/background/operations.ts
  // buildConversationRefs, kernel-feature-gateway.ts, followers-service.ts,
  // voice-service.ts): Coach, Recap and the notes fill send the group and the
  // fan (`group/fan`) once the fan is resolved; every other feature sends the
  // fan's id alone (`fan`), or the group when the fan is not resolved
  // (`group`); the new-follower Hi and the voice script send the fan's id
  // twice (`fan/fan`). Each is answered byte for byte the same whatever the
  // page's capture holds: no thread of the group, a thread of this fan, and a
  // thread of ANOTHER fan, which the new client's path refuses.
  const clientContext = {
    transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
    messageCount: 35,
    fanDisplayName: "charles",
    fanSpendingData: "Total: $42.00",
    fanSubscriptionData: "Subscribed: yes",
  };
  const forms: Array<{ name: string; feature: string; body: Record<string, unknown> }> = [
    {
      name: "group/fan coach-chat",
      feature: "coach-chat",
      body: { conversationRef: GROUP, fanRef: FAN, chatterQuestion: "what next?", isRegeneration: false, clientContext },
    },
    {
      name: "group/fan fan-summary (full)",
      feature: "fan-summary",
      body: { conversationRef: GROUP, fanRef: FAN, messageCount: 1500, isRegeneration: false, clientContext: { ...clientContext, transcriptCoverage: "window" } },
    },
    {
      name: "group/fan fan-summary (short)",
      feature: "fan-summary",
      body: { conversationRef: GROUP, fanRef: FAN, summaryMode: "short", isRegeneration: false, clientContext },
    },
    {
      name: "group/fan fan-notes-fill",
      feature: "fan-notes-fill",
      body: { conversationRef: GROUP, fanRef: FAN, noteFields: ["Имя", "Возраст"], isRegeneration: false, clientContext },
    },
    {
      name: "fan fast-reply",
      feature: "fast-reply",
      body: { conversationRef: FAN, replyTone: "flirty", replyMode: "default", isRegeneration: false, clientContext },
    },
    {
      name: "group fast-reply (fan not resolved)",
      feature: "fast-reply",
      body: { conversationRef: GROUP, isRegeneration: false, clientContext },
    },
    {
      name: "fan/fan hi-greeting (New Followers)",
      feature: "hi-greeting",
      body: {
        conversationRef: FAN,
        fanRef: FAN,
        variantCount: 1,
        isRegeneration: false,
        clientContext: { ...clientContext, messageCount: 2, fanUsername: "charles", personalMessageCount: 0, fanSpendingData: "", fanSubscriptionData: "" },
      },
    },
    {
      name: "fan/fan voice-script",
      feature: "voice-script",
      body: {
        conversationRef: FAN,
        fanRef: FAN,
        draftText: "omg hi",
        isRegeneration: false,
        clientContext: { ...clientContext, fanSpendingData: "", fanSubscriptionData: "" },
      },
    },
  ];

  async function enableVoiceLane() {
    app.config.voiceNotesEnabled = true;
    app.config.voiceNotesPageAllowlist = "pair-fs";
    app.voiceTtsProvider = {
      async synthesize() {
        throw new Error("voice-script must not invoke TTS");
      },
    };
    await upsertVoiceProfile(app.db, {
      platformAccountId: pageIds["pair-fs"]!,
      voiceId: "voice-pair-test",
      model: "eleven_v3",
      settings: {},
      outputFormat: "mp3_44100_128",
    });
  }

  it("answers every form the same with no thread, this fan's thread and another fan's thread of the group", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await enableVoiceLane();
    const states = [
      { name: "no thread", seed: async () => undefined },
      { name: "this fan's thread", seed: () => thread({ group: GROUP, fan: FAN }) },
      { name: "another fan's thread", seed: () => thread({ group: GROUP, fan: OTHER_FAN }) },
    ];
    const answers = new Map<string, Array<{ raw: string; prompt: string; manifest: unknown }>>();
    for (const state of states) {
      // Each state starts from the same history: no thread, and no recap of an
      // earlier state for Coach to attach.
      await testDb.pool.query("delete from page_dm_threads");
      await testDb.pool.query("delete from ai_generation_content");
      await state.seed();
      for (const form of forms) {
        // The released client advertises no capability (`debug-input-v1` only behind its debug switch).
        const response = await ask({ feature: form.feature, capabilities: null, body: form.body });
        expect(response.statusCode, `${form.name}, ${state.name}: ${response.body}`).toBe(200);
        const { manifest } = await served(response);
        expect(manifest ?? {}, form.name).not.toHaveProperty("conversationPair");
        const list = answers.get(form.name) ?? [];
        list.push({ raw: comparable(response.body), prompt: JSON.stringify(provider.input!.body.prompt), manifest });
        answers.set(form.name, list);
      }
    }
    for (const [name, list] of answers) {
      expect(list, name).toHaveLength(states.length);
      for (const answer of list.slice(1)) {
        expect(answer, name).toEqual(list[0]);
      }
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("gets no context frame, so no pair, even when it advertises context-v1", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread({ group: GROUP, fan: OTHER_FAN });
    const response = await ask({ feature: "coach-chat", body: forms[0]!.body });
    const answer = await served(response);
    expect(answer.types).toEqual(["meta", "content_delta", "usage", "done"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("OnlyFans is answered as before", () => {
  it("checks no pair on an OnlyFans page, whatever its threads hold", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // An OnlyFans chat id is the fan's id; a thread that names another fan is not read.
    await thread({ group: FAN, fan: OTHER_FAN, page: "pair-of" });
    for (const body of [
      { conversationRef: FAN },
      { conversationRef: FAN, fanRef: FAN },
      { conversationRef: FAN, fanRef: OTHER_FAN },
    ]) {
      const answer = await served(await ask({ page: "pair-of", platform: "onlyfans", body }));
      expect(answer.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
      expect(answer.context).not.toHaveProperty("pair");
      expect(answer.manifest).not.toHaveProperty("conversationPair");
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
