import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aiFeatureStreamFrameSchema, errorResponseSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertErasureLog,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension R20 HF-4а: the identity of a voice take on Fansly, through the
// real routes: a `voice-script` generation, then its paid render
// (`POST /api/v1/pages/:pageLabel/voice-notes`). The new client names the group
// (`conversationRef`) and the fan (`fanRef`) apart and sends no clientContext;
// the hub checks their pair (HF-9) on the script and again on the render. The
// released Fansly extension (fansly-chat 2.10.1) names the fan's id on both
// refs of the script and renders with no `fanRef`: it is answered exactly as
// before.

// Fansly ids are 18-digit snowflakes, past 2^53: compared as exact strings only.
const GROUP = "650000000000000001";
const NEW_GROUP = "650000000000000009";
const FAN = "700000000000000001";
const OTHER_FAN = "700000000000000002";
/** What the model answers: a script the render's validation admits. */
const SCRIPT = "hello [warmly] world";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let lakeDir = "";
/** A full device token of a chatter of both pages. */
let token = "";
let userId = 0;
const pageIds: Record<string, number> = {};
const provider = { calls: 0 };
const tts = { calls: 0 };

function scriptProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      provider.calls += 1;
      yield { type: "content_delta", text: SCRIPT };
      yield {
        type: "usage",
        providerResponseId: "msg_voice_pair",
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
  lakeDir = await mkdtemp(path.join(tmpdir(), "voice-pair-lake-"));
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
  if (lakeDir) {
    await rm(lakeDir, { recursive: true, force: true });
  }
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
  app.aiGatewayProvider = scriptProvider();
  provider.calls = 0;
  tts.calls = 0;
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id,
    displayName: persona.name,
    systemBlock: persona.content,
    bundledVersion: persona.builtinVersion!,
  });
  const model = await createModel(app.db, { slug: "voice-pair", name: "Voice Pair" });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  for (const [label, create] of [
    ["voice-fs", createFanslyPage],
    ["voice-of", createOnlyFansPage],
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
  // The voice lane of voice-fs, as the owner switches it on.
  app.config.voiceNotesEnabled = true;
  app.config.voiceNotesRetrievalEnabled = true;
  app.config.voiceNotesPageAllowlist = "voice-fs";
  app.config.voiceNotesScriptMaxChars = 600;
  app.config.voiceNotesDailyCharBudget = 100_000;
  app.config.voiceNotesGlobalDailyCharBudget = 100_000;
  app.config.voiceNotesMaxConcurrentSyntheses = 2;
  app.voiceTtsProvider = {
    async synthesize() {
      tts.calls += 1;
      return {
        ok: true,
        audio: Buffer.from("fake-mp3-bytes-payload"),
        characterCost: SCRIPT.length,
        requestId: "tts-req",
        traceId: "tts-trace",
        region: "us-east-1",
      };
    },
  };
  await upsertVoiceProfile(app.db, {
    platformAccountId: pageIds["voice-fs"]!,
    voiceId: "voice-pair-test",
    model: "eleven_v3",
    settings: {},
    outputFormat: "mp3_44100_128",
  });
  await createUserAccount(app, { username: "voice-pair-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(
    app,
    { username: "voice-pair-chatter", pageLabel: "voice-fs" },
    { source: "cli" },
  )).key;
  userId = await fixtureUserId(app, "voice-pair-chatter");
  await assignPageToUser(app, { userId, pageLabel: "voice-of" }, { source: "cli" });
  server = await buildApiServer(app);
  await server.ready();
});

async function waitFor(what: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor: ${what} did not happen in time`);
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await testDb!.pool.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params);
  return Number(rows[0]!.n);
}

/** The page's thread of a group, as the Fansly Sync Engine captures it. */
async function thread(group: string, fan: string | null) {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, true)`,
    [pageIds["voice-fs"], group, fan],
  );
}

