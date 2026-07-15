> Generated 2026-07-15 from docs/generated/REGENERATION-PROMPT.md at commit 7df9a45.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Tests and Fixtures

At this commit `tests` contains 250 `*.test.ts` files: 91 use the
`*.integration.test.ts` suffix and 159 do not. The suite covers runtime
services and modules, HTTP contracts, database migrations and repositories,
platform adapters, projection rebuilds, policy ratchets, dashboard code, and
generated artifacts.

## Vitest configuration

The root `vitest.config.ts` runs in the Node environment and includes
`tests/**/*.test.ts`. Hook and test timeout are both 30 seconds, sourced from
`tests/helpers/timeouts.ts`; coverage reporters are text and lcov.

Aliases point workspace imports at source, including contracts, SDK, shared,
database, Fansly, and dashboard `@/` imports. The configuration also names
`packages/onlyfans/src/index.ts` for `@agency_hub_core/onlyfans`, but that target
path is absent at this commit. React packages resolve from the dashboard
installation so component tests use one React instance.

## Test helpers

`tests/helpers/db.ts` starts a Postgres 16 Testcontainers instance, waits for
queries to succeed, and applies checked-in SQL migrations. It supports a
bounded migration range, including migrations explicitly marked as
non-transactional. Its reset helper removes the pg-boss schema and truncates
public tables while retaining `schema_migrations` and the seeded `platforms`
vocabulary. It also provides a standard encrypted Fansly page fixture.

`tests/helpers/prerequisites.ts` makes missing external prerequisites fail the
test by default. Setting `ALLOW_MISSING_TEST_PREREQUISITES=1` changes that
behavior to an explicit warning and skip.

Other shared harnesses are:

| Helper | Role |
|---|---|
| `tests/helpers/runtime.ts` | runtime application and route setup |
| `tests/helpers/adapter-harness.ts` | platform-adapter conformance inputs |
| `tests/helpers/ai-parity.ts` | prompt assembly comparison with the sibling desktop snapshot |
| `tests/helpers/network.ts` | local network test utilities |
| `tests/helpers/timeouts.ts` | shared 30-second integration timeout |

## Fixtures and supporting artifacts

`tests/fixtures/ofapi-webhooks` contains 12 JSON examples plus a README. The
examples cover sent, received, deleted, and PPV-unlocked messages;
subscriptions; tips; transactions; online/offline/typing presence; and
unverified renewal and tip events.

`tests/audit-artifacts/money-prop-test.ts` and
`tests/audit-artifacts/sse-b3-sim.ts` are supporting programs rather than
Vitest-discovered test files.

Most integration data is assembled directly in test setup through repository
calls and SQL; there is no larger checked-in fixture tree outside the OFAPI
webhook samples.

## Structural and policy tests

Several tests enforce source and generated-artifact boundaries in addition to
behavior:

- `tests/platform-registry.test.ts`,
  `tests/egress-resolver.integration.test.ts`, and
  `tests/money-ratchet.test.ts` execute or reproduce the platform-branch,
  raw-fetch, and money-float budgets;
- `tests/retention-deleters.test.ts` pins files containing SQL-delete syntax;
- `tests/ai-sdk-import-ban.test.ts` pins the sole vendor AI SDK importer;
- `tests/dashboard-sdk-ban.test.ts` pins the dashboard's generated-SDK access
  boundary;
- `tests/contracts-auth-declarations.test.ts`,
  `tests/contracts-route-security.test.ts`, and
  `tests/contracts-spender-validation.test.ts` check route policy metadata;
- `tests/contracts-generation-gate.test.ts` and SDK tests compare generated
  contract artifacts and runtime behavior;
- `tests/ai-feature-parity.test.ts` compares assembled prompts with the sibling
  desktop snapshot when that repository is available, while
  `tests/ai-prompts-templates-sync.test.ts` pins Markdown templates to exported
  prompt constants;
- `tests/schema-guard.test.ts` and `tests/migration-invariants.test.ts` inspect
  database shape and migration rules.

The suite also contains database-backed rebuild and non-resurrection coverage
for message archives, earnings, OFAPI DM state, tiering, and erasure.

## Root test commands

| Command | Selection |
|---|---|
| `pnpm test` | all files selected by Vitest, with an 8 GiB Node heap limit |
| `pnpm test:unit` | excludes integration-suffixed files plus schema, HTTP-client, and network prerequisite tests |
| `pnpm test:sync-critical:db` | integration files except the large API file, plus schema, HTTP-client, and network tests; file parallelism disabled |
| `pnpm test:sync-critical:api` | only tests tagged `[sync-critical]` inside `tests/api.integration.test.ts`; file parallelism disabled |
| `pnpm test:prerequisites` | alias for the two-part sync-critical suite |
| `pnpm check` | typecheck ratchet, ESLint, unit tests, and dashboard build |

The pull-request workflow runs unit and sync-critical selections. The nightly
workflow runs `pnpm test`, which is the full Vitest selection.
