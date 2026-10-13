import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLIENT_FEATURE_FLAG_NAMES, errorResponseSchema } from "@agency_hub_core/contracts";
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
import type { AiGatewayProviderInput } from "../apps/runtime/src/services/ai-gateway.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real verify.
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// R20 HF-12 (chat-extension docs/project-unite/plan.md, architecture §11.1):
// the narrow token's Reply, Fix, Hi and Ping on Fansly behind the page's new
// `drafts` flag, its voice script behind `voice`, its notes fill behind
// `notesFill`. Predicate of the new behaviour: a Fansly page AND a narrow
// chat-extension token. OnlyFans keeps the master switch and the version; a
// full token (the Fansly extension 2.10.1, the desktop) is never asked.

const AUDIT = { source: "cli" } as const;
const PASSWORD = "chatter-secret";
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** The OnlyFans fan of lora-of and lora-vip-of: an established chat. */
const OF_FAN = "777000777";
/** A Fansly chat: its group id and its fan (18-digit ids, the group is not the fan). */
const FANSLY_GROUP = "300000000000000001";
const FANSLY_FAN = "400000000000000002";
const NOTE_FIELDS = ["Имя", "Локация", "Возраст"];
const AI_TEST_TIMEOUT_MS = Math.max(INTEGRATION_TEST_TIMEOUT_MS, 120_000);

/**
 * The owner's `chatExtensionFeatures` rows on prod (read only, 2026-10-13):
 * the two OnlyFans pilot pages, no "*" row, no Fansly page.
 */
const PILOT_ROW = {
  insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
  recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
};
const PROD_ROWS = { "lora-vip-of": PILOT_ROW, "lora-of": PILOT_ROW };

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;
type Prompt = AiGatewayProviderInput["body"]["prompt"];

interface Call {
  name: string;
  feature: string;
  /** The flag that decides it on Fansly. */
  fanslyFlag: "drafts" | "voice" | "notesFill";
  body?: Record<string, unknown>;
}

/** What the new extension asks for on Fansly: the canonical refs, no clientContext. */
const FANSLY_CALLS: readonly Call[] = [
  { name: "Reply", feature: "fast-reply", fanslyFlag: "drafts", body: { replyTone: "casual" } },
  { name: "Fix", feature: "improve-draft", fanslyFlag: "drafts", body: { draftText: "hey you" } },
  { name: "Hi", feature: "hi-greeting", fanslyFlag: "drafts" },
  { name: "Ping", feature: "ping", fanslyFlag: "drafts" },
  // The voice script names the group and the fan apart too (R20 HF-4а).
  { name: "Voice script", feature: "voice-script", fanslyFlag: "voice", body: { draftText: "miss you" } },
  { name: "Notes fill", feature: "fan-notes-fill", fanslyFlag: "notesFill", body: { noteFields: NOTE_FIELDS } },
];

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let narrowToken = "";
let fullToken = "";
const pageIds: Record<string, number> = {};
const capture: { prompts: Prompt[] } = { prompts: [] };
/** Holds the provider after its first chunk until released (the mid-generation test). */
let gate: { entered: () => void; release: Promise<void> } | null = null;

function setSwitches(features: Record<string, Record<string, boolean>>, enabled = true, minVersion = "1.2.0") {
  app.config.chatExtensionEnabled = enabled;
  app.config.chatExtensionFeatures = JSON.stringify(features);
  app.config.chatExtensionMinVersion = minVersion;
}

