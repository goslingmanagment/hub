// Kernel Stage 18: the platform adapter seam (target §4.1). A platform
// integration is a package/module implementing PlatformAdapter, resolved
// through the registry — replacing the two hand-mirrored adapter classes
// behind inverted names and the ~57 strict `platform ===` branch sites.
//
// STREAM VOCABULARY (recorded execution decision): capabilities.streams uses
// TODAY'S sync-stream names (light, dm_conversations, …) because the
// capability-driven planner must emit byte-identical stream sets and the DB
// `sync_stream` enum speaks these names. The target's canonical renames
// (account, conversations, messages, …) are a separate, later migration —
// mapping documented in this package's README.

import type { Platform } from "@agency_hub_core/shared";

/** Today's sync-engine stream vocabulary (mirrors db SYNC_STREAMS — the
 * conformance suite pins the two lists equal so they cannot drift). */
export const PLATFORM_STREAMS = [
  "light",
  "fan_identities",
  "transactions",
  "top_spenders",
  "subscribers",
  "followers",
  "followers_reconcile",
  "dm_conversations",
  "dm_messages",
  "fan_earnings",
  "purchase_history",
  "posts",
  "stats_snapshot",
  "notifications",
  "catalog",
  "post_replies",
  "payouts",
] as const;

export type CanonicalStream = (typeof PLATFORM_STREAMS)[number];

/** Command kinds a platform accepts through the outbox (adapter-declared). */
export type PlatformCommandKind = string;

export interface PlatformCapabilities {
  /** Which streams this platform's pull sync serves (drives the planner). */
  streams: CanonicalStream[];
  webhooks: boolean;
  /** Empty for read-only platforms. */
  writes: PlatformCommandKind[];
  presenceSource: "webhook" | "poll" | "none";
  /** Drives pacing/budget wiring (Stage 26 consumes this). */
  billing: "credit_metered" | "flat" | "session";
}

/**
 * Declares WHAT KIND of credential a platform needs and its lifecycle —
 * deliberately not HOW session material is captured or moved (owner-flagged
 * security design area; kernel storage contract unchanged: AES-256-GCM
 * envelope, versioned key ring).
 */
export interface SessionCustodyDescriptor {
  kind: "api_key" | "browser_session" | "oauth";
  /** Human-readable lifecycle notes (verify/paste/death-signal seams). */
  lifecycle: string;
}

/**
 * One bounded-chunk pull handler per stream. The handler SIGNATURE is owned
 * by the sync engine (executor input/result types live in apps/runtime) —
 * platform-core stays app-agnostic by taking the whole handler type as the
 * adapter's generic parameter; adapters are assembled in the app layer.
 */
export type AnyPullHandler = (...args: never[]) => Promise<unknown>;

export interface PlatformAdapter<TPullHandler extends AnyPullHandler = AnyPullHandler> {
  readonly key: Platform;
  readonly displayName: string;
  readonly capabilities: PlatformCapabilities;

  /** One bounded-chunk handler per capability stream. The conformance suite
   * asserts every declared stream has a handler and vice versa. */
  pull: Partial<Record<CanonicalStream, TPullHandler>>;

  session: SessionCustodyDescriptor;
}

export interface PlatformRegistry<TAdapter extends PlatformAdapter = PlatformAdapter> {
  get(key: string): TAdapter;
  maybeGet(key: string): TAdapter | undefined;
  keys(): Platform[];
  all(): TAdapter[];
}

export function createPlatformRegistry<TAdapter extends PlatformAdapter>(
  adapters: readonly TAdapter[],
): PlatformRegistry<TAdapter> {
  const byKey = new Map<string, TAdapter>();
  for (const adapter of adapters) {
    if (byKey.has(adapter.key)) {
      throw new Error(`Duplicate platform adapter "${adapter.key}"`);
    }
    byKey.set(adapter.key, adapter);
  }
  return {
    get(key) {
      const adapter = byKey.get(key);
      if (!adapter) {
        throw new Error(`Unknown platform "${key}" (registered: ${[...byKey.keys()].join(", ")})`);
      }
      return adapter;
    },
    maybeGet: (key) => byKey.get(key),
    keys: () => [...byKey.keys()] as Platform[],
    all: () => [...byKey.values()],
  };
}

/**
 * Adapter-interface conformance: every declared capability stream has a pull
 * handler, and no handler exists for an undeclared stream. Returns human
 * mismatches; the conformance test asserts [].
 */
export function checkAdapterConformance(adapter: PlatformAdapter): string[] {
  const problems: string[] = [];
  const declared = new Set(adapter.capabilities.streams);
  for (const stream of adapter.capabilities.streams) {
    if (adapter.pull[stream] === undefined) {
      problems.push(`${adapter.key}: declared stream "${stream}" has no pull handler`);
    }
  }
  for (const stream of Object.keys(adapter.pull) as CanonicalStream[]) {
    if (adapter.pull[stream] !== undefined && !declared.has(stream)) {
      problems.push(`${adapter.key}: pull handler for undeclared stream "${stream}"`);
    }
  }
  return problems;
}

export {
  EGRESS_PRIORITY_CLASSES,
  egressScopeKey,
  type EgressContext,
  type EgressPriorityClass,
  type EgressResolver,
  type EgressScope,
} from "./egress.ts";
