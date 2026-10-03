import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";
import { expect } from "vitest";

import type { ClientSdkName, ClientSdkRegistryRow } from "../../apps/runtime/src/services/client-sdk-registry.ts";

// H-1a: the frozen client SDKs as the compat suite drives them. The bundles
// are plain ESM built from a client's vendored @kernel/sdk, so they are typed
// here only as far as the suite touches them; every answer stays `unknown`
// until the bundle's own zod schemas have accepted it.

export interface FrozenKernelApiError extends Error {
  category: string;
  status: number | null;
  code: string | null;
  body: unknown;
}

export interface FrozenFrame {
  type: string;
  [field: string]: unknown;
}

export interface FrozenClientOptions {
  baseUrl: string;
  auth?: { mode: "bearer"; token: () => string };
  headers?: Record<string, string>;
}

export type FrozenClient = Record<string, unknown>;

interface FrozenSchema {
  safeParse(value: unknown): { success: boolean };
}

export interface FrozenSdk {
  KERNEL_CONTRACT_HASH: string;
  kernelOperations: Record<string, { method: string; path: string }>;
  KernelApiError: abstract new (...args: never[]) => FrozenKernelApiError;
  createClient(options: FrozenClientOptions): FrozenClient;
  streamAiFeature(options: FrozenClientOptions, input: {
    feature: string;
    body: Record<string, unknown>;
    onFrame: (frame: FrozenFrame) => void;
    debugPromptEcho?: boolean;
  }): { done: Promise<void>; close(): void };
  fetchVoiceNoteAudio(options: FrozenClientOptions, input: { pageLabel: string; id: number }): Promise<Response>;
  routeSchemas: Record<string, { response: Record<number, FrozenSchema> }>;
}

const repoRoot = join(import.meta.dirname, "../..");

export async function loadFrozenSdk(row: ClientSdkRegistryRow): Promise<FrozenSdk> {
  return await import(/* @vite-ignore */ pathToFileURL(join(repoRoot, row.fixture, "sdk.mjs")).href) as FrozenSdk;
}

/** A contract error means the frozen client could not read what this hub
 * answered: the one failure the suite exists to catch, so it never passes as
 * an expected HTTP error. */
function guardContract(sdk: FrozenSdk, error: unknown, what: string): unknown {
  if (error instanceof sdk.KernelApiError && error.category === "contract") {
    return new Error(`frozen SDK rejected the hub's answer to ${what}: ${error.code}: ${error.message}`);
  }
  return error;
}

export async function call<T = unknown>(
  sdk: FrozenSdk,
  client: FrozenClient,
  operation: string,
  input?: Record<string, unknown>,
): Promise<T> {
  const method = client[operation];
  if (typeof method !== "function") {
    throw new Error(`frozen SDK has no typed operation ${operation}`);
  }
  try {
    return await (method as (input?: Record<string, unknown>) => Promise<T>)(input);
  } catch (error) {
    throw guardContract(sdk, error, operation);
  }
}

/** A raw call, as the clients make for the routes they validate themselves. */
export async function raw(client: FrozenClient, operation: string, input?: Record<string, unknown>): Promise<Response> {
  return await (client.raw as (key: string, input?: Record<string, unknown>) => Promise<Response>)(operation, input);
}

/** Resolves to the KernelApiError the call was expected to raise. */
export async function failure(sdk: FrozenSdk, pending: Promise<unknown>): Promise<FrozenKernelApiError> {
  const error = await pending.then(() => null, (reason: unknown) => reason);
  expect(error, "expected the call to fail").toBeInstanceOf(sdk.KernelApiError);
  return error as FrozenKernelApiError;
}

export async function streamFeature(
  sdk: FrozenSdk,
  options: FrozenClientOptions,
  feature: string,
  body: Record<string, unknown>,
  debugPromptEcho = false,
): Promise<FrozenFrame[]> {
  const frames: FrozenFrame[] = [];
  const handle = sdk.streamAiFeature(options, {
    feature,
    body,
    onFrame: (frame) => frames.push(frame),
    ...(debugPromptEcho ? { debugPromptEcho: true } : {}),
  });
  try {
    await handle.done;
  } catch (error) {
    throw guardContract(sdk, error, `ai/features/${feature}`);
  }
  return frames;
}

