# Stage 10 — Platform-neutral message archive

**Repo(s):** core · **Depends on:** 8; 3 (#52 cold archive running) ·
**Passport:** roadmap.md §4, stage 10

**Status header.** No deviation. Naming note: the successor table is `message_archive`; the
OFAPI-only `dm_message_archive` (verified shape at `schema.ts:960-1010`: `ofapi_account_id NOT
NULL`, sources `webhook|command|rest_reconcile|rest_backfill`) remains in place, frozen as a
backfill source, retired only after this projection's coverage is proven (its writer keeps
running until cutover — capture in parallel, per sequencing rule 4).

## 1. Context

"What did this fan say last quarter" must have one answer for OnlyFans and Fansly alike. Today
full history exists only in the OFAPI-only `dm_message_archive` (webhook-era, OnlyFans) and in
whatever the un-pruned hot table (`page_dm_messages`) has accumulated since Stage 1 — for Fansly,
the hot table is still the only durable copy. This stage builds the platform-neutral archive
projection fed by `message.*` domain events, backfills it from all three existing stores, and
gives it minimal read/search endpoints.

**Entry criteria restated as facts to verify:**
- `message.*` events flowing for OFAPI webhooks AND Fansly sync (Stage 7 producers + Stage 8
  canonicalizers): `SELECT type, count(*) FROM domain_events WHERE type LIKE 'message.%' GROUP BY 1`.
- #52 (`ofapiDmColdArchiveEnabled`) running-on; `dm_message_archive` row rate > 0.
- Hot-table prune still disabled (Stage 1) — the harvest below depends on it.

**Deliverable:** `message_archive` serving history reads beyond the hot cache for both platforms,
rebuildable by one command, backfilled from `dm_message_archive` + `page_dm_messages` + retained
raw payloads, with per-conversation coverage proven before any prune policy anywhere changes.

## 2. Changes

**core — projection table + writer** (`packages/db` + `services/projections/message-archive.ts`):
- Table `message_archive` (§3), keyed by `account_id` + platform-native refs. Column mapping from
  `dm_message_archive` is 1:1 where sensible (text_plain, price_mills, tip fields, sender_role,
  media_metadata) minus the OFAPI-specific NOT NULLs (`ofapi_account_id` becomes nullable
  `native_account_ref`).
- Writer consumes `message.received|sent|deleted|ppv_unlocked` events; per-account watermark
  (`account_seq` high-water, per §5.2 discipline) in a `projection_watermarks` table (name,
  account_id, high_seq) — the first instance of the standard watermark shape (later projections
  reuse it).
- Declared inputs + **one-command rebuild**: `projection:rebuild message_archive [--account]` —
  truncate scope + replay from `domain_events` (CI proves rebuild reproduces identical counts on
  fixtures; this is the template for all future projections).
- Deletions: `message.deleted` sets `deleted_at` tombstone (never row-delete — same discipline
  as `page_dm_messages.deleted_at`, `0048` migration precedent).

**core — backfills (three sources, in this order):**
1. `dm_message_archive` → direct SQL copy (columns map; `source_journal_id` preserved as
   provenance ref; batched INSERT … SELECT ON CONFLICT DO NOTHING).
2. `page_dm_messages` hot rows (both platforms — the Fansly-critical one): join through its
   conversations table (`page_dm_messages.conversation_id` FK, `schema.ts:913`) for
   conversation refs; map `content`, `total_tip_amount_cents` (NB **cents** here — convert
   ×10 to mills via the shared codec, verified column `schema.ts:921`), `sender_role`,
   `purchased_at`.
3. Retained raw payloads / observations (`payload_kind='dm_messages'` rows, Stage 1+) — replay
   through Stage 8 canonicalizers (`events:replay --kind`), which flows into the archive via the
   normal writer; this de-duplicates against 1–2 naturally (same platform message ids).
- All three idempotent (unique key = account + platform + message ref); a per-conversation
  verification query (hot count vs archive count) gates completion.

**core — read endpoints (dashboard-grade, owner/team_lead):**
`GET /api/v1/archive/conversations/:ref/messages` (paged, before-cursor) and
`GET /api/v1/archive/search?q=&pageLabel=&fan=` (ILIKE/tsvector over `text_plain`, bounded) —
registered in `routeSchemas` per house style; SDK-grade surfaces ride Stages 19/20.

