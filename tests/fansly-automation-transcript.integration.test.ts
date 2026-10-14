import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireFanslyWsOwnership,
  applyFanslyWsLiveReceipt,
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  createOnlyFansPage,
  insertObservation,
  seedBundledAiPersona,
  storeProxyConfig,
  upsertFans,
  writeThreadChain,
  type ThreadChainState,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  computePingSummary,
  createBundledPersonalities,
  loadFanslyAutomationInput,
  loadTranscriptContext,
} from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { resetCanonicalizeSweepRuntime, runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { readFanslyPageGeneration, readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { runFanslyCatalogProjection } from "../apps/runtime/src/services/projections/fansly-catalog.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { resetIntegrationDatabase, seedFanslyPage, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  AUTOMATION_DEFINITIONS,
  AUTOMATION_FAN as FAN,
  AUTOMATION_GROUP as GROUP,
  AUTOMATION_NOW as NOW,
  AUTOMATION_PAGE_REF as PAGE_REF,
  AUTOMATION_REST_MESSAGES,
  AUTOMATION_SOCKET_MESSAGES,
  HUB_TYPE_TWO_LINE,
  RELEASED_HI_AUTOMATED_IDS,
  RELEASED_HI_LINES,
  RELEASED_HI_PERSONAL_COUNT,
  RELEASED_PING,
  automationAt,
  automationMessageId as msg,
} from "./helpers/fansly-chat-automation.ts";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension Project Unite R20, HF-7д: the last of the context-parity
// series, for a Fansly request whose transcript the hub loads itself (no
// `clientContext`), through the hub's real writers and readers:
//
//   REST dm_messages observation → sync-pull material head (type,
//   correlationId, HF-7д0) → archive projection → message_archive
//   socket frame → live decoder → dm_live_messages
//   /message/automated observation → catalog → page_automated_messages
//   → the AI route → the prompt the provider receives, the stored record
//
// - [AI-033] Hi marks the model's welcome and mass messages
//   `[Automatic / mass message]` as the released Fansly extension 2.10.1
//   does, from both stores; an unobserved marker is not automation; a fan's
//   message is personal. Nothing else is marked.
// - [AI-037] Ping's segment and the fan's silence, which the hub computes
//   itself, are 2.10.1's on the same chat: the model's automatic messages
//   never count.
// - [AI-148] `transcriptCoverage` of Coach, the Recap and the notes fill comes
//   from the hub's chain (HF-8д) and the window it served.
//
// Predicate of the new behaviour: a Fansly page and a request without
// `clientContext`. The released extension's requests (with it) and OnlyFans
// keep their bytes; the references of 2.10.1 are in
// helpers/fansly-chat-automation.ts.

const FS = "auto-fs";
const OF = "auto-of";
const OF_FAN = "518588958";
const PROOF_LANE = "context-v1, coverage-check-v1, hi-start-proof-v1";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let token = "";
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput; calls: number } = { calls: 0 };
const owners: NonNullable<Awaited<ReturnType<typeof acquireFanslyWsOwnership>>>[] = [];

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.calls += 1;
      provider.input = input;
      yield { type: "content_delta", text: "hey you" };
      yield {
        type: "usage",
        providerResponseId: "msg_automation",
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
  resetCanonicalizeSweepRuntime();
  app = createTestAppContext(testDb, { databaseUrl: testDb.connectionString });
  app.config.chatMuseAiGatewayEnabled = true;
  app.config.fanslyLiveOverlayReadPages = FS;
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
  const { model, page } = await seedFanslyPage(testDb.db, app.config.encryptionKey, 1, FS);
  if (!model || !page) throw new Error("test setup: seed failed");
  pageIds[FS] = page.id;
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [page.id, PAGE_REF]);
  const ofPage = await createOnlyFansPage(app.db, { modelId: model.id, label: OF });
  if (!ofPage) throw new Error("test setup: OnlyFans page creation failed");
  pageIds[OF] = ofPage.id;
  await storeProxyConfig(app.db, ofPage.id, {
    url: "socks5://proxy.example:1080",
    encryptedAuth: null,
    keyVersion: null,
    rateLimitScopeKey: "shared-ai-proxy",
  });
  await upsertFans(app.db, [{ platform: "fansly", platformUserId: FAN }]);
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, true)`,
    [page.id, GROUP, FAN],
  );
  await createUserAccount(app, { username: "auto-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "auto-chatter", pageLabel: FS }, { source: "cli" })).key;
  await assignPageToUser(app, { userId: await fixtureUserId(app, "auto-chatter"), pageLabel: OF }, { source: "cli" });
  server = await buildApiServer(app);
  await server.ready();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const owner of owners.splice(0)) await owner.close();
});

let observations = 0;

/** One REST DM page through the real canonicalizer and archive projection. */
async function restPage(messages: ReadonlyArray<Record<string, unknown>>) {
  const payload = { messages };
  await insertObservation(app.db, {
    source: "pull", producer: "sync:fansly:dm_messages", platform: "fansly",
    accountId: pageIds[FS]!, kind: "dm_messages", payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `automation-${++observations}`, receivedAt: new Date(),
  });
  await runCanonicalization(app, { kinds: ["dm_messages"], accountId: pageIds[FS]! });
  await runMessageArchiveProjection(app, { accountId: pageIds[FS]! });
}

/** The page's `/message/automated` response through the catalog. */
async function automations(rows: unknown = AUTOMATION_DEFINITIONS) {
  await insertObservation(app.db, {
    source: "pull", producer: "sync:fansly:catalog", platform: "fansly",
    accountId: pageIds[FS]!, kind: "automated_messages", payload: rows,
    payloadHash: createHash("sha256").update(JSON.stringify(rows)).digest(),
    idempotencyKey: `automated-${++observations}`, receivedAt: new Date(),
  });
  await runCanonicalization(app, { kinds: ["automated_messages"], accountId: pageIds[FS]! });
  await runFanslyCatalogProjection(app, { accountId: pageIds[FS]! });
}

/** Socket frames through the real capture, live decoder and overlay apply. */
async function socketFrames(...messages: Record<string, unknown>[]) {
  const pageId = pageIds[FS]!;
  const generation = await readProbeGeneration(app.db, FS);
  const owner = await acquireFanslyWsOwnership(testDb!.connectionString, pageId, () => {});
  if (!owner) throw new Error("owner unavailable");
  owners.push(owner);
  const connectionId = randomUUID();
  await beginFanslyWsConnection(owner.db, { id: connectionId, pageId, generation });
  const frame = wrapped(10001, messages.map((message) => serviceFrame({ type: 1, message })));
  const observationId = await captureFanslyWsFrame(owner.db, {
    connectionId, pageId, generation, accountRef: PAGE_REF, ordinal: 1, frame, receivedAt: new Date(),
    validate: async (tx) => {
      if (await readFanslyPageGeneration(tx, FS) !== generation) throw new Error("generation_fenced");
    },
  });
  expect(await applyFanslyWsLiveReceipt(app.db, { observationId }))
    .toMatchObject({ status: "applied", created: messages.length });
}

/** A Fansly message archived before HF-7д0, as the pre-journal seeds hold it:
 *  no marker observed. */
async function archivedWithoutMarkers(n: number, createdAt: number, text: string) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, sender_role, is_sent_by_me, occurred_at, text_plain)
     values ($1, 'fansly', $2, $3, null, 'model', true, $4, $5)`,
    [pageIds[FS], GROUP, msg(n), new Date(createdAt * 1000), text],
  );
}

