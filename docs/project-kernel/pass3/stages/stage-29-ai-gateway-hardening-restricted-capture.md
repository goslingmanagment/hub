# Stage 29 — AI gateway hardening + restricted capture class

**Repo(s):** core · **Depends on:** 7, 19; soft: 22 (grant machinery), 28 (its exporter
exclusion list + erasure procedure cover this stage's content tables) ·
**Passport:** roadmap.md §4, stage 29

**Status header.** No deviation. Verified baseline: the gateway (#26) is running-on in
production (Q1); only **anthropic** is implemented — `openrouter` is a dead enum value across
`ai-gateway.ts:51`, contracts, schema, repo (`schema.ts:1521,1573`); the usage ledger
(`ai_usage_events`, `schema.ts:1508-1574`) stores tokens/cost/metadata and **no prompt or
completion text** (finalize writes `ai-gateway.ts:250-266`); the workboard closing classifier
bypasses the gateway with a direct SDK call (`closing-classifier.ts:1,143,147`, key =
`config.anthropicApiKey`, model `claude-haiku-4-5`). DP 5-A and DP 6-A (full content capture,
restricted class; owner note: monitor volume, trimming later is the two-way door) govern.

## 1. Context

Before any client is forced through the gateway (Stages 31/32), the gateway must be worth being
forced through: a real second provider, per-feature budgets, and the DP 6 capture class — the
product's own quality signal (prompts, completions, acceptance) stored under owner-only access.

**Entry criteria restated as facts to verify:**
- #26 running-on (Q1 — re-check `chatMuseAiGatewayEnabled` on `runtime_instances`).
- Provider keys kernel-held (`anthropicApiKey` env — `config-registry.ts:200`); an OpenRouter
  key exists if the owner wants the second provider live (else it ships implemented-but-unkeyed).
- Stage 19's policy layer live (the restricted read path needs the declarative vocabulary;
  Stage 22's grants are the *soft* upgrade — owner-only via role until then).

**Deliverable:** OpenRouter implemented; per-feature budgets enforced with typed errors; the
restricted class capturing full content + acceptance keyed by generation; classifier rerouted
through the gateway; pricing reconciling against a sample week of vendor invoices.

## 2. Changes

**core — OpenRouter provider** (`services/ai-gateway-openrouter-provider.ts`, mirroring
`ai-gateway-anthropic-provider.ts`): streaming completions, model catalog + micro-USD pricing
entries added to `ai-gateway-pricing.ts`; provider selection by model prefix/routing table; the
dead enum value becomes real end-to-end (`gateway_outcome`/ledger rows unchanged in shape).

**core — per-feature budgets/quotas:** extend the existing daily/request limits
(`chatMuseAiGatewayDailyRequestLimit`/`DailyMicroUsdLimit`/`RequestMicroUsdLimit`,
`config-registry.ts:195-197`) with per-feature multipliers or per-feature keys (feature set is
already enumerated: `fast-reply, improve-draft, help-me, fan-summary, chat-review, scan, ping,
hi-greeting` — `ai-gateway-anthropic.ts:56-76`); breach → typed `quota_denied` error (the
outcome value exists in the ledger enum — wire the client-visible error taxonomy).

**core — restricted capture class (DP 6-A):** two new tables (§3):
`ai_generation_content` (per gateway generation: prompt blocks verbatim, completion, params,
model, feature, principal, conversation ref — written at finalize alongside the ledger row) and
`ai_acceptance_events` (lifecycle `shown|inserted|edited|sent`, generation ref, principal,
occurred_at — fed initially by canonicalizing the Stage 11 lane's `desktop.ai_acceptance`
observations that carry generation ids; fully correlated once Stage 31 reports against gateway
generation ids). Access: reads via a single owner-gated route pair (`kind:'session',
roles:['owner']` — upgraded to explicit grants when 22's machinery is preferred); **excluded by
default from lake exports** (Stage 28's exporter takes an exclusion list — these tables are on
it); covered by the erasure procedure (fan-scoped erasure reaches conversation-linked content).
Volume monitoring per the owner's DP 6 note: a daily row/byte metric + alert threshold; trimming
policy later is a write-path filter (two-way door — the plumbing supports A/B/C of DP 6).

**core — usage ledger authority:** the gateway ledger is authoritative; the client-reported lane
(`POST /api/v1/ai-usage/batch`) is marked deprecated in the contract (`deprecated: true`,
successor noted, removal after Stage 31 confirms fleet cutover — recorded per §6.4 policy). It
keeps working untouched until then.

**core — classifier reroute:** `createAnthropicClosingClassifier` (`closing-classifier.ts:142-166`)
replaced by an internal gateway call (new `runGatewayCompletion({feature:'workboard-closing',
principal: operator, …})` service entry — same model, same prompts byte-for-byte, `max_tokens`/
`temperature` preserved); the direct `@anthropic-ai/sdk` import dies (repo-wide import ban lands
with it — ESLint rule: no vendor SDK imports outside `services/ai-gateway*`); its spend now
appears in the ledger under the feature, subject to budgets (sized so the nightly run fits).

## 3. Schema & data migration

```sql
-- 00NN_ai_restricted_class.sql
CREATE TABLE ai_generation_content (
  id bigserial PRIMARY KEY,
  usage_event_id bigint REFERENCES ai_usage_events(id) ON DELETE RESTRICT,
  generation_ref text NOT NULL UNIQUE,        -- gateway-issued id, the acceptance correlation key
  feature text NOT NULL, model text NOT NULL, provider text NOT NULL,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  page_id bigint, conversation_ref text,
  prompt_blocks jsonb NOT NULL, completion text NOT NULL, params jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_acceptance_events (
  id bigserial PRIMARY KEY, generation_ref text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('shown','inserted','edited','sent')),
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL, source_observation_id bigint,
  UNIQUE (generation_ref, lifecycle, occurred_at)
);
```
No backfill (content capture starts at deploy — DP 6's one-way door runs forward only; that is
the argument for shipping this before the client cutovers). Volume guard: the daily metric.

## 4. Client compatibility

- **Desktop:** none — it stays on its current lanes until Stage 31; the gateway's existing
  streaming contract (`ai/gateway/stream`) is unchanged for the already-wired hub-AI mode.
- **Extension:** none until 32.
- **Dashboard:** none required (AI admin views are 33); the restricted read routes exist for the
  owner only.
- **Workboard:** classifier behavior identical (same model/prompts) — verdict parity spot-check
  in §5.

**Compatibility invariants (target §14):** untouched; the deprecated batch lane keeps serving.

## 5. Tests & verification

**New tests:** OpenRouter provider streaming + pricing unit tests (mocked vendor); budget breach
→ typed error (integration); restricted-class round-trip — a completion lands in
`ai_generation_content` and a team_lead principal's read is 403 while owner's is 200 (the
passport's headline test); acceptance canonicalizer (observation with generation id →
`ai_acceptance_events` row); classifier-via-gateway integration: verdict parity on a fixture set
vs the direct implementation (byte-identical prompts in, same-model determinism caveats
recorded), ledger row appears; vendor-SDK import ban self-test.

**Existing suites:** ai-gateway suite, ai-usage batch suite (unchanged), workboard classifier
suite (updated construction path only).

**Production verification (exit criteria):**
- Classifier runs via the gateway (direct SDK import gone — grep; nightly run's spend visible in
  the ledger under the feature).
- A production completion round-trips with content captured and team-lead-unreadable (probe).
- A budget breach blocks with the typed error (staged low limit on a test feature).
- Pricing table reconciles against vendor invoices for a sample week (numbers recorded here).
- Capture-volume metric + alert live (owner's DP 6 note honored).

## 6. Rollback

- Provider/budget/reroute changes are code+flag revertable; the classifier can be flipped back
  to the direct path by revert (keep the old code one release).
- Captured content is never rolled back (capture is the point); if DP 6 is re-ruled toward B/C,
  the write-path filter changes go-forward and existing rows fall under erasure.
- No irreversible step beyond capture-forward.

## 7. Assumptions

1. **DP 5-A and DP 6-A stand** (recorded); the break-glass direct-key story is an ops runbook
   (Stage 31's concern), not a client feature.
2. **The gateway codebase is as reviewed (well-built)** — hardening extends, does not rewrite;
   the streaming contract consumed by the desktop's hub-AI mode is untouched.
3. **Generation refs**: the gateway can mint/expose a stable `generation_ref` on its existing
   stream (verify the response envelope at execution; if absent, adding it is additive).
4. **Acceptance correlation before Stage 31 is best-effort** (desktop reports acceptance without
   gateway generation ids while in direct mode) — full correlation is a Stage 31 exit criterion,
   not this one's.
5. **Restricted-class reads stay owner-only via role** until Stage 22's grant machinery is
   preferred — either way, never team_lead/chatter.

## 8. Task breakdown

1. **OpenRouter provider + pricing + routing.** *(1 session)*
2. **Per-feature budgets + typed errors.** *(0.5 session)*
3. **Restricted class (tables, finalize write, owner-only reads, lake exclusion, volume
   metric).** *(1 session)*
4. **Acceptance canonicalizer over the Stage 11 lane.** *(0.5 session)* *(parallel with 3)*
5. **Classifier reroute + vendor-SDK import ban.** *(0.5 session)*
6. **(Last) Deploy; §5 production probes + invoice reconciliation week; record results here.**
   *(ops)*

## Progress

**Session 1 (2026-07-06, on main post-28.4; decision #105):**

§8 status — **Tasks 1–5 ALL BUILT green-local; Task 6 (deploy + §5 probes +
invoice week) remains.**

- [x] **Task 3 restricted class** — migration 0072 (`ai_generation_content`,
  `ai_acceptance_events`, feature enum + `workboard-closing`, and
  `ai_usage_events.user_id` DROP NOT NULL: NULL = system lane, the Stage 9
  credit-ledger precedent); finalize dual-writes the generation VERBATIM
  (prompt blocks, completion accumulated in the stream route, params, ALL
  outcomes — a cancelled stream's partial completion is still a fact);
  `generation_ref` = the gateway's existing `requestId` (already on the meta
  frame — assumption 3 verified, nothing added to the envelope); owner-only
  route pair `/api/v1/ai/restricted/generations[/:ref]` (headline test:
  owner 200, team_lead 403, chatter blocked); lake exclusion pinned
  (LAKE_EXCLUDED_TABLES vs TIERED_TABLES test); erasure reach extended (fan
  scope by conversation_ref via generations→acceptance join, page scope by
  page_id); volume guard = `ai_content_rows`/`ai_content_bytes` gauges riding
  the golden-signal sampler with a 5 GB byte threshold on the existing
  incident latch.
- [x] **Task 4 acceptance feed** — projection-sweep pattern (NOT a
  canonicalizer deviation: acceptance rows are a side table, not domain
  events; the pure-parser discipline stays intact). Watermark =
  projection_seq_watermarks with account_id=0 sentinel over OBSERVATION ids;
  tolerant payload mapping (generationRef/requestId, lifecycle/status);
  no-ref and unknown-lifecycle rows counted `skippedNoRef` and left for a
  later replay. Correlation stays best-effort until Stage 31 (assumption 4).
- [x] **Task 2 budgets** — `chatMuseAiGatewayFeatureDailyMicroUsdLimits`
  (EDITABLE JSON map feature→micro-USD; GLOBAL per feature per day — sized
  so scheduled internal lanes fit); breach → typed `QuotaDeniedError`
  (HTTP 429 code `quota_denied`) AND a ledger row (quota_accepted=false,
  gateway_outcome=quota_denied) — denials are ledger facts, not silence.
  The pre-existing daily/request ceilings now use the same taxonomy
  (client-visible change: error code `rate_limit_exceeded` → `quota_denied`
  on gateway quota paths). ORDERING PRESERVED: quota 429 outranks
  provider-unconfigured 503 (reservation rows carry provider NULL until one
  resolves).
- [x] **Task 5 classifier reroute + SDK ban** — `runGatewayCompletion`
  internal lane (services/ai-gateway-internal.ts): reserve → direct-egress
  Anthropic provider (no page proxy — byte-identical egress to the retired
  direct SDK call) → finalize → restricted capture; closing classifier
  same prompts BYTE-FOR-BYTE (SYSTEM_PROMPT constant untouched), same
  model/max_tokens/temperature, spend visible under `workboard-closing`;
  `@anthropic-ai/sdk` import banned repo-wide via no-restricted-imports
  `paths` with the gateway-provider files as the ONE exemption block, plus
  tests/ai-sdk-import-ban.test.ts pinning the importer list. Old direct
  path removed (rollback = git revert, one release window).
- [x] **Task 1 OpenRouter** — fetch-based OpenAI-compatible SSE (NO vendor
  SDK; reuses createAnthropicGatewayProxyFetch so the raw-fetch ratchet
  stays at 13); model-prefix routing (`openrouter:*` →
  aiGatewayOpenrouterProvider, else anthropic) with per-request provider
  stamped on meta/reservation; pricing catalog gpt-4o-mini / gpt-4.1-mini /
  llama-3.3-70b (invoice week trues up); `OPENROUTER_API_KEY` secret
  (NEVER-editable) — unset ships implemented-but-unkeyed as specced.
  Client-lane egress rides the page proxy like Anthropic.
- Also: `POST /api/v1/ai-usage/batch` marked `deprecated: true` in the
  contract (successor = gateway finalize; removal gated on Stage 31 fleet
  cutover); SDK/openapi regenerated.
- [ ] **Task 6 ops** — deploy 0072 + code; §5 production probes (classifier
  nightly spend visible in ledger, restricted round-trip probe, staged
  low-limit budget breach, capture-volume alert live); invoice
  reconciliation week; record here.

GOTCHAS BANKED: zod v4 `z.record` needs BOTH args (single-arg dies in
to-json-schema at contracts:generate); the config-registry pin test counts
runtimeApply classes — NEVER-editable secrets are `none`, not `boot`;
`in ${arr}` drizzle expansion (28.4's lesson) reused throughout.
