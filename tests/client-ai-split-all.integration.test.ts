import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  seedBundledAiPersona,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities, describeSplitOutput } from "../apps/runtime/src/modules/ai/index.ts";
import {
  AiGatewayTerminalStreamConsumer,
  buildAiGatewayTerminalRecord,
  prepareAiGatewayStream,
  type AiGatewayProviderInput,
} from "../apps/runtime/src/services/ai-gateway.ts";
import {
  assignPageToUser,
  createUserAccount,
  setUserPassword,
  type HumanAuthPrincipal,
} from "../apps/runtime/src/services/auth.ts";
import { isSplitAllOnForPage } from "../apps/runtime/src/services/client-split-all.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real verify.
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// chat-extension H-10 (architecture.md D-15): Split for Ping and Hi (H-10a) and
// for the drafts of a Coach answer (H-10b). The gate is the `split-all-v1`
// capability in the request header AND the owner's `splitAll` flag of the page
// AND the feature. This file is the matrix "feature × Split on/off ×
// released/new client" over the real route; the prompt texts themselves are
// pinned in tests/ai-prompts-split-all.test.ts, and the frozen released SDKs in
// tests/client-sdk-compat.integration.test.ts.

const AUDIT = { source: "cli" } as const;
const PASSWORD = "chatter-secret";
/** An established chat: 36 archived messages clear the Recap and Review gate. */
const FAN = "777000777";
/** A new follower: 4 messages stay under the Hi gate's 10. */
const FOLLOWER = "777000778";
const AI_TEST_TIMEOUT_MS = Math.max(INTEGRATION_TEST_TIMEOUT_MS, 120_000);

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type Prompt = AiGatewayProviderInput["body"]["prompt"];

/** How a request reaches the hub: the token and the headers it sends. */
interface Caller {
  name: string;
  token: () => string;
  clientVersion: string;
  /** The `x-kernel-ai-capabilities` header, when the client sends one. */
  capabilities?: string;
}

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let fullToken = "";
let narrowToken = "";
const pageIds: Record<string, number> = {};
const capture: { prompt?: Prompt } = {};
/** What the provider streams next, chunk by chunk. */
let completionChunks: readonly string[] = ["sure thing"];
let stopReason: string | null = "end_turn";

// A desktop or a Fansly extension in the field: a full token, no capability header.
const RELEASED: Caller = { name: "released client", token: () => fullToken, clientVersion: "0.1.64" };
// A full token that advertises the capability: the gate reads the header, not the token.
const FULL_ADVERTISING: Caller = {
  name: "full token advertising split-all-v1", token: () => fullToken, clientVersion: "0.2.0",
  capabilities: "debug-input-v1, split-all-v1",
};
// The chat extension: a narrow token and the capability list its SDK sends.
const EXTENSION: Caller = {
  name: "chat-extension", token: () => narrowToken, clientVersion: "chat-extension/1.0.0",
  capabilities: "context-v1, split-all-v1",
};

interface FeatureCall {
  name: string;
  feature: string;
  body?: Record<string, unknown>;
  /** A substring of the task block when Split by capability is on. */
  splitAllMarker?: string;
  /** Reply and Fix split for every client: the toggle always changes the prompt. */
  alwaysSplits?: true;
}

const COACH_SPLIT_MARKER = "- Inside each draft fence, deliver the message as separate short, text-like sends, separated by [NEXT].";

