import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { aiFeatureStreamFrameSchema, type AiStartProofV1 } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  explainAiConversationOldestMessageQuery,
  findAiConversationOldestMessageRef,
  seedBundledAiPersona,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider, AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { buildAnthropicGatewayStreamRequest } from "../apps/runtime/src/services/ai-gateway-anthropic.ts";
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

// chat-extension Project Unite R20, HF-5: Hi on Fansly by the client's proof of
// the conversation's start, through the real route and the real stores. A
// caller that advertised `hi-start-proof-v1` and sends no `clientContext` is
// admitted to Hi on a Fansly page by its `startProof` (the start checked
// against the history the hub holds, at most 10 personal messages) and by
// nothing else; its fan's avatar rides at the top level. Nobody else sees any
// change: the predicate of the new behaviour is the capability, on the hub's
// own transcript. The rules themselves are the shared matrix
// (tests/fixtures/ai-hi-start-proof-matrix.json, tests/ai-hi-start-proof.test.ts).

// Fansly ids are 18-digit snowflakes past 2^53: exact strings everywhere (HF-8а).
const GROUP = "650000000000000001";
const OTHER_GROUP = "650000000000000002";
const FAN = "700000000000000001";
const OF_FAN = "518588958";
const AVATAR = "https://cdn3.fansly.com/avatar-700000000000000001.jpg";
/** What the new client advertises on Fansly. */
const LANE = "context-v1, coverage-check-v1, hi-start-proof-v1";
/** The same client before this change. */
const BEFORE = "context-v1, coverage-check-v1";

