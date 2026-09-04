# Agency Hub — Archived Decision Narratives

Historical implementation and review narratives removed from the living decision register on
2026-08-23. These blocks are preserved verbatim for old numeric references and archaeology;
they are not current authority. Current rules live in `docs/decisions.md`.

## Decision #3

### Backend Framework
**Decision:** Fastify + Zod.

**Score:** 9/12 chose Fastify; 3/12 chose Hono.

**Why:** Once REST wins, Fastify is the better boring server: mature plugins, straightforward Zod integration, and first-class structured logging. It is more practical for long-running API and SSE workloads than optimizing for the thinnest possible HTTP layer.

**Rejected:** Hono is viable, but its main advantage here was usually tied to tRPC rather than this project's final architecture.

## Decision #5

### Frontend Router
**Decision:** React Router.

**Score:** 7/12 chose React Router; 5/12 chose TanStack Router.

**Why:** This dashboard needs boring, well-known routing more than maximal type cleverness. React Router is easier to search, easier for AI agents to patch correctly, and fully sufficient for a small internal route graph.

**Rejected:** TanStack Router is good technology, but its extra type machinery is a marginal win for this app's routing complexity.

## Decision #22

### Sync Scheduler
**Decision:** `pg-boss`.

**Score:** 7/12 chose `pg-boss`; 3/12 chose BullMQ; 2/12 chose `node-cron`.

**Why:** `pg-boss` delivers durable scheduling, retries, concurrency control, and job visibility without adding Redis. Keeping jobs in Postgres lets the application query queue state directly and keeps operational state in one system.

**Rejected:** BullMQ would force Redis into the baseline stack for no v1 benefit. `node-cron` is too weak once missed runs, retries, and dead jobs matter.

## Decision #37

### Playwright E2E
**Decision:** Defer Playwright E2E to post-MVP.

**Score:** 6/12 included Playwright in v1; 6/12 deferred it.

**Why:** The dashboard UI will change too quickly in the first iteration to justify browser automation churn. The highest-risk v1 behavior is backend correctness around money, sync, and auth, which is better covered by Vitest and Testcontainers.

**Rejected:** A thin smoke suite now would create maintenance work on unstable screens. Skipping browser coverage forever would also be wrong once the UI stabilizes.

## Decision #68

## Phase A Close-Out — Stages 1, 2, 3, 5 Exited (2026-07-05 ~01:40 UTC)

**Decision #68:** All four stages prod-verified in one owner-compressed session (windows
shortened at explicit owner instruction — "i don't want to wait", "do everything now"):

- **Stage 1 exited.** V1: 0 rows match the purge predicate (semantic proof) and the journal
  grew 80,128→80,705 with the oldest row (2026-06-27 03:59) untouched post-deploy; the first
  live 02:30 UTC run remains armed as redundant confirmation. V2 (shortened 48 h→~1 h live
  traffic): 0 of 29,765 baseline conversations decreased; prune structurally disabled. V3: no
  new redactions (kill-switch off). V4: dm_messages raw captures flowing (1→4 rows). V5: disk
  drill passed live (incident #25, Telegram sent, threshold restored). 471,389 raw payloads
  re-stamped far-future.
- **Stage 2 exited.** Deployed in log mode; 0 `would-deny` in all api logs; flipped to
  `enforce` (owner go); live probe: 4×403 on the gated routes with a fresh chatter key
  (revoked after 60 s), 200 on spenders and the bearer surface. Deviations: 48 h log window
  shortened (~30 min + client-repo grep evidence); the dashboard UX smokes (page-delete
  click, workboard undo marker) deferred to natural use — code paths integration-tested.
- **Stage 3 exited.** V1 census: all 15 staged flags running-on on both live instances; V2
  876 archive rows/24 h; V3 28/28 spend-shadow projected; V4 ledger/balance healthy (47,338
  credits, zero incidents); V6 budgets enforcing + burn alert armed. V5 (read-gateway 200)
  recorded on combined evidence — flag running-on, bearer surface proven post-deploy, fleet
  chatter key in daily use — the direct 200 probe rides the next desktop session (no
  ofapi/read traffic in the overnight log window). dm_messages stuck-conversation anomaly
  re-surfaced as an independent ops item.
- **Stage 5 exited** per decision #67 (verify-zero; nothing to export).

Unblocked: Stages 7 (in flight), 13 (Q1), and the Phase-A-gated chain. Stage 4's exit still
awaits the desktop branch reconciliation (decision #66).

## Decision #69

## Desktop Mains Reconciled — Stage 4 Unblocked (2026-07-05)

**Decision #69:** The desktop repo's diverged mains (5-and-5, found by the Stage 4 Q5
artifact diff, decision #66) were reconciled *in-session* — the owner delegated the
remaining human items ("you could do human items"). Merge commit `e8e7b93` on local main;
safety pointer `backup/main-pre-reconcile-20260705`.

The divergence turned out to be two sessions independently fixing the same two bugs a day
apart, so the merge was semantic, not mechanical:

- **Hub confirmed-send projection:** origin's `send/engine.ts` fix (62d00fb, Jul 1)
  auto-composed with local's deeper insert-if-absent DB projection (b1dd980, Jul 2) — both
  test sets pass together.
- **OFAPI read runtime:** local's validate-before-swap design (77d5014 — candidate
  bootstrap, rollback on activation failure, `onOfapiRuntimeConfigChanged` routing) was
  kept over origin's fingerprint-based live switch (5ebf171) — two complete alternative
  implementations; mixing them piecemeal was rejected. Origin's dep name
  `onOfapiReadConfigChanged` and its plumbing are gone.
- **Ported, not lost:** origin's one non-overlapping renderer fix (e8016da, Online snapshot
  staleness) — `['online', accountId]` invalidation on chats/messages/fans db:changed —
  re-implemented inside local's extracted `dbInvalidation.ts` helper with test-table rows.

Verification: full `pnpm check` green on merged main (1,958 tests) and again on the rebased
stage branch `kernel/stage-04-desktop-stop-loss` @ `69a72bf` (1,965 tests) — the arbiter
was that BOTH sides' tests must pass in one tree. Remaining for Stage 4 exit (owner-only):
merge stage branch, bump 0.1.29, tag, **push** (both repos' local mains are now ahead of
origin — core by 21+ commits), feed verify per stage §5.

