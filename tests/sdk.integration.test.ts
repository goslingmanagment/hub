import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  findUserByUsername,
  insertAiGenerationContent,
  insertOfapiWebhookEvent,
  settleOfapiWebhookEvent,
  upsertVoiceProfile,
} from "@agency_hub_core/db";
import {
  KERNEL_CONTRACT_HASH as CONTRACTS_CONTRACT_HASH,
  KernelApiError,
  createKernelClient,
  fetchVoiceNoteAudio,
  routeSchemas,
  subscribeSyncEvents,
  type SyncSnapshotRequired,
} from "@agency_hub_core/contracts";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { VoiceTtsProvider } from "../apps/runtime/src/services/voice-elevenlabs-provider.ts";
import { buildSdkFiles } from "../packages/contracts/src/generate-sdk.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import { kernelOperations } from "../packages/sdk/src/operations.ts";
import { KERNEL_CONTRACT_HASH } from "../packages/sdk/src/meta.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Kernel Stage 20: the generated SDK against a REAL listening server — typed
// operations round-trip with runtime validation, both auth modes, the live
// error taxonomy, and the generator's determinism/hash properties.

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let baseUrl = "";
let chatterKey = "";
let lanaPageId = 0;
let voiceSourceRef = "";

const VOICE_AUDIO = Buffer.from("sdk-voice-note-mp3-bytes");

const voiceProvider: VoiceTtsProvider = {
  async synthesize() {
    return {
      ok: true,
      audio: VOICE_AUDIO,
      characterCost: 12,
      requestId: "sdk-prov-req",
      traceId: "sdk-prov-trace",
      region: "us-east-1",
    };
  },
};

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  const seedContext = createTestAppContext(testDb);

  await createUserAccount(seedContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(seedContext, {
    username: "anton",
    role: "chatter",
  }, { source: "cli" });
  const model = await createModel(testDb.db, { slug: "lana-model", name: "Lana Model" });
  const lana = await createFanslyPage(testDb.db, { modelId: model.id, label: "lana" });
  lanaPageId = lana.id;
  const issued = await issueChatterApiKey(seedContext, {
    username: "anton",
    pageLabel: "lana",
  }, { source: "cli" });
  chatterKey = issued.key;

  // Voice notes (Task 6): a completed source voice-script + a page profile so
  // the typed create/status roundtrip and the binary audio helper have a live
  // render to exercise. The server context carries voice on + a fake provider.
  await upsertVoiceProfile(testDb.db, {
    platformAccountId: lanaPageId,
    voiceId: "voice-abc",
    model: "eleven_v3",
    settings: { stability: 0.5 },
    outputFormat: "mp3_44100_128",
  });
  const anton = await findUserByUsername(testDb.db, "anton");
  voiceSourceRef = `gen-${randomUUID()}`;
  await insertAiGenerationContent(testDb.db, {
    usageEventId: null,
    generationRef: voiceSourceRef,
    feature: "voice-script",
    model: "anthropic:claude-sonnet-4-6",
    provider: "anthropic",
    userId: anton!.id,
    pageId: lanaPageId,
    conversationRef: "conv-sdk-voice",
    fanRef: null,
    promptBlocks: [],
    completion: "hello [warmly] world",
    params: { outcome: "completed" },
  });

  const serverContext: AppContext = createTestAppContext(testDb);
  serverContext.config.voiceNotesEnabled = true;
  serverContext.config.voiceNotesRetrievalEnabled = true;
  serverContext.config.voiceNotesPageAllowlist = "lana";
  serverContext.config.voiceNotesScriptMaxChars = 600;
  serverContext.config.voiceNotesDailyCharBudget = 100_000;
  serverContext.config.voiceNotesGlobalDailyCharBudget = 100_000;
  serverContext.voiceTtsProvider = voiceProvider;

  server = await buildApiServer(serverContext);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (typeof address === "object" && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function requireSetup(context: { skip: () => void }) {
  if (!server || !baseUrl) {
    context.skip();
    return null;
  }
  return true;
}

async function ownerCookie() {
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "dima", password: "owner-secret" }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("expected session cookie");
  }
  return cookie.split(";")[0]!;
}