export function generationRefOf(frames: readonly FrozenFrame[]): string {
  const meta = frames.find((frame) => frame.type === "meta");
  expect(meta?.requestId, "meta frame carries the generation ref").toEqual(expect.any(String));
  return meta!.requestId as string;
}

export const COMPAT_PAGES = { onlyfans: "compat-of", fansly: "compat-fs" } as const;
// onlyfans: an established chat (36 archived messages); onlyfansFollower: a
// new follower (4 messages, under the Hi gate's 10). Fansly fans are
// accounts, their chats are groups.
export const COMPAT_FANS = {
  onlyfans: "777000777",
  onlyfansFollower: "777000778",
  fansly: "700000000000000002",
  fanslyGroup: "700000000000000001",
} as const;
export const COMPAT_OF_ACCOUNT = "acct_compat0000000000000000000000001";
// Released clients sign chatters in with login and password (D35).
export const COMPAT_CHATTER = { username: "compat-chatter", password: "compat-chatter-secret-1" } as const;
export const COMPAT_OWNER = { username: "compat-owner", password: "compat-owner-secret-1" } as const;
/** Archive text of the OnlyFans chats: `${marker} ${n}`, odd n from the fan. */
export const COMPAT_ARCHIVE = { onlyfans: "compat archive line", onlyfansFollower: "compat follower line" } as const;
/** The completion the capturing AI provider streams for every feature. */
export const COMPAT_COMPLETION = "compat reply";
/** The features whose prompt the Split toggle changes for a released client
 * (FEATURE_POLICIES.supportsReplyMode): Reply and Fix. */
export const SPLIT_FEATURES: ReadonlySet<string> = new Set(["fast-reply", "improve-draft"]);

export interface CompatPersona {
  key: string;
  definitionId: string;
}

/** One AI request exactly as a released client sends it. */
export interface LaneCall {
  /** The client's button or surface, for messages. */
  name: string;
  feature: string;
  body(persona: CompatPersona): Record<string, unknown>;
  /** Text the assembled prompt must carry: proves which context path served it. */
  promptMarker: string;
}

/** How one released client really reaches the hub (critic item 2): its
 * version header, its sign-in mode, every AI request it makes and the
 * capture events it uploads. */
export interface ClientLane {
  platform: "onlyfans" | "fansly";
  clientVersion(version: string): string;
  signInMode: "active" | "pending";
  calls: readonly LaneCall[];
  /** The ai_acceptance event the client's acceptance reporter puts on the wire. */
  acceptanceEvent(input: { clientEventId: string; generationRef: string; feature: string }): Record<string, unknown>;
  /** The desktop also uploads its one-time local-DB harvest (x-client-version harvest-<v>). */
  harvest: boolean;
}

// ── Desktop 0.1.64 (onlyfans-chat apps/desktop/src/main/hub/ai-feature-gateway.ts) ──
// It sends refs only: on the OnlyFans lane the hub assembles the context from
// its own archive. Tone rides Reply, the Split mode Reply and Fix; the New
// Followers queue asks hi-greeting for one variant with fanRef = chat id.

function desktopRequest(persona: CompatPersona, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientRequestId: randomUUID(),
    pageLabel: COMPAT_PAGES.onlyfans,
    platform: "onlyfans",
    conversationRef: COMPAT_FANS.onlyfans,
    personaKey: persona.key,
    expectedPersonaDefinitionId: persona.definitionId,
    isRegeneration: false,
    ...extra,
  };
}

const ARCHIVE_MARKER = `${COMPAT_ARCHIVE.onlyfans} 35`;
const FOLLOWER_MARKER = `${COMPAT_ARCHIVE.onlyfansFollower} 3`;

