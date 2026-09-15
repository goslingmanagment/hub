# User account identity, deletion and login reuse

Decision 354; implementation follows the owner-authorized account lifecycle
rework. This is account removal, not erasure of historical business facts.

## Identity and lifecycle

- `users.id` is immutable and never reused. Every administrative operation,
  service mutation, Team modal target and per-user cache key uses that ID.
- Username remains the case-insensitive sign-in/create/search handle.
- An enabled or disabled account reserves its login. Disabling retains its
  password and grants for explicit restoration; all old credentials/links stay
  revoked when it returns.
- Deletion permanently marks `deleted_at`, clears the password and revokes
  credentials, pending reservations and account links under the user lock.
  Active page/model grants are stamped revoked, and the legacy assignment
  projection is cleared. The old row and historical attribution survive.
  The account cannot be
  restored or receive new credentials. New creation with the same login gets
  a different ID and no inherited role, grants, credentials or links.
- Migration 0201 replaces both unconditional username uniqueness constraints
  with a unique case-folded index over `deleted_at IS NULL`. Lookup by login
  excludes deleted accounts. Historical joins continue to use user IDs.

## Administrative API and CLI

The current routes are `/api/v1/admin/users/by-id/:userId/...`; permanent
removal is `DELETE /api/v1/admin/users/by-id/:userId`. IDs must be positive safe
integers. Username-targeted routes are removed and return 404. They are never
aliases to the current holder of a reused login. The `by-id` segment prevents
an old numeric login such as `42` from being interpreted as user ID 42.

SDK 0.3 records the breaking administrative-address change. The operation
names in the generated SDK stay familiar, but their parameters
are `userId`. The dashboard is built with this SDK in the same release. Login,
self-service sessions/devices and invitation redemption keep their existing
routes; extension and desktop code do not call the changed admin operations.
Installed clients do not gate these flows on the global contract hash. Their
publication gates do require an exact match: before the next extension/Desktop
release, re-vendor this SDK against the deployed Core and run the client release
checks. A stale vendor can keep working at runtime while correctly failing the
publication gate.

CLI example (local command examples; production remains owner-gated):

```sh
pnpm cli user list
pnpm cli user deactivate --user-id 42
pnpm cli user reactivate --user-id 42
pnpm cli user delete --user-id 42 --confirm-user-id 42
```

`user set-password`, `assign-page`, `unassign-page` and per-user `api-key`
commands also require `--user-id`. Creation continues to take `--username`.
Old scripts passing `--username` to target an account fail instead of resolving
that name to a replacement person. CLI actor attribution also uses IDs:
`ai:feature-smoke` and `agent hydration decide` take `--as-user-id`; `erasure:run`
takes `--initiated-by-user-id`. Actor selection requires an active account
with the appropriate role.

## Release and recovery

Apply the migration and deploy the matching API/dashboard as one release.
An old dashboard tab must refresh when its retired route returns 404. Do not
restore username-based routes for compatibility: that would recreate the old
card/new person race.

Once deletion or login reuse has occurred, an older binary with unfiltered
username lookup is not a valid rollback. Fix forward; preserve the migration
and ID-only routes. A rollback rehearsal must not silently restore the old
unconditional username constraint or merge two historical identities. Deleted
rows also retain `disabled_at`; the database rejects clearing it or restoring
a password, preserving the older authentication barrier as defense in depth.

The prior login-first extension changes are separate commits and remain
applicable; account deletion revokes its current sign-in through the existing
revocation contract. Publishing or changing a real account is a separate
owner-authorized production operation.

## Required regression evidence

1. Open old account A, delete it, create B with the same normalized login.
2. Old A card/cache/queued requests cannot read or mutate B; old ID operations
   and old username routes fail. Include numeric usernames.
3. A's sessions, API keys, device tokens, pending reservations, invite and
   password-reset links remain unusable. B's credentials still work.
4. B inherits no pages/model grants or history; A's audit/spend attribution
   remains attached to A's ID and reports do not group solely by username.
5. Deletion races with issuance, link redemption, grant changes and restoration
   serialize on the same identity lock. No access can be created after deletion.
6. Owner/self deletion is refused; disabled account restoration still works.
7. Run contracts generation, the full unit/build gate, affected database suites
   and browser checks of delete/cancel/recreate/stale-card behavior.
8. Concurrent grants whose actor references another locked user must both
   commit; the common lifecycle lock is `FOR NO KEY UPDATE`, compatible with
   actor foreign-key checks. Preserve the deletion/issuance serialization tests.
9. Drop the DELETE response after commit: the console refreshes its account
   list, retires the old card and permits reinvitation of the freed login.
   If the deletion or subsequent refresh fails, preserve the error and do not
   optimistically remove an account whose absence has not been confirmed.
10. Upgrade a populated pre-0201 database: preserve user/password/session data,
    keep disabled logins reserved, and reject restoration/renaming of a deleted
    identity while permitting a different ID to use the released login.

## Local verification recorded 2026-09-15

- Contract/SDK generation passed. Full `pnpm check`: 349 unit suites,
  **4118 passed / 9 skipped**, ESLint and dashboard production build passed.
  The repository strictness ratchet passed without new debt; root TypeScript
  still has 1893 accepted pre-existing errors in 120 files.
- **29 PostgreSQL/schema suites / 577 tests passed, zero skips**, including
  every changed integration suite and `tests/schema-guard.test.ts`.
  `ALLOW_MISSING_TEST_PREREQUISITES=0` prohibited prerequisite skips.
- `tests/user-identity-reuse.integration.test.ts`: 14 cases covering normal
  lifecycle, credentials, ID/history isolation, old numeric-name routes,
  owner/self refusal, audit rollback and ten deterministic row-lock races.
- Actual dashboard browser QA against a disposable local HTTP fixture: cancel
  emitted no deletion; confirm emitted only `DELETE .../by-id/17`; a subsequent
  Nikita invitation created ID 29; the still-open ID 17 card showed
  "Участник больше недоступен". The new card required explicit selection.
- Independent backend and UI review completed. No production account, server,
  installed client or release artifact was changed by this local work.

## Adversarial follow-up verification (Decision 355)

- Reproduced and fixed cross-user grant/audit FK deadlock (`40P01`) and stale
  account state after an indeterminate DELETE response. Both new regressions
  failed against `ed4469c1` before the fixes.
- Final `pnpm check`: **349 unit suites / 4123 passed / 9 existing skips**;
  ESLint, strictness ratchet (unchanged debt) and dashboard build passed.
- **31 affected PostgreSQL/schema suites / 586 passed / zero skips** with
  missing prerequisites forbidden. Includes populated 0200-to-0201 upgrade.
- Browser verified severed DELETE response, automatic old-card retirement and
  immediately available same-login invitation. Only synthetic local data used.
- Independent source reviews of both follow-up fixes found no new issues.
  Evidence and screenshots: `output/adversarial-review/README.md`.
