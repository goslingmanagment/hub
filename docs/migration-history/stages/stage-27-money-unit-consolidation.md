# Stage 27 — Money-unit consolidation (Proposal 1 accepted: mills + micro-USD, no data migration)

**Repo(s):** core (+ display-only touches in dashboard, same repo) · **Depends on:** 13
(currency column), Q6 (**answered: Proposal 1 accepted**) · **Passport:** roadmap.md §4, stage 27

**Status header.** Q6 ruling applied: option (a) — platform money stays **mills**, AI cost stays
**micro-USD**, NO ×1000 migration, NO client display changes. Size: 2 sessions. The whole §5.3
discipline ships: one codec, source-named constructors with no bare-number path, lint bans,
mandatory unit suffixes at every boundary. Decision #15 (mills) stands, now with the footgun
class dead by construction.

## 1. Context

The 1000× footgun class lives in the ambiguous constructor and scattered float math:
`toMills(value: MoneyLike)` accepts `bigint|number|string` with caller-dependent meaning
(`packages/shared/src/money.ts:1-4`); raw float sites exist
(`BigInt(Math.round(amount*1000))` — `ofapi-dm-archive.ts:100`; `Math.round(Number(mills)/1000)`
— `telegram-report.ts:199`; `Number(priceMills)/1000` — `ofapi-sync-snapshot.ts:192,195`;
`Number(mills)/1000` — `workboard-v2/engine.ts:136`); and one unit-mismatch trap is live in the
schema (`page_dm_messages.total_tip_amount_cents` — **cents** amid 22 `_mills` columns,
`schema.ts:921`). This stage kills the class by construction, without touching a single stored
value.

**Entry criteria restated as facts to verify:**
- Q6 recorded (done — roadmap §8).
- Stage 13's `currency` column live (unit labels meaningful at boundaries).
- Report totals snapshotted for the before/after diff (dashboard revenue endpoints + Telegram
  digest numbers for a fixed window, saved).

**Deliverable:** `packages/shared/money` as the single branded codec; zero ambiguous-constructor
call sites (grep = 0); lint/ratchet bans green; report totals byte-identical.

## 2. Changes

**core — `packages/shared/src/money.ts` (the codec):**
- Branded types: `type Mills = bigint & { __unit: 'mills' }`, `type MicroUsd = bigint &
  { __unit: 'microUsd' }` (compile-time only — zero runtime change).
- Source-named constructors, no bare-number path: `millsFromDollars(number|string)` (absorbs
  `dollarsToMills`, `:50-64`), `millsFromDbBigint(bigint)` (DB reads), `millsFromCents(number)`
  (the `total_tip_amount_cents` bridge — Stage 10 already needed it), `microUsdFromDollars`,
  `microUsdFromDbInt`, and converters `millsToMicroUsd`/`microUsdToMills` (lossy direction
  explicit). Formatters keep their names (`formatUsdFromMills`, `millsToDecimalString`,
  `millsToNumber` — display-only, now typed over `Mills`); `sumMills` typed; the commission
  helpers (`calculateNetMillsFromGross`/`…GrossFromNet`, `:91-106`) typed.
