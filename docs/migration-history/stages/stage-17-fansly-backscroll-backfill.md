# Stage 17 — Fansly message backscroll backfill

**Repo(s):** core · **Depends on:** 6 (message replay re-confirmed), 8, 10 ·
**Passport:** roadmap.md §4, stage 17

**Status header — one elaboration (flag for sign-off):** the passport describes "a paced backfill
job" as if new. Verified: core already ships a **Fansly DM deep-backfill mechanism** — flag
`fanslyDmDeepBackfillEnabled`, per-run request quotas (`fanslyDmDeepBackfillMaxRequestsPerRun`,
`…LiveRequestsPerDeep`, `executor-handlers.ts:3572-3577`), continuation delay + jitter
(`resolveFanslyDmDeepBackfillContinuationDelayMs`, `:231`), candidate selection
(`selectNextPageDmMessageDeepBackfillCandidate`, `:3619`), and the per-conversation back-scroll
cursor (`state.currentBeforeMessageId` in `page_sync_cursors.state`, read `:3594`, used `:3727`)
over `getMessagesPage(context, { groupId, limit, before })` (`packages/fansly/src/adapter.ts:392`).
This stage **drives the existing machinery to exhaustion and lands the result in the ledger +
archive**, instead of building a parallel job — cheaper and reuses proven pacing. If execution
finds the deep-backfill semantically bounded (not walk-to-exhaustion), extend it rather than
replace it.

## 1. Context

For Fansly, the pruned hot table was historically the only copy of DM history in existence
(review §4.2); the prune has been off since Stage 1, and Stage 10's archive is the durable home.
The platform still serves full history via `before`-cursor pagination (the extension proves
unbounded depth works — target §14). This stage recovers everything Fansly still serves, per
conversation, resumable, gently.

**Entry criteria restated as facts to verify:**
- Stage 10 archive live; `message.*` events flowing for Fansly (Stage 8).
- Stage 6 verdict re-confirms message backscroll replays server-side (it is core's own existing
  route — expected trivially yes; the verdict table covers it).
- Fansly sessions healthy on all pages (no open `auth_blocked` incidents).
- Hot-table prune still disabled (`PAGE_DM_PRUNE_ENABLED` unset/false — Stage 1) → no
  prune-vs-backfill race.
- Owner OK on the pacing plan: weeks of gentle runtime is the design, stated up front.

**Deliverable:** per-conversation manifest (count, earliest timestamp) proving backscroll to
exhaustion for every Fansly conversation, with old conversations' earliest timestamps preceding
the hot-window era; all fetched pages journaled as observations → events → archive; re-run is a
no-op.

## 2. Changes

**core — deep-backfill semantics audit + extension** (`executor-handlers.ts`,
`executeDmMessagesChunk` `:3514` region):
- Verify the walk terminates only at `done` (fewer than `limit` messages returned —
  `adapter.ts:392` semantics) and that the candidate selector eventually visits **every**
  conversation (not just recent/live ones). Extend the selector if it caps depth or skips idle
  conversations: add an `exhausted_at` marker per conversation in the cursor state so completed
  conversations leave the candidate pool permanently.
- **Value-ordered staging:** order candidates by `page_fans.total_creator_net_mills`
  (`schema.ts:632`) descending (top-spender conversations first), then by recency — verify the
  current selector's ordering and adjust.
- **Ledger routing:** with Stage 7 deployed, every fetched messages page persists as a producer-2
  observation (the executor's generalized persistence; DM paths gained raw persistence in
  Stage 1); Stage 8's Fansly canonicalizer emits `message.received`/`message.sent` events
  (dedup_key on platform message id — re-fetching an already-known message produces no new
  event); Stage 10's archive projection consumes them. **No new pipeline here — this stage rides
  it and verifies coverage.**