const desktopLane: ClientLane = {
  platform: "onlyfans",
  clientVersion: (version) => version,
  signInMode: "pending",
  calls: [
    { name: "Reply", feature: "fast-reply", promptMarker: ARCHIVE_MARKER,
      body: (persona) => desktopRequest(persona, { replyTone: "none", replyMode: "preferSplit" }) },
    { name: "Fix", feature: "improve-draft", promptMarker: ARCHIVE_MARKER,
      body: (persona) => desktopRequest(persona, { replyMode: "preferSplit", draftText: "compat draft to fix" }) },
    { name: "Help", feature: "help-me", promptMarker: ARCHIVE_MARKER, body: (persona) => desktopRequest(persona) },
    { name: "Recap", feature: "fan-summary", promptMarker: ARCHIVE_MARKER, body: (persona) => desktopRequest(persona) },
    { name: "Review", feature: "chat-review", promptMarker: ARCHIVE_MARKER, body: (persona) => desktopRequest(persona) },
    { name: "Ping", feature: "ping", promptMarker: ARCHIVE_MARKER, body: (persona) => desktopRequest(persona) },
    { name: "Hi", feature: "hi-greeting", promptMarker: FOLLOWER_MARKER,
      body: (persona) => desktopRequest(persona, { conversationRef: COMPAT_FANS.onlyfansFollower }) },
    { name: "New-follower Hi", feature: "hi-greeting", promptMarker: FOLLOWER_MARKER,
      body: (persona) => desktopRequest(persona, {
        conversationRef: COMPAT_FANS.onlyfansFollower, variantCount: 1, fanRef: COMPAT_FANS.onlyfansFollower,
      }) },
  ],
  // onlyfans-chat apps/desktop/src/main/hub/acceptance-reporter.ts toWireEvent.
  acceptanceEvent: ({ clientEventId, generationRef, feature }) => ({
    clientEventId,
    kind: "ai_acceptance",
    observedAt: new Date().toISOString(),
    payload: {
      operationId: randomUUID(), requestId: generationRef, generationRef, feature, action: "sent",
      accountId: COMPAT_OF_ACCOUNT, conversationId: COMPAT_FANS.onlyfans, edited: true,
    },
  }),
  harvest: true,
};

// ── Fansly extension 2.7.1 (fansly-chat src/background/operations.ts, kernel-feature-gateway.ts) ──
// It reads the chat live and sends it as clientContext. Coach and the Recaps
// use the canonical refs (conversationRef = group, fanRef = fan account);
// every other feature keeps the legacy shape (conversationRef = fan account,
// no fanRef). The requested window is top-level messageCount (deep 3000, quick
// 100, improve 25, Hi 25, short Recap 300); clientContext.messageCount is the
// kept count.

function fanslyTranscript(lines: number, photo = false): string {
  return Array.from({ length: lines }, (_, n) =>
    `[10:${String(n % 60).padStart(2, "0")}] Fan: ${photo && n === 0 ? "[Photo #1] " : ""}compat fansly line ${n}`).join("\n");
}

function fanslyContext(kept: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transcript: fanslyTranscript(kept, extra.media !== undefined),
    messageCount: kept,
    fanSpendingData: "Total: $12.00",
    fanSubscriptionData: "Subscribed: yes",
    fanDisplayName: "Compat Fan",
    ...extra,
  };
}

const CANONICAL_REFS = { conversationRef: COMPAT_FANS.fanslyGroup, fanRef: COMPAT_FANS.fansly } as const;

function fanslyRequest(persona: CompatPersona, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    clientRequestId: randomUUID(),
    pageLabel: COMPAT_PAGES.fansly,
    platform: "fansly",
    conversationRef: COMPAT_FANS.fansly,
    personaKey: persona.key,
    expectedPersonaDefinitionId: persona.definitionId,
    isRegeneration: false,
    ...extra,
  };
}

const fanslyMarker = (kept: number) => `compat fansly line ${kept - 1}`;

/** The voice lane's script request (fansly-chat src/background/voice-service.ts):
 * no persona, no requested window, conversationRef = fanRef = fan account. */
