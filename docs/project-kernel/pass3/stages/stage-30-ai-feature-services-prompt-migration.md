# Stage 30 — AI feature services + prompt migration

**Repo(s):** core (desktop/extension repos as **reference sources only**) · **Depends on:** 29,
10 (transcript context), 16 (Fansly context) · **Passport:** roadmap.md §4, stage 30

**Status header.** No deviation. Two binding rules restated because they are the stage:
**prompts migrate byte-for-byte** (they are tuned production assets — the anti-slop tuning IS
the value), and the escape/sanitize pipeline (`escapeForPrompt`, safety preamble, output
sanitizer) **moves as one unit with its regression tests**. Single-tenant note (DP 9-A):
"editable per org" collapses to global kernel config.

## 1. Context

The desktop and extension each hold a prompt library, context loaders, model registries, and
cost tables — the same product logic drifting independently over partial local caches. After
Stages 10/14/16 the kernel holds all the context those prompts need (transcript, spend,
subscription, fan summary, Fansly earnings). This stage relocates prompt assembly into kernel
feature services; **no client cuts over here** — the stage ends with the kernel *able* to serve
them all, proven by a parity harness.

**Entry criteria restated as facts to verify:**
- Stage 29 exited (gateway hardened; restricted class live — feature services write into it).
- Context sources serving: `message_archive` + hot table (10), spend rollups + fees (13/14),
  `fan_earnings_stats` (16), fan profiles/summaries (existing).
- **Prompt freeze window agreed with the owner** (communicated to the team): no tuning in either
  client repo between inventory snapshot and parity sign-off.
- Feature inventory confirmed against both clients (kernel side already names:
  `fast-reply, improve-draft, help-me, fan-summary, chat-review, scan, ping, hi-greeting` —
  `ai-gateway-anthropic.ts:56-76`; the extension adds its panel features/personas — enumerate
  from its repo at execution, reference-only).

**Deliverable:** `POST /api/v1/ai/features/<feature>` (streaming) serving every inventoried
feature with kernel-side context + byte-identical prompts; personas as kernel config; the parity
harness signed off; a production smoke client exercising each feature.

## 2. Changes

