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
| Chat-extension archive feed — `/client/pages/{label}/conversations/{fan}/feed` (`apiKey` + page scope) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| Chat-extension dossier save — `/client/pages/{label}/fans/{fan}/profile/from-generation` (`apiKey` + page scope) | no (403) | own generations, every page | no (403) | own generations, assigned | no (403) | **own generations, assigned** | — | own generations, by the role's reach |
| Chat-extension own AI spend — `/client/pages/{label}/ai-usage` (`apiKey` + page scope) | no (403) | yes, every page, **own rows only** | no (403) | yes, assigned, own rows only | no (403) | **yes, assigned, own rows only** | — | yes, by the role's reach |
| Chat-extension Spenders statistics — `/client/pages/{label}/spenders/stats` (`apiKey` + page scope) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| Chat-extension awaiting-reply queue — `/client/pages/{label}/spenders/awaiting-reply` (`apiKey` + page scope) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| Chat-extension greeting lease and send custody — `/client/pages/{label}/fans/{fan}/claim`, POST and GET (`apiKey` + page scope) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| Manual resolve of a held chat-extension send — `/pages/{label}/client-send-custody/{attempt}/resolve` (`session` + page scope) | **yes, every page** | no (403) | **yes, assigned** | no (403) | no (403) | no (403) | — | no (403) |
| List of held chat-extension sends and of the ones resolved by hand — `/client-send-custody` (`session`; the page is a filter in the query) | **yes, every page** | no (403) | **yes, assigned** | no (403) | no (403) | no (403) | — | no (403) |
| Chat-extension "new subscribers" list — `/client/pages/{label}/audience-new` (`apiKey` + page scope) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach |
| AI persona prompts and raw prompts — `/ai/personas`, `/ai/personas/{key}`, `/ai/gateway/stream`, `/admin/ai/personas*` (`owner-session`) | **yes** (legacy writes answer 409: edit in the console) | no (403) | no (403) | no (403) | no (403) | no (403) | — | no (403) |
| Client AI — `/ai/persona-catalog` (metadata, no prompt text), `/ai/features/{feature}` (`apiKey`) | no (403) | yes, every page | no (403) | yes, assigned | no (403) | **yes, assigned** | — | yes, by the role's reach (features behind the owner's switches) |

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

The archive feed (chat-extension H-9c) is the route on which a device token
reads a conversation's **messages from the hub's own stores**. The dashboard's
reads of a stored conversation (`pageConversationPreview`,
`pageConversationMessages`, `archiveConversationMessages`) stay cookie-session
routes; a client saw messages through the desktop read gateway and the event
streams, and the chat-extension token reaches neither, so this is the one way
that token reads message text. Every chatter granted a page reads, for any fan
of that page, what the message archive and the webhook store hold of the chat,
a page at a time:

- only on a page granted to the caller (page scope, as on every page route),
  and only while the owner's `preview` switch is on for it. A page that is not
  the caller's answers as on the shared recaps (403 / 404 with the policy
  enforced, `409 client_feature_disabled` / `not_granted` in `log` mode);
- only one conversation per request, the fan in the path. Another fan's chat
  and the same fan on another page are other conversations and never mixed in;
- the text, the time, the sender, a tip or a price in mills and a caption of
  what is attached. No media id or URL, no prompt, no generation, and nothing
  about who of the team read or wrote what;
- a message deleted on the platform is served as a row flagged `deleted`,
  without its text: the row says a message was there and is gone from the
  chat, with its time, its sender, a tip or a price and a caption. The stores
  keep the text they captured (nothing captured is deleted), and no client
  route hands it on, to the owner's device token no more than to a chatter's;
- it only reads. Nothing is asked of the platform and nothing is queued, so a
  chat read here stays unread on OnlyFans.

Its cursor adds no right and tells nothing: it is signed and bound to the page,
the fan and the person, so one chatter's cursor opens nothing for another; it
is checked after the page and the switch, never in their place; and its state
is sealed, so its holder cannot read from it the hub-wide row ids that bound a
walk (they would say how many messages the whole hub holds). Its row is held by
`client-feed.integration`: every cell, the agent key, a page that is not
granted and one that does not exist, in both auth-policy modes, and a cursor
presented by another person, for another fan and for another page.

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

The Spenders statistics (chat-extension H-8b) answer **one page's** numbers to
everyone granted it, the same body whoever asks: 30 local days of gross and
creator-net money, tiers by lifetime spend, silence, new payers and how many
payers wait for a reply. They name no fan, and they open no money a device
token could not already read: `/api/v2/spenders` answers the same page's gross
and creator-net totals for a period (`diagnostics`) and every payer's own
amounts to the same callers. The dashboard's revenue routes stay session-only.
The page is in the path; a page or an instant named in the query is refused,
not ignored. It waits for the owner's `stats` switch on the page (OnlyFans
only) and the extension's version, and a page that is not the caller's answers
as on the shared recaps. An answer is kept in the process for up to 60 seconds
and shared between callers; the checks above run on **every** request, before
the kept answer is looked at, so a caller the hub refuses never reads one. Its
row is held by `client-spender-stats-route.integration`: every cell, the agent
key, and a page that is not granted, tombstoned or missing, in both auth-policy
modes.