export function fanslyVoiceScriptBody(): Record<string, unknown> {
  return {
    clientRequestId: randomUUID(),
    pageLabel: COMPAT_PAGES.fansly,
    platform: "fansly",
    conversationRef: COMPAT_FANS.fansly,
    fanRef: COMPAT_FANS.fansly,
    replyTone: "flirty",
    draftText: "compat voice draft",
    isRegeneration: false,
    clientContext: {
      transcript: fanslyTranscript(20),
      messageCount: 20,
      fanDisplayName: "Compat Fan",
      fanSpendingData: "",
      fanSubscriptionData: "",
    },
  };
}

const COMPAT_MEDIA = {
  groupRef: COMPAT_FANS.fanslyGroup,
  items: [{
    n: 1, placement: "inline", messageId: "700000000000000101", sentAt: Date.UTC(2026, 8, 30, 10),
    sender: "fan", kind: "photo", mediaId: "700000000000000201", paid: false,
  }],
};

const fanslyLane: ClientLane = {
  platform: "fansly",
  clientVersion: (version) => `chatgoose-extension/${version}`,
  signInMode: "active",
  calls: [
    { name: "Reply", feature: "fast-reply", promptMarker: fanslyMarker(60),
      body: (persona) => fanslyRequest(persona, {
        replyTone: "none", replyMode: "preferSplit", messageCount: 100,
        clientContext: fanslyContext(60, { media: COMPAT_MEDIA }),
      }) },
    { name: "Fix", feature: "improve-draft", promptMarker: fanslyMarker(25),
      body: (persona) => fanslyRequest(persona, {
        replyMode: "preferSplit", draftText: "compat draft to fix", messageCount: 25, clientContext: fanslyContext(25),
      }) },
    { name: "Help", feature: "help-me", promptMarker: fanslyMarker(60),
      body: (persona) => fanslyRequest(persona, { messageCount: 100, clientContext: fanslyContext(60, { fanBio: "compat bio" }) }) },
    { name: "Recap", feature: "fan-summary", promptMarker: fanslyMarker(3000),
      body: (persona) => fanslyRequest(persona, { ...CANONICAL_REFS, messageCount: 3000, clientContext: fanslyContext(3000) }) },
    { name: "Short Recap", feature: "fan-summary", promptMarker: fanslyMarker(120),
      body: (persona) => fanslyRequest(persona, {
        ...CANONICAL_REFS, summaryMode: "short", messageCount: 300,
        clientContext: fanslyContext(120, { transcriptCoverage: "window" }),
      }) },
    { name: "Review", feature: "chat-review", promptMarker: fanslyMarker(400),
      body: (persona) => fanslyRequest(persona, { messageCount: 3000, clientContext: fanslyContext(400) }) },
    { name: "Ping", feature: "ping", promptMarker: fanslyMarker(60),
      body: (persona) => fanslyRequest(persona, {
        messageCount: 100, clientContext: fanslyContext(60, { pingSegment: "segment-a", fanSilenceDays: 9 }),
      }) },
    // 25 messages, 2 personal: the Hi gate counts the personal ones.
    { name: "Hi", feature: "hi-greeting", promptMarker: fanslyMarker(25),
      body: (persona) => fanslyRequest(persona, {
        variantCount: 3, messageCount: 25,
        clientContext: fanslyContext(25, {
          fanUsername: "compatfan", fanAvatarUrl: "https://cdn3.fansly.com/compat.jpg", personalMessageCount: 2,
        }),
      }) },
    { name: "Coach", feature: "coach-chat", promptMarker: fanslyMarker(60),
      body: (persona) => fanslyRequest(persona, {
        ...CANONICAL_REFS, draftText: "compat coach draft", messageCount: 100,
        chatterQuestion: "What should I send next?",
        coachHistory: [{ question: "Is he still interested?", answer: "compat earlier coach answer" }],
        clientContext: fanslyContext(60, { fanBio: "compat bio", transcriptCoverage: "window" }),
      }) },
    { name: "Coach preset", feature: "coach-chat", promptMarker: fanslyMarker(60),
      body: (persona) => fanslyRequest(persona, {
        ...CANONICAL_REFS, preset: "situation", messageCount: 100,
        clientContext: fanslyContext(60, { fanBio: "compat bio", transcriptCoverage: "full-history" }),
      }) },
    { name: "Voice script", feature: "voice-script", promptMarker: fanslyMarker(20), body: () => fanslyVoiceScriptBody() },
  ],
  // fansly-chat src/background/acceptance-reporter.ts toWireEvent.
  acceptanceEvent: ({ clientEventId, generationRef, feature }) => ({
    clientEventId,
    kind: "ai_acceptance",
    observedAt: new Date().toISOString(),
    payload: {
      operationId: randomUUID(), requestId: generationRef, generationRef, feature, action: "inserted",
      pageLabel: COMPAT_PAGES.fansly, conversationId: COMPAT_FANS.fansly,
    },
  }),
  harvest: false,
};

