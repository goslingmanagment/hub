# Stage 4 — Desktop stop-loss release

**Repo(s):** desktop (`chatgoose_desktop_fable`) · **Depends on:** — (parallel with 1–3); Q5
(answered — risk accepted, artifact-diff mitigation kept) · **Passport:** roadmap.md §4, stage 4

**Status header — one verified drift, one proposal:**
- **Verified drift from the passport:** the desktop reports **no telemetry to the hub at all** —
  no version header, no heartbeat, no local-DB stats (verified: the only hub calls are AI-usage
  batches, OFAPI commands, and profile/credits reads; the only request header is
  `authorization: Bearer …`, `packages/shared/src/hub/client.ts:610-611,885-886`). The
  passport's exit criterion "installed clients report it (hub telemetry)" is therefore
  unsatisfiable as written, and Stage 12's "fleet inventory with local DB sizes (hub
  telemetry)" has no source.
- **Proposal 4.1 — ACCEPTED by the owner 2026-07-04 ("окей давай"):** this release adds an
  `x-client-version` header to every hub request. It is not new surface — Stage 11's core-side
  wire contract already **requires** it (`producer='desktop@<x-client-version header>'`,
  stage-11 spec §2), so adding it here merely front-loads a Stage 11 prerequisite and gives
  this stage a real exit signal (server-observed versions). Fleet *DB-stats* telemetry is NOT
  added here; Stage 12 gathers its per-machine inventory through the diagnostics-export flow
  instead (see stage-12 spec §1). If the owner declines, the exit criterion falls back to
  feed-download counts + owner check-in with the team.

## 1. Context

Chatters' machines are destroying facts daily: AI-usage events are deleted after 3 failed
upload attempts (with the acceptance metadata riding in the same rows — local-only today,
wanted by Stages 11/29), messages beyond 5,000/chat and transactions older than 31 days are
pruned on every sync pass, guard-audit rows expire at 90 days, and `cmd:data.purge` erases the
whole local DB with no notion of whether the kernel holds a copy. The kernel does not yet
capture any of this (Stages 7/11 land later); until it does, the desktop must simply stop
deleting. This is the client-side twin of Stage 1.

**Entry criteria restated as facts to verify:**
- Committed version is `0.1.27` (`apps/desktop/package.json:4`) while the production feed
  serves `0.1.28` — Q5 accepted the risk; the mitigation below is mandatory before release.
- Release path works: `windows-build` workflow (tag `v*` → build → scp to feed) per
  `docs/RELEASE.md:93-102`; feed URL `https://45-8-230-111.sslip.io/u/bffe2540bd2b7e87bd9b88e3/`
  (`apps/desktop/electron-builder.yml:60-62`).
- Auto-update applies on **Windows packaged builds only** (`shouldAutoUpdate`:
  `platform === 'win32' && isPackaged`, `apps/desktop/src/main/platform/updater.ts:19-21`;
  4 h check interval `:131`). macOS machines update manually.
- The lossy policy is live: `HUB_USAGE_REPORT_MAX_ATTEMPTS = 3`
  (`packages/shared/src/hub/usage-reporter.ts:17`), drop at `:214-224`
  (`store.remove(droppedIds)`), HTTP-400 quarantine at `:195-205` (never blind-retried),
  attempts persisted across restarts in the `usage_events` table
  (`apps/desktop/src/main/db/schema.ts:113-118`, store
  `apps/desktop/src/main/hub/usage-store.ts:53-88`).
- Prunes are live: `MESSAGE_RETENTION_DEFAULT = 5000`
  (`apps/desktop/src/main/db/queries/messages.ts:13`, applied during hydration at
  `sync/polling-sync.ts:526,646,1136`); `SPEND_RETENTION_MS = 31 d`
  (`polling-sync.ts:81`, applied at `:1403-1406`); guard-audit `TTL_MS = 90 d`
  (`src/main/message-guard/runtime.ts:18`, pruned at startup `index.ts:842` and on every
  audit write `runtime.ts:162`).

