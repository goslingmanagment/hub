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

## Declare your claim

Most commands take `--claim-field <name>` (repeatable). Use it. Declaring a claim
tells the hub which fields your conclusion will rest on, and the response then
reports those fields' observability in `capture.scopeFieldStates` BEFORE any row
is fetched. Without a claim you get rows; with a claim you also get whether those
rows could ever have answered you.

## Asking for more data (hydration)

When the record does not reach far enough back, the remedy is hydration: the hub
goes and fetches more from the platform. You never execute that yourself; it is an
owner decision either way.

The response tells you when it is even possible. Look at the `remedy` on the
relevant plane: a kind of `local_replay` or a hydration kind means more data is
reachable. A kind of `none` with reason `no_remedy_exists` or
`discarded_at_capture` means it is not recoverable at all, and no amount of asking
will change that. Say so plainly instead of retrying.

**The request operations exist; this CLI has no command for them.** The API
serves two of them and the `request:hydration` capability is real:

- `POST /api/v1/agent/pages/:pageLabel/threads/:conversationRef/hydration-requests`
  files one. Body: a `target` of kind `thread_backfill_before` with EXACTLY one
  of `beforeAt` / `beforeMessageRef` (a boundary, not a window: "everything in
  this thread older than X"), a `reason`, an optional `maxCalls`, and a UUID
  `idempotencyKey`. It answers **200, not 202**: it records an intent and queues
  nothing. Only an owner decision can spend a vendor call.
- `GET /api/v1/agent/hydration-requests/:requestRef` polls the one you filed.

What each refusal means, so you do not retry the wrong thing:

- **503 `agent_plane_disabled`**: `agentHydrationMode` is `off` (or the whole
  plane is). Not your key, not your request: the deployment has not opened this
  door yet. Do not retry; report it.
- **404**: the same static body as a request that never existed. Your key does
  not hold the page, or did not file that request.
- **409 `hydration_not_admissible`**: the plane already told you there is no
  lane for this gap. Check the `remedy` you were given.
- **403 `agent_capability_missing`**: your key lacks `request:hydration`. Note
  that this is the one refusal on the plane that names a missing CAPABILITY; a
  page you were not granted, or a request that is not yours, is always the
  indistinguishable 404 above.

**Who decides your request (decision #201).** A Fansly `thread_backfill_before`
request may be approved by a versioned in-kernel policy instead of a human,
within a daily call budget: your request's `decision.decisionSource` says which
(`auto_policy` | `owner`), and an auto-approved run usually executes within a
couple of minutes. What this means for how you file:

- always state an explicit `maxCalls`, and keep it ≤ 40 (one full targeted run,
  ~1000 messages) — the policy clamps to 40 and NEVER widens what you asked;
- anything the policy may not decide — OnlyFans, over the day's budget, over
  the cap — simply STAYS `requested` for the owner. Do not refile it under a
  fresh UUID: one live approval per page and one auto-run per conversation per
  UTC day are enforced, so the duplicate just parks;
- `completed` is not "the whole history": re-read the capture floor and decide
  whether another bounded request is worth filing.

Since `hub` has no command for it, from this CLI the useful half is still yours
to do by hand: report the specific gap (page, thread, conversation ref, window,
and the `remedy` the response carried) and hand it to the owner, who can run the
backfill directly. That report IS the request.

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
is the normal case, not an anomaly.

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
| `hub search` | Bounded full text search over the message archive. It does not paginate, by design. |
| `hub coverage` | The capture axis on its own: what was ever captured for a scope and window. |
| `hub observations` | Capture journal ENVELOPES (kind, source, timing, sizes). Never payload bodies. |
| `hub dataset` | A typed query over one registered dataset for one page. |

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