**core — feature-service framework** (`modules/ai/features/`): one registry of features; each
declares its context loaders, prompt template ref, model/effort/temperature defaults (kernel
config, editable — the per-feature tuning tables from `ai-gateway-anthropic.ts:56-95` become the
seed values), and output post-processing. Route `POST /api/v1/ai/features/:feature`
(`kind:'apiKey'` bearer; SSE streaming response via the gateway's existing streaming path);
every generation flows through Stage 29's gateway internals — budgets, ledger, restricted-class
capture, generation refs.

**core — context loaders** (`modules/ai/context/`): transcript (archive + hot table, bounded
window), spend/subscription (rollups + `page_fans`), fan summary (existing fan-profiles), Fansly
per-fan earnings (16's projection). Loaders are pure, testable, and their outputs are exactly the
context blocks the client implementations build today — the parity harness compares at this
level.

**core — prompt migration (byte-for-byte):** prompt libraries from both client repos copied
verbatim into `modules/ai/prompts/` (one file per feature/persona, with a provenance header:
source repo + commit + date); `escapeForPrompt` + safety preamble + output sanitizer ported as
one unit **with their regression tests** (test files copied and adapted only in imports);
personas become kernel config records (name, system-block, per-feature overrides) seeded from
the clients' defaults. A checked-in `prompt-manifest.json` records sha256 of every migrated
prompt against its source — the byte-diff proof is CI-checkable.

**core — parity harness** (`tests/ai-feature-parity.test.ts` + a runnable CLI for the sign-off):
for each feature: fixed fixture context → kernel-assembled prompt vs the client-local
implementation's assembled prompt (client assembly reproduced in the harness from the reference
repos' logic, or via recorded assembled-prompt fixtures captured from the clients during the
freeze) → **compares assembled prompts, not outputs** (passport rule). Differences = blockers,
not notes. Sign-off recorded in `decisions.md` before any client cutover stage starts.

**core — smoke client:** an ops CLI (`ai:feature-smoke --feature <f>`) exercising each feature
against production with a synthetic/owner-approved conversation — run post-deploy and on demand.

## 3. Schema & data migration

```sql
-- 00NN_ai_personas.sql
CREATE TABLE ai_personas (
  id bigserial PRIMARY KEY, key text NOT NULL UNIQUE, display_name text NOT NULL,
  system_block text NOT NULL, feature_overrides jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
```
Per-feature model/effort/temperature config: registry entries (editable, `runtimeApply:'live'`
where safe) or a small `ai_feature_settings` table — decide at execution by count (≤3 knobs per
feature → registry; more → table). No data migration; personas seeded from client defaults.

## 4. Client compatibility

- **Desktop / extension:** zero change — no client cuts over here (31/32). Their current lanes
  (hub-AI mode contract; extension direct-vendor) are untouched. The freeze window is the only
  client-side effect (process, not code).
- **Dashboard:** none (feature admin UI, if any, is 33+).
- **Workboard:** the classifier already rides the gateway (29); it may adopt the feature-service
  registry as an internal consumer here (mechanical; optional task).

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:** the migrated sanitize/escape regression suites (green kernel-side — the move-as-
one-unit proof); prompt-manifest hash check (CI — byte-diff proves equality against recorded
source hashes); context-loader unit tests over fixtures; per-feature streaming integration
(fixture context → gateway mock → streamed completion + restricted-class row + ledger row);
parity harness per feature.

**Existing suites:** gateway suite (29), archive/read suites (context sources).

**Production verification (exit criteria):**
- Byte-diff proof: `prompt-manifest.json` hashes match the frozen client sources (CI + recorded
  here).
- Parity harness: assembled prompts equivalent per feature, signed off in `decisions.md`.
- Smoke CLI exercises every feature in production (latency + outcome recorded — intra-VPS
  gateway hop is single-digit ms per DP 5; record actuals for Stage 31's latency budget).
- Sanitize regression tests green kernel-side.

## 6. Rollback

- Everything is additive (new routes, new module); no client depends on it yet — disable the
  routes to shelve the stage with zero blast radius.
- Prompt tuning stays frozen only through sign-off; after that, kernel-side is the single home
  (Stage 31's assumption) — rolling back *after* clients cut over is their stages' concern.
- No irreversible step.

## 7. Assumptions

1. **The kernel holds all needed context** (the §3 promise delivered by 10/14/16) — any context
   the harness finds client-only (e.g. an extension-local DOM-derived field) is a named gap:
   escalate, don't approximate silently.
2. **The Pass 2 feature inventory is still the feature set**; the extension's persona/panel
   features enumerate cleanly from its repo (reference-only read; no Fansly session internals
   are involved in prompt code).
3. **Prompt freeze holds** through parity sign-off (owner-communicated); post-sign-off, all
   tuning is kernel-side.
4. **Latency budget**: kernel assembly adds context-query time; the smoke CLI's measured p95 is
   the number Stage 31 compares against direct mode (agreed delta lives there).
5. **DP 9-A**: per-org editability = global config; nothing multi-tenant is built.

## 8. Task breakdown

1. **Framework + route + gateway wiring + one pilot feature (fast-reply) end-to-end.** *(1
   session)*
2. **Context loaders + unit tests.** *(1 session)*
3. **Prompt migration (both repos) + sanitize unit + manifest + regression suites.** *(1
   session)*
4. **Remaining features + personas config + seeds.** *(0.5–1 session)*
5. **Parity harness + freeze-window capture + sign-off run.** *(1 session)*
6. **(Last) Deploy; production smoke per feature; record parity sign-off + latency numbers
   here.** *(ops)*

## Progress

**Session 1 (2026-07-06, on main post-#105; decision #106):**

§8 status — **Task 1 DONE (pilot end-to-end), Task 2 core DONE, Task 3 core
DONE (unit + manifest + regression suites); Tasks 4 (remaining features +
persona seeds), 5 (parity harness + freeze capture + SIGN-OFF), 6 (ops)
remain.**

**PRE-FREEZE DEVIATION (recorded):** the owner's prompt-freeze window (§1
entry criterion) has NOT yet been declared. The unit was snapshot from
desktop @ 1db76a4ae13d (2026-07-06); the manifest records source sha256 per
file, so a post-freeze re-snapshot is one command and the Task 5 parity run
re-verifies against the frozen sources. Also: Stage 29 is built, not yet
exited (entry criterion "29 exited" — deploy pending owner window).

- [x] **Prompt unit migrated byte-for-byte** into `modules/ai/prompts/`:
  builder + templates(.ts + .md ×7) + escape + personalities + output
  sanitizers (reply-output/split/xml) + transcript
  (format/normalize/html/ofapi-message/ping-segment) + context formatters
  (spending/subscription) + the prompt-relevant shared types. .md templates
  BYTE-IDENTICAL to source (manifest-pinned); .ts adapted ONLY in imports +
  provenance headers. `prompt-manifest.json` records sourceSha256 +
  coreSha256 per file; drift pin test recomputes.
- [x] **Regression suites moved with the unit** — 123 tests green
  kernel-side unchanged (escape 12, builder 46, reply-output 17,
  templates-sync 34, personalities 14), imports-only adaptation.
- [x] **Migration 0073 ai_personas** + repository (upsert/find/list,
  archived_at soft-retire). Bundled Lora remains the fallback via the
  migrated `createBundledPersonalities`.
- [x] **Feature framework + route**: `POST /api/v1/ai/features/:feature`
  (apiKey auth, SSE via the shared `pipeAiGatewaySse` pump extracted from
  the gateway route); registry seeds = desktop defaults at snapshot (model
  Sonnet 4.6, reasoning medium, quick window 100). Every generation rides
  Stage 29 internals (budgets, ledger, restricted capture, generation refs).
- [x] **Context loaders** (`modules/ai/context/`): transcript rebuilds the
  OFAPI message shape from archive rows and runs the MIGRATED normalizer +
  formatter (max parity by construction); spending derives the vendor
  `sums` from the kernel transactions ledger; subscription from page_fans.
  NAMED GAPS (assumption 1 — escalate, not approximate): (a) PPV
  purchased-state — archive keeps price/tip but not isOpened/isFree, so PPV
  labels render 'unknown' until the archive learns purchase state; (b)
  spending sums are ledger-derived, not the vendor summary object; (c)
  media labels degrade (archive read doesn't surface media metadata). All
  three are parity-harness checkpoints for Task 5.
- [x] **Pilot proven**: fast-reply integration — kernel-assembled prompt
  reaches the provider with persona system-block (1h cache), formatted
  transcript (`[10:00] Fan: …`, `[Tip: $5.00]`), spending + subscription
  blocks; restricted-class row + ledger row land; stored persona via
  personaKey; unknown feature 404s.
- [x] **Task 4 (same session): all seven features live** — FEATURE_POLICIES
  migrated (values verbatim; the desktop's Settings-coupled window resolver
  replaced by kernel bucket defaults, recorded); registry DERIVED from the
  policies (model delegation improve/hi→fast-reply, earnings inclusion,
  window buckets quick 100 / improve 25 / deep 1500 / ping 100 / hi 25);
  desktop product gates carried: requiresDraft 400, deep minMessages 30
  (CG-FLOW-03), hi-greeting ≤10-message lock, ping segment ANALYZED
  kernel-side (migrated analyzePingSegment over the transcript); fanBio for
  hi-greeting from fans.metadata (NAMED parity checkpoint if absent in
  practice). Gate test exercises all seven through the route. Persona
  seeding + extension panel-feature inventory ride Task 5's freeze window
  (the extension's personas are the seeds' source of truth).
- [x] **Task 5: parity SIGNED OFF (#108)** — freeze declared by the owner
  2026-07-06 (structured confirm); harness = tests/ai-feature-parity.test.ts
  + `node --import tsx/esm scripts/ai-parity-signoff.ts`. Freeze guard: all
  24 migrated sources re-hash to the manifest values; desktop HEAD == the
  snapshot commit. Assembly parity: 9 fixtures across all seven features —
  kernel buildPrompt BYTE-IDENTICAL to the live desktop buildPrompt
  (cross-repo import). CAVEAT: assembly-level parity per the passport;
  context-VALUE parity for the three named loader gaps is a Stage 31
  cutover checkpoint. `ai:personas-seed` CLI added (run post-deploy).
- [ ] Task 6: deploy running (0071+0072+0073 one window) + smoke CLI +
  latency numbers; extension panel-feature/persona inventory (reference
  read) lands here too.