/** One archived fan message in a group of voice-fs, so the transcript is not empty. */
async function archived(group: string, fan: string, ref: string) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     values ($1, 'fansly', $2, $3, $4, false, now() - interval '10 minutes', $5)`,
    [pageIds["voice-fs"], group, ref, fan, `hello from ${ref}`],
  );
}

/** A voice-script request. `capabilities: null` sends no capability header. */
async function script(input: {
  page?: string;
  platform?: string;
  capabilities?: string | null;
  body: Record<string, unknown>;
}): Promise<InjectResponse> {
  const capabilities = input.capabilities === undefined ? "context-v1" : input.capabilities;
  return server!.inject({
    method: "POST",
    url: "/api/v1/ai/features/voice-script",
    headers: {
      authorization: `Bearer ${token}`,
      ...(capabilities !== null ? { "x-kernel-ai-capabilities": capabilities } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? "voice-fs",
      platform: input.platform ?? "fansly",
      ...input.body,
    },
  });
}

/** The new client's script: the group and the fan apart, no clientContext. */
function newScriptBody(group: string, fan: string) {
  return { conversationRef: group, fanRef: fan, replyTone: "flirty", draftText: "miss you", isRegeneration: false };
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => aiFeatureStreamFrameSchema.parse(JSON.parse(line.slice("data: ".length))) as Frame);
}

/** A served script: its generation ref (recorded and completed) and its context frame. */
async function served(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  const all = frames(response.body);
  expect(all.at(-1)?.type).toBe("done");
  const generationRef = String(all.find((frame) => frame.type === "meta")!["requestId"]);
  await waitFor("the voice-script generation record", async () => (await testDb!.pool.query(
    `select 1 from ai_generation_content where generation_ref = $1 and params->>'outcome' = 'completed'`,
    [generationRef],
  )).rowCount === 1);
  return { generationRef, context: all.find((frame) => frame.type === "context_v1") };
}

async function render(body: Record<string, unknown>, page = "voice-fs"): Promise<InjectResponse> {
  return server!.inject({
    method: "POST",
    url: `/api/v1/pages/${page}/voice-notes`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function renderState(id: number): Promise<string> {
  const response = await server!.inject({
    method: "GET",
    url: `/api/v1/pages/voice-fs/voice-notes/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(response.json().state);
}

/** A render admitted (202) and then settled `completed`. */
async function rendered(response: InjectResponse): Promise<number> {
  expect(response.statusCode, response.body).toBe(202);
  const id = Number(response.json().voiceNoteId);
  await waitFor("the render to complete", async () => (await renderState(id)) === "completed");
  return id;
}

async function voiceRow(id: number) {
  const { rows } = await testDb!.pool.query<{ conversation_ref: string; request_hash: string; source_generation_ref: string }>(
    `select conversation_ref, request_hash, source_generation_ref from voice_notes where id = $1`,
    [id],
  );
  return rows[0];
}

/** The frozen request hash: sha256(pageId \n conversationRef \n sourceGenerationRef \n script). */
function frozenHash(conversationRef: string, sourceGenerationRef: string, canonicalScript: string): string {
  return createHash("sha256")
    .update(`${pageIds["voice-fs"]}\n${conversationRef}\n${sourceGenerationRef}\n${canonicalScript}`)
    .digest("hex");
}

async function spentChars(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ total: string }>(
    `select coalesce(sum(spent_chars), 0)::text as total from voice_char_budget`,
  );
  return Number(rows[0]!.total);
}

