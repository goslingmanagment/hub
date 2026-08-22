# Agency Hub — Technical Decisions

## Quick Reference

Scan here, then grep the full entry by number. Every new numbered decision
appends a row here in the same change (family law: updated-in-change).

| # | Area | Decision |
|---|------|----------|
| 1 | Language | TypeScript + Node.js 22 LTS |
| 2 | Workspace | `pnpm` workspaces monorepo; no Turborepo/Nx in v1; exact package granularity left to the implementer |
| 3 | Backend Framework | Fastify + Zod |
| 4 | Frontend | React 19 SPA with Vite and TanStack Query |
| 5 | Frontend Router | React Router |
| 6 | Frontend Client State | Zustand from day 1 for cross-component UI state |
| 7 | UI Layer | Tailwind CSS + `shadcn/ui` |
| 8 | Database | PostgreSQL 16 |
| 9 | ORM / Query Layer | Drizzle ORM plus handwritten SQL for reporting queries |
| 10 | API Style | REST JSON under `/api/v1` |
| 11 | API Contracts | Zod schemas as source of truth; generate OpenAPI and typed clients from them |
| 12 | Dashboard Auth | Argon2id passwords + HttpOnly Postgres-backed sessions |
| 13 | ChatMuse Auth | Scoped API keys, one per chatter account, hashed and revocable |
| 14 | Authorization | Page-scoped RBAC for `owner`, `team_lead`, `chatter`, `content_manager` |
| 15 | Money | Store monetary amounts as `BIGINT` mills plus `currency` and raw source amount |
| 16 | Time Handling | Store UTC `timestamptz` in DB; use UTC business dates for product analytics |
| 17 | Reporting Period Semantics | Backend computes UTC business-date boundaries; trailing windows include today |
| 18 | Platform Adapters | Strict adapter boundary per platform with canonical normalized DTOs |
| 19 | Fan Identity | `(platform, platform_user_id)` plus per-page relationship rows |
| 20 | Proxy Handling | Per-page proxy configuration in DB, applied inside adapters |
| 21 | Secret Storage | Encrypt platform tokens and proxy credentials at rest |
| 22 | Sync Scheduler | `pg-boss` on Postgres |
| 23 | Worker Role | Separate worker process role via the same image with a different CMD; not a separate service and no RPC |
| 24 | Caching / Redis | No Redis in v1; use Postgres rollups, Postgres prompt cache, and in-memory short-window limiting |
| 25 | ChatMuse Protocol | REST for normal endpoints; SSE only for AI streaming endpoints |
| 26 | AI Gateway | Hub-owned Claude gateway with quotas, cost ledger, provider response IDs, and per-page/model prompt cache |
| 27 | Notifications | DB-backed alerts + queued Telegram Bot API delivery; owner-only critical alerts plus one daily summary destination |
| 28 | Raw Payload Retention | Store mapping-critical and failed payload snapshots as `jsonb` for 180 days |
| 29 | Sync Idempotency | Checkpointed syncs: upsert raw events first, then rebuild projections |
| 30 | Transaction Taxonomy | Compact 9-bucket internal enum with adapter mappings |
| 31 | Notes / Summary History | Append-only notes; summaries append new versions instead of overwriting |
| 32 | Reporting Rollups | Precomputed daily fact tables for revenue, followers, and subscribers |
| 33 | Logging | Pino structured JSON logs |
| 34 | Migrations | Forward-only Drizzle SQL committed to git and run explicitly during deploy |
| 35 | Env Config | Shared typed config with Zod validation at startup |
| 36 | File Storage | Postgres text/JSON only; no binary or object storage in v1 |
| 37 | Testing | Vitest + Testcontainers; Playwright deferred to post-MVP |
| 38 | Deployment | Docker Compose on one VPS with Caddy |
| 39 | CI/CD | GitHub Actions builds, publishes to GHCR, and deploys over SSH |
| 40 | Code Quality | ESLint + Prettier |
| 41 | Backups | Nightly full Postgres backups stored off-VPS, with restore drills |
| 42 | Health Checks | Lightweight `/health` plus token/proxy health checks |
| 43 | Audit Trail | Append-only audit log for sensitive admin actions |
| 44 | Fansly Auth Headers | Only `authorization` header is required; `fansly-client-id`, `fansly-client-check`, `fansly-session-id` are optional — include when available, omit when not |
| 45 | Payout Reversal (16013) | Fansly raw_type 16013 maps to `payout_reversal` — store in transactions for audit, but exclude from net revenue calculations and `daily_revenue` rollups |
| 46 | Revenue Classification | Shared classification metadata in `types.ts` with 4 reporting buckets (revenue, adjustment, unclassified, excluded) + `affectsFanLtv` flag; no DB schema change; query/service/API/CLI layers consume classification; `netEarningsMills = revenue + adjustments + unclassified`; `totalNetMills` kept as deprecated alias |
| 47 | Dashboard Fan Navigation | Keep `fan` as an internal CRM/data model and API concept, but do not ship a standalone dashboard `Fans` section by default; only surface it when the UI delivers spend-ranked or CRM workflows that are clearly distinct from followers/subscribers |
| 48 | OFAPI Real-Time Pipeline | OFAPI webhook receiver (raw-body HMAC, header-based dedupe, journal table) + pg-boss async processing + SSE fanout `GET /api/v1/events/stream` with `Last-Event-ID` replay; pages map to OFAPI accounts via `pages.ofapi_account_id`; ChatMuse profile PUT auto-creates OnlyFans fans |
| 54 | OFAPI Desktop Read Gateway | Default-off chatter-key `GET /api/v1/ofapi/read/*` compatibility gateway with assigned-page ACL, strict path/query allowlist, central credit ledger, and no write/upload/send routes |
| 55 | OFAPI Command Outbox | Core-owned, default-off command intake with stable client ids, page/chatter dedupe, explicit indeterminate outcomes, retry lineage, and a separate execution flag; no generic write proxy |
| 56 | OFAPI Command Executor | Separately staged one-attempt text execution with no automatic retry, page-attributed credit accounting, webhook repair, and terminal payload redaction |
| 57 | DM Aggregate Analytics | Replaceable aggregate-only UTC daily facts over the governed cold archive; no transcript text, media URLs, or fan identifiers |
| 58 | OFAPI Typing Command Custody | Empty-payload `typing_active_v1` command through the core outbox/executor; no retry, no webhook text matching, zero fallback credits, Direct rollback retained |
| 59 | OFAPI Unsend Command Custody | Numeric-target `unsend_message_v1` command through the core outbox/executor; no retry, one DELETE attempt, bounded audit surface, Direct rollback retained |
| 60 | OFAPI Mark-Read Command Custody | Empty-payload `mark_chat_read_v1` command through the core outbox/executor; no retry, one mark-as-read POST, bounded audit surface, Direct rollback retained |
| 61 | OFAPI Media/PPV Send Command Custody | Bounded `send_media_message_v1` command for existing media IDs; one send attempt, same-kind retry lineage, webhook repair by text/price/media-count only, Direct rollback retained |
| 62 | Fansly server-replay gate (Pass 3 Stage 6) | Day-1 probe: all three DP-1 endpoint families (earnings stats, monthly stats, PPV order history) are REPLAYABLE server-side with the single pasted `fansly-client-check`; no per-route anti-bot token needed. Clears kernel-only Fansly capture (DP 1-B) for Stages 16/17 |
| 63 | Kernel retention & redaction stand-down (Pass 3 Stage 1) | All scheduled/automatic destruction of business facts stopped: retention defaults+envs → 36500 d (webhook journal, DM cold archive, sync raw payloads); page_dm prune + command payload self-redaction behind default-OFF env kill-switches; DM-message sync gains raw persistence (`payload_kind='dm_messages'`, 3 paths); consumed-only guard on the journal purge; hourly disk-usage alert (migration 0052, additive enum value) |
| 64 | Pass 3 spec fixup (pre-execution review) | Doc-only amendments: Stage 7/8 key-table insert protocols made implementable (pre-allocated ids + OVERRIDING SYSTEM VALUE); dependency graph tightened (31/32←11, 33←20, soft 26←19, mutual soft 28↔29); Stage 20 method/path recovered by booting buildApiServer; sensitive kinds excluded from the generic lake into lake/restricted |
| 65 | Kernel destruction-door guards + chatter-read-scope (Pass 3 Stage 2) | One-action data-loss doors closed: raw revenue routes role-gated behind REVENUE_ROUTE_ROLE_ENFORCEMENT (log→enforce); messages_history reset refuses 409 until the Stage 10 archive; fact-bearing page DELETE refuses 409; workboard undo → retraction marker; reclassify → soft-supersede append log (partial active unique, migration 0053) |
| 66 | Desktop stop-loss (Pass 3 Stage 4) | Desktop stops destroying facts: usage spool never self-deletes (dead-letter tier; drop path removed at the type level); prune horizons ×10 (messages 50k, spend 310 d, guard-audit 3650 d); purge flow warns kernel-holds-no-copy; `x-client-version` on every hub request (Proposal 4.1). Q5 diff verdict: served 0.1.28 = desktop origin/main@145260a byte-exact, but the desktop repo's local/origin mains diverged 5-and-5 — 0.1.29 release blocked until the owner reconciles |
| 67 | OnlyMonster export is vacuous (Pass 3 Stage 5) | Verify-zero census 2026-07-05: lora-of 685/685 and lora-vip-of 2168/2168 transactions OFAPI-sourced (0 OnlyMonster rows), no OnlyMonster streams in the 7-day sync_runs window, 0 omapi.onlymonster.ai egress. No export to run; no off-box archive created (Q3 declined). Subscription cancellation stays Stage 15; adapter deletion stays Stage 18 |
| 68 | Stages 1/2/3/5 exit | All four stages prod-verified and exited in one owner-compressed session (verification windows shortened at explicit owner instruction); unblocks Stages 7, 13 and the Phase-A-gated chain |
| 69 | Stage 4 desktop reconcile | The desktop repo's 5-and-5 diverged mains reconciled in-session (merge e8e7b93): local's validate-before-swap OFAPI read runtime kept over origin's live switch; arbiter = both sides' tests pass in one tree |
| 70 | Release ops (Stages 4/6/7) | Owner delegated the remaining pipeline actions with each gated capability re-confirmed: Stage 7 slice deployed, core pushed (prod = origin = local), desktop 0.1.29 released, Stage 6 day-2 probe clean |
| 71 | Stage 13 provenance | Stage 13 green-local: migrations 0055/0056 add transaction provenance columns + a single-writer gate and flip 22 pages FKs to RESTRICT; page DELETE becomes a tombstone, replacing the Stage 2 handler 409 |
| 72 | Stage 13 deploy/verify | Stage 13 merged (d410573) and deployed; §5 verified — 100% source coverage on 15,413 rows, byte-identical revenue totals, writer seed matches reality, zero wrong-writer incidents, zero ingest backlog |
| 73 | Stage 8 domain events | Stage 8 green-local: migration 0057 partitioned domain_events, gapless append proven under 8-way concurrency, three canonicalizer families, cross-producer dedup proven in CI; deploy waits for Stage 7's exit |
| 74 | Stage 9 read-gateway capture | Stage 9 green-local: every gateway 2xx teed into the journal post-respond (bounded queue, fail-open with drop counter and incident kind); migration 0058 adds ofapi_credit_ledger.actor_user_id for attribution |
| 75 | Stage 10 message archive | Stage 10 green-local: migration 0059 platform-neutral message_archive + projection watermarks, event-fed writer, one-command rebuild proven, idempotent backfills; first stage built on an UNDEPLOYED substrate |
| 76 | Stage 16 Fansly earnings | Stage 16 green-local is capture-first only: the projection table ships (0061) but the parse side (adapter typing, canonicalizers, projection writer, read endpoint) is DEFERRED until a live payload corpus exists |
| 77 | Stage 17 Fansly backscroll | Stage 17 green-local: the deferred Fansly DM canonicalizer lands with per-run direction context; live-editable fanslyDeepBackfillIgnoreRetentionLimit lifts the depth cap for the exhaustion crawl; report CLI added |
| 78 | Stage 16 parse side | Owner asked for the canonicalizer pre-ramp; the deferral's premise fell (the extension already parses these shapes in production), so sync-pull v3 + the fan_earnings_stats writer land and the ramp only verifies |
| 79 | Stage 13 exit | Stage 13 EXITED — the first live daytime webhook spends ($4.99 and $13.00) wrote through the single-writer gate stamped source='ofapi:webhook'; Stage 14 unblocked |
| 80 | Stage 14 OFAPI transactions | OFAPI data-exports lane priced and NOT adopted (full REST re-walk ≈30 credits); Stage 14 built green-local — backfill day-budget guard, fee/VAT capture (0062/0063), tips as shadow signal, chargebacks, fan_identities |
| 81 | Stage 14/4 follow-ups | Two same-day tails: ofapi-webhook canonicalizer v1→2 declares tips.received as its own tip.received event; a bounded observer logs desktop x-client-version so Stage 4's fleet-verify check has a data source at all |
| 82 | Stage 11 ingest lane | Stage 11 core side green-local: POST /api/v1/ingest/observations (bearer-only, batch/size/age caps, whole-batch atomic); the client_capture family is registration+validation only — no domain events until Stage 29 |
| 83 | Stage 12 desktop harvest | Stage 12 built in both repos: core accepts `harvest.<table>` kinds under producer `desktop-harvest@<version>` with account resolution moved to ingest; desktop gains rowid walkers, UUIDv5 ids, quarantine and a purge guard |
| 84 | Pre-merge review wave 1 | Adversarial review of the entire unmerged surface found six defects, all fixed same day — headline: ingest page resolution was global and harvest kinds trusted from any client, allowing FORGED message domain events |
| 85 | Pre-merge review wave 2 | Review of Stages 8/9/10/16/17 found ten more defects — the sweep had zero fault isolation, the archive writer read only dollars (tips archived as ZERO), the purchase walk lacked lease fencing and per-fan isolation |
| 86 | Pre-merge review wave 3 | Trust-but-verify over the fix commits themselves: fixes held on 12 of 14 probes and two gaps IN the fixes were closed (systemic-vs-fan-scoped skip conflation, chargeback first-walk starvation) |
| 87 | Stage 19 declarative auth | Stage 19 session 1: all 132 routes carry auth declarations, the verdict middleware reuses the legacy guards (AUTH_POLICY_ENFORCEMENT default log), OpenAPI security derives from auth; in-handler guards NOT deleted yet |
| 88 | Stage 19 module extraction | Task 3 is 8/10 done — handlers moved byte-verbatim with guards intact, server.ts 3,768 → 2,063 lines; normalizeOpenApiDocument sorts paths so the byte gate is registration-order-independent |
| 89 | Stage 19 composition root | Extraction DONE: all ten modules own their routes and server.ts is a 497-line composition root; relative-sibling ESLint walls landed; only Task 6 ops (inert deploy → log window → enforce flip) remains |
| 90 | Stage 20 generated SDK | @kernel/sdk is deliberately tiny — an operations manifest plus contract hash, with methods mapped generically off routeSchemas; the contract hash is sha256 of the normalized OpenAPI; api-types.ts (14,753 lines) deleted |
| 91 | Stage 20 dashboard adoption | The dashboard runs end-to-end on @kernel/sdk: 15 modules re-implemented over typed operations, client.ts/utils.ts deleted, and the direct-fetch ban enforced by a TEST because the dashboard tree is not ESLint-covered |
| 92 | Stage 21 event stream v2 | Stage 21 built whole beside byte-untouched v1: per-account frames, an opaque base64url cursor, pg_notify fanout inside the append transaction, per-account 409 with a computed retained floor, and a smoke consumer (0064) |
| 93 | Stage 22 identity | Stage 22 (0065): sessions open to all roles while the dashboard door stays owner/team_lead, must_change_password, device tokens (90 d sliding, 365 d cap), and append-only access_grants dual-written until the read flip |
| 94 | Stage 23 workboard module | The workboard becomes a platform-neutral kernel module: recompute is event-driven with the nightly sweep demoted to a drift reconciler, claim leases (0066) are soft coordination not access control, and v1 routes retire |
| 95 | Stage 24 desktop kernel client | Desktop becomes a pure kernel client: the SDK ships as a compiled vendored bundle, hub-sync swaps to stream v2 opaque cursors, device-token sign-in lands, and direct OFAPI reads are removed (DP 8) |
| 96 | Stage 25 scheduler + signals | A leader-elected scheduler role becomes the single timekeeper (api and workers construct pg-boss with schedule:false); ordering property harness added; golden signals land as ops_metric_samples + golden_signal_lag (0067) |
| 97 | Stage 27 money codec | Money brands are compile-time only (Mills = bigint, MicroUsd = number); one already-mills constructor absorbs toMills, dollarsToMills survives as an honest alias; ESLint ban plus a money-float ratchet (budget 9) enforce it |
| 98 | Stage 18 platform seam | packages/platform-core lands and its registry is live in the dispatch path (an undeclared stream now fails loudly instead of running the wrong platform's handler); all six mixed handlers split; branch ratchet starts at 64 |
| 99 | Stage 18 OnlyMonster deletion | packages/onlyfans deleted whole (−7,742 lines), OF pages resolve token-less, credential surfaces re-pointed to OFAPI semantics; migration 0068 replaces the platform enum with a platforms reference table; relocation deferred |
| 100 | Stage 26 egress seam | The resolver owns address policy (page scope = the page's proxy, vendor ofapi = direct, vendor fansly REFUSED); pacing is two-phase bulk (0069) behind EGRESS_PACER_MODE off/shadow/enforce; auth-dead pages pause whole |
| 101 | Chain deploy 0057–0069 | The entire built backlog (Stages 8–27 incl. 18 and 26) merged and deployed in one pass with migrations 0057–0069; a live defect was found and fixed within the hour (the sweep skipped the whole 11k webhook corpus) |
| 102 | Stage 28 retention | sync_runs bounded to 30 days and ops_metric_samples to 90; DM prune returns as a coverage-gated cache policy; the redaction switch is deleted for good; the sanctioned scheduled deleters are enumerated and pinned |
| 103 | Stage 28 tiering | Tiering is export→verify→detach in that absolute order with detached partitions PARKED in tiered_pending_drop (no DROP exists in code); restore drills run from Parquet alone; metrics models reconcile with revenue_daily |
| 104 | Stage 28 erasure | Audited break-glass erasure (erasure:run CLI, migration 0071) reaches every plane incl. parked partitions and the lake; catalog rows survive, fan-scope transactions are ANONYMIZED not deleted, no post-erasure rebuilds |
| 105 | Stage 29 AI gateway | generation_ref = the gateway's existing requestId; quota/budget denials are ledger facts plus HTTP 429; per-feature budgets are GLOBAL per day; all outcomes captured restricted; vendor AI SDKs banned outside providers (0072) |
| 106 | Stage 30 prompt migration | The prompt unit is migrated byte-for-byte from the desktop (@1db76a4ae13d) with per-file source hashes in a manifest, 0073 ai_personas, and the feature-service route proven end-to-end; three named context-loader gaps |
| 107 | Stage 30 feature services | All seven inventoried features serve through /api/v1/ai/features/:feature; FEATURE_POLICIES migrated with verbatim values and the kernel registry is DERIVED from them, giving the product gates one source of truth |
| 108 | Stage 30 prompt freeze | Owner DECLARED the prompt freeze and SIGNED OFF parity — kernel buildPrompt output is byte-identical to the desktop's across 9 fixtures; caveat: context-VALUE parity for three loader gaps is a Stage 31 checkpoint |
| 109 | Stage 28.4/29/30 deploy | The 28.4/29/30 backlog deployed to production (migrations 0071+0072+0073) plus a dist-only redeploy; gotcha recorded — the docker build context snapshots at launch, so later commits need a dist-only follow-up pass |
| 110 | Stage 30 exit | Stage 30 EXITED on a production smoke of every feature service: kernel context+prepare is 77–159 ms, the only latency added over client-local assembly; all §5 criteria met and Stages 31/32 unblocked |
| 111 | Stage 31 desktop AI cutover | The desktop's local AI machinery is deleted (−10,693 lines) so the kernel feature lane is the only path: acceptance lifecycle on the capture spool, personas as kernel CRUD, vendor keys decommissioned; NOT released |
| 112 | Dashboard rebuild | Owner ordered a FULL dashboard REBUILD instead of Stage 33's incremental modernization; apps/dashboard deprecated until parity sign-off, Stage 33 requirements carry over as PRD inputs. LATER REVERSED by #117 |
| 113 | Family CI + toolchain | Core ESLint raised to the family standard with its 162-violation backlog burned to zero, `pnpm check` added, pnpm 10.33.1/Node 22/TS 6/vitest 4 pinned family-wide, and a strictness ratchet enforced as `pnpm typecheck` |
| 114 | Stage 35 documentation close | Maps regenerated in all three repos, client CLAUDE.md files rewritten to post-migration truth, release-hygiene asserts added, orientation drills PASS ×3 — the migration's documentation standard is in force |
| 115 | Release audits | Codex (gpt-5.5 xhigh) audited three surfaces pre-release: the lint burn-down is behavior-neutral, chunk-budget overshoot and any-platform clientContext fixed; persona apiKey-auth left open, then ACCEPTED AS IS by the owner |
| 116 | Identity/auth credentials | Humans authenticate with password plus per-device tokens, robots with API keys; chatter password provisioning moves into the live dashboard; must_change_password stays FROZEN; a client key-fallback deletion gate is defined |
| 117 | Dashboard + workboard | #112 REVERSED — the rebuild is CANCELLED and apps/dashboard is the live maintained admin surface (its carry-over features become backlog); the workboard direction is deprecated and Stage 34 stays a banner'd placeholder |
| 118 | Stage 28 erasure scope | Page-scope erasure also purges the page's config/secret rows (page_credentials, egress_endpoints), which soft delete (#72) deliberately keeps as a two-way door; DP 7 unaffected since these are config, not captured facts |
| 119 | Stage 34 standalone workboard | #117 clause (2) NARROWED — only the in-core workboard is deprecated; the STANDALONE workboard app is an ACTIVE direction again with kernel sessions, per-page grants, repo ~/code/workboard, Fansly-only v1 |
| 120 | AI gateway quotas | Daily caps per chatter/page raised (requests 200→500, cost $5→$10) and quota denial made legible end-to-end: the SDK classifies 429 as rate_limit and the desktop gains CG-HUB-03; product gates later get machine codes |
| 121 | Erasure fence semantics | The PR4 non-resurrection fence is MATERIAL-TIME-BOUNDED, not permanent: archive and projection writers check executed-erasure tombstones under a dedicated advisory lock, blocking only material at or before started_at |
| 122 | Wave-2 DM corrections | DM corrections ship behind one staged flag: every archive write computes material_fingerprint (0076), material != emitted is the repair signal draining into first/superseding events; the backfill MUST complete before the flip |
| 123 | DM corrections lineage intake | Pre-#49 archive rows without observations get honest lineage — surviving journal rows are re-journaled verbatim under their original keys, journal-less rows get an operator-source reconstruction from the archive material head |
| 124 | Fansly egress | REVERSES Stage 26's recorded direct fallback — Fansly egress fails CLOSED: a proxyless Fansly page refuses with ProxyMissingError/409, opens a proxy_missing incident (0078) and parks the stream; OnlyFans is untouched |
| 125 | OFAPI command outbox TTL | Queued-only commands with zero attempts expire to `cancelled` after a 10-minute TTL, applied at the top of every sweep before the execution-disabled early return; the one-attempt law is untouched and expiry is journaled |
| 126 | User offboarding | Users are never hard-deleted: offboarding sets a users.disabled_at tombstone (0079) and revokes every credential in one transaction; reactivation restores password login only and the username stays reserved |
| 127 | Ping prompt context | The ping prompt gains a bounded `fanSilenceDays` (0..20,000) so the model can tell six days of silence from six months; entry restored 2026-07-20 after the original was lost from both mains during branch integration |
| 128 | Backups (risk accepted) | Recurring off-box Postgres backups (#41) DECLINED again as accepted risk: VPS loss means permanent loss of all platform history since the last manual dump; B5 closed as accepted-risk, not implemented |
| 129 | Erasure policy | Owner ruled the agency will never execute data-erasure requests, so the module's three uncovered stores stay as-is and no remediation wave is built; the preserved fix recipe must ship first if the policy ever reverses |
| 130 | Observability truthfulness | Golden-signal incidents split per metric with absence-preserving latches, always-emit wedge gauges, a new ops watchdog for a silent scheduler/sampler, and a per-family canonicalize sweep cursor with wrap-to-head (0080) |
| 131 | Revenue reporting scope | Revises Stage 13's active-only readers for HISTORICAL aggregates — revenue attribution moves to status-agnostic readers so tombstoned pages keep their history in rollups; growth reports deliberately stay active-only |
| 132 | Negative-money guards | Negation guards run inside the per-page spend lock: an active other-suffix twin or a missing settled original writes the negative INACTIVE and stickily so; OFAPI pendings now settle-or-expire on a daily reconcile (0081) |
| 133 | Stream state visibility | pageTopSpenders gains a source/streamState block; subscriptions.renewed joins the webhook family (canonicalizer v3 replay); the workboard conversationRef fallback is REFUTED; occurred_at clamps with future partitions (0082) |
| 134 | Message-archive rebuild | The Stage-10 one-command rebuild is retired as structurally lossy; replaced by a staged SHADOW build (0083) with preflight census, legacy-seed lift before replay, a hard detached-partition gate, verify, and an owner-gated switch |
| 135 | dm_messages wedge | page_dm_threads' stored_message_count cap 0..1000 becomes >= 0 only (0084): it encoded retention policy as an integrity constraint and wedged whole dm_messages streams; a ceiling returns only with a bounded-hot-cache protocol |
| 136 | AI fan dossier | Feature-lane prompts inject the stored fan_profiles dossier, gated per feature by a usesFanProfile policy flag and ramped via a live key defaulting to "none"; the dossier is compiled into sections, fail-open and size-bounded |
| 137 | dm_messages projection debt | A Fansly finalize/checkpoint failure no longer fails the chunk — it records a projection_debt row (0085) that a 5-minute sweep repairs; /health/sync stops lying, degrading on retry-wedged streams and unresolved debt |
| 138 | OF poison-chat breaker | OFAPI dm_messages gains a per-conversation circuit breaker (0086) with exponential backoff and 6 h quarantine; the pinned-conversation path checks health and clears the pin; the error taxonomy is deliberately conservative |
| 139 | Decision numbering | RESERVED placeholder for an in-flight AUTH_POLICY_ENFORCEMENT ruling (renumbered twice after #135 and #136 were taken); #143 later records #139 as still reserved |
| 140 | Prompt debug echo | The feature lane may echo the assembled prompt in an additive debug_input_v1 SSE frame — a capability-gated DP 6-A declassification; a 2026-07-12 addendum replaces the timed allowlist with a plain boolean kill-switch |
| 141 | Executor fair scheduling | A pg-boss row is a disposable wakeup, never durable work or retry authority: one job per chunk, one fixed page singleton, complete→send in one transaction, retryLimit 0, no local draining, FIFO across pages |
| 142 | Top spenders read ceiling | pageTopSpenders raises only its request ceiling 500 → 1000 (default stays 150) as one bounded query rather than pagination; Core must deploy before the extension that requests 1000 |
| 143 | Auth policy enforcement | Production AUTH_POLICY_ENFORCEMENT flipped log → enforce after 48 h with zero would-* divergence, API container force-recreated; removing the now-redundant in-handler guards stays deferred |
| 144 | Desktop harvest reconciliation | Desktop harvest manifests are cumulative custody checkpoints, so harvest:reconcile resolves a timestamped snapshot's reconcileUsing to the canonical per-machine latest file; incomplete reconciliation exits non-zero |
| 145 | Harvest authority binding | x-client-version is routing metadata, never authority: only a device token with an owner-bound machine UUID (0090) may journal harvest.* facts, and harvest idempotency keys on machine + deterministic client event |
| 146 | Bounded snapshot pagination | GET /events/snapshot gains an additive pageMode=bounded_v1 that caps durable message/tombstone rows per response with an opaque scope-bound stateCursor; only the terminal null cursor authorizes the checkpoint |
| 147 | Persona revision CAS | Persona revision is the lifecycle token for update AND archive: numeric PUT/DELETE mutate exactly one active revision, stale writers get 409, expectedVersion=0 never removes an active row; bundled seed adopts at version |
| 148 | Global persona ownership | Global personas become Core owner-admin content (supersedes #115 and #147): bearer clients read a metadata-only persona catalog, full text only via the owner-session admin surface; legacy write lanes survive the transition |
| 149 | Replay-journal retention | Replayable OFAPI webhook rows are deleted only as one contiguous prefix — a recent, pending or failed row blocks every later frame; a persistent blocker is an operator repair condition, not permission to discard the tail |
| 150 | Erasure locking | One global session-level erasure lock spans planning, deletion, lake rewrite and completion; a retry marks an earlier attempt `superseded` only on exact selector + resolved-page-id match and a stamped protocol, never by max(id) |
| 151 | Persona admin read-only | #148's owner surface is read-only during the preservation window (mutations 409); the client catalog gains an opaque definitionId sent as expectedPersonaDefinitionId and rejected with 409 persona_definition_changed |
| 152 | Deploy/lifecycle gating | Deploy no longer aborts every invocation — it interrogates the candidate image's capability manifest and rejects only desktop-lifecycle-v2; health exposes contractHash; the harvest index builds CONCURRENTLY outside 0090 |
| 153 | Cursor integrity terminology | Domain-event resume cursors v2/v3/v4 are canonical Base64URL JSON and are NOT MAC-signed; only the bounded OFAPI snapshot stateCursor is HMAC-SHA256 signed — docs must name which cursor they mean |
| 154 | AI proxy failure classification | Connect-level AI-lane failures now classify as provider_proxy_unreachable with a static proxy-naming message, and the page-proxy client caches the first connect failure per generation so SDK retries fail instantly |
| 155 | PPV canonicalization incident | message.ppv_unlocked refs come only from the notification chat path (the top-level user_id is the CREATOR); an unresolvable chat publishes no event; the type is temporarily suppressed on v2; the 70 bad rows stay unrewritten |
| 156 | Fast-reply split mode | replyMode=preferSplit becomes a strict prompt request for 2–3 [NEXT]-separated parts (the single-message opt-out is removed), but not a transport guarantee — the normalizer never invents, duplicates or truncates parts |
| 157 | Documentation cleanup | docs/project-kernel/ is dissolved: stage specs, roadmap, execution log, harness and target architecture move to docs/migration-history/, the map generator to docs/generated/REGENERATION-PROMPT.md, scaffolding deleted |
| 158 | OnlyFans mirror | The OF mirror is capture-before-parse and DB-first per proven surface (supersedes #49's REST bootstrap and #52's webhook-only boundary): every vendor call is a durable job whose envelope commits before parsing |
| 159 | Off-box backups (superseded) | Encrypted off-box backups of the DB, mirror artifacts, config and key custody are REQUIRED with retention, alerting and recurring restore drills, provider-neutral and default-off. SUPERSEDED by #161 |
| 160 | OFAPI budget lanes | Legacy audience/fan-identity/chargeback lanes keep their dedicated day ceilings, but each reservation now increments the dedicated and global OFAPI counters in one atomic statement so the mirror can run beside them |
| 161 | Backups withdrawn | SUPERSEDES #159 and reaffirms #128 — the owner withdraws off-box backups, provider selection, retention/alerting and DR drills; VPS loss may permanently lose captured history and that consequence is accepted |
| 162 | OFAPI cursor semantics | OFAPI now treats `first_id` as EXCLUSIVE, contradicting #49; the v2 capture contract infers inclusive vs exclusive from each saved response, persists the mode in the job cursor and rejects a mid-chain mode change |
| 163 | OFAPI export pilot | One bounded scraping-backed export pilot is authorized (one page, 1–3 frozen chats, ≤1,000 messages, ≤50 credits) via an owner-audited CAS approval and a single stateful start; fleet exports stay quote-only |
| 164 | Export artifact import | The 707-record pilot CSV (36 credits) covers only the last seven days, so it is usable message material but NOT evidence of continuous history: import is projection-only, terminal at item_presence with continuousHistory=false |
| 165 | Fansly purchase history | Fansly /media/orderhistory requires an observed accountMediaId, so purchase history becomes a media-scoped keyset walk over retained dm_messages payloads; canonicalizer v4 also emits ppv_unlocked from inline orders |
| 166 | Page health freshness | A complete Fansly follower walk disagreeing with the headline count gets exactly one bounded restart before blocking; page-health summaries evaluate only applicable streams; subscriber_count refreshes from current rows |
| 167 | Coach-chat feature lane | New stateless multi-turn coach-chat feature — client-held coachHistory replayed per turn under a shared 64k answer ceiling, two-slot recap attach, a short fan-summary variant, includesFanBio flag, and a recap-status read |
| 168 | Governed OFAPI budgets | Governed mirror reads move to per-principal per-UTC-day limits of 4,000 calls and 4,000 reserved credits (the 250 shared daily ceiling is removed); mirror capture gets its own 40,000-credit global stop-loss |
| 169 | Governed OFAPI budgets | Owner adjustment to #168 — the per-principal governed mirror allowance becomes 7,000 calls and 7,000 reserved credits per UTC day; every other safeguard is unchanged |
| 170 | Governed OFAPI budgets | Owner clarification superseding the numbers in #168 and #169 — 4,000 calls and 4,000 reserved credits per origin principal per UTC day, under a 7,000-credit global ceiling for that day |
| 171 | Sync pause UX | Product surfaces keep the distinction between a fully paused page and one paused applicable stream; detailed block controls expose Resume (hiding Sync Now and Pause) and re-request only the rows actually paused |
| 172 | Release ops (dist-only) | A dist-only release must build from a checksum-pinned clean full base image published after a fully verified full deploy, refusing an absent, unlabeled or mismatched tag; the overlay carries only current build outputs |
| 173 | Recovery generations | Every fresh sweep starts at max(checkpoint, retained-row generation)+1 so a checkpoint reset is safe; sync health degrades on any terminal failed task; chargeback reconcile isolates failures per page under one global incident |
| 174 | Voice notes lane | ElevenLabs voice notes become a page-scoped kernel render lane: a voice-script feature plus three routes, a durable single-dispatch state machine with fenced attempts, and ≤2 MB BYTEA audio — supersedes #36 for this class |
| 175 | Voice pilot hardening | voice-script is Fansly-only and requires switch, allowlist, provider, voice profile and a nonblank fan identity matched across refs; the adapter does one fetch and validates audio/mpeg; indeterminate rows report billed:null |
| 176 | Local Docker + build cache | Local Postgres drops `restart: unless-stopped` and uses bounded local log drivers; the production Dockerfile uses architecture-keyed BuildKit cache mounts with manifests copied before source trees |
| 177 | Prompt dossier eligibility | A fan_profiles body may enter a prompt only when Core's restricted ledger proves it came from a usable full fan-summary (mode, terminal completion, identity, byte equality); the dossier date is Core's own created_at |
| 178 | Stream v2 control lane | The v2 stream gains an `event: control` lane outside DomainEventFrame validation; its first member {"type":"replay_completed"} marks the replay/live boundary once per connection and unknown control types must be skipped |
| 179 | Coach-chat draft context | coach-chat now reads the existing draftText as OPTIONAL context via a builder-only optionalDraft flag (requiresDraft stays false); the draft is escaped, XML-wrapped in the uncached block and shed whole under budget pressure |
| 180 | Service egress proxy | Telegram and ElevenLabs share one boot-only, all-or-none SERVICE_EGRESS_PROXY_URL SOCKS5 identity (supersedes only #174's direct-ElevenLabs clause); routing fails closed and activation is gated by a read-only verify CLI |
| 181 | v2 frame account mapping | accountRef is read from the page's current OFAPI mapping in the same statement as each domain-event batch instead of being snapshotted per connection; compatible clients refresh, rebind and reconnect on an unexpected ref |
| 182 | AI failure classification (1A) | The kernel is the sole classifier of provider and transport failures family-wide; Stage 1A ships only the rollback-safe expand half — nullable ledger detail, two reader-first incident kinds, default-off paging, durable outbox |
| 183 | AI failure telemetry (1B) | Stage 1B normalizes failures at the shared AI transport boundary into six wire classes with one static message each, records error_code/failure_phase/HTTP status per failed terminal, and opens guarded incident latches |
| 184 | Server error hygiene | The four boundary sanitizer paths collapse into one shared core owning cause chains, secret masking and clamp policy; only AppError may cross the boundary; the SDK adds an `http` fallback category; wire taxonomy unchanged |
| 185 | Error-handling canon | docs/error-handling.md is the single canonical error-handling reference for core, the extension and desktop; any change to classification, codes, retries, incidents or redaction must update the canon in the same change |
| 186 | Critical-paging preconditions | Four fixes gate `aiCriticalAlertsEnabled`: the internal AI lane fails closed on unusable terminals via the shared consumer, incident state is ordered by event time with an atomic recovery+resolve, outbox delivery is FIFO per incident/channel, and the lease/sweep clocks outlive one physical Telegram send |
| 187 | Plugins throw AppError | `@fastify/rate-limit` threw a duck-typed literal that only reached clients via the passthrough #184 removed, so rate-limited logins answered HTTP 500 for three days; any plugin signalling by throw must throw an `AppError`, and both rate-limit tests join the `[sync-critical]` PR slice |
| 188 | CI gate splits into shards | The single Quality Gate job becomes Static checks + a 3-way sharded Integration matrix + a same-named aggregator (branch protection matches the literal name); no test or harness file changes — measured 688s serial -> 234s per shard |
| 189 | No long dashes in model-facing text | Every em and en dash is removed from the text that reaches a model (templates, live instruction strings, the transcript normalizer, the paid-attachment marker); an em dash is an AI tell nobody types from a phone, and a model mirrors the style of its own prompt. Code comments are exempt: they never reach a model |
| 190 | Voice launch hardening | Voice uses stateless quota refusal and heartbeated queued ownership; audio authorization moves into SQL, cost reconciliation accepts only non-negative PostgreSQL integers, and voice admission/dispatch join the existing material-time erasure fence |
| 191 | A gated skip is not a successful sync | A ramp-gated chunk terminates through `skipPageSync` (no `succeeded_at`, no `progressed_at`, no touch of `consecutive_failures` / `last_error_*`), records `sync_runs.outcome = skipped` and resolves no incidents; the "Not updating" UX state is keyed on the recorded gate REASON, never on the `skipped` outcome (whose pre-existing producer is the lost-lease path on healthy streams), and bulk gated streams are excluded from the monitor's page/fleet rollup exactly as #166 already requires of sync-summary |
| 192 | Ramp-gate wake-up | An admin config write that OPENS a Fansly ramp gate queues `fan_earnings`/`purchase_history` (source `recovery`) for the affected pages, dispatched on the planner's next minutely tick; the gate is read before and after the write so only non-ramped -> ramped transitions queue anything (a needless walk is ~1400 Fansly calls), and a wake-up failure is logged and swallowed instead of failing the config write |
| 193 | Deleted fans in top-spenders | `pageTopSpenders` carries `entries[].deletedAt` (`fans.deleted_detected_at`, ISO, null = alive) so the board can tell a deleted account from an unloaded name and stop re-asking Fansly for ids it can never resolve; deleted fans stay IN the ranking because their spend is in the totals, and the field is `.optional()` because the kernel deploys independently of the extension |
| 194 | Fansly transaction-data correctness | Subscribers add one archive-only expired-history bootstrap; live bulk-stream gates become durable pause/resume state and skipped runs stop claiming data success; PPV target discovery adds a transaction keyset while retaining the existing media-scoped capture contract |
| 195 | Agent principal isolation | An agent key authenticates into its OWN `AuthPrincipal` variant with NO human user (`kind: "agent"`, capabilities + explicit `page_ids`), extending #116's credential taxonomy with a third kind; route kind `agentKey` admits only agent principals, every other kind (including `any`, now an allowlist of the pre-agent methods) refuses them, and a page an agent may not read answers 404 exactly as a page that does not exist |
| 196 | Agent Read Plane | A machine principal reads this hub through 10 operations under `/api/v1/agent/*`, and every 200 carries three independent axes (`delivery`, `capture`, `fieldStates`) plus `conclusion.blockers`; PARTIALLY supersedes #52 strictly narrowly (transcript reads only through operations with mandatory capture/conclusion, only for an `agentKey` principal, never as an unannotated dump). #57, #140, #142 are NOT superseded; DP 7 / DP 8 / DP 9-A are reaffirmed |
| 197 | Capture floor, not absence proof | The `absenceProvable` field and its certification machinery (coverage proofs, capture ceiling, gap-detection mode) are REMOVED before shipping: unreachable on every real route and the slowest reads in the slice. What ships is `captureFloor` (`oldest_stored_row`, from its own unbounded query) plus the `before_capture_floor` gap and blocker — "we hold nothing before DATE" is checkable, "nothing happened before DATE" is not expressible |
| 198 | Agent search is Postgres FTS | Message search runs `websearch_to_tsquery('simple')` over the GIN that has existed unused since migration 0059; `escapeLikePattern` is NOT applied on that path (it corrupts tsquery input), no FTS index is built for the other two message stores, and they are declared `not_indexed` so a miss reads as non-coverage rather than as absence |
| 199 | One writer for the blockers | `concludeEnvelope` in `modules/agent-read/epistemics.ts` is the ONLY runtime site that names a blocker (pinned textually); plane reads are branded witnesses a handler cannot mint (barrel export pinned); ramp mode and cursor traversal enter through the signature — a consumed cursor takes `mutable_sort_key_traversal`, and an unfrozen population takes the `no_frozen_snapshot` caveat instead of an unearned `snapshotExhausted` |
| 200 | Agent keys are issued, never recovered | An agent key is minted by the owner (dashboard or `POST /api/v1/agent/keys`), returns its raw token EXACTLY once and stores only `sha256(token)`; the closed capability matrix and the 365-day lifetime ceiling REFUSE a bad issuance (400) instead of narrowing it silently, the page grant is the labels that were named (no wildcard, later pages are not granted), and delivery to a model is `packages/hub-agent-cli` (`hub`): one command per agentKey operation, one JSON document per call, exit 0/3/4 with `--fail-on-partial`. The `exportPolicy` VALUE flip (spec 11 step C) is BLOCKED: both vendored clients still reject `agent_read_plane_v1` at runtime |
| 201 | Help/Review prompts: Russian output, receipts required | `help-me` and `chat-review` templates rewritten: chatter-facing analysis pinned to Russian («ты»), fan-facing text pinned to the fan's language; fixed capped block structures (СИТУАЦИЯ/ЧТО УПУЩЕНО/СЛЕДУЮЩИЙ ХОД/РИСК; ВЕРДИКТ/ДЕНЬГИ/ПЕРСОНА/ОШИБКИ/ЧТО РАБОТАЕТ); every claim must quote a message fragment; rating bands anchored with a no-default-to-7-8 rule; both Help suggestions implement ONE recommended move; chat-review gains the shared paid-media glossary. XML wire format unchanged |
| 202 | Hydration autopilot: delegated, budgeted approval | The owner may delegate to a VERSIONED in-kernel policy (`agentHydrationAutoApproveMode` off/shadow/enforce, default off) the authorization of one bounded Fansly `thread_backfill_before` attempt per request: ≤40 calls, mark-read always refused, inside `agentHydrationAutoDailyCallBudget` reserved calls per UTC day (default 0). Decisions carry `decision_source='auto_policy'` + `decision_policy_version` (0119) — never a fabricated owner id; over-budget/foreign-platform/over-cap requests stay `requested` for the owner. New platform, target kind or side effect requires a fresh numbered decision
| 203 | Agent transaction summary | Existing operation #10 gains `summary: true` for `transactions`: one MVCC statement returns currency-grouped gross/net/fee/count over matching Hub rows plus a page-wide windowless transaction floor. No new route, table, cursor or completeness proof; `basis='matching_rows_in_hub'` is the wording boundary |
| 204 | Coach situation preset | `coach-chat` accepts optional `preset:'situation'`: Core substitutes the pinned canonical question only when `chatterQuestion` is absent or whitespace-only, refuses preset plus a non-empty question and refuses presets on other features; the optional meta echo `presetQuestion` lets clients replay the real question, while `{presetInstructions}` stays in the uncached task block and is empty for byte-identical normal turns. The extension will route Help into this lane; `help-me` remains served for older clients and desktop |
| 205 | Creator-post capture and Agent read | Creator posts use one default-paused ordinary `posts` sync stream: Fansly account timeline payloads are journaled before canonicalization and governed OFAPI `post_paginate` jobs commit exact response bytes before parsing; both then append projection-only `post.observed` events into the rebuildable `creator_posts` current-head projection. Existing Agent operation #10 and `hub dataset` expose verbatim post text under the existing `read:datasets` + `read:messages` rights; no new route, capability, command or FTS, and capture floors never prove vendor absence |
| 206 | Fansly reverse evidence and fail-closed completeness | Executable reverse behavior may define pagination and observed response shapes, but every adopted path remains raw-first and refuses false completeness: purchase history follows `before=last orderId` to an empty page; transaction/DM totals and DM unique ids are mandatory; earnings rejects partial money aggregates and cursor jumps. Standalone Fansly onboarding requires a proxy at every boundary. New earnings/tracking/list reads remain adapter-only until an honest storage model exists. Agent transaction results serve active rows while their capture floor remains the physical oldest retained row |
| 207 | Smoke consumer projection checkpoints | The permanent v2 smoke consumer applies `stream.projection_checkpoint.hiddenCount` through the same monotonic guard as real v2 clients, so intentionally hidden projection-only rows advance its cursor without false GAP errors; malformed or mismatched checkpoints still fail closed, and the historical persisted counter is retained as an ops baseline rather than reset |
| 208 | Live-list terminal verification and optional DM totals | Fansly follower reconcile compares its unique generation with a freshly captured terminal headline, checkpointing a budgeted verification-only continuation when necessary; one restart then durable block remains. PARTIALLY supersedes #206 only for DM totals: consistently absent/null totals allow a captured, unique-id-guarded but non-destructive completion, while a present total remains stable/exact and is the sole authority for hiding unseen conversations |
| 209 | Fansly post monetization | Fansly timeline money and linked-goal fields become a latest-observed `post_monetization` snapshot, while raw-first `/tips?targetIds` capture supplies donor-to-post rows with exact type-7100 goal attribution and verbatim tip notes in `post_tips`. The rendered post total is `tipAmount + attachmentTipAmount`, never `totalTipAmount`; `tip_goals` deduplicates shared goals. Companion drift cannot wedge posts, malformed tip items become explicit parse debt, and migration 0121/posts canonicalizer v4 preserve replay without claiming continuous refresh or tipped-reply-donor completeness |
| 210 | Fansly live post-tip contract correction | Post-deploy acceptance supersedes #209 narrowly on the undocumented `/tips` item shape and null semantics: live items carry a flat `targetId` that proves donor-to-post attribution but no per-tip goal discriminator or transaction refs. Canonicalizer v5/schema v3 replays them with internal `tipGoalAttribution='unknown'`; a null `postTipGoalRef` means source-did-not-provide, never direct. Nested typed targets remain accepted when actually observed. No migration or inferred goal split |
| 211 | Exact transaction tip context | Fansly DM `tips[]` sidecars project exact, message-gated `tip_transactions` note/conversation context by provider tip id while `transactions` remains money-only. Mandatory sender/time facts, a Stage-28 material-time erasure fence, and field-specific raw lineage prevent false nulls, resurrection, and unverifiable verbatim text; OnlyFans stays visible as `not_captured` |
| 212 | G1 storage stop-loss: telemetry is bounded, capture is not | Sync telemetry stops re-copying unbounded checkpoint state (bounded scalar projection + write-time-or-diff `advanced`), per-attempt success stdout traces default off behind `SYNC_HTTP_ATTEMPT_TRACE_STDOUT` with a DB-failure stdout fallback, production container logs get the bounded `local` driver (20m×5, contract-tested), hourly disk gauges land in `ops_metric_samples` (deadman ignores `disk_*`), and deploy gains an EXIT-trap dist-context sweep plus an opt-in (#176-compatible, default-off) allowlist image GC. No captured fact, retention window, or deleter changes |
| 213 | Disk runway latches | Hourly least-squares fit of `disk_free_bytes` gauges (24h window, ≥6h span) drives two independent `db_disk_usage` subKey-латча: `runway_warning` <30д и `runway_critical` <7д. Unknown history is not a state (ничего не открывает и не резолвит); measured recovery или flat slope резолвит per-latch; resolve-тексты subKey-специфичны, чтобы не читались как общий all-clear |
| 214 | G3 checkpoint cutover: the generation set is the membership authority | The Fansly `dm_conversations` sweep drops its cumulative `snapshotConversationIds` array (O(N²) checkpoint bytes) for a v2 scalar state with a persisted `observedCount`; membership lives row-side in `page_dm_threads.last_seen_generation`. Cross-page overlap is a pre-upsert row read inside the page transaction, which also takes the shared erasure fence and defers the chunk (+60s) rather than racing a delete. The destructive visibility pass runs ONLY on an exact `count(generation) == observedCount`; any gap — including one an erasure could plausibly explain — withholds finalization AND the success stamp, notes or alerts, and retries as a fresh sweep (+15min). Rollback-safe by version: the pre-G3 parser rejects a v2 state and re-walks from offset 0 under a higher generation, losing progress and never correctness |
| 215 | G5 slice 1: the CAS copy is written before the fact, and proved after it | Pull capture on a canary page stores its body in the content-addressed catalog in a SEPARATE transaction that runs BEFORE the inline inserts, and the resulting `(payload_bucket_month, payload_object_id)` pair is carried INTO those inserts as ordinary column values. Same-transaction was rejected because a failed CAS statement aborts the whole transaction (25P02) and would take the capture with it; a post-commit UPDATE was rejected because it mints a second row version per capture on the two biggest tables. Failure of any CAS step is swallowed and leaves null references — never an orphaned fact, only an orphaned object. The envelope reference deliberately carries NO foreign key (an FK to a partitioned catalog taxes the hottest write path and locks its future partition maintenance); a two-directional CHECK, added NOT VALID because both columns start null for all history, is the enforced invariant, and a bounded hourly parity verifier is what actually looks for a dangling or divergent reference. One setting, `capture_cas_dual_write_pages` (CSV of page ids or `*`), is both the switch and the bound and FAILS CLOSED at empty; it reaches each process on the runtime heartbeat that already reads the live overlay, so the canary adds no query in either state. The verifier compares full canonical bodies (never digests alone), never repairs, and pages under the new `capture_payload_parity` incident kind |
| 216 | jsonb reads are single-parse | drizzle 0.45.2's builtin `jsonb` column runs `JSON.parse` on a value node-postgres has ALREADY parsed, so any jsonb value that IS a JSON string is decoded TWICE: stored `"4"` reads back as the NUMBER 4, `"true"` as a boolean, `"{\"a\":1}"` as an object; bare words like `enforce` survive only because their second parse throws. It disarmed the G5 canary in production on 2026-08-16 — `captureCasDualWritePages = "4"` read back as 4, `validateConfigOverride` rejected it as "expects a string", the live overlay silently dropped the override, and nothing logged an error. Fixed at the root by a `jsonbSafe` `customType` in `packages/db/src/schema.ts` whose read is IDENTITY and whose write stays `JSON.stringify` — the wire format is byte-identical, the change is READ-SIDE ONLY, and no migration exists because the stored data was always correct. All 55 jsonb columns switched, not only the three that hold scalars: the object-only ones were safe by accident of what they happen to store, not by construction. The builtin `jsonb` import is lint-banned repo-wide so the trap cannot be re-imported |
| 217 | G5 slice 2: reads move to the catalog through a staged, fail-open seam | Every reader that SERVES an `observations.payload` or `sync_raw_payloads.response_payload` body now goes through one seam (`apps/runtime/src/services/payload-reader.ts`) governed by `capture_cas_read_mode`: `inline` (the pre-slice behavior, zero extra queries, the mode check is one process-local variable), `shadow` (callers still get the inline bytes AND the catalog copy is compared octet-for-octet per read, counted and logged), `serve` (the catalog body IS what callers get). THE INLINE COLUMNS REMAIN THE AUTHORITY OF RECORD IN EVERY MODE — `serve` moves the byte source, never the truth — and the seam FAILS OPEN TO INLINE on every failure class (object/body missing, wrong representation, codec refusal, connection error), silently, never throwing. Transitions are stepwise upward and free downward, the `aiTranscriptFreshUnionMode` rule verbatim, so `serve` is unreachable without a shadow window. THE READ PATH OWNS NO ALARM: a shadow mismatch counts and logs but never touches the `capture_payload_parity` latch, which stays the hourly verifier's alone (a traffic-driven path cannot promise a clean pass, cannot bound its paging rate, and would race the verifier for the latch); the read counters ride the verifier's single telemetry line instead. The body read is barrel-exported only in ENVELOPE-authorized form (`readEnvelopeCapturePayload`), so a bare `(bucket_month, object_id)` still buys nothing. SQL `payload->` extraction sites are explicitly NOT migrated — they never return a whole body — and are marked in place with `CAS-READ-BACKLOG(§6.4)` |
| 218 | G5 slice 3a: the queryable fields get typed columns of their own | The SQL sites that dig INSIDE a capture body and return a FIELD (not a body, so the #217 seam can never route them) move to narrow typed columns populated at INSERT time, derived in `packages/db` from the same parsed object the inline column receives — so a column cannot disagree with its body, and no second row version is minted. 0125 adds `observations.harvest_machine_id / harvest_tx_id / harvest_tx_amount / harvest_tx_created_at` (all `text`: a malformed captured member must still journal, DP 7, and `text` is what `->>` returned) and `sync_raw_payloads.response_tips` (the `{tips}` slice, so the tip replay keeps its server-side narrowing instead of dragging whole DM bodies over the wire). The agent plane's `payloadBytes` becomes `coalesce(cpo.logical_bytes, octet_length(o.payload::text))` over a LEFT JOIN to the catalog PK rather than a fifth column — the number is already stored once on the row the reference addresses — and it deliberately RESTATES the size for referenced rows (canonical octets vs jsonb text), because a size measured on a column the system is about to stop writing is the one that becomes a lie. The coverage-revoke idempotency proof needs no columns at all: `readEnvelopeCapturePayload` is inside packages/db and is the smaller diff. THE ONE INDEX-BACKED PREDICATE IS AN `OR`, NOT A `coalesce` — coalesce over two columns is unindexable — with a typed twin index (0126, CONCURRENTLY per partition, the 0096 pattern) so both arms bitmap-scan; the other two harvest queries use `coalesce` because 0096's partial index needs a `source` clause they never had. NO BACKFILL: every fallback arm is marked `CAS-INLINE-FALLBACK:` and the historical-rewrite slice fills the columns on the pass it already makes. Erasure's `payload::text like` subject matching stays behind — it matches a whole body, not a field — and now names the erasure slice as its owner |
| 219 | G5 slice 3b: erasure becomes catalog-complete, and a capture body gets its first lawful death | The Stage 28.4 erasure now reaches the content-addressed catalog IN THE SAME RUN, landed BEFORE slice 3c can null an inline body and make the catalog copy the only one. The catalog plane INHERITS the module's verdicts instead of forming its own: a body whose every envelope this erasure deleted dies with them — body row, location row, catalog row, the first sanctioned deletion of a captured body in this system — while a body a SURVIVING envelope still references (a shared observation, a `sync_raw_payloads` row erasure never touches) is a bystander's fact: kept, counted and journaled in the tombstone exactly like `sharedObservationsKept`. A SUBJECT-FILTERED REWRITE OF A SHARED BODY WAS REJECTED on two independent grounds — it destroys a bystander's captured bytes (the same law that keeps shared observations), and every referencing envelope still carries that body inline, so a filtered copy would diverge from the #217 authority of record and page the parity verifier by design. Zero references is PROVED, not assumed: a `not exists` over both envelope tables in the statement that selects the deletion set, deletes behind it in FK order, all inside one transaction per bounded batch holding the G3 erasure fence; migration 0127 gives that probe the partial index 0124 deferred until "earned by a real query plan". The sweep runs AFTER the delete transaction (the deletes must be visible for "no surviving reference" to mean anything) and is resumable by construction — set-based statements, no per-object precondition, a re-run rescans and continues. One `capturePayloadErasureSubject` builds the literals for BOTH planes so they cannot disagree about what "contains the subject" means; the catalog scan returns metadata only, never bytes; `exact_bytes` in scope fails the run loudly rather than under-erasing. Slice 0's collision TODO is wired: the hourly parity job counts `collision_ordinal > 0` and pages under the SAME kind with its own `sha256_collision` subKey (#213's runway shape) — measured on every pass canary or not, resolvable only by a zero count, never by a clean parity sample, with subKey-specific resolve texts; `settlePayloadObject` still owns no latch (#217), because the durable row it already writes outlives any counter |
| 220 | G5 slice 3c-1: a captured body stops being written twice | New captures on a page in `capture_cas_pointer_only_pages` (CSV of page ids or `*`, default `''` = off, live via the heartbeat) write the inline body as SQL NULL — the first slice of G5 that actually stops the disk growing. THE WORST CASE IS BOTH COPIES, NEVER NONE, and by construction rather than by a check: the permission is minted only on the success return of `putCaptureCasPayloads`, where both catalog references already exist, so a codec refusal, a dead connection or a page outside the slice-1 canary all write inline exactly as before, and a page listed here but NOT for dual-write behaves like a page listed nowhere. Migration 0128 drops NOT NULL from `observations.payload` / `sync_raw_payloads.response_payload` and adds to each table the invariant that is this slice's core, `CHECK (payload IS NOT NULL OR payload_object_id IS NOT NULL)` — NO ROW MAY ADDRESS ZERO BODIES — NOT VALID on a provable vacuity (every existing row was written under the old NOT NULL). `payload_hash` stays NOT NULL because the producer computes it from the payload OBJECT, never the column, as do the #218 typed columns, so a pointer-only row differs from a dual-written one in the body alone. THE LOAD-BEARING RULE IS THAT A NULL INLINE BODY RESOLVES FROM THE CATALOG IN EVERY READ MODE, `inline` INCLUDED: `capture_cas_read_mode` is designed to be rolled back freely, and if reachability depended on it the escape hatch would blank every pointer-only row — so the mode governs byte-source PREFERENCE for a row with two copies, never REACHABILITY for a row with one, and for such a row the CATALOG is the authority of record. `shadow` skips those rows and the hourly verifier counts them `skippedNullInline` rather than `matched` (a comparison with one operand is not a verdict), so a ramping page's `checked` falls to zero by construction and the latch neither opens nor resolves; necessity reads are counted apart (`servedNullInline`) from preference reads (`served`), and the one bad outcome — the only copy unreadable — returns null, counts and LOGS, while still owning no latch (#217). ROLLBACK IS NOT SYMMETRIC and the registry says so: turning the flag off resumes double-writing for NEW rows only, rows already written pointer-only keep their body only in the catalog forever — the first irreversible flag here, and the reason #219 (erasure reaches the catalog) and the null-inline read law landed first |
| 221 | G5 slice 3c-2: the historical rewrite is a one-time lawful UPDATE, consumed by the reclaim that follows it | Four owner-gated CLI commands (`capture:backfill` / `verify-backfill` / `reclaim` / `drop-parked`), no schedule and no config flag, each dry-run by default and tombstoned in `capture_rewrite_runs` (0129, the `erasure_log` shape — a TABLE because verify must read what backfill concluded hours earlier, and `ops_metric_samples` is deadman-sensitive). THE UPDATE #215 and #218 both forbade is lawful HERE and only here: its bloat does not accumulate, it is CONSUMED — the reclaim copies the surviving tuples into a skinny relation and parks the old one, so the dead versions are exactly the pages that get dropped. A historical body is filed under ITS OWN capture month, never `now()` (0123's ref-closed-cohort law), so the backfill lazily creates the catalog partitions 0123 never made (prod starts 2026-07, 0123 starts 2026-08) and accepts two objects for a raw/observation pair straddling a UTC month boundary. The lane is `platform_capture` for every row and is NOT derived from `source`: `operator` would map to the `system` erasure domain, which #219 never gives a subject sweep, and narrowing erasure reach on a one-way pass over history is not a trade this slice may make. VERIFY PROVES RATHER THAN INFERS — each remaining null-ref row is re-canonicalized and must actually refuse (the backfill's stored count is a printed cross-check, never the authority), every reference is resolved by a TOTAL anti-join (the check the absent FK does not make), and bodies are compared as full canonical octets on a bounded random sample drawn by index probes rather than `order by random()`; it has no `--dry-run` because the verdict row IS its product. observations takes §9.1 whole in two invocable phases — a lock-free resumable skinny copy (inline null where a ref exists, KEPT where the codec refused) that pre-adds the partition-bound CHECK so ATTACH skips its scan and reconciles indexes against the source partition's real `pg_indexes` (0096/0126 are per-leaf), then ONE transaction that detaches, parks, renames the twin into the partition's name and attaches: THE SINGLE TRANSACTION IS THE CRASH PROOF, old-or-new, never neither. Superseded copies park in a NEW `capture_pending_drop` schema, not `tiered_pending_drop`, whose meaning would make the replay guards falsely refuse a live month — and the erasure is taught the new schema explicitly so no under-erasure window opens during grace. `sync_raw_payloads` takes §9.2's OTHER option (null-bodies then VACUUM FULL, writers proven down) because a rename swap would have to re-validate two inbound FKs inside the swap transaction, because its OWNED `bigserial` sequence moves with the table and would break the first capture after the swap, and because unpartitioned means the headroom ask is everything at once — the price, no grace window for that table, is stated rather than discovered. `capture:drop-parked` is the only destroyer, reaches nothing outside the parking schema by construction, and is pinned in `tests/retention-deleters.test.ts` with a STATEMENT-level licence because a `DROP TABLE` is invisible to that file's `delete from` grep. Refusals (current/future month, detached partition, stale-or-overtaken verdict, unconverged erasure, headroom) end the run before the phase body reads anything |
| 222 | G5 review fix: a stamped reference outliving its object is a lost fact, and the two acts are now ordered | An external review found that #219's accepted race — a capture deduping onto an object the erasure sweep is about to delete — stopped being cosmetic the moment #220 let a row have NO inline body: the envelope then addressed a hole, past the 0128 CHECK (which only asks for a reference), past the deliberately absent FK (#215), and past a parity verifier that skips null-inline rows by design. THE FIX IS AN ORDER, NOT A NARROWER WINDOW: the sweep takes `FOR UPDATE` on its candidates in a statement of its OWN, BEFORE the `not exists` verdict, and every envelope writer holds `FOR KEY SHARE` on the object until the insert that stamps the reference COMMITS. Either the writer got there first — the sweep then waits and its verdict statement, taking a fresh READ COMMITTED snapshot after that wait, SEES the new envelope and keeps the body — or the sweep got there first and the writer's probe finds the object gone and writes the envelope with NO reference and its INLINE body, the pre-G5 shape of a capture, which is always readable. There is no third outcome, so the belt-and-braces alternatives were REJECTED: a two-pass sweep with a delay narrows a race that is now closed and cannot be sized (any bound is a guess about GC pauses) while doubling a break-glass act's fence hold; a durable claim row adds a write to the hottest path in the system plus a cleanup that could itself delete a live claim; the FK #215 rejected would work and every word of that rejection still holds, which is exactly why the ONE lock an FK would have taken is taken by hand instead — no DDL, no index (the catalog PK serves it), no history to validate, and only on a capture that carries a reference at all. IT APPLIES UNIFORMLY to pointer-only and dual-write: a dangling reference in the second case is not a lost fact but it is still a lie the verifier reports as `object_missing`, and one rule beats a special case. `lockCapturePayloadRefAlive` stays OFF the package barrel (pinned) because it is a lock, meaningless unless held to the insert's commit. A standing DANGLING-REFERENCE CENSUS over the head of both envelope tables now runs on EVERY hourly pass, canary or not, and pages under the existing `capture_payload_parity` kind with its own `dangling_reference` subKey (#213/#219's shape) — resolvable only by a zero count, with the measured window travelling in the report so a zero is never read as more than it is; the seam counts `refVanished` and owns no alarm (#217). SECOND FINDING, the swap: `capture:reclaim --phase swap` read its erasure preconditions and its row counts OUTSIDE the transaction, so an erasure committing while the swap waited for locks would park a post-erasure source and attach a PRE-erasure shadow — resurrection through the door the G3 fence does not watch. The transaction now takes its locks EXPLICITLY and FIRST (`LOCK TABLE ONLY observations`, then source, then shadow — `ONLY` so it does not stop every other month) and re-proves everything after them: erasure quiet, both partitions in the state they were in, and source/shadow counts equal. THE RECOUNT AND THE ERASURE PROBE DO NOT SUBSUME EACH OTHER — a committed erasure shows up as a count mismatch (nothing writes into a closed month, so the counts cannot drift back into agreement), an UNCOMMITTED one is invisible to any count and only the mid-flight tombstone and the held fence lock catch it. A `statement_timeout` bounds the recount so a pathological count aborts the swap instead of freezing capture under ACCESS EXCLUSIVE, and a refusal under lock settles the run as `refused` (nothing touched), never as a crash. AMENDS #219: its stated residual — "the worst outcome is a dangling reference the parity verifier reports, never a lost fact" — was true when written and became false at #220; it is superseded by this entry and the sentence is corrected in place in the code that carried it |
| 223 | G5 review fix: the reclaim's four missing gates — a typed column nobody could fill, an unreadable body that read as an empty one, a headroom law behind the growth it governs, and a ritual its own gate refused | A second external review of the G5 line found four defects, each an act performed in the wrong ORDER relative to the thing that was supposed to gate it. **(1) THE COHORT WITH NO POPULATION PATH.** Slice 1 (#215) started stamping references; slice 3a (#218) added the typed columns three deployments later and put their only population inside the reference-stamping UPDATE — so every row captured BETWEEN those deployments carries a reference, NULL typed columns, and is excluded by construction from the one scan that would fill them (`payload_object_id is null`). `--phase null-bodies` then removes the inline body every `CAS-INLINE-FALLBACK:` arm was reading through, and for a Fansly `dm_messages` row the tip-context reader's `coalesce(response_tips, CASE …)` hands back the nulled column itself: the replay records an INVALID sidecar for a message that had a perfectly good one — a WRONG fact, not a missing one, which is the worse of the two. `capture:backfill` gains a SECOND scan whose predicate is a SQL mirror of the derivation (`jsonb_typeof` in the scalar set for the harvest members, `= 'object'` for the tips slice, which is exact), so a filled row stops matching and the pass resumes with no cursor like the first one; the count rides the census's existing single scan, and `capture:reclaim` refuses `shadow` and `null-bodies` while any row would still be filled. The gate PROVES rather than counts — the SQL mirror can say `number` for a literal `JSON.parse` turns into `Infinity`, and a refusal built out of a value nobody can change would be permanent — so a non-zero count is walked and re-derived in the same TypeScript the capture path runs, bounded exactly as the codec-refusal rescan is. **(2) A CATALOG FAILURE THAT BECAME A PARSED FACT.** #220 let a row have NO inline body; #217's seam answered a failed catalog read for such a row with the inline value it was holding, which is `null` — the same answer it gives for "this envelope captured no body". A transient blip therefore became permanent: four of six canonicalizer families have no `canParse` gate, so zero events fell straight through to `markObservationParsed`; the A22 re-journal hashed `null` and inserted it under a DETERMINISTIC idempotency key, blocking its own repair forever; the OFAPI materializer and the readthrough sweep stamped their own versions; the agent plane told the owner the payload was withheld for its RESTRICTION CLASS. The seam now RAISES `CapturePayloadUnavailableError` for that one case — a sentinel would have to be checked and the whole finding is that nobody checked, while an exception's default behaviour at an unaudited site is loud. All twelve migrated read sites were audited and each is now propagate / catch-and-count / explicit 503, with the audit written into the seam's header as the call-site registry #217 never left. The canonicalize driver counts `skippedUnavailable` APART from `skippedUnparseable` because unparseable is permanent and unavailable is transient, and the number that would otherwise grow is the one an operator reads as "we need a new parser". Two bugs fell out of the audit and are fixed here: the expired-interactive-response recovery passed the UNRESOLVED row to materialization (which stamps `parse_version` when it cannot parse — so a pointer-only row was consumed unread), and the coverage-revoke idempotency proof read an unreadable prior body as somebody else's proof and answered 409. **(3) THE LAW BEHIND THE GROWTH IT GOVERNS.** `capture:backfill` writes a catalog copy of every body it walks plus a heap tuple per stamped row with NO admission check at all; observation headroom was first asked at `shadow` and raw headroom only AFTER `null-bodies` — i.e. after the UPDATEs that only make the relation bigger. The backfill gains a §9.1-shaped pre-flight (the bodies still to copy, the same again for WAL, and a 5 GiB floor it will not touch) and re-checks the floor every 10 batches, stopping the walk where it stands; the raw headroom check moves BEFORE `null-bodies`. `--assume-free-bytes` was a DRILL that an executed run could pass to the real gate — the tombstone recorded the bypass and did not prevent it — so the CLI now rejects it together with `--execute`, before the app context exists. **(4) THE RITUAL ITS OWN GATE REFUSED.** `checkWritersStopped` refuses on ANY heartbeating instance while the runbook stopped only `worker` and `scheduler`, so the raw phases could never pass. The review expected the check to be too broad; the audit found the opposite — THE API IS A CAPTURE WRITER, on more paths than any other role (`recordAudit` journals an observation on every audited admin mutation, `/api/v1/ingest/observations` is the clients' own capture lane, the webhook receiver and the read gateway write their own, and `POST /api/v1/admin/pages/:pageLabel/verify` writes `sync_raw_payloads` itself through `refreshPageMetadata`). So the check stays maximally broad (a role allowlist would go stale silently, and the failure mode of a stale allowlist is a rewrite under a live writer) and the RUNBOOK is fixed: it stops `api` too, with the production compose-file selector it was missing, and states the cost — the dashboard, both clients and every AI generation are down for R2+R3, which `VACUUM FULL`'s ACCESS EXCLUSIVE was going to impose anyway |
| 224 | Fansly capture widening + the DM media plane (WP-F0) | The Fansly conversation/follower capture stops being a 4-of-25-field stub: `aggregationData.accounts[]` is journaled through a NAMED 18-FIELD ALLOWLIST ([A20]) — `followsYou/following/subscriber/subscriberSubscription/subscriberAutoRenew/notes/containingLists/profileAccess/profileAccessFlags/profileFlags/permissions/statusId/flags/userFlags` on top of `id/username/displayName/createdAt` — while the eight VOLATILE fields (`lastSeenAt`, `followCount`, `subscriberCount`, `postLikes`, `accountMediaLikes`, `timelineStats`, `streaming`, `version`) are never captured, because they change on nearly every response and would destroy the ~11:1 content-address dedup collapse measured on production. That collapse is the whole reason the byte-ceiling mechanism could be DELETED with the ruling: there is no `fanslyUntrimmedCaptureByteCeilingPerDay` key, no lane deferral, and a test pins that nothing in the capture path can defer `dm_conversations` on a byte budget — a storage guard that can stop live chatter work is a worse risk than the runaway it hedged. **The conversation ROWS were never trimmed at all**: `data[]` carries exactly nine fields and the trim keeps all nine, verified by a BYTE-IDENTITY pin on a new verbatim-shaped fixture, because this plan, its v1 and every review pass believed the trim destroyed DM previews, attachments and tips that were never on the route. `groups[].lastMessage` KEEPS its redaction (a duplicate of the verbatim `dm_messages` journal), which is what keeps the agent-read scrub's justification true. **Three new mechanisms.** (1) §3.2a MIXED APPEND: `appendMixedDomainEvents` lets ONE family emit deliverable news and projection-only material for the same observation — deliverables first, then the hidden block, then a checkpoint whose `hiddenCount` counts hidden rows APPENDED (not batch size), because the v2 replay validator requires the row immediately after a seq gap to be the checkpoint covering it. (2) sync-pull v5 parses the DM sale sidecars into four projection-only types (`message.attachments_observed`, `media.observed`, `media.order_observed`, `message.material_observed`) feeding the four rebuildable tables of migration 0130; money is mills, `saleStats.total` is NET (A12), and a sparse `saleStats` is NULL, never 0. `message.ppv_unlocked` keeps running beside `media.order_observed` — two identities for one purchase, never summed, collapsing to ONE `media_orders` row. **A17-4 VARIANT B: `message_archive` gains NO columns** — purchase state is served by joining `message_media_offers` on `(page_id, message_ref)`, so the shadow-rebuild set-equality gate is untouched. (3) §3.2c(ii) the APPEND-side partition census, wired into `runCanonicalization` and not into a command, because that one engine backs both the minutely sweep and the `events:replay` drain: a provider-dated draft aimed at a 2026–2030 month with no ATTACHED partition is REFUSED before any write, the observation keeps its parse debt, and the run reports `partitionBlocked` (a SKIPPED step) with ONE anomaly per (family, month) naming detached-vs-absent and their DIFFERENT recoveries — creating a "missing" partition when the census says detached orphans the facts the detached table holds. Health-floor gauges gain the family LANE (`obs_backlog_<source>_<lane>_v<version>`) because at v5 `sync-pull` and `posts` would have written two different backlogs under one metric name, and the golden-signal threshold map is built with `Object.fromEntries`, where a duplicate key collapses silently. **Two permanent ratchets:** every written `observations.kind` must be claimed by a family, a registered off-sweep claimant or a justified allowlist entry (seeded from a census of the tree, which found five OF capture kinds and one unregistered off-sweep claimant nobody had listed), and every fan-ref-shaped column discovered from `information_schema` must be a fan-scope erasure target or carry a written justification — the FK guard is structurally blind to TEXT platform refs, which is why `tip_sender_platform_user_id` had to be hand-added. The typed write seam ([S2]) is DEFERRED (A28-7): the guarantee is a CI-enforced registry, NOT "structurally impossible". **REPLAY CANNOT RECOVER WHAT WAS NEVER JOURNALED** — pre-fix history stays trimmed, stated through the existing `captureFloor` mechanism (#197); there is no repair re-walk, and the v5 bump re-parses only what the journal already holds |
| 225 | Fansly account statistics (WP-F1) + the projection registry | The `stats_snapshot` sync stream lands as one whole package: the account statistics sweep (`/it/amoie/stats` daily + hourly), the revenue mix (`/account/wallets/earnings/stats` + `/monthlystats`), `/trackinglinks`, the discovery tag counters, and — per **A28-5** — the three mass-DM broadcast routes plus `/polls` and `/recapstats` as STEPS of this lane rather than a `dm_commerce` stream of their own. **THE PROJECTION REGISTRY comes first and is the reusable half.** `ProjectionDefinition {name, eventTypes, tables, stateClass, rebuildKind, run, rebuild}` is now the list the `projection:rebuild` CLI and the worker tick BOTH iterate, replacing a hardcoded three-name if-chain and six hand-written try/catch blocks — two sites nothing checked, on a plan that adds ~10 projections. Every rebuild now runs the §3.2c(i) detached-partition preflight in the ONE function all of them pass through; before this `creator_posts` and `fan_earnings` would have replayed a truncated ledger and called it authoritative without a word. **[D1] the typed ledger read stays DEFERRED**, and the deferral is reopenable rather than a silent drop: every definition declares its `eventTypes` from day one, and a tick-duration alert on the shared queue is the named trigger. §3.4's THIRD STATE CLASS is declared here — `OPERATIONAL_STATE_TABLES` names `capture_coverage`, and a test asserts no projection's `tables` intersects it, so "operational state is never truncated by a rebuild" is checked rather than promised (**A17-6**). **CAPTURE.** The per-lane daily cap is counted in HTTP ATTEMPTS (retries included — a cap in logical calls lets a retry storm multiply real egress by up to 4), lives in the cursor so it survives leases and restarts, and **DEFERS to the next UTC day; it never drops** — a response already fetched is journaled before the cap is consulted again. After **A28-4** that cap is the whole request-count enforcement: no per-egress-key counter, no `sync_rate_limit_days`, no 2×-of-norm signal, and **[A19]** had already removed the global per-page cap. The first-enable backfill derives each next window from the RETURNED `dateAfter`/`dateBefore` — a self-derived walk drifts a bucket per chunk and leaves holes — stops after two empty windows PLUS one probe a year further back (**[E10]**: an empty window on an idle account proves inactivity, not a floor), journals every empty response because the empty window IS the floor evidence, and records the floor in `capture_coverage` with `proof = empty_window` and `proof_observation_id` pointing at it. Backfill continuations carry `fanslyBackfillContinuationDelayMs` ± 30 % jitter: BURST SHAPE, not daily volume, is the ban-risk surface. **EVENTS.** Family `fansly-stats` v1, projection-only, 13 natural-key types, all RECEIPT-TIME (§3.2b) with the provider instant typed in `data` and in the key — so an event from this family can never carry a clamp marker, and its presence is the failure signal. Type codes are stored RAW (**A22-2**: one label maps to two live codes, so keying by label merges legacy into current and keying against a closed set drops legacy rows); an unknown code writes its row AND raises `fansly_stats_unknown_type` (**A1**). `FANSLY_STAT_LABEL_VERSION = 2`, and its unknown guard fires BEFORE the family lookup so 10002/44002/44032 are `unknown:<code>` rather than silently absorbed. Money is mills through the shared constructors, `saleStats.total` is NET (**A12**), and `/trackinglinks.totalNet` served as 0 lands NULL with the served value preserved beside it — unpopulated, never a zero-revenue link. `media.observed` is re-emitted from the aggregation sidecars with `firstOrigin: 'stats_agg'` in F0's EXACT shapes and dedup keys, so `creator_media.first_origin='stats_agg'` names an origin replay can produce; `creatorMediaOfferLocations` is stored PARSED (**A17-5**) and the media-plane projector stays the single writer of `creator_media`. **A21 STANDS**: no `capture.window_observed`, no `stats_capture_windows` — the two top-N tables carry their window identity INLINE, and per-look history is a query over `sync_raw_payloads`. This entry SUPERSEDES #206's clause parking `/trackinglinks`: the route is wired and its snapshot is a first-class daily fact. **5-minute buckets (`period=300000`) are a deliberate NON-GOAL** — reachable, and not worth the calls or the rows. One flag + one FAIL-CLOSED page allowlist per stream (**S4**: a shared allowlist makes a per-stream ramp unexecutable and turns one fat-fingered edit into six broken lanes); the seed pause is generalized from `if (stream === "posts")` so a gated-off stream can never seed pending rows fleet-wide on the deploy that ships it; and the ops-ordering ladder in `repositories/sync.ts`, which had silently omitted `fan_earnings`/`purchase_history` since Stage 16, is repaired |
| 226 | Fansly notifications (WP-F2) — the verbatim-first engagement core | The `notifications` stream lands whole: the head poll (1 800 s, 48/day), the one-off deep backfill, the `fansly-engagement` canonicalizer family, `platform_notifications` + `post_likes` + `subject_refresh_state` (0133 enum, 0134 tables), and the engagement projector. **IT IS THE ONLY PERMANENTLY-LOSSY LANE IN THE SYSTEM** — a liker, a reply, a quote or a purchase is announced ONCE and served by no other route — which is why it is `live` class rather than maintenance, why it polls the head BEFORE anything else, and why a running deep backfill YIELDS to a due head poll (history keeps; the head does not). **LAYER 1 IS THE WHOLE ARGUMENT.** `notification.observed` is emitted for EVERY row and EVERY code, known or not, and `platform_notifications` rebuilds from that event alone — so a code nobody can name today reaches the table by replay the day somebody names it. Layer 2's typed derivations ride BESIDE it, never instead: 2007/2008/32007/45012 become `media.purchase_notification_observed`, the rest become `engagement.notification_observed`, and an unnameable code gets its verbatim row plus a `fansly_notification_unknown_type` anomaly (**A1**). **THE PAYOFF IS NOT HYPOTHETICAL: A22-1 found the shipped spec wrong on EIGHT of sixteen codes, including BOTH purchase events**, which it filed as "PostLikeUndo/PostLikeRedo" — a design that typed before storing would have lost two live money streams into a like bucket with no way back. `packages/shared/src/fansly-notification-types.ts` (`FANSLY_NOTIFICATION_LABEL_VERSION = 1`) holds the corrected table with a CITATION per row and the promotion rule enforced: `confirmed` needs two independent live examples agreeing with a second source, so 2007's UI↔payload match ($80/$50 ↔ 80 000/50 000) is the only confirmed entry and every client-code label is `inferred`. Its labels are `reference/fansly_api_spec.md` §3.1's renderer names, so the repo's two tables cannot drift. **NO LIKE IS DERIVED**: `post_likes` ships schema-complete and EMPTY on Fansly ([E4] — 1002/2002/5003/1004/1005 had ZERO live occurrences and client code proves the client's intent, not the server's), its coverage row reads `not_started` / `forward_only` so the serving layer never renders an empty list as "nobody liked it", and the v1 plan's "2007/2008 = media-like undo/redo, flip post_likes.state" is REFUTED and deleted. **CAPTURE.** The cursor is a NOTIFICATION ID, not a timestamp. The first call of every poll goes UNFILTERED (**A1** wants the unknown codes); on a 4xx or a visibly filtered page the lane widens to the client's FULL declared 18-code CSV — **never the eight-code UI CSV, which silently drops 32007 and 45012, both money** (**A22**) — then to one filter group per call, then STOPS, with the refusal counter durable in the cursor because WP-F1's loop spanned five chunks unnoticed. A narrowed lane never claims a clean capture: every coverage write reads `partial_provider_surface` while the filter is narrowed, **terminal one included, because an empty page through a filter means "no rows of THESE types", not the end of history**. The deep backfill walks to the floor with the repeat-request guard, journals the empty page BECAUSE the empty page is the floor evidence, and records `notificationFloorAt` (13.65 days is where the 2026-08-19 capture STOPPED, not a platform floor). The 96-attempt daily cap is counted in HTTP ATTEMPTS, defers to the next UTC day and NEVER drops. **[A20] on `accounts[]`:** the response embeds the fan as a FULL account record — `lastSeenAt` and every counter field — so that array, and only that array, goes through the 18-field allowlist before journaling; the 200 notification rows and every other key stay verbatim. **HEAD PRECEDENCE IS THE PROVIDER'S `occurred_at`, NEVER `account_seq`**, because the deep backfill appends OLDER facts at HIGHER seq — the one ordering guaranteed wrong here, pinned by "a higher-seq, older-occurred_at event cannot regress the head". **§3.4's THIRD STATE CLASS GAINS ITS SECOND MEMBER**: `subject_refresh_state` — the shared refresh queue every later per-subject lane schedules from — is declared in `OPERATIONAL_STATE_TABLES`, so a rebuild can never truncate it and re-mark the whole catalogue as first-sight. A 2007 marks the bought media dirty there and FETCHES NOTHING; WP-F4 is the consumer |
| 227 | Fansly content catalog (WP-F3) — the lane that measures M, and closes FEAT-002 | The `catalog` stream lands whole (0135 enum, 0136 tables): six fixed daily steps — `/vault/albumsnew`, `/uservault/albumsnew?accountId=`, `/subscriptions/tiers`, `/subscriptions/giftcodes`, `/message/automated`, `/account/walls` — then the vault media walk over `/media/vaultnew` per creator album, then the `/account/media?ids=` and `/account/media/bundle?ids=` batch hydrations, all on ONE 60-attempt daily cap that DEFERS to the next UTC day and never drops. **IT SHIPS BEFORE WP-F4 BECAUSE IT MEASURES M**, the count of unique media offers, and WP-F4's whole sizing (300 calls/page/day round-robin, long-tail cycle ≈ M/rate) rests on a number nobody had computed. **Σ `item_count` IS NOT M** — verified: 27 albums, Σ = 16 939, and the system albums type 38000 (7 574) and type 5000 (3 154) share one `lastItemId` because they are VIEWS over the same media. M is `count(distinct media_offer_ref)` over `creator_media`; the lane reports `uniqueMediaCount`, `vaultMemberUniqueCount` and `albumMembershipSum` side by side in its progress block, the last labelled non-unique everywhere it appears (**A16 item 1**). **THE `/media/vaultnew` QUERY FORM IS SETTLED, and it is the one thing that could have shipped this lane silently broken.** The 2026-08-22 probe sent `albumId=…&search=&before=&after=` for a 4 760-item album and got `{albumMedia: [], media: []}`; the app bundle's `getVaultAlbumMediaNewOrder` shows `before` and `after` are the LITERAL STRING `"0"` on the first page, `mediaType` is present-and-EMPTY when unfiltered, and page two carries `before = <last albumMedia row's own id>` (NOT its `mediaOfferId`, a different value that pages nowhere). **The guard stays anyway**: an empty FIRST page on an album the platform says is non-empty is an unhonoured request, not an empty vault — the sublane stops with `partial_provider_surface` plus ONE anomaly and never retries, because "this creator has no media" is the wrong answer to size a lane against and a walk that re-asks spends a day's cap proving it (WP-F1's lesson). **FEAT-002 CLOSES ON `plans[].price`, NEVER `tier.price`**: all five observed tiers carried `tier.price = 5 000` while plan prices ran 10 000 … **499 990**, so the tier head keeps `base_price_mills` under a name that cannot be misread and `page_subscription_tier_plans` is the queryable truth. `duration_days` reads **`billingCycle`** — the live payload has NO `plans[].duration` key at all; `duration` exists one level down on `promos[]`, which is exactly how that field name gets misread (the plan document says `duration`; the payload wins). **THE ROSTER EVENT is the family's one new idea.** Row events say what IS; nothing in them says what ISN'T, and the case that matters most — a listing that comes back EMPTY — produces no row events at all. So each FULL listing emits one `catalog.listing_observed` carrying its complete ref set, keyed per LOOK, and the projector reconciles in BOTH directions: mark the complement `missing_since`, clear the mark on everything the roster still names. `missing_since` is therefore a REPLAYED fact that survives truncate-and-replay, and nothing is ever deleted (DP 7). Keying it on the ref-set hash instead was built, tested and CORRECTED: a gift code revoked and reinstated unchanged hashes to the roster it had before it vanished, so the event dedupes and the row stays marked forever. **ALBUM MEMBERSHIP GETS NO ROSTER** — it arrives from a PAGED walk, and a roster from one page would claim the album holds only what that page showed. **NO MEDIA BYTES, NO DELIVERY URLS**: `/vault/albumsnew` and `/media/vaultnew` both embed raw `media[]` with `location`, `locations[]` and `variants[]`; the bodies are journaled verbatim and read by nothing, pinned on VALUES as well as columns. **SECONDS AND MILLISECONDS PER FIELD** — one response mixes both (`albums[].createdAt` and `albumContent[].createdAt` are ms while `accountMedia[].createdAt` is seconds), so each field is decoded by the helper for ITS unit and never by a shared guess. `original_price` is read by its SNAKE_CASE name amid camelCase keys. The automation `messageTemplate` is a JSON OBJECT in all seven live values; the March STRING shape keeps a tolerant branch with `parse_ok = false` and a NULL text, because an automation with no text and one we could not read must not look alike. Gift codes join WP-F1's `page_promo_links` as its second `link_kind`, so **both** rebuilds now scope their delete by kind — an unscoped one truncates rows only the other projector's ledger can restore. **The sublane-parking machine (`contract_drift`/`unsupported`/`next_probe_at`) is NOT built (A28-6)**: the probe answered the question it existed for, and all four March routes are live. Batch size is 100 ids — the app's own `splice(0, 100)`, read out of its bundle rather than guessed |
| 228 | Fansly comment archive (WP-F5) — the lane [E1] had to authorise, and the POST that is never sent | The `post_replies` stream lands whole (0137 enum, 0138 `post_comments`): a walk over `GET /post/{postId}/replies` for the entire post back-catalogue, full bodies stored, on a 100-attempt daily cap that DEFERS to the next UTC day and never drops. **IT EXISTS ONLY BECAUSE [E1] PASSED.** Every observed reply GET in the 2026-08-19 capture was preceded ~40 ms by `POST /api/v1/postreply/verify` carrying the same post id (5/5), which made the whole package contingent: if that POST were a server-side precondition, the lane would have been CUT rather than built, because §1 excludes write-shaped calls to the platform. The probe issued the bare GET with no preceding POST and the comments came back (**A25**). So the kernel issues the bare GET and NEVER that POST — a test greps the adapter for the route's path and fails if the string appears anywhere in the file, which is why the path is not written out even in the docstring explaining its absence. **THE WALK QUEUE IS NOT A CURSOR.** There is no order in which a back-catalogue should be read once, so roots are rows in `subject_refresh_state` (`plane='post_replies'`, the second plane on the table WP-F2 built), seeded from `creator_posts` in bounded KEYSET batches on first enable and — for everything published afterwards — **in the SAME TRANSACTION as the `creator_posts` upsert**. That transaction is the load-bearing part: a post committed without its walk row is a post whose comments are never read, and nothing anywhere reports a problem — the lane stays healthy, the coverage row stays clean, and the archive is simply missing that post forever. Priority per chunk is (1) never-walked NEWEST FIRST — an archive that starts with the posts nobody remembers is useless for a year — (2) dirty, (3) round-robin re-walk at `fanslyRepliesRewalkCycleDays` (14). The Fansly-only condition lives in the INSERT's `WHERE`, not in TypeScript, so no new platform branch is added outside the adapter packages. **PAGINATION IS UNPROVEN, AND THE LANE SAYS SO IN STORAGE.** Five live responses carried 1, 1, 1, 1 and 4 replies; no cursor has ever been exercised. The first call is BARE, a page of >= 20 is suspiciously full, and only then is `?before=<last reply id>` attempted — the convention `/timelinenew`, `/message` and `/notifications` share, on a route whose replies come back descending by id. What the cursor DOES is then settled EMPIRICALLY, by comparing the page it returns against the page before it: identical rows mean the route ignored it (`single_page`, and no post is ever paged again), different rows mean it was honoured (`before`). The verdict is durable and announced by exactly ONE anomaly, ever. Until a mode is proven a full page marks its rows `possibly_truncated` and coverage reads `window_captured`, never complete — **and the projector is FORBIDDEN from marking anything `missing_since` from a truncated roster**, because a truncated page's complement is unknowable and guessing it would delete an archive one page at a time. The clear half still runs: a ref the page DID name is present in both worlds. The repeat-cursor guard stops a walk before egress rather than looping (the posts.ts law). **THE OBSERVATION CARRIES THE REQUEST, and it has to.** The post id lives in the request PATH, so the response that matters most — the empty one, "this post has no comments any more" — is a body with no way to say which post it is about. A parser reading the body alone could store comments and could never mark one deleted. The lane journals the verbatim (post-[A20]) body into `sync_raw_payloads.response_payload` as always and gives the OBSERVATION a `{walk, response}` envelope through `persistRawPayload`'s `observationPayload` seam — the mechanism `posts.ts` already uses for a response a future parser needs request context to replay. **EVENTS.** Family `fansly-comments` v1, `projectionOnly`, receipt-time (§3.2b, `createdAt` is SECONDS on this route). `post.comment_observed` per reply, dedup-keyed on the comment's CONTENT hash so an edit appends a new event and moves the head while the fortieth re-read of unchanged bytes appends nothing; `post.comment_list_observed` per walk — the ROSTER, carrying the full ref set, `count` and the truncation flag. The plan's field list named only `{parentPostRef, count}`; a count cannot identify a complement, so the ref set is carried, which is WP-F3's roster lesson applied verbatim (including the per-LOOK key: a comment deleted and restored UNCHANGED hashes to the roster it had before it vanished, so a set-hash key would dedupe the event and leave the row marked forever). **EMPTY-CONTENT REPLIES ARE STORED, not skipped** — one of the four replies in the 18.2 KB live response has `content: ""`, and dropping it would make the reply count disagree with the archive with no way to tell which is wrong. `inReplyTo` and `inReplyToRoot` are stored separately even though they were equal in every observed reply: the day a nested reply arrives, the difference is what reconstructs the thread, and no re-walk recovers it retroactively. **[A20] ON `accounts[]`.** WP-F9's shape probe found the inline account record is a FULL one — `lastSeenAt`, every counter, an avatar with signed CDN locations — and `lastSeenAt` moves every minute. On a lane that re-reads thousands of posts that is the difference between kilobytes a day and unbounded growth, so that array and ONLY that array goes through the 18-field allowlist; `posts`, `aggregatedPosts`, `accountMedia`, `tips`, `tipGoals`, `stories`, `polls` and every future key stay verbatim, and a body with no `accounts` key comes back byte-identical. **AUTHOR HYDRATION STAYS MANDATORY (A27-1)**: the sidecar was EMPTY in 2 of 5 live responses despite a comment existing, so one `/account?ids=` batch per chunk (<= 100 ids) journals under the EXISTING `account_lookup` kind — which no family claims, and which this package deliberately does NOT claim. Nothing parses it, so the "already looked up" set is capture state in the cursor rather than a projection-derived queue that would re-request the same hundred refs every day forever. **`post_comments.author_ref` is declared in `FAN_REF_ERASURE_COLUMNS` with its own exact fan-scope predicate**: it is a TEXT ref with no FK, invisible to the FK guard, and it is the fan-ref column whose under-erasure is most visible, because the row holds words the fan wrote. **THE WALK QUEUE SURVIVES A REBUILD**, pinned: `projection:rebuild fansly_comments` truncates `post_comments` and replays it, and `subject_refresh_state` comes back byte-identical — a rebuild that reset it would re-mark the whole back-catalogue never-walked and release a first-pass crawl for a repair that should cost zero platform calls. **THE CAP SHIPS AT 100 AND THE RAISE IS A SEPARATE ACT (A29, A16's ritual per-lane per [A19]).** At 100 attempts/page/UTC-day the biggest live page (lora-1, 1 318 roots) first-passes in ~14 days and the fleet's ~4 300 roots in ~43 page-days. The raise to **300/day** is one config flip with its own verification window, and its criteria are recorded here rather than remembered: (zero 429s) AND (a MEASURED `posts.length` p99 — the lane reports it in its progress block and logs `posts.length` per call at info, so the criterion is checkable without a bespoke query) AND (page proxy duty < 5 %) AND (DM/transaction lag unregressed). **400/day is the registry ceiling** and the config registry enforces it as a refusal rather than a note. **Holding at 100 because a criterion failed is a SUCCESS outcome of this package, not a failure.** **Rejected, and recorded so it is not re-proposed:** issuing the verify POST "because the browser does" (§1 excludes it and [E1] proved it unnecessary); marking a complement missing from a page that might be truncated; a roster keyed on its ref-set hash; a roster keyed per page of a multi-page walk (it would claim the post holds only what that page showed); claiming `account_lookup` for this family (registering a family for it stays a backlog item, visible and frozen by the ratchet); walk columns on `creator_posts` (an ordinary repair would wipe them); a `SYNC_DOMAIN_POLICY` membership (a flag-gated analytics lane must not degrade a page's block UX to "catching up"); and a declared dependency on `notifications` (the walk reads `creator_posts`; a notification is only ever a dirty SIGNAL) |
| 229 | Fansly posts widening (WP-F6) — the counters the timeline was already serving | The EXISTING `posts` stream is widened rather than joined by a new one: migration 0139 adds fourteen columns to `creator_posts` (`like_count`, `media_like_count`, `reply_count`, `fyp_flags`, `expires_at`, `in_reply_to_ref`, `in_reply_to_root_ref`, `wall_refs`, `account_mention_refs`, the derived `hashtags`/`hashtags_normalized`/`hashtag_parser_version`, `attachment_refs`, `engagement_observed_at` + its index), `POSTS_CANONICALIZER_VERSION` goes 5 -> 6 and `post.observed` to schemaVersion 3. **EVERY ONE OF THESE FIELDS WAS ALREADY IN THE JOURNAL AND WAS BEING THROWN AWAY** — `/timelinenew` and `GET /post?ids=` have served `likeCount`, `mediaLikeCount`, `replyCount`, `fypFlags`, `expiresAt`, `inReplyTo`, `inReplyToRoot`, `wallIds`, `accountMentions` and `attachments` on the same post objects the lane journals verbatim, so the widening is a version bump plus a replay and costs ZERO platform calls to fill history. **ABSENT IS NULL, NEVER 0, and the payload makes it real**: `replyCount` was PRESENT on 9 and ABSENT on 6 of the 15 timeline posts in the 2026-08-19 capture, and `wallIds` does not appear on the timeline route at all while the batch read serves it as `[]` — a NOT NULL DEFAULT 0 would have recorded "nobody replied" for a post whose count the provider simply did not state, and no re-read distinguishes the two afterwards. **EVERY NEW FIELD ENTERS THE CONTENT HASH**, so a like count that MOVED is a new immutable revision and a new head rather than an in-place edit of the row that recorded the old one — which is the entire point of a refresh lane. **HASHTAGS ARE DERIVED FROM THE CAPTION AND NOTHING ELSE (A8)**: zero structured tag fields on all 60 HAR post objects; tag ids exist only in stats aggregation and the discovery feed. The grammar accepts Unicode letters, numbers and MARKS, `_`, and ONE defensive trailing `+`; the raw token, its NFKC-lowercased form and `HASHTAG_PARSER_VERSION` are stored as one fact in three paired parts (a CHECK enforces the pairing), NFKC folds BEFORE lowercasing so a full-width spelling lands on the ASCII tag, duplicates collapse by folded form, and the parser version participates in the content hash so a grammar change RE-MINTS rather than silently rewriting. **No design or doc may cite `#teen+` as observed — it does not appear in the HAR**; the tolerance is defensive and the fixture that exercises it is labelled synthetic. `attachment_refs` copies THREE KEYS BY NAME (`pos`, `contentType`, `contentId`) — an allowlist, not a redaction, so no delivery URL can reach a serving column whatever the platform starts embedding in `attachments[]`. **THE VERIFIED TRAP:** `POSTS_CANONICALIZER_VERSION` is embedded in the `post.tip_parse_rejected` dedup key, so the bump CHANGES that family's dedup identity — a re-parse of an already-rejected `post_tips` page appends one new parse-debt event under `parser:6` beside the `parser:5` one. It is projection-only debt and the rebuild absorbs it; it is recorded here because nothing else would have noticed. **`post.observed` STAYS PROVIDER-DATED** at `publishedAt` — §3.2b's standing exception, not a new choice — so its pre-2024 fixture asserts the CLAMP branch (`occurredAtClamped` + `occurredAtRaw` preserved, `occurred_at` fallen back to receipt time) while the projected row still holds the true publication date, and the v6 drain across history is covered by §3.2c(ii)'s target-month census, now pinned with a `post.observed` case beside the DM one. **DRAIN ARITHMETIC (production, 2026-08-22):** 1 619 `posts` observations, source `pull`, re-parsed at parse_version < 6; the sweep reads 200 rows per family per page and up to 20 pages per run, so the whole corpus drains in a single `events:replay --kind posts` (minutes) or two ordinary minutely runs. Each observation emits one `post.observed` per post in its page (live pages carry <= 15), an upper bound of ~24 000 appends, every one a NEW event because the dedup key embeds both the v3 content hash and the observation id — no v2 event is touched and no row is overwritten. Provider-dated, so the census applies: prod has every 2026 monthly plus the 2024/2025 yearlies attached, so no month is uncovered and no re-attach is needed. ZERO platform calls. **THE ENGAGEMENT REFRESH is a PHASE, not a stream.** The bounded timeline refresh walks back 14 days, so a post from last spring keeps whatever counters it had the week it was published; `GET /post?ids=<csv>` is the only shape that re-reads a back catalogue by id, and it returns the SAME envelope the timeline does, so it journals under the EXISTING `posts` kind with `{phase:"engagement", ids}` in the request params and the v6 family parses it with no new branch. It runs only once the timeline walk has COMPLETED for the request generation — the timeline is how this system learns a post exists; the refresh only updates numbers on posts it already has. **DECAY WITH THE TIER BOUNDARIES AS CONSTANTS**: fresh (<= 30 d) daily, mid (<= 180 d) weekly, long tail every 30 d round-robin by `last_visited_at ASC`. How engagement decays with a post's age is a property of the platform, not a knob; what is tunable is `fanslyPostEngagementDailyCallBudget` (40, the §6.1 ceiling), which decides how much of the decay the lane can afford. Due-ness is computed from `published_at` and `last_visited_at` against `now`, NEVER read from a stored `next_due_at` — the tier a post is in CHANGES as it ages, and a frozen due date would keep a post that crossed into `mid` on a daily cadence forever. Queue state is `subject_refresh_state` `plane='post_engagement'`, the table's THIRD plane, seeded in bounded keyset batches on first enable and — for everything published afterwards — in the SAME TRANSACTION as the `creator_posts` upsert, alongside WP-F5's `post_replies` row, from ONE statement whose Fansly predicate lives in SQL so no new platform branch appears outside the adapter packages. **`engagement_observed_at` IS DERIVED BY THE PROJECTOR** from the event's own `observedAt` whenever the event carried a counter, never stamped by the capture lane: a lane writing into this rebuildable projection would have it wiped by the next `projection:rebuild`, and the ordinary timeline sighting (which also carries `likeCount`) would not set it at all. It only ever moves forward. **A HEAD WHOSE `reply_count` MOVED MARKS THE WP-F5 WALK DIRTY** (`dirty_reason='reply_count_changed'`) in that same transaction — the only cheap evidence this system gets that a post's comments changed — and only on an EXISTING row, because a first sighting is already never-walked and marking it dirty would DEMOTE it out of the walk's top band. **THE CAP DEFERS, NEVER DROPS**: counted in HTTP ATTEMPTS (retries included) in the posts cursor and SEPARATELY from the timeline walk, which is not capped and must never be starved by a refresh phase; the response already fetched is journaled before the counter is consulted again. `fanslyPostEngagementRefreshEnabled` ships FALSE and with it off the posts lane behaves exactly as before, completion checkpoint included. ONE batch of at most 100 ids per dispatch — the size the app splices for every OTHER `?ids=` route it batches, since its own `getPosts` has no batching loop to read — then WP-F1's `fanslyBackfillContinuationDelayMs` +- 30 % jitter, because burst shape and not daily volume is the ban-risk surface. Only the posts the response NAMED count as refreshed; an id the provider dropped is a failure and is retried, since marking it visited would retire it from the never-refreshed band on the strength of a silence. **MEASURED SIZE, because §6.1's ~1 MB/day row predates the measurement:** the one live `GET /post?ids=` response is 29 375 B uncompressed / 10 232 B on the wire for ONE post, of which 22 357 B is the creator's own `accounts[0]` record (ONE per response whatever the batch size) and 6 287 B its `accountMedia` row. The live `/timelinenew` page gives the same shape at scale (222 726 B for 15 posts, the same `accounts[0]`, 186 119 B of `accountMedia` over 23 media), i.e. ~7-13 KB per post once its media travel with it, so a full 100-id batch is ~0.7-1.4 MB uncompressed / ~0.24-0.41 MB on the wire and 20 calls/day is ~14-28 MB/page/day — NOT the ~1 MB §6.1 books for this row, which must be re-derived. lora-1's steady state (~2 calls/day for 1 318 posts) is ~1.4-2.7 MB/day; its one-off first pass is 14 calls / ~10-19 MB; the cap of 40 bounds the lane at ~28-56 MB/page/day. **The `accounts[0]` sidecar carries `lastSeenAt` and is NOT trimmed** — deliberately, because the EXISTING timeline lane already journals the identical record on every page and trimming one and not the other would make two responses of the same kind un-comparable; it is recorded here as the known dedup-collapse cost of this kind rather than fixed inside a package that was not asked to change the timeline lane. **Rejected, and recorded so it is not re-proposed:** a new stream or a new page allowlist for the phase (it rides `posts`, which already has its own gating; a second allowlist is a switch nobody remembers to look at); tier boundaries as config keys; stamping `engagement_observed_at` from the capture lane; storing the caption's mention offsets or handles (the verbatim caption is in the journal and a handle changes); widening the `posts` or `post_monetization` agent datasets (out of scope — the columns are queryable and the read surface is a separate decision) |
| 230 | Fansly payouts (WP-F7) — money OUT, and the mask that is ours | The `payouts` stream lands whole (0140 enum, 0141 `page_payout_methods` + `page_payout_requests`): TWO routes, `GET /payments/payoutmethods` and `GET /payments/payout/requests?before=&after=&limit=10&offset=N`, both read-only, both verified live 2026-08-20. **A28-8 cut it to two and A28-1 deleted the third:** `/account/wallets/earnings` is already the adapter's `getEarningsOverview` (so no wallet-balance route and NO `page_wallet_snapshots`), and the wallet earnings LEDGER `/account/wallets/earnings/transactions` is the EXISTING `transactions` stream — settled by matching seven transaction ids out of this lane's own capture HAR against rows the kernel already held, including the oldest row on page 242 of 242. **THE CREDENTIAL RULE, AND WHY THE MASK IS OURS:** `metadata` is a JSON-ENCODED STRING and the two live providers are asymmetric — provider 2 (**Paxum, NOT PayPal**; A22-4 refuted the spec from the app bundle) returns the creator's FULL email in plaintext while provider 30 (USDT) returns a `field1` the server already masked, so masking cannot be "trust the platform". `masked_label` is the ONLY value derived from `metadata` that leaves the family: **`<first char>***@<domain>`** for an address, **`****<four visible>`** for a wallet field, and migration 0141 CHECKs the shape (`@` ⇒ must match `^.\*\*\*@`) so a parser regression fails at the INSERT. **THE DECODE IS PROVIDER-KEYED, NOT SHAPE-KEYED** — a future provider 99 with its own `field0…fieldN` decodes to NOTHING (`unmapped:99`, null label, not one character emitted), where a shape-keyed decoder would have published whatever it chose to put in `field1`. Invalid JSON ⇒ `metadata_parse_ok = false`, null label, one diagnostic, string stays journal-only. Both kinds are restricted-class and refused by the agent read plane's fail-closed allowlist, and named on its denylist so the refusal carries its reason. **THE STATUS MAP IS ONE CODE DEEP:** all 83 observed rows carried `status = 8` = `Processed`; every other integer is projected as `(code, unmapped:<code>, unmapped)` and the handler raises ONE anomaly per unseen code per page, durably. **MILLS WITH NO SCALING** (the wire unit IS the kernel unit, proved against the UI on seven fields), instants 13-digit Unix ms decoded by an ms-ONLY helper, events receipt-time (§3.2b) so a 2025 payout is writable into a monthly-partitioned ledger. **THE WALK:** offset-paged at 10, `total = 83` back to 2025-06-23 ⇒ nine calls, and the daily head read at `offset=0` IS page one of it, so steady state is TWO calls/day against a cap of **20** (§6.1's corrected number). The repeat-request guard gained a second trigger because the first one could not fire: an offset always advances, so what catches a server IGNORING `offset` is a page whose first row is the first row of the page before it. Ships INERT — flag off, allowlist FAILS CLOSED. |
| 231 | Fansly per-media statistics (WP-F4) — the lane that can overload the platform | The `media_stats` stream lands whole (0142 enum, the §3.3 wiring, four config keys, the handler, the completed parser, the projector reducers): `GET /it/moie/statsnew` over ALL media at an age-decayed cadence — fresh (≤30 d) daily at hourly granularity, mid (31–180 d) weekly, long tail every `fanslyMediaStatsLongTailCycleDays` (30), round-robin by last visit, with WP-F2's purchase signals and the current top-50 jumping the queue. **A16's TABLE IS REPORTED, NEVER RESTATED**: `estimatedCycleDays` is computed on every dispatch from the LIVE class census and the LIVE cap, and the log line says QUARTERLY in words once it passes 90 days — at M = 2 000 the decay wants 294 calls/day and the long tail comes round every 26 days; at M = 5 000 it wants 394 and the cycle is 96 days. Nothing is dropped at any M. The lane is DESIGNED to sit at 100 % of its own 300-attempt cap and is exempt from the 70 %-of-its-own-cap rule by name; raising the cap is a NAMED per-lane owner step, which the registry ceiling of 1 000 makes refusable. **THIRTY-ONE DAYS, NOT A HUNDRED**: the HAR proves this route honours a historical 31-day window exactly, and F1 proved on production what a 100-day one costs. **The queue is `subject_refresh_state` (`plane='media_stats'`), not four columns on `creator_media`** — a rebuild that reset them would re-mark the whole catalogue as first-sight and release a backfill storm bounded only by this lane's own cap, and a test pins the isolation. Video columns stay NULL and unpromised ([E5]).

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

## Arbitrated Decisions
### Workspace Tooling
**Decision:** `pnpm` workspaces only in v1; no Turborepo or Nx.

**Score:** 9/12 chose plain `pnpm` workspaces; 2/12 chose Turborepo; 1/12 was not explicit.

**Why:** Three apps and a small set of shared packages do not justify another build-graph layer yet. Plain `pnpm --filter` workflows stay obvious for humans and AI agents, and the repo can add orchestration later only if build times become a real problem.

**Rejected:** Turborepo is useful only once the repo has measurable build-graph pain. Nx adds even more framework overhead without solving a v1 problem.

### Backend Framework
**Decision:** Fastify + Zod.

**Score:** 9/12 chose Fastify; 3/12 chose Hono.

**Why:** Once REST wins, Fastify is the better boring server: mature plugins, straightforward Zod integration, and first-class structured logging. It is more practical for long-running API and SSE workloads than optimizing for the thinnest possible HTTP layer.

**Rejected:** Hono is viable, but its main advantage here was usually tied to tRPC rather than this project's final architecture.

### API Style
**Decision:** REST JSON under `/api/v1`.

**Score:** 9/12 chose REST + shared schemas / OpenAPI; 3/12 chose tRPC.

**Why:** The dashboard, ChatMuse extension, Telegram jobs, and future scripts all benefit from one plain HTTP contract that works with `fetch`, curl, and generated clients. URL-based versioning is enough for v1, and `/api/v1` keeps the upgrade path explicit if a v2 is ever needed.

**Rejected:** tRPC would couple the transport too tightly to TypeScript consumers and make the extension boundary harder, not easier.

### OpenAPI Generation
**Decision:** Generate OpenAPI from Zod route schemas.

**Score:** 8/12 explicitly specified OpenAPI generation; 2/12 used tRPC; 2/12 shared Zod schemas without OpenAPI.

**Why:** The Zod schemas already exist for validation, so generating OpenAPI adds a stable contract and typed client generation at low cost. That keeps the API inspectable outside the monorepo and avoids drift between dashboard, extension, and scripts.

**Rejected:** Shared Zod schemas without OpenAPI work only as long as every consumer lives in the same tooling context. tRPC removes the universal HTTP contract this project needs.

### Frontend Router
**Decision:** React Router.

**Score:** 7/12 chose React Router; 5/12 chose TanStack Router.

**Why:** This dashboard needs boring, well-known routing more than maximal type cleverness. React Router is easier to search, easier for AI agents to patch correctly, and fully sufficient for a small internal route graph.

**Rejected:** TanStack Router is good technology, but its extra type machinery is a marginal win for this app's routing complexity.

### Frontend Client State
**Decision:** Zustand from day 1 for client-only UI state.

**Score:** 7/12 chose a small Zustand store; 5/12 preferred React local state first.

**Why:** Date ranges, filters, and panel toggles will be shared across unrelated dashboard components almost immediately. Zustand is tiny, avoids prop drilling, and complements TanStack Query instead of overlapping with server state.

**Rejected:** React local state and context are workable, but they become noisy sooner than they save complexity on this dashboard.

### UI Layer
**Decision:** Tailwind CSS + `shadcn/ui`.

**Score:** 6/12 explicitly chose Tailwind + `shadcn/ui`; 6/12 were custom or unspecified.

**Why:** This stack is fast to iterate on, works well with AI-generated UI patches, and keeps component code in the repo instead of behind a dependency boundary. It is the shortest path to a polished internal dashboard without locking the project into a rigid design system.

**Rejected:** Large component libraries add styling gravity the product does not need. A fully custom component system from day 1 is extra effort without user value.

### Dashboard Auth
**Decision:** Argon2id passwords with HttpOnly Postgres-backed sessions.

**Score:** 9/12 chose server-side or opaque cookie sessions; 3/12 chose JWT-style sessions.

**Why:** Fewer than ten dashboard users means the DB lookup cost is irrelevant, while immediate revocation and simpler security semantics are valuable. Argon2id is the right default for password hashing, and Postgres-backed sessions keep auth state explicit and easy to revoke.

**Rejected:** JWT dashboard sessions add token lifecycle and revocation complexity without giving this product a real operational benefit.

### ChatMuse Auth
**Decision:** Admin-issued scoped API keys, one per chatter account, hashed in Postgres and revocable; page access is enforced server-side.

**Score:** 6/12 chose long-lived API keys / personal tokens; 6/12 chose short-lived access tokens with refresh or token exchange.

**Why:** ChatMuse is an internal extension with manually issued credentials, so a pasted API key is the lowest-friction model that still supports revocation and scoping. The backend can enforce per-page access and request-count quotas while always logging token and cost usage in the ledger.

**Rejected:** Access and refresh token flows add rotation, storage, and recovery logic the extension does not need. Per-device credentials would add admin overhead without improving the real threat model.

### Money / Amount Storage
**Decision:** Store all monetary amounts as `BIGINT` mills (`1 mill = $0.001`) in PostgreSQL `bigint` columns, alongside `currency` and the raw source amount.

**Score:** 5/12 chose `BIGINT` mills; 3/12 chose `NUMERIC` + `decimal.js`; 3/12 chose `BIGINT` micros or generic minor units; 1/12 chose integer cents.

**Why:** Fansly already speaks mills, so storing that native unit avoids conversion loss and keeps arithmetic exact; OnlyFans cents convert losslessly by multiplying by 10. Use shared helpers such as `centsToMills`, `millsToDollars`, and `formatMoney` at the edges, and return mills as JSON numbers because the expected range stays comfortably within JavaScript's safe integer limit.

**Rejected:** `NUMERIC` is correct but forces string parsing and decimal ceremony through Drizzle for no gain here. Micros add precision the sources do not need and throw away the "store Fansly natively" advantage. Cents are wrong for this product because they would truncate real Fansly precision.

### Sync Scheduler
**Decision:** `pg-boss`.

**Score:** 7/12 chose `pg-boss`; 3/12 chose BullMQ; 2/12 chose `node-cron`.

**Why:** `pg-boss` delivers durable scheduling, retries, concurrency control, and job visibility without adding Redis. Keeping jobs in Postgres lets the application query queue state directly and keeps operational state in one system.

**Rejected:** BullMQ would force Redis into the baseline stack for no v1 benefit. `node-cron` is too weak once missed runs, retries, and dead jobs matter.

### Worker Separation
**Decision:** Run a separate worker process role using the same Docker image with two CMDs: `node dist/api.js` and `node dist/worker.js`; same codebase, same packages, same DB connection, not a separate service, no RPC, and communication only through `pg-boss` jobs in Postgres.

**Score:** 7/12 chose a separate worker process/container; 5/12 ran jobs in the API process or left the split ambiguous.

**Why:** Long follower syncs and retry-heavy background work should not share an event loop with request handling. The split is operational, not architectural: this is one application deployed in two roles, not a separate service or microservice boundary.

**Rejected:** Running sync jobs in the API process increases the chance that long-running work drags on request responsiveness. A separate service with its own codebase or RPC adds complexity the product does not need.

### ChatMuse Streaming
**Decision:** Use normal REST request/response for standard endpoints and SSE only for AI streaming endpoints.

**Score:** 5/12 included SSE for AI endpoints; 7/12 said REST-only.

**Why:** Fan lookups, notes, and most dashboard APIs are standard REST reads and writes, so they should stay simple. Claude responses can take 3-10 seconds, and SSE is the cheapest way to stream partial AI output without forcing the whole product onto WebSockets.

**Rejected:** REST-only everywhere leaves AI UX stuck behind long spinners. WebSockets are unnecessary for traffic that is still fundamentally request/response.

### Playwright E2E
**Decision:** Defer Playwright E2E to post-MVP.

**Score:** 6/12 included Playwright in v1; 6/12 deferred it.

**Why:** The dashboard UI will change too quickly in the first iteration to justify browser automation churn. The highest-risk v1 behavior is backend correctness around money, sync, and auth, which is better covered by Vitest and Testcontainers.

**Rejected:** A thin smoke suite now would create maintenance work on unstable screens. Skipping browser coverage forever would also be wrong once the UI stabilizes.

### Project Structure Detail
**Decision:** Keep the monorepo shape, but leave the exact app/package split to the implementer based on real code dependencies.

**Score:** 6/12 used many packages; 4/12 used moderate structure; 2/12 used minimal workspaces.

**Why:** Both source documents identified the same broad boundaries, but they disagreed on how aggressively to package them. This reference should lock the architecture and leave package granularity flexible enough to match the actual dependency seams that appear during implementation.

**Rejected:** A fixed minimal split risks turning the API into a grab bag once adapters and worker code grow. A fixed maximal split creates package overhead before the code proves those boundaries are useful.

### Code Quality Tooling
**Decision:** ESLint + Prettier.

**Score:** 1/12 explicitly chose ESLint + Prettier; 2/12 chose Biome; 9/12 were not explicit.

**Why:** ESLint and Prettier are still the safest default for editor support, plugin breadth, CI integration, and AI-generated patches. The boring industry standard is the better choice here than optimizing for tool novelty.

**Rejected:** Biome is promising, but the ecosystem and rule surface are still narrower than the repo is likely to want over time.

### Notification Delivery
**Decision:** Store alerts in the DB first, deliver Telegram notifications asynchronously through `pg-boss`, send critical alerts to the owner only, send one daily summary to a configured destination, and treat recurring failures as one open incident plus one resolved notification.

**Score:** 7/12 chose Telegram Bot API with queued or outbox delivery; 2/12 chose direct Bot API calls without a queue; 1/12 chose a bot framework; 2/12 were not explicit.

**Why:** Persisting alerts first makes the dashboard, Telegram, and job history agree on the same incidents. Queue-backed delivery survives transient Telegram failures, and the open/resolved incident model prevents alert storms for noisy sync or token problems.

**Rejected:** Direct Bot API calls from the failing code path risk lost notifications during outages. Bot frameworks add command and middleware machinery that v1 push notifications do not need.

## Additional Decisions
- **Reporting period semantics:** The backend computes all business period boundaries on UTC business dates, and trailing `7d` and `30d` windows include today so dashboard, Telegram, and exports agree.
- **No Redis in v1:** This is a deliberate choice, not an omission; use Postgres rollups, a Postgres prompt cache, and in-memory short-window limiting until a measured bottleneck says otherwise.
- **Hub-owned AI gateway:** Route all Claude traffic through one backend gateway that records feature, chatter, page, provider response ID, token usage, cost, cache hit, and quota decisions.
- **Raw payload retention:** Store mapping-critical upstream payloads and all failed payloads as `jsonb`, tagged with `mapper_version` and sync run ID, and retain them for 180 days.
- **Sync idempotency and checkpointing:** Every sync should write per-account checkpoints and idempotency keys so reruns can safely upsert raw events first and rebuild derived projections without duplication.
- **Unified transaction taxonomy:** Use one compact internal enum of `subscription`, `tip`, `message_purchase`, `post_purchase`, `stream_tip`, `chargeback`, `refund`, `payout_reversal`, and `other`, then map platform-specific codes inside the adapters.
- **Append-only notes and summaries:** Notes are immutable records, and AI summaries append new versions rather than overwriting prior history.
- **Precomputed rollups:** Maintain daily fact tables for revenue, followers, and subscribers so dashboard and report queries stay simple and consistent.
- **Proxy handling:** Store per-page proxy configuration in the database and apply it inside platform adapters rather than scattering proxy logic across services.
- **Secret encryption:** Encrypt platform tokens and proxy credentials at rest with application-layer encryption so DB leaks and backup exposure do not reveal live secrets in plaintext.
- **Backups:** Run nightly full Postgres backups, keep them off-VPS, and rehearse restores so single-VPS deployment is operationally credible.
- **Health checks:** Provide a lightweight `/health` endpoint and a scheduled token/proxy health check that turns auth death and proxy outages into first-class incidents.
- **Audit trail:** Record login, token issuance and revocation, page assignment changes, payout edits, and note or summary edits as append-only audit events.
- **File storage:** Keep notes, summaries, alerts, raw payload snapshots, and other v1 artifacts in Postgres text/JSONB; do not add binary or object storage yet.
- **Migrations:** Keep Drizzle migrations forward-only, commit the SQL to git, and run them as an explicit deploy step rather than auto-applying them on boot.
- **Logging:** Use Pino structured JSON with request IDs and job IDs so logs are machine-parseable and easy to grep.
- **CI/CD:** Use GitHub Actions to build images, publish them to GHCR, and deploy them to the VPS over SSH.

## Excluded
- **Generic `{ data, error, meta }` success envelopes:** They add wrapper noise without solving a real problem for these internal clients.
- **Full external observability stack in v1:** Pino logs, health checks, DB-backed alerts, and Telegram are enough before adding `Sentry`, `Datadog`, or similar services.
- **UUID-everywhere as a mandatory convention:** Use natural or composite keys where they carry meaning, and keep internal IDs boring unless a specific module needs more.

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

## Linked Decisions
| Package | Decisions | Consequence |
|---------|-----------|-------------|
| **No Redis** | `pg-boss` + Postgres rollups/prompt cache + in-memory short-window limiting | One fewer baseline service, and queue state, cache state, and business state stay queryable in Postgres. |
| **REST + SSE Split** | OpenAPI from Zod + generated typed clients + REST for normal endpoints + SSE for AI streaming only | Most APIs stay simple HTTP while long-running AI responses stream without adopting WebSockets everywhere. |
| **Separate Worker Role** | Same image, two CMDs, shared packages, shared DB, no RPC | Heavy background work is isolated operationally without creating a second service boundary. |
| **BIGINT Mills** | Fansly-native mills + OF cents ×10 + integer math + one formatter/conversion layer | Money stays exact in SQL and JS without `decimal.js` or `NUMERIC` string plumbing. |
| **Hub-Owned AI Gateway** | Centralized Claude access + quotas + cost ledger + prompt cache | ChatMuse usage, billing, caching, and provider integration stay enforceable in one place. |


## Phase Sequencing Change (2026-03-08)

**Decision:** Phase 4 (OnlyFans Connect) now executes before Phase 3 (Dashboard).

**Rationale:** Dashboard should ship with both Fansly and OnlyFans data from day one. Building the dashboard first would mean retrofitting OF support later — more rework, more risk. OF Connect is backend-only and smaller scope, making it a natural predecessor.

**New order:** Phase 1 → Phase 2 → Phase 4 → Phase 3 → Phase 5+

**Impact:** Phase 3 now depends on Phase 2 + Phase 4. PRD numbering swapped (Phase 3 = OF Connect, Phase 4 = Dashboard in PRD; roadmap keeps original names with updated deps).

## Revenue Classification Split (2026-03-09)

**Decision #46:** Replace the single `totalNetMills` revenue model with explicit Revenue / Adjustments / Unclassified / Net Earnings, driven by shared classification metadata.

### Reporting Buckets (in `packages/shared/src/types.ts`)

| Bucket | Canonical Types | Description |
|--------|----------------|-------------|
| `revenue` | subscription, tip, message_purchase, post_purchase, stream_tip | Clean business revenue |
| `adjustment` | chargeback, refund | Post-sale corrections |
| `unclassified` | other | Ambiguous types pending audit |
| `excluded` | payout_reversal | Platform-internal, not income |

Each type also carries `affectsFanLtv: boolean` — fan LTV uses different rules than revenue reporting.

### Fan LTV Rules (separate from revenue)

- revenue types: affect LTV ✅
- chargeback, refund: reduce LTV ✅
- other (fan-linked): temporarily affects LTV ✅ (until audit)
- payout_reversal: does NOT affect LTV ❌

Fan LTV uses an **exclude-list** (only `payout_reversal` excluded), not a whitelist. This preserves current LTV values until `other` is audited.

### Revenue Metrics

- `revenueMills` — sum where bucket = revenue
- `adjustmentMills` — sum where bucket = adjustment
- `unclassifiedMills` — sum where bucket = unclassified
- `netEarningsMills` = revenueMills + adjustmentMills + unclassifiedMills (reconciliation total, must match ledger)

`totalNetMills` remains as a deprecated alias of `netEarningsMills` for rollout safety.

### API Contract Shape

```
summary: { revenueMills, adjustmentMills, unclassifiedMills, netEarningsMills }
breakdown: [{ canonicalType, bucket, netAmountMills }]
comparison: { summary, delta }
```

### What Does NOT Change

- No gross revenue model — system stays on `net_amount_mills`
- No DB schema migration — `canonical_type` is source data, classification is product logic
- No moving OF chargebacks to original sale date — chargeback stays on chargeback timestamp
- No hiding `payout_reversal` from `/transactions` — ledger stays auditable
- No change to pending vs posted semantics (deferred)
- `daily_revenue` schema unchanged — materialization logic uses shared classifier instead of hardcoded special cases

### Follow-up (not blocking)
- Audit `other` bucket: Fansly raw types 18001, 18002, 24101 (referral, leaderboard) may be real revenue
- After audit: remap to proper canonical types or adjust classification
- Consider `classifiedNetEarningsMills` (revenue + adjustments only) as optional derived metric

**Rationale:** Current code treats everything except `payout_reversal` as "revenue", mixing chargebacks into revenue metrics. This must be fixed before Phase 4 (Dashboard) to avoid shipping incorrect financial data. The shared classification approach avoids DB migration and keeps the change in query/service/API/CLI layers only.


## OFAPI Real-Time Pipeline (2026-06-11)

**Decision #48:** Core becomes the real-time hub for the ChatGoose desktop app ("ChatMuse"): an onlyfansapi.com (OFAPI) webhook receiver plus an SSE fanout, with pg-boss carrying the async processing. Scope and shape (brief: ChatGoose desktop `docs/SPEC.md` §9.2 + its live-captured fixtures, copied to `tests/fixtures/ofapi-webhooks/`):

- **Receiver `POST /api/v1/ofapi/webhook`:** authenticates by `HMAC-SHA256(rawBody, signing_secret)` from the `signature` header (hex, timing-safe compare), over the raw bytes — the route lives in its own Fastify plugin scope with the repo's only `parseAs: "buffer"` body parser. Dedupe key is the `x-ofapi-idempotency-key` header (`evt_<40 hex>`; live-verified — the body has no event id), enforced by a unique index on `ofapi_webhook_events.idempotency_key`. The handler does two indexed statements plus one `boss.send` and acks well under OFAPI's 15 s timeout; a minutely sweep job re-enqueues rows whose enqueue was lost.
- **Journal `ofapi_webhook_events` (migration 0027, additive):** full envelope JSONB + derived `sync_event` JSONB + resolved `platform_account_id`, settled by the worker as processed/skipped/failed (settle guarded on `status='pending'`, so a retry racing the sweep settles exactly once). The SSE event id is `fanout_seq`, assigned in **settle order** inside the settle transaction — receive-time bigserial ids would make late settles (pg-boss retries, the sweep) invisible to clients whose `Last-Event-ID` already advanced past them. Retention defaults to 7 days (`OFAPI_EVENT_RETENTION_DAYS`), pruned by a daily 02:30 UTC job.
- **Queue throughput hardening (2026-06-20):** webhook processing uses the
  `ofapi.events.process.v2` queue with `exclusive` policy keyed by journal event id and fetches
  batches of 100 into one sequential handler. This preserves the single-worker settle-order
  invariant while preventing sweep duplicates and removing the pg-boss idle poll between every
  event. The original standard-policy queue is retired in place; retained old jobs are not
  executed, and pending journal rows converge through the v2 minutely sweep.
- **Single-worker startup guard (2026-06-21):** the event fanout design remains single-replica
  until settle ordering is redesigned for HA. `OFAPI_EVENT_WORKER_REPLICAS` defaults to `1`, and
  the worker refuses to register the OFAPI event handlers when it is configured to any other value.
  This is a loud operational guard, not a horizontal-scaling implementation.
- **Account→page mapping:** new nullable unique `pages.ofapi_account_id`. Owner-only admin flow (`GET/POST /api/v1/admin/ofapi/webhook`) registers the webhook at OFAPI with `account_scope: global` and a freshly generated signing secret (stored as an `encryptJson` envelope, same custody as the Telegram bot token; the previous secret is kept and accepted as a rotation grace window, since registration rotates remotely before persisting locally), then auto-maps OFAPI accounts to OnlyFans pages by unambiguous username match; everything else is reported back for manual resolution. Events for unmapped accounts are journaled but not fanned out.
- **Fanout `GET /api/v1/events/stream`:** chatter API-key auth only, frames filtered to the chatter's assigned pages. Frames are core's copy of the desktop `SyncEvent` union (`syncEventSchema` in contracts; `accountId` = OFAPI `acct_…` id) plus a `messageDeleted` extension. Live path: worker `pg_notify`s journal ids on commit; the API process holds one shared LISTEN connection that re-reads the journal from its delivery watermark after every (re)connect, so frames settled during LISTEN gaps still reach connected clients. Replay: `Last-Event-ID` header (or `lastEventId` query param) reads forward from the journal by `fanout_seq`; subscribe-before-replay buffering (deduped by the exact replayed id set) closes the gap between catch-up and live. Streams are capped at 15 minutes so key revocation and page reassignment take effect on reconnect, and slow consumers (>1 MB buffered) are dropped — clients resume via `Last-Event-ID`.
- **Journal-only events:** `transactions.new` is subscribed and journaled (future OF analytics enrichment) but not fanned out — the desktop has no frame for it and a chat-list hint would trigger credit-charged refetches.

**Also shipped with this change (ChatMuse pre-P4 prerequisites):** `PUT …/fans/{platformUserId}/profile` auto-creates the fan + page membership for OnlyFans pages instead of 404 (core's OnlyFans sync is transactions-only, so non-spenders were unwritable; reads and Fansly stay strict), and `POST /api/v1/ai-usage/batch` skips events with invalid `completedAt` per-event, reporting a new `invalidCount`, instead of failing the whole batch.

**Rationale:** Webhooks are ~100× cheaper than polling OFAPI (1 credit/100 events vs 1 credit per uncached call) and the desktop needs push for its P3 milestone. SSE (not websockets) per decision #25. Async processing via pg-boss keeps the receiver inside OFAPI's delivery timeout and reuses existing worker/retry/cron infrastructure; LISTEN/NOTIFY bridges worker→API across the two-container deployment without new infrastructure.


## OFAPI OnlyFans DM Sync + Account Health (2026-06-11)

**Decision #49:** OnlyFans pages get the same core DM features Fansly pages have — DM history in `page_dm_threads`/`page_dm_messages`, conversation previews, workboard eligibility, sync-blocks observability, account-health alerting — fed by onlyfansapi.com on top of the decision-#48 webhook journal. Implements Phases 1–3 of `docs/ofapi-integration-plan.md` (Phase 4 deferred); core stays read-only toward OnlyFans, OnlyMonster transactions/audience sync and the ChatMuse SSE contract are untouched. Each phase ships behind its own default-off flag: `OFAPI_DM_PROJECTION_ENABLED`, `OFAPI_DM_SYNC_ENABLED`, `OFAPI_ACCOUNT_HEALTH_ENABLED`.

- **Phase 1 — live DM projection (webhook-first, D1/D2):** a post-settle step projects settled `messages.received/sent/deleted`, `messages.ppv.unlocked`, and `tips.received` journal rows for OFAPI-mapped OnlyFans pages into the platform-agnostic DM store via the existing `page-dm` repo helpers — conversation id = fan's OnlyFans user id, HTML stripped to plain text (journal keeps the raw payload for `OFAPI_EVENT_RETENTION_DAYS`), heads advance forward-only, unread heuristic (fan message increments, model head reply zeroes; workboard keys off `last_message_sender_role`, so the heuristic is non-load-bearing until reconcile corrects it). Projection bookkeeping lives on the journal row (`projection_status/_error/_attempts`, migration 0028) and the minutely sweep retries pending/failed rows (attempt cap 5) — settle/fanout (`fanout_seq`, SSE) is byte-for-byte untouched, by construction: the projection runs only after the settle transaction commits and never throws into it. DM-type rows are stamped `projection_status='pending'` at receive time regardless of the flag, so enabling later back-projects the journal still inside retention. `messages.deleted` deletes the held row and recounts (Fansly has no vanished-message handling to mirror — this is the plan's stated fallback); `ppv.unlocked` stamps the new `page_dm_messages.purchased_at`; `tips.received` raises the held message's tip total monotonically (annotations survive REST re-walks because already-stored rows are never re-upserted). The `messages_live` block reads webhook ingest freshness (age of last settled `messages.*` event, display-only, conservative 24 h staleness); the workboard queue/snooze endpoints accept OnlyFans pages and the v2 recompute includes OFAPI-mapped ones (`resolveAccessibleFanslyPage` was Fansly-only — the "comes free from D3" assumption in the plan was wrong for the workboard read path).
- **Phase 2 — bootstrap + reconcile (REST, budgeted, D3/D4/D5):** OFAPI-mapped pages route their `dm_conversations`/`dm_messages` executor streams to OFAPI REST handlers; the parked OnlyMonster polling path stays untouched behind `ONLYFANS_DM_POLLING_ENABLED` for unmapped pages (the executor skip, the planner force-pause, and the stream filter all exempt eligible pages — pages paused before the flag flip need one manual resume from the sync dashboard). The client (`listChats`/`listChatMessages`) paces requests client-wide (`OFAPI_REST_DELAY_MS`, 500 ms), honors 429 `retry-after`, and records `_meta` credits/rate into `sync_http_attempts` via `executeObservedRequest`. dm_conversations does one offset-checkpointed full chats walk (limit 100, recent-first), then page-1 reconciles every `OFAPI_DM_RECONCILE_INTERVAL_MINUTES` (6 h): unread counts are taken as authoritative, heads only ever advance (a fresher webhook projection is never regressed), diverged chats get a `dm_messages` follow-up. dm_messages walks per-conversation `order=desc` with the `first_id` cursor — live-doc-verified as *inclusive*, so the cursor echo is dropped — straight down to the retention tier (200 regular / 1000 spender from existing `fan_spend_lifetime` data, plan recommendation 4) with Fansly coverage transitions (exhausted/overlap → `complete`, cap → `partial_window`; no deep-backfill pacing — OFAPI is an official API, the Fansly quota dance is unnecessary). Budgets (D4): per-chunk request cap (`OFAPI_DM_BOOTSTRAP_MAX_REQUESTS_PER_RUN`), UTC-day credit ceiling (`OFAPI_DM_DAILY_CREDIT_BUDGET`) and last-observed balance floor (`OFAPI_CREDIT_FLOOR`) tracked in the new `ofapi_credit_state` singleton (migration 0029; credits are account-global, so deliberately not per page); request-cap blocks yield normally, budget/floor blocks park the stream for an hour. Admin trigger/pause/resume/reset and the `messages_history` block work unchanged (D3, verified by tests).
- **Phase 3 — account health + credit ops (D9):** `accounts.*` events project post-settle into `pages.ofapi_auth_status`/`ofapi_auth_changed_at` (raw event suffix, forward-only by receive time; migration 0030), overlaid on the `connection` block — action states (`authentication_failed`, `otp_code_required`, `face_otp_required`) flip the chip to error; `session_expired` alerts but does not (OFAPI fires it after silent recovery). Alerts reuse the notification-incident machinery (debounced, Telegram-backed, gated by the existing `syncFailureAlertsEnabled`): per-page `ofapi_auth` incidents resolve on `connected/reconnected`; account-global `ofapi_low_credit` (last `_meta` balance < `OFAPI_CREDIT_ALERT_THRESHOLD`) and `ofapi_webhook_silence` (no journaled events for `OFAPI_WEBHOOK_SILENCE_THRESHOLD_MINUTES` = 12 h conservative default while mapped pages exist; silent when the journal is empty — no baseline) run from the minutely OFAPI sweep. Global incidents carry no page, so `notification_incidents.platform_account_id` became nullable (they don't appear in the page-joined incident listing; the Telegram alert plus the admin endpoint are their surface). `GET /api/v1/admin/ofapi/webhook` now reports per-page auth status, last-event ages, and the credit balance/day-spend (the only API-surface change, as planned).

**Plan deltas:** migrations are hand-written numbered SQL (`0028`–`0030`) — the repo has no drizzle-kit meta journal, so `pnpm db:generate` does not apply (0027 was hand-written too, the plan/launch-prompt instruction was stale); `page_dm_messages.purchased_at` plus an `(account, message id)` index were added because nothing existed to "mark purchased" (plan said mark, schema had no column); workboard read-path acceptance required the `resolveAccessibleDmPage` resolver + recompute-list change noted above. Phase 0 measurement (events/day by type over the live journal) could not run in the implementation session — no authorized access to the live DB; informational only, the §4 credit math is unchanged.

**Rationale:** Webhooks already deliver complete message payloads (decision #48), so live DM ingest costs ~nothing; REST is reserved for bootstrap/reconcile under explicit credit budgets with the balance read for free from every response's `_meta`. Reusing the Fansly-built DM store, retention tiers, coverage statuses, sync blocks, and incident alerting means OnlyFans pages light up across previews/workboard/dashboard with no new tables for DM data and no new dashboard pages.


## OFAPI Credit Ledger + OnlyFans Audience/Presence/Top-Spender Parity (2026-06-12)

**Decision #50:** OnlyFans pages close the remaining feature gaps with Fansly — subscribers, fan presence, top spenders — and OFAPI credit spend becomes fully accounted and visible. Implements Phases 1–5 of `docs/ofapi-parity-plan.md` (Phase 0 is the owner's ops runbook; §6 non-goals untouched) on top of decisions #48–#49. Core stays read-only toward OnlyFans; the webhook subscription (17 event types), receiver semantics, settle/fanout ordering (`fanout_seq`), and the ChatMuse SSE contract are byte-for-byte unchanged. Each phase ships behind its own default-off flag: `OFAPI_CREDIT_LEDGER_ENABLED`, `OFAPI_AUDIENCE_SYNC_ENABLED`, `OFAPI_PRESENCE_PROJECTION_ENABLED`, `ONLYFANS_TOP_SPENDERS_ENABLED` (the Phase 2 page is owner-gated UI over Phase 1 data and shows a disabled notice while the ledger flag is off).

- **Phase 1 — credit ledger + reconciliation + alerts (D1–D6):** append-only `ofapi_credit_ledger` (migration 0031; sources `rest | webhook_accrual | external | refill | adjustment`, positive = spent). The client itself is the single spend tap (D1, enforced by a gate test keeping `OFAPI_BASE_URL`/the host inside `ofapi.ts` + `config.ts`): both request paths — including the plain admin path, now operation-tagged (`ofapi_webhook_crud`, `ofapi_admin_accounts`) — parse `_meta` on every response that reached the server, retries included, and report through an injected `onCreditSpend` sink that writes the ledger row and the `ofapi_credit_state` day counter in one transaction (D2; the dm-sync guard skips its own counter write when the ledger owns it, and keeps the pre-ledger behavior with the flag off). Server-reported credits always win (D3); a 2xx without `_meta` books an `estimated` 1-credit row; error responses without `_meta` book nothing — reconciliation absorbs hidden charges and empirically answers whether errors bill (plan rec. 1). Daily 00:40 UTC accrual posts `ceil(events/100)` per completed UTC day from our own journal (idempotent via a partial unique index on `accrual_day`, backfills the retention window, `occurred_at` inside the accrued day so daily/burn aggregates attribute correctly). Hourly bank-style reconciliation walks balance observations (≥60 s apart, |residual| < 1 ignored, cursor + drift on `ofapi_credit_state`) and decomposes drift into `external`/`refill` rows; in-window "known spend" excludes prior `external`/`refill` rows (their ids postdate the windows they describe). New debounced `ofapi_burn_rate` incident on trailing-hour spend (all sources except refills) over `OFAPI_BURN_ALERT_CREDITS_PER_HOUR` (300), from the minutely sweep. Optional daily balance ping (`OFAPI_BALANCE_PING_ENABLED`, 00:05 UTC) anchors quiet days.
- **Phase 2 — credit usage UI (D7):** owner-only `/ofapi-credits` page fed by exactly three `requireOwner` routes: `credits/summary` (balance, UTC-day spend by source, per-stream budgets whose park states mirror the executor guards, floor, 7-day forecast, open `ofapi_*` incidents, reconciliation cursor, last posted accrual day, and the current UTC day's pending webhook estimate as `ceil(today_webhook_events / 100)` kept separate from posted spend), `credits/daily` (dense per-day spend by source, balance series — newest-2000-capped — refill markers, and the operation/page breakdowns, so the breakdown period selector rides this one query and D7's three-route budget holds), `credits/ledger` (filtered, paginated, page-labeled). New-page checklist followed (breadcrumbs, owner sidebar entry, `contracts:generate`, route + dashboard render tests); the stacked daily bars are a generic shared `StackedBarChart`.
- **Desktop-facing C2 endpoint (2026-06-19):** `GET /api/v1/ofapi/credits/summary` is bearer chatter-key only and scoped to the key's current page assignments. It returns assigned-page REST credits from page-attributed ledger rows plus webhook credit estimates derived from assigned-page journal event counts for today and the current seven-day UTC window. It deliberately omits owner-only global balance, refills, external drift, and adjustments; owner/global accounting stays on `/api/v1/admin/ofapi/credits/*`.
- **C3 spend projection and staged apply (2026-06-19):** `OFAPI_SPEND_PROJECTION_SHADOW_ENABLED` gates a separate `ofapi_spend_projection_events` table. It writes comparison rows first: live-captured `transactions.new` becomes integer-mill pending/settled spend input, `messages.ppv.unlocked` is only an estimated purchase signal, and `tips.received` writes `projection_status='blocked'` with `tips_received_live_fixture_required` until a live verified fixture replaces the documented example. Rows are idempotent by domain key and back-project from retained journal rows via the minutely OFAPI sweep. `OFAPI_SPEND_TRANSACTION_INGEST_ENABLED` is a second default-off staged flag (`requires: OFAPI_SPEND_PROJECTION_SHADOW_ENABLED`) that applied only missing `transactions.new` projection rows into the core `transactions` table in its first implementation, created the fan/page membership, and rebuilt spender/revenue rollups from the affected date. The 2026-06-19 implementation was forward-only: existing mismatched transaction rows were not overwritten, `messages.ppv.unlocked` remained estimated-only, `tips.received` remained blocked, and desktop sweep cadence was unchanged. Owner-only `GET /api/v1/admin/ofapi/spend/comparison` compares projection rows against current core `transactions` truth over a bounded window and classifies `matched`, `missing_in_core_truth`, page/fan/amount/state mismatches, `ppv_estimated`, `tips_blocked`, `blocked`, and `skipped` rows with sample deltas; comparison normalized OFAPI `settled` to core `posted`. Production recheck at 2026-06-19 22:55 UTC showed api/worker running shadow+ingest enabled; over 30 days, `transactions.new` matched 11/11 (`302950` gross mills / `242350` net mills), all mismatch buckets were zero, and `messages.ppv.unlocked` remained estimated-only (`ppv_estimated=6`, `278000` gross mills). D6 stays blocked until PPV/tips policy is accepted and the desktop rollback-controlled rollout is explicitly approved.

- **C3 ingest correction (2026-06-21):** `OFAPI_SPEND_TRANSACTION_INGEST_ENABLED` stays default-off and must remain off until terminal/reversal comparison is clean. The apply path is now terminal-only: pending/loading `transactions.new` rows stay shadow-only; `settled` and `reversed` rows are selected until core transaction truth matches the normalized state. Existing transaction rows are updated when the terminal state, amount, sender, or canonical type differs. Reversed rows are represented as posted `refund` adjustments with negative gross/net mills, and comparison normalizes reversed amounts and state the same way. `new_subscription` maps to core `subscription` spend; `messages.ppv.unlocked` remains estimated-only and `tips.received` remains blocked pending a verified live money fixture.
- **Phase 3 — audience (D6/D8):** the `subscribers` stream gains an OnlyFans branch for OFAPI-mapped pages: a budgeted `fans/active` offset sweep (hard 20/page cap per the OpenAPI validation; `{data:{list,hasMore}}` unwrapped with a bare-array fallback) every `OFAPI_AUDIENCE_SWEEP_INTERVAL_MINUTES` (1440), checkpointed in `page_sync_cursors`, feeding the same `fans`/`page_fans`/`page_subscriptions` tables — `subscribedOnData` prices in dollars → mills, renew/ends from `expiredAt`, auto-renew = `status != "Set to Expire"`, tier null, no `*Summ` money (D8). End of sweep mirrors the Fansly generational expiry, guarded against an unexpectedly-empty first page and against contradictory pagination (empty page + `hasMore`), both refusing destructive finalization. The sweep has its own request cap and daily ceiling (`OFAPI_AUDIENCE_*`; ledger-attributed `ofapi_fans_active` spend when the ledger is on, global-counter fallback otherwise) plus the shared floor. Between sweeps, a post-settle `subscriptions.new/renewed` projection (same invariants and journal bookkeeping as the DM projection, stamped `pending` regardless of the flag) upserts the subscription forward-only — the webhook carries no dates, so the sweep owns renew/expiry. Stream plumbing mirrors the DM-polling gate (planner force-pause + request filter for non-eligible pages; the executor skips gracefully if a manual resume races a run in); the audience sync block lights up for eligible pages. **Load-bearing:** dependency evaluation became platform-aware — OnlyFans DM streams never depend on `subscribers`/`followers`/`top_spenders`, so a permanently-paused audience row can never dependency-block the decision-#49 DM sync (regression-tested).
- **Phase 4 — presence (D9):** `users.online`/`users.offline` journal rows project post-settle into the existing presence store (`page_fans.external_presence_*`) for known fans only — unknown ids are skipped, never fetched. `last_seen_online_at` carries the right value for both directions ("now" on online, the historical lastSeen on offline) and the store's `greatest()` semantics keep out-of-order events from regressing. The DM projection folds message-payload partner `lastSeen` into the same store in its existing journal pass (plan rec. 5), and the Phase 3 sweep contributes per-fan `lastSeen` — all under a new `ofapi_last_seen` source now in the workboard presence contract enum. `workboard-presence` gains a DB-read-only OnlyFans branch (refresh is a no-op, no platform credentials needed) for eligible pages; everything else keeps the verbatim Fansly-only rejection, and workboard v2 gates are untouched.
- **Phase 5 — top spenders (D10):** the `top_spenders` stream gains an OnlyFans branch computing rankings **from the existing transactions table** (zero OFAPI credits): the same month-window bootstrap + trailing-7-day steady state as Fansly, anchored on the earliest spender-relevant transaction, written into the same `page_fan_identities` store with `fan:{platformUserId}` identities; windows never split (a DB aggregate has no provider cap). The aggregation reuses the spenders-v2 transaction filter, so window sums reconcile with `fan_spend_daily`. `top_spenders` joins the OnlyFans financials block; the Top Supporters page needed no work — it reads the platform-agnostic spenders-v2 projections.

**Plan deltas:** (1) the balance ping cannot use `GET /accounts` — the OpenAPI spec shows it returns a bare array with **no `_meta`** — so it reads `chats?limit=1` on the first mapped page (same 1-credit cost, guaranteed balance anchor) and falls back to `listAccounts` defensively; (2) `fans/active` wraps the page as `{data: {list, hasMore}}` and hard-caps `limit` at 20 (prose says 50, validation wins) — the client maps both shapes; (3) the breakdown-by-operation/page tables ride the `credits/daily` route so the API surface stays at exactly three routes (D7); (4) the "rankings store the Fansly stream fills" is `page_fan_identities` — per-identity gross/net for the latest processed window, no rank column or top-N retention — and the Top Supporters page reads transactions-derived spenders v2, so the OnlyFans handler matches the store's real semantics and the acceptance check became reconciliation between the two; (5) the platform-aware `SYNC_STREAM_DEPENDENCIES` change wasn't in the plan but is required by its own invariants (above); (6) the DM stream's daily ceiling keeps decision #49's global-day-counter semantic ("keep the D4-style guard"), so with the ledger on, audience/admin spend counts toward it — audience's own ceiling (300) below the DM ceiling (500) preserves DM headroom, and the audience ceiling itself is ledger-attributed per D6; (7) live-verification caveats stand: `fans/active` renew/expire/"Set to Expire" semantics, the subscription webhook's `{PRICE}` formatted string, and OFAPI's real webhook-charging cadence are coded defensively and should be checked against live responses per plan §7 before trusting field-level numbers; (8) two stale tests were corrected in passing — the OnlyFans workboard 400 expectation that decision #49 had already obsoleted, and a dm-sync diverged-head test whose fixed fixture dates stopped qualifying once the wall clock passed them.

**Rationale:** The ledger turns the only authoritative signal (`_meta._credits.balance`) into a checkbook that fully decomposes spend into core/webhooks/external/refills without inventing price tables, while the day counter keeps budget checks cheap and the single client-side tap makes unaccounted spend structurally impossible. Audience, presence, and top spenders reuse the Fansly-built stores, blocks, and admin controls end to end — the only new read surface is the one owner credit page — and the webhook journal keeps doing the heavy lifting: subscriptions and presence ride events that are already paid for, the audience sweep costs ~20 credits per 400-fan page per day, and top spenders cost nothing at all.


## Mixed-Platform Revenue Windows: Disclose, Don't Align (2026-06-13)

**Decision #51:** The OnlyFans trailing revenue offsets (`ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS` in `packages/shared/src/time.ts`: `7d` spans 8 calendar days, `30d` spans 31 — one day longer than the defaults other platforms use) stay exactly as they are, and mixed-platform reports disclose the difference instead of aligning it away (audit B2). Every revenue report (`overview`, `model`, `page`) now carries a required `platformWindows` array with the exact `from`/`to` and comparison bounds each platform contributed; the top-level `from`/`to` remains the union (unchanged); and the dashboard Overview renders a footnote whenever a displayed total combines windows of different widths.

**Rationale:** The offset was introduced by `153bc96` ("Fix OnlyFans revenue rollups and resync recovery", 2026-03-09) with no recorded rationale — presumably to absorb vendor data lag — and has been in production math since. Changing the numbers now would silently shift every OnlyFans `7d`/`30d` total against history and against whatever operational expectation motivated the offset. Disclosure keeps the revenue math byte-for-byte identical while making the metadata and the UI honest: the response names each platform's real window, and the Overview says so wherever a mixed sum (and its vs-previous delta) is displayed.


## OFAPI DM Cold Archive (2026-06-19)

**Decision #52:** Core adds a separate forward-only cold DM archive, distinct from both the raw OFAPI webhook journal and the capped hot `page_dm_threads` / `page_dm_messages` operational store. The first implementation is gated by the default-off staged boot flag `OFAPI_DM_COLD_ARCHIVE_ENABLED` (`requires: OFAPI_DM_PROJECTION_ENABLED`) and writes only message-shaped future webhook deliveries (`messages.received`, `messages.sent`, `messages.deleted`) in the post-settle path. It deliberately has no historical bulk backfill and no separate archive sweep over retained journal rows.

- **Schema:** migration `0037_dm_message_archive.sql` creates `dm_message_archive`, keyed by `(platform, ofapi_account_id, platform_message_id)`, with page/account/chat/fan/message ids, sender role, text, integer-mill PPV/tip amounts, source event metadata (`source_idempotency_key`, `source_journal_id`, `source_fanout_seq`, `source_received_at`), normalized media metadata, tombstone `deleted_at`, retention metadata, and timestamps. There is no FK to `ofapi_webhook_events` because the journal is pruned after `OFAPI_EVENT_RETENTION_DAYS`; archive rows keep their own durable source metadata.
- **Forward-only behavior:** the archive hook runs from `processOfapiWebhookEvent` after the settle transaction commits, before/alongside the existing best-effort projections, and catches/logs failures without changing settle/fanout/projection state. Message replays are idempotent; a later message-shaped event may fill a prior tombstone's missing fields, but it never clears `deleted_at`. The existing DM projection sweep can still back-project the hot operational store, but it does not call the cold archive, so enabling this flag later does not bulk-archive retained historical journal rows.

- **Retry/status correction (2026-06-21):** cold archive attempts now mark the source journal row with `archive_status`, `archive_attempts`, `archive_error`, and `archived_at`. The post-settle attempt first marks `pending`, then records `archived`, `skipped`, or `failed`; the minutely OFAPI sweep retries `pending`/`failed` archive rows up to the archive attempt cap. Rows that settled while the archive flag was off remain `archive_status='none'`, so enabling the flag later still does not bulk-archive old retained journal rows. The owner status endpoint surfaces pending/failed archive counts, the latest archive error, and the retry cap.

- **Deleted-message retention:** `messages.deleted` is an archive tombstone, not a transcript erasure request. The governed archive may retain previously archived text and sanitized media metadata for the configured retention window, while every deleted message row must carry `deleted_at` explicitly and must never be resurrected by a later message-shaped replay.
- **Media and money:** cold storage stores stable media metadata only (`id`, type, readiness/locked state, dimensions/duration when present). It never stores signed/raw CDN URLs, media blobs, or full raw webhook payloads. Money uses integer mills, matching core transaction/revenue storage.
- **Governance surface:** `OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS` defaults to 3650 days; the existing OFAPI cleanup queue purges expired archive rows by `retain_until`. Owner-only `GET /api/v1/admin/ofapi/dm-archive/status` exposes the enabled flag, retention days, row/tombstone counts, last archived/source timestamps, archive lag, and policy markers: owner-only ACL, source-journal audit, daily retention purge, no raw transcript export endpoint yet, stable-media-metadata-only storage.

**Non-goals:** no historical bulk `GET /messages` backfill, no media download/storage, no raw transcript export API, no analytics dashboard scanning raw archive rows directly, and no desktop spend-sweep or polling cadence change. Historical import still needs explicit owner/admin acceptance of read-state risk, budget, retention, ACL, audit, purge/export, and backfill controls.


## OFAPI Sync Snapshot and Replay-Gap Recovery (2026-06-19)

**Decision #53:** The SSE fanout distinguishes an empty replay from a cursor that has fallen
behind journal retention. `GET /api/v1/events/stream` checks the durable fanout sequence
high-water and the oldest retained journal row before hijacking the response. A stale
`Last-Event-ID` receives HTTP `409 sync_snapshot_required`; a cursor ahead of the server receives
HTTP `400`. The sequence high-water is read from `ofapi_webhook_events_fanout_seq`, so gap
detection still works if every journal row has been pruned.

- **Snapshot endpoint:** chatter-key `GET /api/v1/events/snapshot` is scoped to one assigned OFAPI
  account and paginated by internal thread id. The first page captures `snapshotCursor` before
  reading projection state; later pages reuse that cursor. The client persists it only after every
  account/page is applied, then reconnects SSE from that cursor. Events settled after cursor
  capture are replayed normally, so concurrent snapshot reads cannot lose them.
- **State and coverage:** the snapshot contains current hot chat heads/messages, cold-archive
  deltas and tombstones after the requested cursor, current account-auth state, page/account
  coverage, source timestamps/sequences, and explicit omissions. Presence and typing are omitted
  as ephemeral state. `resumeAllowed=false` when either DM projection or the cold archive is
  disabled, preventing a partial durable snapshot from advancing the client cursor.
- **Bounded behavior:** no OFAPI request, historical message backfill, media download, or raw signed
  media URL is introduced. Thread pages are bounded (`limit<=50`); hot-message retention remains
  the existing 200/1000 per-thread policy, while archive rows are included only when they overlay
  the hot window or are deltas after the client's requested sequence.

**Rationale:** replay retention is an implementation bound, not a correctness policy. A silent
empty replay allowed a long-offline desktop to claim live freshness after skipping durable events.
The 409 plus snapshot/tail protocol makes the gap explicit while preserving page ACLs, idempotent
apply, and the existing polling fallback until desktop snapshot recovery is deployed.


## OFAPI Desktop Read Gateway (2026-06-19)

**Decision #54:** The first C6 custody slice is a default-off, read-only compatibility gateway at
`GET /api/v1/ofapi/read/*`, enabled by `OFAPI_DESKTOP_READ_GATEWAY_ENABLED` only when the OFAPI
credit ledger is enabled. The desktop's existing OFAPI client can use this prefix as its base URL:
account-scoped GET paths and JSON response shapes remain unchanged, while the desktop sends its
revocable chatter key to core instead of receiving the unscoped vendor key.

- **Fail-closed allowlist:** only the desktop's current reads are accepted: chats/messages/chat
  media, users/mass-list, transactions, fans, user lists, vault metadata/lists/items, and async
  upload status. Every path segment and query name/value is validated and bounded before an OFAPI
  request. There is no wildcard method proxy: POST/PUT/PATCH/DELETE, sends, unsends, likes,
  mark-read, typing, and uploads are absent.
- **ACL and account discovery:** `/accounts` is synthesized from the caller's current assigned
  OFAPI-mapped pages, and `/whoami` is a sanitized core identity. Account-scoped reads return 404
  unless the OFAPI account maps to an assigned page, avoiding account-existence disclosure.
- **Spend and retry ownership:** the existing core OFAPI client remains the only vendor network
  chokepoint and records every response under a bounded `ofapi_gateway_*` operation with page
  attribution. Known-free upload-status polls record zero credits. Gateway reads make exactly one
  upstream attempt and preserve response JSON, credit/rate headers, HTTP status, and Retry-After;
  the desktop remains the idempotent-read retry authority during migration. Core-wide pacing and a
  120 requests/minute gateway route limit bound request pressure.
- **Rollout boundary:** this slice does not switch desktop production, remove the local OFAPI key,
  or proxy any command. Direct desktop mode remains the rollback path until the command outbox,
  indeterminate write handling, media uploads, production SLO/runbook, and explicit desktop
  gateway switch are complete.

## OFAPI Command Outbox Contract (2026-06-19)

**Decision #55:** Core owns a versioned command outbox before it owns any desktop write. The first
slice is intake/read/cancel only behind `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED`; it cannot call OFAPI.
Vendor execution is a separate dependency-gated flag,
`OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED`, and is not enabled or implemented by the intake slice.
There is no generic path/method proxy.

- **Initial command:** `send_text_message_v1` only. The request carries
  `clientCommandId` (UUID), OFAPI `accountId`, numeric `conversationId`, non-blank text up to
  10,000 characters, and optional `retryOfCommandId`. Media, PPV, uploads, typing, mark-read,
  likes, unsend, and arbitrary vendor payloads are not accepted by this version.
- **API ownership:** chatter-key `POST /api/v1/ofapi/commands` creates or deduplicates a command;
  `GET /api/v1/ofapi/commands/{commandId}` reads one command owned by that chatter;
  `POST /api/v1/ofapi/commands/{commandId}/cancel` cancels only `queued` commands. Responses never
  echo message text. Account ids must map to a page currently assigned to the chatter.
- **States:** core persists `queued`, `in_flight`, `confirmed`, `failed_retryable`,
  `failed_terminal`, `indeterminate`, and `cancelled`. `draft/local_pending` remains desktop-local.
  Intake creates only `queued`; cancel transitions only `queued -> cancelled`. An executor may later
  claim `queued -> in_flight`, with at most one in-flight command per page/conversation lane.
- **Dedupe:** unique key `(page_id, chatter_user_id, client_command_id)` with a minimum 400-day
  retention horizon. Repeating the same canonical request returns the existing command with
  `deduplicated=true`; reusing the id with a different account, conversation, kind, retry lineage,
  or payload hash is `409 conflict`. Core never derives the id from message text.
- **Retry lineage:** retries are new commands with new client ids. `retryOfCommandId` must refer to a
  command owned by the same chatter on the same page/conversation and already in
  `failed_retryable`, `failed_terminal`, `indeterminate`, or `cancelled`. Core never auto-retries an
  `indeterminate` command.
- **Outcome rule:** any execution attempt that may have reached OFAPI becomes `indeterminate`
  unless a response or matching `messages.sent` event proves a terminal outcome. Definite
  pre-delivery failure may become `failed_retryable`; policy/validation rejection becomes
  `failed_terminal`; a vendor response or matched webhook confirms the command. Retry decisions
  remain human-visible and create a new command.
- **Audit/privacy:** the outbox stores the versioned payload for later execution, but read APIs,
  logs, diagnostics, and audit metadata expose only ids, state, payload hash, timestamps, attempt
  count, error code/class, and verifier result. Message text is never logged or returned by command
  status endpoints. The purge/export policy is defined in
  `docs/ofapi-command-outbox-contract.md`: terminal rows must eventually tombstone payload text
  while retaining non-text audit metadata, and owner/admin exports must exclude command text.
  Runtime purge now redacts old terminal payloads from the minutely command sweep; raw payload
  export remains out of scope.

**Rollback:** disabling command intake rejects new commands while retaining existing audit rows.
Disabling future execution parks queued commands and prevents new claims; it never changes a
previously `in_flight`/terminal record or makes desktop retry automatically.

**C6b1 implementation:** migration `0038_ofapi_command_outbox.sql`, the `ofapi_commands` repository,
strict core-owned contracts, and chatter-key create/read/cancel routes implement the non-executing
slice. `OFAPI_DESKTOP_COMMAND_OUTBOX_ENABLED` is default-off and requires the read gateway. The
schema enforces one in-flight row per page/conversation lane for the future executor, but this
slice has no code path that transitions to `in_flight` or calls OFAPI.

**Production rollout (2026-06-19):** revision `ea81511d92de` was first deployed with the staged
flag off and returned `503` to a real chatter-key create. After an audited version-1 staged
override and a second canonical deploy, both API and worker heartbeats reported read gateway and
command outbox enabled with no skipped overrides. A harmless command validated create/dedupe/
mismatch/unassigned/read/idempotent-cancel behavior, ended `cancelled` with zero attempts, created
no credit-ledger row, and leaked no payload text to responses or logs. No vendor send was attempted
or authorized. Executor rollout remains a separate decision requiring a controlled test fan.

## OFAPI Command Executor (2026-06-19)

**Decision #56:** Vendor execution is a separate default-off staged boot dependency,
`OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED`, requiring the command outbox. The worker may issue only
the versioned text-send command through the core OFAPI client, with global pacing, page-attributed
credit accounting, and exactly one HTTP attempt per durable row. Lost queue wakeups are recovered
by a minutely sweep; a stale `in_flight` row becomes `indeterminate`, never `queued`.

- A valid 2xx response carrying a message id confirms the command. Definite 4xx rejection is
  terminal; 429 is human-retryable; transport failures, timeout, 408, 5xx, and ambiguous/malformed
  success are indeterminate.
- No raw vendor error body or message text may enter logs, status responses, or verifier metadata.
- A settled `messages.sent` webhook may repair an in-flight/indeterminate outcome only for one
  unique account + conversation + normalized-text candidate inside a bounded attempt window.
  Ambiguous matches do nothing. The executor does not add a `GET /messages` verifier.
- Execution is deployed off first. Production enablement requires an explicitly controlled test
  fan, one harmless approved send, proof of one vendor/ledger attempt, response/webhook
  confirmation, and rollback proof. Desktop writes do not switch before that gate.

**C6b2 implementation:** migration `0039_ofapi_command_execution.sql` adds attempt timestamps,
queued/verifier indexes, and an at-most-one-attempt constraint. The API enqueues only after durable
insert; zero-retry pg-boss execution plus a minutely recovery sweep drive the worker. The core
OFAPI client now has one typed text-send method with global pacing and page-attributed ledger
reporting. Status responses expose attempt timestamps, and settled `messages.sent` events run the
unique-match verifier as a best-effort post-settle step. The execution flag remains default-off;
implementation does not authorize a production send.

**Default-off production rollout (2026-06-19):** revision `47a36525e653` was deployed and verified
with API/worker healthy. Migration `0039` and the new schema columns/constraint are present.
Runtime heartbeats reported outbox enabled, execution disabled, and no skipped overrides. A real
chatter-key command validated create/read/cancel while staying `attempt_count=0`; no execute job,
`ofapi_command_send_text` ledger row, payload-text log, or vendor send was observed.
Non-live recovery UX and payload purge/export policy are now defined in the command contract; the
runtime payload purge is implemented; desktop transport UI and controlled live send remain pending.

**Payload redaction rollout (2026-06-19):** revision `bbd42e844f36` deployed migration `0041`
and the minutely sweep redaction path with execution still disabled. Production validation proved
the new column/index, active API/worker flags (`outbox=true`, `execution=false`), zero command-send
ledger rows, zero old terminal unredacted production rows, and a rollback-only redaction smoke that
left no synthetic row behind.

## OFAPI Typing Command Custody (2026-06-20)

**Decision #58:** The first non-text desktop write centralized after text sends is the advisory
typing beacon. It extends the existing command outbox instead of adding a generic write proxy.

- **Command kind:** `typing_active_v1`, with the same `clientCommandId`, account, conversation,
  page/chatter ACL, and one-attempt executor as text commands. Payload is exactly `{}`. Unlike
  business commands, typing has a two-minute dedupe horizon; terminal rows are deleted after that
  horizon and it never emits a permanent `command_result` observation.
- **No retry/recovery:** typing is lossy and cosmetic. `retryOfCommandId` is rejected, desktop does
  not need status recovery UI for a missed beacon, and re-sending typing later is a fresh command.
  A queued beacon older than ten seconds is unclaimable and expires rather than appearing late.
- **Vendor request:** one `POST /api/{accountId}/chats/{conversationId}/typing` through the core
  OFAPI client, with global pacing, bounded timeout, no body, and no automatic retry.
- **Accounting:** the endpoint is documented free, so a successful response without `_meta` records
  no permanent credit-ledger row. Provider `_meta._credits.used` still wins if returned, and any
  unexpected non-zero charge is recorded under operation `ofapi_command_typing_active`.
- **Verifier/privacy:** `messages.sent` webhook repair applies only to `send_text_message_v1`.
  Typing rows confirm only from the endpoint response, keep `platform_message_id=null`, and expose
  only non-payload audit fields.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new typing claims
  just like text commands. Desktop Direct write transport remains the rollback path until all write
  kinds are centralized and production-soaked.

**Production validation:** revision `405fe9e41bff` deployed through the canonical dist-only path
with migration `0043_ofapi_command_typing_active.sql` applied. The owner-only route
`lora-vip-of` to the `loravie` conversation `518588958` created command
`729fb32c-c313-4481-9c7c-c64963ec8df3`, which reached `confirmed` after one vendor attempt,
kept payload `{}`, kept `platform_message_id=null`, and wrote one `ofapi_credit_ledger` row under
`ofapi_command_typing_active` with HTTP 200, zero credits, and `estimated=false`. Bounded log/API
checks contained only command/page/kind/outcome metadata. The rollback drill staged execution
`false`, recreated API/worker, proved command `e2d9024f-84e7-44df-a8e4-cd768d58ee49` stayed
queued with zero attempts and no new ledger row, cancelled it, then restored execution `true`.
Final API/worker heartbeats reported outbox `true`, execution `true`, AI gateway `true`, and zero
skipped overrides. The temporary validation key was revoked and its page assignment removed.

## OFAPI Unsend Command Custody (2026-06-20)

**Decision #59:** The next safe non-text write centralized after typing is unsend for already-sent
creator messages. It extends the existing command outbox instead of adding a wildcard DELETE proxy.

- **Command kind:** `unsend_message_v1`, with the same `clientCommandId`, account, conversation,
  page/chatter ACL, durable dedupe, and one-attempt executor as other command kinds. Payload is
  exactly `{ "messageId": "<numeric OnlyFans message id>" }`.
- **No retry/recovery:** unsend is destructive and a second DELETE after an ambiguous first attempt
  can produce a different platform result. `retryOfCommandId` is rejected; any second unsend is a
  visible human action after checking the conversation state.
- **Vendor request:** one
  `DELETE /api/{accountId}/chats/{conversationId}/messages/{messageId}` through the core OFAPI
  client, with global pacing, bounded timeout, no body, and no automatic retry.
- **Accounting:** operation `ofapi_command_unsend_message` records page-attributed OFAPI credit
  observations from `_meta`; a successful response without `_meta` falls back to the normal
  one-credit estimated REST assumption.
- **Verifier/privacy:** text/webhook matching applies only to `send_text_message_v1`. Unsend rows
  confirm only from the DELETE response in this slice; `messages.deleted` remains the downstream
  projection/tombstone evidence. APIs and logs can include command id, page id, command kind, and
  target platform message id, but never message text or media URLs.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new unsend claims.
  Desktop Direct write transport remains the rollback path until all write kinds are centralized
  and production-soaked.

**Production validation:** revision `8d75e4f94d93` deployed through the canonical dist-only path
with migration `0044_ofapi_command_unsend_message.sql` applied. The owner-only route
`lora-vip-of` to the `loravie` conversation `518588958` first created a fresh owner-owned text
message (`c6f73e57-8b51-4c13-aef7-6ced300390f5`, platform id `10090438628342`), then created
unsend command `21cd8d41-8383-40b2-8418-7ca01067ea85`. The unsend command reached `confirmed`
after one vendor attempt, kept payload `{"messageId":"10090438628342"}`, recorded
`platform_message_id=10090438628342`, and wrote one `ofapi_credit_ledger` row under
`ofapi_command_unsend_message` with HTTP 200, one credit, and `estimated=false`. Webhook journal
rows for the target message included projected `messages.sent`, `messages.received`, and paired
`messages.deleted` events. Bounded log/API checks contained no text canary, payload, media URL, or
signed CDN fields. The rollback drill staged execution `false`, recreated API/worker, proved
command `358ad76c-3670-494a-800f-b99fe35b5474` stayed queued with zero attempts and no new ledger
row, cancelled it, then restored execution `true`. Final heartbeats reported outbox `true`,
execution `true`, AI gateway `true`, and zero skipped overrides. The temporary validation key was
revoked and its page assignment removed.

## OFAPI Mark-Read Command Custody (2026-06-20)

**Decision #60:** The next safe command after unsend is explicit chat mark-read. It has no
message text/media payload, but it still mutates OnlyFans read state, so it extends the existing
command outbox instead of adding a generic write proxy.

- **Command kind:** `mark_chat_read_v1`, with the same `clientCommandId`, account, conversation,
  page/chatter ACL, durable dedupe, and one-attempt executor as other command kinds. Payload is
  exactly `{}`.
- **No retry/recovery:** mark-read is a state mutation. `retryOfCommandId` is rejected; any later
  mark-read is a fresh explicit action from the desktop open/read workflow.
- **Vendor request:** one `POST /api/{accountId}/chats/{conversationId}/mark-as-read` through the
  core OFAPI client, with global pacing, bounded timeout, no body, and no automatic retry.
- **Accounting:** operation `ofapi_command_mark_chat_read` records page-attributed OFAPI credit
  observations from `_meta`; a successful response without `_meta` falls back to the normal
  one-credit estimated REST assumption.
- **Verifier/privacy:** webhook text matching applies only to `send_text_message_v1`. Mark-read rows
  confirm only from the POST response in this slice. APIs and logs can include command id, page id,
  and command kind, but never message text, media URLs, or arbitrary vendor response fields.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new mark-read claims.
  Desktop Direct write transport remains the rollback path until all write kinds are centralized
  and production-soaked.

**Production validation:** revision `8fb9a9bc8393` deployed through the canonical dist-only path
with migration `0045_ofapi_command_mark_chat_read.sql` applied. The owner-only route
`lora-vip-of` to the `loravie` conversation `518588958` created mark-read command
`be5c38b9-2697-4bc1-81de-957ec8db2368`. The command reached `confirmed` after one vendor
attempt, kept payload `{}`, kept `platform_message_id=null`, and wrote one `ofapi_credit_ledger`
row under `ofapi_command_mark_chat_read` with HTTP 200, one credit, `estimated=false`, and
`attemptNumber=1`. Bounded worker log checks contained command/page/kind metadata only and no
payload, text, media URL, signed CDN field, or conversation/account text. The rollback drill staged
execution `false`, recreated API/worker, proved command
`4bbd0943-5e56-4500-9125-38928b89ebd9` stayed queued with zero attempts and no new ledger row,
cancelled it, then restored execution `true`. Final heartbeats reported outbox `true`, execution
`true`, AI gateway `true`, and zero skipped overrides. The temporary validation key was revoked and
its page assignment removed.

**Decision #61:** The next safe send-write slice after text/typing/unsend/mark-read is
media/PPV message send using already-existing OFAPI media identifiers. It does not centralize
desktop local file upload. Upload still requires a separate file-byte, storage, MIME, and audit
design.

- **Command kind:** `send_media_message_v1`, with the same `clientCommandId`, account,
  conversation, page/chatter ACL, durable dedupe, one-attempt executor, and same-kind retry lineage
  as text commands.
- **Payload:** `text` may be empty; `price` is `0` or an integer from `3` through `200`;
  `mediaFiles` is a non-empty bounded array of numeric vault IDs or `ofapi_media_*` IDs; `previews`
  is a bounded subset of `mediaFiles`. Payload rejects URLs, file bytes, arbitrary vendor paths,
  reply-to fields, and unknown fields.
- **Vendor request:** one `POST /api/{accountId}/chats/{conversationId}/messages` through the core
  OFAPI client. Core maps numeric vault IDs to numbers, preserves `ofapi_media_*` strings, omits
  empty `previews`, and derives `lockedText=true` only when `price > 0` and caption text is
  non-blank.
- **Retry/recovery:** retry is allowed only from an owned terminal/indeterminate media command in
  the same lane. A retry is a new command row and never a second attempt on the same row.
- **Accounting:** operation `ofapi_command_send_media` records page-attributed OFAPI credit
  observations from `_meta`; missing `_meta` follows the existing one-credit estimated REST
  fallback.
- **Verifier/privacy:** a `messages.sent` webhook may repair an in-flight/indeterminate media
  command only when account, conversation, normalized caption text, price, media count, time
  window, and uniqueness all match. APIs/logs may include command id, page id, kind, and platform
  message id, but never payload text, media IDs, media URLs, file names, or arbitrary vendor body
  fields.
- **Rollback:** staging `OFAPI_DESKTOP_COMMAND_EXECUTION_ENABLED=false` prevents new media command
  claims. Desktop Direct write transport remains the rollback path until upload and any other
  remaining write kinds are centralized and production-soaked.

**Production validation:** revision `2dbb5f407c52` deployed through the canonical dist-only path
with migration `0046_ofapi_command_send_media_message.sql` applied at
`2026-06-20 05:02:06.041099+00`; API and worker image labels matched the revision and dependency
checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`. The owner-only route
was `lora-vip-of` page 9 to `loravie` conversation `518588958`. A governed archive lookup found an
existing owner media id without URLs. Free media command `8360d753-3c2a-420d-9621-6221e1d65cf0`
confirmed after one attempt, `price=0`, `media_count=1`, `preview_count=0`, and platform message id
`10091143135310`. Ledger row `20` recorded `ofapi_command_send_media`, page 9, HTTP 200, one
credit, `estimated=false`, and `attemptNumber=1`. Cleanup used already validated unsend command
`c4a8ef8d-8ab7-4f7a-ac90-225bde2ce746`; ledger row `21` recorded the DELETE and webhooks
`16680`-`16683` projected sent/received/deleted evidence for platform message id `10091143135310`.
API/worker log checks over the validation window found no caption canary, media id, `mediaFiles`,
`mediaUrl`, signed/CDN/download URL, or filename fields. The rollback drill staged execution
`false` at config version 10, recreated API/worker, proved media command
`756d2124-4d23-4ad6-9367-ddd5709f97dc` stayed queued with `attempt_count=0` and no new media ledger
row, cancelled it, then restored execution `true` at version 11. Final heartbeats reported outbox
`true`, execution `true`, AI gateway `true`, zero skipped overrides, and zero nonterminal commands.
The temporary validation key was revoked and its page assignment removed; the validation user has
zero active keys and no assigned pages.

## ChatMuse AI Gateway Contract (2026-06-19)

**Decision #26 update:** The first ChatMuse AI gateway slice is a default-off, chatter-key,
SSE-streaming provider gateway. Desktop continues to build prompt blocks and parse/render results;
core takes custody of provider keys, chatter/page authorization, quota decisions, provider network,
and the durable cost ledger. This is a prompt-streaming v1, not yet a core-owned transcript/context
builder.

- **Wire contract:** `docs/ai-gateway-contract.md` defines the planned
  `POST /api/v1/ai/gateway/stream` request and SSE frame shapes. The exported zod schemas live in
  `packages/contracts/src/routes.ts` as `aiGateway*` contracts before any runtime route is added.
- **Feature compatibility:** gateway `feature` uses the existing `ai_usage_feature` closed enum:
  `fast-reply`, `improve-draft`, `help-me`, `fan-summary`, `chat-review`, `scan`, `ping`, and
  `hi-greeting`. Desktop-only `compare` stays local orchestration and maps to the underlying
  feature operations.
- **Ledger/quotas:** runtime implementation must reserve quota before provider network and record
  one terminal ledger row keyed by `(userId, clientRequestId)` with page, feature, model, provider,
  provider response id, tokens, integer micro-USD cost, cache markers, quota decision, and outcome.
- **Privacy:** raw prompt text, transcript text, generated reply text, and raw provider error bodies
  may stream through runtime but must not be persisted in logs, diagnostics, audit, or the ledger.
- **Rollback:** local desktop provider keys remain supported until the gateway is deployed,
  production-validated, and disabling the gateway flag demonstrably restores direct mode.

**R4b runtime gate:** `CHATMUSE_AI_GATEWAY_ENABLED` is now a default-off, staged boot-applied flag
and `POST /api/v1/ai/gateway/stream` exists as a chatter-key route. With the flag off it returns
`503` before page lookup, quota reservation, provider network, or ledger writes. With the flag on,
it verifies page assignment/platform and still returns `503` before provider execution until the
next runtime slices add Anthropic streaming, quota reservation, and durable ledger rows.

**R4c ledger storage:** migration `0040_ai_gateway_usage_ledger.sql` extends
`ai_usage_events` with nullable gateway metadata (`page_id`, provider/provider response id,
micro-USD cost, approximate-cost marker, quota decision, and terminal gateway outcome) while
preserving the existing `(user_id, client_event_id)` idempotency key. Direct desktop
`/api/v1/ai-usage/batch` events continue to store default cost `0` and null gateway fields.
Runtime provider execution and quota enforcement remain pending and default-off.

**R4d quota preflight:** the gateway now checks ledger-backed UTC-day usage per
`(chatter_user_id, page_id)` before provider execution. `CHATMUSE_AI_GATEWAY_DAILY_REQUEST_LIMIT`
defaults to `200` and `CHATMUSE_AI_GATEWAY_DAILY_MICRO_USD_LIMIT` defaults to `5000000` ($5.00);
either set to `0` blocks provider attempts. Over-quota requests return `429 rate_limit_exceeded`
before Anthropic/OpenRouter network and before any new ledger write. Atomic provider-attempt
reservation/finalization remains part of the provider execution slice.

**R4e pricing utility:** the gateway has a pure Anthropic pricing helper for terminal ledger rows.
It prices the desktop-supported `anthropic:*` ChatMuse models in integer micro-USD, includes
prompt-cache read/write rates, marks aggregate cache-write usage approximate when the provider does
not supply a 5m/1h breakdown, and rejects unsupported models instead of silently underpricing them.
The helper is not yet wired to a live provider call; it is the cost basis for the upcoming terminal
usage row.

**R4f Anthropic adapter groundwork:** core can now build an Anthropic Messages streaming request
from the gateway body without calling the provider. The builder mirrors desktop direct-mode tuning:
`5m` prompt-cache blocks use provider-default ephemeral cache markers, `1h` blocks are explicit,
adaptive thinking omits temperature, `claude-opus-4-8` omits sampling parameters, and usage is
normalized into the terminal ledger cost shape. This is still default-off groundwork; runtime route
fanout, cancellation, atomic reservation/finalization, and production validation remain pending.

**R4g SSE provider seam:** `POST /api/v1/ai/gateway/stream` can now emit `event: ai` SSE frames
from an injected provider after chatter-key auth, page authorization, and quota preflight. The
production app context intentionally does not create a provider yet, so the route remains
fail-closed with `503` before external provider network. Provider failures become bounded error
frames with no prompt/provider-body echo; terminal usage ledger writes remain pending until the
real provider execution and quota reservation/finalization slice.

**R4h terminal ledger finalization:** provider-seam streams now write one terminal gateway ledger
row for completed, failed, or cancelled attempts. The row stores page, provider, provider response
id when observed, usage/cost, quota decision, cache-hit marker, regeneration marker, duration, and
gateway outcome without prompt or response text. Existing `(user_id, client_event_id)` idempotency
dedupes repeated terminal writes, but duplicate provider-attempt prevention still needs an atomic
reservation slice before live provider execution is production-ready.

**R4i atomic reservation:** the gateway now reserves `(user_id, client_event_id)` in
`ai_usage_events` before provider execution. A duplicate `clientRequestId` returns `409 conflict`
before provider execution and cannot start a second paid call. Terminal handling updates the same
row.

**R4j Anthropic provider execution:** core now has a real Anthropic Messages streaming adapter
behind the default-off gateway. It is instantiated only when `CHATMUSE_AI_GATEWAY_ENABLED=true` and
`ANTHROPIC_API_KEY` is configured, maps provider text/thinking/usage events into gateway frames,
uses the same abort signal as the SSE route, and relies on the R4i reservation plus R4h finalizer
for ledger state. Direct-host production validation was blocked by provider egress policy; the
proxy-routed R4m path below is the validated production route.

**R4k stale reservation recovery:** before quota preflight on an authorized gateway request, core
marks null-outcome gateway reservations older than 30 minutes as terminal `failed` rows with
zero token/cost counts and a nonnegative duration. `completed_at` remains the original reservation
time so quota and audit attribution stay on the acceptance day. Recovery logs only the recovered
row count and stale threshold; prompt text, generated text, and provider bodies remain excluded.

**Default-off production rollout (2026-06-19):** revision `bf249a4c33c0` is deployed to production
with the AI gateway still disabled. API and worker image labels match
`agency-hub.source-revision=bf249a4c33c0`; both containers are healthy, the gateway ledger columns
exist, and production has `0` gateway ledger rows / `0` stale open reservations. Latest api/worker
heartbeats show `chatMuseAiGatewayEnabled=false`, `anthropicApiKey=unset`, request cap `200`,
micro-USD cap `5000000`, `ofapiDesktopCommandExecutionEnabled=false`, and `skippedOverrides=0`.
Live provider validation remains blocked on an approved small prompt and must not send a platform
message.

**R4l owner usage reporting:** owner `GET /api/v1/admin/usage/chatters` and the dashboard Usage
page now surface gateway ledger cost/outcome metadata: per-chatter micro-USD cost, approximate-cost
marker, gateway request/outcome/open-reservation counts, provider cost breakdown, and per-feature
cost fields. The report remains metadata-only and does not expose prompts, generated replies, or
raw provider bodies.

**R4m proxy-routed Anthropic provider execution:** production Anthropic calls no longer use the
server host IP. After chatter/page authorization, the gateway resolves the page's stored
`egress_endpoints` proxy and passes an undici dispatcher-backed fetch to the Anthropic SDK for that
request. Missing page proxy returns `503` before quota reservation, ledger insertion, or provider
network, so there is no direct-host fallback. Production validation proved SSE streaming, terminal
ledger metadata, prompt/output log redaction, and staged flag rollback; desktop Hub AI still needs a
separate desktop rollout/default decision.

**R4l production rollout (2026-06-19):** revision `736d37c66549` is deployed default-off. API and
worker labels match the revision, health checks pass, latest heartbeats still show
`chatMuseAiGatewayEnabled=false` and `anthropicApiKey=unset`, and production reporting code
successfully returned the new cost/gateway fields against real data (`rowCount=5`, `activeRows=2`,
`totalGatewayRequests=0`, `openReservations=0`).

**2026-06-20 live validation outcome:** the configured Anthropic key and
`claude-sonnet-4-6` model returned 200 from the operator workstation, but the same non-generating
models probe from the production API container returned `403 Request not allowed`. One controlled
gateway request therefore finalized as `failed` with zero tokens/cost and bounded metadata only.
The production key and staged gateway flag were rolled back; desktop Direct AI remains active. The
next validation path is the R4m proxy-routed gateway, not direct production-host egress.

**2026-06-20 proxy-routed validation outcome:** revision `1ff3ebc42d55` was deployed and API/worker
labels matched the source revision. The controlled page `lora-vip-of` was bound to an existing
stored proxy route; runtime proxy diagnostics showed proxy exit IP `171.22.220.242` versus direct
host IP `45.8.230.111`. With `chatMuseAiGatewayEnabled=true`, one owner-scoped non-mutating SSE
request (`8f6d988c-86bd-48dd-b8c8-7370dd7970a8`) completed with frame counts `meta=1`,
`content_delta=2`, `usage=1`, `done=1`, `error=0`. Its ledger row recorded provider `anthropic`,
model `anthropic:claude-sonnet-4-6`, outcome `completed`, provider response id present, `39` input
tokens, `19` output tokens, `402` micro-USD, quota accepted, and page `lora-vip-of`; schema/log
checks showed no prompt or generated text persisted. The staged rollback drill set gateway `false`
and a valid request returned `503` with zero ledger rows, then gateway was restored to staged
`true`. Final heartbeats show read gateway `true`, command execution `true`, AI gateway `true`, and
zero skipped overrides. The temporary validation chatter key was revoked after the test.

## DM Aggregate Analytics Groundwork (2026-06-20)

**Decision #57:** analytics starts with a replaceable aggregate-only table over the governed,
forward-only cold archive. Migration `0042_dm_message_daily_aggregates.sql` adds one row per
page/UTC day with inbound/outbound/deleted counts, distinct conversation count, paid outbound and
tip counts/mills, message time bounds, and source fanout high-water. It stores no transcript text,
media metadata/URLs, or fan identifiers.

An exclusive `ofapi.dm-analytics.rebuild` worker rebuilds the latest 32 UTC days hourly. Rebuild is
delete-and-replace inside one transaction, so webhook replay and tombstone changes converge without
double counting. The table is disposable derived state; rollback pauses the schedule and leaves
the archive untouched.

This is groundwork, not permission to infer unsupported metrics. Response-time pairing, PPV
unlock funnels, revenue attribution windows, and AI-generation-to-send linkage require explicit
identity contracts before implementation. Historical DM `GET /messages` backfill remains out of
scope.

**Production rollout:** revision `1d7be970bbd1` deployed through the canonical dist-only process
with matching API/worker image labels and dependency checksum. Migration 0042 is applied and the
exclusive queue exists. A one-off production rebuild wrote 5 aggregate rows from 779 archive rows
(`355` inbound, `417` outbound, `7` deleted, `4` paid outbound); aggregate privacy-column count was
zero and cold archive media URL leakage count was zero. Webhook pending returned to zero after the
deploy and command nonterminal rows remained zero.

## Fansly Server-Replay Gate — Pass 3 Stage 6 (2026-07-04)

**Decision #62:** Kernel-only Fansly capture (DP 1-B) is unblocked for the two endpoint
families only the extension called: per-fan earnings stats (`/account/wallets/earnings/stats/accounts`),
monthly earnings stats (`.../monthlystats/accounts`), and PPV order history (`/media/orderhistory`).
The day-1 live probe proves core can replay all three server-side with the **single pasted
`fansly-client-check`** — the per-route anti-bot token the extension harvests per route is NOT
required for these families. The `routeChecks` per-route-bundle contingency in the Stage 6 spec
stays unbuilt.

**Evidence (day-1, 2026-07-04):** `fansly:replay-probe --page lilly-1 --page lilly-2 --calls 1`
run read-only from a one-off container off the production image (bind-mounted patched `cli.js`,
page egress + DB-backed pacing; running api/worker never restarted). Per family, both pages:

| Family | lilly-1 | lilly-2 | verdict |
|---|---|---|---|
| earnings/stats/accounts | 200 success | 200 success | replayable |
| earnings/monthlystats/accounts | 200 success | 200 success | replayable |
| media/orderhistory | 400 code 99 | 400 code 99 | replayable — the 400 is a param error on the bare probe (no `accountMediaId`), NOT a 401/403 auth rejection; the session validated server-side |

**Zero auth rejections on either page.** Confirms owner Q2 ("токен не нужен, это безопасно").

**Still open:** the ≥5-day check-longevity re-probe (run once/day; measures whether the pasted
check rots on these routes faster than on core's live routes). Day-1 replayability is sufficient
for the Stage 16 go/no-go; the longevity number feeds the cadence/degradation design.

## Kernel Retention & Redaction Stand-Down — Pass 3 Stage 1 (2026-07-05)

**Decision #63:** The kernel no longer schedules deletion of its own business facts. One
stage branch (`kernel/stage-01-retention-redaction-standdown`, five checkpoint commits)
delivers, effective the next deploy:

- **Retention raised to effectively-forever (36500 d)** for the OFAPI webhook journal,
  the DM cold archive, and sync raw payloads — env *and* code defaults both change, so a
  missing env can never re-enable a short purge. `retentionDate()`/`dmRetentionDate()`
  now stamp far-future; the cleanup jobs stay in place as no-ops.
- **Kill-switches (default OFF):** `PAGE_DM_PRUNE_ENABLED` gates the per-conversation
  `page_dm_messages` prune at all four call sites (two sync finalizes, OFAPI DM sync
  finalize, projection live-ingest refresh); `OFAPI_COMMAND_PAYLOAD_REDACTION_ENABLED`
  gates the terminal-payload self-redaction inside `sweepOfapiCommands` (at the redaction
  call, which runs before the execution-enabled check). Registry rows added (env-only,
  `NEVER`/`none`); the two retention knobs' registry defaults/labels now tell the truth.
- **DM-message raw persistence (new capture, flagged per spec §7.5):** all three
  DM-message fetch paths persist raw pages with `payload_kind='dm_messages'`
  (OnlyMonster + Fansly persist `page.raw`; the OFAPI client exposes no raw envelope, so
  that path persists the unfiltered item records). Union-only type change; the DB column
  is free text.
- **Consumed-only purge guard:** `deleteExpiredOfapiWebhookEvents` refuses rows whose
  `projection_status`/`archive_status` is `pending`/`failed` regardless of age.
- **Disk-usage alert:** hourly worker cron (`db.disk-usage.check`, :15 UTC) compares
  `statfs("/")` usage against `DISK_USAGE_ALERT_PERCENT` (default 80) and pages the owner
  through the existing Telegram incident layer (`db_disk_usage` kind, one alert per state
  change; Postgres size included as context).

**Deviation from the spec:** §3 declared "no schema change", but §2's "reuse the existing
alert-monitor pattern" requires the incident-kind enum value — **migration 0052**
(`ALTER TYPE notification_incident_kind ADD VALUE IF NOT EXISTS 'db_disk_usage'`),
additive-only, same pattern as migrations 0030/0031. Rollback story unchanged (an unused
enum value is inert; everything else is env/flag-guarded).

**Verification (local):** `pnpm typecheck` clean; full `pnpm test` suite green —
**166 files, 1398/1398** (Testcontainers applied migration 0052). Behavior-change tests:
prune no-op over a >cap conversation, redaction-off leaves >7 d terminal payloads intact,
purge guard deletes old consumed / refuses old unconsumed, DM sync chunk writes
`dm_messages` raw rows, disk alert opens/resolves on threshold crossings. One existing
test updated to the new truth: the OFAPI backfill-cap test now expects 201 stored
messages (fetch-side window cap still bounds the backfill; finalize no longer prunes).

**Prod exit (§3.8) pending owner deploy:** env `OFAPI_EVENT_RETENTION_DAYS=36500` +
`OFAPI_DM_COLD_ARCHIVE_RETENTION_DAYS=36500` in `/opt/agency-hub/.env.production`,
standard deploy (ships 0052), optional idempotent re-stamp of pre-deploy
`sync_raw_payloads.retain_until`, then the §5 V1–V5 checks (exact SQL in the stage
file's `## Progress` block). **Risk carried forward:** fact tables now grow without
bound by design — the disk alert is the containment; retention tiering returns as a
safe cache policy in Stage 28. No off-box backup (Q3) unchanged and now covers strictly
more data.

## Pass 3 Spec Fixup — pre-execution review findings (2026-07-05)

**Decision #64:** An owner-run architecture review of the Pass 3 stage corpus (three
subagents + spot verification against code) surfaced spec defects that would trip a
blind executing session. Verified against the cited files and applied as doc-only
amendments to `docs/project-kernel/pass3/` (roadmap §4 passports, §5 table + tracks,
and the affected stage headers/sections; this entry committed on branch
`kernel/pass3-spec-fixup` — the kernel docs themselves live outside version control):

- **Stage 7/8 key-table insert protocols** were unimplementable as written (key row
  inserted first while `observation_keys.observation_id` / `domain_event_keys.event_id`
  are NOT NULL and the identity id does not exist yet). Fixed: pre-allocate the id via
  `nextval(pg_get_serial_sequence(…))`, the key insert carries it, the journal/event
  row inserts with `OVERRIDING SYSTEM VALUE`. No rollback branch — the protocol stays
  composable inside the webhook receiver's transaction.
- **Dependency graph tightened:** 31 and 32 gain hard dep 11 (their entry criteria
  already required the capture lane); 33 gains hard dep 20 (dashboard-on-SDK is its
  substrate); 26 gains soft 19 (ESLint config); 28 ↔ 29 gain mutual soft deps (28's
  acceptance-rate metric needs 29's class; 29's content tables rely on 28's lake
  exclusion + erasure reach).
- **Stage 20 method/path source fixed:** `routeSchemas` carries neither; the generator
  recovers `{method, path}` by booting `buildApiServer` and joining registered routes
  to registry keys by schema-object identity (the proven `generate.ts` pattern), with a
  both-ways reconciliation assertion; explicit registry fields stay the fallback.
- **Sensitive kinds excluded from the generic lake:** Stage 28's exporter exclusion
  list gains a kind granularity (initially `desktop.guard_audit`); excluded kinds
  export to `lake/restricted/…` (same manifest/verify discipline, restricted access)
  so DETACH still loses nothing. Stage 11 records the kind on that list.

**Reviewed and declined** (recorded so they are not re-litigated): splitting Stage 29
into provider/budgets vs content capture — the mutual soft deps suffice; a
`sensitivity_class` substrate before Stage 7 — DP 6-A full-content capture is an
accepted owner decision and kind-level lake exclusion covers the gap; reordering 22
before 11 — it would stall the capture track, and the lane's rate limit, body cap, and
kind allowlist stand (a per-principal volume alert on `desktop.unknown:*` is noted as
cheap hardening at execution time); resizing Stage 23 — its spec already carries the
claim-lease schema, attribution, compensating-event undo, and v1-route removal the
review believed missing.

## Kernel Destruction-Door Guards + Chatter-Read-Scope — Pass 3 Stage 2 (2026-07-05)

**Decision #65:** The two classes of one-action data loss are closed, on branch
`kernel/stage-02-destruction-doors` (based on the `kernel/pass3-spec-fixup` tip so this log
stays linear; five checkpoint commits + one test-fixup commit):

- **Chatter-read-scope gate.** The four raw revenue/transaction routes (page revenue,
  transactions, revenue/daily, per-fan transactions) now require a dashboard session role
  (owner/team_lead) via `enforceRevenueRouteRoleScope`, layered after the existing
  `canAccessPage` page scope. `REVENUE_ROUTE_ROLE_ENFORCEMENT` starts in `log`
  (serve + `would-deny` log, the 48 h observation window) and flips to `enforce` (403) by env.
  The chatter-facing spenders board is untouched (regression-tested). **Entry criterion
  verified in client code, not assumed:** desktop calls core only for `/api/v1/pages`, fan
  profiles, and OFAPI read lanes; the extension calls pages/profiles/`ai-usage/batch` and
  builds its spenders board against Fansly directly — neither touches the gated routes.
- **Reset door.** `resetSyncBlock` refuses `messages_history` with 409 before touching any
  state (it would hard-delete every stored DM for the page); it returns with the Stage 10
  archive. Checkpoint (`audience`) and top-spender (`financials`) resets stay available.
- **Page-delete door.** Admin page DELETE refuses 409 while the page holds transactions or
  DM history (`getPageBusinessFactPresence` handler check; the 38 CASCADE FKs are Stage 13's
  RESTRICT flip). Empty pages still delete. `pages.deleted_at` lands as unwritten substrate
  for Stage 13.
- **Workboard undo/reclassify.** `deleteLastWorkboardContact` → `retractLastWorkboardContact`
  (marks `retracted_at`; both contact-log readers exclude retracted rows).
  `clearClosingCacheForPage` → `supersedeClosingCacheForPage` (marks `superseded_at`;
  verdicts become an append log; all five closing-cache joins and three scans read active
  rows only).

**Deviation from the spec (§3):** the spec's migration sketch was ADD-COLUMN-only, but its §2
supersede design ("keep prior verdicts … let the new run write fresh rows") is impossible
under the existing full `UNIQUE (platform_account_id, platform_message_id)` on
`wb_closing_cache` with an upsert writer. **Migration 0053** therefore also converts that
unique into a **partial unique index on active rows** (`WHERE superseded_at IS NULL`), and
the upsert targets it via `targetWhere`. Additive-safe: existing rows are all active; no
rewrite; rollback keeps the columns harmlessly.

**Verification (local):** `pnpm typecheck` clean; full `pnpm test` **166 files, 1402/1402**
(Testcontainers applied migration 0053; schema-guard green). New tests: 4-route gate in
log/enforce + owner-session + spenders regression; reset 409 + audience/financials resets
still 200; fact-bearing delete 409 / empty delete 200; undo retraction with reader
exclusion; supersede + fresh-run reinsert with reads returning only the active verdict. Two
existing tests were updated to the new truth (admin CRUD delete now meets the guard;
sync-blocks unit reset test documents the refusal).

**Prod exit (§3.8) pending owner:** merge the chain (stage-01 → pass3-spec-fixup →
stage-02), deploy (ships 0053; no env change — `log` is the default), review 48 h of
`would-deny` logs (expected zero legitimate hits given the client-code grep), then set
`REVENUE_ROUTE_ROLE_ENFORCEMENT=enforce` + restart and run the §5 smoke checks (chatter-key
403 probe, fact-bearing delete refusal, retraction/supersede marker queries — exact
commands in the stage file's `## Progress`). **Risk carried forward:** none new; the
messages_history reset stays unavailable until Stage 10, and Stage 13 must reconcile with
`pages.deleted_at` rather than adding a second tombstone column.

## Desktop Stop-Loss — Pass 3 Stage 4 (2026-07-05)

**Decision #66:** The desktop stops destroying facts daily — the client-side twin of Stage 1.
Desktop repo branch `kernel/stage-04-desktop-stop-loss` (three checkpoint commits off local
main 5d298d4; full `pnpm check` green):

- **Usage spool never self-deletes** (d0c094c): the legacy drop-after-3-failures rule is
  retired. Failed events keep persisted attempts and park in a dead-letter tier after the 3rd
  failure — retried on app start and on an hourly sweep, never removed. `kind:'dropped'` is
  gone from the onError union (compile-time proof). Backoff extends to a capped [5 s..60 m].
  HTTP-400 quarantine kept and now exportable (diagnostics `usageQuarantine`: count +
  payloads). Core's `(userId, clientEventId)` dedup absorbs re-sends.
- **Prune horizons ×10** (4a2bfcf): messages 5,000 → 50,000 per chat; spend 31 d → 310 d;
  guard-audit TTL 90 d → 3,650 d. Constants only, mechanisms kept, pin tests added.
- **Purge warning + version header** (e79a259): the DangerZone purge flow now states the
  kernel holds no copy of local messages/transactions/telemetry and offers diagnostics export
  inline (the false "next sync rebuilds it" reassurance corrected); every hub request carries
  `x-client-version` (Proposal 4.1, accepted 2026-07-04), injected from main so
  packages/shared stays platform-pure — the fleet-version exit signal and Stage 11's
  producer version.

**Deviations:** (1) the spec's "purge flow renderer test" is unimplementable — the desktop
repo has no component-test infrastructure (no jsdom/@testing-library, zero .test.tsx);
coverage = the typed i18n catalog + unchanged confirm logic. (2) The Q5 artifact diff used a
macOS dir-build instead of `pnpm dist:win` (the script hard-asserts win32) — valid because
the asar payload is the platform-independent bundled JS, proven below.

**Q5 artifact-diff verdict (the assumption was FALSE):** the served
`ChatGoose-Setup-0.1.28.exe` (sha512 matches latest.yml) contains an app payload
**byte-identical to a clean build of desktop `origin/main@145260a`** ("release: bump desktop
to 0.1.28"; sole delta = CRLF in index.html from the Windows CI checkout). Nothing exists
only in the artifact — but 0.1.28 is NOT a version-bump-only build: **the desktop repo's
local main and origin/main have diverged 5-and-5**. Inside 0.1.28 and missing locally:
01b25e7 (activity-panel mockup fixture), e8016da (Online snapshot staleness fix), 62d00fb
(Hub confirmed-send projection fix), 5ebf171 (live OFAPI read-transport switching fix).
Local-only and missing from origin: b1dd980, 77d5014, 84038b8 + two doc commits. Per the
stage spec §7.1 the 0.1.29 release is **blocked until the owner reconciles the branches**
(merge/rebase, then rebase the stage branch — one likely small conflict in
apps/desktop/src/main/index.ts — then bump 0.1.28 → 0.1.29, tag, windows-build workflow).
Exact steps in the stage file's `## Progress`.

**Risk carried forward:** local DBs grow ~10× slower-bounded (accepted; DangerZone shows
dbBytes); `usage_events` spool grows unbounded while the hub is unreachable (accepted,
disk-bounded, surfaced in diagnostics); the desktop branch divergence is a NEW standing risk
until reconciled — every desktop session before the merge builds on a main that lacks four
production fixes.

## OnlyMonster Export Is Vacuous — Pass 3 Stage 5 (2026-07-05)

**Decision #67:** The passport's full historical export has nothing to operate on, verified live
(00:47 UTC, read-only):

- **V1 provenance census:** every OnlyFans transaction is OFAPI-sourced — `lora-of` 685/685,
  `lora-vip-of` 2168/2168, **0 rows** with non-`ofapi:` raw_type on either page.
- **V2 stream census (7 days):** only shared planner streams (light, followers, transactions,
  top_spenders, subscribers, dm_conversations, dm_messages, followers_reconcile) — no
  OnlyMonster-specific stream; V1's zero rows proves no OnlyMonster writer ran regardless.
- **Egress:** 0 calls to `omapi.onlymonster.ai` in api+worker logs (caveat: containers were
  recreated tonight so log history is short; Q1's 48 h check of 2026-07-04 found the same zero).

No export job is built; no data moves. **Standing risks carried forward:** (1) no off-box backup
of any kind exists (Q3 declined, owner-accepted) — re-raise no later than Stage 28; (2) the
OnlyMonster subscription, if still billed, is cancellable at the owner's discretion and is tracked
in Stage 15; (3) the dead OnlyMonster adapter code stays in-repo until Stage 18's seam. If any
later census finds an OnlyMonster-sourced row, this entry is superseded per append-only law and
the full-export spec (preserved in this stage file's history) re-activates.

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

## Owner-Delegated Release Session — Core Pushed, Desktop 0.1.29, Stage 7 Fully Live (2026-07-05 ~02:50 UTC)

**Decision #70:** The owner delegated the remaining pipeline actions ("continue please you
can do everything yourself"), with each gated capability individually re-confirmed
(AskUserQuestion: "Deploy now" for the core deploy; "Full release" + "read-only prod
SELECT" for the desktop release and coverage check; the day-2 probe command was pasted by
the owner verbatim):

- **Stage 6 day-2 probe:** verdicts identical to day-1 on both lilly pages — zero auth
  rejections; no check-rot after ~24 h. Days 3–5 remain (once daily via the deployed CLI).
- **Stage 7 build-complete slice deployed:** main fast-forwarded to 5c69c9c
  (3b tail: account_lookup/probe/tracking/trial/dm_conversations/fans_active captures;
  4b: ten admin routes through recordAudit) and deployed dist-only at ~02:47 UTC — health,
  sync-health, dashboard delivery verified. Interim coverage read (02:51 UTC): 13 kinds
  emitting; dm_conversations already the top pull producer (116 rows in minutes);
  schedule-bound kinds (fans_active, identity pages, command_result, operator) pending
  their natural triggers. Suite on the slice: 168 files / 1413 tests green.
- **Core pushed:** origin/main 1a06b5d..5c69c9c — prod = origin = local for the first time
  this phase.
- **Desktop 0.1.29 released:** reconciled main merged with the stage-04 branch (69a72bf),
  bump commit 91d3c2d, final `pnpm check` green on the release commit (1,965 tests), tag
  v0.1.29 pushed (145260a..91d3c2d) — windows-build run 28727409498 publishes to the feed.
  Stage 4 §5 verification (feed serves 0.1.29; x-client-version on ai-usage batches within
  7 days; diagnostics on one Win + one macOS machine) starts once CI lands.

Remaining owner-independent tails: Stage 7 48 h reconciliation (~2026-07-07 morning),
Stage 6 days 3–5.

## Stage 13 Green-Local — Provenance, Currency, Single-Writer Gate (2026-07-05)

**Decision #71:** Stage 13 built and green-local in one session on
`kernel/stage-13-transactions-provenance` (5021ac2; suite 169 files / 1417 tests).
Migrations 0055 (provenance columns, writer seed, backfill, `wrong_transactions_writer`
incident kind) + 0056 (22 of 42 pages.id FKs → RESTRICT, classification recorded in the
migration comment). Two deviations from the spec text, both recorded in the stage
`## Progress`:

1. **`source_observation_id` carries no FK constraint.** `observations` is partitioned
   with PK `(id, received_at)`; PostgreSQL cannot FK a partitioned table on `id` alone —
   the same limitation that forced the `observation_keys` companion in 0054. The column
   is a documented plain bigint; the OFAPI ingest populates it TODAY (not a follow-up)
   by resolving the webhook delivery key through `findObservationByKey`.
2. **The writer-seed invariant continues at the write paths** (elaboration beyond the
   spec): `createPlatformPage` births Fansly pages with `transactions_writer='fansly'`;
   `setPageOfapiAccountId` assigns `'ofapi'` when unassigned. Without this, every page
   created after the migration would refuse its own writer until Stage 14 — including
   live onboarding. An explicit assignment is never overridden.

Also notable: the Stage 2 handler-level 409 on fact-bearing page deletion is REPLACED by
tombstone semantics per the spec's §5 (delete = `status='deleted'`, facts and config
remain — a two-way door; only a raw SQL DELETE is refused, now at the FK level). The
gate refuses NULL-writer pages for every writer; the OFAPI ingest skips only the refused
page (rows stay pending and re-list), other pages keep applying.

Remaining for exit: deploy (migrations 0055+0056), then §5 production checks — source
coverage split, per-page/month revenue totals identical, wrong-writer probe, ingest
flowing post-deploy.

## Stage 13 Deployed + Verified (2026-07-05 ~03:45 UTC)

**Decision #72:** Stage 13 merged to main (d410573) and deployed (owner-confirmed
"Deploy now"); migrations 0055+0056 applied; containers healthy, health + sync-health
green. §5 verification (read-only, same session):

- **Source coverage 100%**: 15,413 rows — fansly:rest 12,560 / ofapi:rest 2,701 /
  ofapi:webhook 152; zero NULLs; zero 'onlymonster' (consistent with #67).
- **Revenue totals byte-identical**: per-page/month count+gross+net snapshot diff
  before vs after migration = empty (106 rows).
- **Writer seed = running reality**: 5 fansly pages → 'fansly', 2 onlyfans → 'ofapi';
  zero wrong_transactions_writer incidents — the gate is live and silent.
- **FK flip exact**: pg_constraint shows 22 RESTRICT / 16 CASCADE FKs on pages —
  precisely the recorded classification.
- **Ingest backlog zero**: all 152 projected transactions.new events applied; the
  overnight max(created_at) (23:00 UTC) reflects quiet hours, not a stall.

The wrong-writer probe requirement is satisfied by the integration suite (no staging
env exists; tests/transactions-writer-gate.integration.test.ts proves refusal +
incident + lossless re-apply end-to-end). Exit flips when the next live webhook spend
lands post-deploy (proving the gated write path in production traffic).

## Stage 8 Green-Local — Domain Events, Canonicalization, Replay (2026-07-05)

**Decision #73:** Stage 8 built green-local in one session on `kernel/stage-08-domain-events`
(4 slices, tip 422fc81; suite 174 files / 1439 tests). **Ordering deviation, owner-instructed
("do not wait"):** built while Stage 7 is deployed+live but not yet exited — the same
compression as Stage 7-on-Stage-1 (#68). The DEPLOY waits for Stage 7's 48 h exit (~07.07);
nothing ships until then.

Delivered: migration 0057 (domain_events partitioned monthly by occurred_at, 2024-01→2026-12
plus a MINVALUE catch-all; gapless-seq and dedup companions per the same partitioned-unique
limitation as 0054); the append protocol proven gapless under 8-way concurrency; webhook /
sync-pull / command-result canonicalizer families with the binding dedup-key table; the
CROSS-PRODUCER DEDUP HEADLINE PROVEN in CI (one DM as webhook delivery + REST page → two
observations, ONE message.received event, replay appends zero); minutely sweep as the replay
executor; events:replay CLI.

Scope decisions recorded in the stage `## Progress`: tips.received undeclared (unverified
fixture — first replay customer); fansly DM pages undeclared (direction needs the page's own
account id — not decidable by a pure function; a later canonicalizer version threads a
context table); onlymonster pages undeclared (vendor retiring, zero prod rows);
subscriber/follower/audience pages next version. One trap for posterity: ORDER BY with a bare
column name resolves to the SELECT's ::text alias → lexicographic sort that looks exactly
like sequence gaps; qualify the column.

Remaining for exit: deploy after Stage 7 exits, days-long type-coverage watch, staging
replay drill, canonicalization-lag p95 baseline.

## Stage 9 Green-Local — Read-Gateway Capture + Attribution (2026-07-05)

**Decision #74:** Stage 9 built green-local on `kernel/stage-09-read-gateway-capture`
(15a0509, branched off the Stage 8 tip for a linear 8→9 merge chain; suite 174 files /
1442 tests). Same ordering deviation as #73 (owner "do not wait"): deploy waits for
Stage 7's exit, chained behind Stage 8.

Delivered: producer 4 — every gateway 2xx response teed into the journal post-respond
(bounded queue, joinable drainer, verbatim body, path-template kind, chatter principal);
fail-open bounded to this producer only, with a drop counter and the new
read_gateway_capture incident kind at threshold. Attribution: migration 0058 adds
ofapi_credit_ledger.actor_user_id; the principal threads gateway → proxyRead → spend
sink → ledger; background REST spenders stay NULL (system). The review's
gateway-attribution gap (§4.4) is closed at both halves.

Deviations recorded in the stage `## Progress`: the <1 ms enqueue micro-benchmark is
skipped as CI-flaky (the guard is structural — a bounded array push); the gateway p95
baseline moves to the deploy step (measured immediately before, same method as after).

Remaining for exit: deploy after Stage 7 (behind Stage 8), 24 h observation-count vs
gateway-request reconciliation, p95 comparison.

## Stage 10 Green-Local — Platform-Neutral Message Archive (2026-07-05)

**Decision #75:** Stage 10 built green-local on `kernel/stage-10-message-archive` (94bf6ca,
off the Stage 9 tip — linear 8→9→10 merge chain; suite 175 files / 1446 tests). This is the
FIRST stage built on an UNDEPLOYED substrate (green-local Stage 8's domain_events); the risk
was flagged to the owner beforehand and the owner instructed to continue ("please do
everything you need and continue now"). Deploys strictly after 8+9 deploy and their
canonicalizers verify live.

Delivered: migration 0059 (message_archive with the Stage 13 RESTRICT fact policy +
projection_seq_watermarks — the spec's watermark table name was taken by the spender
rebuild timestamps, recorded deviation); event-fed writer behind per-account seq watermarks
(received/sent insert, deleted tombstone; ppv_unlocked a recorded v1 no-op); minutely
sweep; one-command rebuild proven to reproduce identical counts from the ledger (the §5.2
template proof, first of its kind); idempotent backfills from dm_message_archive and the
hot table (the single cents→mills conversion, explicit); replay-driven source 3 = Stage 8's
events:replay by construction; owner/team_lead-gated read/search endpoints (chatter 403,
team_lead page-scoped).

Remaining for exit: deploy (after the 7→8/9 chain), prod backfills, 48 h per-conversation
coverage (hot ≤ archive, both platforms present), desktop-visible spot-check.

## Stage 16 Green-Local — Fansly Earnings & PPV Streams, Capture Side (2026-07-05)

**Decision #76:** Stage 16 built green-local on `kernel/stage-16-fansly-earnings` (adefc1a,
chain 8→9→10→16; suite 176 files / 1447 tests). Central deviation, capture-first: the parse
side (adapter typing, `fan.earnings_observed`/PPV canonicalizers, the fan_earnings_stats
projection writer, the read endpoint) is DEFERRED to a canonicalizer-v2 slice AFTER the
single-page ramp captures a live payload corpus — the shapes are probe-grade unknown and
guessing schemas pre-ramp is precisely what capture-now-parse-later exists to avoid. The
projection TABLE ships now (0061) so v2 is code-only. Observations lose nothing; replay
fills events retroactively.

Design findings: the order-history endpoint is per-fan and CURSORLESS — the "back-scroll"
is a checkpointed keyset walk over page_fans (new listPageFanNativeIds), cursor resets on
exhaustion = incremental refresh. Ramp gates are live-editable rather than boot-staged
(ramp flips must not need restarts — staged-by-process, live by mechanism). Bulk streams
are deliberately absent from SYNC_DOMAIN_POLICY supporting lists: a flag-off stream must
not degrade the page's block-health UX to "catching up".

Remaining for exit: deploy with the chain (flags off = inert), single-page ramp 48 h
(lilly-1/lilly-2 — sessions probe-proven), canonicalizer v2 + projection from the captured
corpus, fleet enable, 2-week incident watch.

## Stage 17 Green-Local — Fansly Backscroll Backfill (2026-07-05)

**Decision #77:** Stage 17 built green-local on `kernel/stage-17-backscroll` (29e49d4,
chain 8→9→10→16→17; suite 176 files / 1448 tests). Same deviation family (#73–#76).

Delivered: (1) the Fansly DM canonicalizer Stage 8 had deliberately deferred — sync-pull v2
resolves message direction against a per-run page→native-account-ref context map, keeping
canonicalizers pure (the context is an argument, not a lookup inside); tips stay in mills;
missing own-ref rows are recoverable via events:replay (recorded edge). (2) The semantics
audit CONFIRMED the spec's suspicion: the deep-backfill walk was depth-capped by
stored_message_count < retention_limit, not walk-to-exhaustion (value ordering was already
spender-first, pre-satisfying the spec). Extension per extend-don't-replace: live-editable
fanslyDeepBackfillIgnoreRetentionLimit (12th live key) lifts the cap for the exhaustion
crawl. (3) fansly:backscroll-report manifest CLI — the exit criterion reads from it.

Design note recorded: manual "sync all" expands via domain lists, which deliberately
exclude the bulk streams — scope requests never hammer them; they ride the recovery/planner
cadence.

Remaining for exit (ops, after the chain deploys): flip the cap knob, weeks-long crawl,
weekly manifest watch, §5 prod checks at 100% exhausted.

## Stage 16 Parse Side Landed — Extension-Proven Shapes (2026-07-05)

**Decision #78:** The owner asked for the canonicalizer without waiting for the ramp
("can we do canonicalizer somehow now"). Resolution: the deferral's premise was "no
trusted shape source until live capture" — but a trusted source EXISTS: the extension
parses these exact responses in production daily. Shapes derived from its parsers
(chatgoose `shared/types.ts`), units confirmed mills by core's own treatment of the same
endpoint family. The ramp's role flips from discovery to verification.

Landed on the Stage 17 branch (600284b; suite 177 files / 1449 tests): sync-pull v3 —
`fan.earnings_observed` per fan per window with content-hashed dedup (unchanged snapshot
re-fetch appends zero, CI-proven) and `message.ppv_unlocked` with a composite key
(deviation: order-history rows carry NO order id — `ppv:<fan>:<media|bundle>:<createdAt>`);
the `fan_earnings_stats` projection writer (watermark pattern, on-demand fan upserts,
forward-only observed_at) in the projection sweep + `projection:rebuild`. Stage 16's
remaining deferral shrinks to: adapter typed schemas (cosmetic post-ramp) + the owner-grade
read endpoint (Stage 33 or a later slice).

## Stage 13 Exited — Live Webhook Spend Through the Gate (2026-07-05)

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

## Stage 14 data-exports lane evaluation — verdict (2026-07-05)

**Decision #80 (part 1, spec task 7):** POST /api/data-exports was priced on paper
against the marker-walk REST cost using the vendored spec. Facts: creating an export
costs 0 credits (status `calculating_credits`; scraping types charge after the fact,
per-export dynamic pricing), and the flow is async (create → start → poll → download).
The REST marker-walk baseline: the pages' ENTIRE current history is 685 + 2,170 rows
≈ 29 pages of 100 ≈ ~30 credits for a full re-walk — a rounding error against the
200/day backfill budget. Verdict: **do not adopt now.** The lane only wins if the
depth probe (task 2) reveals a large pre-2025-09 tail that needs a bulk pull; the
"one live probe" (create a transactions-type quote, never start it, delete) rides the
same owner-gated ops window as the depth probe. Re-evaluate then; otherwise closed.

## Stage 14 Green-Local — Built Same Day Its Dependencies Exited (2026-07-05)

**Decision #80 (part 2):** Stage 14 build complete on `kernel/stage-14-ofapi-transactions`
(off the Stage 17 tip — the chain stays linear 8→9→10→16→17→14; deploy still rides
Stage 7's exit). **Suite 179 files / 1458 tests green.** Five slices:

1. **Day-budget guard on the backfill CLI** (DP 2's binding condition): new 'backfill'
   scope in reserveOfapiDayCredits (own counter pair, migration 0062), knob
   `ofapiBackfillDailyCreditBudget` (default 200), reserve-before-every-request via the
   shared createOfapiRestGuard; refusal stops the walk with an explicit
   `budget_exhausted` stop reason ("resume tomorrow"; re-runs converge).
2. **Explicit fee/VAT/tax capture** (migration 0063): verified live shape —
   transactions.new carries fee_amount/vat_amount/tax_amount dollars-float
   (gross − fee = net; VAT buyer-side). Carried contract → shadow row → truth ingest →
   REST backfill; fill-only upsert semantics (an omitting writer never erases).
3. **tips.received UNBLOCKED**: 3 natural webhooks landed 2026-06-30..07-03 — the
   passport's condition. Two traps the prod probe settled: top-level `user_id` is the
   CREATOR (constant across tippers per page) — the fan is `payload.user.id`; and tips
   ALSO arrive as transactions.new (412 truth rows), so tips.received maps as an
   estimated shadow SIGNAL (never ingest truth — no double-count). Legacy blocked rows
   self-heal through the regular sweep (re-list filter + shared domain key). New benign
   comparison status `tips_signal`. Follow-up unlocked, deferred: declaring
   tips.received in the Stage 8 canonicalizer family (a version bump; ledger loses
   nothing meanwhile).
4. **Chargebacks via OFAPI**: daily 03:10 UTC reconcile behind
   `ofapiChargebacksReconcileEnabled` (boot, default off). Collision trap solved:
   payment.id is the ORIGINAL transaction's id → chargebacks write under
   `{payment.id}:chargeback`, never demoting the settled row (CI-proven). Gross/net/
   fees negated (OnlyMonster shape); writer-gate enforced per page; backfill budget lane.
   First run walks full history, then a trailing 90-day window.
5. **fan_identities OFAPI branch**: tracking/trial-link users via 4 new client methods
   behind `ofapiFanIdentitiesSyncEnabled` (boot, default off), audience budget lane.
   Recorded simplification: no cross-run cursor — links are few, upserts idempotent,
   runs converge across cadence under the per-run request cap.

Remaining (ops, not build): depth probe per page + conditional top-up (task 2, live
credits — owner-gated window), the data-exports live quote (#80 part 1), deploy with
the chain (migrations 0062+0063 additive-inert), §5 checks over a week.

**Also fixed same session (live prod bug, outside the plan):** lora-of/lora-vip-of
dm_messages NEVER succeeded — the chat-messages read is scraped server-side and scales
with chat size, so the two largest conversations always exceeded the 15 s client abort
(~400 futile attempts/24 h). Fix: 60 s slow-lane timeout for `ofapi_chat_messages` only
(46216dd). Rides the chain deploy; cherry-pickable onto main if wanted sooner.

## Post-Stage-14 tail: tips canonicalizer v2 + Stage 4 fleet-verify gap (2026-07-05)

**Decision #81:** Two same-day follow-ups on the chain (both ride the Monday deploy):

1. **ofapi-webhook canonicalizer family v1→2** (23f8aed): tips.received declared from
   the live-verified shape — its own `tip.received` event (dedup `tip:<notificationId>`,
   fan = payload.user.id), distinct from `transaction.posted` so money is never counted
   twice. The parse_version-0 tips observations waiting in prod become the sweep's first
   real replay customers; NB the version bump re-scans the whole webhook corpus once
   (dedup keys make it append-zero; paced at 20 pages/family/minute).
2. **Stage 4 exit-gap fix** (9613c9e): the fleet-verify check ("x-client-version: 0.1.29
   from every active machine in core logs") had NO data source — core never logged the
   header (fastify doesn't serialize headers; no proxy in compose). New bounded observer
   logs one "Desktop client version observed" line per (version, remote address); after
   Monday's deploy the check greps those lines — ~5 days of fleet data before the 07-12
   deadline. Interim fleet check today was therefore impossible by construction, not by
   traffic.

## Stage 11 Core Side Green-Local — Chain Now Seven Stages Deep (2026-07-05)

**Decision #82:** Stage 11's core side built same session (ceb6cc4; suite 180 files /
1462 tests green after fixing one stale registry-dispatch pin the tips-v2 bump
invalidated). Ordering deviation, same recorded pattern as #73–#75: Stage 4 is
released-not-exited (0.1.29 on the feed, fleet verify pending 07-12 with the data
source #81 just created) and Stage 7 deployed-not-exited. The chain is now
**8→9→10→16→17→14→11**, tip `kernel/stage-14-ofapi-transactions` @ ceb6cc4 — all of
it additive and flag-inert, still one Monday deploy.

Substance: `POST /api/v1/ingest/observations` per spec §2 exactly (bearer-only,
version header required, 1..100 / 1 MB / 120-min caps, whole-batch atomic,
`{accepted, duplicates}` via the Stage 7 key protocol — duplicate re-send CI-proven
free); unknown kinds journal as `desktop.unknown:<kind>`; canonicalizer family
`client_capture` is registration+validation only BY DESIGN — zero domain events until
Stage 29 (the family version is Stage 29's replay hook; flagged in review per spec).
No schema change. The 3c handoff memo (wire contract verbatim + client obligations:
quarantine-on-400, purge-notice-before-wipe, whole-batch resend) landed as a NEW file
in the desktop repo: `docs/project-kernel/pass3-stage-11-wire-contract.md` (untracked
— the 3c/Stage 12 executor commits it with its work).

Exit (ops): deploy with the chain → desktop uploader release (3c) → §5: ≥1 production
desktop end-to-end, duplicates=all on re-send, offline-drain drill, a week of spool
telemetry (which also gates Stage 12's harvest).

## Stage 12 Built — Both Halves, Same Day (2026-07-05)

**Decision #83:** Stage 12 (desktop local-DB harvest) built across both repos in one
session, grounded in a full desktop-schema exploration. Ordering deviation as before
(deps 11/8/10 green-local-not-exited; the fleet run is ops after the chain deploys).

**Core glue** (dd006b2, on the chain): lane accepts `harvest.<table>` kinds verbatim
under `producer='desktop-harvest@<version>'`; account resolution moved to INGEST
(payload.ofapiAccountId → pages.ofapi_account_id — harvest events carry no pageLabel
and NULL-account observations never canonicalize). client-capture family v2:
harvest.messages parses with Stage 8 dedup-key parity — CI-proven cross-producer
collapse (webhook + harvest → 2 observations, 1 event) while pre-epoch history appends
with tombstones. RECORDED DEVIATION: harvest.fan_transactions is validation-only, not
"candidate events" — the ledger's transaction events start at the webhook epoch, so
historical harvest events would ALL append as noise; the meaningful dedup surface is
the transactions TRUTH table (the desktop's own sweep calls OFAPI
GET /{account}/transactions — same id space), which is what `harvest:reconcile`'s
residue query joins (report-only; NULL-account rows always residue).

**Desktop half** (ac5fbb9 on `kernel/stage-12-harvest` off 0.1.29): harvest module with
rowid walkers, DETERMINISTIC UUIDv5 ids keyed on natural PKs (not rowids — VACUUM),
cursors persisted only after the covering 2xx, 400-quarantine + capped-backoff retry,
per-machine manifest for reconciliation, Danger-Zone start/pause UI with polled
progress, and the purge guard: purge REFUSES while a started harvest is incomplete
(the spec's one binding ordering rule, encoded). New hub client method
postIngestObservations; harvest client sends x-client-version 'harvest-<app version>'.
`pnpm check` green (typecheck, lint, 762+1206 tests). The Stage 11 wire-contract memo
is committed in the desktop repo alongside.

Exit (ops, after chain deploy + a desktop release carrying this): fleet inventory via
diagnostics exports → one machine first → manifests reconcile via harvest:reconcile →
re-run no-op proof → archive coverage predates webhook epoch → residue review. Local
prune policies stay at Stage 4 caps until manifests reconcile.

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

## Stage 19 Session 1 — Declarative Authorization Landed, Extraction Next (2026-07-05)

**Decision #87:** Stage 19 (API decomposition + declarative authorization) started on
branch `kernel/stage-19-api-decomposition` off the Stage 14 chain tip (23e827c) —
a SEPARATE branch, not part of Monday's merge chain. §8 tasks 1, 2, 4, 5 of 6 are
done at 3cb9598; full suite after the last code commit: **186 files / 1504 tests
green** (baseline 182/1474). What shipped:

- **Auth vocabulary + verdict middleware (d189b67).** Every one of the 132
  routeSchemas entries (spec said 129 — stages 10/11 added routes; the 129/128
  off-by-one reconciled: the webhook registers inside its own plugin scope for the
  buffer body parser, coverage is exactly 1:1) carries
  `auth: {kind, roles?, scope?}` transcribed from the verified in-handler guards.
  The verdict engine (`apps/runtime/src/api/auth-policy.ts`) REUSES the legacy
  guard functions in try/catch — decision parity by construction, not
  re-implementation. `AUTH_POLICY_ENFORCEMENT` env (default `log`, registry
  editability NEVER, mirroring Stage 2's key): log mode records the verdict and
  logs `would-deny`/`would-allow` divergence onResponse; enforce denies before any
  handler. Deploying this is INERT.
- **Contracts CI gate (same commit).** A contracts unit test fails any
  routeSchemas entry without a valid declaration (zod-strict, self-tested), plus a
  pinned review of the 37 `scope:"page"` keys. Linter-independent by design.
- **OpenAPI security derived from auth (4b8af34).** `routeSecurityFromAuth` +
  swagger-transform injection; the four hand-set security constants and their 128
  per-entry lines are gone. SEVEN operations changed in
  `reference/agency-hub.openapi.json`, all justified: the 4 Stage 2 revenue routes
  stop advertising bearer keys production has refused since the enforce flip
  (the doc was lying about the tightening), and `upsertFanProfile` + the two
  profile-versions routes now admit both auth methods their handlers actually
  accept (the doc was lying about acceptance). `api-types.ts` unchanged. The
  `auth` block itself is stripped from the wire document.
- **Policy table + introspection (same commit).** An onRoute collector exposes
  `server.routePolicyTable` (method/path/routeKey/auth) — the same introspection
  Stage 20's SDK generator needs; `pnpm contracts:generate` renders
  `docs/generated/authorization-policy.md` (docs/ is untracked; the table
  regenerates from any checkout).
- **ESLint bootstrap (3cb9598).** First linter in core: flat config whose ONLY
  rules are the `modules/<name>/index.ts` import walls, dormant until extraction
  populates `modules/`, probe-verified to fire; `pnpm lint` wired into CI.

**Deviation from spec §2 (recorded):** in-handler guard calls are NOT deleted as
modules migrate. The whole stage deploys as one unit — deleting guards at
extraction would leave routes unprotected during the log-only window (middleware
observing, guards gone) and would leave the 48 h divergence diff with nothing to
compare against. Guard deletion is a separate cleanup slice AFTER the production
enforce flip; `REVENUE_ROUTE_ROLE_ENFORCEMENT` retires in that same slice, not
before.

Client-compat facts re-verified before annotating (Explore over both client
repos): desktop and extension call `pages`, fan-profile GET/PUT, and
`ai-usage/batch` with BEARER keys — those routes are declared `any`/`apiKey`, not
`session`; the extension on `bar-tone-menu` no longer calls spenders/fans-search
at all (drift vs Stage 2's baseline, no action needed — declarations mirror
handlers, not clients). `ai-usage/batch` is apiKey-only de facto
(requireApiKeyUser inside the service), declared accordingly.

Remaining: Task 3 — extract the ten modules with handlers VERBATIM (guards
intact), buildApiServer as composition root, per-module role-matrix tests,
relative-sibling lint walls (3–4 sessions); then Task 6 ops (inert deploy → 48 h
log window → enforce flip → cleanup slice). Steps sketched in the stage's
`## Progress` block.

## Stage 19 Session 2 — Eight of Ten Modules Extracted (2026-07-05)

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

## Stage 19 Session 3 — Extraction Complete, server.ts Is a Composition Root (2026-07-05)

**Decision #89:** Task 3 is DONE. All ten target-§6.1 modules now own their
routes; `apps/runtime/src/api/server.ts` is a **497-line composition root**
(fastify setup, the declarative-auth middleware + routePolicyTable collector,
the requestAuth factory, pg-boss, module registration, swagger/openapi, the
error handler, SPA static serving) — down from 3,768 lines at the stage's
start. Full suite after the last commit: **186 files / 1505 tests green**.
Session commits, each gated on typecheck + an empty `contracts:generate` diff
+ targeted suites + the role matrix:

- 963db99 **catalog** (14 routes): model/page CRUD with the Stage 13 tombstone
  delete, onboarding + the queueInitialOnboardingSync helper family (boss via
  module ctx), credentials verify (public adapter surface only, per the
  safeguard scope rule), proxy test, page-verify recovery, credentials-update
  audit. serializeAssignedPage/rethrowAdminCatalogError/
  isAdminPageVerifyBadRequest moved with it.
- c8b8137 **ops slice 1** (23): health pair, the OFAPI credits family
  including the hijacked CSV export, sync monitor + per-page blocks, the eight
  admin sync triggers, connections.
- 00fed94 **ops slice 2** (17): admin logs/queue/db-stats/incidents (raw-sql
  reporting with the severity normalization), the Telegram notifications
  surface, and the config surface (live PATCH, editable clear, advisory-locked
  staged flips) — extraction complete.
- cd2c17e **relative-sibling ESLint walls**, now that the layout is final
  (every module = one modules/<name>/index.ts). Gotcha worth keeping: minimatch
  `*` matches `..`, so the sibling group needs `!../../**` or every
  `../../services/…` import trips the wall. Probe-verified: a sibling internal
  import errors; `../<other>/index.ts` and parent traversal pass; the repo
  lints clean.

With #87/#88: Stage 19's §8 tasks 1–5 are all done. What remains is **Task 6
(ops) only**: owner deploy (INERT — AUTH_POLICY_ENFORCEMENT defaults to log,
no migrations in this stage) → 48 h log window (grep api logs for
`auth-policy would-deny|would-allow`; zero unexplained divergence per module)
→ flip AUTH_POLICY_ENFORCEMENT=enforce + restart + re-probe → the
guard-deletion cleanup slice (in-handler requireX calls the middleware
subsumes; REVENUE_ROUTE_ROLE_ENFORCEMENT retires with
enforceRevenueRouteRoleScope) → stage exits. This branch is NOT part of
Monday's merge chain; it merges independently after the chain lands.

## Stage 20 Session 1 — @kernel/sdk Built, Streams Helpers Live, api-types Dead (2026-07-05)

**Decision #90:** Stage 20 started on `kernel/stage-20-generated-sdk` off the
Stage 19 tip (ordering deviation in the #73–#75 pattern — owner: "continue it
and next stages, don't worry about time checking"; Stage 19 is green-local,
not deployed). §8 tasks 1, 2, 4 of 6 are done at e268f53; full suite
**188 files / 1525 tests green**.

- **@kernel/sdk (e18aa4e).** Design decision worth recording: the generated
  package is deliberately TINY — an operations manifest (method/path per
  registry key, recovered from Stage 19's `server.routePolicyTable` with a
  total-join assertion), the contract hash, and re-exports; there is no mass
  codegen. Every moving part lives in `packages/contracts/src/sdk-runtime.ts`,
  where per-operation methods and request/response types are MAPPED
  generically off `typeof routeSchemas` (z.input in, z.output out) and
  responses are runtime-validated with the same schemas the server enforces.
  Cookie/bearer auth with a 401/403 hook; KernelApiError taxonomy; `raw()`
  escape hatch; exclusions = webhook, both SSE streams, the wildcard read
  gateway, the CSV export. **The contract hash is sha256 of the normalized
  OpenAPI document, not the manifest** — a renamed response field must move
  it (the cross-repo drift drill's property), pinned by test. Core has no
  package version, so the SDK base is "0.1.0" and the hash is the real
  identity; release tags own versioning (Task 6). DP 10 git-tag pinning is
  documented in the generated README.
- **Stream helpers (3149f2f).** `subscribeSyncEvents` wraps the v1 protocol
  (Last-Event-ID resume, per-frame validation, 409 → onSnapshotRequired,
  deliberately no auto-reconnect — the server bounds stream lifetime and v1
  clients own the loop); `streamAiGateway` parses `event: ai` frames;
  `ofapiRead` is the thin wildcard passthrough. Conformance proven on fake
  streams (split chunks, heartbeat noise, invalid frames) and against the
  LIVE server — seeded journal events replayed through the helper, an
  ahead-of-journal cursor produced the parsed snapshot-required payload.
- **api-types.ts deleted (e268f53, Task 4 done early).** 14,753 dead lines +
  the openapi-typescript dependency; verified consumer-free first. Types now
  flow from the SDK's mapped inference; the OpenAPI document remains the
  published artifact.

Remaining: Task 3 (dashboard adoption ×16 modules, delete client.ts, lint
ban), Task 5 (drift gates in desktop/extension + the prove-the-gate drill),
Task 6 (release ops — note: external git-tag installs need the runtime
bundled from contracts at publish time; decide there). Resume map in the
stage's `## Progress`.

## Stage 20 Session 1 Addendum — Dashboard Adopted Same Session (2026-07-05)

**Decision #91:** Task 3 landed in the same session (2d536cf): the dashboard
runs end-to-end on @kernel/sdk. All 15 domain modules re-implemented over the
typed operations through one `src/api/sdk.ts` (cookie mode); `client.ts` and
`utils.ts` deleted; the two `ApiError` consumers moved to `KernelApiError`;
the CSV download rides `raw()`; React Query keys are byte-stable and the
workboard-v2 comma-joined `status` wire shape is preserved. The SDK's
`onAuthError` gained an OPERATION argument so a failed `login` stays a form
error while expired sessions still redirect. Where hooks take looser types
than the contracts (period/platform/bucketKey strings), localized
`Parameters<typeof kernel.X>[0][...]` casts keep hook signatures unchanged.
Two recorded mechanics: (1) the lint ban is a TEST
(tests/dashboard-sdk-ban.test.ts — no direct fetch in src/api, no client
resurrection, every module through ./sdk.js) because the dashboard tree is
not ESLint-covered — the same mechanism substitution as the contracts auth
gate; (2) `@kernel/sdk` needs FOUR alias registrations (dashboard
tsconfig/vite, root vitest, tsconfig.base — root tsc follows test imports
into dashboard sources and cascades phantom errors without the base mapping).
Dashboard `tsc -b` + `vite build` green; dashboard suite 18 files/113 green;
full suite after the last commit: **189 files / 1528 tests green**.

Stage 20 remaining: Task 5 (drift gates in desktop/extension CI + weekly
bump-PR + the prove-the-gate drill — cross-repo, owner-visible PRs) and
Task 6 (release step: sdk-vX.Y.Z tags; bundle the contracts runtime into the
tag artifact for external installs — decide there).

## Stage 21 Built Whole — Event Stream v2 Beside Untouched v1 (2026-07-06)

**Decision #92:** Stage 21 (event stream v2) built completely in one session on
`kernel/stage-21-event-stream-v2` @ 0d28077 (chain 19→20→21; ordering
deviation in the standing #73–#75 pattern — the substrate is green-local
Stage 8, deploy follows the chain). §8 tasks 1–5 all done in four commits;
full suite after the last commit: **192 files / 1542 tests green**, with the
v1 SSE suite byte-untouched — the compatibility invariant's proof.

What shipped:
- **Frame + cursor (a29a420).** Frame `{accountId, accountSeq, type,
  occurredAt, data}` with `type` contractually open (unknown-type tolerance is
  explicit, tested). The resume cursor is OPAQUE base64url
  `{v:2, w:{<account>: <highSeq>}}` — strict decoder (unknown version,
  malformed JSON, non-canonical base64 all rejected), deterministic encoder.
  v2 routes declared `kind:"any"` (execution decision the spec delegated —
  the dashboard consumes v2 in Stage 33). SDK gained `subscribeDomainEvents`.
- **Fan-out (56e0f82).** One `pg_notify` per (account, batch) inside the
  append transaction — commit-fired, payload advisory. `createDomainEventHub`
  carries the v1 hub's exact discipline (notify = wake-up only, serialized
  drain, watermark advances only after broadcast) generalized to per-account
  watermarks with a dirty-account set and reconnect rebaselining.
- **Endpoints (a39288b).** v2 stream/snapshot beside byte-identical v1:
  grant-scoped account universe (owner = all), per-account replay + buffered
  live tail, re-auth for BOTH credential kinds, and the per-account 409 —
  ahead-of-head AND below-retained-floor, with the floor COMPUTED from
  retained rows (min account_seq), so Stage 28's tiering needs no code change
  here; the conformance test prunes synthetically and also proves the exact
  floor edge resumes cleanly.
- **Smoke instrument (0d28077).** Permanent worker-side consumer over the same
  hub+replay code path, durable checkpoint (migration 0064: cursor +
  frames/gap/duplicate counters), restart-resume proven without recount, a
  synthetic seq gap counted as the bug signal. Runs unconditionally like the
  Stage 7/8 sweeps (read-only besides its row).

Recorded deviations: (1) v2 snapshot is the grant-checked fresh-cursor
handshake; the spec's "current projection state per account" payloads ride the
consumer stages (24/33) additively — Stage 21's only consumer needs exactly
the cursor reset. (2) The smoke consumer tails the hub in-process rather than
HTTP-self-connecting (auth/URL wiring to self adds ops surface; the wire
framing is covered by the CI conformance suite).

Exit (Task 6, ops): deploy migration 0064 + dist → 24 h smoke window with
zero gaps/duplicates (`select * from domain_events_smoke_checkpoint`) →
dual-stream load measurement → the first-ever Fansly frame observed on v2 →
v1 desktop connections unaffected.

## Stage 22 Built — Identity: Sessions, Device Tokens, Grants, Attribution (2026-07-06)

**Decision #93:** Stage 22 built (§8 tasks 1–5) on the chain branch
(commits c4dbcc6 + 89dc253 + a fixture fix, after Stage 21 on
`kernel/stage-21-event-stream-v2` — chain 19→20→21→22; standing ordering
deviation). Full suite after the last commit: **193 files / 1547 tests
green**. Migration **0065**.

What shipped and the execution decisions inside it:
- **All-roles sessions with the dashboard door unmoved.** `roleCanUseSession`
  (login capability) opens to chatters; a NEW `roleCanUseDashboard` keeps
  `requireDashboardUser` at owner/team_lead — the spec's "chatter dashboard
  login remains BLOCKED" is a role split, not a route change. New vocabulary
  kind **"any-session"** (any live cookie session) covers the self-serve auth
  surface; verdict via new `requireSessionUser`.
- **must_change_password** rides admin set-password (invite flow v1); the
  gate is enforced UNCONDITIONALLY in the policy hook (allowlist =
  me/logout/change-password) — deliberately outside the Stage 19 log/enforce
  comparison since it is new behavior with no legacy guard to diverge from.
  `changeOwnPassword` verifies the current password, clears the flag, and
  revokes every session (re-login required — recorded semantic).
- **Device tokens**: `agency_hub_device_` prefix, digest-stored, sliding 90 d
  expiry (bump throttled to ≥1 d gains) hard-capped at 365 d from creation;
  `authenticateBearerToken` prefix dispatch in resolvePrincipal and BOTH SSE
  re-auth branches; `requireApiKeyUser` widened to accept device tokens —
  execution decision: keep the kind name "apiKey", zero route re-annotation.
  Nothing is ever attributed to a bare device (the principal is the owning
  human). Self-issue on any-session + the owner admin trio.
- **Grants**: append-only `access_grants` (revoke = stamp; org scope reserved
  per DP 9-A single-tenant, recorded as the invariant); the projection
  reproduces `listUserPageAssignments`' exact row shape with model grants
  expanding to present AND FUTURE pages at read time. EXECUTION
  INTERPRETATION RECORDED: the spec's "assignments become read-only
  immediately" would break continuous parity, so assign/unassign and the
  api-key page-bind DUAL-WRITE (grant + legacy row) until
  ACCESS_GRANTS_READ_ENABLED flips reads AND freezes legacy writes;
  `grants:parity` CLI (exit 1 on any diff) is the flip gate.
- **Attribution**: workboard contacts (`acted_by_user_id`) and snoozes
  (`created_by_user_id`) threaded from the acting principal; manual sync
  triggers VERIFIED already attributed by Stage 7 4b's recordAudit.
- **Deferred to Task 6 ops, with reasons**: content_manager TS removal (a
  surviving prod row with the TS value removed would 500 response
  serialization — prod row check first), and the model-grant dashboard list
  UI (routes + history endpoint exist; Stage 33 owns admin UI expansion —
  minimal-surface rule).

The §5 grid runs live: chatter password login + the must-change flow end to
end, dual-credential parallel acceptance + expiry + revoke independence,
model grants reaching a page created AFTER the grant (grants read path) while
the legacy path correctly ignores them until the flip, stamped revokes
answering the access-history query, both read paths agreeing after
unassign, attribution rows populated.

Exit (Task 6): deploy 0065 → prod smokes (chatter login, dual-credential
round-trip, history query recorded, `grants:parity` = 0) → read-path flip →
content_manager row check → assignment-table drop ships a release later,
owner-acknowledged.

## Stage 23 Built — Workboard Becomes a Kernel Module, v1 Retired (2026-07-06)

**Decision #94:** Stage 23 built (§8 tasks 1–5) on the chain branch
(commits 377b528 → 4a4054a → 69baf3f → 6318372 → 2c9a124 on
`kernel/stage-21-event-stream-v2` — chain 19→20→21→22→23; standing ordering
deviation, deps 21+22 green-local). Full suite after the last commit:
**188 files / 1527 tests green** (the count drops from 193 because six v1
test files retire with the feature; one stage suite added). Migration
**0066** (workboard_claim_leases).

What shipped and the execution decisions inside it:
- **Module move + platform neutrality (Task 1).** The ten engine files
  git-mv'd byte-for-byte into `apps/runtime/src/modules/workboard/`;
  `resolveAccessibleWorkboardPage` replaces the Fansly-only accessor — the
  read-side platform throw is gone, so the OnlyFans boards the engine always
  scored now serve. The v2 route summaries drop the "Fansly page" wording
  (OpenAPI text-only).
- **Event-driven recompute; the sweep is demoted to reconciler (Task 2).**
  A worker-side domain-event-hub subscriber maps fan-relevant events
  (message.*/transaction.posted/subscription.*/presence.*/fan.* with a
  fanIdentityRef) to pg-boss jobs debounced per fan: singletonKey
  `<accountId>:<fanIdentityRef>`, startAfter 5 s — bursts collapse to one
  run. The job resolves the platform-native ref via findPlatformFan; an
  unknown fan is a recorded skip (the reconciler covers it). The nightly
  recomputeAllWorkboardPages now returns `changed` as the
  **workboard_reconcile_drift** counter (warn >0 / info =0; target zero).
- **Claim leases (Task 3).** Soft coordination, NOT access control (DP 4c):
  one live row per (page, fan); a second chatter's claim STEALS the lease
  (last-writer-wins, never blocks); release stamps; TTL default 30 min,
  request-capped at 240; expiry read-filtered. Routes are
  kind:"any-session" + scope:"page" (chatters claim their own work — page
  access is the boundary, not the dashboard door). Live claims ride the
  board response (`claims[]`); both sides audit via recordAudit
  (fan_claimed / fan_released — released only when a live lease existed).
- **Module-emitted domain events (Tasks 3+4).** `workboard.state_changed`
  on REAL tab transitions only (before/after snapshot incl. removals) and
  `workboard.contact_retracted` on undo — NAMING DEVIATION RECORDED: the
  spec wrote `contact.retracted`; namespaced to match state_changed. Both
  carry observationId **0 sentinel** (module-emitted, no source
  observation) and time-based dedupKeys (identical transitions can
  legitimately recur). `retractLastWorkboardContact` now returns whether a
  row was stamped — the compensating event is emitted only on true (undo of
  nothing is not a fact).
- **v1 retired (Task 5).** Consumer inventory gate passed: the four v1
  routes had dashboard-only consumers (desktop repo grep clean — spec §4
  re-verified). Routes, contracts, schemas, and types removed; absence
  pinned twice (contract test: no routeSchemas entry = 404; api.integration
  404 probe mirroring the crm-retirement precedent).
  `services/workboard.ts`, `services/workboard-presence.ts`,
  `repositories/workboard.ts` deleted; `unsnoozeWorkboardFan` moved
  VERBATIM into the v2 repository (the snooze v1/v2 duplication collapses
  to the module's). Dashboard: `/pages/:label/workboard` renders the v2
  board; `/workboard/v2` joins `/crm` as a legacy redirect; ONE
  platform-neutral sidebar entry (OnlyFans boards visible — §5 exit
  criterion). The v1 page + view-model/theme + four components die.
- **Presence panel consequence (recorded).** The v1 presence endpoint's
  on-demand Fansly follower refresh died with the panel; presence still
  flows through follower sync + OFAPI webhooks into
  `external_presence_at`, surfacing as the v2 board's `online` flag — the
  ofapi-presence suite now proves projection→board-online end to end.

Tests: stage suite (lease lifecycle incl. steal/expiry, claim/unclaim
services + audit + board surfacing, state_changed real-transitions-only,
contact_retracted once-only, OnlyFans board read, hub→job mapping with
relevance filtering + ordered-delivery proof, job-side fan resolution);
five suites moved off v1 (worker mocks, auth-policy matrix,
identity-grants attribution, api.integration, ofapi-presence).

Exit (Task 6 ops): deploy 0066 with the chain → staging latency harness
(p95 event→board within the 5 s debounce) → two-user lease drill → one
week of reconciler drift = 0 → prod 404 probe on the four v1 paths.

## Stage 24 Built — Desktop Becomes a Pure Kernel Client (2026-07-06)

**Decision #95:** Stage 24 built (§8 tasks 1–5) across BOTH repos in one
session. Desktop branch `kernel/stage-24-sdk-stream-v2` (off the stage-12
harvest tip): 8045339 → 0fbac28 → 05ad6de → 21ccd97 → 4b99d21 → 053ae24 →
4de27b3. Core (chain branch): ddbae06 → 1f2511e → f0680ee → 5cf9ef5 →
907315b. Suites after the last code commits: **core 188/1530**, **desktop
772 (shared) + 1223 (app)**, full `pnpm check` green.

Execution decisions and deviations:
- **SDK distribution = compiled vendored bundle** (core
  `scripts/vendor-sdk.mjs` → desktop `packages/kernel-sdk`, js+d.ts, zod the
  only dependency, contract hash + source commit in kernel-sdk.vendor.json).
  This implements Stage 20 Task 6's "bundle contracts runtime for external
  installs": consumers see declarations only (skipLibCheck), so their
  stricter compiler flags never re-litigate core source. Git-tag installs
  (DP 10) replace the MECHANISM at the release step — the `@kernel/sdk`
  import surface is identical. Core-side enablers: sdk-runtime optional
  props gained `| undefined` (exactOptionalPropertyTypes-clean), the
  network wrap now preserves abort/timeout in error.code, and the generated
  index re-exports the runtime surface (routeSchemas, stream helpers,
  cursor codec) that in-workspace consumers reached via contracts directly.
- **Task 1 (SDK delegation).** The 971-line hand client became a delegation
  layer behind the SAME HubClient interface/HubError taxonomy; per-timeout
  memoized SDK clients over a bridged fetch (no shared timeout slot to
  race); the HubFetch seam kept so every test fixture survived. Send-engine
  suites passed UNCHANGED (the done-check). Two leniencies died as drift
  now fails loudly: absent page fields / missing invalidCount are contract
  violations; a payload echo on command responses is contract-stripped
  rather than rejected (the desktop-state invariant holds by construction).
  The desktop's stricter parseable-completedAt gate was re-added on top of
  the contract element (core deliberately accepts and burns those as
  invalidCount; the reporter must pre-wire-reject).
- **Core-side v2 consumability (the #92 "payloads ride Stage 24" tail).**
  Serve-time only, ledger rows byte-identical, all additive (OpenAPI doc
  unchanged): frames carry fanRef/conversationRef/messageRef + accountRef
  (pages.ofapi_account_id); message.received/sent frames whose source
  observation is an OFAPI webhook message get `payload` = the SAME
  normalized message the v1 fanout serves (normalizeOfapiSyncMessage over
  the source observation; batched per replay page, order-preserving on the
  live path) — without it every live message would cost a read-gateway
  round trip (credits + latency = crown-jewel regression). **Typing rides a
  new `event: ephemeral` lane** forwarded from the v1 fanout hub: never
  ledgered (append-only is the wrong home for a 5-second hint), no id line,
  never advances the cursor, live-only.
- **Task 2 (stream v2).** hub-sync keeps its proven discipline verbatim
  (parser/watchdog/backoff/auth-stop/handle-then-checkpoint) and swaps
  protocol: opaque cursor under NEW key hubSync.v2Cursor (v1 lastEventId
  retained for the fallback window); mapDomainFrame translates canonical
  types onto the existing SyncEvent union so handleHubEvent is untouched;
  unknown types checkpoint without emitting (forward-compat rule —
  deliberate difference from v1's no-checkpoint on unknown). RECORDED
  MAPPING FACTS: readStateChanged was always local-only (server never sent
  it); subscriptions.renewed's v1 chat-list nudge has no ledger source —
  accepted loss, polling cadence covers it. v2 gap recovery = fresh-cursor
  handshake + per-account list-only head refresh through polling (the v2
  snapshot carries no projection pages per #92; the spec's "same
  page-and-apply structure" was written before that deviation).
  hubSyncProtocol ('v2' default / 'v1' fallback) rides the settings file,
  no UI, deleted after fleet confirmation.
- **Task 3 (device tokens).** One-time sign-in in Settings → Hub: main
  logs in, captures the session cookie off the raw response (no cookie jar
  in the main process), issues the device token through the SDK client's
  static-headers seam (label = machine name), stores keychain
  hubDeviceToken, logs the one-time session out. resolveHubCredential
  (device token preferred, chatter key fallback) feeds ALL hub consumers;
  the config fingerprint includes the resolved credential so issuance
  reconnects everything live.
- **Task 4 (direct-read removal, DP 8).** ofapiReadTransport collapsed to
  z.literal('hub') — readField's corrupt-row fallback IS the 'direct'
  coercion (pinned by test). ofapiKey left SECRET_NAMES and the COMPILER
  drove the full sweep (deeper than the spec's file list, recorded): Keys
  UI row, key-test provider, settings patch route, keyMeta entry, dev env
  seeding. deleteDecommissionedSecrets removes the keychain file on every
  boot — version rollback cannot restore direct reads (intended). Grep
  gate: 'direct' survives only in the AI transport enum (Stage 31) and the
  frozen outbox migration DDL (third legitimate remnant, recorded).
- **Task 5.** Break-glass + rollout runbook committed kernel-side
  (docs/runbooks/desktop-hub-outage-break-glass.md): kernel-down ⇒ local
  cache only; owner-issued temporary key never lands on chatter machines;
  team-key rotation after fleet confirm; macOS manual-update note;
  per-machine v1 flip instructions.

Exit (Task 6 ops): staged release one machine → 48 h → fleet; production
verification per §5 (zero desktop v1 SSE connections feeds Stage 25's
entry, read-gateway volume per machine unchanged, grep gates, one-week
chat-freshness watch); then kernel-side team OFAPI key rotation.

## Stage 25 Build Half — Scheduler Role, Ordering Proof, Golden Signals (2026-07-06)

**Decision #96:** Stage 25 tasks 1–3 built on the chain branch (077aa08 →
60110cd → 98d4819 → e76c866). Tasks 4–5 stay gated as specced: the
consumer-zero sweep + singleton-assertion removal + 2-worker rollout need
the Stage 24 fleet off v1 (prod verification), and the fanout_seq/v1
retirement migration is the owner-gated LAST step. Full suite after the
last code commit: **191 files / 1538 tests green**. Migration **0067**.

- **Scheduler role (Task 1).** resolveRole gains 'scheduler'; cron
  registration collapses into services/schedules.ts (the ONE place),
  invoked only by the leader-elected scheduler runtime (session advisory
  lock ns 58212, stateless standby retrying every 10 s). pg-boss v12 fires
  cron from any instance with `schedule: true` (the default — verified in
  the pinned version's source), so workers AND the api now construct with
  `schedule: false`; the scheduler is the one timekeeper. A leader whose
  lock session dies exits immediately (a successor may already be firing).
  The scheduler also creates queues (idempotent) so a fresh environment
  has no boot-order race. Compose gains the scheduler service; worker-2
  scale-out mechanics documented in place for the Task 4 rollout.
  FIX FOUND BY THE FULL SUITE: a terminated lock session left its pool
  client checked out — pool.end() hung; onDeath now destroys the corpse.
- **Ordering property harness (Task 2).** Three racing sweep runners over
  a live growing corpus across three accounts re-prove Stage 8's
  invariants under multi-runner churn (per-account seq gapless 1..K, dedup
  collapse to one event), including a runner dying mid-load. The
  real-process staging chaos drill (kill -9) is Task 4's ops step.
- **Golden signals (Task 3).** ops_metric_samples (p50/p95, minutely,
  rolling 14-day prune until Stage 28) + golden_signal_lag incident kind
  (pg enum + contracts). Five lags over a trailing 10-minute window:
  capture (webhook receipt→settle), canonicalization (observation→event),
  projection (backlog age above each watermark), command settle
  (enqueue→finalize), SSE delivery — EXECUTION INTERPRETATION RECORDED:
  the smoke checkpoint keeps no per-frame receipt stamps, so SSE delivery
  = checkpoint staleness (bounds the same failure mode: a wedged
  consumer). p95 thresholds flip the existing incident latch (one alert
  per state change); GET /api/v1/ops/metrics (monitoring gate) serves the
  series + thresholds + smoke counters. Cron rides the scheduler; the
  sample job runs on workers.

Exit (Tasks 4–5, ops/owner-gated): golden-signal baselines recorded on
the singleton topology BEFORE the rollout; staging two-worker soak +
chaos drill; consumer-zero sweep over v1/fanout_seq/sync_event; singleton
assertion deleted; 2 workers + scheduler live in prod; then the
retirement migration (fanout_seq + sync_event columns dropped) under
explicit owner go.

## Stage 27 Built — Money Codec, Footgun Class Dead by Construction (2026-07-06)

**Decision #97:** Stage 27 tasks 1–3 built in one session on the chain branch
(06a06d9). Task 4 is ops (deploy → report-totals byte-diff for a fixed
window → CI gates). Full suite after the commit: **192 files / 1548 tests
green, unchanged expectations** (the spec's "any expectation change = a bug
found" held — none changed). No schema change, no data migration (Q6).

Execution decisions:
- Brands are compile-time only: Mills = bigint brand; **MicroUsd = number
  brand** (recorded adaptation — the spec sketched bigint, but
  cost_micro_usd is an int column flowing as JS number everywhere; a bigint
  brand would have been churn masquerading as safety).
- **ONE already-mills constructor** (`millsFromInteger`) absorbs the deleted
  `toMills` byte-for-byte, instead of the sketched `millsFromDbBigint` —
  pg returns numeric columns as strings and Fansly hands mills-native
  numbers, so three near-duplicate constructors would have re-created the
  ambiguity the stage kills. The audit classified ALL 27 toMills call sites
  as already-mills (repo rows; Fansly wallet balances, subscription prices,
  transaction amounts — Fansly is mills-native on the wire); none parsed
  dollars.
- `dollarsToMills` survives as an honest ALIAS of `millsFromDollars`
  (~80 call sites; the name states its unit — churn without safety gain).
  `millsFromCents` bridges the _cents column (×10); the column itself stays
  cents per the spec's accepted-debt ruling.
- Four float sites rewrote through the codec with value-preservation
  property tests: ofapi-dm-archive usdToMills (pinned over 2-decimal wire
  dollars — the domain where Math.round(x*1000) and the toFixed(3) parse
  agree exactly), telegram whole-dollar rounding (millsToRoundedDollars),
  snapshot + workboard mills→dollar numbers (millsToDollarsNumber).
- AI plane: pricing result typed MicroUsd via microUsdFromDbInt; converters
  millsToMicroUsd (exact) / microUsdToMills (lossy, truncation named).
- Enforcement: eslint no-restricted-syntax bans toMills reintroduction; the
  float-site ratchet rides the TEST SUITE (tests/money-ratchet.test.ts vs
  scripts/money-float-budget.json, budget 9, only decreases) — first
  burn-down target recorded: ofapi-dm-sync's dollars→cents write. Boundary
  suffix audit: contracts money fields all unit-suffixed already; the
  pattern matches were counters — no additive twins needed.

Exit (Task 4 ops): deploy with the chain → §1 report-totals snapshot
re-run, diff = 0 (dashboard revenue endpoints + Telegram digest, fixed
window) → grep-zero + gates green in CI.

## Stage 18 Started — Platform Seam Live in the Dispatch Path (2026-07-06)

**Decision #98:** Stage 18 tasks 1 + 6 complete, task 2/3's handler SPLIT
done (relocation pending), on the chain branch (e24fa9c → 8a7b08d).
Ordering deviation recorded: dep Stage 15 = the owner's OnlyMonster
subscription cancel (commercial action); its verify-zero half EXITED with
Stage 5 (#67, zero rows/streams/egress), so code-side work is safe. Full
suite after the last commit: **193 files / 1555 tests green**.

- **packages/platform-core** (target §4.1): PlatformAdapter /
  PlatformCapabilities / SessionCustodyDescriptor + createPlatformRegistry
  + a two-way conformance check (declared streams ↔ pull handlers).
  RECORDED DECISIONS: capabilities.streams speaks TODAY'S sync-stream
  vocabulary (the DB sync_stream enum owns those names; the target's
  canonical renames are a separate later migration — mapping in the
  package README); the pull-handler type is the adapter's generic
  parameter so platform-core stays app-agnostic (executor types live in
  apps/runtime, where the two adapters are assembled —
  apps/runtime/src/platforms/registry.ts).
- **The registry is live in the dispatch path**: executeStreamChunk's
  stream switch became registry dispatch — an undeclared stream for a
  platform now fails loudly instead of running the wrong platform's
  handler (the old switch ignored the platform entirely). Capabilities are
  parity-pinned against getSyncStreamsForPlatform + resolveStreamsForScope
  (drift fails the suite before Task 4 swaps the planner over).
- **All six mixed handlers split per platform** (light, top_spenders,
  transactions, subscribers, dm_conversations, dm_messages) — branch
  bodies verbatim, narrowing kept via assertion guards (`!==` — invisible
  to the ratchet by design: assertions, not branches), the transactions
  windowing prelude duplicated into both halves. Per-platform pull maps
  route straight to the halves; the old execute*Chunk names remain as
  compat shells for the three platform-agnostic test suites.
- **Ratchet**: scripts/check-platform-branches.mjs vs
  platform-branch-budget.json — day-one strict `platform ===` count
  recorded: **64** (self-excluding the ratchet's own test); wrapped into
  the registry suite.

REMAINING (next sessions): test re-point + shell deletion (ratchet drops);
exclusive-handler relocation into platforms/ modules; Task 3 —
onlyfans-ofapi adapter assembly (webhook/commands halves) + OnlyMonster
deletion (packages/onlyfans + bootstrap adapter/onlyFansAdapter fields +
AdapterLike); Task 4 — planner capability wiring (NOTE:
getSyncStreamsForPlatform's page-sync.ts:902 use is db-package-internal —
app callers move to capabilities, the db-internal list stays pinned);
Task 5 — platforms reference table + 7-column enum→text migration
(staging rehearsal + reverse REQUIRED before prod); Task 7 ops.

## Stage 18 Build Side Complete — OnlyMonster Deleted, Enum Retired (2026-07-06)

**Decision #99:** Stage 18's build half is complete on the chain branch
(c8d93d0 "18.5 OnlyMonster deleted" → a476139 "18.6 platforms reference
table"). Two commits, −7,742 lines net on the first. Physical
handler-relocation is DEFERRED (recorded below) — the seam's semantic
guarantees are all live and test-pinned.

**18.5 — OnlyMonster deletion (Task 3 tail):**
- `packages/onlyfans` deleted whole (adapter, mappers, errors, types) +
  workspace dep + `ONLYMONSTER_BASE_URL` config key/registry row.
  `onlyFansDefaultDelayMs` KEPT — the sync rate-limiter still paces
  OF egress with it (platform pacing, not vendor plumbing).
- `bootstrap.ts`: `onlyFansAdapter` field/construction/close gone.
  `adapter: AdapterLike` (Fansly) KEPT for now — its retirement rides the
  relocation leg (below), where the registry becomes the only adapter
  surface.
- **OF pages resolve token-less**: `resolvePageContext`'s OnlyMonster
  decrypt arm died; OF pages return `{ auth: { token: "" }, proxy,
  egressKey }` without requiring stored credentials (they have none).
  `resolveExecutorPageContext` = pure delegation now.
- **Credential surfaces re-pointed to OFAPI-era semantics:**
  verify-credentials matches `ofapi.listAccounts()` by username
  (route + test); update-credentials OF variant → 400 ("no stored
  credentials to update"); page proxies → 400 for OF (egress is
  vendor-side); CLI `page add onlyfans` lost --token-file/--proxy-*.
  Contract OF variants shrunk accordingly (createPage = {platform,
  username(+modelSlug,label)}; updateCredentials = {platform} tag only).
- **Failed-payload mapper tag** `onlymonster-phase3-v1` kept byte-identical
  as a local constant in sync/shared.ts (recorded rows stay comparable);
  honest re-tagging for OFAPI streams can ride a later leg.
- Tests: OFAPI-era onboarding fixtures (happy path also pins an EMPTY
  credential vault; ambiguity → 409 — the old "first match wins" behavior
  is deliberately dead; tx atomicity re-proven via the
  pages_ofapi_account_uniq constraint firing mid-transaction); OnlyMonster
  adapter/lookup/mapper/token-file tests deleted; sync-handlers pins the
  transactions skip stub (webhook-sourced). Ratchet 55 → 48.

**18.6 — platforms reference table (Task 5):**
- Migration 0068: `platforms(key, display_name, adapter_version)` seeded
  fansly/onlyfans; the 7 enum columns (pages.platform, fans.platform,
  dm_message_archive.platform, sync_http_attempts/sync_run_events/
  sync_rate_limits/page_fan_external_notes.provider) → text USING ::text
  + FK to platforms(key); DROP TYPE platform last.
- **Rehearsed locally on postgres:16: up → down → up, all clean.** The
  down file lives at docs/runbooks/0068-platforms-reference-down.sql (it
  CANNOT live in packages/db/migrations — the runner pattern-matches and
  applies every .sql there, and its filename regex rejects dotted
  suffixes). Staging rehearsal on a prod copy before deploy remains
  OWNER-GATED (passport rule).
- Drizzle: platformEnum died; columns are text(..., {enum}) so TS
  narrowing is unchanged; workboard-v2's raw `'fansly'::platform` casts
  dropped (type gone). GOTCHA fixed: the integration reset helper
  truncated ALL public tables — platforms is reference data pages FK
  into, so resetIntegrationDatabase now excludes it.

**RECORDED DEVIATION — relocation deferred:** the spec's remaining build
items (§2: handler bodies into packages/fansly-adjacent +
packages/onlyfans-ofapi modules; AppContext.adapter retirement with ~31
consumers re-pointed; webhook/commands halves declared on the adapter;
shared/types platforms const → registry-derived) are pure file/naming
motion with zero semantic delta — the isolation properties they serve are
already delivered by the split halves + registry dispatch + conformance
pins. Doing that churn mid-chain, right before Stage 26 rewires the same
modules' transport layer (resolveEgress), would move the same lines twice.
It goes to a dedicated mechanical session (compiler-driven), possibly
folded into Stage 26's entry. Wiring an adapter `webhook/commands` surface
NOW, with no consumer re-pointed to it, would be API surface without users
— declined on scope discipline.

**Stage 18 remaining after this:** relocation leg (above) + Task 7 ops
(staging rehearsal of 0068 on a prod copy, staged deploy Fansly-first,
48 h telemetry diff) — owner-gated.

**Full suite after the last code commit: 186 files / 1512 tests green**
(chain tip 24dee3e). The suite itself earned its keep twice on the way:
run 1 caught two stale pins still exercising the retired OnlyMonster
credentials arm of the metadata backfill (re-pinned to OFAPI-only
semantics in 24dee3e), and the first post-migration run caught
resetIntegrationDatabase truncating the platforms seed rows. File/test
counts dropped vs #98 (193/1555 → 186/1512) because OnlyMonster's own
test files went down with the package — deletions, not regressions.

## Stage 26 Build Half — Egress Seam, Class Pacing, Auth-Dead Pause (2026-07-06)

**Decision #100:** Stage 26's build side on the chain branch (d7ea175
"26.1 resolver+pacer+ratchet" → ed99b16 "26.2 auth-dead pause"). Ordering
deviation as #98/#99: built on green-local Stage 18 (dep). Tasks 1/2/4/5
complete; Task 3 PARTIAL (recorded below); Task 6 = ops.

**26.1 — the egress seam (Tasks 1+2+5):**
- packages/platform-core/egress.ts owns the SHAPE (EgressScope page|vendor,
  EgressContext, three priority classes); services/egress/resolver.ts is
  THE resolver with the recorded address policies: page scope = the page's
  proxy identity; vendor "ofapi" = vendor-direct (today's behavior, now
  written down instead of being an accident of bare fetch); vendor
  "fansly" = REFUSED (Fansly egress is direct-to-platform and must be
  page-scoped by construction). No default path — unknown scopes throw.
- **Pacing design decision (the naive version FAILED its own property
  test):** the existing reserve primitive pushes every locked row to
  scheduledAt+spacing, so a single-pass [vendor, class] reservation drags
  the vendor horizon out to bulk's backlog — interactive gained nothing.
  The mechanism that works is TWO-PHASE BULK: bulk waits out its own class
  row first, then claims the vendor row only when the send is imminent.
  Bulk's entire backlog lives in class:bulk; the vendor row only ever
  holds imminent sends; interactive pays in-flight sends, never the queue.
  Aging floor = claim-at-reservation (later arrivals can't push scheduled
  work). Vendor caps preserve today's effective rates (ofapi 500 ms;
  fansly 0 — there IS no cross-proxy Fansly cap today and seeding one
  would newly serialize proxies; the row exists as a knob).
- Migration 0069: sync_rate_limits.priority_class (additive, default
  'bulk').
- OFAPI client lanes: reads=interactive, commands=commands, list
  sync=bulk; admin request() stays unpaced (today's behavior). Rollout
  knob EGRESS_PACER_MODE off|shadow|enforce (default off — deploy inert;
  registry row added). Shadow computes the class-aware decision
  fire-and-forget — zero latency added, failures swallowed, diff logged as
  component=egress_pacer_shadow.
- Enforcement: undici value-import lint wall (egress modules +
  shared/http-client + pre-seam fansly adapter exempt; flat-config gotcha:
  the wall lives INSIDE the existing no-restricted-syntax rule because a
  second block would silently replace the toMills ban for overlapping
  files) + scripts/check-raw-fetch.mjs ratchet, day-one budget 13
  (ofapi 7 + fansly adapter 1 = Task 3 targets; telegram 4 + anthropic 1 =
  recorded non-platform exceptions). ofapi-fan-identities' local `fetch`
  closure renamed fetchPage (ratchet false positive).

**26.2 — auth-dead pause (Task 4, re-scoped per the spec's status header:
detection was already typed, the SEMANTICS were the gap):**
- pausePageSyncForAuth: whole page → FSM paused + blocker_kind='auth'
  stamped. The stamp is the reversibility contract:
  clearPageSyncAuthBlock (already in the re-verify recovery path) matches
  exactly the auth pause and never touches deliberately-paused streams
  (top-spenders/dm-polling feature gates).
- Direct-sync 401/403: executor parks the FULL stream set after the fenced
  per-stream block (before: one stream blocked, the rest kept burning
  against dead auth). Via getSyncStreamsForPlatform, NOT the registry —
  executor→registry would deepen the registry⇄executor-handlers value
  cycle (and broke sync-executor.test.ts's closed module mock; caught
  in-session).
- OFAPI accounts.*: action-required statuses pause; connected/reconnected
  release (vendor-signaled re-verify); session_expired stays alert-only.
- Commands fail fast: auth-dead page settles failed_terminal
  (ofapi_auth_action_required) BEFORE any HTTP — one-attempt discipline
  untouched, the attempt is never spent. Gated on
  OFAPI_ACCOUNT_HEALTH_ENABLED (stale ofapi_auth_status must not fail
  sends when the projection isn't running).
- Pinned: planner drops the paused page within one cycle
  (listRunnablePageSync), both resume paths, no-HTTP fail-fast.

**RECORDED — Task 3 partial:** the three behaviors' ADDRESS policies are
now explicit in the resolver and their PACING lanes ride the pacer hook
(shadow/enforce). The remaining physical adoption (createOfapiClient
requiring an EgressContext input; the Fansly adapter receiving transports
from the resolver instead of building dispatchers from the same factories)
is deferred to the mechanical relocation session shared with Stage 18's
deferral (#99) — the same modules move; identical factories mean identical
addresses today, and the ratchet (13→0 trajectory) keeps the debt visible.

**Task 6 ops (owner-gated):** deploy inert (0069 additive, mode=off) →
flip shadow → 48 h diff review (egress_pacer_shadow logs) → per-vendor
enforce cutover → staging saturation proof (interactive p95 flat under
bulk) → auth-dead drill (staged credential kill or next natural death).

**Full suite after the last code commit: 189 files / 1528 tests green**
(chain tip 4e2dcdd). The ratchets guarded their own stage: the first full
run caught the resolver's platform ternary raising the Stage 18 branch
count 48→49 — replaced with a vocabulary map (followup 4e2dcdd).

## THE BIG DEPLOY — Chain 0057–0069 Live in Prod (2026-07-06)

**Decision #101 (owner-directed "deploy and do what you need"):** the entire
built backlog — stages 8, 9, 10, 11, 12-glue, 14, 16, 17, 19, 20, 21, 22,
23, 24-core, 25, 27, 18, 26 — merged to main (fast-forward 05b6f3e →
aa522c8 + deploy-prep commits) and DEPLOYED to prod in one pass, migrations
0057–0069. Owner point-confirms per gate (deploy scope + shadow flip; probe
credential; six flag flips) — the #70 pattern held throughout.

**Pre-deploy evidence:**
- Stage 7 reconcile snapshot (28 h window, deploy moved earlier by owner):
  pull 11 producers both platforms, webhook 10.7k; `operator` source proven
  LIVE by the probe-credential audit rows (user.created + api_key.issued);
  `command_result` wired-but-no-traffic (watch: first natural desktop send).
  Formal 48 h close-out stays post-hoc queryable (observations timestamped).
- p95 baseline (20 gateway reads, probe chatter key): p50 0.964 s / p95 1.869 s.
- **0068 rehearsal on a REAL prod copy** (passport): server-side dump→restore
  into kernel_rehearsal (7.1 GB), migrations 0057–0069 forward clean, 0068
  9.6 s (432k sync_http_attempts rewrite — the prod lock window), DOWN-path
  proven (enum restored), re-apply 9.4 s. Rehearsal DB dropped after.
- First-ever OFF-BOX BACKUP: 3.0 GB pg_dump -Fc on the dev machine
  (scratchpad; 37 min over SSH). The accepted no-backup risk now has one
  point-in-time exception.
- Deploy-prep commit 4363d3c: the FIRST production build since Stage 18
  caught three stale packages/onlyfans refs (build-production.mjs,
  deploy-production.sh manifest/overlay/dist-Dockerfile, Dockerfile) and
  Buffer in the SDK cursor codec (dashboard tsc) → isomorphic
  TextEncoder/btoa rewrite, suites green.

**Deploy:** full image build (lockfile changed), nohup-detached (tool
timeouts must never kill a stack recreate). EGRESS_PACER_MODE=shadow set in
.env.production pre-restart (Stage 26 48 h shadow window started at deploy).
Stack recreate brought up agency-hub-scheduler-1 (Stage 25 role; compose
synced by the deploy script). Migrations applied at boot (advisory-locked):
schema_migrations 69, platforms seeded, enum platform GONE.

**Post-deploy verification:**
- Scheduler: leadership acquired, schedules registered, timekeeper running.
- Golden signals sampling (ops_metric_samples rows within minutes).
- p95 after: p50 0.962 s (byte-flat) / p95 1.059 s (improved) — Stage 9's
  capture tee costs nothing. read-gateway captured EXACTLY 20 observations
  for the 20 probe reads (1:1 — Stage 9 exit evidence). Probe key revoked.
- Shadow pacer logged 20 egress_pacer_shadow decisions (Stage 26 lane live).
- archive:backfill ran (2 archive + 34 hot batches).
- Workboard v2 serving (deploy script's same-origin dashboard check).

**LIVE DEFECT FOUND AND FIXED WITHIN THE HOUR (2dc8e3f):** the first sweep
appended 1,428 events — all PULL-family. The golden-signal canonicalize
breach fired immediately (Stage 25's alarm working as designed) on a stuck
4,000-row re-scan loop: webhook observations journal with account_id NULL
and only the vendor ref (native_account_ref = acct_…, capture-first by
design), but the sweep's unmapped check read row.accountId — the ENTIRE
webhook corpus (11k rows) skipped forever, and the keyset scan burned its
whole page budget on the same stuck rows (new observations starved). Fix:
the run context builds an inverse page map (platform-scoped over BOTH
platform_account_id and ofapi_account_id — OF pages' external id is empty
in the OFAPI era) and the driver resolves the ref before the check;
genuinely unmapped refs keep the skip-and-retry self-heal. Pinned by a
prod-shape test. Redeployed (dist-only path): backlog fully drained in 3
ticks — 10,836 events, live lag 55 s, tip.received events present,
remaining 1,988 pending rows = undeclared kinds (typing) by design.

**Staged flips (owner-confirmed, runbook step 6), written with audit rows:**
fanslyFanEarningsSyncEnabled + fanslyPurchaseHistorySyncEnabled +
fanslyNewStreamPageAllowlist="lilly-1,lilly-2" (Stage 16 lilly ramp),
fanslyDeepBackfillIgnoreRetentionLimit (Stage 17),
ofapiChargebacksReconcileEnabled + ofapiFanIdentitiesSyncEnabled (Stage 14,
boot-apply → worker bounced). GOTCHA: SSH heredoc quoting silently wrote
NOTHING on the first attempt (verify-after-write caught it); file+scp+psql -f
is the reliable path.

**Ops watches armed:** Stage 7 48 h close-out (~01:50 UTC 07-07, post-hoc
query); first natural command_result; Stage 16 shapes on lilly pages;
chargebacks first run 03:10 UTC; Stage 26 shadow diff review (~48 h);
Stage 19 would-deny log window → enforce flip; Stage 8/9/10 telemetry
windows per stage Progress blocks; desktop fleet x-client-version (07-12).

## Stage 28 First Slice — Ops Retention Bounded, Prune Returns Gated (2026-07-06)

**Decision #102:** Stage 28 Task 5 built and deployed same-day (1f8ead8;
suite 191 files / 1531 tests green). The other half of the deploy day: the
by-model earnings view (owner request — overviewRevenueByModel endpoint +
Overview "Earnings by model" card with trend sparklines) shipped in the
same window (7c4f81e + closed-mock followup 7ee5494).

- **sync_runs bounded** — the reverse-direction retention bug (unbounded
  growth, no deleter) closed: 30-day sweep, 'running' rows exempt,
  children cascade, raw payloads keep rows and null the link. 0070 index.
- **ops_metric_samples** 90 days (was the 14-day Stage 25 stopgap).
- **Prune = cache policy again**: flag default ON (kill-switch semantics
  kept one release), runtime-gated on archive coverage (archive ≥ hot per
  conversation, cached 15 min, fails closed, logs held-state). Prod env
  pins nothing → the coverage query is now the deciding gate in prod.
- **Redaction switch retired for good** — flag, sweep arm, repo fn
  deleted; terminal command payloads are permanent business facts.
- **Deleter enumeration** — the sanctioned scheduled deleters are exactly:
  30d observability sweep, 90d samples prune, coverage-gated DM cache
  prune, pg-boss archival. Any new SQL-deleting file fails the pin test.

**RECORDED for Task 1:** DuckDB ships as a runtime dependency (the
scheduler container runs exports); nothing is tierable until ~2027-01
(6-month hot window over data that starts 2026-07) — the tiering job lands
drill-tested on synthetic partitions ahead of need.

## Stage 28 Build Push — Tiering + Restore Drill + Metrics Models (2026-07-06)

**Decision #103:** same-day continuation of #102 — Stage 28 Tasks 1, 2, and
3's first slice built and drill-proven (d63b7ae → 82bbc63 → a066b48 +
build fix 5c505a3); deployed with the retention slice.

- **Tiering (Task 1):** export→verify→detach in that absolute order;
  detached partitions PARK in tiered_pending_drop — no DROP exists in code
  (owner-gated behind the drill, §6's one irreversible step). Exporter =
  NDJSON → DuckDB COPY TO PARQUET with explicit per-table schemas.
  postgres_scanner REJECTED (recorded): extension install needs network at
  run time; json+parquet ship inside @duckdb/node-api and work offline in
  prod and Testcontainers alike. Restricted kinds (desktop.guard_audit)
  export to lake/restricted under the same manifest/verify discipline.
  GOTCHAS BANKED: @duckdb/node-api must be a RUNTIME dependency (the
  scheduler-fired worker job runs exports) AND an esbuild external (native
  bindings can't bundle — the deploy's full image build caught it);
  ATTACH PARTITION demands LIKE … INCLUDING ALL (CHECK constraints);
  identity columns need OVERRIDING SYSTEM VALUE on restore.
- **Restore drill (Task 2):** from Parquet alone — staging rebuild, counts
  vs manifest AND the parked table, re-attach. The DROP gate is automated;
  the parked originals stay untouched until the owner rules.
- **Metrics models (Task 3 slice):** net_revenue_daily reconciles EXACTLY
  with revenue_daily (pinned — this is Stage 33's serving-swap gate);
  fan_ltv; response_sla. Models read hot Postgres only until lake data
  exists (~2027-01) — recorded, the lake UNION is additive then.
- Nothing is tierable in prod until ~2027-01 (hot window 6 months over
  data starting 2026-07): the daily 04:40 UTC cycle no-ops until the first
  partition ages out, with the whole path already drill-tested.

**Remains in Stage 28:** Task 4 (erasure CLI + erasure_log migration) and
Task 6 ops (first prod cycle, plateau watch, §5 exit criteria).

**Decision #104 (2026-07-06, session continuation):** Stage 28 **Task 4
built and drill-proven** — the audited break-glass erasure. `erasure:run`
CLI (dry-run default; `--execute` demands `--confirm <scopeRef>` verbatim),
migration 0071 `erasure_log`, `services/erasure/`. Build order within the
stage held: the erasure lands only after tiering existed, because erasure
must reach EVERY plane history can live in — hot tables, attached ledger
partitions, **detached-but-parked tables in tiered_pending_drop** (a
parent-table DELETE never reaches those — caught at design time), and the
Parquet lake (filter-out rewrite, manifest re-checksum, an `erasures[]`
record inside the manifest).

- **Semantics rulings (recorded):** catalog rows (models/pages/users)
  survive — erasure removes captured facts and derived projections, not the
  agency's own records; offboarding is a different act. The `fans` row IS
  captured identity and goes. Fan-scope transactions are ANONYMIZED (fan
  linkage + vendor identifiers nulled), never deleted — the money moved and
  aggregates must stay truthful; page/model scope deletes the page's
  transactions outright.
- **No post-erasure projection rebuilds** — deliberate deviation from the
  stage doc's letter: once partitions tier, a full account rebuild replays
  hot events only and would DESTROY projection rows sourced from detached
  months. Erasure purges projection rows directly; non-resurrection is
  structural (source observations/events are gone) and the drill proves it
  by replaying projections after the erase.
- **Observation exclusivity:** an observation dies only if no OTHER fan's
  events reference it; shared batch captures survive and are counted in
  plan + tombstone (`sharedObservationsKept`) — residual risk visible, not
  hidden. Undeclared kinds (parse_version 0) are reached by payload text
  match (quoted-JSON always; bare-numeric with boundaries).
- **Loud-failure curation:** the fan-FK stance is introspected from
  pg_constraint at run time; an unmapped non-cascade FK to `fans` fails the
  plan with the table name — a new table can't silently join the fan graph
  without an erasure ruling. (fan_earnings_stats RESTRICTs fans — cleared
  before the fans row by curated order.)
- **Audit is service-level dual-write:** audit_events + operator
  observation with account_id NULL — the erasure's own trail is
  structurally unreachable by a re-run of itself.
- **Drill (tests/erasure.integration.test.ts):** synthetic fan A vs
  bystander B on one page, facts across every plane including a parked
  partition and lake parquet+manifests; dry-run plan == executed counts
  EXACTLY; B and the shared observation survive; manifests re-stamped with
  fresh checksums; idempotent re-run converges to zero everywhere.
- **Gotchas banked:** drizzle sql`` expands arrays to `($1, $2, …)` — write
  `in ${arr}`; `any(${arr})` and `in (${arr})` both break (malformed array
  literal / record comparison). A negated ledger pred needs
  `not coalesce((pred), false)` — NULL conversation_ref silently ate the
  shared-lineage guard under three-valued logic.
- retention-deleters allowlist gains services/erasure as the ONE sanctioned
  non-scheduled deleter.

**Remains in Stage 28:** Task 6 ops only (first prod tiering cycle
~2027-01, plateau watch, §5 exit criteria). Erasure stays unused until a
real request; the drill is the rehearsal.

**Decision #105 (2026-07-06, same session as #104):** Stage 29 **Tasks 1–5
all built green-local** — AI gateway hardening + the DP 6-A restricted
capture class. Migration 0072. Key rulings:

- **generation_ref = the gateway's existing requestId** (already exposed on
  the meta frame) — assumption 3 verified, no envelope change; it is the
  acceptance correlation key end-to-end.
- **user_id NULL = system lane** on ai_usage_events (DROP NOT NULL, the
  Stage 9 credit-ledger precedent) — the classifier's nightly spend books
  without a synthetic user.
- **Denials are ledger facts:** every quota/budget breach writes a
  quota_denied row AND throws the typed error (HTTP 429 `quota_denied`).
  Client-visible taxonomy change recorded: gateway quota paths no longer
  return `rate_limit_exceeded`. Quota 429 still outranks
  provider-unconfigured 503 (pre-Stage-29 ordering preserved; reservation
  rows carry provider NULL until one resolves).
- **Per-feature budgets are GLOBAL per day** (JSON config map), not
  per-user — the point is "the nightly classifier run fits", and the
  per-user/page daily quota already exists one layer up.
- **Classifier egress stays DIRECT** (no page proxy) in the internal lane —
  byte-identical to the retired SDK call; prompts/model/params carried over
  byte-for-byte; @anthropic-ai/sdk now import-banned outside the gateway
  provider files (ESLint paths ban + importer-list pin test).
- **Acceptance feed is a projection, not a canonicalizer** — acceptance
  rows are a side table, not domain events; the pure-parser discipline of
  the canonicalize driver stays intact. Watermark = account_id 0 sentinel
  over observation ids; correlation best-effort until Stage 31.
- **All outcomes captured** in ai_generation_content (a cancelled stream's
  partial completion is still a fact); restricted tables lake-excluded by
  construction (pin test) and inside the erasure reach (fan scope via
  conversation_ref, page scope via page_id).
- **OpenRouter with no vendor SDK** — fetch-based SSE through the SAME
  page-proxy fetch wrapper as Anthropic (raw-fetch ratchet stays 13);
  prefix routing; ships implemented-but-unkeyed until OPENROUTER_API_KEY
  lands; pricing catalog is provisional pending the §5 invoice week.
- ai-usage batch lane marked deprecated (successor = gateway finalize;
  removal gated on Stage 31 fleet cutover).

**Remains in Stage 29:** Task 6 ops (deploy 0072+0071 together, §5 probes,
invoice reconciliation week). NOTE: Stage 28.4 (#104) is committed and
pushed but NOT yet deployed — the deploy gate needs an owner confirm; 0071
and 0072 ride the next deploy window together.

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

**Decision #108 (2026-07-06, owner-confirmed):** Stage 30 **prompt freeze
DECLARED and parity SIGNED OFF.** The owner confirmed both gates in one
structured confirm: (a) production deploy of the built backlog (0071
erasure_log + 0072 AI restricted class + 0073 ai_personas + Stages
28.4/29/30 code), (b) the prompt freeze — no tuning in either client repo
until parity sign-off.

**Parity sign-off (passport rule: assembled prompts, not outputs):**
- Freeze guard: desktop HEAD == frozen snapshot 1db76a4ae13d; all 24
  migrated files' SOURCES re-hash exactly to the manifest's recorded
  sha256 values.
- Assembly parity: 9 fixtures across all seven features (tone/mode
  branches, draft, ping segments, fan bio) — kernel `buildPrompt` output
  is BYTE-IDENTICAL to the live desktop `buildPrompt` imported from the
  sibling checkout. Zero differences.
- Harness: tests/ai-feature-parity.test.ts (skips where the sibling repo
  is absent) + the authoritative runnable
  `node --import tsx/esm scripts/ai-parity-signoff.ts` (exit-coded).
- CAVEAT recorded: this proves ASSEMBLY parity. Context-VALUE parity for
  the three named loader gaps (PPV purchased-state, ledger-derived sums,
  media labels) is a Stage 31 cutover checkpoint against live traffic —
  the harness level is what the passport requires for this stage's exit.
- `ai:personas-seed` CLI upserts the bundled personas into ai_personas
  (idempotent; run post-deploy).

Client cutover stages (31/32) are now unblocked on the parity side.

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

**Decision #111 (2026-07-06):** Stage 31 BUILD COMPLETE (Tasks 1–4) on
desktop branch `kernel/stage-31-ai-cutover` @ 40e8e65 — the desktop's
local AI machinery is deleted; the kernel feature lane is the only path.
Highlights: the deletions sweep (a5ca0a0, −10,693 lines: shared prompts/
+ llm/, provider clients, both legacy gateway lanes, context loader,
model-selector UI; `aiGatewayTransport` collapsed to
`z.literal('feature')` — the ofapiReadTransport precedent, third and
last application); acceptance lifecycle (shown/copied/inserted/
sent+edited) on the Stage 11 capture spool with the
operationId+requestId correlation pair; personas as kernel CRUD with the
local KV as offline cache; spend priced by the gateway usage frame (the
mapGatewayUsage costMicroUsd omission caught and fixed in f3e9bfc —
coordinator tests had injected cost directly and masked it); vendor keys
decommissioned (out of SECRET_NAMES, secret files deleted on boot —
unrecoverable by rollback; KeySettings dead; the hub connection probe,
collaterally deleted by the sweep, rebuilt hub-only); usage lane in
drain mode (no producer; reporter kept one release for parked rows;
db.counts.usageEvents in the diagnostics export is the drain gauge).
Suites 538 + 1100 green; 3 grep gates pin the cutover. NOT RELEASED —
Task 5 (pilot workday → staged fleet 0.1.31 → §5 verification → owner
comms + upstream vendor-key revocation) is owner-gated and additionally
gated on 0.1.30 fleet adoption.

**Decision #112 (2026-07-07):** Dashboard REBUILD instead of modernization —
owner decision superseding Stage 33's incremental approach ("visual behavior
preserved, response shapes unchanged"). The owner wants a FULL NEW dashboard,
designed and built in its own Claude session with its own PRD; the current
`apps/dashboard` is DEPRECATED — it keeps serving until the new one reaches
parity sign-off, then is deleted. Stage 33's substantive requirements carry
over as PRD inputs, not as constraints on shape: reports served from the
Stage 28 metrics models, grants + device-token admin UI, erasure UI
(owner-only, dry-run-first), golden-signals page, live updates over stream
v2 instead of the 18 polling timers. Launch prompt:
`docs/project-kernel/prompts/prompt-dashboard-rebuild.md`. The Stage 33
in-flight branch (kernel/stage-33-dashboard, unpushed: the useKernelEvents
bridge + polling-site sweep) was ABANDONED; its verified ground truth
(polling inventory, the v2 event-lane facts) is preserved in the launch
prompt instead.

**Deploy log (2026-07-06/07, owner-run chain "deploy, check, test, release"):**
dist-only deploys of main → prod (three passes: f4ae42e enablers; 26a5b2e
window params; 535cfb8 the walk). Verified: health green; the Fansly
feature smoke on lilly-1 generated end-to-end with the captured prompt
containing "Fansly" and ZERO "OnlyFans" (named substitution live);
top-spenders route serving (401 unauth). FOUND + FIXED (the Stage 16 ramp
doing its job): fan_earnings capture never returned data — Fansly's
earnings endpoints answer PER FAN (correlationAccountId); a windowed call
without one returns [] (probe-confirmed: with a fan id → 21 rows). Capture
reworked as a spender-scoped checkpointed walk (page_fans net>0, two calls
per fan, concatenated chunk journals). purchase_history remains blocked on
its own param contract (order-history wants accountMediaId — the per-fan
walk shape needs rework; circuit breaker failing loudly as designed).
Desktop fleet-version telemetry was reset by the container restarts —
0.1.30 adoption check pending fresh traffic.

**Extension 1.6.0 RELEASED (2026-07-06 ~19:40 UTC):** signed xpi live on
https://ext.gosling-agency.ru/updates.json (sha256:0729e450…, gecko ≥142,
753 KB). The Stage 32 cutover ships: kernel-only AI (vendor host
permissions gone from the manifest), device-token sign-in, kernel spenders
board (lifetime gross from fan_earnings_stats), acceptance telemetry,
x-client-version producer identity. Old versions keep working until
update. §5 week-watch from here: fleet on the version header, kernel-only
network panel + measured Fansly quota drop, chatter walkthrough,
acceptance observations under producer chatgoose-extension@1.6.0. The
NEXT release deletes the board fallback (spendersLegacyRebuild) and the
legacy chatter-key path.

**Family law (recorded per Stage 35, 2026-07-06 — binding family-wide):**
(a) **Anti-deletion rule** — removing or superseding any hand-curated
document requires a tombstone entry in the owning repo's decision log;
deprecated specs get a banner, never deletion (generated docs under
`docs/generated/` are exempt — they are regenerated, not curated).
(b) **Updated-in-change** — hand-curated docs are updated in the same
change that invalidates them. (c) **Cross-repo decisions live in THIS
log**; client repos reference entries by number, never copy them. Client
logs exist as of today: desktop `docs/decisions.md` (D1–D5), extension
`docs/decisions.md` (E1–E7). NUMBERING NOTE (append-only honesty): this
log has historical gaps — #27–#45 and #47 were never written (the era
between the v1 build log and the OFAPI integration entries) and one
duplicate #80 exists; numbers are never reused or renumbered.
TOMBSTONE (recorded retroactively): the 2026-07-02 cleanup deleted the
OFAPI feature-plan doc, the deploy-audit report, and the pre-deploy fix
reports (contents survive in the memory of the working sessions and in
this log's entries #48–#53); the Workboard v3 PRD and brief were deleted
2026-06-10 by owner decision and are unrecoverable (reflog expired) —
lesson recorded in the owner's project notes.

**Decision #113 (2026-07-07, Stage 35 Task 3):** The family CI floor and
toolchain are harmonized. (1) Core ESLint grew from the Stage 19 bootstrap
to the family standard — js/ts recommended + the desktop's hygiene rules
(no-unused-vars with `_` escapes, consistent-type-imports, no-explicit-any
as ERROR) layered under the architecture walls (module boundaries #19,
money-constructor ban #27, undici-outside-egress ban #26, vendor-AI-SDK
ban #29); the 162-violation backlog was burned to zero (no eslint-disable
waivers; the locking.ts unsafe-finally rewrite preserves all five
outcome matrices byte-identically). (2) Core gains `pnpm check`
(typecheck + lint + test:unit + dashboard build) — the same command
clients run. (3) One toolchain family-wide: pnpm pinned via
`packageManager` = 10.33.1 in all three repos (workflows read the pin —
no duplicated versions in CI), engines.node >= 22, TypeScript ^6 and
vitest ^4 everywhere (core 5.8→6 dropped the deprecated `baseUrl` for
relative `paths`; vitest 4 required a constructible class mock in
bootstrap.test.ts and honest spyOn casts in fansly-dm-fixtures).
(4) STRICTNESS RATCHET: `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess` are ON in tsconfig.base.json; the surfaced
debt (2058 errors, 136 files — 84% is `possibly undefined` from indexed
access, mostly tests; the deprecated dashboard's share dies with the
rebuild) is snapshotted per-file in `scripts/strictness-ratchet.json`
and enforced by `scripts/check-strictness-ratchet.mjs`, which IS
`pnpm typecheck`: a file over its budget fails, a new file with errors
fails, and a shrink demands the snapshot be shrunk in the same change
(both directions drill-verified). The count only goes down; zero debt
makes typecheck plain tsc again. (5) CI: core PRs additionally run the
sync-critical subset now selected by a `[sync-critical]` title tag
(the drift-prone 16-fragment `--testNamePattern` allowlist is retired;
the tag selects the same 19 tests — verified by `vitest list`); a new
nightly workflow runs the FULL Testcontainers suite including the
projection rebuild-from-fixtures proofs. (6) Desktop gets its first PR
CI (`ci.yml` running `pnpm check`, green locally before commit) — the
zero-PR-CI era is over; the extension already had lint-in-check from
Stage 32 and moved to TS 6 — where the first check run FAILED on the
deprecated `baseUrl` (TS5101) and the failure was initially masked by a
piped exit code; the vestigial `baseUrl` was removed and the full check
re-verified green with an unmasked exit. Lesson, family-wide: never read
a suite's result through a pipe — `cmd | tail` reports the pipe's exit,
not the suite's.

**Decision #114 (2026-07-07, Stage 35 Tasks 4–6 — the closing stage is done):**
Maps regenerated into `docs/generated/` in all three repos (core 24 /
desktop 12 / extension 18, banner-pinned to commit, Pass 1 originals
banner-superseded, map prompts carry a committed regeneration addendum);
client CLAUDE.md files rewritten/created to post-migration truth with SDK
versioning-and-pinning sections; release-hygiene asserts live in both
release paths (extension deploy.sh proven against the live feed; desktop
windows-build.yml). Orientation drills — a fresh session per repo, CLAUDE.md
as sole entry — PASS ×3 with file:line-verified answers; every doc defect
they surfaced was fixed in-change (core map index routing; extension MV2→MV3,
stale gateway-contract pointer flagged, E3 correction; desktop SPEC
§6.2/§8.6 superseded banners + precedence note). The regeneration itself
found and fixed a shipped extension bug (E8: options-page device-token
sign-in unreachable — missing protocol case; next release must also migrate
the 4 legacy-key-only hub ops before deleting the chatter-key path).
Family CI green same-day: core 28824417152, desktop PR #1 28824630105
(first-ever PR CI, on a real draft PR), extension 28825364090. With this,
the 35-stage Project Kernel migration's documentation standard is in force:
CLAUDE.md + decisions.md + docs/generated/ are the living surface;
docs/project-kernel/ is the archive.

**Decision #115 (2026-07-07, GPT-5.5 xhigh release audits — owner-directed):**
Codex (gpt-5.5, xhigh) audited three surfaces before tonight's releases.
(1) CORE lint burn-down (#113): CONFIRMED behavior-neutral — all
locking.ts outcome paths equivalent, no cleanup regressions. (2) Its three
core findings against Stage 31/32 code: [fixed] the fan_earnings walk could
overshoot the chunk request budget by one — hasRequestCapacity(count) now
reserves both per-fan calls up front (chunk-budget.ts + walk, pinned in
tests/chunk-budget.test.ts); [fixed] clientContext accepted for ANY platform
— now fansly-only per the Stage 32 rationale (OnlyFans context is
kernel-fresh; a bearer could fabricate transcript/spend), 400 otherwise,
integration block moved to a fansly page + OF-rejection pin; [OPEN — owner
call] persona upsert/archive routes are `apiKey`-auth (any chatter/device
bearer can edit the GLOBAL persona system blocks; stage-32 spec said
owner/team-lead-gated). Deliberate tension: the desktop's persona
sync/editor runs under chatter credentials — gating writes to owner breaks
that flow. Options when decided: (a) accept for the trusted single-tenant
team, (b) role-gate writes and move desktop persona sync to an owner-run
step, (c) per-user personas. Not changed tonight. (3) DESKTOP 0.1.31 and
EXTENSION 1.7.0 findings: fixed in their repos (desktop: device-token-only
AI gate, stale copy, pre-build tag assert; extension E10: Bearer-"set"
poisoning, key-gated token flow, null-safe bearer). Desktop finding
"vendor-key-only installs stranded" judged vacuous: 0.1.30 reads are
hub-only, a working install necessarily has hub credentials.

**#115 persona-auth RESOLVED (2026-07-07, owner):** ACCEPTED AS IS — persona
upsert/archive stay `apiKey`-auth. Rationale: single-tenant (DP 9-A), the
bearer set is the agency's own trusted team, and the desktop's persona
sync/editor legitimately runs under chatter credentials. Revisit only if the
team grows beyond trusted operators or a per-user persona design lands.

**Decision #116 (2026-07-07, owner via identity-planning session):** Family
credential ruling — HUMANS authenticate with username+password (one per
person) and per-device tokens (`agency_hub_device_`, minted by the person's
own sign-in in each client); ROBOTS (probes, scripts) use API keys
(`agency_hub_core_`). Keys leave the HUMAN onboarding path; they never leave
the kernel. Concretely:
(a) **Chatter password provisioning moves into the live dashboard** (the gap
that stranded token adoption: chatter creation offered no password field, no
set-password control existed, so tokens were unissuable without CLI/devtools).
Ships as: optional password on chatter creation + "Set password" in the
chatter detail modal, both riding the existing
`PATCH /api/v1/admin/users/:username/password`. If a dashboard rebuild
proceeds (#112), this is parity scope.
(b) **`must_change_password` stays FROZEN for chatters** until a self-serve
change-password surface exists somewhere: the gate's allowlist
(me/logout/authChangePassword) correctly blocks device-token issuance, and no
client or chatter-reachable page renders a change-password form — a flagged
chatter would be stranded. The allowlist is NOT widened (that would hollow the
flag); provisioning always sends `mustChangePassword: false`.
(c) **Client key-fallback deletion gate** (replaces "after fleet migration"
with something checkable): (1) provisioning UI live in prod, (2) every active
chatter holds a device token with `last_used_at` fresher than 14 days,
(3) one week fleet-wide without CG-HUB-03. Then, as one kernel-declared step:
the extension executes its E9 deletion, the desktop adds `hubApiKey` to
decommission-on-boot. Dashboard "Issue Key" survives — for automation.
(d) **The workboard is not an input to this plan.** Owner stated in this
session that the workboard direction is deprecated (the v2 dashboard page
included); identity work must not wait on Stage 34. OPEN ADJUDICATION left
with the owner, not resolved here: reconcile #112 (dashboard rebuild ruling)
and the Stage 34 progress note (2026-07-07 "DPs RESOLVED") with the stated
deprecations — both entries currently read as active plans.
Client-side counterparts: extension E12 (hub-failure diagnostics) already
recorded; extension E9 deletion and the desktop probe fix reference this
entry.

**Decision #117 (2026-07-07, owner):** #112 REVERSED; workboard direction
CLOSED — the #116d open adjudication is resolved. (1) The dashboard rebuild
is CANCELLED: `apps/dashboard` is NOT deprecated — it is the live, maintained
admin surface (the owner runs the agency from it daily). The #112 carry-over
features (grants + device-token admin UI, erasure UI, golden-signals page,
stream-v2 replacing the polling timers) become BACKLOG items for the live
dashboard — incremental work, no rebuild, no parity gate. TOMBSTONE:
`docs/project-kernel/prompts/prompt-dashboard-rebuild.md` AND the PRD
workspace `docs/project-kernel/dashboard/` (skeleton prd.md + README) deleted
in this change (the prompt's verified ground truth — the polling inventory and
v2 event-lane facts — originated in the abandoned Stage 33 branch notes;
re-derive from code if needed); CLAUDE.md header and SESSIONS.md harness
table updated in the same change. Consequence for #113: the strictness-ratchet debt attributed
to "the deprecated dashboard's share dies with the rebuild" is REAL debt now
and burns down like everything else. (2) The workboard direction is
DEPRECATED (owner, same session — including the dashboard's Workboard v2
page as a product direction; the page keeps serving as-is): Stage 34 stays a
placeholder with a deprecation banner, its 2026-07-07 "DPs RESOLVED" progress
note is historical, the design-pass prompt and PRD skeleton are banner'd and
must not be run. No identity/auth work waits on a chatter web surface —
chatter password self-service remains owner-managed (dashboard Set password,
#116) unless the owner later orders a standalone change-password page.

**Decision #118 (2026-07-07, owner):** Stage 28.4 page-scope erasure also
purges the page's config/secret rows (`page_credentials`,
`egress_endpoints`). Soft delete (#72) stays a two-way door and deliberately
keeps them; erasure is the one-way door and previously left encrypted secrets
present-but-unreachable forever (all credential readers/deleters are
active-gated, and the erasure target list omitted both tables). DP 7
unaffected — these are config, not captured facts; the erasure module is
already on the retention-deleters allowlist. Regression: the page-scope
erasure drill in `tests/erasure.integration.test.ts` seeds both rows and
pins their `hot:*:delete` targets. Origin: external review finding R2-1
(the reviewer's delete-in-soft-delete fix was rejected as reversing #72).

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

**Decision #119 (2026-07-08, owner):** #117 clause (2) NARROWED — the
workboard closure was recorded wider than the owner's intent. What is
deprecated is the workboard INSIDE core: the dashboard's Workboard v2 page
as a product direction (the page keeps serving as-is — unchanged from #117).
The STANDALONE workboard application (Stage 34, DP 4a = B) is an ACTIVE
direction again — the owner wants it built. The 2026-07-07 resolutions in
the Stage 34 progress note are REINSTATED as decisions of record: **DP 4b =
kernel sessions** (no IdP, no browser device tokens), **DP 4c = per-page
grants** (the existing `assignedPageIds` enforcement shape), hosting = same
VPS at `workboard.gosling-agency.ru`, repo `~/code/workboard`, v1
Fansly-only. The #117 tombstone banners on the design-pass prompt
(`docs/project-kernel/prompts/prompt-workboard-design.md`), the PRD skeleton
(`docs/project-kernel/workboard/prd.md`), and the Stage 34 placeholder are
replaced with pointers here in the same change; CLAUDE.md header and the
SESSIONS.md harness table updated likewise. Entry criterion unchanged:
owner-approved PRD (the design pass stops there) before any Stage 34 code.
#116d's identity ruling is unaffected: no identity/auth work waits on the
workboard; chatter password self-service remains owner-managed (#116) until
the app actually ships a change-password surface. Same day, executing this
decision: the repo `~/code/workboard` was scaffolded (family standard from
day one — CLAUDE.md, AGENTS.md pointer, `docs/decisions.md` with the family
law + W1, README, PRD skeleton at `docs/prd.md`; that repo's docs are NOT
gitignored) and the separate launch-prompt ritual was DROPPED (owner: "не
усложняем") — the new repo's CLAUDE.md carries the rules and decided
inputs, its PRD skeleton the section briefs and seeded owner questions; the
design pass is now just a fresh session in `~/code/workboard` asked to
write the PRD. The core copies (design-pass prompt, PRD skeleton, workspace
README) carry retirement banners and are frozen history. The founding
inputs were then RE-CONFIRMED by the owner in a structured interview
(2026-07-08, doubting the 07-07 record): login/password against core,
per-page grants, Fansly-only v1, same-VPS subdomain — all stand; NEW: v1 is
desktop-browser-only; board UX shape deliberately OPEN (the PRD proposes
variants with mockups). Recorded as W1 in the new repo's log.

**Decision #120 (2026-07-10, owner):** AI gateway daily caps raised and the
quota denial made legible end-to-end. Trigger: on 2026-07-09 the lora-vip-of
chatter hit the 200-requests/day cap (23:27–23:50 UTC, 25 `quota_denied`
ledger rows; the desktop showed only the generic CG-HUB-02 card). (1) Default
daily caps per chatter/page UTC day: requests 200 → **500**, cost
$5 → **$10** (5M → 10M micro-USD). Both moved together deliberately — at the
observed ~$0.011/request, 500 requests ≈ $5.3 would have silently hit the old
cost cap ~470 requests in. Changed in the zod env defaults + config registry +
runtime constants; prod sets no env overrides, so the deploy carries them.
(2) SDK stream helpers (`streamAiFeature`/`streamAiGateway`) now classify
non-2xx openings via `categoryForStatus` instead of an auth/server/validation
ternary — a 429 reaches clients as `rate_limit` with the body's `quota_denied`
code (previously it surfaced as "validation"). (3) Desktop (0.1.31+): new
`HubFailureReason` 'quota' → new **CG-HUB-03** ("Daily AI generation limit
reached… resets at midnight UTC"); hub timeouts/connection drops in the AI
feature lane map to CG-NET-02/CG-NET-01 instead of CG-HUB-02; the CG-HUB-02
recovery text no longer promises "sync retries automatically" (false for
generation and for one-attempt outbox sends). Follow-ups noted, not done: the
Fansly extension shares the CG-HUB-02 blindness (own repo/session); kernel
product-gate 400s are still string-matched by the desktop (`mapKernelGateError`)
and deserve structured codes; the dock could pre-warn from the quota frame's
`remainingRequestsToday`.

*Same night, executing #120's follow-ups:* the kernel's four product gates
now throw `ProductGateError` with machine codes (`gate_min_messages`,
`gate_hi_greeting_limit`, `gate_ping_active`, `gate_draft_required`; messages
unchanged); desktop (9b1334a) and extension (fed6a84, bar-tone-menu) map those
codes structurally with the message match kept as a pre-#120 fallback; the
extension got its own quota card (`hub_quota_exceeded` / CG-HUB-09 — its
CG-HUB-03 was already taken by the legacy family); and the desktop dock
pre-warns from the meta quota frame (amber strip at ≤25 requests left,
`quotaRemainingRequests` on operation:complete). Deployed/released separately
per gate.

## Fast-Reply Freshness Wave 1 — Erasure Fence Semantics + Readthrough Reconcile (2026-07-10)

**Decision #121 (2026-07-10, owner):** the PR4 erasure non-resurrection fence
is **MATERIAL-TIME-BOUNDED**, not permanent. Retained `ofapi_webhook_events`
payloads and REST readthrough observations can recreate erased
`dm_message_archive` / `page_dm_messages` rows when a sweep replays them
after an erasure; every archive material writer (webhook, REST readthrough,
tombstone) and the page_dm projection writer now checks the executed-erasure
tombstones before writing, serialized against a running erasure through a
dedicated two-int advisory-lock namespace (writers take a shared try-lock
and DEFER on miss; erasure takes exclusive locks per resolved page id,
sorted, at the top of its delete transaction). The fence blocks only
material with `source_received_at` / `message_created_at` **at or before
the erasure's `started_at`** — erasure cleans the PAST; a still-active
erased fan's new messages are captured normally (DP-7 preserved). PERMANENT
fencing (erasure as a de-facto fan block) was considered and NOT chosen.
The predicate matches `dry_run = false` regardless of `completed_at`
(mid-flight-died runs stay fenced fail-closed); page/model scopes match by
the RESOLVED page ids stored in the plan jsonb (`plan.resolvedPageIds` —
`pages.label` is mutable, so a rename must not disarm the fence); fan
scopes match by immutable fan ref. Fence hits stamp the journal row
`skipped` / `erasure_fenced`; fenced readthrough items are dropped and the
observation still stamps (the backlog gauge must not latch over rows that
can never project). Recorded waivers: (1) the null-ref tombstone stub is
the DOCUMENTED CONTENTLESS SURVIVOR — delete webhooks carry no fan refs, so
a fan-scope fence cannot reach the stub; it survives with message id only
and the fence blocks any later hydration; (2) `ofapi_webhook_events.payload`
is not an erasure target anywhere (pre-existing; owner decision pending);
(3) the subscription/presence/spend projections replay the same retained
journal but are OUT of the Wave-1 fence scope (aggregate/status rows, not
fan transcripts) — owner-acknowledged.

*Same wave, an implementation choice worth recording:* the widened
readthrough capture (`ofapi_gateway_chat_messages_v2`, envelope with
chatId/conversationRef/cursors) is emitted only while
`OFAPI_DM_READTHROUGH_RECONCILE_ENABLED` is on; with the flag off the
capture keeps today's v1 shape. Capture-first is preserved either way (both
kinds journal the response verbatim); the gate keeps the
`obs_backlog_readthrough_v1` health floor honest — v2 rows only accumulate
while something consumes them, so the golden-signal latch never fires over
a lane that is deliberately dark, and a rollback stops v2 accumulation
instead of latching a permanent incident.

**Decision #122 (2026-07-10, owner):** the Wave-2 DM corrections program
ships as ONE staged boot flag `OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED`
(staged group #122) plus unflagged writer changes. Mechanism: every material
write to `dm_message_archive` computes `material_fingerprint` (sha256 over
material fields only; columns land in migration 0076), `material != emitted`
is the queryable repair signal, and a minutely reconciler drains it into the
ledger — FIRST events for REST/command-only rows that never reached
`domain_events`, SUPERSEDING events (same event type, new account_seq, dedup
key `msg:<dir>:<id>:<fingerprint>`, `supersedesEventId` + fingerprint in the
event DATA, `emitted_event_id` stamped back on the archive row) for rows
whose material advanced past what was emitted. HARD PRECONDITION, order
load-bearing: `corrections:backfill-fingerprints` runs to completion BEFORE
the flag flips — enabling against NULL fingerprints mass-appends redundant
superseding events for the entire history. Sends-as-facts ships ACTIVE (no
flag), engaged only on the direct-confirm path while
`ofapiDmColdArchiveEnabled` is on: confirmed sends write fill-grade
`source='command'` archive rows a later webhook upgrades, and the raced
direct-confirm/webhook seam ships fixed with it (a lost failure race no
longer journals a false `failed_*` fact). The Fansly 1970 repair
(`events:repair-fansly-1970`) is the FIRST superseding consumer — a one-shot
owner CLI campaign; rows it cannot resolve
(`missingObservation`/`missingItem`/`outOfRange`) stay 1970 BY DESIGN
(source facts unreachable; timestamps are never guessed). Rollback
semantics: flag off + restart stops the sweeps (fingerprint columns are
passive bookkeeping, re-enabling resumes from the repair signal); appended
superseding events and the 1970 repair are FACTS in the append-only ledger —
no rollback, "stop" means don't run further; migration 0076 is additive and
image-rollback compatible. Deploy ritual: image+0076 → backfill (dry-run →
real, review `drainOpen` bound) → flag #122 → 1970 campaign (size → dry-run
→ real), per `docs/runbooks/fastreply-freshness.md`.

**Decision #123 (2026-07-10, owner-authorized blanket, recorded by the
session):** W2.1 lineage intake for the corrections reconciler. The Wave-2
reconciler lineage-skipped 100% of the initial drain on prod: OFAPI webhook
observation intake only began ~2026-07-05 (#49), and `ofapi_webhook_events`
retains ~14 days (the Wave-2 spec's "36500d" assumption was wrong), so
17,172 pre-#49 archive rows had no observation to anchor first events to —
8,549 of them with no surviving journal payload at all. Resolution, in
order of honesty: (1) surviving journal rows (live table or the frozen
`ofapi_webhook_events_w2_lineage_snapshot`, 138,082 rows) are journaled
VERBATIM as webhook-source observations under the row's ORIGINAL
idempotency key — the reconciler's primary lookup resolves them unchanged;
(2) journal-less rows get an operator-source reconstruction observation
whose payload is the archive row's material head — the cold archive IS the
journal's durable copy by design, so this is late intake of a retained
fact, not fabrication; the reconciler gains a fallback lookup arm for the
operator lane. "Never fake lineage" stands: ids and timestamps are the
row's own, and rows resolving neither way stay skip-and-counted. The
intake kinds (`ofapi_webhook_lineage_backfill`,
`dm_archive_material_reconstruction`) are registered with NO canonicalize
family — events come from the reconciler under canonical dedup keys. Same
decision covers the two sweep repairs: the reconcile cursor persists
across runs (skipped rows retry once per full cycle instead of
head-blocking the signal — the 2026-07-10 starvation), and lineage skips
log ONE aggregated warn per sweep with a sample instead of a line per row
(500/min against the pre-#49 backlog). Ritual: `corrections:intake-lineage
--dry-run` → real → re-enable `OFAPI_DM_CORRECTIONS_RECONCILE_ENABLED` →
watch the drain; the snapshot table stays until the drain completes and
its drop is a separate owner decision.

**Decision #124 (2026-07-10, W3.1 / B6+A35 — REVERSES the Stage-26 recorded
direct fallback):** Fansly egress fails CLOSED. Stage 26 recorded "a page
without a proxy egresses direct under egress key `direct`" as the address
policy and pinned it in `tests/egress-resolver.integration.test.ts`; on prod
that fallback was reachable silently — `resolveEgress` was dead code, the real
path (`resolveStoredPageContext` → `FanslyAdapter.getDispatcher(null)`)
returned the direct undici agent with no throw, no log, no incident
(`proxy_failed` only fires when `hasProxy`), and erasure purges
`egress_endpoints`, so an erased-but-syncing page burned the shared VPS IP —
model-ban class risk. New policy, enforced in three layers: (1)
`resolveStoredPageContext` refuses a proxyless Fansly page with a typed
`ProxyMissingError` (409 `proxy_missing`) AND opens a `proxy_missing`
notification incident (new kind, migration 0078) — the sync executor parks
the stream as `manual_action_required`/`proxy_missing` instead of
hot-retrying; (2) belt: `FanslyAdapter.getDispatcher` throws
`FanslyProxyMissingError` on a null proxy, so no code path can direct-dispatch
Fansly traffic; (3) `resolveEgress` refuses proxyless fansly-vendor page
scopes and the Stage-26 test pin is FLIPPED to expect-refusal. The incident
resolves on the next successful chunk or verification with a proxy present.
`setPageProxy` (the repair path) resolves with an explicit
`allowMissingProxy` escape hatch — it verifies through the NEW proxy, never
the stored null. OnlyFans pages are untouched (egress is vendor-side at
OFAPI; proxyless OF pages still resolve with egress key `direct`). A page
that loses its proxy now stops syncing LOUDLY — that stop is intended;
operational precondition (E2): assign proxies to any active proxyless Fansly
pages BEFORE deploying this, or their sync parks at the first chunk.

**Decision #125 (2026-07-10, W3.2 / A4+A23 — outbox queued-TTL semantics):**
queued-only OFAPI command rows expire to `cancelled` after a TTL. The sweep
re-enqueued queued rows forever with no age bound, and while execution was
disabled it returned early — rows parked invisibly (`command_settle` samples
only finished attempts) and fired hours late on re-enable: a stale DM to a
fan. The desktop's cancel route has zero product callers (A23), so nothing
client-side drains a parked queue. Semantics: at the TOP of every minutely
sweep — deliberately BEFORE the execution-disabled early return, because a
parked queue is the exact bug window — rows still `queued` with
`attempt_count = 0` and `created_at` older than the TTL are UPDATEd to
`cancelled` with `last_error_code = 'expired_queued_ttl'`. This reuses the
existing state (no migration, no contract change, no client re-vendor): the
desktop already renders `cancelled`, and it is already in
`RETRYABLE_SOURCE_STATES`, so an expired send stays chatter-retryable. Each
expiry is journaled via `recordCommandResultObservation` under
`cmd:<id>:cancelled` — the same idempotency key a client cancel would use, so
the two paths dedupe into one fact. Belt: `claimQueuedOfapiCommand` carries a
`created_at >= now - TTL` predicate, so an execute job racing the sweep can
never fire a stale send. TTL = 10 minutes (`QUEUED_COMMAND_TTL_MS`), pinned
to the desktop's `VERIFY_AUTO_STOP_AGE_MS`: the kernel must never execute a
queued row the desktop has already stopped watching (15 min would leave a
5-min blind execution window). Overridable live via the non-staged
`ofapiQueuedCommandTtlMs` registry row (env
`OFAPI_QUEUED_COMMAND_TTL_MS`, floor 60s), read per sweep — no restart, no
staged flag: the guard ships fail-closed deliberately. One-attempt law
untouched: only never-attempted rows expire; anything past claim stays the
one-attempt/indeterminate machinery's territory. Fail direction is closed —
worst case a legitimately-queued-but-stale send cancels and the chatter
retries; strictly better than an hours-late duplicate DM.

**Decision #126 (2026-07-10, user offboarding — deactivation tombstone, never
DELETE):** users (chatters, staff) are never hard-deleted; offboarding sets a
`users.disabled_at` tombstone (migration 0079), mirroring the Stage 13 pages
soft-delete standard. Hard delete is structurally impossible anyway
(`ofapi_commands.chatter_user_id` is RESTRICT) and undesirable: gateway spend,
audit events, and command attribution reference `users.id` and must survive
offboarding. `adminDeactivateUser` (owner-only) sets the tombstone and revokes
every credential — API keys, device tokens, sessions, reason
`user_deactivated` — in ONE transaction with the `user.deactivated` audit row.
Fail-closed belt: `getAuthenticatedUserById` returns null for a tombstoned
row, so all three authenticate paths (session, api-key, device-token) die at
the principal root even if a credential row somehow survived; login folds
disabled into the invalid-credentials branch (same 401 + dummy argon2 verify +
backoff — no enumeration oracle). A tombstoned user is frozen: password set,
key/device-token issuance, and page assignment all refuse with 400 until
`adminReactivateUser` clears the tombstone. Reactivation restores password
login ONLY — revoked keys/tokens stay revoked (issue fresh ones); the username
stays reserved (unique) while tombstoned, deliberately: recreating it would
silently inherit the old row's attribution history. Owners cannot be
deactivated, nor can the caller deactivate itself. Sibling change, same
motivation (honest admin surface): `adminListUsers` now carries
`lastActiveAt = max(api-key last_used, device-token last_used)` — the key-only
column showed "Never" for every #116 password+device-token chatter.

**Decision #127 (2026-07-11, restored 2026-07-20 — ping knows the silence
length through bounded `fanSilenceDays`):** The ping prompt previously received
only the segment LABEL (`segment-a` / `segment-b`). The model therefore could
not distinguish six days of silence from six months: client transcripts carry
only wall-clock `HH:MM`, while the existing analyzer already knows the latest
fan-text timestamp. The whole-day gap now appears as a `Fan silence:` line in
the uncached ping task block, with a static calibration rule in the template:
short gaps may carry light “hey stranger” energy, long gaps need a softer
zero-pressure reopen, and the generated message must never quote the number or
sound tracked.

Both context paths derive the value from the SAME analysis and `nowMs` that
select the segment. OnlyFans computes it kernel-side; Fansly may send optional
`clientContext.fanSilenceDays` beside its live client-computed `pingSegment`.
The wire value is an integer `0..20_000`; future timestamps clamp to zero and
the kernel-derived path clamps to the same maximum, so prompt assembly never
sees an unbounded recency value. Older clients omit it and retain the segment-
only behavior. Because `clientContext` is strict, Core must deploy before the
extension starts sending the new field; the extension must re-vendor the SDK
from this current Core rather than restore the historical pre-Coach vendor.

This entry and implementation were originally authored in stranded Core commit
`5bc88df8` and extension commits `1a0edb4..55ecb96`, then lost from both mains
during parallel branch integration. Later prompt-manifest commentary and
Decision #136 continued to reference #127 even though its actual entry/code
were absent. Restoring the missing numbered decision closes that historical
gap; there was no superseding or reversing decision. Prompt-freeze discipline
continues: `prompt-manifest.json` re-pins the evolved builder/templates and the
ping template carries a Decision #127 note while its Stage-30 source hash stays
the historical record.

**Decision #128 (2026-07-11, B5 — recurring DB backups declined, risk accepted):**
The 2026-07-08 audit's B5 finding (decision #41 "nightly off-box Postgres backups +
restore drills" never implemented) was resolved by the owner as ACCEPTED RISK, not
implementation — same call as 2026-07-04, re-confirmed after the 2026-07-10 reboot
purged the only ad-hoc dump from /private/tmp. Consequence, stated plainly: loss of the
VPS (disk failure, provider incident, compromise) = permanent loss of ALL platform
history since the last manual dump, for a system whose own invariants promise 100-year
retention; Stage-28 tiering is on the same volume and provides zero protection. No
recurring cron/timer/provider-snapshot job exists on prod (verified 2026-07-11: root
crontab none, no backup timers/containers). The only restore point is a manual
`pg_dump -Fc` (latest: ~/backups/agency-hub/, 2026-07-11, 4.8 GB, taken from prod rev
ea9ac13). Owner may reverse this by implementing #41 at any time; until then B5 is
CLOSED as accepted-risk. Supersedes the "P1-if-absent" open state in the audit addendum.

**Decision #129 (2026-07-11, B7 — erasure completeness moot: erasures will not be executed):**
Owner ruling on the audit's B7 (erasure module misses sync_raw_payloads /
ofapi_webhook_events / ofapi_spend_projection_events + the W2.1 snapshot table) and the
pending #121 waiver: the agency does not intend to execute data-erasure requests at all
— "такого не будет никогда, мы не будем это исполнять". Verified prod fact 2026-07-11:
erasure_log has ZERO non-dry-run rows; the gap has never fired and stays latent. The
erasure module remains in the tree untouched (capture-first: nothing is deleted), but no
W6 remediation wave will be built; the three surviving stores are sanctioned as-is. If
this policy ever reverses (a real deletion request arrives), the fix recipe is preserved
in fix-plan-FINAL-2026-07-10.md §W6 (variant b) and MUST ship before executing that
request — an erasure run under today's module would falsely report completeness.
Resolves the #121 pending waiver. B7 CLOSED (policy), not fixed (code).

**Decision #130 (2026-07-11, W5 — observability truthfulness: per-signal latch,
wedge gauges, ops deadman, sweep cursor):** four related semantics changes from
the audit's B8/A25/A53/B3, one deploy (migration 0080). (1) Golden-signal
incidents split per metric — incident key `golden_signal_lag:global:<metric>`
(kind unchanged); a standing breach on one signal no longer masks or falsely
resolves the others; the legacy shared key is resolved once at the first
post-deploy sampler run. Absence semantics: a metric that emits NO sample this
run keeps its latch exactly as-is — the old code resolved the shared latch on
"no breaches", so a completely dead pipeline sent "✅ Resolved". (2) Always-emit
wedge gauges `capture_pending_age` (oldest unprocessed webhook, 10-min
threshold) and `command_queued_age` (oldest queued+unattempted command, 15-min
threshold — the W3.2 TTL sweep cancels at 10, so a breach means the sweep
itself is dead); a missing SSE smoke-checkpoint row latches as a failed probe
instead of disappearing. `acceptance_events_1h` rides along as a
threshold-free liveness gauge (D9). (3) New api-side ops watchdog
(`ops-watchdog.ts`, kinds `scheduler_silent`/`ops_sampler_silent`): pages when
the scheduler heartbeat or the sampler goes >3 min silent, 5-min boot grace
for deploy restarts — a dead scheduler used to stop ALL cron with zero pages.
(4) The canonicalize sweep resumes from a per-family in-memory cursor with
wrap-to-head (#123 semantics; CLI/replay runs bypass it), so a stuck cohort at
the scan head can no longer starve fresh observations; the 4000/min ceiling
stays (throughput bound, not a starvation trap). Ride-alongs: boot-override
read is now retry-3-then-RETHROW (A31 — a crash-looping container is visible,
a silently flags-off "healthy" api is not); sampler indexes per the Stage-0
EXPLAIN (BRIN on the append tables, partial btree on the bounded lookups);
metric-sample prune moved from every minute to hourly.

**Decision #131 (2026-07-11, W7.2 / A33 — tombstoned pages keep their revenue
history):** consciously revises the Stage-13 "active-only" reader choice FOR
HISTORICAL AGGREGATES. Every revenue surface (overview/model reports, finance
module series, Top Spenders scopes, Telegram digest) previously derived its
page set from active-only readers, so tombstoning a page silently dropped its
ENTIRE revenue history from every rollup while the facts stayed in
`transactions` — totals lied by the page's lifetime net. New split:
navigation/status surfaces stay on the active-only readers; revenue
attribution goes through `listRevenuePages` / `listRevenueModels` /
`findRevenueModel` / `listRevenueScopePages` (no status filter, status
exposed). Page-scoped detail routes still 404 on tombstones — retired pages
stay hidden as PAGES; only rollups keep their history. Contract: additive
optional `status` on `pageRevenueItemSchema` ('active'|'deleted') and
`modelRevenueItemSchema` ('active'|'retired' — retired = zero active pages);
dashboard badges render them. Growth reports deliberately stay active-only (a
tombstoned page's frozen follower counts are not current growth). Expected
visible effect at deploy: all-time totals jump UP by retired pages' lifetime
revenue — that jump IS the fix.

**Decision #132 (2026-07-11, W7.3+W7.4 / A21+B4+A47 — negation guards, sticky
suppression, pending settle-or-expire):** three writers mint negative money
rows (`<id>:reversal` from the webhook truth ingest and the REST backfill,
`<id>:chargeback` from the chargebacks reconcile) with per-suffix dedup and
no settled-original check — structurally double-countable (both flags are ON
in prod; Stage-0 census 2026-07-11: 0 double pairs, 9 orphan reversals
≈ −$114.95). Guards now run inside the existing per-page spend lock:
(Guard 1/B4) an active other-suffix twin ⇒ the new negative writes INACTIVE
as `superseded_duplicate_negation` (first negative wins; repair pin: the
:reversal is canonical, the :chargeback twin deactivates); (Guard 2/A21) no
active POSTED original under the base id ⇒ inactive as
`reversal_without_settled_original`; a late-arriving settled original
reactivates AT MOST ONE suppressed negative (earliest row) via the explicit
fixup — the ONLY reactivation path. (Guard 0, mandatory) `upsertTransaction`'s
conflict-set used to reset `is_active=true` on every re-upsert — any webhook
redelivery would resurrect a deactivated twin; the two guard reasons are now
STICKY through the conflict-set (`missing_from_sync_window` deliberately
stays re-activatable — re-appearance is its designed recovery). Repair CLI
`money:repair-negations` (dry-run first) deactivates the census anomalies and
rebuilds rollups. (W7.4/A47) OFAPI pending rows now settle-or-expire like the
Fansly anchor: daily 03:25 UTC `ofapi.pending.reconcile` (+ CLI
`ofapi:pending-reconcile`) rescans stale (>7d) pendings through the existing
credit-guarded REST backfill, then retires what a fresh scan of the window no
longer reports — displayed revenue stops carrying dead pendings (census: 156
stale rows, ≈$2,804 net). Migration 0081 (two enum values). Also in this
wave (W7.1/B1, forward-only): the Anthropic provider preserves the 5m/1h
cache-write breakdown from message_start when a usage delta lacks it — the
1h component was priced at the 5m rate (37.5% under-recorded); historical
rows are identifiable (`cache_write_tokens>0 AND cost_approximate=true`) and
stay unmutated (append-only ledger).

**Decision #133 (2026-07-11, W8 — stream-state visibility, canonicalizer
tail, E5 re-journal):** (1) A12/A20 kernel side: `pageTopSpenders` gains an
additive `source` block `{streamState: ramped|flag_off|not_allowlisted|
unsupported_platform, lastSyncedAt, consecutiveFailures}` — `builtAt:null/
entries:[]` was indistinguishable from "no spenders" for a non-ramped page.
The Stage 16 allowlist gate is EXTRACTED to `sync/fansly-stream-gate.ts` and
shared by the executor and the reporter (one function, no drift; empty CSV =
all pages allowed). `top_spenders`/`fan_earnings`/`purchase_history` join
`MONITORED_SYNC_STREAMS` (snapshot/CLI visibility) but stay OUT of block
health (BLOCK_TASKS / SYNC_DOMAIN_POLICY unchanged — a flag-gated stream must
not degrade block UX). Response-schema-only contract change; no client
re-vendor (W9 takes the field only if it ships the richer copy). (2) A48:
`subscriptions.renewed` joins the OFAPI webhook family (same notification
envelope as subscriptions.new → `subscription.renewed`), canonicalizer v2→3 —
the bump DELIBERATELY replays webhook history so pre-fix renewals backfill;
safe because W5.3's sweep cursor (#130) is live and dedup keys are stable.
(3) A49 REFUTED, fallback NOT enabled: the proposed workboard-recompute
fallback (message.* with null fanIdentityRef → conversationRef) required
Fansly conversationRef to be the thread partner; it is the messaging GROUP id
(`item.groupId` — a different id space; the groups payload carries
`partnerAccountId` separately). A fixture pin in canonicalize-sync-pull.test
documents the refutation; revisit only if that pin ever fails. (4) A43:
the fan_earnings walk now persists its cursor with purchase_history's
hold-back discipline — persisted cursor advances only past SUCCESSFUL fans, a
zero-success chunk leaves the checkpoint untouched, the mass-skip breaker
stays armed. (5) A46 (forward-only): `transaction.posted` event data gains
`amountUnit` — `"mills"` (Fansly) / `"dollars"` (OFAPI float) — on
NEWLY-emitted events only; pre-fix events are immutable facts, consumers
branch on platform where the field is absent. No sync-pull version bump (a
replay would only dedupe). (6) Partitions (A13 remainder): occurred_at clamps
at canonicalize time to [2024-01-01, now+2mo]; out-of-window values fall back
to observation.receivedAt (never a guessed boundary) with the raw value
preserved as `occurredAtRaw` in event data; migration 0082 adds
`domain_events_future`/`observations_future` FROM '2031-01-01' TO MAXVALUE —
named outside the tiering `_YYYY_MM` regex (0077 precedent) so they are
structurally undetachable, and monthly pre-creation stops before 2031 (the
shrinking lead pages the owner ahead of the hand-off). (7) A30+A32: the dead
`ONLYFANS_PUBLIC_PROFILE_*` flags and their boot-crash OR-invariant are
DELETED (zero callers — they could only crash boot, never enable anything;
the resolver module and its capture tables remain untouched);
`assertClearableKey` now also rejects `runtimeApply==='boot'` keys (the two
EDITABLE boot flags could bypass the staged ritual via generic DELETE); the
ConfigurationTab `config-<key>` anchor is keyed on `runtimeApply==='boot'`
(kills the duplicate ids on editable boot keys AND gives staged non-boot keys
an anchor). (8) E5/A22: one-shot CLI `observations:rejournal-collisions`
re-journals the ~40k pull observations swallowed by the pre-f8c4409
chunk-constant idempotency key (window 2026-07-05T01:50Z..07-07T18:00Z) —
verbatim from `sync_raw_payloads`, producer `rejournal:a22`, per-raw-row keys
(idempotent), append-only; the sweep consumes the rows and domain_event_keys
dedup makes re-canonicalization of already-seen facts a no-op. Dry-run first,
counts per stream.

**Decision #134 (2026-07-11, W10 / B10+A37+A51 — message-archive shadow
rebuild machinery):** the Stage-10 one-command rebuild (delete + event
replay) is retired as structurally lossy: the replay reads only ATTACHED
domain_events partitions (tiering detaches months >6mo; the watermark
advances past missing seqs silently) and the reset destroys legacy-seed rows
(`source_event_id IS NULL AND backfill_source IN
('dm_message_archive','hot_table')`) — for pruned hot originals those rows
are the ONLY copy. The build spec had already rejected in-place rebuild and
hash-equality-as-proof; the shipped replacement is a staged SHADOW build
(migration 0083, `message_archive_shadow`, same shape, distinct index
names). R0 `archive:rebuild-preflight`: per-account census — event-sourced
rows, legacy seeds by source, unrecoverable-if-dropped (the corrected query
INCLUDING dm_message_archive as an origin — the audit's version omitted it),
detached-partition census (pg_inherits vs tiered_pending_drop AND
detached-in-public 0077 leftovers). R1 (dispatched from `projection:rebuild
message_archive`, replacing the W1 unconditional throw, --account kept): per
account, ONE restartable transaction — legacy-seed LIFT first (verbatim
copy, provenance preserved; lift-before-replay reproduces the live table's
first-writer precedence exactly), then event replay from seq 0 behind a HARD
detached-partition gate (checked at start AND end of the transaction — a
tiering detach mid-build aborts instead of shipping a short replay), then
account-scoped backfill re-run; the existing writers were parameterized with
a two-value whitelisted target table. R2 `archive:rebuild-verify`:
set-difference proof (shadow ⊇ old on the archive key) + per-column material
comparison with bounded samples; NONZERO MISSING ROWS FAILS (exit 1) and the
switch re-checks the same condition inside its transaction. R3
`archive:rebuild-switch` (owner-gated, dry-run default, sweep worker paused
for the window — runbook `docs/runbooks/message-archive-rebuild.md`): one
transaction under the rebuild advisory lock — old → message_archive_retired_
<ts> (KEPT; capture-first — its drop is a separate owner decision), shadow →
message_archive, canonical index/constraint/sequence names follow the live
table, and the projection watermark is FORCE-reset (delete+reinsert — the
guarded upsert would keep a higher stale watermark and skip events) to the
shadow's replay high-seq. No erasure during a rebuild window (W6 ⟂ W10); E5
re-journal runs before any prod run. Ride-alongs: (A51) `text_plain` is now
derived through `normalizeDmMessageText` in the projection writer — the
event ledger stays verbatim, and the shadow replay heals pre-strip rows for
free (verify flags those diffs `healedHtml`); (A37)
`rebuildFanEarningsProjection`'s two autocommit deletes now run in one
transaction — a crash between them left an empty projection behind a stale
watermark, permanently and silently.

**Decision #135 (2026-07-11, A2a / dm_messages wedge — the 0026 upper bound
falls, the floor stays):** `page_dm_threads_stored_message_count_check`
becomes `>= 0` only (migration 0084). The 0026 cap (`BETWEEN 0 AND 1000`)
encoded retention POLICY as an integrity constraint, and Stage 1's prune
stand-down (`PAGE_DM_PRUNE_ENABLED=false`; hot DM history nondecreasing
until Stage 28) turned it into a time bomb: the moment an at-cap
conversation receives a new message, the finalize recount
(`finalizePageDmConversationMessageSync` writes COUNT(*) into the bounded
column) throws 23514 and the page's ENTIRE dm_messages stream wedges —
candidate selection re-pins the same conversation (stale-head priority 0)
every run. lora-1/lora-2 were down 2026-07-05..07-11 exactly this way
(310/265 failed runs; seven threads at the cap, two already at 1025 physical
rows via the paging-branch commits that land before the failing finalize).
NOT the trigger: Stage 17 backscroll and the cap-lift flag — the first
failure predates the Stage 17 commit by 8 hours; they only widen the blast
radius, which is why `fanslyDeepBackfillIgnoreRetentionLimit` goes OFF as
containment while this repair lands (its own gate and window, #70 ritual).
The upper bound does NOT come back as a number: it returns only WITH the
bounded-hot-cache protocol (durable PPV home first — `message_archive` has
no `purchased_at` and the AI union upgrades `is_opened` from the hot row;
then per-eviction archive coverage and atomic evict/recount/checkpoint),
because until pruning is a cache policy any DB ceiling re-arms the same
wedge. Counter repair for the two mismatched threads (1825, 13294712) is a
separate owner gate: pause those two dm_messages streams → lease drain →
row-locked recount → resume (no shared advisory-lock contract exists with
the executor — leases own that path; a repair racing a live finalize would
just lose its recount).

**Decision #136 (2026-07-11, AI features read the stored fan dossier —
kernel-side, fail-open, staged):** Every feature-lane prompt whose policy
says so now injects the latest `fan_profiles` body (the Scan dossier the
extension pushes via `upsertFanProfile`) — the kernel looks up its OWN
store; the INJECTION needs no wire-contract change, so the Fansly extension
and the desktop get the behavior without an SDK re-vendor. (The same-day
review fixes below did extend the upsert/profile contract with OPTIONAL
generatedAtMs/sourceGeneratedAt fields — non-strict schemas, compatible in
either deploy order.) New `FeaturePolicy.usesFanProfile`
gates it per feature: ON for fast-reply (compare inherits — its cards ride
the fast-reply feature), improve-draft, help-me, ping; OFF for fan-summary
(it GENERATES the dossier — feeding it back is circular), chat-review (must
judge the chatter independently of a stored opinion) and hi-greeting (a cold
opener must not show unexplained familiarity — revisit after observation).
Runtime rollout/rollback rides `chatMuseAiFanProfileContextFeatures`
("none" | "all" | CSV, live-wired like the union mode). DEFAULT IS "none":
a deploy alone never activates the feature — ramp with deliberate flips
`fast-reply` → `fast-reply,ping` → `all`; rollback is "none", no deploy. The lookup is STRICTLY fail-open (on the Fansly clientContext path
it is the generation's only fans-table read, so a fan_profiles hiccup must
degrade to "no section", never a failed Reply) and resolves the fan exactly
like the spend/name loaders (`fans` by platform + platform_user_id, R3-2),
plus a `deleted_detected_at IS NULL` guard; Fansly group chats
(conversationRef = groupId) get no dossier — accepted. The dossier is
COMPILED, not pasted (`context/fan-profile.ts`): parsed into the
fan-summary template's sections — production dossiers are RUSSIAN markdown
(`## N. ДОСЬЕ/ПОРТРЕТ/…`; the template says "Write in Russian" and the
dashboard's parseFanProfile pins the shape), so the matcher carries RU+EN
aliases plus stem matching on H1/H2 lines only (H3 subheadings and list
bullets never split). FINANCIAL PROFILE always dropped (fresh
spend/subscription data rides its own blocks); volatile sections (STAGE AND
TRAJECTORY, OPEN LOOPS, STRATEGY) dropped once the dossier is older than
`chatMuseAiFanProfileVolatileMaxAgeDays` (default 21 — stable facts age
well, stale open loops mislead); whole sections shed by keep-priority
against the 10k-char target; hard mid-text cut only at 20k; unrecognized
shapes get a bounded 10k head. Age is measured from the SOURCE generation
time: `fan_profiles.source_generated_at` (migration 0087; upsert contract
gains optional `generatedAtMs`, profile responses gain optional
`sourceGeneratedAt` — both non-strict-safe in either deploy order) with
`created_at` fallback for legacy rows — `created_at` alone is the hub
APPEND time, and a delayed client re-push must not zero the dossier's age. The prompt section ("## Fan Dossier", dated,
"the transcript is authoritative" framing, escaped `<fan_dossier>` body)
rides the dynamic 5m block after the subscription section — the 1h static
prefix stays fan-agnostic and no cache anchor moved, so live caches survive
the deploy. Second post-freeze template change after #127: fast-reply /
improve-draft / help-me / ping (+ templates.ts, builder.ts,
feature-policies.ts) re-pinned in prompt-manifest.json with this decision's
note; fan-summary.md untouched. Observability: debug-level "ai feature
dossier injected" (version/age/chars/truncated/droppedSections — never the
body), warn on lookup failure, and a `fanProfile` entry in
params.contextManifest on BOTH context paths (the Fansly clientContext lane
has no transcript manifest, but the dossier audit still lands). Same-day P1
hardening: the write-side dedupe/ordering is ATOMIC in the kernel —
appendFanProfile's advisory-locked transaction no-ops an identical body
(lost-ack re-push) and rejects a sourced write that is not newer than the
stored latest (client preflight GETs remain an optimization; legacy writes
without generatedAtMs keep append semantics); generatedAtMs is
contract-bounded to 2100-01-01 and future skew past 5 minutes clamps to
server "now" so a broken client clock can't pin volatile sections fresh.

**Addendum to #136 (2026-07-12, disclaimer over age-dropping).** The volatile
age-drop is REMOVED: the compiler no longer drops STAGE AND TRAJECTORY, OPEN
LOOPS, or STRATEGY when the dossier is old, and the live key
`chatMuseAiFanProfileVolatileMaxAgeDays` is retired (dead config → tombstoned;
LIVE key count 17→16). Rationale (owner decision): the prompt ALREADY carries a
dated disclaimer ("generated on {date}… may be out of date… transcript is
authoritative"), so also hard-dropping those sections was belt-and-braces that
discarded useful historical context. The disclaimer in `fanProfileSection`
(builder.ts) is strengthened to name the date and mark the situational sections
as possibly-obsolete HISTORY, not current instructions — the original worry was
that STRATEGY reads like a directive, and a sharpened disclaimer addresses that
without denying the model the context. UNCHANGED: FINANCIAL PROFILE is still
always dropped (that is about DUPLICATION with the live spending blocks, not
age), size-pressure shedding by keep-priority against the 10k target, the 20k
hard cap, and the bounded-head fallback. builder.ts is manifest-pinned, so
prompt-manifest.json re-pins builder.ts's coreSha256 with this note. `ageDays`
is still computed and reported in the contextManifest and stamped on the
disclaimer; only the age-based DROP decision is gone.

**Decision #139 — RESERVED for the in-flight AUTH_POLICY_ENFORCEMENT ruling
(authored in the ai/ping-silence session, uncommitted at the time of this
write; renumbered twice: its original #135 was taken by A2a, and its #136
reservation was taken by the fan-dossier decision above before this merge
landed — #137/#138 are also taken below). If that session lands its entry
under a different number, this placeholder is released.**

**Decision #137 (2026-07-11, A2b / #135 follow-through — projection debt,
health truthfulness):** the two systemic gaps behind the #135 wedge close.
(1) A finalize/checkpoint failure in the Fansly dm_messages chunk no longer
fails the chunk: the message upsert commits in its own owned transaction,
the thread-summary recompute + checkpoint ride a second one, and when only
that second step fails (and it is NOT a PageSyncLeaseLostError — fencing
stays fatal, as do capture and message-upsert failures) the failure is
recorded as a `projection_debt` row (0085: kind + platform_account_id +
conversation_id + attempts, one live row per target via a partial unique
index, resolution = resolved_at, never deleted per DP 7), the cursor pin is
cleared, and the loop continues. A 5-minute sweep re-runs the recompute
(enforceRetention via the same isPageDmPruneAllowed gate the executor uses)
and resolves; conversations whose thread vanished resolve trivially.
(2) /health/sync stops lying: a stream in `retrying`/`scheduled` with
consecutive_failures >= 10 now pushes `${stream}:retry_wedged` and degrades
the page exactly like a failed stream (the #135 incident ran 251-270
consecutive failures while health said ok), and any page with unresolved
projection debt pushes `projection_debt`. New issue strings only — the
response schema is already z.array(z.string()), no contract regen. Known
residual, accepted: a conversation with open debt is re-selected first each
chunk and burns ~1 request per pass until the sweep repairs it — visible
via the issue + the projectionDebtRecorded chunk stat; skipping open-debt
conversations in candidate selection is a possible follow-up, deliberately
NOT taken now (the failure mode it would guard against is speculative, the
extra join is not).

**Decision #138 (2026-07-11, OF poison-chat wedge — per-conversation
circuit breaker):** OFAPI dm_messages gets chat-level fault isolation
(0086: page_dm_message_sync_health — failure_count, error_class,
next_retry_at = now + min(5min·2^(n-1), 6h), quarantine_until = now+6h from
the 4th failure; PK = conversation_id, cascades with the thread; rows clear
on a successful sync of the conversation, re-admission is implicit when the
windows lapse). Candidate selection LEFT JOINs the table and skips open
windows; the pinned-conversation path (which used to make the poison chat
the FIRST fetch of every run, forever — three successive poison chats on
one page, ~3350 attempts / ~35h of 60s aborts over 9 days, last_ok never
stamped) now checks the pin's health row and clears the pin, which also
unwedges the two wedged pages on deploy with no manual cursor surgery.
Error taxonomy is deliberately conservative — chat-isolatable is ONLY
status=null+abort/timeout (`vendor_opaque_timeout`) and a single 5xx
(`vendor_5xx`); 401/403 stay page-level (vendor contract has not proven a
chat-local 403), 429 stays with the page-level backoff, any other 4xx or
non-OFAPI error rethrows, and 3+ DISTINCT conversations failing
timeout/5xx in one run rethrows (vendor outage, not poison — no
mass-quarantine). A first-page timeout at the default limit probes limit 20
then 5 as SINGLE attempts (retries=0 plumbed through the client) before
recording the failure — a giant chat may survive a smaller vendor scrape
window; a probed-down limit sticks for that chat for the run. The
exhaustion stamp (last_ok) stays reachable and honest: skippedQuarantined
(counted at chunk END) and perChatFailures ride the run stats. Ride-along:
the dashboard ConfigurationTab gained a boolean live-flag editor (toggle +
the same costWarning confirm gate; the #135 containment flip had to be done
via psql because boolean live keys rendered an editable-looking chip with
no editor). The string live keys still have no editor — known, follow-up.

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

**Second addendum to #137/#138 (2026-07-11, the streak is not the signal):**
the retry_wedged widening survived exactly one partial run in production —
`yieldPageSync` resets `consecutive_failures = 0` (and the last-error
fields) on EVERY partial yield, so the moment the breaker keeps a stream
moving, the page-level streak goes quiet while poison chats still sit in
backoff with `succeeded_at` NULL. Preserving the streak across yields would
be wrong the other way (the stream genuinely progresses). The durable
carrier is the breaker table itself: health now pushes
`dm_messages:coverage_degraded` for any page holding
`page_dm_message_sync_health` rows with `failure_count > 0` — those rows
clear only when THEIR conversation actually syncs. Consequence for
incident semantics: `succeeded_at` alone proves nothing while
`skippedQuarantined > 0` (the chunk legitimately returns satisfied once
every currently-eligible candidate is drained); full-coverage proof =
succeeded_at stamped AND zero failing breaker rows AND zero conversation
head/archive gaps. retry_wedged stays for streams with no breaker
(Fansly), where the streak still carries the wedge.

**Decision #140 (2026-07-11, LLM-input observability — capability-gated,
time-bounded prompt declassification):** The kernel feature lane may echo the
exact assembled prompt in an additive `debug_input_v1` SSE frame so the two
ChatMuse clients can inspect what the model actually received, including
kernel-loaded transcript, persona, templates, and fan dossier. This is an
explicit DP 6-A declassification — a new chatter-scoped read channel onto
content that is otherwise owner-only — not a general logging path, and not
"the client's own request echoed back" (the desktop sends refs only; persona,
templates and the dossier originate here). Emission requires BOTH: the caller
advertises the exact `debug-input-v1` capability token, and the authenticated
chatter's username sits inside a live window.

The window is ONE live key, `chatMuseAiPromptDebugEcho`, holding the allowlist
AND the deadline in one value (`"user1,user2@<ISO>"`, deadline split on the last
`@`; `"none"` disables; no `all` wildcard). One key, not two, so every enable or
disable is a single atomic write: a deadline left over from a previous window can
never re-open echo when only the user list is edited. The owner-only config PATCH
validates the shape and caps one window at 24 hours; a forgotten window expires by
itself. The env schema accepts only `"none"`, so enablement cannot bypass the
audited owner API, and deploy/rollback are inert.

The runtime gate fails closed on the WHOLE value, not per token: an empty entry,
an `all`/`none` smuggled into the list, or a window longer than 24 hours disables
echo entirely rather than dropping the bad part and honouring the rest — and the
24h bound is re-checked at READ time, not only at write time, because a row can
also arrive from a restored dump, a hand-run UPDATE, or an older kernel's rules.
For a legitimately written window the remaining time only shrinks, so the runtime
check never fights the write path.

The frame is feature-lane only: the raw gateway frame union stays strict
(`streamAiGateway` still rejects an unknown frame), old clients never advertise
the capability and so never receive it, and a new client against an old kernel
simply gets no frame — the capability rides a HEADER, not the strict request
body, so a kernel rollback after a client release cannot break generations. The
echo block schema is separate from the request-side block schema and bounded at
2.5M chars: a 300k `clientContext` transcript escapes fivefold (`&` → `&amp;`)
into ONE dynamic block, so the request-side 100k bound would have made the echo
unparseable for the very requests that most need inspecting. The pump writes the
frame immediately after `meta` under `Cache-Control: no-store`; the audit log
records feature/page/user metadata only, never prompt text.

Clients keep the body in memory only (never storage, never logs). The desktop
app-origin renderer may show it inline; the extension may show it only on its own
token-gated extension page, never in the Fansly DOM — that DOM is a hostile,
shared document and gets only a typed allowlist projection of `contextManifest`
(counts and dossier metadata), never prompt blocks and never a raw-manifest
fallback.

**Addendum to #140 (2026-07-11, review round 5).** `scripts/vendor-sdk.mjs` now
REFUSES to vendor from a dirty tree (`--allow-dirty` stamps `<sha>-dirty`). The
vendored manifest's `sourceCommit` is a provenance claim — "re-run the vendor at
this commit and you get these bytes" — but the script reads the working tree, so
an uncommitted source edit shipped inside an artifact stamped with a clean sha.
That is exactly how this decision nearly went out: the feature-lane frame types
were exported by hand-editing `packages/sdk/src/index.ts` — a GENERATED file —
so the next clean `contracts:generate` would have dropped an export both clients
import, and the lie was invisible because the manifest looked honest. The export
now lives in the generator (`generate-sdk.ts`), and a dirty vendor can no longer
pass as a snapshot.

The guard checks the WHOLE tree, not just `packages/{sdk,contracts,shared}`. The
first cut scoped it to the copied sources — and missed that the vendor script
itself decides which files are copied, how their imports are rewritten and which
compiler options emit the bytes, while package.json / pnpm-lock.yaml / tsconfig
pin the tsc and zod that do the emitting. A guard that tolerates an uncommitted
edit to its own definition of "these bytes" is the same provenance bug one level
up.

**Addendum to #140 (2026-07-12, fleet-wide echo — string window → boolean
kill-switch).** The owner decided the assembled prompt (safety preamble, persona,
templates, fan dossier) is NOT withheld from the agency's own chatters and wants
it shown to everyone in debug mode, always, with no per-use friction. This
SUPERSEDES the original #140 control-surface specifics: the username-in-a-live-
window requirement, the "no `all`" rule, the mandatory ISO deadline, the 24-hour
cap, the forgotten-window auto-expiry, and the "one atomic string" grammar — all
retired. An architecture review (Codex gpt-5.6-sol) found the string grammar was
"a boolean disguised as a string DSL"; the control surface is now a plain live
boolean key `chatMuseAiPromptDebugEchoEnabled` (default false; the old string key
`chatMuseAiPromptDebugEcho`, its parser/validator, and its PATCH transition hook
are removed). The dashboard renders it as an on/off switch; validation is the
registry's generic boolean type-check (no feature-specific parser). The
declassification/bandwidth warning lives in the descriptor NOTE, deliberately NOT
as a `costWarning` — that would force two-click confirmation on the DISABLE path
too, wrong for an emergency kill-switch.

What this addendum PRESERVES unchanged: the frame is feature-lane only and the
raw gateway stays strict; the capability header is compatibility negotiation, not
authorization (under a fleet-wide flag any bearer client in debug mode receives
the frame — that is the accepted intent); the real data boundary is the unchanged
page-authorization (a chatter sees the assembled prompt only for a generation on
a page they are authorized to access — this grants NO historical or cross-page
read of `ai_generation_content`, which stays owner-only); env default is false so
a deploy is inert, and enabling is a single audited owner PATCH; clients never log
or persist the body and render the full prompt only on an extension-origin surface.

Rollback runbook (the flag is a persisted DB override, not env): to disable during
an incident, set `chatMuseAiPromptDebugEchoEnabled` to false (or clear the
override) FIRST, then roll back code — a code rollback alone makes the override
temporarily unreadable but a later roll-forward would re-activate it. Follow-up
(not a blocker for this change): the frame can be very large (blocks bounded at
2.5M chars) and `raw.write` backpressure is unhandled, and every emission writes
an info log — add echo count/bytes/latency metrics and sample that log once
fleet-wide volume is understood.

**Decision #141 (2026-07-11, executor fair scheduling — the group-wedge
zombie):** three interacting defects let ONE page monopolize its egress
group for hours while a sibling page's top-priority job starved 3.5h
unfetched (prod: lora-of vs lora-vip-of after the #138 deploy).
(1) The continuation wakeup was sent with NO singleton key, and the
exclusive queue's uniqueness is `(name, COALESCE(singleton_key, ''))` over
queued jobs — one lingering NULL-key job anywhere in the queue made every
subsequent NULL-key send return null. (2) The executor read that null as
"keep draining locally" (up to 500 chunks ≈ 25h at poison-chat pace),
holding the group in localActiveGroups the whole time. (3) pg-boss
expiration is a HARD wall clock (`started_on + expire_seconds`, 180s
here); touch feeds only the heartbeat monitor — so the monopolizing job
had long been handed to retry while its process kept driving chunks
(zombie). The first hotfix (`c1ef205`) removed local draining, but its
parent-scoped keys allowed multiple queued jobs per page; production promptly
showed three lora-vip-of continuations and stale priority-30 work taking extra
DM turns ahead of lora-of. It also used `getJobById` as an ownership snapshot
and changed `createQueue` options that pg-boss ignores for an existing queue.

The final contract makes a pg-boss row a disposable wakeup, never the durable
work or retry authority. One queue job owns exactly ONE chunk. Every immediate
wakeup uses the ONE fixed singleton `String(pageId)`. A delayed yield is stored
only in `page_sync_states.retry_at`; the minutely planner materializes it when
due, so a future queue singleton cannot block an urgent manual request. Parent
completion and fixed-key child insertion happen in ONE PostgreSQL transaction
through pg-boss's caller-supplied `db` option (`complete → send`): the active
parent leaves the exclusive partial index before the child enters it, while a
crash/send failure rolls both back. `complete.affected !== 1` is ownership loss
and forbids the send; `send === null` after a successful completion means the
same page wakeup already exists and the transaction commits.

`sync.page.execute` has `retryLimit=0`: durable `page_sync_states`, lease
reclaim, and the planner are the single retry/reconciliation authority, so a
same-id pg-boss retry cannot create attempt ABA. Queue startup is declarative:
`createQueue → updateQueue → getQueue` must read back exclusive / 900s expiry /
30s heartbeat / zero retries or startup fails, and every new job pins 900/0
itself. Fifteen minutes is conservative operational headroom above the observed
3×60s and 4×60s OFAPI paths, not a formal request deadline; a 60s pre-expiry
handoff guard prevents a grandfathered/overrunning attempt from mutating queue
state. Local multi-chunk draining is removed, restoring pg-boss as the sole
page-order/group arbiter.

Two FSM fences close adjacent races exposed by the same investigation. An old
generation's delayed `yieldPageSync` may not overwrite a newer manual request:
the newer request source wins, `retry_at` is cleared, and the page remains
immediately runnable. A page lease is terminal once expired: heartbeat,
progress, yield/complete/retry/block/clear, and transactional ownership checks
all require an unexpired lease, so a stalled worker cannot resurrect or settle
an expired generation.
Non-goal, accepted: the provider-level breaker (#138's 3-distinct
rule) stays per-run even though runs are now shorter — quarantine
accumulation across runs already covers the cross-run case.

**Addendum to #141 (2026-07-12, bounded priority and one clock domain):**
fixed page singletons bound queue cardinality but do not by themselves bound
priority ownership: a long manual/onboarding/reset/anomaly generation could
replace every completed job with another boosted successor and starve a
scheduled page forever. Migration 0089 separates immutable request/audit origin
(`request_source`, still used as the `sync_runs.source` trigger) from mutable
queue admission class (`dispatch_source`). A new generation seeds both from its
request source. Its first attempted chunk consumes the dispatch boost: generic
yield, transient retry, and same-generation block re-enter as `scheduled`, while
an explicit handler continuation class is honored. The existing generation CAS
preserves both fields of a newer concurrent request, so an old chunk cannot
demote fresh manual work.

Cross-page scheduling is deliberately FIFO, not strict pg-boss numeric
priority. pg-boss priority has no aging: a continuously replaced scheduled
priority-30 page can starve an older priority-25 singleton forever, including
after durable state promotes that page to manual while its fixed queue row
retains 25. With one queued/active row per page, FIFO plus atomic successor
insertion at the tail is the fairness quantum: every older page in the egress
group gets a turn before that successor. `dispatch_source` still ranks streams
inside a page and orders the planner's initial materialization, but cannot grant
repeated cross-page ownership. We deliberately do not cancel/reinsert or reach
into pg-boss's private table to promote a colliding row; both alternatives add
a second ownership protocol and fetch/promotion races where FIFO needs none.

Rollout compatibility is part of the worker protocol, not a one-off queue
cleanup. A fetched wakeup whose key/options are not the canonical fixed
`String(pageId)` / 900s / retry0 contract is grandfathered: before any page
lease, sync run, or vendor request, the worker atomically completes it and
inserts the canonical child through the same `complete → send` transaction.
For an existing page it always attempts that child even when the preflight
durable snapshot is not runnable; otherwise a concurrent manual request could
collide with the active legacy fixed key and lose its only wakeup until the
planner. A genuinely missing/tombstoned page is complete-only. Multiple old
parent-scoped rows converge onto the one fixed child by singleton collision.

All ownership expiry decisions use PostgreSQL time. Expired lease reclaim
selects locked rows and CAS-updates them against `clock_timestamp()`; manual
requests test lease expiry under the same row lock; the pg-boss handoff guard
compares its database `started_on` to database time before `complete → send`.
Process `Date` remains a planner/cadence timestamp, never authority for whether
a worker or queue attempt still owns work. Real PostgreSQL tests pin both clock
skew directions, the shared-egress ordering `A → waiting B → A successor`, and
the inverse stale-priority case (`queued B@25`, durable manual promotion,
repeating `A@30`: B still runs first).

**Decision #142 (2026-07-12, complete current Fansly spender board — bounded
1000-row read):** `pageTopSpenders` raises only its request ceiling from 500 to
1000; the default remains 150. The live extension page that triggered this
decision has `fanCount=694`: the old response could report that total but had no
cursor/offset and could return only the same top 500, so rows 501–694 were
unreachable to client-side search and tiers. The tactical answer is one bounded
query, not pagination: the repository already executes one deterministic
`gross_mills DESC, platform_user_id ASC LIMIT n` read, and splitting a projection
that updates in place across independent HTTP requests would introduce
duplicate/skip races without a snapshot watermark. There is no DB migration,
handler change, new operation, or response-shape change. Above 1000 the response
remains deliberately truncated and `fanCount` continues to state the full total;
a future need beyond that ceiling must add snapshot-bound pagination rather than
remove the bound.

Compatibility order is load-bearing: deploy Core first, then release the
extension that requests 1000 for both lifetime and current-month windows. Old
extensions continue requesting 500 against the expanded server. The inverse
order reaches the old Core's exact limit-validation 400; for one release the new
extension recognizes only that exact response and retries once at 500, preserving
an honestly truncated board during a rollout mistake or urgent Core rollback.
Extension rollback is always safe; Core-first remains the normal rollout order.
`pnpm contracts:generate` refreshes OpenAPI/generated SDK/hash. The client does
not re-vendor for this compatible constraint expansion: it uses the same
operation and numeric query type, and the SDK runtime validates responses but
does not pre-parse request queries. This follows the client rule that compatible
evolution does not churn the vendored SDK without a new operation. The extension
must version its session cache (so a warm top-500 entry cannot survive the
upgrade), prove a 1000-row DOM/search/cursor path, and keep its existing honest
`top N of M` fallback.

**Decision #143 (2026-07-11, A8/B2 — AUTH_POLICY_ENFORCEMENT flipped
log → enforce):** The final owner-gated audit item is closed. Its precondition
was met: the trailing 48 hours contained zero `auth-policy would-*` divergence
lines, so log-mode shadow verdicts matched the legacy in-handler guards.
Production `AUTH_POLICY_ENFORCEMENT` was changed from `log` to `enforce` and the
API container alone was force-recreated because the flag is API-owned. The
environment file was backed up before the flip. Verification showed HTTP 200,
the running configuration at `enforce`, and zero post-restart auth-policy errors
or chatter lockout. Rollback is to restore `log` and recreate the API container.
`REVENUE_ROUTE_ROLE_ENFORCEMENT` was already enforced under #68. Removing the
now-redundant in-handler guards remains deferred work, not part of this ruling.

This uses #143 because #128 and #129 already contain the accepted backup and
erasure-policy rulings, #136 is the fan-dossier decision, #139 remains reserved,
and #140–#142 are assigned. The stale duplicate numbers from the original
in-flight branch must not be merged.

**Decision #144 (2026-07-13, revision-aware desktop harvest reconciliation):**
Desktop harvest manifests are cumulative custody checkpoints, not immutable
one-shot counts. Schema-v19 clients retain every uploaded natural-key/content
revision and atomically replace a per-machine
`chatgoose-harvest-manifest-<machine>-latest.json`; timestamped files remain
audit snapshots and can become stale after a later local revision. The Core
`harvest:reconcile` CLI therefore resolves a supplied timestamped v2 snapshot's
safe `reconcileUsing` basename to that canonical sibling. For compatibility it
also discovers the canonical sibling beside a legacy v1 timestamp when one
exists, while falling back to the v1 file when it does not. Canonical and
requested manifests must carry the same UUID machine id; path traversal is
rejected. Observation ingestion, producer gates, and wire schemas do not
change—the capture lane already accepts the revision metadata verbatim and the
existing machine/kind count remains the reconciliation authority.
An incomplete reconciliation exits non-zero so shell automation cannot mistake
the report for a passed custody gate.

**Decision #145 (2026-07-13, server-owned Desktop harvest authority and
machine-stable retry identity):** `x-client-version: harvest-*` is routing
metadata, never authority. A normal chatter API key or self-issued device token
can choose every request header and therefore may not journal canonicalizable
`harvest.*` facts. Migration 0090 adds one nullable, unique machine UUID to a
device-token row. Only an owner session can bind, transfer, or remove that
capability through the admin route; ingest requires the authenticated token's
server-loaded binding and requires every trusted harvest payload to carry that
exact machine UUID. Assigned-page resolution remains unchanged. Ordinary
client-capture kinds remain available to unprivileged device tokens, while any
attempt to claim the harvest producer without a binding fails 403 before the
capture transaction. Webhook, REST/readthrough, and all non-harvest
canonicalization paths are unchanged.

Harvest idempotency is machine + deterministic client event, not human
principal + event. That identity survives a different chatter signing into the
same preserved Desktop database. A partial expression index supports a bounded
compatibility lookup for immutable pre-0090 observations, whose keys retain the
old principal prefix; no captured row is rewritten or deleted. New concurrent
requests also converge through the existing observation-key uniqueness because
they construct the same machine key. Any duplicates already captured before
0090 remain visible for reconciliation and operator review.

Rollout is Core-first and fail-closed. Immediately after migration, the owner
binds each approved active Desktop token ID to the UUID in that machine's
manifest/diagnostics; uploaders retry their unchanged request bodies while the
binding is absent, so there is no compatibility translation or silent loss.
Rollback reopens the old header-trust behavior and is therefore an explicit
security rollback. Separately, a device-token-only self-service DELETE revokes
exactly the current credential and writes its audit row in the same transaction;
cookie sessions, API keys, and sibling device tokens cannot use that operation.

**Decision #146 (2026-07-13, bounded resumable Desktop state snapshots):**
`limit` on `GET /api/v1/events/snapshot` historically bounded only thread rows;
one response could still collect every hot/archive message in up to 50 threads
plus every unresolved tombstone. The additive `pageMode=bounded_v1` protocol
instead caps durable message-or-tombstone rows per response (`messageLimit`,
default 100, maximum 200) and carries an opaque `stateCursor`. That cursor binds
the account, requested sequence, sticky fanout snapshot cursor, state timestamp,
message limit, current thread, store phase, and row keyset; malformed or
scope-mismatched cursors fail 400. Tombstones page first, then each thread pages
its archive overlays before hot rows without an archive twin, preserving the
legacy archive-wins merge exactly and eventually returning every row. No row is
truncated; a formal byte ceiling is deliberately not claimed because one
retained message/media row is indivisible.

Compatibility is Core-first and additive. Legacy callers keep the original
thread-page response byte semantics and see no `nextStateCursor`. New Desktop
clients probe bounded mode with legacy `limit=1`; an old or rolled-back Core
strips the unknown query fields and omits `nextStateCursor`, so the client
idempotently switches to one-thread legacy pagination and still refuses to
checkpoint until every page is applied. A bounded response always includes
`nextStateCursor` (terminal `null` included), and only that terminal marker
authorizes the existing snapshot-cursor checkpoint.

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

**Decision #148 (2026-07-13, global personas become owner-admin content;
supersedes #115 and #147):** Global persona definitions and their full system
blocks are Core owner content. Desktop and Fansly Extension clients may select a
persona for a local account mapping, but may not create, edit, archive, or sync
definition text in steady state. New bearer clients read
`GET /api/v1/ai/persona-catalog`, whose active/archived entries contain only key,
display name, numeric version, and status. Full text is available only through
the owner-session `/api/v1/admin/ai/personas` surface. Owner create is
create-only; owner update and archive require the exact active numeric revision
and stale writers receive 409. Archived rows remain tombstones and there is no
restore operation.

This is a preservation-first rollout, not an immediate auth flip. The actually
shipped legacy full-text GET and bearer PUT/DELETE remain available until both
client fleets have released snapshot-before-read, complete JSON export,
catalog-only behavior, and no-write steady state. During that transition an
omitted-version PUT keeps the shipped last-write-wins/resurrection behavior and
an omitted-version DELETE keeps the shipped archive behavior; an identical
active replay is a true revision/timestamp no-op so reconnects cannot churn
catalog versions. The unshipped bearer lifecycle-state route from #147 is
removed. A later owner-gated release may close the legacy write routes only
after preservation/read-only coverage is demonstrated.

Bundled seeding is create-only. Once any row exists for a key—including an
owner-customized or archived row—every seed rerun and bundled-version increase
is a byte-for-byte no-op for its prompt, name, metadata, timestamps, revision,
and lifecycle state. The lifecycle-v2 release gate therefore requires exact
preservation-first read-only Desktop and Extension artifacts plus their
automated coverage, not the CAS-aware Extension receipt described by #147; it
remains fail-closed with no operator override.

**Decision #149 (2026-07-14, replay-journal retention remains contiguous-prefix
only):** A recent, pending, or failed replayable OFAPI webhook row blocks
automatic deletion of every later replayable frame, even when a later row is
old and fully projected/archived. The durable replay floor is proof of one
contiguous removed prefix; deleting around a blocker would make it a lossy
max-deleted approximation and could strand an offline client beyond missing
frames. Journal-only/non-replayable rows may still be removed independently
when their consumed guards pass. A persistent oldest blocker is an operator
repair/alert condition, not permission for the cleanup job to discard its tail.
The stale webhook retention test is corrected to match this already-pinned
behavior; the SSE regression continues to prove that a failed blocker retains
the eligible frame behind it until repaired.

**Decision #150 (2026-07-14, interrupted erasures resolve by immutable target,
never by latest log id):** One global session-level erasure lock is held across
planning, database deletion, post-commit lake rewrite, and log completion.
Erasures are rare break-glass operations, and page/model/fan scopes can rewrite
the same parquet file and `.erasure.tmp` path; scope-local locks are therefore
unsafe. This is distinct from page-id writer fence locks, which protect archive
material only inside the database transaction.

A successful retry creates its own auditable plan and, in the same completion
transaction, marks an earlier unresolved non-dry-run attempt `superseded` only
when both its selector (`scope_type + scope_ref`) and its stored immutable set of
resolved page IDs exactly match the converged row. Automatic adoption is also
limited to rows and plans stamped
`execution_protocol=global-erasure-lock-v1`: acquiring the same
global session lock proves that no stamped predecessor is still executing.
Protocol-null pre-cutover attempts might belong to a process that never took
this lock and therefore remain unresolved for explicit operator review, even
when their page IDs match. A reused label/slug with new page IDs, a newer
attempt, or any other scope likewise remains unresolved and continues to fail
snapshot recovery closed. Completed and superseded rows are resolved;
historical rows with `completed_at` but no new marker remain resolved for
compatibility. No `max(id)` heuristic is allowed to declare an older or
unrelated erasure complete.

**Decision #151 (2026-07-14, persona administration is read-only while legacy
LWW exists; catalog carries content identity):** Decision #148's owner surface
is intentionally read-only during the preservation window. Owner POST/PUT/DELETE
return 409 after owner authentication, and the dashboard renders no mutation
controls, until a later owner-gated release closes the shipped bearer LWW lane.
This prevents a legacy reconnect from silently destroying newly authored owner
prompt bytes without requiring a rushed partial prompt-history system. Full
owner reads remain available for migration review; legacy compatibility writes
remain exactly as specified by #148.

The metadata-only client catalog adds `definitionId`, an opaque `v1:` identity
derived from the exact key, display name, and system-block bytes. Clients compare
but never parse it, and the prompt text remains absent. Unlike monotonic database
revision, this identity remains truthful when disaster recovery restores an
older row/revision, so clients can invalidate persona-dependent caches and
in-flight work against the actual restored definition. A definition-aware
feature request sends that catalog value as `expectedPersonaDefinitionId`.
An omitted `personaKey` is only a compatibility alias for the active
database-backed `builtin:lora` row; it never reads bundled source prompt bytes,
and an archived/missing default fails closed.
Core resolves the persona and rejects either a byte mismatch or an
expected catalog entry that is now missing/archived with 409
`persona_definition_changed` before loading prompt context, reserving quota, or
invoking a provider. Requests without the precondition retain the legacy 400 for
an unavailable persona; the successful meta frame echoes the applied value as
`personaDefinitionId`. Both fields are additive and optional during fleet
rollout: an old request receives the old meta shape. Rollout is Core-first: the
old feature-body schema is strict and may reject the new request field with 400,
so clients enable the precondition only after observing the compatible catalog
and health contract. On an accepted request, a missing echo is an old/partial
Core signal rather than proof that the selected definition was applied.

**Decision #152 (2026-07-14, lifecycle gate constrains capability enablement,
not ordinary Core deploys):** Additive, repair, and emergency Core releases must
remain deployable while the Desktop/Extension preservation evidence is pending.
The deployment script therefore no longer aborts every invocation. The cutover
continues to fail closed: before release-file sync or stack replacement, deploy
interrogates the built candidate image's runtime capability manifest. Ordinary
Core candidates advertise none and proceed; any candidate advertising
`desktop-lifecycle-v2` is rejected until a later reviewed change implements
owner-gated verification of exact Desktop/Extension fleet artifacts. There is
no environment/status-file bypass. Public health exposes the
generated normalized-OpenAPI `contractHash`, so client release gates can compare
the running Core contract to their vendored SDK manifest without pretending a
route-local 401 proves schema compatibility or inventing source-SHA ancestry.
The large observations
harvest compatibility index is split from migration 0090 and built by an
explicit, idempotent `CREATE INDEX CONCURRENTLY IF NOT EXISTS` migration outside
a transaction while still under the global migration advisory lock. Deploy runs
the exact prefix through 0096 in a foreground candidate-image one-shot before
stack recreation, after capturing the schema baseline, so the old API remains
available throughout the long concurrent build. Recreate/rollback handling
cannot begin until that one-shot exits and releases the migration lock; startup's
twenty-minute health budget remains only crash/retry protection. Before the
one-shot starts, pending migrations through 0096 are compared with the captured
remote baseline; any non-allowlisted migration raises a rollback-forbidden
latch immediately, including the pre-ledger crash window of a concurrent index.

**Decision #153 (2026-07-14, cursor integrity terminology):** Domain-event
resume cursors v2/v3/v4 are canonical Base64URL JSON and are not MAC-signed.
Their recovery safety comes from strict shape/scope checks plus server-side
erasure epoch and retained-topology validation. The bounded OFAPI snapshot
`stateCursor` is a different contract and is HMAC-SHA256 signed with a key
version. Documentation and release descriptions must name which cursor they
mean; "signed recovery cursor" is not a valid description of domain-event v4.

**Decision #154 (2026-07-15, dead page proxies are named and dialed once):**
The lora-2 incident: a dead page SOCKS proxy made every AI generation on that
page hang ~31 seconds (Anthropic SDK default retry policy re-dialing a dead
proxy — three connect timeouts plus backoff) and surface to clients as the
generic `provider_stream_failed`, which the extension collapsed into its own
generic hub error; the cause was rediscovered by hand from the ledger and a
TCP probe. Three rulings. (1) The AI-lane stream catch classifies connect-level
failures (undici `ConnectTimeoutError`/`UND_ERR_CONNECT_TIMEOUT`,
`SocksClientError`, `ECONNREFUSED`-class codes anywhere in the cause chain —
`classifyProviderStreamFailure` in shared http-client) and emits the frame code
`provider_proxy_unreachable` with a static proxy-naming message; everything
else keeps `provider_stream_failed`. Frame messages stay static — the redacted
cause chain (`formatObservedError`) goes to the server log line only, never to
clients. (2) The page-proxy Anthropic client wraps its fetch in
`createStickyConnectFailureFetch`: the first connect-level failure is cached
for the rest of that client resolution (= one generation), so SDK retries fail
instantly instead of re-dialing a proxy that cannot recover within the request
(~31s → ~10s worst case, instant when the proxy refuses). HTTP-level retry
semantics (429/5xx) are untouched — only connect failures stick. (3) The frame
`code` remains an open string in the contract: clients match by prefix
(`provider*`), so new codes ship without a contract bump or SDK re-vendor. The
extension side of this incident is chatgoose E38.

**Decision #155 (2026-07-15, PPV poison-loop incident — canonical refs +
serve-time tourniquet):** `message.ppv_unlocked` canonicalization shipped the
webhook's top-level `user_id` as `conversationRef`/`fanIdentityRef`. On this
notification kind that field is the RECIPIENT CREATOR (the same live-verified
trap `tips.received` already documents in `ofapi-payloads.ts`), so every one
of the 70 ledgered ppv events named a non-existent conversation. Desktop
≥0.1.37 deterministically rejected those frames, froze its v2 cursor, and its
SSE reconnect loop burned ~14k OFAPI credits in one night (nginx forensics
2026-07-15; the `ofapi_burn_rate:global` alert fired 00:44 MSK and went
unacted). Ruling: (a) notification-kind refs come ONLY from
`notificationChatId()` / `extractMessageIdFromNotification()`
(payload.user.id / the `{MESSAGE_LINK}` chat path); an unresolvable chat
publishes NO event — the observation stays journaled unparsed rather than
shipping refs that poison every conversation-resolving consumer. No
canonicalizer version bump: replayed history would dedup away on
`ppv:<notificationId>`, so a v4 sweep buys nothing. (b) A TEMPORARY serve-time
suppression of `message.ppv_unlocked` on the v2 stream
(`SUPPRESSED_V2_FRAME_TYPES`, modules/events) unwedges every fielded desktop
with one deploy: the account watermark still advances via the next delivered
frame, and the suppressed events lose nothing consumers use (wrong-ref'd,
no-op in v1 projections/archive — that archive comment recorded the ref as
unreliable BEFORE the incident; a consumer hardening its checks must consult
the producer's recorded deviations). REMOVE once `x-client-version` shows the
fleet on a non-rejecting desktop (its D17). (c) The 70 bad rows are NOT
rewritten — `domain_events` stays append-only; repair follows the
`fansly-1970-repair.ts` superseding pattern as a follow-up wave, alongside ppv
facts entering snapshots and the read-budget gate (incident plan P1/P3).

**Decision #156 (2026-07-15, Split mode is a strict prompt request, not an
output guarantee):** A `fast-reply` request with `replyMode=preferSplit` now
instructs the model to return two short `[NEXT]`-separated parts minimum and
three maximum. The prior opt-out that allowed one unsplit message when a split
felt forced is removed; two parts are the default and a third is reserved for
content that genuinely benefits from another send.

This is a prompt-level generation requirement, not deterministic transport
enforcement. Provider output remains probabilistic: the reply normalizer does
not invent or duplicate text when the model returns one usable part, and does
not silently truncate extra usable parts when the model exceeds the requested
maximum. It continues to split and sanitize the completed output it actually
receives. The prompt regression suite pins the 2–3-part instruction and the
absence of the old single-message opt-out; the output suite pins the unchanged
fallback behavior.

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

**Decision #158 (2026-07-16, OnlyFans mirror is capture-before-parse and
DB-first by proven surface; supersedes the REST-bootstrap transport in #49 and
the webhook-only history boundary in #52):** The target is a durable local
mirror of in-scope OnlyFans DM and campaign facts. Every governed vendor call
belongs to exactly one durable `capture_job` or `interactive_request`; admission
creates the attempt before dispatch, a CAS transition grants dispatch, and the
exact response envelope is committed before parsing or serving. A captured
response is parsed locally without another vendor call. `contract_rejected`
freezes cursor and coverage; an adapter repair replays the saved envelope.
History work is finite, page-qualified, frozen-target, budgeted, and
intent-driven. A changed chat head is evidence, never permission to fan out
paid pagination. The legacy OnlyFans `dm_messages` crawler is permanently
retired in capabilities, durable state, executor dispatch, dashboard controls,
and deploy rollback; Fansly remains unchanged.

Correctness lives in append-only observations/domain events plus rebuildable
projections, not in retained sync telemetry. Coverage is a terminal fact with
explicit proof lineage and can be revoked; item presence or artifact checksum
alone never proves continuous history. Campaign recipients are materialized
only from explicit vendor identity evidence and `unknown` is not `false`.
Bulk/import facts carry immutable provenance. Fanout is selected by a
versioned profile bound to the resume cursor; hidden ranges advance through a
server checkpoint and are not rescanned on reconnect. Reobservation of a fact
already imported receives a new event sequence but is presented to compatible
clients as the original actionable message kind, not as an unknown literal
event. Campaign fanout remains capture-only until a canary proves an explicit
campaign/queue association and a compatible invalidate contract.

DB-first rollout is per surface: `chats_list`, `chat_messages_tail`,
`chat_messages_history(first_id)`, and `chat_message_specific` each move
`live → shadow → db_fallback → db_only` only when serving shape, freshness,
coverage, projection high-water, and client compatibility are all proven.
`GET .../messages` is not classified as a pure read: fielded Desktop uses its
vendor mark-read side effect. Therefore history retrieval and explicit
mark-read must be split in the client/protocol before any messages surface can
become DB-only. The serving projection preserves native order/id, original
HTML/text, read flags, reply/tip/media metadata, tombstones, provenance, and
event sequence; media bytes and expiring signed URLs stay out of scope.
Archive import uses a trusted historical timestamp policy rather than the
generic pre-2024 timestamp clamp. All new producers and read modes ship
default-off; production migration, live probes, cohort/export spending, and
each DB-only cutover remain explicit rollout gates.

The first S5a implementation is deliberately quote-only: an owner-created
`account_export` job may issue one captured create with `auto_start=false` and
captured status GETs bounded to a 15-minute cadence and one day. It exposes no
approve/start/download/import path; stateful uncertainty or contract drift
keeps the single page export slot blocked until independent vendor
reconciliation. Only a fully bound captured quote or explicit vendor
calculation failure may release that slot. The operating sequence is pinned in
`docs/runbooks/ofapi-export-quote.md`.

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

**Decision #160 (2026-07-17, legacy OFAPI budget lanes and governed mirror
share one atomic physical cap):** Audience, fan-identity, and chargeback reads
retain their dedicated day ceilings, but each pre-dispatch reservation now
increments that dedicated counter and the global OFAPI counter in one
conditional `ofapi_credit_state` statement. The response ledger sink records
the actual global spend; settlement adjusts the dedicated estimate to actual
and releases the temporary global estimate. A crash between settlement steps
can only leave a conservative reservation until UTC rollover. Consequently the
background mirror executor may run beside those product lanes without a
non-atomic overspend window or disabling subscription/identity/chargeback
freshness. The background flag still creates no work: only explicit durable
capture intents are drained.

**Decision #161 (2026-07-17, recurring/off-box backups are not an OF Mirror
requirement; supersedes #159 and reaffirms #128):** The owner explicitly
withdraws the encrypted off-box PostgreSQL backup, backup-provider selection,
retention/alerting, and recurring disaster-recovery restore drill from the
project. None of them gates S1/S2, archive cohorts, DB-first serving, tiering,
or production activation. Loss of the VPS or its storage may therefore cause
permanent loss of locally captured history; that consequence is accepted and
must not be reopened as an implementation blocker without a new owner
decision. The export-artifact bucket remains in scope as the primary durable
copy of a temporary vendor export needed for import, not as a database backup.
Checksums and replay/round-trip checks that protect an actual import or
destructive tier/drop remain data-movement correctness checks, not a backup
program. No runtime flag or code path may depend on backup availability.

**Decision #162 (2026-07-17, OFAPI message cursor semantics are verified per
captured page):** The first production S2 pilot proved that OFAPI now treats
`first_id` as exclusive: two non-empty responses started at the message older
than the requested frozen head, and the one-message chat returned an empty
terminal page. This contradicts the inclusive behavior recorded in #49 and
caused all three bounded pilot jobs to stop safely as `contract_rejected`
without advancing coverage. The v2 capture contract therefore infers
inclusive versus exclusive behavior from each saved response, persists the
inferred mode in the job cursor, and rejects a mid-chain mode change. An
exclusive page is accepted only when every returned numeric message id is
strictly older than the requested boundary; an unverifiable or wrong-side edge
remains blocked. Local replay upgrades the job's contract/parser versions and
reuses the already-paid response; it never dispatches OFAPI. The proof policy
itself is unchanged: the frozen head remains an item-presence fact from the
List-Chats/live projection and pagination proves the older range.

**Decision #163 (2026-07-17, one bounded scraping-backed OFAPI export pilot
may start; narrows the quote-only boundary in #158):** The owner authorizes an
explicitly approved S5a pilot for one OnlyFans page, one to three frozen chat
IDs, at most 1,000 exported messages, and at most 50 credits. Fleet exports
remain quote-only. Approval is an owner-audited CAS transition from a captured
`owner_approval_required` or `export_quote_requires_start` state, defaults to
dry-run, and names both the current job row version and maximum credits. It
permits one stateful `POST .../start`; an indeterminate start is never retried
automatically. The complete ceiling stays conservatively settled against that
attempt until a captured terminal status supplies the exact cost, after which
the ledger and job spend are reconciled once. Status GETs are safe, bounded,
and may retry. A completion is usable only when `total_rows = rows_processed`,
`failed_downloads = 0`, the row and cost caps hold, and a temporary HTTPS
download URL is present. The job then stops at `artifact_capture_required`:
no import, coverage proof, or larger cohort is authorized until the artifact
is copied into our controlled storage, checksummed, and its real CSV contract
passes a pilot review.

**Decision #164 (2026-07-17, the checked pilot artifact may be imported as
item presence only):** The first bounded export completed with 707 records for
the three frozen chats at an exact cost of 36 credits. Its RFC-4180 CSV has 33
stable columns, no duplicate message IDs, and no malformed records. However,
despite a 2016 start date, the delivered records cover only the most recent
seven days. Therefore the artifact is useful message material but is not
evidence of continuous history and cannot produce or upgrade an
`ofapi.capture_completed.v1` fact.

An owner may register only `<account_export job UUID>.csv` from the configured
read-only artifact directory. The route defaults to dry-run and rechecks the
terminal row count, exact header, account, frozen chat set, date bounds, unique
message IDs, byte limit, and SHA-256 before journaling one pointer observation
and creating one local `export_import` job. The worker repeats the size,
checksum, and contract checks before materialization; it performs no OFAPI
request and spends no credits. Imported message material is projection-only
and yields bounded cursor checkpoints, never business SSE frames. Because the
CSV omits reply and full media identities, those fields are marked unobserved
and cannot erase richer live material during an upsert. A successful import is
terminal `item_presence` with `continuousHistory=false`; fleet export/import
still requires a separate bounded decision after this vertical slice is
verified in production.

**Decision #165 (2026-07-17, Fansly purchase history is a media-scoped walk
over captured DM evidence):** The production failure was a contract error in
our client, not a reason to disable the product permanently. Fansly's
`/media/orderhistory` requires exactly one observed `accountMediaId` or
`accountMediaBundleId`; `accountIds` is only an optional buyer filter. A live
read-only probe with one Lilly media id returned HTTP 200, while the old
fan-only request returned HTTP 400/code 99 `missing accountMediaId`.

The replacement creates no second queue or media table. It keyset-scans the
already retained `sync_raw_payloads(endpoint='dm_messages')`, extracts only PPV
attachments plus media ids proven by inline `accountMediaOrders`, and stores
the raw-row high-water and bounded pending targets in the existing sync
checkpoint before egress. A target-specific `purchase_history` raw capture is
the durable dedupe fact; a crash after capture is reconciled locally without a
second vendor request. HTTP 404/410 is target-local and captured; every HTTP
400, auth/rate-limit/server failure, an unknown successful response shape, or
a response at the cursorless 100-row cap fails visibly rather than certifying
false completeness. There is never a fan×media cartesian walk.

Sync-pull canonicalizer v4 also emits `message.ppv_unlocked` from
`accountMediaOrders` embedded in newly captured DM pages, so new purchases do
not wait for the historical walk. Production observations prove their
`createdAt` values are epoch seconds; v4 uses the Fansly seconds/milliseconds
codec, preventing 1970 events. Existing historical DM observations are locally
replayable under v4. The stream remains feature-gated for a bounded ramp, but
the corrected implementation is now eligible to replace the 2026-07-06
temporary disablement recorded in Stage 16.

**Decision #166 (2026-07-17, page health reports actionable freshness; a
moving Fansly follower list gets one bounded restart):** Fansly follower pages
are a live list, not a transactional snapshot. If a complete reconcile walk
differs from the headline count, the first mismatch starts one fresh generation
and records that restart in the checkpoint. A second mismatch blocks exactly as
before, and neither mismatch may deactivate rows. This repairs transient
one-row drift without converting it into an unbounded provider loop.

The dashboard page-level health summary now evaluates only streams applicable
to that page under the current feature gates. `fan_earnings` and
`purchase_history` are bulk enrichment and remain fully visible in the detailed
sync monitor, but no longer paint otherwise-current Fansly page data red.
OnlyFans compatibility/no-op rows (`light`, legacy `transactions`, retired
`dm_messages`) and disabled audience/DM/top-spender/identity lanes are likewise
excluded; enabled OFAPI lanes still participate and can require attention.
This changes only the summary signal, never scheduling, capture, detailed
observability, or stored data. The OFAPI audience sweep and live subscription
projection also refresh `pages.subscriber_count` from authoritative current
`page_subscriptions`; previously both pages had thousands of current rows but
the reporting cache stayed null forever, producing the dashboard's false
`N/A`.

**Decision #167 (2026-07-18, coach-chat feature lane — stateless multi-turn
coach, two-slot recap attach, short fan-summary variant, `includesFanBio`
policy flag, recap-status read, and canonical coach/recap identity):** Core
gains a new AI feature `coach-chat` on the feature lane (`POST
/api/v1/ai/features/coach-chat`, SSE like every feature, fail-closed on
transport truncation and on the normalized output-exhaustion signal). The
coach is stateless server-side: the multi-turn dialog is client-held and
replayed each turn as `coachHistory` (completed exchanges only, oldest first)
alongside the required free-form `chatterQuestion`; the kernel keeps no
session. `chatterQuestion` is 1–2000 chars, required for coach-chat and
rejected for every other feature; `coachHistory` is coach-only with a hard
ceiling of ≤20 entries, `question` ≤2000 chars, `answer` ≤64000 chars.
Serializability follows the owner-approved option "c" (2026-07-18): the coach
keeps its adaptive thinking budget (16k, no output-token cap games), and the
`answer` bound is a TRANSPORT ceiling, not a prompt bound. The same
`COACH_ANSWER_MAX_CHARS` (64000, one shared contract constant) is enforced
identically on the live coach-chat output stream — a generation whose
accumulated visible output crosses it errors WITHOUT a `done` frame and is
terminal-recorded as failed, so it can never be attached/committed. Therefore
every committed answer is ≤ the ceiling and replays verbatim within schema. The
old 120k aggregate reject is REMOVED (a schema-valid-yet-gate-rejected zone was
an API defect): a client trimming to its window setting is never rejected, and
transport abuse is the route's job (a scoped 12 MiB body limit sized
content-agnostically for the worst case, NOT a content policy: 20×66k history +
a 300k transcript + the smaller free-text fields sum to ~1.69M UTF-16 code units,
and the true per-code-unit worst case on the JSON wire is SIX bytes — a lone
surrogate (U+D800) or an ASCII control char is a legal JSON string value that
JSON.stringify escapes to a six-byte `\uXXXX` sequence — so ~1.69M × 6 ≈ 10.1MB
(a printable 3-byte-UTF-8 char is only ~5.06MB, well under). Round-3 briefly
banned control chars in the large fields to hold a 3-byte/char ceiling at 8 MiB,
but round-4 (P2-4) REVERTED that ban: it regressed every live Fansly feature
whose transcript carries arbitrary fan text (a stray control char 400'd the whole
request) and was invisible in the generated OpenAPI, so the fields are plain
bounded strings again and the limit was raised 8 MiB → 12 MiB to absorb the
six-byte worst case with headroom while genuine transport abuse still 413s). The 2500-token base
`max_tokens` is NOT a character-serializability guarantee and must not be
described as one; prompt cost is bounded core-side instead. Before assembly core
projects each accepted history answer to a ≤10k head+tail replay (6000 head +
3800 tail + an explicit `[… N chars omitted …]` marker, code-point-safe), then
the newest-first 60k history budget sheds on the EXACT rendered size (escaping +
XML-wrapper overhead included), so an oversized newest entry can no longer
overshoot the budget. The extension applies the same ≤10k projection only as a
bandwidth optimization; correctness never depends on it. When the prompt still
cannot fit the worst case, core sheds deterministically: protect the question,
the safety/methodology system prompt, and the newest transcript, then drop
oldest coach exchanges, then trim/dedupe recap and dossier. An unrecognized feature
name returns the structured `unknown_ai_feature` error (not a bare 404) so the
extension can distinguish "needs a newer Hub" from an unauthorized/missing
page.

Fan bio inclusion becomes a shared `includesFanBio` policy flag instead of the
hard-coded `feature === "hi-greeting"` bio check — enabled for `hi-greeting`
(unchanged), `help-me` (its prior absence was a bug), and `coach-chat`. The
coach prompt template is laid out cache-safe: the stable, high-reuse sections
(agency methodology / persona / fan context) precede the volatile ones
(rolling history, then the current question) so the provider prompt-cache
prefix survives turn-to-turn, and the prompt-manifest hashes were re-snapshot
to match.

Recap gains a short variant of `fan-summary`: an optional `summaryMode:
'short'` (valid only for `fan-summary`, sent only for the short run — omitted
means legacy full, so an older core never sees the field) drives a fixed
300-message window and a compact template with a hard mode-specific output cap
(full's adaptive reservation must not apply). A short recap is stored under a
mode-qualified local cache key (legacy unqualified keys read as full) and is
never pushed to the `fan_profiles` dossier, so a short run cannot overwrite the
durable full profile. Truncation or output-exhaustion fails closed for coach
and both recap sizes — a truncated recap is never cached, pushed as dossier, or
attached.

On every coach turn core selects two slots from the restricted generation
store — the freshest usable full recap and the freshest usable short recap
(terminal `completed`, non-empty, no exhaustion stop reason, `params` carrying
`summaryMode`/coverage/requested-and-kept counts/persona so legacy rows are
excluded, deterministic `ORDER BY created_at DESC, id DESC`) via a composite
index. Attach rule: only one exists → attach it; both exist and the full is
newer → attach the full only; the short is newer → attach BOTH, each labeled
with age and role. Lookup failure fails open (coach proceeds recap-less,
recorded in the context manifest); a recap identical to the injected dossier is
injected once. A new metadata-only, page-scoped SDK read `GET
/api/v1/ai/recap-status` (operation `aiRecapStatus`) returns both slots'
generated-at/coverage/counts (or "none") with no generation and no AI spend,
preserving the invariant that opening Coach incurs no AI cost. Coach and recap
requests adopt the canonical identity `conversationRef = Fansly groupId` and
`fanRef = fanAccountId` (the contract already separates these); during
transition the attach lookup searches both the canonical and the legacy
`fanAccountId ?? groupId` key. Extension spec: chatgoose
`docs/superpowers/specs/2026-07-17-coach-chat-design.md` (§5 recap, §7 kernel
contract); the `ai_usage_events.feature` enum gains `coach-chat` via a numbered
forward migration and the Usage dashboard's fixed feature column list.

**Decision #168 (2026-07-18, governed interactive OFAPI budgets are per user
per UTC day):** The initial capture-first safety limits of 60 calls per UTC
hour and 250 shared interactive credits per UTC day blocked ordinary desktop
reads while the vendor remained healthy. Governed mirror reads now allow each
origin principal up to 4,000 calls and 4,000 reserved credits per UTC day. The
principal window and its retry boundary both reset at the next UTC day; the
shared 250-credit ceiling is removed.

Mirror capture uses its own 40,000-credit global daily stop-loss instead of
reusing the legacy DM-sync budget. The existing balance floor, durable
reservation accounting, per-job bulk caps, and explicit incident pause remain
unchanged. `OFAPI_DM_DAILY_CREDIT_BUDGET` continues to govern only the legacy
DM-sync path.

**Decision #169 (2026-07-18, owner adjustment to #168):** The per-principal
governed mirror allowance is 7,000 calls and 7,000 reserved credits per UTC
day. This supersedes only the 4,000/4,000 values in #168; its UTC-day window,
40,000-credit global stop-loss, balance floor, and all other safeguards remain
unchanged.

**Decision #170 (2026-07-18, owner clarification to #168 and #169):** The
governed mirror budget is 4,000 calls and 4,000 reserved credits per origin
principal per UTC day, with a 7,000-credit global ceiling across all
principals for that UTC day. This supersedes the numeric allowances in #168
and #169; their UTC-day reset, balance floor, and remaining safeguards are
unchanged.

**Decision #171 (2026-07-18, partial sync pauses stay precise and
recoverable):** Product surfaces preserve the page summary's distinction
between a fully paused page and one paused applicable stream instead of
collapsing both to the same `Data updates paused` banner. Owner links from the
overview and page detail deep-link to that page's Sync workspace.

Detailed block controls expose Resume whenever an operational substream is
paused even if the block's primary truth remains current and its aggregate
badge is `Up to date`. While that recovery is available, `Sync Now` and Pause
are hidden because neither is the action that clears the paused state. Resume
re-requests only the block rows that were actually paused, so recovering one
supporting stream cannot restart already-healthy vendor work. Visible
OnlyFans compatibility/no-op rows (`light`, legacy `transactions`, retired
`dm_messages`) remain auditable but never manufacture a Resume action. This
changes only operator copy and control reachability; applicability, scheduling,
stored data, and Decision #166 page-health policy remain unchanged.

**Decision #172 (2026-07-18, dist-only releases rebase on one pinned clean
full image):** A production full build publishes a clean base alias keyed by
the dependency checksum after the deployed candidate passes all
health, capability, label, sync, and dashboard verification. A dist-only
release must build from that pinned full image and refuses to run when the tag
is absent, unlabeled without an explicit compatibility override, or labeled
with a different dependency checksum. The running production image and its
rollback snapshot are never retagged as a dist base. Consequently every
dist-only image is the clean full image plus exactly one current artifact
overlay instead of an unbounded chain of previous releases.

The overlay mirrors the full runtime image and contains only dashboard,
runtime, database bundle, and migration outputs. Internal contracts, Fansly,
platform-core, and shared bundles are already incorporated into the runtime
and database production bundles and are not copied as separate runtime paths.
The full image installs only Playwright's Chromium headless shell, which is the
binary used by both runtime launch sites, and removes package-manager indexes
in the same layer. Image/tag garbage collection remains an explicit,
owner-gated operation so current, rollback, and the checksum-pinned clean base
cannot be deleted by an unscoped prune.

**Decision #173 (2026-07-19, recovery generations stay monotonic and partial
production failures stay visible):** Resetting a sync checkpoint does not
reset the retained projection rows that carry generation numbers. Every fresh
Fansly follower, Fansly/OFAPI subscriber, and Fansly DM-conversation sweep
therefore starts at `max(checkpoint generation, retained-row generation) + 1`,
including inactive or hidden rows. A valid in-progress cursor resumes without
another high-water read, and finalization keeps the existing `< generation`
retirement predicate. This makes the existing owner Reset operation safe after
a consistency block without deleting facts or adding a migration.

Public sync health degrades when any applicable task is terminal `failed`, even
when an up-to-date or paused primary task hides that failure at block level.
Only the task state is authoritative: `needsAttention`, dependency delays, and
ordinary pauses do not trip the gate. Existing block-level counters retain
their meaning; a hidden failure is reported as `failed_tasks` and supplies the
public error summary.

OFAPI chargeback reconciliation uses a full-history first walk with neither
date boundary and paired start/end boundaries from one clock instant on
trailing walks. An unexpected vendor or database failure is isolated to its
page so the remaining fleet still converges; only after the fleet pass does the
worker fail, and a single deduplicated global incident remains open until an
all-written clean run. The queue is reconciled at startup to a zero retry
limit, so one scheduled job performs exactly one fleet pass instead of
repurchasing healthy pages. A request without a response keeps its durable
credit estimate charged in
the conservative direction while only its in-memory lifecycle token is
released for the next page.

**Decision #174 (2026-07-18, voice notes are a page-scoped kernel render lane
with a durable single-dispatch state machine; supersedes #36 for the bounded
voice-audio artifact class):** ElevenLabs voice notes ship as a first-class
kernel feature, not a client-side integration: the extension holds no vendor
key and never calls ElevenLabs. A new `voice-script` feature rides the existing
SSE feature lane to compose the spoken script from refs + `clientContext`
exactly like every other AI feature, and the render itself is driven by three
page-scoped routes — POST to admit a render, a status poll, and an audio fetch —
each returning structured `voice_*` error/outcome codes plus `idempotency_mismatch` and `artifact_expired` so the client maps
failures by code, not by prose. Every render is a durable job in `voice_notes`
governed by the decision-#158 discipline: admission creates the attempt before
any dispatch, a CAS transition grants exactly one dispatch under a fenced
`attempt_token` + `lease_until`, and only the fencing token may settle the
terminal row; a lease-expiry sweep resolves abandoned dispatches to
`indeterminate` rather than retrying, because an unacknowledged provider call is
never silently re-sent. A truncated script stream is an error, never a
render input.

The rendered audio is stored as bounded `BYTEA` inline on the job row — capped
at ≤2 MB per row and nulled by a logged 7-day retention purge that flips the row
to `artifact_expired`. This **explicitly supersedes Decision #36's
"Postgres text/JSON only; no binary storage" rule for this one bounded,
short-lived, self-purging artifact class** and for it alone: no object store,
no unbounded blobs, no other artifact type is admitted by this carve-out. The
audio bytes and any expiring provider URLs stay out of every projection and
export.

ElevenLabs is a new `vendor:"elevenlabs"` egress class: a non-platform vendor
reached directly and unpaced, distinct from the platform (Fansly/OFAPI) egress
that the per-page proxy pacer governs — it carries no chatter session and no
model-ban risk, so it does not ride the platform rate limiter, but it is still
named as its own class for budgeting and observability. Character spend is
metered by the `voice_notes` rows themselves plus per-day `voice_char_budget`
scope counters (page and global), reserved atomically before dispatch and
refunded on settle. This ledger is deliberately kept OUT of `ai_usage_events`,
whose provider `CHECK` stays `anthropic | openrouter`; voice characters are not
token spend and must not pollute the AI gateway's accounting or its provider
domain.

The whole lane is gated behind `VOICE_NOTES_ENABLED` (default off) and a
fail-closed page allowlist: with the flag off or a page absent from the
allowlist, the feature, routes, executor dispatch, and capability hint are all
inert. Owner sign-off for the #36 supersession is requested explicitly in this
PR's description — merging the code lands the mechanism, but the documented
carve-out from #36 is the owner's to ratify.

**Decision #175 (2026-07-20, voice pilot hardening clarifies identity,
artifact, billing-view, and concurrency invariants):** `voice-script` is a
Fansly-only precursor to synthesis. Before any LLM spend it now requires the
live voice switch, fail-closed page allowlist, configured ElevenLabs provider,
page voice profile, and a nonblank fan identity carried identically in
`conversationRef` and `fanRef`. Synthesis admission accepts the resulting
restricted generation only when its user, page, conversation, and fan refs all
match the requested fan. This removes the group-id fallback and makes fan-scope
erasure address a new voice artifact directly by its canonical fan ref.

The ElevenLabs adapter still performs exactly one client fetch and zero
automatic retries, but redirects now fail instead of forwarding the API key and
script. Successful bodies are streamed under the 2 MiB ceiling, require exact
`audio/mpeg`, and must contain a complete first MPEG Layer III frame (directly
or after a valid ID3v2 header). Blank `character-cost` is unknown, never zero.
The database independently binds `audio_bytes_len` to
`octet_length(audio_bytes)` and the same cap. Invalid, truncated, wrong-MIME,
or oversized 200 responses remain possibly billed and never become playable
artifacts.

`VOICE_NOTES_MAX_CONCURRENT_SYNTHESES` is enforced by a process-local gate for
the current single-API deployment. A saturated job remains `queued` without a
dispatch lease; only after a permit opens does it re-read the live switch,
allowlist, and limit and attempt the one queued→dispatched CAS. Thus waiting
cannot expire a dispatch lease, a disabled/de-allowlisted job cannot slip into
ElevenLabs later, and a sweep that wins the row prevents provider dispatch.
Running multiple API replicas would require replacing this gate with a shared
one before enabling more than one replica.

Finally, the existing 24-hour reservation release for stale
`indeterminate` rows may use `billed=false` only as an internal one-time budget
release marker. Every public status projection for an `indeterminate` row
returns `billed:null`; neither the client nor an operator may interpret the
internal marker as proof that ElevenLabs did not charge.

**Decision #176 (2026-07-20, local Docker use is opt-in and production build
caches stay architecture-scoped):** Development and local-test Postgres no
longer use `restart: unless-stopped`; local work starts the database explicitly,
so reopening Docker Desktop does not silently revive an idle checkout. Every
local Compose service uses Docker's rotating `local` log driver, bounded to
three 10 MiB files. Production Compose restart and logging policies are
unchanged.

The production Dockerfile uses BuildKit cache mounts with distinct target- and
native-build architecture keys for pnpm and Corepack. Workspace manifests are
copied before source trees so ordinary source changes reuse the dependency
layer, while nested host `node_modules` and package build outputs are excluded
from the context. The runtime keeps Decision #172's Chromium Headless Shell and
package-index cleanup, and CI launches that bundled browser from the final
runtime image. This does not change #172's checksum-pinned clean-base lifecycle
or its owner-gated image/tag garbage collection; deploys do not automatically
promote a local cache tag or delete candidate image tags.

**Decision #177 (2026-07-21, prompt dossiers require Core-owned usable full-recap
proof):** A `fan_profiles` row is preserved and remains visible through the
profile/history APIs regardless of provenance, but it may enter an AI prompt
only when Core's restricted generation ledger independently proves the exact
body came from a usable full `fan-summary`. Eligibility requires the same
terminal facts as recap attachment: `summaryMode = full`, completed outcome,
nonblank completion, a present stop reason other than `max_tokens`/`length`,
the same page and fan identity, and byte-for-byte equality between the stored
profile body and the terminal completion. Modern Fansly rows match `fan_ref`;
OnlyFans and legacy Fansly full-recap rows may match `conversation_ref` only
while `fan_ref` is null. Filtering precedes profile-version ordering, so a newer unproven dossier
cannot hide an older proven one.

The prompt's dossier date is the matching Core terminal record's `created_at`,
not client-supplied `source_generated_at` or the later Hub append time. This
closes the Decision #136 / ChatGoose E45 residual where an output-exhausted
pre-guard recap had already reached Hub: its partial completion may remain as
an audit fact but cannot be injected. No public contract, SDK, or database
migration changes; current clients self-heal naturally on a fresh successful
full recap and its existing profile sync.

**Decision #178 (2026-07-22, v2 stream control lane and the replay-completion
marker):** The v2 domain-event stream carries a third SSE lane, `event:
control` — connection-scoped signals that are not domain events and never
enter DomainEventFrame validation (the vendored SDK's `subscribeDomainEvents`
consumes only `event: domain` and hard-fails the subscription on an invalid
domain frame, which is exactly why the marker must NOT be a synthetic domain
frame with zero accountId/accountSeq). Its first member is
`{"type":"replay_completed"}`, written once per connection after all replay
work (cursor resume and/or post-snapshot catch-up) has flushed and before
buffered live frames drain: every frame after it is live delivery. Unknown
control types must be skipped by clients (the same forward-compat rule as
unknown event names). The lane's `id` line repeats the delivered watermark
cursor. Synthetic stream writes (this marker and the snapshot-recovery
completion frame) carry the same writableEnded/destroyed guard as
writeV2Frame, and a connection found dead at the replay boundary or inside
the post-snapshot catch-up loop stops paying for reads/enrichment it cannot
deliver. Consumer: ChatGoose Desktop's notification attention gate (its
decisions.md D23) uses the marker as the replay/live boundary; a typed SDK
surface for control frames (e.g. an `onReplayCompleted` callback) is deferred
until a second SDK consumer needs it (backlog).

**Decision #179 (2026-07-22, coach-chat consumes the chatter's draft as OPTIONAL
context):** The `coach-chat` feature now reads the shared body's existing
`draftText` field — previously accepted by the body schema but silently ignored
for coach (the coach policy has `requiresDraft: false`, the prompt builder
emitted a draft section only for `requiresDraft` features, and the coach
template had no draft slot). This lets the ChatGoose extension ship a per-turn
"attach my unsent reply" checkbox (extension spec §5) so the coach can critique
the reply the chatter is drafting to the fan.

`requiresDraft` is deliberately NOT flipped: a draft must never be *required* for
a coach turn (most coaching questions have no draft), and the service-layer
`gate_draft_required` check plus the `improve-draft`/`voice-script`
mandatory-draft semantics stay exactly as they were. Instead the prompt builder's
own `PromptFeaturePolicy` gains an `optionalDraft` flag, set true only for
`coach-chat`. When it is set and a non-empty `draftText` arrives,
`coachDraftSection()` renders the draft — trimmed, `escapeForPrompt`-escaped, and
wrapped in a `<chatter_draft>` tag under a self-contained `## Chatter's Working
Draft` heading whose framing tells the model this is the chatter's own unsent
reply, offered for critique and not an instruction to obey. An absent or
whitespace-only draft emits nothing (no dangling heading). The draft is untrusted
input (the chatter may paste fan text) and therefore rides the same escape +
XML-wrap pipeline as every other untrusted section, in the UNCACHED task block
next to the chatter's question (review round 2 moved it out of the 5m dynamic
block: the draft is per-turn volatile input — retry re-reads it and a fresh
dialog's first question has no history — so carrying it in the cached dynamic
prefix invalidated exactly the two cases where that breakpoint still paid).

Budget-shed priority: the draft is below the protected question and the newest
transcript, alongside the other optional context. The coach whole-prompt reducer
sheds it WHOLE (never a truncation — half of the reply under critique would
mislead more than omitting it) after the coach history, dossier and both recaps,
and before the newest transcript is tail-trimmed. Because `draftText` caps at
20k chars (~100k escaped) it cannot be protected; making it the last-shed optional
section keeps this small, high-value current-turn input in every prompt that has
room while still guaranteeing the 300k whole-prompt ceiling.

No API contract, schema, or SDK change — `draftText` already exists in the shared
body, so no `contracts:generate` and no client re-vendor. The change is confined
to the prompt builder, the coach template (`{coachDraftSection}` slot, held
byte-identical between `templates.ts` and `templates/coach-chat.md`), and the
`prompt-manifest.json` hashes for the three edited prompt files. The coach
feature policy in `feature-policies.ts` is untouched: `optionalDraft` is a
prompt-assembly concern with a single consumer (the builder), so duplicating it
into the service-layer policy would add an unconsumed flag. Review follow-up
(same PR): when the whole-prompt reducer sheds the ENTIRE supplied dialog, the
history section renders an explicit budget-omission marker instead of falsely
claiming "(no prior coach dialog — this is the first question)" — a stateless
coach must never be told a dialog it was sent does not exist; and the coach
integration test pins body.draftText end-to-end through prepareAiFeatureStream
into the assembled prompt's <chatter_draft> wrapper, so a future feature-gating
of the service-layer forwarding line cannot silently disable the draft while
builder-level unit tests stay green. Review round 2 (same PR): (1) the coach
budget reducer became two-pass — the shed cascade is monotonic, so when the
draft itself ends up dropped at step 2b, the reducer rebuilds from the original
inputs with the draft off; attaching a draft can therefore never leave the
prompt poorer than its draftless twin; (2) partial dialog eviction is now as
honest as total eviction — kept exchanges carry their ABSOLUTE dialog numbers
and every drop (the reducer's shed AND coachHistorySection's internal 60k shed)
renders a counted "(earlier N coach exchanges omitted to fit the prompt
budget)" marker, with the final rendered section still held to the 60k budget
exactly. Round 3: a supplied draft is never a SILENT shed — the builder
reports post-budget `coachDraftIncluded` (final-wrapper probe, spoof-proof via
escaping, mirroring `coachRecapSlots`) and the feature layer records
`contextManifest.chatterDraft = { chars, included }` (additive manifest key —
no contract change); surfacing the flag to the extension's meta frame is a
recorded follow-up for when the client UI wants to render it. Round 6: a shed
draft leaves a one-line omission note IN the prompt (the history-marker honesty
rule — a «critique my draft» question must never invite hallucinating one);
`coachDossierIncluded` corrects the pre-build fanProfile manifest entry
post-budget (`included`), closing the last uncorrected optional-context claim;
and the step-3 memo re-verifies fits() before returning, falling through to a
fresh search if the pass-identity invariant is ever broken. Round 7: the
omission note itself must never displace context — round 6 let it ride the
cascade, where at an exact-ceiling boundary it evicted the dossier the true
draftless twin kept; it is now appended only after the context is chosen and
only when it fits as-is (boundary-filled prompts drop it — the fact stays in
the manifest), with a calibrated exact-ceiling twin-equivalence test; the memo
gains a search-count regression guard; and fanProfile.included is pinned at the
service layer for both the kept and the shed dossier. Round 8: recap dedupe
moved BEFORE the first shed measurement (a transient full/short duplicate could
evict history the deduped prompt would have kept — boundary-pinned); the
omission note rides the transcript search itself, costing ≤78 chars of the
oldest tail on the trimmed path where the post-choice append provably never fit
(post-trim slack <5 chars), while pre-trim exits keep the round-7 append-only-
if-it-fits rule; the single-entry history compensation subtracts the measured
overflow instead of halving away half the newest answer; the dossier-injected
debug log moved post-budget and carries `included` for coach, so log and
manifest cannot contradict; the dossier integration pin seeds the loader's
required completion-equality proof. Round 9: the single-entry compensation
binary-searches the largest fitting projection over the answer's own length
(minimal loss ≈ the marker itself, pinned ≥59_900 of 60k; the fixed decrement
lost 200+ chars and the default-span cap hid the near-lossless region); the
boundary tests now genuinely pack the window (probe-calibrated 6×10_000 —
the prior calibration fired neither compensation loop); `inTranscriptSearch`
is pass-scoped so a future early exit cannot let the note ride pass 2's
cascade. Round 10: a SMALL draft (rendered ≤2_048 chars,
COACH_SMALL_DRAFT_RIDE_CHARS) rides the transcript search like the note —
paying its own size in oldest-tail chars — instead of being whole-dropped at
2b; larger drafts keep the documented drop order. This also erases the
two-pass CPU cost for tiny drafts (the remaining double cascade for large
displacing drafts is the accepted price of the never-poorer invariant). The
loop-1 calibration test now genuinely fires the compensation (the round-9
calibration missed the join newlines — this entry's earlier coverage claim was
wrong for loop 1); the dossier log message says «omitted by prompt budget»
when the reducer shed it. Round 11 (scope correction): the never-poorer
invariant applies to a DROPPED draft only — that is what the two-pass rebuild
guarantees. A KEPT draft displaces context at SECTION granularity, because the
pre-existing cascade design deliberately trims the transcript only after every
summary section is exhausted (assembled-review ruling: the newest transcript
outranks dossier/recaps); at an exact-ceiling boundary a few-hundred-char
addition of ANY kind — a draft, a longer question, one more history entry —
costs a whole section. Earlier rounds' unconditional phrasing here ("never
leave the prompt poorer", "pays its own size in oldest-tail chars") was
overclaimed and is corrected by this entry. Whether the cascade should learn
transcript-first trimming for small overages (which would change that
pre-existing ruling for every optional section, not just drafts) is an OPEN
product question recorded for the owner — not decided in this PR. Merge-gate
final round: the omission note is paid from a fixed reserve (a module-constant
note length, honoured by the step-3 search for the draftless twin too), keeping
the 5m-cached dynamic block byte-identical between draftless and shed-draft
runs — its bytes previously shortened the cached transcript and re-billed the
whole block at the provider; equality is pinned by test. Coach-history
eviction audit (P2) recorded in .agentic/backlog.md per the stop-criterion
policy.

**Decision #180 (2026-07-23, Telegram and ElevenLabs share one fail-closed
service SOCKS5 identity; supersedes only #174's direct-ElevenLabs egress
clause):** The two service vendors now resolve through one boot-only,
all-or-none `SERVICE_EGRESS_PROXY_URL` / username / password tuple. It is
separate from page-owned proxy rows because it has service-infrastructure
custody and no page lifecycle. Both vendor scopes are unpaced, return a
non-null dispatcher, and expose the same credential-free
`service:socks5://host:port` egress key. Each operation owns and closes its own
dispatcher, so Telegram cannot close a voice transport. This leaves #174's
single-dispatch voice state machine, billing, artifact, and page-gating rules
unchanged while replacing only its statement that ElevenLabs is reached
directly.

Routing fails closed. A malformed or partial tuple is a boot error.
ElevenLabs has no direct or page fallback. Telegram's transition-only
`TELEGRAM_PROXY_PAGE_LABEL` branch is reachable only when the whole dedicated
tuple is absent; a configured route that fails authentication, connection, or
vendor allowlisting never falls back. A later cleanup release removes that
legacy branch after activation and a 24–48 hour soak. All ElevenLabs and
Telegram fetches require an explicit dispatcher. Voice keeps exactly one
synthesis attempt and its conservative status-0 semantics: an unacknowledged
attempt stays dispatched, is swept to indeterminate, and retains its character
reservation. Telegram keeps at most two retries for 429/5xx and non-connect
transient transport or timeout failures, but never retries a connect/auth
failure against the immutable route; business callers remain best-effort while
delivery failures are persisted.

Activation is owner-gated by the read-only `service-egress verify` CLI. It
checks the observed exit IP, Telegram `getMe`, and ElevenLabs
`GET /v1/user/subscription` with `xi-api-key`, without synthesis or message
delivery, and requires equal consumer egress keys. The owner must rotate any
exposed ElevenLabs key, provision and restrict the proxy/key, pass preflight
before recreating runtime roles, run the persisted Telegram test, complete a
one-page voice canary, and monitor the soak; none of those production actions
is performed merely by landing this code.

There is no database migration. Changing the
`voice_provider_unavailable` contract description intentionally changes the
kernel contract hash. After this Core revision lands and deploys, the
ChatGoose extension and every other current client must freshly re-vendor the
SDK before its next release because their deploy gates pin vendored hash parity
to production. Regenerating `docs/generated/*` is a separate follow-up using
its regeneration prompt; these generated maps are not hand-edited here.

**Decision #181 (2026-07-24, v2 domain frames carry the current OFAPI page
mapping at ledger-read time):** Stage 24's `accountRef =
pages.ofapi_account_id` remains a serve-time page mapping, not historical
event provenance, but it is no longer snapshotted once for a 15-minute SSE
connection. `listEventsSince` reads the page's current OFAPI ref in the same
PostgreSQL statement as every domain-event batch, and ordinary replay,
buffered-live, and live frames carry that per-row value. A page remap may
therefore change `accountRef` within one numeric-account connection.
Compatible clients do not apply or checkpoint an unexpected ref: they refresh
the current snapshot and grants, bind the new ref, and reconnect with the
unchanged cursor so the same ledger row replays under the current mapping.

The alternative of closing before the foreign frame was rejected because a
cursorless connection would reconnect cursorless, baseline at the new head,
and silently skip the event that exposed the remap. Reading
`observations.native_account_ref` was also rejected: replaying old account A
after the page currently maps to B would violate Decision #95's current-page
contract, while module-emitted events with `observation_id = 0` would remain
unprotected. The legacy synthetic
`stream.snapshot_replay_completed` frame has no ledger row, so it performs a
fresh page-mapping read immediately before publishing its recovery-clearing
cursor and fails closed if that read fails.

This is an internal repository-row addition and a serve-time value correction:
the SSE frame shape, opaque cursor, auth scope, SDK, OpenAPI, and append-only
ledgers are unchanged; there is no migration or contract regeneration.
Rollout order is Desktop recovery first, then Core, because older Desktop
builds checkpoint foreign refs without applying them. The remaining
current-page semantic deliberately serves retained A history with B after an
A→B remap, as Decision #95 requires; `accountRef` does not claim ledger
provenance.

**Decision #182 (2026-07-24, the kernel owns family-wide AI failure
classification; Stage 1A is expand-only):** Core is the sole classifier of
provider and transport failures for every client in the Agency Hub family.
Clients consume the precise kernel wire code; they do not repeat provider-body
parsing or infer a different class locally. Per the owner ruling on 2026-07-24,
chatters see the true actionable cause rather than a generic substitute.
Operator and engineering visibility are not alternatives to that chatter
result: every failed generation must reach the chatter-facing terminal path,
the operator incident/paging path, and durable engineering telemetry.

Frame messages remain static and bounded: raw provider bodies, prompts, and
credentials stay in redacted server observability, never in SSE text. Adding a
new error `code` inside the existing error frame is contract-free and clients
must handle unknown codes safely. Adding a new frame `type` is not
contract-free; it requires a lockstep contract/SDK/client rollout gate.

The first release is deliberately the rollback-safe expand half only. It adds
nullable ledger detail (`error_code`, `failure_phase`,
`provider_http_status`), reader-first `ai_provider_billing` and
`ai_provider_failed` incident kinds, a separate default-off critical-AI paging
flag, and a leased durable notification outbox. Paging-off transitions persist
with visible `suppressed` state; retry exhaustion is explicit and outbox queue
age is a golden signal. Existing sync incidents retain their direct-send
behavior. No Stage 1A production path creates either new incident kind,
populates the new ledger detail, or changes SSE classification or wire
behavior. Precise classification, incident producers, and activation belong to
Stage 1B.

**Decision #183 (2026-07-24, Stage 1B activates precise AI failure telemetry
and guarded incident producers):** Provider adapters now normalize failures at
the shared AI transport boundary before the terminal caller renders or records
them. Anthropic SDK subclass/status/`error.type` evidence wins; its observed
HTTP 400 `invalid_request_error` low-credit response is billing only when the
provider message exactly matches the one production signature. Any other 400
stays `provider_stream_failed`. OpenRouter no longer encodes status only in an
`Error.message`: non-2xx responses carry structured status and Retry-After.
The wire classes are `provider_billing`, `provider_auth`,
`provider_rate_limited`, `provider_unavailable`,
`provider_proxy_unreachable`, and `provider_stream_failed`; every class has one
static message, and only a 429 carries the provider's parsed Retry-After value.
An interruption after provider output begins is always the generic stream
class. Failure phase is exactly `connect | provider_response | stream`.

Every failed provider terminal now records `error_code`, `failure_phase`, and
the HTTP status when one exists. Completed and cancelled terminals force all
three fields to null. The HTTP SSE lane, operator feature-smoke CLI, internal
gateway lane, and stale-reservation recovery follow that law; no prompt,
completion, provider body, or credential is added to the usage ledger.

Billing and authentication open the existing `ai_provider_billing` incident
immediately on one GLOBAL latch; any later successful generation resolves it.
Other classified page failures use the ledger to require three consecutive
failed provider generations (old unclassified rows, quota denials,
cancellations, billing, and auth cannot manufacture the streak), then open
`ai_provider_failed` on a PAGE latch split between upstream-provider and
page-proxy causes. The page's next successful generation resolves both cause
latches. The incident `error_code` is the wire code; summaries are static and
derived only from provider name, code/phase, and optional HTTP status, then
passed through the existing redactor — never a provider body.

The chatter error frame is written first, terminal ledger/restricted capture
settles second, and incident work runs last behind a log-and-continue guard.
All transitions use the Stage 1A durable critical-outbox seam. The
`aiCriticalAlertsEnabled` policy remains default-off, so deployment creates
dashboard-visible `suppressed` rows but cannot page until the owner separately
enables the flag. There is no migration, owner API change, OpenAPI/SDK
regeneration, or change to sync, voice, send, or Voice retry laws.

**Decision #184 (2026-07-24, Stage 3 centralizes server error hygiene without
changing the wire taxonomy):** The four boundary sanitizer paths now pass
through one shared core. It owns cause-chain rendering, nested error-code
extraction, Drizzle/query-style detection, shape-based secret masking, and the
caller's selected clamp policy. Sync persistence retains its 1,024-character
ellipsis summary and query-context replacement; voice logs retain their
512-character literal clip and type/code-only query projection; notification
incidents retain their 240-character ellipsis; transport/provider observers
retain the prior cause-chain shape. The former per-site helpers are deleted.

Redaction is defense in depth. Arbitrary text masks URL credentials plus
Anthropic, OpenRouter/`sk-`, ElevenLabs `sk_`, OFAPI, Agency Hub bearer-key,
Telegram-token, generic Bearer, and labelled-secret shapes. Pino additionally
censors structured authorization-header, proxy-URL, and bot-token paths.
Ordinary non-secret text is unchanged.

Only `AppError` (plus the cursor-restart response's explicit extension) may
cross the server error boundary as an intentional application error. An
arbitrary object that merely resembles `{statusCode,error,message}` is an
internal 500. Zod request errors are rebuilt from structured issues, not the
raw Fastify aggregate; caller string values are removed, unsafe key-bearing
issues are generalized, and the useful result is capped at 512 characters.

`voice_provider_unavailable` keeps its code and HTTP 503 but exposes one static
chatter message. The key/proxy/restart diagnosis moves to a structured server
warning containing configuration-presence booleans only. No voice retry,
billing, admission-order, or incident behavior changes.

The SDK keeps every existing error category and adds `http` as the honest
fallback for otherwise unrecognized statuses; only HTTP 400 maps to the
existing `validation` category by default. Contract generation remains
mandatory for the source edit, but the OpenAPI document is unchanged, so the
contract hash and generated SDK artifacts do not move. This stage adds no wire
code, frame shape, incident kind, database migration, or sync-executor
classification change.

**Decision #185 (2026-07-24, the error-handling canon is family law):**
`docs/error-handling.md` is the single canonical reference for error handling
across core, the ChatGoose Firefox extension, and ChatGoose Desktop. Any change
to classification, wire code/message, HTTP `AppError`, retry disposition,
failure-ledger fields, incident kind/latch/threshold/resolve rule, notification
outbox policy, client mapping, or error-boundary/redaction behavior must update
the canon in the same family change. Clients reference this decision and the
canon rather than maintaining normative copies. The existing evolution rule
stands: adding a code to the open error frame is contract-free and must degrade
safely in every client; adding or reshaping a frame type is lockstep-gated.

**Decision #186 (2026-07-27, preconditions for enabling critical AI paging):**
A review of the Stage 1A/1B/3 range found four defects that only matter once
`aiCriticalAlertsEnabled` is flipped on. They are fixed together and the flag
stays `false` until all four ship.

1. **The internal AI lane fails closed.** It hand-folded provider frames and
   defaulted to `completed`, so a stream with no usage frame, no usable `done`
   (null `stopReason`), or empty output settled as a zero-cost SUCCESS. That
   both resolved the global `ai_provider_billing` latch on a non-answer and let
   the workboard cache all-`needs_reply` defaults under a content hash, where
   they were never recomputed. The lane now shares
   `AiGatewayTerminalStreamConsumer` with the SSE pump and the CLI smoke path,
   and throws AFTER the ledger row, restricted capture and incident reconcile
   have settled, so an unusable terminal is a recorded failure. The classifier
   caller already stops and leaves the remainder uncached on a throw.
   Scope, precisely: this closes the terminal-integrity doors (no usage, no
   usable `done`, empty output). It does NOT close cache poisoning in general.
   A truncated `stop_reason: max_tokens` response is an explicitly USABLE
   terminal for the shared consumer, so partial or malformed classifier JSON
   still becomes fabricated `needs_reply=true` defaults and is still cached
   under its content hash. That door is older and orthogonal — it belongs to
   classifier-side coverage validation, not to terminal integrity — and is
   left OPEN as separate work.
   Known gap in the same area: a `provider_usage_missing` terminal records
   zero cost with `costApproximate: false`, even though content had already
   streamed and provider spend definitely occurred, so it under-counts the
   global per-feature budget. The external gateway already has the conservative
   `estimateCostOnMissingUsage` fallback for exactly this; the internal lane
   does not. Bounded in practice by the classifier's own per-page daily call
   reservation, so it is recorded rather than fixed here.
2. **Incident state is ordered by event time.** Both staleness guards compared
   the stored timestamps against the PROCESSING clock, so a delayed failure
   could drag `last_seen_at` below a newer failure and let the `maxLastSeenAt`
   guard resolve a still-broken incident. Comparison is now against the event's
   own time. A repeat failure at `last_seen_at` is first-writer-wins. A failure
   at `resolved_at` reopens — but that rule only ever decides a tie for the
   no-tombstone resolve primitive: every production producer opens through the
   recovery guard, which suppresses at `recoveredAt >= occurredAt`, and the
   recovery path resolves at `last_seen_at <= recoveredAt`, so a genuine
   failure/recovery tie goes to the RECOVERY. That asymmetry is inherited, not
   introduced here, and is kept deliberately: both directions self-heal on the
   next terminal, and tightening the guard would reopen the delayed-retry race
   it was added for. The recovery
   tombstone, the conditional resolve and the resolved-outbox row now commit in
   one transaction under the incident-key advisory lock; splitting them left a
   crash seam that pinned an incident open while suppressing older failures.
3. **Outbox delivery is FIFO per incident and channel.** The due-filter runs
   before the ordering, so a backed-off `opened` row was invisible while a
   fresh `resolved` row was delivered first — one transient Telegram failure
   was enough to page a resolution for an alert that arrived a minute later.
   A `not exists` fence blocks a row while any earlier-`transition_at` row of
   the same incident and channel is still `pending` or `leased`. Terminal
   states never block, so an `opened` row that ends `exhausted` or `suppressed`
   releases its `resolved` successor, which pages alone — including when paging
   was off at open time. Suppressing that orphan resolution needs a dependency
   edge between rows and is deliberately left OPEN as a separate decision.
4. **Lease and sweep clocks outlive one send.** The 60-second lease was shorter
   than the ~150-second Telegram retry window, and one timestamp served a whole
   25-row batch, so later rows were granted already-expired leases and retry
   backoff was measured from sweep start. The lease is 300 seconds (pinned in
   test above the derived `TELEGRAM_SEND_RETRY_WINDOW_MS`), every lease and
   settlement takes a fresh timestamp, and the sweep stops on a 300-second
   wall-clock budget. The queue is reconciled on boot with a 600-second expiry,
   a 30-second heartbeat and `retryLimit: 0`, verified against configuration
   drift — `createQueue` cannot change an existing queue, and pg-boss kills an
   active job at `expireInSeconds` regardless of heartbeats, so the expiry (not
   the heartbeat) is the ceiling the budget plus one send must fit under.

Deliberately NOT included. The malformed-JSON/oversize-body HTTP 500 raised in
the same review is not a regression: Fastify's `FST_ERR_CTP_*` errors carry no
`.error` property, so the duck-typed passthrough removed by #184 never matched
them, and the behavior is identical before and after that change. It is also
the documented boundary contract, so returning 400/413/415 there is a change to
#184 and needs its own decision. Stale-reservation recovery still skips
incident evaluation (its rows do count toward the page streak, so the next real
terminal opens the incident) and belongs in a bounded worker rather than the
request path. Direct internal-lane connect failures are still classified
`provider_proxy_unreachable`; the honest fix needs a new wire code in both
clients and is not worth it for one ledger field on a lane whose only caller
passes no `pageId`.

**Decision #187 (2026-07-27, a plugin that throws must throw an `AppError`):**
#184 removed the boundary's duck-typed `{statusCode, error, message}`
passthrough deliberately. What went unnoticed is that `@fastify/rate-limit`
does not build its own reply — it executes `throw errorResponseBuilder(...)` —
and this repo's builder returned exactly such a literal. From 2026-07-24 until
2026-07-27 every rate-limited login therefore answered HTTP 500
`internal_error` instead of 429 `rate_limit_exceeded`.

The limiter itself never broke: it runs at `onRequest`, so the request was
still refused and brute-force protection held. What broke was the contract —
clients map 429 and 500 to different retry dispositions, and an operator
watching for a spray sees a spike of 500s.

The fix returns `TooManyRequestsError`, which already carried exactly the
pre-regression wire shape (`rate_limit_exceeded` / 429). No allowlist and no
duck-typing is reintroduced: the boundary rule stands, and the plugin is
brought into compliance with it instead. The general rule is now canon — any
plugin that signals by throwing must throw an `AppError`.

Why three days: the covering test, `rate limits cross-account spraying per IP
(audit B7)`, was not tagged `[sync-critical]`, so it ran only in the nightly.
The nightly went red on 2026-07-25 and stayed red through 07-27 with this as
its single failure. Both rate-limit tests now carry the tag, so the PR gate
catches this class. A red nightly is not coverage; it is an unread alarm.

**Decision #188 (2026-07-28, the PR gate is sharded):** The sync-critical
suite is ~120 database acquisitions over 104 files and is why a pull request
waited. `ci.yml` becomes three jobs: `Static checks` (typecheck, lint, contract
regeneration, production build, Docker image, Chromium smoke, unit tests), an
`Integration N/3` matrix over `test:sync-critical:db --shard`, and a
`Quality Gate` aggregator.

Sharding is applied to the `:db` half directly because `test:prerequisites` is
a compound `A && B` and trailing arguments would otherwise land only on `B`;
the single-file `:api` selection cannot be sharded and rides shard 1.

**No test and no harness file changes.** Each shard is a separate runner, so
files stay serial within a shard and every acquisition keeps its own throwaway
container — byte-identical behaviour to the single-job layout, just spread
across machines. Measured: 688s fully serial, 234s per shard; the first CI run
of the new layout finished the whole gate in ~6 min against a 17.75 min median.

The aggregator is not ceremony. The branch-protection ruleset requires a check
named literally `Quality Gate`; a matrix publishes `Integration 1/3` and
friends, which would satisfy nothing while still reporting green. It carries
`if: always()` because a skipped required job reports success.

Also adopted, independent of the split: per-job `timeout-minutes` (there were
none, so the default was six hours and a stuck run was indistinguishable from a
slow one), cancellation of superseded pull-request runs, and
`workflow_dispatch`. These supersede the older, unmerged CI proposal that
would instead have moved integration coverage off pull requests entirely —
rejected because it silently weakened an unchanged required-check name.

**Tried and deliberately dropped: running the test cluster on tmpfs with
`fsync=off`.** It is worth a further 40% (234s -> 140s per shard), but it
surfaced a latent teardown race: stopping a container while a pool still holds
a connection raises FATAL 57P01, and a node-postgres Pool with no `error`
listener turns that into an unhandled event that fails a run in which every
test passed (CI run 30306753356: "Test Files 35 passed" followed by an
unhandled error). A process-level guard reduced but did not eliminate it —
still roughly one failure in five runs. The speedup is real and should be
revisited only after the race is fixed at its source: pools created by
`createPool` have no `error` handler, which is the same hazard the pg-boss
listener in `buildApiServer` was added for (audit B8), and it applies to the
production API and worker as much as to tests.

Recorded for the next person: the 38-minute run that triggered this work was
the worst of 32 samples; the median gate was 17.75 minutes. Measure the
distribution before optimising against a single sample.

Not addressed, deliberately: `pnpm test:unit` starts Postgres containers today
because `tests/voice-profiles.test.ts` and `tests/voice-notes-sweep.test.ts`
are database-backed without the `.integration.test.ts` name, so the `--exclude`
list misses them. They are correct as tests and merely misfiled; renaming them
would reshuffle shard assignment and is left to its own change.

**Decision #189 (2026-07-28, no long dashes in anything the model reads):**
An em dash is an AI tell in fan-facing chat: nobody texting from a phone types
one. Our prompts were saturated with them, and a model mirrors the style of its
own prompt, so the tell was being taught rather than merely tolerated. Every em
and en dash is now gone from the text that reaches the model: all ten templates
(and their byte-identical `templates.ts` twins), the live instruction strings in
`builder.ts`, and the transcript normalizer. Prose pauses became commas, a
`**Heading** —` became a colon, the dossier disclaimer's paired aside became
parentheses, and numeric ranges took plain hyphens. Code comments are untouched:
they never reach a model.

The structural half matters more than the prose. The paid-attachment marker was
emitted as `[… — PPV $X.XX, state]`, so an em dash arrived in EVERY generation
once per paid attachment in the window, ahead of any instruction. Its grammar is
now `[… - PPV $X.XX, state]`. That marker is emitted twice, by this repo's
`prompts/transcript/normalize.ts` for archive-sourced transcripts and by the
extension's `src/shared/transcript.ts` for the live DOM read, and it is quoted
verbatim inside fast-reply, help-me, improve-draft and ping. All five sites move
together or the quoted grammar stops describing the live tag; the extension
change ships as its own PR against the same day.

Cleaning the sources is only half of it, because the coach ANSWERS the chatter
reads are model output, not template text. The one explicit "never use long
dashes" rule lived inside the bundled Lora personality, which binds the reply
features and nothing else, so coach chat, recaps, chat review and voice scripts
were never told. The rule is now a WRITING RULES block on both safety preambles
(`REPLY_SAFETY_PREAMBLE` and `ANALYSIS_SAFETY_PREAMBLE`), which is the only text
every feature shares, and it names the case the personality rule missed: example
messages, suggested wording and proposed drafts count as output too. It rides
the uncached system block, so it costs nothing in cache invalidation.

Two consequences, both accepted. Russian recaps and reviews lose a dash that is
correct Russian typography; the owner's ruling is that consistency beats it,
since the same text gets pasted and skimmed next to fan-facing copy. And the
coach's 300k ceiling now has ~430 fewer characters for context: the reducer
handles that by design, but the packed budget FIXTURE had to move with the
preamble, so it derives its padding from `ANALYSIS_SAFETY_PREAMBLE.length`
instead of a fixed 50k that would silently shed the recap it asserts is kept.

Output-side normalization (`normalizeDashes` in `prompts/output/reply-output.ts`,
uncalled here because sanitizing happens client-side) stays a client concern.

**Decision #190 (2026-07-31, voice launch hardening joins queued ownership
and erasure fencing):** Saturated synthesis keeps the existing FIFO contract:
the admitted row remains `queued` without a dispatch lease until a configured
process-local permit opens. While it waits, the owning API process refreshes
`updated_at` every minute. The minutely sweep now treats five minutes without
that heartbeat, rather than row age, as abandonment. A live waiter therefore
cannot be reclaimed and refunded underneath a later paid dispatch, while a
crashed process still converges through the existing unbilled sweep.

Quota refusal is stateless. It still returns `voice_quota_denied` and consumes
no budget, but fresh client UUIDs no longer create permanent terminal rows.
When a concurrent same-UUID winner may have consumed the final budget, the
loser rolls back and re-reads the idempotency key before choosing replay,
mismatch, or 429.

Audio retrieval applies `(id, platform_account_id, user_id)` in SQL before
selecting the bounded BYTEA. ElevenLabs `character-cost` reconciles a
reservation only when it is a non-negative PostgreSQL integer at both the HTTP
adapter and service boundary; an invalid value is unknown and leaves the
estimate charged.

Finally, Fansly voice admission and the single-dispatch CAS both join the
existing page erasure advisory-lock protocol and re-check material-time
tombstones using the source generation's `created_at`. Pre-erasure fan material
cannot be inserted or sent after an erasure, while genuinely newer material
keeps Decision #175's supported behavior.

**Decision #191 (2026-07-31, a ramp-gated skip is neither a success nor a
failure):** On 2026-07-17 at 20:06 `fanslyNewStreamPageAllowlist` was narrowed
from the empty string (which means "every page") to `"lilly-1,lilly-2"`, so the
`fan_earnings` feed for `lora-1/2/3` stopped. It stayed stopped for 13 days and
not one instrument said so. The reason is that the gate skip returned
`satisfied: true`, and the executor treats "satisfied" as "the chunk finished
its work": it called `completePageSync`, which stamps `succeeded_at = now()`,
zeroes `consecutive_failures` and clears `last_error_*`; it recorded the run as
`succeeded`; it called `resolveSyncChunkRecoveryIncidents`, which closes
`stream_failed_threshold`; and `buildStreamSyncUx` printed "Up to date" because
a non-null `succeeded_at` was all it needed. Every one of those signals was
generated by a chunk that issued zero HTTP requests.

A gated chunk now terminates through `skipPageSync`. Its `where` clause is
byte-identical to `completePageSync`'s — same lease fence, same generation
check — and it releases the lease and advances `applied_seq` the same way,
because the scheduler decides "due" from `applied_seq` / `last_scheduled_slot`
and never from `succeeded_at`, so withholding success cannot wedge the stream.
What it withholds is every claim: no `succeeded_at`, no `progressed_at` (a chunk
with no egress made no progress), and no write at all to `consecutive_failures`
or `last_error_*`, because a skip must neither clear a real failure streak nor
invent one. The run is written as `sync_runs.outcome = skipped`, which the
existing telemetry already maps to health `degraded`, and incident resolution is
not called: closing `stream_failed_threshold` off the back of a skip would clear
an alert while the failure streak it was raised for is still sitting on the row.
The `top-spenders` route reports `source.lastSyncedAt` straight off the same
`succeeded_at`, so the extension's board inherits the honest timestamp for free.

`buildStreamSyncUx` gains a branch that returns the existing `off` state as
"Not updating" instead of falling through to "Up to date". It is keyed on the
GATE REASON (`stats.gatedSkip` of the last completed run), never on the
`skipped` outcome by itself, and that distinction is the whole point rather than
a detail. The `skipped` outcome has one pre-existing producer: `recordSkipped`,
called from `buildLeaseLostResult` at eight sites in the executor whenever a
worker loses its lease. That happens to perfectly healthy streams of every kind,
and `completed_runs` picks the freshest finished run of ANY non-running outcome
by `finished_at`, so the stale worker's `skipped` row can land AFTER the
replacement run that actually succeeded. Keying the state on the outcome alone
would therefore have reported a working `dm_messages` stream as "gated off"
until its next run finished — hours on a bulk cadence, and with a detail string
naming a gate that does not exist. The marker is written into the run's stats
under its own key, after the handler stats spread so nothing can clobber it,
because a state must not be inferred from free-text `error_summary`.

The bulk streams still must not dominate. `fan_earnings` and `purchase_history`
are in `MONITORED_SYNC_STREAMS`, and `off` outranks `syncing` / `retrying` /
`catching_up` / `setup` in the page rollup, so an honest per-stream `off` would
have turned every Fansly page — and the fleet line above it — permanently "Off"
on a default configuration, where both ramp flags are false. `sync-summary`
already forbids exactly this (decision #166); the monitor's page rollup simply
lacked the filter. It now applies the same one, and the membership list moved
into `sync-ux.ts` so the two sites cannot drift apart. The bulk streams keep
their own honest entry in the per-stream list, which is where the truth about a
gated feed belongs.

The trigger is deliberately narrow. `gatedSkip` is set only by
`fanslyNewStreamSkip` and must not be extended to the other "satisfied but did
nothing" skips (`onlyfans_top_spenders_disabled`,
`legacy_ofapi_dm_messages_retired`, sweep-not-due, and friends): those streams
sit in `BLOCK_TASKS` / `SYNC_DOMAIN_POLICY`, where withholding `succeeded_at`
would degrade chatter-visible block health rather than inform anyone. For the
same reason `fan_earnings` is NOT added to `BLOCK_TASKS`; decisions #133 and
#166 stand, and they forbid exactly one thing — a flag-gated stream painting a
block red — while explicitly protecting the detailed observability this change
restores.

Two existing pins asserted that all ten streams finish `succeeded` —
`tests/sync.integration.test.ts` and the `[sync-critical]` onboarding case in
`tests/api.integration.test.ts`. Both were the bug preserved as an expectation:
the ramp flags are off in the test runtime, so those pins locked in the exact
reporting that hid the outage. Both now expect `skipped` for `fan_earnings` and
`purchase_history`.

KNOWN LIMITATION, recorded rather than fixed (owner's ruling, 2026-07-31). The
gate guard is ONE-SIDED: the marker proves a gate, but its absence proves
nothing. If a genuinely gated stream then loses a lease, `recordSkipped` writes
an unmarked `skipped` run with a later `finished_at`, `gatedSkipReasonFor`
returns null, and the stale-but-non-null `succeeded_at` lets the stream read
"Up to date" again on the detailed monitor until the next gated run lands — up
to 24h for `fan_earnings` and 4h for `purchase_history` at their cadences. It is
accepted because the primary guarantee is untouched by the race: `succeeded_at`
is still never stamped, so `top-spenders`' `source.lastSyncedAt` and both
extension surfaces stay honest throughout, and only the monitor degrades. It
also needs an external stall to trigger at all, since a gated chunk does no
egress and lives milliseconds. Closing it means deriving gate state from the
latest MARKED run within the stream's cadence rather than from the latest run
outright — which changes what the monitor accepts as evidence, and is therefore
its own decision rather than a tweak. Recorded here so whoever picks it up does
not have to rediscover the shape of it.

One trap for the next maintainer, in the same area. `sync-summary`'s
`toStreamSyncUx` never populates the gate reason and synthesises `lastCompletion`
as always-`success` from `succeeded_at`, so the "Not updating" branch is
unreachable on the dashboard/connections path. That is harmless TODAY only
because `gatedSkip` is confined to the two bulk streams, which `sync-summary`
filters out of its stream list anyway. The confinement is enforced by a comment
on `StreamChunkResult.gatedSkip` and by this entry — by no mechanical check. So
if someone later sets `gatedSkip` on a non-bulk stream, the dashboard will go on
printing "Up to date" over a gated feed and no test in the suite will fail.
Extending `gatedSkip` therefore means teaching `sync-summary` about the gate in
the same change.

Considered and deliberately declined by the owner on 2026-07-31: a watchdog that
pages the owner when a stream has been gated for N days, and a warning when an
allowlist edit narrows the set of pages. Both were rejected in favour of waking
the affected streams the moment the gate opens (its own change), so that the
recovery path is short enough not to need an alarm. This paragraph exists so
that the absence of a watchdog reads as a decision rather than an oversight.
**Decision #192 (2026-07-31, an admin config write that OPENS a ramp gate queues
the affected streams):** On 2026-07-17 at 20:06 `fanslyNewStreamPageAllowlist`
was narrowed from the empty "every page" value to `lilly-1,lilly-2`. That
silently stopped `fan_earnings` for the lora pages, and their spenders
projection stood still for thirteen days. The allowlist was restored on
2026-07-31 — and even then nothing would have moved, because opening a ramp gate
only changed which pages the executor STOPS skipping. Each stream still had to
wait for its own slot, and `fan_earnings` ticks once a day. The owner-facing
"sync all page streams" action is no help: it deliberately excludes the bulk
streams.

So the admin config write now queues the work itself. Both live config
endpoints — `PATCH /api/v1/admin/config` and `DELETE /api/v1/admin/config/:key`
— check the changed keys against the three ramp-gate keys
(`fanslyNewStreamPageAllowlist`, `fanslyFanEarningsSyncEnabled`,
`fanslyPurchaseHistorySyncEnabled`) and, on a hit, request `fan_earnings` /
`purchase_history` with request source `recovery`. The DELETE path matters on
its own: the string validator refuses an empty override value, so restoring the
fully open "every page" allowlist is only possible by clearing the override,
which is exactly the shape of the incident being fixed.

**It is a transition detector, not a sweep.** The gate is read twice — once
before the write, once after — and only a (page, stream) pair that moved from
non-ramped to ramped is queued. This is the load-bearing constraint, not a
refinement. A gated `fan_earnings` walk costs TWO Fansly calls per fan, and a
completed walk resets its cursor to 0, so the next run is a full walk rather than
an incremental one; on a page the size of lora-1 (697 spenders) one unwanted
wake-up is on the order of 1400 unscheduled requests. The kernel is allowed to
pull Fansly on a cadence — that is DP 1-B, and it is exactly why the cadence is
the budget. The traffic leaves through the page's own proxy identity (Stage 26:
every platform-bound request resolves its egress key per page, and a Fansly page
must never reach the platform on a direct IP because a model ban is the failure
mode), so a burst that the pull schedule never accounted for is spent against
that identity. Note the attribution: "never exceed what the chatter's own
browser session already does" is the EXTENSION's law, since it rides that
session; the kernel's own constraint is per-page proxied egress at a designed
cadence. A "queue whatever is open right now" version would have spent that
burst on actions that open nothing: narrowing the allowlist (the very action
that caused this incident), turning a stream flag OFF, re-writing a key with its
existing value (the override writer does not compare old and new), and each step
of the registry's own documented "enable one page at a time" rollout.

Three further narrowings. The ramped verdict is computed with
`resolveFanslyNewStreamState`, which is the REPORTER form of the gate — the same
checks in the same order as the executor, sharing its allowlist primitive
`fanslyNewStreamAllowed`, and the same function the `top-spenders` `source`
block reports to the extension. The executor itself does not call it: it inlines
the platform and flag checks and calls the shared allowlist primitive directly,
so the allowlist rule is genuinely shared while the state ladder is a deliberate
second implementation. Only the two gated streams are queued and only on Fansly
pages. And pages are enumerated through the existing `listFanslyPages`
repository listing (`platform = 'fansly'` and `status = 'active'`), so a
tombstoned page is never woken; no new query was invented. `dependencyOptions`
is not threaded through, because it only relaxes the OnlyFans OFAPI DM
dependency graph and this path is Fansly-only.

**The timing claim is "within a minute", not "immediately".** The handler writes
durable intent (`request_seq > applied_seq`); dispatch happens when the sync
planner's `* * * * *` schedule next ticks and `listRunnablePageSync` picks the
page up. Sending a pg-boss wake-up straight from the handler was considered and
rejected: it would add a second dispatch path out of an HTTP route in order to
save under a minute, against the twenty-four hours this already removes.

The wake-up runs AFTER `setConfigOverridesAtomic` and `recordAudit`, and it is
wrapped so that a failure is logged and swallowed. By that point the override is
already written and audited; turning a successful, durable config change into an
HTTP error because a convenience follow-up failed would be strictly worse than
waiting for the next slot, which is the pre-existing behavior anyway. The
pre-write snapshot is wrapped the same way and degrades to "no wake-up".

Transition-awareness has one operational consequence worth writing down,
because it is not obvious: a swallowed wake-up failure CANNOT be retried by
saving the same value again. That second write is correctly a no-op — the gate
did not move — so the page keeps waiting for its normal slot. To force a
wake-up after a logged failure, toggle the stream's flag off and back on: the
off write moves the gate to `flag_off` and the on write is then a real
non-ramped -> ramped transition.

Rejected alternatives and the gaps they leave, all in one place. Having the
PLANNER notice the transition — persist the last gate verdict per (page,
stream) and reconcile on each tick — was rejected as too much machinery for this
incident, but it is the strictly more complete design, because it would cover
every write path rather than only the HTTP one. Two gaps follow from that.
First, a gate opened through the environment plus a restart, or through any
override write that does not go through these two endpoints, wakes nothing and
still waits up to one slot. Second, a known concurrency limitation, found in
review on 2026-07-31 and ruled backlog rather than fix: the before-snapshot is
not serialized with the config write, so two concurrent owner PATCHes on the
same gate key without `expectedVersion` can interleave such that neither handler
observes the transition, and the stream again waits for its normal slot. Closing
it would mean taking the snapshot under the same lock as
`setConfigOverridesAtomic`, widening the config repository's transaction
boundary for a case whose worst outcome is a fallback to the behavior that
existed before this decision.

Separately, and as an explicit owner decision the same day, no watchdog alerts
the owner about a long-gated stream and no warning fires when an allowlist is
narrowed. The recurrence defense is this wake-up plus the honest reporting of a
gated skip; the rejected guards are recorded here so the omissions read as
decisions rather than oversights.

**Decision #193 (2026-07-31, `top-spenders` carries the deleted-fan marker in
`entries[]`):** The spenders board had no way to tell "this account was deleted
on the platform" from "the name has not loaded yet". On `lora-1`, 209 of the
697 projection rows have neither `username` nor `displayName`, and every one of
them carries `fans.deleted_detected_at`. The board rendered them as a bare
numeric id with a "find chat" affordance that can never succeed, and the
extension's name sweep re-asked Fansly for those ids on every build — Fansly
does not return deleted accounts at all, and a negative answer is not cached,
so the requests bought nothing but egress against the chatter's own session.

`pageTopSpenders` therefore returns `entries[].deletedAt` — the ISO time of the
FIRST detection (`fans.deleted_detected_at`), `null` when the fan is alive. The
column is read straight through `listTopFanEarnings`; the server clears it as
soon as any sync sees a name again, so a revived account needs no extra
handling here.

Deleted fans are deliberately NOT filtered out of the ranking. They spent real
money, the projection totals are built from those rows, and hiding them would
make the board's sums stop matching `fanCount`. The honest shape is "present
and labelled", not "absent".

The field rides `entries[]` rather than the existing `pageDeletedFans` route.
That route caps at `limit <= 200` while `lora-1` already has 209 deleted fans,
so reading it would already need paging today: every board build would pay at
least two extra round-trips to reconstruct, client side, a join the projection
query already has for free.

`deletedAt` is `.optional()` on purpose. The kernel deploys independently of the
extension, and the vendored SDK validates responses with the same zod schema: a
required field would be fine here but would forbid the reverse direction, where
a newer extension talks to an older kernel that does not emit it. Optional keeps
both directions valid, and the extension normalizes the absent case to `null` at
its own boundary.
**Decision #194 (2026-07-31, Fansly transaction-data correctness uses
authoritative snapshots, honest gates and two target sources):** A live
cross-check against `lora-1` established three separate contracts rather than
one generic backfill problem.

1. The active subscriber snapshot was correct, but `/subscribers?status=3,4`
   cannot recover the expired archive exposed by Fansly. Every hourly run still
   finalizes that active generation first. A page with no completed history
   marker then performs one checkpointed `status=5` pass, captures the raw
   responses, hydrates the fans and inserts historical subscriptions with
   `is_current=false`. Its conflict update is archive-only: an expired response
   may update an already inactive row but can never turn an active row off.
   That refresh also preserves the inactive row's original `last_seen_at`,
   because the rollup uses it as the factual retirement boundary.
   Future expiry is retained by the ordinary active-generation retirement, so
   the historical pass is not repeated every hour. This adds one bounded
   subscriber-page plus account-lookup walk per page, not permanent polling.

2. `fan_earnings` and `purchase_history` rollout skips are not data success.
   The minutely planner materializes the live flag and allowlist into durable
   `feature_gate` pauses. Reopening a gate creates at most one recovery
   generation through the existing page-sync state and fixed page wakeup; it
   never dispatches directly from config handling. A raced in-flight skip
   consumes its leased generation but preserves `succeeded_at`,
   `progressed_at`, retry/failure metadata and recovery incidents. Chunk
   progress is a replacement snapshot, not a merge with stale keys.
   Ownership is equally narrow: a later operator pause replaces the gate
   marker, while a page-wide auth pause leaves already parked gate/operator
   rows untouched, so neither recovery path can release the other's hold.
   Reader-facing fan-earnings freshness comes from the successful cursor,
   which advances only after real capture, rather than from task settlement.

3. Decision #165 remains media-scoped, but captured DM pages are no longer the
   only discovery source. Fansly message-purchase transaction types
   `2010/2110` map their non-empty correlation id to `accountMediaId`, while
   `2016/2116` map it to `accountMediaBundleId`. A v3 checkpoint adds a
   transaction-id keyset ahead of the existing DM-raw keyset; v2 checkpoints
   migrate on read. Discovered content still travels through the same bounded
   `/media/orderhistory` request, raw capture, fail-closed shape classifier and
   content-level dedupe. A transaction kind that conflicts with the captured
   namespace for the same content id fails closed even when the observations
   land in different keyset batches. It does not synthesize PPV events directly
   from money rows and it does not create a fan-by-media crawler. This closes
   target discovery gaps while preserving the established rule that repeat
   sales of an already captured target rely on inline orders.

No schema migration, queue, table or new provider endpoint is introduced.

**Decision #195 (2026-08-01, an agent key is a principal without a user, and
every pre-agent surface refuses it):** Decision #116 fixed the credential
taxonomy as "humans authenticate with a password plus per-device tokens, robots
with API keys". The Agent Read Plane adds a third kind that neither half
describes: a machine reader that is not a chatter's robot, holds no human
identity at all, and must be readable-by-construction narrower than the owner
who issued it.

The obvious modelling — reuse the human principal and set the creator (the
owner) as its user — was rejected. `canAccessPage` short-circuits on the owner
role, so an owner-shaped agent principal would read every page in the agency and
the key's `page_ids` grant would be decorative. `AuthPrincipal` is therefore a
discriminated union: the existing human shape, or `{ kind: "agent", authMethod:
"agent_key", agentKeyId, keyName, capabilities, pageIds }` with no `user` field.
That is the enforcement mechanism, not documentation: TypeScript refuses every
`principal.user` read until the site declares what an agent gets instead, and on
a human-only surface the answer is always "refused". Sixteen call sites were
walked; the per-human services (voice notes, the OFAPI command outbox and read
gateway, the AI gateway and feature lanes, the workboard reports) now declare
`HumanAuthPrincipal` in their signatures, the route handlers that read a user
narrow through the existing guards (`requireOwner`, `requireDashboardUser`,
`requireApiKeyUser`, `requireSessionUser` are assertion functions now) or
through the new `requireHumanPrincipal`, and the two scope helpers plus the
audit-context builder grew explicit agent branches.

Isolation is symmetric and one-way. The new route kind `agentKey` admits agent
principals and nothing else; every other kind refuses them, which required
turning `any` from a wildcard into an explicit allowlist of the pre-agent
authentication methods (a regression pin keeps sessions, api keys and device
tokens passing it). Page scope for an agent is its grant, never `undefined` —
the value that means owner-everything — and a cross-page request intersects with
`agentScopeFor`, which fails closed on an empty intersection.

The existence oracle is closed at the VERDICT layer, not only in handlers: for an
agent principal, "this page is not in your grant" and "there is no such page"
produce the same static 404, byte-identical, before any handler runs. Human
principals keep today's 403/404 distinction, which the dashboard's own messages
depend on.

Key lifetime is enforced where the write happens: authentication slides
`expires_at` (+90 days, clamped to `created_at` + 365) inside the same guarded
statement that stamps `last_used_at`, so a revoked or expired key matches no row,
gets no fresh timestamp and cannot be resurrected by the very request that should
have been refused.

Shipped alongside, because it is the same class of bug in the read path: the
archive text search escapes `%`, `_` and `\` before its ILIKE, so a search for
"100%" finds that text instead of matching every message ever archived.

This slice registers NO routes and moves no operation surface — the auth-kind
enum value is the only contract change, and the generated OpenAPI and SDK are
byte-identical (only the authorization-policy document's kind legend moves).

---

**Decision #196 (2026-08-01, the Agent Read Plane):** a machine principal now
reads this hub through ten operations under `/api/v1/agent/*`. The reason it
exists is a single production failure: asked whether a fan had paid for a custom
in January, the system answered with an empty list, and the empty list was
indistinguishable from "we never captured January for that thread". The money
plane had the answer the whole time.

So the contract is not "return rows". Every 200 carries three INDEPENDENT axes.
`delivery` is a property of the response (how much came back, what capped it,
whether the frozen membership snapshot is exhausted). `capture` is a property of
the world, computed from the key's scope, the source and the requested window and
from NOTHING else — a test runs the same query with and without result filters
and compares the serialized block byte for byte, because a filter that could move
a capture floor would let `hasMedia=true` returning zero rows "prove" that no
media existed. `fieldStates` says, per field and BEFORE any row is fetched,
whether that field was ever observable in this scope at all.

On top of them sits `conclusion.blockers`: every reason this answer is narrower
than the question that was asked (see #197 for what was deliberately NOT built,
and #199 for who is allowed to write one). An empty collection therefore always
arrives with a populated `capture` and a non-empty `blockers` list. Never a bare
`[]`.

This PARTIALLY supersedes #52, strictly narrowly: transcript material leaves the
kernel only through operations that carry mandatory `capture` and `conclusion`,
only to an `agentKey` principal, only under a capability, with a budget, an audit
row and a revocable key — never as an unannotated export. #57, #140 and #142 are
explicitly NOT superseded, and DP 7 (capture first), DP 8 (break-glass reads) and
DP 9-A (single tenant) are reaffirmed.

The existence oracle is closed by construction. A page outside the key's grant
and a page that does not exist answer the same static 404, and the two globally
addressable operations (#3, #4) answer 200-with-empty instead, because a 404
there would collapse "no such fan" into "the fan is on a page you cannot see" —
which is the original failure with a different mask. The number of pages an agent
cannot see is public through operation #1, so `scopeNarrowing` discloses nothing
new and prevents "this fan never paid" being said about a payment on an invisible
page.

**Decision #197 (2026-08-01, the plane reports a capture FLOOR, not a proof):**
the first build of slice A carried an `absenceProvable` boolean an agent could
read as "this did not happen", certified by OnlyFans coverage proofs, a capture
ceiling and a gap-detection mode. It is REMOVED before shipping, by owner ruling.

The reason is not doctrinal, it is arithmetic. Nothing in this system performs a
verified gap sweep, so the detection mode was hardcoded to the value that forces
the answer false; no route computed a real lane ceiling; and the coverage-proof
reads that fed the rest were the slowest queries in the slice. The field was
therefore structurally `false` on every real request, at the cost of the most
expensive reads on the plane. A boolean that is always false teaches an agent
nothing and is worse than absent, because its presence implies it could be true.

What survives is the part that answers the question that started this work.
`capture.captureFloor` reports when THIS STORE's record of a scope begins
(`kind: "oldest_stored_row"` — a lower bound on what we hold, established by its
own unbounded query rather than from whichever rows a window returned), and a
window starting earlier produces a `before_capture_floor` gap with a named remedy
plus the `window_before_capture_floor` blocker. "We hold nothing from before 21
February" is a checkable fact about this deployment. "Nothing happened before 21
February" was never sayable and is now not even expressible.

Removed with it: `agentCaptureBasisEnum`, `agentProofSchema`,
`agentCaptureCeilingSchema`, `capture.gapDetection`, the `ofapi_message_coverage`
reads, the lane-ceiling merge, and thirteen proof-shaped blocker values. Kept:
`captureFloor`, `gaps[]`, the caveat list, and `capture.planes[]` with honest
read / not_read / not_indexed / not_applicable states.

**Decision #198 (2026-08-01, agent search is Postgres FTS):** message search runs
`to_tsvector('simple', text_plain) @@ websearch_to_tsquery('simple', $q)` against
the GIN index that has existed on `message_archive` since migration 0059 and had
never been used. `escapeLikePattern` is NOT applied on this path: it escapes
`\`, `%` and `_` for LIKE, which is meaningless to the tsquery parser and
actively corrupts input (`snake_case` becomes `snake\_case`).

No FTS index is built for `dm_message_archive` or `page_dm_messages`, and that is
a decision rather than an omission: both are declared `not_indexed` in the
response, which makes a miss visible as NON-COVERAGE instead of as absence, and
leaves the `plane_not_indexed` blocker on every search answer. Two further
caveats are always present because they are always true: the corpus is Russian
and the `simple` configuration does not stem (so "заплатил" will not find
"заплатили"), and media-only messages have empty text while in a customs audit
the delivery IS the media.

`pg_trgm` is deliberately not a migration. Migrations here are forward-only,
numbered and applied as an unbroken prefix, so a "skippable" committed migration
does not exist; the extension is a manual owner step and the code detects it at
runtime, falling back from `fts_trgm` to `fts` with a named caveat rather than
breaking.

**Decision #199 (2026-08-01, one writer for the blockers):** every reason an
answer is narrower than its question is assembled in exactly one runtime file,
`modules/agent-read/epistemics.ts`, and a textual test asserts that no other
runtime file so much as NAMES a blocker value. A second writer would eventually
disagree with the first, and a missing blocker reads as "nothing limited this",
which is the failure the whole envelope exists to prevent.

Two mechanisms keep that single writer honest. Plane reads are BRANDED witnesses
minted only inside `packages/db` — the barrel exports the type and not the
constructor, and a pin test fails the build if that changes — so `state: "read"`
is a fact a repository returned rather than a claim a handler made. The first
review round found four handlers minting reads for stores they never queried
(#3 for money and CRM, #4 regardless of the requested lanes, #5 for three message
stores while its SQL touched only the thread table, #10 for `page_fans` on every
dataset); the brand is the structural answer, not a review checklist.

And every new condition enters through the function's SIGNATURE rather than a
bypass: ramp mode arrives as `planeMode` (`read_only` adds `read_only_mode` for
its verification window), and cursor traversal arrives as `cursorConsumed`.

That second one is an arbitration, not a detail. `occurred_at` and
`last_message_at` are updated in place by the sync writers, so a keyset traversal
can skip a row that moved between pages. Within ONE request the read is
MVCC-consistent and a `mutable_sort_key` caveat is enough; ACROSS pages it is not,
so any response that consumed a cursor takes the `mutable_sort_key_traversal`
blocker. Its sibling `no_frozen_snapshot` is the same honesty applied to the
population: operations with a monotonic bound to freeze (threads, observations)
apply it in SQL and may report `snapshotExhausted`; the ones without say so out
loud rather than implying a stability nobody earned.


**Decision #200 (2026-08-01, an agent key is issued once and delivered through
one CLI):** the plane's credentials and their delivery, decided together because
the same property runs through both: a machine principal must never be able to
widen, recover or misread its own grant.

**Issuance.** `POST /api/v1/agent/keys` (owner session) mints a key and returns
the raw token in that response and nowhere else; the row holds `sha256(token)`,
the listing schema has no field that could express either the token or the
digest, and a lost token is re-issued rather than recovered. The routes live under
`/api/v1/agent/` specifically so the plane's `Cache-Control: no-store` hook covers
the one response in this system that carries a live bearer token, and their
contracts live in a sibling module (`routes-agent-keys.ts`) so the read plane's
own pins (eleven operations, exactly one owner-session, an evidence envelope on
every 200) keep meaning what they say.

Two rules REFUSE rather than adjust. A capability outside `AGENT_CAPABILITIES` is
a 400: silently dropping a typo would mint a key the owner believes is narrower
than it is. A lifetime past the 365-day ceiling is a 400 too, not a clamp: an
owner who asked for two years and received one would learn about it from a broken
agent months later. Neither rule is re-implemented at the route. The capability
enum is derived from the same constant the table CHECK enforces, and the ceiling
is decided once inside `insertAgentKey`; the route only translates the typed
refusals into HTTP. The page grant is explicit labels resolved to ids at
issuance, so a page created tomorrow is granted by nothing.

**Delivery.** `packages/hub-agent-cli`, bin `hub`, exactly one command per
agentKey operation and nothing composite. All HTTP goes through the generated SDK,
which validates every successful response against the same Zod contract the server
enforces; a CLI with its own fetch would trade that away and trip the raw-fetch
ratchet besides. Auth is `HUB_AGENT_KEY` or `~/.config/hub/credentials`, base URL
`HUB_BASE_URL`. The CLI writes no state (the `tg` tool taught that lesson with
eight abandoned receipts).

Exit codes are the part worth arguing about. The sibling tool exits 0 even on
failure, which works there because a failure is a document in the same ontology.
Here it is not: a 404 means the conclusion is unreachable, and reporting that with
a zero exit is the same lie as printing a bare `[]`. So: 0 an answer came back, 3
an answer came back carrying blockers and `--fail-on-partial` was passed, 4 no
answer. A document is printed on stdout in every case, and `blockers` is lifted to
the top of it so an agent reading nothing else still sees the verdict.
`docs/agent-read-skill.md` is the model-facing half of this.

Two properties keep that output contract true rather than merely intended (review
round 1). The bin names the repo's tsconfig explicitly, so the workspace path
aliases resolve identically from any working directory; without it the documented
`hub <command>` worked only from the repo root and died elsewhere with a stack
trace, empty stdout and exit 1, breaking both invariants at once. And the bin
wraps its own bootstrap, so even a loader failure emits one document and exit 4.
A spawn test drives the REAL bin from outside the repository, because the
internal-module tests structurally could not see that class of bug. Separately,
the credentials file is REFUSED when its mode lets anyone else read it: the CLI
never creates that file so it cannot fix the mode, and staying quiet about a
world-readable bearer token is how it stays world-readable (the ssh private-key
precedent, remedy included in the message).

Round 2 added the atomicity the credential needed from the start. The key row and
its audit commit in ONE transaction, and so do a revocation and its audit. The
earlier order (write the key, audit after) was justified by "a failed audit must
not destroy a minted credential", which is backwards: the token reaches the owner
only through that one response, so a failure after the insert leaves a LIVE key
nobody holds, unauditable, and blocking its own name with a unique-constraint 409
on the retry. An orphaned credential is worse than a failed issuance, and only one
of the two is recoverable. Revocation has the sharper version of the same problem:
the audit row is written only on the TRANSITION, so a crash between the update and
the audit would send the retry down the already-revoked branch and lose the record
permanently. The dashboard carries the same law: the issuance mutation is owned by
the tab rather than the modal, because a per-call `mutate` callback runs only
while its observer is mounted, and a modal dismissed mid-flight would drop the
sole token handoff for a key the server had already committed.

Two smaller round-2 rules, both instances of a rule this repository already has.
An unexpected driver error from the key insert is REPLACED, not chained: its
message embeds the SQL with its bound parameters, which for this table include the
digest, and the boundary logs what it is handed. And the CLI's error document
carries bounded metadata only, never `KernelApiError.body`: on a 2xx that failed
validation that body is the complete unvalidated payload, so printing it would
hand a model exactly what the schema refused.

Owner-session operations (9b payloads, #13 hydration decisions) are absent from
this CLI on purpose: an agent key cannot reach them, so a command for them could
only produce a confident 401.

**exportPolicy staging (spec 11), and where it stopped.** The sequence is (A)
widen the wire literal to an enum, (B) serve the value from config, (C) flip the
value, and collapsing it breaks clients in production because the SDK validates
successful responses against a VENDORED schema. A and B shipped with the plane's
operations. C did NOT ship: verification was done by loading each client's
vendored RUNTIME schema and `safeParse`-ing a response carrying
`agent_read_plane_v1` (a hash comparison always false-stops because this work
moves the hub hash, and a text grep can hit a `.d.ts` while the runtime `.js`
still carries the old `z.literal`). Both `of-desktop` and `fansly-ext` REJECT it;
the dashboard's workspace SDK accepts. `agentExportPolicyValue` therefore stays at
`no_raw_transcript_export_endpoint_yet` until the owner re-vendors both clients,
after which the flip is a live config change with its own verification window.

This is also where #52's partial supersede becomes operative. #196 recorded the
narrow supersede in principle (transcript reads only through operations carrying
mandatory `capture`/`conclusion`, only for an `agentKey` principal, never as an
unannotated dump); the wire marker that ADVERTISES it is exactly the value still
waiting on the fleet. Until then the plane is live and the marker is honest about
saying nothing new. #57, #140 and #142 remain untouched; DP 7, DP 8 and DP 9-A are
reaffirmed.

**Decision #201 (2026-08-01, Help and Review answer in Russian and must carry
receipts):** the `help-me` and `chat-review` prompt templates are rewritten
around two failures the owner hit in live use: both features answered in
English (the chatters work in Russian; the analysis was unreadable noise to its
only audience), and both produced generic essay-shaped output that named no
specific messages and changed no specific behavior.

The language rule is split by AUDIENCE, not by feature. Chatter-facing analysis
(help-me's coaching section, chat-review's evaluation and recommendations) is
pinned to Russian, addressed «ты», with English trade terms allowed where they
are the natural register (PPV, upsell, churn). Fan-facing text (help-me's two
suggestions, chat-review's «как надо было» rewrites) is pinned to the fan's
language inferred from the transcript, defaulting to English, because a
ready-to-send message in the coaching language is not ready to send. This is
the same split fan-summary and the short recap already committed to (Russian
analysis over an English-speaking transcript).

Both templates now demand receipts: every claim ties to a quoted fragment
(under 15 words, never whole messages, never a retell), the window is judged as
a window (no guessing at history outside it, newest messages weighted
highest), and free-form essays are replaced by fixed capped block structures.
Help-me: СИТУАЦИЯ / ЧТО УПУЩЕНО / СЛЕДУЮЩИЙ ХОД / РИСК, under 150 words
total, no praise padding. Chat-review: ВЕРДИКТ / ДЕНЬГИ / ПЕРСОНА / ОШИБКИ /
ЧТО РАБОТАЕТ, under 400 words, mistakes ranked money-first and capped at
three, each carrying a concrete replacement message in the model's voice.

Three product rules sharpen what the numbers and suggestions mean. Help-me's
two suggestions are two RENDERINGS of the one recommended move (safe vs
escalated), not two unrelated replies, and both must answer a direct question
sitting in the fan's last message. Chat-review's rating bands are anchored in
observable facts (what was converted, what was burned) with an explicit
do-not-default-to-7-8 instruction, and the reviewer grades the chatter's play,
never the fan's difficulty. Chat-review also gains the shared paid-media
marker glossary: it reads the same `[… - PPV $X.XX, state]` markers every
other transcript feature is briefed on, and its absence was the same class of
oversight as help-me's originally missing fan bio (spec §7).

The XML wire format is untouched (`coaching`/`engaging`/`flirty`,
`rating`/`evaluation`/`recommendations`, integer 1-10), so the extension's
parsers and overlay rendering need no change. templates.ts stays byte-identical
to the .md files (templates-sync), and prompt-manifest.json records the new
hashes with this decision as the documenting note. No contract or schema
change; the fleet picks this up on the next hub deploy with no extension
release.

**Decision #202 (2026-08-01, the hydration autopilot: a delegated, budgeted
approval).** Until now every vendor-paid hydration attempt was authorized by an
owner click (#13). The owner has now delegated exactly ONE act to an in-kernel
policy: approving a single bounded Fansly `thread_backfill_before` attempt,
within a daily reserved-call budget. The delegation is narrow on purpose, and
each edge of it is enforced in the candidate query itself, not in prose:
Fansly only (the OF lane's read marks a fan's thread read — #158 — and the
policy may not consent to a side effect for the owner), `thread_backfill_before`
only, ≤40 calls per request (one full targeted run), mark-read always `false`,
the filing key still alive and still granted, no auth-parked page, one live
approval per page, one auto-approval per conversation per UTC day.

**Provenance is first-class.** Migration 0119 adds `decision_source`
('owner' | 'auto_policy') and `decision_policy_version`; the journal gains the
`auto_policy` actor. A policy decision leaves `decided_by_user_id` NULL — a
fabricated owner id is exactly the confusion the actor model exists to prevent
— and the audit row is attributed to the requesting agent key with
`decisionSource`, `policyVersion`, `maxCalls` and `budgetDate` in its summary.
The wire decision object now carries `decisionSource`/`policyVersion`, so an
agent polling its request can tell a human judgement from a budgeted rule.

**The budget is a reservation, counted at decision time.** The policy sums the
`maxCalls` it approved since the UTC day start and refuses to reserve past
`agentHydrationAutoDailyCallBudget`; an approval that later under-spends or
fails does NOT return its reservation (v1, deliberate: simpler arithmetic, and
the error is on the safe side). The adapter's own bounded retries are outside
this number — it bounds what the owner authorized, not TCP weather. The
arithmetic is race-free because the ONLY caller is the exclusive hydration
cycle: one approver exists by construction, so no reservation table is needed
until that stops being true.

**The stop ladder is explicit.** `enforce -> shadow|off` stops new decisions
AND parks not-yet-dispatched auto-approvals (the dispatcher re-checks
`decision_source` against the live mode; parked rows expire by their own short
TTL); `agentHydrationMode` leaving `dispatch` stops all new dispatch; a started
Fansly run finishes its single bounded attempt — the same «one approval, one
attempt» law as everywhere else. `shadow` decides nothing and logs what it
WOULD approve, sized for the ritual: run shadow for a couple of days, read the
would-approve volume, set the budget, then enforce.

**Closed in the same change:** the targeted Fansly backfill now parks the whole
page's streams and opens the auth incident on a 401/403, exactly like the
executor (the former log-only branch is gone — an auth-dead page must not stay
harvestable by the next approval); and the owner approval queue stopped
claiming an exact exhausted snapshot when it hits its SQL limit (`cappedBy:
"limit"`, inexact count — the honest half of backlog BL-C1 until a cursor
lands). Widening the delegation — a new platform, a new target kind, any side
effect — is not a config flip; it is a fresh numbered decision.

**Decision #203 (2026-08-02, a monthly Hub total is one read, not a cursor
ritual).** The Agent Read Plane's generic dataset rows are useful for locating a
transaction, but they are the wrong primitive for «сколько за июль»: operation
#10 deliberately does not freeze a cross-request cursor traversal, so adding
hundreds of returned rows can never become one stable monetary answer. The
owner does not need a completeness-proof project to answer that question; the
useful and checkable claim is narrower: how much matching transaction material
Hub holds for one page and one closed window.

Therefore the existing `agentDatasetQuery` operation gains `summary: true` for
the `transactions` dataset only. It runs one SQL statement over the same page,
window and allowlisted filters, returning `transactionCount`, `grossMills`,
`netMills` and nullable `feeMills`, grouped by currency so unlike currencies are
never added. The response says `basis: matching_rows_in_hub`, returns no row
items and no cursor, and reports an exhausted one-request snapshot. The same
statement computes the page-wide transaction floor outside the requested window
and outside result filters, satisfying #197 without making the returned rows
their own floor.

This is deliberately NOT a new route, dataset vocabulary, table, migration,
hydration target or proof of vendor completeness. Ordinary #10 row responses are
wire-identical because the additive `summary` member is emitted only when asked.
Thread hydration cannot repair transaction history, so a window before this
floor carries `remedy: none`. The CLI spelling is the existing command plus one
flag: `hub dataset ... --dataset transactions --summary`.

**Decision #204 (2026-08-02, Help becomes a Coach preset turn):** this extends
#167's stateless `coach-chat` lane and reuses #201's situational structure
without putting prompt text back into a client. The strict feature request body
accepts one optional literal, `preset:'situation'`. On Coach, Core substitutes a
pinned Russian canonical question when `chatterQuestion` is absent or contains
only whitespace. A preset combined with a non-empty chatter question is a 400,
as is a preset on any non-Coach feature. `coachHistory` remains valid on a
preset turn because Help may be requested again mid-session.

The substituted text is echoed as optional `presetQuestion` on the shared SSE
meta frame so the extension can store and replay the real kernel-owned question
without duplicating it. The new `{presetInstructions}` template slot lives in
the uncached `## Your Task` block: situation mode requires the four labeled
advice blocks from #201 and exactly two tone-contrasted draft fences, while a
normal Coach turn substitutes an empty string and keeps its prompt bytes
unchanged. The raw gateway and other feature lanes omit the meta field.

Per the cross-repo design in `goose/fansly-ext`
`docs/superpowers/specs/2026-08-02-help-into-coach.md`, the extension follow-up
routes the Help button and hotkey into this preset turn. Core continues serving
`help-me` unchanged for older extension builds and the desktop app. Physical
retirement of that feature is a separate later decision, gated on desktop
usage.

**Decision #205 (2026-08-02, creator-post text is captured raw-first and read
through the existing Agent dataset operation).** Posts are a normal sync stream,
not a second capture subsystem. Every page receives a `posts` state, but it is
seeded paused: deploying the schema or Agent descriptor cannot spend vendor
credits or start a fleet crawl. An operator opens exactly one page through the
existing trigger surface (`POST /api/v1/admin/sync/trigger` with
`scope: "posts"`, or `pnpm cli sync --page <label> --scope posts`); `all` deliberately
does not include posts. The trigger records a generation and uses the ordinary
resume FSM. On OnlyFans it fails before either write unless background capture
is enabled and the page has an OFAPI account mapping. If either prerequisite
later disappears, the planner parks that page again; a handler race records a
configuration failure, never a successful sync or the Fansly bulk-only
`gatedSkip`. Fansly walks the creator account timeline by
its opaque `before` cursor (`GET /timelinenew/{accountId}?before=...&after=0`).
OnlyFans uses `GET /{ofapiAccountId}/posts?limit=100&offset=...&order=publish_date&sort=desc`
through a `post_paginate` kind in the existing governed OFAPI capture-job lane;
its response `_meta` remains the authority for actual credits. Fansly journals
the complete response payload before its post canonicalizer; OFAPI commits the
exact response bytes before its strict parser or cursor settlement runs.

Accepted rows append projection-only `post.observed` domain events. The
rebuildable `creator_posts` projection keeps the current head for one
`(page, platform post id)`, the verbatim text, publish time, first/last
observation, attachment count and complete source lineage. A materially edited
post creates another immutable event and advances that head. Missing rows,
empty pages and partial timelines are NEVER deletion proof, so v1 infers no
deletion. Media bytes, expiring media URLs, stories, scheduled posts, comments,
reactions and post analytics are outside this slice.

The read surface is the already shipped generic Agent operation #10 and its
existing `hub dataset` command with dataset `posts`. Verbatim text deliberately
requires both existing capabilities, `read:datasets` and `read:messages`; no
post-specific capability, endpoint or CLI command is added. V1 has exact
registry filters and `publishedAt` sorting but no full-text search. The global
catalog says post capture is `unknown` because rollout is page-scoped; a page
response derives its windowless oldest-stored-row floor from `creator_posts`
and may report a before-floor gap, but by #197 that remains evidence about Hub
holdings rather than proof that no older vendor posts exist. V1 has no backward
post-history intent, so another incremental run is not advertised as a remedy
for a window before that floor.

**Decision #206 (2026-08-02, executable Fansly reverse evidence is a guard,
not a fixture).** The archived reverse project is useful where it contains
running client behavior, not merely guessed OpenAPI prose. Its purchase-history
loop establishes the contract we adopt: request one media or bundle target,
continue with `before` equal to the last row's `orderId`, and terminate only on
an empty successful page. The Hub therefore stores a v4 cursor per target,
journals every page before classifying it, reconstructs a chain after a crash,
and blocks missing, repeated, cyclic or forked cursors. A short non-empty page
is continuation, never completeness.

The same evidence hardens the existing money and DM walks. A successful
transaction page must carry a non-negative safe-integer `total`; the raw payload lands
before total, overlap, empty-page or final-count guards run. A DM sweep likewise
requires a stable valid total and a persisted set of unique group ids. Drift,
overlap, or an unverifiable legacy checkpoint abandons that generation and
starts from offset zero without hiding any conversation; destructive
finalization is allowed only when the unique count equals the provider total.
Fan earnings are captured one provider response at a time. A fan rejection
stops the keyset at its contiguous successful prefix, and one malformed money
breakdown poisons the whole `(fan, window)` aggregate instead of producing a
plausible partial total or an invented zero.

Fansly egress is required at every standalone verification/onboarding boundary,
including the service and CLI, reaffirming #124. Proxy removal remains a
separate explicit operator action. Four useful reverse-observed reads land only
at the typed adapter boundary for now: earnings overview, tracking links,
account-list membership and list items. They preserve raw responses and expose
`contractAccepted`; none is advertised as captured or persisted until a real
runtime consumer and storage model exist.

Live Fansly response dumps are not test fixtures. The working tree keeps only a
small explicitly synthetic corpus with privacy guards and non-zero synthetic
money probes. Removing the old corpus from the current tree does NOT erase it
from Git history; history rewriting, force-pushing and any credential/URL
rotation are a separate destructive owner operation and are not authorized by
this decision.

The Agent API review closes two adjacent truthfulness gaps. Transaction rows
and summaries serve active current heads only, while `captureFloor` remains the
physical page-wide minimum across retained active and inactive rows. Dataset
filter values are validated against registry field kinds before SQL, native
timestamp/money comparisons preserve their types, and cursor v1 accepts only
the single sort term it can actually encode.

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

**Decision #208 (2026-08-02, live Fansly lists verify at the terminal boundary;
an absent DM total can never authorize destructive finalization).** Production
raw evidence closed two false assumptions without weakening either deletion
guard.

A follower reconcile walk is not a transaction. The three durable production
blocks on `lilly-2`, `lora-2` and `lora-3` contained complete, successfully
hydrated generations, but each was compared with `account_me.followCount`
captured 6–15 minutes earlier. Retained pages prove real joins/leaves during
both the original walk and its single retry; the unique raw ids equal the
projected generation rows. The terminal page therefore persists the completed
generation as `verificationPending`, then captures `account_me` again. If the
chunk has no request capacity, the next chunk performs only that verification
request and never refetches the list. Deactivation is still allowed only when
the generation's exact unique count equals this fresh terminal headline. The
starting headline remains diagnostic, offset duplicates remain a warning when
the unique count is exact, and #166's one bounded restart followed by a durable
block is unchanged.

The live and archived `/messaging/groups` contract consistently returns
`aggregationData.total` as null or omits it. Decision #206's unconditional DM
total requirement contradicted that captured contract and made every Fansly DM
conversation stream restart forever after deployment. This decision PARTIALLY
supersedes #206 only for that field. Every page still lands raw-first and every
generation persists its unique group-id set. Duplicate ids, cross-page overlap,
an invalid non-null total, a present-to-absent transition, an absent-to-present
transition, or a changed numeric total still abandons the generation before any
terminal visibility write.

When a numeric total is consistently present, destructive finalization keeps
the #206 rule: the unique count must equal that stable total before unseen
conversations may be marked invisible. When the total is consistently absent
or null, a terminal short page may complete the capture walk and advance sync
freshness, but completion is explicitly `destructiveFinalization:false` and
unseen conversations remain visible. The outcome is recorded as a note and in
run stats rather than as a health-degrading anomaly. This is the anti-deletion
fallback: stale visibility is preferable to inventing completeness from a
provider field that does not exist.

No migration or public contract changes. After deployment, the three historical
follower blocks require a targeted `followers_reconcile` reset/requeue so their
abandoned cursors cannot resume; the generation high-water rule from #173 keeps
the replacement generations monotonic. The five DM streams need only a fresh
request: their failed terminal guards never hid data and their next total-less
sweep completes under the new non-destructive mode.

**Decision #209 (2026-08-03, Fansly post monetization separates cumulative
snapshots from individually attributable tips).** The Fansly timeline already
returns the counters rendered on a creator post. Every supplied money value is
Fansly-native mills and cumulative as of that observation. `tipAmount` is the
post-target component, `attachmentTipAmount` is the tipped-reply component, and
the bottom-of-post total is exactly their sum (with a missing component treated
as zero only when the other component is present). The provider's separate
`totalTipAmount` field is NOT that rendered total and is neither substituted nor
added into it. If both component fields are absent, Hub records no counter fact,
not an invented zero.

Tip goals remain timeline snapshot material. A post's type-7100 attachment links
to the top-level goal by id; target/current amounts are cumulative mills and the
label is provider-verbatim creator text. One goal may be shared by several
posts, so the per-post projection intentionally repeats its latest observed goal
snapshot. Any cross-post or campaign aggregation MUST deduplicate by
`tipGoalRef`; summing `tipGoalCurrentMills` across post rows double-counts a
shared goal.

Individual attribution comes from one companion
`GET /tips?targetIds=<timeline post ids>` after each non-empty Fansly timeline
page. The two requests are one checkpoint unit and reserve both request slots up
front. Each successful provider response is journaled verbatim before contract
rejection: timeline under `posts`, the array under `post_tips`. Accepted tip
targets append projection-only `post.tip_observed` events and rebuild into one
current row per `(page, native tip id, native post id)`, retaining the donor's
platform user id, amount in mills, occurrence time, transaction refs, the
provider-verbatim optional message and full source lineage. Exactly one
type-1000 target establishes the post. Zero or multiple post targets are
ambiguous. At most one type-7100 target establishes the goal; an optional
top-level `tipGoalId` may corroborate that target but may neither replace nor
contradict it. `post.tip_observed` schema v2 therefore makes a precise
donor-to-post and, when the target exists, donor-to-goal claim. These remain
facts about accepted rows in captured responses; an empty or partial capture
is not proof that no other tips exist.

Fault isolation is deliberately asymmetric. A non-array companion response is
journaled and left below the parser floor, but records a sync anomaly and does
NOT block the timeline checkpoint: optional attribution drift cannot wedge the
creator-post lane or repeatedly refetch a valid timeline page. Inside a valid
array, every item is parsed independently. Valid siblings still become
`post.tip_observed`; rejected indexes and bounded reason codes become hidden
projection-only `post.tip_parse_rejected` diagnostics under the same atomic
checkpoint. A future family-version bump replays the retained raw response and
can retire that parse debt without guessing today.

The requested page scope is a second, independent boundary. At capture time an
explicit receiver mismatch or any type-1000 target outside the requested
`targetIds` quarantines the response: `sync_raw_payloads` keeps the provider
body verbatim, while its `post_tips` observation carries a bounded
request-context envelope that the current parser deliberately leaves as visible
parse debt. A `fansly_post_tips_scope_drift` anomaly records only indexes and
reason codes. The canonicalizer also compares each tip's `receiverId` with the
page's native Fansly account ref, so legacy or manually re-journaled
observations cannot silently cross accounts.

The Agent plane exposes three Fansly-only datasets instead of widening the
existing text-only `posts` dataset. `post_monetization` is money-bearing and
contains a verbatim goal label, so it requires `read:datasets` + `read:money` +
`read:messages`. `post_tips` is money-bearing and carries the fan-written
verbatim tip note, so it has the same three-capability gate. `tip_goals` ranks
the repeated current post heads deterministically and returns exactly one
latest snapshot per native goal plus `linkedPostCount`; it is the aggregation
surface that removes the shared-goal double-count footgun. Platform capture
gates remain independent (`capturesPostMonetization` and `capturesPostTips`);
OnlyFans reports `not_captured` rather than allowing row-level nulls to imply
support. Fail-closed `posts` observations below canonicalizer v4 surface as a
`creator_posts` parse-debt gap on `posts`, `post_monetization` and `tip_goals`;
the current head must not look complete while a newer captured page awaits
replay.

The temporal contract stays split on purpose. `post_monetization.windowColumn`
is `publishedAt`, the stable identity axis of its one-row-per-post snapshot;
both `publishedAt` and `lastObservedAt` remain filterable, but observation time
does not masquerade as money time. A known post is retrieved with a broad
publication window plus exact `postRef` filter. `post_tips.windowColumn` is
`postTipOccurredAt` and answers which individually attributable money movements
were captured in a period.

Migration 0121 additively extends `creator_posts` and creates
`creator_post_tips`. The posts canonicalizer advances to v4, so retained v1
timeline observations replay into the new cumulative fields while old
`post.observed` and v1 `post.tip_observed` events remain projectable; new
material hashes include the money/goal snapshot, exact goal target and tip
message. Replay cannot invent historical individual tips from a `/tips`
response Hub never captured.

The first Fansly posts run after this feature sees the absent durable
`fanslyPostTipsBackfilledAt` marker and deliberately ignores the legacy head
anchor once. It resumes a checkpointed full walk until the terminal empty page,
capturing monetization and `/tips` responses for older posts before stamping the
marker. The upgrade backfill is bounded, resumable and never inferred from
replay.

Later six-hour revisions deliberately do NOT stop at the previous head. Each
logical walk freezes a publication cutoff at its start (`now - 14 elapsed
days`), pairs every visited timeline page with `/tips`, and completes only at
the terminal empty page or after capturing one page whose every post is older
than that cutoff. A mixed-age page and a post published exactly at the cutoff
both force pagination to continue. The previous-head encounter is telemetry,
not a termination condition. The frozen cutoff, `before` cursor, page index,
captured head and anchor flag are durable; a chunk or request-generation
boundary changes ownership only and inherits that exact walk instead of
restarting at page zero. This relies on Fansly `/timelinenew` remaining
newest-first; the conservative all-old-page boundary and post-deploy acceptance
make that assumption observable without comparing opaque post ids.

The serving boundary is deliberately narrower than the raw evidence. The
monetization dataset is the latest observed current-head snapshot, not a
time-series balance. Ordinary capture revisits the rolling 14-day publication
horizon, so late tips on those posts refresh even after their post has moved
below the prior-head page. A post older than the frozen horizon is still a
point-in-time observation: its counter, goal and individual tip rows are not
claimed continuously current, and `lastObservedAt` is the evidence for the last
refresh. The aggregate `attachmentTipAmount` does not identify the donor of a
tipped reply, and `/tips?targetIds=<post>` may omit a tip whose actual target is
a reply/attachment rather than that post. Therefore the sum of captured
`post_tips` rows is NOT required to equal `postTipTotalMills`; any shortfall is
reported and investigated, never filled by inference. A post-deploy live
acceptance against the known birthday posts is the gate for both the
newest-first walk assumption and how complete Fansly's target-filter semantics
are in practice.

**Decision #210 (2026-08-03, live Fansly post-tip shape corrects the
unverified goal-attribution contract).** Production acceptance immediately
after #209 found that `GET /tips?targetIds=<post ids>` does return an array, but
its live items are flat: `id`, `senderId`, `receiverId`, `amount`, `message`,
`createdAt`, and `targetId`. They do not carry `targets`, `tipGoalId`, or either
transaction reference. Across the acceptance corpus every `receiverId` matched
the scoped page and every `targetId` was one of that request's post ids. The
returned rows exactly reproduced the known per-post tip counts and totals.
This live evidence supersedes #209 only where #209 treated nested typed targets
as the established provider contract.

The flat `targetId` is exact donor-to-post evidence. It is not donor-to-goal
evidence. Timeline attachments link a goal to a post, while one post can contain
both goal-qualified and direct tips; copying the post's goal ref to every tip is
therefore false. The matching earnings transaction is also insufficient: live
tip ids join one-to-one to `transactions.correlation_id`, but those rows expose
no goal or target discriminator. Subset-summing individual amounts against a
goal counter is inference and can be non-unique, so Hub does not do it.

The posts canonicalizer advances to v5 and accepts either the live flat shape
or the previously supported nested typed-target shape. A flat item emits
`post.tip_observed` schema v3 with internal
`tipGoalAttribution = 'unknown'`; nested type-7100 evidence emits `goal`, and a
nested target list with no type-7100 target emits `direct`. The immutable event
keeps that epistemic distinction even though the current serving projection
stores only an exact nullable goal ref. The capture-time scope guard now checks
flat `targetId` as well as nested type-1000 targets. Retained v4-rejected arrays
replay under v5; malformed siblings remain bounded item-level debt.

Projection merge follows the same evidence law across repeated sightings of
one immutable tip. Schema-v3 `unknown` and semantically unknown schema-v1
material cannot erase a non-null exact goal ref captured earlier; a newer
explicit `direct` or `goal` sighting remains last-writer-wins. Incremental
projection and full rebuild apply the identical field merge.

No schema migration is justified. The live source supplies no known/direct
state to persist for any row, and adding a column would not create a new fact.
Serving is deliberately conservative: a non-null `postTipGoalRef` is exact goal
evidence, while null has row state `source_did_not_provide`, never
`observed_empty`. Consequently live acceptance can prove individual post rows,
counts, sums, sender, time, and note, but cannot require the known aggregate
goal/direct split to appear on individual rows. `post_monetization` and
`tip_goals` remain the honest goal-level snapshot surfaces.

**Decision #211 (2026-08-03, tip notes are an exact gated projection, not an
inferred transaction-to-message join).** Fansly's retained `/message` response
contains two independently useful structures. Its `tips[]` sidecar carries the
provider tip id, amount, occurrence time, sender, receiver and optional
fan-written `message`; the request envelope carries the exact `groupId` whose
conversation was fetched. Production evidence establishes a one-to-one bridge
from `tips[].id` to the existing tip transaction's `correlation_id`. It does
not establish a bridge to one archived message: `messages[].correlationId`
exists for only a subset, and target type 4000 ids do not join archived message
refs. Time-and-amount proximity is useful diagnostics but is not identity.

Hub therefore materializes `transaction_tip_contexts` directly from every
successfully journaled Fansly `dm_messages` raw payload. One current row per
`(account_id, platform_tip_id)` stores the exact request-scoped conversation,
the sidecar note, provider money/time/party facts and raw-payload lineage. A
materializable item MUST carry a valid provider tip id, sender id and occurrence
time; an absent/null optional note is valid, an empty string is observed empty,
and a present non-string note rejects that item instead of becoming a false
source absence. The parser is item-level fail-open: one rejected sidecar item
cannot wedge the DM lane or discard valid siblings, but it does create bounded
parse debt. Raw journaling remains first.

Projection upsert is idempotent and knowledge-monotonic, so a later sparse
observation cannot erase a previously captured conversation or note. Identity
lineage (`source_raw_payload_id`, `captured_at`) stays with the observation that
established the row, while verbatim note lineage has its own
`tip_message_source_raw_payload_id` and `tip_message_captured_at`. While that
raw survives, the note FK names the observation that actually proved those
bytes. Both raw FKs are nullable with `ON DELETE SET NULL`: normalized facts
keep their capture times after ordinary raw retention expires, while lineage
can never wedge journal cleanup.

Every projection write takes the Stage-28 shared erasure fence lock and tests
the same material-time boundary, using the earlier of provider occurrence time
and Hub capture time. A matching executed/non-dry-run erasure tombstone is a
terminal intentional `erasure_fenced` result, even if that erasure attempt died
mid-flight; lock contention with an actively running erasure is `deferred` and
MUST retry or fail without advancing replay progress. Fan erasure deletes
contexts matching the captured sender, receiver or conversation scope, and
page/model erasure deletes the whole account plane. Thus retained raw cannot
resurrect a note or party identity after erasure.

Retained raw payloads are recoverable through a bounded keyset historical
backfill. Each run freezes its raw high-water before scanning, advances only
after terminal outcomes, and emits only static sanitized boundary errors; live
capture cannot extend the run indefinitely and a database error cannot print a
bound note or provider identifier. Replay never uses a temporal or amount
heuristic.

The existing `transactions` dataset remains the money-only surface and keeps
its capability boundary. It gains the honest alias `correlationRef`; the old
`relatedMessageRef` is retained for compatibility but is explicitly legacy and
MUST NOT be interpreted as a message id. Verbatim tip notes are served through
the separate `tip_transactions` dataset, which starts from every active
canonical tip transaction on every platform, left-joins exact context where it
exists and requires `read:datasets` + `read:money` + `read:messages`. A row
returns the usual transaction money fields plus `correlationRef`,
`contextState`, `capturedConversationRef` and `tipMessageText`. OnlyFans rows
remain visible with `contextState = 'not_captured'`; unsupported context must
not turn into a false absence of tip transactions.

Null semantics are structural. A transaction without an exact projected
context reports both context fields as `not_captured`. A captured sidecar with
no provider note reports `source_did_not_provide`; a supplied empty note is
`observed_empty`; non-empty text is present. Dataset evidence independently
checks for eligible Fansly tip transactions lacking a context row and exposes
that as `internal_capture_gap`. A retained-raw backfill closes the replayable
subset, but a remaining gap honestly recommends a fresh free recapture rather
than promising that local replay can recover a DM page Hub never retained.
Reading the money rows alone cannot prove that no notes exist while this gap remains.
There is deliberately no `messageRef` in this version. A future point lookup
may return one archived message plus bounded neighbours, but only after an
exact provider-backed message identity is available; conversation membership
or nearest timestamp is not silently upgraded into that claim.

**Decision #212 (2026-08-12, G1 storage stop-loss: telemetry is bounded,
capture is not):** The 2026-08-11 disk census (88% full, ~2 GB/day of DB
values) attributed the dominant daily growth not to captured facts but to
telemetry re-copying them: `summarizeCheckpoint` embedded the full
`page_sync_cursors.state` — including the cumulative `snapshotConversationIds`
array, O(N²) across a Fansly `dm_conversations` sweep — into every
`checkpoint_loaded`/`checkpoint_advanced` event and `sync_runs.stats`
(~1.34 GB/day), and the worker printed a stdout trace line per upstream HTTP
attempt (~83% of its log volume) into an unbounded `json-file` Docker log.

G1 bounds the representations without touching capture, retention windows, or
any deleter:

- Checkpoint telemetry stores a bounded generic projection (scalars verbatim,
  strings truncated at 120 chars, arrays as `${key}Count`, objects as
  `${key}Keys`, 32-key cap). The authoritative state stays in
  `page_sync_cursors`. `stats.checkpoint.advanced` is recorded at write time
  OR derived from a diff of the bounded summaries — some handlers persist
  checkpoints without calling the telemetry method, so neither signal alone is
  truthful.
- Per-attempt success stdout traces are suppressed by default behind
  `SYNC_HTTP_ATTEMPT_TRACE_STDOUT` (EDITABLE, `runtimeApply: "none"`).
  Retries, failures, and any attempt whose `sync_http_attempts` row failed to
  persist still reach stdout — stdout remains the surviving record of an
  attempt the DB could not keep (the pinned best-effort invariant). The
  optional NDJSON file sink stays full-fidelity.
- Production Compose applies the bounded `local` log driver (20m × 5) to every
  service, pinned by a derive-from-file contract test; Postgres gains
  `stop_grace_period: 60s` so a recreate cannot SIGKILL a checkpointing
  cluster.
- The hourly disk check persists `disk_free_bytes` / `disk_used_bytes` /
  `disk_used_percent_bp` gauges into `ops_metric_samples` for a later
  days-to-full slope; the ops sampler deadman excludes `disk_*` so an hourly
  writer can never mask the minutely sampler's death.
- The deploy script sweeps its remote dist-only build context via the EXIT
  trap (previously leaked on failed builds) and gains an allowlist image GC
  (full-ID keep-set including running containers, candidate/rollback tags
  only, abort on a degraded keep-set). Per #176's owner-gated image-deletion
  rule the GC is DEFAULT OFF and runs only with `--image-gc` /
  `DEPLOY_IMAGE_GC=1` on an explicit owner say-so.

Deliberately NOT in G1: no retention value changes (`SYNC_OBSERVABILITY_
RETENTION_DAYS` stays 30 — lowering it drives the sanctioned sweep through
unbatched `sync_runs` deletes whose `ON DELETE SET NULL` seq-scans the
unindexed 19.5 GB `sync_raw_payloads.sync_run_id` column and severs the
raw→observation idempotency-key lineage the #133 rejournal repair depends on;
a leaf/parent retention split plus that index are prerequisites), no schema
changes, no new deleters. Follow-ups tracked in
`investigations/storage-unified-execution-plan-2026-08-11.md`.


**Decision #213 (2026-08-12, disk runway latches — days-to-full pages before
percent does):** The 80% `db_disk_usage` latch fires when the disk is already
nearly gone and, being latched, never re-pages while it stands open — during
the August storage incident the owner received at most one page as the disk
went 80→90%. G1's hourly `disk_free_bytes` gauges now feed a least-squares
24h fit (7d as a secondary readout); the fitted days-to-full drives two NEW
independent latches, `db_disk_usage:global:runway_warning` (<30 days) and
`:runway_critical` (<7 days), with thresholds as in-file constants — they are
containment, not tuning surface.

Semantics: a series spanning under 6 hours is UNKNOWN — it neither opens nor
resolves a runway latch (ignorance must never clear a latch a real measurement
opened, e.g. after a restart onto a pruned series). A measured value resolves
per latch on recovery above that latch's threshold, and a measured flat or
positive slope resolves both. Warning and critical are independent latches, so
an escalation pages exactly once more — deliberate, since a single latch
cannot re-page on severity without losing the anti-flap property. Resolve
texts are subKey-specific ("Disk runway back above …; usage latches
unaffected"): resolving a runway latch while the percent latch or the other
runway latch stands open must not read as a disk-wide all-clear. The
error-handling canon's incident table gains both `db_disk_usage` rows in this
same change per #185.


**Decision #214 (2026-08-15, G3 checkpoint cutover: the generation set is the
membership authority):** The Fansly `dm_conversations` sweep carried its own
membership in `page_sync_cursors.state.snapshotConversationIds` — every group
id it had seen, rewritten in full on every page. That array was the top storage
writer measured on 2026-08-11 (O(N²) bytes per sweep, amplified through
checkpoint telemetry until #212 bounded the projection). The same membership is
already recorded row-side by `page_dm_threads.last_seen_generation`, which G2
slice 1 made monotonic under concurrent writers and G2 slice 2 proved equal to
the array in production. G3 removes the array and makes the rows the authority.

**State v2** is scalars only: `{version, mode, generation, offset,
observedCount, pageCount, providerTotalMode, providerReportedTotal,
unchangedPageStreak, fullSweepStartedAt, lastFullSweepCompletedAt}`.
`observedCount` is PERSISTED, not derived — it was previously read back out of
the array's length, so dropping the array without persisting the count would
have silently restarted every resumed sweep's count at zero. The parser accepts
both stored shapes and migrates v1 on load by adopting the array's length; a v1
state carrying neither the array nor a count is refused loudly and its sweep
restarts, as the retired legacy-snapshot guard did.

**Rollback is by version, not by hope.** The pre-G3 parser tests `version !== 1`
exactly, so a v2 state reads there as no cursor at all and the old handler falls
into its fresh-sweep branch: generation = max(stored generation, row-side
high-water) + 1, offset 0. A rolled-back sweep loses PROGRESS and never
correctness, because the new generation is above every stamp its finalization
compares against; `generation` and `lastFullSweepCompletedAt` are read off the
raw record and survive the round trip. Pinned by a test holding a verbatim copy
of the old parser.

**Certification.** Cross-page overlap — the provider handing back an id an
earlier offset page already applied — is now a pre-upsert read of the rows
carrying this generation, inside the page write transaction, which is where the
stamp and the count that follow it are also decided. Within-page duplicate ids
and the provider-total mismatch stay in memory and stay BEFORE the hydration
loop, so a malformed page cannot spend group-detail or head-repair requests
against Fansly before being rejected. The destructive visibility pass
(`markPageDmConversationsInvisibleByGeneration`) runs only when
`count(last_seen_generation = generation) == observedCount` EXACTLY.

Two strictness rules make that gate meaningful rather than decorative:

1. **An erasure never authorizes destruction.** A shortfall can have a benign
   cause — the Stage-28 module deletes stamped rows mid-sweep — but
   `findErasureLogTouchingPageSince` proves only that SOME erasure touched the
   page, never that it deleted the specific missing rows. An abandoned erasure
   beside one genuinely lost stamp is indistinguishable, and acting on it would
   hide a live thread from every chatter's list. A plausible erasure therefore
   downgrades the report from an error anomaly
   (`dm_conversations_generation_membership_guard`) to a calm note
   (`dm_conversations_dual_proof_erasure_delta`) and changes nothing else. Per
   #208, stale visibility is explicitly preferred to a vanished thread.
2. **Uncertified membership always withholds the completion**, not merely the
   destructive pass. A total-less sweep runs no visibility pass either way, but
   it must not stamp itself the stream's last successful run or advance
   `lastFullSweepCompletedAt` on a membership it could not certify; the
   completed state is written progress-only. The withheld state carries no
   `mode`, so the retry is a fresh sweep under a higher generation, which
   converges on its own.

**Two new automatic retry dispositions**, both in the error-handling canon per
#185 and both using the existing yield/defer machinery rather than an
exception: a page fenced by a running erasure defers the chunk with a +60s
`continuationRetryAt` (nothing read past the lock, nothing written, same offset
re-fetched); a withheld finalization yields with +15min, because an uncertified
membership tends to repeat and an unthrottled retry would re-walk the whole
page against the provider on a loop.

The G2 dual-proof module and its unit tests are retained for replaying archived
v1 states, and its count-shaped erasure predicate is the one the live sweep
uses — one definition of "only a shortfall can be an erasure", not two. The
per-page `generationSetCount` scalar keeps riding the checkpoint as the bounded
membership telemetry that replaced the array's digest. No migration:
`page_sync_cursors.state` stays jsonb, just smaller. No OnlyFans path changed
and no platform branch added.


**Decision #215 (2026-08-16, G5 slice 1: the CAS copy is written before the
fact, and proved after it):** Slice 0 (#c64bdc27) landed the content-addressed
payload catalog with no writer. This slice turns on the first one, for pull
capture only, behind a bounded canary that is off by default. The inline bodies
— `observations.payload` and `sync_raw_payloads.response_payload` — remain the
authority for every reader; nothing in this slice resolves a payload through
the new references.

**Ordering: the object first, in its own transaction, and its address travels
into the inline INSERT.** `persistRawPayload` fixes ONE `captureInstant` (§7
step 1, so raw and observation can never address different months across a UTC
boundary), stores the body in the catalog, and passes the resulting
`(payload_bucket_month, payload_object_id)` pair to `insertRawPayload` and
`insertObservation` as ordinary column values.

Both alternatives were rejected for concrete reasons, not taste:

- **Same transaction as the inline insert** would have destroyed capture-first.
  A failed statement aborts the entire PostgreSQL transaction (25P02), so no
  `try`/`catch` around the CAS branch could have saved the capture; a codec
  refusal, a jsonb rejection or a missing catalog partition would have cost the
  provider response itself. DP 7 does not bend for referential tidiness.
- **A post-commit UPDATE of the references** would have minted a second heap
  tuple and its WAL for every capture, on the two largest tables in the system
  (~19 GB of TOAST between them). Paying for a fresh row version per capture in
  order to record a deduplication is self-defeating in a project whose entire
  purpose is removing physical duplication.

The only cost of this ordering is an ORPHANED OBJECT when the capture fails
after the CAS commit: harmless, unreachable by any reader, invisible to the
verifier (which only examines rows that HAVE references), and collapsed onto by
the next identical capture. §7 puts the object ahead of the envelope for the
same reason. Every CAS failure is swallowed and yields null references, which
is and must remain a permanently legal state.

**No foreign key on the envelope side, deliberately.** PostgreSQL 16 would
accept an FK to the catalog's composite partitioned primary key, so this is a
choice: an FK would tax the hottest write path in the system with a partition
lookup plus an index probe per capture, and would put the catalog's future
partition maintenance (the cold tier's detach/attach) in the way of live
capture. What IS enforced in the database is a two-directional CHECK — both
reference columns set or both null — because a half-set reference is an address
that cannot be resolved, silent unreachability wearing the shape of a valid row
(the same law as `capture_payload_locations`' locator CHECK). It is added NOT
VALID and never validated: both columns are null for every pre-existing row, so
the constraint is vacuously true for all of history, while PostgreSQL still
enforces it on every INSERT and UPDATE from that moment on. Validating it would
scan ~35 GB for zero information on a box whose free space is why G5 exists.
The dangling reference an FK would have prevented is instead what the parity
verifier looks for — and a dangling reference must never cost us a captured
fact. Slice 0 made the same call in the other direction: the body tables DO
carry an FK to the catalog, because they are small, low-rate, and a body
without its identity row is unreadable by construction. Same reasoning, applied
per write rate.

**No index on the reference columns.** This is a write-only stage; the verifier
samples by scanning a bounded window of the most recent rows in primary-key
order, so nothing needs one. An index is earned by a query plan in the pointer
slice.

**One setting is both the switch and the bound.**
`capture_cas_dual_write_pages` is a CSV of platform page ids (numeric — the ids
are what the capture seam holds without an extra lookup) or `*`. It FAILS
CLOSED: empty means no pages, the opposite of `fanslyNewStreamPageAllowlist`
and the same direction as `voiceNotesPageAllowlist`, because an unset setting
must never read as "dual-write the entire fleet". A second `enabled` flag was
not added: it would only make it possible to be on with no bound. The value
reaches each process on the runtime heartbeat, which already loads the effective
config once a minute in every role — so the slice adds NO query in either
state, and off is byte-identical to the pre-slice capture path. The price is
that a flip lands within one heartbeat interval rather than instantly, which is
the right latency for a canary whose ramp is measured in days.

**Restricted material stays out.** This seam carries pull capture only, so the
lane is `platform_capture` (`ordinary_capture` / `fan_subject`). Stage 29
verbatim prompts and completions never pass through `persistRawPayload` and
must never be added to it: they would then share an identity scope with
ordinary capture, and a coalesce could hand a restricted body to an ordinary
reader. A restricted writer gets its own seam and the `ai_generation` lane,
which is a structurally different object.

**The proof, and its refusal to fix anything.** An hourly job
(`capture.payload.parity.verify`, :35 UTC) samples up to 50 referenced
envelopes across both tables, loads each catalog body, and compares the FULL
canonical octets — never the digests, which travel in the report only as a
fingerprint (#214's dual-proof discipline, and slice 0's "hash is not proof of
equality"). It NEVER repairs, deletes or touches inline data: a job that
reconciled a captured fact with a derived copy of itself is precisely what DP 7
forbids. With the canary off it returns without touching the database and
without touching the incident latch, because "not measured" is not "measured
and clean" — turning the canary off after a real mismatch must not clear the
alarm (#213's asymmetry). A mismatch pages under a NEW incident kind,
`capture_payload_parity`: reusing `db_disk_usage` or `observations_partitions`
would have told the owner a false story about which subsystem is broken, and
this is also the kind the slice-0 collision path (a sha256 collision inside one
scope and month) will use when it is wired. Per #185 the kind is added to the
error-handling canon's incident table in this same change.

**Decision #216 (2026-08-17, jsonb reads are single-parse):** drizzle-orm
0.45.2's builtin `jsonb` column maps a driver value like this:

```
mapFromDriverValue(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}
```

node-postgres has already run `JSON.parse` on the jsonb wire value before
drizzle ever sees it. So the branch is not a fallback for an unparsed string —
it is a SECOND parse, and it fires exactly when the stored jsonb value IS a JSON
string. Stored `"4"` comes back as the number 4, `"true"` as the boolean true,
`"null"` as null, `"{\"a\":1}"` as an object. A stored `"enforce"` survives
only by accident: its second `JSON.parse` throws and the `catch` hands the
string back. The corruption is silent, type-dependent, and invisible to every
type annotation in the codebase, because `$type<string>()` describes what we
believe the column holds, not what the mapper returns.

**How it surfaced.** On 2026-08-16 the G5 CAS dual-write canary was armed by
setting `config_settings.captureCasDualWritePages` to `"4"` — the CSV of canary
page ids, one page. The row was written correctly. On read it became the number
4; `validateConfigOverride` saw `kind: "string"` and a number, returned
`expects a string`; `applyEffectiveOverrides` skips any override that fails
re-validation (`if (!validated.ok) continue`), so the overlay dropped it. The
canary never turned on, the setting read back as its env default, and NOTHING
logged an error — the drop is a `continue`, by design, because an invalid stored
override must not take a process down. Production is currently running the
workaround value `"4,"`, whose trailing comma makes the second parse throw.

**The fix is a column type, not a validator patch.** Hardening
`validateConfigOverride` to coerce a number back into a string would have made
this one key work and left the trap armed for every other jsonb read, while
teaching the validator to accept values the write path can never produce.
Instead `packages/db/src/schema.ts` declares a `jsonbSafe` `customType`:
`dataType()` returns `jsonb`, `fromDriver` returns the driver value AS-IS, and
`toDriver` is `JSON.stringify(value)` — character-for-character what the builtin
`mapToDriverValue` sends. **The write/wire format is unchanged**, verified
against the drizzle 0.45.2 source in `node_modules`; this is a READ-SIDE fix
only. There is NO migration and there must not be one: every byte already in
Postgres is correct, and always was — only the read lied.

**All 55 jsonb columns switched, not just the three that can hold a scalar.**
`config_settings.value` and `config_audit_log.old_value`/`new_value` are the
only columns TYPED as scalars (`ConfigOverrideValue = string | number |
boolean`), and they are the only ones the bug can bite today. The rest hold
objects and arrays, which the driver returns as JS objects and which both
mappers pass through untouched. But "safe because of what we happen to store" is
not an invariant — it is one refactor away from a silent data bug in the capture
spine, and the four structurally untyped columns (`observations.payload`,
`domain_events.data`, `capture_json_hot_bodies.body`,
`sync_raw_payloads.response_payload`) are precisely the ones a future change is
most likely to hand a bare JSON string. A uniform type also removes the standing
question "is THIS column one of the safe ones?" from every future review. An
audit of every read-site found nothing depending on the double-parse: no code
writes a pre-stringified JSON string into a jsonb column (the ~45 sites that
look like it are raw `sql` templates with an explicit `::jsonb` cast, where
Postgres parses once and drizzle's mapper is never invoked), and no code
`JSON.parse`s a drizzle-read jsonb column.

**The guard.** The builtin is now lint-banned repo-wide — `no-restricted-imports`
blocks the single name `jsonb` from `drizzle-orm/pg-core` (every other export
there stays available), so re-introducing the trap fails `pnpm lint` with a
pointer to `jsonbSafe`. The regression pins live in
`tests/config-settings.integration.test.ts` and go through the real repository
writes and the real overlay: the production value `"4"` must survive as the
STRING `"4"` all the way into the merged config, a batch of strings that are
themselves valid JSON (`007`, `true`, `null`, `[1,2]`, `{"a":1}`, `1e3`, `-0`)
must each round-trip verbatim, number and boolean settings must stay their own
types, and an object-payload column (`runtime_instances.running`, read through
the relational query builder — a different mapping path than a plain select)
must still come back an object with its nested scalars intact.

---

**Decision #217 (2026-08-18, G5 slice 2: reads move to the catalog through a
staged, fail-open seam):** slice 1 (#215) put a second, content-addressed copy
of every pull-capture body on disk and proved it faithful hourly. Nothing read
it. This slice teaches the readers to, one mode at a time, without changing what
a single caller receives until the owner says so.

**One seam, one mode, three states.** `apps/runtime/src/services/payload-reader.ts`
resolves `(inline body, optional catalog reference)` into the body a caller
gets, under `capture_cas_read_mode`:

- **`inline`** — the inline column, exactly as every reader behaved before this
  slice. The mode check is ONE process-local variable read and the function
  returns: no query, no allocation, no logger call. This is the default and the
  deploy state.
- **`shadow`** — the caller still receives the INLINE bytes. Additionally, for
  an envelope that carries a reference, the catalog copy is read and compared
  OCTET FOR OCTET through the frozen codec, the verdict is counted, and each
  disagreement emits one bounded log line (envelope, id, reference, reason —
  never the body). This is the hourly parity job made continuous and per-read,
  and it is structurally incapable of changing an answer.
- **`serve`** — the catalog canonical body IS what callers receive.

**The inline columns remain the AUTHORITY OF RECORD in every mode.** `serve`
moves where the bytes are fetched from; it does not move what is true. That is
why nothing in this slice nulls, rewrites, or stops writing an inline column,
and why a `serve` failure is not an error condition at all.

**Fail open to inline, always.** There is no mode and no failure path in which
the seam throws, returns null where a body existed, or returns anything but the
inline body when it cannot prove a catalog body. Object missing, body row
missing, an `exact_bytes` object under a `jsonb` envelope, a codec refusal, a
dead connection — each falls back to inline and bumps a counter. In `serve` the
fallback is SILENT by design: a fallback is a normal safe outcome, not an
incident, and a per-read error log on a degraded catalog would drown the log
before anyone read it. The counters ride the parity job's telemetry line.

**Transitions are stepwise up, free down** — `validateCaptureCasReadModeTransition`
is `validateAiTranscriptFreshUnionModeTransition`'s rule verbatim, checked inside
the same locked write transaction. `inline → serve` is rejected: a mode that
changes the byte source of a read must first spend a window in `shadow`, where
the identical comparison runs on live traffic and cannot affect a caller. Every
downward move is allowed unconditionally — a rollback must never be rate-limited
by the rule that governs enabling.

**THE READ PATH OWNS NO ALARM, and this is the load-bearing decision.** A shadow
mismatch counts and logs. It does NOT open, and does not resolve, the
`capture_payload_parity` incident. The hourly verifier
(`services/capture-payload-parity.ts`) stays the sole authority over that
latch's whole lifecycle. Three reasons, and any one of them is sufficient:

1. **A latch needs an owner that can also say "clean".** Resolution requires a
   pass that measured something and found it faithful. A traffic-driven read
   path cannot promise that: during a quiet hour it measures nothing, and
   "nothing measured" must never read as "measured and clean" (the same
   asymmetry the disk-runway latches and #215's skip branch already encode).
2. **It cannot bound its own paging rate.** The verifier pages at most once an
   hour off a bounded sample. A read path fires at traffic's whim; a systematic
   divergence would re-page per resolved row.
3. **Two writers race one latch.** The verifier resolving what a concurrent read
   just opened (or the reverse) makes the alarm's state a function of
   scheduling. One owner, one lifecycle.

So the read counters surface in exactly one place — the verifier's single
telemetry line, alongside the write counters — and that line now also fires when
the dual-write canary is off but the read mode is not, because references
written during an earlier canary window outlive a dual-write rollback.

**The body read is exported only in envelope-authorized form.** Slice 0 kept
`loadPayloadBody` off the package barrel because a bare `(bucket_month,
object_id)` is an ADDRESS, not an authorization: one object may be shared by
several envelopes and a `restricted_ai` body is addressed exactly like an
ordinary one. That pin stands. What the barrel gained is
`readEnvelopeCapturePayload`, which cannot be called without naming the ENVELOPE
CLASS the reference was read off — and that name is load-bearing, not
decoration: it decides which representation the reference may resolve to and
refuses the others (today both envelope classes store `jsonb`, so an
`exact_bytes` object means the two content planes have been crossed; the webhook
envelopes of a later slice will map to `exact_bytes`). A bare object id still
buys nothing.

**Key order is a non-issue, and it is pinned rather than assumed.** In `serve`
the returned value is the catalog body re-parsed from `jsonb`, a different
OBJECT than the inline one. It is not a different VALUE: both copies are stored
as `jsonb`, which normalizes key order identically on both sides, so the
canonical codec's own ordering never survives into what a reader sees and even
`JSON.stringify` over the two agrees. That matters because exactly one migrated
site RE-HASHES what it reads — `observations-rejournal` computes
`sha256(JSON.stringify(payload))` for the observation it re-journals — and an
integration test pins the equality of both the string and the digest.

**What was NOT migrated, deliberately.** Sites where Postgres digs INSIDE the
body and never returns it whole are out of scope and marked in place with
`CAS-READ-BACKLOG(§6.4)`: the harvest `payload->>'machineId'` lookups and the
transaction-residue extraction in `repositories/observations.ts` (one backed by
an index expression, migration 0096), the tip-context reader that narrows to
`{tips}` server-side precisely so it does NOT detoast the rest, the agent
plane's `octet_length(o.payload::text)` size column, the coverage-revoke
idempotency proof (inside packages/db, inside its own write transaction, no
logger and no seam reach), and erasure's `payload::text like` subject matching.
Per §6.4 these must move to narrow typed locator/projection columns BEFORE the
inline JSON can go away; routing them through the seam would mean fetching a
whole body to throw most of it away, which is the opposite of what the narrowing
is for. Also out: pointer-only writes, nulling inline, historical rewrite, the
static contract test banning direct `observations.payload` access (§7 puts that
after parity, in a later slice), and the webhook exact-bytes representation.

**Cost, and what bounds it.** `shadow` and `serve` each cost ONE catalog query
per envelope that CARRIES a reference; a null reference costs nothing in any
mode. References exist only for pages in the slice-1 dual-write canary, so that
canary bounds the read cost too — the two ramps are deliberately coupled. List
readers resolve row by row (no batch loader in this slice), so a replay page of
200 referenced rows costs 200 extra queries; that number is quoted in the
setting's `costWarning`, and a batch loader is the obvious next optimization if
the ramp ever makes it matter.

---

**Decision #218 (2026-08-18, G5 slice 3a: the queryable fields get typed columns
of their own):** #217 moved every reader that SERVES a capture body onto the
catalog and listed, honestly, what it could not move: the SQL that digs INSIDE
`observations.payload` / `sync_raw_payloads.response_payload` and returns a
FIELD. Those sites have no body for a seam to route, and each one silently
starts answering NULL the day the inline column stops being written — the last
thing standing between here and pointer-only writes. This slice gives each field
a narrow typed column (migration 0125), populated at INSERT time, and leaves the
inline extraction behind only as a fallback for rows written before it.

**Derived in packages/db, inside the same INSERT.** Every observation in the
system goes through `insertObservation` and every raw capture through
`insertRawPayload`, so the derivation lives there
(`packages/db/src/capture-queryable-fields.ts`, pure and unit-tested) rather
than at any producer. Two consequences are the point: a typed column cannot
disagree with the body it was derived from, because both come from the same
parsed object in the same statement; and there is NO second row version — a
post-commit UPDATE to stamp these columns would mint a fresh heap tuple per
capture on the two largest tables in the system, which is the exact
amplification this project exists to remove (the #215 ruling, applied again).

**The per-site decisions, and why they differ.**

- **Harvest lookups** (`hasHarvestObservationClientEvent`,
  `countHarvestObservations`, `listHarvestTransactionResidue`) →
  `observations.harvest_machine_id` plus, for the residue report,
  `harvest_tx_id` / `harvest_tx_amount` / `harvest_tx_created_at`. `text`, not
  `uuid`/`numeric`/`timestamptz`: capture-first (DP 7) outranks tidiness — a
  harvested fact with a malformed member must still journal, and `text` is also
  exactly what `->>` returned, which is what keeps the fallback equivalent to
  the column replacing it.
- **The one index-backed predicate is an OR, not a `coalesce`.**
  `coalesce(harvest_machine_id, payload->>'machineId') = $1` is unindexable, and
  the alternative to an index on `observations` is a scan of the largest table
  here. So that site reads `harvest_machine_id = $1 OR (harvest_machine_id IS
  NULL AND payload->>'machineId' = $1)` — two arms, disjoint by construction,
  each with its own partial index over the identical predicate (0126's typed
  twin of 0096's expression original), which the planner resolves as a BitmapOr.
  An `EXPLAIN` assertion pins that both index names appear and no `Seq Scan`
  does. The other two harvest queries DO use a plain `coalesce`, and that is not
  an inconsistency: 0096's partial index requires `source = 'client_capture'`,
  which neither of them constrains, so neither has ever been index-backed and
  there is no plan to protect.
- **The DM tip replay** → `sync_raw_payloads.response_tips`, a stored `{tips}`
  slice. This reader narrows IN SQL precisely so a keyset walk over hundreds of
  retained DM pages does not drag hundreds of whole message bodies across the
  wire; routing it through the seam would fetch each whole catalog body and
  throw most of it away — paying the exact cost the narrowing exists to avoid.
  A slice column keeps the walk cheap AND survives the body's removal. It is
  written only for `dm_messages` captures: filling it everywhere would copy a
  `{"tips": null}` onto every posts/fans/transactions capture in the system.
- **The agent plane's `payloadBytes`** → a LEFT JOIN to the catalog,
  `coalesce(cpo.logical_bytes, octet_length(o.payload::text))`, NOT a fifth
  typed column. The number is already stored, once, on the row the reference
  addresses; duplicating it onto every observation would pay heap for something
  the catalog PK hands over on an index probe, and would only ever be right for
  rows written after this slice, while the join is right for every reference
  slice 1 has already written. The value does shift for a referenced row
  (canonical octets vs jsonb's own text rendering, which pads its separators) —
  that is the correction, not a regression: a size measured on a column the
  system is about to stop writing is the number that would become a lie.
- **The coverage-revoke idempotency proof** → `readEnvelopeCapturePayload` with
  an inline fallback, no new columns. `pageId`/`chatId` are members of ONE
  operator kind's payload; two columns on the system's biggest table on behalf
  of a single caller is the wrong trade, and this reader wants the (tiny) whole
  body anyway. #217 marked it unreachable "with no logger and no seam reach" —
  true of the runtime seam, but the envelope-authorized reader is IN
  packages/db, so the smaller diff was simply to call it.

**No backfill, deliberately, and the fallbacks are marked for the slice that
removes them.** Every harvest row and retained DM capture in production keeps a
NULL typed column today and is found through the inline arm. Backfilling here
would mean an UPDATE across the whole of `observations` — again a second row
version per fact, for a column nothing yet reads. The HISTORICAL REWRITE slice
already walks that heap to null the inline bodies and populates these columns on
the same pass, from the same tuple, at no extra cost; only then may the arms go.
Each one is a `// CAS-INLINE-FALLBACK:` comment so that removal is a grep, and
each is written so the removal is a deletion rather than a rewrite.

**What is still not migrated, and who owns it.** Erasure's `payload::text like`
subject matching (`services/erasure/index.ts`). It is not a field — it matches
the WHOLE body as text to find a subject, so there is nothing to project into a
column, and the catalog owes it an answer first: a body may be SHARED by several
envelopes, so rewriting one under a single subject is not a per-row act. It
keeps its `CAS-READ-BACKLOG(§6.4)` marker, now naming the erasure slice as its
owner, and the historical rewrite does not start until that slice lands.

**Decision #219 (2026-08-18, G5 slice 3b: erasure becomes catalog-complete, and
a capture body gets its first lawful death):** #215 started writing every
pull-capture body TWICE — inline (the authority) and once into the
content-addressed catalog — and #217 made readers serve from the second copy.
The Stage 28.4 erasure module reached only the first one. Slice 3c stops writing
the inline body and rewrites the heap; the instant that lands, the catalog copy
is the ONLY copy, and an executed erasure would leave the erased fan's material
sitting in a table no governed act could touch. This slice lands the act FIRST,
so no window of silent under-erasure ever exists.

**The law is inherited, not invented.** Both earlier slices wrote it down before
there was code for it — migration 0123 ("a body may die only when the last
surviving envelope reference is gone") and `services/payload-reader.ts` ("a
shared body may not be rewritten under one envelope's subject"). The catalog
plane therefore takes the inline plane's verdicts instead of forming its own:

- A body whose EVERY envelope this erasure deleted has no surviving fact behind
  it. It dies with them — body row, location row and catalog row. THAT is the
  new sanctioned deleter, and it is the first thing in this system ever allowed
  to delete a captured body.
- A body a SURVIVING envelope still references is a BYSTANDER'S FACT: a shared
  observation the module deliberately kept, or a `sync_raw_payloads` row erasure
  has never touched. It is kept, counted and reported in the tombstone —
  identical treatment to `sharedObservationsKept`, which is the same residual
  risk seen from the other side.

**A SUBJECT-FILTERED REWRITE OF A SHARED BODY WAS CONSIDERED AND REJECTED**, on
two independent grounds. (1) It destroys a bystander's captured bytes — exactly
what the module's observation-exclusivity law forbids on the inline side, where
"deleting a shared batch capture would orphan bystanders' lineage" is why shared
survivors are reported rather than erased. (2) Every envelope that references a
body still carries that body INLINE today, and #217 keeps inline the authority
of record in every read mode; a filtered catalog copy would make the two
disagree — which is the precise condition the hourly parity verifier pages
about. A slice cannot ship a designed-in alarm. The consequence is stated
plainly rather than hidden: this slice makes the catalog EXACTLY as complete as
the inline plane, no more. Reaching a shared body's content would require
rewriting BOTH planes in place, i.e. mutating an immutable capture envelope —
its own decision, which the owner has not been asked for.

**Zero references is PROVED, in the same transaction, per batch.** The deletion
set comes from a `not exists` against both `observations` and
`sync_raw_payloads` in the statement that selects it, and the deletes run in FK
order behind it (bodies and location first — 0123's `ON DELETE RESTRICT` makes a
catalog row structurally unable to take its body with it by accident). Migration
0127 gives that probe the partial index 0124 explicitly deferred until "an index
is earned by a real query plan": unindexed, an existence check per candidate is
a sequential scan of the largest relation in the system, and an erasure that
does not finish is an erasure that did not happen.

**Same run, after the delete transaction, in bounded batches.** One erasure
decision covers both planes from the operator's view, but the sweep cannot be
inside the delete transaction: "no surviving reference" only means something
once those deletes are visible. Each batch is its own transaction holding the
G3 erasure fence's exclusive locks over every resolved page id. Resumability
falls out of the shape — every statement is set-based over that batch's
candidate list, so a crash leaves earlier batches committed and the rest
untouched, and a re-run rescans, recomputes and continues with no "already
deleted" case to handle. The residual is named rather than papered over: a
capture landing DURING the sweep can dedup onto a dying object (READ COMMITTED
has no predicate lock), and the worst outcome is a dangling reference — the
failure class #215 already accepts and the parity verifier already reports —
never a lost fact.

**One subject definition for both planes.** `capturePayloadErasureSubject` now
builds the literals for the inline `payload::text like` matcher AND for the
catalog scan, so the two planes cannot disagree about what "this body contains
the subject" means. The catalog scan returns METADATA ONLY — which objects match,
never their bytes — so it is barrel-safe for the same reason
`readEnvelopeCapturePayload` is and a bare `(bucket_month, object_id)` still
buys nothing. The fan-lineage collector gains a catalog arm that translates a
matched object back into the envelopes referencing it: a no-op today (the two
copies are identical by construction), and the ONLY arm that can find those rows
after 3c nulls the inline column. `exact_bytes` objects in scope FAIL THE RUN
LOUDLY rather than being skipped — no writer produces one yet, and the webhook
slice that will owes the scan its byte arm.

**The sha256 collision alarm is wired, and the hot path still owns nothing.**
Slice 0 left `settlePayloadObject`'s collision path with a TODO: a non-empty
candidate set with no matching body IS a collision inside one scope+month, and
nobody was paged. The hourly parity job now counts
`capture_payload_objects where collision_ordinal > 0` and pages under the
EXISTING `capture_payload_parity` kind with its own subKey,
`sha256_collision` — the shape #213 gave the `db_disk_usage` runway latches. Own
subKey means own lifecycle: a clean parity pass may NOT resolve a standing
collision, only a collision count back at zero may, and both resolve texts name
the condition that cleared so neither reads as a catalog-wide all-clear. The
check runs on EVERY pass, canary or not, because a collision is a durable row
and switching a flag off must not clear an integrity page. `settlePayloadObject`
gets no counter and no latch (#217, applied to the write path this time): it is
the hottest path in the system, and the evidence it already writes —
`collision_ordinal > 0`, forever, on the row itself — outlives any process
counter.

---

**Decision #220 (2026-08-18, G5 slice 3c-1: a captured body stops being written
twice):** slices 0–3b built the second, content-addressed copy of every pull
capture (#215), taught every reader that SERVES a body to fetch it from there
(#217), gave the queries that dig INSIDE a body their own typed columns (#218),
and taught the erasure to reach the catalog (#219). Every one of them left the
inline column exactly as it was, so the disk still grew at the old rate — the
whole project has so far only ADDED bytes. This slice is where the growth stops:
on a page in the new `capture_cas_pointer_only_pages` canary, a capture whose
catalog write ALREADY SUCCEEDED writes `observations.payload` /
`sync_raw_payloads.response_payload` as SQL NULL. The historical rewrite of rows
written before today is 3c-2 and rides separately.

**THE WORST CASE IS BOTH COPIES, NEVER NONE — and it is a construction, not a
check.** Pointer-only permission is minted in exactly one place: the success
return of `putCaptureCasPayloads`, where both catalog references already exist,
inside the transaction that proved the bodies are on disk. Every failure path in
that function returns the same `NO_REFS` value it always did, whose new
`pointerOnly` flag is false — so a codec refusal, a dead connection, a missing
partition, or a page outside the slice-1 canary all write the inline body
byte-identically to the pre-slice code. A page listed for pointer-only but NOT
for dual-write therefore behaves like a page listed nowhere: no catalog write, no
reference, no permission. Capture-first (DP 7) is not traded against anything
here; the only thing this slice can get wrong is writing a body twice.

**The database enforces the floor the writer promises.** Migration 0128 drops
NOT NULL from both body columns and adds, to each table, `CHECK (payload IS NOT
NULL OR payload_object_id IS NOT NULL)`. That constraint — not the flag, not the
seam — is the slice's core invariant: NO ROW MAY ADDRESS ZERO BODIES. Dropping
NOT NULL alone would have made "a capture with no body anywhere" representable,
which is the state DP 7 exists to forbid; what is being relaxed is not "a body is
required" but "the body is required IN THIS COLUMN". NOT VALID, and here the
vacuity is provable rather than assumed: every existing row was written under the
old NOT NULL, so the predicate holds for all of history, and PG16 still checks
every INSERT and UPDATE from the moment it is added. `payload_hash` stays NOT
NULL: it is computed by the producer from the payload OBJECT before the insert
(`services/sync/shared.ts`), never from the column, so a pointer-only row carries
the same digest it would have carried with its body inline. The slice-3a typed
columns are derived from that same object inside the same INSERT, before any
decision about storage — so a pointer-only row is identical to a dual-written one
in every column except the body.

**A NULL INLINE BODY IS REACHABLE IN EVERY READ MODE, `inline` INCLUDED, and
this is the load-bearing decision.** `capture_cas_read_mode` was designed to be
rolled back freely (#217: "every downward move is allowed unconditionally"). If
reachability depended on it, the first operator to reach for that escape hatch
would blank every pointer-only row in the system — the safety valve would be the
demolition charge. So the seam now resolves a null-inline row from the catalog
BEFORE it consults the mode at all: THE MODE GOVERNS BYTE-SOURCE PREFERENCE FOR A
ROW WITH TWO COPIES, NEVER REACHABILITY FOR A ROW WITH ONE. Three consequences
follow and each is pinned by a test:

1. **For a pointer-only row the CATALOG is the authority of record.** #217's
   "the inline columns remain the authority in every mode" was a statement about
   rows that have an inline column; it stands unchanged for them. A row with one
   copy has its authority where that copy is.
2. **`shadow` SKIPS such rows** (`shadowSkippedNullInline`) instead of scoring
   them `shadowMatched`, and the hourly verifier does the same with its own
   `skippedNullInline` count. A comparison with one operand is not a verdict,
   and least of all "matched" — the same asymmetry that already keeps "nothing
   measured" from reading as "measured and clean". As a page ramps, its parity
   `checked` therefore falls toward zero BY CONSTRUCTION, and the latch neither
   opens nor resolves off a sample of zero. The proof that a catalog body is
   faithful is spent BEFORE the inline copy goes away — the slice-2 shadow window
   and this job's own history over that page — which is exactly why the flag is
   gated behind them.
3. **The forced reads are counted apart** (`servedNullInline`) from the
   preference-driven ones (`served`): only the latter disappear if the mode is
   rolled back, and one number for both would make a rollback look like it had
   freed the system from the catalog when it had not. The one genuinely bad
   outcome — a null-inline row whose catalog copy cannot be read — returns null,
   counts `nullInlineUnresolved`, and LOGS every time, unlike a silent `serve`
   fallback: "a captured body is currently unreachable" is a different sentence
   from "the fast path was unavailable". It still owns no latch (#217).

**ROLLBACK IS NOT SYMMETRIC, and the registry says so in those words.** Turning
`capture_cas_pointer_only_pages` off resumes double-writing for NEW captures
only; every row already written pointer-only keeps its body ONLY in the catalog,
forever. That is the first irreversible flag in this project, and it is why the
two irreversibility-adjacent slices landed first: erasure had to reach the
catalog (#219) before a catalog body could be the only one, and the null-inline
read law above had to exist before a read-mode rollback could be safe. It is also
why this is a SECOND setting rather than a fourth mode of the read seam or a
second value of the dual-write canary: two acts with different reversibility get
two switches, and a page must be listed in both.

**What was NOT done here.** No backfill and no historical rewrite (3c-2 owns the
~35 GB already on disk, and the slice-3a fallback arms stay until it has run); no
webhook envelopes (`ofapi_webhook_events` still needs its `exact_bytes` seam); no
removal of the inline fallback arms; no validation of the new CHECK; no
write-time assertion that the pointer-only list is a subset of the dual-write
list — the subordination is structural (no reference, no permission), and a
string-comparison gate at flip time would be a weaker restatement of a property
the code cannot violate, while adding a way to reject a legitimate flip ordering.

---

**Decision #221 (2026-08-18, G5 slice 3c-2: the heap that is already on disk is
rewritten once, under an owner's hand):** slices 0–3c-1 built the second copy
(#215), moved the readers to it (#217), gave the field queries typed columns
(#218), taught the erasure to reach it (#219) and stopped writing the inline
body for NEW captures on a canary page (#220). Every one of them left the ~35 GB
already on disk exactly as it was: each of those rows still carries its body
inline and NO reference at all, which means the catalog cannot see them, the
erasure's catalog arm cannot find them, and nothing about them will ever get
smaller on its own. This slice is the machinery that walks them — and it is
MACHINERY ONLY: nothing destructive runs without an owner typing an exact
relation name.

**FOUR CLI COMMANDS, NO SCHEDULE, NO CONFIG FLAG.** `capture:backfill`,
`capture:verify-backfill`, `capture:reclaim` and `capture:drop-parked` take the
erasure's governance, because they are the erasure's kind of act: one-time,
owner-initiated, dry-run by default, tombstoned. A schedule was never
considered — this walks tens of GB on the box whose free space is the reason G5
exists, and the one thing worse than not running it is running it at 04:00 with
nobody watching. A config flag was rejected for the same reason it was rejected
for `tiering:run`: a flag makes an act repeatable by accident, and these are not
acts that should ever happen twice unnoticed. Migration 0129 adds
`capture_rewrite_runs` — the `erasure_log` shape, and it is a TABLE rather than
a log line because two of the four commands must READ what an earlier one
concluded, hours later, from another process. `ops_metric_samples` was rejected
for it: an irregular operator-paced series inside a fixed-shape gauge store
either trips the golden-signals deadman or teaches everyone to ignore it (#212
already carved `disk_*` out for exactly this).

**THE ONE LAWFUL UPDATE IN THIS PROJECT, AND WHY IT IS LAWFUL ONLY HERE.** #215
rejected a post-commit UPDATE of the reference columns and #218 rejected an
UPDATE backfill of the typed columns, both on the same ground: an UPDATE mints a
second heap tuple plus its WAL, per row, on the two largest tables in the
system, and paying for a fresh row version per capture in order to record a
DEDUPLICATION is self-defeating. That argument is about the STEADY STATE and it
does not reach a one-time pass whose entire purpose is to be followed by a
physical rewrite: here the bloat the UPDATE creates is not a cost that
accumulates, it is CONSUMED — `capture:reclaim` copies the surviving tuples into
a skinny relation and parks the old one, so the dead versions this pass leaves
behind are precisely the pages that get dropped. The two alternatives are both
worse: rewriting each row twice (once to stamp, once to compact), or a side
table holding the stamps until the compaction reads them, which is a second copy
of the reference for no benefit. Two consequences are accepted out loud rather
than hidden: between the backfill and the reclaim the scope is BIGGER on disk
(which is why §9.1's headroom precondition is a law, not a warning), and a month
backfilled but never reclaimed carries permanent bloat — so the runbook treats
backfill → verify → reclaim as ONE ritual per month, not three chores.

**A HISTORICAL BODY IS FILED UNDER ITS OWN CAPTURE MONTH, NEVER TODAY'S.** The
object's `captureInstant` is the row's own `observations.received_at` /
`sync_raw_payloads.captured_at`. Using `now()` would pile all of history into
the current month and destroy the property migration 0123 calls a law — a closed
capture month is a ref-closed, self-contained cohort, which is what makes every
future cold segment self-contained. The consequence is that the backfill
addresses months 0123 never created (production data starts 2026-07; 0123 starts
2026-08), so `ensureCapturePayloadCatalogPartitions` creates the four catalog
partitions for a month on first use, lazily, from the batch's own instants —
shaped like `ensureObservationPartitions`, idempotent, and stopping below the
2031 catch-all. The second consequence is priced and kept: a raw envelope and its
paired observation whose two timestamps straddle a UTC month boundary by
milliseconds get two objects instead of one. That is a handful of rows across
the corpus and the honest cost of using each row's own truth rather than
inventing a shared instant for facts captured a year ago.

**THE LANE IS `platform_capture` FOR EVERY HISTORICAL ROW, AND IT IS NOT DERIVED
FROM `source`.** The tempting version reads `observations.source` and maps
`operator` to the `operator_action` lane — which carries the `system` erasure
domain, and #219 never gives `system` to a subject sweep. A one-way pass over
history that narrows what a future erasure can reach is not a trade this slice is
allowed to make, so every body it writes gets the same lane the live dual write
assigns. That also means a historical body and its live twin land in ONE object
instead of two, which is the deduplication working across the cutover.

**VERIFY PROVES; IT DOES NOT INFER.** Three checks, and any one refuses the
scope. (1) EVERY ROW HAS A REFERENCE, except rows the frozen codec refuses — and
those are NOT taken from the backfill's recorded count. That count is an
inference over two numbers produced hours apart by different processes, and it
would pass just as happily if the backfill had crashed mid-scope and left
unreached rows behind; so each remaining null-ref row is RE-CANONICALIZED here
and must actually refuse, with the stored count printed beside the proved number
as a cross-check and never as the authority. The walk is bounded — above 10k
remaining rows the answer is "run the backfill first", which is what a remainder
that size means. (2) EVERY REFERENCE RESOLVES — a TOTAL anti-join against the
catalog's primary key, not a sample, because this is the check the
deliberately-absent foreign key (#215) does not make and one dangling reference
plus a reclaimed body is one captured fact gone. (3) THE BODIES AGREE — full
canonical octets (never digests alone, the #215 rule) on a bounded random sample,
because comparing every body in a monthly partition means detoasting the whole
partition and the failure this catches is systematic. The sample is drawn by
random index probes inside the scope's id range rather than `order by random()`
— a full scan plus a sort is the one thing a verification step on a disk-starved
box must not do — and the resulting slight over-representation of rows after long
id gaps is stated in the code rather than hidden. `capture:verify-backfill` has
NO `--dry-run`, deliberately: it writes nothing to capture data and the single
row it does write is its verdict, which IS its product, so a "dry" verify could
only ever be a way to run the useless half.

**THE OBSERVATIONS RECLAIM IS §9.1 VERBATIM, IN TWO SEPARATELY INVOCABLE
PHASES.** `--phase shadow` builds `observations_YYYY_MM__skinny` beside the live
partition and copies every row into it WITHOUT the inline body wherever a
reference exists — and WITH it where the codec refused, because for those rows
the inline column is the only copy there is and 0128's CHECK is what says so. It
takes no lock on the live table, runs for hours, and resumes from the highest id
already copied. It adds the partition-bound CHECK there rather than at the swap,
so `ATTACH PARTITION` skips its validation scan — otherwise the swap would hold
ACCESS EXCLUSIVE for a full heap scan, which is exactly the lock the operation is
shaped to keep short — and it reconciles the index set against the SOURCE
PARTITION's real `pg_indexes`, because `LIKE observations INCLUDING ALL` brings
only the parent's declared indexes and 0096's and 0126's partial expression
indexes are created `ON ONLY observations` and attached per leaf. `--phase swap`
is ONE transaction under `lock_timeout`: detach, rename the original away,
move it to the parking schema, rename the twin into the partition's name, attach.
THE SINGLE TRANSACTION IS THE CRASH-SAFETY PROOF — a process killed at any
instant leaves the OLD partition attached, and there is no state in which the
parent has no partition for that month. Every statement inside is catalog-only,
so `lock_timeout` bounds the WAIT and not the work; failing to get the lock
aborts with nothing changed, which is the correct outcome. The twin TAKES THE
PARTITION'S NAME because `observations_2026_07` must keep meaning "July's rows"
to the tiering regex, the replay guards and the erasure's parked scan.

**THE PARKED COPY GETS A NEW SCHEMA, NOT STAGE 28's.** `tiered_pending_drop`
means one specific thing to three call sites — the erasure sweeps it as extra
delete targets, and both `fansly-replay-projection.ts` and `message-archive.ts`
REFUSE to replay a month they find parked there. A partition parked by THIS
slice means the opposite: its rows are live, in a twin attached under the same
name. Parking it there would make those guards refuse a month that is perfectly
available — a false refusal in the code path that exists to prevent silent data
loss. So superseded copies go to `capture_pending_drop`, under a name
(`<partition>__pre_g5_<ts>`) that cannot collide with the name the twin took. The
erasure is then taught about the new schema EXPLICITLY (its parked scan now reads
both, and returns fully qualified references so no caller can re-derive the wrong
one) rather than inheriting a meaning that is wrong for these tables: without
that, a swap would open a window — between the swap and the owner-gated drop — in
which an executed erasure quietly under-erased.

**`sync_raw_payloads` TAKES §9.2's OTHER OPTION, AND THE REASONS ARE
STRUCTURAL.** §9.2 prefers the shadow swap "при достаточном временном headroom".
This slice ships the maintenance rewrite instead, on three independent grounds.
(1) TWO INBOUND FOREIGN KEYS: `transaction_tip_contexts` references
`sync_raw_payloads(id)` twice (0122), and a rename swap must drop and re-create
both — re-creating a foreign key VALIDATES it, a full scan of the referencing
table inside the swap transaction, holding ACCESS EXCLUSIVE on that table too.
The SHORT stop §9.2 wanted from the swap is exactly what this version does not
have, and it has it least when the tip-context projection has grown. (2) THE
OWNED SEQUENCE MOVES WITH THE TABLE: `id` is `bigserial`, so
`sync_raw_payloads_id_seq` is OWNED BY that column and `ALTER TABLE … SET
SCHEMA` carries it along, while the shadow's copied default still says
`nextval('sync_raw_payloads_id_seq')` — unqualified, resolved through
`search_path`, which no longer finds it. The first capture after the swap fails:
a DP 7 violation caused by a storage optimisation, the one outcome this project
may not produce. (3) UNPARTITIONED MEANS NO UNIT SMALLER THAN EVERYTHING, so
§9.1's headroom law would refuse the swap on the production box for the reason
the swap exists. So the table gets two phases: `null-bodies` (batched, resumable,
guarded by 0128's CHECK, which makes PostgreSQL itself reject any row this would
leave with no body anywhere) and `vacuum-full`. THE COST IS STATED PLAINLY RATHER
THAN DISCOVERED: there is no parked copy and therefore NO GRACE WINDOW for this
table — once the bodies are nulled the catalog is their only home, which is the
state #220 already sanctions for new captures, reached deliberately and only over
rows a fresh verify has blessed. Both phases refuse while any runtime instance is
heartbeating or any other client backend is non-idle: the G4 phase-2 ritual
(`docker compose stop worker scheduler`), enforced instead of documented.

**THE DROP IS A DIFFERENT COMMAND AND THE ONLY DESTROYER.** `capture:reclaim`
never drops anything; `capture:drop-parked` destroys ONE relation and can reach
nothing outside `capture_pending_drop` — the schema half of the statement is a
module constant no caller can influence, and the relation half is resolved out of
that schema's own catalog listing before the drop, so a name in `public` cannot
be reached by any spelling. Four gates: resolvable inside the parking schema,
`--confirm` equal to the exact relation name, an elapsed grace window (24h by
default, because a parked partition IS the rollback for its swap and a rollback's
value is entirely in how long it stays available), and `--execute`. THE RETENTION
PIN IS EXTENDED WITH A STATEMENT-LEVEL LICENCE, not a file entry: a `DROP TABLE`
is invisible to `tests/retention-deleters.test.ts`'s `delete from` grep, which is
precisely why it needed its own pin — the test now asserts there is exactly one
`drop table` in the file, that its schema is the constant, that the parking
schema is written to in exactly one place, that the resolve-then-confirm sequence
is present, and that the erasure sweeps the new schema. The licence itself is
narrow and true: what lives in that schema is by construction a partition a
transactional swap SUPERSEDED, every row of which is also in the attached twin —
so the fact is not being deleted, a duplicate of its physical residue is.

**SAFETY RAILS THAT REFUSE RATHER THAN WARN.** The CURRENT UTC month is refused
(a snapshot copy would silently drop every row captured between the copy and the
swap, and waiting a month costs nothing while losing a day of capture costs
everything); so is a future month, and a partition that is detached or parked. A
verify verdict older than 24h is refused, and so is one a later backfill has
overtaken — freshness is not wall-clock alone, because a backfill that finished
AFTER the verify describes a scope that has since changed. An erasure that has
not converged (`erasure_log.completed_at IS NULL` on an executed run) or a held
fence lock refuses every phase: a shadow built across an erasure's commit would
carry erased rows into the relation that replaces the original, which is
resurrection arriving through a door the G3 fence does not watch. A refusal from
any of these ends the run BEFORE the phase body reads anything — "refused" means
nothing was touched and nothing was even looked at. Every command is bounded and
paced (`--batch`, `--pause-ms`) because this pass spikes WAL and autovacuum on a
box chosen for this project because its disk is nearly full, and every command
defaults to a dry run that prints exact counts. `--assume-free-bytes` is a
declared drill seam for the headroom law — the precondition most likely to refuse
a real run, and an owner staring at one needs to ask "how much would I have to
free" without waiting for a cleanup — and it is journaled in the tombstone
whenever used, so a run that skipped the real measurement says so forever.

**WHAT WAS NOT DONE.** No `ofapi_webhook_events` (those envelopes still need the
`exact_bytes` seam). No removal of the slice-3a `CAS-INLINE-FALLBACK:` arms —
they may go only once every production month has been through this ritual, which
is a later decision with its own evidence. No validation of 0124's or 0128's
NOT VALID constraints. No index on the backfill's scan predicate: it would have
to be built CONCURRENTLY across every partition of the largest table in the
system, to serve a walk that runs ONCE and would then have to be justified
forever after — the rule 0124 applied to the reference columns, applied to their
inverse. And no automatic progression from one phase to the next: the gap
between two phases is measured in hours and the world moves in it, so every
phase re-checks its preconditions from the database rather than trusting that a
previous command succeeded.

**Decision #222 (2026-08-19, G5 review fix: a stamped reference outliving its
object is a lost fact, and the two acts are now ordered):** an external
adversarial review of the G5 line found two concurrency defects on one axis —
erasure racing another writer. Both are fixed here, together, because they are
the same mistake made twice: a proof taken at one instant and acted on at
another.

**FINDING 1, and why #219 was right until it wasn't.** The catalog sweep's
deleter carried an explicit, honest note: a capture landing DURING the sweep can
dedup onto an object the batch is deleting, PostgreSQL has no predicate lock at
READ COMMITTED, and "the worst outcome is a dangling reference the parity
verifier reports, never a lost captured fact". That sentence was true when it
was written, and its truth rested entirely on a premise from #215 — every
envelope that carries a reference ALSO carries the body inline. #220 removed
that premise for a page in `capture_cas_pointer_only_pages` and did not revisit
the acceptance. The interleaving that used to be cosmetic became fact loss:

1. an erasure deletes envelopes and some object reaches zero references;
2. a concurrent capture on the same page dedups onto it — `putPayloadObject`
   reads the existing row and returns its reference, and on that path the CAS
   transaction WRITES NOTHING AT ALL — then commits and pauses;
3. the sweep proves zero committed references (correctly, at that instant) and
   deletes body, location and catalog row;
4. the capture inserts its envelopes: `payload` NULL, `payload_object_id` set to
   the object that no longer exists.

Nothing downstream catches step 4. 0128's CHECK is satisfied (a reference IS
present), there is no foreign key by #215's deliberate choice, and the parity
verifier skips null-inline rows by #220's deliberate choice. The captured fact
is simply unreadable, silently, forever.

**THE FIX IS AN ORDER BETWEEN TWO ACTS, NOT A SMALLER WINDOW.** Two statements
make it:

- `deleteUnreferencedCapturePayloadObjects` takes `FOR UPDATE` on its candidate
  rows in a statement of its OWN, sorted by the catalog's primary key, BEFORE
  the `not exists` verdict — and the two must stay two statements in that order,
  because as one statement the verdict would be computed from the snapshot the
  statement began with, i.e. from before the lock wait, which is the stale proof
  this fix exists to remove.
- `insertObservation` and `insertRawPayload` call `lockCapturePayloadRefAlive`
  — `SELECT … FOR KEY SHARE` on the addressed object — inside the SAME
  transaction as the insert that stamps the reference, so the lock is still held
  at the instant the row becomes visible.

The two lock modes conflict, so exactly one of two things can happen. The writer
got there first: the sweep WAITS for its commit, and the verdict statement,
which under READ COMMITTED takes a fresh snapshot after that wait, SEES the new
envelope and keeps the body. Or the sweep got there first: the writer's probe
returns zero rows, the reference is DROPPED, and the envelope is written with
its INLINE body — the pre-G5 shape of a capture, always legal and always
readable. There is no third outcome and no window between them.

**REJECTED ALTERNATIVES, and the reasons are not stylistic.** A SECOND
CONFIRMATION PASS separated by a delay narrows a race; this one is closed, and a
delay could not be sized honestly anyway (any bound is a guess about GC pauses
and scheduler latency) while doubling how long a break-glass act holds the
erasure fence. A DURABLE CLAIM ROW written inside the CAS transaction and read
by the sweep's `not exists` adds a write and a row to the hottest write path in
the system in the common case where nothing is racing, plus a TTL cleanup that
is itself a new deleter and could delete a live claim. A FOREIGN KEY would close
it — it is the textbook mechanism — and every word of #215's rejection of one
still holds: an FK taxes the hot write path with index maintenance, locks the
catalog's future partition maintenance, and would have to validate all of
history. Which is precisely the argument FOR what shipped: `FOR KEY SHARE` is
the one lock an FK would have taken, taken by hand, at the one moment it is
needed — no DDL, no index (the catalog's own primary key serves the probe), no
history to validate, and paid only by a capture that carries a reference at all.

**IT APPLIES UNIFORMLY, pointer-only and dual-write alike.** A dangling
reference on a dual-written row is not a lost fact — the inline body is there —
but it is still a lie, and it is the one the verifier reports as
`object_missing`. Closing it in one place beats teaching the writers which
envelopes are allowed to lie. `lockCapturePayloadRefAlive` stays OFF the package
barrel (pinned in `tests/capture-payload-barrel.test.ts`) because it is a LOCK,
not a read: a runtime caller holding it for the length of some other transaction
would fence the erasure for no reason, and one calling it and then inserting
separately would believe a proof it does not have.

**A STANDING DANGLING-REFERENCE CENSUS, with its own latch.** The hourly parity
job now counts references whose catalog row is absent, over both envelope
tables, and pages under the existing `capture_payload_parity` kind with its own
`dangling_reference` subKey — the shape #213 gave the disk-runway latches and
#219 gave the collision census. It runs on EVERY pass, canary on or off, for the
collision census's reason and a stronger one: rolling a flag back does not
re-attach a body to a reference that points at nothing, and `inline` mode plus a
canary rollback is exactly the configuration an operator reaches for when they
are worried. It is BOUNDED to the head of each table (a total anti-join over
`observations` is minutes, not an hourly cost) and the window travels in the log
line and the incident text, so a zero is never read as "zero anywhere in
history" — the total sweep over history is `capture:verify-backfill`'s job and it
already does one per scope. The capture seam counts `refVanished` and owns no
alarm of its own (#217): the repositories decide, because they hold the lock;
the scheduled job pages, because an alarm needs an owner that runs on a known
schedule.

**FINDING 2 — the swap read a world that was still moving.**
`capture:reclaim --phase swap` checked the erasure preconditions once, at
precondition time, and read the source/shadow row counts OUTSIDE the swap
transaction. An erasure that executed in the gap — including while the swap sat
waiting for its locks — would leave the swap parking a POST-erasure source and
attaching a PRE-erasure shadow, bringing back every row that erasure deleted.
That is resurrection, arriving through the one door the G3 fence does not watch,
committed by the act that was supposed to be the safe one. The transaction now
takes its locks EXPLICITLY AND FIRST — `LOCK TABLE ONLY observations`, then the
source partition, then the shadow, in the order the DDL would take them anyway,
with `ONLY` so the stop does not extend to every other month — and then re-proves
everything: erasure quiet, both relations still in the attachment state the
plan assumed, and the two row counts equal.

**THE RECOUNT AND THE ERASURE PROBE DO NOT SUBSUME EACH OTHER**, which is why
both are there. An erasure that COMMITTED its deletes shows up as a count
mismatch and cannot hide: nothing writes into a closed month, so the counts
cannot drift back into agreement. An erasure that has NOT committed them is
invisible to any count — MVCC hides it — and only the mid-flight `erasure_log`
tombstone and the held fence lock can see it. A `statement_timeout` bounds the
recount, because it is the only statement in that transaction that reads data
and it runs under ACCESS EXCLUSIVE: a pathological count aborts the swap rather
than freezing capture. A re-verification that says no is a REFUSAL, not a crash —
the transaction rolls back, the run settles as `refused`, and the message names
the remedy (drop the shadow and rebuild it; re-running the shadow phase only
ADDS rows and would never remove the ones the erasure deleted).

**THE RETENTION PIN IS EXTENDED DELIBERATELY.** The fix added a statement to
`packages/db/src/repositories/capture-payload-erasure.ts`, the file that carries
the statement-level licence for the one deleter of a captured body, so
`tests/retention-deleters.test.ts` now pins the lock statement AND its position
— before the verdict, which is before the deletes. Delete that statement, or
fold it into the verdict query, and this file goes back to being able to destroy
the only copy of a captured body while an envelope is being written to point at
it, with every other assertion in the file still passing. That is exactly the
class of regression a statement-level licence exists to catch.

**AMENDMENT TO #219 (family law: updated-in-change).** #219's stated residual —
"a capture landing DURING the sweep … the outcome is a dangling reference …
never a lost captured fact" — was true when it was written and became false when
#220 shipped. It is superseded by this entry. The acceptance is withdrawn: the
race is closed rather than tolerated, and the note in the code that carried the
old reasoning now carries the new one. Nothing else in #219 changes — the
inheritance of the module's verdicts, the bystander law, the refusal to rewrite
a shared body, and the collision subKey all stand.

**WHAT WAS NOT DONE.** No foreign key (see above). No migration: nothing about
this fix is a schema change, and the catalog's primary key already indexes every
probe it adds. No total dangling-reference sweep on the hourly schedule, for the
cost reason stated above — the bounded window is declared rather than implied.
No change to the erasure's ordering (the catalog sweep still runs after the
delete transaction commits, because "no surviving reference" only means
something once those deletes are visible). And no attempt to make the capture
seam retry into the catalog when its object vanished: writing the inline body is
simpler, provably correct, and lands in the state #220 already sanctions — the
worst case is both copies, never none.

---

**Decision #223 (2026-08-19, G5 review fix: the reclaim's four missing gates —
a typed column nobody could fill, an unreadable body that read as an empty one,
a headroom law behind the growth it governs, and a ritual its own gate
refused):** a second external adversarial review of the G5 line, run against
the state #222 left, found four defects. They are fixed together because they
are the same mistake in four places: an act performed in the wrong ORDER
relative to the thing that was supposed to gate it. All four gate the
destructive historical reclaim, which is why none of them could be deferred to
a backlog.

**FINDING 1 — THE COHORT WITH NO POPULATION PATH, and it is the one that
destroys a fact rather than losing one.**

The slices shipped in this order: #215 (slice 1) started dual-writing the
catalog reference; #218 (slice 3a) added the narrow typed columns three
deployments later, and put their ONLY population inside the reference-stamping
statement. Every row captured between those two deployments therefore carries a
reference AND null typed columns — and `listCaptureBackfillCandidates` excludes
it by construction, because its predicate is `payload_object_id is null` and
those rows have one. There was no path in the system that could fill them.

That was harmless while the inline body was there, because every typed column
has a `CAS-INLINE-FALLBACK:` arm reading the body directly. `capture:reclaim
--phase null-bodies` is the act that takes the body away, and it nulls
`response_payload` for EVERY referenced row, not only the ones whose typed
columns are filled. What the Fansly tip-context reader then evaluates is:

    coalesce(rp.response_tips,
             case when jsonb_typeof(rp.response_payload) = 'object'
                  then jsonb_build_object('tips', rp.response_payload -> 'tips')
                  else rp.response_payload end)

With `response_tips` null and `response_payload` null, `jsonb_typeof` yields
NULL, the CASE takes its ELSE arm, and the whole expression is the nulled
column. The sidecar parser reads that as `envelopeStatus: "invalid"`. So the
replay does not record "no tip context for this message" — it records that the
message's tip envelope was MALFORMED, for a message whose envelope was
perfectly good and is still sitting in the catalog. A wrong fact is worse than
a missing one, and this one would have been written into the projection by the
very act that was supposed to be lossless.

THE FIX IS A SECOND SCAN, NOT A FLAG. `capture:backfill` now runs a
typed-column catch-up after its reference walk reports `scope_complete`, at the
same `--batch` and `--pause-ms` (the same UPDATE cost on the same tables;
running both at once would double the WAL rate an operator chose those numbers
for). Its predicate is deliberately narrow and deliberately a MIRROR of the
derivation: almost every row in the corpus derives to all-NULL — these columns
serve the harvest lane and Fansly DM tips and nothing else — so "a typed column
is null" would match everything and never converge. What it matches instead is
"the derivation gate passes AND the body holds a value the derivation would
return", with `jsonb_typeof(x) in ('string','number','boolean')` mirroring
`jsonMemberText` for the harvest members and `jsonb_typeof(body) = 'object'`
mirroring `deriveRawPayloadTipsSlice` exactly. A filled row stops matching, so
the pass is resumable with no cursor exactly as the first one is.

AND A GATE, WHICH PROVES RATHER THAN COUNTS. `capture:reclaim` refuses `shadow`
(observations copy rows WITHOUT their bodies) and `null-bodies` while any row in
scope would still be filled. The count rides the census's EXISTING single scan
rather than adding a second pass over the largest table in the system. But the
count alone may not refuse, because the SQL mirror can be wrong in one
direction: `jsonb_typeof` says `number` for a literal like `1e999`, which
`JSON.parse` returns as `Infinity` and `jsonMemberText` renders as NULL. Such a
row would match the census filter forever, the catch-up would fill nothing, and
the reclaim would be permanently refused over a value nobody can do anything
about. So the count is the cheap SCREEN and a bounded walk that re-derives each
candidate in the same TypeScript the capture path runs is the VERDICT — the
same shape, and the same sentence, as `capture:verify-backfill` proving each
remaining null-ref row is really a codec refusal. Above the rescan bound it
stops trying and says "run the backfill", again exactly as verify does.

NOT GATED on `swap` and `vacuum-full`, deliberately: those act on a relation a
gated phase already prepared, and by the time they run the bodies are either
already gone (which is `vacuum-full`'s precondition) or in a copy this gate
cannot see. A gate there would read as a second line of defence and be neither.

**FINDING 2 — A TRANSIENT CATALOG FAILURE THAT BECAME A PERMANENT PARSED
FACT.**

#220 let an envelope have no inline body. #217's read seam, written before that
was possible, answered a failed catalog read by returning the inline value it
was holding — which for such a row is `null`. `null` is also this seam's word
for "this envelope captured no body". Handing the same answer to two opposite
questions is the whole defect, and every consumer downstream took the wrong one:

* the canonicalize driver: four of the six families have no `canParse` shape
  gate, so a null payload canonicalizes to zero events and control falls
  straight through to `markObservationParsed`. The observation is stamped
  consumed and vanishes from every future replay — the failure the parse_version
  contract's own comment describes as "as surely as a DROP would";
* `observations-rejournal`: it hashes what it reads and inserts under
  `rejournal:a22:<rawId>`, a DETERMINISTIC key. A null payload becomes a
  permanent observation with `payload_hash = sha256("null")`, counted as a
  successful repair, and every later run finds the key and reports
  `alreadyRejournaled`. The campaign blocks its own correction forever;
* the OFAPI capture materializer and the DM readthrough sweep: each stamps its
  own version on a body it decided was structurally unusable;
* the expired-interactive-response recovery: terminalizes the request as
  `response_delivery_interrupted`;
* the agent read plane: reports the body WITHHELD for its `restricted_class` —
  a policy decision the kernel never made about a body it merely failed to
  fetch.

THE SEAM NOW RAISES, and the shape was chosen against the failure it is fixing.
A discriminated result or a sentinel has to be CHECKED, and the finding is
precisely that nobody checked; an exception is the only shape whose DEFAULT
behaviour at an unaudited call site is loud — the batch fails, the job retries,
the row stays unstamped. `CapturePayloadUnavailableError` is raised for exactly
one condition: a row with NO inline body whose catalog copy could not be read.
The seam's older and larger promise is untouched and pinned by its own case: a
row that carries an inline body still never throws, in any mode, however broken
the catalog — that fall-open guarantee is what makes `capture_cas_read_mode`
safe to roll forward and back.

ALL TWELVE MIGRATED READ SITES WERE AUDITED, one at a time, against one law: an
unavailable body must never be recorded as an empty, parsed or absent fact. Each
is now propagate (the site's own per-row catch already leaves the row for the
next pass), catch-and-count (it would otherwise settle something durable), or an
explicit error (the API path). The result is written into the seam's header as
the call-site registry #217 never left behind — eleven of the twelve sites had
never been named in any document, which is how a per-site review was skipped for
a whole slice.

THE DRIVER COUNTS IT SEPARATELY, and that is not bookkeeping. `skippedUnparseable`
means PERMANENT — a body no parser understands, waiting for code. `skippedUnavailable`
means TRANSIENT — a body that is almost certainly intact and momentarily out of
reach, waiting for nothing. Folding them together would let a degraded catalog
masquerade as a corpus of unknown payloads, and the number that would grow is
exactly the one an operator reads as "we need to write a new parser".

TWO PRE-EXISTING BUGS FELL OUT OF THE AUDIT and are fixed in the same change,
because both are instances of the same law. `recoverExpiredOfapiInteractive-
Responses` passed the UNRESOLVED observation to `materializeOfapiCapture-
Observation` while its sibling branch read through the seam — and that function
STAMPS `parse_version` when it cannot build a page, so a pointer-only row was
being consumed without its body ever being read. And `revokeOfapiMessage-
Coverage`'s idempotency proof, on an unreadable prior body, fell through to
"this action belongs to another proof" and answered HTTP 409: an existence claim
about somebody else's data, manufactured out of a failed fetch. It now raises
its own error, mapped to 503 — "ask again in a minute", which is what is true.

**FINDING 3 — THE HEADROOM LAW RAN BEHIND THE GROWTH IT GOVERNS.**

`capture:backfill` writes a full catalog copy of every body it walks plus a
second heap tuple per stamped row, on the two largest tables in the system, and
it had NO admission check of any kind. The observation headroom law was first
evaluated at `--phase shadow` and the raw one only AFTER `--phase null-bodies` —
that is, after the UPDATEs whose only effect on the volume is to make the
relation bigger. A run admitted in that order can fill the disk before anything
is in a position to refuse it, and the refusal it eventually meets is the
reclaim declining to clean up the mess.

The backfill now has a §9.1-shaped pre-flight: the heap+TOAST share of the rows
still to copy (worst case, no dedup), the same again for WAL (`wal_level =
replica` in production, so the inserts are fully logged — the same sentence
`reclaimHeadroomVerdict` already makes), and a 5 GiB floor it will not touch.
The floor is a separate term on purpose: §9.1 says what an OPERATION needs and
says nothing about what the rest of the box needs while that operation runs, and
on a VPS where Postgres, its WAL, the images and the logs share one volume those
are different sentences. It is NOT config, for the reason db-disk-alert.ts gives
about its runway thresholds — a tunable containment threshold is one somebody
turns off the night it would have fired.

Mid-run, every 10 batches, the walk re-asks ONLY the floor. Re-deriving the full
inequality would be arithmetic theatre (the estimate is the same estimate and
the remaining share is exactly what the walk has been consuming); what genuinely
has to stay true is that the volume has not reached the line, and if it has, the
honest response is to stop where it stands — the walk is resumable with no
cursor, so stopping costs only the time already spent. The `sync_raw_payloads`
headroom check moves to BEFORE `null-bodies`, where an operator learns the
answer while the table is still exactly as it was.

`--assume-free-bytes` WAS A DRILL THAT COULD ANSWER FOR THE REAL GATE. It was
journaled in the tombstone, so a bypass was recorded — afterwards, which is not
what a gate is for. The CLI now rejects it together with `--execute`, before the
app context is even built, because the combination is not a bad run but a
category error: the flag exists so an owner staring at a refusal can ask "how
much would I have to free up", and letting that answer stand in for the one
measurement between a nearly-full volume and a `VACUUM FULL` is the opposite of
its purpose. The option survives on the service interface (a test must be able
to drive the phase bodies to both verdicts, and a dry run asking "what if" is
what it was built for); what changed is that no EXECUTING invocation can reach
it. The backfill's own gate takes an injectable reader instead of a flag — a
test seam that is not also a production surface.

ONE READER, NOT TWO. The rewrite had its own private `statfs("/")` beside the
hourly gauge's, with a comment claiming they agreed. Both now call
`readDiskFreeBytes` in services/db-disk-alert.ts, so the day the gauge learns
about a second volume or a reserved-blocks correction, the headroom law learns
it in the same commit instead of quietly admitting runs the alarm would refuse.

**FINDING 4 — THE DOCUMENTED RITUAL COULD NOT PASS ITS OWN GATE, and the fix is
the opposite of the one that was expected.**

`checkWritersStopped` refuses on ANY heartbeating `runtime_instances` row. The
runbook's R2 said `docker compose stop worker scheduler`. The api never stops,
so it keeps heartbeating, so both raw phases refuse indefinitely: the ritual as
written could never run. The review's proposed fix was to narrow the check to
the roles that can actually write capture.

THE AUDIT FOUND THE PREMISE FALSE. The api is a capture writer, on more paths
than any other role:

* `observations` — `services/auth.ts recordAudit` journals one on EVERY audited
  admin mutation (roughly two dozen routes); `POST /api/v1/ingest/observations`
  is the desktop's and the extension's own capture lane; the OFAPI webhook
  receiver and the OFAPI read gateway each write their own, synchronously,
  inside the request;
* `sync_raw_payloads` — `POST /api/v1/admin/pages/:pageLabel/verify` calls
  `refreshPageMetadata`, which fetches from Fansly and journals the response
  through `persistRawPayload`. It is the one capture-lane PULL outside the
  worker, and it lands in the exact table these phases rewrite.

So the check is left maximally broad and the RUNBOOK is what was wrong. Two
reasons, and the second is the stronger one: an allowlist of writer roles would
go STALE SILENTLY — a role that gains a capture write does not come back to
update it — and the failure mode of a stale allowlist is a `VACUUM FULL` running
under a live writer, which is the single thing this check exists to prevent. The
alternative of gating the specific api paths during maintenance was rejected as
well: it would need a maintenance-mode flag, i.e. new always-on config surface
whose only correct value is the one it has every other day of the year.

R2 now stops `api`, `worker` and `scheduler`, with the production compose-file
selector the runbook was missing (`--env-file .env.production -f
docker-compose.production.yml` — without it the command runs against the local
`docker-compose.yml` and silently does nothing on the VPS), and it STATES THE
COST rather than leaving it to be discovered: the dashboard, both clients and
every AI generation are down for the length of R2 and R3. That window is not
new — `VACUUM FULL` holds ACCESS EXCLUSIVE on `sync_raw_payloads` for the whole
rewrite and every api path touching that table would have blocked on it anyway.
What is new is that it is budgeted before it starts instead of observed while it
happens. The refusal message names all three roles and points at the runbook
step, so an operator who meets it is told what to do rather than something that
does not work.

**WHAT WAS NOT DONE.** No migration: every column these fixes read and write
already exists (0125's typed columns, 0128's presence CHECK, 0129's journal). No
new config key, queue or incident kind — the floor is a constant for the reason
above, the catch-up is a second pass of an existing owner-gated command, and the
unavailable-body condition owns no latch (#217 still holds: the read path
counts, the hourly verifier alarms). No `canParse` gate added to the four
families that lack one: that is a real gap and it is a DIFFERENT one — those
families would still stamp a legitimately malformed body, which is #217-era
behaviour this change does not touch and does not make worse. And no attempt to
make the typed-column catch-up run automatically anywhere: it is part of
`capture:backfill`, which has no schedule and no flag, because a pass that
rewrites heap tuples on the largest tables in the system runs with someone
watching (#221).

---

**Decision #224 (2026-08-22, endpoints-cover WP-F0: the Fansly capture stops
discarding fan state, the DM sale sidecars become a plane, and three gaps that
had survived every review pass get mechanisms):**

**THE CORRECTION THAT CAME FIRST, because it inverts what everyone believed.**
This plan, its v1, and every review pass asserted that
`trimFanslyMessagingGroupsPayload` destroys `lastMessage` content, attachments
and tips on the conversation rows. Re-verified against a live capture: **there
is no `lastMessage` object on a conversation row.** Fansly serves exactly nine
fields per row — `account_id, groupId, partnerAccountId, partnerUsername, flags,
unreadCount, subscriptionTierId, lastMessageId, lastUnreadMessageId` — and the
trim keeps all nine. For `data[]` the function is an IDENTITY REWRITE and always
was. A byte-identity pin on a NEW verbatim-shaped fixture holds that, because
the belief is the kind that gets re-invented: the committed
`messaging_groups.json` is already trimmed-shaped and would pass the assertion
vacuously.

**THE LOSS THAT WAS REAL: `aggregationData.accounts[]`, 4 of ~25 fields kept.**
That is exactly the fan-evaluation material this initiative exists to capture —
does the fan follow back, what is their subscription and auto-renew state, our
notes, our lists, what access they hold, whether the account is alive. It is
repaired as a NAMED ALLOWLIST of 18 fields, not as a removal, and the eight
rejected fields are named as loudly as the accepted ones: `lastSeenAt`,
`followCount`, `subscriberCount`, `postLikes`, `accountMediaLikes`,
`timelineStats`, `streaming`, `version`. They change on nearly every response.
Capturing them would make every body unique and destroy the ~11:1 dedup collapse
measured on production — and THAT collapse is the entire reason the byte-ceiling
mechanism could be deleted rather than tuned. The deletion is pinned negatively:
no `fanslyUntrimmedCaptureByteCeilingPerDay` key exists, and nothing in the
capture path can defer a lane on `response_body_bytes`, which survives as pure
instrumentation. A storage guard able to stop live chatter work is a worse risk
than the runaway it hedges.

`lastSeenAt` was contested and rejected explicitly. It is genuinely useful to
chatters and genuinely destructive to dedup. If it is ever wanted it arrives as
its own "fan was online at T" fact, never inside a conversation body.

**MECHANISM 1 — THE MIXED APPEND (§3.2a), the one genuinely new protocol here.**
One `dm_messages` observation must now yield deliverable news AND projection-only
commerce material. No legal path existed: the projection-only append throws on
the first deliverable type, and a plain deliverable append passes no checkpoint,
so the hidden rows take account_seq values nothing covers and
`validateV2DeliverableReplayBatch` reads the gap as a ledger hole and refuses the
whole batch — every SSE client stuck at that cursor. `appendMixedDomainEvents`
requires a checkpoint whenever the batch carries a projection-only type, and the
ORDER inside the single account-seq transaction is load-bearing: deliverables in
caller order, then the hidden block, then the checkpoint. A deliverable row
interleaved between hidden rows splits the gap in two and the batch is refused.
`hiddenCount` counts hidden rows ACTUALLY APPENDED, dedup hits excluded — which
is identical to the old value on the pure projection-only path, so that path is
unchanged by construction rather than by inspection.

**MECHANISM 2 — sync-pull v5 and the media plane.** The journaled DM and
purchase-history responses have always carried `attachments[]`, `accountMedia[]`
with `permissions.permissionFlags[].price`, `saleStats`, `accountMediaBundles[]`
and `accountMediaOrders[]`. v4 read the order rows alone. v5 reads the rest and
emits four projection-only types into migration 0130's four rebuildable tables.
Three rules those tables obey, each because breaking it has a named cost: NO
URLs, locations or variants ever (the payload carries signed CDN addresses; they
stay raw-journal-only); NO queue columns (refresh scheduling is capture-plane
operational state, and this table is truncated by `projection:rebuild`); money is
mills and NULL-or-non-negative, where a sparse `saleStats` means "the platform
did not serve this", never zero.

`message.ppv_unlocked` keeps running unchanged beside `media.order_observed`.
They describe the SAME purchase from two identities — fan-purchase and
order-identity — and are never summed. An inline DM order row and a
`purchase_history` row for one purchase mint the same composite key and collapse
to ONE `media_orders` row, because the live order shape carries no order id at
all; `order_ref` stays nullable until a response is observed supplying one, and
only then, versioned, may it become the key.

**Purchase state is a JOIN, not a column (A17-4, variant B).** An earlier draft
added `purchase_state` / `purchased_at` / `purchase_ref` to `message_archive`.
The media-plane event types are not in `MESSAGE_EVENT_TYPES`, so the
shadow-rebuild set-equality gate would either fail or be weakened into a future
purchase-state wipe. Instead the archive gains Fansly coverage through the
channel it ALREADY understands — `message.material_observed`, filling the
existing material head, media list and `price_mills` — and purchase state is
served by joining `message_media_offers` on `(page_id, message_ref)`. The
archive's column set is pinned from `information_schema` so re-adding those three
columns fails a test rather than a rebuild.

**MECHANISM 3 — THE APPEND-SIDE PARTITION CENSUS (§3.2c(ii)), the gap two
earlier passes left live.** `domain_events` is monthly-partitioned by
`occurred_at`, and two lanes are deliberately provider-dated:
`message.material_observed` (the archive's `occurred_at` IS the message time) and
`post.observed`. A v5 bump drains months of DM history through the first of them.
An append whose target month has no ATTACHED partition fails
`ExecFindPartition` (23514) **per row, forever** — the observation is never
stamped, so every subsequent sweep retries it. The pre-existing account-row
preflight cannot see two of the three failure shapes: an EMPTY detached partition
hides no rows, and an ABSENT partition involves no detachment at all
(`ensureDomainEventPartitions` creates the current month + 3; no historical month
is ever auto-created — that is construction, not forgetfulness, and no runbook
line a human remembers prevents it).

The gate lives in `runCanonicalization`, NOT in a command. That one engine backs
both the ordinary minutely sweep and the `events:replay` drain, and a CLI-only
gate would leave the steady-state sweep that re-reads history after a version
bump completely unguarded. Refusal semantics are deliberate: the observation is
NOT stamped (its parse debt must survive the recovery), the run reports a typed
`partitionBlocked` count distinct from `errored`, and the driver raises ONE
anomaly per (family, target month) instead of one error per row — a blocked drain
is thousands of rows, and thousands of identical log lines are how an operator
stops reading them. **A run reporting `partitionBlocked > 0` is a SKIPPED step,
not a passed one.**

The check is scoped, and the scoping is pinned so nobody re-generalises it: it
name-matches `domain_events_YYYY_MM` for **2026–2030 only** and passes everything
else through. Every other regime is covered by construction —
`domain_events_pre_2024` spans MINVALUE → 2024-01-01, `_2024` and `_2025` are
YEARLY partitions migration 0077 named so tiering cannot re-detach them, and the
0082 catch-all covers 2031+. What the mechanism does NOT need to distinguish, the
OPERATOR does: the anomaly reports **detached** vs **absent** because the
recoveries differ, and using the absent recovery on a detached month (creating a
"missing" partition) orphans the facts the detached table holds. Both recoveries,
and the three things never to do, are in
`docs/runbooks/domain-event-partitions.md`.

**THE GAUGE RENAME, which had to ship in the same change.** `healthFloorName`
was `obs_backlog_${source}_v${version}`. The moment sync-pull reached v5 it
collided with the `posts` family's existing `obs_backlog_pull_v5` — two different
backlogs written under one metric name every tick, and the golden-signal
threshold map is built with `Object.fromEntries`, where a duplicate key collapses
silently to whichever came last. Every family now declares a stable, version-
INDEPENDENT `lane`, and the name is `obs_backlog_${source}_${lane}_v${version}`.
The consequence is stated rather than discovered: every existing series ends at
the rename and a new one starts. Ops metric samples are plain strings — nothing
migrates and nothing breaks.

**TWO PERMANENT RATCHETS.** (i) `WRITTEN_OBSERVATION_KINDS` +
`tests/observation-kind-coverage.test.ts`: every kind this tree journals must be
claimed by a canonicalizer family, by a REGISTERED off-sweep claimant, by a
justified dynamic rule, or by an allowlist entry carrying its reason — and no
allowlist entry may be orphaned in either direction. It is seeded from a census
of the tree rather than from a list, which is how it found five OF capture kinds
nobody had enumerated and one off-sweep claimant (the capture materializer) that
had never been registered. The census half greps the write seams line-wise, so
BL-C3's own writer — `endpoint: cond ? "link_stats_tracking" : "link_stats_trial"`
— is caught, and it pins the set of files that call `insertObservation` directly
so a new writer must come through the registry. (ii) an integration ratchet that
discovers fan-ref-shaped columns from `information_schema` and requires each to
be a fan-scope erasure target or justified: the erasure module's only automatic
guard enumerates non-cascade FKs to `fans`, and every fan reference this
initiative adds is a TEXT platform ref with no FK — structurally invisible to it.
The precedent is not hypothetical: `tip_sender_platform_user_id` had to be
hand-added. An unlisted table UNDER-ERASES SILENTLY.

**THE GUARANTEE, STATED HONESTLY.** The typed write seam ([S2] — making
`RawPayloadInsertRow.endpoint` a registry-derived union) is DEFERRED by owner
ruling. So ratchet (i) is a CI-enforced registry, **not** "structurally
impossible": a string literal at an untyped seam is caught at PR time by a test,
not by `tsc`. The caveat that keeps that honest: BL-C3 survived intact because
link-stats had a direct projection-write path, and every family this initiative
adds is `projectionOnly` and canonicalizer-fed with no such fallback — so the
same mistake on a new kind shows up as an EMPTY projection, not a redundant one,
until the kind is claimed and replayed. Recovery stays complete; the gap is
simply visible as missing data.

**AND THE LIMIT ON ALL OF IT: REPLAY CANNOT RECOVER WHAT WAS NEVER JOURNALED.**
The widened capture applies forward only. Pre-fix history stays trimmed, stated
through the existing `captureFloor` mechanism (#197), and there is no repair
re-walk — a re-walk would knock on Fansly for data we chose not to keep, and the
fan fields it would return are today's values, not the ones that were true then.
The v5 bump re-parses only what the journal already holds. The G5 CAS /
pointer-only machinery is untouched: only the payload handed to
`persistRawPayload` changes.

**WHAT WAS DELIBERATELY NOT BUILT** (each deleted by an owner ruling, and named
so it is not re-grown by accident): the §3.5 per-egress-key daily counter,
`sync_rate_limit_days`, the 2×-of-norm ops signal and the boot/PATCH limiter
invariants (the report they existed for is one query against
`sync_http_attempts`); the byte ceiling and its lane-deferral outcome; the typed
write seam and its negative type-test; and the three `message_archive` purchase
columns. `response_body_bytes` stays, as a column and as measurement only.

---

**Decision #225 (2026-08-22, endpoints-cover WP-F1: the account-statistics
lane, and the projection registry that had to come first):**

**WHY THE REGISTRY IS IN THIS ENTRY AT ALL.** WP-F1 is one lane. What made it
the right place to build the projection registry is arithmetic: the plan adds
roughly ten projections to a spine whose entire registry was a hardcoded
three-name `if`-chain in `projection:rebuild` and six hand-written try/catch
blocks in the worker tick. Ten copies of two unchecked edits is the
expensive-forever shape, and the two failure modes it produces are both silent —
a projector registered nowhere is a table that quietly stops filling, and a
projector nobody can REBUILD is a projection you cannot repair. Both are
omissions a passing end-to-end test does not notice, which is why the
media-plane registration ratchet had been asserting on the SOURCE TEXT of those
two sites. That ratchet is now written against the registry instead, which is
strictly stronger: it could only ever see whether one literal was present.

**What the registry deliberately does NOT do.** [D1] — the typed positive
`types` filter on `listEventsSince`, its index, and the conversion of the five
existing projectors — stays DEFERRED (owner, 2026-08-21), and so does per-family
tick scheduling. The half that is nearly free was kept: every definition
declares its `eventTypes` from day one, which is what makes the deferral
reopenable rather than a silent drop. The NAMED TRIGGER ships with it — a
tick-duration alert on the shared queue — because a deferral whose trigger was
only defined in the fallback branch would have had no trigger at all.
Observation-driven consumers are not in the registry and should not be:
`ai_acceptance` walks `observations` by id, has no event types to declare, and a
registry entry with an empty type list would be a lie the registry test exists
to catch.

**THE THIRD STATE CLASS, checked rather than promised.** Rebuild is truncate +
replay, and no event carries a cursor, a floor or a blocker. A rebuild that
truncated `capture_coverage` would erase every retention floor the backfill paid
egress to discover and re-trigger the whole first-sight backfill set — an egress
storm against a platform whose failure mode is a model ban. So
`OPERATIONAL_STATE_TABLES` declares the class (A17-6), and the test asserts the
intersection with every projection's `tables` is EMPTY. That empty intersection
IS the guarantee; the §9.1 checksum exclusion follows from the classification
rather than from an exemption written into the test file.

**THE BUDGET, and the one sentence that matters.** The per-lane daily cap is
counted in HTTP **attempts**, retries included, because a cap counted in logical
calls lets a retry storm multiply real egress by up to the adapter's retry limit.
It lives in the cursor, so it survives leases, restarts and re-dispatches — a cap
that resets on every lease is not a cap. And crossing it **defers the lane to the
next UTC day; it never drops**: the check runs before the call, and a response
already fetched is journaled before the cap is consulted again. After A28-4 this
is the WHOLE request-count enforcement in the design — the §3.5 per-egress-key
counter, `sync_rate_limit_days`, the 2×-of-trailing-norm ops signal and the
boot/PATCH limiter invariants are all deleted, and [A19] had already removed the
global per-page cap. `response_body_bytes` stays, as measurement only.

**THE BACKFILL DETAIL THAT IS NOT OBVIOUS.** Each next window is derived from the
provider's RETURNED `dateAfter`/`dateBefore`, never from the bounds we asked for.
Fansly snaps windows to its own bucket grid, so a walk that stepped back 100 days
from OUR requested bound would drift a bucket per chunk and leave holes nobody
would notice for a year. The stop rule is two consecutive all-empty windows PLUS
one probe roughly a year further back, because an empty window on a long-idle
account proves INACTIVITY, not a retention floor ([E10]) — and every empty
response is journaled, because the empty window IS the floor evidence. The floor
lands in `capture_coverage` with `proof = empty_window` and a
`proof_observation_id` pointing into the 100-year journal: evidence with no
address is a claim.

**BURST SHAPE IS THE BAN-RISK SURFACE, not daily volume.** A chunk spends five
requests in about thirteen seconds and is re-queued immediately, so an unspaced
deep walk runs contiguously at ~23 requests/minute — 4.4× the live human capture
session that produced zero 429s — for as long as it has work. Backfill
continuations therefore carry `fanslyBackfillContinuationDelayMs` (20 s) ± 30 %
jitter. Steady-state sweeps keep immediate continuation, because they are six to
eight calls a day.

**THE EVENTS.** Family `fansly-stats` v1, `projectionOnly: true`, thirteen
natural-key types, every one added to `PROJECTION_ONLY_DOMAIN_EVENT_TYPES` in the
same change that registered the family — the file's own comment says the two are
one decision, never two. All of them are RECEIPT-TIME (§3.2b): `occurredAt` is
the observation instant and the provider instant is a typed field in `data` and
part of the natural key. A receipt-time draft is by construction inside
`clampDraftOccurredAt`'s window, so this family can never produce
`occurredAtClamped` — its PRESENCE is the failure signal, and the pre-2024
fixture asserts exactly that. The failure this prevents is concrete:
`domain_events` is monthly-partitioned, and a historical append dated at provider
time aims an insert at a cold or detached partition and fails `ExecFindPartition`
(23514) forever.

**Type codes are stored raw, and the label module's guard order is the test.**
A22-2 found five label/code pairs where one visible label maps to two live codes
(legacy and current): keying by label silently merges legacy into current, and
keying by code against a closed set silently DROPS every legacy row. So storage
holds the integer, the label table is read-time and versioned
(`FANSLY_STAT_LABEL_VERSION = 2`), and an unknown code writes its row AND raises
`fansly_stats_unknown_type` (A1: journaled and surfaced, never dropped). The
unknown guard fires BEFORE the family lookup, so a new member of a known family —
10002, 44002, 44032 — reports `unknown:<code>` instead of being absorbed into a
label we would then trust.

**Money and absence.** Mills through the `packages/shared` constructors, as
decimal strings in events (JSON cannot carry a bigint and a float re-opens the
1000× footgun). `saleStats.total` is the creator's NET share (A12) and is never
summed with gross. `/trackinglinks.totalNet` came back 0 on all five observed
links while `totalGross` was populated: it lands NULL, with the served number
preserved beside it so a later populated capture is distinguishable from today's
silence. `totalVideoPercentWatched` is already a SUM on the wire and is stored as
one — dividing on write would bake in a divisor we have not proven.

**What this supersedes, explicitly.** #206 parked `/trackinglinks` as an endpoint
with no consumer. It has one now: the daily snapshot is a first-class fact, and
consecutive-day diffs ARE the daily series the platform does not serve.

**A21 stands and is restated so nobody rebuilds it.** There is no
`capture.window_observed` event and no `stats_capture_windows` table. The two
top-N tables carry their window identity INLINE (`page, plane, period_ms,
requested_start, requested_end, content_hash`), and "which window did we ask for,
when, and what came back" is a query over `sync_raw_payloads`, which already
stores endpoint, request params, status code and captured-at per request for a
hundred years. The same reasoning forced one correction during the build: the
capture INSTANT is outside the hashed material for the daily tag and
tracking-link snapshots. Hashing it minted a fresh event on every poll, forever —
the exact runaway A21 deleted the window event for.

**5-minute buckets are a deliberate non-goal.** `period=300000` is reachable (the
UI's "Last Hour" proves it). It would multiply this lane's calls and its row
count for a granularity nothing in the plan, the dashboard or the agent plane
asks for. Recorded here so the next pass does not read its absence as an
oversight.

**Two repairs that came with the wiring.** The ops-ordering `streamOrderSql` in
`repositories/sync.ts` — the third hand-written copy of the stream order — had
silently omitted `fan_earnings` and `purchase_history` since Stage 16, so both
fell to `else 999` and sorted last regardless of their real index. And
`MONITORED_SYNC_STREAMS` was missing `posts`, which made a wedged posts walk
unobservable in exactly the way a wedged `fan_earnings` walk was before W8.1; the
new pin is `MONITORED_SYNC_STREAMS ⊇ getSyncStreamsForPlatform("fansly")`, so the
next omission fails a test instead of hiding a lane.

**The seed pause is generalized.** `buildSeedPageSyncState` used to special-case
`if (stream === "posts")`. Every other stream seeds pending/recovery, so a
gated-off stream added to `SYNC_STREAMS` without that branch seeds one pending
row per page FLEET-WIDE on the deploy that ships it — before its flag has ever
been opened. `SEED_PAUSED_SYNC_STREAMS` is the list now, and the pin is a test.

**S4 stands: one flag and one page allowlist PER STREAM.** The stats allowlist
FAILS CLOSED (empty = no pages), the opposite of `fanslyNewStreamPageAllowlist`
(empty = all pages), and reading the stats lane through the shared key would
report every page as ramped the moment its flag went on. Two keys are not the
cost being weighed: with a shared allowlist, adding page 2 for one lane opens
page 2 for every lane at once, which makes a per-stream ramp unexecutable, and
one fat-fingered edit breaks six streams instead of one.

---

**Decision #226 (2026-08-22, endpoints-cover WP-F2: the notification lane, and
the case for journaling before you understand):**

**THE ONE PROPERTY EVERY OTHER DECISION HERE FOLLOWS FROM.** `notifications` is
the only permanently-lossy capture surface in this system. Fansly announces a
liker, a reply, a quote or a purchase ONCE, in this stream, and no other route
serves it again — not the post detail, not the transaction ledger, not the
message archive. A statistics window we miss today can be re-asked for tomorrow;
a notification we miss is gone. So the lane is `live` class at 1 800 s rather
than maintenance, it polls the head BEFORE it does anything else, and a running
deep backfill YIELDS to a due head poll. History keeps. The head does not.

**LAYER 1, AND WHY IT EARNED ITSELF IN THIS EXACT FAMILY.** The canonicalizer
emits `notification.observed` for EVERY row and EVERY code — known, unknown,
unnameable — and `platform_notifications` rebuilds from that event alone. Typed
derivations ride BESIDE it and never instead of it: a 2007 row emits its verbatim
event AND a `media.purchase_notification_observed`, so deleting the second
changes what we can query, never what we hold.

That is not a general principle applied out of habit. **A22-1 read the client's
own filter arrays line by line and found `reference/fansly_api_spec.md` §3.1
wrong on EIGHT of its sixteen codes, including BOTH purchase events**, which it
had filed as "PostLikeUndo" and "PostLikeRedo". A design that typed first and
stored the typed result would have swept two live money streams into a like-noise
bucket, permanently, with the raw codes nowhere. The labels were wrong; the data
would not have been lost. **That is the concrete payoff of the verbatim-first
layer, and it is worth citing the next time someone proposes parsing before
journaling.** The v1 plan's "2007/2008 = media-like undo/redo, flip
`post_likes.state`" is refuted and deleted; "never import FBuddy's map" stands,
and is better justified now — both maps are wrong about 2007/2008.

**THE LABEL TABLE IS A READ-TIME ARTIFACT WITH A VERSION AND A CITATION PER
ROW.** `packages/shared/src/fansly-notification-types.ts`
(`FANSLY_NOTIFICATION_LABEL_VERSION = 1`) carries the corrected table; storage
holds the RAW integer (**A22-2**), so a re-derivation is a version bump plus a
projection rebuild and never a data rewrite. The promotion rule is unchanged and
binding: `confirmed` requires two independent live examples agreeing with a
second source, because client code proves the CLIENT's intent, not the SERVER's
behaviour. 2007 is therefore the only `confirmed` entry at ship — its UI↔payload
match is a real one ("Purchased your Media for $80/$50" against
`accountMediaPrice` 80 000 / 50 000) — and 2008, 32007, 45012, 1002, 2002, 1004,
1005, 5003, 15007 and 15011 are all `inferred` with a client-code citation.
`1003` is declared by the client's tab map with NO filter label, and is
deliberately treated as UNKNOWN: "we can see it" is not "we can name it", and
pretending otherwise would suppress the anomaly that is the only signal a new
code arrived. The labels are the spec's own renderer names in snake_case (the
four purchase codes take the platform's FILTER label instead, because the money
is the point and "account-media order" buries it), so the repo's two tables
cannot drift apart on the same source.

**`post_likes` SHIPS SCHEMA-COMPLETE AND EMPTY, AND SAYS SO.** No Fansly like
code is live-confirmed: 1002/2002/5003/1004/1005 had ZERO occurrences in the
200-row census, and a client-code label is not server behaviour ([E4]). Layer 2
writes nothing there, a test pins that a 2007 purchase leaves it untouched, and
its `capture_coverage` row reads `not_started` with `acquisition_mode =
forward_only` — a NEGATIVE claim the serving layer needs, because without it an
empty list reads as "nobody liked it" rather than "we have never been able to
see this". The table exists complete because the OnlyFans `posts.liked` webhook
populates it independently, and because a table that arrives later arrives
without its precedence rule tested.

**THE CURSOR IS A NOTIFICATION ID, NOT A TIMESTAMP.** `before=<id>` is "the page
older than that row". Read as an epoch it would ask for notifications from 1970,
get an empty page, and record a retention floor that does not exist.

**THE TYPE FORK (A1 + A22).** The first call of every poll goes with NO `type`
param, because a filtered call can only return codes we already knew to ask for
and the unknown ones are half the reason this lane exists. On a 4xx, or when an
empty unfiltered page is contradicted by a one-time probe with the filtered form,
the lane widens to the client's **FULL declared eighteen-code CSV** — and never
to the eight codes the walked UI happened to send, which silently exclude `32007`
(Locked Text Purchases) and `45012` (Stream Ticket Purchases), **both of which
are money, on exactly the degraded path where a silent gap is least affordable**.
Then one filter group per call, then it stops. The refusal counter is DURABLE in
the cursor rather than local to a dispatch: WP-F1's window loop spanned five
chunks on production and a guard that lived inside one chunk would have watched
it happen five times and said nothing.

**A DEGRADED LANE NEVER CLAIMS A CLEAN CAPTURE.** While the type form is
narrowed, every `capture_coverage` write on this plane reads
`partial_provider_surface` — **including the terminal one**. An empty page means
different things in the two forms: unfiltered it is the archive's floor, through
a narrowed filter it only means "no rows of THESE types". Calling the second
`provider_exhausted` would tell the serving layer we reached the end of history
when we reached the end of a filter, which is the worst claim this lane can make.

**THE DEEP BACKFILL** walks backwards to the floor with WP-F1's repeat-request
guard (the identical `before` twice stops the walk and writes a terminal coverage
row), journals every page INCLUDING the empty one because the empty page IS the
floor evidence, and records `notificationFloorAt` with `proof = empty_window` and
`proof_observation_id` pointing at the journaled body. **13.65 days is where the
2026-08-19 capture STOPPED, not a platform floor** — the walk measures the real
depth, and every "likers since X" claim the serving layer makes is bounded by it.
The like/liker facts carry `acquisition_mode = forward_only` because nothing can
retro-fetch a liker.

**THE BUDGET** is 96 HTTP ATTEMPTS per page per UTC day (48 head polls plus
pagination), counted in attempts because a cap counted in logical calls lets a
retry storm multiply real egress by up to four, living in the cursor so it
survives leases and restarts, and DEFERRING to the next UTC day rather than
dropping — a response already fetched is journaled before the cap is consulted
again. After **A28-4** the per-lane cap is the whole request-count enforcement.

**[A20] ON THE EMBEDDED `accounts[]`, and it is the sharpest case of the hazard
so far.** `/notifications` embeds the fan as a FULL account record — 23 keys in
the live capture, `lastSeenAt`, `followCount`, `subscriberCount`, `postLikes`,
`accountMediaLikes`, `timelineStats` and `streaming` among them. `lastSeenAt`
moves every minute; journaling it verbatim would make every notification body
unique and destroy the content-address dedup collapse the whole disk budget rests
on. So that array — and ONLY that array — goes through the named 18-field
allowlist before journaling. The 200 notification rows, the tips, the media, the
subscriptions and every key the platform starts serving tomorrow are stored
verbatim: DP 7 says journal verbatim, and [A20] narrowed one array, not a
response.

**HEAD PRECEDENCE IS THE PROVIDER'S `occurred_at`, NEVER `account_seq`, and the
reason is physical.** The deep backfill walks BACKWARDS: it appends OLDER facts
at HIGHER account_seq and at a LATER observation instant. So both orderings every
other projector in this tree can use — ledger position, and "latest capture wins"
— are guaranteed wrong here, and either would let a year-old like overwrite
today's undo. `notification_ref` is the deterministic tie-break, the guard lives
in the repository's upsert so no caller can forget it, and the blocking test is
"a higher-seq, older-`occurred_at` event cannot regress the head". This is
`creator_posts`'s law generalized, with the deliberate difference stated: a post
head means "latest capture wins", a notification-fed state machine must be
ordered by when the EVENT happened.

**§3.4'S THIRD STATE CLASS GAINS ITS SECOND MEMBER.** `subject_refresh_state`
(migration 0134) is the ONE shared refresh queue every later per-subject lane
schedules from — WP-F4's media statistics, WP-F5's reply walk, WP-F6's engagement
refresh, and the OF post-stats decay. It is declared in
`OPERATIONAL_STATE_TABLES`, so no projection's `tables` list may name it and a
rebuild can never truncate it. The failure that classification prevents is
concrete: rebuild is truncate + replay, no event carries a due date or a walk
cursor, and a rebuild that wiped the queue would reset every cycle and re-mark
the whole catalogue as first-sight — an egress storm against a platform whose
failure mode is a model ban. It is why v1's four queue columns on the rebuildable
`creator_media` were wrong, and why WP-F5 had already kept its walk state out of
`creator_posts`.

**THE COMMERCE SIGNAL, and its whole extent.** A 2007/2008/32007/45012 event
marks the purchased media dirty in `subject_refresh_state` (`plane='media_stats'`,
`refresh_class='dirty'`, `dirty_reason='purchase_notification'`, due now) and
**fetches nothing**. `media_purchase_signals` is not a new table: the rows land
in `platform_notifications` and drive refresh priority plus the commerce
correlation join. WP-F4 is what acts on the mark.

**ERASURE.** Both new fan-ref-shaped columns are declared in
`FAN_REF_ERASURE_COLUMNS` and reached by a real predicate with a per-row drill,
because the module's automatic guard enumerates non-cascade foreign keys to
`fans` and neither column is one — the same blind spot
`creator_post_tips.tip_sender_platform_user_id` had to be hand-fixed for.
`post_likes.liker_platform_user_id` is always the fan.
`platform_notifications.correlation_ref` is the fan on the codes that NAME one —
purchases, follows, subscriptions — and the predicate is written to exactly that:
a notification whose correlation ref is a post id is the creator's own content
and survives, the same line `media_offer_locations.correlation_ref` draws. A
predicate that deleted both would erase the page's own history to forget one
person.

**Rejected, and recorded so it is not re-proposed:** a `media_purchase_signals`
table (the rows are already in `platform_notifications`; a second copy of one
fact needs a second rebuild path); queue columns on `creator_media` (truncated by
an ordinary repair); the eight-code UI CSV as the degraded-path fallback (it
drops two money codes); and typing a code the label table cannot name (that is
the mistake the spec made on eight of them).

---

**Decision #227 (2026-08-22, endpoints-cover WP-F3: the content catalog, and the
number WP-F4 is sized against):**

**WHY THIS LANE SHIPS BEFORE THE PER-MEDIA ONE.** WP-F4 visits every media offer
a page owns on an age-decayed round-robin under a 300-call daily cap, so its
long-tail refresh cycle is M / rate — and until now M was a guess. The whole
argument for this package is that a lane sized against a guessed denominator can
be honest about its cadence only by accident. `catalog` measures M.

**Σ `item_count` IS NOT M, AND THE DIFFERENCE IS NOT SMALL.** The 2026-08-19
capture served 27 albums summing to 16 939 items — but the system albums type
38000 (7 574 items) and type 5000 (3 154 items) carry the SAME `lastItemId`:
they are views over the same media, not shelves holding different media. Any
number derived by summing that column is a fiction. M is
`count(distinct media_offer_ref)` over `creator_media`, and the lane reports
three figures together in its progress block — `uniqueMediaCount` (M),
`vaultMemberUniqueCount` (the overlap-aware union the walk itself measures) and
`albumMembershipSum` (Σ, labelled NON-UNIQUE at every appearance). Publishing Σ
alone would have been the easiest possible way to size WP-F4 wrong.

**THE `/media/vaultnew` FORM, and the failure it was one commit away from.** The
2026-08-22 probe asked `albumId=…&search=&before=&after=` for an album the
platform says holds 4 760 items and got `{albumMedia: [], media: []}`. An empty
first page is INDISTINGUISHABLE from an exhausted album, so a lane that trusted
it would have recorded "this creator has no media", sized the media lane against
zero, and produced no error anywhere. The app bundle settles the form:
`getVaultAlbumMediaNewOrder` builds
`?albumId=<id>&mediaType=<filter|"">&search=<text|"">&before=<cursor>&after="0"`,
and its caller passes the LITERAL STRING `"0"` for both cursors on the first
page and `before = <the last albumMedia row's own id>` afterwards. Two details
carry the whole difference: an empty `before=` is a cursor the server does not
honour, and the paging id is the MEMBERSHIP row's `id`, not its `mediaOfferId`.

**AND THE GUARD STAYS ANYWAY.** An empty page is "end of pages" only after a
non-empty one, or on the first page of an album whose `itemCount` is 0. An empty
FIRST page on a non-empty album stops that sublane with
`partial_provider_surface`, ONE anomaly and no retry — never a loop. WP-F1 spent
a whole production day's cap re-asking a question it could not answer, across
five chunks, and nothing said a word; the shape of that failure is what this
guard is written against.

**FEAT-002 CLOSES ON THE PLAN, NOT THE TIER.** Every one of the five observed
tiers carried `tier.price = 5 000` while its plans ran from 10 000 to **499 990**
— a page reported from the tier head would read as a $5 page. So the tier head
keeps `base_price_mills` under a name no consumer can mistake for a price, the
verbatim `plans` array rides beside it as proof nothing was dropped, and
`page_subscription_tier_plans` is the queryable truth. `duration_days` reads
**`billingCycle`**: the live payload has no `plans[].duration` key at all, and
`duration` DOES exist one level down on `promos[]` — the plan document names the
promo's field and calls it the plan's. The payload is the contract; the writer
accepts either key so a provider rename is survivable, and a fixture pins both.

**THE ROSTER EVENT, and why `missing_since` needs one.** A tier is retired, a
gift code revoked, an album deleted. DP 7 forbids deleting the row, so the
projection marks it — and a projector cannot derive a mark from row events,
because row events say what IS and nothing in them says what ISN'T. The worst
case is the honest one: a page whose last tier is retired serves an EMPTY
listing, which produces zero row events and would leave stale tiers reading as
live forever. So every FULL listing also emits one `catalog.listing_observed`
carrying its complete ref set, and the projector marks the complement missing and
CLEARS the mark on everything the roster still names. `missing_since` becomes a
replayed fact, reproduced byte-for-byte by a truncate-and-replay, rather than a
sweep-time side effect a rebuild could not reconstruct.

**The first version of that key was wrong, and the correction is the interesting
part.** Hashing the ref set made an unchanged roster append nothing, which looked
like the right economy. It is wrong in exactly one direction: a gift code that
disappears and comes back UNCHANGED hashes to the roster it had before it
vanished, so the event dedupes, the projector never sees it, and the row stays
marked `missing_since` while the platform is serving it again. A set returning to
a previous shape is a different FACT from a set that never changed, and only the
LOOK tells them apart — so the roster is keyed per observation, the content hash
stays in `data` as the cheap "did the set move?" read, and replay is still a
no-op because the same observation replays to the same key. The cost is seven
small events per page per day against a production ledger that already appends
~1 971.

**ALBUM MEMBERSHIP GETS NO ROSTER, deliberately.** It arrives from a PAGED walk,
and a roster built from one page would claim the album contains only what that
page showed — the walk would spend its life marking and un-marking its own rows.
A partial listing is not a listing.

**NO MEDIA BYTES, NO DELIVERY URLS (A4-4).** `/vault/albumsnew` and
`/media/vaultnew` both embed raw `media[]` rows carrying `location`,
`locations[]` and `variants[]` — signed CDN material. The bodies are journaled
verbatim (DP 7) and NOTHING downstream reads those keys, pinned on VALUES as well
as on column names, which is what the fixtures' `SIGNED-…` placeholders exist
for. The catalog fetches metadata, prices, permissions and membership, and never
a byte of media.

**SECONDS AND MILLISECONDS, PER FIELD.** One response mixes both: on
`/uservault/albumsnew`, `albums[].createdAt` and
`aggregationData.albumContent[].createdAt` are MILLISECONDS while
`aggregationData.accountMedia[].createdAt` is SECONDS. Gift codes and promos are
milliseconds. Each field is decoded by the helper for ITS unit; a single
heuristic that guesses right today is a 1970 row the day the platform changes.

**TWO SMALLER TRAPS, recorded because both are silent when got wrong.**
`original_price` is snake_case amid otherwise camelCase keys, so reading it by
the camelCase name returns a NULL list price and no error. And the automation
`messageTemplate` is a JSON OBJECT in all seven live values — the archived claim
that it is a single-quoted Python-repr pseudo-JSON STRING is refuted by the
capture and withdrawn — but the string branch survives with `parse_ok = false`
and a NULL `message_text`, because an automation with no text and one we could
not read must never look alike in storage.

**`page_promo_links` BECOMES A TWO-WRITER TABLE, and both rebuilds are scoped.**
WP-F1 created it with `link_kind IN ('tracking','gift_code')` and this package
supplies the second kind. The kind is part of the primary key, so the two row
sets are structurally disjoint — but an UNSCOPED `delete … where page_id = ?` on
either rebuild would truncate rows the other projector's ledger owns and only the
other rebuild could restore. Both now delete by kind. The gift-code half adds
`uses`, `max_uses`, `price_mills`, `original_price_mills`, the two date bounds
and `missing_since`, rather than borrowing the tracking half's counters: a list
price and a revenue figure have different bases and §2.3's rule against combining
them applies inside one table as much as across two.

**THE SUBLANE-PARKING MACHINE IS NOT BUILT (A28-6).** The plan carried a
per-route `contract_drift | unsupported | not_probed` state with `next_probe_at`
and a 7-day retry. The probe answered the question it existed for on 2026-08-22:
all four March-corpus routes are live. A parked-sublane state machine with no
sublane to park is machinery maintained for a hypothesis that has been settled.
What survives is the part that earned itself — per-scope `capture_coverage` rows,
which say what a walk reached and why it stopped without pretending to schedule
its own recovery.

**Batch size is 100, and it is not a guess.** The app's own `requestMediaTick`
and `requestBundleTick` both `splice(0, 100)` before calling `/account/media?ids=`
and `/account/media/bundle?ids=`, so 100 is a size the server is known to answer
for. The plan's fallback of 25 would have tripled the hydration call count for
nothing.

**Rejected, and recorded so it is not re-proposed:** a roster keyed on its ref-set
hash (see above — it makes a returning entity permanently missing); `media.observed`
declared on this projection (the media plane stays the SINGLE writer of
`creator_media`, and declaring the type twice would make the registry's ownership
claim untrue); writing the user vault's `accountMedia[]` into `creator_media` (it
is the account's PURCHASES from other creators, and counting it would inflate M
by the size of the page's shopping history); a `content` value in `SyncDomain`
(there is none, and adding one to the vocabulary for a label is not worth it —
`financials` is where tiers, plan prices and gift codes belong); and a
`media_stats -> catalog` dependency declared here rather than by WP-F4 (a
dependency on a handler that does not exist yet blocks nothing and misleads
everything).


---

**Decision #228 (2026-08-22, endpoints-cover WP-F5: the comment archive, and the
POST this system will never send):**

**THIS LANE EXISTS BECAUSE A PROBE SAID IT COULD.** Every one of the five
observed `GET /post/{postId}/replies` calls in the 2026-08-19 capture was
preceded ~40 ms earlier by a reply-verify POST carrying the same post id — 5 of
5. That made WP-F5 contingent rather than planned: §1 excludes write-shaped
calls to the platform, so if the POST had been a server-side precondition the
comment archive would have been CUT, not built, and the owner would have been
asked before anything downstream of it was designed. [E1] issued the bare GET
with no preceding POST, on the canary page, through the page's own proxy, and
the comments came back (**A25**). The lane is built on that one fact.

**AND THE POST IS STILL NEVER SENT.** A POST that "only verifies" is still a
POST to somebody else's server on an account whose failure mode is a model ban,
and the temptation to add it later — because the browser does, because a reply
came back empty once — is exactly the kind that gets added at 2 a.m. So the law
is a grep: a test reads `packages/fansly/src/adapter.ts` and fails if that
route's path appears ANYWHERE in the file, as a route, a comment, or a
half-finished idea. The path is deliberately not written out even in the
docstring that explains its absence, because the pin greps the whole file.

**THE WALK QUEUE IS NOT A CURSOR, AND ITS SEEDING IS A TRANSACTION.** A
back-catalogue has no order it should be read once, so the unit of work is a ROW
per root post in `subject_refresh_state` (`plane='post_replies'`, `known_count`
= the reply count that walk last saw) — the second plane on the table WP-F2
built, and the reason that table exists rather than four queue columns on a
rebuildable projection. Rows are seeded from `creator_posts` in bounded KEYSET
batches on first enable (zero platform calls — the posts are already in the
database), and for everything published afterwards **in the SAME TRANSACTION as
the `creator_posts` upsert**.

That transaction is the load-bearing part of this package, and it is worth being
precise about why. A post committed WITHOUT its walk row is a post whose comments
are never read — and nothing anywhere reports a problem. The lane stays healthy,
its coverage row stays clean, the queue drains to zero, and the archive is simply
missing that post's comments forever. Seeding on a timer instead leaves the same
hole for however long the timer is, and the seeding sweep is itself bounded by a
daily call budget, so "however long" can be days. The Fansly-only condition lives
in the INSERT's `WHERE` rather than in TypeScript, so the platform seam stays
where the Stage 18 ratchet expects it.

Priority per chunk: **(1) never-walked, NEWEST POST FIRST** — a comment archive
that starts with the posts nobody remembers is useless for a year — **(2) dirty**
(a head reply-count change, or a future comment-signal notification), **(3)**
round-robin re-walk of rows older than `fanslyRepliesRewalkCycleDays` (14). The
VISIT is what clears the dirty mark and nothing else does, so a signal cannot be
lost between "marked" and "fetched"; and a FAILED look does not move
`last_visited_at`, because a failed look is not a look and moving it would retire
a post from the never-walked band on the strength of an error.

**PAGINATION IS UNPROVEN, AND THE LANE SAYS SO IN STORAGE.** Five live responses
carried 1, 1, 1, 1 and 4 replies. No cursor has ever been exercised, so nothing
here may claim a complete read of a post with many comments. The first call is
BARE; a page of >= 20 replies is suspiciously full — far outside anything the
route has ever done — and only then is `?before=<last reply id>` attempted, the
convention `/timelinenew`, `/message` and `/notifications` share, on a route
whose replies come back descending by id.

What the cursor DOES is then settled EMPIRICALLY rather than assumed: the page it
returns is compared against the page before it. Identical rows mean the route
ignored the cursor (`single_page`, and no post is ever paged again); different
rows mean it was honoured (`before`). The verdict is durable in the cursor state
and announced by exactly ONE anomaly, ever — a discovery announced on every walk
is a discovery nobody reads. The repeat-cursor guard is spent BEFORE egress: the
identical `before` twice in one walk stops the walk with a warning rather than
looping, which is the posts.ts law and the lesson WP-F1 paid a full day's cap to
learn.

Until a mode is proven, a full page marks its rows `possibly_truncated` and the
lane's coverage reads `window_captured`, never complete. **The projector is
FORBIDDEN from marking anything `missing_since` from a truncated roster** — a
truncated page's complement is unknowable, and guessing it would delete an
archive one page at a time. The CLEAR half still runs, because a ref the page DID
name is present in both worlds. A page fetched WITH a cursor is marked truncated
too, deliberately over-marking: one response can prove nothing about a second
page on a route whose pagination nobody has observed.

**THE OBSERVATION CARRIES THE REQUEST, AND IT HAS TO.** The post id lives in the
request PATH, so the response that matters most — the empty one, "this post has
no comments any more" — is a body with no way to say which post it is about. A
parser reading the body alone could store comments and could never mark one
deleted, which is the entire `missing_since` half of this package. The lane
journals the verbatim (post-[A20]) body into `sync_raw_payloads.response_payload`
exactly as every other lane does, and gives the OBSERVATION a
`{walk: {postId, before}, response}` envelope through `persistRawPayload`'s
`observationPayload` seam — the mechanism `posts.ts` already uses for a response
a future parser needs request context to replay. Nothing is lost and nothing is
invented; both halves are journaled.

**THE ROSTER, AGAIN, AND WHY ITS FIELD LIST GREW.** Family `fansly-comments` v1,
projection-only, receipt-time (§3.2b — `createdAt` is SECONDS on this route, and
a 2023 comment dated at provider time would fail `ExecFindPartition` (23514)
forever). `post.comment_observed` per reply, dedup-keyed on the comment's CONTENT
hash so an edit appends a new event and moves the head while the fortieth re-read
of unchanged bytes appends nothing. `post.comment_list_observed` per walk.

The plan named the roster's fields as `{parentPostRef, count}`. A count cannot
identify a complement, so the roster carries the full ref SET — WP-F3's lesson
applied verbatim, including its correction: the key is per LOOK (the observation
id), because a comment deleted and restored UNCHANGED hashes to the roster it had
before it vanished, so a set-hash key would dedupe the event and leave the row
marked missing forever.

**EMPTY-CONTENT REPLIES ARE STORED, NOT SKIPPED.** One of the four replies in the
18.2 KB live response has `content: ""`. A fan who replied with only an
attachment still replied, and dropping the row would make the reply count
disagree with the archive with no way to tell which of the two is wrong.
`inReplyTo` and `inReplyToRoot` are stored SEPARATELY even though they were equal
in every observed reply: the day a nested reply arrives, the difference is what
reconstructs the thread, and no re-walk recovers it retroactively.

**[A20] ON `accounts[]`, and this is the response that made it non-theoretical.**
WP-F9's shape probe read a live reply page and found the inline account record is
a FULL one — `lastSeenAt`, `notes`, `containingLists`, `subscriberSubscription`,
`statusId`, `followCount`, `subscriberCount`, and an avatar carrying signed CDN
locations. `lastSeenAt` changes every minute; journaling it makes every body
unique and destroys the content-address dedup collapse the disk budget rests on.
On a lane that re-reads a back-catalogue of thousands of posts, that is the
difference between kilobytes a day and unbounded growth. So `accounts[]` — and
only `accounts[]` — goes through the 18-field allowlist before journaling.
`posts` (the replies themselves, bodies and all), `aggregatedPosts`,
`accountMedia`, `accountMediaBundles`, `tips`, `tipGoals`, `stories`, `polls` and
every key the platform starts serving tomorrow pass through UNTOUCHED, and a body
with no `accounts` key comes back byte-identical.

**AUTHOR HYDRATION STAYS MANDATORY (A27-1), AND STAYS UNCLAIMED.** `accounts[]`
was EMPTY in 2 of the 5 captured responses despite a comment existing, so inline
hydration is not guaranteed and the fallback is not an optimization. At most ONE
`/account?ids=` batch per chunk (<= 100 ids, the adapter's own limit) journals
under the EXISTING `account_lookup` kind — which no canonicalizer family claims,
and which this package deliberately does NOT claim. Registering a family for it
stays a backlog item, visible and frozen by the observation-kind ratchet. Because
nothing parses the result, the "already looked up" set is capture state in the
cursor rather than a projection-derived queue: a queue derived from
`post_comments.author_username IS NULL` would never drain and would re-request
the same hundred refs every day forever.

**ERASURE.** `post_comments.author_ref` is declared in `FAN_REF_ERASURE_COLUMNS`
with its own exact fan-scope predicate. It is a TEXT platform ref with no FK to
`fans`, so the erasure module's automatic guard is structurally blind to it — and
of every fan-ref column on that list this is the one whose under-erasure is most
visible, because the row holds words the fan wrote. The predicate has none of
`platform_notifications.correlation_ref`'s code-dependent ambiguity: a comment
has exactly one author and it is never the creator's own content.

**THE WALK QUEUE SURVIVES A REBUILD, PINNED.** `projection:rebuild
fansly_comments` truncates `post_comments` and replays it from the ledger, and
`subject_refresh_state` comes back byte for byte. A rebuild that reset those rows
would re-mark the entire back-catalogue never-walked and release a first-pass
crawl of every post on every page — an egress storm bought by a repair that
should cost zero platform calls.

**THE CAP SHIPS AT 100 AND THE RAISE IS A SEPARATE ACT (A29; A16's ritual,
per-lane per [A19]).** Production counts on 2026-08-22: lora-1 1 318 roots,
lora-2 1 141, lora-3 1 082, lilly-1 398, lilly-2 347, ari-1 8 — ~4 294
fleet-wide. At 100 attempts/page/UTC-day the biggest page first-passes in ~14
days and the whole fleet in ~43 page-days, which run in parallel because each page
has its own proxy and its own budget.

The raise to **300/day** is ONE config flip with its own verification window, and
its criteria are recorded here rather than remembered:

1. zero 429s on the lane's egress key;
2. a MEASURED `posts.length` p99 — the lane logs `posts.length` per call at info
   and reports `p99PostsLength` in its progress block, so this is checkable
   without a bespoke query;
3. page proxy duty under 5 %;
4. DM and transaction lag unregressed.

**400/day is the ceiling without a fresh owner decision**, and the config
registry enforces it as a refusal (`max: 400`) rather than as a note in a
document. **Holding at 100 because a criterion failed is a SUCCESS outcome of
this package, not a failure.**

**Rejected, and recorded so it is not re-proposed:** issuing the verify POST
because the browser does (§1 excludes it and [E1] proved it unnecessary); marking
a complement `missing_since` from a page that might be truncated (it deletes an
archive one page at a time); a roster keyed on its ref-set hash (a restored
comment stays marked forever); a roster assembled across the pages of one walk
(a partial listing is not a listing); claiming `account_lookup` for this family;
walk columns on `creator_posts` (an ordinary repair would wipe them, which is the
reason `subject_refresh_state` exists); a `SYNC_DOMAIN_POLICY` membership (a
flag-gated analytics lane must not degrade a page's block-health UX to "catching
up" while its gate is shut); and a declared dependency on `notifications` — the
walk reads `creator_posts`, and a notification is only ever a dirty SIGNAL.

---

**Decision #229 (2026-08-22, endpoints-cover WP-F6: the posts widening, and the
counters that were already in the journal):**

**NOTHING NEW WAS CAPTURED TO FILL THESE COLUMNS.** `/timelinenew` has been
serving `likeCount`, `mediaLikeCount`, `replyCount`, `fypFlags`, `expiresAt`,
`inReplyTo`, `inReplyToRoot`, `accountMentions` and `attachments` on every post
object this lane has ever journaled, and `GET /post?ids=` adds `wallIds` on top.
The `posts` family read four of those fields and dropped the rest on the floor.
So WP-F6 is a migration, a canonicalizer version bump and a replay: fourteen
columns on `creator_posts` (0139), `POSTS_CANONICALIZER_VERSION` 5 -> 6,
`post.observed` at schemaVersion 3, and `events:replay --kind posts` to fill the
history — **zero platform calls, on a corpus already in `observations`.**

**ABSENT IS NULL, NEVER 0, and this is the payload that proves the rule matters.**
`replyCount` was present on 9 of the 15 timeline posts in the 2026-08-19 capture
and ABSENT on the other 6. `wallIds` does not appear on the timeline route at all
and is served as `[]` by the batch read. A `NOT NULL DEFAULT 0` on `reply_count`
would have recorded "nobody replied" for six posts whose reply count the provider
never stated, and nothing downstream could ever tell the manufactured zero from a
real one. The columns are nullable, the arrays distinguish absent from empty, and
the parser refuses the WHOLE page rather than half-reading a widened field it
does not recognise.

**EVERY NEW FIELD ENTERS THE CONTENT HASH.** That is what makes this a refresh
lane rather than a mutable row: a like count that moved appends a new immutable
`post.observed` and advances the head, so the archive holds the counter's history
and the projection holds its latest value. An unchanged re-read hashes
identically and only advances `last_observed_at`, so the ordinary six-hourly
timeline walk does not mint a revision per sighting.

**HASHTAGS ARE DERIVED, AND THE GRAMMAR IS NOT `\w+` (A8).** There is no
structured tag field on any of the 60 post objects in the capture — tag ids exist
only in stats aggregation and the discovery feed — so the caption is the only
source, and an ASCII-only class would silently drop every non-Latin caption this
agency actually publishes. The tokenizer takes Unicode letters, numbers and
MARKS, `_`, and ONE defensive trailing `+`. Three columns are written together
and a CHECK enforces the pairing: the raw token exactly as the caption wrote it,
its NFKC-lowercased form (folded BEFORE lowercasing, so a full-width spelling
lands on the ASCII tag rather than beside it), and the parser version that
produced both. The version participates in the content hash, so re-deriving the
tokens under a new grammar mints a new head instead of overwriting the lineage
that produced the old ones — A22-2's lesson in a different key.

**`#teen+` IS NOT AN OBSERVATION.** It appears in no HAR body. The trailing `+`
is tolerated so a caption that types it does not lose the character, the fixture
that exercises it is labelled SYNTHETIC in the test, and no design or doc may
cite the example as live evidence.

**`attachment_refs` IS AN ALLOWLIST, NOT A REDACTION.** Three keys are copied by
name — `pos`, `contentType`, `contentId` — so a `location`, a `variants[]` or any
future URL-bearing key the platform adds to `attachments[]` cannot reach a
serving column, because nothing copies it. The bytes stay in the raw journal,
read by nothing, exactly as WP-F3 keeps `media[].location` there.

**THE VERIFIED TRAP.** `POSTS_CANONICALIZER_VERSION` is embedded in the
`post.tip_parse_rejected` dedup key. The 5 -> 6 bump therefore changes that
family's DEDUP IDENTITY: a re-parse of an already-rejected `post_tips` page
appends one new parse-debt event under `parser:6` beside the `parser:5` one. Both
are projection-only, both describe the same rejection, and a projection rebuild
absorbs the pair. It is written down because it is invisible — no test fails, no
count looks wrong, and a future reader finding two debt events for one rejection
would otherwise have to reconstruct why.

**`post.observed` STAYS PROVIDER-DATED, and that is §3.2b's standing exception
rather than a choice made here.** The event's `occurred_at` IS the post's
publication instant, which is why the driver's `[2024-01-01, now + 2 months]`
clamp can fire on this family at all — a receipt-time family is inside the window
by construction and can never produce a clamp marker, so the marker's presence is
the proof of which kind a lane is. The pre-2024 fixture asserts exactly that:
`occurredAtClamped: true`, `occurredAtRaw` preserved verbatim, `occurred_at`
fallen back to the observation's receipt time, a dedup key unchanged because it
is built before the clamp — **and the projected row still holding the TRUE
publication date**, because the projector reads `data.publishedAt` and never
`event.occurredAt`.

**THE V6 DRAIN, stated the way WP-F0(b) states its own.** Production holds
**1 619** `posts` observations, source `pull`. The v6 bump moves the family's
parse floor, so the minutely sweep re-reads every one of them oldest-first at 200
rows per family per page and up to 20 pages per run — the whole corpus is one
`events:replay --kind posts` (minutes) or two ordinary sweep runs. Each
observation emits one `post.observed` per post in its page, and live pages carry
at most 15, so the upper bound is ~24 000 appends. **Every one is a NEW event and
nothing is overwritten**: the dedup key embeds the v3 content hash AND the
observation id, so the v2 events stay exactly where they are and the head lands
on the newest sighting by the same `last_observed_at` rule that already ordered
them. Because the family is provider-dated, §3.2c(ii)'s target-month census
applies to the drain — and production has every 2026 monthly partition attached
plus the 2024/2025 yearlies, so no month is uncovered and the re-attach ritual is
not needed. The drain makes no platform request.

**THE ENGAGEMENT REFRESH IS A PHASE ON THE EXISTING STREAM, NOT A NEW ONE.** The
bounded timeline refresh walks back 14 days; a post from last spring is never
re-read by it, so its counters are frozen at whatever they were the week it was
published. `GET /post?ids=<csv>` is the only shape that reads a back catalogue by
id — and it returns the SAME envelope the timeline does, so the phase journals
under the EXISTING `posts` kind with `{phase:"engagement", ids}` in the request
params and the v6 family parses it with no new branch, no new stream, no new
flag on the lane and no new dataset. It runs only after the timeline walk has
COMPLETED for the request generation: the timeline is how this system learns a
post EXISTS, and the refresh only updates numbers on posts it already has.

**DECAY, WITH THE BOUNDARIES AS CONSTANTS.** Fresh (<= 30 days) re-read daily,
mid (<= 180 days) weekly, long tail every 30 days round-robin by
`last_visited_at ASC`. How engagement on a post decays with its age is a property
of the platform, not a knob an operator should be turning; what IS tunable is
`fanslyPostEngagementDailyCallBudget`, which decides how much of that decay the
lane can afford. **Due-ness is computed from `published_at` and `last_visited_at`
against `now`, never read from a stored `next_due_at`** — the tier a post belongs
to CHANGES as the post ages, so a frozen due date would keep a post that crossed
from fresh into mid on a daily cadence forever, and lengthening a cycle would
never take effect at all. The column is still maintained (it is the shared
table's contract and what its partial index covers) and the DIRTY path is read
through `dirty_reason`, which no cutoff can suppress.

**THE QUEUE IS `subject_refresh_state`'s THIRD PLANE.** `plane='post_engagement'`,
seeded from `creator_posts` in bounded keyset batches on first enable and — for
everything published afterwards — in the SAME TRANSACTION as the `creator_posts`
upsert, from ONE statement that seeds WP-F5's `post_replies` row alongside it.
WP-F5's argument carries over unchanged: a post committed without its queue rows
is a post the comment walk never reads and the refresh never re-reads, with a
healthy lane, a clean coverage row, and nothing anywhere reporting a problem. The
Fansly-only condition rides in the statement's `WHERE`, so the platform seam
stays where the Stage 18 ratchet expects it and the branch budget is unchanged.

**`engagement_observed_at` IS DERIVED BY THE PROJECTOR, NOT STAMPED BY THE LANE.**
It is the event's own `observedAt` whenever the event carried at least one
counter. Stamping it from the capture lane would have been the obvious thing and
is wrong twice: `creator_posts` is rebuildable, so the next `projection:rebuild`
would wipe it, and the ordinary timeline sighting — which also carries
`likeCount` — would not set it at all, leaving the column reading as "never
observed" for posts whose counters had just been read. It only moves forward, so
a later capture that carried no counters cannot erase the moment the counters
were last seen.

**A `reply_count` THAT MOVED MARKS THE COMMENT WALK DIRTY.** It is the only cheap
evidence this system gets that a post's comments changed, and it costs nothing:
the head upsert already knows the previous value. The mark is written in the same
transaction, with `dirty_reason='reply_count_changed'`, and ONLY on an existing
row — a first sighting is already never-walked and therefore already in WP-F5's
top priority band, so marking it dirty would DEMOTE it.

**THE CAP DEFERS AND NEVER DROPS.** `fanslyPostEngagementDailyCallBudget` (40,
the §6.1 ceiling) is counted in HTTP ATTEMPTS with retries included, lives in the
posts cursor so it survives leases and restarts, and is counted SEPARATELY from
the timeline walk — the timeline is not capped, and letting a refresh phase spend
the capture's budget would trade the thing this system depends on for the thing
that decorates it. A response already fetched is journaled before the counter is
consulted again. `fanslyPostEngagementRefreshEnabled` ships FALSE, and with it off
the posts lane behaves exactly as it did before this package, completion
checkpoint included.

**ONE BATCH PER DISPATCH, THEN JITTER.** At most 100 ids — the size the app
splices for every OTHER `?ids=` route it batches (`requestedAccountIds_`,
`requestedMediaIds_`, `requestedBundleIds_`), read out of its bundle rather than
guessed, since its own `getPosts` has no batching loop to read because its two
live call sites hydrate one or two ids. Then WP-F1's
`fanslyBackfillContinuationDelayMs` +- 30 % jitter, because burst shape and not
daily volume is the ban-risk surface. **Only the posts the response NAMED count
as refreshed**: an id the provider dropped from the batch is recorded as a
failure and retried, because marking it visited would retire it from the
never-refreshed band on the strength of a silence — the same rule WP-F5 applies
to a failed walk.

**MEASURED SIZE, because §6.1's row for this lane predates the measurement, and
the measurement says the row is wrong by more than an order of magnitude.** The
one live `GET /post?ids=` response is 29 375 B uncompressed / 10 232 B on the
wire for a SINGLE post id, and the composition is the whole story: 571 B of
`posts[]`, 6 287 B of `accountMedia[]`, and **22 357 B of `accounts[0]` — the
creator's own full account record, ONE per response whatever the batch size**.
The live `/timelinenew` page gives the same shape at scale: 222 726 B for 15
posts, the same 22 357 B `accounts[0]`, and 186 119 B of `accountMedia[]` over 23
media rows — i.e. **~7–13 KB per post once its media travel with it**. So a full
100-id batch is **~0.7–1.4 MB uncompressed / ~0.24–0.41 MB on the wire**, and 20
calls/day is **~14–28 MB/page/day**, not the ~1 MB §6.1 books for this row. At
lora-1's steady state (~2 calls/day for 1 318 posts under the decay) the lane
costs ~1.4–2.7 MB/day; its one-off first pass is 14 calls and ~10–19 MB; the cap
of 40 bounds it at ~28–56 MB/page/day. A23 removed disk as a limiter, so this is
REPORTED and deliberately not gated — but §6.1's byte column for this row must be
re-derived from the measurement rather than from the planning figure, and any
later fleet arithmetic that adds it up must use these numbers.

**THE `accounts[0]` SIDECAR IS NOT TRIMMED, deliberately.** It carries
`lastSeenAt`, which moves every minute and defeats the content-address dedup
collapse — the [A20] problem exactly. It is left verbatim here because the
EXISTING timeline lane already journals the identical 22 357 B record on every
page of every walk, and trimming one response of a kind while leaving the other
verbatim makes two bodies of the same kind un-comparable and the kind's dedup
behaviour unexplainable. Recording the cost is the honest move; fixing it means
changing the timeline lane's capture, which is a decision of its own and not one
this package was asked to make.

**Rejected, and recorded so it is not re-proposed:** a new stream or a new page
allowlist for the phase (it rides `posts`, which already has its own gating, and
a second allowlist is a switch nobody remembers to look at); tier boundaries as
config keys (they describe the platform, not a preference); stamping
`engagement_observed_at` from the capture lane (wiped by the next rebuild, and
blind to the timeline sighting that already observed the counters); storing the
caption's mention offsets or handles (the verbatim caption is in the journal and
a handle changes, while the account ref does not); a fan-scope erasure predicate
on `account_mention_refs` (they are CREATOR refs — on the one live example the
post mentions the page's own account — and a predicate there would delete the
creator's own caption history to forget somebody else); and widening the `posts`
or `post_monetization` agent datasets with the new columns (the read surface is a
separate decision, and this package was scoped to storage, canonicalization,
projection and capture).

---

**Decision #230 (2026-08-22, endpoints-cover WP-F7: the payouts lane, and the
mask that has to be ours):**

**TWO ROUTES, AND THE THIRD WAS A DUPLICATE OF SOMETHING THE KERNEL HAS RUN
SINCE 2024.** The plan's WP-F7 named three routes and WP-F8 named a fourth. A28-8
removed `/account/wallets/earnings` because it is already `getEarningsOverview`
in the adapter — which also removes the `page_wallet_snapshots` table the plan
specified, since this package now adds no wallet-balance read at all. A28-1
removed the whole of WP-F8: `GET /account/wallets/earnings/transactions` is the
EXISTING `transactions` stream, which calls it with `limit=100`, runs a
full-history `offset_head_scan` backfill on page connect and then increments.
That was settled by IDENTITY, not by resemblance — seven transaction ids taken
out of this lane's own 2026-08-20 capture HAR, newest, middle, and the oldest row
on page 242 of 242 (`754098287358779392`, 2025-03-06), all found in
`transactions` under lora-3 with the same dates, types, amounts and
`correlation_account_id`, against 49 004 journaled responses under the same
`endpointTemplate`. A second lane on that route would have been a duplicate money
ledger with its own parser and its own bugs, and its "one-off ~242-call backfill"
would have re-walked a history the kernel already holds.

So WP-F7 is: `GET /payments/payoutmethods` and
`GET /payments/payout/requests?before=&after=&limit=10&offset=N`. Both GET, both
loosely typed, both journaled before anything asserts on their shape.

**THE CREDENTIAL RULE, AND WHY THE MASKING HAS TO BE OURS.** `metadata` arrives
as a JSON-ENCODED STRING — a string containing JSON, decoded in the
canonicalizer and never in SQL — and the two live providers are asymmetric in
exactly the way that decides the design:

- **providerId 2 is Paxum, not PayPal.** `reference/fansly_api_spec.md:1404` says
  PayPal; A22-4 refuted it from the app bundle, which renders provider 2 with
  `/assets/images/psps/paxum.webp` and names Paxum in its compliance copy. The
  wrong processor's name on a money-out record is not a cosmetic error.
- **Provider 2 returns the creator's FULL email address in plaintext.** Provider
  30 (USDT) returns `field0…field10` where `field1` is ALREADY server-masked (38
  `X` plus four visible characters).

One provider hands us a credential and the other does not, so "mask what the
platform masks" is not a rule — it is a coincidence that held for one of two
providers. `masked_label` is therefore OURS, and it is the ONLY value derived
from `metadata` that ever leaves this family:

- an address becomes **`<first character>***@<domain>`** — one character of the
  local part, a FIXED three asterisks (a length-preserving mask leaks the
  length), and the whole domain, because the domain answers "which processor
  account is this" for an operator and the local part is the half that
  identifies a person;
- a wallet field becomes **`****<the four visible characters>`**, which is what
  the UI itself renders as "ending in …".

**AND THE SHAPE IS ENFORCED BY THE DATABASE, not promised by the parser.**
Migration 0141 CHECKs that a `masked_label` containing an `@` matches
`^.\*\*\*@[^@]+$`. A full address cannot satisfy it, so a canonicalizer
regression that let one through fails at the INSERT rather than at a code review.
The integration suite asserts it from three directions: the table holds the mask
(checked on VALUES, not on the column list, so a future column carrying the
address would fail), the JOURNAL still holds the full address verbatim, and a
direct INSERT of a full address is rejected.

**THE DECODE IS PROVIDER-KEYED, NOT SHAPE-KEYED, and that is the whole defence
against the provider nobody has met yet.** A future provider 99 with its own
`field0…fieldN` wallet payload decodes to NOTHING: no branch matches it,
`masked_label` is null, `provider_label` is `unmapped:99`, and not one character
of its metadata enters an event or a projection. A shape-keyed decoder — "looks
like fields, mask `field1`" — would have published whatever that provider chose
to end `field1` with, and would have had no opinion at all about a recovery
phrase in `field3`. The adversarial fixture carries exactly that shape.

`metadata` that is not valid JSON lands the row with `metadata_parse_ok = false`,
a null label and one diagnostic; the unreadable string stays in the journal. The
row is still written, because a method we could not read and a method with
nothing to read are different facts and only that flag tells them apart.

**CAPTURE-FIRST IS NOT SUSPENDED FOR CREDENTIALS.** The raw body is journaled
verbatim and kept 100 years under DP 7. That is deliberate: the mask is a
PROJECTION rule, and an over-eager scrubber at the journal would have destroyed
the only copy of the fact a rebuild replays from. What is closed instead is the
serving side — neither `payout_methods` nor `payout_requests` is on
`AGENT_OBSERVATION_PAYLOAD_ALLOWLIST`, which is an ALLOWLIST and fails closed, so
absence IS the enforcement. Both are also named on the DENYLIST with their
reason, so a future widening has to delete a sentence rather than add a word, and
`tests/fansly-payouts-restricted.test.ts` pins the absence — an absence nothing
checks is an absence somebody deletes.

**THE STATUS MAP IS ONE CODE DEEP AND SAYS SO.** All 83 payout requests on the
walked page carried `status = 8`, whose UI label is `Processed`. Every other
payout status is unknown. So `8` is never treated as "the success code" in any
conditional: the projection stores `(status_code, status_label,
status_confidence)` together, an unknown code becomes `unmapped:<code>` and
`unmapped`, and the capture handler raises ONE
`fansly_payout_status_unknown` anomaly per unseen code per page, remembered
durably in the cursor so the next day's sweep is silent. **The row is still
projected** — dropping the codes we cannot name would make the history quietly
agree with itself and disagree with the platform. A payout that failed, was
cancelled or was reversed reported as "Processed" is money the agency believes
arrived. (A22-3 names five values for the WALLET status enum; that is a different
enum on a different route, and importing it here would be exactly the guess this
rule forbids.)

Payout method `type` (1), `flags` (0) and `status` (3) had NO rendered label
anywhere in the walked UI, so they stay RAW INTEGERS and are never given invented
names. Provider labels are read-time: the integer is what is stored.

**MONEY IS MILLS AND NOTHING SCALES.** `amount` is already mills on the wire —
the same unit the kernel uses — proved against the rendered UI on seven
independent fields ($131 = 131 000, `pendingBalance` 2 102 632 = $2 102.63). The
value travels as a decimal string through `millsString` → `millsFromInteger`, the
column is `bigint`, and a negative or fractional amount is refused rather than
rounded: a plausible-looking rounded number is worse than an honest null, because
it can be summed.

**TIME.** `createdAt` and `updatedAt` are 13-digit Unix ms, decoded by an
ms-ONLY helper rather than the seconds-or-ms heuristic the other Fansly families
need — this family has no seconds field anywhere, and a heuristic that could be
wrong will be. Every event is RECEIPT-TIME (§3.2b): `occurredAt` is the
observation's `receivedAt` and the provider instant is a typed field in `data`.
That is load-bearing here rather than ceremonial — the walked history reaches back
to 2025-06-23, `domain_events` is monthly-partitioned, and a provider-dated draft
would fail `ExecFindPartition` (23514) forever. A pre-2024 fixture asserts the
event carries no clamp marker while the projection keeps the true date.

**THE WALK, AND THE NINE CALLS.** `/payments/payout/requests` is OFFSET-paged at
10: `total = 83`, oldest 2025-06-23, nine pages walked live. `before` and `after`
are sent PRESENT AND EMPTY, exactly as the app sends them on all nine observed
calls — an omitted parameter is a different request, and `/media/vaultnew`
already taught this initiative that a guessed cursor form returns an empty page
for a 4 760-item album, indistinguishable from an exhausted one. Whether
`limit > 10` is honoured on THIS route has never been measured (the one
authorized probe answered it for `/earnings/transactions`, a different route), so
10 is assumed rather than believed.

The daily head read at `offset=0` IS page one of the walk on the day the lane is
enabled, which is what makes the whole history NINE request calls and not ten.
After that the walk is done and the lane costs exactly TWO calls a day: one
method listing, one head page. The cap is **20 attempts/page/UTC-day** — §6.1's
corrected number, which was 8 before the ledger was believed to ride this lane
and stays 20 after the ledger turned out to be a duplicate, because 20 is what
lets the nine-call walk finish on the day the gate opens. It DEFERS to the next
UTC day and never drops a response already fetched.

**THE REPEAT-REQUEST GUARD GAINED A SECOND TRIGGER, BECAUSE THE FIRST ONE COULD
NOT FIRE.** The plan specifies "same offset twice ⇒ stop + anomaly". On an offset
walk the offset ALWAYS advances by construction, so that check can only catch
corrupted cursor state — which is real (a crash mid-save produces it) but is not
the failure this route can have. A server that IGNORES `offset` and serves page
one forever would have walked to the page cap, spending the day's budget
re-reading the same ten rows, with the guard watching an integer that could never
repeat. So the guard keeps the offset check (spent before any egress) and adds
the one that answers the same question from the other end: **a page whose FIRST
ROW is the first row of the page before it.** Either trigger stops the walk with
one anomaly, and the page that proved it is still journaled — it is evidence
about the provider, and a guard that dropped it would leave nothing to diagnose.
This was found by writing the test that was supposed to prove the guard worked.

**THE ROSTER, AND WHAT DOES NOT GET ONE.** The method listing is a FULL array, so
it emits `payout.method_list_observed` per LOOK — keyed on the observation id,
not on the ref set, because a method removed and re-added UNCHANGED hashes to the
roster it had before it vanished, so a set-keyed event would dedupe and the row
would stay marked `missing_since` forever while the platform served it again
(the correction WP-F3's projection test found, inherited here). The projector
applies it in BOTH directions: mark the complement, clear the mark on everything
the set still names. Payout REQUESTS get no roster: they arrive from an
offset-paged walk, and a roster built from one page of ten would mark the other
seventy-three missing while the next page un-marked them.

**NO FAN REFS, AND THAT IS A PROPERTY OF THE DATA.** Both tables are page-scope —
these are the CREATOR's own payouts. `method_ref` and `payout_ref` are the
platform's own ids for the page's own rows, so no column here is fan-ref-shaped
and the §9.3 erasure column ratchet has nothing to bind to. That is not an
exemption and no justification entry was added.

**Rejected, and recorded so it is not re-proposed:** a wallet-balance route or a
`page_wallet_snapshots` table (A28-8 — `/account/wallets/earnings` is already
`getEarningsOverview`); a second reader of
`/account/wallets/earnings/transactions` (A28-1 — it is the `transactions`
stream, verified by id); a shape-keyed metadata decoder (it publishes an unknown
provider's payload); scrubbing the credential at the journal (it destroys the
only copy of the fact, and the mask can be replayed while the fact cannot);
importing A22-3's five-value wallet status enum onto payout `status` (a different
enum on a different route); naming payout-method `type`/`flags`/`status` (no UI
label was ever rendered for them); a `SYNC_DOMAIN_POLICY` membership (a
flag-gated lane must not degrade a page's block-health UX to "catching up" while
its gate is shut — `domain: "financials"` is a label, not a membership); and a
`missing_since` column on `page_payout_requests` (a payout that happened does not
un-happen).

---

**Decision #231 (2026-08-22, endpoints-cover WP-F4: per-media statistics, and
the one lane that can overload the platform):**

**WHY THIS LANE GETS ITS OWN ENTRY AND ITS OWN REVIEW (A30).** Every other
package in this initiative reads a bounded surface: a page has one account
statistics response, a few dozen payout rows, some thousands of posts. This one
is `M` calls wide, where `M` is the whole media catalogue, and it is the only
lane in the design that is EXPECTED to spend its entire daily budget every day.
Everything below follows from that.

**A16'S TABLE IS REPORTED, NEVER RESTATED.** The decay's demand is
`R = H + Mid/7 + L/cycle` and the long tail's real cycle is whatever budget is
LEFT once the daily and weekly tiers have taken theirs —
`L / (cap − H − Mid/7)`. At the owner's stated 5-media-a-day publication rate
that reproduces A16 exactly: M = 2 000 ⇒ 294 calls/day and a 26-day cycle;
M = 5 000 ⇒ 394 and **96 days, which is QUARTERLY**; M = 10 000 ⇒ 560 and 212;
M = 20 000 ⇒ 894 and 446. Four tests pin those four rows. The weekly term is
deliberately NOT rounded before it is applied — round it and M = 5 000 reports 98
days where the owner's table says 96, which is a different design being
described. **Nothing is dropped at any M**: every item is still visited
round-robin, just less often. But a long tail described as "monthly" while it is
quarterly is a lie the plan must not tell, so `estimatedCycleDays` is computed on
every dispatch from the LIVE class census and the LIVE cap, and the log line says
"QUARTERLY or worse, not monthly" in words once it passes 90 days. It is never a
documentation constant.

**THE CAP IS THE WHOLE ENFORCEMENT, AND SATURATION IS THE DESIGN.**
`fanslyMediaStatsDailyCallBudget` ships at 300 — the number A16 sized the decay
against — counted in HTTP **ATTEMPTS** (retries included; a cap in logical calls
lets a retry storm multiply real egress by up to the adapter's retry limit, which
on this lane is the difference between 300 and 1 200 requests a day). §6.1 exempts
this lane from the "P95 under 70 % of its own cap" rule BY NAME: it is built to
run at 100 % when M is large, and it reports due-backlog and cycle stretch
instead. Raising the cap toward what the decay wants is a NAMED per-lane step —
one lane, one value, owner-approved, backed out on any 429 or latency regression
— and the registry ceiling of 1 000 is what makes a raise past it a refusal
rather than a note in a document. Crossing the cap **defers to the next UTC day
and never drops**: the response already fetched is journaled before the cap is
consulted again, and a test spends a two-attempt call across the boundary to
prove it.

**THIRTY-ONE DAYS, NOT A HUNDRED — and the plan is overridden on evidence.**
The plan specifies 100-day backfill windows on the strength of
`datapointLimit: 100`, which says a window may CARRY a hundred buckets and never
said the provider would honour a hundred-day one. On production 2026-08-22
`/it/amoie/stats` answered a 100-day window with its own DEFAULT trailing 31
days, 200 and all, and the walk that derived its next window from THAT re-issued
the same request until the day's cap was gone — 25 byte-identical responses, one
dedup object id. The 2026-08-19 HAR proves `/it/moie/statsnew` honours a
HISTORICAL 31-day window exactly (`beforeDate 2026-08-01 / afterDate 2026-07-01`
came back `dateBefore 2026-07-31 / dateAfter 2026-06-30`), so **the per-media
backfill walks in 31-day windows**, deriving each next window from the RETURNED
bounds with one day of overlap because the provider snaps to its own bucket grid.

**THE FINDING THAT COST A TEST RUN TO SEE, WRITTEN DOWN SO NOBODY RE-DERIVES
IT.** `windowWasHonoured` — F1's loop guard, reused verbatim here — **cannot
detect the 90-day long-tail refusal**, and the reason is structural rather than a
bug. That refresh is a TRAILING window, so a provider answering it with its
default trailing 31 days returns a window with the SAME END and a nearer start:
nothing reaches newer than we asked, nothing is disjoint, and the guard correctly
reports no contradiction — there is none. What there is, is 59 days we asked for
and did not get. So the 90-day probe checks COVERAGE as well (`served.afterMs`
within a day of `requested.afterMs`), and the loop guard is left exactly as F1
wrote it. The discovery is durable, page-scoped and announced ONCE, because it is
a property of the ROUTE and because falling back to three 31-day windows TRIPLES
what a long-tail visit costs — which the progress block reports rather than
hiding.

**THE QUEUE IS NOT A PROJECTION, AND THE TEST IS THE POINT.** Rows live in
`subject_refresh_state` (`plane='media_stats'`, §3.4's third state class), which
no `projection:rebuild` truncates. v1 proposed four queue columns on
`creator_media`; a rebuild — an ordinary repair, run by an operator fixing
something else entirely — would have wiped them, re-marked the WHOLE catalogue as
first-sight and released a per-media backfill storm bounded only by this lane's
own daily cap, because [A19] removed the global per-page one. The explicit test
truncates and replays `creator_media` from the ledger and asserts the queue comes
back byte-for-byte: the visit stands, the cycle stands, the backfill is still at
its floor. Seeding is bounded keyset batches on first enable AND — for anything
projected afterwards — the SAME TRANSACTION as the `creator_media` upsert, the
F5/F6 precedent: a media row committed without its queue row is an item the lane
never looks at, with a healthy lane, a clean coverage row and nothing anywhere
reporting a problem.

**CLASSES ARE COMPUTED FROM AGE AT READ TIME, NEVER READ OFF `refresh_class`.**
The tier an item belongs to changes as the item AGES and the long-tail cycle is a
LIVE config key, so a stored class freezes each row at the tier and the cycle in
force when it was last visited — an item that crossed from fresh into mid would
be re-read daily forever. The column is still maintained (it is the shared
table's contract and what its partial index covers) and the DIRTY path is read
through `dirty_reason`, which no cutoff can suppress. The age basis is
`created_at_platform`, or FIRST SIGHT where the platform served none —
`publicationTimeBasis='first_seen'`, classed fresh for 30 days, and never an
invented date. Every live `creator_media` row carries a platform date today (0
NULL across the fleet); the fallback exists because media first seen in a
statistics aggregation may not.

**TWO SIGNALS JUMP THE QUEUE, AND ONE OF THEM IS FREE.** WP-F2 has been marking
purchased media dirty since it shipped (`dirty_reason='purchase_notification'`)
and fetching nothing — this is the consumer those marks were waiting for. Beside
it, the CURRENT top-50 of `stats_top_media` is promoted once a UTC day for ZERO
platform calls: the account response already ranks the page's media and F1 already
projects it, so an item that has just entered the top-50 gets today's call
instead of its class cadence. Once a day, not every dispatch — re-marking would
keep fifty items permanently dirty and starve the round-robin — and never an item
visited within the last day.

**FOUR CONFIG KEYS AND ONLY FOUR.** The three age-class boundaries and the
per-tier window spans are CONSTANTS with their derivation in the comment beside
them: they describe how a media item's traffic decays with its age, which is a
property of the platform rather than a knob an operator should be turning, and a
test pins that no key by those names exists. What IS tunable is what A6 asks to
be tunable — the long-tail cycle — plus the ramp flag, the FAIL-CLOSED page
allowlist (S4; the fail-OPEN semantic here would have started a 300-call-a-day
walk on every Fansly page on the deploy that shipped the lane) and the daily cap.

**[E5]: THE VIDEO COLUMNS STAY NULL AND UNPROMISED.** All six observed
`/it/moie/statsnew` responses carried exactly seven stat keys —
`{type, views, previewViews, uniqueViewers, previewUniqueViewers,
interactionTime, previewInteractionTime}` — and NO video fields, even though the
polled asset is `media.type = 2, mimetype = video/mp4`. The columns exist because
the ACCOUNT-level media datapoints DO carry them. Absence is absence: those
columns are NULL for `subject_kind='media_offer'` rows, the read layer must not
coalesce them, and nothing in the dashboard, the datasets or §12 may claim
per-media watch metrics until [E5] settles.

**THE PARSER F1 LEFT AS A STUB WOULD HAVE PARSED EVERY BODY TO NOTHING.** It
looked for `mediaOfferId`; the route serves `dataset.datasetMediaOfferId` (6/6
live responses). Completed here in the ONE `fansly-stats` family — not a second
registration — with one new event type, `media_tag.stats_observed`, registered in
`PROJECTION_ONLY_DOMAIN_EVENT_TYPES` in the same change that taught the parser to
mint it. It carries the per-media `topFypTags` rows, the finest FYP attribution
Fansly exposes, with the tag name joined from the response's own
`aggregationData.tags[]` and NULL where that join misses — never fabricated from
the id. The WINDOW is part of that row's identity, because rank 2 of one window
is not the same fact as rank 2 of the next. `fansly_media_tag_stats` was created
by 0132 and left empty on purpose; this is what fills it.

**Rejected, and recorded so it is not re-proposed:** shrinking the lane to
"fresh + top-50" (A28-3 kept it as planned — all media, age-decayed, 300/page/day);
a `capture_coverage` row per media (it would be a second queue of the same
cardinality in a table whose contract is "how far back does this plane reach" —
one page-scoped row, and the per-look history is a query over the journal, A21);
100-day backfill windows (the plan's number, refuted by F1 on production and by
the HAR); config keys for the age boundaries or the window spans (they describe
the platform, not a policy); a `SYNC_DOMAIN_POLICY` membership (a flag-gated lane
must not degrade a page's block-health UX to "catching up" while its gate is shut
— `domain: "audience"` is a label, not a membership); five-minute buckets, which
#225 already declared a deliberate non-goal and which would multiply this lane's
calls again; and any promise of per-media watch metrics before [E5].
