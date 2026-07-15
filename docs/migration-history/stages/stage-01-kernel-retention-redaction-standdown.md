# Stage 1 — Kernel retention & redaction stand-down

**Repo(s):** core · **Depends on:** — · **Passport:** roadmap.md §4, stage 1

**Status header.** No deviation from the master. One mechanics note carried from roadmap §2.2 and
confirmed against code: the two retention knobs are **`runtimeApply: "none"` (env-only)**, so the
stand-down of the webhook journal and the DM cold archive is an **env change + restart (a deploy)**,
not a dashboard config flip. Q1 confirms the urgency: `ofapiEventRetentionDays` runs at the default
**7** in production; the journal purge is live (oldest row exactly 7 days back, ~76 k rows). Disk:
32 GB free of 79 GB.

## 1. Context

The review's worst finding (capture grade F): the kernel schedules deletion of its own business
facts. Every 02:30 UTC the webhook journal drops everything older than 7 days — money events
included; raw sync payloads are stamped to die at 180 d (7 d for DM metadata); the hot DM table is
pruned to 200/1,000 messages per conversation on every sync and every webhook refresh; command
payloads self-redact 7 days after settling. This stage stops all scheduled/automatic destruction of
business facts in the kernel, effective the deploy — buying the time the ledger (Stages 7–8) needs
to land.

**Entry criteria restated as facts to verify at execution time:**

- VPS Postgres volume headroom checked (Q1: 32 GB free of 79 GB — re-check; `GET
  /api/v1/admin/db/stats`, `server.ts:2991-3013`, gives per-table sizes).
- `ofapiEventRetentionDays` running value = 7 (Q1). Re-read via `GET /api/v1/admin/config`
  (`server.ts:3144`) or the §2.1 `config_settings`/`runtime_instances` queries.
- Q1 answered is **not** a prerequisite for this stage (it is for Stage 3).

**Deliverable:** one deploy after which (a) the 02:30 journal cleanup deletes 0 business rows,
(b) `sync_raw_payloads` stops expiring, (c) `page_dm_messages` per-conversation counts are
nondecreasing, (d) DM message sync writes raw payloads, (e) terminal command payloads are no longer
redacted, and (f) the dashboard config view shows truthful (non-destructive) values.

## 2. Changes

**core — env / production config (deploy-time):**
- `OFAPI_EVENT_RETENTION_DAYS` → `36500` in `.env.production` (env-only knob — `config.ts:120`,
  `config-registry.ts:166`). Effectively-forever.
- `OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS` → `36500` (env-only — `config.ts:125`,
  `config-registry.ts:171`; default already 3650 so low urgency, but align it).

**core — code constants / defaults:**
- `DEFAULT_OFAPI_EVENT_RETENTION_DAYS` `7 → 36500` (`services/ofapi-events.ts:68`) so a missing env
  never re-enables a 7-day purge (defense in depth: the default and the env both change).
- `services/sync/shared.ts:27-36`: `retentionDate()` (now+180 d, `:31`) and `dmRetentionDate()`
  (now+7 d, `:34-36`) → far-future (e.g. now + 36500 d), or stamp `retain_until = null` and make the
  purge treat NULL as never-expire. **Preferred:** stamp far-future so the existing
  `retain_until < now` delete (`repositories/sync.ts:755-757`) simply never matches; leaves the
  purge job in place as a no-op. `DM_RAW_RETENTION_DAYS` (`:28`) raised the same way.
- `services/ofapi-command-executor.ts`: disable payload self-redaction. Guard
  `redactTerminalOfapiCommandPayloads` (called at `:343-347` from `sweepOfapiCommands`) behind a new
  env kill-switch `OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED` (default **false**). NB the redaction
  currently runs *before* the execution-enabled check (`:355`), so it fires even with execution
  disabled — the kill-switch must sit at the redaction call, not the executor gate.
