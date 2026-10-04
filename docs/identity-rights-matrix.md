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

| Surface (policy kind) | owner, cookie | owner, device token | team_lead, cookie | team_lead, device token | chatter, cookie | chatter, device token | `content_manager` (historical) | chat-extension token (any role) |
|---|---|---|---|---|---|---|---|---|
| Sign in at all (`login`, password sign-in) | yes | yes | yes | yes | yes | yes | **no — 401 on both lanes** | yes (password sign-in, `client`) |
| Owner console — `/admin/*` (`owner-session`) | **yes** | no (403) | no (403) | no (403) | no (403) | no (403) | — | no (403) |
| Dashboard — `/models`, revenue (`session`) | yes | no (403) | **yes** | no (403) | no (403) | no (403) | — | no (403) |
| Cabinet `/account` — `/auth/devices`, `/auth/usage` (`any-session`) | yes | no (403) | yes | no (403) | **yes** | no (403) | — | no (403) |
| `/auth/me` (`any`) | yes | yes | yes | yes | yes | yes | — | yes |
| Clients — `/pages`, `/pages/{label}/…` (`any` + page scope) | every page | every page | assigned | assigned | assigned | **assigned** | — | **listed reads only**, by the role's reach; `/pages` no (403) |
| Desktop read gateway — `/ofapi/read/*` (`apiKey`) | no (403) | yes, assigned | no (403) | yes, assigned | no (403) | **yes, assigned** | — | no (403) |
| Chat-extension bootstrap — `/client/bootstrap` (`apiKey`) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| Chat-extension shared recaps — `/client/pages/{label}/conversations/{fan}/recaps` (`apiKey` + page scope) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| Chat-extension dossier save — `/client/pages/{label}/fans/{fan}/profile/from-generation` (`apiKey` + page scope) | no (403) | own generations, every page | no (403) | own generations, assigned | no (403) | **own generations, assigned** | — | own generations, by the role's reach |
| Chat-extension own AI spend — `/client/pages/{label}/ai-usage` (`apiKey` + page scope) | no (403) | yes, every page, **own rows only** | no (403) | yes, assigned, own rows only | no (403) | **yes, assigned, own rows only** | — | yes, by the role's reach |

The client bootstrap lists the caller's **active** pages only (a tombstoned
page is never listed, assigned or not) and announces every feature off until
the owner switches it on (the audited `chatExtension*` settings). Its
`bindingsByHost` keeps an owner host binding only when it points at one of
those pages, so a binding never reveals a page the caller is not granted, and
only when the host holds accounts of that page's platform (an OnlyMonster
account binds an OnlyFans page, never a Fansly one). A
live agent key is refused with 403 even on a page it is granted. Its row is
held by `client-bootstrap.integration`: every cell of it, plus the agent key,
in both auth-policy modes; the switches and bindings by
`client-owner-switches.integration`.

The shared recaps read (chat-extension H-13) is the one route on which a
chatter reads a **restricted generation record**. A stored AI generation
(`ai_generation_content`: its prompt and its output) is otherwise read back
only by the owner; here every chatter granted a page reads the **text** of
that page's recaps, whoever generated them. The owner ruled recaps shared, with
no private recap per chatter (chat-extension `docs/architecture.md` §19,
decision 1, and question 8 of its `docs/hub-pr-plan.md` §6), and the widening
stops exactly there:

- only `fan-summary` generations, and only the two usable ones the recap
  status already describes: the freshest completed full and short recap of the
  fan (and of the persona, when the caller names one);
- never a generation that carries a `contextScope`: one whose context held
  something only its caller saw is that person's draft, not a shared recap, so
  it is excluded from this read, from the recap status, from the Coach attach
  and from the proof of a dossier alike;
- only on a page granted to the caller (page scope, as on every page route),
  and only while the owner's `recap` switch is on for it;
- only the text and its provenance (`generationRef`, time, persona, coverage):
  no prompt block, no author, no context manifest. The reader names its
  columns, so the rest never leaves the database for this route.

A page that is not the caller's serves no recap in either auth-policy mode;
only the refusal differs. With the policy enforced, the declared page scope
answers before the handler, as on every page route: 403 for a page that is not
granted, 404 for one that does not exist. In `log` mode the handler decides,
and the chat-extension feature check (`requireClientFeature`, the same on
every chat-extension page route) answers both `409 client_feature_disabled`
with the reason `not_granted`, which does not tell a missing page from another
person's.

Its row is held by `client-recaps.integration`: every cell, the agent key, a
page that is not granted and one that does not exist, in both auth-policy
modes, and two chatters of one page reading the same recap.

The dossier save from a stored generation (chat-extension H-5) writes the
fan's dossier, as the older `PUT …/fans/{fan}/profile` does, with one
difference in who decides the text: the caller names one of its own
generations and the hub copies the text from the restricted record. The right
is narrower than the page grant on purpose:

- only the **author's own** generation is found. Another person's generation
  answers 404 exactly as one that does not exist, to a chatter of the same
  page, to the team lead and to the owner alike: the route is no way to learn
  that a generation exists, and no way to publish someone else's;