describe("[R20 HF-4а] the new client's voice take: the group and the fan apart, no clientContext", () => {
  it("script → the real render with different ids and no clientContext: a verified pair, one paid render", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread(GROUP, FAN);
    await archived(GROUP, FAN, "8001");

    const take = await served(await script({ body: newScriptBody(GROUP, FAN) }));
    expect(take.context).toMatchObject({ pair: "verified" });
    const { rows: [generation] } = await testDb.pool.query<{ conversation_ref: string; fan_ref: string; feature: string }>(
      `select conversation_ref, fan_ref, feature from ai_generation_content where generation_ref = $1`,
      [take.generationRef],
    );
    expect(generation).toEqual({ conversation_ref: GROUP, fan_ref: FAN, feature: "voice-script" });

    const body = {
      clientRequestId: randomUUID(),
      conversationRef: GROUP,
      fanRef: FAN,
      sourceGenerationRef: take.generationRef,
      script: SCRIPT,
    };
    const first = await render(body);
    expect(first.json()).toMatchObject({ state: "dispatched", scriptChars: SCRIPT.length });
    const id = await rendered(first);
    expect(tts.calls).toBe(1);
    // The render is keyed by the chat; the request hash is the frozen one (fanRef is not hashed).
    expect(await voiceRow(id)).toEqual({
      conversation_ref: GROUP,
      request_hash: frozenHash(GROUP, take.generationRef, SCRIPT),
      source_generation_ref: take.generationRef,
    });

    // The same request replays the same render, no second synthesis.
    const replay = await render(body);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({ voiceNoteId: id, state: "completed" });
    expect(tts.calls).toBe(1);

    // The source is of this pair only: the group without the fan (the released
    // client's rule, the chat is the fan), another fan, or the fan as the chat.
    for (const other of [
      { conversationRef: GROUP },
      { conversationRef: GROUP, fanRef: OTHER_FAN },
      { conversationRef: FAN, fanRef: FAN },
      { conversationRef: FAN },
    ]) {
      const refused = await render({ clientRequestId: randomUUID(), sourceGenerationRef: take.generationRef, script: SCRIPT, ...other });
      expect(refused.statusCode, `${JSON.stringify(other)}: ${refused.body}`).toBe(400);
      expect(errorResponseSchema.parse(refused.json()).error).toBe("voice_source_invalid");
    }
    expect(tts.calls).toBe(1);
    expect(await count("voice_notes")).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("renders a pair new to the hub (no thread of the group): the script says `pair: unverified`", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const take = await served(await script({ body: newScriptBody(NEW_GROUP, FAN) }));
    expect(take.context).toMatchObject({ pair: "unverified" });
    const id = await rendered(await render({
      clientRequestId: randomUUID(),
      conversationRef: NEW_GROUP,
      fanRef: FAN,
      sourceGenerationRef: take.generationRef,
      script: SCRIPT,
    }));
    expect((await voiceRow(id))?.conversation_ref).toBe(NEW_GROUP);
    expect(tts.calls).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[R20 HF-4а] a pair the page's capture contradicts: 409 conversation_fan_mismatch", () => {
  it("refuses the script before any spend: nothing generated, nothing recorded", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread(GROUP, FAN);
    const response = await script({ body: newScriptBody(GROUP, OTHER_FAN) });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conversation_fan_mismatch");
    expect(response.body).not.toContain(FAN);
    expect(response.body).not.toContain(OTHER_FAN);
    expect(response.body).not.toContain(GROUP);
    expect(provider.calls).toBe(0);
    expect(await count("ai_generation_content")).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses the render when the group was captured as another fan's chat since its script: no row, no budget, no synthesis", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const take = await served(await script({ body: newScriptBody(GROUP, FAN) }));
    expect(take.context).toMatchObject({ pair: "unverified" });
    // The Sync Engine captures the group: another fan's chat.
    await thread(GROUP, OTHER_FAN);

    const response = await render({
      clientRequestId: randomUUID(),
      conversationRef: GROUP,
      fanRef: FAN,
      sourceGenerationRef: take.generationRef,
      script: SCRIPT,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error).toBe("conversation_fan_mismatch");
    expect(response.body).not.toContain(FAN);
    expect(response.body).not.toContain(OTHER_FAN);
    expect(response.body).not.toContain(GROUP);
    expect(await count("voice_notes")).toBe(0);
    expect(await spentChars()).toBe(0);
    expect(tts.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the other refusals as they were: the client-context lane's refs, a missing fan, OnlyFans", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread(GROUP, FAN);
    const clientContext = {
      transcript: "[10:00] Fan: hey babe\n[10:01] Model: hey you",
      messageCount: 2,
      fanDisplayName: "charles",
      fanSpendingData: "",
      fanSubscriptionData: "",
    };
    for (const [name, request] of [
      // With clientContext the hub checks no pair, so the refs must still be the fan's id twice.
      ["client-context lane, group/fan", { capabilities: null, body: { ...newScriptBody(GROUP, FAN), clientContext } }],
      ["client-context lane, no fan", { capabilities: null, body: { conversationRef: FAN, draftText: "hi", clientContext } }],
      ["no clientContext, no fan", { body: { conversationRef: GROUP, draftText: "hi" } }],
      ["no clientContext, a blank fan", { body: { conversationRef: GROUP, fanRef: "  ", draftText: "hi" } }],
    ] as const) {
      const response = await script(request);
      expect(response.statusCode, `${name}: ${response.body}`).toBe(400);
      expect(response.json(), name).toMatchObject({
        error: "gate_voice_identity_required",
        message: "voice-script requires matching, nonblank conversationRef and fanRef",
      });
    }
    const onlyFans = await script({ page: "voice-of", platform: "onlyfans", body: newScriptBody(GROUP, FAN) });
    expect(onlyFans.statusCode, onlyFans.body).toBe(400);
    expect(onlyFans.json().error).toBe("gate_voice_unsupported_platform");
    expect(provider.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the released Fansly extension (fansly-chat 2.10.1) is answered as before", () => {
  // Its real request forms (fansly-chat ff30d00): the script —
  // src/background/voice-service.ts startScript through
  // kernel-feature-gateway.ts streamFeature: the fan's id on both refs, its own
  // transcript, no persona, no requested window, no capability header; the
  // render — voice-service.ts createNote through agency-hub-client.ts
  // createVoiceNote: four fields, the fan's id as the chat, no fanRef.
  const releasedScriptBody = () => ({
    conversationRef: FAN,
    fanRef: FAN,
    replyTone: "flirty",
    draftText: "omg hi",
    isRegeneration: false,
    clientContext: {
      transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
      messageCount: 2,
      fanDisplayName: "charles",
      fanSpendingData: "",
      fanSubscriptionData: "",
    },
  });
  const releasedRenderBody = (sourceGenerationRef: string) => ({
    clientRequestId: randomUUID(),
    conversationRef: FAN,
    sourceGenerationRef,
    script: SCRIPT,
  });

  /** The stream with what differs per request by design (ids, the quota left) masked. */
  function comparable(raw: string) {
    return raw
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/"(remainingRequestsToday|remainingMicroUsdToday)":\d+/g, '"$1":<n>');
  }

  it("its script and render get the same answers whatever the page's capture holds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const states = [
      { name: "no thread", seed: async () => undefined },
      { name: "this fan's thread of the group", seed: () => thread(GROUP, FAN) },
      { name: "another fan's thread of the group", seed: () => thread(GROUP, OTHER_FAN) },
      // A capture that WOULD contradict the pair if the render named the fan apart.
      { name: "a thread whose id is the fan's, of another fan", seed: () => thread(FAN, OTHER_FAN) },
    ];
    const answers: Array<{ script: string; render: unknown; state: string }> = [];
    for (const state of states) {
      for (const table of ["page_dm_threads", "voice_notes", "voice_char_budget", "ai_generation_content"]) {
        await testDb.pool.query(`delete from ${table}`);
      }
      await state.seed();
      const scriptResponse = await script({ capabilities: null, body: releasedScriptBody() });
      const take = await served(scriptResponse);
      expect(take.context, state.name).toBeUndefined();

      const renderResponse = await render(releasedRenderBody(take.generationRef));
      const id = await rendered(renderResponse);
      expect(await voiceRow(id), state.name).toEqual({
        conversation_ref: FAN,
        request_hash: frozenHash(FAN, take.generationRef, SCRIPT),
        source_generation_ref: take.generationRef,
      });
      const view = renderResponse.json();
      answers.push({
        script: comparable(scriptResponse.body),
        render: { ...view, voiceNoteId: "<id>", createdAt: "<at>" },
        state: await renderState(id),
      });
    }
    expect(answers[0]!.render).toEqual({
      voiceNoteId: "<id>",
      state: "dispatched",
      scriptChars: SCRIPT.length,
      billed: null,
      audioSha256: null,
      audioBytesLen: null,
      createdAt: "<at>",
    });
    for (const answer of answers.slice(1)) {
      expect(answer).toEqual(answers[0]);
    }
    expect(tts.calls).toBe(states.length);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("[R20 HF-4а] the same render naming the fan apart is the new form, and its pair is checked", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // A capture that holds the fan's id as another fan's chat: the released
    // render above is admitted beside it; with `fanRef` it is refused.
    await thread(FAN, OTHER_FAN);
    const take = await served(await script({ capabilities: null, body: releasedScriptBody() }));
    const named = await render({ ...releasedRenderBody(take.generationRef), fanRef: FAN });
    expect(named.statusCode, named.body).toBe(409);
    expect(named.json().error).toBe("conversation_fan_mismatch");
    expect(await count("voice_notes")).toBe(0);
    expect(tts.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[R20 HF-4а] erasing the fan removes the voice note of the group", () => {
  function eraser() {
    return {
      db: testDb!.db,
      pool: testDb!.pool,
      config: { lakeDir } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never;
  }

  it("deletes the render of a group the hub never linked to the fan; another fan's render stays", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The fan's take in a group the hub holds no thread of and no live message
    // in: only the script's record says whose it is.
    const take = await served(await script({ body: newScriptBody(NEW_GROUP, FAN) }));
    expect(take.context).toMatchObject({ pair: "unverified" });
    const id = await rendered(await render({
      clientRequestId: randomUUID(),
      conversationRef: NEW_GROUP,
      fanRef: FAN,
      sourceGenerationRef: take.generationRef,
      script: SCRIPT,
    }));
    // A bystander: another fan's take in a group the hub knows.
    await thread(GROUP, OTHER_FAN);
    const other = await served(await script({ body: newScriptBody(GROUP, OTHER_FAN) }));
    const otherId = await rendered(await render({
      clientRequestId: randomUUID(),
      conversationRef: GROUP,
      fanRef: OTHER_FAN,
      sourceGenerationRef: other.generationRef,
      script: SCRIPT,
    }));

    const result = await executeErasure(eraser(), { scopeType: "fan", platform: "fansly", fanRef: FAN }, { initiatedBy: userId });
    expect(result.plan.targets.find((target) => target.plane === "hot" && target.target === "voice_notes"))
      .toMatchObject({ action: "delete", rows: 1 });
    expect(result.executedCounts["hot:voice_notes:delete"]).toBe(1);
    expect(await count("voice_notes where id = $1", [id])).toBe(0);
    expect(await count("ai_generation_content where generation_ref = $1", [take.generationRef])).toBe(0);
    expect(await count("voice_notes where id = $1 and audio_bytes is not null", [otherId])).toBe(1);
    expect(await count("ai_generation_content where generation_ref = $1", [other.generationRef])).toBe(1);

    // Nothing of the erased take renders again.
    const again = await render({
      clientRequestId: randomUUID(),
      conversationRef: NEW_GROUP,
      fanRef: FAN,
      sourceGenerationRef: take.generationRef,
      script: SCRIPT,
    });
    expect(again.statusCode, again.body).toBe(400);
    expect(again.json().error).toBe("voice_source_invalid");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an erasure of the fan fences a render of the fan's group: no row, no budget, no synthesis", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const take = await served(await script({ body: newScriptBody(NEW_GROUP, FAN) }));
    // A fan erasure that started after the script and resolved no group of the fan.
    await insertErasureLog(app.db, {
      scopeType: "fan",
      scopeRef: `fan:fansly:${FAN}`,
      initiatedBy: userId,
      dryRun: false,
      plan: { resolvedPageIds: [pageIds["voice-fs"]], resolvedFanGroupIds: [] },
    });
    const response = await render({
      clientRequestId: randomUUID(),
      conversationRef: NEW_GROUP,
      fanRef: FAN,
      sourceGenerationRef: take.generationRef,
      script: SCRIPT,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      error: "voice_source_invalid",
      message: "The source voice-script generation is covered by an erasure",
    });
    expect(await count("voice_notes")).toBe(0);
    expect(await spentChars()).toBe(0);
    expect(tts.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
