# Build spec v6 — FROZEN (OnlyFans AI-context freshness)

Supersedes build-spec-v5.md. v6 = v5 + three pre-implementation audits folded in
(feasibility-vs-code, optimality pass, tabletop walkthrough). Design closed; this is the
build document. Repos: core (main), desktop (0.1.33 ALREADY RELEASED — a7d2829 tagged;
future release = 0.1.34; windows-build.yml publishes the feed on ANY v* tag push —
feed-silent build = workflow_dispatch WITHOUT a tag). Prod = 2c500c1 (07-10 deploy).

Problem: kernel builds AI transcripts from message_archive (tail of two independent
minutely crons; 0–2+ min stale) while the chatter UI is seconds-fresh. Architecture
settled: ONE ledger (domain_events); union read for freshness; corrections later as
material-fingerprint superseding events. Fresh source = dm_message_archive (post-settle,
mills-native, isOpened tri-state, media, tombstones, conversation-indexed; source enum
pre-reserves rest_reconcile/rest_backfill). Precondition to verify on prod at deploy:
ofapiDmColdArchiveEnabled effectively ON.

## Wave 1 — kernel-only, one deploy, four PRs

### PR1 — safety + capture
- Disable message-archive rebuild (guard at the CLI call site / inside
  rebuildMessageArchiveProjection — the `delete from` text lives in the already-
  allowlisted repo file; guard placement keeps the retention pin untouched). Rationale:
  rebuild replays only the ATTACHED domain_events parent (detached/tiered partitions
  invisible) and destroys backfill_source rows.
- Flip pageDmPruneEnabled default true→false in BOTH config-registry.ts:202 AND
  config.ts zod default (parity test enforces together); PAGE_DM_PRUNE_ENABLED=false
  also as pre-deploy env condition; verify api+worker+scheduler heartbeats post-deploy.
- Webhook: DELETE the route-level rate-limit config block (modules/ingest/index.ts:93-103)
  — receiveOfapiWebhook already implements the full target order (HMAC → validate →
  journal+observation one tx → 200 incl. duplicates → best-effort boss.send with sweep
  recovery; journal-tx failure → 5xx). NO soft limiter (cut — speculative). Remove the
  orphaned ofapiWebhookRateLimitMax/WindowSeconds keys from registry + config.ts env
  schema TOGETHER (parity test). Prod-host check (owner): no upstream nginx 429 remains.
- Runbook note: if the post-settle cold-archive upsert throws, the row retries via the
  existing minutely archive sweep → up to ~60–90s where UI shows a message the union
  lacks; accepted, no alarm.

### PR2 — reader correctness (unflagged)
- Move page-access into features/index.ts right after the platform check (:115-118),
  mirroring the gateway's combined not-found shape (canAccessPage needs only
  principal + pageId — no state from context loads). Gateway re-check stays.