/** A message id of the seeded chats: 18 digits, ordered by `n`. */
const msg = (n: number) => String(800_000_000_000_000_000n + BigInt(n));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Frame = Record<string, unknown>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let token = "";
const pageIds: Record<string, number> = {};
const provider: { input?: AiGatewayProviderInput; calls: number } = { calls: 0 };

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream(input) {
      provider.calls += 1;
      provider.input = input;
      yield { type: "content_delta", text: "hey you" };
      yield {
        type: "usage",
        providerResponseId: "msg_hi_start_proof",
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
  const model = await createModel(app.db, { slug: "hi-proof", name: "Hi Proof" });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  for (const [label, create] of [
    ["hi-fs", createFanslyPage],
    ["hi-fs2", createFanslyPage],
    ["hi-of", createOnlyFansPage],
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
  await createUserAccount(app, { username: "hi-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "hi-chatter", pageLabel: "hi-fs" }, { source: "cli" })).key;
  const userId = await fixtureUserId(app, "hi-chatter");
  for (const pageLabel of ["hi-fs2", "hi-of"]) {
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
async function thread(group = GROUP, fan = FAN, page = "hi-fs") {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, true)`,
    [pageIds[page], group, fan],
  );
}

/** One archived message; a higher `ageMin` is older. */
async function archived(input: {
  ref: string;
  fromFan: boolean;
  ageMin: number;
  page?: string;
  platform?: string;
  conv?: string;
  deleted?: boolean;
  pending?: boolean;
}) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending)
     values ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval, $8, $9, $10)`,
    [
      pageIds[input.page ?? "hi-fs"],
      input.platform ?? "fansly",
      input.conv ?? GROUP,
      input.ref,
      input.fromFan ? FAN : null,
      !input.fromFan,
      String(input.ageMin),
      `text of ${input.ref}`,
      input.deleted ? new Date() : null,
      input.pending ?? false,
    ],
  );
}

/**
 * The chat of GROUP on hi-fs as the hub's archive holds it: messages
 * `from`…`to`, the fan's where `fan` names them, the model's otherwise.
 */
async function seedChat(from: number, to: number, fan: readonly number[] = []) {
  for (const n of range(from, to)) {
    await archived({ ref: msg(n), fromFan: fan.includes(n), ageMin: (to - n + 1) * 2 });
  }
}

/** A row of the page's socket overlay; `stub`: a deletion frame without a create. */
async function socket(input: { ref: string; ageMin?: number; deleted?: boolean; stub?: boolean }) {
  const stub = input.stub ?? false;
  await testDb!.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
       is_sent_by_page, created_at, content, decoder_version, first_visible_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
    [
      pageIds["hi-fs"], input.ref, GROUP,
      stub ? null : FAN, stub ? null : false,
      stub ? null : new Date(Date.now() - (input.ageMin ?? 1) * 60_000), stub ? null : `socket ${input.ref}`,
      stub ? null : new Date(),
      input.deleted ? new Date() : null,
    ],
  );
}

function tabProof(overrides: Partial<AiStartProofV1> = {}): AiStartProofV1 {
  return {
    v: 1, source: "tab-short-page", groupId: GROUP, startWitnessId: msg(1), coveredCount: 2, personalCount: 0, automatedIds: [],
    ...overrides,
  };
}

/** The window of a request: the ids the client's tab holds, with their sides. */
const windowOf = (ids: readonly number[], fan: readonly number[] = []) => ({
  window: ids.map((n) => ({ id: msg(n), dir: fan.includes(n) ? "fan" : "model" })),
  deletedIds: [] as string[],
});

async function ask(input: {
  feature?: string;
  page?: string;
  platform?: string;
  capabilities?: string | null;
  body?: Record<string, unknown>;
}): Promise<InjectResponse> {
  delete provider.input;
  const capabilities = input.capabilities === undefined ? LANE : input.capabilities;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature ?? "hi-greeting"}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(capabilities !== null ? { "x-kernel-ai-capabilities": capabilities } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? "hi-fs",
      platform: input.platform ?? "fansly",
      // What the new client names on Fansly, unless the request names its
      // own: the group and the fan apart.
      ...(input.body?.["conversationRef"] === undefined ? { conversationRef: GROUP, fanRef: FAN } : {}),
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

/** The stream with what differs per request by design (ids, the quota left) masked. */
function comparable(raw: string) {
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/"(remainingRequestsToday|remainingMicroUsdToday)":\d+/g, '"$1":<n>');
}

/** A served request: its frames, context frame, prompt, images, recorded manifest and stream. */
async function served(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  const all = frames(response.body);
  expect(all.at(-1)?.type).toBe("done");
  const meta = all.find((frame) => frame.type === "meta");
  const context = all.find((frame) => frame.type === "context_v1");
  const { generationRef: _ref, ...contextBody } = context ?? {};
  const { rows } = await testDb!.pool.query<{ params: { contextManifest?: Record<string, unknown> } }>(
    `select params from ai_generation_content where generation_ref = $1`,
    [meta!["requestId"]],
  );
  const prompt = provider.input!.body.prompt;
  return {
    types: all.map((frame) => frame.type),
    context: context === undefined ? undefined : contextBody,
    /** The text the model reads, without the image. */
    text: JSON.stringify({ systemBlocks: prompt.systemBlocks, userBlocks: prompt.userBlocks }),
    images: prompt.images,
    providerBody: provider.input!.body,
    manifest: rows[0]?.params.contextManifest,
    raw: comparable(response.body),
  };
}

/** A refused request: its envelope; nothing reached the provider. */
function refused(response: InjectResponse, status = 400) {
  expect(response.statusCode, response.body).toBe(status);
  expect(provider.input).toBeUndefined();
  return JSON.parse(response.body) as Record<string, unknown>;
}

const UNPROVEN = {
  error: "gate_hi_greeting_limit",
  message: "hi-greeting is only available for conversations whose start is proven",
  statusCode: 400,
  reason: "history_unproven",
};
const TOO_MANY = {
  error: "gate_hi_greeting_limit",
  message: "hi-greeting is only available for conversations with at most 10 personal messages",
  statusCode: 400,
  reason: "too_many_personal",
};
/** The refusals of every other lane, as they were: no `reason`. */
const LEGACY_TOO_MANY_MESSAGES = {
  error: "gate_hi_greeting_limit",
  message: "hi-greeting is only available for conversations with at most 10 messages",
  statusCode: 400,
};
const LEGACY_TOO_MANY_PERSONAL = {
  error: "gate_hi_greeting_limit",
  message: "hi-greeting is only available for conversations with at most 10 personal messages",
  statusCode: 400,
};

async function generationRows() {
  const { rows } = await testDb!.pool.query<{ content: string; usage: string }>(
    `select (select count(*) from ai_generation_content)::text as content,
            (select count(*) from ai_usage_events)::text as usage`,
  );
  return { content: Number(rows[0]!.content), usage: Number(rows[0]!.usage) };
}

describe("Hi on Fansly by the start proof (the new client's path)", () => {
  it("admits a proven start with automation only, where the count of messages refuses everyone else", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Twelve of the model's automatic messages, no personal one.
    await thread();
    await seedChat(1, 12);
    trap = await armNoOutboundTrap(testDb);

    // Before this change, and for a caller that does not advertise the proof:
    // twelve messages are more than ten.
    for (const capabilities of [null, BEFORE]) {
      expect(refused(await ask({ capabilities }))).toEqual(LEGACY_TOO_MANY_MESSAGES);
    }

    const proof = tabProof({ coveredCount: 12, personalCount: 0, automatedIds: range(1, 12).map(msg) });
    const answer = await served(await ask({
      body: { startProof: proof, personalMessageCount: 0, coverageCheck: windowOf(range(1, 12)) },
    }));
    expect(answer.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(answer.context).toMatchObject({
      source: "archive",
      pair: "verified",
      servedHead: { messageRef: msg(12), isFromFan: false },
      window: { requested: 25, served: 12 },
    });
    // The window's ids are answered as for any feature (HF-8в).
    expect((answer.context!.coverageCheck as { window: Array<{ state: string }> }).window.map((item) => item.state))
      .toEqual(Array.from({ length: 12 }, () => "included"));
    // The model reads the hub's transcript; the proof adds no text and no image.
    expect(answer.text).toContain(`text of ${msg(1)}`);
    expect(answer.text).toContain(`text of ${msg(12)}`);
    expect(answer.images).toBeUndefined();
    // Counts only in the record, never an id.
    expect(answer.manifest).toMatchObject({
      conversationPair: "verified",
      hiStartProof: { source: "tab-short-page", coveredCount: 12, personalCount: 0, automatedCount: 12 },
    });
    expect(JSON.stringify(answer.manifest!["hiStartProof"])).not.toContain(msg(1));
    await trap.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers the three scenarios of a 41-message chat (chat-extension architecture §5.8)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // The hub's archive holds the newest 25 of the chat's 41 messages, as its
    // pull-cadenced history usually does; six of the 41 are personal.
    const personal = [3, 10, 20, 30, 40, 41];
    const automated = range(1, 41).filter((n) => !personal.includes(n));
    await thread();
    await seedChat(17, 41, personal);

    // (а) The first open: the tab holds the fresh end of 25 and no proof.
    const before = await generationRows();
    expect(refused(await ask({ body: { coverageCheck: windowOf(range(17, 41), personal) } }))).toEqual(UNPROVEN);
    expect(provider.calls).toBe(0);
    expect(await generationRows()).toEqual(before);

    // (б) A short fresh end, then continuous observation up to 41 messages.
    const tab = await served(await ask({
      body: {
        startProof: tabProof({ coveredCount: 41, personalCount: 6, automatedIds: automated.map(msg) }),
        coverageCheck: windowOf(range(1, 41), personal),
      },
    }));
    expect(tab.context).toMatchObject({ window: { requested: 25, served: 25 }, servedHead: { messageRef: msg(41) } });
    expect(tab.manifest).toMatchObject({ hiStartProof: { source: "tab-short-page", coveredCount: 41, personalCount: 6, automatedCount: 35 } });

    // (в) The «Новые» pass walked the history to its start: four personal
    // messages among its last 30, one draft.
    const pass = await served(await ask({
      body: {
        variantCount: 1,
        startProof: tabProof({ source: "pass-empty-page", coveredCount: 41, personalCount: 4, automatedIds: automated.map(msg) }),
        coverageCheck: windowOf(range(1, 41), personal),
      },
    }));
    expect(pass.manifest).toMatchObject({ hiStartProof: { source: "pass-empty-page", coveredCount: 41, personalCount: 4 } });
    expect(pass.text).toContain("Write exactly ONE ready-to-send message");
    expect(tab.text).toContain("Write exactly 3 different greeting variants");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses without a proof whatever the hub holds, and a count alone proves nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Two messages: every other lane admits Hi here, on the hub's own count.
    await thread();
    await seedChat(1, 2, [2]);
    await served(await ask({ capabilities: null }));
    await served(await ask({ capabilities: BEFORE }));

    const before = await generationRows();
    for (const body of [{}, { personalMessageCount: 0 }, { personalMessageCount: 2, coverageCheck: windowOf([1, 2], [2]) }]) {
      expect(refused(await ask({ body })), JSON.stringify(body)).toEqual(UNPROVEN);
    }
    // Nothing was generated and nothing recorded.
    expect(provider.calls).toBe(2);
    expect(await generationRows()).toEqual(before);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("admits 10 personal messages and refuses 11", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    await seedChat(1, 12, [2, 4, 6, 8, 10, 12]);

    const ten = tabProof({ coveredCount: 12, personalCount: 10, automatedIds: [msg(1), msg(3)] });
    const admitted = await served(await ask({ body: { startProof: ten, personalMessageCount: 10 } }));
    expect(admitted.manifest).toMatchObject({ hiStartProof: { personalCount: 10 } });

    const before = await generationRows();
    const eleven = tabProof({ coveredCount: 12, personalCount: 11, automatedIds: [msg(1)] });
    expect(refused(await ask({ body: { startProof: eleven } }))).toEqual(TOO_MANY);
    expect(refused(await ask({ body: { startProof: eleven, personalMessageCount: 11 } }))).toEqual(TOO_MANY);
    expect(await generationRows()).toEqual(before);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts a pass among its last 30: 11 personal messages at the start of a long history are admitted, as by the released extension", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Eleven personal messages a long time ago (msg 1…11), then 34 automatic ones.
    const automated = range(12, 45);
    await thread();
    await seedChat(1, 45, [1, 3, 5, 7, 9, 11]);

    // The pass: none of its last 30 messages is personal.
    const pass = await served(await ask({
      body: {
        variantCount: 1,
        startProof: tabProof({ source: "pass-empty-page", coveredCount: 45, personalCount: 0, automatedIds: automated.map(msg) }),
        coverageCheck: windowOf(range(1, 45), [1, 3, 5, 7, 9, 11]),
      },
    }));
    expect(pass.manifest).toMatchObject({ hiStartProof: { source: "pass-empty-page", coveredCount: 45, personalCount: 0, automatedCount: 34 } });

    // The released Fansly extension's New Followers window decides the same
    // chat the same way: it counts the last 30 messages it read.
    await served(await ask({
      capabilities: null,
      body: {
        conversationRef: FAN, fanRef: FAN, variantCount: 1, isRegeneration: false,
        clientContext: {
          transcript: "Model: [Automatic / mass message] hi", messageCount: 30, fanDisplayName: "charles",
          fanUsername: "charles", personalMessageCount: 0, fanSpendingData: "", fanSubscriptionData: "",
        },
      },
    }));

    // A tab that saw the same history from its start counts all of it.
    expect(refused(await ask({
      body: { startProof: tabProof({ coveredCount: 45, personalCount: 11, automatedIds: automated.map(msg) }) },
    }))).toEqual(TOO_MANY);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("admits an empty chat by a proof of an empty history, until the hub holds a message of it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    const empty = tabProof({ startWitnessId: null, coveredCount: 0, personalCount: 0, automatedIds: [] });
    for (const source of ["tab-short-page", "pass-empty-page"] as const) {
      const answer = await served(await ask({
        body: { startProof: { ...empty, source }, personalMessageCount: 0, coverageCheck: { window: [], deletedIds: [] } },
      }));
      expect(answer.context).toMatchObject({ servedHead: null, window: { served: 0 }, coverageCheck: { window: [], deleted: [] } });
      expect(answer.manifest).toMatchObject({ hiStartProof: { source, coveredCount: 0, personalCount: 0, automatedCount: 0 } });
    }
    // A chat the hub has not captured at all is the same case.
    const uncaptured = await served(await ask({ body: { conversationRef: OTHER_GROUP, fanRef: FAN, startProof: { ...empty, groupId: OTHER_GROUP } } }));
    expect(uncaptured.manifest).toMatchObject({ conversationPair: "unverified", hiStartProof: { coveredCount: 0 } });

    // The hub now holds a message of the chat: the history is not empty.
    await archived({ ref: msg(1), fromFan: false, ageMin: 1 });
    expect(refused(await ask({ body: { startProof: empty } }))).toEqual(UNPROVEN);
    // Nor is it when the request's own window names a message.
    expect(refused(await ask({
      body: { conversationRef: OTHER_GROUP, fanRef: FAN, startProof: { ...empty, groupId: OTHER_GROUP }, coverageCheck: windowOf([7]) },
    }))).toEqual(UNPROVEN);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the start against the history the hub holds", () => {
  it("refuses a proof whose first message is not the hub's first; a deleted message, another chat's or another page's never contradicts it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    await seedChat(5, 8, [6]);
    const proof = tabProof({ startWitnessId: msg(5), coveredCount: 4, personalCount: 1, automatedIds: [msg(5), msg(7), msg(8)] });
    await served(await ask({ body: { startProof: proof } }));

    // Messages older than the proof's first one that are not this chat's
    // current history: one the hub knows as deleted, a tombstone-first stub,
    // another chat of the page, and the same group id on another page.
    await archived({ ref: msg(1), fromFan: true, ageMin: 500, deleted: true });
    await archived({ ref: msg(2), fromFan: true, ageMin: 499, deleted: true, pending: true });
    await archived({ ref: msg(3), fromFan: true, ageMin: 498, conv: OTHER_GROUP });
    await archived({ ref: msg(4), fromFan: true, ageMin: 497, page: "hi-fs2" });
    const admitted = await served(await ask({ body: { startProof: proof, coverageCheck: windowOf(range(5, 8), [6]) } }));
    expect(admitted.manifest).toMatchObject({ hiStartProof: { coveredCount: 4, personalCount: 1 } });

    // The request's own window names an older message.
    expect(refused(await ask({ body: { startProof: proof, coverageCheck: windowOf(range(4, 8), [6]) } }))).toEqual(UNPROVEN);

    // The hub holds an older message of this very chat, live.
    await testDb.pool.query("update message_archive set deleted_at = null where message_ref = $1", [msg(1)]);
    const before = await generationRows();
    expect(refused(await ask({ body: { startProof: proof } }))).toEqual(UNPROVEN);
    expect(await generationRows()).toEqual(before);
    // A contradicted start outranks the count.
    expect(refused(await ask({
      body: { startProof: { ...proof, coveredCount: 12, personalCount: 11, automatedIds: [] } },
    }))).toEqual(UNPROVEN);
    // The hub deletes it again: the proof stands again.
    await testDb.pool.query("update message_archive set deleted_at = now() where message_ref = $1", [msg(1)]);
    await served(await ask({ body: { startProof: proof } }));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads the archive's oldest message, not only the 25 the transcript served", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    await seedChat(1, 40);
    // The transcript serves msg 16…40; the proof names msg 16 as the first.
    const proof = tabProof({ startWitnessId: msg(16), coveredCount: 25, personalCount: 0, automatedIds: range(16, 40).map(msg) });
    expect(refused(await ask({ body: { startProof: proof, coverageCheck: windowOf(range(16, 40)) } }))).toEqual(UNPROVEN);
    // With the real first message it is admitted over the same 40.
    const whole = tabProof({ coveredCount: 40, personalCount: 0, automatedIds: range(1, 40).map(msg) });
    const answer = await served(await ask({ body: { startProof: whole, coverageCheck: windowOf(range(1, 40)) } }));
    expect(answer.context).toMatchObject({ window: { requested: 25, served: 25 } });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("with the socket overlay: a socket deletion hides the archive's copy, and a socket message counts as history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    await seedChat(4, 7, [6]);
    const proof = tabProof({ startWitnessId: msg(5), coveredCount: 3, personalCount: 1, automatedIds: [msg(5), msg(7)] });
    // The archive holds msg 4 live: the proof is contradicted.
    expect(refused(await ask({ body: { startProof: proof } }))).toEqual(UNPROVEN);

    // The page's socket saw msg 4 deleted. A page that reads the overlay hides
    // it as its transcript does; a page that does not is judged by the archive.
    await socket({ ref: msg(4), deleted: true, stub: true });
    expect(refused(await ask({ body: { startProof: proof } }))).toEqual(UNPROVEN);
    app.config.fanslyLiveOverlayReadPages = "all";
    const admitted = await served(await ask({ body: { startProof: proof } }));
    expect(admitted.context).toMatchObject({ source: "live_union", window: { served: 3 } });
    expect(admitted.text).not.toContain(`text of ${msg(4)}`);

    // A message only the socket holds so far, older than the proof's first one.
    await socket({ ref: msg(3), ageMin: 30 });
    const contradicted = refused(await ask({ body: { startProof: proof } }));
    expect(contradicted).toEqual(UNPROVEN);
    // One the proof covers changes nothing.
    await testDb.pool.query("delete from dm_live_messages where platform_message_id = $1", [msg(3)]);
    await socket({ ref: msg(8), ageMin: 0 });
    const withSocket = await served(await ask({ body: { startProof: { ...proof, coveredCount: 4, personalCount: 2 } } }));
    expect(withSocket.context).toMatchObject({ source: "live_union", servedHead: { messageRef: msg(8) }, window: { served: 4 } });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("orders ids as snowflakes and reads one conversation's range of the archive", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const pageId = pageIds["hi-fs"]!;
    const oldest = (liveOverlay = false) => findAiConversationOldestMessageRef(testDb!.db, { pageId, conversationRef: GROUP, liveOverlay });
    expect(await oldest()).toBeNull();
    // A 19-digit id is newer than any 18-digit one, a 17-digit id older,
    // whatever the times say and whatever the text order is.
    await archived({ ref: "1000000000000000105", fromFan: true, ageMin: 900 });
    await archived({ ref: msg(50), fromFan: true, ageMin: 5 });
    expect(await oldest()).toBe(msg(50));
    await archived({ ref: "99999999999999999", fromFan: true, ageMin: 1 });
    expect(await oldest()).toBe("99999999999999999");
    // Not this conversation's live history.
    await archived({ ref: "11111111111111111", fromFan: true, ageMin: 1, deleted: true });
    await archived({ ref: "22222222222222222", fromFan: true, ageMin: 1, conv: OTHER_GROUP });
    await archived({ ref: "33333333333333333", fromFan: true, ageMin: 1, page: "hi-fs2" });
    await archived({ ref: "44444444444444444", fromFan: true, ageMin: 1, pending: true });
    expect(await oldest()).toBe("99999999999999999");
    // A socket deletion hides the archive's copy only for a reader of the overlay.
    await socket({ ref: "99999999999999999", deleted: true, stub: true });
    expect(await oldest()).toBe("99999999999999999");
    expect(await oldest(true)).toBe(msg(50));

    // One long conversation and a spread that dominates the table: without it
    // the planner rightly prefers a sequential scan and the plan proves nothing.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select $1, 'fansly', case when g <= 3000 then $2 else '66' || lpad((g % 400)::text, 16, '0') end,
              (810000000000000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread ' || g, 'seed'
       from generate_series(1, 40000) g`,
      [pageId, GROUP],
    );
    await testDb.pool.query("analyze message_archive, dm_live_messages");
    for (const liveOverlay of [false, true]) {
      const plan = await explainAiConversationOldestMessageQuery(testDb.db, { pageId, conversationRef: GROUP, liveOverlay });
      expect(plan, plan).toContain("message_archive_account_conv_idx");
      expect(plan, plan).not.toMatch(/Seq Scan on message_archive\b/);
      // The overlay is named only for a reader of it.
      expect(plan.includes("dm_live_messages"), plan).toBe(liveOverlay);
    }
    expect(await oldest(true)).toBe(msg(50));
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the fan's avatar at the top level", () => {
  it("reaches the model as an image without clientContext, as the released extension's does", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    await seedChat(1, 2, [2]);
    const proof = tabProof({ coveredCount: 2, personalCount: 1, automatedIds: [msg(1)] });

    const withAvatar = await served(await ask({ body: { startProof: proof, fanAvatarUrl: AVATAR } }));
    expect(withAvatar.images).toEqual([{ url: AVATAR }]);
    // What the provider is sent: the image, after the text.
    const sent = buildAnthropicGatewayStreamRequest(withAvatar.providerBody).messages[0].content;
    expect(sent.at(-1)).toEqual({ type: "image", source: { type: "url", url: AVATAR } });
    // The hub passes the address on and never opens it (the provider is a stub
    // here; a fetch of the URL would be the only outbound request).
    trap = await armNoOutboundTrap(testDb);
    await served(await ask({ body: { startProof: proof, fanAvatarUrl: AVATAR } }));
    await trap.assertNoOutbound();
    await trap.restore();
    trap = null;

    // Without it: the same text, no image.
    const plain = await served(await ask({ body: { startProof: proof } }));
    expect(plain.images).toBeUndefined();
    expect(plain.text).toBe(withAvatar.text);
    expect(buildAnthropicGatewayStreamRequest(plain.providerBody).messages[0].content.some((block) => block.type === "image")).toBe(false);

    // The released Fansly extension (2.10.1) sends the same address inside
    // clientContext, and the provider gets the same image.
    const released = await served(await ask({
      capabilities: null,
      body: {
        conversationRef: FAN, fanRef: FAN, variantCount: 1, isRegeneration: false,
        clientContext: {
          transcript: "Model: hi", messageCount: 1, fanDisplayName: "charles", fanUsername: "charles",
          fanAvatarUrl: AVATAR, personalMessageCount: 0, fanSpendingData: "", fanSubscriptionData: "",
        },
      },
    }));
    expect(released.images).toEqual(withAvatar.images);
    expect(buildAnthropicGatewayStreamRequest(released.providerBody).messages[0].content.at(-1)).toEqual(sent.at(-1));
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the predicate: a caller that advertises hi-start-proof-v1, on the hub's own transcript", () => {
  it("refuses the fields from anyone else and anywhere else, with a machine reason", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread();
    await seedChat(1, 2, [2]);
    const proof = tabProof({ coveredCount: 2, personalCount: 1, automatedIds: [msg(1)] });
    const before = await generationRows();
    const reasonOf = async (input: Parameters<typeof ask>[0]) => {
      const envelope = refused(await ask(input));
      expect(envelope).toMatchObject({ error: "bad_request", statusCode: 400 });
      return envelope["reason"];
    };

    // Not advertised: a strict body refused these fields before, and still does.
    for (const capabilities of [null, BEFORE, "debug-input-v1, split-all-v1"]) {
      for (const body of [{ startProof: proof }, { personalMessageCount: 1 }, { fanAvatarUrl: AVATAR }]) {
        expect(await reasonOf({ capabilities, body }), `${capabilities} ${Object.keys(body)}`).toBe("capability_required");
      }
    }
    // Another feature.
    for (const feature of ["fast-reply", "improve-draft", "ping", "coach-chat"]) {
      const extra = { draftText: "hey", chatterQuestion: "what next?" };
      const allowed = feature === "improve-draft" ? { draftText: extra.draftText } : feature === "coach-chat" ? { chatterQuestion: extra.chatterQuestion } : {};
      expect(await reasonOf({ feature, body: { ...allowed, startProof: proof } }), feature).toBe("start_proof_not_allowed");
      expect(await reasonOf({ feature, body: { ...allowed, fanAvatarUrl: AVATAR } }), feature).toBe("start_proof_not_allowed");
    }
    // Beside clientContext: that lane carries its own count and avatar.
    const clientContext = { transcript: "Fan: hi", messageCount: 1, fanDisplayName: "charles", fanSpendingData: "", fanSubscriptionData: "" };
    for (const body of [{ startProof: { ...proof, groupId: FAN } }, { personalMessageCount: 1 }, { fanAvatarUrl: AVATAR }]) {
      expect(await reasonOf({ body: { conversationRef: FAN, fanRef: FAN, clientContext, ...body } })).toBe("start_proof_not_allowed");
    }
    // A proof of another chat, and a count that is not the proof's.
    expect(await reasonOf({ body: { startProof: { ...proof, groupId: OTHER_GROUP } } })).toBe("start_proof_mismatch");
    expect(await reasonOf({ body: { startProof: proof, personalMessageCount: 2 } })).toBe("start_proof_mismatch");
    // A body the schema refuses, whoever sends it.
    for (const capabilities of [null, LANE]) {
      for (const startProof of [{ ...proof, personalCount: 3 }, { ...proof, startWitnessId: null }, { ...proof, extra: 1 }, { ...proof, v: 2 }]) {
        const response = await ask({ capabilities, body: { startProof } });
        expect(response.statusCode, response.body).toBe(400);
        expect(JSON.parse(response.body)).toMatchObject({ error: "Bad Request" });
      }
      expect((await ask({ capabilities, body: { fanAvatarUrl: "https://cdn3.fansly.com.evil.test/x" } })).statusCode).toBe(400);
    }
    expect(provider.calls).toBe(0);
    expect(await generationRows()).toEqual(before);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("changes Hi on Fansly only: every other feature streams byte for byte what it did, and an admitted Hi prompts as before", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // Thirty messages, the newest a week old: enough for the deep features,
    // and a fan silent long enough for Ping.
    await thread();
    const week = 7 * 24 * 60;
    for (const n of range(1, 30)) {
      await archived({ ref: msg(n), fromFan: n % 2 === 1, ageMin: week + (30 - n) * 2 });
    }
    for (const request of [
      { feature: "fast-reply", body: { replyTone: "casual" } },
      { feature: "improve-draft", body: { draftText: "hey you" } },
      { feature: "ping", body: {} },
      { feature: "fan-summary", body: {} },
      { feature: "chat-review", body: {} },
      { feature: "coach-chat", body: { chatterQuestion: "what next?" } },
    ]) {
      // Each starts without a recap of an earlier one for Coach to attach.
      await testDb.pool.query("delete from ai_generation_content");
      const was = await served(await ask({ feature: request.feature, capabilities: BEFORE, body: request.body }));
      await testDb.pool.query("delete from ai_generation_content");
      const now = await served(await ask({ feature: request.feature, capabilities: LANE, body: request.body }));
      expect(now.raw, request.feature).toBe(was.raw);
      expect(now.text, request.feature).toBe(was.text);
      expect(now.manifest, request.feature).toEqual(was.manifest);
      expect(now.manifest ?? {}, request.feature).not.toHaveProperty("hiStartProof");
    }

    // Hi itself: an admitted proof adds nothing to the prompt or the frame.
    await testDb.pool.query("delete from message_archive");
    await seedChat(1, 2, [2]);
    const legacy = await served(await ask({ capabilities: BEFORE }));
    const proven = await served(await ask({
      body: { startProof: tabProof({ coveredCount: 2, personalCount: 1, automatedIds: [msg(1)] }) },
    }));
    expect(proven.text).toBe(legacy.text);
    expect(proven.raw).toBe(legacy.raw);
    expect(proven.context).toEqual(legacy.context);
    const { hiStartProof, ...rest } = proven.manifest!;
    expect(hiStartProof).toEqual({ source: "tab-short-page", coveredCount: 2, personalCount: 1, automatedCount: 1 });
    expect(rest).toEqual(legacy.manifest);
    // The lane does not need the frame's capabilities.
    const bare = await served(await ask({
      capabilities: "hi-start-proof-v1",
      body: { startProof: tabProof({ coveredCount: 2, personalCount: 1, automatedIds: [msg(1)] }) },
    }));
    expect(bare.types).toEqual(["meta", "content_delta", "usage", "done"]);
    expect(bare.text).toBe(legacy.text);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the released Fansly extension (fansly-chat 2.10.1, clientContext) is answered as before", () => {
  // Its real forms (fansly-chat ff30d00: src/background/operations.ts
  // buildConversationRefs and the Hi request, followers-service.ts,
  // kernel-feature-gateway.ts, shared/greeting-context.ts). It counts the
  // personal messages itself and sends its own transcript, name and avatar; it
  // advertises no capability. Its gate reads its own count, never the hub's
  // history.
  const clientContext = {
    transcript: "[10:00] Model: [Automatic / mass message] welcome\n[10:01] Fan: CLIENT_LINE_TWO",
    messageCount: 14,
    fanDisplayName: "Charles",
    fanSpendingData: "",
    fanSubscriptionData: "",
  };
  const greeting = { fanUsername: "charles77", fanCustomName: "Charlie", fanBio: "Runs marathons", fanAvatarUrl: AVATAR };
  const forms: Array<{ name: string; feature: string; body: Record<string, unknown>; gate?: Record<string, unknown> }> = [
    {
      // The chat's Hi button: the fan's id as the conversation, three variants.
      name: "chat Hi (fan as conversationRef), 2 personal of 14",
      feature: "hi-greeting",
      body: {
        conversationRef: FAN, replyMode: "default", isRegeneration: false, variantCount: 3, messageCount: 25,
        clientContext: { ...clientContext, ...greeting, personalMessageCount: 2 },
      },
    },
    {
      name: "chat Hi, the group as conversationRef (fan not resolved), 10 personal of 40",
      feature: "hi-greeting",
      body: {
        conversationRef: GROUP, isRegeneration: true, variantCount: 3, messageCount: 25,
        clientContext: { ...clientContext, messageCount: 40, personalMessageCount: 10 },
      },
    },
    {
      // The New Followers window: fan/fan, one draft.
      name: "New Followers Hi (fan/fan), no personal message",
      feature: "hi-greeting",
      body: {
        conversationRef: FAN, fanRef: FAN, variantCount: 1, isRegeneration: false,
        clientContext: { ...clientContext, messageCount: 2, ...greeting, personalMessageCount: 0 },
      },
    },
    {
      // Extension <= 2.4.3: the deprecated alias skips the gate.
      name: "the deprecated new-follower alias, 500 messages",
      feature: "hi-greeting",
      body: { conversationRef: FAN, fanRef: FAN, greetingMode: "new-follower", clientContext: { ...clientContext, messageCount: 500 } },
    },
    {
      name: "chat Hi, 11 personal messages",
      feature: "hi-greeting",
      body: { conversationRef: FAN, variantCount: 3, clientContext: { ...clientContext, personalMessageCount: 11 } },
      gate: LEGACY_TOO_MANY_PERSONAL,
    },
    {
      name: "Hi without a personal count (extension <= 2.4.3), 11 messages",
      feature: "hi-greeting",
      body: { conversationRef: FAN, clientContext: { ...clientContext, messageCount: 11 } },
      gate: LEGACY_TOO_MANY_MESSAGES,
    },
    {
      name: "fan fast-reply",
      feature: "fast-reply",
      body: { conversationRef: FAN, replyTone: "flirty", replyMode: "default", isRegeneration: false, clientContext: { ...clientContext, messageCount: 35 } },
    },
    {
      name: "group/fan coach-chat",
      feature: "coach-chat",
      body: { conversationRef: GROUP, fanRef: FAN, chatterQuestion: "what next?", isRegeneration: false, clientContext: { ...clientContext, messageCount: 35 } },
    },
  ];

  it("gates, prompts and streams every form the same, whatever the header says and whatever the hub holds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const states = [
      { name: "the hub holds nothing of the chat", seed: async () => undefined },
      {
        name: "the hub holds 45 messages of it",
        seed: async () => {
          await thread();
          await seedChat(1, 45, range(1, 20));
        },
      },
    ];
    const answers = new Map<string, unknown[]>();
    for (const state of states) {
      await state.seed();
      for (const form of forms) {
        for (const capabilities of [null, "hi-start-proof-v1", LANE]) {
          // Each starts without a recap of an earlier one for Coach to attach.
          await testDb.pool.query("delete from ai_generation_content");
          const response = await ask({ feature: form.feature, capabilities, body: form.body });
          const label = `${form.name}; ${state.name}; ${capabilities}`;
          const list = answers.get(form.name) ?? [];
          if (form.gate !== undefined) {
            // The envelope as it was: its code, its words, no `reason`.
            expect(refused(response), label).toEqual(form.gate);
            list.push(form.gate);
          } else {
            const answer = await served(response);
            expect(answer.types, label).toEqual(["meta", "content_delta", "usage", "done"]);
            expect(answer.manifest ?? {}, label).not.toHaveProperty("hiStartProof");
            list.push({ raw: answer.raw, text: answer.text, images: answer.images });
          }
          answers.set(form.name, list);
        }
      }
    }
    for (const [name, list] of answers) {
      expect(list, name).toHaveLength(states.length * 3);
      for (const one of list) {
        expect(one, name).toEqual(list[0]);
      }
    }
    // What its Hi prompt carries is what it sent: its transcript, its name
    // lines and its avatar as the image.
    const hi = answers.get("chat Hi (fan as conversationRef), 2 personal of 14")![0] as { text: string; images: unknown };
    expect(hi.text).toContain("CLIENT_LINE_TWO");
    expect(hi.text).toContain("Display name: Charles");
    expect(hi.text).toContain("Username: charles77");
    expect(hi.images).toEqual([{ url: AVATAR }]);
    expect((answers.get("fan fast-reply")![0] as { images: unknown }).images).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("OnlyFans", () => {
  it("keeps its gate whatever the caller advertises, and takes none of the fields", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const of = { page: "hi-of", platform: "onlyfans" };
    for (const n of range(1, 10)) {
      await archived({ ref: String(9000 + n), fromFan: n % 2 === 1, ageMin: 100 - n, page: "hi-of", platform: "onlyfans", conv: OF_FAN });
    }
    // Ten messages: admitted on the count of messages, by the same prompt and
    // stream with the capability and without.
    const without = await served(await ask({ ...of, capabilities: null, body: { conversationRef: OF_FAN } }));
    const advertised = await served(await ask({ ...of, capabilities: "hi-start-proof-v1", body: { conversationRef: OF_FAN } }));
    expect(advertised.raw).toBe(without.raw);
    expect(advertised.text).toBe(without.text);
    expect(advertised.manifest).toEqual(without.manifest);
    // The ChatSpace extension's frame is what it was.
    const chatspace = await served(await ask({ ...of, capabilities: "context-v1", body: { conversationRef: OF_FAN } }));
    const withLane = await served(await ask({ ...of, capabilities: "context-v1, hi-start-proof-v1", body: { conversationRef: OF_FAN } }));
    expect(withLane.raw).toBe(chatspace.raw);
    expect(withLane.context).toEqual(chatspace.context);

    // Eleven: refused in the same words, without a reason.
    await archived({ ref: "9011", fromFan: true, ageMin: 1, page: "hi-of", platform: "onlyfans", conv: OF_FAN });
    for (const capabilities of [null, "context-v1", LANE]) {
      expect(refused(await ask({ ...of, capabilities, body: { conversationRef: OF_FAN } })), String(capabilities)).toEqual(LEGACY_TOO_MANY_MESSAGES);
    }
    // The fields are Fansly's.
    const proof = tabProof({ groupId: OF_FAN, startWitnessId: "9001", coveredCount: 11, personalCount: 0, automatedIds: [] });
    for (const body of [{ startProof: proof }, { personalMessageCount: 0 }, { fanAvatarUrl: AVATAR }]) {
      expect(refused(await ask({ ...of, body: { conversationRef: OF_FAN, ...body } }))).toMatchObject({
        error: "bad_request", reason: "start_proof_not_allowed",
      });
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