The awaiting-reply queue (chat-extension H-8c) lists **one page's** payers
whose fan wrote after the page's last message, biggest spender first, the same
rows to everyone granted the page. A row names a fan: the platform id and the
names, the lifetime gross, when the fan and the page last wrote, and how many
messages are unread or that this is not known. It opens nothing a device token
could not already read: `/api/v2/spenders` answers the same fields of every
payer of the page to the same callers, and the queue is the hub's own choice
and order of them over the whole page. It only reads: nothing is asked of the
platform and nothing is queued, so a chat listed here stays unread on
OnlyFans. It waits for the same `stats` switch as the statistics (OnlyFans
only) and the extension's version, a page that is not the caller's answers as
on the shared recaps, and nothing is kept between requests. Its cursor adds no
right: it is signed and bound to the page and the person for an hour, so one
chatter's cursor opens nothing for another, and it is checked after the page
and the switch, never in their place. Its state is sealed, so its holder reads
nothing from it, the hub's own id of a fan included. Its row is held by
`client-spender-awaiting-reply.integration`: every cell, the agent key, a page
that is not granted, tombstoned or missing, in both auth-policy modes, and a
cursor presented by another person and for another page.

The greeting lease and send custody (chat-extension H-7b) let a person
granted a page hold a fan's first greeting for themselves and report a send
from the preview; the hub sends nothing itself. What one caller learns about
another is deliberately small:

- the holder of a lease is never named. The answer says `you-elsewhere` (the
  caller's own lease, held by another of their client installs) or
  `someone-else`, and a lease token is answered only to the install that
  holds it;
- a send in flight shows its attempt id and state to everyone granted the
  page, so nobody dispatches over it; its one-time ticket is answered once, to
  the dispatcher, and only its sha256 is stored. A finished send is shown by
  the status read only to the person who dispatched it (their own last send to
  the fan, so their client learns of a manual resolve), never to anyone else;
- a desktop new-follower command whose outcome is unknown shows the same way
  to everyone granted the page, as a send nobody can vouch for
  (`uncertain-held`) under the command's id, and gives no lease: it may have
  greeted the fan. Who queued it is not shown;
- the outcome of a send (`sent`, `failed`) is taken only from the person and
  the client install that dispatched it. `registerNativeSend` records the
  caller's own proven send and frees nobody's custody: over a held send of
  the same part it records the greeting alone, and the send stays held;
- only a confirmed greeting's owner may dispatch the rest of its group, and
  only the owner still gets a lease on a greeted fan.

Which of the owner's switches an action waits for: `claim` and `renew` need
`newcomers`; `dispatch` needs `previewSend` (and `newcomers` for a greeting),
read from the owner's stored switches inside the dispatch's own transaction;
the status read needs only the master switch and the minimum version, on an
OnlyFans page; `release`, `sent` and `failed` end what the hub already
admitted and need only the page grant; `registerNativeSend` reports a send
that already happened and needs only the page grant on an OnlyFans page, so
no switch, flag or minimum version ever loses the proof of a send. A page
that is not the caller's answers as on every chat-extension page route (403 /
404 with the policy enforced, `409 client_feature_disabled` / `not_granted`
in `log` mode).