async function generate(input: {
  token: string;
  feature: string;
  pageLabel: string;
  platform: "onlyfans" | "fansly";
  clientVersion?: string | null | undefined;
  body?: Record<string, unknown>;
}): Promise<InjectResponse> {
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${input.feature}`,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.clientVersion === null ? {} : { "x-client-version": input.clientVersion ?? EXTENSION_VERSION }),
    },
    payload: {
      clientRequestId: randomUUID(),
      pageLabel: input.pageLabel,
      platform: input.platform,
      ...input.body,
    },
  });
}

/** The narrow token's call on the Fansly page, as the new extension makes it. */
function fanslyCall(
  call: Call,
  extra: { pageLabel?: string; clientVersion?: string; platform?: "onlyfans" | "fansly" } = {},
) {
  return generate({
    token: narrowToken,
    feature: call.feature,
    pageLabel: extra.pageLabel ?? "lora-1",
    platform: extra.platform ?? "fansly",
    clientVersion: extra.clientVersion,
    body: { conversationRef: FANSLY_GROUP, fanRef: FANSLY_FAN, ...call.body },
  });
}

function expectFeatureRefused(response: InjectResponse, reason: string, what: string) {
  expect(response.statusCode, `${what}: ${response.body}`).toBe(409);
  expect(errorResponseSchema.parse(response.json()), what).toMatchObject({ error: "client_feature_disabled", reason });
}

/** Past the switch: the generation runs. */
function expectPastSwitch(response: InjectResponse, what: string) {
  expect(response.body, what).not.toContain("client_feature_disabled");
  expect(response.statusCode, `${what}: ${response.body}`).toBe(200);
  expect(response.body, what).toContain("sure thing");
}

async function generationCount(): Promise<number> {
  const { rows } = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from ai_usage_events");
  return rows[0]!.count;
}

function frames(response: InjectResponse) {
  return response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; requestId?: string; text?: string });
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
      capture.prompts.push(input.body.prompt);
      yield { type: "content_delta", text: "sure thing" };
      if (gate !== null) {
        gate.entered();
        await gate.release;
      }
      yield { type: "content_delta", text: ", babe" };
      yield {
        type: "usage",
        providerResponseId: "msg_fansly_drafts",
        cacheHit: false,
        usage: { inputTokens: 40, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, costMicroUsd: 90, costApproximate: false },
      };
      yield { type: "done", stopReason: "end_turn" };
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
  for (const [label, create, externalId, granted] of [
    ["lora-of", createOnlyFansPage, "100000001", true],
    ["lora-vip-of", createOnlyFansPage, "100000002", true],
    // Every Fansly page on prod has its platform account id (2026-10-13).
    ["lora-1", createFanslyPage, "500000000000000001", true],
    // A Fansly page the chatter is not granted.
    ["lora-2", createFanslyPage, "500000000000000002", false],
  ] as const) {
    const page = await create(app.db, { modelId: model!.id, label });
    pageIds[label] = page!.id;
    await storeProxyConfig(app.db, page!.id, {
      url: "socks5://proxy.example:1080", encryptedAuth: null, keyVersion: null, rateLimitScopeKey: "fansly-drafts-proxy",
    });
    await testDb.pool.query("update pages set external_page_id = $2 where id = $1", [page!.id, externalId]);
    if (granted) {
      await assignPageToUser(app, { userId: chatterId, pageLabel: label }, AUDIT);
    }
  }
  for (const label of ["lora-of", "lora-vip-of"]) {
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain)
       select $1, 'onlyfans', $2, (5000 + g)::text, case when g % 2 = 0 then null else $2 end,
              g % 2 = 0, now() - interval '3 days' + (g || ' minutes')::interval, 'archive line ' || g
       from generate_series(1, 6) g`,
      [pageIds[label], OF_FAN],
    );
  }

  // The Fansly chat: its thread (the group with its fan) and two archived
  // lines ten days old, past Ping's five-day active window, the model's last
  // (a silent fan Ping may nudge).
  await testDb.pool.query(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id)
     values ($1, $2, $3)`,
    [pageIds["lora-1"], FANSLY_GROUP, FANSLY_FAN],
  );
  await testDb.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref,
       fan_native_id, is_sent_by_me, occurred_at, text_plain)
     values ($1, 'fansly', $2, '600000000000000001', $3, false, now() - interval '10 days', 'archived hello'),
            ($1, 'fansly', $2, '600000000000000002', null, true, now() - interval '10 days' + interval '1 minute', 'hi there')`,
    [pageIds["lora-1"], FANSLY_GROUP, FANSLY_FAN],
  );
  // The voice lane of lora-1, so a voice script admitted by the switch runs.
  app.config.voiceNotesEnabled = true;
  app.config.voiceNotesPageAllowlist = "lora-1";
  app.voiceTtsProvider = {
    async synthesize() {
      throw new Error("a voice script never synthesizes");
    },
  };
  await upsertVoiceProfile(app.db, {
    platformAccountId: pageIds["lora-1"]!,
    voiceId: "voice-fansly-drafts",
    model: "eleven_v3",
    settings: {},
    outputFormat: "mp3_44100_128",
  });

  server = await buildApiServer(app);
  await server.ready();
  const signIn = async (body: Record<string, unknown>, clientVersion: string) => {
    const response = await server!.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": clientVersion },
      payload: { username: "grisha", password: PASSWORD, label: "fansly drafts device", mode: "active", ...body },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ token: string }>().token;
  };
  narrowToken = await signIn({ client: "chat-extension" }, EXTENSION_VERSION);
  fullToken = await signIn({}, "chatgoose-extension/2.10.1");
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

