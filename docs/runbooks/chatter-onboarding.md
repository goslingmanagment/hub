# Onboarding a chatter, and the link operations

How a new person gets an account, and which of the day-to-day operations to
reach for when something goes wrong with their sign-in. The reverse direction
is `docs/runbooks/chatter-offboarding.md`; the rights behind every button are in
`docs/identity-rights-matrix.md`.

The console ("Настройки → Команда") is PR-1B. Until it ships, each step names
the route behind the button; owner cookie session required.

## Inviting

1. **Команда → Пригласить**: login, pages (multi-select, grouped by platform).
   Role (`chatter` by default) and the link's lifetime (7 days) sit under
   "Дополнительно". Route: `POST /api/v1/admin/users/<login>/links` for an
   existing account, or the invite operation that creates the account, the page
   grants and the link in **one** transaction — if any page label is wrong,
   nothing is created at all.
2. The response carries the link **once**: `https://gosling-agency.ru/join#<…>`.
   It is never stored, logged or journalled. Copy it from the dialog and send it
   in Telegram by hand, with the ready-made message template. If you lose it,
   just make a new one (step 4) — the lost one is retired automatically.
3. The person opens it on any device, chooses a password (12+ characters, not a
   common one), and is told which client to install for the platforms they were
   actually granted.
4. Until they do, their card reads **«ждёт регистрации»**. «Отправить
   приглашение заново» mints a fresh link and retires the previous one — at most
   one link per person is ever active.

A link is one-time and lives 7 days by default (30 at most). Used, expired and
revoked links are kept as facts, never deleted.

### The login already exists

The invite form checks the whole team, including disabled participants, using
the same case-insensitive login rule as the kernel. `Nikita` and `nikita` are
one login. A duplicate opens the existing participant's card rather than
creating or restoring an account automatically. A stale list is refreshed
after a failed invite; the form keeps its inputs and gives an inline recovery
path.

- **Access disabled:** choose «Перейти к восстановлению», review the saved
  role and pages, then confirm «Восстановить доступ» only for the same person.
  Their history and login belong to that identity. For someone else, choose
  another login.
- **Waiting for registration:** use «Отправить приглашение заново» on their
  card. Creating the same person again is unnecessary.
- **Already active:** open the card to check their pages/devices or use
  «Сбросить пароль ссылкой» if they forgot the password.

Disabled participants also remain visible under «Отключённые участники» on the
Team tab. Restoration does not revive old links or sign-ins. If the person
never set a password, create a new invitation after restoring. If a mandatory
password change is pending (`mustChangePassword`), create a password-reset
link before they sign in to a client. Otherwise the old password works again,
and a reset link is needed only if they forgot it.

## Which operation, when

| Situation | Use | Route |
|---|---|---|
| Forgot the password | «Сбросить пароль ссылкой» — send a new link in Telegram | `POST /api/v1/admin/users/<login>/links` with `kind: password_reset` |
| Lost or sold one machine | «Отозвать вход» on that device | `DELETE /api/v1/admin/users/<login>/device-tokens/<id>` |
| Not sure which machines are signed in | «Отозвать все устройства», then let them sign in again | `DELETE /api/v1/admin/users/<login>/device-tokens` |
| Suspected leak, person keeps working | «Завершить все входы»; they sign in again with the same password | `POST /api/v1/admin/users/<login>/terminate-access` |
| Person is leaving | the offboarding runbook | — |
| Adding or removing a page | assign / unassign; it takes effect on their next request, with no re-login | `POST` / `DELETE /api/v1/admin/users/<login>/pages` |

Two things to keep straight, because the names are close:

- **A password reset always terminates every sign-in.** There is no variant that
  keeps the old devices alive; that is deliberate.
- **«Отозвать все устройства» leaves the browser session and any legacy API key
  alive.** It is a device operation, not an eviction. See the offboarding
  runbook's ladder table.

## Checks after the person is in

- Their card lists their devices with a client version and a last-activity time.
- `/pages` for them shows exactly the pages you granted (the extension and the
  desktop app both read the same list).
- Their AI spend shows up under their own name in the usage report, and to them
  in their own cabinet at `/account`.

Pinned by `tests/rights-matrix.integration.test.ts` (*row «assigned a Fansly
page»*, *row «assigned an OnlyFans page»*, *chatter: the cabinet and the
clients*) and `tests/account-links.integration.test.ts`.
