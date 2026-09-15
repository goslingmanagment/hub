# Offboarding a chatter

What to do when someone stops working with the agency, in the order that closes
the most access soonest, and — just as important — what the hub **cannot** close
for you.

Rights model behind every step: `docs/identity-rights-matrix.md`. Onboarding and
the day-to-day link operations: `docs/runbooks/chatter-onboarding.md`.

The console card ("Настройки → Команда → карточка человека") is PR-1B. Until it
ships, each step names the route behind the button; owner cookie session
required for all of them.

## The ladder, and why the order matters

Four operations exist and they are not interchangeable. Picking the wrong one is
the classic offboarding mistake:

| Operation | Kills | Leaves alive |
|---|---|---|
| **«Отозвать вход»** | one device token | every other sign-in |
| **«Отозвать все устройства»** | every device token and reservation | **the cookie session** |
| **«Завершить все входы»** | device tokens, reservations, sessions, active links | the password — a fresh login still works |
| **Деактивировать** | all of the above, permanently | nothing; the account cannot sign in at all |

For an actual departure you need the last two, in that order.

## Steps

1. **«Завершить все входы»** — `POST /api/v1/admin/users/<login>/terminate-access`.
   Every device token, reservation, cookie session and unused invite or reset
   link of that person dies at once, and the device-token epoch advances.
   The password is untouched on purpose: this operation is also the one you use
   for a suspected leak, where the person keeps working.

2. **Деактивировать** — `POST /api/v1/admin/users/<login>/deactivate`.
   The account is tombstoned (`disabled_at`; nothing is ever deleted — DP 7).
   From here on both sign-in lanes refuse with the same answer they give for a
   login that never existed, so a former chatter learns nothing about whether
   their account still exists. Assignments, passwords and links are frozen: they
   cannot be re-opened without reactivating first.

   Deactivation alone would have covered step 1, but running step 1 first means
   access is gone the moment you click it, even if step 2 waits for a
   conversation.

3. **Manual — sign out of Fansly in their Firefox.** The hub does not own that
   session and cannot end it. If the machine stays with the agency, open the
   profile and sign out; if it goes with the person, change the page's Fansly
   password.

4. **Manual — platform passwords.** Change the passwords of any page the person
   worked on if they ever saw them, and rotate anything they had out of band.

5. **Wait up to 60 seconds for open streams.** A stream that was already running
   re-checks authorisation on a 60-second tick and closes itself; it is not cut
   the instant you click. Nothing new can be started in the meantime — every
   fresh request is already refused.

6. **The local cache stays on the machine.** The desktop app's SQLite database
   and the extension's stored data are not reachable from the hub. The app hides
   them (the granted-pages snapshot is bound to the identity that fetched it),
   but the file is erased only by running a purge on that machine (D23 of the
   desktop repo, #145). If the machine is not coming back, treat the data as
   still being on it.

## What the person sees

Vocabulary is fixed by §2 of the plan: people know a login, a password and their
devices. The words "token", "key" and "API" never appear on their screen.

| After | In the extension / the desktop app | In the browser |
|---|---|---|
| «Отозвать вход» (that device) | «Сессия на этом устройстве завершена, войдите снова» — the sign-in screen; the client wipes its own stored sign-in | unchanged |
| «Отозвать все устройства» | the same, on every device | **still signed in** — the cabinet still opens |
| «Завершить все входы» | the same, on every device | signed out; the next page load asks for the password, which still works |
| Деактивировать | the same, and signing in again fails with «Неверный логин или пароль» | the same |

An already open stream keeps delivering for up to 60 seconds after the
revocation before it closes — expect that gap rather than treating it as a bug.

## Verifying it took

- The person's card shows no devices, and `GET /api/v1/admin/users` shows
  `disabledAt` set.
- `GET /api/v1/auth/me` with anything they held answers 401 (`token_revoked` for
  a device token that still matched a row).
- `POST /api/v1/auth/login` with their password answers 401.

All of this is pinned by `tests/rights-matrix.integration.test.ts`
(*row «terminated all access»*, *row «deactivated»*) and
`tests/user-deactivation.integration.test.ts`.

## If they come back

Reactivation (`POST /api/v1/admin/users/<login>/reactivate`) restores password
login and nothing else: every revoked credential stays revoked and links are not
revived. Re-assign pages, then send a fresh reset link
(`docs/runbooks/chatter-onboarding.md`).

## Dormant accounts nobody offboarded (census, Decision 353)

Deactivation is an event; an account nobody ever decided about is a slow leak.
The 2026-09-15 census found three, and they are listed here rather than fixed in
code because each one is a judgement about a person, not a migration:

- **`probe-ops` (#16)** — a live test account with no credentials. Deactivate it;
  a robot that needs to read production gets an agent key (#195), and one that
  needs to act gets its own account and signs a device in by password.
- **User #22** — holds page grants on `lora-of` and `lora-vip-of` and does
  nothing with them. Unassign the pages, then deactivate.
- **User #4** — created and never acted. Deactivate it or write down why it
  exists.

Re-run the census when the team changes shape. Two queries, under the app psql
user (the `read_only` role does not see these tables):

```sql
-- accounts with no live credential and no recent activity
select u.id, u.username, u.role, u.disabled_at,
       max(d.last_used_at) as last_device_use
from users u
left join device_tokens d on d.user_id = u.id
group by u.id
order by last_device_use nulls first;

-- page grants held by accounts that are not signing in
select u.username, p.platform, p.label
from user_page_assignments a
join users u on u.id = a.user_id
join pages p on p.id = a.platform_account_id
order by 1, 2, 3;
```
