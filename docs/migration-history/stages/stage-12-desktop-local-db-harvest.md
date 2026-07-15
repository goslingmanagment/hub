# Stage 12 — Desktop local-DB harvest (one-time)

**Repo(s):** desktop (+ core canonicalizer glue) · **Depends on:** 11 (lane), 8 (dedup), 10
(archive home) · **Passport:** roadmap.md §4, stage 12

**Status header — one verified drift (no owner action needed):** the passport's entry
criterion "fleet inventory with local DB sizes (hub telemetry)" has no source — the desktop
reports no telemetry to the hub (verified in stage-04 spec, Status header). The inventory is
gathered instead from each machine's existing **diagnostics export** (per-table row counts +
`dbBytes`, `apps/desktop/src/main/index.ts:1070-1180`, counts at `:1144-1151`), collected by
the owner per machine before the harvest is triggered. Same information, manual transport;
scope otherwise unchanged.

## 1. Context

Chatters' machines are the only place some OnlyFans history exists: local `messages` beyond
the kernel's hot window and webhook epoch, `fan_transactions` inside the (Stage 4-widened)
local window, the full-text send audit (`outbox` — kept forever locally), guard-audit full
text, and the acceptance/spend ledgers. This stage copies all of it into the kernel ledger
once — **before any local pruning policy loosens** (sequencing rule: insurance before
surgery). Dedup against facts the kernel already has happens naturally at canonicalization
(Stage 8's `dedup_key`), so over-uploading is free and under-uploading is the only failure
mode that matters.

**Entry criteria restated as facts to verify:**
- Stage 11 lane live in production: `POST /api/v1/ingest/observations` accepting desktop
  batches (stage-11 §5 exit checks recorded).
- Stage 10 archive live (harvested messages need a projection home; rebuild command works).
- Stage 4 shipped fleet-wide (spool semantics + `x-client-version` observed) — local prunes
  frozen at the raised caps; **they stay frozen until this stage's manifests reconcile**.
- Local schema at `SCHEMA_VERSION = 16` (`apps/desktop/src/main/db/migrations.ts:30`) on every
  machine (each machine's diagnostics export carries `schemaVersion`, `index.ts:1088-1093`);
  a machine below 16 updates the app first (auto-update) rather than getting a special path.
- Per-machine diagnostics exports collected (the inventory: per-table counts + `dbBytes`).

**Deliverable:** every fleet machine harvested: per-machine manifest reconciled against
kernel-side ingested counts; archive coverage extending to before the webhook epoch for
harvested accounts; re-run on any machine a no-op.

## 2. Changes

**desktop — harvest module** (`apps/desktop/src/main/harvest/` new; wired into the existing
hub module `apps/desktop/src/main/hub/index.ts`):
- **Table walkers** over the local SQLite (read-only, rowid-ordered, chunked): the harvested
  set is `messages`, `fan_transactions`, `outbox`, `message_guard_events`, `usage_events`
  (including quarantined rows and the local-only `accepted`/`acceptedPart` metadata that the
  live reporter strips from the wire — `apps/desktop/src/main/hub/usage-mapper.ts:3-5`),
  `ai_spend_log`, `credit_log`. **Excluded, with reasons:** `chats`/`accounts`/`fans`
  (reference data the kernel already holds), `summaries` (hub-synced via the fan-profile
  PUT/GET lane already), `media_cache`/`media_urls` (binary cache), `thread_fetch_log` (local
  ops telemetry, no business fact), `settings` (contains secrets — never leaves the machine).
- **Upload via the Stage 11 lane, verbatim contract:** batches ≤100 events, ≤1 MB body,
  `Retry-After` honored, 400 → quarantine-export; `producer` is the lane's version header —
  the harvest sets `x-client-version` to `harvest-<app version>` so core stamps
  `producer='desktop-harvest@<version>'` exactly as stage-11 §3 fixed. Event fields:
  `kind='harvest.<table>'` (see core glue below), `observedAt` = the row's own timestamp,
  `payload` = the full row (JSON) + `{table, machineId, schemaVersion}`,
  `clientEventId` = UUIDv5 of `<machineId>:<table>:<rowPk>` — **deterministic**, so a re-run
  or resume re-sends the same ids and the lane's `(principal, clientEventId)` idempotency
  makes it a no-op.
- **`machineId`:** a new `install_id` value in the local `settings` KV table (generated once,
  UUID; the settings table is schemaless key-value — no migration). Included in every payload
  and in the manifest.
- **Checkpointing:** per-table `harvest.cursor.<table>` rows in local settings (last uploaded
  rowid + count); abort/crash/offline resume from the cursor. Off-hours pacing: default
  1 batch/2 s (config constant), so a 100k-row machine drains in well under a day without
  competing with live work.
- **Manifest:** on completion the module writes
  `chatgoose-harvest-manifest-<machineId>-<stamp>.json` (per-table: row count, min/max
  timestamps, uploaded count, duplicate count as reported by the lane's
  `{accepted, duplicates}` responses) and surfaces it in the diagnostics folder; the owner
  collects it for the kernel-side reconciliation.
- **Trigger:** owner/team-lead-instructed, per machine — a new Settings → Danger Zone action
  ("Upload history to kernel", progress bar + pause/resume), NOT automatic. Staged across the
  fleet (one machine first).

**core — canonicalizer glue (Stage 8 seam, extending stage-11's `client-capture.ts` family):**
- Kind allowlist extends with `harvest.messages`, `harvest.fan_transactions`,
  `harvest.outbox`, `harvest.message_guard_events`, `harvest.usage_events`,
  `harvest.ai_spend_log`, `harvest.credit_log` (unknown kinds still journal — capture-first).
- `harvest.messages` → `message.*` domain events using the Stage 8 OnlyFans parsers' dedup
  keys, so a message the kernel already saw (webhook, REST, gateway tee) collapses; account
  resolution via the payload's OFAPI account id against `pages.ofapi_account_id` (the desktop
  is OnlyFans-only). Events feed the Stage 10 archive — pre-webhook-epoch history is the
  point.
- `harvest.fan_transactions` → `transaction.*` candidate events, **flagged
  `source='harvest'`** per Stage 13's provenance enum; they do NOT write canonical
  `transactions` rows directly — the Stage 13 single-writer gate stands, and OFAPI REST
  history (back to 2025-09 per Q1) should dedup nearly all of them. Any *residue* (harvested
  transaction with no OFAPI counterpart) is surfaced as a report for the owner, not silently
  ingested.
- `harvest.outbox` / `harvest.message_guard_events` / `harvest.usage_events`: observation-only
  (same rule as stage-11's live kinds — guard text sensitive, no read path before Stage 29);
  `outbox` rows carry `core_command_id` where present (`db/queries/outbox.ts:44-45`), giving
  free correlation to kernel command records.
- Reconciliation script (`scripts/` or ops CLI): per machine, per kind — manifest count vs
  `SELECT count(*) FROM observations WHERE producer LIKE 'desktop-harvest@%' AND
  payload->>'machineId' = $1 AND kind = $2`; plus the transaction-residue report.

## 3. Schema & data migration

**No schema change in either repo** (desktop cursor + install id ride the existing settings
KV; core observations/keys exist from Stage 7). The harvest itself is the data migration:
idempotency = deterministic `clientEventId` (lane level) + `dedup_key` (event level); batch
bound 100 events/1 MB; rate bound by the lane's 120/min/principal + the client's own 1
batch/2 s pacing; **no credits and no platform egress** — this is local-disk → kernel only
(the DP 2 day-budget condition does not bind). Progress checkpointing per table as above.
Completeness verification query: manifest-vs-observations reconciliation per machine/kind
(§2), plus archive coverage: `SELECT min(sent_at) FROM message_archive WHERE account_id=$a`
predating the account's webhook epoch.

## 4. Client compatibility

- **Desktop:** a progress note in Settings while running; no workflow change; chat, sends, AI
  untouched (harvest reads the DB on the main process's existing better-sqlite3 handle —
  WAL-mode reads don't block writers; pacing keeps CPU/IO negligible).
- **Extension / dashboard / workboard:** untouched. (Kernel-side: observation volume rises
  during the fleet run — within Stage 7's partition/alerting envelope; the lane's rate limit
  is the backpressure.)

**Compatibility invariants (target §14):** chatter bearer keys — the harvest authenticates
with the machine's existing key via the Stage 11 lane; no contract changes anywhere.

## 5. Tests & verification

**New tests:**
- Desktop (`apps/desktop/tests/harvest/`): walker chunking + cursor resume (kill mid-table,
  resume produces no gap/overlap — deterministic ids make this assertable); excluded-table
  guard (settings/summaries/media never read); manifest counts equal walked counts; purge
  blocked while a harvest is incomplete (guard in the `cmd:data.purge` path — a machine must
  not purge un-harvested history once this feature exists).
- Core (integration): each `harvest.*` kind → observation with correct producer/kind;
  `harvest.messages` fixture that duplicates a webhook-ingested message → one domain event,
  two observations (cross-producer dedup proof, extending Stage 8's CI test); transaction
  residue report lists only OFAPI-unmatched rows; re-posting a full batch → `duplicates=all`,
  zero new rows.

**Existing suites:** desktop `pnpm check`; core lane + canonicalizer suites (Stage 11) stay
green.

**Production verification (exit criteria):**
- Per-machine manifests reconcile against kernel counts (the §2 script; record per machine in
  this file).
- Archive coverage predates the webhook epoch for harvested accounts (the §3 query, recorded).
- Re-run on one machine is a no-op (`duplicates=all`, dedup proof in prod).
- Transaction-residue report reviewed by the owner (expected ≈ empty given Q1's backfill
  depth; anything real is a finding, not silently ingested).

## 6. Rollback

- The harvest is additive uploads — abort any time (cursor keeps state); captured
  observations stay (never roll back capture). Kernel-side there is nothing to unwind: no
  projection consumed harvest events destructively (transactions residue is report-only).
- Desktop module ships in a regular release; disabling the Settings action is the off switch.
- No irreversible step. The one ordering rule that must hold: **local prune policies stay at
  Stage 4 caps until the machine's manifest reconciles** — encoded as the purge/prune guard,
  not convention.

## 7. Assumptions

1. **Fleet schema versions are ≥16** (Stage 4 shipped everywhere); a lower version updates
   first — the walkers are written against v16 shapes only.
2. **What was pruned locally before Stage 4 is booked as unrecoverable** (passport rule) —
   this stage recovers what remains; no ghost-chasing.
3. **Stage 11's lane numbers hold** (100/1 MB/120-min); if fleet uploads trip kernel
   rate-limits the client pacing widens — the spool absorbs, nothing drops.
4. **`pages.ofapi_account_id` is the resolution key** for desktop accounts (unique per Q1's
   mapping check); an unmappable account's events journal with `account_id NULL` (Stage 7
   semantics) and are flagged in reconciliation rather than dropped.
5. **The single-writer gate (13) and OFAPI backfill (14) are live or in flight** — harvested
   transactions stay observation+report-only either way; nothing here writes canonical money
   rows.
6. **Local DB is SQLCipher via the app's own handle** — the harvest never reads the DB file
   from outside the app (no key export, custody unchanged).

## 8. Task breakdown

1. **Desktop walkers + cursors + pacing + deterministic ids + tests.** Files:
   `apps/desktop/src/main/harvest/*` (new), `apps/desktop/src/main/hub/index.ts` (wiring).
   Done-check: harvest unit tests incl. resume; `pnpm check`. *(1 session)*
2. **Manifest + Settings trigger UI + purge guard.** Files: harvest module,
   `DangerZone.tsx`, `index.ts` (diagnostics folder). Done-check: renderer test; manifest
   written on completion. *(0.5 session)*
3. **Core glue: kind allowlist + harvest canonicalizers + residue report + integration
   tests.** Files: core `client-capture.ts` canonicalizer family + tests. Done-check:
   cross-producer dedup test green. *(0.5–1 session — parallel with 1)*
4. **Reconciliation script.** Done-check: runs against a staging harvest, reports per
   machine/kind. *(≤0.5 session)*
5. **(Last) Fleet run:** one machine → verify manifest + dedup no-op → stage across fleet →
   run production verification (§5) and record per-machine results here. Local prune policies
   may loosen only after this task records complete. *(ops, + fleet runtime)*
