> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Capture and Canonicalization

This map follows facts from durable capture into the per-account domain-event
ledger and its immediate projections. The central rule is capture first:
provider and client inputs are journaled before interpretation, while
canonicalization is replayable and versioned.

## 1. Durable observations

`packages/db/src/repositories/observations.ts` is the write/read seam for the
partitioned `observations` journal. Producers supply a source, producer stamp,
kind, raw payload, payload hash, and idempotency key; account, platform,
observed time, actor, and native account reference are optional metadata. The
repository uses an idempotency claim before inserting the journal row. A
duplicate returns the original row's exact `(id, received_at)` pair, just as a
new insert does, so immediate projectors can stamp the right partitioned row.

Observation inserts and claims are transaction-coupled. Callers that wrap a
batch in one database transaction either persist every claim and row or none.
`packages/db/migrations/0082_w8_future_catchall_partitions.sql`
adds catch-all partitions beginning at 2031; runtime partition pre-creation
therefore stops at that boundary rather than overlapping it.

The journal has two independent replay coordinates:

- `parse_version` records which canonicalizer version has consumed a row.
- `(id, received_at)` addresses the exact row across time partitions.

An unmapped fact may remain in the journal with a null account. It is retained
without being allowed to mint an account-scoped domain event.

## 2. Capture producers

The main writers are visible at these boundaries:

| Source | Producer path | Captured material |
|---|---|---|
| `webhook` | `apps/runtime/src/services/ofapi-webhooks.ts` | signed OFAPI deliveries, before projection |
| `pull` | `apps/runtime/src/services/sync/executor-handlers.ts` | successful raw sync responses and best-effort failed-fetch records |
| `command_result` | `apps/runtime/src/services/ofapi-command-executor.ts` | each terminal command outcome |
| `client_capture` | `apps/runtime/src/services/ingest-observations.ts` | desktop telemetry and one-time harvested local tables |
| read-gateway capture | `apps/runtime/src/services/ofapi-read-gateway-capture.ts` | successful proxied reads; chat-message v2 envelopes feed a dedicated projector |
| repair producer | `apps/runtime/src/services/observations-rejournal.ts` | bounded replacement observations for historical observation-key collisions |

`apps/runtime/src/services/observations-rejournal.ts` is append-only repair,
not an in-place rewrite. Producer `rejournal:a22` re-journals affected sync
facts in its bounded incident window under non-colliding keys; canonical event
deduplication decides whether they add new truth.

## 3. Client capture and harvest trust boundary

`POST /api/v1/ingest/observations` is registered in
`apps/runtime/src/modules/ingest/index.ts` and implemented by
`apps/runtime/src/services/ingest-observations.ts`.

The live allowlist is `ai_acceptance`, `guard_audit`, `send_audit`, `ai_spend`,
`credit_spend`, and `data_purge_notice`. Allowed kinds are stored as
`desktop.<kind>`; everything else becomes `desktop.unknown:<kind>` instead of
being discarded. An unknown or out-of-scope page label is likewise captured
with a null account.

The harvest namespace accepts only these producer-gated kinds:
`harvest.messages`, `harvest.fan_transactions`, `harvest.outbox`,
`harvest.message_guard_events`, `harvest.usage_events`,
`harvest.ai_spend_log`, and `harvest.credit_log`. A `harvest-*` client version
must reach the route through `requireHarvestDeviceToken`. The server derives
the authorized machine id from that device token, and every trusted harvest
payload must carry the same `machineId`.

Normal client events deduplicate on
`<principalUserId>:<clientEventId>`. Trusted harvest events deduplicate on
`<authorizedMachineId>:<clientEventId>`, making retries stable across user
principals. `hasHarvestObservationClientEvent` also recognizes legacy
principal-keyed harvest rows through the expression index introduced by
`packages/db/migrations/0090_device_token_harvest_capability.sql`.
All `observedAt` values and all harvest machine bindings are validated before
the transaction begins; the request batch is atomic.

## 4. Canonicalization sweep

`apps/runtime/src/services/canonicalize-driver.ts` owns queue
`canonicalize.sweep`, scheduled every minute. For each family it reads rows
below that family's parse-version floor, runs a pure canonicalizer, appends
drafts to the domain-event ledger, and only then stamps the observation. A
failed row is logged and left below the floor, while later rows in the same
page continue.

The scheduled worker scans 200 rows per page and at most 20 pages per family.
Its in-memory per-family cursor resumes after the last bounded sweep and wraps
to the head at the end, so poison or temporarily unmapped rows are retried once
per full cycle without starving newer rows. Filtered CLI replay is deliberately
cursor-free and deterministic.

