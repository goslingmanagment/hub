import {
  checkAdapterConformance,
  createPlatformRegistry,
  type CanonicalStream,
  type PlatformAdapter,
  type PlatformRegistry,
} from "@agency_hub_core/platform-core";

import { getSyncStreamsForPlatform, type PageSyncLease } from "@agency_hub_core/db";
import type { Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  executeFanIdentitiesChunk,
  onlyfansDmConversationsChunk,
  onlyfansLightChunk,
  onlyfansSubscribersChunk,
  onlyfansTopSpendersChunk,
  onlyfansTransactionsChunk,
  type ExecutorRequestContext,
  type StreamChunkResult,
} from "../services/sync/executor-handlers.ts";
import { onlyfansPostsChunk } from "../services/sync/posts.ts";

// Adapters are assembled in the app layer because pull handlers require
// AppContext. Capabilities share the planner's per-platform stream lists;
// conformance checks below require a handler for every declared stream.

/** The full executor dispatch input (executeStreamChunk's shape). Handlers
 * declaring narrower inputs are assignable (parameter contravariance). */
export type ExecutorChunkInput = ExecutorRequestContext & {
  streamState: PageSyncLease;
  syncRunId: number;
};

export type ExecutorPullHandler = (
  app: AppContext,
  input: ExecutorChunkInput,
) => Promise<StreamChunkResult>;

/** Sync-trigger scope policy: which streams a manual/API trigger of each
 * scope schedules. POLICY, not capability — e.g. OnlyFans' "light" also
 * schedules transactions and fan identities. Always a subset of
 * capabilities.streams (pinned by the registry suite). A scope absent from
 * the map is unsupported on that platform (resolveStreamsForScope throws). */
export type SyncScopePolicy = Partial<Record<"light" | "followers" | "all" | "data" | "messages" | "posts", CanonicalStream[]>>;

export type AppPlatformAdapter = PlatformAdapter<ExecutorPullHandler> & {
  syncScopes: SyncScopePolicy;
};
export type AppPlatformRegistry = PlatformRegistry<AppPlatformAdapter>;

// The per-platform pull maps route straight to the split handler halves —
// no platform branch survives on the dispatched path (Stage 18 Tasks 2–3).
//
// Fansly has none since step 4 (S4-10): the Fansly Sync Engine
// (`apps/runtime/src/sync/`) reads every Fansly page, so the legacy executor
// declares no Fansly stream and has no Fansly handler. The planner seeds and
// schedules only the platforms that declare streams
// (`legacyExecutorPlatforms`), the app-level `requestPageSync` refuses a
// platform with none (`LegacySyncRetiredError`), and the owner levers resolve a
// Fansly page's scopes straight to the engine's registry keys
// (`services/sync-engine-levers.ts`).
const ONLYFANS_PULL: Partial<Record<CanonicalStream, ExecutorPullHandler>> = {
  light: onlyfansLightChunk,
  transactions: onlyfansTransactionsChunk,
  fan_identities: executeFanIdentitiesChunk,
  top_spenders: onlyfansTopSpendersChunk,
  subscribers: onlyfansSubscribersChunk,
  dm_conversations: onlyfansDmConversationsChunk,
  posts: onlyfansPostsChunk,
};

export const fanslyPlatformAdapter: AppPlatformAdapter = {
  key: "fansly",
  displayName: "Fansly",
  capabilities: {
    streams: [],
    webhooks: false,
    writes: [],
    presenceSource: "poll",
    billing: "session",
  },
  syncScopes: {},
  pull: {},
  session: {
    kind: "browser_session",
    lifecycle: "Pasted session material; verified on paste (resolvePageContext/verifySession); "
      + "death signal = 401/403 during sync → auth_blocked incident. Capture/refresh mechanics "
      + "deliberately unspecified (owner-flagged custody area).",
  },
};

export const onlyfansPlatformAdapter: AppPlatformAdapter = {
  key: "onlyfans",
  displayName: "OnlyFans",
  capabilities: {
    streams: getSyncStreamsForPlatform("onlyfans"),
    webhooks: true,
    writes: [
      "send_text_message_v1",
      "send_media_message_v1",
      "typing_active_v1",
      "unsend_message_v1",
      "mark_chat_read_v1",
    ],
    presenceSource: "webhook",
    billing: "credit_metered",
  },
  syncScopes: {
    light: ["light", "transactions", "fan_identities"],
    posts: ["posts"],
    data: ["light", "transactions", "fan_identities", "top_spenders", "subscribers"],
    messages: ["dm_conversations"],
    all: [
      "light",
      "transactions",
      "fan_identities",
      "top_spenders",
      "subscribers",
      "dm_conversations",
    ],
  },
  pull: ONLYFANS_PULL,
  session: {
    kind: "api_key",
    lifecycle: "Vendor-held sessions behind the OFAPI gateway (onlyfansapi.com); the kernel "
      + "holds only the vendor API key. Auth death arrives as accounts.authentication_failed "
      + "webhooks → account health incident.",
  },
};

export function createAppPlatformRegistry(): AppPlatformRegistry {
  const adapters = [fanslyPlatformAdapter, onlyfansPlatformAdapter];
  for (const adapter of adapters) {
    const problems = checkAdapterConformance(adapter);
    if (problems.length > 0) {
      throw new Error(`Platform adapter conformance failed:\n${problems.join("\n")}`);
    }
  }
  return createPlatformRegistry(adapters);
}

/** The process-wide registry (pure/stateless — handlers take AppContext).
 * Built eagerly so a conformance failure is a boot failure, not a 500. */
export const appPlatformRegistry: AppPlatformRegistry = createAppPlatformRegistry();

/** The platforms the legacy page-sync executor serves: those whose adapter
 *  declares a stream (OnlyFans since step 4 S4-10). The planner seeds,
 *  schedules and executes page-sync state only for their pages. */
export function legacyExecutorPlatforms(registry: AppPlatformRegistry = appPlatformRegistry): Platform[] {
  return registry.all().filter((adapter) => adapter.capabilities.streams.length > 0).map((adapter) => adapter.key);
}

/** Whether the legacy page-sync executor serves `platform`. */
export function isLegacyExecutorPlatform(
  platform: Platform,
  registry: AppPlatformRegistry = appPlatformRegistry,
): boolean {
  return legacyExecutorPlatforms(registry).includes(platform);
}