describe("kernel SDK against a live server", () => {
  it("round-trips public, bearer, and cookie operations with typed results", async (context) => {
    if (!requireSetup(context)) return;

    const anonymous = createKernelClient(kernelOperations, { baseUrl });
    const health = await anonymous.health().catch((error: unknown) => {
      // 503 (degraded) is a declared, validated shape too — surface anything else.
      expect(error).toBeInstanceOf(KernelApiError);
      expect((error as KernelApiError).status).toBe(503);
      return null;
    });
    if (health) {
      expect(typeof health).toBe("object");
    }

    const bearer = createKernelClient(kernelOperations, {
      baseUrl,
      auth: { mode: "bearer", token: () => chatterKey },
    });
    const me = await bearer.me();
    expect(me.authMethod).toBe("api_key");
    expect(me.user.username).toBe("anton");

    const pages = await bearer.pages();
    expect(pages.map((page) => page.label)).toContain("lana");

    const subscribers = await bearer.pageSubscribers({
      params: { pageLabel: "lana" },
      query: {},
    });
    expect(subscribers.items).toEqual([]);

    const cookie = await ownerCookie();
    const owner = createKernelClient(kernelOperations, { baseUrl, headers: { cookie } });
    const users = await owner.adminListUsers();
    expect(users.map((user) => user.username).sort()).toEqual(["anton", "dima"]);

    const created = await owner.adminCreateModel({ body: { slug: "sdk-model", name: "SDK Model" } });
    expect(created.slug).toBe("sdk-model");
  });

  it("surfaces the live error taxonomy", async (context) => {
    if (!requireSetup(context)) return;

    const bearer = createKernelClient(kernelOperations, {
      baseUrl,
      auth: { mode: "bearer", token: () => chatterKey },
    });
    await expect(bearer.adminListUsers()).rejects.toMatchObject({
      category: "auth",
      status: 403,
    });
    await expect(
      bearer.pageSubscribers({ params: { pageLabel: "ghost" }, query: {} }),
    ).rejects.toMatchObject({ category: "not_found", status: 404 });

    const cookie = await ownerCookie();
    const owner = createKernelClient(kernelOperations, { baseUrl, headers: { cookie } });
    await expect(
      owner.raw("pageRevenue", { params: { pageLabel: "lana" }, query: { period: "bogus" } })
        .then((response) => response.status),
    ).resolves.toBe(400);
  });

  it("reaches excluded operations through raw()", async (context) => {
    if (!requireSetup(context)) return;

    const cookie = await ownerCookie();
    const owner = createKernelClient(kernelOperations, { baseUrl, headers: { cookie } });
    const response = await owner.raw("adminOfapiCreditsLedgerCsv", { query: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
  });

  it("round-trips voice-note create/status typed + fetches audio via the binary helper", async (context) => {
    if (!requireSetup(context)) return;

    const options = { baseUrl, auth: { mode: "bearer" as const, token: () => chatterKey } };
    const bearer = createKernelClient(kernelOperations, options);

    // Typed create → 202 view (voiceNoteId + createdAt REQUIRED in the schema).
    const created = await bearer.voiceNoteCreate({
      params: { pageLabel: "lana" },
      body: {
        clientRequestId: randomUUID(),
        conversationRef: "conv-sdk-voice",
        sourceGenerationRef: voiceSourceRef,
        script: "hello [warmly] world",
      },
    });
    expect(typeof created.voiceNoteId).toBe("number");
    expect(["queued", "dispatched"]).toContain(created.state);
    expect(typeof created.createdAt).toBe("string");

    // Typed status → poll to completed (the synthesis runs detached).
    let status = created;
    const deadline = Date.now() + 5000;
    while (status.state !== "completed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await bearer.voiceNoteStatus({
        params: { pageLabel: "lana", id: created.voiceNoteId },
      });
    }
    expect(status.state).toBe("completed");
    expect(status.audioBytesLen).toBe(VOICE_AUDIO.byteLength);

    // Binary helper → raw Response with audio/mpeg bytes (excluded from the
    // typed client; the CSV-raw test is its sibling precedent).
    const audio = await fetchVoiceNoteAudio(options, {
      pageLabel: "lana",
      id: created.voiceNoteId,
    });
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(audio.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await audio.arrayBuffer());
    expect(bytes).toEqual(VOICE_AUDIO);
  });

  it("manifest matches the booted server's route table exactly", async (context) => {
    if (!requireSetup(context)) return;

    const byKey = new Map(server!.routePolicyTable.map((row) => [row.routeKey, row]));
    expect(byKey.size).toBe(Object.keys(routeSchemas).length);
    for (const [key, def] of Object.entries(kernelOperations)) {
      const row = byKey.get(key);
      expect(row, key).toBeDefined();
      expect({ method: row!.method, path: row!.url }, key).toEqual(def);
    }
  });
});