## Decision #79

**Decision #79:** Stage 13 flips to **exited** (prod-verified 2026-07-05 ~11:40 UTC).
The §5 exit condition — the first live daytime webhook spend writing through the
single-writer gate — was met twice over: a $4.99 subscription at 08:36 UTC and a
$13.00 message purchase at 10:28 UTC, both stamped `source='ofapi:webhook'` with
`source_observation_id` attached. Zero `wrong_transactions_writer` incidents; the two
`transactions.new` webhook observations since deploy map 1:1 to the two written rows
(no ingest backlog). Verified in a read-only session authorized by the owner.

Consequence: Stage 14 (OFAPI transactions truth + historical backfills) is unblocked —
its dependencies 13+5+3 are now all exited — and its build starts immediately per the
owner's standing "continue without waiting".

Same session, for the record: Stage 7 interim coverage healthy (webhook 3,130 obs /
9 kinds, pull 1,662 / 9 kinds since the 02:47 deploy; `command_result`/`operator` at
zero — traffic-dependent, watch at Monday's reconciliation). Read-gateway p95
baseline-by-logs is NOT available (no gateway lines in api logs in 24 h) — Monday's
pre-deploy baseline needs an active probe instead. The live `onlyfans/dm_messages`
bug is now evidenced: pages lora-of/lora-vip-of have NEVER succeeded; ~400 attempts/24 h
on `GET /:accountId/chats/:chatId/messages` (limit=100) all abort on the client-side
timeout — diagnosis proceeding as non-stage work.

## Decision #84

**Decision #84:** Pre-merge adversarial review of the ENTIRE unmerged surface (core
chain 8→9→10→16→17→14→11→12-glue + desktop harvest branch) ran Saturday 2026-07-05,
before Monday's one-pass merge/deploy — four independent reviewers, one per slice,
each handed the slice's invariants. Six real defects found, all fixed and re-verified
same day (core fcc06cf, suite 181 files / 1466 tests; desktop a639876, 762+1209):

- SECURITY, ingest lane (Stage 11): page resolution was global — any bearer key could
  attribute observations to any page, and harvest.* kinds were trusted from ANY
  client version, so a live client could journal harvest.messages verbatim and the
  sweep would mint FORGED message.* domain events for arbitrary pages. Fixed at both
  layers: resolution now scoped to the principal's assigned pages (owner
  unrestricted; out-of-scope → NULL account, which never canonicalizes), and the
  harvest namespace + the client-capture canonicalizer both gate on the
  desktop-harvest@ producer.
- Chargebacks (Stage 14): a truncated first full-history walk wrote partials, locking
  the page into the 90-day window forever (pre-90d chargebacks silently lost). First
  walk is now all-or-nothing; next-day run redoes it on a fresh budget.
- Desktop harvest (Stage 12): the 400-quarantine path was dead code (probed .kind;
  HubError carries .reason) — deterministic 400s would retry forever with no
  artifact; STARTED_KEY persisted before uploader validation — one Start click with
  Hub unconfigured armed the purge guard permanently; no byte budget vs the hub's
  1 MiB bodyLimit — heavy rows could 413-wedge the walk. All three fixed (900 KB
  chunk splits; oversize single events quarantine-and-skip, surfaced by reconcile's
  walked>uploaded gap). Plus: live-sync retention prunes now FREEZE while a harvest
  is incomplete (they raced the walk — rows could die before reaching the kernel),
  and purge failures surface in the UI instead of silently closing the dialog.
- Stale test pin: canonicalize-sweep expected parse_version 1 for client_capture —
  stale since dd006b2's v2 bump; the last full core suite run predated the glue
  commit. Lesson recorded: re-run the FULL suite after the last commit of a session,
  not before it.

Chain tips moved: core merge target is now `kernel/stage-14-ofapi-transactions` @
fcc06cf; desktop release branch is `kernel/stage-12-harvest` @ a639876. Runbook
updated. Also added post-deploy belt-and-braces: spot-check the 5 legacy blocked
tips rows' domain_key values after the first sweep (they must match the shared
`tip:<notificationId>` construction for self-heal).

## Decision #85