- **`toMills(MoneyLike)` deleted** after a full call-site audit: each caller classified by what
  its input actually is (DB bigint / dollars string / already-mills number) and rewritten to the
  named constructor. The audit list is recorded in the PR (this is the stage's core labor).
- The four float sites above rewritten through the codec (`millsFromDollars`,
  `formatUsdFromMills`/`millsToNumber`).

**core — AI plane:** `cost_micro_usd` (int, `schema.ts:1527`) reads/writes through
`MicroUsd` constructors; the gateway pricing math (`ai-gateway-pricing.ts`) and the three
config limits (`chatMuse…MicroUsdLimit`, `config-registry.ts:195-197`) typed. No column changes.

**core — boundary suffix rule:** every money field at a contract/report/telegram boundary
carries its unit in its name — audit `packages/contracts/src/routes.ts` money fields (verified
convention largely holds: `costMicroUsd`, `*Mills`; the audit fixes stragglers **additively** —
a misnamed field gets a suffixed twin + `deprecated` marker, old name retired on the clients'
own cadence; no breaking rename).

**core — lint bans (ESLint from Stage 19 + ratchet):**
- Ban `toMills` (it no longer exists — the rule prevents reintroduction), ban new occurrences of
  `* 1000` / `/ 1000` / `Math.round(` in files importing money types (heuristic
  `no-restricted-syntax` scoped to money modules + the ratchet script counting
  `Math.round\(.*(1000|price|amount|mills)` repo-wide — day-one count recorded, only decreases).
- Ban arithmetic on raw DB money columns outside the codec: repository-layer convention check
  (money columns only touched via typed helpers) — enforced by review rule + ratchet, honestly
  documented as convention-plus-count rather than a sound type system (drizzle returns
  bigint/number; the brands apply at the service boundary).

**dashboard (same repo, display-only):** `apps/dashboard/src/lib/format.ts` +
`MoneyCell.tsx` et al. keep formatting mills — imports move to the typed formatters; zero visual
change (totals diff proves it).

## 3. Schema & data migration

**No schema change. No data migration.** (Q6's entire point.) The one candidate —
`total_tip_amount_cents` → mills — is deliberately NOT migrated: the column keeps its honest
`_cents` suffix and the codec bridges it; renaming/converting a hot DM column buys nothing the
suffix rule doesn't (record as accepted debt; Stage 28's models normalize at read time).

## 4. Client compatibility

- **Desktop / extension:** nothing — no wire field changes (additive suffix twins only, if the
  audit finds stragglers; consumed on their own cadence per §6.4 deprecation policy).
- **Dashboard:** zero visual change (byte-identical totals is an exit criterion).
- **Workboard:** n/a.

**Compatibility invariants (target §14):** untouched.

## 5. Tests & verification

**New tests:** codec unit tests (constructor semantics incl. string-dollar edge cases carried
from `dollarsToMills`'s existing behavior; cents bridge ×10; micro-USD round-trips; lossy
conversion direction explicit); type-level tests (a `Mills` where `MicroUsd` expected fails to
compile — `tsd`-style or `@ts-expect-error` fixtures); the four float-site rewrites each get a
value-preservation test (old expression vs new codec call over a property range).

**Existing suites:** everything touching money — transactions/rollups, reporting, telegram
digest, AI usage, spenders, workboard engine — green with **unchanged expectations** (any
expectation change = a bug found, escalate, don't absorb silently).

**Production verification (exit criteria):**
- Report totals byte-identical: the §1 snapshot re-run post-deploy, diff = 0 (dashboard revenue
  endpoints + Telegram digest for the same fixed window).
- `grep -rn "toMills(" --include="*.ts"` = 0 (excluding the lint rule/docs).
- Lint + ratchet gates green in CI; ratchet budget file shows the float-site count at its new
  floor.

## 6. Rollback

- Pure refactor + lint config — revert commits restore everything; no data was touched, no
  contract broken. No irreversible step.

## 7. Assumptions

1. **The AI plane continues in micro-USD** (its config/API already do — verified) and the two
   units never mix without an explicit converter call — the brands enforce it at compile time in
   service code.
2. **Decision #15 (mills) stands** under the owner's Q6 ruling; a future full micro-USD
   migration remains possible (the codec centralizes exactly the sites it would touch — this
   stage *reduces* that blast radius).
3. **`dollarsToMills`'s existing parsing semantics are correct** (string dollars → mills,
   verified logic `money.ts:50-64`) — `millsFromDollars` inherits them byte-for-byte; behavior
   changes are out of scope.
4. **ESLint exists** (Stage 19). If this stage somehow runs first, the ratchet scripts carry the
   bans alone (they are the enforcement floor).
5. **The `_cents` column stays cents** — every consumer goes through `millsFromCents`; drift
   signal: a new reader doing `*10` inline (the ratchet's pattern list includes it).

## 8. Task breakdown

1. **Codec (brands + named constructors + converters) + unit/type tests.** *(0.5 session)*
2. **`toMills` call-site audit + rewrite + float-site rewrites + value-preservation tests.**
   *(1 session — the core labor)*
3. **Boundary suffix audit (contracts/reports/telegram) + additive fixes; lint rules + ratchet
   budgets.** *(0.5 session)*
4. **(Last) Deploy; totals byte-diff + grep-zero + CI gates; record results here.** *(ops)*

## Progress

**Session 1 (2026-07-06, chain branch — commit 06a06d9; deps 13 + Q6 both EXITED/answered, no
ordering deviation needed):** §8 tasks 1–3 BUILT (decision #97). Suite **192/1548, unchanged
expectations**. No schema/data change.

- [x] **Task 1** — codec: Mills(bigint)/MicroUsd(number — recorded adaptation) brands;
  millsFromInteger (ONE already-mills constructor absorbing toMills byte-for-byte — recorded
  deviation from the millsFromDbBigint sketch), millsFromDollars (inherits dollarsToMills
  parsing; old name kept as honest alias), millsFromCents (×10 bridge), micro constructors,
  explicit converters (lossy direction named), typed formatters + millsToDollarsNumber /
  millsToRoundedDollars. Unit + @ts-expect-error type tests.
- [x] **Task 2** — toMills deleted; all 27 sites audited → already-mills class →
  millsFromInteger (cli revenue prints, finance rollups, reporting aggregation, telegram
  totals, onboarding/shared wallet balances, subscription prices, transaction amounts).
  Four float sites through the codec with value-preservation property tests.
- [x] **Task 3** — eslint toMills ban; ratchet = tests/money-ratchet.test.ts vs
  scripts/money-float-budget.json (budget 9; first target: ofapi-dm-sync dollars→cents);
  suffix audit clean (contracts money fields all unit-suffixed; matches were counters).
- [ ] **Task 4 (ops)** — deploy with the chain; report-totals byte-diff (dashboard revenue +
  Telegram digest, fixed window, §1 snapshot); grep-zero + gates in CI.
