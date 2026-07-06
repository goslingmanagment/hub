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
  executeDmConversationsChunk,
  executeDmMessagesChunk,
  executeFanEarningsChunk,
  executeFanIdentitiesChunk,
  executeFollowersChunk,
  executeFollowersReconcileChunk,
  executeLightChunk,
  executePurchaseHistoryChunk,
  executeSubscribersChunk,
  executeTopSpendersChunk,
  executeTransactionsChunk,
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

export type AppPlatformAdapter = PlatformAdapter<ExecutorPullHandler>;
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

function pullHandlers(streams: CanonicalStream[]): Partial<Record<CanonicalStream, ExecutorPullHandler>> {
  const byStream: Record<CanonicalStream, ExecutorPullHandler> = {
    light: executeLightChunk,
    fan_identities: executeFanIdentitiesChunk,
    transactions: executeTransactionsChunk,
    top_spenders: executeTopSpendersChunk,
    subscribers: executeSubscribersChunk,
    followers: executeFollowersChunk,
    followers_reconcile: executeFollowersReconcileChunk,
    dm_conversations: executeDmConversationsChunk,
    dm_messages: executeDmMessagesChunk,
    fan_earnings: executeFanEarningsChunk,
    purchase_history: executePurchaseHistoryChunk,
  };
  return Object.fromEntries(streams.map((stream) => [stream, byStream[stream]]));
}

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
  pull: pullHandlers(FANSLY_STREAMS),
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
  pull: pullHandlers(ONLYFANS_STREAMS),
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