**Deliverable:** desktop `0.1.29` on the existing feed: usage spool never self-deletes,
local prune horizons raised ~10×, guard-audit TTL effectively disabled, purge warns about
kernel-unheld data, `x-client-version` sent — and nothing else changes.

## 2. Changes

**desktop — `packages/shared/src/hub/usage-reporter.ts` (the lossy policy dies):**
- Delete the drop path: attempts still increment and persist, but no attempt count ever calls
  `store.remove()` for a *failed* event (`:214-224` rewritten). Removal remains only for
  2xx-confirmed events and invalid rows at load (`:133-150` behavior kept).
- Backoff extends: `HUB_USAGE_REPORT_RETRY_DELAYS_MS = [5 s, 15 s]` grows to a capped schedule
  (`[5 s, 15 s, 60 s, 5 m, 15 m, 60 m]`, last value repeating). Events with
  `attempts >= 3` become the **dead-letter tier**: retried only on app start and on an hourly
  sweep, so a poisoned event cannot busy-loop the queue — but is never deleted.
- Quarantine (HTTP-400 schema-invalid) kept exactly (`isQuarantineFailure`, `:117-119`) and
  made **exportable**: quarantined rows (count + payloads) join the diagnostics export
  (`apps/desktop/src/main/index.ts:1070-1180` gains a `usageQuarantine` section). This is the
  passport's "kept but exportable".
- `onError({kind:'dropped'})` (`:224`) is removed with the drop path; the callback union loses
  the `dropped` kind (compile-time proof that no caller expects drops).

**desktop — prune horizons (constants only, mechanisms untouched):**
- `MESSAGE_RETENTION_DEFAULT` 5,000 → **50,000** (`db/queries/messages.ts:13`).
- `SPEND_RETENTION_MS` 31 d → **310 d** (`sync/polling-sync.ts:81`).
- Guard-audit `TTL_MS` 90 d → **3,650 d** (`message-guard/runtime.ts:18`) — effectively
  disabled, prune code kept (Stage 1's kernel pattern: raise constants, don't delete
  machinery). In scope per the passport's goal sentence ("stops destroying telemetry") and the
  target §14 perishable table, which lists the 90-day guard-audit TTL explicitly.
- `outbox` (send audit) and `ai_spend_log`/`credit_log` have no TTL today
  (`db/schema.ts:149` — "kept forever") — verified, nothing to change.

**desktop — `cmd:data.purge` interim warning (full semantics in Stage 11):**
- The DangerZone confirm flow (`renderer/src/features/settings/sections/DangerZone.tsx`,
  IPC `cmd:data.purge` → `apps/desktop/src/main/index.ts:996-1019`) gains a warning block:
  the kernel holds **no copy** of local messages/transactions/telemetry yet; purge is
  permanent loss; "export diagnostics first" is offered inline. Type-"purge"-to-confirm stays.
  No behavior change to the purge itself (Stage 11 adds `data_purge_notice` upload-then-wipe).

**desktop — `x-client-version` header (Proposal 4.1):** `packages/shared/src/hub/client.ts`
request builder adds `x-client-version: <app version>` on every hub call (version threaded
from the main process; the shared package stays platform-pure — the version is a client
constructor arg, matching the existing `hubBaseUrl` pattern, `apps/desktop/src/main/hub/index.ts:170`).