/** One AI request without `clientContext`: refs only, the hub loads the context. */
async function ask(input: {
  feature: string;
  page?: string;
  platform?: string;
  capabilities?: string;
  body?: Record<string, unknown>;
}): Promise<InjectResponse> {
  delete provider.input;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature}`,
    headers: {
      authorization: `Bearer ${token}`,
      // An empty list is the released extension: it advertises nothing.
      ...(input.capabilities === "" ? {} : { "x-kernel-ai-capabilities": input.capabilities ?? "context-v1" }),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? FS,
      platform: input.platform ?? "fansly",
      conversationRef: GROUP,
      fanRef: FAN,
      ...input.body,
    },
  });
}

/** The same request at AUTOMATION_NOW, the clock of the references. */
async function askAtNow(input: Parameters<typeof ask>[0]): Promise<InjectResponse> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  try {
    return await ask(input);
  } finally {
    vi.useRealTimers();
  }
}

function served(res: InjectResponse): void {
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).toContain("\"type\":\"done\"");
}

/** The user side of the prompt the provider was given. */
function userText(): string {
  return provider.input!.body.prompt.userBlocks.map((block) => block.text).join("\n");
}

/** The transcript lines of the prompt (the text between its `<transcript>` tags). */
function transcriptLines(): string[] {
  const match = /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(userText());
  if (!match) throw new Error("no transcript in the prompt");
  return match[1]!.split("\n");
}

/** What the tests read of a stored generation record's params. */
interface StoredParams {
  summaryMode?: string;
  transcriptCoverage?: string | null;
  keptCount?: number;
  contextManifest?: Record<string, unknown>;
}

/** The params of the newest stored generation record of a feature. */
async function storedParams(feature: string): Promise<StoredParams> {
  const { rows } = await testDb!.pool.query<{ params: StoredParams }>(
    "select params from ai_generation_content where feature = $1 order by id desc limit 1",
    [feature],
  );
  return rows[0]!.params;
}

/** Its context manifest (every request the hub loads the transcript of has one). */
async function storedManifest(feature: string): Promise<Record<string, unknown>> {
  const manifest = (await storedParams(feature)).contextManifest;
  if (!manifest) throw new Error(`no context manifest in the stored ${feature}`);
  return manifest;
}

/** Hi of the new client: its proof of the chat's start (a tab's short page). */
function hiBody(personalCount: number, automatedIds: string[], coveredCount: number) {
  return {
    startProof: {
      v: 1, source: "tab-short-page", groupId: GROUP, startWitnessId: msg(1), coveredCount, personalCount, automatedIds,
    },
    personalMessageCount: personalCount,
  };
}

/** The released 2.10.1 Hi lines with the one line the hub reads differently. */
const HUB_HI_LINES = RELEASED_HI_LINES.map((line) => (
  line === "[20:00] Model: [Automatic / mass message] [System message]" ? HUB_TYPE_TWO_LINE : line
));

describe("[AI-033] Hi on Fansly marks welcome and mass messages as 2.10.1 does (chat-extension R20 HF-7д)", () => {
  it("archive and socket messages, the page's welcome texts: the released extension's transcript", async () => {
    await automations();
    await restPage(AUTOMATION_REST_MESSAGES);
    await socketFrames(...AUTOMATION_SOCKET_MESSAGES);

    served(await askAtNow({
      feature: "hi-greeting",
      capabilities: PROOF_LANE,
      body: hiBody(RELEASED_HI_PERSONAL_COUNT, RELEASED_HI_AUTOMATED_IDS, 12),
    }));
    expect(transcriptLines()).toEqual(HUB_HI_LINES);
    // The template's explanation rides with the marks.
    expect(userText()).toContain("Model messages marked [Automatic / mass message] are welcome or mass messages");

    const manifest = await storedManifest("hi-greeting");
    expect(manifest).toMatchObject({ source: "live_union", liveCount: 2 });
    expect(manifest["fanslyAutomation"]).toEqual({
      marked: 5, typeTwo: 1, nonReplyCorrelation: 3, welcomeText: 1, modelMarkersUnknown: 0, overlayMarkers: 0,
      welcomeTexts: 2,
    });
    // As many marks as the client's proof names automatic messages.
    expect(manifest["hiStartProof"]).toMatchObject({ personalCount: 7, automatedCount: 5 });
    expect(transcriptLines().filter((line) => line.includes("[Automatic / mass message]")))
      .toHaveLength(RELEASED_HI_AUTOMATED_IDS.length);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("only Hi is marked: Reply, Ping and the Recap read the chat as before, and the released extension's Hi is kept as sent", async () => {
    await automations();
    await restPage(AUTOMATION_REST_MESSAGES);

    for (const feature of ["fast-reply", "ping"]) {
      served(await askAtNow({ feature }));
      expect(userText(), feature).not.toContain("[Automatic / mass message]");
      expect(await storedManifest(feature), feature).not.toHaveProperty("fanslyAutomation");
    }

    // The released Fansly extension sends its own transcript, labelled by
    // itself; the hub neither reads the stores for it nor marks it again.
    const sent = "[10:00] Model: thanks for subscribing\n[10:05] Fan: hi";
    served(await ask({
      feature: "hi-greeting",
      capabilities: "",
      body: {
        conversationRef: FAN,
        fanRef: FAN,
        clientContext: {
          transcript: sent, messageCount: 2, personalMessageCount: 1, fanDisplayName: "Fan",
          fanSpendingData: "", fanSubscriptionData: "",
        },
      },
    }));
    expect(transcriptLines()).toEqual(sent.split("\n"));
    expect(await storedParams("hi-greeting")).not.toHaveProperty("contextManifest.fanslyAutomation");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rows archived before the markers: a welcome text or the socket's markers still mark them, an unknown marker does not", async () => {
    await automations();
    await archivedWithoutMarkers(1, automationAt(3, 10, 0), "hey babe, welcome to my page 💕\nso glad you're here");
    await archivedWithoutMarkers(2, automationAt(2, 10, 0), "flash sale 50% off today only");
    await restPage([{ ...AUTOMATION_REST_MESSAGES[1]!, id: msg(3), createdAt: automationAt(1, 9, 0) }]);
    // A mass send archived before the markers that the socket saw with its
    // correlation (prod 2026-10-13: 88 of the 102 mass sends the socket saw).
    await archivedWithoutMarkers(4, automationAt(1, 12, 0), "new pics tonight");
    await socketFrames({
      id: msg(4), groupId: GROUP, senderId: PAGE_REF, content: "new pics tonight", createdAt: automationAt(1, 12, 0),
      attachments: [], type: 1, correlationId: "500000000000000007",
    });

    // The client read every marker from its page: three automatic, one personal.
    served(await askAtNow({ feature: "hi-greeting", capabilities: PROOF_LANE, body: hiBody(1, [1, 2, 4].map(msg), 4) }));
    expect(transcriptLines()).toEqual([
      "[10:00] Model: [Automatic / mass message] hey babe, welcome to my page 💕",
      "so glad you're here",
      // 2.10.1 reads this one's correlation from its own page; the hub never
      // observed it, and an unknown marker is not automation.
      "[10:00] Model: flash sale 50% off today only",
      "[09:00] Fan: hi! thanks 😊",
      "[12:00] Model: [Automatic / mass message] new pics tonight",
    ]);
    expect((await storedManifest("hi-greeting"))["fanslyAutomation"]).toEqual({
      marked: 2, typeTwo: 0, nonReplyCorrelation: 1, welcomeText: 1, modelMarkersUnknown: 2, overlayMarkers: 1,
      welcomeTexts: 2,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a failed read of the welcome texts never fails Hi: the markers alone decide, and the manifest says so", async () => {
    await automations();
    await restPage(AUTOMATION_REST_MESSAGES);
    await testDb!.pool.query("alter table page_automated_messages rename column message_text to message_text_moved");
    try {
      served(await askAtNow({ feature: "hi-greeting", capabilities: PROOF_LANE, body: hiBody(6, [1, 4, 8, 9].map(msg), 10) }));
    } finally {
      await testDb!.pool.query("alter table page_automated_messages rename column message_text_moved to message_text");
    }
    // The welcome sent without a correlation is no longer marked.
    expect(transcriptLines()).toContain("[10:00] Model: thanks  for subscribing");
    expect((await storedManifest("hi-greeting"))["fanslyAutomation"]).toEqual({
      marked: 3, typeTwo: 1, nonReplyCorrelation: 2, welcomeText: 0, modelMarkersUnknown: 0, overlayMarkers: 0,
      welcomeTexts: null,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("OnlyFans Hi reads no Fansly automation and marks nothing", async () => {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id,
         sender_role, is_sent_by_me, occurred_at, text_plain)
       values ($1, 'onlyfans', $2, '3998001000001', null, 'model', true, now() - interval '1 hour', 'thanks for subscribing')`,
      [pageIds[OF], OF_FAN],
    );
    served(await ask({ feature: "hi-greeting", page: OF, platform: "onlyfans", body: { conversationRef: OF_FAN, fanRef: OF_FAN } }));
    expect(transcriptLines().join("\n")).not.toContain("[Automatic / mass message]");
    expect(await storedManifest("hi-greeting")).not.toHaveProperty("fanslyAutomation");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("[AI-037] Ping's segment and silence on Fansly are 2.10.1's on the same chat (chat-extension R20 HF-7д)", () => {
  it("the hub's own history gives the released segment and days of silence; automation never counts", async () => {
    await automations();
    await restPage(AUTOMATION_REST_MESSAGES);

    const nowMs = Date.parse(NOW);
    const plain = await loadTranscriptContext(app, { pageId: pageIds[FS]!, conversationRef: GROUP, limit: 100 });
    expect(computePingSummary(plain.messages, nowMs)).toEqual(RELEASED_PING);
    // With the marks applied (as Hi reads the chat), the same: the segment
    // and the silence read only the fan's text messages.
    const marked = await loadTranscriptContext(app, {
      pageId: pageIds[FS]!, conversationRef: GROUP, limit: 100,
      fanslyAutomation: await loadFanslyAutomationInput(app, { pageId: pageIds[FS]! }),
    });
    expect(marked.transcript).toContain("[Automatic / mass message]");
    expect(computePingSummary(marked.messages, nowMs)).toEqual(RELEASED_PING);

    // The route: not blocked as active (two automatic sends came after the
    // fan's last message), and the prompt's silence is the released one.
    served(await askAtNow({ feature: "ping" }));
    expect(userText()).toContain(`Fan silence: the fan's last message was ${RELEASED_PING.fanSilenceDays} days ago.`);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

// ── [AI-148] coverage ────────────────────────────────────────────────────────

const FULL_NOTE = "(the transcript below covers the ENTIRE conversation history)";
const WINDOW_NOTE = "(the transcript below is the most recent window only, the history is longer)";

/** A chat of `count` messages, fan and model in turn, one minute apart. */
function longChat(count: number, text: (n: number) => string = (n) => `message ${n}`) {
  return Array.from({ length: count }, (_, k) => {
    const n = k + 1;
    return {
      id: msg(n), groupId: GROUP, senderId: n % 2 === 1 ? FAN : PAGE_REF, content: text(n),
      createdAt: automationAt(2, 10, 0) + n * 60, attachments: [], inReplyTo: null, inReplyToRoot: null,
      type: 1, correlationId: "0", totalTipAmount: 0,
    };
  });
}

/** The thread's chain, as the Sync Engine writes it (HF-8д). */
async function chain(state: "partial" | "complete", count: number) {
  const { rows: [thread] } = await testDb!.pool.query<{ id: string }>(
    "select id::text as id from page_dm_threads where platform_account_id = $1 and platform_conversation_id = $2",
    [pageIds[FS], GROUP],
  );
  const partial: ThreadChainState = {
    epoch: 1, state: "partial", headId: msg(count), headAt: new Date(), oldestId: msg(1),
    oldestCreatedAtMs: automationAt(2, 10, 1) * 1000, count, upwardCount: 0, proof: null, proofWitness: null,
    provenAt: null,
  };
  await writeThreadChain(app.db, Number(thread!.id), {
    chain: state === "partial"
      ? partial
      : {
        ...partial, state: "complete", proof: "empty_page",
        proofWitness: { kind: "observation", observationId: 1, receivedAt: new Date() }, provenAt: new Date(),
      },
    source: "engine",
  });
}

const coachBody = { chatterQuestion: "What should I send next?" };

describe("[AI-148] transcriptCoverage of a Fansly Recap, Coach and notes fill comes from the hub's chain (chat-extension R20 HF-7д)", () => {
  it("full history on a proven chain whose start the window reaches; a window when the hub holds older messages", async () => {
    await restPage(longChat(32));
    await chain("complete", 32);

    // The full Recap: the stored record carries the coverage the recap
    // readers show; its template has no note.
    served(await ask({ feature: "fan-summary", body: { messageCount: 1500 } }));
    expect(userText()).not.toContain(FULL_NOTE);
    let params = await storedParams("fan-summary");
    expect(params).toMatchObject({ summaryMode: "full", transcriptCoverage: "full-history", keptCount: 32 });
    expect(params.contextManifest?.["transcriptCoverage"]).toEqual({ value: "full-history", chain: "complete", reachesOldest: true });

    // The short Recap and Coach say it in the prompt.
    served(await ask({ feature: "fan-summary", body: { summaryMode: "short" } }));
    expect(userText()).toContain(FULL_NOTE);
    expect(await storedParams("fan-summary")).toMatchObject({ summaryMode: "short", transcriptCoverage: "full-history" });
    served(await ask({ feature: "coach-chat", body: coachBody }));
    expect(userText()).toContain(FULL_NOTE);
    served(await ask({ feature: "fan-notes-fill", body: { noteFields: ["Name"] } }));
    expect(userText()).toContain(FULL_NOTE);

    // A window of 30 of the 32: the history is longer, whatever the chain.
    served(await ask({ feature: "fan-summary", body: { messageCount: 30 } }));
    params = await storedParams("fan-summary");
    expect(params).toMatchObject({ transcriptCoverage: "window", keptCount: 30 });
    expect(params.contextManifest?.["transcriptCoverage"]).toEqual({ value: "window", chain: "complete", reachesOldest: false });
    served(await ask({ feature: "coach-chat", body: { ...coachBody, messageCount: 10 } }));
    expect(userText()).toContain(WINDOW_NOTE);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("unknown without a proven chain: no note and no stored coverage, as before", async () => {
    await restPage(longChat(32));
    await chain("partial", 32);

    served(await ask({ feature: "fan-summary", body: { summaryMode: "short" } }));
    expect(userText()).not.toContain(FULL_NOTE);
    expect(userText()).not.toContain(WINDOW_NOTE);
    const params = await storedParams("fan-summary");
    expect(params.transcriptCoverage).toBeNull();
    expect(params.contextManifest?.["transcriptCoverage"]).toEqual({ value: null, chain: "unknown", reachesOldest: true });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("Coach's budget cut the transcript: the note says window", async () => {
    // 40 messages of 9 000 characters: more than Coach's prompt budget.
    await restPage(longChat(40, (n) => `${n} `.padEnd(9_000, "x")));
    await chain("complete", 40);

    served(await ask({ feature: "coach-chat", body: coachBody }));
    expect(userText()).toContain(WINDOW_NOTE);
    expect(userText()).not.toContain(FULL_NOTE);
    expect((await storedManifest("coach-chat"))["transcriptCoverage"]).toEqual({
      value: "window", chain: "complete", reachesOldest: true, promptBudgetCut: true,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the released extension's coverage and OnlyFans are what they were", async () => {
    await restPage(longChat(32));
    await chain("complete", 32);

    // 2.10.1 sends its own coverage with its own transcript.
    served(await ask({
      feature: "fan-summary",
      capabilities: "",
      body: {
        conversationRef: FAN,
        summaryMode: "short",
        clientContext: {
          transcript: "[10:00] Fan: hi", messageCount: 35, fanDisplayName: "Fan", fanSpendingData: "",
          fanSubscriptionData: "", transcriptCoverage: "window",
        },
      },
    }));
    expect(userText()).toContain(WINDOW_NOTE);
    const released = await storedParams("fan-summary");
    expect(released.transcriptCoverage).toBe("window");
    expect(released.contextManifest ?? {}).not.toHaveProperty("transcriptCoverage");

    // OnlyFans: no chain read, no coverage on the hub's lane.
    served(await ask({
      feature: "coach-chat", page: OF, platform: "onlyfans",
      body: { ...coachBody, conversationRef: OF_FAN, fanRef: OF_FAN },
    }));
    expect(userText()).not.toContain(FULL_NOTE);
    expect(userText()).not.toContain(WINDOW_NOTE);
    expect(await storedManifest("coach-chat")).not.toHaveProperty("transcriptCoverage");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