beforeEach(() => {
  gate = null;
  capture.prompts = [];
  setSwitches(PROD_ROWS);
});

describe("[R20 HF-12] the narrow token's drafts, voice script and notes fill on Fansly", () => {
  it("Fansly without the page's flag: 409 flag_off before any spend; with it: past the switch", async (context) => {
    if (!server) return context.skip();

    // The owner's rows as on prod: no Fansly page has a row.
    const before = await generationCount();
    for (const call of FANSLY_CALLS) {
      expectFeatureRefused(await fanslyCall(call), "flag_off", call.name);
    }
    expect(await generationCount()).toBe(before);

    // `drafts` opens Reply, Fix, Hi and Ping, and nothing else.
    setSwitches({ ...PROD_ROWS, "lora-1": { drafts: true } });
    for (const call of FANSLY_CALLS) {
      const response = await fanslyCall(call);
      if (call.fanslyFlag === "drafts") {
        expectPastSwitch(response, call.name);
      } else {
        expectFeatureRefused(response, "flag_off", call.name);
      }
    }

    // `voice` and `notesFill` open the voice script and the notes fill.
    setSwitches({ ...PROD_ROWS, "lora-1": { voice: true, notesFill: true } });
    for (const call of FANSLY_CALLS) {
      const response = await fanslyCall(call);
      if (call.fanslyFlag === "drafts") {
        expectFeatureRefused(response, "flag_off", call.name);
      } else {
        expectPastSwitch(response, call.name);
      }
    }

    // A page's row false reads as no row.
    setSwitches({ ...PROD_ROWS, "lora-1": { drafts: false, voice: false, notesFill: false } });
    for (const call of FANSLY_CALLS) {
      expectFeatureRefused(await fanslyCall(call), "flag_off", call.name);
    }
  }, AI_TEST_TIMEOUT_MS);

  it("Fansly with the flag still answers to the master switch, the version and the page grant", async (context) => {
    if (!server) return context.skip();
    const everything = { "lora-1": { drafts: true, voice: true, notesFill: true }, "lora-2": { drafts: true, voice: true, notesFill: true } };

    setSwitches({ ...PROD_ROWS, ...everything }, false);
    for (const call of FANSLY_CALLS) {
      expectFeatureRefused(await fanslyCall(call), "disabled", call.name);
    }
    setSwitches({ ...PROD_ROWS, ...everything });
    for (const call of FANSLY_CALLS) {
      expectFeatureRefused(await fanslyCall(call, { clientVersion: "chat-extension/1.1.9" }), "client_outdated", call.name);
      // A Fansly page not granted and one that does not exist answer the same.
      expectFeatureRefused(await fanslyCall(call, { pageLabel: "lora-2" }), "not_granted", call.name);
      expectFeatureRefused(await fanslyCall(call, { pageLabel: "ghost-fansly" }), "not_granted", call.name);
    }
  }, AI_TEST_TIMEOUT_MS);

  it("naming OnlyFans for a Fansly page gets nothing: the route refuses the mismatch before any context or spend", async (context) => {
    if (!server) return context.skip();

    const before = await generationCount();
    for (const call of FANSLY_CALLS) {
      const response = await fanslyCall(call, { platform: "onlyfans" });
      expect(response.statusCode, `${call.name}: ${response.body}`).toBe(404);
    }
    expect(capture.prompts).toEqual([]);
    expect(await generationCount()).toBe(before);
  }, AI_TEST_TIMEOUT_MS);

  it("the flag revoked mid-generation: the generation under way finishes; the next is refused; its acceptance report lands", async (context) => {
    if (!server) return context.skip();
    setSwitches({ ...PROD_ROWS, "lora-1": { drafts: true } });

    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    gate = { entered, release: new Promise<void>((resolve) => { release = resolve; }) };

    const pending = fanslyCall(FANSLY_CALLS[0]!);
    await inside;
    // The owner turns drafts off while the provider is still streaming.
    setSwitches(PROD_ROWS);
    release();
    const finished = await pending;

    expect(finished.statusCode, finished.body).toBe(200);
    const streamed = frames(finished);
    expect(streamed.map((frame) => frame.type)).toContain("done");
    expect(streamed.filter((frame) => frame.type === "content_delta").map((frame) => frame.text).join("")).toBe("sure thing, babe");
    const generationRef = streamed[0]!.requestId!;
    const { rows } = await testDb!.pool.query<{ completion: string; gateway_outcome: string; params: Record<string, unknown> }>(
      `select g.completion, u.gateway_outcome, g.params
       from ai_generation_content g join ai_usage_events u on u.id = g.usage_event_id
       where g.generation_ref = $1`,
      [generationRef],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ completion: "sure thing, babe", gateway_outcome: "completed" });
    expect(rows[0]!.params).toMatchObject({ clientProfile: "chat-extension" });

    // The next generation reads the switch afresh.
    gate = null;
    expectFeatureRefused(await fanslyCall(FANSLY_CALLS[0]!), "flag_off", "after the revocation");

    // The chatter still inserts the draft she has: its report is no generation and no flag decides it.
    const acceptance = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: { authorization: `Bearer ${narrowToken}`, "x-client-version": EXTENSION_VERSION },
      payload: {
        events: [{
          clientEventId: randomUUID(),
          kind: "ai_acceptance",
          observedAt: new Date().toISOString(),
          payload: { generationRef, lifecycle: "inserted" },
          pageLabel: "lora-1",
        }],
      },
    });
    expect(acceptance.statusCode, acceptance.body).toBe(200);
    expect(acceptance.json()).toEqual({ accepted: 1, duplicates: 0 });
  }, AI_TEST_TIMEOUT_MS);
});

