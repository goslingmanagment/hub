# Identity rights matrix (Decisions 352, 354)

One login is not one set of rights. Since Decision 349 every person in the
agency has a single account and signs in to the dashboard, the Fansly extension
and the OnlyFans desktop app with the same login and password — but what that
account can actually reach depends on five independent axes, and "the chatter
has an account" answers none of them. This document is the map, and
`tests/rights-matrix.integration.test.ts` is its proof: every row below names
the test case that holds it.

Read with the [generated policy table](generated/authorization-policy.md),
[chatter onboarding](runbooks/chatter-onboarding.md) and
[chatter offboarding](runbooks/chatter-offboarding.md).

Account-target operations use immutable `userId`. A login can belong to a new
account after deletion; credentials, rights, cached cards and historical usage
remain bound to the original ID. See
[account deletion](runbooks/user-account-deletion.md).

## The five axes

1. **Role** — `owner`, `team_lead`, `chatter`. Set at invitation, changed only
   by the owner. (`content_manager` is historical — see *Honest boundaries*.)
2. **Sign-in method** — a cookie session (the browser) or a device token (both
   clients, minted by `POST /auth/device-tokens/password`). Since Decision 370
   there is no third: the API-key lane is gone. The method is a right in
   itself — the same person reaches different things depending on how they
   signed in.
3. **Page assignments** — which pages of which platform the account is granted.
   Resolved from the database on **every request**, so a change lands on the
   next call without a re-login or a re-issued credential.
4. **Device rights** — which sign-ins exist on which machines, and which of the
   four revocation operations has been used on them.
5. **The client's local cache** — the desktop's SQLite and the extension's
   `storage.local`. The hub does not own this axis at all; see *Honest
   boundaries*.

## Role × sign-in method

What each combination reaches. "Assigned" means the page-scoped routes of the
pages that account is granted; the owner is granted every page implicitly.

| Surface (policy kind) | owner, cookie | owner, device token | team_lead, cookie | team_lead, device token | chatter, cookie | chatter, device token | `content_manager` (historical) |
|---|---|---|---|---|---|---|---|
| Sign in at all (`login`, password sign-in) | yes | yes | yes | yes | yes | yes | **no — 401 on both lanes** |
| Owner console — `/admin/*` (`owner-session`) | **yes** | no (403) | no (403) | no (403) | no (403) | no (403) | — |
| Dashboard — `/models`, revenue (`session`) | yes | no (403) | **yes** | no (403) | no (403) | no (403) | — |
| Cabinet `/account` — `/auth/devices`, `/auth/usage` (`any-session`) | yes | no (403) | yes | no (403) | **yes** | no (403) | — |
| `/auth/me` (`any`) | yes | yes | yes | yes | yes | yes | — |
| Clients — `/pages`, `/pages/{label}/…` (`any` + page scope) | every page | every page | assigned | assigned | assigned | **assigned** | — |
| Desktop read gateway — `/ofapi/read/*` (`apiKey`) | no (403) | yes, assigned | no (403) | yes, assigned | no (403) | **yes, assigned** | — |
| Chat-extension bootstrap — `/client/bootstrap` (`apiKey`) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — |

The client bootstrap lists the caller's **active** pages only (a tombstoned
page is never listed, assigned or not) and announces every feature off until
the owner switches it on; its row is held by `client-bootstrap.integration`.

Three consequences worth stating out loud, because each has already surprised
someone:

- **A device token is never an owner session.** The owner signing in to a
  client on a chatter's machine gets a client principal, not the console — this
  is the mechanical half of Р10 (the two owner accounts stay separate).
- **The cabinet is cookie-only.** A device token on `/auth/devices` answers 403,
  not 401, and carries no `reason`: it is a scope decision, not a dead
  credential, and a client must not wipe its custody over it.
- **The dashboard and the cabinet are different gates.** A chatter holds a real
  cookie session and still cannot open `/models`; `any-session` is the
  self-serve surface, `session` is the dashboard.

## The event matrix

