# Runbook: deploying the unified chatter account (Decision 347)

One wave, three owner-gated steps: the kernel first, then the console and the
cabinet, then the clients. This runbook covers the kernel deploy (PR-1A), whose
only real risk is a single migration that can fail on production data.

## 1. Precondition — run BEFORE the deploy

Migration `0200_users_username_lower_uidx.sql` adds a unique index on
`lower(username)`. It fails if two accounts already differ only in case.

```sql
-- must return ZERO rows (app user or superuser; the read_only role cannot see users)
select lower(username), count(*)
from users
group by 1
having count(*) > 1;
```

- **Zero rows** → proceed.
- **Any rows** → rename one of each colliding pair first (dashboard → the person's
  card, or the CLI `user` group). Renaming is a normal update; nothing else in
  the system keys off the spelling. Then re-run the query and proceed.

Nothing else gates this deploy: `0199_account_links.sql` (new `account_links`
table, new nullable `device_tokens.last_client_version`) cannot fail on data.

## 2. If 0200 fails anyway

Startup owns migration, so the failure happens after the old container is gone.
What the system does by itself:

- `0199` committed and is in `schema_migrations`; `0200` rolled back with its own
  transaction and is NOT in the ledger — the migration runner applies each file
  in a transaction, so there is no half-applied index.
- Both files are listed in `ROLLBACK_COMPATIBLE_MIGRATIONS`
  (`scripts/deploy-production.sh`), so the schema delta does not disable
  automatic rollback: **the deploy script restores the previous image on its
  own** and production comes back on the old code. The `account_links` table and
  the new column simply sit unused — the old image never reads them.

What is left for a human: rename the colliding login (query above), then re-run
the deploy. No manual database surgery, and nothing to undo — the additive
objects from `0199` are exactly what the retry needs anyway.

If automatic rollback was skipped for an unrelated reason (the log says which),
the manual equivalent is the ordinary one: re-tag the previous image and
`docker compose up -d --force-recreate`. The additive schema stays; it is
compatible with both images.

## 3. Order of the wave

1. **PR-1A (kernel)** → deploy → verification window (below).
2. **PR-1B + PR-1C** (console "Команда", `/join`, `/account`) → deploy →
   a trial invite end to end.
3. **PR-E1 / PR-D1** (extension and desktop releases), in either order, only
   after step 2: their release gates compare the production contract hash with
   the vendored one.
4. All five people on new clients (check `last_client_version`) → **PR-4**
   removes the legacy lane.

## 4. Verification window after the kernel deploy

The point of this window is that NOTHING old broke — every new route is additive.

- Old clients keep working unchanged: extension 2.2.2 and desktop 0.1.54 sign in
  exactly as before (`login`, `authIssueDeviceToken`, `authReserveDeviceToken`,
  `authActivateDeviceToken` are untouched).
- `/health` reports the new `contractHash`.
- A junk token on `POST /api/v1/auth/links/inspect` answers `404` — the public
  link lane is alive and discloses nothing.
- A wrong password on `POST /api/v1/auth/device-tokens/password` answers `401`
  and writes an `auth.login_failed` audit row (same lane as cookie login).
- `select count(*) from account_links` is 0 until the owner creates the first
  invite. Nothing back-fills it.

## 5. Kill switch

`ACCOUNT_LINKS_ENABLED` (live, editable in the console, no restart) turns the
**public link pages** off: `/auth/links/inspect` and `/auth/links/redeem` answer
404 while the owner can still create links. It deliberately does NOT gate the
password sign-in route — that is the clients' only way in after PR-E1/PR-D1, and
turning it off would lock the whole fleet out. Sign-in is bounded by its per-IP
rate limit (20/min) and the per-account backoff instead.