// chat-extension has no lane on purpose: its rows must run with the narrow
// token H-3 introduces, and the suite must also check row.operations ⊆
// CLIENT_TOKEN_PROFILES["chat-extension"].operations. Register its SDK only
// together with that lane.
export const CLIENT_LANES: Partial<Record<ClientSdkName, ClientLane>> = {
  "onlyfans-chat": desktopLane,
  "fansly-chat": fanslyLane,
};

export function laneFor(name: ClientSdkName): ClientLane {
  const lane = CLIENT_LANES[name];
  if (!lane) {
    throw new Error(`no compat lane for ${name}: add it (narrow token + allowlist check for chat-extension, H-3) before registering its SDK`);
  }
  return lane;
}

export interface CompatContext {
  sdk: FrozenSdk;
  lane: ClientLane;
  /** The chatter's client, as the released client builds it. */
  client: FrozenClient;
  options: FrozenClientOptions;
  clientFor(token: string | null): FrozenClient;
  pageIds: Record<keyof typeof COMPAT_PAGES, number>;
  pool: Pool;
}

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function signIn(ctx: CompatContext, mode: "active" | "pending"): Promise<string> {
  const issued = await call<{ mode: string; token: string }>(ctx.sdk, ctx.clientFor(null), "authIssueDeviceTokenWithPassword", {
    body: { ...COMPAT_CHATTER, label: "compat suite", mode },
  });
  expect(issued.mode).toBe(mode);
  return issued.token;
}

async function upsertProfile(ctx: CompatContext, pageLabel: string, fan: string, body: string) {
  const saved = await call<{ body: string }>(ctx.sdk, ctx.client, "upsertFanProfile", {
    params: { pageLabel, platformUserId: fan },
    body: { body, generatedAtMs: Date.now() },
  });
  expect(saved.body).toBe(body);
}

interface CommandView {
  commandId: string;
  kind: string;
  state: string;
  deduplicated: boolean;
}

/** A send as the desktop queues it (send/engine.ts): never claimed here, since
 * no outbox worker runs in the suite. */
async function queueText(ctx: CompatContext) {
  const body = {
    clientCommandId: randomUUID(),
    kind: "send_text_message_v1",
    accountId: COMPAT_OF_ACCOUNT,
    conversationId: COMPAT_FANS.onlyfans,
    payload: { text: "compat queued text" },
    retryOfCommandId: null,
  };
  const command = await call<CommandView>(ctx.sdk, ctx.client, "createOfapiCommand", { body });
  expect(command).toMatchObject({ kind: "send_text_message_v1", state: "queued", deduplicated: false });
  return { body, command };
}

interface VoiceNoteView {
  voiceNoteId: number;
  state: string;
}