describe("sync-events helper against the live stream", () => {
  it("replays journal frames after Last-Event-ID and validates each one", async (context) => {
    if (!requireSetup(context)) return;

    for (let i = 1; i <= 2; i++) {
      const created = await insertOfapiWebhookEvent(testDb!.db, {
        idempotencyKey: `sdk_sse_${i}`,
        eventType: "users.typing",
        ofapiAccountId: "acct-sdk",
        payload: { event: "users.typing" },
      });
      await settleOfapiWebhookEvent(testDb!.db, {
        id: created!.id,
        status: "processed",
        platformAccountId: lanaPageId,
        syncEvent: { type: "typing", accountId: "acct-sdk", chatId: String(i) },
        processedAt: new Date(),
      });
    }

    const frames: Array<{ id: number; event: { type: string } }> = [];
    let resolveGotTwo: () => void;
    const gotTwo = new Promise<void>((resolve) => { resolveGotTwo = resolve; });
    const handle = subscribeSyncEvents(
      { baseUrl, auth: { mode: "bearer", token: () => chatterKey } },
      {
        lastEventId: 0,
        onFrame: (frame) => {
          frames.push(frame);
          if (frames.length === 2) resolveGotTwo();
        },
      },
    );
    await gotTwo;
    handle.close();
    await handle.done;

    expect(frames).toHaveLength(2);
    expect(frames[0].event.type).toBe("typing");
    expect(frames[1].id).toBeGreaterThan(frames[0].id);
  });

  it("surfaces a cursor ahead of the journal as onSnapshotRequired", async (context) => {
    if (!requireSetup(context)) return;

    let snapshot: SyncSnapshotRequired | null = null;
    const handle = subscribeSyncEvents(
      { baseUrl, auth: { mode: "bearer", token: () => chatterKey } },
      {
        lastEventId: 999_999,
        onFrame: () => undefined,
        onSnapshotRequired: (details) => { snapshot = details; },
      },
    );
    await handle.done;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.error).toBe("sync_snapshot_required");
    expect(snapshot!.snapshotPath).toBe("/api/v1/events/snapshot");
  });
});

describe("SDK generator determinism", () => {
  it("two runs over the same inputs are byte-identical, and the hash keys off the OpenAPI document", (context) => {
    if (!requireSetup(context)) return;

    const openApiDocumentJson = readFileSync("reference/agency-hub.openapi.json", "utf8");
    const input = {
      routePolicyTable: server!.routePolicyTable,
      openApiDocumentJson,
      sdkVersion: "0.1.0",
    };
    const first = buildSdkFiles(input);
    const second = buildSdkFiles(input);
    expect([...first.keys()]).toEqual([...second.keys()]);
    for (const [file, content] of first) {
      expect(second.get(file), file).toBe(content);
    }

    // The committed meta hash equals sha256 of the committed OpenAPI document.
    const expectedHash = createHash("sha256").update(openApiDocumentJson, "utf8").digest("hex");
    expect(KERNEL_CONTRACT_HASH).toBe(expectedHash);
    expect(CONTRACTS_CONTRACT_HASH).toBe(expectedHash);
    expect(first.get("src/meta.ts")).toContain(expectedHash);

    // A schema-shape change (the drift drill renames a response field) MUST
    // change the hash even when no method/path moves.
    const mutated = buildSdkFiles({
      ...input,
      openApiDocumentJson: openApiDocumentJson.replace('"ok"', '"okRenamed"'),
    });
    expect(mutated.get("src/meta.ts")).not.toBe(first.get("src/meta.ts"));
  });
});
