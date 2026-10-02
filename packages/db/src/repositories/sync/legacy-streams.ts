import type { SyncStream } from "../page-sync.ts";

// Fansly Sync Engine (design step 3 §3.2 item 6): which legacy sync stream
// each registry key takes over, as the registry's `legacy` refs say
// (`apps/runtime/src/sync/fansly/registry.ts`, `FANSLY_RESOURCE_SPECS[].legacy`,
// streams only — senders have no stream row). The database package cannot
// import the runtime's registry, so its SQL surfaces (the `sync_streams`
// dataset) read this copy; `apps/runtime/src/sync/fansly/legacy-streams.ts`
// derives the same table from the registry and
// `tests/sync-legacy-streams.test.ts` pins the two equal, so neither drifts.

/** Registry key → the legacy streams it takes over, in registry order. */
export const FANSLY_ENGINE_LEGACY_STREAMS: ReadonlyArray<readonly [string, readonly SyncStream[]]> = [
  ["account.poll", ["light"]],
  ["dm-conversations.head", ["dm_conversations"]],
  ["dm-conversations.full", ["dm_conversations"]],
  ["dm-conversations.find", ["dm_conversations"]],
  ["dm-conversations.detail", ["dm_conversations"]],
  ["dm-conversations.ws-down", ["dm_conversations"]],
  ["dm-messages.head", ["dm_messages"]],
  ["dm-messages.catchup", ["dm_messages", "dm_conversations"]],
  ["dm-messages.history", ["dm_messages"]],
  ["transactions.head", ["transactions"]],
  ["transactions.insurance", ["transactions"]],
  ["transactions.rescan", ["transactions"]],
  ["transactions.backfill", ["transactions"]],
  ["top-spenders.window", ["top_spenders"]],
  ["top-spenders.bootstrap", ["top_spenders"]],
  ["fan-earnings.roster", ["fan_earnings"]],
  ["purchases.targets", ["purchase_history"]],
  ["payouts.daily", ["payouts"]],
  ["payouts.walk", ["payouts"]],
  ["subscribers.poll", ["subscribers"]],
  ["subscribers.history", ["subscribers"]],
  ["followers.head", ["followers"]],
  ["followers.reconcile", ["followers_reconcile"]],
  ["fan-profiles.lookup", ["subscribers", "followers", "followers_reconcile"]],
  ["fan-profiles.probe", ["dm_conversations", "dm_messages"]],
  ["notifications.forward", ["notifications"]],
  ["notifications.backfill", ["notifications"]],
  ["posts.refresh", ["posts"]],
  ["posts.backfill", ["posts"]],
  ["posts.engagement", ["posts"]],
  ["post-replies.walk", ["post_replies"]],
  ["post-replies.authors", ["post_replies"]],
  ["catalog.fixed", ["catalog"]],
  ["catalog.vault", ["catalog"]],
  ["catalog.hydrate", ["catalog"]],
  ["media-stats.walk", ["media_stats"]],
  ["stats.daily", ["stats_snapshot"]],
  ["stats.hourly", ["stats_snapshot"]],
  ["stats.backfill", ["stats_snapshot"]],
];

const SQL_SAFE_TOKEN = /^[a-z][a-z0-9_.-]*$/;

/**
 * The table as a SQL `values` list `(resource, stream)` — one row per pair —
 * for a derived table in a code-constant SQL source. Every token is checked
 * against a closed alphabet at module load, so nothing but registry names can
 * reach the text.
 */
export function fanslyEngineLegacyStreamValuesSql(): string {
  const pairs: string[] = [];
  for (const [resource, streams] of FANSLY_ENGINE_LEGACY_STREAMS) {
    for (const stream of streams) {
      if (!SQL_SAFE_TOKEN.test(resource) || !SQL_SAFE_TOKEN.test(stream)) {
        throw new Error(`Not a registry name: ${resource} / ${stream}`);
      }
      pairs.push(`('${resource}', '${stream}')`);
    }
  }
  return `values ${pairs.join(", ")}`;
}
