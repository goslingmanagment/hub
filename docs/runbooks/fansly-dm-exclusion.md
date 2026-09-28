# Fansly DM partner exclusion

Decision 327 changes the write after the existing recovery checks: three terminal
message 5xx failures and a captured account lookup that resolves no partner.
It adds no flag, request type or automatic recovery action.

The handler adds `messageSyncExcludedReason` to the current thread metadata only
if the conversation still belongs to the same page and partner. It preserves
the current head, preview, stored-message cursors, coverage and other metadata.
The exclusion and ordinary stream checkpoint reset share the lease-owned
transaction. A removed/rebound thread or lost lease does not receive an exclusion
from the old lookup; the chunk fails and retains its checkpoint.

For a reported exclusion, inspect the existing sync run note and captured
`account_lookup` receipt for that run. A historical lookup is evidence about its
then-current binding, not proof that the partner remains unresolvable now.
Use the Agent Read Plane or connect as `read_only` and run a bounded transaction:

```sql
begin transaction isolation level repeatable read read only;
select current_user, current_setting('transaction_read_only');
select id, platform_account_id, last_message_id, newest_stored_message_id,
       oldest_stored_message_id, stored_message_count, message_coverage_status,
       metadata ->> 'messageSyncExcludedReason' as exclusion_reason, updated_at
from page_dm_threads
where platform_account_id = :page_id and id = :conversation_id;
select stream, state, updated_at
from page_sync_cursors
where page_id = :page_id and stream = 'dm_messages';
rollback;
```

Require `current_user = read_only` and `transaction_read_only = on`. Compare
retained before/after receipts when available; one current snapshot cannot prove
that no earlier writer was overwritten. No production measurement is included
with the implementation's local regression suite.

Deployment and any manual exclusion reset remain separately owner-gated. A code
rollback requires another approved deployment and restores the former stale-row
write risk. Do not clear exclusions or rewind checkpoints merely to test this fix.

## Per-thread breaker

A first-page failure that does not end in exclusion no longer pins or fails
the stream. A thread-attributable provider answer (a terminal HTTP 500 or a
404/4xx; never 401/403/408/429, a Retry-After deadline, a gateway 502/503/504
or any other 5xx, an envelope failure at HTTP 200, or a
transport/proxy/contract/capture failure) records a row in
`page_dm_message_sync_health` and clears the `dm_messages` pin in one
lease-owned transaction. The chunk then continues with other threads under its
normal budgets. The thread backs off 5, 10 and 20 minutes, then is quarantined
for 6 hours from its fourth failure. Once its window lapses it is retried at
most once per chunk, on a single physical attempt; further failing threads
wait for the next chunk. A successful read of the thread clears the row: a
completed ordinary walk, a finished B1 hint walk, or any page of a targeted
backfill.

The stream fails with its ordinary classification and backoff only for
stream-level failures: every failure listed above as not thread-attributable,
a failed breaker write, lease loss, and an outage. An auth (401/403), rate-limit
(429) or Retry-After answer to the partner-account lookup is stream-level too:
the stream fails with that answer and its deadline, before the thread is
deferred and with the pin kept, instead of reading other threads into the same
limit. When two or more other groups of the page have failed since its last
successful message read, the failure is treated as a page-wide outage and
opens no breaker. A walk that already wrote pages keeps its pin and still
fails the stream on a later page: restarting it would stop on its own pages
and hide the gap below them.

A chunk with accepted message reads settles as ordinary progress (failure
streak reset, stream incident resolved). A chunk that read no message page
while a selectable thread still carries breaker failures (deferred by this
chunk or an earlier one, backing off or quarantined) keeps the streak, last
error and incident and claims no progress.

When only threads inside a short backoff window (their first three failures)
remain, the stream sleeps until the earliest `next_retry_at` instead of
completing. An ordinary request (a `dm_conversations` follow-up, the daily
slot, Sync now) wakes it earlier. A B1 WS-hint or AI-accelerator wake (an
`event` request) is not admitted while that request is outstanding, so hint
subjects wait for the window to end, at most 20 minutes; every woken chunk
runs the B1 step first. One thread's three windows keep the request
outstanding about 35 minutes, under the 45-minute `queue_delayed` threshold;
several threads failing in turn can push it past.

A quarantine holds nothing open. Every later failure re-arms it for another
6 hours, so waiting on it would keep the request outstanding for good and shut
B1 out; with head catch-up on, the thread's uncaptured head debt does not
hold the stream either. The chunk completes instead; if it read nothing, it
settles as a quality hold without success, as does any later request that
finds nothing else to read during the quarantine. The stream goes idle, B1
wakes reach it again, and the next ordinary request after the quarantine ends
retries the thread.

While a Fansly row carries failures and its thread is still selectable
(visible, bound to a fan, not excluded), `/health/sync` reports
`dm_messages:coverage_degraded` for the page; a thread retired by exclusion,
hiding or unbinding stops counting, and its row applies again only if the
thread returns. A targeted backfill of a thread inside its window refuses with
`breaker_open`. Inspect rows read-only:

```sql
select conversation_id, failure_count, error_class, last_attempt_at,
       next_retry_at, quarantine_until
from page_dm_message_sync_health
where platform_account_id = :page_id and failure_count > 0;
```