const CALLS: readonly FeatureCall[] = [
  { name: "Reply", feature: "fast-reply", body: { replyTone: "none" }, alwaysSplits: true },
  { name: "Fix", feature: "improve-draft", body: { draftText: "draft to fix" }, alwaysSplits: true },
  { name: "Help", feature: "help-me" },
  { name: "Recap", feature: "fan-summary" },
  { name: "Review", feature: "chat-review" },
  { name: "Coach", feature: "coach-chat", body: { chatterQuestion: "what next?" },
    splitAllMarker: COACH_SPLIT_MARKER },
  { name: "Coach preset", feature: "coach-chat", body: { preset: "situation" }, splitAllMarker: COACH_SPLIT_MARKER },
  { name: "Ping", feature: "ping", splitAllMarker: "- Split mode is on for this message." },
  { name: "Hi", feature: "hi-greeting", body: { conversationRef: FOLLOWER },
    splitAllMarker: "separated by [NEXT] inside the variant" },
  { name: "Hi, one draft", feature: "hi-greeting", body: { conversationRef: FOLLOWER, fanRef: FOLLOWER, variantCount: 1 },
    splitAllMarker: "deliver the greeting as separate short, text-like sends, separated by [NEXT]" },
];
const SPLIT_ALL_CALLS = CALLS.filter((call) => call.splitAllMarker !== undefined);
const callNamed = (name: string) => CALLS.find((call) => call.name === name)!;

function setSwitches(features: Record<string, Record<string, boolean>> | null, enabled = true) {
  app.config.chatExtensionEnabled = enabled;
  app.config.chatExtensionFeatures = JSON.stringify(features ?? {});
}

/** Coach, Recap and Review are flags of their own for a narrow token (H-3). */
const withAiFlags = (splitAll: boolean) => ({ "lora-of": { coach: true, recap: true, review: true, splitAll } });

async function generate(
  caller: Caller,
  call: FeatureCall,
  replyMode: "default" | "preferSplit" | undefined,
  page: { label: string; platform: "onlyfans" | "fansly"; body?: Record<string, unknown> } = { label: "lora-of", platform: "onlyfans" },
) {
  delete capture.prompt;
  const response = await server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${call.feature}`,
    headers: {
      authorization: `Bearer ${caller.token()}`,
      "x-client-version": caller.clientVersion,
      ...(caller.capabilities !== undefined ? { "x-kernel-ai-capabilities": caller.capabilities } : {}),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: page.label,
      platform: page.platform,
      conversationRef: FAN,
      ...(replyMode !== undefined ? { replyMode } : {}),
      ...call.body,
      ...page.body,
    },
  });
  expect(response.statusCode, `${caller.name} ${call.name}: ${response.body}`).toBe(200);
  const frames = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; requestId?: string; text?: string });
  return { frames, prompt: capture.prompt!, generationRef: frames[0]!.requestId! };
}

const taskBlock = (prompt: Prompt) => prompt.userBlocks.at(-1)!.text;

async function paramsOf(generationRef: string): Promise<Record<string, unknown>> {
  const { rows } = await testDb!.pool.query<{ params: Record<string, unknown> }>(
    "select params from ai_generation_content where generation_ref = $1", [generationRef],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.params;
}

async function seedChat(pageId: number, fan: string, messages: number, firstMessageId: number) {
  // Odd n from the fan, even n from the model, three days back.
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     select $1, 'onlyfans', $2, ($4::int + g)::text, case when g % 2 = 0 then null else $2 end,
            g % 2 = 0, now() - interval '3 days' + (g || ' minutes')::interval, 'archive line ' || g
     from generate_series(1, $3::int) g`,
    [pageId, fan, messages, firstMessageId],
  );
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  app.config.chatMuseAiGatewayEnabled = true;
  app.config.chatMuseAiGatewayDailyRequestLimit = 10_000;
  app.aiGatewayProvider = {
    provider: "anthropic",
    async *stream(input) {
      capture.prompt = input.body.prompt;
      for (const text of completionChunks) {
        yield { type: "content_delta", text };
      }
      yield {
        type: "usage",
        providerResponseId: "msg_split",
        cacheHit: false,
        usage: { inputTokens: 40, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 90, costApproximate: false },
      };
      yield { type: "done", stopReason };
    },
  };
  const persona = createBundledPersonalities()[0]!;
  await seedBundledAiPersona(app.db, {
    key: persona.id, displayName: persona.name, systemBlock: persona.content, bundledVersion: persona.builtinVersion!,
  });
  await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
  const chatterId = await fixtureUserId(app, "grisha");
  await setUserPassword(app, { userId: chatterId, password: PASSWORD }, AUDIT);

  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  for (const [label, create] of [
    ["lora-of", createOnlyFansPage],
    // An OnlyFans page the extension cannot bind: no platform account id, no host binding.
    ["nova-of", createOnlyFansPage],
    ["lora-fansly", createFanslyPage],
  ] as const) {
    const page = await create(app.db, { modelId: model!.id, label });
    pageIds[label] = page!.id;
    await storeProxyConfig(app.db, page!.id, {
      url: "socks5://proxy.example:1080", encryptedAuth: null, keyVersion: null, rateLimitScopeKey: "split-ai-proxy",
    });
    await assignPageToUser(app, { userId: chatterId, pageLabel: label }, AUDIT);
  }
  await testDb.pool.query("update pages set external_page_id = '100000001' where id = $1", [pageIds["lora-of"]]);
  await testDb.pool.query("update pages set external_page_id = null where id = $1", [pageIds["nova-of"]]);
  for (const label of ["lora-of", "nova-of"]) {
    await seedChat(pageIds[label]!, FAN, 36, 5000);
    await seedChat(pageIds[label]!, FOLLOWER, 4, 6000);
  }

  server = await buildApiServer(app);
  await server.ready();
  const signIn = async (body: Record<string, unknown>, clientVersion: string) => {
    const response = await server!.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": clientVersion },
      payload: { username: "grisha", password: PASSWORD, label: "split test device", mode: "active", ...body },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ token: string }>().token;
  };
  narrowToken = await signIn({ client: "chat-extension" }, EXTENSION.clientVersion);
  fullToken = await signIn({}, RELEASED.clientVersion);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(() => {
  completionChunks = ["sure thing"];
  stopReason = "end_turn";
});

