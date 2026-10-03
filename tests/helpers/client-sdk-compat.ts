import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  routeSchemas: Record<string, { response: Record<number, { safeParse(value: unknown): { success: boolean } }> }>;
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

export const COMPAT_PAGES = { onlyfans: "compat-of", fansly: "compat-fs" } as const;
export const COMPAT_FANS = { onlyfans: "777000777", fansly: "700000000000000002", fanslyGroup: "700000000000000001" } as const;
export const COMPAT_LEAD = { username: "compat-lead", password: "compat-lead-secret-1" } as const;
export const COMPAT_FEATURES = ["fast-reply", "ping", "fan-summary"] as const;
export type CompatFeature = (typeof COMPAT_FEATURES)[number] | "hi-greeting";

export interface CompatPersona {
  key: string;
  definitionId: string;
}

/** How one released client really reaches the hub (critic item 2): its
 * version header, its sign-in mode and the body it sends per AI feature. */
export interface ClientLane {
  platform: "onlyfans" | "fansly";
  clientVersion(version: string): string;
  signInMode: "active" | "pending";
  featureBody(feature: CompatFeature, persona: CompatPersona): Record<string, unknown>;
}

function fanslyTranscript(lines: number): string {
  return Array.from({ length: lines }, (_, n) => `[10:${String(n % 60).padStart(2, "0")}] Fan: compat fansly line ${n}`).join("\n");
}

// The desktop sends no context: on the OnlyFans lane the hub assembles it from
// its own archive (packages/shared/src/hub/client.ts → ai-feature-gateway.ts).
const desktopLane: ClientLane = {
  platform: "onlyfans",
  clientVersion: (version) => version,
  signInMode: "pending",
  featureBody: (_feature, persona) => ({
    clientRequestId: randomUUID(),
    pageLabel: COMPAT_PAGES.onlyfans,
    platform: "onlyfans",
    conversationRef: COMPAT_FANS.onlyfans,
    personaKey: persona.key,
    expectedPersonaDefinitionId: persona.definitionId,
    isRegeneration: false,
  }),
};

// The Fansly extension reads the chat live and sends it as clientContext; a
// full Recap asks for 3000 messages; the Split toggle rides every feature
// (fansly-chat src/background/operations.ts, kernel-feature-gateway.ts).
const fanslyLane: ClientLane = {
  platform: "fansly",
  clientVersion: (version) => `chatgoose-extension/${version}`,
  signInMode: "active",
  featureBody: (feature, persona) => {
    const recap = feature === "fan-summary";
    const kept = recap ? 3000 : 35;
    return {
      clientRequestId: randomUUID(),
      pageLabel: COMPAT_PAGES.fansly,
      platform: "fansly",
      conversationRef: recap ? COMPAT_FANS.fanslyGroup : COMPAT_FANS.fansly,
      fanRef: COMPAT_FANS.fansly,
      personaKey: persona.key,
      expectedPersonaDefinitionId: persona.definitionId,
      replyTone: "none",
      replyMode: "preferSplit",
      messageCount: recap ? 3000 : 50,
      isRegeneration: false,
      ...(feature === "hi-greeting" ? { variantCount: 3 } : {}),
      clientContext: {
        transcript: fanslyTranscript(kept),
        messageCount: kept,
        fanDisplayName: "Compat Fan",
        fanSpendingData: "Total: $12.00",
        fanSubscriptionData: "Subscribed: yes",
        ...(feature === "ping" ? { pingSegment: "segment-a", fanSilenceDays: 9 } : {}),
        ...(feature === "hi-greeting"
          ? { fanUsername: "compatfan", fanAvatarUrl: "https://cdn3.fansly.com/compat.jpg", personalMessageCount: 2 }
          : {}),
      },
    };
  },
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
  clientFor(token: string | null): FrozenClient;
}

async function signIn(ctx: CompatContext, mode: "active" | "pending"): Promise<string> {
  const issued = await call<{ mode: string; token: string }>(ctx.sdk, ctx.clientFor(null), "authIssueDeviceTokenWithPassword", {
    body: { ...COMPAT_LEAD, label: "compat suite", mode },
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
    expect(await call(ctx.sdk, ctx.clientFor(token), "me")).toMatchObject({ user: { username: COMPAT_LEAD.username } });
  },
  async authIssueDeviceTokenWithPassword(ctx) {
    const token = await signIn(ctx, ctx.lane.signInMode);
    if (ctx.lane.signInMode === "pending") await call(ctx.sdk, ctx.clientFor(token), "authActivateDeviceToken");
    expect(await call(ctx.sdk, ctx.clientFor(token), "me")).toMatchObject({ user: { username: COMPAT_LEAD.username } });
  },
  async authRevokeCurrentDeviceToken(ctx) {
    const token = await signIn(ctx, "active");
    expect(await call(ctx.sdk, ctx.clientFor(token), "authRevokeCurrentDeviceToken")).toEqual({ revoked: true });
    const error = await failure(ctx.sdk, call(ctx.sdk, ctx.clientFor(token), "me"));
    expect(error).toMatchObject({ status: 401, category: "auth", body: { reason: "token_revoked" } });
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
};
