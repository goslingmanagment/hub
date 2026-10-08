# Reading this agency's data honestly: the `hub` CLI

You are an agent with a key to the Agent Read Plane. This page is how to use it
without fooling yourself.

The plane exists because of one incident. Someone asked whether a fan named Rick
had spent money in January. A tool answered with an empty list. The empty list was
true and the conclusion drawn from it was false: the money existed, the store's
record of that conversation simply started in July. Everything below is built so
that mistake is not available to you.

## The one rule

**An empty result is not an answer. `conclusion.blockers` is the answer.**

Every response carries `conclusion.blockers`: every reason, KNOWN TO THIS SYSTEM,
why this answer is narrower than the question you asked. A non empty list means
you did not read what you asked about, and each entry names why.

**An empty list is weaker than it looks, and this is the most important sentence
on this page.** It means no known narrowing condition was detected. It does NOT
mean the coverage was complete. This system runs no verified gap sweep and holds
no completeness proof for any store: that machinery was designed, found to be
unreachable on every real route, and REMOVED rather than left as a field that is
structurally always false. So "no blockers" is the absence of a known problem, not
the presence of a guarantee.

What you have instead, and what you must read every time, is:

- `capture.planes[]`: which stores were actually consulted, and the reason for
  each that was not. **The capture floor lives HERE, one per store**: a plane
  with `state: "read"` carries `captureFloor`, and that is when THAT store's
  record of the scope begins. There is no `capture.captureFloor` at the top of
  the envelope, and asking for one gets you `undefined` at the exact moment you
  are deciding whether something is absent. A floor is a fact about one store,
  so the response never claims one for itself.
- `capture.gaps[]` and `capture.sourceErrors[]`: named holes, and sources that
  failed during this read.
- `delivery.caveats[]` and `delivery.snapshotExhausted`: whether the traversal was
  stable and whether it really finished.

Report what you found AND what those said. "No transactions in the window" is a
claim about the world that nothing here can support. "No transactions found in the
window, and the archive for this thread begins 2026-07-05, so January was never
covered" is the truth. When the window sits fully inside the covered range and no
blocker fired, the honest phrasing is still "this system holds no matching
records", not "there were none".

## Three axes, read them separately

A response splits what it knows into three parts that answer different questions.
Confusing them is the whole failure mode.

**`delivery`** is about THIS RESPONSE. How many records came back, whether more
exist, what stopped it (a limit, a budget, a timeout). It says nothing about the
world. `delivery.returned: 0` means this call returned nothing, not that nothing
happened.

**`capture`** is about THE WORLD, or rather about what this system ever wrote
down. It is computed from your key's scope, the sources involved and the window
you asked for, and from nothing else. The same request with and without result
filters produces a byte identical `capture`. Inside it:

- `planes[]`: every store that could bear on your question, each marked `read`,
  `not_read`, `not_indexed` or `not_applicable`. A plane that was `read` carries
  `captureFloor` and nothing else; a plane that was not carries `reason` and no
  floor, because a floor on a store nobody opened would be a fabricated floor.
  A plane that was not read cannot support any conclusion.
- `planes[].captureFloor`: when THAT store's record of the scope BEGINS, as
  `{ at, kind }`. Read it as a lower bound: "the archive for this thread starts
  here". It is NOT a statement that nothing existed earlier; nothing in this
  system can say that. `kind: "unknown"` (and `at: null`, which means the same
  thing) means no honest floor could be computed without a scan nobody paid for,
  so treat the answer as unbounded below.
- `gaps[]`: named holes. The one you will meet most is
  `before_capture_floor`, which means your window starts earlier than the record
  does.
- `sourceErrors[]`: a source that failed during this read. Any entry here means
  the answer is provisional.
- `scopeNarrowing`: your key was granted fewer pages than the question spanned.

The shape, abridged (the real `planes` array carries EVERY plane exactly once,
which is why it is long; nothing may be silently missing from it):

```json
{
  "capture": {
    "planes": [
      { "plane": "message_archive", "state": "read",
        "captureFloor": { "at": "2026-02-21T09:14:03Z", "kind": "oldest_stored_row" } },
      { "plane": "transactions", "state": "not_read",
        "reason": "capability_not_granted" },
      { "plane": "dm_message_archive", "state": "not_indexed",
        "reason": "not_indexed_for_text_search" }
    ],
    "observedRowFloor": "2026-02-21T09:14:03Z",
    "gaps": [],
    "sourceErrors": [],
    "scopeNarrowing": { "keyGrantExcludedPages": 0, "totalPagesForQuery": 3 },
    "scopeFieldStates": {}
  },
  "conclusion": { "blockers": ["claim_not_declared"] }
}
```

Two traps in that shape. `observedRowFloor` is the minimum occurred-at of the
ROWS THIS RESPONSE RETURNED: a diagnostic, not a capture floor, and calling it
one is exactly the mistake this page exists to prevent. And the per-thread
inventory (`hub threads`) additionally carries a `captureFloor` on every ITEM:
that one is the floor for that single conversation, which is usually the number
you want to quote when you report an absence for one fan.

That item floor comes from the chat's PROVEN chain. Each thread item (and each
thread in `hub person`, and the transcript's `threadCoverage` block) carries the
chat's coverage as the Fansly Sync Engine proves it:

