# @agency_hub_core/platform-core

The platform adapter seam (kernel Stage 18, target §4.1). A platform
integration implements `PlatformAdapter` and registers through
`createPlatformRegistry` — the app layer assembles adapters (handlers need
app-layer types), the registry replaces `AppContext.adapter` /
`onlyFansAdapter`, and strict `platform ===` branches ratchet to ~0
(`scripts/check-platform-branches.mjs`).

## Adding platform #3 (the litmus — target §4.4)

1. New adapter package/module implementing `PlatformAdapter` (pull handlers
   for its capability streams, custody descriptor).
2. A `platforms` reference-table row (key, display name, adapter version).
3. Credential UI for its custody kind.

No migration across fact tables, no new branch sites.

## Stream vocabulary

`capabilities.streams` deliberately uses TODAY'S sync-stream names — the
planner emits byte-identical sets and the DB `sync_stream` enum speaks them.
The target's canonical renames map as: light→account, subscribers→
subscriptions, dm_conversations→conversations, dm_messages→messages,
followers(+_reconcile)→followers, fan_identities→(onlyfans identity refs);
presence is webhook-fed (no pull stream). That rename is a separate, later
migration.
