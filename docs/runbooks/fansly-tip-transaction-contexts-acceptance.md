# Fansly tip transaction context — post-deploy acceptance

This is the production gate for decision #211. It verifies the exact bridge
from a Fansly ledger tip to the optional note and request-scoped conversation
captured in the `/message` response sidecar. It does **not** infer a concrete
message ref from timestamp, amount, target id or conversation membership.

Run these checks after migration 0122 and the matching runtime/Agent contract
are deployed. Treat `1000` mills as `$1`; never print fan-written notes or fan
ids in deployment logs.

## 1. Migration and retention safety

```sql
select to_regclass('public.transaction_tip_contexts') as context_table;
select to_regclass('public.sync_raw_payloads_dm_tip_context_backfill_idx') as backfill_index;

select conname, pg_get_constraintdef(oid, true) as definition
from pg_constraint
where conrelid = 'transaction_tip_contexts'::regclass
  and conname in (
    'transaction_tip_contexts_source_raw_payload_id_fkey',
    'transaction_tip_contexts_tip_message_source_raw_payload_id_fkey',
    'transaction_tip_contexts_tip_message_lineage_check'
  )
order by conname;
```

Acceptance: the table and partial raw keyset index exist; both raw-payload FKs
are nullable with `ON DELETE SET NULL`; and the note-lineage check requires a
capture time whenever note text is present. A restricted/non-null FK would
eventually block ordinary `sync_raw_payloads` retention cleanup.

## 2. Replay retained raw once

Run the deterministic keyset backfill in the deployed API container:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml \
  exec -T api node apps/runtime/dist/cli.js tip-contexts:backfill
```

The command freezes and prints one `rawHighWaterId`, finishes with exit code
zero, and reports bounded counts only, including `conversationConflicts` and
`contextsErasureFenced`. Conversation conflicts must be zero. A conflict means
one native tip id appeared under two request-scoped conversations and must be
investigated from owner-only raw rather than resolved by arrival order. An
erasure-fenced row is an intentional terminal skip and may be non-zero only
when the matching scope has already been erased. The command may be rerun:
`(account_id, platform_tip_id)` is unique and upserts are idempotent. A deferred
erasure race has no successful-result counter: it fails the run without
advancing past the affected raw row, as does a DB error. The emitted boundary
error must be static and contain no note, group id, provider tip id or SQL
parameters. Malformed sidecar members are counted/skipped without discarding
valid siblings.

## 3. Exactness and coverage census

```sql
select p.label,
       count(*) as active_tip_transactions,
       count(ttc.id) as exact_contexts,
       count(*) filter (where ttc.id is null) as context_gaps,
       count(ttc.id) filter (where ttc.tip_message_text is not null) as supplied_notes,
       count(ttc.id) filter (where ttc.tip_message_text = '') as supplied_empty_notes,
       min(ttc.captured_at) as first_context_capture,
       max(ttc.captured_at) as last_context_capture
from transactions tr
join pages p on p.id = tr.platform_account_id
left join transaction_tip_contexts ttc
  on ttc.account_id = tr.platform_account_id
 and ttc.platform_tip_id = tr.correlation_id
where tr.is_active is true
  and tr.canonical_type = 'tip'
group by p.label
order by p.label;
```

OnlyFans tip rows should remain in the census with zero exact contexts; that is
an unsupported capture lane, not evidence that no tips exist. Fansly gaps are
reported, not synthesized. Retained raw can close only rows whose relevant DM
page was captured and has not expired.

For every still-retained lineage row, prove both provider tip id and request
conversation directly from its raw source:

```sql
select count(*) as invalid_exact_bridges
from transaction_tip_contexts ttc
join sync_raw_payloads rp on rp.id = ttc.source_raw_payload_id
where rp.request_params ->> 'groupId' is distinct from ttc.captured_conversation_ref
   or not exists (
     select 1
     from jsonb_array_elements(
       case when jsonb_typeof(rp.response_payload -> 'tips') = 'array'
         then rp.response_payload -> 'tips' else '[]'::jsonb end
     ) tip
     where tip ->> 'id' = ttc.platform_tip_id
   );
