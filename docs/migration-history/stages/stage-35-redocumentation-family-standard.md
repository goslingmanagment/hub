# Stage 35 — Re-documentation & family standard

**Repo(s):** all (core, desktop, extension, + workboard repo if Stage 34 has shipped) ·
**Depends on:** everything prior (last by definition) · **Passport:** roadmap.md §4, stage 35

**Status header.** No deviation from the master. Two verified working-tree findings that
become entry work (facts as of 2026-07-04, re-verify at execution):
1. **Both client repos' Pass 1 maps are uncommitted**: `docs/project-kernel/` is untracked in
   `chatgoose_desktop_fable` AND in `chatgoose` (`git status` — the extension's entire
   `docs/` is untracked). "Machine-generated maps regenerated from committed prompts" cannot
   be true while the prompts and maps only exist in working trees.
2. **The desktop working tree deletes six review docs uncommitted**
   (`docs/reviews/2026-06-10-plan-review.md` … `review-prompt.md`, plus two untracked new
   reviews) — exactly the knowledge-deletion habit the anti-deletion rule (target §12.2)
   exists to stop. Resolution (restore, or commit the deletion WITH tombstone entries) is
   owner's choice, made explicit in task 1 — never a silent `git add -A`.

## 1. Context

The owner's operating model is agents-do-the-engineering (DP 10: the documentation standard
is mandatory, not optional). Today the family inverts it: **core — 632 files, the money, the
kernel — has no CLAUDE.md, no AGENTS.md, and no lint**; the extension has no agent docs and
no decision log; only the desktop meets the bar (CLAUDE.md 8 KB + pointer AGENTS.md +
SESSIONS.md + ESLint-as-architecture + full strictness) while having **zero PR CI**. This
stage brings every repo to the target §12 standard and regenerates the maps so documentation
describes the END state of the migration, not the starting one.

**Entry criteria restated as facts to verify:**
- No stage in flight; a stage-list retrospective recorded (where shipped ≠ roadmap, the diff
  is written down in `pass3/` — not papered over).
- Working trees clean after task 1's reconciliation (the two Status-header findings).
- Verified per-repo baseline (survey 2026-07-04; re-verify with `git`/`ls` at execution):

