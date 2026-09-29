# Fansly provider cooldown

`rate_limit` and `provider_5xx` streams retain a future `retry_at` when new work
arrives. `request_seq`, the latest request source and payload can advance while
the stream remains `retrying`. This is queued work waiting for its provider
deadline, not a lost request. Ordinary and targeted leases obey that deadline.

Retry-After is an absolute lower bound. The local backoff may move it later;
the local 30-minute ladder cap never shortens a longer provider deadline.
Manual requests still supersede ordinary transport/yield backoff and expired
provider cooldowns. The persisted retry class does not distinguish a provider
header from the same class's local ladder; both are protected. This shared
queue guard also applies to the same retry classes on OFAPI streams; the
long-cooldown incident rule below is Fansly-specific.

A Fansly 429/5xx with an explicit retry deadline more than 30 minutes away opens
the existing stream incident on its first failure, with the retry time in the
message. Existing incident deduplication and successful-chunk recovery remain.
No new flag or notification destination is introduced.

## Page hold after a Fansly 429

A 429 speaks for the page's session, not one endpoint, so it also holds the
whole page: a row in `page_sync_provider_holds` (0219).

- A 429 with a future Retry-After holds the page until exactly that instant,
  whatever the stream's failure streak (a 5xx before it, or an earlier hold
  that has passed). There is no cap: the failing stream itself waits the whole
  deadline, so its siblings never resume sooner.
- The first 429 of a stream's streak (its `consecutive_failures` was 0) holds
  the page at least 120 s, and exactly 120 s when it named no deadline. A later
  429 without a deadline backs off only that stream.
- A 5xx with a Retry-After never holds the page.

A hold is only ever extended, never shortened. While `hold_until` is in the
future, no stream of the page is leased (regular chunk, Sync now, B1 wake,
targeted thread backfill) and the AI fast lane stays off it. The failing stream
keeps its own `retry_at`; sibling rows, streaks and health are not touched, so
a queued sibling may read as queued or delayed. The failed run carries the
anomaly `page_provider_hold`. Interactive requests (page verification, CLI
probes, the platform command outbox) and the WS binding check do not consult
the hold.

```sql
select p.label, h.* from page_sync_provider_holds h join pages p on p.id = h.page_id
where h.hold_until > now();
```

Do not delete or shorten a hold to test recovery; it ends by itself.

For diagnosis, retain the page/stream, `retry_at`, retry kind, request/applied
sequence and the normalized provider error using existing read-only tools.
Queueing a manual follow-up does not bypass the provider deadline. Do not clear
the row or repeatedly dispatch it to test recovery. A separately approved
deployment can apply this fix without changing any flag or triggering a probe.

Rollback uses the prior application image and preserves the database. Returning
to the prior code reopens the early-retry race; an incident alone is not evidence
that retrying before the provider deadline is safe.
