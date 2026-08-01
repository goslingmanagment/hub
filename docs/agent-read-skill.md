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

Every response carries `conclusion.blockers`, a list of every reason this answer
is narrower than the question you asked. When it is empty, you read everything the
question covered. When it is not empty, you did not, and each entry names why.

Report what you found AND what the blockers said. "No transactions in the window"
is a claim about the world. "No transactions in the window, and the archive for
this thread begins 2026-07-05, so January was never checked" is the truth.

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
  `not_read`, `not_indexed` or `not_applicable`, with a reason when it was not
  read. A plane that was not read cannot support any conclusion.
- `captureFloor`: when this store's record of the scope BEGINS. Read it as a lower
  bound: "the archive for this thread starts here". It is NOT a statement that
  nothing existed earlier. Nothing in this system can say that.
- `gaps[]`: named holes. The one you will meet most is
  `before_capture_floor`, which means your window starts earlier than the record
  does.
- `sourceErrors[]`: a source that failed during this read. Any entry here means
  the answer is provisional.
- `scopeNarrowing`: your key was granted fewer pages than the question spanned.

**`fieldStates`** is about ONE FIELD on ONE RECORD, plus `capture.scopeFieldStates`
for the scope as a whole, computed before any row is fetched. A field can be
observed, unobservable on this platform, or not captured. A null that is
`unobservable` is not a null that means zero.

## What to do when blockers are not empty

Read the blocker, then act on it instead of retrying blindly.

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
goes and fetches more from the platform. You cannot execute that yourself. You
file a request, the owner approves or denies it, and the hub executes.

The response tells you when this is possible: look for a `remedy` of kind
`local_replay` or a hydration remedy on the relevant plane. A remedy of kind
`none` with reason `no_remedy_exists` or `discarded_at_capture` means the data is
not recoverable and no amount of asking will change that. Say so plainly instead
of retrying.

Filing a request needs the `request:hydration` capability on your key. If your key
does not have it, ask the owner for a key that does, or hand the owner the
specific gap you found (page, thread, window) and let them run it.

## The CLI

```
hub <command> [flags]
```

Auth comes from `HUB_AGENT_KEY`, or from `HUB_AGENT_KEY=...` in
`~/.config/hub/credentials`. The base URL comes from `HUB_BASE_URL` and defaults
to production. The CLI stores nothing and creates nothing.

Output is exactly one JSON document on stdout, every time, success or failure:

```json
{ "ok": true, "operation": "agentThreads", "exitCode": 0, "blockers": [], "data": { } }
```

Exit codes:

- `0`: an answer came back.
- `3`: an answer came back with a non empty `blockers`, and you passed
  `--fail-on-partial`. Use this flag in scripts that must not treat a narrowed
  answer as a complete one.
- `4`: no answer. Hub error, refusal, timeout, or a flag this CLI could not use.
  The document carries the error.

Global flags: `--base-url`, `--fail-on-partial`, `--pretty`, `--help`.
`hub` with no command, or `hub <command> --help`, prints the usage document
(itself JSON) listing every command and flag.

### Commands

| Command | What it answers |
|---|---|
| `hub capabilities` | What this deployment serves, what YOUR key may read, today's budget, the dataset catalog. Start here. |
| `hub resolve` | A URL, slug, username or native id, turned into fan identities. Try this before concluding a fan does not exist. |
| `hub person` | One fan across every granted page: identity, memberships, threads, money, subscriptions. |
| `hub timeline` | One fan's merged timeline across lanes (money, subscriptions, follows, message refs). |
| `hub threads` | Cross page DM thread inventory with per thread capture bounds. |
| `hub transcript` | The full transcript of ONE thread. Needs `read:messages`; every call is audited. |
| `hub search` | Bounded full text search over the message archive. It does not paginate, by design. |
| `hub coverage` | The capture axis on its own: what was ever captured for a scope and window. |
| `hub observations` | Capture journal ENVELOPES (kind, source, timing, sizes). Never payload bodies. |
| `hub dataset` | A typed query over one registered dataset for one page. |

Two operations are deliberately absent: observation PAYLOADS and hydration
DECISIONS are owner only. Your key cannot reach them, and a command for them would
only produce a confident 401.

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
hub coverage --person-platform fansly --person-user 5791 \
  --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --pretty
```

Read a thread, deleted messages included (that is the default, because a deleted
message is a fact of the investigation):

```
hub transcript --page-label lora-2 --conversation 810272281019305984 \
  --from 2026-01-01T00:00:00Z --limit 200 --claim-field lifetimeSpendMills
```

Continue a traversal. Send the cursor and NOTHING else: the cursor carries the
window and the filters, and resending them is an error:

```
hub threads --cursor "<cursor from delivery.nextCursor>"
```

Query a dataset. Filters are `field:op[:value]`; a JSON value is parsed as JSON,
so `in` takes an array:

```
hub dataset --page-label lora-2 --dataset transactions \
  --filter 'type:in:["tip","message"]' --filter amountMills:gte:1000 \
  --sort occurredAt:desc --limit 100
```

### Budgets and limits

Your key has a daily request budget and a daily row budget, and at most two calls
in flight at once. `hub capabilities` reports today's consumption. A 429 with
`agent_budget_exhausted` means you spent the day's allowance; do not loop on it.
Search and dataset queries are rate limited more tightly than reads.

## Habits that keep you honest

1. Run `hub capabilities` first. Knowing your grant prevents most false negatives.
2. Declare `--claim-field` for whatever your conclusion will rest on.
3. Read `conclusion.blockers` before you read `data`.
4. Quote `captureFloor` whenever you report an absence over a date range.
5. Use `--fail-on-partial` in anything automated.
6. When a plane says `not_read`, say so in your answer rather than reasoning past
   it.
7. Never write "nothing happened before DATE". Write "this system holds nothing
   before DATE". They are different claims and only one of them is checkable.