describe("Split for Ping, Hi and Coach drafts behind split-all-v1 (H-10)", () => {
  it("matrix: the Split toggle reaches Ping, Hi and Coach only with the capability AND the page's flag", async (context) => {
    if (!server) return context.skip();

    for (const flagOn of [false, true]) {
      setSwitches(withAiFlags(flagOn));
      expect(await isSplitAllOnForPage(app, pageIds["lora-of"]!)).toBe(flagOn);
      for (const caller of [RELEASED, FULL_ADVERTISING, EXTENSION]) {
        for (const call of CALLS) {
          const what = `flag=${flagOn} ${caller.name} ${call.name}`;
          const plain = await generate(caller, call, "default");
          const asked = await generate(caller, call, "preferSplit");
          const gateOpen = flagOn && caller.capabilities !== undefined && call.splitAllMarker !== undefined;

          expect(asked.prompt.systemBlocks, what).toEqual(plain.prompt.systemBlocks);
          if (call.alwaysSplits || gateOpen) {
            expect(asked.prompt.userBlocks, what).not.toEqual(plain.prompt.userBlocks);
          } else {
            expect(asked.prompt.userBlocks, what).toEqual(plain.prompt.userBlocks);
          }
          if (call.splitAllMarker !== undefined) {
            expect(taskBlock(asked.prompt).includes(call.splitAllMarker), what).toBe(gateOpen);
            // Only the uncached task block moves: the 1h prefix and the context keep their bytes.
            expect(asked.prompt.userBlocks.slice(0, -1), what).toEqual(plain.prompt.userBlocks.slice(0, -1));
            expect(taskBlock(plain.prompt), what).not.toContain("Split mode is on");
          }
          // No new frame, whatever the gate says (D-15): markers travel inside content_delta.
          // A caller that advertises context-v1 has its context_v1 frame (H-4b) with or without Split.
          const frameTypes = caller.capabilities?.includes("context-v1")
            ? ["meta", "context_v1", "content_delta", "usage", "done"]
            : ["meta", "content_delta", "usage", "done"];
          expect(asked.frames.map((frame) => frame.type), what).toEqual(frameTypes);
          expect(plain.frames.map((frame) => frame.type), what).toEqual(frameTypes);
          // The structure record exists only for a generation the gate opened.
          expect("outputStructure" in await paramsOf(asked.generationRef), what).toBe(gateOpen);
          expect(await paramsOf(plain.generationRef), what).not.toHaveProperty("outputStructure");
        }
      }
    }
  }, AI_TEST_TIMEOUT_MS * 2);

  it("a released client's prompt and stored params are the same with the flag on as with it off", async (context) => {
    if (!server) return context.skip();

    for (const call of SPLIT_ALL_CALLS) {
      setSwitches(withAiFlags(false));
      const off = await generate(RELEASED, call, "preferSplit");
      const offParams = await paramsOf(off.generationRef);
      setSwitches(withAiFlags(true));
      const on = await generate(RELEASED, call, "preferSplit");
      expect(on.prompt, call.name).toEqual(off.prompt);
      expect(await paramsOf(on.generationRef), call.name).toEqual(offParams);
      // And replyMode absent is the same request to the builder.
      expect((await generate(RELEASED, call, undefined)).prompt, call.name).toEqual(off.prompt);
    }
  }, AI_TEST_TIMEOUT_MS);

  it("the flag follows the owner's switches: master switch, the page's own value, the binding, the platform", async (context) => {
    if (!server) return context.skip();
    const ping = CALLS.find((call) => call.feature === "ping")!;
    const expectSplit = async (caller: Caller, expected: boolean, what: string, page?: Parameters<typeof generate>[3]) => {
      const { prompt } = await generate(caller, ping, "preferSplit", page);
      expect(taskBlock(prompt).includes(ping.splitAllMarker!), what).toBe(expected);
    };

    // Everything at rest: the code defaults.
    setSwitches(null, false);
    await expectSplit(FULL_ADVERTISING, false, "switches at rest");

    // The master switch off beats the flag.
    setSwitches({ "*": { splitAll: true } }, false);
    await expectSplit(FULL_ADVERTISING, false, "master switch off");

    setSwitches({ "*": { splitAll: true } });
    await expectSplit(FULL_ADVERTISING, true, "flag on for every page");
    await expectSplit(EXTENSION, true, "flag on for every page, narrow token");

    // The page's own value wins over "*".
    setSwitches({ "*": { splitAll: true }, "lora-of": { splitAll: false } });
    await expectSplit(EXTENSION, false, "the page's own value is off");

    // A page the extension cannot bind a host account to.
    setSwitches({ "*": { splitAll: true } });
    expect(await isSplitAllOnForPage(app, pageIds["nova-of"]!)).toBe(false);
    await expectSplit(EXTENSION, false, "binding missing", { label: "nova-of", platform: "onlyfans" });

    // Fansly is outside the pilot: its extension already sends replyMode on
    // every feature, and advertising the capability changes nothing there.
    expect(await isSplitAllOnForPage(app, pageIds["lora-fansly"]!)).toBe(false);
    await expectSplit(FULL_ADVERTISING, false, "fansly page", {
      label: "lora-fansly",
      platform: "fansly",
      body: {
        clientContext: {
          transcript: "[10:00] Fan: hey", messageCount: 12, fanDisplayName: "Fan",
          fanSpendingData: "", fanSubscriptionData: "", pingSegment: "segment-a", fanSilenceDays: 9,
        },
      },
    });
    // Coach is the feature the Fansly extension has and the desktop does not:
    // its drafts stay unsplit there too, capability or not.
    const coach = callNamed("Coach");
    const fanslyCoach = await generate(FULL_ADVERTISING, coach, "preferSplit", {
      label: "lora-fansly",
      platform: "fansly",
      body: {
        fanRef: FAN,
        clientContext: {
          transcript: "[10:00] Fan: hey", messageCount: 12, fanDisplayName: "Fan",
          fanSpendingData: "", fanSubscriptionData: "", transcriptCoverage: "window",
        },
      },
    });
    expect(taskBlock(fanslyCoach.prompt)).toContain("Keep the explanation outside the fence.");
    expect(taskBlock(fanslyCoach.prompt)).not.toContain("Split mode is on");
    expect(await paramsOf(fanslyCoach.generationRef)).not.toHaveProperty("outputStructure");
    // On the OnlyFans page the same request splits.
    expect(taskBlock((await generate(FULL_ADVERTISING, coach, "preferSplit")).prompt)).toContain(coach.splitAllMarker!);

    // A switch that cannot be read turns the extension off as a whole.
    app.config.chatExtensionFeatures = "{\"*\": {\"splitAll\": true}";
    await expectSplit(FULL_ADVERTISING, false, "unreadable switch");
    expect(await isSplitAllOnForPage(app, 0)).toBe(false);
  }, AI_TEST_TIMEOUT_MS);

  it("records the structure of the finished text, a marker cut by a chunk boundary included, and changes no frame", async (context) => {
    if (!server) return context.skip();
    setSwitches(withAiFlags(true));
    const [ping, hi, hiOne] = [callNamed("Ping"), callNamed("Hi"), callNamed("Hi, one draft")];
    const trap = await armNoOutboundTrap(testDb!);
    try {
      // Ping: [NEXT] arrives in two chunks; the client receives exactly those chunks.
      completionChunks = ["hey you [NE", "XT] what's up"];
      const pinged = await generate(EXTENSION, ping, "preferSplit");
      expect(pinged.frames.filter((frame) => frame.type === "content_delta").map((frame) => frame.text))
        .toEqual(completionChunks);
      expect(await paramsOf(pinged.generationRef)).toMatchObject({
        clientProfile: "chat-extension",
        outcome: "completed",
        outputStructure: { variantsRequested: 1, partsPerVariant: [2], ok: true },
      });

      // Hi, three variants, both markers cut by chunk boundaries.
      completionChunks = ["a [", "NEXT", "] b [VARI", "ANT] c [NEXT", "] d [VARIANT", "] e [NEXT] f [NEXT] g"];
      const greeted = await generate(EXTENSION, hi, "preferSplit");
      expect((await paramsOf(greeted.generationRef))["outputStructure"])
        .toEqual({ variantsRequested: 3, partsPerVariant: [2, 2, 3], ok: true });

      // One draft: the model ignored Split. The record says so; the stream is not touched.
      completionChunks = ["just one message"];
      const single = await generate(FULL_ADVERTISING, hiOne, "preferSplit");
      expect(single.frames.map((frame) => frame.type)).toEqual(["meta", "content_delta", "usage", "done"]);
      const singleParams = await paramsOf(single.generationRef);
      expect(singleParams["outputStructure"]).toEqual({ variantsRequested: 1, partsPerVariant: [1], ok: false });
      expect(singleParams).not.toHaveProperty("clientProfile");

      // Split not asked for: no record, even with the gate's other two halves in place.
      completionChunks = ["a [NEXT] b"];
      expect(await paramsOf((await generate(EXTENSION, ping, "default")).generationRef)).not.toHaveProperty("outputStructure");

      // A stream that did not complete has no final text to describe.
      stopReason = null;
      const cut = await generate(EXTENSION, ping, "preferSplit");
      expect(cut.frames.at(-1)!.type).toBe("error");
      const cutParams = await paramsOf(cut.generationRef);
      expect(cutParams).toMatchObject({ outcome: "failed" });
      expect(cutParams).not.toHaveProperty("outputStructure");

      // The gate reads the database only.
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, AI_TEST_TIMEOUT_MS);

  it("Coach: records the parts of each draft block, a fence and a marker cut by chunk boundaries included", async (context) => {
    if (!server) return context.skip();
    setSwitches(withAiFlags(true));
    const [coach, preset] = [callNamed("Coach"), callNamed("Coach preset")];
    const trap = await armNoOutboundTrap(testDb!);
    try {
      // Two draft blocks between the advice. No chunk carries a whole opener or
      // a whole marker, and the client receives exactly those chunks.
      completionChunks = [
        "Сначала ответь на вопрос.\n``", "`draft\nhey you [NE", "XT] what's up\n`", "``\nИли смелее.\n```dra",
        "ft\na [NEXT", "] b [NE", "XT] c\n``", "`",
      ];
      expect(completionChunks.some((chunk) => chunk.includes("[NEXT]") || chunk.includes("```draft"))).toBe(false);
      const answered = await generate(EXTENSION, coach, "preferSplit");
      expect(answered.frames.map((frame) => frame.type))
        .toEqual(["meta", ...completionChunks.map(() => "content_delta"), "usage", "done"]);
      expect(answered.frames.filter((frame) => frame.type === "content_delta").map((frame) => frame.text))
        .toEqual(completionChunks);
      expect(await paramsOf(answered.generationRef)).toMatchObject({
        clientProfile: "chat-extension",
        outcome: "completed",
        outputStructure: { draftsRequested: null, partsPerDraft: [2, 3], brokenDrafts: 0, strayMarkers: 0, ok: true },
      });

      // A preset turn asks for exactly two drafts. The model gave one: the record says so.
      completionChunks = ["СИТУАЦИЯ: тёплый.\n```draft\nhey [NEXT] you\n```"];
      const presetTurn = await generate(EXTENSION, preset, "preferSplit");
      expect((await paramsOf(presetTurn.generationRef))["outputStructure"])
        .toEqual({ draftsRequested: 2, partsPerDraft: [2], brokenDrafts: 0, strayMarkers: 0, ok: false });

      // One fence per part is the miss Split on Coach can cause; the stream is not touched.
      completionChunks = ["```draft\nhey you\n```\n```draft\nwhat's up\n```"];
      const fencePerPart = await generate(FULL_ADVERTISING, coach, "preferSplit");
      expect(fencePerPart.frames.map((frame) => frame.type)).toEqual(["meta", "content_delta", "usage", "done"]);
      const fencePerPartParams = await paramsOf(fencePerPart.generationRef);
      expect(fencePerPartParams["outputStructure"])
        .toEqual({ draftsRequested: null, partsPerDraft: [1, 1], brokenDrafts: 0, strayMarkers: 0, ok: false });
      expect(fencePerPartParams).not.toHaveProperty("clientProfile");

      // Advice with no message to propose has nothing to split.
      completionChunks = ["Подожди его ответа, не пиши первым."];
      expect((await paramsOf((await generate(EXTENSION, coach, "preferSplit")).generationRef))["outputStructure"])
        .toEqual({ draftsRequested: null, partsPerDraft: [], brokenDrafts: 0, strayMarkers: 0, ok: true });

      // The same empty list is not ok when a draft was written and no client reads it. A marker in
      // the advice is shown to the chatter as text.
      completionChunks = ["Подожди его ответа [NEXT] не пиши первым."];
      expect((await paramsOf((await generate(EXTENSION, coach, "preferSplit")).generationRef))["outputStructure"])
        .toEqual({ draftsRequested: null, partsPerDraft: [], brokenDrafts: 0, strayMarkers: 1, ok: false });
      // A block the answer never closed: out of tokens is a completed stream too.
      completionChunks = ["Напиши так.\n```draft\nhey you [NEXT] what's"];
      stopReason = "max_tokens";
      const outOfTokens = await generate(EXTENSION, coach, "preferSplit");
      stopReason = "end_turn";
      expect(await paramsOf(outOfTokens.generationRef)).toMatchObject({
        outcome: "completed",
        stopReason: "max_tokens",
        outputStructure: { draftsRequested: null, partsPerDraft: [], brokenDrafts: 1, strayMarkers: 1, ok: false },
      });

      // Split not asked for: no record, whatever the answer looks like.
      completionChunks = ["```draft\na [NEXT] b\n```"];
      expect(await paramsOf((await generate(EXTENSION, coach, "default")).generationRef)).not.toHaveProperty("outputStructure");
      // Nor for a released client that asks without the capability.
      expect(await paramsOf((await generate(RELEASED, coach, "preferSplit")).generationRef)).not.toHaveProperty("outputStructure");

      // The gate and the Coach context read the database only.
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, AI_TEST_TIMEOUT_MS);

  it("a structure check that throws costs only its own record: the generation row and the ledger are written", async (context) => {
    if (!server) return context.skip();
    const principal: HumanAuthPrincipal = {
      authMethod: "device_token",
      user: {
        id: await fixtureUserId(app, "grisha"), username: "grisha", role: "chatter", assignedPages: [], mustChangePassword: false,
      },
      assignedPageIds: [pageIds["lora-of"]!],
    };
    /** What the route does with a prepared stream: read it to its end, then settle the terminal record. */
    const settle = async (describeOutput: (completion: string) => Record<string, unknown>) => {
      const stream = await prepareAiGatewayStream(app, principal, {
        clientRequestId: randomUUID(),
        feature: "ping",
        pageLabel: "lora-of",
        platform: "onlyfans",
        platformUserId: FAN,
        conversationId: FAN,
        model: "anthropic:claude-sonnet-4-6",
        reasoningEffort: "off",
        isRegeneration: false,
        prompt: { systemBlocks: [{ text: "system", cache: "1h" }], userBlocks: [{ text: "user", cache: "none" }] },
      }, { describeOutput });
      const consumer = new AiGatewayTerminalStreamConsumer();
      for await (const frame of stream.stream(new AbortController().signal)) {
        consumer.note(frame);
      }
      consumer.finish();
      const recorded = await stream.recordTerminal(buildAiGatewayTerminalRecord(consumer, {
        outcome: consumer.outcome, failure: null, durationMs: 1, completedAt: new Date(),
      }));
      return { recorded, generationRef: stream.requestId };
    };

    completionChunks = ["hey you [NEXT] what's up"];
    const warn = vi.spyOn(app.logger, "warn");
    try {
      const failing = await settle(() => {
        throw new Error("structure check exploded");
      });
      // The usage row is finalized and the restricted record is stored, without the structure key.
      expect(failing.recorded).toBe(true);
      const params = await paramsOf(failing.generationRef);
      expect(params).toMatchObject({ outcome: "completed", stopReason: "end_turn" });
      expect(params).not.toHaveProperty("outputStructure");
      const { rows } = await testDb!.pool.query(
        `select g.completion, u.gateway_outcome
         from ai_generation_content g join ai_usage_events u on u.id = g.usage_event_id
         where g.generation_ref = $1`,
        [failing.generationRef],
      );
      expect(rows).toEqual([{ completion: "hey you [NEXT] what's up", gateway_outcome: "completed" }]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: failing.generationRef }),
        "AI gateway output structure check failed",
      );

      // The same stream with a check that returns: the key is there.
      warn.mockClear();
      const described = await settle((completion) => describeSplitOutput(completion, 1));
      expect(described.recorded).toBe(true);
      expect(await paramsOf(described.generationRef)).toMatchObject({
        outcome: "completed",
        outputStructure: { variantsRequested: 1, partsPerVariant: [2], ok: true },
      });
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), "AI gateway output structure check failed");
    } finally {
      warn.mockRestore();
    }
  }, AI_TEST_TIMEOUT_MS);
});
