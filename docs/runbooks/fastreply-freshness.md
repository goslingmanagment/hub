# Runbook — Fast-reply freshness (OnlyFans AI-context union read)

Build spec: `docs/fastreply-freshness-build-spec.md` (frozen). This runbook collects
the operational notes each Wave-1 PR ships; deploy preconditions live at the end.

Desktop: NOTHING to build (0.1.33 is live) — at deploy, only verify the feed serves
0.1.33. **0.1.29 is manual-reinstall-only**: the updater has no allowDowngrade
(verified), so a machine rolled back to 0.1.29 can only move forward by reinstalling.

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

## PR4 — readthrough reconcile (`ofapiDmReadthroughReconcileEnabled`)

- **Flag lane:** boolean, STAGED (boot-applied) — flips via the staged endpoint +
  restart, own verification window (same day per the rollout override). Deploy
  precondition (owner-verified): `ofapiDmColdArchiveEnabled` effectively ON.
- **What it does when ON:** chat-open readthroughs journal the widened v2 observation
  (`ofapi_gateway_chat_messages_v2`) + immediate best-effort projection; the minutely
  readthrough sweep (rides canonicalize.sweep) is the retry. When OFF, capture keeps
  the v1 shape — v2 rows never accumulate unconsumed, so `obs_backlog_readthrough_v1`
  stays honest. NOTE: after a rollback (flag off), any v2 rows captured while it was on
  that remain unprojected keep the backlog gauge latched — expected; re-enable or the
  Wave-2 replay clears it.
- **Monitor:** the sweep log line `Readthrough reconcile sweep complete` — `upserts` is
  the MEASURED webhook-loss rate; `conflicts.*` (text/price/direction/timestamp/reply/
  media) are the non-sentinel divergences Wave 1 deliberately keeps for the Wave-2
  reducer; `drops` = erasure-fenced items; `deferred` = writes parked behind a running
  erasure (retried next sweep).
- **Erasure fence (decision #121):** material-time-bounded — pre-erasure facts stay
  dead, an erased-but-active fan's NEW messages flow. Fence hits stamp journal rows
  `skipped`/`erasure_fenced` (terminal). Null-ref tombstone stubs post-erasure are the
  documented contentless survivor. Do not "fix" a latched backlog by deleting
  observations — find the wedged consumer.
- **Deploy-time EXPLAIN (owner, prod psql):** the readthrough listing filters
  `parse_version < 1 and source = 'readthrough' and kind = 'ofapi_gateway_chat_messages_v2'`
  over `observations_parse_idx`; undeclared version-0 kinds share that index range, so
  verify on prod-size data before trusting the sweep cadence:
  `EXPLAIN select o.id from observations o where o.parse_version < 1 and o.source = 'readthrough' and o.kind = 'ofapi_gateway_chat_messages_v2' order by o.id asc limit 100;`
  A misbehaving plan is grounds to revisit (no new observations index without this
  EXPLAIN — spec rule).
- **Migration 0075** (single tx, forward-only): `dm_message_archive` gains
  `rest_material_observation_id` / `rest_material_observed_at`; `source_journal_id`
  drops NOT NULL (REST-inserted rows have no webhook journal row — never fake ids).
