# Pass 4 — Execution log (live progress board)

The running state of stage execution. Maintained by each execution session
per `prompts/prompt-4-stage-execution.md`. The stage **specs** are in
`stages/`; the **order + dependency graph** are in `roadmap.md` §4/§5; the
**append-only decision record** is `docs/decisions.md`. This file tracks
only *where each stage is*.

**Status values:** `not-started` · `in-progress` · `green-local` (code +
tests green locally, deploy prepared) · `exited` (prod-verified per the
spec's §5 check — the only status that unblocks dependents) · `blocked`.

A stage may start only when every dependency in roadmap §5 is `exited`.
"Merged" is not "exited" (roadmap §3.8).

| # | Stage | Phase | Repo | Status | Note |
|---|---|---|---|---|---|
| 1 | Kernel retention & redaction stand-down | A | core | exited (prod-verified 2026-07-05, 89fa290) | **DEPLOYED 2026-07-05 00:00 UTC** (89fa290, migrations 0052+0053, envs set, 471k raw payloads re-stamped, smoke green). Exit pending: V1 (post-02:30 UTC), V4 (+24 h), V2 (+48 h), V5 drill — see stage `## Progress` |
| 2 | Destruction-door guards + chatter-read-scope fix | A | core | exited (prod-verified 2026-07-05, 89fa290) | **DEPLOYED 2026-07-05 00:00 UTC** in `log` mode (89fa290). Exit pending: 48 h `would-deny` review → `enforce` flip → 403 probe + smoke — see stage `## Progress` |
| 3 | OFAPI staged-capture enablement completed | A | core (ops) | exited (prod-verified 2026-07-05) | 2026-07-05 00:30 UTC: checklist 6/7 PASSED (all 15 flags on both instances; archive/shadow/ledger/budgets healthy; dm_messages anomaly surfaced). Pending: V5 read-gateway smoke at the 02:36 close-out, then exits with Stage 1 |
| 4 | Desktop stop-loss release | A | desktop | released — awaiting §5 fleet verify | 2026-07-05: mains RECONCILED (merge `e8e7b93`, decisions #66/#69) → **0.1.29 RELEASED ~02:52 UTC** (owner-confirmed; main 145260a..91d3c2d, tag v0.1.29, windows-build 28727409498 success, **feed latest.yml VERIFIED = 0.1.29**; decision #70). Exit when: `x-client-version: 0.1.29` from every active machine within 7 days (≤2026-07-12) + diagnostics export Win+macOS — then flip to exited |
| 5 | OnlyMonster full historical export | B | core | exited (prod-verified 2026-07-05) | 2026-07-05 00:47 UTC: verify-zero PASSED (0 OnlyMonster rows on both OF pages, no vendor streams, 0 egress; decisions.md #67). Flips to exited with Stage 1 at the 02:36 close-out |
| 6 | Fansly server-replay gate | B | core (+ext ref) | probe-run | day-1 (#62) + **day-2 2026-07-05: identical verdicts, zero auth rejections — no check-rot after ~24 h**; days 3–5 remain (once/day via deployed CLI: `docker exec agency-hub-api-1 node apps/runtime/dist/cli.js fansly:replay-probe --page lilly-1 --page lilly-2 --calls 1`) |
| 7 | Observation journal + server-side producers | C | core | green-local+DEPLOYED (full) | **BUILD COMPLETE + FULLY DEPLOYED 2026-07-05** — §8 items 1–4 all done, all producers live. Deploy 1: 01:50 UTC (main@1a06b5d, migration 0054). Deploy 2: ~02:47 UTC (main@5c69c9c merged + deployed + pushed to origin, owner-confirmed; dist-only, health+sync verified; interim read 02:51: 13 kinds emitting, dm_conversations top pull) — 3b tail (hydration/probe/identities/OFAPI-list captures) + 4b (10 admin routes via recordAudit). Suite 168/1413. Exit = 48 h reconciliation (clock from 01:50 UTC ≈ 07.07 morning) + producer-coverage all-sources>0 + p95 settle — see stage `## Progress` |
| 8 | Domain events, canonicalization, replay | C | core | green-local | **2026-07-05: BUILD COMPLETE, suite 174/1439 green** — branch `kernel/stage-08-domain-events` @ da8f0e4 (4 slices + #73). **ORDERING DEVIATION (#73, owner "do not wait"): built on deployed-not-exited Stage 7; DEPLOY WAITS for 7's exit (~07.07).** Migration 0057 (partitioned ledger 2024→ + MINVALUE, gapless-seq + dedup companions, 8-way concurrency proof); webhook/sync-pull/command families (tips.received + fansly-DM/OM/subscriber pages deferred to replay by design); CI dedup headline PROVEN (2 observations → 1 event); minutely sweep = replay executor (~60s lag baseline); events:replay CLI. Exit after deploy: type-coverage watch + staging replay drill + lag p95 |
| 9 | Read-gateway capture-through + read attribution | C | core | green-local | **2026-07-05: BUILD COMPLETE, suite 174/1442 green** — branch `kernel/stage-09-read-gateway-capture` @ 25db387 (off Stage 8 tip — linear 8→9 chain; ordering deviation #74, deploy waits for 7's exit). Migration 0058 (ledger actor_user_id + read_gateway_capture incident kind); post-respond fail-open tee (bounded queue, drop counter + incident, producer='read-gateway', payload verbatim, template kind); attribution gateway→ledger closed (background spends NULL = system). Exit after deploy: 24 h count reconciliation + p95 vs pre-deploy baseline |
| 10 | Platform-neutral message archive | C | core | in-progress | 2026-07-05: branch `kernel/stage-10-message-archive` off Stage 9 tip (linear 8→9→10). **First stage on UNDEPLOYED substrate (green-local Stage 8) — flagged, owner instructed to continue.** Migration 0059 (`message_archive` + `projection_seq_watermarks` — spec's name was taken, deviation); event-fed writer + minutely sweep + `projection:rebuild`/`archive:backfill` CLIs; hot-table backfill carries the cents→mills conversion; endpoints owner/team_lead-gated. **Suite 175/1446 GREEN** — @ 10d8b6d (build 94bf6ca + #75). Exit after the 7→8/9→10 deploy chain: prod backfills + 48 h coverage + desktop spot-check |
| 11 | Client-capture lane (core side) + desktop hoard upload | C | core | green-local (core side) | **2026-07-05: core side BUILT** on the chain (now 8→9→10→16→17→14→11; ordering deviation — Stage 4 released-not-exited, same pattern as #73-#75). `POST /api/v1/ingest/observations` (bearer-only, x-client-version required, 1..100/1MB/120min, whole-batch atomic, dedup via Stage 7 keys → {accepted,duplicates}); unknown kinds journaled `desktop.unknown:<kind>`; registration-only canonicalizer family (client_capture, 6 desktop.* kinds, ZERO domain events by design until St.29). No schema change. **3c wire-contract memo handed over**: `chatgoose_desktop_fable/docs/project-kernel/pass3-stage-11-wire-contract.md` (untracked, new file). Exit: deploy w/ chain → desktop uploader release (3c) → ≥1 prod desktop end-to-end + idempotency + week of spool telemetry |
| 12 | Desktop local-DB harvest (one-time) | C | desktop | green-local (both halves) | **2026-07-05: BUILT both repos (#83).** Core glue on the chain @ dd006b2 (harvest kinds verbatim, ingest-time account resolution via ofapiAccountId, family v2 harvest.messages with Stage 8 key parity — cross-producer collapse CI-proven; DEVIATION: fan_transactions validation-only, residue vs TRUTH table via `harvest:reconcile`). Desktop @ a639876 on `kernel/stage-12-harvest` (walkers + UUIDv5 natural-pk ids + cursors-after-2xx + 400-quarantine + manifest + Danger-Zone UI + PURGE GUARD while incomplete; **review fixes 2026-07-05 (#84): HubError.reason quarantine detection, STARTED_KEY after uploader validation, 900 KB byte-split batches, live-sync prunes FROZEN in code while harvest incomplete, purge errors surfaced in UI**; pnpm check 762+1209 green). Exit: chain deploy → desktop release → one machine → manifests reconcile → fleet; prunes frozen until reconciled (now enforced in code, not just ops) |
| 13 | Transactions provenance, currency, single-writer gate | C | core | exited (prod-verified 2026-07-05 ~11:40 UTC) | **EXITED (decision #79)**: two live webhook spends through the gate same morning ($4.99 sub 08:36, $13.00 message purchase 10:28, both `ofapi:webhook` + observation provenance), 0 wrong-writer incidents, `transactions.new` obs↔rows 1:1. Deploy history: 03:45 UTC main@d410573, migrations 0055+0056, §5 verify #71/#72. **Stage 14 unblocked** |
| 14 | OFAPI transactions truth + historical backfills | C | core | green-local | **2026-07-05: BUILD COMPLETE same day deps exited, suite 179/1458** — branch `kernel/stage-14-ofapi-transactions` @ da3b595 (#80, off Stage 17 tip — chain 8→9→10→16→17→14). Migrations 0062 (backfill day-counter) + 0063 (fee/VAT/tax trio on transactions+shadow); backfill CLI budget-guarded (DP 2); tips.received UNBLOCKED from 3 natural fixtures (fan=user.id NOT creator user_id; shadow signal, no double-count; blocked rows sweep-self-heal); chargebacks reconcile (`{payment.id}:chargeback` — never demotes the original); fan_identities OFAPI branch (tracking/trial links, audience budget). Data-exports verdict: not adopted (~30 credits re-walks everything). **+ live-bug fix 46216dd: 60s slow-lane timeout un-starves the 2 giant DM chats.** Remaining = ops: depth probe (owner window), deploy w/ chain, §5 week |
| 15 | OnlyMonster parity gate + retirement | D | core | not-started | collapsed per Q1; subscription cancel = owner action |
| 16 | Fansly earnings & PPV order-history streams | E | core | green-local (capture side) | **2026-07-05, suite 176/1447** — branch `kernel/stage-16-fansly-earnings` @ 3cf86e4 (#76). Migrations 0060/0061; full registration sweep; handlers journal verbatim (order-history is per-fan CURSORLESS → keyset walk over page_fans); live-editable ramp gates default OFF (deploy inert). **PARSE SIDE LANDED same-day (#78, on the stage-17 branch @600284b, suite 177/1449): shapes from the EXTENSION's production parsers, units mills-confirmed; fan.earnings_observed (content-hashed dedup) + message.ppv_unlocked (composite key — no order id exists) + fan_earnings_stats projection writer + rebuild.** Remaining deferral: adapter typed schemas (post-ramp cosmetic) + read endpoint (St. 33). Exit: deploy w/ chain → ramp verifies shapes → fleet → 2-week watch |
| 17 | Fansly message backscroll backfill | E | core | green-local | **2026-07-05, suite 176/1448** — branch `kernel/stage-17-backscroll` @ 4ed6d99 (#77). Fansly DM canonicalizer LANDED (sync-pull v2, page→native-ref run context); audit CONFIRMED depth cap (`stored_message_count < retention_limit`) → live knob `fanslyDeepBackfillIgnoreRetentionLimit` lifts it; value ordering was already spender-first; `fansly:backscroll-report` manifest CLI. Exit: chain deploy → flip knob → weeks-long crawl → manifest 100% |
| 18 | Platform adapter seam | F | core | not-started | deletes dead OnlyMonster adapter |
| 19 | API decomposition + declarative authorization | F | core | in-progress (build complete) | 2026-07-05: branch `kernel/stage-19-api-decomposition`. **Tasks 1-5 of 6 ALL DONE** (sessions 1-3, decisions #87-#89): declarative auth on all 132 routes + verdict middleware (log default) + CI gate; security derived from auth; policy table + introspection; ESLint walls (path + sibling, probe-verified); **all ten §6.1 modules extracted — server.ts = 497-line composition root**, handlers verbatim, guards intact. REMAINING: Task 6 ops only (inert owner deploy → 48 h log window → enforce flip → guard-deletion cleanup slice) — steps in stage `## Progress` |
| 20 | Generated SDK + dashboard adoption | F | core | in-progress (core side complete) | 2026-07-05: branch `kernel/stage-20-generated-sdk` off Stage 19 tip (ordering deviation, owner "continue"). **Tasks 1+2+3+4 of 6 DONE @ 2d536cf** (#90/#91): @kernel/sdk generated (manifest + hash = sha256(OpenAPI); runtime mapped off Zod registry); SSE/AI helpers conformance-proven live; **dashboard fully adopted — client.ts deleted, 15 modules on typed operations, adoption gate test**; api-types.ts (14.7k lines) deleted. REMAINING: Task 5 cross-repo drift gates + drill (desktop/extension), Task 6 release ops — see stage `## Progress` |
| 21 | Event stream v2 | F | core | green-local | 2026-07-06: branch `kernel/stage-21-event-stream-v2` @ 0d28077 (chain 19→20→21; ordering deviation — built on green-local Stage 8). **Tasks 1-5 ALL BUILT** (#92): frame contract + opaque per-account cursor codec; append-commit NOTIFY + per-account hub; v2 stream/snapshot beside untouched v1 (per-account 409 incl. real retained-floor computation — Stage 28 safe); smoke consumer + migration 0064; SDK subscribeDomainEvents. v1 suite byte-untouched green. Exit = Task 6 ops: deploy → 24 h smoke (0 gaps/dups) → load measurement → first Fansly frame — see stage `## Progress` |
| 22 | Identity: sessions, device tokens, grants, attribution | G | core | green-local | 2026-07-06: built on the chain @ 89dc253 (#93): all-roles sessions (dashboard stays owner/team_lead via roleCanUseDashboard split), must-change-password gate enforced in the policy hook, device tokens (prefix-dispatched bearers, sliding 90d/cap 365d, dual-accepted on kind:apiKey), access_grants append-only log + dual-write until ACCESS_GRANTS_READ_ENABLED flips reads (grants:parity CLI), workboard attribution columns threaded. Migration 0065. content_manager TS removal deferred to ops (needs prod row check). Exit = Task 6 prod smokes + parity + read-path flip — see stage `## Progress` |
| 23 | Workboard kernel module | G | core | green-local | 2026-07-06: built on the chain @ 2c9a124 (#94), chain 19→20→21→22→23. **Tasks 1–5 ALL BUILT**: engine byte-moved into modules/workboard + platform-neutral accessor (OnlyFans boards serve); event-driven per-fan recompute (hub subscriber → pg-boss singletonKey debounce 5 s), nightly sweep demoted to reconciler w/ workboard_reconcile_drift counter; claim leases (migration **0066**; any-session+page routes, steal semantics, claims[] on the board, audit both sides); workboard.state_changed (real transitions only) + workboard.contact_retracted (once-only) module events (observationId 0 sentinel); **v1 RETIRED** (4 routes+services+repo deleted, absence pinned by contract test + 404 probe; dashboard /workboard renders the v2 board, /workboard/v2 legacy-redirects, single neutral nav entry). Suite **188/1527** (six v1 test files retire, one stage suite added). Exit = Task 6 ops: deploy 0066 → staging latency harness → two-user lease drill → week of drift=0 → prod 404 probe — see stage `## Progress` |
| 24 | Desktop migration: SDK, stream v2, direct-read removal | G | desktop | green-local | 2026-07-06: built BOTH repos in one session (#95). Desktop `kernel/stage-24-sdk-stream-v2` @ 4de27b3 (off stage-12 tip): vendored @kernel/sdk (compiled bundle, hash-pinned), HubClient = SDK delegation (send-engine suites unchanged), hub SSE on stream v2 (opaque cursor, mapDomainFrame onto the untouched SyncEvent union, hubSyncProtocol v1 fallback flag), device-token sign-in (resolveHubCredential feeds all consumers), **direct reads DEAD** (transport literal, ofapiKey decommissioned on boot, compiler-driven sweep). Core enablers on the chain @ 907315b: vendor script (St.20 T6 partial), SDK surface/strictness/error-code fixes, v2 frames desktop-consumable (refs+accountRef+message payload enrichment+ephemeral typing lane — the #92 payload tail), break-glass runbook. Suites: core 188/1530, desktop 772+1223. Exit = Task 6 ops: staged release → zero v1 SSE (feeds St.25) → week of freshness → team-key rotation — see stage `## Progress` |
| 25 | Worker scale-out; global-ordering retirement | H | core | not-started | |
| 26 | Egress & pacing unification; auth-dead pause | H | core | not-started | |
| 27 | Money-unit consolidation | H | core | not-started | Proposal 1 — no data migration |
| 28 | Retention tiering, lake, metrics, erasure | H | core | not-started | on-box (Q3); backup risk re-accepted — write tombstone in decisions.md |
| 29 | AI gateway hardening + restricted capture class | I | core | not-started | |
| 30 | AI feature services + prompt migration | I | core | not-started | |
| 31 | Desktop AI cutover | I | desktop | not-started | cutover = feature services, not transport flip |
| 32 | Extension cutover | I | extension | not-started | Proposal 32.1 (a) — kernel `compare` feature |
| 33 | Dashboard modernization | J | core/dashboard | not-started | |
| 34 | Workboard application | J | workboard (new repo) | design-pending | placeholder — awaits DP 4 design pass (Q4) |
| 35 | Re-documentation & family standard | J | all | not-started | commits both client repos' Pass 1 maps first |

## Standing risks & ops tails (carry until closed)

- **No off-box backup** (Q3 re-accepted): VPS loss = total history loss. Re-raise no later than **Stage 28**; Stage 28 writes the tombstone, does not build a mirror.
- **Stage 6 longevity**: ≥5-day daily re-probe to measure session check-rot. Day-1 was enough to green-light Stage 16; longevity still open.
- **Live prod bug (outside the plan)**: `onlyfans/dm_messages` stuck on 2 conversations — OFAPI timeouts, ~93 retries/48h, 0 successes. Not a stage; flagged for separate attention.
- **Dirty working tree**: RESOLVED 2026-07-05 — committed as two groups on main: Stage 6 probe (90110ba), OFAPI-credits dashboard rework (c54fa5d).
- **Desktop repo mains DIVERGED** — RESOLVED 2026-07-05: reconciled by merge `e8e7b93` (decisions #69); local main now carries both sides. **New tail: both repos' local mains are ahead of origin (core: 21+ commits; desktop: merge + docs) — owner must push.**

## Monday 2026-07-07 runbook (single pass, after the 48 h window closes ~01:50 UTC)

Every prod-touching step needs its own owner confirm (SSH read / merge+push / deploy /
flips are separate capabilities). Chain tip to merge: `kernel/stage-14-ofapi-transactions`
@ **23e827c** (contains 8→9→10→16→17→14→11→12-glue + tips-v2 + fleet observer +
dm_messages fix + ALL THREE 2026-07-05 review waves: #84 fcc06cf — ingest
page-scope + harvest producer gates, chargebacks first-walk guard; #85 478eaf8 —
sweep fault isolation, archive tip units + tombstone-first + transactional reset,
purchase-history lease-fencing + per-fan isolation, incident-latch re-arm,
stableHash deep canonicalization; #86 9d30bb2 — purchase-history mass-skip
breaker + code-99 taxonomy, chargebacks first-walk 200-page headroom). Suite at
tip: 182 files / 1474 tests. Desktop release branch: `kernel/stage-12-harvest`
@ **3a1087f** (400-quarantine via HubError.reason, purge-guard arming, byte-split
batches, frozen prunes + test, epoch fallback for garbage timestamps; 762+1211).

1. **Reconcile & exit Stage 7** (read-only SSH): producer coverage by source over the
   48 h window — webhook/pull proven; `command_result`/`operator` were 0 through 11:35
   on 07-05 (traffic-dependent) — if still 0, trigger one desktop command + one admin
   action and re-check rather than fail the exit. Then flip row 7 to exited (+decision).
2. **Merge the chain** into main (owner): `git merge kernel/stage-14-ofapi-transactions`
   — linear, should be conflict-free. Push.
3. **Gateway p95 baseline BEFORE deploy** — log-based measurement is impossible (0
   gateway lines in api logs/24 h); use an active probe: ~20 sequential
   `GET /api/v1/ofapi/read/<cheap path>` with the chatter key, record timings (spends
   ~20 credits — owner go).
4. **Deploy**: `scripts/deploy-production.sh --mode dist-only root@45.8.230.111` —
   migrations 0057–0063 apply in one pass (all additive; new flags default off; ramp
   gates off ⇒ deploy inert). Post-deploy smoke: health + sync + observation journal.
5. **Post-deploy immediate**: p95 probe again (compare vs 3); `archive:backfill` both
   sources; watch the canonicalize sweep — webhook-family v2 re-scans the corpus once
   (append-zero by dedup; tips events + the 5 blocked tips_signal rows appear);
   `projection:rebuild` not needed (sweeps converge). Fleet observer lines start as
   desktops call in ("Desktop client version observed"). Belt-and-braces (#84):
   spot-check the 5 legacy blocked tips rows' `domain_key` values after the first
   sweep — they must match the shared `tip:<notificationId>` construction, else the
   self-heal produced duplicates instead of flips.
6. **Flips (owner, staged)**: Stage 16 ramp on lilly-1/lilly-2
   (fanslyFanEarningsSyncEnabled + fanslyPurchaseHistorySyncEnabled + allowlist) →
   shapes verify → fleet. Stage 17: fanslyDeepBackfillIgnoreRetentionLimit. Stage 14:
   ofapiChargebacksReconcileEnabled + ofapiFanIdentitiesSyncEnabled; then the depth
   probe dry-run per page (+ data-exports quote probe) in the same credit window.
7. **Watches armed**: Stage 8 type-coverage + lag p95; Stage 9 24 h capture-count vs
   gateway 2xx + p95 delta; Stage 10 48 h archive coverage; Stage 14 week of burn
   telemetry; Stage 17 weekly `fansly:backscroll-report`; Stage 4 fleet grep (deadline
   07-12); Stage 6 day-4/5 probes; dm_messages: confirm the two stuck conversations
   finally complete under the 60 s timeout (`page_sync_states` succeeded_at goes
   non-null on lora-of/lora-vip-of).
