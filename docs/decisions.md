# Agency Hub — Technical Decisions

This is the living register of durable, non-obvious constraints. Start with the Quick
Reference, then search the numbered body. Build/session history belongs in Git or
`docs/decisions-archive.md`; temporary work belongs in `backlog.md`.

A new entry is justified only when it constrains future changes. Keep it to rule, reason,
enforcement point, and exit condition; do not append branches, hashes, test counts, review
rounds, or deployment narration (#235).

## Quick Reference

| # | Area | Current rule / status |
|---:|---|---|
| 1 | Language | TypeScript + Node.js 22 LTS |
| 2 | Workspace | pnpm workspaces only — no Turborepo/Nx build-graph layer until build times are a measured problem. |
| 3 | Backend Framework | Historical implementation record archived; no current constraint lives in its body. |
| 4 | Frontend | React 19 SPA with Vite and TanStack Query |
| 5 | Frontend Router | Historical implementation record archived; no current constraint lives in its body. |
| 6 | Frontend Client State | Zustand holds cross-component client-only UI state (filters, date ranges, toggles); server state stays in TanStack Query. |
| 7 | UI Layer | Tailwind CSS with shadcn/ui components vendored into the repo; no external component-library dependency boundary. |
| 8 | Database | PostgreSQL 16 |
| 9 | ORM / Query Layer | Drizzle ORM plus handwritten SQL for reporting queries |
| 10 | API Style | REST JSON under /api/v1 with URL-based versioning; no tRPC — every client (dashboard, extension, scripts) gets one plain HTTP contract. |
| 11 | API Contracts | OpenAPI and typed clients are GENERATED from the Zod route schemas — the schemas are the single contract source, never hand-edited output. |
| 12 | Dashboard Auth | Dashboard humans authenticate with Argon2id passwords over HttpOnly Postgres-backed sessions — server-side sessions so revocation is immediate; no JWT sessions. |
| 13 | ChatMuse Auth | Human-bound clients use revocable bearer API keys or device tokens; page access is enforced server-side, never by the client |
| 14 | Authorization | Page-scoped RBAC for `owner`, `team_lead`, `chatter`, `content_manager` |
| 15 | Money | Store monetary amounts as `BIGINT` mills plus `currency` and raw source amount |
| 16 | Time Handling | Store UTC `timestamptz` in DB; use UTC business dates for product analytics |
| 17 | Reporting Period Semantics | Backend computes UTC business-date boundaries; trailing windows include today |
| 18 | Platform Adapters | Strict adapter boundary per platform with canonical normalized DTOs |
| 19 | Fan Identity | `(platform, platform_user_id)` plus per-page relationship rows |
| 20 | Proxy Handling | Per-page proxy configuration in DB, applied inside adapters |
| 21 | Secret Storage | Encrypt platform tokens and proxy credentials at rest |
| 22 | Sync Scheduler | Historical implementation record archived; no current constraint lives in its body. |
| 23 | Runtime Roles | One image starts API, worker, or scheduler through `apps/runtime/dist/startup.js`; cross-role work uses Postgres (pg-boss and LISTEN/NOTIFY), with no RPC service |
| 24 | Caching / Redis | No Redis in v1; use Postgres rollups, Postgres prompt cache, and in-memory short-window limiting |
| 25 | Client Protocol | REST for normal endpoints; SSE for AI and event streams; no WebSockets |
| 26 | AI Gateway | Core owns provider custody, authorization, quotas, usage/cost accounting, and restricted prompt/completion capture; clients have no direct provider fallback |
| 27 | Notifications | Alerts persist to the DB first, then deliver to Telegram asynchronously through pg-boss; recurring failures collapse into one open incident plus one resolved… |
| 28 | Raw Payload Retention | Captured business facts are retained for 100 years and are never deleted on a schedule. The only sanctioned deleters are the pinned erasure paths; bounded operational… |
| 29 | Sync Idempotency | Checkpointed syncs: upsert raw events first, then rebuild projections |
| 30 | Transaction Taxonomy | Compact 9-bucket internal enum with adapter mappings |
| 31 | Notes / Summary History | Append-only notes; summaries append new versions instead of overwriting |
| 32 | Reporting Rollups | Precomputed daily fact tables for revenue, followers, and subscribers |
| 33 | Logging | Pino structured JSON logs |
| 34 | Migrations | Forward-only Drizzle SQL committed to git and applied under an advisory lock at role startup; deploy owns migration safety guards |
| 35 | Env Config | Shared typed config with Zod validation at startup |
| 36 | File Storage | Postgres text/JSON remains the default storage boundary. Rendered voice audio is the single explicit bounded binary exception under #174; adding another binary class… |
| 37 | Testing | Historical implementation record archived; no current constraint lives in its body. |
| 38 | Deployment | Docker Compose on one VPS with Caddy |
| 39 | CI/CD | GitHub Actions verifies changes; owner-gated workstation deploys use `scripts/deploy-production.sh` over SSH |
| 40 | Code Quality | ESLint is the enforced code-quality gate. This repository has no general Prettier dependency, configuration, or formatting command, so no decision may claim that it does. |
| 41 | Backups | The off-box backup requirement was withdrawn by #161. Recovery policy must not silently reintroduce external backups as a release gate. |
| 42 | Health Checks | Lightweight `/api/v1/health` plus protected detailed sync health |
| 43 | Audit Trail | Append-only audit log for sensitive admin actions |
| 44 | Fansly Auth Headers | Only `authorization` header is required; `fansly-client-id`, `fansly-client-check`, `fansly-session-id` are optional — include when available, omit when not |
| 45 | Payout Reversal (16013) | Fansly raw_type 16013 maps to `payout_reversal` — store in transactions for audit, but exclude from net revenue calculations and `daily_revenue` rollups |
| 46 | Revenue Classification | Transactions carry classification metadata with four reporting buckets (revenue / adjustment / unclassified / excluded); netEarningsMills = revenue + adjustments +… |
| 47 | Dashboard Fan Navigation | Keep `fan` as an internal CRM/data model and API concept, but do not ship a standalone dashboard `Fans` section by default; only surface it when the UI delivers… |
| 48 | OFAPI Real-Time Pipeline | OFAPI webhook receiver (raw-body HMAC, header-based dedupe, journal table) + pg-boss async processing + SSE fanout `GET /api/v1/events/stream` with `Last-Event-ID`… |
| 49 | OFAPI DM sync and account health | OnlyFans DM integration phases are: Phase 1 ingest, Phase 2 ledger, Phase 3 connection/health. Ingest is webhook-first and projection failure never aborts… |
| 50 | OFAPI credit ledger | The core OFAPI client is the single spend tap — every response that reached the server parses _meta and writes an append-only ofapi_credit_ledger row plus the day… |
| 51 | Mixed-platform revenue windows | OnlyFans trailing windows are one calendar day wider and the difference is disclosed. |
| 52 | OFAPI DM cold archive | A messages.deleted event is an archive TOMBSTONE, not an erasure request: the row keeps its text and sanitized media metadata, must carry deleted_at explicitly, and a… |
| 53 | OFAPI sync snapshot | An empty SSE replay must be distinguished from a cursor that fell behind retention: a stale Last-Event-ID gets 409 sync_snapshot_required and a cursor ahead of the… |
| 54 | OFAPI Desktop Read Gateway | The desktop read gateway is a fail-closed GET-only allowlist — every path segment and query name/value validated, no wildcard method proxy, no writes — and the core… |
| 55 | OFAPI Command Outbox | Core owns a versioned command outbox with no generic path/method proxy: dedupe on (page_id, chatter_user_id, client_command_id) never derived from message text, retries… |
| 56 | OFAPI Command Executor | Exactly one HTTP attempt per durable command row: a stale in_flight row becomes indeterminate and never returns to queued; definite 4xx is terminal, 429 is… |
| 57 | DM Aggregate Analytics | DM analytics is aggregate-only over the cold archive: one row per page/UTC day with no transcript text, media metadata or fan identifiers; the table is disposable… |
| 58 | OFAPI Typing Command Custody | The typing beacon rides the OFAPI command outbox as `typing_active_v1` (empty payload, one attempt, no retry lineage, 2-minute dedupe horizon with terminal rows… |
| 59 | OFAPI Unsend Command Custody | `unsend_message_v1` is one DELETE attempt through the outbox with `{messageId}` as the entire payload; `retryOfCommandId` is rejected because a second DELETE after an… |
| 60 | OFAPI Mark-Read Command Custody | `mark_chat_read_v1` is one POST through the outbox with an empty payload and no retry — read-state mutation gets the same one-attempt custody as sends; confirmation… |
| 61 | OFAPI Media/PPV Send Command Custody | `send_media_message_v1` sends only already-existing OFAPI media ids (price 0 or 3–200, bounded mediaFiles/previews, no URLs or file bytes); local file upload is… |
| 62 | Fansly server-replay gate (Pass 3 Stage 6) | Fansly earnings-stats, monthly-stats and PPV order-history replay server-side from the kernel with the single pasted `fansly-client-check`; no per-route anti-bot token… |
| 63 | Kernel retention & redaction stand-down (Pass 3 Stage 1) | Retention for the webhook journal, DM cold archive and sync raw payloads is 36500 days in env AND code default, so a missing env can never re-enable a purge; the… |
| 64 | Pass 3 spec fixup (pre-execution review) | Key-table inserts against partitioned journals pre-allocate the id via `nextval(pg_get_serial_sequence(...))`, the key row carries it, and the journal/event row inserts… |
| 65 | Kernel destruction-door guards + chatter-read-scope (Pass 3 Stage 2) | Raw revenue/transaction routes require an owner/team_lead dashboard session on top of page scope (`REVENUE_ROUTE_ROLE_ENFORCEMENT`, log→enforce); one-action data-loss… |
| 66 | Desktop stop-loss (Pass 3 Stage 4) | The desktop client never self-deletes captured facts: the usage spool dead-letters instead of dropping (no `dropped` outcome exists at the type level), prune horizons… |
| 67 | OnlyMonster export is vacuous (Pass 3 Stage 5) | No OnlyMonster-sourced data exists (lora-of 685/685 and lora-vip-of 2168/2168 rows are OFAPI-sourced, zero vendor egress); no export lane is built and canonicalizers… |
| 68 | Stages 1/2/3/5 exit | Historical implementation record archived; no current constraint lives in its body. |
| 69 | Stage 4 desktop reconcile | Historical implementation record archived; no current constraint lives in its body. |
| 70 | Release ops (Stages 4/6/7) | Historical release session: the owner delegated a bounded set of deploy/release actions and each gated action was confirmed during that session. It did not establish a… |
| 71 | Stage 13 provenance | Every transaction row carries its source provenance and only the page's declared `transactions_writer` may write it (a NULL-writer page is refused for every writer, and… |
| 72 | Stage 13 deploy/verify | Page deletion is a soft delete that deliberately keeps credentials, egress endpoints and fact rows for undelete; the provenance backfill left revenue totals… |
| 73 | Stage 8 domain events | domain_events is partitioned monthly with a gapless per-account seq and cross-producer content-hash dedup (the same fact arriving as webhook and as REST page yields one… |
| 74 | Stage 9 read-gateway capture | Every read-gateway 2xx is teed verbatim into the journal after the response is sent, through a bounded queue that is fail-open for that producer only (drop counter plus… |
| 75 | Stage 10 message archive | message_archive is a rebuildable projection: an event-fed writer advances per-account seq watermarks, one command reproduces identical counts from the event ledger,… |
| 76 | Stage 16 Fansly earnings | Fansly PPV order history is per-fan and cursorless, so back-scroll is a checkpointed keyset walk over page_fans whose cursor reset means incremental refresh; ramp gates… |
| 77 | Stage 17 Fansly backscroll | Fansly DM canonicalizers stay pure — message direction is resolved from a per-run page→native-account-ref context passed in as an argument, never looked up inside the… |
| 78 | Stage 16 parse side | Fansly earnings/PPV shapes may be derived from the extension's production parsers rather than waiting for live capture (a trusted shape source already exists).… |
| 79 | Stage 13 exit | Historical implementation record archived; no current constraint lives in its body. |
| 80 | Stage 14 OFAPI transactions | The OFAPI data-exports lane is priced and NOT adopted: a full REST marker-walk of both pages' entire history is ~30 credits against a 200/day backfill budget, so the… |
| 81 | Stage 14/4 follow-ups | tips.received is declared as its own `tip.received` domain event keyed `tip:<notificationId>` with the fan taken from `payload.user.id` (top-level user_id is the… |
| 82 | Stage 11 ingest lane | The ingest batch remains bearer-only, bounded, and whole-batch atomic. Its original claim that `client_capture` emits no domain events is superseded by the v2 family in… |
| 83 | Stage 12 desktop harvest | `harvest.<table>` kinds are accepted only under producer `desktop-harvest@<version>`, and account resolution happens at INGEST (payload.ofapiAccountId →… |
| 84 | Pre-merge review wave 1 | Historical implementation record archived; no current constraint lives in its body. |
| 85 | Pre-merge review wave 2 | Historical implementation record archived; no current constraint lives in its body. |
| 86 | Pre-merge review wave 3 | Historical implementation record archived; no current constraint lives in its body. |
| 87 | Stage 19 declarative auth | All routes declare authorization and the declarative middleware is enforced. The in-handler checks are intentionally retained as the second isolation layer under #143;… |
| 88 | Stage 19 module extraction | Historical implementation record archived; no current constraint lives in its body. |
| 89 | Stage 19 composition root | Route modules own their declarations while the server remains a composition root. Authorization cleanup promised by the original stage log is cancelled by the… |
| 90 | Stage 20 generated SDK | @kernel/sdk stays deliberately tiny — an operations manifest plus re-exports, with per-operation request/response types MAPPED generically off `typeof routeSchemas`;… |
| 91 | Stage 20 dashboard adoption | The dashboard reaches the kernel only through @kernel/sdk — no direct fetch in `src/api`, no resurrected client.ts — and the ban is enforced by a TEST… |
| 92 | Stage 21 event stream v2 | Event-stream v2 frames are `{accountId, accountSeq, type, occurredAt, data}` and `type` is open. Resume uses an opaque strict-decoded cursor; per-account 409 covers… |
| 93 | Stage 22 identity | Sessions, device tokens, and append-only access grants remain the identity model. `ACCESS_GRANTS_READ_ENABLED` is still default-off, so legacy authorization and… |
| 94 | Stage 23 workboard module | Workboard claim leases are SOFT coordination, not access control: a second chatter's claim steals the lease (last-writer-wins, never blocks), and page scope on an… |
| 95 | Stage 24 desktop kernel client | Clients consume a compiled vendored SDK, use stream-v2 opaque cursors, and perform no direct OFAPI reads. Payloads ride Stage 24 as defined by #92; typing alone uses… |
| 96 | Stage 25 scheduler + signals | Cron registration lives in exactly one place (services/schedules.ts) and fires only from the leader-elected scheduler role — api and workers must construct pg-boss with… |
| 97 | Stage 27 money codec | Money brands are compile-time only (Mills = bigint brand, MicroUsd = number brand) and every amount is built through the named constructors; dollarsToMills is an alias,… |
| 98 | Stage 18 platform seam | Platform-bound stream dispatch goes through the platform registry — an undeclared stream fails loudly instead of silently running another platform's handler — and… |
| 99 | Stage 18 OnlyMonster deletion | OnlyFans pages resolve token-less — no stored credentials, so credential-update and page-proxy routes answer 400 for OF (egress is vendor-side). `platform` is text FK'd… |
| 100 | Stage 26 egress seam | The resolver alone owns egress address policy: page scope = that page's proxy identity, vendor "ofapi" = vendor-direct, vendor "fansly" is REFUSED (Fansly must be… |
| 101 | Chain deploy 0057–0069 | Historical chain deployment for Stages 8-27. The durable client contract is #95: SDK client, stream v2, direct reads removed, and device-token identity. The… |
| 102 | Stage 28 retention | Scheduled deleters are an executable allowlist in `tests/retention-deleters.test.ts`; business facts remain outside operational retention paths |
| 103 | Stage 28 tiering | Tiering is export→verify→detach in that absolute order and detached partitions PARK in tiered_pending_drop — no DROP exists in code, the drop is the one owner-gated… |
| 104 | Stage 28 erasure | Erasure removes captured facts and derived projections, never the agency's own catalog rows (models/pages/users survive, the fans row goes); fan-scope transactions are… |
| 105 | Stage 29 AI gateway | Quota/budget denials are ledger facts: a quota_denied row plus HTTP 429 `quota_denied` (gateway quota paths no longer return rate_limit_exceeded), and per-feature… |
| 106 | Stage 30 prompt migration | Historical implementation record archived; no current constraint lives in its body. |
| 107 | Stage 30 feature services | Historical implementation record archived; no current constraint lives in its body. |
| 108 | Stage 30 prompt freeze | Desktop snapshot 1db76a4ae13d is the frozen provenance baseline. Source-backed manifest entries must retain that source hash; current kernel files must match their recorded core hash… |
| 109 | Stage 28.4/29/30 deploy | Historical implementation record archived; no current constraint lives in its body. |
| 110 | Stage 30 exit | Historical implementation record archived; no current constraint lives in its body. |
| 111 | Stage 31 desktop AI cutover | Client repositories contain no vendor AI SDKs, vendor keys, prompt assembly, or local generation path. All generation goes through the kernel gateway. The desktop AI… |
| 112 | Dashboard rebuild | The proposed dashboard rebuild was cancelled by #117: `apps/dashboard` is the live maintained console and the standalone workboard is governed by #119. Two old capture… |
| 113 | Family CI + toolchain | `pnpm typecheck` IS the strictness ratchet: per-file error budgets in scripts/strictness-ratchet.json may only shrink, a new file with errors fails, and a shrink must… |
| 114 | Stage 35 documentation close | Living documentation is CLAUDE.md, this register, focused contracts/runbooks, generated contract artifacts, and current source; migration-history is evidence, not current status. Legacy-key… |
| 115 | Release audits | Persona upsert/archive stay `apiKey`-auth — any chatter/device bearer can edit the global persona system blocks — accepted deliberately under single-tenant DP 9-A… |
| 116 | Identity/auth credentials | Humans use username/password and self-minted device tokens; robots use revocable API keys. Chatter provisioning is create -> optional password -> optional page… |
| 117 | Dashboard + workboard | #112 is reversed: apps/dashboard is the live, maintained admin surface and there is no rebuild or parity gate — the carry-over features are incremental backlog. The… |
| 118 | Stage 28 erasure scope | Page-scope erasure also purges the page's config/secret rows (page_credentials, egress_endpoints), which soft delete (#72) deliberately keeps as a two-way door; DP 7… |
| 119 | Stage 34 standalone workboard | Only the in-core workboard is deprecated; the STANDALONE workboard app is an active direction in its own repo, authenticating against kernel sessions (no IdP, no… |
| 120 | AI gateway quotas | Quota denial is legible cross-client: a gateway 429 classifies as `rate_limit` carrying the body's `quota_denied` code, and the four product gates throw machine codes… |
| 121 | Erasure fence semantics | The PR4 non-resurrection fence is MATERIAL-TIME-BOUNDED, not permanent: archive and projection writers check executed-erasure tombstones under a dedicated advisory… |
| 122 | Wave-2 DM corrections | DM corrections ride one staged flag: every archive write computes `material_fingerprint`, and `material != emitted` is the queryable repair signal a reconciler drains… |
| 123 | DM corrections lineage intake | Lineage is never faked: surviving journal rows are re-journaled verbatim under their ORIGINAL idempotency key, journal-less rows get an operator-source reconstruction… |
| 124 | Fansly egress | REVERSES Stage 26's recorded direct fallback — Fansly egress fails CLOSED: a proxyless Fansly page refuses with ProxyMissingError/409, opens a proxy_missing incident… |
| 125 | OFAPI command outbox TTL | Queued-only commands with zero attempts expire to `cancelled` after a 10-minute TTL, applied at the top of every sweep before the execution-disabled early return; the… |
| 126 | User offboarding | Users are never hard-deleted: offboarding sets a users.disabled_at tombstone (0079) and revokes every credential in one transaction; reactivation restores password… |
| 127 | Ping prompt context | The ping prompt carries a bounded whole-day `fanSilenceDays` (integer 0..20,000, future timestamps clamp to zero) derived from the same analysis that picks the segment;… |
| 128 | Backups (risk accepted) | Recurring off-box Postgres backups (#41) are DECLINED as accepted risk: no cron/timer/snapshot job exists on prod, and losing the VPS means permanent loss of all… |
| 129 | Erasure policy | The agency will not execute data-erasure requests, so the erasure module's three uncovered stores are sanctioned as-is and no remediation wave is built. If the policy… |
| 130 | Observability truthfulness | Observability must not lie: golden-signal incidents are keyed per metric, and a metric that emits NO sample keeps its latch exactly as-is (silence is never a resolve).… |
| 131 | Revenue reporting scope | Revises Stage 13's active-only readers for HISTORICAL aggregates: revenue attribution goes through the status-agnostic `listRevenue*` readers so a tombstoned page keeps… |
| 132 | Negative-money guards | Negation guards run inside the per-page spend lock: an active other-suffix twin or a missing settled original writes the negative INACTIVE and stickily so; OFAPI… |
| 133 | Stream state visibility | Surviving constraints: `occurred_at` clamps at canonicalize time to [2024-01-01, now+2mo] with the raw value preserved and never a guessed boundary, the `_future`… |
| 134 | Message-archive rebuild | The Stage-10 one-command rebuild is retired as structurally lossy; replaced by a staged SHADOW build (0083) with preflight census, legacy-seed lift before replay, a… |
| 135 | dm_messages wedge | A2a: `stored_message_count` is floor-only; retention policy must never be encoded as a DB upper-bound constraint. A2b: failed finalize/checkpoint work is recorded in… |
| 136 | AI fan dossier | Feature prompts inject the stored fan dossier only where `FeaturePolicy.usesFanProfile` permits it and a live key enables it; lookup is fail-open and bounded, financial… |
| 137 | dm_messages projection debt | Capture and projection are separately transactional: a thread-summary/checkpoint failure no longer fails the chunk — it records a never-deleted `projection_debt` row… |
| 138 | OF poison-chat breaker | OFAPI `dm_messages` faults isolate per conversation with bounded backoff/quarantine; 401/403/429 remain page-level and three distinct failing conversations imply a… |
| 139 | Decision numbering | Reserved number. The actual AUTH_POLICY_ENFORCEMENT ruling is #143; #139 must not be reused. |
| 140 | Prompt debug echo | Echoing an assembled prompt is an explicit DP 6-A declassification available only to the feature lane and a capability-advertising client. The frame is bounded and… |
| 141 | Executor fair scheduling | A pg-boss row is a disposable wakeup, never durable work or retry authority: one job owns exactly one chunk, every immediate wakeup uses the fixed singleton… |
| 142 | Top spenders read ceiling | pageTopSpenders is one bounded deterministic read: max 1000, default 150 (verified in routes.ts), with fanCount stating the true total and the response honestly… |
| 143 | Auth policy enforcement | `AUTH_POLICY_ENFORCEMENT` is `enforce`. Declarative authorization does not replace in-handler isolation guards: both layers deliberately enforce page/grant boundaries,… |
| 144 | Desktop harvest reconciliation | Desktop harvest manifests are cumulative custody checkpoints, not one-shot counts: the canonical per-machine <machine>-latest.json is the reconciliation authority,… |
| 145 | Harvest authority binding | x-client-version is routing metadata, never authority: journaling harvest.* facts requires a device token with an owner-bound machine UUID (0090), and an unbound claim… |
| 146 | Bounded snapshot pagination | GET /events/snapshot gains additive pageMode=bounded_v1 capping durable message/tombstone rows per response behind an opaque scope-bound stateCursor (malformed or… |
| 147 | Persona revision CAS | `feature_overrides.__kernelBundledVersion` records the bundled revision adopted by the kernel. Timestamps never participate in persona conflict resolution. Core must… |
| 148 | Global persona ownership | Global persona definitions are Core owner content: bearer clients read only the metadata catalog (key, display name, version, status) via /ai/persona-catalog, full text… |
| 149 | Replay-journal retention | Replayable OFAPI webhook rows are deleted only as one contiguous prefix — a recent, pending or failed row blocks every later frame, because the replay floor must prove… |
| 150 | Erasure locking | One global session-level erasure lock spans planning, DB deletion, lake rewrite and log completion (scope-local locks are unsafe because scopes share parquet/.tmp… |
| 151 | Persona admin read-only | The owner persona surface stays read-only (mutations 409, no dashboard controls — string still live in modules/ai/index.ts) until the legacy bearer LWW lane is closed.… |
| 152 | Deploy/lifecycle gating | Deploy no longer aborts every invocation: it interrogates the candidate image's runtime capability manifest and rejects only a candidate advertising… |
| 153 | Cursor integrity terminology | Domain-event resume cursors v2/v3/v4 are canonical Base64URL JSON and are NOT MAC-signed — their safety is shape/scope checks plus erasure-epoch and retained-topology… |
| 154 | AI proxy failure classification | Connect-level AI-lane failures (ConnectTimeoutError, SocksClientError, ECONNREFUSED-class anywhere in the cause chain) classify as provider_proxy_unreachable with a… |
| 155 | PPV canonicalization incident | message.ppv_unlocked refs come only from the notification chat path (the top-level user_id is the CREATOR); an unresolvable chat publishes no event; the type is… |
| 156 | Fast-reply split mode | replyMode=preferSplit becomes a strict prompt request for 2–3 [NEXT]-separated parts (the single-message opt-out is removed), but not a transport guarantee — the… |
| 157 | Documentation cleanup | Historical implementation record archived; no current constraint lives in its body. |
| 158 | OnlyFans mirror | The OF mirror is capture-before-parse and DB-first per proven surface (supersedes #49's REST bootstrap and #52's webhook-only boundary): every vendor call is a durable… |
| 159 | Off-box backups (superseded) | Historical off-box backup requirement, fully superseded by #161. Retained only because investigations cite the reversal; it is not a current release or operations gate. |
| 160 | OFAPI budget lanes | Legacy audience/fan-identity/chargeback lanes keep their dedicated day ceilings, but each reservation now increments the dedicated and global OFAPI counters in one… |
| 161 | Backups withdrawn | The owner withdrew off-box encrypted backups, provider selection, retention/alerting and DR restore drills entirely — losing the VPS may permanently lose locally… |
| 162 | OFAPI cursor semantics | OFAPI treats first_id as EXCLUSIVE, contradicting the inclusive behavior recorded in #49; the v2 capture contract therefore infers inclusive-vs-exclusive from each… |
| 163 | OFAPI export pilot | Fleet OFAPI exports remain quote-only: a scraping-backed export runs only under an owner-audited CAS approval naming the current row version and max credits, defaults… |
| 164 | Export artifact import | An OFAPI export artifact is message material, never proof of continuous history: an import is projection-only, terminal at item_presence with continuousHistory=false,… |
| 165 | Fansly purchase history | Fansly `/media/orderhistory` requires exactly one OBSERVED accountMediaId/accountMediaBundleId (fan ids are only a filter), so purchase history is a keyset walk over… |
| 166 | Page health freshness | A complete Fansly follower reconcile that disagrees with the headline count gets exactly ONE fresh generation (recorded in the checkpoint); a second mismatch blocks,… |
| 167 | Coach-chat feature lane | coach-chat is stateless server-side: the client replays completed exchanges as `coachHistory` (<=20, answers <=COACH_ANSWER_MAX_CHARS=64000 enforced identically on the… |
| 168 | Governed OFAPI budgets | Historical budget parent. Its surviving UTC-day reset, retry boundary, balance floor, and lane separation are consolidated into #170; its numeric allowances are not… |
| 169 | Governed OFAPI budgets | Removed body; numeric allowance superseded by #170. |
| 170 | Governed OFAPI budgets | Governed mirror reads are budgeted per origin principal per UTC day: 4,000 calls and 4,000 reserved credits under a 7,000-credit global daily ceiling. The window and… |
| 171 | Sync pause UX | A partial substream pause shows Resume and hides Sync Now/Pause. Resume re-requests only the rows actually paused. Visible OnlyFans compatibility rows (`light`,… |
| 172 | Release ops (dist-only) | A dist-only release MUST build from the checksum-pinned clean full base image published only after a fully verified full deploy, and refuses an absent, unlabeled… |
| 173 | Recovery generations | Every fresh follower/subscriber/DM-conversation sweep starts at max(checkpoint generation, retained-row generation) + 1 — including inactive and hidden rows — so an… |
| 174 | Voice notes lane | ElevenLabs voice notes become a page-scoped kernel render lane: a voice-script feature plus three routes, a durable single-dispatch state machine with fenced attempts,… |
| 175 | Voice pilot hardening | Synthesis admission accepts a restricted generation only when user, page, conversationRef and fanRef all match the requested fan (no group-id fallback); the ElevenLabs… |
| 176 | Local Docker + build cache | Local Postgres is opt-in (no `restart: unless-stopped`) with bounded local log drivers; production restart/logging policy and #172's checksum-pinned clean-base… |
| 177 | Prompt dossier eligibility | A `fan_profiles` body may enter an AI prompt only when Core's own restricted generation ledger proves it came from a usable FULL fan-summary (summaryMode=full,… |
| 178 | Stream v2 control lane | The v2 domain-event stream carries a third SSE lane, `event: control`, that never enters DomainEventFrame validation (the marker must not be a synthetic domain frame);… |
| 179 | Coach-chat draft context | coach-chat consumes the shared body's `draftText` as OPTIONAL context via a prompt-builder-only `optionalDraft` flag — `requiresDraft` stays false and the… |
| 180 | Service egress proxy | Telegram and ElevenLabs both egress through ONE boot-only, all-or-none `SERVICE_EGRESS_PROXY_URL` SOCKS5 identity, separate from page-owned proxy rows and fail-closed:… |
| 181 | v2 frame account mapping | `accountRef` on v2 domain frames is a SERVE-TIME page mapping, never event provenance: it is read from the page's current OFAPI ref in the same SQL statement as each… |
| 182 | AI failure classification (1A) | The kernel is the SOLE classifier of provider/transport failures for the whole family — clients consume the wire code and never re-parse provider bodies or infer their… |
| 183 | AI failure telemetry (1B) | Six wire classes (provider_billing/auth/rate_limited/unavailable/proxy_unreachable/stream_failed), one static message each, only 429 carrying Retry-After; failure phase… |
| 184 | Server error hygiene | Only an `AppError` (plus the cursor-restart response's explicit extension) may cross the server error boundary — an object that merely resembles… |
| 185 | Error-handling canon | `docs/error-handling.md` is the single canonical error-handling reference for core, the Firefox extension and Desktop: any change to classification, wire code/message,… |
| 186 | Critical-paging preconditions | Critical AI paging keeps four constraints: (1) `provider_usage_missing` currently records zero non-approximate cost in the internal lane, so spend is undercounted until… |
| 187 | Plugins throw AppError | Any Fastify plugin that signals by THROWING must throw an `AppError` — the boundary's duck-typed `{statusCode,error,message}` passthrough removed by #184 is never… |
| 188 | CI gate splits into shards | Branch protection requires a check literally named `Quality Gate`, preserved with `if: always()`. `tests/voice-profiles.test.ts` and `tests/voice-notes-sweep.test.ts`… |
| 189 | No long dashes in model-facing text | No em/en dash may appear in any text that reaches a model (templates + their templates.ts twins, builder.ts instruction strings, transcript normalizer) or in model… |
| 190 | Voice launch hardening | A queued voice row is owned by a heartbeat (updated_at refreshed each minute; 5 minutes without it, not row age, means abandoned), quota refusal is stateless and… |
| 191 | A gated skip is not a successful sync | A ramp-gated chunk performs no vendor call and claims no success/progress. Current mechanics are the durable `feature_gate` pause introduced by #194; UI copy keys on… |
| 192 | Ramp-gate wake-up | A config change queues affected Fansly streams only on a non-ramped -> ramped transition. Every new gated lane registers its keys in `GATE_CONFIG_KEYS`; otherwise… |
| 193 | Deleted fans in top-spenders | `pageTopSpenders` returns `entries[].deletedAt` (fans.deleted_detected_at, null = alive) so a deleted account is distinguishable from an unloaded name; deleted fans… |
| 194 | Fansly transaction-data correctness | Ramp-gate skips materialize as durable `feature_gate` pauses; opening a registered gate wakes only the affected streams. Subscriber expired-history bootstrap is… |
| 195 | Agent principal isolation | An agent key authenticates into its own AuthPrincipal variant with NO user field (kind "agent", capabilities + explicit pageIds), extending #116's taxonomy; route kind… |
| 196 | Agent Read Plane | Every 200 from /api/v1/agent/* carries three INDEPENDENT axes — `delivery` (a property of the response), `capture` (a property of the world, computed from… |
| 197 | Capture floor, not absence proof | The plane may report a capture FLOOR (`captureFloor`, kind `oldest_stored_row`, from its own unbounded query) and gaps/caveats, never an absence proof:… |
| 198 | Agent search is Postgres FTS | Message search runs `websearch_to_tsquery('simple')` over the GIN that has existed unused since migration 0059; `escapeLikePattern` is NOT applied on that path (it… |
| 199 | One writer for the blockers | `concludeEnvelope` in `modules/agent-read/epistemics.ts` is the ONLY runtime site that names a blocker (pinned textually); plane reads are branded witnesses a handler… |
| 200 | Agent keys are issued, never recovered | An agent key's raw token is returned exactly once and stored only as sha256; a bad capability or a lifetime past the 365-day ceiling is a 400, never a silent narrowing… |
| 201 | Help/Review prompts: Russian output, receipts required | help-me and chat-review split language by AUDIENCE: chatter-facing analysis in Russian («ты»), fan-facing suggestions/rewrites in the fan's language. Both demand… |
| 202 | Hydration autopilot | A versioned in-kernel policy may approve one bounded Fansly hydration under explicit daily budgets. |
| 203 | Agent transaction summary | agentDatasetQuery gains `summary: true` for the transactions dataset only: one statement returns currency-grouped count/gross/net/fee plus a page-wide windowless floor,… |
| 204 | Coach situation preset | `coach-chat` accepts optional `preset:'situation'`: Core substitutes the pinned canonical question only when `chatterQuestion` is absent or whitespace-only, refuses… |
| 205 | Creator-post capture and Agent read | Creator-post capture is an ordinary sync stream seeded PAUSED per page and deliberately excluded from scope `all`; verbatim post text is served only through the… |
| 206 | Fansly reverse evidence and fail-closed completeness | Fansly purchase history pages by `before = last orderId` and terminates ONLY on an empty successful page — a short non-empty page is continuation, never completeness; a… |
| 207 | Smoke consumer projection checkpoints | Historical implementation record archived; no current constraint lives in its body. |
| 208 | Live-list terminal verification and optional DM totals | Destructive finalization of a Fansly list requires an exact match — the generation's unique count against a FRESHLY captured terminal headline (follower reconcile) or… |
| 209 | Fansly post monetization | The rendered Fansly post tip total is `tipAmount + attachmentTipAmount` — never `totalTipAmount`, and two absent components record NO counter fact rather than a zero;… |
| 210 | Fansly live post-tip contract correction | A `/tips` item's flat `targetId` is exact donor-to-POST evidence and never donor-to-GOAL: copying a post's goal ref onto its tips is false, and subset-summing tip… |
| 211 | Exact transaction tip context | Tip notes are projected only from exact provider tip ids in the retained `/message` `tips[]` sidecar — never from a time-and-amount or nearest-message heuristic —… |
| 212 | G1 storage stop-loss: telemetry is bounded, capture is not | Telemetry representations may be bounded; captured facts never are. Checkpoint summaries are bounded while `page_sync_cursors` stays authoritative, and stdout remains… |
| 213 | Disk runway latches | Hourly least-squares fit of `disk_free_bytes` gauges (24h window, ≥6h span) drives two independent `db_disk_usage` subKey-латча: `runway_warning` <30д и… |
| 214 | G3 checkpoint cutover: the generation set is the membership authority | Row-side `page_dm_threads.last_seen_generation` — not a cumulative checkpoint array — is the membership authority, and the destructive visibility pass runs ONLY on an… |
| 215 | G5 slice 1: the CAS copy is written before the fact, and proved after it | Pull capture on a canary page stores its body in the content-addressed catalog in a SEPARATE transaction that runs BEFORE the inline inserts, and the resulting… |
| 216 | jsonb reads are single-parse | drizzle 0.45.2's builtin `jsonb` column runs `JSON.parse` on a value node-postgres has ALREADY parsed, so any jsonb value that IS a JSON string is decoded TWICE: stored… |
| 217 | G5 slice 2: reads move to the catalog through a staged, fail-open seam | Every served capture body goes through `payload-reader.ts`. If an inline body exists it remains a valid fallback in every mode; if a pointer-only catalog read fails,… |
| 218 | G5 slice 3a: the queryable fields get typed columns of their own | A query that digs a FIELD out of a capture body must read a typed column derived in packages/db inside the SAME INSERT as the body (never a post-commit UPDATE, never a… |
| 219 | G5 slice 3b: erasure becomes catalog-complete, and a capture body gets its first lawful death | A catalog body is deleted only after its last envelope reference is gone; bodies referenced by surviving envelopes are bystander facts and are kept. The older claim… |
| 220 | G5 slice 3c-1: a captured body stops being written twice | New captures on a page in `capture_cas_pointer_only_pages` (CSV of page ids or `*`, default `''` = off, live via the heartbeat) write the inline body as SQL NULL — the… |
| 221 | G5 slice 3c-2: the historical rewrite is a one-time lawful UPDATE, consumed by the reclaim that follows it | The historical rewrite is owner-typed CLI only (no schedule, no config flag) and is the ONE lawful UPDATE in this project, licensed solely because `capture:reclaim`… |
| 222 | G5 review fix: a stamped reference outliving its object is a lost fact, and the two acts are now ordered | An external review found that #219's accepted race — a capture deduping onto an object the erasure sweep is about to delete — stopped being cosmetic the moment #220 let… |
| 223 | G5 review fix: the reclaim's four missing gates — a typed column nobody could fill, an unreadable body that read as an empty one, a headroom law behind the growth it governs, and a ritual its own gate refused | An unavailable captured body must never be recorded as an empty, parsed or absent fact: the CAS read seam RAISES CapturePayloadUnavailableError (a sentinel would go… |
| 224 | Fansly capture widening + the DM media plane (WP-F0) | Fansly capture may widen only through the NAMED 18-field allowlist on embedded account records — lastSeenAt, followCount, subscriberCount, postLikes, accountMediaLikes,… |
| 225 | Fansly account statistics (WP-F1) + the projection registry | New projections register through `ProjectionDefinition` and may not include operational-state tables. Per-lane egress caps count HTTP attempts, persist in the cursor,… |
| 226 | Fansly notifications (WP-F2) — the verbatim-first engagement core | Notifications are the only permanently-lossy capture surface, so every row and every code is journaled verbatim and typed derivations ride BESIDE the verbatim event,… |
| 227 | Fansly content catalog (WP-F3) — the lane that measures M, and closes FEAT-002 | A roster event is keyed per OBSERVATION (never on the ref-set hash — a thing that vanishes and returns unchanged would dedupe and stay marked missing_since forever) and… |
| 228 | Fansly comment archive (WP-F5) — the lane [E1] had to authorise, and the POST that is never sent | The comment archive reads GET /post/{postId}/replies WITHOUT the browser's verify POST — no write-shaped call to Fansly, pinned by a whole-file grep of… |
| 229 | Fansly posts widening (WP-F6) — the counters the timeline was already serving | Widened provider fields are nullable — absent is NULL, never 0, and the parser refuses a whole page rather than half-reading an unrecognised field; every new field… |
| 230 | Fansly payouts (WP-F7) — money OUT, and the mask that is ours | Payout credential masking is OURS, not the platform's — `<first>***@domain` and `****<last4>`, the only value derived from metadata, enforced by a DB CHECK in 0141 and… |
| 231 | Fansly per-media statistics (WP-F4) | The per-media stats lane is attempt-capped, may intentionally saturate its cap, and reports its computed long-tail cycle. Queue state lives in… |
| 232 | Fansly serving surface (WP-S1) | The WP-S1 serving surface never authorizes capture: all eight routes are GETs with no body, no handler enqueues a sync or flips a flag, and all eight carry… |
| 233 | Fansly history walks corrected against production (amends #225, #231) | Daily stats history walks backward by calendar month using `year`/`month` and verifies `monthWasHonoured`; hourly is trailing-window only, while earnings retains its… |
| 234 | Staged configuration changes | Owner-approved 2026-08-23: staged configuration flags flip one at a time. Each flip has its own named verification window and rollback observation; unrelated staged… |
| 235 | Decision-log integrity | Owner-approved 2026-08-23: this file contains durable current constraints, not session history, branch hashes, test counts, or deploy narration. Existing decision… |

## Numbered decisions

## Decision #1 — Language

TypeScript + Node.js 22 LTS

## Decision #2 — Workspace

pnpm workspaces only — no Turborepo/Nx build-graph layer until build times are a measured problem.

## Decision #3 — Backend Framework

Historical implementation record: [archive](decisions-archive.md#decision-3).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #4 — Frontend

React 19 SPA with Vite and TanStack Query

## Decision #5 — Frontend Router

Historical implementation record: [archive](decisions-archive.md#decision-5).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #6 — Frontend Client State

Zustand holds cross-component client-only UI state (filters, date ranges, toggles); server state
stays in TanStack Query.

## Decision #7 — UI Layer

Tailwind CSS with shadcn/ui components vendored into the repo; no external component-library
dependency boundary.

## Decision #8 — Database

PostgreSQL 16

## Decision #9 — ORM / Query Layer

Drizzle ORM plus handwritten SQL for reporting queries

## Decision #10 — API Style

REST JSON under /api/v1 with URL-based versioning; no tRPC — every client (dashboard, extension,
scripts) gets one plain HTTP contract.

## Decision #11 — API Contracts

OpenAPI and typed clients are GENERATED from the Zod route schemas — the schemas are the single
contract source, never hand-edited output.

## Decision #12 — Dashboard Auth

Dashboard humans authenticate with Argon2id passwords over HttpOnly Postgres-backed sessions —
server-side sessions so revocation is immediate; no JWT sessions.

## Decision #13 — ChatMuse Auth

Human-bound clients authenticate with revocable bearer API keys or device tokens. Page access is
enforced server-side, never by the client.

## Decision #14 — Authorization

Page-scoped RBAC for `owner`, `team_lead`, `chatter`, `content_manager`

## Decision #15 — Money

### Money / Amount Storage
**Decision:** Store all monetary amounts as `BIGINT` mills (`1 mill = $0.001`) in PostgreSQL `bigint` columns, alongside `currency` and the raw source amount.

**Score:** 5/12 chose `BIGINT` mills; 3/12 chose `NUMERIC` + `decimal.js`; 3/12 chose `BIGINT` micros or generic minor units; 1/12 chose integer cents.

**Why:** Fansly already speaks mills, so storing that native unit avoids conversion loss and keeps arithmetic exact; OnlyFans cents convert losslessly by multiplying by 10. Use shared helpers such as `centsToMills`, `millsToDollars`, and `formatMoney` at the edges, and return mills as JSON numbers because the expected range stays comfortably within JavaScript's safe integer limit.

**Rejected:** `NUMERIC` is correct but forces string parsing and decimal ceremony through Drizzle for no gain here. Micros add precision the sources do not need and throw away the "store Fansly natively" advantage. Cents are wrong for this product because they would truncate real Fansly precision.

## Decision #16 — Time Handling

Store UTC `timestamptz` in DB; use UTC business dates for product analytics

## Decision #17 — Reporting Period Semantics

Backend computes UTC business-date boundaries; trailing windows include today

## Decision #18 — Platform Adapters

Strict adapter boundary per platform with canonical normalized DTOs

## Decision #19 — Fan Identity

`(platform, platform_user_id)` plus per-page relationship rows

## Decision #20 — Proxy Handling

Per-page proxy configuration in DB, applied inside adapters

## Decision #21 — Secret Storage

Encrypt platform tokens and proxy credentials at rest

## Decision #22 — Sync Scheduler

Historical implementation record: [archive](decisions-archive.md#decision-22).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #23 — Worker Role

One image starts the API, worker, or scheduler through `apps/runtime/dist/startup.js`. Roles share
packages and Postgres; cross-role work uses pg-boss and LISTEN/NOTIFY, with no RPC service.

## Decision #24 — Caching / Redis

No Redis in v1; use Postgres rollups, Postgres prompt cache, and in-memory short-window limiting

## Decision #25 — ChatMuse Protocol

REST request/response for normal endpoints; SSE for AI and event streams; no WebSockets.

## Decision #26 — AI Gateway

Core owns provider custody, authorization, quotas, usage/cost accounting, and the restricted-class
capture of verbatim prompts and completions. Those bytes never enter logs, the business capture
lane, or ordinary audit rows; provider error bodies never cross the boundary. Clients have no
direct-provider fallback. Client requests reserve `(userId, clientRequestId)` before provider
dispatch (duplicate = 409) and page-scoped generation uses the page's resolved egress.

## Decision #27 — Notifications

Alerts persist to the DB first, then deliver to Telegram asynchronously through pg-boss; recurring
failures collapse into one open incident plus one resolved notification, and critical alerts go
owner-only.

## Decision #28 — Raw Payload Retention

Captured business facts are retained for 100 years and are never deleted on a schedule. The only
sanctioned deleters are the pinned erasure paths; bounded operational telemetry is not authority for
captured facts.

## Decision #29 — Sync Idempotency

Checkpointed syncs: upsert raw events first, then rebuild projections

## Decision #30 — Transaction Taxonomy

Compact 9-bucket internal enum with adapter mappings

## Decision #31 — Notes / Summary History

Append-only notes; summaries append new versions instead of overwriting

## Decision #32 — Reporting Rollups

Precomputed daily fact tables for revenue, followers, and subscribers

## Decision #33 — Logging

Pino structured JSON logs

## Decision #34 — Migrations

Forward-only Drizzle SQL committed to Git and applied under an advisory lock at role startup. The
deploy script owns migration safety checks and rollback refusal after schema change.

## Decision #35 — Env Config

Shared typed config with Zod validation at startup

## Decision #36 — File Storage

Postgres text/JSON remains the default storage boundary. Rendered voice audio is the single explicit
bounded binary exception under #174; adding another binary class requires a new decision.

## Decision #37 — Testing

Historical implementation record: [archive](decisions-archive.md#decision-37).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #38 — Deployment

Docker Compose on one VPS with Caddy

## Decision #39 — CI/CD

GitHub Actions verifies changes. Production deploys are owner-gated and run
from a workstation through `scripts/deploy-production.sh` over SSH.

## Decision #40 — Code Quality

ESLint is the enforced code-quality gate. This repository has no general Prettier dependency,
configuration, or formatting command, so no decision may claim that it does.

## Decision #41 — Backups

The off-box backup requirement was withdrawn by #161. Recovery policy must not silently reintroduce
external backups as a release gate.

## Decision #42 — Health Checks

Lightweight `/api/v1/health` plus protected `/api/v1/health/sync` detail

## Decision #43 — Audit Trail

Append-only audit log for sensitive admin actions

## Decision #44 — Fansly Auth Headers

Only `authorization` header is required; `fansly-client-id`, `fansly-client-check`,
`fansly-session-id` are optional — include when available, omit when not

## Decision #45 — Payout Reversal (16013)

Fansly raw_type 16013 maps to `payout_reversal` — store in transactions for audit, but exclude from
net revenue calculations and `daily_revenue` rollups

## Decision #46 — Revenue Classification

Transactions carry classification metadata with four reporting buckets (revenue / adjustment /
unclassified / excluded); netEarningsMills = revenue + adjustments + unclassified, payout_reversal
is excluded from revenue and from fan LTV, and LTV uses an exclude-list not a whitelist.
Classification is product logic, never a DB migration.

## Decision #47 — Dashboard Fan Navigation

Keep `fan` as an internal CRM/data model and API concept, but do not ship a standalone dashboard
`Fans` section by default; only surface it when the UI delivers spend-ranked or CRM workflows that
are clearly distinct from followers/subscribers

## Decision #48 — OFAPI Real-Time Pipeline

**Decision #48:** Core becomes the real-time hub for the ChatGoose desktop app ("ChatMuse"): an onlyfansapi.com (OFAPI) webhook receiver plus an SSE fanout, with pg-boss carrying the async processing. Scope and shape (brief: `goose/of-desktop/docs/SPEC.md` §9.2 + its live-captured fixtures, copied to `tests/fixtures/ofapi-webhooks/`):

- **Receiver `POST /api/v1/ofapi/webhook`:** authenticates by `HMAC-SHA256(rawBody, signing_secret)` from the `signature` header (hex, timing-safe compare), over the raw bytes — the route lives in its own Fastify plugin scope with the repo's only `parseAs: "buffer"` body parser. Dedupe key is the `x-ofapi-idempotency-key` header (`evt_<40 hex>`; live-verified — the body has no event id), enforced by a unique index on `ofapi_webhook_events.idempotency_key`. The handler does two indexed statements plus one `boss.send` and acks well under OFAPI's 15 s timeout; a minutely sweep job re-enqueues rows whose enqueue was lost.
- **Journal `ofapi_webhook_events` (migration 0027, additive):** full envelope JSONB + derived `sync_event` JSONB + resolved `platform_account_id`, settled by the worker as processed/skipped/failed (settle guarded on `status='pending'`, so a retry racing the sweep settles exactly once). The SSE event id is `fanout_seq`, assigned in **settle order** inside the settle transaction — receive-time bigserial ids would make late settles (pg-boss retries, the sweep) invisible to clients whose `Last-Event-ID` already advanced past them. Decision #63 supersedes the original short-retention plan: `OFAPI_EVENT_RETENTION_DAYS` defaults to 36500.
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
- **Fanout `GET /api/v1/events/stream`:** bearer API-key or device-token auth, with frames filtered to the principal's assigned pages. Frames are core's copy of the desktop `SyncEvent` union (`syncEventSchema` in contracts; `accountId` = OFAPI `acct_…` id) plus a `messageDeleted` extension. Live path: worker `pg_notify`s journal ids on commit; the API process holds one shared LISTEN connection that re-reads the journal from its delivery watermark after every (re)connect, so frames settled during LISTEN gaps still reach connected clients. Replay: `Last-Event-ID` header (or `lastEventId` query param) reads forward from the journal by `fanout_seq`; subscribe-before-replay buffering (deduped by the exact replayed id set) closes the gap between catch-up and live. Streams are capped at 15 minutes so key revocation and page reassignment take effect on reconnect, and slow consumers (>1 MB buffered) are dropped — clients resume via `Last-Event-ID`.
- **Journal-only events:** `transactions.new` is subscribed and journaled (future OF analytics enrichment) but not fanned out — the desktop has no frame for it and a chat-list hint would trigger credit-charged refetches.

**Also shipped with this change (ChatMuse pre-P4 prerequisites):** `PUT …/fans/{platformUserId}/profile` auto-creates the fan + page membership for OnlyFans pages instead of 404 (core's OnlyFans sync is transactions-only, so non-spenders were unwritable; reads and Fansly stay strict), and `POST /api/v1/ai-usage/batch` skips events with invalid `completedAt` per-event, reporting a new `invalidCount`, instead of failing the whole batch.

**Rationale:** Webhooks are ~100× cheaper than polling OFAPI (1 credit/100 events vs 1 credit per uncached call) and the desktop needs push for its P3 milestone. SSE (not websockets) per decision #25. Async processing via pg-boss keeps the receiver inside OFAPI's delivery timeout and reuses existing worker/retry/cron infrastructure; LISTEN/NOTIFY bridges worker→API across the two-container deployment without new infrastructure.

## Decision #49 — OFAPI DM sync and account health

OnlyFans DM integration phases are: Phase 1 ingest, Phase 2 ledger, Phase 3 connection/health.
Ingest is webhook-first and projection failure never aborts settle/fanout. The vendor `first_id`
cursor is EXCLUSIVE per #162; the older inclusive claim is invalid. OnlyFans DM streams never depend
on subscribers, followers, or top spenders.

## Decision #50 — OFAPI credit ledger

The core OFAPI client is the single spend tap — every response that reached the server parses _meta
and writes an append-only ofapi_credit_ledger row plus the day counter in one transaction;
server-reported credits always win, a 2xx without _meta books an estimated 1 credit, an error
without _meta books nothing, and reconciliation absorbs the rest.

## Decision #51 — Mixed-platform revenue windows

**Decision #51:** The OnlyFans trailing revenue offsets (`ONLYFANS_REVENUE_TRAILING_PERIOD_OFFSETS` in `packages/shared/src/time.ts`: `7d` spans 8 calendar days, `30d` spans 31 — one day longer than the defaults other platforms use) stay exactly as they are, and mixed-platform reports disclose the difference instead of aligning it away (audit B2). Every revenue report (`overview`, `model`, `page`) now carries a required `platformWindows` array with the exact `from`/`to` and comparison bounds each platform contributed; the top-level `from`/`to` remains the union (unchanged); and the dashboard Overview renders a footnote whenever a displayed total combines windows of different widths.

**Rationale:** The offset was introduced by `153bc96` ("Fix OnlyFans revenue rollups and resync recovery", 2026-03-09) with no recorded rationale — presumably to absorb vendor data lag — and has been in production math since. Changing the numbers now would silently shift every OnlyFans `7d`/`30d` total against history and against whatever operational expectation motivated the offset. Disclosure keeps the revenue math byte-for-byte identical while making the metadata and the UI honest: the response names each platform's real window, and the Overview says so wherever a mixed sum (and its vs-previous delta) is displayed.

## Decision #52 — OFAPI DM cold archive

A messages.deleted event is an archive TOMBSTONE, not an erasure request: the row keeps its text and
sanitized media metadata, must carry deleted_at explicitly, and a later message-shaped replay may
fill missing fields but must never clear deleted_at. The cold archive stores stable media metadata
only — never signed CDN URLs, blobs, or raw payloads.

## Decision #53 — OFAPI sync snapshot

An empty SSE replay must be distinguished from a cursor that fell behind retention: a stale
Last-Event-ID gets 409 sync_snapshot_required and a cursor ahead of the server gets 400; the
snapshot captures its cursor BEFORE reading projection state, and resumeAllowed=false whenever DM
projection or the cold archive is off so a partial snapshot can never advance a client cursor.

## Decision #54 — OFAPI Desktop Read Gateway

The desktop read gateway is a fail-closed GET-only allowlist — every path segment and query
name/value validated, no wildcard method proxy, no writes — and the core OFAPI client stays the only
vendor network chokepoint: one upstream attempt per gateway read, page-attributed credits, and
account-scoped reads 404 rather than disclose account existence.

## Decision #55 — OFAPI Command Outbox

Core owns a versioned command outbox with no generic path/method proxy: dedupe on (page_id,
chatter_user_id, client_command_id) never derived from message text, retries are NEW commands with
new ids, and any attempt that may have reached the vendor becomes indeterminate — core never
auto-retries an indeterminate command. Read APIs, logs and exports expose ids/state/hashes only,
never message text.

## Decision #56 — OFAPI Command Executor

Exactly one HTTP attempt per durable command row: a stale in_flight row becomes indeterminate and
never returns to queued; definite 4xx is terminal, 429 is human-retryable,
transport/timeout/408/5xx/ambiguous success are indeterminate; a settled messages.sent webhook may
repair an outcome only on a unique account+conversation+normalized-text match in a bounded window,
and no raw vendor body or message text may enter logs.

## Decision #57 — DM Aggregate Analytics

DM analytics is aggregate-only over the cold archive: one row per page/UTC day with no transcript
text, media metadata or fan identifiers; the table is disposable derived state rebuilt
delete-and-replace, and response-time pairing, unlock funnels, revenue attribution and AI-to-send
linkage stay forbidden until explicit identity contracts exist.

## Decision #58 — OFAPI Typing Command Custody

The typing beacon rides the OFAPI command outbox as `typing_active_v1` (empty payload, one attempt,
no retry lineage, 2-minute dedupe horizon with terminal rows deleted, no permanent command_result);
it confirms only from the endpoint response and records a credit row only if the vendor returns a
non-zero `_meta` charge.

## Decision #59 — OFAPI Unsend Command Custody

`unsend_message_v1` is one DELETE attempt through the outbox with `{messageId}` as the entire
payload; `retryOfCommandId` is rejected because a second DELETE after an ambiguous first can produce
a different platform result, and logs/APIs may carry ids but never text or media URLs.

## Decision #60 — OFAPI Mark-Read Command Custody

`mark_chat_read_v1` is one POST through the outbox with an empty payload and no retry — read-state
mutation gets the same one-attempt custody as sends; confirmation comes from the POST response only.

## Decision #61 — OFAPI Media/PPV Send Command Custody

`send_media_message_v1` sends only already-existing OFAPI media ids (price 0 or 3–200, bounded
mediaFiles/previews, no URLs or file bytes); local file upload is explicitly NOT centralized, retry
is a new command row in the same lane, and webhook repair matches only on
account/conversation/normalized text/price/media-count/time/uniqueness.

## Decision #62 — Fansly server-replay gate (Pass 3 Stage 6)

Fansly earnings-stats, monthly-stats and PPV order-history replay server-side from the kernel with
the single pasted `fansly-client-check`; no per-route anti-bot token is required and the per-route
`routeChecks` bundle stays unbuilt.

## Decision #63 — Kernel retention & redaction stand-down (Pass 3 Stage 1)

Retention for the webhook journal, DM cold archive and sync raw payloads is 36500 days in env AND
code default, so a missing env can never re-enable a purge; the journal purge refuses rows still
pending/failed, and fact tables are allowed to grow unbounded with a disk-usage alert as the only
containment.

## Decision #64 — Pass 3 spec fixup (pre-execution review)

Key-table inserts against partitioned journals pre-allocate the id via
`nextval(pg_get_serial_sequence(...))`, the key row carries it, and the journal/event row inserts
with OVERRIDING SYSTEM VALUE — composable inside the caller's transaction; sensitive observation
kinds export to `lake/restricted/` rather than the generic lake.

## Decision #65 — Kernel destruction-door guards + chatter-read-scope (Pass 3 Stage 2)

Raw revenue/transaction routes require an owner/team_lead dashboard session on top of page scope
(`REVENUE_ROUTE_ROLE_ENFORCEMENT`, log→enforce); one-action data-loss doors are refusals or
append-only markers instead — messages_history reset 409s, workboard undo writes `retracted_at`,
reclassify supersedes rather than clearing.

## Decision #66 — Desktop stop-loss (Pass 3 Stage 4)

The desktop client never self-deletes captured facts: the usage spool dead-letters instead of
dropping (no `dropped` outcome exists at the type level), prune horizons are 50k messages / 310 d
spend / 3650 d guard-audit, and every hub request carries `x-client-version`.

## Decision #67 — OnlyMonster export is vacuous (Pass 3 Stage 5)

No OnlyMonster-sourced data exists (lora-of 685/685 and lora-vip-of 2168/2168 rows are
OFAPI-sourced, zero vendor egress); no export lane is built and canonicalizers may leave onlymonster
pages undeclared.

## Decision #68 — Stages 1/2/3/5 exit

Historical implementation record: [archive](decisions-archive.md#decision-68).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #69 — Stage 4 desktop reconcile

Historical implementation record: [archive](decisions-archive.md#decision-69).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #70 — Release ops (Stages 4/6/7)

Historical release session: the owner delegated a bounded set of deploy/release actions and each
gated action was confirmed during that session. It did not establish a general one-flag-at-a-time
ritual; that owner-approved rule is #234.

## Decision #71 — Stage 13 provenance

Every transaction row carries its source provenance and only the page's declared
`transactions_writer` may write it (a NULL-writer page is refused for every writer, and page
creation/OFAPI assignment seeds the writer); `source_observation_id` is a bare bigint because a
partitioned `observations` cannot be FK'd on id alone; page delete became a tombstone
(`status='deleted'`), replacing #65's handler 409.

## Decision #72 — Stage 13 deploy/verify

Page deletion is a soft delete that deliberately keeps credentials, egress endpoints and fact rows
for undelete; the provenance backfill left revenue totals byte-identical.

## Decision #73 — Stage 8 domain events

domain_events is partitioned monthly with a gapless per-account seq and cross-producer content-hash
dedup (the same fact arriving as webhook and as REST page yields one event; replay appends zero); a
canonicalizer that cannot decide a field from the payload alone stays undeclared rather than
guessing, and ORDER BY on a bare column name resolves to the SELECT's text alias — qualify it.

## Decision #74 — Stage 9 read-gateway capture

Every read-gateway 2xx is teed verbatim into the journal after the response is sent, through a
bounded queue that is fail-open for that producer only (drop counter plus a read_gateway_capture
incident at threshold); credit-ledger rows carry `actor_user_id` so gateway spend is attributable,
background REST stays NULL.

## Decision #75 — Stage 10 message archive

message_archive is a rebuildable projection: an event-fed writer advances per-account seq
watermarks, one command reproduces identical counts from the event ledger, backfills are idempotent
(with the single explicit cents→mills conversion), and reads are owner/team_lead-gated (chatter
403).

## Decision #76 — Stage 16 Fansly earnings

Fansly PPV order history is per-fan and cursorless, so back-scroll is a checkpointed keyset walk
over page_fans whose cursor reset means incremental refresh; ramp gates are live-editable (a ramp
flip must never need a restart) and flag-off bulk streams stay out of SYNC_DOMAIN_POLICY so they
cannot degrade a page's block-health UX.

## Decision #77 — Stage 17 Fansly backscroll

Fansly DM canonicalizers stay pure — message direction is resolved from a per-run
page→native-account-ref context passed in as an argument, never looked up inside the canonicalizer —
and manual "sync all" expands via domain lists that deliberately exclude the bulk streams. The
deep-backfill depth cap (stored_message_count < retention_limit) is lifted only by the live-editable
key `fanslyDeepBackfillIgnoreRetentionLimit`.

## Decision #78 — Stage 16 parse side

Fansly earnings/PPV shapes may be derived from the extension's production parsers rather than
waiting for live capture (a trusted shape source already exists). `fan.earnings_observed` is
content-hash-deduped so an unchanged snapshot re-fetch appends zero, and PPV unlocks key on
`ppv:<fan>:<media|bundle>:<createdAt>` because order-history rows carry no order id.

## Decision #79 — Stage 13 exit

Historical implementation record: [archive](decisions-archive.md#decision-79).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #80 — Stage 14 OFAPI transactions

**Part 1.**
The OFAPI data-exports lane is priced and NOT adopted: a full REST marker-walk of both pages' entire
history is ~30 credits against a 200/day backfill budget, so the async export flow only wins if a
large pre-2025-09 tail appears. Re-open only on that condition; otherwise closed.

**Part 2.**
Backfill walks reserve from their own 'backfill' credit counter and stop with an explicit
`budget_exhausted` reason instead of overrunning; fee/VAT/tax capture is fill-only upsert (an
omitting writer never erases). tips.received is an estimated shadow SIGNAL only — tips also arrive
as transactions.new, so it is never ingested as truth — and chargebacks write under
`{payment.id}:chargeback` so the settled original row is never demoted.

## Decision #81 — Stage 14/4 follow-ups

tips.received is declared as its own `tip.received` domain event keyed `tip:<notificationId>` with
the fan taken from `payload.user.id` (top-level user_id is the CREATOR), kept distinct from
transaction.posted so tip money is never counted twice. A canonicalizer family version bump re-scans
the entire webhook corpus once — dedup keys make that replay append-zero.

## Decision #82 — Stage 11 ingest lane

The ingest batch remains bearer-only, bounded, and whole-batch atomic. Its original claim that
`client_capture` emits no domain events is superseded by the v2 family in #83; consumers must follow
#83.

## Decision #83 — Stage 12 desktop harvest

`harvest.<table>` kinds are accepted only under producer `desktop-harvest@<version>`, and account
resolution happens at INGEST (payload.ofapiAccountId → pages.ofapi_account_id) — a NULL-account
observation never canonicalizes. harvest.messages dedups against webhook events by Stage-8 key
parity, harvest.fan_transactions is validation-only (the ledger's transaction events start at the
webhook epoch), and a desktop purge refuses while a started harvest is incomplete.

## Decision #84 — Pre-merge review wave 1

Historical implementation record: [archive](decisions-archive.md#decision-84).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #85 — Pre-merge review wave 2

Historical implementation record: [archive](decisions-archive.md#decision-85).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #86 — Pre-merge review wave 3

Historical implementation record: [archive](decisions-archive.md#decision-86).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #87 — Stage 19 declarative auth

All routes declare authorization and the declarative middleware is enforced. The in-handler checks
are intentionally retained as the second isolation layer under #143; they are not cleanup debt.

## Decision #88 — Stage 19 module extraction

Historical implementation record: [archive](decisions-archive.md#decision-88).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #89 — Stage 19 composition root

Route modules own their declarations while the server remains a composition root. Authorization
cleanup promised by the original stage log is cancelled by the dual-layer law #143.

## Decision #90 — Stage 20 generated SDK

@kernel/sdk stays deliberately tiny — an operations manifest plus re-exports, with per-operation
request/response types MAPPED generically off `typeof routeSchemas`; there is no mass codegen. The
contract hash is sha256 of the NORMALIZED OpenAPI document (not the manifest), so a renamed response
field moves it and trips client drift gates; webhook, both SSE streams, the wildcard read gateway
and the CSV export are excluded from the SDK.

## Decision #91 — Stage 20 dashboard adoption

The dashboard reaches the kernel only through @kernel/sdk — no direct fetch in `src/api`, no
resurrected client.ts — and the ban is enforced by a TEST (tests/dashboard-sdk-ban.test.ts) because
the dashboard tree is not ESLint-covered.

## Decision #92 — Stage 21 event stream v2

Event-stream v2 frames are `{accountId, accountSeq, type, occurredAt, data}` and `type` is open.
Resume uses an opaque strict-decoded cursor; per-account 409 covers ahead-of-head and
below-retained-floor. Payloads ride Stage 24: normalized message payloads travel in the v2 frame
instead of forcing a read-gateway call.

## Decision #93 — Stage 22 identity

Sessions, device tokens, and append-only access grants remain the identity model.
`ACCESS_GRANTS_READ_ENABLED` is still default-off, so legacy authorization and access-grant
dual-write remain active until live parity is proven zero; elapsed time alone is not an exit
condition.

## Decision #94 — Stage 23 workboard module

Workboard claim leases are SOFT coordination, not access control: a second chatter's claim steals
the lease (last-writer-wins, never blocks), and page scope on an any-session route is the access
boundary, not the dashboard door. Module-emitted domain events (`workboard.state_changed` on real
tab transitions only, `workboard.contact_retracted` only when a row was actually stamped) carry
observationId 0 as the "no source observation" sentinel with time-based dedup keys; recompute is
event-driven and the nightly sweep is only a drift reconciler.

## Decision #95 — Stage 24 desktop kernel client

Clients consume a compiled vendored SDK, use stream-v2 opaque cursors, and perform no direct OFAPI
reads. Payloads ride Stage 24 as defined by #92; typing alone uses the cursor-free ephemeral lane.
Deleted direct-read credentials are erased on boot and are not restored by a version rollback.

## Decision #96 — Stage 25 scheduler + signals

Cron registration lives in exactly one place (services/schedules.ts) and fires only from the
leader-elected scheduler role — api and workers must construct pg-boss with schedule:false.
Golden-signal lags (capture, canonicalize, projection, command settle, SSE staleness) latch the
incident at p95 thresholds.

## Decision #97 — Stage 27 money codec

Money brands are compile-time only (Mills = bigint brand, MicroUsd = number brand) and every amount
is built through the named constructors; dollarsToMills is an alias, millsFromCents bridges the
cents column. toMills is ESLint-banned and new Math.round-over-money sites fail the money-float
ratchet (scripts/money-float-budget.json, budget 9, decreases only).

## Decision #98 — Stage 18 platform seam

Platform-bound stream dispatch goes through the platform registry — an undeclared stream fails
loudly instead of silently running another platform's handler — and capabilities.streams speaks the
DB sync_stream vocabulary, not the target's renames. `platform ===` outside the adapter packages is
ratcheted by scripts/check-platform-branches.mjs.

## Decision #99 — Stage 18 OnlyMonster deletion

OnlyFans pages resolve token-less — no stored credentials, so credential-update and page-proxy
routes answer 400 for OF (egress is vendor-side). `platform` is text FK'd to the platforms reference
table (a new platform is a row, not an enum change), and a down-migration .sql may never live in
packages/db/migrations because the runner applies every file there.

## Decision #100 — Stage 26 egress seam

The resolver alone owns egress address policy: page scope = that page's proxy identity, vendor
"ofapi" = vendor-direct, vendor "fansly" is REFUSED (Fansly must be page-scoped), unknown scopes
throw. Bulk pacing is two-phase — bulk waits out its own class row and claims the vendor row only
when the send is imminent, so interactive never queues behind bulk's backlog; an auth-dead page
pauses whole with blocker_kind='auth', and that stamp is the reversibility contract.

## Decision #101 — Chain deploy 0057–0069

Historical chain deployment for Stages 8-27. The durable client contract is #95: SDK client, stream
v2, direct reads removed, and device-token identity. The production-shape and verify-after-write
lessons remain pinned in code/tests rather than this deploy log.

## Decision #102 — Stage 28 retention

The sanctioned scheduled deleters are enumerated by `tests/retention-deleters.test.ts`; any new
SQL-deleting file fails that gate. DM prune is a cache policy gated at runtime on archive≥hot
coverage (fails closed). Durable terminal business command payloads remain facts; bounded typing
beacons and expired pending credentials are operational state, not business facts.

## Decision #103 — Stage 28 tiering

Tiering is export→verify→detach in that absolute order and detached partitions PARK in
tiered_pending_drop — no DROP exists in code, the drop is the one owner-gated irreversible step.
@duckdb/node-api must stay a runtime dependency and an esbuild external; postgres_scanner is
rejected because it needs network at run time.

## Decision #104 — Stage 28 erasure

Erasure removes captured facts and derived projections, never the agency's own catalog rows
(models/pages/users survive, the fans row goes); fan-scope transactions are ANONYMIZED rather than
deleted so aggregates stay truthful, and there are no post-erasure projection rebuilds. It must
reach every plane history can live in — hot tables, attached and parked partitions, the Parquet lake
— and an unmapped non-cascade FK to `fans` fails the plan loudly so no new table can silently join
the fan graph.

## Decision #105 — Stage 29 AI gateway

Quota/budget denials are ledger facts: a quota_denied row plus HTTP 429 `quota_denied` (gateway
quota paths no longer return rate_limit_exceeded), and per-feature budgets are GLOBAL per day, not
per user. Every generation outcome is captured in the restricted class — lake-excluded by
construction and erasure-reachable — and vendor AI SDKs are import-banned outside the gateway
provider files.

## Decision #106 — Stage 30 prompt migration

Historical implementation record: [archive](decisions-archive.md#decision-106).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #107 — Stage 30 feature services

Historical implementation record: [archive](decisions-archive.md#decision-107).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #108 — Stage 30 prompt freeze

Desktop snapshot 1db76a4ae13d is the frozen provenance baseline. Source-backed manifest entries
must retain that source hash; current kernel files must match their recorded core hash, and
kernel-native additions must be marked explicitly. Later decisions may evolve kernel behavior,
but must update the manifest in the same change. The original sign-off proved ASSEMBLY parity
only — context-VALUE parity for the three named loader gaps was never proven.

## Decision #109 — Stage 28.4/29/30 deploy

Historical implementation record: [archive](decisions-archive.md#decision-109).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #110 — Stage 30 exit

Historical implementation record: [archive](decisions-archive.md#decision-110).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #111 — Stage 31 desktop AI cutover

Client repositories contain no vendor AI SDKs, vendor keys, prompt assembly, or local generation
path. All generation goes through the kernel gateway. The desktop AI machinery was deleted; its AI
secrets were removed from `SECRET_NAMES` and are erased on boot, so rollback does not restore them.

## Decision #112 — Dashboard rebuild

The proposed dashboard rebuild was cancelled by #117: `apps/dashboard` is the live maintained
console and the standalone workboard is governed by #119. Two old capture gaps remain explicit:
`fan_earnings` requires `correlationAccountId`, and per-fan `purchase_history` is blocked by the
order-history `accountMediaId` contract. Legacy chatter-key removal remains open under #114.

## Decision #113 — Family CI + toolchain

`pnpm typecheck` IS the strictness ratchet: per-file error budgets in
scripts/strictness-ratchet.json may only shrink, a new file with errors fails, and a shrink must
update the snapshot in the same change. One toolchain family-wide (pnpm 10.33.1 via packageManager,
Node ≥22, TS 6, vitest 4) and never read a suite's result through a pipe — the pipe's exit code
lies.

## Decision #114 — Stage 35 documentation close

Living documentation is CLAUDE.md, this register, focused contracts/runbooks, generated contract
artifacts, and current source; migration-history is evidence, not current status. The former client
prerequisites are complete: Hub operations prefer device tokens and `spendersLegacyRebuild` is
gone. Removing the dual-accepted chatter-key path remains gated on demonstrated fleet adoption;
do not infer adoption from age alone.

## Decision #115 — Release audits

Persona upsert/archive stay `apiKey`-auth — any chatter/device bearer can edit the global persona
system blocks — accepted deliberately under single-tenant DP 9-A because the desktop's persona sync
runs on chatter credentials; revisit only if the team grows past trusted operators. clientContext is
accepted for Fansly pages only (400 otherwise), since OnlyFans context is kernel-fresh and a bearer
could otherwise fabricate transcript/spend.

## Decision #116 — Identity/auth credentials

Humans use username/password and self-minted device tokens; robots use revocable API keys. Chatter
provisioning is create -> optional password -> optional page assignment. A retry after a later-step
failure skips recreation and safely repeats password/assignment. `must_change_password` stays off
until a chatter-reachable change-password surface exists; client key fallback is removed only after
the three-part fleet gate in this decision is proven.

## Decision #117 — Dashboard + workboard

#112 is reversed: apps/dashboard is the live, maintained admin surface and there is no rebuild or
parity gate — the carry-over features are incremental backlog. The in-core workboard (the
dashboard's Workboard v2 page as a product direction) is deprecated.

## Decision #118 — Stage 28 erasure scope

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

## Decision #119 — Stage 34 standalone workboard

Only the in-core workboard is deprecated; the STANDALONE workboard app is an active direction in its
own repo, authenticating against kernel sessions (no IdP, no browser device tokens) with per-page
grants, same-VPS subdomain, Fansly-only desktop-browser v1. No identity/auth work waits on it, and
no Stage 34 code starts before an owner-approved PRD.

## Decision #120 — AI gateway quotas

Quota denial is legible cross-client: a gateway 429 classifies as `rate_limit` carrying the body's
`quota_denied` code, and the four product gates throw machine codes (`gate_*`) that clients map
structurally, message-matching only as fallback. Defaults are 500 requests / $10 per chatter-page
UTC day, and the two caps must move together.

## Decision #121 — Erasure fence semantics

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

## Decision #122 — Wave-2 DM corrections

DM corrections ride one staged flag: every archive write computes `material_fingerprint`, and
`material != emitted` is the queryable repair signal a reconciler drains into FIRST or SUPERSEDING
events. Hard precondition — the fingerprint backfill must complete before the flag flips; appended
superseding events and the 1970 repair are append-only facts with no rollback.

## Decision #123 — DM corrections lineage intake

Lineage is never faked: surviving journal rows are re-journaled verbatim under their ORIGINAL
idempotency key, journal-less rows get an operator-source reconstruction observation built from the
archive row's own material head (ids and timestamps are the row's own), and rows resolving neither
way stay skip-and-counted. The reconcile cursor persists across runs so skipped rows retry per cycle
instead of head-blocking the signal.

## Decision #124 — Fansly egress

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

## Decision #125 — OFAPI command outbox TTL

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

## Decision #126 — User offboarding

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

## Decision #127 — Ping prompt context

The ping prompt carries a bounded whole-day `fanSilenceDays` (integer 0..20,000, future timestamps
clamp to zero) derived from the same analysis that picks the segment; the generated message must
never quote the number. `clientContext` is strict, so Core deploys before any client starts sending
the field, and the evolved templates stay prompt-manifest-pinned.

## Decision #128 — Backups (risk accepted)

Recurring off-box Postgres backups (#41) are DECLINED as accepted risk: no cron/timer/snapshot job
exists on prod, and losing the VPS means permanent loss of all platform history since the last
manual pg_dump. The owner may reverse this by implementing #41 at any time.

## Decision #129 — Erasure policy

The agency will not execute data-erasure requests, so the erasure module's three uncovered stores
are sanctioned as-is and no remediation wave is built. If the policy ever reverses, the preserved
fix recipe MUST ship before any real erasure run — today's module would falsely report completeness.
Resolves the #121 pending waiver.

## Decision #130 — Observability truthfulness

Observability must not lie: golden-signal incidents are keyed per metric, and a metric that emits NO
sample keeps its latch exactly as-is (silence is never a resolve). Wedge gauges always emit, a
missing probe row latches as failed, an ops watchdog pages when the scheduler or sampler goes
silent, and the canonicalize sweep resumes from a per-family cursor with wrap-to-head.

## Decision #131 — Revenue reporting scope

Revises Stage 13's active-only readers for HISTORICAL aggregates: revenue attribution goes through
the status-agnostic `listRevenue*` readers so a tombstoned page keeps its lifetime history in every
rollup, while navigation/status surfaces and growth reports deliberately stay active-only and
page-scoped detail routes still 404 on tombstones.

## Decision #132 — Negative-money guards

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

## Decision #133 — Stream state visibility

Surviving constraints: `occurred_at` clamps at canonicalize time to [2024-01-01, now+2mo] with the
raw value preserved and never a guessed boundary, the `_future` partitions are named outside the
tiering regex so they are structurally undetachable, `amountUnit` lands on newly-emitted events only
(pre-fix events stay immutable), the Fansly stream-gate is one shared function, and the workboard
conversationRef fallback is REFUTED (conversationRef is the group id, pinned by a fixture).

## Decision #134 — Message-archive rebuild

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

## Decision #135 — dm_messages wedge

A2a: `stored_message_count` is floor-only; retention policy must never be encoded as a DB
upper-bound constraint. A2b: failed finalize/checkpoint work is recorded in `projection_debt`
instead of failing the whole run; unresolved debt degrades page health, and the repair sweep
restarts stranded projection recomputations.

## Decision #136 — AI fan dossier

Feature prompts inject the stored fan dossier only where `FeaturePolicy.usesFanProfile` permits it
and a live key enables it; lookup is fail-open and bounded, financial profile data is always
dropped. The former volatile age-reset rule is retired: old data is labelled with a dated disclaimer
instead of being silently removed.

## Decision #137 — dm_messages projection debt

Capture and projection are separately transactional: a thread-summary/checkpoint failure no longer
fails the chunk — it records a never-deleted `projection_debt` row (one live row per target) that a
5-minute sweep repairs, while lease-fencing, capture and message-upsert failures stay fatal. Health
must not lie: a stream retrying with >= 10 consecutive failures and any page with unresolved debt
degrade /health/sync.

## Decision #138 — OF poison-chat breaker

OFAPI `dm_messages` faults isolate per conversation with bounded backoff/quarantine; 401/403/429
remain page-level and three distinct failing conversations imply a vendor outage. A successful
adaptive probe persists `preferred_page_limit`; clearing a failure preserves that sticky limit and
removes the row only when no sticky values remain. The first probe-eligible fetch is one attempt: a
60-second hang is the giant-chat signature.

## Decision #139 — Decision numbering

Reserved number. The actual AUTH_POLICY_ENFORCEMENT ruling is #143; #139 must not be reused.

## Decision #140 — Prompt debug echo

Echoing an assembled prompt is an explicit DP 6-A declassification available only to the feature
lane and a capability-advertising client. The frame is bounded and memory-only: never persisted or
logged. The original timed allowlist, daily cap, and substitution grammar were retired; the live
control surface is one switch.

## Decision #141 — Executor fair scheduling

**Part 1.**
A pg-boss row is a disposable wakeup, never durable work or retry authority: one job owns exactly
one chunk, every immediate wakeup uses the fixed singleton String(pageId), parent completion and
child insertion share one transaction (complete → send), sync.page.execute has retryLimit=0, and
local multi-chunk draining is forbidden. Delayed yields live only in page_sync_states.retry_at; a
lease is terminal once expired.

**Part 2.**
Immutable request_source (audit) is separated from mutable dispatch_source (queue admission, 0089):
the first attempted chunk consumes the boost so a long manual generation cannot starve scheduled
pages. Cross-page scheduling is deliberately FIFO, not pg-boss numeric priority (which has no
aging), and every ownership/expiry decision uses PostgreSQL clock time, never process Date.

## Decision #142 — Top spenders read ceiling

pageTopSpenders is one bounded deterministic read: max 1000, default 150 (verified in routes.ts),
with fanCount stating the true total and the response honestly truncated above the ceiling. A future
need beyond 1000 must add snapshot-bound pagination, never simply remove the bound.

## Decision #143 — Auth policy enforcement

`AUTH_POLICY_ENFORCEMENT` is `enforce`. Declarative authorization does not replace in-handler
isolation guards: both layers deliberately enforce page/grant boundaries, and tests must prove
isolation with middleware enforced. Rollback is `log` plus API-container recreation; removing
handler guards requires a new security decision.

## Decision #144 — Desktop harvest reconciliation

Desktop harvest manifests are cumulative custody checkpoints, not one-shot counts: the canonical
per-machine <machine>-latest.json is the reconciliation authority, timestamped snapshots may be
stale, and machine UUIDs must match with path traversal rejected. An incomplete reconciliation exits
non-zero so shell automation cannot read the report as a passed custody gate.

## Decision #145 — Harvest authority binding

x-client-version is routing metadata, never authority: journaling harvest.* facts requires a device
token with an owner-bound machine UUID (0090), and an unbound claim fails 403 before the capture
transaction. Harvest idempotency keys on machine + deterministic client event, not on the human
principal, and rollback to header trust is an explicit security rollback.

## Decision #146 — Bounded snapshot pagination

GET /events/snapshot gains additive pageMode=bounded_v1 capping durable message/tombstone rows per
response behind an opaque scope-bound stateCursor (malformed or mismatched → 400); no row is ever
truncated and no byte ceiling is claimed. Only the terminal null nextStateCursor authorizes the
snapshot checkpoint, and legacy callers keep the original semantics.

## Decision #147 — Persona revision CAS

`feature_overrides.__kernelBundledVersion` records the bundled revision adopted by the kernel.
Timestamps never participate in persona conflict resolution. Core must deploy before a
revision-aware desktop; #148 removes the unshipped bearer lifecycle route but does not remove these
rules.

## Decision #148 — Global persona ownership

Global persona definitions are Core owner content: bearer clients read only the metadata catalog
(key, display name, version, status) via /ai/persona-catalog, full text lives behind the owner
session, archived rows are tombstones with no restore. Bundled seeding is create-only — once any row
exists for a key, every reseed and version bump is a byte-for-byte no-op.

## Decision #149 — Replay-journal retention

Replayable OFAPI webhook rows are deleted only as one contiguous prefix — a recent, pending or
failed row blocks every later frame, because the replay floor must prove a removed prefix rather
than a lossy max-deleted approximation. A persistent blocker is an operator repair/alert condition,
never permission for the cleanup job to discard its tail.

## Decision #150 — Erasure locking

One global session-level erasure lock spans planning, DB deletion, lake rewrite and log completion
(scope-local locks are unsafe because scopes share parquet/.tmp paths). A retry may mark an earlier
attempt superseded only on exact selector + identical stored resolved-page-id set +
execution_protocol=global-erasure-lock-v1; no max(id) heuristic may ever close an older erasure, and
unstamped attempts stay open for operator review.

## Decision #151 — Persona admin read-only

The owner persona surface stays read-only (mutations 409, no dashboard controls — string still live
in modules/ai/index.ts) until the legacy bearer LWW lane is closed. The catalog carries an opaque
v1: definitionId over key+name+system-block bytes, sent as expectedPersonaDefinitionId; Core rejects
a byte mismatch or a missing/archived entry with 409 persona_definition_changed BEFORE loading
context, reserving quota, or calling a provider.

## Decision #152 — Deploy/lifecycle gating

Deploy no longer aborts every invocation: it interrogates the candidate image's runtime capability
manifest and rejects only a candidate advertising desktop-lifecycle-v2, with no env or status-file
bypass. Public health exposes the generated normalized-OpenAPI contractHash so client release gates
compare contracts instead of inferring compatibility from a 401 or a source SHA.

## Decision #153 — Cursor integrity terminology

Domain-event resume cursors v2/v3/v4 are canonical Base64URL JSON and are NOT MAC-signed — their
safety is shape/scope checks plus erasure-epoch and retained-topology validation; only the bounded
OFAPI snapshot stateCursor is HMAC-SHA256 signed with a key version. Docs and release notes must
name which cursor they mean.

## Decision #154 — AI proxy failure classification

Connect-level AI-lane failures (ConnectTimeoutError, SocksClientError, ECONNREFUSED-class anywhere
in the cause chain) classify as provider_proxy_unreachable with a STATIC proxy-naming message — the
redacted cause chain goes to the server log only, never to clients; the page-proxy client caches the
first connect failure for the whole generation so SDK retries fail instantly (HTTP 429/5xx retry
semantics untouched). The frame code stays an open string: clients match by prefix, so new codes
ship with no contract bump or SDK re-vendor.

## Decision #155 — PPV canonicalization incident

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

## Decision #156 — Fast-reply split mode

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

## Decision #157 — Documentation cleanup

Historical implementation record: [archive](decisions-archive.md#decision-157).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #158 — OnlyFans mirror

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

## Decision #159 — Off-box backups (superseded)

Historical off-box backup requirement, fully superseded by #161. Retained only because
investigations cite the reversal; it is not a current release or operations gate.

## Decision #160 — OFAPI budget lanes

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

## Decision #161 — Backups withdrawn

The owner withdrew off-box encrypted backups, provider selection, retention/alerting and DR restore
drills entirely — losing the VPS may permanently lose locally captured history and that consequence
is accepted; it must not be reopened as an implementation blocker without a new owner decision. The
export bucket is a durable copy of a vendor export, not a database backup, and no runtime flag or
code path may depend on backup availability.

## Decision #162 — OFAPI cursor semantics

OFAPI treats first_id as EXCLUSIVE, contradicting the inclusive behavior recorded in #49; the v2
capture contract therefore infers inclusive-vs-exclusive from each SAVED response, persists the mode
in the job cursor, and rejects a mid-chain mode change. An exclusive page is accepted only when
every returned id is strictly older than the boundary; local replay upgrades parser versions on the
already-paid response and never re-dispatches.

## Decision #163 — OFAPI export pilot

Fleet OFAPI exports remain quote-only: a scraping-backed export runs only under an owner-audited CAS
approval naming the current row version and max credits, defaults to dry-run, permits ONE stateful
POST .../start, and an indeterminate start is never retried automatically. A completion is usable
only on total_rows = rows_processed, zero failed downloads, caps held, and a download URL present —
then the job stops at artifact_capture_required.

## Decision #164 — Export artifact import

An OFAPI export artifact is message material, never proof of continuous history: an import is
projection-only, terminal at item_presence with continuousHistory=false, can never produce or
upgrade ofapi.capture_completed.v1, and yields no business SSE frames. Fields the CSV omits (reply,
full media identity) are marked unobserved and may not erase richer live material on upsert;
registration re-checks header/row count/scope/date bounds/unique ids/size/SHA-256 and spends no
credits.

## Decision #165 — Fansly purchase history

Fansly `/media/orderhistory` requires exactly one OBSERVED accountMediaId/accountMediaBundleId (fan
ids are only a filter), so purchase history is a keyset walk over retained
`sync_raw_payloads(endpoint='dm_messages')` — never a fan x media cartesian, and the target-specific
raw capture is the dedupe fact. Any HTTP 400 / auth / rate-limit / unknown-shape response or a hit
on the cursorless 100-row cap must fail visibly instead of certifying completeness.

## Decision #166 — Page health freshness

A complete Fansly follower reconcile that disagrees with the headline count gets exactly ONE fresh
generation (recorded in the checkpoint); a second mismatch blocks, and neither mismatch may
deactivate rows. Page-health summaries evaluate only streams applicable under current gates — bulk
enrichment (`fan_earnings`, `purchase_history`) and no-op/disabled lanes stay visible in the
detailed monitor but never paint a page red.

## Decision #167 — Coach-chat feature lane

coach-chat is stateless server-side: the client replays completed exchanges as `coachHistory` (<=20,
answers <=COACH_ANSWER_MAX_CHARS=64000 enforced identically on the live output stream so an
over-ceiling generation fails without `done`), `chatterQuestion` is coach-only and required, and
body size is policed by a content-agnostic 12 MiB transport limit, never by content bans. A short
`summaryMode` recap is cached under a mode-qualified key and never pushed to the durable
`fan_profiles` dossier; an unknown feature name returns `unknown_ai_feature`.

## Decision #168 — Governed OFAPI budgets

Historical budget parent. Its surviving UTC-day reset, retry boundary, balance floor, and lane
separation are consolidated into #170; its numeric allowances are not current.

## Decision #170 — Governed OFAPI budgets

Governed mirror reads are budgeted per origin principal per UTC day: 4,000 calls and 4,000 reserved
credits under a 7,000-credit global daily ceiling. The window and retry boundary reset at the next
UTC day; balance-floor and reservation safeguards remain. `OFAPI_DM_DAILY_CREDIT_BUDGET` governs
only legacy DM sync, not mirror lanes.

## Decision #171 — Sync pause UX

A partial substream pause shows Resume and hides Sync Now/Pause. Resume re-requests only the rows
actually paused. Visible OnlyFans compatibility rows (`light`, `transactions`, `dm_messages`) remain
non-resumable.

## Decision #172 — Release ops (dist-only)

A dist-only release MUST build from the checksum-pinned clean full base image published only after a
fully verified full deploy, and refuses an absent, unlabeled (without explicit override) or
checksum-mismatched tag; the running production image and its rollback snapshot are never retagged
as that base, and image/tag GC stays an owner-gated operation that cannot prune current, rollback or
the clean base.

## Decision #173 — Recovery generations

Every fresh follower/subscriber/DM-conversation sweep starts at max(checkpoint generation,
retained-row generation) + 1 — including inactive and hidden rows — so an owner checkpoint Reset can
never delete facts or need a migration. Detailed sync health degrades on ANY terminal `failed` task
even when the block looks up to date; `needsAttention` and pauses do not trip that gate.

## Decision #174 — Voice notes lane

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

## Decision #175 — Voice pilot hardening

Synthesis admission accepts a restricted generation only when user, page, conversationRef and fanRef
all match the requested fan (no group-id fallback); the ElevenLabs adapter does one fetch, no
retries, refuses redirects, and only a complete audio/mpeg body under the cap becomes a playable
artifact. `VOICE_NOTES_MAX_CONCURRENT_SYNTHESES` is a PROCESS-LOCAL gate — a second API replica may
not be enabled until it is replaced by a shared one — and an `indeterminate` row always reports
`billed:null` publicly.

## Decision #176 — Local Docker + build cache

Local Postgres is opt-in (no `restart: unless-stopped`) with bounded local log drivers; production
restart/logging policy and #172's checksum-pinned clean-base lifecycle are unchanged, and image/tag
pruning stays owner-gated and OFF by default.

## Decision #177 — Prompt dossier eligibility

A `fan_profiles` body may enter an AI prompt only when Core's own restricted generation ledger
proves it came from a usable FULL fan-summary (summaryMode=full, completed, nonblank, stop reason
not max_tokens/length, same page+fan identity, byte-for-byte equality with the terminal completion);
filtering precedes profile-version ordering so a newer unproven dossier cannot hide an older proven
one, and the prompt's dossier date is Core's `created_at`, never a client-supplied timestamp.

## Decision #178 — Stream v2 control lane

The v2 domain-event stream carries a third SSE lane, `event: control`, that never enters
DomainEventFrame validation (the marker must not be a synthetic domain frame);
`{"type":"replay_completed"}` is written once per connection after all replay flushes and before
buffered live frames, and clients MUST skip unknown control types.

## Decision #179 — Coach-chat draft context

coach-chat consumes the shared body's `draftText` as OPTIONAL context via a prompt-builder-only
`optionalDraft` flag — `requiresDraft` stays false and the mandatory-draft semantics of
improve-draft/voice-script are untouched. The draft is untrusted input (escaped, XML-wrapped, in the
UNCACHED task block) and is shed WHOLE under budget pressure; a KEPT draft displaces context at
SECTION granularity because the cascade trims the newest transcript only after every summary section
is exhausted.

## Decision #180 — Service egress proxy

Telegram and ElevenLabs both egress through ONE boot-only, all-or-none `SERVICE_EGRESS_PROXY_URL`
SOCKS5 identity, separate from page-owned proxy rows and fail-closed: a malformed tuple is a boot
error, ElevenLabs has no direct or page fallback, and a configured route that fails auth/connect
never falls back. Each operation owns and closes its own dispatcher; voice keeps exactly one attempt
while Telegram may retry <=2 transient failures but never a connect/auth failure.

## Decision #181 — v2 frame account mapping

`accountRef` on v2 domain frames is a SERVE-TIME page mapping, never event provenance: it is read
from the page's current OFAPI ref in the same SQL statement as each event batch, so it may change
mid-connection after a remap. Clients must not apply or checkpoint an unexpected ref — they refresh
snapshot/grants, rebind, and reconnect with the UNCHANGED cursor.

## Decision #182 — AI failure classification (1A)

The kernel is the SOLE classifier of provider/transport failures for the whole family — clients
consume the wire code and never re-parse provider bodies or infer their own class; every failed
generation must reach the chatter terminal path, the operator incident path, and durable telemetry.
Adding an error `code` to the existing frame is contract-free (clients must handle unknown codes
safely); adding a frame `type` requires a lockstep contract/SDK/client rollout.

## Decision #183 — AI failure telemetry (1B)

Six wire classes (provider_billing/auth/rate_limited/unavailable/proxy_unreachable/stream_failed),
one static message each, only 429 carrying Retry-After; failure phase is exactly
connect|provider_response|stream; every failed terminal records error_code/failure_phase/HTTP status
while completed and cancelled force all three null. Billing/auth latch globally and resolve on any
later success; other page failures need three consecutive classified failures before opening a
page-latched incident.

## Decision #184 — Server error hygiene

Only an `AppError` (plus the cursor-restart response's explicit extension) may cross the server
error boundary — an object that merely resembles `{statusCode,error,message}` is an internal 500,
and Zod errors are rebuilt from structured issues with caller strings removed. All four boundary
sanitizers share one core owning cause chains, secret-shape masking and clamp policy; redaction is
defense in depth (text masking plus Pino path censoring).

## Decision #185 — Error-handling canon

`docs/error-handling.md` is the single canonical error-handling reference for core, the Firefox
extension and Desktop: any change to classification, wire code/message, HTTP AppError, retry
disposition, failure-ledger fields, incident kind/latch/threshold/resolve, outbox policy, client
mapping or redaction must update the canon in the SAME family change; clients reference it instead
of keeping normative copies.

## Decision #186 — Critical-paging preconditions

Critical AI paging keeps four constraints: (1) `provider_usage_missing` currently records zero
non-approximate cost in the internal lane, so spend is undercounted until conservative estimation
lands; (2) a truncated `max_tokens` classifier result can still poison cached `needs_reply`
defaults; (3) incident ordering uses event time, recovery wins equal-time ties, and tombstone +
conditional resolve + outbox commit atomically under the incident-key advisory lock; (4) outbox
delivery is FIFO per incident/channel and bounded by `expireInSeconds`, not heartbeat. These are
open constraints, not a completed deploy narrative.

## Decision #187 — Plugins throw AppError

Any Fastify plugin that signals by THROWING must throw an `AppError` — the boundary's duck-typed
`{statusCode,error,message}` passthrough removed by #184 is never reintroduced and no allowlist is
added; the plugin is brought into compliance instead (e.g. rate-limit throws
`TooManyRequestsError`).

## Decision #188 — CI gate splits into shards

Branch protection requires a check literally named `Quality Gate`, preserved with `if: always()`.
`tests/voice-profiles.test.ts` and `tests/voice-notes-sweep.test.ts` use Postgres despite lacking
`.integration.test.ts`, so `test:unit` is not Docker-free. The earlier `createPool` error-handler
blocker is fixed; the tmpfs CI experiment is unblocked but not adopted.

## Decision #189 — No long dashes in model-facing text

No em/en dash may appear in any text that reaches a model (templates + their templates.ts twins,
builder.ts instruction strings, transcript normalizer) or in model OUTPUT including drafts and
example messages — the rule lives in both safety preambles; the paid-attachment marker grammar is
`[… - PPV $X.XX, state]` and its five sites (this repo's normalize.ts, fansly-ext's transcript.ts,
and the templates quoting it) must move together. Code comments are exempt.

## Decision #190 — Voice launch hardening

A queued voice row is owned by a heartbeat (updated_at refreshed each minute; 5 minutes without it,
not row age, means abandoned), quota refusal is stateless and creates no terminal row, audio
retrieval scopes (id, platform_account_id, user_id) in SQL, an ElevenLabs character-cost is honoured
only as a non-negative integer, and voice admission/dispatch sit inside the Stage-28 material-time
erasure fence.

## Decision #191 — A gated skip is not a successful sync

A ramp-gated chunk performs no vendor call and claims no success/progress. Current mechanics are the
durable `feature_gate` pause introduced by #194; UI copy keys on the recorded gate reason, never the
generic skipped outcome.

## Decision #192 — Ramp-gate wake-up

A config change queues affected Fansly streams only on a non-ramped -> ramped transition. Every new
gated lane registers its keys in `GATE_CONFIG_KEYS`; otherwise opening the gate cannot wake it. The
resulting pause/resume state follows #194.

## Decision #193 — Deleted fans in top-spenders

`pageTopSpenders` returns `entries[].deletedAt` (fans.deleted_detected_at, null = alive) so a
deleted account is distinguishable from an unloaded name; deleted fans stay IN the ranking because
their spend is in the totals, and the field is `.optional()` so a newer client can talk to an older
kernel.

## Decision #194 — Fansly transaction-data correctness

Ramp-gate skips materialize as durable `feature_gate` pauses; opening a registered gate wakes only
the affected streams. Subscriber expired-history bootstrap is archive-only and cannot deactivate an
active row. PPV target discovery uses exact transaction-key mappings and fails closed on conflicts.

## Decision #195 — Agent principal isolation

An agent key authenticates into its own AuthPrincipal variant with NO user field (kind "agent",
capabilities + explicit pageIds), extending #116's taxonomy; route kind `agentKey` admits only agent
principals and every other kind refuses them, which makes `any` an explicit allowlist of pre-agent
methods rather than a wildcard. An agent's page scope is its grant (never `undefined` =
owner-everything), a page outside the grant and a nonexistent page return the same byte-identical
404 decided at the verdict layer, and authentication slides expires_at (+90d, clamped to
created_at+365) inside the same guarded statement that stamps last_used_at.

## Decision #196 — Agent Read Plane

Every 200 from /api/v1/agent/* carries three INDEPENDENT axes — `delivery` (a property of the
response), `capture` (a property of the world, computed from scope/source/window and from nothing
else, pinned byte-identical with and without result filters), `fieldStates` (per field, before any
row is fetched) — plus `conclusion.blockers`; an empty collection is never a bare []. PARTIALLY
supersedes #52 (transcript material leaves only through these operations, only for an agentKey
principal, with capability, budget, audit and revocation); #57/#140/#142 and DP 7/8/9-A stand.
Globally addressable operations answer 200-with-empty, page-scoped ones a static 404.

## Decision #197 — Capture floor, not absence proof

The plane may report a capture FLOOR (`captureFloor`, kind `oldest_stored_row`, from its own
unbounded query) and gaps/caveats, never an absence proof: `absenceProvable`,
proof/ceiling/gap-detection schemas and thirteen proof-shaped blockers are removed, so "we hold
nothing before date X" is sayable and "nothing happened before X" is not expressible.

## Decision #198 — Agent search is Postgres FTS

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

## Decision #199 — One writer for the blockers

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

## Decision #200 — Agent keys are issued, never recovered

An agent key's raw token is returned exactly once and stored only as sha256; a bad capability or a
lifetime past the 365-day ceiling is a 400, never a silent narrowing or clamp, and the key row
commits in ONE transaction with its audit (same for a revocation, whose audit is written only on the
transition). Delivery is packages/hub-agent-cli (`hub`), one command per operation, all HTTP through
the generated SDK, no state written, exit 0/3/4 with a document on stdout in every case, credentials
file refused when world-readable, and error output never carries KernelApiError.body. exportPolicy
stays at `no_raw_transcript_export_endpoint_yet` until both clients re-vendor.

## Decision #201 — Help/Review prompts: Russian output, receipts required

help-me and chat-review split language by AUDIENCE: chatter-facing analysis in Russian («ты»),
fan-facing suggestions/rewrites in the fan's language. Both demand receipts (quoted fragment under
15 words, judge the window as a window) and fixed capped blocks — help-me СИТУАЦИЯ/ЧТО
УПУЩЕНО/СЛЕДУЮЩИЙ ХОД/РИСК under 150 words, chat-review ВЕРДИКТ/ДЕНЬГИ/ПЕРСОНА/ОШИБКИ/ЧТО РАБОТАЕТ
under 400 with three money-first mistakes; XML wire format unchanged, templates.ts byte-identical,
prompt-manifest.json updated in the same change.

## Decision #202 — Hydration autopilot

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

## Decision #203 — Agent transaction summary

agentDatasetQuery gains `summary: true` for the transactions dataset only: one statement returns
currency-grouped count/gross/net/fee plus a page-wide windowless floor, with `basis:
matching_rows_in_hub` as the wording boundary — no rows, no cursor, no new route/table/migration,
and never a claim of vendor completeness.

## Decision #204 — Coach situation preset

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

Per the cross-repo design in
`goose/fansly-ext/docs/superpowers/specs/2026-08-02-help-into-coach.md`, the extension follow-up
routes the Help button and hotkey into this preset turn. Core continues serving
`help-me` unchanged for older extension builds and the desktop app. Physical
retirement of that feature is a separate later decision, gated on desktop
usage.

## Decision #205 — Creator-post capture and Agent read

Creator-post capture is an ordinary sync stream seeded PAUSED per page and deliberately excluded
from scope `all`; verbatim post text is served only through the existing Agent dataset operation
behind BOTH `read:datasets` and `read:messages` — no post-specific capability, route, CLI command or
FTS. Missing rows, empty pages and partial timelines are NEVER deletion proof.

## Decision #206 — Fansly reverse evidence and fail-closed completeness

Fansly purchase history pages by `before = last orderId` and terminates ONLY on an empty successful
page — a short non-empty page is continuation, never completeness; a transaction page needs a valid
non-negative `total`, and one malformed money breakdown poisons the whole (fan, window) rather than
inventing a partial or a zero. Fansly egress requires a proxy at every standalone
verification/onboarding boundary (reaffirms #124), and live Fansly response dumps may never become
test fixtures.

## Decision #207 — Smoke consumer projection checkpoints

Historical implementation record: [archive](decisions-archive.md#decision-207).
It does not define current behavior; use the Quick Reference status and later decisions.

## Decision #208 — Live-list terminal verification and optional DM totals

Destructive finalization of a Fansly list requires an exact match — the generation's unique count
against a FRESHLY captured terminal headline (follower reconcile) or against a stable present
provider total (DM); when `aggregationData.total` is consistently absent/null the walk may complete
and advance freshness but only with `destructiveFinalization:false`, leaving unseen conversations
visible. Stale visibility is always preferred to inventing completeness from a field the provider
does not send.

## Decision #209 — Fansly post monetization

The rendered Fansly post tip total is `tipAmount + attachmentTipAmount` — never `totalTipAmount`,
and two absent components record NO counter fact rather than a zero; any cross-post or campaign goal
aggregation MUST deduplicate by `tipGoalRef` or it double-counts a shared goal. The money-bearing
post datasets require read:datasets+read:money+read:messages, and a shortfall between captured
`post_tips` rows and the post counter is reported and investigated, never filled by inference.

## Decision #210 — Fansly live post-tip contract correction

A `/tips` item's flat `targetId` is exact donor-to-POST evidence and never donor-to-GOAL: copying a
post's goal ref onto its tips is false, and subset-summing tip amounts against a goal counter is
inference Hub does not do. A null `postTipGoalRef` means `source_did_not_provide`, never `direct`,
and a later `unknown` sighting can never erase an exact goal ref captured earlier.

## Decision #211 — Exact transaction tip context

Tip notes are projected only from exact provider tip ids in the retained `/message` `tips[]` sidecar
— never from a time-and-amount or nearest-message heuristic — served through `tip_transactions`
behind read:datasets+read:money+read:messages, with every write taking the Stage-28 erasure fence so
retained raw can never resurrect an erased note. `transactions.relatedMessageRef` is legacy and MUST
NOT be read as a message id; absent context is `not_captured`, an absent note
`source_did_not_provide`, an empty one `observed_empty`, and there is deliberately no `messageRef`
until an exact provider-backed message identity exists.

## Decision #212 — G1 storage stop-loss: telemetry is bounded, capture is not

Telemetry representations may be bounded; captured facts never are. Checkpoint summaries are bounded
while `page_sync_cursors` stays authoritative, and stdout remains fallback evidence when DB
telemetry persistence fails. `SYNC_OBSERVABILITY_RETENTION_DAYS` must not be lowered until
`sync_raw_payloads.sync_run_id` is indexed and leaf/parent retention is split: current deletes can
seq-scan the raw table and sever #133 raw-to-observation repair lineage.

## Decision #213 — Disk runway latches

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

## Decision #214 — G3 checkpoint cutover: the generation set is the membership authority

Row-side `page_dm_threads.last_seen_generation` — not a cumulative checkpoint array — is the
membership authority, and the destructive visibility pass runs ONLY on an exact `count(generation)
== observedCount`; a plausible erasure NEVER authorizes destruction, it only downgrades the anomaly
to a note (per #208, stale visibility beats a vanished thread). An uncertified membership withholds
the success stamp and `lastFullSweepCompletedAt` too, not merely the destructive pass, and retries
as a fresh sweep under a higher generation (+15min; an erasure-fenced page defers +60s).

## Decision #215 — G5 slice 1: the CAS copy is written before the fact, and proved after it

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

## Decision #216 — jsonb reads are single-parse

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

## Decision #217 — G5 slice 2: reads move to the catalog through a staged, fail-open seam

Every served capture body goes through `payload-reader.ts`. If an inline body exists it remains a
valid fallback in every mode; if a pointer-only catalog read fails, #223 requires
`CapturePayloadUnavailableError`, never null/empty. The traffic read path owns no parity alarm; the
bounded verifier alone opens and resolves it.

## Decision #218 — G5 slice 3a: the queryable fields get typed columns of their own

A query that digs a FIELD out of a capture body must read a typed column derived in packages/db
inside the SAME INSERT as the body (never a post-commit UPDATE, never a producer); the columns are
`text` because capture-first outranks type tidiness, an index-backed predicate uses two disjoint OR
arms with partial indexes rather than an unindexable `coalesce`, and every inline-extraction
fallback is marked `// CAS-INLINE-FALLBACK:` and may be removed only after the historical rewrite
has run over every production month.

## Decision #219 — G5 slice 3b: erasure becomes catalog-complete, and a capture body gets its first lawful death

A catalog body is deleted only after its last envelope reference is gone; bodies referenced by
surviving envelopes are bystander facts and are kept. The older claim that a dangling reference was
harmless is withdrawn: #222's lock-before-verdict and writer-lock protocol is mandatory because a
dangling reference can mean fact loss.

## Decision #220 — G5 slice 3c-1: a captured body stops being written twice

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

## Decision #221 — G5 slice 3c-2: the historical rewrite is a one-time lawful UPDATE, consumed by the reclaim that follows it

The historical rewrite is owner-typed CLI only (no schedule, no config flag) and is the ONE lawful
UPDATE in this project, licensed solely because `capture:reclaim` physically consumes the bloat it
creates — so backfill→verify→reclaim is one ritual per month; a historical body is filed under its
own capture month and always gets the `platform_capture` lane (deriving it from `source` would
narrow future erasure reach); superseded partitions park in `capture_pending_drop`, never Stage 28's
`tiered_pending_drop`; and the drop is a separate command whose `DROP TABLE` carries a
statement-level licence in tests/retention-deleters.test.ts.

## Decision #222 — G5 review fix: a stamped reference outliving its object is a lost fact, and the two acts are now ordered

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

## Decision #223 — G5 review fix: the reclaim's four missing gates — a typed column nobody could fill, an unreadable body that read as an empty one, a headroom law behind the growth it governs, and a ritual its own gate refused

An unavailable captured body must never be recorded as an empty, parsed or absent fact: the CAS read
seam RAISES CapturePayloadUnavailableError (a sentinel would go unchecked) and every read site must
propagate, catch-and-count, or answer 503 — while a row that still carries an inline body never
throws in any mode. Every growth-producing or destructive capture act checks its gates BEFORE it
writes (typed-column completeness, headroom with a non-config 5 GiB floor re-checked mid-walk),
--assume-free-bytes is rejected together with --execute, and checkWritersStopped stays maximally
broad because the api is itself a capture writer on ~6 paths.

## Decision #224 — Fansly capture widening + the DM media plane (WP-F0)

Fansly capture may widen only through the NAMED 18-field allowlist on embedded account records —
lastSeenAt, followCount, subscriberCount, postLikes, accountMediaLikes, timelineStats, streaming,
version stay out because they make every body unique and destroy the ~11:1 dedup collapse — and no
byte ceiling may ever defer a capture lane. message_archive must never regain
purchase_state/purchased_at/purchase_ref (purchase state is a JOIN on message_media_offers); a mixed
deliverable+projection-only append requires a checkpoint and the order
deliverables→hidden→checkpoint; and canonicalization refuses with a typed partitionBlocked count
(observation NOT stamped) when the target domain_events month has no attached partition.

## Decision #225 — Fansly account statistics (WP-F1) + the projection registry

New projections register through `ProjectionDefinition` and may not include operational-state
tables. Per-lane egress caps count HTTP attempts, persist in the cursor, and defer rather than drop;
every stream has its own flag and fail-closed page allowlist. The date-window history walk in the
original record is invalid; #233 is the only current walk rule.

## Decision #226 — Fansly notifications (WP-F2) — the verbatim-first engagement core

Notifications are the only permanently-lossy capture surface, so every row and every code is
journaled verbatim and typed derivations ride BESIDE the verbatim event, never instead of it — the
repo's own fansly_api_spec.md was wrong on 8 of 16 codes including both money codes, and raw storage
is what made that recoverable; codes stay integers behind a versioned read-time label table whose
'confirmed' status needs two independent live examples. Notification head state is ordered by the
provider's occurred_at (never account_seq — the deep backfill appends older facts at higher seq),
the cursor is a notification id not a timestamp, a narrowed type form must write
partial_provider_surface coverage INCLUDING the terminal row, and subject_refresh_state is
operational state no rebuild may truncate.

## Decision #227 — Fansly content catalog (WP-F3) — the lane that measures M, and closes FEAT-002

A roster event is keyed per OBSERVATION (never on the ref-set hash — a thing that vanishes and
returns unchanged would dedupe and stay marked missing_since forever) and is never emitted from a
paged or partial listing; catalog size M is count(distinct media_offer_ref), never Σ item_count.
Media bytes/delivery URLs (location, locations[], variants[]) are journaled but read by nothing; a
two-writer table is rebuilt scoped by link_kind; each timestamp field is decoded by its own unit (no
seconds-or-ms heuristic); an empty FIRST page of a non-empty album stops the sublane with one
anomaly and never retries.

## Decision #228 — Fansly comment archive (WP-F5) — the lane [E1] had to authorise, and the POST that is never sent

The comment archive reads GET /post/{postId}/replies WITHOUT the browser's verify POST — no
write-shaped call to Fansly, pinned by a whole-file grep of packages/fansly/src/adapter.ts; walk
rows are seeded in the SAME transaction as the creator_posts upsert, a truncated roster may never
mark a complement missing_since (the CLEAR half still runs), accounts[] is allowlisted to 18 fields
before journaling, a failed look does not move last_visited_at, and the walk queue survives a
projection rebuild. The cap ships at 100 attempts/page/day; the raise to 300 is one config flip
against four named criteria and 400 is the registry-enforced ceiling.

## Decision #229 — Fansly posts widening (WP-F6) — the counters the timeline was already serving

Widened provider fields are nullable — absent is NULL, never 0, and the parser refuses a whole page
rather than half-reading an unrecognised field; every new field enters the content hash, hashtags
are derived with a Unicode-letter/number/mark grammar whose NFKC form and parser version ride in the
hash, and attachment/mention refs are copied by a three-key allowlist so no URL-bearing key can
reach a serving column. Refresh due-ness is computed from published_at/last_visited_at against now
(never a stored next_due_at), engagement_observed_at is derived by the projector rather than stamped
by the lane, the refresh budget is counted separately from the uncapped timeline walk, and only ids
the response NAMED count as refreshed.

## Decision #230 — Fansly payouts (WP-F7) — money OUT, and the mask that is ours

Payout credential masking is OURS, not the platform's — `<first>***@domain` and `****<last4>`, the
only value derived from metadata, enforced by a DB CHECK in 0141 and decoded PROVIDER-KEYED so an
unknown provider publishes nothing; capture-first is not suspended for credentials (the full body
stays journaled) and the serving side is closed instead: both payout tables stay off the agent
allowlist with a pinned absence test. Status codes are stored as (code, label, confidence) with
unknown codes projected as unmapped rather than dropped or assumed successful, amounts are already
mills and nothing scales, and an offset-paged walk gets no roster plus a first-row-repeat guard.

## Decision #231 — Fansly per-media statistics (WP-F4)

The per-media stats lane is attempt-capped, may intentionally saturate its cap, and reports its
computed long-tail cycle. Queue state lives in `subject_refresh_state(plane='media_stats')`, never
in rebuildable media projections. Age is computed from `coalesce(created_at_platform,
first_observed_at)` as corrected by #233; the nonexistent `publicationTimeBasis` name is retired.

## Decision #232 — Fansly serving surface (WP-S1)

The WP-S1 serving surface never authorizes capture: all eight routes are GETs with no body, no
handler enqueues a sync or flips a flag, and all eight carry `owner-session` + page scope — that is
the money gate, and widening any of them is its own PR editing both the page-scope list and
`tests/contracts-auth-declarations.test.ts`. Every fact dataset must declare a non-empty
`readPlanes` plus a `captureFloorPlane` (`readPlanes: []` is forbidden — it silently disables
capture-floor epistemics), `disclosesPurchase` is a REQUIRED boolean whose OR with `verbatimText`
decides `read:messages`, `post_replies` journal bodies are never served, gross is derived from net
at read time in a `derived:true` envelope, and a chart with no coverage badge is a claim only
`provider_exhausted` earns.

## Decision #233 — Fansly history walks corrected against production (amends #225, #231)

Daily stats history walks backward by calendar month using `year`/`month` and verifies
`monthWasHonoured`; hourly is trailing-window only, while earnings retains its proven historical
windows. Per-media all-zero windows count as empty, cannot walk below the created/first-seen floor,
and every visit stamps `last_visited_at`. The month form is still NOT production-proven; the
endpoint probe must pass before the rule is described as verified live.

## Decision #234 — Staged configuration changes

Owner-approved 2026-08-23: staged configuration flags flip one at a time. Each flip has its own
named verification window and rollback observation; unrelated staged flags are never bundled. This
is the rule formerly mis-cited as the '#70 ritual'.

## Decision #235 — Decision-log integrity

Owner-approved 2026-08-23: this file contains durable current constraints, not session history,
branch hashes, test counts, or deploy narration. Existing decision numbers are never reused or
renumbered. When a current rule or cross-repo reference changes, update the rule and all live
references in the same change; Git and `decisions-archive.md` hold history.
