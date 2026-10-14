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
    /** `x-kernel-ai-capabilities` (SDK 0.4.0, H-4a); older bundles ignore it. */
    capabilities?: readonly string[];
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

/**
 * A call as chat-extension makes every one (packages/hub/src/sdk-transport.ts):
 * `client.raw`, the status, then the frozen SDK's own response schema for it —
 * a body that fails the schema is the contract break the suite exists to catch.
 */
export async function rawChecked<T = Record<string, unknown>>(
  sdk: FrozenSdk,
  client: FrozenClient,
  operation: string,
  input?: Record<string, unknown>,
  status = 200,
): Promise<T> {
  return await checkedAnswer<T>(sdk, operation, await raw(client, operation, input), status);
}

export async function checkedAnswer<T>(sdk: FrozenSdk, operation: string, response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect(response.status, `${operation}: ${text.slice(0, 500)}`).toBe(status);
  const body = JSON.parse(text) as unknown;
  const schema = sdk.routeSchemas[operation]?.response[status];
  expect(schema, `the frozen SDK declares no ${status} for ${operation}`).toBeDefined();
  expect(schema!.safeParse(body).success, `the frozen SDK's schema refuses the hub's ${status} to ${operation}`).toBe(true);
  return body as T;
}

/**
 * A route whose manifest path has a literal colon (`/api/v2/spenders:batch`):
 * the SDK's path builder takes `:batch` for a parameter, so chat-extension
 * sends it itself with the manifest's method, auth and headers
 * (packages/hub/src/sdk-transport.ts sendLiteralPath).
 */