describe("[R20 HF-12] unchanged: OnlyFans and the full token", () => {
  const OF_CALLS: readonly Call[] = FANSLY_CALLS.filter((call) => call.fanslyFlag === "drafts");

  it("OnlyFans: Reply, Fix, Hi and Ping on lora-of and lora-vip-of need the master switch and the version alone, under the owner's prod rows", async (context) => {
    if (!server) return context.skip();
    const ofCall = (call: Call, pageLabel: string, clientVersion?: string | null) => generate({
      token: narrowToken,
      feature: call.feature,
      pageLabel,
      platform: "onlyfans",
      clientVersion,
      body: { conversationRef: OF_FAN, ...call.body },
    });

    for (const pageLabel of ["lora-of", "lora-vip-of"]) {
      for (const call of OF_CALLS) {
        const what = `${pageLabel} ${call.name}`;
        // No drafts row, as on prod: past the switch.
        setSwitches(PROD_ROWS);
        const plain = await ofCall(call, pageLabel);
        expectPastSwitch(plain, what);
        // A drafts row on an OnlyFans page changes nothing: the flag does not exist there.
        setSwitches({ ...PROD_ROWS, [pageLabel]: { ...PILOT_ROW, drafts: true } });
        const withRow = await ofCall(call, pageLabel);
        expect(withRow.statusCode, what).toBe(plain.statusCode);
        // The master switch and the version still decide.
        setSwitches(PROD_ROWS, false);
        expectFeatureRefused(await ofCall(call, pageLabel), "disabled", what);
        setSwitches(PROD_ROWS);
        expectFeatureRefused(await ofCall(call, pageLabel, "chat-extension/1.1.9"), "client_outdated", what);
        expectFeatureRefused(await ofCall(call, pageLabel, null), "client_outdated", what);
      }
      const reply = await ofCall(OF_CALLS[0]!, pageLabel);
      expect(reply.statusCode, reply.body).toBe(200);
      expect(reply.body).toContain("sure thing");
    }
  }, AI_TEST_TIMEOUT_MS);

  it("the full token: the Fansly extension 2.10.1's request on Fansly and the desktop's on OnlyFans answer and prompt the same whatever the switches say", async (context) => {
    if (!server) return context.skip();
    // The Fansly extension 2.10.1 (fansly-chat operations.ts,
    // voice-service.ts, kernel-feature-gateway.ts): a full token, its own
    // version header, the window it read itself in clientContext, the legacy
    // refs (conversationRef = the fan) on Reply, Fix, Hi and Ping, the fan on
    // both refs of the voice script, the group and the fan on the notes fill;
    // Hi with its profile fields and three variants, Ping with its segment.
    const clientContext = {
      transcript: "[2026-10-12 18:00] fan: hey\n[2026-10-12 18:01] you: hi there",
      messageCount: 2,
      fanSpendingData: "",
      fanSubscriptionData: "",
    };
    const oldFanslyBody = (feature: string): Record<string, unknown> => {
      switch (feature) {
        case "hi-greeting":
          return {
            variantCount: 3,
            clientContext: { ...clientContext, fanDisplayName: "fan_one", fanUsername: "fan_one", personalMessageCount: 2 },
          };
        case "ping":
          return { clientContext: { ...clientContext, fanDisplayName: "fan_one", pingSegment: "segment-a", fanSilenceDays: 3 } };
        default:
          return { clientContext: { ...clientContext, fanDisplayName: "fan_one" } };
      }
    };
    const oldFansly = (call: Call) => generate({
      token: fullToken,
      feature: call.feature,
      pageLabel: "lora-1",
      platform: "fansly",
      clientVersion: "chatgoose-extension/2.10.1",
      body: {
        ...call.body,
        conversationRef: call.feature === "fan-notes-fill" ? FANSLY_GROUP : FANSLY_FAN,
        ...(call.feature === "fan-notes-fill" || call.feature === "voice-script" ? { fanRef: FANSLY_FAN } : {}),
        isRegeneration: false,
        ...oldFanslyBody(call.feature),
      },
    });
    const desktop = (call: Call) => generate({
      token: fullToken,
      feature: call.feature,
      pageLabel: "lora-of",
      platform: "onlyfans",
      clientVersion: "0.1.64",
      body: { conversationRef: OF_FAN, ...call.body },
    });
    const calls: Array<{ what: string; send: () => Promise<InjectResponse> }> = [
      ...FANSLY_CALLS.map((call) => ({ what: `2.10.1 ${call.name}`, send: () => oldFansly(call) })),
      ...OF_CALLS.map((call) => ({ what: `desktop ${call.name}`, send: () => desktop(call) })),
    ];

    const answers = async () => {
      const out: Array<{ status: number; error: string | null; prompt: Prompt | undefined; text: string }> = [];
      for (const { send } of calls) {
        capture.prompts = [];
        const response = await send();
        out.push({
          status: response.statusCode,
          error: response.statusCode === 200 ? null : response.body,
          prompt: capture.prompts[0],
          text: frames(response).filter((frame) => frame.type === "content_delta").map((frame) => frame.text).join(""),
        });
      }
      return out;
    };

    // Everything off, the extension's switches at rest.
    setSwitches({}, false, "0.0.0");
    const atRest = await answers();
    for (const [index, answer] of atRest.entries()) {
      expect(answer.status, `${calls[index]!.what}: ${answer.error}`).toBe(200);
      expect(answer.text, calls[index]!.what).toBe("sure thing, babe");
    }
    // Every Fansly flag off on prod rows, then every one on: the same answers, the same prompts.
    setSwitches(PROD_ROWS);
    expect(await answers()).toEqual(atRest);
    setSwitches({ ...PROD_ROWS, "lora-1": { drafts: true, voice: true, notesFill: true } });
    expect(await answers()).toEqual(atRest);
  }, AI_TEST_TIMEOUT_MS);
});

