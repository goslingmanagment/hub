# A0 discrepancy reasons before writes — 12 September

The code computes eleven reasons for a conversation-head difference. Four
specialized shadow counters cover five reason types; six others remain inside
`stateChangesBelowStop`. This explains the loss of diagnostic detail; it does
not establish which reason caused a particular production case.

This is a static diagnosis of the source observed in production as `31b73a96`
at 18:38 UTC. The local source hashes are checked against that exact commit in
[source.json](source.json). No new production read, application change, provider
request, flag change or replay was performed for this report.

## Where detail is lost

`fansly-dm-conversations.ts:565` reads stored rows before applying the page.
At line 823, `diffConversationHead` compares that snapshot with normalized
incoming values. At line 867 the entire reason array reaches the shadow input;
`advanceDmShadow` folds it into counters before the transaction's conversation
writes at line 975. The reason array itself is not retained.

`dm-shadow.ts:28` separately counts `missing_row`, `last_message_id`,
`unread_count` / `last_unread_message_id`, and `conversation_flags`. Every
nonempty reason array also increments `stateChangesBelowStop` once per
conversation observation. Counts do not identify conversations or count
individual reasons; a conversation can have more than one reason.

When a case has a positive state-change counter and all those named counters
are zero, its reason or reasons must be within the following six categories:

| Reason | What the comparison needs |
|---|---|
| `visibility` | Stored `isVisible` versus the sweep's incoming `true`. |
| `unresolved_identity` | Stored metadata versus the partner identity resolved from aggregation and any permitted detail lookup. |
| `message_sync_excluded_reason` | Stored exclusion versus aggregation membership and any budgeted account-resolution result. |
| `subscription_tier_id` | Stored tier versus the conversation's normalized tier or null. |
| `last_message_at` | Stored time versus normalized embedded/detail/repair time, falling back to the stored value. |
| `last_message_sender_id` | Stored sender versus embedded/detail/repair sender, falling back to the stored value. |

`headRollbacksBelowStop` is a separate predicate over the raw provider marker
and previous head. It does not cover every `last_message_at` change. Zero
rollbacks therefore do not remove timestamp changes from this set. Likewise,
material, invalid-marker and history counters are separate from these reasons.

## What retained evidence can establish

The [four additional cases](
../../fansly-c1-deploy-2026-09-11/followup-20260912T183741Z/a0-case-comparison/REPORT.md)
each have one generic state change and no named head-ID, unread, flags or
rollback change. Their comparable retained sweeps contain no raw metadata
change below the stop. That comparison uses consecutive provider responses;
the runtime comparison uses the database row before applying this page.

Retained raw head metadata can compare tier, timestamp and sender across
provider responses. It does not recover the database's earlier visibility,
metadata or effective head, nor the entire sequence of detail/repair lookups
and budget decisions. Reading the current row cannot recover that earlier
comparison either. The saved version-1 shadow state contains bounded scalars,
with no reason array or conversation IDs (`dm-shadow-state.ts:13`).

The combined evidence therefore leaves eleven raw-unchanged cases unresolved;
it does not turn them into false positives. The earlier two retained flags
transitions and three unavailable reconstructions remain separate. These are
runtime case observations, not a count of distinct conversations or messages.

## Ruled-out attribution and remaining work

The generic repository's forward-only head guard applies only when
`headForwardOnly === true` (`page-dm.ts:224`). The Fansly sweep's call at
`fansly-dm-conversations.ts:975` does not pass that option. That conditional
guard cannot explain these cases as proposals rejected by this writer.
Other concurrent writers and provider-side deletion have not been attributed
to any of these eleven cases.

The existing shadow stop and legacy business streak remain separate; this
diagnosis does not justify changing either predicate. More copies of the same
aggregate report cannot recover the missing historical reasons. Future reason
telemetry would require a focused, reviewed A0 follow-up; old records without
it must remain unknown. No telemetry design or extra stage PR is introduced here.

The safe-stop gate remains open, regardless of the seven-day calendar point.
Savings, fresh-event latency and deletion repair are not established by this
diagnosis. Independent review is recorded in [REVIEW.md](REVIEW.md).