**Decision #85:** Review wave 2 — the four chain slices wave 1 didn't cover (Stages
8/9/10/16/17, built in earlier sessions and never independently reviewed) got the
same four-reviewer adversarial treatment. TEN more defects, all fixed + full suite
green same evening (478eaf8; 182 files / 1472 tests, clean re-run after the final
edit per the #84 lesson):

- Stage 8 CRITICAL: the minutely sweep had zero fault isolation — one poison row or
  transient DB error wedged canonicalization for ALL families forever (the failing
  row retries first every tick). Now per-row + per-family isolation, errored counter.
- Stage 10 CRITICAL: archive writer read only price (dollars) — every Fansly tip
  (tipAmountMills, MILLS) and harvest tip (tipAmount, dollars) archived as ZERO,
  permanent under first-writer-wins. Tip resolution now covers all three producer
  shapes. Also: out-of-order tombstones were dropped (now tombstone-first stub +
  content hydration, content_pending column in unreleased 0059, backfills hydrate);
  non-atomic reset could leave an archive permanently empty behind a stale watermark
  (now transactional).
- Stage 16 CRITICAL ×2: purchase-history keyset walk had no lease fencing (only
  such loop in the file) and no per-fan isolation — one deleted fan's 404 wedged the
  walk on that fan forever. Both fixed; fan-scoped 400/404/410 skip with anomaly,
  auth/rate-limit still propagate. stableHash replacer-array bug (nested
  breakdown[].type silently excluded) fixed NOW while dedup-key changes are free
  (prod has no domain events until the deploy).
- Stage 17: idle-path deep-backfill selection ignored the retention-limit knob.
- Stage 9: capture-drop incident latch could stick shut permanently when the
  incident open failed (rejection-based reset was unreachable — the open path
  swallows errors); boolean-return re-arm now.

Clean verdicts worth keeping: Stage 8 append protocol race-safe + gapless under
concurrency; domain_events partitions self-heal via the daily 03:10 job (3-month
lead + incident); Stage 9 tee/drainer/attribution clean; Stage 10 cents→mills ×10
single-point + archive endpoints properly page-scoped; Stages 16/17 flags-off fully
inert, mills discipline clean, migrations additive.

Chain tip moves again: merge target = kernel/stage-14-ofapi-transactions @ 478eaf8
(+ this decision commit). Both waves together: 16 defects found by review after
"test-green" — the pre-merge adversarial pass earns its place in the standard
stage-execution loop.

## Decision #86

**Decision #86:** Review wave 3 — trust-but-verify over the fix commits themselves
(three skeptical verifiers, one per fix commit fcc06cf/478eaf8/a639876). The fixes
held on 12 of 14 pointed probes; two real gaps IN THE FIXES found and closed
(core 9d30bb2, desktop 3a1087f; suites 182/1474 and 762+1211, both green):

- CRITICAL (self-suspected, verifier-confirmed at 90): purchase-history per-fan
  isolation conflated systemic failures with fan-scoped ones. A Fansly
  param-contract drift (HTTP 400 + app code 99 — probe-proven systemic) would skip
  EVERY fan, dedupe hundreds of skips into ONE warn anomaly, stamp the completion
  checkpoint, and repeat the zero-capture "success" every cadence, alert-free.
  Now: code 99 propagates; skips advance the cursor locally only (failed walks
  resume); mass-skip circuit breaker fails the run loudly when no fan succeeded.
- Chargebacks first-walk starvation: the all-or-nothing guard (#84) + the 20-page
  per-run cap = a >2000-row history could NEVER complete, discarding daily forever
  with info-only logging. First walks now cap at 200 pages (20k rows), blocked
  pages log at warn.
- Desktop sub-bar flags taken: garbage local timestamps degrade to epoch
  client-side (one unparseable observedAt would 400-wedge a whole table's harvest
  permanently — whole-batch atomicity); quarantine-write failure no longer masks
  the original 400; prune-freeze got its missing regression test.

Verified-clean worth recording: tombstone-stub protocol correct under replay and
rebuild (false ON CONFLICT WHERE = no-op, no overwrite); incident latch re-arm
cannot spam Telegram (incidentKey idempotence); stableHash single call site;
ingest scoping safe for empty assignments; no import cycles; desktop byte
accounting UTF-8-correct; prune-freeze binding window provably zero-length.

FINAL Monday tips: core kernel/stage-14-ofapi-transactions @ 9d30bb2 (+ this
decision), desktop kernel/stage-12-harvest @ 3a1087f. Three-wave total: 18 defects
after "test-green", 2 of them defects in earlier fixes — the verify-the-fix pass
is not optional.

## Decision #88

**Decision #88:** Task 3 (module extraction) is 8/10 done on
`kernel/stage-19-api-decomposition` @ 72ca544; full suite after the last
extraction commit: **186 files / 1505 tests green**. server.ts shrank
3,768 → 2,063 lines. One verified checkpoint commit per module — each gated on
typecheck + an EMPTY `contracts:generate` diff + targeted suites + the new
role matrix: workboard (2ba8c15, with the extraction scaffold), identity
(383e649), ai (9f985a6), events (245df9b, the whole SSE lifecycle),
conversations (f88d611), ingest (a0718f6), audience (bc17a6a), finance
(72ca544, incl. the overview aggregate and getRevenueDailySeries).

Mechanics that bind the remaining work:
- **Handlers moved byte-verbatim, guards intact** (deviation #87 holds). The
  scaffold is `api/request-auth.ts` (createRequestAuth: the closure helpers
  factored out unchanged; also pageScopeFor + auditCtx) + `modules/context.ts`
  (ApiServer type — the logger generic must be AppContext["logger"], not
  FastifyBaseLogger — and ApiModuleContext {appContext, auth, boss}); pg-boss
  now boots before any route registers so modules can carry it.
- **normalizeOpenApiDocument sorts spec.paths.** Extraction shuffles route
  registration order and swagger's paths object follows it; the one-time
  reorder diff (identity commit) was proven content-equal by
  canonicalized-JSON comparison (121 path templates both sides). The byte-gate
  is registration-order-independent from here on.
- **Sorting decisions vs target §6.1** (recorded, not silent): read gateway +
  ofapi commands → ingest (observation-producing custody lanes, kept with the
  webhook receiver); the credits family → ops; overviewGrowth → audience;
  the overview dashboard aggregate → finance; openApiJson stays in the
  composition root next to swagger.
- **Per-module role matrix** added to tests/auth-policy.integration.test.ts:
  one representative route per module × four principals × BOTH enforcement
  modes with log/enforce status parity asserted — behavior-level, so it holds
  through the rest of the extraction untouched.
- Verbatim-move exceptions: crossPageTransactions keeps its unused
  platformByLabel local; serializePageMetric temporarily duplicated in finance
  (server.ts copy still feeds serializeAssignedPage until catalog moves).

Remaining for Task 3 (next session, resume map in the stage's `## Progress`):
catalog (14 routes; onboarding/credentials handlers + the
queueInitialOnboardingSync helper family), ops (40 routes, ~1,300 lines), the
relative-sibling ESLint walls once the layout is final, and a dead-import
sweep. Then Task 6 (inert deploy → 48 h log window → enforce flip → guard
cleanup).

## Decision #106

**Decision #106 (2026-07-06, same session):** Stage 30 **Tasks 1–3 core
built green-local** (full suite 1675/1675) — the prompt unit migrated
byte-for-byte from the desktop (@ 1db76a4ae13d) with its 123 regression
tests green kernel-side unchanged; manifest with per-file source hashes;
0073 ai_personas; the feature-service route with the fast-reply pilot
proven end-to-end over Stage 29's gateway internals. Context loaders
reconstruct the vendor message shape from archive rows and run the MIGRATED
normalizer/formatters — parity by construction, with three NAMED gaps (PPV
purchased-state, ledger-derived spending sums, media labels) as Task 5
checkpoints. PRE-FREEZE DEVIATION recorded: the owner has not yet declared
the prompt-freeze window; the snapshot is re-verifiable against the
recorded commit, and Task 5's parity sign-off is the gate before any
client cutover. Remaining: Task 4 (other features + persona seeds), Task 5
(parity + sign-off, owner-gated), Task 6 (ops; 0071+0072+0073 deploy
together at the next owner-confirmed window).

## Decision #107

**Decision #107 (2026-07-06, same session):** Stage 30 **Task 4 built** —
all seven inventoried features serve through `/api/v1/ai/features/:feature`
(suite 1676/1676). FEATURE_POLICIES migrated with verbatim values (one
recorded adaptation: the Settings-coupled window resolver became kernel
bucket defaults seeded from the desktop's); the kernel registry is DERIVED
from the policies, so prompt behavior, model delegation, earnings
inclusion, and the product gates (draft required, deep minimum 30,
hi-greeting ≤10 lock, ping segment analysis) have ONE source of truth.
Remaining in Stage 30: Task 5 parity harness + freeze capture + sign-off
(OWNER GATE: declare the prompt freeze), persona seeding + extension
inventory (rides the freeze), Task 6 deploy/smoke/latency.

## Decision #109

**Decision #109 (2026-07-06, owner-confirmed window):** the Stage 28.4 /
29 / 30 backlog is **DEPLOYED to production** (root@45.8.230.111).
Sequence: full-chain deploy (image from 6bba967-era tree; migrations
0071_erasure_log + 0072_ai_restricted_class + 0073_ai_personas applied at
startup under the advisory lock — schema_migrations 73; all containers
healthy incl. scheduler) followed by a dist-only redeploy of HEAD 0541b22
(the first image snapshot missed the ai:personas-seed CLI by minutes —
gotcha: the docker build context snapshots at launch; anything committed
after the deploy starts needs a follow-up dist-only pass).

Post-deploy verification:
- erasure_log / ai_generation_content / ai_acceptance_events / ai_personas
  all exist; erasure and capture tables empty (nothing invoked — correct).
- Route smoke: /api/v1/ai/restricted/generations → 401 (exists,
  owner-gated); POST /api/v1/ai/features/fast-reply → 400 on empty body
  (exists, contract-validating).
- Personas seeded via ai:personas-seed: builtin:lora (7,049 chars).
- Golden-signal volume gauges live: ai_content_rows=0,
  ai_content_bytes≈40KB (empty-relation baseline) sampling minutely.
- Prod now serves: the erasure CLI (unused until a real request — the
  drill is the rehearsal), the hardened gateway (budgets + quota_denied +
  restricted capture on every generation INCLUDING the nightly classifier,
  whose next run books spend under workboard-closing), and all seven
  kernel feature services (no client consumes them until 31/32).

Stage 29's remaining exit items (production probes + invoice week) and
Stage 30 Task 6's smoke-per-feature + latency numbers run against this
deployment.

## Decision #110

**Decision #110 (2026-07-06):** Stage 30 **EXITED** — production smoke of
every feature service via the new `ai:feature-smoke` CLI (lora-of,
conversation 310112051, as admin). Headline: **kernel context+prepare =
77–159 ms** across all features — the only latency added vs client-local
assembly; provider time dominates identically in either mode (DP 5 holds
with two orders of magnitude of headroom; this is Stage 31's comparison
number). fast-reply 2.0s total / $0.024; deep features on their tuned
models (fan-summary Opus, 123s, $0.24). hi-greeting correctly 400-gated on
a long conversation — the migrated product gate firing in production.
Every smoke generation landed in ai_generation_content with its ledger
row. All §5 exit criteria met: byte-diff proof, parity sign-off (#108),
per-feature smoke with recorded latency, sanitize regressions green.
Stages 31/32 fully unblocked. Smoke spend ≈ $0.48 total (three quick
features ran twice — a parse-retry re-ran them; completions captured both
times, recorded honestly).

## Decision #138

**Addendum to #137/#138 (2026-07-11, same-day live findings):** (1) #137's
retry_wedged check was scoped to retrying/scheduled — prod immediately
demonstrated the gap: a 425-streak dm_messages flipped to
pending/backfilling between failures and /health/sync went back to 200/ok.
The streak only resets on a real success, so the check now fires in every
state except paused (deliberate operator state) and failed (already
degrades via failedStreams). (2) #138's adaptive-probe result was
remembered only per-run: every new run re-paid up to 4x60s default-limit
timeouts before re-probing down (observed live: ~5-6 min per run for a
5-20 message page). Migration 0088 adds
page_dm_message_sync_health.preferred_page_limit — probe success records
the working limit, conversation starts seed from it, and
clearConversationSyncHealth preserves it (a giant chat's incremental head
fetches need the small limit too; the row is dropped only when nothing
sticky remains). (3) The probe-eligible first fetch (default limit, no page
stored this run) is now a SINGLE attempt: a 60s hang is the giant-chat
signature, fast transport blips rethrow into the executor's stream retry.
(4) 0087 was taken by the scan-dossier session's fan_profiles migration
while this one was in flight — the sticky-limit migration shipped as 0088;
#139 stays free for the dossier ruling.

## Decision #147

**Decision #147 (2026-07-13, persona revision CAS includes archive and legacy
reconnects):** Persona revision is the lifecycle token for both update and
archive. A numeric PUT or DELETE mutates exactly one active revision; a stale
writer receives 409. DELETE encodes an explicit absent/create-only token as
`expectedVersion=0` and never interprets it as permission to remove an active
row. Replaying an archive after a lost response is idempotent and returns the
existing archived revision.

Pre-version Desktop v0.1.41 automatically PUTs every cached custom persona on
each reconnect and omits the token. That form may create an absent key or
confirm identical active content, but divergent active content and every
omitted-version active DELETE return 409. This intentionally trades old-client
write availability for shared-state safety: an old Desktop retains a rejected
edit locally, but cannot overwrite or archive a newer writer. Core must deploy
before the revision-aware Desktop. The new Desktop captures the exact editor
base revision, journals it before I/O, and reconciles a create-only archive only
when Core's full active payload matches the locally journaled base; it then
retries with the observed numeric revision. It completes the revision-bearing
lifecycle-state preflight before DELETE, preventing an old Core from stripping
the unknown CAS query and mutating first. No timestamp participates in
conflict resolution.

The bundled-persona seed keeps the legacy customization contract as part of
this lifecycle. `feature_overrides.__kernelBundledVersion` records the bundled
version without changing the public persona contract. The first post-upgrade
seed adopts an existing row at the current bundled version without changing its
name, prompt, timestamp, or revision; rerunning the same version is a true
no-op, so user customization survives. Only a strictly newer bundled version
CAS-replaces the prompt and advances the revision, while a newer stored marker
than the running binary fails closed instead of downgrading it.

## Decision #157

**Decision #157 (2026-07-15, documentation cleanup — `docs/project-kernel/`
dissolved):** The Project Kernel migration is complete, so its archive folder
and the "project-kernel / pass1 / pass2 / pass3 / maps" naming are retired; the
enduring records become normal documentation and spent scaffolding is removed.
Tombstone (family anti-deletion law):
- **Kept, relocated →** `docs/migration-history/`: all 35 stage specs,
  `roadmap.md`, `execution-log.md`, the stage-execution harness
  (`prompts/prompt-4-stage-execution.md` → `stage-execution-harness.md`), and
  `target-architecture.md`, whose §14 compatibility invariants the harness
  cites as binding. The live map generator moves from
  `docs/project-kernel/prompts/prompt-1-map.md` to
  `docs/generated/REGENERATION-PROMPT.md`, with its title and output-path
  instructions updated. The resulting migration-history tree contains 40
  tracked documents: four root records, one stage index, and 35 stage specs.
- **Deleted, git-recoverable (tracked):** all 21 superseded Pass-1 maps under
  `docs/project-kernel/maps/`, replaced by the 24 living maps under
  `docs/generated/`; the retired `prompts/prompt-workboard-design.md`; and the
  two frozen `workboard/` copies. The live Workboard brief and PRD skeleton are
  in the standalone `~/code/workboard` repo per #119.
- **Historical untracked scratch cleanup:** before its 2026-07-12 removal, the
  local-only material was archived to
  `~/code/archive/docs-cleanup-2026-07-12/core/` (not Git history): the Pass-2
  review and decision-points files; Pass-2/3 generation prompts (`prompt-2`,
  `prompt-3`, `prompt-3a-continue`, `prompt-3a-roadmap-skeleton`, `prompt-3b`,
  `prompt-3c`); `project-kernel/README.md`; the 2026-07-02 architecture review;
  the 2026-07-08 system-audit report and JSON artifacts; the seven-file
  `fix-plans-2026-07-10/` program; `prompts/{project_review,workboard_v2}.md`;
  and the completed `superpowers/plans/2026-07-07-main-review-findings-fixes.md`.
- `CLAUDE.md`, `AGENTS.md`, `SESSIONS.md`, and the two Stage-6 source comments
  are repointed in this change. Historical paths inside prior append-only
  decisions and migration records stay verbatim. The 24 generated map bodies
  are intentionally not hand-edited here: their banners still name the retired
  generator path until the immediately-following regeneration commit rebuilds
  them from `docs/generated/REGENERATION-PROMPT.md` against this structural
  snapshot (generated docs are exempt from the family anti-deletion rule).

## Decision #159

**Decision #159 (2026-07-16, encrypted off-box recovery is required;
superseded by #161 on 2026-07-17):** The database, immutable mirror
artifacts, runtime configuration required to interpret them, and encryption-key
custody metadata must have encrypted off-box backups with declared retention,
failure alerting, and a recurring restore drill into an isolated environment.
An object bucket used for export capture is not by itself a PostgreSQL backup,
and an untested upload is not recovery evidence. The implementation remains
provider-neutral and default-off until the owner selects provider, region,
retention, key custody, and budget; production activation is blocked until a
restore drill proves schema, ledger/projection rebuild, artifact checksums, and
documented recovery-time/recovery-point objectives. If those external choices
are not provisioned, the risk stays visibly open rather than being described as
closed by the mirror bucket.

## Decision #207

**Decision #207 (2026-08-02, the permanent v2 smoke consumer follows the same
projection-checkpoint protocol as real v2 clients).** Projection-only material
is intentionally omitted from the live hub, while its immediately following
`stream.projection_checkpoint` carries the exact `hiddenCount` that authorizes
the sequence jump. The SSE route already advances its per-account guard through
`advanceProjectionCheckpoint`; the smoke consumer incorrectly treated that
checkpoint as an ordinary frame and logged a GAP for every valid hidden batch.

The smoke consumer now parses the shared checkpoint shape and advances through
that same guard. Because its subscription follows every account rather than a
fixed grant set, an account created after startup is explicitly baselined at
zero before its first frame. Restart catch-up also excludes projection-only rows and uses
the same deliverable-replay batch validator as the SSE route before consuming a
row. A malformed count, a mismatched range, or an ordinary ledger gap still
takes the existing fail-closed GAP path. The persisted historical `gap_count`
is not rewritten: production verification compares its delta across the release
window, preserving prior evidence while making future error logs a truthful
signal.

## Unnumbered historical blocks

### Consensus Decisions

## Consensus Decisions
- **Language / runtime (12/12):** TypeScript on Node.js 22 LTS keeps API, dashboard, worker, and shared contracts in one well-supported stack.
- **Frontend app shell (12/12):** React SPA with Vite and TanStack Query fits a desktop-only internal dashboard without SSR overhead.
- **Database (12/12):** PostgreSQL is the obvious system of record for relational data, reporting, jobs, and JSONB snapshots.
- **ORM / query layer (12/12):** Drizzle plus handwritten SQL keeps schema definitions in TypeScript while preserving control over reporting queries.
- **Monorepo shape (12/12):** Keep one monorepo with apps and shared packages so shared contracts and domain code stay close to their consumers.
- **Authorization model (12/12):** Page-scoped RBAC matches the PRD's visibility rules and scales cleanly to new modules.
- **Platform adapter boundary (11/12):** Separate platform adapters behind one interface so Fansly and OnlyFans differences stay contained.
- **Deployment baseline (12/12):** Docker Compose on one VPS with Caddy is the right operational baseline for this scale.
- **Testing runner (12/12):** Vitest is the fastest and least controversial test runner for this stack.
- **Env config validation (10/12):** Zod-validated env config should crash fast on bad startup state instead of failing deep in a sync job.
- **Fan identity (10/12):** `(platform, platform_user_id)` matches the PRD and makes ChatMuse fan lookup direct.
- **Rate limiting + usage ledger (10/12):** Durable usage tracking plus a short-window limiter is the right baseline for internal AI features with quotas.

### Decision Matrix

## Decision Matrix
Historical appendix: this matrix preserves what the 12 source proposals chose and does not override the final rulings above.

Legend for the matrix:

- `GS1` `GS2` `GS3` = `gpt_short_1..3`
- `CF1` `CF2` `CF3` = `codex-full-1..3`
- `OS1` `OS2` `OS3` = `opus_short_1..3`
- `OF1` `OF2` `OF3` = `opus-full-1..3`

| # | Area | Grouped choices |
|---|------|-----------------|
| 1 | Language / runtime | TypeScript + Node 22 LTS (`all 12`) |
| 2 | Package manager / workspace tooling | `pnpm` workspaces, no extra orchestrator (`GS1 GS2 GS3 CF1 CF2 CF3 OS2 OF1 OF2`) `9`; `pnpm` + Turborepo (`OS1 OF3`) `2`; not explicit (`OS3`) `1` |
| 3 | Backend framework | Fastify (`GS1 GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2`) `9`; Hono (`OS1 OS2 OF3`) `3` |
| 4 | Frontend app shell | React + Vite + TanStack Query (`all 12`) |
| 5 | Frontend router | React Router (`GS1 GS2 GS3 CF1 CF2 OF1 OF2`) `7`; TanStack Router (`CF3 OS1 OS2 OS3 OF3`) `5` |
| 6 | Local UI state | Small Zustand store (`GS2 CF1 CF2 CF3 OF1 OF2 OF3`) `7`; React local state / no extra store first (`GS1 GS3 OS1 OS2 OS3`) `5` |
| 7 | Styling / component layer | Tailwind + `shadcn/ui` (`OS1 OS2 OS3 OF1 OF2 OF3`) `6`; custom or unspecified (`GS1 GS2 GS3 CF1 CF2 CF3`) `6` |
| 8 | Database | PostgreSQL (`all 12`) |
| 9 | ORM / query layer | Drizzle + handwritten SQL for reporting (`all 12`) |
| 10 | Repo shape | Monorepo with apps + shared packages (`all 12`) |
| 11 | API style | REST + shared schemas / OpenAPI (`GS1 GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2`) `9`; tRPC (`OS1 OS2 OF3`) `3` |
| 12 | Dashboard auth | Server-side or opaque cookie session (`GS1 GS2 GS3 CF1 CF2 CF3 OS2 OF1 OF3`) `9`; JWT-style session (`OS1 OS3 OF2`) `3` |
| 13 | ChatMuse auth | Long-lived API key / personal token (`OS1 OS2 OS3 OF1 OF2 OF3`) `6`; short-lived access token with refresh or token exchange (`GS1 GS2 GS3 CF1 CF2 CF3`) `6` |
| 14 | Authorization model | Page-scoped RBAC (`all 12`) |
| 15 | Secret / token storage | Encrypt at rest (`GS2 CF1 CF2 OF3`) `4`; store in DB without encryption (`OF2`) `1`; not explicit (`GS1 GS3 CF3 OS1 OS2 OS3 OF1`) `7` |
| 16 | Money representation | `BIGINT` mills (`OS1 OS2 OS3 OF1 OF2`) `5`; `BIGINT` micros or generic minor units (`GS2 GS3 CF2`) `3`; `NUMERIC` + `decimal.js` (`GS1 CF1 CF3`) `3`; integer cents (`OF3`) `1` |
| 17 | Financial ingestion model | Normalized records plus raw payload retention (`GS2 GS3 CF1 CF2 CF3 OF1 OF2`) `7`; normalized only / no explicit raw retention (`GS1 OS1 OS2 OS3 OF3`) `5` |
| 18 | Time storage / display | UTC in DB, Moscow for business display/reporting (`GS2 GS3 CF1 CF2 CF3 OF1 OF2 OF3`) `8`; not explicit (`GS1 OS1 OS2 OS3`) `4` |
| 19 | Where business period boundaries are computed | Backend (`GS3 CF2 CF3`) `3`; frontend (`OF2 OF3`) `2`; same timezone rule but location unspecified (`GS2 CF1 OF1`) `3`; not explicit (`GS1 OS1 OS2 OS3`) `4` |
| 20 | Platform integration boundary | Strict adapter interface per platform (`GS1 GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2 OF3`) `11`; not explicit (`OS2`) `1` |
| 21 | Proxy handling | Per-page or per-account proxy config in DB, applied inside adapters (`GS2 CF2 CF3 OS3 OF1 OF2 OF3`) `7`; not explicit (`GS1 GS3 CF1 OS1 OS2`) `5` |
| 22 | Deployment baseline | Docker Compose + single VPS + Caddy (`all 12`) |
| 23 | Extra infrastructure | Minimal stack, no Redis / MinIO baseline (`GS1 GS2 GS3 CF1 OS1 OS2 OS3 OF1`) `8`; Redis baseline (`CF2 CF3 OF2 OF3`) `4`; MinIO baseline (`CF2`) `1` |
| 24 | Worker separation | Separate worker process/container (`GS1 GS2 GS3 CF1 CF2 CF3 OS2`) `7`; API process also runs jobs or split not explicit (`OS1 OS3 OF1 OF2 OF3`) `5` |
| 25 | ChatMuse transport | REST `fetch` endpoints (`GS1 GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2`) `10`; tRPC client (`OS2 OF3`) `2` |
| 26 | Streaming AI responses | Plain request/response only (`GS1 OS1 OS2 OS3 OF1 OF2 OF3`) `7`; SSE for AI-only endpoints (`GS2 GS3 CF1 CF2 CF3`) `5` |
| 27 | Rate limiting + usage ledger | Durable Postgres usage ledger plus a short-window limiter (`GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2 OF3`) `10`; basic or unspecified (`GS1 OS2`) `2` |
| 28 | Sync scheduler | `pg-boss` (`GS1 GS2 GS3 CF1 CF3 OS1 OF1`) `7`; BullMQ (`CF2 OF2 OF3`) `3`; `node-cron` (`OS2 OS3`) `2` |
| 29 | Sync idempotency | Explicit checkpoints / idempotency keys / upserts (`GS2 GS3 CF1 CF2 OF1`) `5`; not explicit (`GS1 CF3 OS1 OS2 OS3 OF2 OF3`) `7` |
| 30 | Caching strategy | No Redis baseline; Postgres rollups/prompt cache, maybe tiny in-process cache (`GS1 GS2 GS3 CF1 OS1 OS2 OS3 OF1`) `8`; Redis-backed cache layer (`CF2 CF3 OF2 OF3`) `4` |
| 31 | Reporting / read models | Precomputed daily fact tables / rollups (`GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2`) `8`; mostly compute on read or not explicit (`GS1 OS1 OS2 OF3`) `4` |
| 32 | Testing runner | Vitest (`all 12`) |
| 33 | Browser E2E coverage | Thin Playwright smoke suite (`GS1 GS2 GS3 CF1 CF2 CF3`) `6`; no browser E2E initially (`OS1 OS2 OS3 OF1 OF2 OF3`) `6` |
| 34 | Error handling + logging | Pino structured logs, typed errors, Telegram alerts (`GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2 OF3`) `9`; lighter / not explicit (`GS1 OS1 OS2`) `3` |
| 35 | External error SaaS | Sentry (`GS2 CF2`) `2`; no external SaaS or not stated (`10`) |
| 36 | Notification delivery | Telegram Bot API with queued / outbox delivery (`GS2 GS3 CF1 CF2 CF3 OF1 OF2`) `7`; direct Bot API helper without queue (`OS1 OS3`) `2`; grammY / bot framework (`OF3`) `1`; not explicit (`GS1 OS2`) `2` |
| 37 | Database migrations | Forward-only Drizzle SQL migrations (`GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2 OF3`) `9`; not explicit (`GS1 OS1 OS2`) `3` |
| 38 | Migration execution | Explicit deploy step (`GS2 CF1 CF3 OF1 OF2`) `5`; auto on startup / app boot (`CF2 OF3`) `2`; not explicit (`GS1 GS3 OS1 OS2 OS3`) `5` |
| 39 | Environment config | Zod-validated typed env config (`GS2 GS3 CF1 CF2 CF3 OS1 OS3 OF1 OF2 OF3`) `10`; not explicit (`GS1 OS2`) `2` |
| 40 | Fan identity | `(platform, platform_user_id)` plus per-page relationship rows (`GS1 GS2 GS3 CF1 CF2 CF3 OS3 OF1 OF2 OF3`) `10`; not explicit (`OS1 OS2`) `2` |
| 41 | Notes / summary history | Append-only note and summary history (`GS2 OF1`) `2`; not explicit (`10`) |
| 42 | File / object storage | Postgres text / JSONB only, no object storage in v1 (`GS2 GS3 CF1 OS3 OF1 OF2 OF3`) `7`; S3 / MinIO now (`CF2 CF3`) `2`; not explicit (`GS1 OS1 OS2`) `3` |
| 43 | Raw payload retention | Keep selected raw payload snapshots (`GS2 GS3 CF1 CF2 CF3 OF2`) `6`; not explicit (`GS1 OS1 OS2 OS3 OF1 OF3`) `6` |
| 44 | AI gateway / provider boundary | Central Hub-owned provider gateway with cost tracking (`GS3 CF3 OS1 OS3 OF1 OF2 OF3`) `7`; not explicit or partial (`GS1 GS2 CF1 CF2 OS2`) `5` |
| 45 | Transaction taxonomy | Unified cross-platform enum with adapter mapping tables (`OF1 OF2 OF3`) `3`; not explicit (`9`) |
| 46 | Backup / restore | Nightly Postgres backups plus restore drills (`GS3 CF2 CF3 OF1`) `4`; lighter backup mention (`OS1`) `1`; not explicit (`7`) |
| 47 | Code quality tooling | Biome (`OF1 OF3`) `2`; ESLint + Prettier (`CF2`) `1`; not explicit (`9`) |
| 48 | Architecture docs | ADRs + per-package READMEs (`CF2`) `1`; not explicit (`11`) |
| 49 | Monitoring / health checks | Lightweight health endpoint + uptime checks (`OF3`) `1`; not explicit (`11`) |
| 50 | Internal ID convention | UUID-heavy internal IDs (`CF3 OF3`) `2`; serial / mixed / not explicit (`10`) |
| 51 | API response envelope | Generic `{ data, error, meta }` envelope (`OF1 OF2`) `2`; direct resource DTOs or not explicit (`10`) |

### Phase Sequencing Change (2026-03-08)

## Phase Sequencing Change (2026-03-08)

**Decision:** Phase 4 (OnlyFans Connect) now executes before Phase 3 (Dashboard).

**Rationale:** Dashboard should ship with both Fansly and OnlyFans data from day one. Building the dashboard first would mean retrofitting OF support later — more rework, more risk. OF Connect is backend-only and smaller scope, making it a natural predecessor.

**New order:** Phase 1 → Phase 2 → Phase 4 → Phase 3 → Phase 5+

**Impact:** Phase 3 now depends on Phase 2 + Phase 4. PRD numbering swapped (Phase 3 = OF Connect, Phase 4 = Dashboard in PRD; roadmap keeps original names with updated deps).

### ## Stage 13 Exited — Live Webhook Spend Through the Gate (2026-07-05)

## Stage 13 Exited — Live Webhook Spend Through the Gate (2026-07-05)

### ## Stage 19 Session 2 — Eight of Ten Modules Extracted (2026-07-05)

## Stage 19 Session 2 — Eight of Ten Modules Extracted (2026-07-05)

### THE BIG DEPLOY — Chain 0057–0069 Live in Prod (2026-07-06)

## THE BIG DEPLOY — Chain 0057–0069 Live in Prod (2026-07-06)

### External-Review Fix Batch Deployed — Stage 26 Shadow Window Restarted (2026-07-07)

## External-Review Fix Batch Deployed — Stage 26 Shadow Window Restarted (2026-07-07)

Three automated reviews of main (`0ebf936..1a06b5d`, `..05b6f3e`,
`..1ea4e10`) produced 25 findings; all verified in-repo before acting
(five parallel audit agents). 21 fixed across 17 commits
(`15c53ae..0d60fe9`) plus #118 (`d3a581d`); 4 no-action: R1-2 stale
(already fixed by 5021ac2/0056), R1-6 benign by design (capture-first),
R1-8 deprecated surface (#117), R3-5 optional Drizzle hygiene. Three
reviewer-proposed fixes were REJECTED and replaced: delete-children-in-
soft-delete (reverses #72 — replaced by #118 erasure coverage), inner
page_fans join in the AI name lookup (blanks un-linked fans — platform
filter instead), skip-observation-on-stale-finalize (drops a captured
fact — the idempotency key already dedupes the race).

Headline fixes: the shadow egress pacer is isolated to `shadow:vendor:*`
rows and shadow bulk claims only its class row — **all Stage 26
shadow-diff data collected before this deploy is invalid; the 48 h
observation window restarts at this deploy, and the enforce cutover must
be judged only on post-2026-07-07 numbers.** Observation idempotency keys
are per-fetch (`page:stream:run:requestSeq.N`) — multi-page chunks
journal fully (`fan_earnings_monthly` had been dropped every chunk).
Global notification incidents (null page) are listable and manually
resolvable. SDK `onAuthError` fires for raw()/SSE 401s. Webhook
transaction provenance survives REST backfill. Tombstoned pages leave the
visible-model surface. CI regenerates contracts and fails on drift; three
guard tests joined the `[sync-critical]` PR slice (19→22).
`fansly:replay-probe` refuses verdicts on dry-run/zero-call runs. The
fan_earnings walk yields `request_budget`, not null. Write eligibility
requires an active page (backfill + spend sweep). Incident resolve texts
are exhaustive per kind. Ten auth flows commit mutation+audit atomically
(`withAuditTransaction`). The #116 provisioning flow is extracted and
unit-tested. AI-context money rides `millsToDollarsNumber`. Dynamic
undici imports are lint-banned; the two ipify diagnostics ride an
`undiciRequest` re-export from http-client.

Deploy: dist-only `d3a581dc2861` (~19:00 UTC). Script verified API
health, worker healthcheck, and image labels; the `/api/v1/health/sync`
gate then timed out 8× — post-restart worker catch-up plus autovacuum
made the visible_pages aggregation exceed the 30 s per-attempt cap, and
each abandoned attempt left its query running server-side (17 stacked
backends at peak, a self-amplifying loop). The script was deliberately
stopped before exhausting retries to prevent an auto-rollback of a
healthy stack (locks released cleanly; no rollback ran); the two
remaining gates were completed by hand: sync-health 200 with pages
(56 s → 34 s as the backlog drained), `/login` 200 with the root mount.
Deploy-script follow-up for a future session: the sync gate's 30 s
per-attempt cap is too tight for cold-start churn — raise its max_time
or make the API cancel the query when the client disconnects.

Still open after this batch: prompt-1-map re-runs for
`docs/generated/00-overview.md` (claims TS 5.8/Vitest 3; repo is on
TS 6/Vitest 4) and `18-retention-erasure-tiering.md` (generator-emitted
trailing whitespace) — fresh session, hand-edit banned by their banners.

### Project-Review Fix Batch: the 4 Surviving Findings (2026-07-08)

## Project-Review Fix Batch: the 4 Surviving Findings (2026-07-08)

The Workflow-orchestrated project review (5 finder passes → adversarial
verify → 7 confirmed findings, run before the external-review batch
landed) was re-checked against `d0a4651`: two findings were already
resolved by that batch (revenue-route enforcement is live in `enforce`
on prod via `REVENUE_ROUTE_ROLE_ENFORCEMENT`; the AddChatterModal
orchestration was fixed by R3-7), one narrowed to a P4 residue (the
strictness ratchet's fail-open now only affects partial-workspace runs,
where the shrink check is skipped). The remaining four were re-confirmed
by a fresh adversarial verifier agent against ground truth, then fixed
in `22687a0..4d87146` (each commit carries the full failure analysis):

- **P1** deleted page → perpetual schedule/lease/throw/reclaim churn
  (~2–3 min cycle, forever). Planner/lease queries now require
  `p.status='active'`; the executor parks (not throws) on a missing
  page; the DELETE route pauses the page's streams. `22687a0`.
- **P2** historical `active_subscribers` decayed retroactively: the
  full-history rebuild gated on `is_current=true`. Retired rows now
  count through `least(ends_at, last_seen_at)`. Projection rebuild
  self-heals prod on the next sweep — no migration. `a651836`.
- **P2** the scheduler had no healthcheck and no deploy gate: heartbeat
  file written only after a successful instance-heartbeat upsert +
  compose healthcheck + `wait_for_scheduler_health`. Standby entries
  must not carry the healthcheck. Follow-up (small, separate): golden-
  signal alert on the sync planner queue's newest-job age, for the
  healthy-process/dead-timekeeper wedge. `7243593`.
- **P3** the Subscribers "All" chip/header showed the filtered total;
  both now ride a dedicated unfiltered `{limit:1}` count. `4d87146`.

Verification: `pnpm check` green; red-green proven for both new
integration pins (they fail on the pre-fix queries); 11 adjacent
integration suites (196 tests) green under Docker.

### Fast-Reply Freshness Wave 1 — Erasure Fence Semantics + Readthrough Reconcile (2026-07-10)

## Fast-Reply Freshness Wave 1 — Erasure Fence Semantics + Readthrough Reconcile (2026-07-10)