describe("[R20 HF-2] the narrow token's AI on a Fansly page: the page's own row alone, and no Help", () => {
  /** Every chat-extension flag on. */
  const EVERYTHING = Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, true]));
  /** Coach, Recap and Review: their flags exist on Fansly since HF-2. */
  const DEEP_CALLS: ReadonlyArray<{ name: string; feature: string; flag: "coach" | "recap" | "review"; body?: Record<string, unknown> }> = [
    { name: "Coach", feature: "coach-chat", flag: "coach", body: { chatterQuestion: "what next?" } },
    { name: "Recap", feature: "fan-summary", flag: "recap", body: { summaryMode: "short" } },
    { name: "Review", feature: "chat-review", flag: "review" },
  ];
  const deepCall = (call: (typeof DEEP_CALLS)[number]) => generate({
    token: narrowToken,
    feature: call.feature,
    pageLabel: "lora-1",
    platform: "fansly",
    body: { conversationRef: FANSLY_GROUP, fanRef: FANSLY_FAN, ...call.body },
  });
  /** Help, as each client would ask it on the Fansly page. */
  const narrowHelp = (extra: { pageLabel?: string; clientVersion?: string | null } = {}) => generate({
    token: narrowToken,
    feature: "help-me",
    pageLabel: extra.pageLabel ?? "lora-1",
    platform: "fansly",
    clientVersion: extra.clientVersion,
    body: { conversationRef: FANSLY_GROUP, fanRef: FANSLY_FAN },
  });
  /** The released Fansly extension 2.10.1's Help: its full token, its header, its own transcript. */
  const oldHelp = () => generate({
    token: fullToken,
    feature: "help-me",
    pageLabel: "lora-1",
    platform: "fansly",
    clientVersion: "chatgoose-extension/2.10.1",
    body: {
      conversationRef: FANSLY_FAN,
      isRegeneration: false,
      clientContext: {
        transcript: "[2026-10-12 18:00] fan: hey\n[2026-10-12 18:01] you: hi there",
        messageCount: 2,
        fanSpendingData: "",
        fanSubscriptionData: "",
        fanDisplayName: "fan_one",
      },
    },
  });

  it("the owner's \"*\" row, with every flag on, opens no generation on a Fansly page: flag_off before any spend", async (context) => {
    if (!server) return context.skip();
    const before = await generationCount();
    capture.prompts = [];
    // Every flag on for every page, and on the OnlyFans pages' own rows: none is the Fansly page's row.
    for (const rows of [{ "*": EVERYTHING }, { "*": EVERYTHING, "lora-of": EVERYTHING, "lora-2": EVERYTHING }]) {
      setSwitches(rows);
      for (const call of FANSLY_CALLS) {
        expectFeatureRefused(await fanslyCall(call), "flag_off", call.name);
      }
      for (const call of DEEP_CALLS) {
        expectFeatureRefused(await deepCall(call), "flag_off", call.name);
      }
    }
    expect(capture.prompts).toEqual([]);
    expect(await generationCount()).toBe(before);

    // The same "*" row is every OnlyFans page's, as before: Reply there is past the switch.
    const onlyFans = await generate({
      token: narrowToken, feature: "fast-reply", pageLabel: "lora-of", platform: "onlyfans",
      body: { conversationRef: OF_FAN, replyTone: "casual" },
    });
    expectPastSwitch(onlyFans, "lora-of Reply under the \"*\" row");

    // The page's own row: each generation by its own flag, the "*" row still saying nothing here.
    setSwitches({ "*": EVERYTHING, "lora-1": { drafts: true, voice: true, notesFill: true } });
    for (const call of FANSLY_CALLS) {
      expectPastSwitch(await fanslyCall(call), call.name);
    }
    for (const call of DEEP_CALLS) {
      expectFeatureRefused(await deepCall(call), "flag_off", call.name);
    }
    // And its `false` holds under a "*" that says on.
    setSwitches({ "*": EVERYTHING, "lora-1": { ...EVERYTHING, drafts: false } });
    expectFeatureRefused(await fanslyCall(FANSLY_CALLS[0]!), "flag_off", "drafts: false under \"*\": true");
  }, AI_TEST_TIMEOUT_MS);

  it("Coach, Recap and Review on Fansly wait for the page's own coach, recap and review rows", async (context) => {
    if (!server) return context.skip();
    for (const call of DEEP_CALLS) {
      // The other two flags on, this one not: the switch refuses this generation alone.
      const others = Object.fromEntries(DEEP_CALLS.filter((other) => other !== call).map((other) => [other.flag, true]));
      setSwitches({ ...PROD_ROWS, "lora-1": { ...others, drafts: true } });
      expectFeatureRefused(await deepCall(call), "flag_off", call.name);
      // With its row the same request is past the switch (what the generation then needs is the feature's own).
      setSwitches({ ...PROD_ROWS, "lora-1": { [call.flag]: true } });
      const admitted = await deepCall(call);
      expect(admitted.body, call.name).not.toContain("client_feature_disabled");
      // The master switch and the version still decide.
      setSwitches({ ...PROD_ROWS, "lora-1": { [call.flag]: true } }, false);
      expectFeatureRefused(await deepCall(call), "disabled", call.name);
    }
  }, AI_TEST_TIMEOUT_MS);

  it("Help: the narrow token's is refused on Fansly whatever the switches say; OnlyFans and the full token keep it", async (context) => {
    if (!server) return context.skip();
    const before = await generationCount();
    capture.prompts = [];
    // No switch lifts it: at rest, the master switch on, every flag on for the page and for every page.
    for (const [rows, enabled] of [
      [{}, false],
      [PROD_ROWS, true],
      [{ "*": EVERYTHING, "lora-1": EVERYTHING }, true],
    ] as const) {
      setSwitches(rows, enabled);
      expectFeatureRefused(await narrowHelp(), "platform_unsupported", "the narrow token's Help on Fansly");
      // The platform answers first: before the version, and for a page the caller is not granted.
      expectFeatureRefused(await narrowHelp({ clientVersion: "chat-extension/1.1.9" }), "platform_unsupported", "an outdated extension");
      expectFeatureRefused(await narrowHelp({ pageLabel: "lora-2" }), "platform_unsupported", "a page not granted");
    }
    expect(capture.prompts).toEqual([]);
    expect(await generationCount()).toBe(before);

    // OnlyFans, as before HF-2: the narrow token's Help needs the master switch and the version alone.
    const onlyFansHelp = (clientVersion?: string | null) => generate({
      token: narrowToken, feature: "help-me", pageLabel: "lora-of", platform: "onlyfans", clientVersion,
      body: { conversationRef: OF_FAN },
    });
    setSwitches(PROD_ROWS);
    expectPastSwitch(await onlyFansHelp(), "lora-of Help");
    expectFeatureRefused(await onlyFansHelp("chat-extension/1.1.9"), "client_outdated", "lora-of Help");
    setSwitches(PROD_ROWS, false);
    expectFeatureRefused(await onlyFansHelp(), "disabled", "lora-of Help");

    // The released Fansly extension 2.10.1 (a full token) keeps Help on Fansly: the same answer
    // and the same prompt whatever the chat-extension switches say.
    const answers: Array<{ status: number; prompt: Prompt | undefined; text: string }> = [];
    for (const [rows, enabled, minVersion] of [
      [{}, false, "0.0.0"],
      [PROD_ROWS, true, "1.2.0"],
      [{ "*": EVERYTHING, "lora-1": EVERYTHING }, true, "9.9.9"],
    ] as const) {
      setSwitches(rows, enabled, minVersion);
      capture.prompts = [];
      const response = await oldHelp();
      expect(response.statusCode, response.body).toBe(200);
      answers.push({
        status: response.statusCode,
        prompt: capture.prompts[0],
        text: frames(response).filter((frame) => frame.type === "content_delta").map((frame) => frame.text).join(""),
      });
    }
    expect(answers[0]!.text).toBe("sure thing, babe");
    expect(answers[0]!.prompt).toBeDefined();
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  }, AI_TEST_TIMEOUT_MS);
});
