# Stage 18 — Platform adapter seam

**Repo(s):** core · **Depends on:** 8 (canonicalize seam), 15 (OnlyMonster quarantined); soft:
16/17 complete (move the Fansly streams once) · **Passport:** roadmap.md §4, stage 18

**Status header — two verified calibrations + one mechanism substitution (flag for sign-off):**
1. **The pgEnum blast radius is 7 columns, not "61 tables"**: `platformEnum`
   (`packages/db/src/schema.ts:42`) types exactly 7 columns — 3 named `platform` (`pages:165`,
   `fans:553`, `dm_message_archive:964`) and 4 named `provider` (`sync_http_attempts:348`,
   `sync_run_events:396`, `sync_rate_limits:506`, `page_fan_external_notes:677`). The enum→
   reference-table migration is cheaper than the passport implies.
2. **Strict branch sites: 56** outside the two adapter packages (grep
   `platform ===` excluding `packages/onlyfans|packages/fansly`, re-verified) — the ratchet's
   day-one number.
3. **"Lint ratchet" ships as a counting script + CI gate** (`scripts/check-platform-branches.mjs`
   asserting count ≤ recorded high-water): verified **no linter exists in core** (no eslint/biome
   config anywhere) — ESLint arrives with Stage 19/20's boundary rules; the ratchet cannot wait
   for it.

## 1. Context

