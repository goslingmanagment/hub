import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aiFeatureStreamFrameSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  insertErasureLog,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertVoiceProfile,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider } from "../apps/runtime/src/services/ai-gateway.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
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

async function spentChars(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ total: string }>(
    `select coalesce(sum(spent_chars), 0)::text as total from voice_char_budget`,
  );
  return Number(rows[0]!.total);
}

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