- only of the page in the path and of the fan in the path, and only a usable
  full recap (the same rule as the shared recaps, so never one with a
  `contextScope`). The fan in the path is the chat: a generation of one fan's
  chat that names another fan is found for neither, so the route never writes
  one fan's recap into another fan's dossier;
- nothing of the record comes back: the answer is the dossier version's
  number and times;
- only on a page granted to the caller, and only while the owner's `recap`
  switch is on for it. A page that is not the caller's answers as on the
  shared recaps (403 / 404 with the policy enforced, `409
  client_feature_disabled` / `not_granted` in `log` mode).

The chat-extension token saves a dossier this way only: the older write is
not on its list. Its row is held by `client-profile-from-generation.integration`:
every cell, the agent key, a page that is not granted and one that does not
exist, in both auth-policy modes, and another person's generation refused for
every role.

Fresh text (chat-extension H-4c, `liveTextContext` on the AI feature stream)
adds no right and no route. A caller who may generate for a page may send the
last messages its client read off that page's open chat; they join the
transcript of that one generation and are stored in its restricted record
only, scoped `contextScope: principal-draft` as above. Two limits keep it
inside what the caller could already do:

- nothing the client sends is read back by anyone else: it reaches no message
  archive, no observation and no dossier, and no shared reader selects a scoped
  generation;
- the check that a snapshot belongs to the chat the request names reads other
  pages' message stores (the archive and the webhook archive) only for pages
  granted to the caller (every page for the owner). A message id that exists
  on a page the caller is not granted is not looked up, so the
  `context_conflict` refusal never says that an id exists there.

Held by `client-ai-live-text.integration` (a chatter of two pages, the owner,
a page that is not the chatter's) and `client-ai-live-text-lookup.integration`.

The own-AI-spend read (chat-extension H-15) answers the **caller's own**
ledger rows on the page of the path, by day, and nothing else: an owner's
device token reads the owner's spend, never a chatter's (everyone's spend is
the owner console's usage report, cookie only). The page is in the path, so
page scope applies as on every page route; a page or a user named in the query
is refused, not ignored. It waits for the owner's master switch
(`chatExtensionEnabled`) and the extension's version
(`chatExtensionMinVersion`); it has no flag of its own and asks for no
platform or host binding. Its row is held by `client-ai-usage.integration`:
every cell, the agent key, and a page that is not granted, tombstoned or
missing, in both auth-policy modes.

The **chat-extension token** (chat-extension H-3) is a device token the
extension asks for at password sign-in with `client: "chat-extension"`. The
sign-in echoes `client`, the token row keeps the profile for good (a trigger
refuses any change), and the bootstrap names it in `identity.tokenClient`. It
reaches only the routes of `CLIENT_TOKEN_PROFILES["chat-extension"]`
(`packages/contracts/src/client-token-scopes.ts`; the "chat-extension token"
column of the [generated policy table](generated/authorization-policy.md)):
who am I, the bootstrap, the persona catalogue without prompt texts, the AI
feature stream, the recap status, the shared recaps, the dossier save from a
stored generation, the fan and conversation profiles, the spenders reads, its
own AI spend, the capture lane and revoking itself. Every other route
answers a plain 403 with no `reason`, in **both** auth-policy modes, before any
handler runs; page scope still applies on the listed routes, and a revoked or
expired token still answers 401 with its reason. On the capture lane it sends
only `ai_acceptance`, journaled as `chat-extension@<version>`, and
`client_health` (chat-extension H-11b), and it can never carry the desktop
harvest capability. A `client_health` report is never journaled, from any
token: the journal keeps the payload and the user forever. The lane folds it
into hourly rollups that hold no user, page or fan (the `client_health_*_hourly`
tables) and drops the report; with `chatExtensionHealthIngestEnabled` off (or
the master switch off) it accepts the report and keeps nothing, and the
bootstrap does not list `client-health-perf-v1`, so the extension does not send
one. Held by `client-health-intake.integration`. The owner reads the rollups at
`GET /api/v1/admin/client-health` (chat-extension H-11c), an `owner-session`
route like the rest of the owner console: no device token reaches it, the
extension's own included. It names no person, since the rollups hold none: the
figures are by client version and host build, and a group of fewer than 20
observations shows its size and no mean, maximum or percentile. Held by
`client-health-view.integration`. Its AI generations wait for
the owner's switches (`chatExtensionEnabled`, the Coach / Recap / Review flags) and its
version for `chatExtensionMinVersion`, and each generation record is labelled
`clientProfile: "chat-extension"`. A full device token of the same person is
untouched. Held by `device-token-client-profile.integration` (every route of
the policy table walked by a narrow and a full token in both modes) and by
`rights-matrix.integration` › *chatter, chat-extension token*.

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
- **The chat-extension token narrows a client, not a person.** It keeps a
  leaked or misbehaving extension inside the extension's routes; the person
  who signed it in can still sign in again with the same password and take a
  full device token. An application rollback to a hub older than H-3 also
  reads a narrow token as a full one until the next forward deploy. Before
  rolling back past H-3, list the live narrow tokens read-only
  (`select id, user_id, label from device_tokens where client_profile is not
  null and revoked_at is null and expires_at > now()`) and revoke each one in
  the cabinet (the person's card, «Завершить вход на устройстве»); the
  extension signs in again after the forward deploy.
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