**desktop — release:** version bump `0.1.27` → **`0.1.29`** (`apps/desktop/package.json:4`,
deliberately skipping the feed's `0.1.28`), tag `v0.1.29`, `windows-build` workflow publishes
to the same feed URL. **Q5 mitigation (mandatory, before publishing):** download the served
`0.1.28` artifact, unpack both asars (`0.1.28` vs a clean local `pnpm dist:win` build of
repo HEAD), and diff — confirm nothing unmerged in `0.1.28` would be silently reverted by
`0.1.29`; record the diff result in this file.

## 3. Schema & data migration

**No schema change** — deliberate. The durable spool reuses the existing `usage_events`
columns (`attempts` already persists; quarantine marking already exists), so `SCHEMA_VERSION`
stays 16 (`apps/desktop/src/main/db/migrations.ts:30`) and a fleet rollback to `0.1.28`/`0.1.27`
cannot hit a forward-schema DB. **No data migration**; no backfill. Local DB growth is the
accepted cost (caps raised, not removed; DangerZone shows `dbBytes` via `useLocalDataStats`).

## 4. Client compatibility

- **Desktop:** chatters see nothing except the new purge warning text and a slowly larger
  local DB. Reads/sends/AI untouched. macOS installs need the manual-update step in the
  rollout note (auto-update is Windows-only).
- **Extension / dashboard / workboard:** not touched in any way.
- **Kernel:** additive only — `x-client-version` is a new request header core ignores until
  Stage 11 reads it; `/api/v1/ai-usage/batch` traffic shape unchanged (same batches, retried
  longer on failure; core's `(userId, clientEventId)` dedup absorbs re-sends —
  `repositories/ai-usage.ts:220-221`).

**Compatibility invariants (target §14):** desktop auto-update feed continuity — same URL,
same generic provider, same unsigned-trust model (`electron-builder.yml:42-51` `identity:
null` unchanged). No contract gains a successor here.

## 5. Tests & verification

**New tests (desktop repo):**
- Usage-reporter policy unit tests (`packages/shared/src/hub/usage-reporter.test.ts` extends):
  N consecutive failures → event still in store with `attempts=N` (no removal); dead-letter
  tier retried on the hourly sweep, not the hot loop; 400 → quarantined, not retried, present
  in export shape; successful flush after 10 failures drains the event exactly once.
- Prune-constant tests: message prune keeps 50,000; spend prune cutoff at 310 d; guard prune
  cutoff at 3,650 d (existing prune tests re-pinned to the new constants).
- Hub client test: every request carries `x-client-version` matching the injected version.
- Purge flow renderer test: warning copy rendered; confirm still required.

**Existing suites:** full `pnpm check` (typecheck + lint + test + build) green — the repo's
canonical gate (CLAUDE.md convention).

**Production verification (exit criteria):**
- Feed serves `0.1.29` (`latest.yml` on the feed URL); Q5 artifact diff recorded here.
- Fleet on the new version: `x-client-version: 0.1.29` observed on `/api/v1/ai-usage/batch`
  requests from every active machine within 7 days (server request logs; macOS stragglers
  chased manually).
- Zero dropped usage events over 7 days — structurally guaranteed (the drop path no longer
  compiles); verified operationally by diagnostics export showing no gaps in `clientEventId`
  continuity and the quarantine section empty (or triaged).
- Local caps confirmed via the diagnostics export (`db.counts` per-table row counts,
  `index.ts:1144-1151`) on one Windows and one macOS machine.

## 6. Rollback

- Feed rollback = re-publish the previous `latest.yml` + installer on the same feed
  (electron-updater generic provider serves whatever `latest.yml` names); no schema migration
  means old versions open the DB cleanly.
- The raised caps are constants — a rollback release restores the old numbers; data already
  retained is then pruned back by the old code (acceptable: rollback means we chose the old
  policy again; nothing the kernel needed is uploaded yet at this stage).
- No irreversible step. (`0.1.29` shipping while `0.1.28`'s provenance is unknown is the one
  accepted risk — Q5, owner-signed, mitigated by the artifact diff.)

## 7. Assumptions

1. **The feed's `0.1.28` is a version-bump-only build** (Q5, owner's judgment) — the artifact
   diff is the check; a real unmerged feature found there blocks release until recovered into
   the repo.
2. **`usage_events` volume stays modest** (AI-usage events only, ≤100/batch drain) — an
   unreachable hub for weeks grows the spool linearly; disk-bounded, surfaced in DangerZone
   stats. No cap is added on purpose.