Canonical event timestamps are constrained in this driver. Dates before
2024-01-01, more than two months in the future, or invalid dates fall back to
the observation's `received_at`. The event data records
`occurredAtClamped: true` and the original value in `occurredAtRaw`. The
canonicalizer builds the dedup key before clamping, so replay identity does not
change.

### Canonicalizer registry

`apps/runtime/src/services/canonicalize/index.ts` currently declares four
families:

| Source | Version | Implementation | Result |
|---|---:|---|---|
| `webhook` | 3 | `canonicalize/ofapi-webhook.ts` | OFAPI messages, PPV unlocks, tips, transactions, subscriptions, presence, and auth |
| `pull` | 3 | `canonicalize/sync-pull.ts` | pulled transactions, DMs, earnings, purchase history, and PPV unlocks |
| `command_result` | 1 | `canonicalize/command-result.ts` | every `command.<state>` becomes `command.settled` |
| `client_capture` | 2 | `canonicalize/client-capture.ts` | trusted `harvest.messages` becomes message facts; other declared desktop/harvest kinds validate and stamp with no domain event |

Webhook renewal deliveries map to `subscription.renewed`. PPV unlock mapping
uses `notificationChatId` and `extractMessageIdFromNotification` from
`apps/runtime/src/services/ofapi-payloads.ts`; it does not treat a top-level
creator `user_id` as the fan conversation. Fansly DM timestamps in the pull
family pass through the epoch-seconds-aware `asFanslyTimestamp` helper.

Harvested messages intentionally reuse the live message keys
`msg:<direction>:<messageId>` and `msg:deleted:<messageId>`. Existing live facts
therefore collapse while pre-capture history can append. Harvested transaction
rows remain observation-only; their reconciliation truth is the transaction
table, not synthetic historical domain events.

## 5. Domain-event append protocol

`packages/db/src/repositories/domain-events.ts` owns
`appendDomainEvents`. In one transaction it locks the account's
`domain_event_seq` row `FOR UPDATE`, claims each content dedup key, allocates
sequence numbers through that counter, and inserts events without gaps. A
deduplicated input returns the existing event id in the append outcome. The
corrections reconciler uses that outcome to retain lineage even when another
producer already emitted the same material fact.

The canonical vocabulary emitted at this commit is:

- `message.received`, `message.sent`, `message.deleted`,
  `message.ppv_unlocked`
- `tip.received`, `transaction.posted`, `fan.earnings_observed`
- `subscription.started`, `subscription.renewed`, `subscription.ended`
- `presence.online`, `presence.offline`
- `account.auth_changed`, `command.settled`

Identity references and payload detail stay in event columns/data; the type is
the stable behavioral vocabulary. Replay queries can be bounded through an
explicit `throughSeq`, which streaming uses to preserve a captured replay
ceiling.

## 6. Projectors and corrections

`apps/runtime/src/services/projections/message-archive.ts`,
`fan-earnings.ts`, and `ai-acceptance.ts` consume domain events behind their
own durable projection cursors. Message archive consumes received, sent, and
deleted messages. A schema-v2 superseding message event carries a complete
`data.head`; the projector replaces material from that head rather than
merging a partial historical payload.

Wave-2 DM convergence is centered on
`packages/db/src/repositories/dm-message-candidate.ts`. Webhook archive,
readthrough REST reconciliation, and confirmed commands reduce candidates
under a row lock with an erasure fence and source-aware field precedence.
`apps/runtime/src/services/dm-corrections-reconciler.ts` compares material and
emitted fingerprints. A mismatch emits a schema-v2 `message.received` or
`message.sent` event with `supersedesEventId`, fingerprint, and complete head,
then advances the emitted fingerprint. Rows without defensible source lineage
remain pending rather than receiving invented lineage.

Two bounded repair paths use supersession rather than mutation:

- `apps/runtime/src/services/fansly-1970-repair.ts` repairs historical Fansly
  message events whose seconds timestamps had been interpreted as milliseconds.
- `apps/runtime/src/services/projections/message-archive-rebuild.ts` preflights retained
  event coverage, builds a shadow archive from events plus allowed backfills,
  verifies it, and switches tables under an advisory lock; migration 0083
  supplies the shadow table.

## 7. Operational invariants

- Capture idempotency and domain-event content deduplication are separate
  layers; a repaired observation can be new while its event is already known.
- Observations with event drafts but no mapped account are not stamped, so a
  later account mapping can make them projectable.
- Empty canonicalization is a valid result and stamps the row for declared
  validation-only kinds.
- Parse-version bumps are the replay mechanism; canonicalizers must remain
  total and deterministic for retained payloads.
- Canonical events are append-only. Corrections supersede old material and
  retain the old event as lineage.
