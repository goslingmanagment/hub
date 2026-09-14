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
