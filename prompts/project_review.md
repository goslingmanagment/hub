# Agency Hub Review Prompts

Small prompt set for reviewing this repo. Run from `/Users/dmitriy/code/core`.

Use `01` first. Then run `02-05` as separate review passes if needed. Use `06` only after you choose findings to fix.

## Shared Context

```text
Review Agency Hub for real defects.

Project context:
- TypeScript / ESM / pnpm monorepo.
- Backend: Fastify API, worker, pg-boss, Drizzle, Postgres.
- Frontend: React + Vite dashboard.
- Domain: Fansly/OnlyFans sync, transactions, subscribers, followers, DMs, workboard, health, onboarding, credentials, proxies, sessions.
- Main areas: apps/runtime/src, apps/dashboard/src, packages/db/src, packages/contracts/src, packages/fansly/src, packages/onlyfans/src, packages/shared/src, tests.

Focus on bugs and production risk, not style.

For each real issue, report:
- Severity: P0/P1/P2/P3.
- File and line.
- What breaks.
- How to reproduce or what test should fail.
- Suggested fix direction.

Prefer concrete findings. If something is only suspicious, label it as a follow-up probe.
```

## 01. General Audit

```text
Do a broad first-pass audit of Agency Hub.

Start by understanding the repo structure, package scripts, README, current git status, and the main runtime/dashboard/db/test areas.

Look for the highest-risk issues:
- Data loss or duplicate data during sync.
- API / contract / dashboard drift.
- Auth, session, or role bugs.
- Worker, pg-boss, lease, and sync-run races.
- Money mistakes: cents vs mills, gross vs net, refunds, chargebacks.
- Date, timezone, and business-day mistakes.
- Production startup, migration, Docker, or deploy problems.
- Tests that create false confidence.

Return the top 10-15 findings or follow-up probes.
```

## 02. Backend, Sync, DB

```text
Review backend, sync, and database correctness.

Primary areas:
- apps/runtime/src/services/sync*
- apps/runtime/src/services/sync/*
- apps/runtime/src/worker*.ts
- apps/runtime/src/services/workboard.ts
- apps/runtime/src/services/conversations.ts
- packages/db/src/schema.ts
- packages/db/src/repositories/*
- packages/fansly/src/*
- packages/onlyfans/src/*
- tests related to sync, workers, repositories, and db writes.

Look for:
- Lease fencing bugs or stale worker updates.
- Checkpoints advanced before writes are durable.
- Retry/idempotency bugs.
- Manual blocks or disabled pages bypassed by planner/executor.
- Partial sync failures shown as healthy.
- SQL bugs: missing page/platform filters, unstable pagination, unsafe raw SQL.
- Missing constraints or indexes needed for upserts.
- Transaction cleanup deleting valid history.
- Fan identity collisions across pages/platforms.
- DM last-message, unread, or sender-role inconsistencies.

For race conditions, describe the interleaving briefly.
```

## 03. Security, Auth, Secrets

```text
Review security, auth, and secret handling.

Primary areas:
- apps/runtime/src/api/server.ts
- apps/runtime/src/services/auth.ts
- apps/runtime/src/services/page-onboarding.ts
- apps/runtime/src/services/page-context.ts
- apps/runtime/src/services/page-proxies.ts
- apps/runtime/src/services/health.ts
- packages/shared/src/crypto.ts
- packages/shared/src/config.ts
- packages/shared/src/logger.ts
- packages/contracts/src/routes.ts
- dashboard login/settings pages
- auth, redaction, and route-security tests.

Look for:
- Routes missing required auth or role checks.
- API-key permissions differing from session permissions.
- Cookie/session TTL/logout/secure/sameSite issues.
- Missing rate limits on sensitive actions.
- Credentials, proxy auth, sessions, or tokens leaked in logs, traces, errors, DB fields, or UI.
- Encryption key rotation bugs.
- Health/docs endpoints exposing too much.
- Stored XSS through notes, profiles, summaries, messages, or markdown.
- SSRF or proxy misuse through user-provided proxy URLs.
```

## 04. Frontend and Contracts

```text
Review dashboard correctness and API contract drift.

Primary areas:
- apps/dashboard/src/api/*
- apps/dashboard/src/pages/*
- apps/dashboard/src/stores/*
- apps/dashboard/src/lib/*
- packages/contracts/src/routes.ts
- packages/contracts/src/generated/api-types.ts
- apps/runtime/src/api/server.ts
- dashboard, workboard, and API integration tests.

Look for:
- Runtime responses that do not match zod schemas or generated types.
- Dashboard code assuming wrong optional/required fields.
- Enum drift: roles, platforms, sync states, transaction types.
- React Query cache invalidation bugs after mutations.
- Stale data after switching page/model/filter.
- Pagination, filter, or sort bugs.
- UI actions mutating the wrong fan/page after refetch.
- Money/date formatting bugs.
- Missing error/loading states that show stale or false data.
- Workboard fans disappearing because of filters, snooze logic, or null dates.
```

## 05. Tests and Production Readiness

```text
Review tests and production readiness.

Primary areas:
- tests/*
- vitest.config.ts
- package.json scripts
- tests/helpers/*
- Dockerfile
- docker-compose*.yml
- scripts/*
- README.md
- apps/runtime/src/startup.ts
- apps/runtime/src/bootstrap.ts
- packages/shared/src/config.ts
- packages/db/src/migrate-runner.ts

Look for:
- Critical paths without tests.
- Tests that pass while the production path can still be broken.
- Flaky tests from timers, real time, DB state, network, or ports.
- Test scripts excluding important coverage.
- Docker image missing runtime files or dashboard assets.
- API/worker startup or migration races.
- Unsafe production defaults.
- Healthchecks that go green too early.
- Secrets exposed in scripts, docs, command args, or logs.
- Deploy scripts that can leave a partial broken stack.

Return concrete findings plus a short prioritized test/check backlog.
```

## 06. Fix Selected Findings

```text
Fix the selected Agency Hub findings.

Before editing:
- Read the finding, relevant code, and nearby tests.
- Check current git status.
- Do not revert unrelated user changes.

Fix requirements:
- Address the root cause.
- Add or update a regression test when practical.
- Keep the change local and consistent with existing patterns.
- Run targeted tests; run typecheck if practical.

Final response:
- What changed.
- Tests/checks run.
- Remaining risk, if any.
```