Two hand-mirrored adapter classes behind inverted names (`AppContext.adapter` **is Fansly**,
`AppContext.onlyFansAdapter` **is OnlyMonster** — `bootstrap.ts:96-97,162-169`), a 4,142-line
`executor-handlers.ts` with platform branches inside stream handlers, and a 2-value pgEnum are
the tax every prior stage paid. This stage extracts the one honest seam: registry-resolved
`PlatformAdapter`s with declared capabilities, per-adapter handler modules (move-don't-rewrite),
a `platforms` reference table, and the OnlyMonster code deleted.

**Entry criteria restated as facts to verify:**
- Full Docker integration suite green (the net for the plan's biggest pure refactor); Testcontainers
  available (`tests/helpers/db.ts`).
- Stage 15 executed: OnlyMonster quarantined, zero egress — deletion here is of dead code.
- Stages 16/17 shipped (recommended): the Fansly stream set is final, so handlers move once.
- Record the day-one branch count (grep above) and 48 h of per-stream sync telemetry as the
  behavior baseline (`sync_runs` outcomes/counters per stream).

**Deliverable:** `packages/platform-core` (interfaces + registry), `packages/fansly` and a new
`packages/onlyfans-ofapi` implementing `PlatformAdapter`, executor-handlers decomposed per
adapter, `platforms` reference table replacing the enum, OnlyMonster deleted, behavior-identical
telemetry over 48 h.

## 2. Changes

**core — `packages/platform-core` (new):** `PlatformAdapter` / `PlatformCapabilities` /
`CanonicalStream` / `SessionCustodyDescriptor` interfaces exactly per target §4.1 (streams
vocabulary: `account, transactions, subscriptions, followers, conversations, messages, presence,
fan_earnings, purchase_history, top_spenders`); `createPlatformRegistry()` →
`platforms.get(key)`. `canonicalize(observation)` hangs here, implemented by moving Stage 8's
per-family canonicalizers behind each adapter.

**core — adapters:**
- `packages/fansly`: `FanslyAdapter` implements the interface; its pull handlers move from
  `executor-handlers.ts` (the fansly branches of the 9 handlers, dispatch switch at `:4120-4141`)
  into `packages/fansly`-adjacent handler modules (**move-don't-rewrite**: function bodies
  byte-preserved where possible, imports adjusted). `SessionCustodyDescriptor` declares the
  pasted-session lifecycle (verify/paste/death-signal interface — `resolvePageContext`,
  `verifySession`, the `auth_blocked` incident); **capture/refresh mechanics deliberately
  unspecified** (scope guard).
- `packages/onlyfans-ofapi` (new name — vendor named where the vendor matters): wraps the
  existing OFAPI client + webhook integration + command executor halves as the OnlyFans adapter
  (`webhook.verify/decode`, `commands`, `pull` for the OFAPI-era streams,
  `billing:'credit_metered'`).
- `packages/onlyfans` (OnlyMonster) **deleted** — adapter, mappers, and the OnlyMonster-only
  service paths (`onlyfans-transactions.ts` OnlyMonster branches, `onlyfans-identities.ts`
  OnlyMonster paths) after re-grep for consumers (Stage 15 quarantine made this mechanical).
- `bootstrap.ts`: `adapter`/`onlyFansAdapter` fields replaced by `platforms` registry;
  `AdapterLike` dies; every `AppContext.adapter` consumer re-pointed (compiler-driven).

**core — sync engine wiring:** planner reads `adapter.capabilities.streams` instead of
`getSyncStreamsForPlatform`'s hardcoded lists (`page-sync.ts:533`) and
`resolveStreamsForScope`'s per-platform arrays (`sync-control.ts:40-87`) — both become
capability-driven with the same output for today's two platforms (test-pinned);
`executeStreamChunk`'s switch (`executor-handlers.ts:4093,4120`) becomes
`platforms.get(page.platform).pull[stream](input)`; `resolveExecutorPageContext`'s platform
branch (`:4066-4091`) moves into adapter context builders. `executor-handlers.ts` shrinks to the
dispatcher + shared helpers.

**core — schema: `platforms` reference table + enum retirement (§3).** The 7 enum columns
become `text` + FK to `platforms(key)`; `platformEnum`/TS `platforms` const
(`packages/shared/src/types.ts:1`) replaced by registry-derived types.

**core — ratchet:** `scripts/check-platform-branches.mjs` — greps strict `platform ===` outside
adapter packages, compares to `platform-branch-budget.json` (starts at the day-one count, target
~0); CI fails on increase; decreases update the budget file. Litmus documented in
`platform-core`'s README: adding platform #3 = package + `platforms` row + credential UI
(target §4.4).

## 3. Schema & data migration

```sql
-- 00NN_platforms_reference.sql   (rehearsed + reversed on a staging copy BEFORE prod — passport)
CREATE TABLE platforms (
  key text PRIMARY KEY, display_name text NOT NULL, adapter_version text NOT NULL DEFAULT '1'
);
INSERT INTO platforms VALUES ('fansly','Fansly','1'), ('onlyfans','OnlyFans','1');
-- per enum column (7×): ALTER TABLE <t> ALTER COLUMN <c> TYPE text USING <c>::text;
--                        ALTER TABLE <t> ADD CONSTRAINT <t>_<c>_fk FOREIGN KEY (<c>) REFERENCES platforms(key);
DROP TYPE platform;    -- last, after all 7 columns converted
```
Notes: `USING ::text` on enum→text is a table rewrite on PG16 for these tables — schedule off-peak;
`sync_http_attempts` is the big one (30-day retention keeps it bounded). No data backfill beyond
the two seed rows. Down-path: recreate the enum + cast back (rehearsal proves it).

## 4. Client compatibility

- **Desktop / extension / dashboard / workboard:** none visible — pure internal seam; API
  contracts unchanged (`routeSchemas` untouched; platform values on the wire are the same
  strings). Contract `z.enum(['fansly','onlyfans'])` fields in `packages/contracts` stay literal
  enums at the API edge (additive evolution when platform #3 lands — a contract change, then).

**Compatibility invariants (target §14):** all preserved; explicitly re-verify the SSE frame
union and outbox intake tests after the move (they must not even re-compile differently).

## 5. Tests & verification

**New tests:** registry resolution + capabilities-driven planner parity (old lists vs new
capabilities → identical stream sets for both platforms — pinned); adapter-interface conformance
suite (each adapter: declared streams have handlers, canonicalize is total over its kinds);
ratchet script self-test.

**Existing suites:** **the entire integration suite is the acceptance instrument** — sync
executor, DM projection/archive, spend, webhook, SSE, workboard — green before and after, with
`--testNamePattern` allowlists replaced by whatever tags exist at this point (Stage 35 formalizes).

**Production verification (exit criteria):**
- 48 h before/after telemetry diff: per-stream run counts, chunk counts, outcome ratios, error
  rates statistically unchanged (`sync_runs` stats query, same windows).
- Branch-site report: ratchet count recorded (expect a large drop; target trajectory to ~0).
- Enum migration rehearsed AND reversed cleanly on a staging copy before prod (recorded).
- Staged deploy: one adapter's handlers move first (Fansly), 48 h soak, then OnlyFans-OFAPI.

## 6. Rollback

- Handler moves are pure refactors — revert commits restore the old layout; the staged deploy
  (one adapter first) bounds the blast radius.
- Enum migration: rehearsed down-path (recreate type, cast columns back, drop FKs); executed
  only under owner go if a production issue demands it.
- OnlyMonster deletion is git-recoverable; nothing runtime depends on it (Stage 15 proved zero
  egress).

## 7. Assumptions

1. **No new platform lands mid-stage**; the sync FSM (planner → `page_sync_states` → executor →
   bounded chunks) keeps its semantics and its tests byte-for-byte.
2. **Stage 8's canonicalizers exist as pure functions** — moving them behind `adapter.canonicalize`
   is a relocation, not a rewrite.
3. **The 7-column enum inventory is complete** (re-grep `platformEnum(` at execution).
4. **`packages/contracts` platform enums are API-edge concerns** and deliberately NOT converted
   to registry-driven — the wire contract stays explicit.
5. **Stages 16/17 shipped** — else their streams are built pre-seam and moved here (more churn,
   same end state; the master allows it).

## 8. Task breakdown

1. **`platform-core` package + registry + conformance test harness.** *(1 session)*
2. **Fansly adapter migration (handlers move + custody descriptor) + 48 h staging soak.** *(1–2
   sessions)*
3. **OnlyFans-OFAPI adapter assembly + handler moves + OnlyMonster deletion.** *(1–2 sessions)*
4. **Planner/executor capability wiring + parity pins.** *(1 session — after 2–3)*
5. **Enum→reference-table migration + staging rehearsal (apply + reverse).** *(0.5–1 session)*
6. **Ratchet script + CI gate + budget file.** *(≤0.5 session)* *(parallel)*
7. **(Last) Staged prod deploy; 48 h telemetry diff per adapter; record results here.** *(ops)*

## Progress

**Session 1 (2026-07-06, chain branch `kernel/stage-21-event-stream-v2` @ 8a7b08d; ordering
deviation #98: dep 15 = owner's commercial cancel, verify-zero exited with Stage 5):**

§8 status — **Task 1 DONE, Task 6 DONE, Tasks 2/3's handler SPLIT done** (relocation +
OnlyMonster deletion pending). Suite **193/1555**.

- [x] **Task 1** (e24fa9c) — packages/platform-core (interfaces + registry + conformance);
  adapters assembled in apps/runtime/src/platforms/registry.ts (capabilities parity-pinned
  vs getSyncStreamsForPlatform/resolveStreamsForScope; honest custody descriptors; OnlyFans
  writes = 5 outbox kinds). RECORDED: streams vocabulary = today's sync-stream names (README
  maps the target renames); handler type = adapter generic param (app-agnostic core).
  executeStreamChunk = registry dispatch (undeclared stream now fails loudly).
- [x] **Task 6** (e24fa9c) — ratchet scripts/check-platform-branches.mjs + budget (day-one
  **64**), wrapped into tests/platform-registry.test.ts.
- [x] **Tasks 2/3 split half** (8a7b08d) — six mixed handlers split into fansly*/onlyfans*
  halves (bodies verbatim; narrowing via `!==` assertion guards; transactions prelude
  duplicated); per-platform pull maps route to the halves; execute*Chunk compat shells
  remain for tests/sync-handlers.test.ts + 2 integration suites.
**Session 2 (2026-07-06, same chain branch @ a476139; decision #99):** BUILD SIDE COMPLETE.

- [x] **Shells deleted + suites re-pointed** (1f11df9) — ratchet 64 → 58.
- [x] **Task 4** (69ca3ba) — resolveStreamsForScope + sync-blocks supportedStreams read the
  adapter (syncScopes policy map + capabilities.streams); scope-subset-of-capabilities pinned.
  page-sync.ts's getSyncStreamsForPlatform use is db-internal — stays pinned, recorded.
  Ratchet 58 → 55.
- [x] **Task 3 tail: OnlyMonster DELETED** (c8d93d0, −7,742 lines) — packages/onlyfans +
  workspace dep + ONLYMONSTER_BASE_URL gone; bootstrap onlyFansAdapter gone; OF pages resolve
  token-less (no stored credentials); onboarding/verify/update-credentials/page-proxies/CLI
  re-pointed to OFAPI-era semantics (ambiguous username now 409s; proxy on OF pages 400s —
  egress is vendor-side); OF transactions pull = recorded skip (webhook-sourced). Ratchet
  55 → **48**.
- [x] **Task 5** (a476139) — migration 0068 platforms reference table; 7 enum columns → text
  + FK; DROP TYPE platform; drizzle platformEnum → text(..., {enum}). **Rehearsed locally
  up → down → up on postgres:16**; down file = docs/runbooks/0068-platforms-reference-down.sql
  (must NOT live in migrations/ — the runner applies every .sql there). Test reset helper now
  preserves the platforms seed rows. STAGING rehearsal on a prod copy before deploy =
  owner-gated (passport).
- [ ] **DEFERRED (recorded, decision #99): relocation leg** — handler bodies into
  packages/fansly-adjacent + onlyfans-ofapi modules, AppContext.adapter retirement (~31
  consumers), adapter webhook/commands halves, shared platforms const → registry-derived.
  Pure file motion, zero semantic delta; do as a dedicated compiler-driven session, possibly
  folded into Stage 26 entry (same modules gain resolveEgress there — avoid moving lines
  twice).
- [ ] **Task 7 ops** (owner-gated): staging rehearsal of 0068 + reverse on prod copy; staged
  deploy (Fansly first, 48 h soak); 48 h telemetry diff; record here.

Gotchas: registry⇄executor-handlers is a value-level circular import that works because the
handler fns are hoisted declarations consumed at call time — do NOT convert them to const
arrow exports; the ratchet self-excludes platform-registry.test.ts (its regex literal).