- **Manifest:** a small read-model/report (CLI `fansly:backscroll-report`): per conversation —
  hot-table count, archive count, earliest archived timestamp, cursor state
  (`exhausted`/in-progress). Emits JSON + a summary table; the exit criterion reads from it.
- **Throughput knobs:** run under the existing quotas and the DB rate-limit waiter
  (`sync_rate_limits` scopes for `dm_messages`, `rate-limiter.ts:70-80`); off-peak bias via the
  continuation-delay knobs; abort on any auth anomaly (existing `blockPageSync` +
  `notifyAuthFailedIncident` path fails safe).

## 3. Schema & data migration

**No schema change.** Cursor-state additions (`exhausted_at`) live inside the existing
`page_sync_cursors.state` JSONB (`schema.ts:478-502`). The "data migration" is the crawl itself:
- Idempotency: archive/event dedup (Stage 8 `dedup_key`; archive unique per account+message id) —
  re-crawling any window adds zero events/rows.
- Rate bounds: existing per-run request quota + 2.5 s pacing + continuation jitter.
- Progress checkpointing: `state.currentBeforeMessageId` per conversation (existing).
- Verification query: the manifest report; completeness = every conversation `exhausted` and
  archive count ≥ hot count.

## 4. Client compatibility

- **Desktop:** none (OnlyFans surface).
- **Extension:** none — it keeps reading Fansly for its UI; the crawl is server-side under
  existing pacing (platform-safety: same egress identity per page, existing waiter).
