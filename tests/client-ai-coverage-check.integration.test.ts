import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AI_COVERAGE_CHECK_DELETED_MAX,
  AI_COVERAGE_CHECK_WINDOW_MAX,
  aiFeatureStreamFrameSchema,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  seedBundledAiPersona,
  storeProxyConfig,
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

// chat-extension Project Unite R20, HF-8в: the window coverage check, through
// the real route and the real stores. The client names what its open tab holds
// of a chat (`coverageCheck.window`, both sides) and what it saw deleted there
// (`coverageCheck.deletedIds`); a caller that advertised `coverage-check-v1`
// (beside `context-v1`) gets one answer per id in the `context_v1` frame, from
// the transcript that served the generation. Nobody else sees any change: the
// predicate of the new behaviour is the capability. How the client reads the
// answers is the shared matrix (tests/fixtures/ai-coverage-check-matrix.json,
// tests/ai-coverage-check.test.ts).

// Fansly ids are 18-digit snowflakes past 2^53: the transcript and the answers
// keep them as exact strings (HF-8а).
const GROUP = "650000000000000001";
const OTHER_GROUP = "650000000000000002";
const FAN = "700000000000000001";
const OF_FAN = "518588958";
const BOTH = "context-v1, coverage-check-v1";

/** A message id of the seeded chats: 18 digits, ordered by `n`. */
const msg = (n: number) => String(800_000_000_000_000_000n + BigInt(n));

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
      yield { type: "content_delta", text: "sure thing" };
      yield {
        type: "usage",
        providerResponseId: "msg_coverage",
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
  const model = await createModel(app.db, { slug: "coverage", name: "Coverage" });
  if (!model) {
    throw new Error("test setup: model creation failed");
  }
  for (const [label, create] of [
    ["cov-fs", createFanslyPage],
    ["cov-fs2", createFanslyPage],
    ["cov-of", createOnlyFansPage],
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
  await createUserAccount(app, { username: "coverage-chatter", role: "chatter" }, { source: "cli" });
  token = (await issueChatterDeviceToken(app, { username: "coverage-chatter", pageLabel: "cov-fs" }, { source: "cli" })).key;
  const userId = await fixtureUserId(app, "coverage-chatter");
  for (const pageLabel of ["cov-fs2", "cov-of"]) {
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
async function thread(group: string, fan: string, page = "cov-fs") {
  await testDb!.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id, is_visible)
     values ($1, $2, $3, true)`,
    [pageIds[page], group, fan],
  );
}

/** One archived message; `ageMin` minutes old, so a higher `ageMin` is older. */
async function archived(input: {
  ref: string;
  fromFan: boolean;
  ageMin: number;
  page?: string;
  platform?: string;
  conv?: string;
  deleted?: boolean;
}) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain, deleted_at)
     values ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval, $8, $9)`,
    [
      pageIds[input.page ?? "cov-fs"],
      input.platform ?? "fansly",
      input.conv ?? GROUP,
      input.ref,
      input.fromFan ? FAN : null,
      !input.fromFan,
      String(input.ageMin),
      `text of ${input.ref}`,
      input.deleted ? new Date() : null,
    ],
  );
}

async function ask(input: {
  feature?: string;
  page?: string;
  platform?: string;
  capabilities?: string | null;
  body: Record<string, unknown>;
}): Promise<InjectResponse> {
  delete provider.input;
  const capabilities = input.capabilities === undefined ? BOTH : input.capabilities;
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature ?? "fast-reply"}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(capabilities !== null ? { "x-kernel-ai-capabilities": capabilities } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.page ?? "cov-fs",
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

/** A served request: its frame types, its context frame without the per-request ref, the prompt and the stream. */
async function served(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  const all = frames(response.body);
  expect(all.at(-1)?.type).toBe("done");
  const context = all.find((frame) => frame.type === "context_v1");
  const { generationRef: _ref, ...contextBody } = context ?? {};
  return {
    types: all.map((frame) => frame.type),
    context: context === undefined ? undefined : contextBody,
    prompt: JSON.stringify(provider.input!.body.prompt),
    raw: comparable(response.body),
  };
}

/** The stream with what differs per request by design (ids, the quota left) masked. */
function comparable(raw: string) {
  return raw
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/"(remainingRequestsToday|remainingMicroUsdToday)":\d+/g, '"$1":<n>');
}

/**
 * The chat of GROUP on cov-fs: seven live messages, the newest five of which a
 * `messageCount: 5` window serves (msg 3…7), and two the hub tombstoned. Plus
 * a message of another chat of the page and one of another page's chat of
 * the same group id.
 */
async function seedChat() {
  await thread(GROUP, FAN);
  for (const [n, fromFan] of [[1, true], [2, false], [3, true], [4, false], [5, true], [6, false], [7, true]] as const) {
    await archived({ ref: msg(n), fromFan, ageMin: 70 - n * 10 });
  }
  await archived({ ref: msg(21), fromFan: true, ageMin: 45, deleted: true });
  await archived({ ref: msg(22), fromFan: false, ageMin: 35, deleted: true });
  await archived({ ref: msg(31), fromFan: true, ageMin: 5, conv: OTHER_GROUP });
  await archived({ ref: msg(32), fromFan: true, ageMin: 5, page: "cov-fs2" });
}

describe("the window coverage check on Fansly (the new client's path)", () => {
  it("answers every id of both lists exactly once, in the client's order, from the served transcript", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedChat();
    trap = await armNoOutboundTrap(testDb);

    const coverageCheck = {
      window: [
        { id: msg(7), dir: "fan" },
        // The model's message, named as the fan's.
        { id: msg(6), dir: "fan" },
        { id: msg(5), dir: "fan" },
        { id: msg(4), dir: "model" },
        // Held for the chat, older than the five served.
        { id: msg(2), dir: "model" },
        // Tombstoned by the hub.
        { id: msg(21), dir: "fan" },
        // Another chat of the page, another page's chat, never seen.
        { id: msg(31), dir: "fan" },
        { id: msg(32), dir: "fan" },
        { id: msg(99), dir: "fan" },
      ],
      // Deleted on the tab: one the hub still served, one it tombstoned, one
      // it holds live but outside the window, one it never saw.
      deletedIds: [msg(3), msg(22), msg(1), msg(98)],
    };
    const answer = await served(await ask({
      body: { conversationRef: GROUP, fanRef: FAN, messageCount: 5, knownFanMessageIds: [msg(7), msg(1)], coverageCheck },
    }));
    expect(answer.types).toEqual(["meta", "context_v1", "content_delta", "usage", "done"]);
    expect(answer.context).toMatchObject({
      source: "live_union",
      pair: "verified",
      servedHead: { messageRef: msg(7), isFromFan: true },
      window: { requested: 5, served: 5 },
      knownFanMessages: [{ id: msg(7), state: "included" }, { id: msg(1), state: "absent" }],
    });
    expect(answer.context!.coverageCheck).toEqual({
      window: [
        { id: msg(7), state: "included" },
        { id: msg(6), state: "direction_mismatch" },
        { id: msg(5), state: "included" },
        { id: msg(4), state: "included" },
        { id: msg(2), state: "outside_window" },
        { id: msg(21), state: "deleted" },
        { id: msg(31), state: "absent" },
        { id: msg(32), state: "absent" },
        { id: msg(99), state: "absent" },
      ],
      deleted: [
        // The tab saw it deleted, the model read it: the discrepancy.
        { id: msg(3), state: "still_served" },
        { id: msg(22), state: "deleted" },
        { id: msg(1), state: "absent" },
        { id: msg(98), state: "absent" },
      ],
    });

    // Ids only: the prompt and the rest of the frame are those of the same
    // request without the check.
    const without = await served(await ask({
      body: { conversationRef: GROUP, fanRef: FAN, messageCount: 5, knownFanMessageIds: [msg(7), msg(1)] },
    }));
    expect(without.prompt).toBe(answer.prompt);
    const { coverageCheck: _answers, ...rest } = answer.context!;
    expect(without.context).toEqual(rest);
    await trap.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers full lists (60 window ids, 60 deleted ids, 10 known ids: 110 for the store lookup) one by one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread(GROUP, FAN);
    // 40 live messages, alternating sides from the fan's; ten tombstoned ones.
    for (let n = 1; n <= 40; n += 1) {
      await archived({ ref: msg(n), fromFan: n % 2 === 1, ageMin: 500 - n });
    }
    for (let n = 101; n <= 110; n += 1) {
      await archived({ ref: msg(n), fromFan: true, ageMin: 600, deleted: true });
    }
    // The newest 20 serve (msg 21…40), msg 1…20 are older; msg 201…220 nobody has seen.
    const window = [
      ...Array.from({ length: 40 }, (_, k) => ({ id: msg(40 - k), dir: (40 - k) % 2 === 1 ? "fan" : "model" })),
      ...Array.from({ length: 20 }, (_, k) => ({ id: msg(201 + k), dir: "fan" })),
    ];
    const deletedIds = [
      ...Array.from({ length: 10 }, (_, k) => msg(101 + k)),
      ...Array.from({ length: 50 }, (_, k) => msg(301 + k)),
    ];
    const knownFanMessageIds = Array.from({ length: 10 }, (_, k) => msg(401 + k));
    expect(window).toHaveLength(AI_COVERAGE_CHECK_WINDOW_MAX);
    expect(deletedIds).toHaveLength(AI_COVERAGE_CHECK_DELETED_MAX);

    const answer = await served(await ask({
      body: { conversationRef: GROUP, fanRef: FAN, messageCount: 20, knownFanMessageIds, coverageCheck: { window, deletedIds } },
    }));
    const check = answer.context!.coverageCheck as { window: Array<{ id: string; state: string }>; deleted: Array<{ id: string; state: string }> };
    expect(check.window.map((item) => item.id)).toEqual(window.map((item) => item.id));
    expect(check.deleted.map((item) => item.id)).toEqual(deletedIds);
    const count = (list: Array<{ state: string }>) => list.reduce<Record<string, number>>((all, item) => {
      all[item.state] = (all[item.state] ?? 0) + 1;
      return all;
    }, {});
    // The lookup held all 110 outside ids at once: nothing fell back to `unknown`.
    expect(count(check.window)).toEqual({ included: 20, outside_window: 20, absent: 20 });
    expect(count(check.deleted)).toEqual({ deleted: 10, absent: 50 });
    expect(answer.context!.knownFanMessages).toEqual(knownFanMessageIds.map((id) => ({ id, state: "absent" })));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers an empty chat with empty lists, and every feature of the kernel lane alike", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread(GROUP, FAN);
    const empty = await served(await ask({
      body: { conversationRef: GROUP, fanRef: FAN, coverageCheck: { window: [], deletedIds: [] } },
    }));
    expect(empty.context).toMatchObject({ servedHead: null, window: { served: 0 }, coverageCheck: { window: [], deleted: [] } });

    // The deep features want 30 messages at least.
    for (let n = 1; n <= 30; n += 1) {
      await archived({ ref: msg(n), fromFan: n % 2 === 1, ageMin: 100 - n });
    }
    for (const request of [
      { feature: "improve-draft", body: { draftText: "hey you" } },
      { feature: "fan-summary" },
      { feature: "chat-review" },
      { feature: "coach-chat", body: { chatterQuestion: "what next?" } },
    ]) {
      const answer = await served(await ask({
        feature: request.feature,
        body: {
          conversationRef: GROUP,
          fanRef: FAN,
          coverageCheck: { window: [{ id: msg(29), dir: "fan" }, { id: msg(30), dir: "model" }], deletedIds: [msg(99)] },
          ...request.body,
        },
      }));
      expect(answer.context?.coverageCheck, request.feature).toEqual({
        window: [{ id: msg(29), state: "included" }, { id: msg(30), state: "included" }],
        deleted: [{ id: msg(99), state: "absent" }],
      });
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the predicate: only a caller that advertises coverage-check-v1 gets the answers", () => {
  it("leaves every other stream byte for byte what it was, the field sent or not", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedChat();
    const body = { conversationRef: GROUP, fanRef: FAN, messageCount: 5 };
    const coverageCheck = { window: [{ id: msg(7), dir: "fan" }], deletedIds: [msg(3)] };

    for (const capabilities of [null, "context-v1", "coverage-check-v1", "debug-input-v1, split-all-v1"]) {
      const plain = await served(await ask({ capabilities, body }));
      const withField = await served(await ask({ capabilities, body: { ...body, coverageCheck } }));
      expect(withField.raw, String(capabilities)).toBe(plain.raw);
      expect(withField.prompt, String(capabilities)).toBe(plain.prompt);
      expect(withField.context ?? {}, String(capabilities)).not.toHaveProperty("coverageCheck");
    }
    // Without `context-v1` there is no frame to answer in, the token or not.
    expect((await served(await ask({ capabilities: "coverage-check-v1", body: { ...body, coverageCheck } }))).types)
      .toEqual(["meta", "content_delta", "usage", "done"]);

    // With both tokens the frame is the one `context-v1` gets, plus the answers.
    const before = await served(await ask({ capabilities: "context-v1", body }));
    const after = await served(await ask({ capabilities: BOTH, body: { ...body, coverageCheck } }));
    expect(after.context).toEqual({
      ...before.context,
      coverageCheck: { window: [{ id: msg(7), state: "included" }], deleted: [{ id: msg(3), state: "still_served" }] },
    });
    expect(after.prompt).toBe(before.prompt);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a body the schema refuses, whoever sends it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await thread(GROUP, FAN);
    for (const capabilities of [null, BOTH]) {
      for (const coverageCheck of [
        { window: [{ id: msg(1), dir: "fan" }], deletedIds: [msg(1)] },
        { window: Array.from({ length: 61 }, (_, k) => ({ id: msg(k + 1), dir: "fan" })), deletedIds: [] },
        { window: [] },
      ]) {
        const response = await ask({ capabilities, body: { conversationRef: GROUP, fanRef: FAN, coverageCheck } });
        expect(response.statusCode, response.body).toBe(400);
      }
    }
    expect(provider.calls).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("the released Fansly extension (fansly-chat 2.10.1, clientContext) is answered as before", () => {
  // Its real forms (fansly-chat ff30d00, src/background/operations.ts
  // buildConversationRefs, kernel-feature-gateway.ts): Reply as the fan's id
  // alone, Coach as group/fan, the new-follower Hi as fan/fan. It advertises
  // no capability and never sends the check. A request that carries its own
  // transcript has no context frame, so even a header and a check change
  // nothing.
  const clientContext = {
    transcript: "[10:00] Fan: CLIENT_LINE_ONE\n[10:01] Model: CLIENT_LINE_TWO",
    messageCount: 35,
    fanDisplayName: "charles",
    fanSpendingData: "Total: $42.00",
    fanSubscriptionData: "Subscribed: yes",
  };
  const forms = [
    { feature: "fast-reply", body: { conversationRef: FAN, replyTone: "flirty", replyMode: "default", isRegeneration: false, clientContext } },
    {
      feature: "coach-chat",
      body: { conversationRef: GROUP, fanRef: FAN, chatterQuestion: "what next?", isRegeneration: false, clientContext },
    },
    {
      feature: "hi-greeting",
      body: {
        conversationRef: FAN,
        fanRef: FAN,
        variantCount: 1,
        isRegeneration: false,
        clientContext: { ...clientContext, messageCount: 2, fanUsername: "charles", personalMessageCount: 0, fanSpendingData: "", fanSubscriptionData: "" },
      },
    },
  ];

  it("streams and prompts every form the same, with or without the header and the check", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedChat();
    for (const form of forms) {
      const released = await served(await ask({ feature: form.feature, capabilities: null, body: form.body }));
      expect(released.types, form.feature).toEqual(["meta", "content_delta", "usage", "done"]);
      const advertised = await served(await ask({
        feature: form.feature,
        capabilities: BOTH,
        body: { ...form.body, coverageCheck: { window: [{ id: msg(7), dir: "fan" }], deletedIds: [msg(3)] } },
      }));
      expect(advertised.raw, form.feature).toBe(released.raw);
      expect(advertised.prompt, form.feature).toBe(released.prompt);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("OnlyFans", () => {
  it("answers the check for a caller that advertises it, and nothing changes for one that does not", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await archived({ ref: "9001", fromFan: true, ageMin: 20, page: "cov-of", platform: "onlyfans", conv: OF_FAN });
    await archived({ ref: "9002", fromFan: false, ageMin: 10, page: "cov-of", platform: "onlyfans", conv: OF_FAN });
    await archived({ ref: "9003", fromFan: true, ageMin: 15, page: "cov-of", platform: "onlyfans", conv: OF_FAN, deleted: true });
    const base = { page: "cov-of", platform: "onlyfans" };
    const body = { conversationRef: OF_FAN, knownFanMessageIds: ["9001"] };
    const coverageCheck = { window: [{ id: "9002", dir: "model" }, { id: "9001", dir: "fan" }], deletedIds: ["9003"] };

    const checked = await served(await ask({ ...base, body: { ...body, coverageCheck } }));
    expect(checked.context!.coverageCheck).toEqual({
      window: [{ id: "9002", state: "included" }, { id: "9001", state: "included" }],
      deleted: [{ id: "9003", state: "deleted" }],
    });
    // The ChatSpace extension advertises `context-v1` alone: its frame is what it was.
    const chatspace = await served(await ask({ ...base, capabilities: "context-v1", body }));
    const { coverageCheck: _answers, ...rest } = checked.context!;
    expect(chatspace.context).toEqual(rest);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
