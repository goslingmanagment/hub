# Fansly WS + REST reliability repair

Decisions 383–387; plans and independent Fable review:
`docs/plans/2026-09-22-fansly-reliability/`.

## Deployment boundary

This branch changes code and adds migration 0206. It does not deploy, enable
flags, repin production policy, reset a watermark or recover historical rows.
Production rollout follows the ordinary owner-approved deploy procedure. Test
and observe one page before widening an operational intervention. Preserve the
existing B0/B1 gates, full cadence and 24-hour attempt budget.

0206 is additive and an older binary can keep writing the old columns. A code
rollback leaves new receipt evidence readable; old code can again repeat reads
for deleted targets. Disable B1 through the existing switch if containment is
needed. Keep raw observations and attempt accounting intact.

## Generation repair (retired)

The checked repin `fansly:ws-policy` (status, preview, apply), its `fanslyWsHints`
diagnostic in the sync blocks and the dashboard's "Event-driven refresh paused"
line are deleted (step 4, S4-12): every Fansly page runs on the Sync Engine,
which routes the socket's demand itself and never consults a B1 policy.

## Settlement and failure checks

```sql
select page_id, settlement_kind, count(*)
from fansly_ws_hint_status where received_at >= now() - interval '24 hours'
group by page_id, settlement_kind;

select page_id, subject_ref, last_refresh_outcome, consecutive_failures,
       next_due_at, retry_after_at, requested_revision, applied_revision
from subject_refresh_state where plane = 'fansly_ws_dm'
order by page_id, subject_ref;
```

A prior hot_applied_at remains materialization evidence even if the message is later deleted.
source_deleted means an exact retained delete settled the operational target
following a contiguous REST walk. It does not mean the message was stored in the
business archive; hot_applied_at stays null for a deleted-only target. Its
settlement_observation_id points to retained deletion evidence. Mutation receipts
stay mutation_debt; applying them to stored messages is described under
[Platform deletions](#platform-deletions).

A terminal transport/timeout event for the admitted B1 request records
`target_transport`/`target_timeout` and retries after 60 seconds, then 120, up to
one hour. A missing target without exact deletion evidence still uses the existing
one-minute target_unconfirmed retry, bounded by the unchanged 24-hour cap. Auth, 429/Retry-After, policy cancellation and storage/telemetry errors
retain shared executor behavior. New R+1 preserves retry_after_at. Hint-only
runs never certify ordinary freshness or resolve its incidents. Attempt counts
are not refunded or reset across policy generations.

A spent 24-hour cap is checked before any B1 request is prepared: the claimed
subject records `budget_exhausted` and retries when enough counted attempts age
out of the window, without a pacer slot or a consecutive_failures increment,
and no event-only DM run is woken for it until then. Subjects
deferred to the same reopening are claimed in the order they were refused
(`last_visited_at`), so a saturated page serves its backlog first in, first
out rather than by group id. Other refusals before dispatch (policy disabled or
expired, type disabled) also leave consecutive_failures unchanged.

A0 full scans after bounded scans must retain the prior certified completion in
diagnostics.boundaryMs. Inspect complete/incomplete status and below-stop
witnesses together; green deployment or a complete A0 report alone is not a
whole-archive preservation proof.

## Six retained-only Ari targets

The exact input is `docs/plans/2026-09-22-fansly-reliability/ari-recovery-targets.json`.
It identifies the six observations/messages independently checked in the
September 21 audit. Their live reader state can change; regenerate the manifest:

```sh
pnpm --silent cli fansly:ws-recovery-manifest \
  --input docs/plans/2026-09-22-fansly-reliability/ari-recovery-targets.json
```

The command uses a read-only transaction, at most 20 exact targets, the envelope
payload reader, canonical reader precedence and the existing owner-erasure
fence. Output contains text length and envelope hash and provenance, never text. Missing
receipts, unavailable bodies, uncertain binding and owner erasure are explicit.
Custody is the stored expected identity, not fabricated account verification.
Later source mutations remain distinct from materialization/tombstones in the
reader. A manifest is a current inspection, not reusable write authorization.

There is no supported WS-to-message_archive projector for message material in
this code (deletion marks on already stored rows are separate, see below). The
six rows are not claimed recovered. A separate B2 change must define native sender/fan
identity for groups absent from REST, source-event deduplication/provenance,
tombstone ordering, owner-erasure fencing and replay before applying a reviewed
production recovery. Do not create a fake visible REST thread to bypass it.

## Platform deletions

A Fansly DM deletion reported by the account socket (serviceId 5, event type
10) marks the copies Hub already holds as deleted: `page_dm_messages.deleted_at`
and `message_archive.deleted_at`. Text, attachments, tips and reply refs stay.
Nothing is inserted: a message deleted before Hub captured it stays absent.

Since step 4 (S4-11) the Fansly Sync Engine is the only writer of these marks.
The socket frame's ack records the deletion in the live overlay, and the page's
`dm-live.deletions` work (no request) marks the hot rows, appends one
`message.deleted` event and tombstones the archive from it (tombstone-first: a
row that reaches the archive later keeps the mark); the engine recomputes the
thread window. See `apps/runtime/src/sync/README.md`.

Deletions from before that were exact `mutation_debt` receipts that the retired
ws-hints projector filed in `fansly_ws_hint_receipts` and a minutely reconcile
applied: a receipt with a known generation and native group whose group matches
the stored thread, dated by the earliest receipt, never expanded from a
correlation or bulk marker. The receipts stay as records. No event carries
those marks, so the archive shadow rebuild re-applies them; erasure removes them
with the fan's rows.

Readers keep their existing deleted-row behavior. The desktop/dashboard
conversation view, thread windows (stored count, newest/oldest ids) and AI
context skip deleted rows, as they do for OnlyFans tombstones. Agent Read
transcripts return the row with `state: "deleted"`, `deletedAt` and its text
(`includeDeleted` defaults to true); Agent Read search and the dashboard
archive search return the hit with `deletedAt`; the person timeline shows it as
`message.deleted`. A later REST read of the message does not clear a mark.

Exception, the thread head: its id, time and preview stay with the Fansly
conversation list, their only writer, and that list can keep naming a deleted
message as the head (13 threads in production on 2026-09-28, rewritten by
list scans days after the deletion). The inbox preview of such a thread keeps
showing the deleted text, unmarked, while the conversation view hides the
message. A stored head that is marked still counts as captured, so it opens no
head debt.

Rollback: marks persist after a code rollback. The marked rows stay hidden
from the conversation view, the thread windows and the AI context, and stay
frozen: `upsertPageDmMessages` never refreshes a marked row, and no code path
unmarks one. Rolling back code therefore does not undo wrong marks; they would
need a separate, owner-approved unmark repair, which does not exist.

```sql
select p.label, count(*) filter (where m.deleted_at is not null) as marked_hot
from page_dm_messages m join pages p on p.id = m.platform_account_id
where p.platform = 'fansly' group by p.label;
```
