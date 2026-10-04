# Provider cooldown of the legacy page-sync queue

> Since step 4 of the Fansly Sync Engine (S4-19) the legacy page-sync executor
> serves OnlyFans only. What this runbook said about Fansly — a provider
> `Retry-After` as the retry deadline, the immediate incident for a deadline
> more than 30 minutes away, and the page hold after a 429 (R04,
> `page_sync_provider_holds`) — is deleted: a Fansly page's 429 holds its
> route in the engine (`apps/runtime/src/sync/README.md`; `pnpm cli sync why`).
> Nothing writes or obeys `page_sync_provider_holds` any more; its rows stay as
> records.

`rate_limit` and `provider_5xx` streams retain a future `retry_at` when new work
arrives. `request_seq`, the latest request source and payload can advance while
the stream remains `retrying`. This is queued work waiting for its retry
deadline, not a lost request. Ordinary and targeted leases obey that deadline.

Manual requests still supersede ordinary transport/yield backoff and expired
cooldowns. The deadline is the stream's own consecutive-failure ladder (60 s
doubling, 30 minutes cap): OFAPI names no deadline of its own to the executor.

For diagnosis, retain the page/stream, `retry_at`, retry kind, request/applied
sequence and the normalized provider error using existing read-only tools.
Queueing a manual follow-up does not bypass the deadline. Do not clear the row
or repeatedly dispatch it to test recovery.