- `historyState`: `none` (nothing stored), `unverified` (messages stored by the
  old sync, never proven contiguous: there may be holes), `partial` (a
  contiguous chain down from a confirmed head, the start not reached yet) or
  `complete` (the chain reached the chat's first message);
- `historyProof`: `empty_page` when `complete` was proven by Fansly returning an
  empty page below the oldest message. That is the ONLY proof of completeness;
  a short page or a meeting with already-stored messages is not;
- `contiguousOldestAt` / `contiguousCount`: where the proven chain ends and how
  many messages it holds; `headConfirmedAt`: when its newest end was confirmed.

`captureFloor` is `{ "kind": "proven_chain", "at": <contiguousOldestAt> }` once
the chat has a chain (`partial` or `complete`): every message from `at` up to
the head is held, without a hole. Otherwise it stays `unknown`. On an
`unverified` chat no floor is claimed at all, because the old sync's windows
have holes. `messageCoverageStatusRaw` and `retentionLimit` are the OLD sync's
fields, kept for compatibility: `complete` there does not mean complete.

**`fieldStates`** is about ONE FIELD on ONE RECORD, plus `capture.scopeFieldStates`
for the scope as a whole, computed before any row is fetched. A field can be
observed, unobservable on this platform, or not captured. A null that is
`unobservable` is not a null that means zero.

One money trap deserves naming: **refunds**. Fansly has no refund/chargeback
capture lane at all — a refunded transaction keeps its `posted` row forever —
and the OnlyFans chargeback capture lives in a store this plane cannot read.
So "no refund rows in the window" can NEVER support "no refund happened"; the
strongest claim this system can back is "the hub holds no record of a refund".
Declare the `refundState` claim field whenever a conclusion touches refunds:
it comes back `not_captured` (Fansly) or `captured_unparsed` (OnlyFans) with a
`field_state_insufficient` blocker, which is the system saying exactly that.

## What to do when blockers are not empty

Read the blocker, then act on it instead of retrying blindly.

- `claim_not_declared`: you declared no `--claim-field`, so nothing checked
  whether the fields your conclusion rests on are observable at all. This is the
  one you will see most, on every call that skips the claim. It does not
  invalidate the rows you got; it means the answer carries no observability
  verdict. Re run with a claim before resting a conclusion on it.
- `gaps_present`: `capture.gaps[]` is not empty. Read them; each names a hole and
  the remedy, if any, for that hole.
- `window_before_capture_floor`: you asked about a period earlier than the
  record. Either narrow your claim to the covered period and say so, or ask for
  hydration (below).
- `capture_floor_unknown`: no honest floor could be computed for this scope. Treat
  the answer as unbounded below.
- `plane_not_read` / `plane_not_indexed`: a store that matters was not consulted.
  Check `capture.planes[]` for the reason. `not_indexed` on search means the text
  is held but not searchable, so a miss is not evidence of absence.
- `delivery_not_exhausted`: more records exist. Follow the cursor before
  concluding anything about totals.
- `mutable_sort_key_traversal`: this response continued a cursor, and the sort key
  can change under a traversal, so a row may have moved between pages. Counts from
  a multi page traversal are approximate.
- `read_only_mode`: the plane is in its verification ramp. Everything you got is
  real, but the deployment is not yet declaring completeness.
- `source_errors_present`: something failed mid read. Re run before concluding.
- `key_grant_narrowed_scope`: parts of the question are outside your key. Say so
  rather than answering as if the whole question was covered.
- `claim_field_unobservable` / `field_state_insufficient`: the field you declared
  a claim on cannot be observed for this scope. The answer cannot support that
  claim, whatever the rows say.
- `vault_inventory_unproven`: on `vault_media` only. Either the page has no live
  album row at all (the roster was never captured) or at least one live album has
  never been walked all the way through, so what you got is a lower bound on what
  the Vault holds. Do not say "this file is not in the Vault" and do not count the
  Vault. Row-level proofs stay valid: a member's `missingSince` is only ever
  written after a complete walk of its own album, so it remains "absent from that
  walk" (never a deletion claim) even while the page-level blocker is up. The
  catalog lane walks albums under a daily call cap and a big Vault takes more than
  a day, so `/health` being green says nothing about this. Per album, the rows
  carry `lastFullWalkAt`, `fullWalkRef` and `fullWalkObservedCount` — read those
  to see which albums are proven and how old the proof is.

## Declare your claim

Most commands take `--claim-field <name>` (repeatable). Use it. Declaring a claim
tells the hub which fields your conclusion will rest on, and the response then
reports those fields' observability in `capture.scopeFieldStates` BEFORE any row
is fetched. Without a claim you get rows; with a claim you also get whether those
rows could ever have answered you.

## Asking for more data (hydration)

When the record does not reach far enough back, the remedy is to have the hub
fetch more from the platform. You never execute that yourself. Which route you
use depends on the page:

- **A page on the Fansly Sync Engine** — `hub sync-status --page-label <page>`
  shows `mode: "live"` and its `requestsEnabledAt` has passed: file a **history
  request** (next section). It needs no owner decision, reads whole chats or
  their newest N messages for up to 1000 fans at once, and reports progress and
  an estimate.
- **A page being switched** — `mode: "handover"`: neither engine reads it for a
  few minutes; both routes answer **409 `fansly_page_switching`**. Wait and
  retry, do not refile under another key.
- **An OnlyFans page**: the hydration route below; the owner decides each
  request.
- **A Fansly page outside the engine** (`off`, `shadow`): none is left in
  production. The hydration route still records the intent there, but nothing
  executes it: the owner can only reject it.

The response tells you when more data is even possible. Look at the `remedy` on
the relevant plane: a kind of `local_replay` or a hydration kind means more data
is reachable. A kind of `none` with reason `no_remedy_exists` or
`discarded_at_capture` means it is not recoverable at all, and no amount of
asking will change that. Say so plainly instead of retrying.

**The hydration route has no `hub` command.** The API serves two operations and
the `request:hydration` capability is real:

- `POST /api/v1/agent/pages/:pageLabel/threads/:conversationRef/hydration-requests`
  files one. Body: a `target` of kind `thread_backfill_before` with EXACTLY one
  of `beforeAt` / `beforeMessageRef` (a boundary, not a window: "everything in
  this thread older than X"), a `reason`, an optional `maxCalls`, and a UUID
  `idempotencyKey`. It answers **200, not 202**: on an OnlyFans page it
  records an intent and queues nothing — only an owner decision can spend a
  vendor call.
- `GET /api/v1/agent/hydration-requests/:requestRef` polls the one you filed.

**On a live engine page the hydration route is a one-fan wrapper.** The hub
files the history request for you (that chat, depth "before your boundary") and
the hydration request answers `dispatching` with `progress.executionRef` = the
history request's ref (follow it with `hub history-status --request <ref>` if
you like). Its state mirrors the history request's fan: `completed` — read to an
EMPTY page, the chat's whole history is stored; `partially_completed` — read to
your boundary, not proven complete; `failed` with `lastError: quarantined` —
Fansly keeps refusing that chat, do not refile; `failed` with `lastError:
vendor_unavailable` — the chat could not be read (not found, excluded);
`expired` — the history request was cancelled. Nobody decides it: an owner
decision on such a request answers 409 `engine_managed`. Before the page's
requests open the request stays `requested`; file it again with the same
`idempotencyKey` once they open.

What each refusal means, so you do not retry the wrong thing:

- **503 `agent_plane_disabled`**: `agentHydrationMode` is `off` (or the whole
  plane is). Not your key, not your request: the deployment has not opened this
  door yet. Do not retry; report it.
- **404**: the same static body as a request that never existed. Your key does
  not hold the page, or did not file that request.
- **409 `hydration_not_admissible`**: the plane already told you there is no
  lane for this gap. Check the `remedy` you were given.
- **409 `fansly_page_switching`**: the page is being switched to the engine;
  retry in a few minutes.
- **403 `agent_capability_missing`**: your key lacks `request:hydration`. Note
  that this is the one refusal on the plane that names a missing CAPABILITY; a
  page you were not granted, or a request that is not yours, is always the
  indistinguishable 404 above.

**Who decides your OnlyFans request.** The owner, every time: the approval
names the call, page and credit ceilings and consents to the read marking the
chat read (#158). Until then the request stays `requested`; do not refile it
under a fresh UUID. `completed` means the capture reached the end of the
vendor's history; `partially_completed` with `lastError: budget_exhausted`
means the owner's ceiling stopped it; `failed` means nothing was hydrated and a
re-run needs a new request and a new decision. The auto-approve policy
(`decision.decisionSource: "auto_policy"` on older requests) decided Fansly
requests only and is gone with the legacy Fansly lane: a Fansly request is a
history request, which needs no decision.

Since `hub` has no command for the hydration route, the useful half is still
yours to do by hand: report the specific gap (page, thread, conversation ref,
window, and the `remedy` the response carried) and hand it to the owner. That
report IS the request.

## History requests (pages on the Fansly Sync Engine)

History requests are how you read whole chats, or their newest N messages, for
many fans at once: the primary path on every page the Fansly Sync Engine runs
(`hub sync-status` shows `mode: "live"` and `requestsEnabledAt` has passed). On
a page not switched yet, or before its requests open, the hub answers **409
`history_requests_unavailable_on_page`**: use the hydration route above, and
`hub history-request` prints that fallback in `error.hint` beside the refusal.

What a request is:

- one page, 1 to 1000 fans, and a depth that is REQUIRED: `--all` (each chat to
  its first message) or `--latest N` (the newest N messages of each chat, the
  fan's and the model's). A fan is named by its Fansly account id (`--fan`), a
  chat's conversation ref (`--conversation`) or a chat link
  (`--chat-url https://fansly.com/messages/<id>`);
- a `--reason` (the hub keeps a digest only) and an idempotency key: the same key
  with the same fans answers the same request (`disposition: "coalesced"`), the
  same key with other fans is 409 `idempotency_mismatch`. Without
  `--idempotency-key` every call files a new request;
- answered at once, from the database alone: each fan's chat or why it was
  refused (`not_found`, `excluded` with `excludedReason`, `page_erased`,
  `duplicate`), what is already held, an estimate, and a state: `ready` (already
  satisfied, nothing to read), `queued`, `loading`, or `blocked` (Fansly keeps
  refusing that chat; `probeAt` says when it is asked again). A fan that cannot
  be resolved never fails the request.

Reading progress (`hub history-status`):

- `request.counts`, `request.reads` (`done`, `remainingMin`,
  `remainingEstimate`) and `request.eta`. The ETA is always TWO numbers:
  `lowerBoundSeconds` ("not less than") and `estimateSeconds`, labelled
  `basis: "estimate"`. Fansly does not say how long a chat is, so there is no
  upper bound: never quote the estimate as a promise.
- The time is the reads at `eta.ratePerHour`, the rate the page's budgets leave
  this request (about 800 reads an hour on a busy page, shared round robin with
  the page's other open requests). `eta.limitedBy` names the budget that sets it:
  `family` (the chat list, a chat's detail and `/message` share 15 a minute —
  the usual one), `route` (`/message` itself, when it runs slower) or `page`
  (the page's pause, when the page is busy with other work). `eta.slowdown`
  (non-null) says `/message` runs below its budget on that page since Fansly
  answered 429; it is already in the rate and does not lift by itself.
- `eta.hold` (non-null) is a stop in force: nothing is read until `until` —
  the page's hold, or the `/message` route's own after a 429 (`scope`). It is
  NOT in the seconds above: the reads start when it ends. `until: null` means no
  known instant ends it (the page needs new credentials or the operator).
- `waitingReason` / `waitingUntil` say why the request, or one fan, waits right
  now (`pacer`, `class_share`, `paused`, `page_hold`, `route_hold`,
  `ownership_unconfirmed`, ...). They are body fields, never blockers.
- a fan is `ready` once satisfied: `all` only when its chat is `complete` with
  `historyProof: "empty_page"`; `latest N` once the contiguous chain from the
  anchor (the chat's head when the request was filed) holds N messages, or the
  whole chat is proven shorter. Every loaded message is in the transcript as soon
  as it is read; nothing waits for the request to finish.

Who sees what: you see, and may cancel, the requests of EVERY requester on your
pages (other agents and the owner), shown by `requesterKind` only. A request on
a page outside your grant is the plane's one static 404. Filing and cancelling
need `request:hydration`; everything that returns fans' chat refs (filing,
status, list) also needs `read:messages`.

These answers always carry `claim_not_declared` and `capture_floor_unknown` (a
request is a statement about work, not about how far back the store reaches),
so `--fail-on-partial` would turn every one of them into exit 3. Do not use it
here; read `data.request.state` and the counts.

```
hub history-request --page-label lora-1 --fan 438766025723355136 \
  --chat-url https://fansly.com/messages/810272281019305984 \
  --all --reason "spend audit for the July campaign"
hub history-request --page-label lora-1 --file fans.txt --latest 200 \
  --reason "context before outreach" --idempotency-key 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f
hub history-status --request 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f --state blocked
hub history-list --page-label lora-1 --state open
hub history-cancel --request 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f --reason "superseded"
```

`--file` holds one fan per line: an account id, a chat link, or
`conversation:<ref>`, of the `--page-label` page; a line `pageLabel<TAB>fan`
names its own page instead (then `--page-label` is needed only for fans without
one). Blank lines and `#` comments are skipped, and a fan named twice on a page
is sent once. A create answers with the first 200 fans; page the rest with
`hub history-status --cursor` (the create's `delivery.nextCursor` works as is).

You never split a list yourself: when the fans span several pages or one page
has more than 1000 of them, `hub history-request` files one request per page and
per 1000 fans, and its document turns COMPOSITE (`composite.calls`, one result
per request in `data.requests`, exactly as `history-request-batch` prints them
below; with `--idempotency-key` every request derives its own key from it). One
page and at most 1000 fans is one call with the operation's own document.

Two commands are COMPOSITE: several calls of one operation, one document.

```
hub history-request-batch --file pages.tsv --all --reason "Q3 whale review" \
  --idempotency-key 0c6f5e1a-2b3d-4e5f-8a9b-1c2d3e4f5a6b
hub history-status --request 7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f --wait --poll-seconds 60
```

- `history-request-batch` reads `pageLabel<TAB>fan` lines, files one request per
  page and per 1000 fans, and prints one result per request (`ok`,
  `disposition`, `request`, or the refusal's metadata with its `hint`). If any
  request was refused it exits 4, and the others are still filed and listed. With
  `--idempotency-key` a re-run files nothing twice: every chunk derives its own
  key from it.
- `history-status --wait` polls, every `--poll-seconds` (at least 15, default
  30; each poll is one call of your budget), until the request is `done` or
  `cancelled` or `--max-wait-seconds` (default 7200) runs out, and prints only the
  last answer with `composite.finished`. A request with a `blocked` fan stays
  open while Fansly keeps refusing that chat, so `finished: false` at the end is
  a normal outcome: read the counts.

## What the sync engine is doing (`hub sync-status`, `hub sync-why`)

The Fansly Sync Engine keeps one queue of work per page and can say why any of
it waits. Two read-only commands show it; both need `read:datasets`:

- `hub sync-status [--page-label]` — per page: the mode (`off`, `shadow`,
  `handover`, `live`), the pause record (the owner's setting, the smallest gap
  between sends over the last hour, sends closer than the setting over the last
  day — the rule says 0), sends in the last hour by class (`urgent`,
  `requests`, `planned`), the queue by class (`runnable`, and `waitingByReason`
  counts), page and resource holds, breakers, quarantined work, and the
  progress of open history requests.
- `hub sync-why --page-label --resource <key> [--subject <id>]` — the open work
  rows of one registry key (or the newest closed one of a named subject), each
  with `waitingReason` / `waitingUntil`, the demand and applied revisions, the
  breaker and the last attempt. For a resource whose subjects are chats or fans
  (`dm-messages.head`, `.catchup`, `.history`, `dm-conversations.find`,
  `.detail`, `dm-live.deletions`, `fan-profiles.probe`) the key also needs
  `read:messages`.

Both answer from the page's journal: what the engine actually asked Fansly and
why the rest waits. Every page the engine runs is `live`; a page that is `off`
(or was left in `shadow`, a mode nothing runs any more) has no actor, so its
queue is empty or waits on `ownership_unconfirmed`. Shadow mode is gone: the
`shadow` block of a page's status is always `null` and `shadow` on a work row
always `false` (the fields stay on the wire only). The waiting reasons are the closed
list above (`not_due`, `pacer`, `class_share`, `page_hold`, `route_budget`,
`route_hold`, `resource_hold`, `subject_breaker`, `blocked_by_vendor`,
`quarantined`, `paused`, `dependency`, `ownership_unconfirmed`, `running`);
`route_hold` is a 429's hold of the route the work reads (until
`waitingUntil`), `route_budget` that route's own pace. Like history progress they are body
fields, and the envelope always carries `capture_floor_unknown` because the
engine's queue is not captured platform data.

```
hub sync-status --page-label lora-1
hub sync-why --page-label lora-1 --resource transactions.head
hub sync-why --page-label lora-1 --resource dm-messages.head --subject 810272281019305984
```

## A chat Fansly stopped serving (`hub thread-availability`)

Fansly can stop serving one chat to one page: the fan blocked the page, or
deleted the account. Every read of that chat then gets Fansly's own error, and
the Fansly Sync Engine keeps an **unavailability episode** of the page and the
chat: `refusing` from the first refusal, `established` at the fifth, after
which the engine stops reading the chat in the background (only a new message
in it asks for one read, not before `retryNotBefore`). Chatters still see the
messages the socket showed, but `hub transcript` (confirmed messages only) stops
growing, and a history request for the chat is refused (`excluded`,
`chat_unavailable`).

`hub thread-availability --page-label <page> --conversation <ref>` reads that
episode for ONE chat. It needs `read:messages`, reads the database only (no
message text, no request to Fansly) and answers the operation's own document
plus a one-line `note` that says what the answer means:

- `data.episode` is the chat's OPEN episode: `state`, `openedAt`,
  `establishedAt`, `lastRefusalAt`, `refusals`, `retryNotBefore`, `ownerNote`
  (`text` and `at`, the owner's own observation) and `cause`.
- **`episode: null` means no open episode is recorded. It is NOT proof that
  Fansly serves the chat**: an episode opens only when a read of the chat is
  refused, so a chat nobody has read since, a chat whose episode ended, and
  every chat of a page the engine does not run (OnlyFans included) all answer
  null.
- `cause` is a likelihood, never a proof: `unchecked` (deleted or blocked,
  nobody checked), `probably_blocked` (the account exists when looked up
  without a login), `probably_deleted` (it does not). Hub has no such check
  yet, so today every episode says `unchecked`.
- A page outside your grant and a conversation ref the page holds no thread
  for are the plane's one static 404 (`code: "not_found"`, exit 4).
- On a hub older than this route the CLI prints `data: null`, the note
  `state unknown: the server has no availability route`, and exits 0: the
  state is unknown, not "served".

```
hub thread-availability --page-label lora-1 --conversation 810272281019305984 --pretty
```

## The CLI

```
hub <command> [flags]
```

### Running it

The CLI is not published; it lives in the hub checkout and runs from source. Two
invocations work on a fresh clone with no extra setup, and both behave the same
from any working directory:

```
# call the bin directly, from anywhere:
node <checkout>/packages/hub-agent-cli/bin/hub.mjs <command>

# or, from inside the checkout:
pnpm hub <command>
```

For a bare `hub` on your PATH, link it once yourself. pnpm does not put a sibling
workspace package's bin in the root `node_modules/.bin`, so nothing does this for
you:

```
ln -s <checkout>/packages/hub-agent-cli/bin/hub.mjs ~/.local/bin/hub
```

On the agency's operator machine the bare `hub` is deliberately NOT a link into
a dev checkout. The CLI validates every response against the contract compiled
into it, strictly, so it must match the DEPLOYED revision, and a checkout is
routinely ahead of or behind production and fails at `capabilities`. The link
points instead at a production-pinned copy, `~/.local/share/hub-agent-cli-prod`
(a `git archive` of exactly the deployed commit, `.source-revision` inside; never
a worktree, since worktree cleanup has deleted one mid-audit).
`scripts/deploy-production.sh` rebuilds that copy at the end of every verified
deploy; `scripts/rebuild-hub-cli-prod.sh <revision>` does the same by hand, and
switches the link only after the new CLI answers `capabilities` with the contract
hash that revision compiles to. The running revision is the
`agency-hub.source-revision` label on the production image.

### Configuration

Auth comes from `HUB_AGENT_KEY`, or from `HUB_AGENT_KEY=...` in
`~/.config/hub/credentials`. The base URL comes from `HUB_BASE_URL` and defaults
to production. The CLI stores nothing and creates nothing.

If you use the credentials file, `chmod 600` it. The CLI refuses to run when that
file is readable by anyone else, and tells you the command to fix it: the file
holds a live bearer token, and the CLI cannot repair a mode on a file it never
created.

Output is exactly one JSON document on stdout, every time, success or failure:

```json
{ "ok": true, "operation": "agentThreads", "exitCode": 0,
  "blockers": ["claim_not_declared"], "data": { } }
```

`blockers` is lifted out of the body on purpose: it is the exit code contract,
and an agent that reads nothing else must still see it. Note that this example
is an ordinary successful call, and `exitCode: 0` next to a non empty `blockers`
is the normal case, not an anomaly. `hub thread-availability` adds a `note`
beside `data`: one line saying what its answer means.

Exit codes. **`0` means the call succeeded, NOT that the answer is complete**:

- `0`: an answer came back. That is all it says. Without `--fail-on-partial` the
  CLI exits `0` even when `blockers` is NON EMPTY, and it is normally non empty
  because `claim_not_declared` fires on every call that declares no claim, so a bare
  `hub threads` exits 0 carrying a blocker. Completeness is read from the
  document, never from the exit code: `blockers`, `capture.planes[].captureFloor`,
  `capture.gaps[]` and `delivery.caveats[]`.
- `3`: an answer came back with a non empty `blockers` AND you passed
  `--fail-on-partial`. That flag is what turns a narrowed answer into a non zero
  exit; without it the same answer is a `0`. Use it in anything automated that
  must not treat a narrowed answer as a full one.
- `4`: no answer. Hub error, refusal, timeout, or a flag this CLI could not use.
  The document carries bounded error metadata: operation, status, code and a short
  message. It deliberately does NOT carry the response body, because a body that
  failed contract validation is exactly the material the schema refused to show
  you.

Global flags: `--base-url`, `--fail-on-partial`, `--pretty`, `--help`.
`hub` with no command, or `hub <command> --help`, prints the usage document
(itself JSON) listing every command and flag.

### Commands

| Command | What it answers |
|---|---|
| `hub capabilities` | What this deployment serves, what YOUR key may read, today's budget, the dataset catalog. Start here. |
| `hub resolve` | A URL, slug, username or native id, turned into fan identities. Try this before concluding a fan does not exist. |
| `hub person` | One fan across every granted page: identity, memberships, threads, money, bounded post-tip attribution, subscriptions. |
| `hub timeline` | One fan's merged timeline across lanes (money, separate post-tip attribution, subscriptions, follows, message refs). |
| `hub threads` | Cross page DM thread inventory with per thread capture bounds. |
| `hub transcript` | The full transcript of ONE thread. Needs `read:messages`; every call is audited. |
| `hub thread-availability` | Whether Fansly stopped serving ONE chat to its page: its open unavailability episode, or null (no open episode recorded, not proof that the chat is served). Needs `read:messages`. |
| `hub search` | Bounded full text search over the message archive. It does not paginate, by design. |
| `hub coverage` | The capture axis on its own: what was ever captured for a scope and window. |
| `hub observations` | Capture journal ENVELOPES (kind, source, timing, sizes). Never payload bodies. |
| `hub dataset` | A typed query over one registered dataset for one page. |
| `hub history-request` | File a history request: fans of one page and a depth; more than 1000 fans or several pages are split into one request per page and 1000 fans. Pages on the Fansly Sync Engine only; elsewhere 409 with the hydration fallback. |
| `hub history-request-batch` | COMPOSITE: history requests from a `pageLabel<TAB>fan` list, one per page and 1000 fans. |
| `hub history-status` | One history request: counts, reads, ETA, why it waits, a page of its fans. `--wait` (COMPOSITE) polls until it ends. |
| `hub history-cancel` | Cancel a history request; loaded messages stay. |
| `hub history-list` | History requests on your pages, newest first, from every requester. |
| `hub sync-status` | The Fansly Sync Engine's status of your pages: pause record, sends by class, queue by why it waits, holds. |
| `hub sync-why` | Why a page's engine work of one resource (and subject) is waiting. |

Two operations are deliberately absent: observation PAYLOADS and hydration
DECISIONS are owner only. Your key cannot reach them, and a command for them would
only produce a confident 401. Filing and polling a hydration request are not
absent by design: they exist on the API (above) and simply have no `hub`
command yet.

Every window is `[from, to)` and BOTH bounds are required: `timeline`,
`transcript`, `coverage`, `observations`, `dataset` and `search` all refuse with
a 400 when one is missing, because no operation here substitutes a silent
default, and "asked about January, got last quarter, got nothing" is the original
incident. The single exception is `threads`, which takes no window at all. The
one case where you send neither bound is a `--cursor`, which carries the window
it was minted with; resending any scope flag next to a cursor is a 400.
Timestamps are RFC 3339 with an explicit offset (`2026-01-01T00:00:00Z`).

### Working shapes

Start every investigation by learning what you hold:

```
hub capabilities --pretty
```

Find the fan without knowing which key you have:

```
hub resolve --input "https://fansly.com/rickd" --pretty
```

Ask the capture question before the data question, when the answer will hinge on
a date range:

```
hub coverage --person-platform fansly --person-user 438766025723355136 \
  --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --pretty
```

Read a thread, deleted messages included (that is the default, because a deleted
message is a fact of the investigation). Both window bounds are required:

```
hub transcript --page-label lora-2 --conversation 810272281019305984 \
  --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z \
  --limit 200 --claim-field textPlain
```

Continue a traversal. Send the cursor and NOTHING else: the cursor carries the
window and the filters, and resending them is an error. The value is the opaque
string from `delivery.nextCursor` of the previous response, copied verbatim:

```
hub threads --cursor c2NvcGU6bG9yYS0yOjgxMDI3MjI4MTAxOTMwNTk4NA
```

Query a dataset. Field names are the dataset's OWN wire names (`hub
capabilities` prints them per dataset; the transactions dataset has
`transactionType` and `grossMills`, not `type` and `amountMills`, and a field
outside the allowlist is a 400 before any SQL runs). Filters are
`field:op[:value]`; a JSON value is parsed as JSON, so `in` takes an array:

```
hub dataset --page-label lora-2 --dataset transactions \
  --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z \
  --filter 'transactionType:in:["tip","message_purchase"]' \
  --filter grossMills:gte:1000 \
  --sort occurredAt:desc --limit 100
```

For OnlyFans subscription activity, choose the grain explicitly. `subscriptions`
is the mutable one-row-per-fan relationship snapshot; its window and default sort
use `startedAt`, so it cannot represent a renewal or a later return as another row.
`subscription_events` reads the already-stored `subscription.started` and
`subscription.renewed` facts from `domain_events`, windows them by `occurredAt`,
and returns `phase`, the provider's nullable `subType`, and a nullable `fanId`:

```
hub dataset --page-label lora-vip-of --dataset subscription_events \
  --from 2026-08-11T00:00:00Z --to 2026-08-19T00:00:00Z \
  --sort occurredAt:desc --limit 200
```

These are events Hub actually stored, not a completeness proof and not the
OnlyFans aggregate metric. `phase` preserves the webhook event type, so a
returning subscriber remains `phase=renewed`. When the business question is the
OnlyFans new/return cohort, count `phase=started` plus
`phase=renewed, subType=returning_subscriber`; do not discard the latter or
rewrite the stored phase. `fanId` is returned only when the stored event identity
still resolves to a fan of that page. Legacy v3 events that accidentally stored
the creator id, and identities removed by erasure, keep their event row but expose
`fanId=null`; the read path never rehydrates identity from raw capture payloads.
Read the `domain_events` plane floor and blockers before reporting an absence or
a total.

`transactions.relatedMessageRef` is a legacy, misnamed compatibility alias for
the provider's generic correlation key. It is NOT proof of a related message;
use `correlationRef` in new work.

To read tip money and exact captured conversation/note context in one row, use
`tip_transactions`. It starts from every active ledger tip on both platforms,
then left-joins context by the exact provider tip id. It requires all three
capabilities: `read:datasets`, `read:money`, and `read:messages`; successful
reads are audited because `tipMessageText` is provider-verbatim fan copy:

```
hub dataset --page-label lora-1 --dataset tip_transactions \
  --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z \
  --filter correlationRef:eq:TIP_ID \
  --claim-field grossMills --claim-field contextState \
  --claim-field capturedConversationRef --claim-field tipMessageText --pretty
```

`contextState=captured` means the exact sidecar exists. On a captured row, a
null note is `source_did_not_provide`, while a supplied empty string is
`observed_empty`. `contextState=not_captured` keeps the tip row visible and marks
`capturedConversationRef` and `tipMessageText` as `not_captured`; OnlyFans uses
this state because its context lane is not implemented. An eligible Fansly tip
without context also emits `internal_capture_gap` even if filters remove that
row, or no claim fields were declared, so an empty note-filter result cannot prove
that no notes exist. Follow its `recapture` remedy. Retained-raw backfill may
close some historical gaps, but cannot recover a DM page that was never retained.
There is deliberately no message ref: conversation membership is not message
identity.

Creator posts use the same operation and command; there is no second posts API.
The row carries `postRef`, verbatim `postText`, `publishedAt`, observation bounds
and `attachmentCount`. Because the text is verbatim, the key needs BOTH
`read:datasets` and `read:messages`, and every successful read is audited. List a
page's posts newest first:

```
hub dataset --page-label lora-2 --dataset posts \
  --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z \
  --sort publishedAt:desc --limit 100 \
  --claim-field postRef --claim-field postText
```

Read one known post through an exact registry filter:

```
hub dataset --page-label lora-2 --dataset posts \
  --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z \
  --filter postRef:eq:post-42 --claim-field postText
```

Post monetization has two deliberately separate temporal axes. The current
one-row-per-post snapshot keeps `publishedAt` as its window column. To answer
"what does Hub currently hold under post X", use a broad publication window
and the exact post ref; `publishedAt` and `lastObservedAt` are both filterable,
but the latter is observation time, not money time:

```
hub dataset --page-label lora-1 --dataset post_monetization \
  --from 2025-01-01T00:00:00Z --to 2027-01-01T00:00:00Z \
  --filter postRef:eq:POST_REF \
  --claim-field postTipTotalMills --claim-field tipGoalRef \
  --claim-field lastObservedAt --pretty
```

Ordinary Fansly posts capture runs every six hours and revisits posts published
inside a frozen 14-day horizon, continuing past the previous head and capturing
one wholly older boundary page. This catches late tips during a normal campaign,
but it is not permanent refresh for every historical post. For a post older
than that horizon, use `lastObservedAt` to qualify the snapshot as point-in-time;
do not call its current counter or goal live without newer evidence.

Individual captured tips use their own `postTipOccurredAt` window. A non-null
`postTipGoalRef` is exact type-7100 target evidence. A null ref is unattributed:
Fansly's live flat `/tips` item proves the post but supplies no per-tip goal
discriminator, so its row `fieldStates.postTipGoalRef` is
`source_did_not_provide`, never `observed_empty`. `postTipMessageText` is
provider-verbatim fan copy, so this whole dataset needs `read:datasets` +
`read:money` + `read:messages` and every successful read is audited:

```
hub dataset --page-label lora-1 --dataset post_tips \
  --from 2026-07-27T00:00:00Z --to 2026-08-02T00:00:00Z \
  --filter postTipPostRef:eq:POST_REF \
  --sort postTipOccurredAt:asc --limit 200 \
  --claim-field postTipAmountMills --claim-field postTipGoalRef \
  --claim-field postTipMessageText --pretty
```

`tip_goals` is the aggregation surface: it returns one deterministic latest
row per shared `tipGoalRef` plus `linkedPostCount`. Do not sum repeated
`tipGoalCurrentMills` values from `post_monetization`.

The sum of `post_tips` rows is NOT required to equal `postTipTotalMills`.
Fansly's snapshot total includes `attachmentTipAmountMills` (tips targeting
replies/attachments), while `/tips?targetIds=<post>` may not return a row whose
actual target was that reply. Report the captured rows and any difference;
never fill it by inference. On every post-tip read, treat `parse_debt` or
`rejected_rows` in `capture.gaps` as a blocker and follow the local-replay
remedy. Person/timeline expose attribution separately from `money` so the same
payment is never added twice; verbatim tip messages remain dataset-only.

V1 has no post full-text search. Do not imitate one with `contains` or ILIKE;
those operators are deliberately absent. `hub capabilities` reports the global
posts capture state as `unknown` because collectors roll out per page. The
page-scoped response's `creator_posts.captureFloor`, gaps and blockers are the
evidence to use for that page. A `before_capture_floor` gap has remedy
`none: journal_before_capture_start`: after the one-time retained-history walk,
ordinary collection only revisits the rolling horizon, so simply running it
again cannot prove history from before the recorded floor.

For a page total, do NOT paginate and add row responses. Ask the same operation
for one summary. It returns no `items`; `summary.groups[]` keeps currencies
separate and gives `transactionCount`, `grossMills`, `netMills` and nullable
`feeMills` over every matching transaction row in the one Hub snapshot:

```
hub dataset --page-label lora-1 --dataset transactions \
  --from 2026-07-01T00:00:00Z --to 2026-08-01T00:00:00Z \
  --summary
```

The wording boundary is literal: `summary.basis` is
`matching_rows_in_hub`. Report «Hub хранит X за июль», never «на платформе было
ровно X». This mode computes a windowless page transaction floor and needs no
cursor; thread hydration has no bearing on it.

### The Fansly statistics, catalogue and money datasets (endpoints-cover)

Thirteen datasets landed with WP-S1, over what the F1–F7 and F4 capture lanes
write. **All thirteen are Fansly-only.** On an OnlyFans page they answer empty
forever, and `hub capabilities` says so per dataset — check `platforms` before
you conclude anything from a zero.

| dataset | what it answers | capabilities |
|---|---|---|
| `traffic_daily` | profile and account-media traffic per bucket, by raw source code | `read:datasets` |
| `media_stats` | one media's buckets with its catalogue head and sale figures | `+ read:money` |
| `top_media` | what Fansly ranked over a window | `read:datasets` |
| `top_tags` | this page's top FYP tags per window | `read:datasets` |
| `revenue_mix` | the platform's own daily earnings breakdown by type code | `+ read:money` |
| `message_media_sales` | what was offered and bought in DMs | `+ read:money + read:messages` |
| `comments` | reply bodies over the attempted back catalogue | `+ read:money + read:messages` |
| `likes` | liker identity — **empty on Fansly**, see below | `read:datasets` |
| `vault_media` | album ↔ raw-media membership (`mediaRef`); optional `mediaOfferRef`, both vaults | `read:datasets` |
| `notifications` | every notification row, every code, verbatim | `read:datasets` |
| `subscription_tiers` | one row per PLAN: the price truth, not the tier base | `+ read:money` |
| `payouts` | payout requests with masked methods | `+ read:money` |
| `capture_coverage` | how far back each plane reaches, as data | `read:datasets` |

**OnlyFans payouts live elsewhere.** `payouts` above is Fansly's. For an
OnlyFans page read `ofapi_payout_requests` (`+ read:money`, claim field
`ofapiPayoutRequest`): one row per invoice as OnlyFans lists it, latest
observation wins (`state` moves from `new` to its final value), with
`amountMills`, `currency`, `state`, `rejectReason` and `requestedAt`. The
scheduled read takes only the newest 50 requests per run; its `captureFloor` is
the oldest request Hub holds, and anything earlier is "Hub holds no record",
never "OnlyFans paid nothing".

Two names moved. `purchase_history` is **gone from the catalog entirely** — it
was never a dataset, only a sync-stream name with no serving table, and
`message_media_sales` is what answers the question it stood for. `fan_earnings`
is still planned and still has no serving projection.

**The scope-pairing rule.** `message_media_sales` requires `read:messages` AND
`read:money` together, and refusing one refuses the query. A row saying "this
fan bought offer 3 of message X" discloses a conversation as much as a payment:
a buyer identity, or a per-message sale count, IS a purchase disclosure, and
there is no threshold below which it stops being one. `comments` rides the same
capability for the ordinary reason — it hands over prose someone wrote.

**Coverage first, and never read no-rows as zero.** Every one of these datasets
declares the capture planes it reads, so `capture.planes[]` comes back populated
and `captureFloor` is real. Before you report a number from any of them, read
the floor; before you report an ABSENCE, read `capture_coverage` for the same
page. These lanes are flag-gated and page-allowlisted, and the allowlists FAIL
CLOSED (empty = no pages). A page that was never enabled holds nothing, and
nothing is not zero:

```
hub dataset --page-label lora-1 --dataset capture_coverage \
  --from 2026-01-01T00:00:00Z --to 2027-01-01T00:00:00Z \
  --sort updatedAt:desc --limit 100
```

Read `status` in the `(status, acquisition_mode, proof)` vocabulary. Only
`provider_exhausted` means "that is all there is". `window_captured` means one
window was captured and the surface beyond it is unproven. `not_started` and a
missing row are different again — the first is a lane that has never run, the
second is nobody having claimed anything at all.

**`likes` is empty on Fansly, on purpose.** No Fansly like code is
live-confirmed, so the liker lane writes nothing and the catalog reports
`captureState: not_captured`. The dataset exists so the hole has a name: an
omitted dataset and an empty one are indistinguishable to a reader, and only one
of them is honest. Never report "nobody liked this post".

**Raw code + label + mapping version.** Every labelled enum on these datasets is
served three ways, and the RAW CODE is the fact. `sourceCode='44011'` with
`sourceLabel='suggestions_visits'` and `mappingVersion=2`; `typeCode=2010` with
`typeLabel='media'`; `typeCode` on notifications with `typeLabel` and a
`typeConfidence` of `confirmed` or `inferred`. Filter and group on the CODE.
The label is this build's reading of it and has been wrong before — the shipped
notification map was wrong on eight of sixteen codes, including both purchase
events — and a label can change under you when the mapping version bumps.

Two label traps worth naming:

- **One revenue label, two live codes.** `media` is both `2010` (legacy) and
  `2110` (current); the same is true of media sets, tips, locked text, stream
  tickets, subscriptions and referrals, and this ledger reaches back to
  2025-03-06. `typeEra` tells you which half you are holding. Grouping by
  `typeLabel` merges the pair — which is what Fansly's own chart does; grouping
  by `typeCode` keeps them apart. Pick deliberately.
- **A traffic family has two members and they are not the same metric.** Member
  1 (`measure: "visits"`) is the count the creator's widget shows and always
  carries zero interaction time; member 0 (`measure: "dwell"`) carries the dwell
  time with its OWN, differing view count. **Never sum them.** A code whose
  `measure` is null is one this label version cannot name — it is served anyway
  (A1) and must not be folded into a neighbouring family.

**NET is served; GROSS is derived.** Fansly's `saleStats.total` is the
creator's NET share after the platform's 20 % cut, and that is what
`salesNetMills` holds, verbatim. `salesGrossMillsDerived` is computed at read
time (`net / 0.8`) and its name says so. **Never add a net figure to a gross
one** — not across `revenue_mix` (which stores both separately and never derives
one from the other), not between `media_stats` and `transactions`, not anywhere.
When you report a sale, say which basis you are reporting.

**Per-media watch metrics do not exist.** The per-media statistics route serves
seven stat keys and no video fields at all, for a video asset. `media_stats`
therefore has no watch columns rather than always-null ones. The account-level
media datapoints DO carry them, and any average built from those components is
OURS: the platform serves no averages anywhere in this payload, so a figure of
that shape was computed by this system and must be reported as such.

**The dashboard's numbers will not match Fansly's own 30-day widget, and that is
correct.** Fansly leaves the Suggestions visit code (`44011`) out of the
denominator of its 30-day percentages; we count every raw source. The shares
differ; neither is wrong; the raw codes are on every row so either can be
reproduced. This applies to the 30-day view only — the last-24h comparison needs
no adjustment. If someone asks why a number disagrees with the platform page,
this is usually the answer, and the answer is an explanation, not a correction.

### Files and post attachments

`raw_media` identifies a platform file by `(page, mediaRef)` independently of
offers. `filename` is the provider filename; `vault_media.customFilename` is
the album membership label. Duration is milliseconds and `frameRateMilli` is
FPS × 1000. Original dimensions and delivery dimensions have separate fields.
Missing metadata is null. These datasets require `read:messages` because names
and album titles can contain user-written text; signed delivery URLs are absent.

```sh
hub dataset --page-label lora-1 --dataset raw_media --from 2024-01-01T00:00:00Z --to 2026-10-01T00:00:00Z --claim-field rawMedia --pretty
hub dataset --page-label lora-1 --dataset post_attachments --from 2024-01-01T00:00:00Z --to 2026-10-01T00:00:00Z --filter postRef:eq:951216338532048896 --claim-field postAttachment --pretty
hub dataset --page-label lora-1 --dataset vault_media --from 2024-01-01T00:00:00Z --to 2026-10-01T00:00:00Z --claim-field vaultInventory --pretty
```

`post_attachments` expands every slot into its bundle members and explicit
`main`, `offer_preview`, `bundle_preview` roles. Use the returned row `key`;
`(postRef, pos)` alone is not unique. `attachmentIndex` is zero-based; bundle
`memberIndex` is one-based, and direct offers use zero. A preview ref becomes
a media ref only when the corresponding raw file has been observed. Unresolved
relations remain rows with `linkState`; they also produce an internal capture
gap. A resolved platform link is not proof that a particular local file matches.

`vault_media.lastFullWalkAt`, `fullWalkRef`, and `fullWalkObservedCount` describe
the last validated full unfiltered creator-album walk. They are null until one
has finished. `missingSince` means the member was absent from such a walk,
not that the provider deleted the file. Partial, capped, malformed, or interrupted
walks cannot mark membership missing. Unchanged albums are revisited after seven
days within the existing request budgets; this is not a seven-day freshness SLA.

`lastObservedAt` dates source evidence, **not a change-feed position**. Use the
sortable/filterable `rowUpdatedAt` on `posts`, `raw_media`, `post_attachments` and
`vault_media` for routine incremental reads, with an overlap on the saved time.
For joined datasets it is the greatest participating projection write time,
including the file/offer/bundle or album/scan metadata. Keep `from/to` on the full
source history you track; narrowing publication/first-observation dates to the
poll interval would hide old rows repaired today. Use `rowUpdatedAt >= saved time
minus overlap`, sort ascending, follow all cursors and upsert stable keys.

Collect touched post refs from **both** posts and post_attachments. For each,
read and replace the complete current attachment set; an empty set removes old
local attachments. Polling only existing attachment rows misses a post whose last
slot was removed. A timestamp is not a tombstone or a commit sequence: concurrent
long transactions, rebuilds and interrupted pagination need reconciliation.
Traverse complete history initially, after rebuild/recovery and periodically to
repair discrepancies. Neither time overlap nor pagination proves a frozen snapshot
or every intermediate state. Do not infer “never posted” from an empty result.

OnlyFans posts point directly to raw media ids, with its string type preserved
as `providerType`; Fansly numeric `mediaType` is not invented for OF. OF Vault
and stories remain outside this supported surface. `posts.fypFlags` is the raw
Fansly value, not a verified publication label or proof of an FYP impression.

### Budgets and limits

Your key has a daily request budget and a daily row budget, and at most two calls
in flight at once. `hub capabilities` reports today's consumption. A 429 with
`agent_budget_exhausted` means you spent the day's allowance; do not loop on it.
Search and dataset queries are rate limited more tightly than reads.

## Habits that keep you honest

1. Run `hub capabilities` first. Knowing your grant prevents most false negatives.
2. Declare `--claim-field` for whatever your conclusion will rest on.
3. Read `conclusion.blockers` before you read `data`, and never read the exit
   code instead: `0` means the call worked, not that the answer is whole.
4. Quote `capture.planes[].captureFloor` for the plane your answer rests on (or
   the item's own `captureFloor`) whenever you report an absence over a date
   range. There is no top level `capture.captureFloor` to quote.
5. Use `--fail-on-partial` in anything automated.
6. When a plane says `not_read`, say so in your answer rather than reasoning past
   it.
7. Never write "nothing happened before DATE". Write "this system holds nothing
   before DATE". They are different claims and only one of them is checkable.