| Fact | core | desktop | extension |
|---|---|---|---|
| CLAUDE.md / AGENTS.md | — / — | ✅ 8 KB / ✅ pointer | — / — |
| decisions.md | ✅ 958 lines, #61, quick-ref table | — | — |
| Maps + committed prompt | `docs/project-kernel/maps/` ×21 + `prompts/` ×7 | `docs/project-kernel/` ×11 + `prompt-1-map.md` (untracked!) | `docs/project-kernel/` ×16 + `prompt-1-map.md` (untracked!) |
| Per-file generation banner | none (provenance in README only) | none (README cites commit 84038b8) | none, no README |
| PR CI | typecheck+build+docker+unit+sync-critical (`.github/workflows/ci.yml`) — **no lint** | **none** (only tag-triggered `windows-build.yml`) | `npm run check` = typecheck+test+build — **no lint** |
| ESLint | **absent** | ✅ flat, architecture rules | absent (until Stage 32 adds it) |
| tsconfig | `strict` only | strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` | strict + `noUncheckedIndexedAccess` |
| Toolchain | pnpm@10.30.3 pinned, TS ^5.8.2, vitest ^3.2.4, ESM | pnpm (unpinned field), TS ^6.0.3, vitest ^4.1.8, ESM | npm/commonjs → pnpm/ESM in 32; TS ^5.9.3, vitest ^4.0.18 |
| Canonical check cmd | none (discrete scripts) | `pnpm check` | `check` (no lint) |

**Deliverable:** every repo passes the target's own test — a fresh agent session, given only
CLAUDE.md, correctly answers the orientation questions ("where does X get written", "who can
do what", "what happens when Y arrives") — with maps regenerated after the last code change
and all CI gates green family-wide.

## 2. Changes

**All repos — agent context files (target §12.3):**
- **core**: write `CLAUDE.md` (the inversion, fixed last-but-not-least): one-paragraph
  what-this-is; doc-routing table (decisions.md, `docs/generated/` maps, pass3 stage specs,
  runbooks incl. the DP 8 break-glass and go-live docs); hard rules **with rationale** —
  outbox one-attempt/fail-closed discipline (crown jewel 2), capture-first/no-scheduled-
  deletion (DP 7), staged-flag one-flip-at-a-time, money units per Q6 (mills + micro-USD,
  named constructors only), single-tenant invariant (DP 9-A), no `platform ===` outside
  adapters, egress via the resolver only, "no kernel write API without a principal";
  conventions (pnpm, Docker for Testcontainers, `tests/*.integration.test.ts`); the check
  command (added below). Plus `AGENTS.md` as a pointer (the desktop's 5-line pattern
  verbatim) and — multi-session work being the norm here — a `SESSIONS.md` modeled on the
  desktop's.
- **desktop**: update `CLAUDE.md` to post-migration truth (SDK client, stream v2, hub-only
  reads, kernel AI features, device tokens; prune/spool semantics per Stages 4/11/12; drop
  retired references: local prompt library, direct transports, vendor keys). `AGENTS.md`
  already correct.
- **extension**: write `CLAUDE.md` + pointer `AGENTS.md` from scratch (post-Stage-32 truth:
  SDK, device token, kernel features/boards, reader-only Fansly role per DP 1-B, the
  session-material scope guard, deploy.sh release ritual); note `SPEC_FINAL.md` is
  historical, code + kernel docs are truth (its own map says so).
- **workboard repo** (if it exists by now): verify it was born compliant (stage-34 §1
  constraint); otherwise this stage's checklist applies to it too.

**All repos — decision logs (target §12.2):**
- Bootstrap `docs/decisions.md` in desktop and extension (core's format: numbered,
  append-only, quick-ref table): seed entries = the migration decisions that landed in each
  repo (stages 4/11/12/24/31 desktop; 32 extension) with pointers to the core-side specs.
- **Family law recorded in each log**: (a) the anti-deletion rule — removing/superseding any
  doc requires a tombstone entry; deprecated specs get a banner, never deletion (generated
  docs exempt); (b) hand-curated docs are updated in the same change that invalidates them;
  (c) cross-repo decisions live in core's log and are referenced, not copied. Core's log
  additionally records: the numbering gap around #48–53 (historical, not renumbered —
  append-only), and tombstones for anything task 1 confirms deleted.

**All repos — maps regenerated to the END state (target §12.2):**
- Re-run each repo's committed map prompt against the post-migration tree into
  **`docs/generated/`** (the §12.1 skeleton location), with a **per-file banner**:
  `> Generated <date> from <prompt path> at commit <sha>. Machine-generated — do not
  hand-edit; regenerate with the same prompt.` Prompts move to `docs/prompts/` where the
  skeleton wants them (core keeps `docs/project-kernel/prompts/` as the historical Pass 1–3
  record).
- The old Pass 1 maps under `docs/project-kernel/` are **kept** with a superseded banner +
  a tombstone-style pointer entry in decisions.md (anti-deletion rule applied to ourselves);
  the pass2/pass3 documents remain untouched as the migration's historical record.
- **Owner intent recorded (2026-07-04):** after the migration finishes, the "project kernel"
  branding retires — `docs/project-kernel/` becomes explicitly a historical archive and the
  *living* documentation is the normal `docs/` + `docs/generated/` surface this stage
  builds. Interim per-repo docs (`pass3-migration.md`) get superseded banners here. The
  quality bar for agent-produced docs is this stage's orientation drill (§5) — a regenerated
  doc that can't orient a fresh session fails the stage, regardless of banner discipline.
- Core also regenerates the derived references stages built (`docs/generated/` policy table
  from Stage 19, egress inventory from Stage 26) — verify their banners carry regeneration
  commands.

**CI floor (target §12.4) — per repo:**
- **core**: add ESLint (flat config; seed from the desktop's, plus the architecture rules
  earlier stages introduced — module boundaries (19), money-constructor bans (27),
  `platform ===` ratchet (18), egress-resolver requirement (26), no vendor-SDK imports
  outside the gateway (29)); add a root `check` script (`typecheck && lint && test:unit &&
  build`); `ci.yml` gains the lint step; new nightly workflow: full Testcontainers
  integration suite + the projection-rebuild-from-fixtures proof (§5.2 discipline);
  sync-critical subset stays on PR via tags, retiring any `--testNamePattern` allowlist
  drift.
- **desktop**: NEW `.github/workflows/ci.yml` — `pnpm check` on PR/push (ubuntu; the suite
  is node-env vitest + electron-vite build, both linux-safe). The zero-PR-CI era ends here
  at the latest.
- **extension**: add the lint step to `check` (config landed in Stage 32); CI already runs
  `check` on PR.
- **Cross-repo**: verify the SDK pin + contract-hash drift gates are humming in both client
  repos (weekly bump-PR flow live; re-run the stage-20 deliberate-breaking-change drill once,
  record it).

**Toolchain harmonization (target §12.4):**
- One pinned pnpm via `packageManager` in all three (core's `pnpm@10.30.3` is the reference;
  bump family-wide to one current version); `engines.node >= 22` everywhere.
- One TypeScript major and one vitest major family-wide (desktop's TS 6 / vitest 4 are
  current; core upgrades TS ^5.8→6 and vitest 3→4; extension aligns) — mechanical, gated by
  each repo's `check`.
- **core strictness ratchet**: enable `exactOptionalPropertyTypes` +
  `noUncheckedIndexedAccess` in `tsconfig.base.json`; fix what's cheap, suppress the rest
  with a **counted ratchet** (an error-count snapshot that may only decrease, enforced in
  CI) — the flags land now, the debt burns down without blocking the stage. (Full-fix effort
  is unknowable until the flags flip; the ratchet keeps this stage honest at its 3–4-session
  size.)

**Release hygiene (Q5's class of drift, fixed as process):**
- Desktop `RELEASE.md` + workflow gain a checked step: after publish, assert feed
  `latest.yml` version == tag == `apps/desktop/package.json` version (a tiny script in the
  workflow); the stage-04 artifact-diff ritual is documented as the recovery path.
- Extension `deploy.sh` already derives `updates.json` from `manifest.json` — add the same
  assert (served version == manifest == package.json) to its verify step (`deploy.sh`
  already curls the public URLs).

## 3. Schema & data migration

**No schema change. No data migration.** (Documentation, CI, and toolchain only.)

## 4. Client compatibility

- **Desktop / extension / dashboard / workboard:** zero runtime change. Desktop and
  extension releases during this stage are CI/docs-only (or none at all — CI changes don't
  require a client release).
- **Compatibility invariants (target §14):** none in play. The auto-update feed and
  self-hosted channel are untouched; the release-hygiene asserts only *observe* them.

## 5. Tests & verification

**New tests/gates:** core ESLint baseline green; core strictness ratchet job (count may only
decrease); nightly integration + projection-rebuild workflows green twice consecutively;
desktop PR CI green on a real PR; extension lint green; SDK drift-gate drill re-proven
(deliberate break fails both client repos — screenshot/log recorded here).

**Existing suites:** every repo's full check green on the harmonized toolchain (the TS/vitest
upgrades are proven by the suites themselves).

**Production verification (exit criteria):**
- **The orientation drill, run literally**: a fresh agent session per repo, given only
  CLAUDE.md, answers "where does X get written", "who can do what", "what happens when Y
  arrives" correctly — one transcript per repo attached/linked here.
- Maps regenerated after the last code change of the migration (banner dates ≥ last
  substantive commit; spot-check three claims per repo against code).
- All CI gates green across the family on the same day (record the run links).
- decisions.md in all repos current, with the family law + tombstones present.

## 6. Rollback

Docs and CI are git-revertable; the toolchain upgrades revert per repo if a suite regression
proves deeper than it looks (each upgrade is its own commit). Nothing here is irreversible,
and nothing touches runtime. The one deliberately sticky artifact is the anti-deletion rule
itself — once recorded, removing it requires its own tombstone (that is the point).

## 7. Assumptions

1. **Repo topology is DP 10-A** (three repos + workboard's if shipped); the SDK pin/CI
   machinery from Stage 20 is live — this stage verifies and documents, it does not build
   distribution.
2. **Earlier stages carried their doc duty** ("updated in-change" family law applies from
   Stage 20 onward per the passport) — this stage is the final sweep and regeneration, not
   the first attempt; big gaps found here are retrospective entries, not silent fixes.
3. **The Pass 1 map prompts still produce useful maps** against the migrated tree (they are
   descriptive prompts, resilient to refactors); prompt adjustments are committed alongside
   the regenerated output (they are part of the generated-docs contract).
4. **The desktop CLAUDE.md remains the gold-standard template** (target §12.3) — core's and
   the extension's new files copy its *shape*, not its content.
5. **Owner arbitrates task 1's deletions** (restore vs tombstone) — the six desktop review
   docs and any other uncommitted deletions found at execution; the untracked map folders
   are committed as-is (they are the Pass 1 deliverable).
6. **Single-tenant invariant (DP 9-A) and the append-only retention model (DP 7)** are
   written into core's decisions.md as standing invariants if earlier stages haven't already
   done so (Stage 22 assumption 5 and Stage 28 own parts of this — reconcile, don't
   duplicate).

## 8. Task breakdown

1. **Working-tree reconciliation + decision-log bootstraps + family law.** Commit the
   untracked `docs/project-kernel/` in both client repos; resolve the desktop review-doc
   deletions with the owner (restore or tombstone); seed desktop/extension decisions.md;
   record family law + core tombstones/gap note. Done-check: `git status` clean ×3; logs
   present with quick-ref tables. *(0.5 session)*
2. **Core CLAUDE.md + AGENTS.md + SESSIONS.md.** Done-check: a colleague-grade read-through
   + the core orientation drill passes on a draft session. *(0.5–1 session)*
3. **CI floors + toolchain harmonization + core strictness ratchet.** Files: core
   `eslint.config.mjs` (new), `package.json` scripts, `.github/workflows/*` in all repos,
   tsconfig bases, version pins/upgrades. Done-check: §5's gates green; ratchet job
   enforcing. *(1–1.5 sessions)*
4. **Maps regenerated ×3 into `docs/generated/` + banners + supersession entries; derived
   references verified.** Done-check: banner discipline; three-claims spot-check per repo.
   *(0.5–1 session — parallel with 3)*
5. **Client CLAUDE.md work** (desktop update, extension create) **+ SDK versioning-and-
   pinning section in each consumer CLAUDE.md** (stage-20's agent-legibility requirement)
   **+ release-hygiene asserts.** Done-check: asserts fire in a dry run; drift drill
   re-proven. *(0.5–1 session)*
6. **(Last) The orientation drill in all repos + family-wide green-CI snapshot; record
   transcripts, run links, and the migration retrospective pointer in this file.** *(ops)*

## Progress (2026-07-06/07)

**Task 1 DONE (07-06):** both entry findings were already resolved (client maps
committed 5d298d4/846fc9c; desktop review docs tombstoned 996fcbb; both client
trees clean). Client decision logs bootstrapped: desktop `docs/decisions.md`
(D1–D5, on kernel/stage-31-ai-cutover), extension `docs/decisions.md` (E1–E7,
on bar-tone-menu). Family law + numbering-gap note + retroactive tombstones
appended to core's log.

**Task 2 DONE (07-07):** core `CLAUDE.md` (intro / current-state / doc-routing
table / hard-rules-with-rationale / conventions — the desktop template's shape,
core's content), `AGENTS.md` (the 5-line pointer), `SESSIONS.md` (session
runbook: harness prompts, standing rules incl. never-`git add -A` and
docs-via-`add -f`, ops watches pointer).

**Task 3 DONE (07-07), decision #113:** family lint standard in core (recommended
+ desktop hygiene rules over the Stage 19 walls; 162 violations → 0, no waivers);
`pnpm check` in core; nightly full-Testcontainers workflow (carries the
projection rebuild-from-fixtures proofs); sync-critical PR subset now selected
by a `[sync-critical]` title tag — the 16-fragment `--testNamePattern` allowlist
is retired (same 19 tests, proven via `vitest list`); toolchain harmonized
(pnpm@10.33.1 pinned via `packageManager` ×3, workflows read the pin; node>=22;
TS ^6 + vitest ^4 family-wide — core dropped deprecated `baseUrl` for relative
paths, extension dropped its vestigial `baseUrl` after the first TS6 check
caught it); strictness ratchet ON (exactOptionalPropertyTypes +
noUncheckedIndexedAccess; 2058 errors / 136 files snapshotted per-file in
`scripts/strictness-ratchet.json`; `pnpm typecheck` IS the ratchet — both
failure directions drill-verified); desktop PR CI born (`ci.yml` → `pnpm
check`, green locally). Full core suite green on the new toolchain
(205 files / 1683 passed; two vitest-4 breaks fixed: constructible class mock
in bootstrap.test.ts, spyOn casts in fansly-dm-fixtures.test.ts).

**Drift drill re-proven (07-07, §2 cross-repo):** deliberate breaking change in
core (route key `pages` → `pagesDrill` in `packages/contracts/src/routes.ts` +
the catalog module binding) → `contracts:generate` → re-vendored into BOTH
clients. Three gates fired in order: (1) core's own generator refused until the
runtime binding matched the registry ("manifest/registry mismatch — missing:
[pagesDrill]"); (2) desktop typecheck FAILED: `src/hub/client.ts(478):
Property 'pages' does not exist on type 'KernelClient'` (+ the
KernelOperationKey constraint at line 192); (3) extension typecheck FAILED:
`src/background/agency-hub-client.ts(198): Property 'pages' does not exist on
type 'KernelClient'`. Everything reverted; both clients re-verified green
(desktop typecheck exit 0; extension FULL check exit 0, unmasked).

**Remaining:** Task 4 (maps ×3 + banners), Task 5 (client CLAUDE.md work + SDK
pinning sections + release-hygiene asserts), Task 6 (orientation drills +
green-CI snapshot + retrospective pointer).

## Progress (2026-07-07, second push) — Tasks 4–6

**Task 4 DONE:** maps regenerated ×3 into each repo's `docs/generated/` with the
banner discipline (core: 24 maps @ 0bc74f6; desktop: 12 maps @ d044790;
extension: 18 maps @ 1586f07 — all committed). Superseded banners prepended to
every Pass 1 original (21/14/18 files). The map prompts gained a committed
"Stage 35 regeneration addendum" (output location + banner spec + re-verify
rule), per assumption 3. Three-claims spot-check done per repo — all exact.
Derived references verified: the Stage 19 policy table
(`docs/generated/authorization-policy.md`) carries its regeneration command;
the Stage 26 "egress inventory" exists as the LIVING raw-fetch ratchet
(`scripts/check-raw-fetch.mjs` + budget), not a doc — recorded here as the
inventory's current form.
*Method note:* regeneration ran on Opus subagents; fact sheets from an aborted
earlier run were extracted transcript-to-file (never through the orchestrator
context) and used as pre-verified source material.

**Task 5 DONE:** desktop CLAUDE.md rewritten to post-migration truth + Kernel
SDK versioning-and-pinning section; extension CLAUDE.md + AGENTS.md created
from scratch (post-Stage-32 truth, DP 1-B live-reader role, SPEC_FINAL marked
historical) + same SDK section; release-hygiene asserts shipped AND dry-run
proven — extension `deploy.sh` (package==manifest before signing; served
feed==release after upload; verified against the live 1.6.0 feed) and desktop
`windows-build.yml` (served latest.yml==package.json==tag) + RELEASE.md
recovery note.

**Task 6 DONE — orientation drills ALL THREE PASS (fresh Opus session per
repo, CLAUDE.md as sole entry):**
- **core:** all three answers (fan-earnings write path
  observations→domain_events→fan_earnings_stats→top-spenders route; staged-flip
  owner+advisory-lock mechanics; unmapped-webhook capture-then-skip) verified
  file:line-exact. Friction: no map index visible from the routing table —
  fixed (row now routes through `00-overview.md`).
- **extension:** PASS; drill also surfaced doc bugs, all fixed in-change:
  CLAUDE.md said MV2 (manifest is v3), the `ai-gateway-contract.md` pointer
  described the V1 raw gateway (now flagged PARTIALLY STALE with the correct
  feature-lane sources), `boundaries.md` now advertised by name, E3's
  "vendor hosts left in manifest" corrected by an appended note.
- **desktop:** PASS; drill flagged SPEC §6.2 (stream v1) and §8.6 (Direct AI)
  as stale → SUPERSEDED banners added to both sections + a precedence note in
  the routing table (decisions/generated win over SPEC).

**Bug found by the regeneration (extension E8):** `issueAgencyHubDeviceToken`
was UNREACHABLE in shipped 1.6.0 (missing `getRuntimeRequestType` case —
options-page device-token sign-in silently dead; the legacy chatter-key path
masked it). Fixed + test-pinned on bar-tone-menu; ships next release. Related
map fact for that release: 4 hub-client ops still authenticate with the legacy
key only — migrate them to the device token BEFORE deleting the chatter-key
path.

**Family green-CI snapshot (2026-07-07, all same-day):**
- core `CI` (full quality gate incl. ratchet + sync-critical Testcontainers):
  run 28824417152 SUCCESS.
- desktop PR CI on a real PR (#1, draft, kernel/stage-31-ai-cutover):
  run 28824630105 `pnpm check` PASS — the zero-PR-CI era is over. (The PR is
  a DRAFT opened to exercise CI; merging it is the owner-gated 0.1.31 release.)
- extension `CI` on bar-tone-menu: run 28825364090 SUCCESS.
- CI floor fix recorded: the ratchet's shrink demand initially failed the
  Docker image build (context excludes tests/) — now armed only when the full
  workspace is visible; per-file budgets unconditional.

**Retrospective pointer:** the migration's raw record is
`pass3/execution-log.md` (per-stage statuses + deviations) +
`docs/decisions.md` #62–#114 + each stage file's `## Progress` block. A
synthesized retrospective is deliberately NOT written here — it is owner-called
future work; this pointer is where it starts.

**Stage exit state:** all §5 exit criteria met same-day (drills ×3 PASS with
transcripts summarized above, maps banner-dated ≥ last substantive commit,
family CI green, decisions.md current in all three repos with family law +
tombstones). Remaining owner calls: flip the execution-log row to `exited`,
decide the draft PR #1's fate at 0.1.31 time.