- `repositories/page-dm.ts`: the prune (`prunePageDmMessagesToLimit`, `:560`) called from
  `finalizePageDmConversationMessageSync` (`:801`, prune `:812-816`) and
  `refreshPageDmConversationWindow` (`:718`, prune `:737-743`, via `ofapi-dm-projection.ts:320-323`)
  becomes a **no-op behind a kill-switch env** `PAGE_DM_PRUNE_ENABLED` (default **false**). Keep the
  functions; gate the two call sites. (Re-enabled as a *safe cache policy* only in Stage 28, once
  history lives in the archive+ledger.)
- **DM message sync gains raw persistence.** Today the DM-*messages* handlers persist **zero** raw
  (`executeOnlyFansDmMessagesChunk` `executor-handlers.ts:3160`, `executeDmMessagesChunk` (Fansly)
  `:3514`, and OFAPI DM sync `services/sync/ofapi-dm-sync.ts` — none call `persistRawPayload`). Add a
  `persistRawPayload` call (the helper is `shared.ts:73-89`) in each DM-message fetch path, mirroring
  the subscribers/followers sites (`executor-handlers.ts:1654/1904/2172`), `payloadKind:
  'dm_messages'`, far-future `retain_until`. **Note (proposal, see §7):** this is genuinely new
  capture — flagged as the one scope-broadening item in Stage 1; it is in the passport ("DM message
  sync paths gain `persistRawPayload`"), so no deviation, but call it out at review.
- **Belt-and-braces purge guard.** Even at 36500 d, harden `deleteExpiredOfapiWebhookEvents`
  (`repositories/ofapi.ts:977-984`): add a predicate that a row is deletable only if its
  `projection_*` **and** `archive_*` bookkeeping columns (`schema.ts:2139-2146`) show consumed
  (i.e. never delete an unconsumed row regardless of age). This closes the "expire before
  projection consumes" class permanently.
- **Config-registry labels/flags updated to truth.** `ofapiEventRetentionDays` and
  `ofapiDmColdArchiveRetentionDays` (`config-registry.ts:166,171`): keep `destructive` accurate but
  update the human label/description to reflect the new forever default; the dashboard must not
  present a 7-day retention as current.

**core — new (small):** a **disk-usage alert** (none exists today — only the on-demand
`/admin/db/stats`). Add a scheduled check (reuse the existing alert-monitor pattern that already
serves credits/webhook-silence/account-health) that pages the owner when the Postgres volume crosses
a threshold (e.g. 80 %). This is the containment for "tables now grow forever."

## 3. Schema & data migration

**No schema change.** All fact tables already exist; this stage changes *when/whether* rows are
deleted, not their shape.

**No data backfill.** Two one-time data touches, both idempotent and optional:
- Optionally re-stamp existing `sync_raw_payloads.retain_until` to far-future so already-written
  rows also stop expiring (batched `UPDATE ... WHERE retain_until < :farFuture`). Idempotent
  (re-running matches nothing new). Without it, rows written before the deploy still expire on their
  stamped date — acceptable (they are ≤180 d old) but the UPDATE preserves them.
- No re-stamp needed for `ofapi_webhook_events` (purge is age-based off `received_at`, not a stored
  column) — raising the retention is sufficient.

## 4. Client compatibility

- **Desktop:** no visible change. Reads (gateway + SSE) and sends untouched; only server-side
  retention changes. Local DB caps are Stage 4 (desktop repo, Pass 3c).
- **Extension:** no change.
- **Dashboard:** the config page shows the new (truthful, non-destructive) retention values; admin
  destruction doors are Stage 2, not here.
- **Workboard:** n/a.

**Compatibility invariants (target §14):** none altered. The SSE `sync` frame protocol, command
outbox semantics, and read-gateway path shape are untouched — this stage only stops deletions.

## 5. Tests & verification

**New tests:**
- Unit: `deleteExpiredOfapiWebhookEvents` with the new consumed-guard deletes an old **consumed**
  row but refuses an old **unconsumed** row (fixture rows with/without projection+archive marks).
- Unit: prune no-op — `finalizePageDmConversationMessageSync` and `refreshPageDmConversationWindow`
  with `PAGE_DM_PRUNE_ENABLED=false` leave row counts unchanged over a >cap conversation.
- Unit: command sweep with `OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED=false` leaves a >7-day terminal
  command payload intact.
- Integration (Testcontainers): a DM-messages sync chunk produces `sync_raw_payloads` rows
  (`payloadKind='dm_messages'`).

**Existing suites that must stay green:** the sync executor suite, OFAPI webhook/projection suite,
DM projection suite.

**Production verification (exit criteria):**
```sql
-- (V1) Next 02:30 UTC journal cleanup deletes 0 business rows.
--   Check the job log line + confirm the oldest row keeps aging past 7 days:
SELECT min(received_at), max(received_at), count(*) FROM ofapi_webhook_events;
-- oldest received_at should march older than 7 days after the deploy.
```
```sql
-- (V2) page_dm_messages per-conversation counts strictly nondecreasing over 48h.
--   Snapshot then re-run:
SELECT platform_account_id, conversation_id, count(*) FROM page_dm_messages GROUP BY 1,2;
```
- **(V3)** A terminal `ofapi_commands` row older than 7 days still has non-empty payload text
  (query `payload IS NOT NULL AND updated_at < now() - interval '7 days' AND state terminal`).
- **(V4)** DM sync runs produce `sync_raw_payloads` rows: `SELECT count(*) FROM sync_raw_payloads
  WHERE payload_kind='dm_messages' AND created_at > :deploy` > 0 within 24 h.
- **(V5)** Disk-usage alert fires in a staging drill at the threshold.
- **Observation window:** 48 h for V2; one cleanup cycle (next 02:30 UTC) for V1.

## 6. Rollback

- Every code change is env/flag-guarded: revert `PAGE_DM_PRUNE_ENABLED`,
  `OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED`, and the retention envs to restore prior behavior; no
  migration to undo.
- The far-future `retain_until` re-stamp (if run) is **not auto-reversible** into deleting data — by
  design (we do not want a rollback that deletes facts). To restore old pruning behavior, re-enable
  the flags going forward; already-preserved rows stay.
- **Irreversible-by-intent:** nothing here deletes data, so there is no destructive step to gate.
  The only "irreversible" direction (re-shortening retention) is exactly what we never want to do
  automatically; if ever needed it is an owner-gated manual purge (Stage 28's erasure procedure).

## 7. Assumptions

1. **The daily purge jobs + inline prunes are the *only* deleters of these tables.** Verified: three
   scheduled jobs (`fansly.raw-payload-cleanup` daily 02:00 `worker-services.ts:141`;
   `ofapi.events.cleanup` daily 02:30 `ofapi-events.ts:252`; `ofapi.commands.sweep` minutely
   `ofapi-command-executor.ts:113`) plus inline `page_dm_messages` prune. Drift signal: a new delete
   path added after this stage — the belt-and-braces guard and the disk alert are the safety net.
2. **The two retention knobs are env-only (`runtimeApply: "none"`).** A dashboard override lands in
   `skippedOverrides` and is never applied — so the stand-down must be an env deploy. Drift signal:
   a future change flips these to `runtimeApply: "boot"|"live"`.
3. **Current webhook/sync volume ≈ Pass 2's estimate** (tens of MB/day) — table growth is safe for
   the ledger window. The disk alert is the guard if this is wrong.
4. **`.env.production` is the live env source on the VPS** and a restart re-reads it (boot-apply).
5. **The DM-message raw-persistence add is genuinely new capture** (today zero) — it is in the
   passport, but flag it at review as the one scope-broadening line, since it is the only change here
   that *adds* writes rather than *stopping* deletes.
6. **`dm_message_archive.source` already reserves `rest_backfill`/`rest_reconcile`/`command`** enum
   values (`schema.ts:1007-1009`) though only `webhook` is written today — no constraint change is
   needed when later stages write those sources.

## 8. Task breakdown

1. **Env + code-default retention raise** (webhook journal, DM cold archive, raw payloads):
   env changes + `ofapi-events.ts:68` default + `sync/shared.ts:27-36` constants. Done-check: unit +
   the V1/V4 queries pass on staging. *(≤0.5 session)*
2. **Kill-switches**: `PAGE_DM_PRUNE_ENABLED`, `OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED`; gate the
   two prune call sites + the redaction call. Done-check: V2/V3 unit tests. *(≤0.5 session)* *(parallel with 1)*
3. **DM-message raw persistence**: add `persistRawPayload` to the three DM-message fetch paths.
   Done-check: integration test (V4). *(≤0.5 session)*
4. **Belt-and-braces purge guard** + **config-registry label truth**. Done-check: V1 unit test.
   *(≤0.5 session)* *(parallel with 1–3)*
5. **Disk-usage alert** (new scheduled monitor). Done-check: staging drill (V5). *(≤0.5 session)*
6. **(Last) Deploy + record production verification** (V1–V5) in the stage file. *(ops)*

---

## Progress

*Working scratchpad — exempt from the append-only rule. Session started 2026-07-05, branch `kernel/stage-01-retention-redaction-standdown`.*

**Pre-flight (done):** dirty tree resolved on main (Stage 6 probe = 90110ba, OFAPI-credits rework = c54fa5d). All §7 assumptions re-verified against code — no drift. Path notes vs spec shorthand: `config.ts`/`config-registry.ts` = `packages/shared/src/`; `repositories/*` = `packages/db/src/repositories/`; `deleteExpiredRawPayloads` (spec: "repositories/sync.ts:755-757") = `packages/db/src/repositories/sync.ts:755`. Registry test forces a registry row per new env key. `payload_kind` is a TS union at `packages/db/src/repositories/sync.ts:635` (DB column free text — no migration needed for 'dm_messages'). Prod checks (§1 disk headroom / running retention value) deferred to the owner-run deploy step — prod access is owner-gated.

**§8 checklist:**
- [x] 1. Env + code-default retention raise — committed b8ba7ff (config.ts:120/125 → 36500, registry defaults/labels, ofapi-events.ts default, ofapi-dm-archive default, sync/shared.ts retentionDate/dmRetentionDate → +36500d; webhook prune test pins retention=7 explicitly)
- [x] 2. Kill-switches — committed 03a4d0e (PAGE_DM_PRUNE_ENABLED + OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED, default OFF; 4 prune call sites gated via new services/page-dm-retention.ts helper; finalize gains enforceRetention input default true; redaction gated inside sweepOfapiCommands before the execution check; registry rows NEVER/none; tests: page-dm no-prune integration, redaction-off integration)
- [x] 3. DM-message raw persistence — committed e3bce79 (3 paths: OM + Fansly persist page.raw, OFAPI persists {items} — no raw envelope on that client; payloadKind 'dm_messages' union-only; V4 assertion added to ofapi-dm-sync integration; backfill-cap test updated to 201 = no finalize prune)
- [x] 4. Belt-and-braces purge guard — committed 0faa493 (deleteExpiredOfapiWebhookEvents refuses projection/archive pending|failed rows regardless of age; integration test covers both directions; registry label truth was in task 1)
- [x] 5. Disk-usage alert — committed c472684 (new services/db-disk-alert.ts, queue db.disk-usage.check hourly :15 UTC, statfs("/") vs DISK_USAGE_ALERT_PERCENT default 80, db_disk_usage incident kind through the existing Telegram incident layer; **migration 0052** = ALTER TYPE ADD VALUE — the stage's one §3 deviation, additive-only, precedent 0030/0031; contracts regenerated)
- [x] 6. Deploy prep DONE (steps below); prod verification remains owner-run. Full `pnpm test`: **166 files, 1398/1398 green** (2026-07-05). decisions.md #63 appended + committed (55db42e). Stage = **green-local**.

**Next step (owner / follow-up ops session):** run the deploy steps below, verify V1–V5, then flip execution-log.md to `exited`.

**Owner-run deploy steps (stage exit, §3.8):**
1. Review/merge branch `kernel/stage-01-retention-redaction-standdown` into `main` (5 checkpoint commits, revert unit = the branch).
2. On the VPS, edit `/opt/agency-hub/.env.production`: set `OFAPI_EVENT_RETENTION_DAYS=36500` and `OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS=36500` (add if absent — an existing `=7` would override the new code default). No env needed for the kill-switches (absence = off = stand-down) or `DISK_USAGE_ALERT_PERCENT` (default 80).
3. Deploy: `scripts/deploy-production.sh --mode dist-only root@45.8.230.111`. Migration 0052 (`ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'db_disk_usage'`) ships with the release; post-deploy confirm `schema_migrations` contains 0052.
4. Optional but recommended (preserves pre-deploy raw payloads, idempotent):
   `UPDATE sync_raw_payloads SET retain_until = now() + interval '36500 days' WHERE retain_until < now() + interval '36000 days';`
5. Production verification (§5): V1 after next 02:30 UTC — `SELECT min(received_at), max(received_at), count(*) FROM ofapi_webhook_events;` oldest must age past −7d. V2 — snapshot `SELECT platform_account_id, conversation_id, count(*) FROM page_dm_messages GROUP BY 1,2;` re-run at +48h, counts nondecreasing. V3 — `SELECT count(*) FROM ofapi_commands WHERE payload_redacted_at IS NULL AND payload IS NOT NULL AND updated_at < now() - interval '7 days' AND state IN ('confirmed','failed_retryable','failed_terminal','cancelled');` stays > 0 / no new redactions (`payload_redacted_at` newer than deploy must not appear). V4 — `SELECT count(*) FROM sync_raw_payloads WHERE payload_kind = 'dm_messages' AND captured_at > '<deploy time>';` > 0 within 24 h. V5 drill — set `DISK_USAGE_ALERT_PERCENT=1`, restart worker, expect the 🚨 Telegram disk alert within the hour (or at :15); restore `80`, expect the ✅ resolve on the next tick.
6. Then flip this stage to `exited (prod-verified <date>, <commit>)` in execution-log.md.

**DEPLOY EXECUTED 2026-07-05 00:00 UTC (owner "Full go" in-session):** main fast-forwarded to 89fa290 (chain stage-01→spec-fixup→stage-02); `.env.production` gained OFAPI_EVENT_RETENTION_DAYS=36500 + OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS=36500 (they were ABSENT before — prod pruned on the old code default; backup `.env.production.bak-pre-stage1`); `deploy-production.sh --mode dist-only` verified (API+sync health 200); migrations 0052+0053 applied 23:57:27 UTC. Smoke: journal 80,128 rows oldest 2026-06-27 03:59:42 UTC (**V1 marker: must survive the 02:30 UTC cleanup**); V3 baseline 0 unredacted old payloads (check = no NEW payload_redacted_at after deploy); V4 baseline 0 dm_messages raw rows (expect >0 in 24 h); **471,389 sync_raw_payloads re-stamped far-future**; V5 drill in progress (threshold 1%, worker recreated 00:03 UTC, tick at 00:15; NB `docker restart` does NOT re-read env_file — compose `--env-file .env.production -f docker-compose.production.yml up -d --force-recreate --no-deps worker` is required). Remaining to exit: V1 (post-02:30), V4 (+24 h), V2 (+48 h), V5 confirmation + threshold restore.

**V5 PASSED 2026-07-05 00:15 UTC:** drill (threshold 1%) fired on the first hourly tick — incident #25 `db_disk_usage` opened 00:15:43 with summary "Disk 60.1% used (threshold 1%); free 31.3 GiB of 78.6 GiB; Postgres 7.9 GiB"; Telegram `incident_opened` delivery = sent. Threshold restored to default 80 (env line removed, worker recreated 00:17 healthy); auto-resolve ✅ expected at the 01:15 tick. Remaining for exit: V1 (post-02:30 UTC), V4 (+24 h), V2 (+48 h).