3. **Windows auto-update uptake within days; macOS manual** (`updater.ts:19-21`); the rollout
   note to the team covers macOS.
4. **Core's ai-usage dedup holds** (`(userId, clientEventId)` `onConflictDoNothing`) so longer
   retry horizons cannot double-count spend.
5. **The shared package stays platform-pure** (repo lint rule) — the version header lands via
   injection, not `process.versions`/electron imports in `packages/shared`.
6. **Stage 11/12 depend on this stage's semantics**: spool-never-deletes is what makes the
   Stage 11 uploader a generalization and the Stage 12 harvest complete. Drift signal: any
   later change reintroducing a delete-on-failure path invalidates both — flag there.

## 8. Task breakdown

1. **Usage-reporter policy rewrite + tests** (drop path removed, backoff schedule, dead-letter
   tier, quarantine export wiring). Files: `packages/shared/src/hub/usage-reporter.ts`,
   `apps/desktop/src/main/hub/usage-store.ts`, `apps/desktop/src/main/index.ts` (diagnostics).
   Done-check: policy unit tests green; `kind:'dropped'` gone from the type union. *(0.5–1
   session)*
2. **Prune constants ×10 + guard TTL + re-pinned tests.** Files: `db/queries/messages.ts`,
   `sync/polling-sync.ts`, `message-guard/runtime.ts`. Done-check: constants tests green.
   *(≤0.25 session — parallelizable with 1)*
3. **Purge warning UI + `x-client-version` header + client test.** Files: `DangerZone.tsx`,
   `packages/shared/src/hub/client.ts`, `apps/desktop/src/main/hub/index.ts`. Done-check:
   renderer test + header test green. *(≤0.5 session — parallelizable with 1)*
4. **Q5 artifact diff** (served `0.1.28` vs clean HEAD build) — record result here; blocker if
   real drift found. Done-check: diff summary appended to this file. *(≤0.25 session)*
5. **(Last) Release `0.1.29`** (bump, tag, workflow, feed check) **and run the production
   verification** (§5), including the 7-day fleet-version watch; record results in this file.
   *(ops)*

---

## Progress

*Working scratchpad — exempt from the append-only rule. Session 2026-07-05, desktop repo branch `kernel/stage-04-desktop-stop-loss` (off local main 5d298d4).*

**Pre-flight:** deps none (parallel with 1–3); Q5 answered (risk accepted, artifact-diff mandatory — see result below). Entry facts verified: committed version 0.1.27 ✅; feed serves 0.1.28 (latest.yml, releaseDate 2026-07-01) ✅; lossy policy + prunes live at the spec's exact lines ✅; `pnpm check` is the repo gate ✅.