export async function literalPathChecked<T = Record<string, unknown>>(
  sdk: FrozenSdk,
  options: FrozenClientOptions,
  operation: string,
  body: unknown,
): Promise<T> {
  const def = sdk.kernelOperations[operation]!;
  const response = await fetch(`${options.baseUrl}${def.path}`, {
    method: def.method,
    headers: {
      ...options.headers,
      ...(options.auth ? { authorization: `Bearer ${options.auth.token()}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await checkedAnswer<T>(sdk, operation, response, 200);
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
  capabilities: readonly string[] = [],
): Promise<FrozenFrame[]> {
  const frames: FrozenFrame[] = [];
  const handle = sdk.streamAiFeature(options, {
    feature,
    body,
    onFrame: (frame) => frames.push(frame),
    ...(debugPromptEcho ? { debugPromptEcho: true } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
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
  /** A subscriber of the last hour, with no chat yet («Новые»). */
  onlyfansNewSubscriber: "777000780",
  fansly: "700000000000000002",
  fanslyGroup: "700000000000000001",
} as const;
/** The one paid tip of the OnlyFans fan, two days back. */
export const COMPAT_OF_TIP_MILLS = 25_000n;
export const COMPAT_OF_ACCOUNT = "acct_compat0000000000000000000000001";
/** The OnlyFans creator id of the OnlyFans page (`pages.external_page_id`). */
export const COMPAT_OF_PLATFORM_ACCOUNT = "100000777";
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

/** The operations the suite's shared core calls for every row (the compat
 * test's health, shared-reads, stream and error checks). */
export const COMPAT_SHARED_OPERATIONS: readonly string[] = [
  "health", "me", "pages", "aiPersonaCatalog", "aiRecapStatus", "spenders", "ingestObservations", "aiFeatureStream",
];

/** One AI request exactly as a released client sends it. */
export interface LaneCall {
  /** The client's button or surface, for messages. */
  name: string;
  feature: string;
  body(persona: CompatPersona): Record<string, unknown>;
  /** Text the assembled prompt must carry: proves which context path served it. */
  promptMarker: string;
  /** What the client puts on `x-kernel-ai-capabilities` besides `debug-input-v1`. */
  capabilities?: readonly string[];
  /** On a page whose owner switch `splitAll` is on, the client asks this
   * draft for parts too: `split-all-v1` on the header, `replyMode` in the body
   * (H-10; chat-extension's Hi, Ping and Coach). */
  splitAll?: boolean;
}

/** The owner's per-page switches of the chat-extension (H-2b), as the
 * effective config holds them. */
export interface OwnerSwitches {
  chatExtensionEnabled: boolean;
  chatExtensionFeatures: string;
  chatExtensionHostBindings: string;
}

/** How one released client really reaches the hub (critic item 2): its
 * version header, its sign-in mode, every AI request it makes and the
 * capture events it uploads. */
export interface ClientLane {
  platform: "onlyfans" | "fansly";
  clientVersion(version: string): string;
  signInMode: "active" | "pending";
  /** The narrow profile the client asks for at sign-in (H-3); null = a full token. */
  tokenClient: "chat-extension" | null;
  /** Shared-core reads the client never makes because its token is refused
   * them: the suite asserts the refusal instead of the read. */
  refusedSharedOperations: readonly string[];
  /** The owner's switches the client's pages need on this hub (null = none:
   * a full token is not subject to them). */
  ownerSwitches: OwnerSwitches | null;
  /** The shared core's two page reads, with the query the client sends. */
  sharedReads(persona: CompatPersona): { aiRecapStatus: Record<string, unknown>; spenders: Record<string, unknown> };
  calls: readonly LaneCall[];
  /** The ai_acceptance event the client's acceptance reporter puts on the wire. */
  acceptanceEvent(input: { clientEventId: string; generationRef: string; feature: string }): Record<string, unknown>;
  /** A `client_health` report (H-11b) the client uploads in a batch of its own; null = it sends none. */
  healthEvent: ((version: string) => Record<string, unknown>) | null;
  /** The producer its capture events are journaled under (H-12a). */
  producer(input: { version: string; header: string }): string;
  /** The desktop also uploads its one-time local-DB harvest (x-client-version harvest-<v>). */
  harvest: boolean;
}

/** The desktop's and the Fansly extension's shared reads, as the suite has always sent them. */
function fullTokenSharedReads(platform: "onlyfans" | "fansly") {
  return (persona: CompatPersona) => ({
    aiRecapStatus: { pageLabel: COMPAT_PAGES[platform], conversationRef: COMPAT_FANS[platform], personaDefinitionId: persona.definitionId },
    spenders: { scope: "page", pageLabel: COMPAT_PAGES[platform], period: "30d", limit: 10, offset: 0 },
  });
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
  tokenClient: null,
  refusedSharedOperations: [],
  ownerSwitches: null,
  sharedReads: fullTokenSharedReads("onlyfans"),
  healthEvent: null,
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
  producer: ({ header }) => `desktop@${header}`,
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
  tokenClient: null,
  refusedSharedOperations: [],
  ownerSwitches: null,
  sharedReads: fullTokenSharedReads("fansly"),
  healthEvent: null,
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
  // The Fansly extension's header is not a bare version: H-12a left it as it was.
  producer: ({ header }) => `desktop@${header}`,
  harvest: false,
};

// ── chat-extension 0.2.2–0.2.4 and its next release on ChatSpace (OnlyFans) ──
// chat-extension packages/core/src/domain/ops/request.ts buildStreamRequest,
// domain/features/plan.ts planStart. It signs in with the narrow token (H-3)
// and sends refs only: conversationRef = fanRef = the fan on OnlyFans, and the
// hub assembles the context from its own archive. Windows are the default
// settings (quick 100: Reply, Coach; improve 25: Fix; ping 100; Hi 25; deep
// 3000: Review, full Recap; short Recap 300), never above the bootstrap's
// `limits.deepMax` (this hub's default: 1500). `context-v1` rides every request
// (the bootstrap declares it); Reply and Fix always carry replyMode (Split off
// by default), Hi, Ping and Coach only with `split-all-v1` on a page whose own
// splitAll is on. Hi asks 3 variants in the dock, 1 in «Новые»; a preview
// (Spenders, «Новые») adds the checkpoint's known fan message ids.

/** The bootstrap's `limits.deepMax` at this hub's default (aiTranscriptDeepMaxRows unset). */
export const EXTENSION_DEEP_WINDOW = 1500;
const EXTENSION_CAPABILITIES = ["context-v1"] as const;

function extensionRequest(
  persona: CompatPersona,
  messageCount: number,
  extra: Record<string, unknown> = {},
  fan: string = COMPAT_FANS.onlyfans,
): Record<string, unknown> {
  return {
    clientRequestId: randomUUID(),
    pageLabel: COMPAT_PAGES.onlyfans,
    platform: "onlyfans",
    conversationRef: fan,
    fanRef: fan,
    personaKey: persona.key,
    expectedPersonaDefinitionId: persona.definitionId,
    messageCount,
    isRegeneration: false,
    ...extra,
  };
}

/** The fresh text of the open chat (D-14, H-4c): confirmed messages only, newest last. */
function extensionLiveText(): Record<string, unknown> {
  return {
    capturedAt: new Date().toISOString(),
    items: [
      { platformMessageId: "5035", direction: "fan", occurredAt: new Date(Date.now() - 120_000).toISOString(), text: `${COMPAT_ARCHIVE.onlyfans} 35` },
      { platformMessageId: "5037", direction: "fan", occurredAt: new Date(Date.now() - 60_000).toISOString(), text: COMPAT_LIVE_TEXT },
    ],
  };
}

/** Fresh text the archive does not hold yet: proves the live path reached the prompt. */
export const COMPAT_LIVE_TEXT = "compat fresh line from the open chat";

/** The extension's own feature ids (its FeatureId) by hub feature. */
const EXTENSION_FEATURE_OF: Record<string, string> = {
  "fast-reply": "reply", "improve-draft": "fix", "hi-greeting": "hi", ping: "ping",
  "chat-review": "review", "fan-summary": "recap", "coach-chat": "coach",
};

/** chat-extension packages/core/src/domain/telemetry/acceptance.ts: a dock
 * draft the human sent from the composer (TL-007; `sent` only from a linked
 * receipt + echo). The envelope names the page. */
function extensionAcceptanceEvent(input: { clientEventId: string; generationRef: string; feature: string }): Record<string, unknown> {
  return {
    clientEventId: input.clientEventId,
    kind: "ai_acceptance",
    observedAt: new Date().toISOString(),
    pageLabel: COMPAT_PAGES.onlyfans,
    payload: {
      generationRef: input.generationRef, lifecycle: "sent", opId: randomUUID(),
      feature: EXTENSION_FEATURE_OF[input.feature] ?? input.feature, surface: "dock", part: 0,
      via: "composer", platformMessageId: "5038", edited: false,
    },
  };
}

/** chat-extension packages/core/src/domain/telemetry/health.ts: one
 * 15-minute ClientHealthV1 window (its `kind` rides the envelope; no pageLabel). */
function extensionHealthEvent(version: string): Record<string, unknown> {
  const to = new Date(Math.floor(Date.now() / 900_000) * 900_000);
  const from = new Date(to.getTime() - 900_000);
  return {
    clientEventId: randomUUID(),
    kind: "client_health",
    observedAt: to.toISOString(),
    payload: {
      v: 1,
      window: { from: from.toISOString(), to: to.toISOString() },
      client: { name: "chat-extension", version, browser: "firefox", browserMajor: 157, os: "macos" },
      host: { kind: "chatspace", build: "index-DEVowLko", contractOk: true, missing: [] },
      disabled: ["previewSend"],
      perf: [],
      counters: {
        "p1.insert-misplaced": 0, "p1.send-without-human": 0, "p1.read-without-human": 0,
        "insert.prevented": 0, "send.held": 0, "send.uncertain": 0,
      },
      footprint: { kind: "owned-estimate", cachesKB: 420, logsKB: 900 },
    },
  };
}

const extensionLane: ClientLane = {
  platform: "onlyfans",
  clientVersion: (version) => `chat-extension/${version}`,
  signInMode: "active",
  tokenClient: "chat-extension",
  refusedSharedOperations: ["pages"],
  // Everything the extension uses on its page, as on the owner's test page;
  // previewSend (X8) stays off, as in production.
  ownerSwitches: {
    chatExtensionEnabled: true,
    chatExtensionFeatures: JSON.stringify({
      [COMPAT_PAGES.onlyfans]: {
        insertion: true, navigation: true, wsTap: true, sound: true, fanPanel: true, spenders: true,
        review: true, recap: true, coach: true, preview: true, stats: true, newcomers: true, freshText: true,
      },
    }),
    chatExtensionHostBindings: JSON.stringify({ "onlymonster:36408": COMPAT_PAGES.onlyfans }),
  },
  // hub-data.ts: recap status names the fan twice; the Spenders board pages by 200.
  sharedReads: (persona) => ({
    aiRecapStatus: { pageLabel: COMPAT_PAGES.onlyfans, conversationRef: COMPAT_FANS.onlyfans, fanRef: COMPAT_FANS.onlyfans, personaDefinitionId: persona.definitionId },
    spenders: { scope: "page", pageLabel: COMPAT_PAGES.onlyfans, period: "30d", limit: 200, offset: 0 },
  }),
  healthEvent: extensionHealthEvent,
  calls: [
    { name: "Reply", feature: "fast-reply", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, 100, { replyMode: "default", replyTone: "none" }) },
    { name: "Reply with a tone, Split on", feature: "fast-reply", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, 100, { replyMode: "preferSplit", replyTone: "flirty" }) },
    { name: "Reply with fresh text", feature: "fast-reply", promptMarker: COMPAT_LIVE_TEXT, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, 100, { replyMode: "default", replyTone: "none", liveTextContext: extensionLiveText() }) },
    { name: "Fix", feature: "improve-draft", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, 25, { replyMode: "default", draftText: "compat draft to fix" }) },
    { name: "Hi", feature: "hi-greeting", promptMarker: FOLLOWER_MARKER, capabilities: EXTENSION_CAPABILITIES, splitAll: true,
      body: (persona) => extensionRequest(persona, 25, { variantCount: 3 }, COMPAT_FANS.onlyfansFollower) },
    { name: "«Новые» Hi", feature: "hi-greeting", promptMarker: FOLLOWER_MARKER, capabilities: EXTENSION_CAPABILITIES, splitAll: true,
      body: (persona) => extensionRequest(persona, 25, { variantCount: 1, knownFanMessageIds: ["6003"] }, COMPAT_FANS.onlyfansFollower) },
    { name: "Ping", feature: "ping", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES, splitAll: true,
      body: (persona) => extensionRequest(persona, 100) },
    { name: "Spenders preview Reply", feature: "fast-reply", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, 100, { replyMode: "default", replyTone: "none", knownFanMessageIds: ["5035", "5033"] }) },
    { name: "Review", feature: "chat-review", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, EXTENSION_DEEP_WINDOW) },
    { name: "Recap", feature: "fan-summary", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, EXTENSION_DEEP_WINDOW) },
    { name: "Short Recap", feature: "fan-summary", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES,
      body: (persona) => extensionRequest(persona, 300, { summaryMode: "short" }) },
    { name: "Coach", feature: "coach-chat", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES, splitAll: true,
      body: (persona) => extensionRequest(persona, 100, {
        chatterQuestion: "What should I send next?",
        coachHistory: [{ question: "Is he still interested?", answer: "compat earlier coach answer" }],
        draftText: "compat coach draft",
      }) },
    { name: "Coach preset", feature: "coach-chat", promptMarker: ARCHIVE_MARKER, capabilities: EXTENSION_CAPABILITIES, splitAll: true,
      body: (persona) => extensionRequest(persona, 100, { preset: "situation" }) },
  ],
  acceptanceEvent: extensionAcceptanceEvent,
  // H-12a: the narrow token's profile names the producer; the header only the version.
  producer: ({ version }) => `chat-extension@${version}`,
  harvest: false,
};

export const CLIENT_LANES: Partial<Record<ClientSdkName, ClientLane>> = {
  "onlyfans-chat": desktopLane,
  "fansly-chat": fanslyLane,
  // H-3: signed in narrow; client-sdk-registry.test.ts holds its rows'
  // operations inside CLIENT_TOKEN_PROFILES["chat-extension"].
  "chat-extension": extensionLane,
};

export function laneFor(name: ClientSdkName): ClientLane {
  const lane = CLIENT_LANES[name];
  if (!lane) {
    throw new Error(`no compat lane for ${name}: add it before registering its SDK`);
  }
  return lane;
}

export interface CompatContext {
  sdk: FrozenSdk;
  lane: ClientLane;
  /** The chatter's client, as the released client builds it. */
  client: FrozenClient;
  /** The same chatter with a full token: only to set up what the client under
   * test never writes itself (a narrow token is refused those routes). For a
   * full-token lane it is the same token as `client`. */
  seed: FrozenClient;
  options: FrozenClientOptions;
  clientFor(token: string | null): FrozenClient;
  /** The persona the client picked from the catalog. */
  persona: CompatPersona;
  pageIds: Record<keyof typeof COMPAT_PAGES, number>;
  pool: Pool;
}

const OWNER_SWITCH_KEYS = [
  "chatExtensionEnabled", "chatExtensionFeatures", "chatExtensionHostBindings", "chatExtensionMinVersion",
  "chatExtensionHealthIngestEnabled",
] as const;

/** Saves the owner's chat-extension switches of a config; the returned
 * function puts them back exactly (a key that was unset is unset again). */
export function keepOwnerSwitches(config: Partial<Record<(typeof OWNER_SWITCH_KEYS)[number], unknown>>): () => void {
  const saved = OWNER_SWITCH_KEYS.map((key) => [key, Object.hasOwn(config, key), config[key]] as const);
  return () => {
    for (const [key, had, value] of saved) {
      if (had) config[key] = value;
      else delete config[key];
    }
  };
}

async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The password sign-in (D35) as the lane's client makes it; `anonymous` is a
 * client without a bearer. */
export async function signIn(
  sdk: FrozenSdk,
  anonymous: FrozenClient,
  lane: ClientLane,
  mode: "active" | "pending",
): Promise<string> {
  if (lane.tokenClient === null) {
    const issued = await call<{ mode: string; token: string }>(sdk, anonymous, "authIssueDeviceTokenWithPassword", {
      body: { ...COMPAT_CHATTER, label: "compat suite", mode },
    });
    expect(issued.mode).toBe(mode);
    return issued.token;
  }
  // chat-extension (packages/hub/src/facade.ts signIn): an active narrow token,
  // read raw — the SDK's sign-in schema drops the H-3 echo the client checks.
  expect(mode, "a narrow token is never a pending reservation").toBe("active");
  const response = await raw(anonymous, "authIssueDeviceTokenWithPassword", {
    body: { ...COMPAT_CHATTER, label: "Firefox · macOS · ChatSpace", mode, client: "chat-extension" },
  });
  expect(response.status).toBe(200);
  const issued = await response.json() as { mode: string; token: string; client?: unknown };
  expect(sdk.routeSchemas.authIssueDeviceTokenWithPassword!.response[200]!.safeParse(issued).success).toBe(true);
  expect(issued).toMatchObject({ mode: "active", client: lane.tokenClient });
  return issued.token;
}

async function upsertProfile(ctx: CompatContext, pageLabel: string, fan: string, body: string) {
  const saved = await call<{ body: string }>(ctx.sdk, ctx.seed, "upsertFanProfile", {
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

interface ExtensionBootstrap {
  protocol: number;
  identity: { userId: number; username: string; tokenClient: string | null };
  pages: Array<{ pageId: number; pageLabel: string; platform: string; platformAccountId: string | null; features: Record<string, { available: boolean; reason?: string }> }>;
  bindingsByHost: Record<string, number>;
  limits: { deepMax: number; feedMax: number; freshTextMaxItems: number; freshTextMaxChars: number };
  capabilities: string[];
}

/** chat-extension's bootstrap read (packages/hub/src/bootstrap.ts): raw, then
 * what it checks before it trusts it. */
async function extensionBootstrap(ctx: CompatContext): Promise<ExtensionBootstrap> {
  return await rawChecked<ExtensionBootstrap>(ctx.sdk, ctx.client, "clientBootstrap");
}

/** The fan ids chat-extension's OnlyFans calls name: conversationRef = fanRef = the fan. */
const OF_FAN = { pageLabel: COMPAT_PAGES.onlyfans, fanRef: COMPAT_FANS.onlyfans } as const;

/** One of the lane's AI calls, streamed as the client streams it, and its generation recorded. */
async function laneGeneration(ctx: CompatContext, name: string): Promise<{ generationRef: string; body: Record<string, unknown> }> {
  const request = ctx.lane.calls.find((item) => item.name === name)!;
  const body = request.body(ctx.persona);
  const generationRef = generationRefOf(
    await streamFeature(ctx.sdk, ctx.options, request.feature, body, false, request.capabilities),
  );
  await waitFor(`the ${name} generation capture`, async () => (await ctx.pool.query(
    `select 1 from ai_generation_content where generation_ref = $1 and params->>'outcome' = 'completed'`, [generationRef],
  )).rowCount === 1);
  return { generationRef, body };
}

interface ExtensionRecaps {
  full: { generationRef: string; text: string; coverage: { requestedCount: number | null } } | null;
  short: { generationRef: string; text: string; coverage: { requestedCount: number | null } } | null;
  fullSavedToProfile: boolean;
}

async function extensionRecaps(ctx: CompatContext): Promise<ExtensionRecaps> {
  return await rawChecked<ExtensionRecaps>(ctx.sdk, ctx.client, "clientConversationRecaps", {
    params: OF_FAN, query: { personaDefinitionId: ctx.persona.definitionId },
  });
}

/** Today's date in the zone chat-extension's popup asks its AI spend in. */
function moscowToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

let claimFans = 0;

/** A fresh «Новые» fan per run: a lease outlives the exerciser that took it. */
function nextClaimFan(): string {
  claimFans += 1;
  return `77700090${claimFans}`;
}

/** The lease body chat-extension sends (services/greeting-leases.ts): one token per install + fan. */
function leaseBody(action: "claim" | "renew" | "release", lease: { leaseToken: string; instanceId: string }) {
  return { action, leaseToken: lease.leaseToken, instanceId: lease.instanceId };
}

interface ExtensionClaim {
  lease: { state: string; leaseToken: string | null; heldBy: string | null };
  greeting: { state: string; messageRef: string | null };
}

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
    const token = await signIn(ctx.sdk, ctx.clientFor(null), ctx.lane, "pending");
    await call(ctx.sdk, ctx.clientFor(token), "authActivateDeviceToken");
    expect(await call(ctx.sdk, ctx.clientFor(token), "me")).toMatchObject({ user: { username: COMPAT_CHATTER.username } });
  },
  async authIssueDeviceTokenWithPassword(ctx) {
    const token = await signIn(ctx.sdk, ctx.clientFor(null), ctx.lane, ctx.lane.signInMode);
    if (ctx.lane.signInMode === "pending") await call(ctx.sdk, ctx.clientFor(token), "authActivateDeviceToken");
    expect(await call(ctx.sdk, ctx.clientFor(token), "me")).toMatchObject({ user: { username: COMPAT_CHATTER.username } });
  },
  async authRevokeCurrentDeviceToken(ctx) {
    const token = await signIn(ctx.sdk, ctx.clientFor(null), ctx.lane, "active");
    expect(await call(ctx.sdk, ctx.clientFor(token), "authRevokeCurrentDeviceToken")).toEqual({ revoked: true });
    const error = await failure(ctx.sdk, call(ctx.sdk, ctx.clientFor(token), "me"));
    expect(error).toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
  },
  // ── chat-extension's page routes (packages/hub/src/facade.ts; the callers in
  //    packages/core and apps/extension/src/composition/background/hub-data.ts) ──
  async clientAiUsageDaily(ctx) {
    // The popup's debug line: today in Moscow, one day, the zone left to the hub.
    await laneGeneration(ctx, ctx.lane.calls[0]!.name);
    const report = await rawChecked<{ scope: { pageLabel: string }; timeZone: string; days: Array<{ date: string; totals: { requestCount: number; costMicroUsd: number } }> }>(
      ctx.sdk, ctx.client, "clientAiUsageDaily", { params: { pageLabel: COMPAT_PAGES.onlyfans }, query: { date: moscowToday(), days: 1 } },
    );
    expect(report).toMatchObject({ scope: { pageLabel: COMPAT_PAGES.onlyfans }, timeZone: "Europe/Moscow" });
    expect(report.days.at(-1)!.date).toBe(moscowToday());
    expect(report.days.at(-1)!.totals.requestCount).toBeGreaterThan(0);
    expect(report.days.at(-1)!.totals.costMicroUsd).toBeGreaterThan(0);
  },
  async clientAudienceNew(ctx) {
    // «Новые», the popup and the sound poller: 48 hours, no limit, no cursor.
    const page = await rawChecked<{ window: { hours: number }; items: Array<{ fanRef: string; kind: string }> }>(
      ctx.sdk, ctx.client, "clientAudienceNew", { params: { pageLabel: COMPAT_PAGES.onlyfans }, query: { windowHours: 48 } },
    );
    expect(page.window.hours).toBe(48);
    expect(page.items.map((item) => item.fanRef)).toContain(COMPAT_FANS.onlyfansNewSubscriber);
  },
  async clientBootstrap(ctx) {
    const boot = await extensionBootstrap(ctx);
    const me = await call<{ user: { id: number } }>(ctx.sdk, ctx.client, "me");
    // What the client checks before it trusts a bootstrap (bootstrap.ts).
    expect(boot.protocol).toBe(1);
    expect(boot.identity).toMatchObject({ userId: me.user.id, username: COMPAT_CHATTER.username, tokenClient: "chat-extension" });
    const page = boot.pages.find((item) => item.pageLabel === COMPAT_PAGES.onlyfans)!;
    expect(page).toMatchObject({ pageId: ctx.pageIds.onlyfans, platform: "onlyfans", platformAccountId: COMPAT_OF_PLATFORM_ACCOUNT });
    expect(page.platformAccountId).toMatch(/^[1-9]\d{0,29}$/);
    expect(boot.bindingsByHost).toEqual({ "onlymonster:36408": ctx.pageIds.onlyfans });
    // The page's own feature is the client's only gate of a switch: every
    // switch the owner turned on reads available; X8's previewSend stays off.
    const switches = (JSON.parse(ctx.lane.ownerSwitches!.chatExtensionFeatures) as Record<string, Record<string, boolean>>)[COMPAT_PAGES.onlyfans]!;
    for (const [flag, on] of Object.entries(switches)) {
      expect(page.features[flag], flag).toEqual(on ? { available: true } : expect.objectContaining({ available: false }));
    }
    expect(page.features.previewSend).toMatchObject({ available: false });
    // A route is called only when its capability is declared (HUB_ROUTES).
    expect(boot.capabilities).toEqual(expect.arrayContaining([
      "context-v1", "live-text-v1", "split-all-v1", "shared-recaps-v1", "recap-profile-v1", "archive-feed-v1",
      "spenders-stats-v1", "awaiting-reply-v1", "preview-send-custody-v1", "audience-new-v1", "ai-usage-v1",
    ]));
    // The deep window the lane's Review and Recap send.
    expect(boot.limits.deepMax).toBe(EXTENSION_DEEP_WINDOW);
  },
  async clientConversationFeed(ctx) {
    const boot = await extensionBootstrap(ctx);
    type Feed = { snapshotRevision: string; nextOlderCursor: string | null; head: { messageRef: string } | null; items: Array<{ messageId: string; text: string | null }>; summary: unknown };
    // The preview's first page: limit min(50, feedMax), the Ping window as the summary's.
    const first = await rawChecked<Feed>(ctx.sdk, ctx.client, "clientConversationFeed", {
      params: OF_FAN, query: { limit: Math.min(50, boot.limits.feedMax), summaryWindow: 100 },
    });
    expect(first.head?.messageRef).toBe("5036");
    expect(first.items[0]).toMatchObject({ messageId: "5036", text: `${COMPAT_ARCHIVE.onlyfans} 36` });
    expect(first.summary).not.toBeNull();
    // The fan panel's last message, then the walk to older ones on the same snapshot.
    const panel = await rawChecked<Feed>(ctx.sdk, ctx.client, "clientConversationFeed", { params: OF_FAN, query: { limit: 1 } });
    expect(panel.items.map((item) => item.messageId)).toEqual(["5036"]);
    expect(panel.nextOlderCursor).toEqual(expect.any(String));
    const older = await rawChecked<Feed>(ctx.sdk, ctx.client, "clientConversationFeed", {
      params: OF_FAN, query: { cursor: panel.nextOlderCursor, limit: 50 },
    });
    expect(older.snapshotRevision).toBe(panel.snapshotRevision);
    expect(older.items[0]!.messageId).toBe("5035");
    expect(older.summary).toBeNull();
  },
  async clientConversationRecaps(ctx) {
    const full = await laneGeneration(ctx, "Recap");
    const short = await laneGeneration(ctx, "Short Recap");
    const recaps = await extensionRecaps(ctx);
    expect(recaps).toMatchObject({
      full: { generationRef: full.generationRef, text: COMPAT_COMPLETION, coverage: { requestedCount: EXTENSION_DEEP_WINDOW } },
      short: { generationRef: short.generationRef, text: COMPAT_COMPLETION, coverage: { requestedCount: 300 } },
      fullSavedToProfile: expect.any(Boolean),
    });
  },
  async clientFanClaim(ctx) {
    // «Новые» Hi: the greeting lease, taken, renewed and given back.
    const params = { pageLabel: COMPAT_PAGES.onlyfans, fanRef: nextClaimFan() };
    const lease = { leaseToken: randomUUID(), instanceId: randomUUID() };
    for (const [action, state] of [["claim", "owned"], ["renew", "owned"], ["release", "released"]] as const) {
      const answer = await rawChecked<ExtensionClaim>(ctx.sdk, ctx.client, "clientFanClaim", { params, body: leaseBody(action, lease) });
      expect(answer.lease.state, action).toBe(state);
    }
    // The human sent the greeting from ChatSpace's own composer (wsTap): a
    // proven native send needs no previewSend and confirms the greeting.
    const fanRef = nextClaimFan();
    const native = await rawChecked<ExtensionClaim>(ctx.sdk, ctx.client, "clientFanClaim", {
      params: { pageLabel: COMPAT_PAGES.onlyfans, fanRef },
      body: {
        action: "registerNativeSend", attemptId: randomUUID(), instanceId: lease.instanceId, purpose: "greeting",
        group: { generationRef: randomUUID(), variant: 0, partCount: 1 }, partIndex: 0, platformMessageId: `91${fanRef}`,
      },
    });
    expect(native.greeting.state).toBe("confirmed");
  },
  async clientFanClaimStatus(ctx) {
    const params = { pageLabel: COMPAT_PAGES.onlyfans, fanRef: nextClaimFan() };
    const lease = { leaseToken: randomUUID(), instanceId: randomUUID() };
    const free = await rawChecked<ExtensionClaim>(ctx.sdk, ctx.client, "clientFanClaimStatus", { params });
    expect(free.lease.state).toBe("none");
    await rawChecked(ctx.sdk, ctx.client, "clientFanClaim", { params, body: leaseBody("claim", lease) });
    // The read names no install and no token: the caller's own live lease
    // reads as held by them elsewhere, never with the token.
    const held = await rawChecked<ExtensionClaim>(ctx.sdk, ctx.client, "clientFanClaimStatus", { params });
    expect(held.lease).toMatchObject({ state: "held", heldBy: "you-elsewhere", leaseToken: null });
    await rawChecked(ctx.sdk, ctx.client, "clientFanClaim", { params, body: leaseBody("release", lease) });
  },
  async clientFanProfileFromGeneration(ctx) {
    // A finished full Recap becomes the fan's dossier; 409 generation_not_ready
    // is asked again, as the client's saver does.
    const full = await laneGeneration(ctx, "Recap");
    const body = { generationRef: full.generationRef, clientRequestId: full.body.clientRequestId };
    const answer: { saved?: { outcome: string; profile: { createdAt: string } } } = {};
    await waitFor("the dossier save", async () => {
      const response = await raw(ctx.client, "clientFanProfileFromGeneration", { params: OF_FAN, body });
      if (response.status === 409) {
        expect(await response.json()).toMatchObject({ error: "generation_not_ready" });
        return false;
      }
      answer.saved = await checkedAnswer(ctx.sdk, "clientFanProfileFromGeneration", response, 200);
      return true;
    });
    expect(answer.saved).toMatchObject({ outcome: expect.stringMatching(/^(created|existing)$/), profile: { createdAt: expect.any(String) } });
    // The recaps read says whether the dossier's latest version is this
    // recap: a text an older version already holds is answered `existing`
    // and stays where it was (every generation here has the same text).
    const recaps = await extensionRecaps(ctx);
    expect(recaps.full?.generationRef).toBe(full.generationRef);
    const dossier = await rawChecked<{ profile: { body: string } | null }>(ctx.sdk, ctx.client, "pageConversationProfile", {
      params: { pageLabel: COMPAT_PAGES.onlyfans, conversationId: COMPAT_FANS.onlyfans },
    });
    expect(recaps.fullSavedToProfile).toBe(dossier.profile?.body === COMPAT_COMPLETION);
    if (answer.saved?.outcome === "created") expect(recaps.fullSavedToProfile).toBe(true);
  },
  async clientSpenderAwaitingReply(ctx) {
    // The Spenders window's queue: a payer whose last word is the fan's.
    const page = await rawChecked<{ items: Array<{ fanRef: string; lifetimeGrossMills: number }> }>(
      ctx.sdk, ctx.client, "clientSpenderAwaitingReply", { params: { pageLabel: COMPAT_PAGES.onlyfans }, query: { limit: 100 } },
    );
    expect(page.items).toEqual([expect.objectContaining({ fanRef: COMPAT_FANS.onlyfans, lifetimeGrossMills: Number(COMPAT_OF_TIP_MILLS) })]);
  },
  async clientSpenderStats(ctx) {
    // The Spenders window's statistics: 30 days in the browser's zone.
    const stats = await rawChecked<{ timeZone: string; days: unknown[]; totals: { d30: { grossMills: number; payerCount: number } } }>(
      ctx.sdk, ctx.client, "clientSpenderStats",
      { params: { pageLabel: COMPAT_PAGES.onlyfans }, query: { windowDays: 30, timeZone: "Europe/Moscow" } },
    );
    expect(stats.timeZone).toBe("Europe/Moscow");
    expect(stats.days).toHaveLength(30);
    expect(stats.totals.d30).toMatchObject({ grossMills: Number(COMPAT_OF_TIP_MILLS), payerCount: 1 });
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
    if (ctx.lane.tokenClient === "chat-extension") {
      // The fan panel's dossier: on OnlyFans the conversation is the fan.
      await upsertProfile(ctx, COMPAT_PAGES.onlyfans, COMPAT_FANS.onlyfans, body);
      const result = await rawChecked(ctx.sdk, ctx.client, "pageConversationProfile", {
        params: { pageLabel: COMPAT_PAGES.onlyfans, conversationId: COMPAT_FANS.onlyfans },
      });
      expect(result).toMatchObject({ fan: { platformUserId: COMPAT_FANS.onlyfans }, profile: { body } });
      return;
    }
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
  async pageSpenderAutoLists(ctx) {
    // The Spenders board's shelves, read beside its first page.
    const shelves = await rawChecked<{ metric: string; totalEntries: number; lists: Array<{ key: string; entryCount: number }> }>(
      ctx.sdk, ctx.client, "pageSpenderAutoLists", { params: { pageLabel: COMPAT_PAGES.onlyfans } },
    );
    expect(shelves.lists.length).toBeGreaterThan(0);
    // The one paying fan sits on exactly one shelf.
    expect(shelves.lists.reduce((sum, list) => sum + list.entryCount, 0)).toBe(1);
  },
  async spenderDetail(ctx) {
    // The fan panel asks lifetime and 30 days; the preview 30 days.
    for (const period of ["lifetime", "30d"] as const) {
      const detail = await rawChecked<{ metrics: { lifetime: { scopeGrossAmountMills: number } }; pages: Array<{ pageId: number }> }>(
        ctx.sdk, ctx.client, "spenderDetail", {
          params: { platform: "onlyfans", platformUserId: COMPAT_FANS.onlyfans },
          query: { scope: "page", pageLabel: COMPAT_PAGES.onlyfans, period },
        },
      );
      expect(detail.metrics.lifetime.scopeGrossAmountMills, period).toBe(Number(COMPAT_OF_TIP_MILLS));
      expect(detail.pages.map((page) => page.pageId), period).toContain(ctx.pageIds.onlyfans);
    }
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
