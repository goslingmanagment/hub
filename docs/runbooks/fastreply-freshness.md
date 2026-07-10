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

## PR3 — union read (`aiTranscriptFreshUnionMode`)

- **Flag lane:** live-wired (`runtimeApply: live`), flipped via
  `PATCH /api/v1/admin/config` — no restart. Transitions are validated in the write tx:
  upward only stepwise `off→shadow→serve`; ANY rollback (`serve→shadow`, `serve→off`,
  `shadow→off`) allowed instantly. The staged lane cannot carry it (boolean-only).
  The console shows the key read-only; use the PATCH API. The #70 one-flag-at-a-time
  ritual applies procedurally.
- **Rollback semantics:** `off` = PERF rollback (shadow still EXECUTES the union query —
  going to shadow does not remove query load); `shadow` = CORRECTNESS rollback (union
  results stop being served but stay measured). No cleanup needed after any rollback.
- **Failure posture:** union-query error → archive serves + `staleContext: true` in the
  manifest — never a hard failure. Mode-read failure / invalid stored value → archive
  serves + manifest `mode: "unknown"` — never a silent fallback.
- **Live monitor:** `params.contextManifest` on `ai_generation_content` (owner-only) —
  watch `additions` (union rows the archive lacked), `unionError` (must be zero),
  `queryDurationMs`, `gapMs`. Backlog gauges `obs_backlog_<source>_v<N>` ride the
  golden-signal latch (threshold 600 000 ms; a failed probe latches too).
- **Rollout (owner override 2026-07-10):** NO 24–48 h shadow window — deploy → shadow
  for MINUTES (one smoke pass: several live generations, manifests show union additions
  and zero errors) → serve immediately, same day. The off→shadow→serve order stays
  (it is ordering, not duration).
