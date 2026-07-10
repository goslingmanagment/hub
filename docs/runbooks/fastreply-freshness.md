# Runbook — Fast-reply freshness (OnlyFans AI-context union read)

Build spec: `docs/fastreply-freshness-build-spec.md` (frozen). This runbook collects
the operational notes each Wave-1 PR ships; deploy preconditions live at the end.

## PR1 — capture path

- **Cold-archive upsert failure is self-healing, no alarm.** If the post-settle
  cold-archive upsert throws, the journal row stays `archive_status='pending'|'failed'`
  and the existing minutely archive sweep retries it → up to ~60–90 s during which the
  chatter UI can show a message the union read lacks. Accepted; do not page on it.
- **Webhook route has no rate limit on purpose.** A 429 before the journal loses the
  delivery after OFAPI's 5 retries. If a limiter is ever reintroduced it must sit AFTER
  the journal write. Prod-host check at deploy: no upstream nginx 429 remains on
  `/api/v1/ofapi/webhook`.
- **`projection:rebuild message_archive` is disabled.** The replay sees only attached
  `domain_events` partitions and destroys `backfill_source` rows. `archive:backfill`
  (idempotent, additive) remains the recovery tool.
- **Deploy env condition:** `PAGE_DM_PRUNE_ENABLED=false` (also the new schema default);
  verify api+worker+scheduler heartbeats post-deploy.