**core — explicitly NOT here:** `page_dm_messages` stays the interactive cache with prune
disabled (until Stage 28); `dm_message_archive`'s writer keeps writing (parallel capture);
desktop history UX unchanged until Stage 24.

## 3. Schema & data migration

```sql
-- 00NN_message_archive.sql
CREATE TABLE message_archive (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id         bigint NOT NULL,             -- pages.id; RESTRICT semantics via Stage 13 policy
  platform           text   NOT NULL,
  native_account_ref text,
  conversation_ref   text,
  message_ref        text   NOT NULL,             -- platform-native message id
  fan_native_id      text,
  sender_role        text   NOT NULL DEFAULT 'unknown',
  is_sent_by_me      boolean NOT NULL DEFAULT false,
  occurred_at        timestamptz,
  text_plain         text   NOT NULL DEFAULT '',
  price_mills        bigint,
  is_tip             boolean NOT NULL DEFAULT false,
  tip_amount_mills   bigint NOT NULL DEFAULT 0,
  in_reply_to_ref    text,
  media_metadata     jsonb  NOT NULL DEFAULT '[]',
  deleted_at         timestamptz,
  source_event_id    bigint,                      -- provenance → domain_events (null for direct backfill rows)
  backfill_source    text,                        -- 'dm_message_archive' | 'hot_table' | null(event-fed)
  archived_at        timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, platform, message_ref)
);
CREATE INDEX message_archive_account_conv_idx ON message_archive (account_id, conversation_ref, occurred_at);
CREATE INDEX message_archive_account_occurred_idx ON message_archive (account_id, occurred_at);
CREATE INDEX message_archive_text_search_idx ON message_archive USING gin (to_tsvector('simple', text_plain));

CREATE TABLE projection_watermarks (
  projection text NOT NULL, account_id bigint NOT NULL, high_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (projection, account_id)
);
```
Backfills batched (10k rows/iteration), checkpointed by max(id) per source, idempotent via the
unique key; completeness query per conversation:
`hot count (deleted_at IS NULL) ≤ archive count` for every `(account, conversation)`. Not
partitioned at creation (text-scale data; Stage 28 tiers it if warranted — flagged there).

## 4. Client compatibility

- **Desktop:** none — its history reads stay on the hot paths until Stage 24; a message visible
  in the desktop must be findable in the archive within minutes (exit check), but the desktop
  doesn't read the archive yet.
- **Extension:** none.
- **Dashboard:** gains the two read endpoints (owner/team_lead-gated); optional UI in Stage 33.
- **Workboard:** n/a (module reads events/archive from Stage 23+).

**Compatibility invariants (target §14):** untouched (SSE, outbox, gateway, fan-profile pair all
unchanged).

## 5. Tests & verification

**New tests:** writer integration (message.* fixtures → rows; deleted → tombstone); rebuild
reproduces identical counts from event fixtures (CI — the §5.2 proof, first of its kind here);
each backfill idempotent (double-run adds 0); cents→mills conversion unit test for source 2;
Fansly + OnlyFans rows both present from mixed fixtures (platform-neutral proof); search/read
endpoint auth (chatter key → 403).

**Existing suites:** DM projection, cold-archive, page-dm repositories — all unchanged behavior.

**Production verification (exit criteria):**
- Per-conversation: archive counts ≥ hot-table counts (the §3 query over the full fleet).
- Fansly rows present — the headline platform-neutral proof:
  `SELECT platform, count(*) FROM message_archive GROUP BY 1` shows both.
- Rebuild-from-ledger on a staging copy of production reproduces identical counts.
- A message visible in the desktop is findable in the archive within minutes (spot-check via
  search endpoint after a live DM).
- **Observation window:** run the coverage query 48 h apart — both snapshots must hold (no
  regression while live traffic flows).

## 6. Rollback

- The projection is rebuildable by definition — drop/truncate + rebuild is the recovery for any
  writer bug; no upstream data is ever at risk.
- Backfills: re-runnable; partial runs resume from checkpoints. Removing the stage = stop the
  writer, keep the table (inert) — no consumer depends on it until 17/24/28/33.
- No irreversible step; no prune policy changes anywhere in this stage.

## 7. Assumptions

1. **`dm_message_archive` rows accumulated since #52 are sound** (spot-check counts vs journal
   before trusting source 1).
