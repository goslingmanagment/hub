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

## Wave 2 — corrections program (branch kernel/fastreply-corrections)

Design notes: `docs/fastreply-corrections-design-notes.md`. Deploy waits for the
Wave-1 soak window (~2–3 days of manifest/reconcile attribution data per the scope
boundary). ORDER IS LOAD-BEARING — the reconciler flag before the backfill
mass-appends redundant superseding events for the whole history (preamble 1).

### Deploy sequence (owner-gated, in this exact order)

1. **Deploy the image** (migration **0076** applies at container boot: fingerprint/
   emitted/revision/provenance/rest_platform_changed_at columns + the partial
   repair-signal index). Both new flags default OFF — nothing behavioral changes at
   deploy beyond: (a) writers now compute `material_fingerprint` on every material
   write (webhook INSERTs also close `emitted`), and (b) the readthrough floor is
   **v2** — the gauge series becomes `obs_backlog_readthrough_v2` and v1-stamped
   observations replay through the reducer on the first sweeps (a brief backlog
   blip, then zero; the replays are material no-ops).
2. **Preamble backfill** (owner CLI, one-shot, idempotent/resumable):
   `corrections:backfill-fingerprints --dry-run` → review counts → run for real.
   The output's **INITIAL DRAIN BOUND** (`drainOpen`) = Wave-1 REST-only +
   command-only rows that will get FIRST events when the reconciler turns on;
   `emittedClosed` should be the overwhelming majority (webhook history already in
   the ledger); `stubsSkipped` = null-ref tombstone stubs (documented survivors).
3. **Flip `OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED`** (staged boot flag #122 +
   restart). Watch the worker's `DM corrections reconcile sweep complete` line:
   `firstEvents` drains ≈ drainOpen at ≤500 rows/min then goes quiet;
   `superseding` stays near zero in steady state (each one = a real material
   correction reaching the ledger); `lineageSkips`/`stubSkips` nonzero-but-stable
   is fine, growing is not.
4. **Fansly 1970 repair** (owner CLI, one-shot campaign):
   - size first (prod psql): `SELECT count(*) FROM domain_events_pre_2024 WHERE
     occurred_at < '2000-01-01' AND type IN ('message.received','message.sent');`
   - `events:repair-fansly-1970 --dry-run` (add `--account <id>` to pilot one page)
     → real run. Superseding events land with corrected timestamps; the minutely
     archive projection sweep applies the heals (verify:
     `SELECT count(*) FROM message_archive WHERE occurred_at < '2000-01-01'` → 0
     for fansly accounts once the sweep passes).
   - `missingObservation`/`missingItem`/`outOfRange` counts are review lists, not
     failures — those events stay 1970 (source facts unreachable; never guessed).
   - New observations are correct from this deploy (asFanslyTimestamp in the
     canonicalizer); the campaign only covers the historical damage.
5. **Sends-as-facts** ships active (no flag): it engages only on the direct-confirm
   path when `ofapiDmColdArchiveEnabled` is ON (it is), writes fill-grade
   `source='command'` rows that a later webhook upgrades, and the reconciler emits
   their first `message.sent` events dedupe-proof against late webhooks. The raced
   direct-confirm/webhook seam is fixed with it — a lost failure race no longer
   journals a false `failed_*` fact.

### Post-deploy findings (2026-07-10) — READ BEFORE RESUMING THE SEQUENCE

- **Step 3 was rolled back the same hour.** The reconciler lineage-skipped
  100% of the drain: OFAPI webhook observations only exist since ~07-04/05
  (the #49 flip) — rows journaled 06-19..07-04 never had one, and the
  `ofapi_webhook_events` journal itself retains only ~14 days (the spec's
  "36500d" assumption was wrong), so 8,549 of the 17,172 open rows have no
  surviving journal row either. Surviving payloads are frozen in
  `ofapi_webhook_events_w2_lineage_snapshot` (138,082 rows, 2026-07-10).
  Two sweep defects on top: the sweep restarts from the signal head every
  run (afterId never persists — head-block starves post-Wave-1 REST rows)
  and it warns per row (500/min). Fix program = W2.1 (late observation
  intake from the snapshot; owner decision on the 8,549 journal-less rows;
  cursor + warn-once). Do NOT re-enable the flag before W2.1.
- **The backfill expectation was miscalibrated**: prod reality is
  emittedClosed 4,902 / drainOpen 17,172 — the ledger lane is younger than
  the archive, not older.
- **Migration 0077 is a hard precondition for step 4 (1970 repair)**:
  tiering had detached every 2024–2025 domain_events monthly, so corrected
  timestamps (both the Wave-2 canonicalizer fix and the campaign's
  superseding events) had no landing partition — inserts failed 23514 and
  the observations retried forever. 0077 re-opens the range with YEARLY
  partitions (`domain_events_2024`/`_2025`) whose names the tiering regex
  can never match again.

### Rollback

- Reconciler: staged flag off + restart — sweeps stop; fingerprint columns are
  passive bookkeeping; no cleanup. (Turning it back on later resumes from the
  repair signal exactly where it stopped.)
- The 1970 repair and any appended superseding events are FACTS (append-only
  ledger) — there is no rollback; "stop" = don't run the campaign further. The
  archive projection keeps whatever it last applied.
- Writer changes (reducer, sends-as-facts, seam fix) are unflagged code — rollback
  is a redeploy of the previous image (rollback-compatible: 0076 is additive).
