# Runbook: deploying the unified chatter account (Decisions 349 and 353)

One wave, four owner-gated steps: the kernel first, then the console and the
cabinet, then the clients, then the removal of the legacy lanes. Sections 1–5
cover the kernel deploy (PR-1A), whose only real risk is a single migration that
can fail on production data. **Section 6 covers PR-4 (Decision 353), whose risk
is the opposite kind: no migration at all, and three preconditions on data that
are cheap to check and expensive to skip.**

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
   removes the legacy lane — see §6, which gates on more than the fleet.

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

## 6. PR-4 — removing the legacy lanes (Decision 353)

PR-4 deletes the api-key lane, the cookie token-issuance routes and
`must_change_password`. **No migration ships with it**, which is the whole
safety story: the `api_keys` table, the `must_change_password` column and the
`content_manager` enum value all stay, so **rolling the image back is safe at
any moment and needs no database work.** The risk lives entirely in production
*data* that the new code refuses to serve.

Every query below runs under the **app** psql user on `agency_hub_core` — the
`read_only` role cannot see these tables.

### 6.1 Preconditions — all four, BEFORE the deploy

**(a) Zero `content_manager` rows, deactivated ones included.**

```sql
-- must return 0
select count(*) from users where role = 'content_manager';
```

Deliberately NOT filtered by `disabled_at`: `listUsers` does not filter either,
so `GET /api/v1/admin/users` serializes every row, deactivated test accounts
among them. One surviving row — even a long-dead test user nobody thinks about —
fails response validation and answers 500, and the whole «Команда» tab goes dark
with it. Rename the role of any row that turns up (`update users set role =
'chatter' …` after deciding what the account actually is) before deploying.

**(b) Zero accounts carrying the retired flag.**

```sql
-- must return 0
select count(*) from users where must_change_password;
```

The flag stops being enforced in PR-4. A flagged account would silently become
an ordinary one, which is a security change nobody reviewed — clear the flag by
deciding each case first (reset the password by link, or clear the column).

**(c) The fleet has crossed to password sign-in.**

```sql
select user_id, label, last_client_version, last_used_at
from device_tokens
where revoked_at is null and expires_at > now()
order by last_client_version nulls first, user_id;
```

Every row must report extension ≥ 2.4.0 or desktop ≥ 0.1.55, **Mac installs
included** — macOS does not auto-update (unsigned Squirrel), its DMG is
published by hand, so a Mac is the likeliest row to lag. A `null` version means
that device has not spoken since the column landed: chase it, do not merge past
it. What breaks for an un-crossed client is precisely one thing — a NEW sign-in
through a cookie route. Tokens already issued keep working either way.

**(d) No hidden consumer of a legacy API key.** *(This is the precondition the
fleet query cannot answer.)*

```sql
select user_id, key_prefix, last_used_at
from api_keys
where revoked_at is null
order by last_used_at desc nulls last;
```

A client, script or cron that authenticates **only** by api key has no row in
`device_tokens` at all, so §6.1(c) is blind to it. Expected result: one row,
`Dmitriy`, with `last_used_at` older than a week. Then:

1. The owner **revokes that key before the PR-4 deploy** — `hub apikey revoke
   --username Dmitriy` on the pre-PR-4 image, or the console.
2. **Wait one full day** and watch for 401s and for anything that starts
   complaining.

Do this while the lane still exists: a 401 from a live-but-revoked key is
diagnosable and leaves a trail (`api_keys.last_used_at`, the audit row). After
PR-4 the same request is refused by prefix with no lookup, no reason and no
trace — a consumer that surfaces then looks like an unrelated outage. If any row
other than `Dmitriy` appears, or `last_used_at` is recent, **stop**: something is
using the lane and needs its own account with a device token (or an agent key,
#195) before PR-4 can go anywhere.

### 6.2 Deploy and the verification window

The deploy itself is ordinary (`scripts/deploy-production.sh`, owner-gated).
What to check afterwards:

- `/health` reports the new `contractHash`. Both clients keep working on the
  device tokens they already hold — **no re-login for anyone**.
- A signed-in chatter's `/auth/me` still answers 200, and
  `user.mustChangePassword` is `false`.
- «Команда» in the console lists every person (this is the §6.1(a) gate paying
  off) and a person's card shows their devices.
- A device sign-in works end to end: `POST /api/v1/auth/device-tokens/password`
  with a real password answers 200 in `active` mode.
- The retired paths answer **404**, not 401 or 500:
  `POST /api/v1/admin/users` · `PATCH /api/v1/admin/users/<login>/password` ·
  `GET|POST|DELETE /api/v1/admin/users/<login>/api-keys` ·
  `POST /api/v1/auth/device-tokens` · `POST /api/v1/auth/device-tokens/reservations` ·
  `POST /api/v1/admin/users/<login>/device-tokens`.
- A bearer with the old `agency_hub_core_` prefix answers 401 with **no**
  `reason` in the body.

### 6.3 Rollback

**Safe and boring: re-tag the previous image and `docker compose up -d
--force-recreate`.** PR-4 adds no migration, so there is no schema delta to
consider and nothing in `ROLLBACK_COMPATIBLE_MIGRATIONS` to check. The old image
finds every table, column and enum value exactly where it left them — including
the `api_keys` rows, which were never deleted. The only thing that does not come
back by itself is a key the owner revoked in §6.1(d); issue a fresh one.

### 6.4 After the deploy: the clients' release gate

Both client release scripts compare the production contract hash with their
**vendored** one and refuse to publish when they differ. PR-4 rotates the hash,
so from the moment it deploys until each client re-vendors
(`node scripts/vendor-sdk.mjs …`) and ships, **no client release can go out —
including a hotfix**. Plan the deploy for a window where neither client has an
urgent release pending, or re-vendor both repos first.