2. **Fansly message sync stays healthy** (pasted session) through the backfill window; a session
   death pauses source-3 replay for that page, resumes after re-paste.
3. **The hot table's conversations table join** (`page_dm_messages.conversation_id` FK,
   `schema.ts:913`) provides platform conversation refs for source 2 — verify the ref columns on
   the conversations table at execution.
4. **`total_tip_amount_cents` is genuinely cents** (`schema.ts:921`) — the one unit conversion in
   the stage; the codec call makes it explicit (Stage 27 later bans the bare arithmetic form).
5. **Stage 13's RESTRICT policy** will cover `message_archive` (fact table) when it lands — if 13
   already ran, add the FK as RESTRICT in this migration; else leave FK-less and Stage 13's
   pattern picks it up (note which way it went at execution).

## 8. Task breakdown

1. **Table + watermark + writer + rebuild command + CI rebuild proof.** Done-check: writer/
   rebuild tests green. *(1–1.5 sessions)*
2. **Backfill 1 + 2 (SQL copies with conversion + checkpoints).** Done-check: idempotency +
   coverage queries on staging. *(1 session)*
3. **Backfill 3 (replay-driven) + de-dup verification across sources.** Done-check: mixed-source
   fixture test; staging replay. *(0.5–1 session)*
4. **Read/search endpoints + contracts.** Done-check: auth + shape tests; `contracts:generate`
   clean. *(0.5 session)* *(parallel with 2–3)*
5. **(Last) Deploy; run backfills in prod; 48 h coverage checks + desktop-visible spot-check;
   record results here.** *(ops)*

## Progress

*Working scratchpad — session 2026-07-05, branch `kernel/stage-10-message-archive` off the Stage 9 tip (linear 8→9→10 chain). **Same ordering deviation family (#73/#74, owner "do not wait / do everything"):** stands on green-local Stage 8 (undeployed) — the first stage built on an UNDEPLOYED substrate; flagged to the owner before building, owner instructed to continue. Deploys strictly after 8+9 are deployed and their canonicalizers verified live.*

**§8 checklist:**
- [x] 1. **Table + watermark + writer + rebuild (0059).** `message_archive` per spec §3 with the Stage 13 fact-policy FK (RESTRICT — 13 deployed first, per assumption 5 note). **Naming deviation:** the spec's `projection_watermarks` is TAKEN (spender rebuild timestamps) → generic high-water lives in `projection_seq_watermarks` (projection, account_id, high_seq) — the standard shape later projections reuse. Writer applies received/sent (insert, first-writer-wins — cross-producer dedup already collapsed upstream), deleted → tombstone; **ppv_unlocked is a NO-OP in v1** (notification-shaped, unreliable message ref — deviation recorded). Platform derives from the page catalog per account (events are platform-less by design). Minutely sweep `projections.message-archive.sweep` + `projection:rebuild message_archive [--account]` CLI; CI proof: rebuild reproduces identical counts incl. tombstones.
- [x] 2. **Backfills 1+2.** Source 1: `dm_message_archive` → direct SQL copy (columns 1:1, `ofapi_account_id`→`native_account_ref`, batched 10k, checkpointed, ON CONFLICT DO NOTHING). Source 2: hot table joined through `page_dm_threads` + pages for platform/conversation refs; `total_tip_amount_cents × 10` = the one cents→mills conversion (explicit comment; Stage 27 bans the bare form later). Both idempotent (double-run adds 0 — CI-proven). `archive:backfill` CLI runs both then sweeps.
- [x] 3. **Backfill 3 = Stage 8's replay by construction** — `events:replay --kind dm_messages` flows through the normal writer and dedupes against 1–2 via the unique key; no separate machinery (the mixed-source test proves event-fed + hot-table rows coexist without dupes).
- [x] 4. **Read/search endpoints.** `GET /api/v1/archive/conversations/:ref/messages` (before-cursor paging) + `GET /api/v1/archive/search?q=&fan=` (bounded ILIKE), `requireDashboardUser` gate (owner/team_lead; chatter bearer → 403 — tested), page-scoped for team_lead via assignedPageIds, contracts + OpenAPI regenerated.
- [ ] 5. Deploy (after 7 exits → 8/9 deploy → this) + prod backfills + 48 h coverage checks (per-conversation hot ≤ archive; both platforms present) + desktop-visible spot-check.