**§8 checklist:**
- [x] 1. Usage-reporter policy rewrite (d0c094c) — drop path deleted (`kind:'dropped'` removed from the union = compile-time proof), capped backoff [5s..60m], dead-letter tier at 3 attempts retried on start + hourly sweep, `getDeadLetterCount()`, quarantine kept + exportable (report type; wiring in 04.3); reporter/store tests rewritten to never-delete semantics
- [x] 2. Prune horizons ×10 (4a2bfcf) — messages 5,000→50,000; spend 31 d→310 d; guard-audit TTL 90 d→3,650 d; pin tests added (constant pin, behavioral 310 d prune pin, behavioral 3,650 d guard pin)
- [x] 3. Header + purge warning (e79a259) — `x-client-version` on every hub request incl. the AI-gateway stream (injected via module options; packages/shared stays platform-pure); DangerZone arming flow warns "kernel holds no copy yet, purge = permanent loss" + inline diagnostics-export button; the false "next sync rebuilds it from OFAPI" reassurance corrected; diagnostics gains `usageQuarantine` (count + payloads). **Deviation:** the spec's "purge flow renderer test" is unimplementable — the repo has NO component-test infra (no jsdom/@testing-library, zero .test.tsx, renderer tests are pure-logic only); coverage = typed i18n catalog (both locales enforced by the type) + unchanged confirm logic. Adding a component-render stack was judged out of scope.
- [x] 4. **Q5 artifact diff — assumption FALSE, release BLOCKED on reconciliation.** Served `ChatGoose-Setup-0.1.28.exe` (sha512 matches latest.yml) unpacked (7za→asar) and diffed: the app payload (`out/` bundles + package.json) is **byte-identical to a clean build of `origin/main@145260a`** ("release: bump desktop to 0.1.28"); sole delta = CRLF line endings in index.html (Windows CI checkout). So nothing exists only in the artifact — BUT 0.1.28 is NOT version-bump-only: **local main and origin/main have diverged 5-and-5**. Origin-only (all inside 0.1.28, missing locally): 01b25e7 activity-panel mockup fixture, e8016da Online snapshot staleness fix, 62d00fb Hub confirmed-send projection fix, 5ebf171 live OFAPI read-transport switching fix. Local-only (not yet on origin): b1dd980, 77d5014, 84038b8 + two doc commits. Per §7.1 the release blocks until recovered — recovery is a plain branch reconciliation, no asar archaeology needed. NB: the win build could not be produced locally (`dist:win` hard-asserts win32); the mac dir-build asar was used — valid because the asar payload is the platform-independent bundled JS (proven: win-CI vs mac builds of the same commit differ only by CRLF).
- [ ] 5. Release 0.1.29 (owner-run, AFTER reconciliation) — see steps below.

**Green-local:** full `pnpm check` (typecheck + lint + tests + build) exit 0 on the stage branch, 2026-07-05.

**Owner-run steps to exit the stage:**
1. ~~Reconcile the diverged mains~~ **DONE 2026-07-05 (session, per "you could do human items")** — merge commit `e8e7b93` on local main. The "footprints barely overlap" prediction was wrong: 6 files overlapped because *both* sides had independently fixed the same two bugs (Jul 1 origin vs Jul 2 local). Resolution: local's deeper implementations kept (insert-if-absent Hub projection — origin's engine fix composed cleanly; validate-before-swap OFAPI runtime supersedes origin's fingerprint-based live switch); origin's one non-overlapping fix — the `['online', accountId]` renderer invalidation on chats/messages/fans (Online snapshot staleness) — ported into `dbInvalidation.ts` + its test table. Backup pointer: `backup/main-pre-reconcile-20260705`. Verified: full `pnpm check` green on merged main (1,958 tests, 0 lint errors).
2. ~~Rebase the stage branch~~ **DONE 2026-07-05** — `kernel/stage-04-desktop-stop-loss` rebased onto reconciled main, zero conflicts, now @ `69a72bf`; `pnpm check` green (1,965 tests).
3. ~~Merge + bump + tag + push~~ **DONE 2026-07-05 ~02:50 UTC (owner-confirmed "Full release" via AskUserQuestion)** — main fast-forwarded to the stage branch (69a72bf), version bumped in `91d3c2d` ("release: bump desktop to 0.1.29"), final `pnpm check` green on the release commit (1,965 tests), tag `v0.1.29`, pushed `main` + tag to origin (145260a..91d3c2d). `windows-build` run 28727409498 triggered by the tag (publishes .exe + latest.yml to the feed; latest.yml uploads last by design).
4. Verify (§5): ~~feed `latest.yml` names 0.1.29~~ **VERIFIED 2026-07-05 02:52 UTC** (windows-build 28727409498 success; latest.yml: version 0.1.29, releaseDate 02:52:21Z, sha512 present). STILL OPEN: `x-client-version: 0.1.29` appears on `/api/v1/ai-usage/batch` in core's request logs from every active machine within 7 days (macOS manually chased); diagnostics export on one Win + one macOS machine shows the raised caps and an empty/triaged `usageQuarantine`.
5. Rollout note to the team: macOS updates manually; local DBs will grow (caps raised ~10×) — expected.
6. Then flip execution-log.md row 4 to `exited (prod-verified <date>, v0.1.29)`.