| Event | What must happen | How it is verified |
|---|---|---|
| Assigned a Fansly page | `GET /pages` and `/auth/me` for the device token carry it on the next request; the page's operations open | `rights-matrix.integration` › *row «assigned a Fansly page»* |
| Assigned an OnlyFans page | `GET /ofapi/read/accounts` for the device token carries the `acct_…` id; one principal spans both platforms | `rights-matrix.integration` › *row «assigned an OnlyFans page»*. The rail appears in the desktop after its rebaseline/restart — **manual** |
| Assignment removed | The Fansly page's operations answer 403 (404 for a label that never existed); the OnlyFans account leaves the rail and its per-account reads 404 before a credit is spent; the pages that remain still work | `rights-matrix.integration` › *row «assignment removed»* |
| Revoked one sign-in | The other device of the same person keeps working; the revoked one answers 401 `reason: token_revoked` | `rights-matrix.integration` › *row «revoked one sign-in»*; the reason itself: `auth-unauthorized-reason.integration` |
| Revoked every device | Every device token 401s; **the cookie session stays alive** | `rights-matrix.integration` › *row «revoked every device»* |
| Terminated all access | Device tokens, reservations, sessions and active links all die; a fresh `login` with the same valid password still works | `rights-matrix.integration` › *row «terminated all access»*; the counts: `auth-devices.integration` |
| Password reset by link | The old password 401s and the new one 200s; every prior device token and session 401s | `rights-matrix.integration` › *row «password reset by link»*; the link lifecycle: `account-links.integration` |
| Deactivated | Every credential 401s and both sign-in lanes refuse **with no oracle** — byte-identical answers for a disabled account and for one that never existed | `rights-matrix.integration` › *row «deactivated»*; the tombstone and the frozen mutations: `user-deactivation.integration` |
| Deleted and login reused | Old credentials/links and old-ID actions fail; a new account has a new ID and only newly assigned access; old audit/spend attribution survives | `user-identity-reuse.integration` |
| Stale username route or old card | It cannot resolve to a replacement user, including numeric logins | `user-identity-reuse.integration`; `team-account-lifecycle` |
| Roles | owner: every page, console by cookie only; team_lead: dashboard but not the console, clients by assignment; chatter: cabinet and clients, never the dashboard; `content_manager`: cannot sign in anywhere | `rights-matrix.integration` › *§7 — roles* (four cases). The declarative policy grid per module: `auth-policy.integration` |
| Another person signs in on the same PC | The principal and the assigned pages are the new person's; the previous person's local data is hidden but still on the disk | **manual + documented** (D23 of the desktop repo, #145) |
| No pages of that platform | The extension shows CG-HUB-05; the desktop shows an empty state instead of reconnecting forever | **unit tests in the clients** |
| An assignment is removed while a stream is open | The open SSE stream re-checks authorisation and closes within 60 s | **documented, not automated** — `SSE_AUTH_REVALIDATE_INTERVAL_MS = 60_000`, `apps/runtime/src/modules/events/index.ts` |

`auth-policy.integration.test.ts` is deliberately **not** extended with the
roles row: it pins the declarative policy layer against the legacy in-handler
guards in both enforcement modes and has no device tokens or password sign-in in
its fixture. The roles row is about principals, not about the two layers
agreeing, so it lives here in one place.

## Honest boundaries

The matrix is only worth having if it also says what the hub does **not**
control.

- **The hub does not own the chatter's Fansly session.** A chatter stays logged
  into Fansly in their own Firefox regardless of every revocation here. Signing
  them out of Fansly is a manual step of the offboarding runbook.
- **"Revoke all devices" is not "this person is out."** By design (§4.4) it
  touches device tokens and reservations only: the cookie session survives. Use
  **«Завершить все входы»** (terminate all access) for a real cut-off, and
  deactivation to close the account. (Before Decision 370 a legacy API key
  survived it too; that half of the trap is gone with the lane.)
- **Streams lag by up to 60 seconds.** A revoked assignment closes an already
  open SSE stream at the next revalidation tick, not instantly.
- **The desktop's local cache outlives the account.** Removing an assignment or
  the whole account hides the data in the app; the SQLite file on the machine is
  erased only by a purge run there (D23, #145). Nothing the hub does reaches it.
- **The account list empties quietly.** `GET /ofapi/read/accounts` answers
  `200 []` after the last OnlyFans assignment is removed — it is a list, not a
  page-scoped operation. The 403/404 shows up on the per-account reads.
- **`content_manager` accounts are historical.** Decision 370 took the role out
  of the wire enum as well: it is not creatable, cannot sign in, and cannot be
  serialized to any client. The PG enum value stays (migrations are
  forward-only), so a historical row remains readable by raw SQL — and the admin
  user list fails closed rather than publishing a role no client can parse.
  Production had zero such rows when the role was retired; that count was the
  merge gate.

## Where this is enforced

Declarations live in `packages/contracts/src/routes.ts` (`auth: { kind, scope }`)
and are pinned by `tests/contracts-auth-declarations.test.ts`; the verdict is
computed in `apps/runtime/src/api/auth-policy.ts` by running the same guard
functions the handlers call (`requireOwner`, `requireDashboardUser`,
`requireSessionUser`, `requireApiKeyUser` — whose name is historical since
Decision 370: the one bearer it admits is a device token), so a declared
decision and an in-handler decision cannot drift apart by construction. Page scope resolves
through `canAccessPage` against `assignedPageIds`, recomputed per request.