/** The extension's voice take: a voice-script generation, then a render of it. */
async function renderVoiceNote(ctx: CompatContext) {
  const generationRef = generationRefOf(await streamFeature(ctx.sdk, ctx.options, "voice-script", fanslyVoiceScriptBody()));
  await waitFor("the voice-script generation capture", async () => (await ctx.pool.query(
    `select 1 from ai_generation_content where generation_ref = $1 and params->>'outcome' = 'completed'`, [generationRef],
  )).rowCount === 1);
  const body = {
    clientRequestId: randomUUID(),
    conversationRef: COMPAT_FANS.fansly,
    sourceGenerationRef: generationRef,
    script: COMPAT_COMPLETION,
  };
  const view = await call<VoiceNoteView>(ctx.sdk, ctx.client, "voiceNoteCreate", { params: { pageLabel: COMPAT_PAGES.fansly }, body });
  expect(view.voiceNoteId).toEqual(expect.any(Number));
  return { body, view };
}

let outreachFans = 0;

/** One exerciser per operation a registry row lists beyond the shared core. */
export const COMPAT_OPERATION_EXERCISERS: Record<string, (ctx: CompatContext) => Promise<void>> = {
  async aiUsageBatch(ctx) {
    const result = await call(ctx.sdk, ctx.client, "aiUsageBatch", {
      body: {
        events: [{
          clientEventId: randomUUID(), feature: "fast-reply", model: "anthropic:claude-sonnet-4-6",
          inputTokens: 10, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0,
          conversationId: null, durationMs: 5, isCacheHit: false, isRegeneration: false,
          completedAt: new Date().toISOString(),
        }],
      },
    });
    expect(result).toMatchObject({ receivedCount: 1, insertedCount: 1 });
  },
  async authActivateDeviceToken(ctx) {
    const token = await signIn(ctx, "pending");
    await call(ctx.sdk, ctx.clientFor(token), "authActivateDeviceToken");
    expect(await call(ctx.sdk, ctx.clientFor(token), "me")).toMatchObject({ user: { username: COMPAT_CHATTER.username } });
  },
  async authIssueDeviceTokenWithPassword(ctx) {
    const token = await signIn(ctx, ctx.lane.signInMode);
    if (ctx.lane.signInMode === "pending") await call(ctx.sdk, ctx.clientFor(token), "authActivateDeviceToken");
    expect(await call(ctx.sdk, ctx.clientFor(token), "me")).toMatchObject({ user: { username: COMPAT_CHATTER.username } });
  },
  async authRevokeCurrentDeviceToken(ctx) {
    const token = await signIn(ctx, "active");
    expect(await call(ctx.sdk, ctx.clientFor(token), "authRevokeCurrentDeviceToken")).toEqual({ revoked: true });
    const error = await failure(ctx.sdk, call(ctx.sdk, ctx.clientFor(token), "me"));
    expect(error).toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
  },
  async cancelOfapiCommand(ctx) {
    const { command } = await queueText(ctx);
    const params = { commandId: command.commandId };
    expect(await call(ctx.sdk, ctx.client, "cancelOfapiCommand", { params })).toMatchObject({ state: "cancelled" });
    // The desktop retries a cancel whose answer it lost.
    expect(await call(ctx.sdk, ctx.client, "cancelOfapiCommand", { params })).toMatchObject({ state: "cancelled" });
  },
  async createOfapiCommand(ctx) {
    const { body, command } = await queueText(ctx);
    // A resend after a lost answer dedupes to 200 on the same command.
    expect(await call(ctx.sdk, ctx.client, "createOfapiCommand", { body }))
      .toMatchObject({ commandId: command.commandId, state: "queued", deduplicated: true });
    // The other kinds the desktop queues (typing, mark-read, unsend).
    for (const [kind, payload] of [
      ["typing_active_v1", {}],
      ["mark_chat_read_v1", {}],
      ["unsend_message_v1", { messageId: "5035" }],
    ] as const) {
      const queued = await call(ctx.sdk, ctx.client, "createOfapiCommand", {
        body: { clientCommandId: randomUUID(), kind, accountId: COMPAT_OF_ACCOUNT, conversationId: COMPAT_FANS.onlyfans, payload },
      });
      expect(queued).toMatchObject({ kind, state: "queued" });
    }
  },
  async eventsV2Facts(ctx) {
    // A raw call: the desktop validates the money-facts page itself.
    const accountId = ctx.pageIds.onlyfans;
    const response = await raw(ctx.client, "eventsV2Facts", { query: { accountId, afterSeq: 0, limit: 500 } });
    expect(response.status).toBe(200);
    const page = await response.json() as unknown;
    expect(ctx.sdk.routeSchemas.eventsV2Facts!.response[200]!.safeParse(page).success).toBe(true);
    expect(page).toMatchObject({ accountId, facts: [], hasMore: false });
  },
  async followerOutreachAttempt(ctx) {
    // A fresh fan per run: a fan's greeting custody outlives this exerciser.
    outreachFans += 1;
    const result = await call(ctx.sdk, ctx.client, "followerOutreachAttempt", {
      params: { pageLabel: COMPAT_PAGES.fansly },
      body: { fanRef: `71000000000000${outreachFans}`, attemptId: randomUUID(), action: "reserve" },
    });
    expect(result).toMatchObject({ owned: true, state: "reserved" });
  },
  async getOfapiCommand(ctx) {
    const { command } = await queueText(ctx);
    expect(await call(ctx.sdk, ctx.client, "getOfapiCommand", { params: { commandId: command.commandId } }))
      .toMatchObject({ commandId: command.commandId, state: "queued", deduplicated: false });
  },
  async ofapiCreditsChatterSummary(ctx) {
    expect(await call(ctx.sdk, ctx.client, "ofapiCreditsChatterSummary")).toEqual(expect.any(Object));
  },
  async pageConversationProfile(ctx) {
    const body = `compat conversation dossier ${randomUUID()}`;
    await upsertProfile(ctx, COMPAT_PAGES.fansly, COMPAT_FANS.fansly, body);
    const result = await call(ctx.sdk, ctx.client, "pageConversationProfile", {
      params: { pageLabel: COMPAT_PAGES.fansly, conversationId: COMPAT_FANS.fanslyGroup },
    });
    expect(result).toMatchObject({ profile: { body } });
  },
  async pageFanProfile(ctx) {
    const body = `compat fan dossier ${randomUUID()}`;
    await upsertProfile(ctx, COMPAT_PAGES[ctx.lane.platform], COMPAT_FANS[ctx.lane.platform], body);
    const result = await call(ctx.sdk, ctx.client, "pageFanProfile", {
      params: { pageLabel: COMPAT_PAGES[ctx.lane.platform], platformUserId: COMPAT_FANS[ctx.lane.platform] },
    });
    expect(result).toMatchObject({ profile: { body } });
  },
  async pageTopSpenders(ctx) {
    const result = await call(ctx.sdk, ctx.client, "pageTopSpenders", {
      params: { pageLabel: COMPAT_PAGES.fansly },
      query: { window: "lifetime" },
    });
    expect(result).toMatchObject({ window: "lifetime" });
  },
  async upsertFanProfile(ctx) {
    await upsertProfile(ctx, COMPAT_PAGES[ctx.lane.platform], COMPAT_FANS[ctx.lane.platform], `compat upsert ${randomUUID()}`);
  },
  async voiceNoteCreate(ctx) {
    const { body, view } = await renderVoiceNote(ctx);
    // A resend of the same take replays the same render.
    expect(await call(ctx.sdk, ctx.client, "voiceNoteCreate", { params: { pageLabel: COMPAT_PAGES.fansly }, body }))
      .toMatchObject({ voiceNoteId: view.voiceNoteId });
  },
  async voiceNoteStatus(ctx) {
    const { view } = await renderVoiceNote(ctx);
    const params = { pageLabel: COMPAT_PAGES.fansly, id: view.voiceNoteId };
    let state = view.state;
    await waitFor("the voice render", async () => {
      state = (await call<VoiceNoteView>(ctx.sdk, ctx.client, "voiceNoteStatus", { params })).state;
      return state !== "queued" && state !== "dispatched";
    });
    expect(state).toBe("completed");
    const audio = await ctx.sdk.fetchVoiceNoteAudio(ctx.options, params);
    expect(audio.status).toBe(200);
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(0);
  },
};