- Transcript path filters deleted_at AND content_pending — in the READER/repo layer,
  never in modules/ai/prompts/** (prompt-manifest pin).
- Separate internal AI reader accepting limit ≤1500; dashboard archive route keeps the
  500 clamp and its contract.

### PR3 — union read
- Flag: `aiTranscriptFreshUnionMode` = EDITABLE + runtimeApply:"live" STRING with
  enumValues ["off","shadow","serve"] (staged lane is boolean-only — cannot be used;
  precedents: egressPacerMode, fanslyNewStreamPageAllowlist). Read via
  loadEffectiveConfig at the transcript read-site → mode changes without restart.
  #70 ritual procedural. Console shows it read-only (A9) — flips via PATCH API.
  Update tests/config-registry.test.ts pinned LIVE_KEYS + test title count.
  Runbook: `off` = PERF rollback (shadow still executes the query!); `shadow` =
  correctness rollback. No cleanup needed after any rollback.
- Query: one-statement CTE (single MVCC snapshot; else REPEATABLE READ read-only).
  Order of operations: candidates from BOTH stores scoped (account, conversationRef);
  PLUS cross-source tombstone lookup keyed off candidate message refs via
  dm_message_archive's UNIQUE (platform, ofapi_account_id, platform_message_id) —
  resolve the page row's ofapi_account_id for that arm (no (platform_account_id,
  platform_message_id) index exists); join by message ref → tombstone dominance (either
  store + page_dm_messages.deleted_at) → source preference (dm row wins) → PPV upgrade
  from page_dm_messages.purchased_at (isOpened true only, never downgrade) →
  deterministic ORDER BY (occurred_at/message_created_at with EXPLICIT NULLS LAST
  policy, guarded-numeric message id, lexical fallback, never throws) → dedupe/
  tombstones BEFORE the final tail cap. OnlyFans only; new platform=== branch → bump
  scripts/platform-branch-budget.json 49→50 with written justification (NB: tests/
  count too; don't write the literal in test names).
- Serve-mode fallback on union error = archive + stale-context telemetry bit. Never a
  hard failure.
- Per-generation context manifest → `params` jsonb of the existing restricted
  generation record (insertAiGenerationContent; additive key; shadow generations settle
  through the same recordTerminal finally-path — no second write path; quota-denied/
  pre-stream throws don't manifest, by design). Channel = internal optional argument on
  prepareAiGatewayStream — NOT a field on aiGatewayStreamBodySchema (client-forgeable,
  shared with the raw gateway route, forces SDK regen). Fields: mode/source, archive
  count/union count, archive head ref/time, union head ref/time, heads-equal,
  additions/tombstones, signed gap ms, query duration, loader version. No text.
- Honest backlog signal: NO new table. Per-family backlog-age gauges added to
  computeGoldenSignals: for each CANONICALIZER_FAMILIES entry, now()-MIN(received_at)
  over parse_version < family.version AND source AND kind IN family.kinds (registry-
  driven → version-0 kinds excluded by construction); one more series for the PR4
  readthrough kind. Sampler is a separate job from the sweep → wedged sweep is measured,
  not self-reported. Embed the family version in the metric name. Threshold in
  GOLDEN_SIGNAL_THRESHOLDS_MS → existing breach→incident latch for free. Uses the
  existing observations_parse_idx access path; no new observations index without prod
  EXPLAIN.
- Perf gate before serve (right-sized to fleet reality ~876 archive rows/day): ~10k
  archive rows / ~3k duplicate cold rows / ~500 tombstones in the hot conversation PLUS
  rows spread across other conversations and a second account, ANALYZE after seeding;
  EXPLAIN asserts both conversation indexes used, no account-wide seq scan; limit-1500
  exercised; shadow p95 well under provider latency.

### PR4 — readthrough reconcile (own flag — boolean STAGED boot is fine here)
- Widen ReadGatewayCaptureEntry (today only operation/status/body): chat id, pagination
  cursors, conversationRef. New observation kind `ofapi_gateway_chat_messages_v2`; old
  kind untouched forever (no chat id → never sweep it).
- Migration 0075+ (single-tx, no CONCURRENTLY): rest_material_observation_id bigint
  NULL, rest_material_observed_at timestamptz NULL; ALTER source_journal_id DROP NOT
  NULL (verified: writers keep it required in their input types; no reader/zod/erasure
  consumes it; btree tolerates NULLs). rest_platform_changed_at DEFERRED to Wave 2.
  Never fake journal ids. No FK to observations.
- upsertDmMessageArchiveFromReadthrough — WAVE-1 DUMB MERGE (full per-field precedence
  deferred to Wave 2's reducer): INSERT missing rows; on conflict FILL-ABSENT ONLY —
  COALESCE nullable columns (price_mills, sender_platform_user_id,
  in_reply_to_message_id, platform_conversation_id, fan_platform_user_id,
  message_created_at) + sentinel-aware fill (text_plain='', sender_role='unknown',
  media_metadata='[]' — exactly the tombstone-stub shape, so REST completing a stub
  falls out free) + isOpened monotone advance (true wins, false beats null, never
  true→false); deleted_at sticky; WHERE ... IS DISTINCT FROM over that small expression
  set = true no-op (chat-open of 100 known messages rewrites 0 rows; rest_* provenance
  updates only inside the guard). Per-item parse failures skip-and-count. Nothing lost
  permanently: the v2 observation is verbatim; Wave 2 replays via its version floor.
- ALSO make the WEBHOOK cold-archive upsert merge-guarded (tabletop S3 defect): at
  minimum isOpened-monotone and never regress REST-advanced material on late/retried
  webhook applies (its SET list already doesn't touch rest_* columns).
- Replayable projector — NOT a canonicalizer family (pure-sync seam stamps parse_version
  before/without projecting → silent loss; empty-draft family double-stamp hazard):
  a dedicated small sweep runner with its own version-floor constant, reusing
  listObservationsForReplay(source='readthrough', kinds=['ofapi_gateway_chat_messages_v2'],
  belowParseVersion=1) + markObservationParsed, PROJECT THEN STAMP, own try/catch +
  page budget (mirrors runFamily's fault isolation), invoked from an existing minutely
  handler (canonicalize.sweep handler after runCanonicalization, or alongside
  sweepOfapiDmProjections). API-side immediate best-effort projection after capture;
  the sweep is the retry. EXPLAIN the listing on prod-size data (v1 readthrough rows
  share parse_version=0; kind filter is outside the index).
- Counters (readthrough_reconcile upserts/noops/drops/parse_skips) = fields on the
  runner's run-result object logged by the sweep (existing idiom), no new surface.
- New files must not contain the literal "delete from" (retention pin greps comments
  too) nor a literal "fetch(" (raw-fetch budget 13/13); new TS strictness-clean.

### Erasure tests (part of PR4 definition-of-done)
- Integration tests: fan/page erasure covers dm rows sourced REST-only / command-only /
  webhook-then-REST. REST-only rows are reached via fan/conversation refs (must be
  filled by the upsert); unprojected v2 observations are reached via the payload
  ref-match — the envelope's conversationRef is load-bearing.
- Tombstone-first-then-REST: null-ref stubs are UNREACHABLE by fan-scope predicates in
  both stores — DOCUMENTED CONTENTLESS SURVIVOR (message id only, no content), asserted
  explicitly in the test as a waiver; Wave 2's reconciler skip-and-counts them.
- Explicit waiver line: ofapi_webhook_events.payload is not an erasure target anywhere
  (pre-existing, owner decision pending — do not silently inherit).

### Rollout
One image, flags off → PR3 shadow 24–48h (verify: manifests flowing, overlay_would_add
rates, zero union errors, p95 flat) → serve (own window) → PR4 flag (own window; watch
reconcile counters = measured webhook-loss rate). All flag flips live/PATCH (PR3) or
boot (PR4). Desktop: nothing to build (0.1.33 live); only verify feed serves 0.1.33 and
add the "0.1.29 = manual-reinstall-only" runbook line (updater has no allowDowngrade —
verified). Prod precondition checks: ofapiDmColdArchiveEnabled ON; no upstream nginx 429.

## Wave 2 — corrections program (unchanged from v5 EXCEPT the additions below)

As v5: material_field_provenance jsonb; material_fingerprint sha256("dm-material-v1\0"+
canonicalJson) over material fields only (bytea; hex only in dedup keys; stale-REST/
changedAt-only → same fingerprint; real change → new); emitted_fingerprint +
emitted_event_id + revision_no; MessageFactCandidate with per-field presence +
GPT's precedence table pinned verbatim; superseding events = same event types, new
account_seq, dedup key msg:<dir>:<id>:<fpHex>, supersedesEventId + fingerprint in event
DATA (tiering pins domain_events top-level columns); EXTEND domain-events-enrich for
schema-v2 superseding events (emit COMPLETE merged head — thin frames leave desktop
unrepaired; desktop whole-row upsert verified safe for repeated ids); message_archive
projector learns same-message superseding merge; material!=emitted = queryable repair
signal + minutely bounded reconciler; sends-as-facts after the direct-confirm raced
seam fix (text/media sends only); rest_platform_changed_at column lands here; fan
erasure adds rest_material_observation_id to lineage; contract phase after next desktop
release: observed-head manifest → freshness badge via versioned endpoint/capability;
client witness only if manifest data shows kernel-invisible heads.

WAVE-2 MIGRATION PREAMBLE (required, from tabletop S7):
1. Fingerprint BACKFILL for all pre-existing dm_message_archive rows; set
   emitted_fingerprint = material_fingerprint (+ emitted_event_id) for rows already in
   the ledger — BEFORE enabling the reconciler, else the entire history flags as
   uncorrected and it mass-appends redundant superseding events.
2. Wave-1 REST-only rows (source_journal_id NULL) legitimately get their first events
   appended — state the initial-drain bound; needs (1) first.
3. Null-ref tombstone stubs cannot satisfy non-null ref requirements — reconciler
   skip-and-counts them explicitly.
4. Seed material_field_provenance for legacy rows from the existing source column.

## Ratchet/test updates the build includes (complete list)
1. platform-branch-budget.json 49→50 + justification (PR3).
2. config-registry.test.ts: LIVE_KEYS += aiTranscriptFreshUnionMode (+ title count);
   BOOT/staged list += PR4 flag; env-schema↔registry parity for added AND removed keys
   (webhook rate-limit pair removed in PR1).
3. pageDmPruneEnabled default flip in registry + config.ts together.
4. Migrations 0075+ single-tx.
5. Untouched (by construction): retention-deleters pin, contracts-auth pin, prompt
   manifest, raw-fetch budget, SDK/OpenAPI (no routes.ts change anywhere in Wave 1).

## v7 BINDING AMENDMENTS (final GPT delta review — override anything above on conflict)

1. **PR3 flag transitions:** the live-edit endpoint has no transition rule → pin one:
   upward only off→shadow→serve (stepwise); rollback serve→shadow, serve→off,
   shadow→off allowed; validate against current desired value inside the same locked
   tx that writes the override. Env default off; clearing an override must resolve to
   off. Read the mode ONCE per generation (in loadTranscriptContext or immediately
   before it in prepareAiFeatureStream). A failed mode read must NOT silently fall back
   to archive-only — fail the request or mark unknown-freshness in the manifest.
2. **PR4 immediate-path stamping:** change insertObservation's result to
   {inserted, observationId, receivedAt} — returning the EXISTING key's received_at on
   the duplicate path too; the immediate projector stamps with that exact value (the
   stamp predicate is (id, received_at) — partition-exact), never new Date().
   Error boundary: pure per-item parse failure = skip+count, stamp after the rest;
   ANY DB/upsert failure = abort, no stamp; page-budget exhaustion mid-observation =
   no stamp (partial rows replay idempotently); stamp failure after projection = leave
   below floor (replay = material no-op). Add a rolling-version test: v1 API immediate
   projector running after a v2 worker projection must not regress the row.
3. **Exact merge shapes (both writers; replaces the "dumb merge" prose):**
   P := a.message_created_at IS NULL (tombstone-stub hydration predicate).
   W := P OR (a.rest_observation_id IS NULL AND excluded.source_received_at >= a.source_received_at)
   (webhook may replace webhook-owned material; once REST advanced the row, webhook is
   fill-only + monotone until Wave 2's platform-change ordering).
   advance_opened(old,new) := TRUE if either TRUE; else FALSE if either FALSE; else NULL.
   REST writer per field: ids/createdAt/price/reply = COALESCE(old, incoming);
   sender_role = incoming only when old='unknown'; is_sent_by_me = incoming only when P;
   text = incoming only when old='' and incoming non-empty; is_opened = advance_opened;
   is_tip = old OR incoming; tip_amount = GREATEST(old, incoming); media = incoming only
   when old='[]' and incoming non-empty; deleted_at untouched. Webhook writer per field:
   if W → prefer incoming (COALESCE(incoming, old); text/price/media replace when
   incoming non-empty/non-null); else fill-only; is_opened ALWAYS advance_opened;
   is_tip OR; tip_amount GREATEST; is_sent_by_me incoming only when P; deleted_at and
   rest_* untouched. BOTH writers guard with ROW(next_material_tuple) IS DISTINCT FROM
   ROW(current_material_tuple) — provenance/updated_at excluded from the comparison and
   updated only inside the guard; rest_observed_at = the observation's received_at.
   Tombstone writer: ON CONFLICT DO UPDATE SET deleted_at=COALESCE(old,excluded) ...
   WHERE a.deleted_at IS NULL (today it rewrites provenance on every repeat).
   COUNT the non-sentinel conflicts Wave 1 deliberately keeps (text/price/direction/
   timestamp/reply/media) — "conflicts barely exist" must become a measured number.
4. **Erasure non-resurrection fence (PR4, blocking):** retained ofapi_webhook_events
   payloads + the cold-archive sweep (reads pending/failed journal rows) can RECREATE
   erased dm_message_archive rows. Every archive material writer (webhook, REST,
   tombstone) checks the executed-erasure scope tombstones before upsert; a non-dry-run
   erasure row fences from completed_at IS NULL (it's written before deletion starts;
   scope index exists); serialize the fence-check+upsert against erasure via a shared
   page/account advisory lock (check-before-write without serialization still races).
   Tests: pending/failed/already-claimed journal rows + tombstone hydration after
   erasure. The null-ref-stub waiver stands only WITH this fence.
5. **Health gauges:** iterate a shared health-floor registry ({name, source, kinds,
   version}) covering CANONICALIZER_FAMILIES + the readthrough runner descriptor
   (imported by both the runner and the sampler — floors cannot drift); emit zero when
   caught up; per-kind MIN over the (kind, received_at) index; per-family try/catch —
   one failed probe must not suppress the rest AND must itself open/retain an incident;
   mirror the gauge into the p95 slot (the latch evaluates p95 only); add every family
   metric to GOLDEN_SIGNAL_THRESHOLDS_MS.
6. **PR1 contract nit:** remove 429 from ofapiWebhookReceive.response in routes.ts +
   `pnpm contracts:generate` (the ONE routes.ts change in Wave 1; response-schema only,
   no auth/oper change; client re-vendor NOT required).
7. **Perf gate shape:** BOTH a concentrated worst-case conversation AND multi-account/
   multi-conversation spread (spread-only misses the conversation-tail sort).
8. **Wave-2 constraints from this review:** bump the readthrough floor 1→2 at reducer
   cutover so v1-stamped observations replay through the real reducer; compute
   material_fingerprint from the REDUCED head (never raw wave-1 rows/provenance);
   rest_observed_at is observation time, NOT platform edit time (rest_platform_changed_at
   remains a separate wave-2 input); the candidate reducer REPLACES both wave-1 merge
   paths (no competing writers); update the shared health-floor descriptor in the same
   commit as any version bump; ordering = project candidate merge → append superseding
   event → advance emitted_fingerprint → stamp (material no-op may stamp immediately).

## v7.1 PRECISION FIXES (SQL/mechanics verification — apply verbatim)

1. Column naming drift: W predicate uses the MIGRATION's names —
   `P OR (a.rest_material_observation_id IS NULL AND excluded.source_received_at >= a.source_received_at)`;
   `rest_observed_at` → `rest_material_observed_at` everywhere.
2. REST INSERT arm (was unspecified; source_received_at stays NOT NULL): writes
   source='rest_reconcile', source_event_type from direction, source_idempotency_key =
   the v2 observation's idempotency key, source_journal_id = NULL, source_received_at =
   the observation's received_at. The REST UPDATE arm never touches source_* columns.
3. Webhook writer table gains the two omitted columns: in_reply_to_message_id =
   COALESCE(incoming, old) when W else COALESCE(old, incoming); sender_role = incoming
   when W, else incoming only when old='unknown'.
4. media_metadata jsonb compare: object keys normalize, but ARRAY ORDER is significant —
   sort
Second AI ledger; per-conversation projection queues; full per-account drain inline in
settle; SSE gated on projection; fleet-wide fail-closed serving; write-through
readthrough; client transcript for OF; proxyRead at generation; in-place rebuild +
hash-equality as fidelity proof; schema-versioned dedup as correction identity;
message.corrected event type; top-level supersedes_event_id column; historical
readthrough replay; canonicalizer_family_health table; post-journal soft limiter;
canonicalizer family registration for readthrough.

## v8 CONSOLIDATED TIGHTENINGS (5 pre-code agents, all verified) — authoritative

Coherence: C1 ratchet-5 = "OpenAPI untouched EXCEPT the 429 removal + contracts:generate
in PR1 (commit regenerated reference/agency-hub.openapi.json)". C2 both cold-archive
writers + REST writer built to the amendment-3 per-field tables; main-body "fill-absent
dumb merge" is SUPERSEDED history, not a fallback. C3 canonical names
rest_material_observation_id / rest_material_observed_at. C4/C5 backlog gauge = per-KIND
MIN over observations_kind_received_idx (parse_version<v AND source filter), MAX-agg into
ONE per-family gauge named with version. C6 read mode ONCE in prepareAiFeatureStream just
before loadTranscriptContext (features/index.ts:157), pass down; manifest arg stays on
prepareAiGatewayStream. C7 union-query fail → archive+stale bit; mode-read fail / invalid
stored value → archive + manifest mode:"unknown"; mode enum off|shadow|serve|unknown.

PR boundaries: health registry — PR3 builds health-floors.ts + family entries + sampler +
thresholds; PR4 adds the readthrough descriptor + threshold in the runner's commit.
Amendment-3 merge + amendment-4 fence hit the same dm-message-archive.ts writers → one
change per writer. insertObservation return change ({inserted, observationId, receivedAt};
duplicate path returns the existing key's received_at — one column on the existing select,
zero extra queries) + conflict counters → PR4. Transition check plumbs into
applyConfigPatchesInTx via optional validateTransition(currentRowValue|null → next) under
the existing FOR-UPDATE (no new lock); DELETE/clear needs none.

Definitions: M1 flag ofapiDmReadthroughReconcileEnabled (bool, boot, default false). M2
apps/runtime/src/services/health-floors.ts. M3 material tuple = 13 fields
(sender_platform_user_id, sender_role, is_sent_by_me, message_created_at, text_plain,
price_mills, is_opened, is_tip, tip_amount_mills, in_reply_to_message_id,
platform_conversation_id, fan_platform_user_id, media_metadata); excl deleted_at, all
provenance, raw_shape_version, retention, updated_at; webhook table MUST add sender_role +
in_reply_to_message_id. M4 threshold 600000ms all families. M5 fence lock: dedicated
2-int namespace, key (ns, page_id); writers pg_try_advisory_xact_lock_shared, erasure
pg_advisory_xact_lock exclusive per resolved page id, sorted, top of delete tx. M6
params.contextManifest, loaderVersion "transcript-union-v1", source archive|union. M7 REST
INSERT NOT NULL cols: source='rest_reconcile', source_event_type by direction,
source_idempotency_key="readthrough:<obsId>:<msgId>", source_journal_id NULL,
source_received_at = obs received_at, retain_until mirror webhook policy; UPDATE never
touches source_*.

SQL nits: guard via drizzle setWhere sql`ROW(...) IS DISTINCT FROM ROW(...)` — no-row
RETURNING = NO-OP not failure; media_metadata sort items by id before compare (array order
significant); tombstone writer WHERE deleted_at IS NULL (also stops retain_until refresh,
intended); clock-domain skew (Postgres now() vs Node new Date()) in the W >= — accepted,
recorded.

ERASURE FENCE (amendment 4, refined by the dedicated review — all blocking for PR4):
- predicate matches dry_run=false REGARDLESS of completed_at (failed/pending rows retry
  post-completion; mid-flight-died run stays fenced fail-closed).
- writers TRY-lock + DEFER on miss (cold-archive writer is inline in the singleton settle
  loop — blocking would stall settle+fanout); sweep retries post-commit; NO memoization.
- fence-HIT → journal row archive_status/projection_status='skipped' (reason
  'erasure_fenced') else backlog gauge latches a permanent incident.
- fence MUST also cover the page_dm_messages/page_dm_threads projection writer
  (runOfapiDmProjectionForSettledRow) — same journal resurrects the fan into the
  CHATTER-VISIBLE store + the union's tombstone/PPV arms. Same helper+lock. Explicit
  WAIVER line for subscription/presence/spend projections (same journal exposure, out of
  Wave-1 scope, owner-acknowledged).
- scope_ref fragility: pages.label mutable → post-erasure rename disarms a page fence.
  Fix: executeErasure puts resolved pageIds in the plan jsonb; repo helper
  isDmArchiveScopeFenced(db,{pageId,refs}) matches fan by ref + page/model by page id.
- helper in packages/db (repo layer) so the Wave-2 reducer inherits it.
- >>> OWNER DECISION (gates PR4 tests + decisions.md): MATERIAL-TIME-BOUNDED fence (only
  material with source_received_at / message_created_at <= erasure.started_at — pre-erasure
  facts stay dead, new messages from a still-active fan flow, preserves DP-7 + live-convo
  union) vs PERMANENT fence (erasure = de-facto fan block, new facts dropped). Bounded =
  principled default. <<<
- tests: pending/failed/already-claimed swept post-erasure → no row + terminal-skip;
  tombstone-then-REST → contentless stub; page_dm sweep post-erasure → no page_dm row;
  page rename post-erasure → fence holds. Wire into the drill (erasure.integration.test.ts:503).

## OWNER DECISIONS (final, 2026-07-10)

- Erasure fence semantics: MATERIAL-TIME-BOUNDED (owner, 2026-07-10, this session):
  the fence blocks only material with source_received_at / message_created_at <=
  erasure.started_at. Erasure cleans the PAST; a still-active erased fan's new
  messages are captured normally (DP-7 preserved). Record as a decisions.md entry
  when PR4 lands. PERMANENT fencing was considered and NOT chosen.

## ROLLOUT OVERRIDE (owner, 2026-07-10)

No 24-48h shadow window — chatters are blocked NOW. Same-day activation: deploy →
shadow for MINUTES (one smoke pass: several live generations, check manifests show
union additions and zero errors) → serve immediately. PR4 flag follows the same day.
The off→shadow→serve transition rule stays (it is ordering, not duration). All
fail-open fallbacks and the instant PATCH rollback remain the safety net; manifests
are the live monitor.

## WAVE 2 SCOPE BOUNDARY (owner, 2026-07-10)

BUILD NOW (green-local; deploy waits ~2-3 days of wave-1 soak for attribution):
- The corrections mechanism: material fingerprints + superseding events in
  domain_events + the migration preamble (fingerprint backfill BEFORE the reconciler,
  REST-only initial drain bound, stub skip-and-count, provenance seeding) + the
  message_archive same-message superseding merge + enrichment extension (complete
  merged head in v2 frames).
- Sends-as-facts through the candidate path, AFTER fixing the direct-confirm raced
  seam (executor ignores finalize no-op; webhook path checks).
- First consumer: the Fansly 1970-timestamp repair rides the superseding capability.
  NB: the OF reducer/material head is dm_message_archive-specific; the Fansly repair
  slice needs its own short design note in-session (superseding events in
  domain_events are generic — the head store for Fansly differs). Stop-and-ask if
  the design is not cleanly derivable.

DEFERRED (pending wave-1 manifest data, decide in ~2 weeks):
- Pipeline pacing (event-driven canonicalize/projection).
- Freshness badge / contract phase (needs a desktop release; only if manifests show
  kernel-invisible heads actually occur).

Wave-1 field data to size against: readthrough reconcile caught 2 webhook-missed
messages within minutes of activation — webhook loss is routine, not exceptional.
