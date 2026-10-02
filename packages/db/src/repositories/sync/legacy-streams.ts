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

/** The keys of that table whose work carries a subject (a thread, a target, a
 *  fan) rather than the page, in registry order (`ResourceSpec.subject`,
 *  pinned by tests/sync-legacy-streams.test.ts). A page-level key's newest
 *  row is one index step away (`sync_work_key_recent`); a subject-level key's
 *  newest row across all its subjects is not, so the `sync_streams` dataset
 *  reads those keys from the page's recent attempts instead. */
export const FANSLY_ENGINE_SUBJECT_LEVEL_KEYS: readonly string[] = [
  "dm-conversations.find",
  "dm-conversations.detail",
  "dm-messages.head",
  "dm-messages.catchup",
  "dm-messages.history",
  "purchases.targets",
  "fan-profiles.probe",
];

const SQL_SAFE_TOKEN = /^[a-z][a-z0-9_.-]*$/;

function sqlToken(value: string): string {
  if (!SQL_SAFE_TOKEN.test(value)) throw new Error(`Not a registry name: ${value}`);
  return `'${value}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return values.length === 0 ? "'{}'::text[]" : `array[${values.map(sqlToken).join(", ")}]::text[]`;
}

/**
 * The table per legacy stream, as a SQL `values` list
 * `(stream, keys, page_keys, subject_keys)` — one row per stream in order of
 * first appearance, each array in registry order: every key that takes the
 * stream over, then the same keys split into page-level and subject-level
 * ones — for a derived table in a code-constant SQL source. Every token is
 * checked against a closed alphabet at module load, so nothing but registry
 * names can reach the text.
 */
export function fanslyEngineStreamKeysValuesSql(): string {
  const keysByStream = new Map<string, string[]>();
  for (const [resource, streams] of FANSLY_ENGINE_LEGACY_STREAMS) {
    for (const stream of streams) {
      const keys = keysByStream.get(stream) ?? [];
      keys.push(resource);
      keysByStream.set(stream, keys);
    }
  }
  const subjectLevel = new Set(FANSLY_ENGINE_SUBJECT_LEVEL_KEYS);
  const rows = [...keysByStream].map(([stream, keys]) => `(${[
    sqlToken(stream),
    sqlTextArray(keys),
    sqlTextArray(keys.filter((key) => !subjectLevel.has(key))),
    sqlTextArray(keys.filter((key) => subjectLevel.has(key))),
  ].join(", ")})`);
  return `values ${rows.join(",\n         ")}`;
}