- **Dashboard:** none required; archive search (Stage 10's endpoints) simply starts returning
  older Fansly history.
- **Workboard:** n/a.

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:** selector visits idle conversations + honors value ordering (unit, fixture pages);
`exhausted_at` terminal behavior (unit); integration: a two-page fixture conversation walks to
`done`, produces observations + events + archive rows, and a re-run adds zero.

**Existing suites:** Fansly DM sync suite, deep-backfill tests (exist for the current mechanism —
extend), archive projection suite.

**Production verification (exit criteria):**
- Manifest: 100 % conversations `exhausted`; earliest archived timestamps precede the hot-window
  era for old conversations (spot-check the oldest known conversations per page — e.g. lilly-1
  transactions go back to 2024-05, so DM history should reach comparable depth if the platform
  retains it).
- Re-run of one exhausted conversation: no new rows (idempotency proof in prod).
- Archive search returns years-old Fansly messages (owner spot-check).
- Zero `auth_blocked` incidents attributable to the crawl; session-death mid-crawl (if it
  happens) resumes cleanly after re-paste (checkpoint proof).
- **Observation window:** the crawl runs for weeks by design; the stage exits when the manifest
  is complete, not on a calendar.

## 6. Rollback

- `fanslyDmDeepBackfillEnabled` off stops the crawl instantly; cursors keep their place; resume
  by re-enabling. No data effect.
- Nothing to undo — all writes are capture (observations/events/archive), never rolled back by
  design.
- No irreversible step. Platform-facing risk contained by pacing/quotas/abort-on-auth-anomaly.

## 7. Assumptions

1. **Fansly retains full history server-side** — verify on the first conversation (compare
   earliest fetched vs. the extension's known depth); if the platform floors earlier than
   expected, record the floor per conversation in the manifest (a fact, not a failure).
2. **The hot-table prune stays disabled** until Stage 28 re-enables it as a cache policy — the
   archive must prove coverage first (Stage 10 exit + this manifest).
3. **Stage 8's Fansly message canonicalizer is total** for the messages-page shape (media
   metadata included per §3.6 rule 1 — bytes excluded, metadata kept).
4. **The deep-backfill machinery behaves as verified at spec time** (quota/continuation/cursor
   mechanics at the cited lines). Drift signal: the semantics audit in §2 finds a depth cap —
   extend, don't replace.

## 8. Task breakdown

1. **Semantics audit + selector extension (`exhausted_at`, value ordering).** Done-check: unit
   tests; a staging crawl visits and exhausts a fixture conversation set. *(1 session)*
2. **Manifest report CLI.** Done-check: report matches staging DB state. *(≤0.5 session)*
3. **Ledger-coverage verification** (observation/event/archive rows per fetched page on staging).
   Done-check: integration test. *(≤0.5 session)*
4. **(Last, ops) Enable fleet crawl, monitor weekly via the manifest; when 100 % exhausted, run
   §5 prod checks and record results here + `decisions.md`.** *(ops, weeks of unattended
   runtime)*

## Progress

*Session 2026-07-05, branch continues the chain (8→9→10→16→17). Deviation family #73–#75.*

**Build plan (session continuity):**
1. **Assumption 3 is FALSE in the current build** — Stage 8 deliberately deferred the Fansly DM canonicalizer (message direction needs the page's OWN Fansly account id; pure function can't know it). Stage 17 lands it as **sync-pull canonicalizer v2**: the sweep builds a per-run `Map<accountId, nativeAccountRef>` from `pages.external_page_id` (Fansly pages carry the Fansly account id there) and passes it as an optional context arg — `familyForObservation` stays pure; `canonicalizeSyncPullObservation(obs, context?)` gains fansly `dm_messages` handling: FanslyMessagesPage `{messages[]}`, direction = senderId === ownAccountRef ? sent : received, dedup `msg:<dir>:<id>`, tip mills from totalTipAmount (Fansly DM tips are MILLS per normalizeDmTipAmountCents ÷10-to-cents precedent — VERIFY at execution), conversationRef = groupId. Version bump v1→v2 makes the sweep re-visit ALL pull kinds — dedup absorbs.
2. **Semantics audit** of fanslyDmDeepBackfill (executor-handlers ~:3572-3727 cited lines): terminate-at-done check, candidate selector visits idle conversations, add `exhausted_at` terminal marker in page_sync_cursors.state, value ordering by page_fans.total_creator_net_mills desc.
3. **Manifest CLI** `fansly:backscroll-report`: per conversation — hot count, archive count, earliest archived ts, cursor state.
4. Tests: canonicalizer v2 unit (direction both ways, tip mills), selector unit, two-page walk integration (observations+events+archive, re-run adds 0).
5. No schema change. No new pipeline — rides 7/8/10.

**Build state (2026-07-05):** branch `kernel/stage-17-backscroll` (chain …→16→17).
- [x] 1. **Fansly DM canonicalizer LANDED (sync-pull v2)** — direction resolves against a per-run page→native-ref context map (`listPageNativeAccountRefs`; `CanonicalizeRunContext` threaded through the driver; canonicalizers stay pure); tip totals kept in MILLS; dedup `msg:<dir>:<id>` collides with any future producer of the same fact. Missing own-ref → zero events, recoverable via `events:replay --parse-version` (recorded edge). Version bump v1→v2 makes the sweep revisit all pull kinds — dedup absorbs (sweep test updated to floor 3).
- [x] 2. **Semantics audit — spec suspicion CONFIRMED:** the deep-backfill selector is depth-capped (`stored_message_count < retention_limit`), NOT walk-to-exhaustion; value ordering already spender-first (creator_net_amount_mills desc — spec requirement pre-satisfied); the exhaustion marker already exists as `message_backfill_complete`/coverage-status. **Extension (extend-don't-replace):** live-editable `fanslyDeepBackfillIgnoreRetentionLimit` (default false; 12th live key) lifts the cap predicate for the crawl — owner flips it to start the weeks-long walk; hot-table growth is the accepted cost (archive coverage is the goal; disk monitored).
- [x] 3. **Manifest CLI** `fansly:backscroll-report`: per conversation hot vs archive counts, earliest archived ts, cursor state; summary line counts gaps.
- [ ] 4. Ops (after chain deploy): flip the knob, weekly manifest watch, §5 prod checks when 100% exhausted.
