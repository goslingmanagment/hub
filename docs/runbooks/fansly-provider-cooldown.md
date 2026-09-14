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

For diagnosis, retain the page/stream, `retry_at`, retry kind, request/applied
sequence and the normalized provider error using existing read-only tools.
Queueing a manual follow-up does not bypass the provider deadline. Do not clear
the row or repeatedly dispatch it to test recovery. A separately approved
deployment can apply this fix without changing any flag or triggering a probe.

Rollback uses the prior application image and preserves the database. Returning
to the prior code reopens the early-retry race; an incident alone is not evidence
that retrying before the provider deadline is safe.