```

Acceptance: `invalid_exact_bridges = 0`.

```sql
select count(*) as invalid_note_lineage
from transaction_tip_contexts ttc
join sync_raw_payloads rp
  on rp.id = ttc.tip_message_source_raw_payload_id
where ttc.tip_message_text is not null
  and not exists (
    select 1
    from jsonb_array_elements(
      case when jsonb_typeof(rp.response_payload -> 'tips') = 'array'
        then rp.response_payload -> 'tips' else '[]'::jsonb end
    ) tip
    where tip ->> 'id' = ttc.platform_tip_id
      and tip ->> 'message' is not distinct from ttc.tip_message_text
  );
```

Acceptance: `invalid_note_lineage = 0`. This query deliberately joins the
note-specific raw source, not the row-identity source; a later sparse sighting
must never claim provenance for text it did not contain.

Also inspect non-null corroborating facts without turning a mismatch into a
guessed correction:

```sql
select count(*) filter (
         where ttc.tip_amount_mills is not null
           and ttc.tip_amount_mills <> tr.gross_amount_mills
       ) as amount_mismatches,
       count(*) filter (
         where ttc.sender_platform_user_id is not null
           and f.platform_user_id is not null
           and ttc.sender_platform_user_id <> f.platform_user_id
       ) as sender_mismatches
from transaction_tip_contexts ttc
join transactions tr
  on tr.platform_account_id = ttc.account_id
 and tr.correlation_id = ttc.platform_tip_id
 and tr.is_active is true
left join fans f on f.id = tr.fan_id;
```

Investigate any mismatch from owner-only raw. Do not repair it by nearest time,
equal amount or target-type heuristics.

## 4. Erasure-fence safety

The integration gate must cover all three Stage-28 scopes before production:

- fan erasure deletes rows matching captured sender, receiver or conversation;
- page/model erasure deletes all rows for the resolved account ids;
- a writer racing an actively locked erasure returns `deferred`, while a
  payload at or before any executed/non-dry-run tombstone returns terminal
  `erasure_fenced` and cannot resurrect the row from retained raw, including
  when the erasure attempt itself died mid-flight.

The writer's material time is the earlier of provider `occurredAt` and Hub
`capturedAt`, so both values are mandatory for materialization. Do not execute a
real erasure merely as a production smoke test; verify the shipped integration
test result and confirm that the normal backfill completes instead of raising
the static deferred-writer failure.

## 5. Agent read smoke and disclosure gate

Start with `hub capabilities --pretty`. Acceptance requires:

- `tip_transactions` is available on both platforms and requires exactly
  `read:datasets`, `read:money`, `read:messages`;
- ordinary `transactions` exposes `correlationRef` while retaining the legacy
  `relatedMessageRef` alias; neither is described as a message ref;
- a key without `read:messages` receives 403 before SQL/audit disclosure;
- successful `tip_transactions` reads are audited as verbatim text reads.

Use a bounded window and do not print the actual note during deploy acceptance:

```sh
hub dataset --page-label lora-1 --dataset tip_transactions \
  --from 2026-07-27T00:00:00Z --to 2026-08-02T00:00:00Z \
  --claim-field contextState --claim-field capturedConversationRef \
  --claim-field tipMessageText --limit 20 \
  | jq '{returned: .delivery.returned,
         contextStates: [.items[].fields.contextState],
         noteStates: [.items[].fieldStates.tipMessageText.state],
         gapKinds: [.capture.gaps[].kind]}'
```

The reduction is mandatory in deployment logs; do not print the unredacted
response. Check only counts/states there.
A captured null note has row state `source_did_not_provide`; a captured empty
string has `observed_empty`; a missing Fansly context has `not_captured` plus an
`internal_capture_gap` and recapture remedy. The gap must remain visible when a
filter removes the missing row and when no claim fields are declared. OnlyFans
rows have `not_captured` context fields but do not create a Fansly-lane gap.

There is deliberately no `messageRef` acceptance check. `capturedConversationRef`
proves only which request-scoped conversation carried the sidecar. Reading one
message plus neighbours remains a separate future operation.