The **manual resolve** of a held send is the one right here that is not the
sender's: the owner, or a team lead of the page, ends an unresolved attempt
as sent or not sent after looking at the chat, with a note. It is a cabinet
route (cookie session), so a chatter, any device token and the
chat-extension token are refused; it is audited as
`client.send_custody_resolved` (who, which page, which attempt, which
outcome; no fan id) in the transaction that resolves; and no chat-extension
switch gates it, so a held send stays resolvable while the extension is
switched off. "Not sent" waits for the attempt's ticket to run out (`409
conflict` / `ticket_live` before that): inside it the page may still send. Both rows are held by `client-claim-routes.integration`: every
cell, the agent key, a page that is not granted and one that does not exist,
in both auth-policy modes.

The **list of held sends** (chat-extension H-7e) is what those two people
read before they resolve: every send from the preview whose client never
reported and whose ticket ran out, and, on request, the sends already
resolved by hand. It is the resolve's right and no wider:

- a cabinet route (cookie session) of the owner and team leads. A chatter,
  any device token (the owner's and a team lead's included), the
  chat-extension token and an agent key are refused with 403;
- the owner reads every active page, a team lead the pages assigned to them,
  and a team lead with no page reads an empty list. The page is an optional
  filter in the query, not a path parameter, so the route declares no page
  scope and the handler checks the page itself: 404 for a page that does not
  exist, 403 for one the viewer does not reach, in both auth-policy modes;
- it names the person who dispatched each send and the client install it came
  from, and for a resolved one the resolver and their note. That is more than
  the claim routes tell a chatter (a lease holder is never named there): the
  resolver has to know whom to ask what was sent;
- it serves no text of a message: the custody tables hold none, and the hub
  does not know which text went out. It does serve each send's
  `generationRef`, the id of the AI generation the text came from. That
  generation's record (its prompt and its output) stays restricted: the
  owner reads it on `/ai/restricted/generations/{ref}`, and a team lead
  learns the id here, not the text. It says whether the fan's greeting is on
  record, in the words of the claim status read, and not the greeting's
  message id;
- it only reads the hub's own records: nothing is asked of OnlyFans, nothing
  is queued and nothing is written, the audit trail included. No
  chat-extension switch gates it.

Its row is held by `client-held-sends.integration`: every cell, the agent
key, a page that is not the viewer's and one that does not exist, in both
auth-policy modes. How to judge a held send is
[the held-sends runbook](runbooks/client-held-sends.md).

The "new subscribers" list (chat-extension H-7c) answers who subscribed to a
page, or came back to it, inside a window of up to 720 hours: the fan's id and
names, when they subscribed, their subscription as the hub holds it, a
summary of the chat (times and a count, no text) and where the greeting
stands. A full device token of the same role already reads the page's
subscribers (`/pages/{label}/subscribers`); the chat-extension token does not
reach that route, so this list is how that token learns of a page's
subscribers, and only of those of the window:

- only on a page granted to the caller (page scope, as on every page route),
  and only while the owner's `newcomers` switch is on for it. A page that is
  not the caller's answers as on the shared recaps (403 / 404 with the policy
  enforced, `409 client_feature_disabled` / `not_granted` in `log` mode);
- nobody of the team is named. A row's `claim` carries the states the claim
  status read answers for the same fan and caller and nothing more: a lease
  reads `you-elsewhere` or `someone-else`, a finished send shows only to the
  person who dispatched it, and a greeting says that the fan is greeted, never
  by whom;
- it only reads the hub's own records. Nothing is asked of the platform and
  nothing is queued, so no chat is marked read on OnlyFans.

Its cursor adds no right: it is signed and bound to the page and the person,
so one chatter's cursor opens nothing for another, and it is checked after the
page and the switch, never in their place. Its row is held by
`client-audience-new.integration`: every cell, the agent key, a page that is
not granted and one that does not exist, in both auth-policy modes, and a
cursor presented by another person and for another page.

The **chat-extension token** (chat-extension H-3) is a device token the
extension asks for at password sign-in with `client: "chat-extension"`. The
sign-in echoes `client`, the token row keeps the profile for good (a trigger
refuses any change), and the bootstrap names it in `identity.tokenClient`. It
reaches only the routes of `CLIENT_TOKEN_PROFILES["chat-extension"]`
(`packages/contracts/src/client-token-scopes.ts`; the "chat-extension token"
column of the [generated policy table](generated/authorization-policy.md)):
who am I, the bootstrap, the persona catalogue without prompt texts, the AI
feature stream, the recap status, the shared recaps, the dossier save from a
stored generation, the fan and conversation profiles, the spenders reads, the
Spenders statistics and the awaiting-reply queue, its own AI spend, the capture lane and revoking itself. Every other route
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
observations in the range asked for shows its size and no mean, maximum or
percentile. That floor is on the range of one read and no narrower: the mean
and the maximum of a few observations can be worked out from two reads of
larger ranges, so it keeps a thin figure from being read as the version's and
does not seal a small group off. Contract verdicts and counters are counts of
reports and events and are shown at any size. Held by
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
- **Persona prompts are owner content.** No device token — any role, any client
  version, a legacy token with no client profile, the owner's own — reads a
  persona's system prompt, writes or archives a persona, or sends a raw prompt.
  Before this cutover every full device token could do all of that, with no
  audit row (the narrow chat-extension token never could). The clients keep
  exactly what they use: the metadata catalog and the feature lane, where the
  hub assembles the prompt itself.

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
| Persona edited | Only the owner by cookie, through `/admin/ai/personas`: every change is compare-and-set on the version (a stale tab gets 409) and commits an `ai_persona.created` / `updated` / `archived` audit row with no prompt text in the same transaction. The legacy `/ai/personas` writes are retired (409 for the owner, 403 for every bearer) | `rights-matrix.integration` › *row «persona edited»*; the lane in depth: `ai-persona-admin.integration` |
| Persona prompts are owner content | Every device token — fresh or legacy, full or the chat-extension's narrow one, any role, the owner's included — and a chatter's cookie session answer 403 on the full-text list, the legacy writes and the raw prompt gateway; nothing changes and no AI spend is booked; the catalog still answers 200 to every device token without prompt text | `rights-matrix.integration` › *row «persona prompts are owner content»*; both enforcement modes: `auth-policy.integration` |
| Client AI keeps working | A chatter's device token, a legacy one included, still streams through `/ai/features/{feature}` | `rights-matrix.integration` › *row «client AI keeps working»* |
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
