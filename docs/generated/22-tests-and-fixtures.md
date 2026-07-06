> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Tests & Fixtures (`tests/`)

The root test suite: ~205 `tests/*.test.ts` files, of which ~70 are
`*.integration.test.ts` that run against a Testcontainers Postgres 16 (the
remaining ~135 are unit tests). Integration tests need Docker Desktop and run
nightly; PR/push CI runs a unit + sync-critical subset. Several ratchets and
policy pins execute as tests inside the suite. This map covers the harness,
fixtures, the ratchet/pin tests, and the package.json test-script variants.

## Layout / counts

- 205 `tests/*.test.ts` files (`ls tests/*.test.ts | wc -l`); 70 are
  `*.integration.test.ts` (Testcontainers/Postgres); ~135 are unit tests.
  Largest files: `api.integration.test.ts` (~301KB), `sync-handlers.test.ts`
  (~117KB), `db-write.integration.test.ts` (~89KB),
  `ofapi-spend-transaction-ingest.integration.test.ts` (~49KB),
  `fansly-transactions.test.ts` (~45KB).
- Subdirs: `tests/helpers/`, `tests/fixtures/`, `tests/audit-artifacts/`.

## Harness (`tests/helpers/`)

- `db.ts` — Testcontainers `GenericContainer("postgres:16")` (DB `testdb`,
  user/pass `postgres`). Exposes `startTestDatabase` (applies migrations from
  `packages/db/migrations`), `startIntegrationTestDatabase` (wraps it via
  `acquireTestPrerequisite`, skipping when Docker is absent),
  `resetIntegrationDatabase` (truncates every table except `schema_migrations`
  and `platforms`), `applyTestMigrations` (per-file transaction), and
  `seedFanslyPage`.
- `runtime.ts` (~8.6KB) — the runtime/app test harness.
- `ai-parity.ts` — Stage 30 prompt-parity harness (compares assembled prompts
  against the sibling desktop repo).
- `adapter-harness.ts`, `network.ts`, `prerequisites.ts`
  (`acquireTestPrerequisite`), `timeouts.ts`
  (`INTEGRATION_TEST_TIMEOUT_MS = 30_000`).
- `vitest.config.ts` (root) — `environment: "node"`,
  `include: ["tests/**/*.test.ts"]`, hook/test timeout 30s, coverage text + lcov.
  Aliases resolve the workspace packages plus the dashboard `@/` alias and React
  (to `apps/dashboard/node_modules`).

## Fixtures / audit-artifacts

- `tests/fixtures/ofapi-webhooks/` — 13 files: JSON webhook samples
  (messages_sent / received / deleted / ppv_unlocked, subscriptions_new,
  tips_received, transactions_new, unverified_* and others) plus a README.
- `tests/audit-artifacts/` — `money-prop-test.ts` (a property test) and
  `sse-b3-sim.ts` (an SSE simulation) — support artifacts, not `.test.ts` files.

## Ratchet / pin tests (execute scripts or pin allowlists inside the suite)

| Test file | Stage | What it pins |
|---|---|---|
| `tests/platform-registry.test.ts:80` | 18 | Runs `scripts/check-platform-branches.mjs`, asserts the budget output |
| `tests/egress-resolver.integration.test.ts:218` | 26 | Runs `scripts/check-raw-fetch.mjs`, asserts the budget output |
| `tests/money-ratchet.test.ts` | 27 | Inlines the grep against `money-float-budget.json` (no separate script) |
| `tests/retention-deleters.test.ts` | 28 | Deleter allowlist pin (`SANCTIONED_DELETER_FILES` enumerates every file issuing a SQL delete; scheduled deleters listed in the header) |
| `tests/ai-sdk-import-ban.test.ts` | 29 | Only `ai-gateway-anthropic-provider.ts` may import `@anthropic-ai/sdk` |
| `tests/dashboard-sdk-ban.test.ts` | 20 | No direct `fetch(` / hand-rolled client in `apps/dashboard/src/api` |
| `tests/contracts-auth-declarations.test.ts` | 19 | Every `routeSchemas` entry declares a valid `auth` policy |
| `tests/contracts-route-security.test.ts`, `tests/contracts-spender-validation.test.ts` | 19 | Route-security + spender-validation contract pins |
| `tests/ai-feature-parity.test.ts` | 30 | Freeze guard: assembled prompts byte-identical to the frozen desktop snapshot (≥9 fixtures; skips if the sibling repo is absent; authoritative run = `scripts/ai-parity-signoff.ts`) |
| `tests/ai-prompts-templates-sync.test.ts` | 30 | Markdown template files must match the exported constants |
| `tests/client-versions.test.ts` | 4 | Fleet-verify pin |
| `tests/schema-guard.test.ts`, `tests/migration-invariants.test.ts` | — | Schema pins |

## package.json test-script variants

| Script | What it runs |
|---|---|
| `test` | `vitest run` (everything), `NODE_OPTIONS=--max-old-space-size=8192` |
| `test:unit` | `vitest run` excluding `tests/**/*.integration.test.ts`, `tests/schema-guard.test.ts`, `tests/http-client.test.ts`, `tests/network.test.ts` (the Docker/network-dependent files) |
| `test:prerequisites` | → `test:sync-critical` → `test:sync-critical:db` + `test:sync-critical:api` |
| `test:sync-critical:db` | `vitest run --no-file-parallelism` on `tests/*.integration.test.ts` + schema-guard + http-client + network, excluding `api.integration.test.ts` |
| `test:sync-critical:api` | `api.integration.test.ts` only, `--testNamePattern "\[sync-critical\]"` (19 tagged tests in that file) |
| `typecheck` | The strictness ratchet script (`scripts/check-strictness-ratchet.mjs`) |
| `typecheck:tsc` | Raw `tsc --noEmit` |
| `typecheck:ratchet-update` | Ratchet `--update` (rewrites the snapshot) |
| `lint` | `eslint .` |
| `check` | typecheck + lint + test:unit + dashboard build |

## Notes

- Only two GitHub workflows exist (`ci.yml`, `nightly.yml`); there are no other
  `.github/workflows/*`. The nightly job is the Testcontainers backstop
  (`pnpm test`); PR/push CI runs `test:unit` + `test:prerequisites`.
