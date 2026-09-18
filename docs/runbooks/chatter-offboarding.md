# Offboarding a chatter

What to do when someone stops working with the agency, in the order that closes
the most access soonest, and — just as important — what the hub **cannot** close
for you.

Rights model behind every step: `docs/identity-rights-matrix.md`. Onboarding and
the day-to-day link operations: `docs/runbooks/chatter-onboarding.md`.

The console card is "Настройки → Команда → карточка человека". Every account
action uses its immutable ID, not its login. An owner cookie session is
required. See [account deletion](user-account-deletion.md) for lifecycle and
compatibility details.

## The ladder, and why the order matters

Five operations exist and they are not interchangeable. Picking the wrong one is
the classic offboarding mistake:

| Operation | Kills | Leaves alive |
|---|---|---|
| **«Отозвать вход»** | one device token | every other sign-in |
| **«Отозвать все устройства»** | every device token and reservation | **the cookie session and the legacy API key** |
| **«Завершить все входы»** | device tokens, reservations, sessions, API keys, active links | the password — a fresh login still works |
| **«Отключить доступ»** | all of the above; login blocked until explicitly restored | identity, history, saved role and page assignments |
| **«Удалить аккаунт»** | every sign-in and link; password removed; account cannot be restored | immutable historical attribution; login becomes free |

Choose **disable** when the same account may return, or **delete** when removing
the account permanently. Both close all Hub sign-ins themselves. Use
«Завершить все входы» separately when the person keeps working.

## Steps

1. **Choose account removal or temporary disable.**
   - **«Отключить доступ»** — `POST /api/v1/admin/users/by-id/<userId>/deactivate`.
     Sign-ins and links are revoked, the account is disabled, and its login
     remains reserved. Role, password and page assignments remain for explicit
     restoration of the same account.
   - **«Удалить аккаунт»** — `DELETE /api/v1/admin/users/by-id/<userId>`.
     All sign-ins and links are revoked, the password is cleared and the login
     becomes free. A later invitation creates a different account. Historical
     attribution survives, and the old account cannot be restored.

2. **Confirm the intended person and complete the operation.** The card binds
   the action to the immutable user ID. Deletion requires a separate permanent
   deletion confirmation. There is no need to terminate sign-ins first; both
   operations do that atomically themselves.

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
| «Отключить доступ» | the same, and signing in again fails with «Неверный логин или пароль» | the same |
| «Удалить аккаунт» | the old sign-ins stop working; a reused login belongs to a new account | the old session cannot access the new account |

An already open stream keeps delivering for up to 60 seconds after the
revocation before it closes — expect that gap rather than treating it as a bug.

## Verifying it took

- After disabling, the card has no active sign-ins and `GET /api/v1/admin/users`
  shows `disabledAt` set. After deletion, the old ID is absent from the list
  and administrative actions on it return 404.
- `GET /api/v1/auth/me` with anything they held answers 401 (`token_revoked` for
  a device token that still matched a row).
- `POST /api/v1/auth/login` with their password answers 401.

All of this is pinned by `tests/rights-matrix.integration.test.ts`
(*row «terminated all access»*, *row «deactivated»*) and
`tests/user-deactivation.integration.test.ts`.

## If they come back

A deleted account cannot be restored: create a fresh invitation. The same login
is available, but the new account receives a new ID, password and assignments.
The following recovery applies only to a disabled account.


Open the same person under **«Отключённые участники»** and choose
**«Восстановить доступ»** (`POST /api/v1/admin/users/by-id/<userId>/reactivate`).
The confirmation states that their saved role and assigned pages become usable
again. Review those pages before confirming; restoration must never transfer
someone else's history to a new person with the same name.

Every old sign-in and link stays revoked. If the person already set a password
and no mandatory password change is pending, they can log in with it again.
If `mustChangePassword` is set, the confirmation directs the owner to create a
password-reset link before client sign-in; restoration does not clear that
flag. A reset link also helps if the password was forgotten. If the person
never registered, create a fresh invitation from the restored card's «Ссылки»
section. See `docs/runbooks/chatter-onboarding.md`.
