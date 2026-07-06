import {
  checkAdapterConformance,
  createPlatformRegistry,
  type CanonicalStream,
  type PlatformAdapter,
  type PlatformRegistry,
} from "@agency_hub_core/platform-core";

import type { PageSyncLease } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  executeFanEarningsChunk,
  executeFanIdentitiesChunk,
  executeFollowersChunk,
  executeFollowersReconcileChunk,
  executePurchaseHistoryChunk,
  fanslyDmConversationsChunk,
  fanslyDmMessagesChunk,
  fanslyLightChunk,
  fanslySubscribersChunk,
  fanslyTopSpendersChunk,
  fanslyTransactionsChunk,
  onlyfansDmConversationsChunk,
  onlyfansDmMessagesChunk,
  onlyfansLightChunk,
  onlyfansSubscribersChunk,
  onlyfansTopSpendersChunk,
  onlyfansTransactionsChunk,
  type ExecutorRequestContext,
  type StreamChunkResult,
} from "../services/sync/executor-handlers.ts";

// Kernel Stage 18: the two platform adapters, assembled in the app layer
// (pull handlers need AppContext/executor types — platform-core stays
// app-agnostic). Capabilities mirror today's hardcoded per-platform stream
// lists BYTE-FOR-BYTE (parity is test-pinned against
// getSyncStreamsForPlatform until Task 4 swaps the planner onto these).
//
// The pull handlers currently point at the SHARED per-stream chunk functions
// (each still branches by platform internally) — the Tasks 2–3 handler moves
// split those bodies into per-adapter modules behind these same slots,
// keeping every commit green (move-don't-rewrite).

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
 * scope schedules. POLICY, not capability — e.g. Fansly's "all" deliberately
 * excludes the bulk fan_earnings/purchase_history streams (Stage 16: manual
 * sync-all must not fire the heavy crawls). Always a subset of
 * capabilities.streams (pinned by the registry suite). A scope absent from
 * the map is unsupported on that platform (resolveStreamsForScope throws). */
export type SyncScopePolicy = Partial<Record<"light" | "followers" | "all" | "data" | "messages", CanonicalStream[]>>;

export type AppPlatformAdapter = PlatformAdapter<ExecutorPullHandler> & {
  syncScopes: SyncScopePolicy;
};
export type AppPlatformRegistry = PlatformRegistry<AppPlatformAdapter>;

/** Mirrors getSyncStreamsForPlatform("fansly"): every stream but fan_identities. */
const FANSLY_STREAMS: CanonicalStream[] = [
  "light",
  "transactions",
  "top_spenders",
  "subscribers",
  "followers",
  "followers_reconcile",
  "dm_conversations",
  "dm_messages",
  "fan_earnings",
  "purchase_history",
];

/** Mirrors getSyncStreamsForPlatform("onlyfans") (OFAPI-era streams). */
const ONLYFANS_STREAMS: CanonicalStream[] = [
  "light",
  "transactions",
  "fan_identities",
  "top_spenders",
  "subscribers",
  "dm_conversations",
  "dm_messages",
];

// The per-platform pull maps route straight to the split handler halves —
// no platform branch survives on the dispatched path (Stage 18 Tasks 2–3).
const FANSLY_PULL: Partial<Record<CanonicalStream, ExecutorPullHandler>> = {
  light: fanslyLightChunk,
  transactions: fanslyTransactionsChunk,
  top_spenders: fanslyTopSpendersChunk,
  subscribers: fanslySubscribersChunk,
  followers: executeFollowersChunk,
  followers_reconcile: executeFollowersReconcileChunk,
  dm_conversations: fanslyDmConversationsChunk,
  dm_messages: fanslyDmMessagesChunk,
  fan_earnings: executeFanEarningsChunk,
  purchase_history: executePurchaseHistoryChunk,
};

const ONLYFANS_PULL: Partial<Record<CanonicalStream, ExecutorPullHandler>> = {
  light: onlyfansLightChunk,
  transactions: onlyfansTransactionsChunk,
  fan_identities: executeFanIdentitiesChunk,
  top_spenders: onlyfansTopSpendersChunk,
  subscribers: onlyfansSubscribersChunk,
  dm_conversations: onlyfansDmConversationsChunk,
  dm_messages: onlyfansDmMessagesChunk,
};

export const fanslyPlatformAdapter: AppPlatformAdapter = {
  key: "fansly",
  displayName: "Fansly",
  capabilities: {
    streams: FANSLY_STREAMS,
    webhooks: false,
    writes: [],
    presenceSource: "poll",
    billing: "session",
  },
  syncScopes: {
    light: ["light"],
    followers: ["followers"],
    data: ["light", "transactions", "top_spenders", "subscribers", "followers", "followers_reconcile"],
    messages: ["dm_conversations", "dm_messages"],
    all: [
      "light",
      "transactions",
      "top_spenders",
      "subscribers",
      "followers",
      "followers_reconcile",
      "dm_conversations",
      "dm_messages",
    ],
  },
  pull: FANSLY_PULL,
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
    streams: ONLYFANS_STREAMS,
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
    data: ["light", "transactions", "fan_identities", "top_spenders", "subscribers"],
    messages: ["dm_conversations", "dm_messages"],
    all: [
      "light",
      "transactions",
      "fan_identities",
      "top_spenders",
      "subscribers",
      "dm_conversations",
      "dm_messages",
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
