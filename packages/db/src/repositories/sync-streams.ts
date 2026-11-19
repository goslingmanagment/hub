// The `sync_stream` vocabulary: every value of the database enum. Rows of
// `page_sync_states`, `page_sync_cursors`, `sync_runs` and their telemetry
// carry these names for good, so the type keeps them all. The legacy
// page-sync executor runs only `LEGACY_EXECUTOR_STREAMS` (page-sync.ts); the other
// names are records of the Fansly lanes it ran until step 4 and the names the
// Fansly Sync Engine's status surfaces and levers still address its registry
// keys by (`apps/runtime/src/sync/fansly/registry.ts`, the lever map).
export const SYNC_STREAMS = [
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
  "media_stats",
] as const;

export type SyncStream = typeof SYNC_STREAMS[number];
