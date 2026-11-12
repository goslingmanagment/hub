# Agent doors: what an agent key reaches, by object

An agent is a participant: a person of kind `agent` in the people registry, with its own named key. The key
reaches the pages it was granted and does what its capabilities say; everything it does is audited under the key,
and the key under its agent. This page lists the doors by object. How to read an answer honestly (blockers,
capture, delivery) is `agent-read-skill.md`; the CLI is `hub` (`hub <command> --help`).

## Who this key is

- `hub capabilities` (`GET /api/v1/agent/capabilities`) answers `key.agent`: the agent's `code` and name, or null
  for a service's own key. Start here.
- The owner sees every key with its agent, its rights in words and its last call in Система → «Агенты и ключи».
  A key is issued for an agent (`agentCode`, or `agent-keys:issue --agent <code>` on the server); only a
  service's own key (`signin:*`, `introspect:agent_keys` alone) has none. A key issued before the registry is
  linked on the agent's card, never re-issued.
- An agent holds one live key: its rights and pages change in place (`agent-keys:capabilities`, `agent-keys:pages`).
  A key is replaced without downtime by issuing the new one as its replacement («Выпустить на замену», or
  `agent-keys:replace <name> --name <new>`): the same agent, pages and rights, and the old key works 24 hours more.

## Doors by object

| Object | Door | Capability | Notes |
|---|---|---|---|
| People | `GET /api/v1/agent/people` | `read:team` | Who is who: code, kind, role, state, logins, working pages, schedule, Telegram. Pay terms only with `read:pay_terms` (the ledger's key). `?since=` for changes |
| People | `POST /api/v1/agent/people/proposals`, `GET …/proposals` | `propose:people` | A change about a person, or a new person; it waits for the owner. Never pay terms |
| Shifts | `GET /api/v1/agent/team/shift-review` (`hub shift-review`) | `read:team` + `read:money` | «Разбор смены» of one shift on the key's pages and the shift audit's numbers from it. Texts with `read:messages`; the AI's own texts never |
| Shifts and sales | `POST /api/v1/agent/team/sales` | `read:team` + `read:money` | The team's work and every sale on the key's pages in a window (≤ 31 days), with the facts whose a sale is: holders, the bought PPV's sender, post tip, Campaign, last writer, marks, the owner's split (`resolution`: Hub's active decision when it shares the sale out, a nobody's sale given to a person included) and `decision` (`{kind: split\|nobody\|pot, pot}`: Hub's active decision of any kind) |
| Sales (report check) | `POST /api/v1/agent/team/sale-context` (`hub sale-context`) | `read:team` + `read:money` | Each sale's fan, the PPV it bought (its text with `read:messages`), who wrote to the fan in 48 h, 7 days, last in 60 days; `archive`: the fan's chat as the report check reads the archive (the priced message, the page's messages of 7 days by author, the last author of 60 days) |
| Sales (chain of money) | `GET /api/v1/agent/team/sale-chain` (`hub sale-chain <id>`) | `read:team` + `read:money` | From one sale: whose it is (home, why, the owner's decision, an open claim), the shift, the report of that day (Hub's version or the ledger's post), accrual and payout as states. Never a pay sum |
| Fans (watch) | `POST /api/v1/agent/team/fan-watch` (`hub fan-watch`) | `read:messages` | A watched fan's new messages on a page since a mark (the archive's time, to the microsecond), and when the page last wrote to them. Tips with `read:money` |
| Fans and messages | `hub resolve`, `person`, `timeline`, `threads`, `transcript`, `search` | `read:messages` and others | The read plane: `agent-read-skill.md` |
| Money | `hub dataset` (`transactions`, `fan_spend_*`, …) | `read:datasets` + `read:money` | Typed dataset queries per page |
| Matters | `POST /api/v1/agent/matters`, `…/close`, `…/comment` | `write:matters` | Open, close, comment a matter by its reason key, for a person (by login) or a role. The agent's own kinds only |
| Agent reports | `PUT /api/v1/agent/reports/:slug` (`hub report put`), `GET /api/v1/agent/reports` | `write:reports` | A markdown page people read in the app (`traffic` is Трафик → Сводка) |
| System state | `PUT /api/v1/agent/system/routines`, `PUT …/system/copies` | `write:system_state` | A reporter's whole list of routines and copies, for Система → «Состояние» |
| Content | `hub publication-*`, `post-*`, `media-look`, `vault-album-draft` | `write:publication_drafts`, `approve:*`, `withdraw:publications`, `delete:posts`, `look:media`, `read:content` | `agent-read-skill.md`, «Drafting wall posts» and after |
| Fan queues | `hub queue-*` | `write:fan_queues` | Queues for chatters, on the word of the person who asked |
| Custom orders | `GET/POST /api/v1/agent/custom-orders`, `POST …/custom-orders/:code`, `POST …/custom-orders/cards` (`hub custom list\|create\|step\|cards`) | `write:customs` | Record an order from the card (Gengar's `/tz`), write what the models' group says (at the model, deliveries in parts, revisions, refusals, cancels, messages), report cards with no order. Never a payment or «отдали»: those are people's |
| Shift reports «со слов» | `GET /api/v1/agent/shift-reports/draft`, `GET …/claimable`, `POST …/line`, `…/comment`, `…/off-platform`, `…/submit` (`hub shift-report show\|claimable\|line\|comment\|off-platform\|submit`) | `write:shift_reports` | Gengar's `/smena` fills and hands in the report of a person whose switch «сдаёт смену в системе» is on, from the person's own words: below |
| Shift reports (the ledger's feed) | `GET /api/v1/agent/shift-reports` | `read:team` + `read:money` | Every version handed in, after a cursor (`next`, a place `seq`): what the ledger accrues and pays from. `held` lists the versions held back for the key's pages, on every read until the key may read them; then they come in `reports` at their own older `seq` — take every item of `reports` whatever its seq |
| Erasures (the ledger's feed) | `GET /api/v1/agent/erasures` | `read:team` + `read:money` | Every fan erasure Hub completed, after a cursor: the platform and the fan's ref, for the ledger to blank its own copies: below |
| «Чья продажа» «со слов» | `POST /api/v1/agent/sale-decisions`, `…/cancel`, `…/applied`, `GET …/sale-decisions`; `POST /api/v1/agent/sale-questions`, `…/answer`, `…/close`, `GET …/sale-questions` (`hub sale decide\|cancel\|applied\|decisions\|ask\|answer\|close\|questions`) | `write:shift_reports` (the lists: or `read:team`) | Decisions and questions about whose a sale is, in their one home: below |
| «Чья продажа» (the ledger's feed) | `GET /api/v1/agent/sale-decisions/feed` | `read:money` | Every change of a decision after a cursor, in the order made: what the ledger follows instead of writing its own. Below |
| Claims | `GET /api/v1/agent/sale-claims`, `POST …/sale-claims/answer` | `write:shift_reports` (the list: or `read:team`) | The claims and decisions of a person or a sale; the other side's answer «со слов» |
| Keys (for services) | `POST /api/v1/agent/keys/introspect` | `introspect:agent_keys` | Another service asks who an agent's hub key is: below |

A page outside the key's grant is the plane's static 404, the same as one that does not exist. A session never
gets through any of these doors; an agent key never gets through a session's.

## Shift reports «со слов»

The shift report is one object in Hub with three doors to one service: the person's Workboard, the chat extension,
and this one, for an agent writing the person's words from their Telegram messages (Gengar's `/smena`). The
report is the person's: the agent writes only what the person said in their own message, never what it inferred
itself. A question about whose a sale is goes to the person in words, and only their answer is written.

- `hub shift-report show --sender <their Telegram id>` (or `--person <code>`, `--shift <id>`; without `--shift`
  the person's latest shift): the report as the person sees it. `enabled` is their switch: false means Hub takes
  no words for them and their report goes the old way (the post in «Отчётность»). It also carries the draft's lines
  («Ваши продажи», «Рядом») with the rule's words and the facts behind them, the versions handed in, `posts` (the
  newest version as the post for «Отчётность», one per model) and `colleagues` (whom «делим с…» may name).
  Reading needs no message.
- `hub shift-report claimable --shift <id> --sender <id>`: the sales of the last 7 days the person may add by hand,
  nobody's first.
- `hub shift-report line --shift <id> --sale <transactionId> --statement not_mine|share|mine|rule`: the person's word
  on a sale. «не моё» and «делим с…» (`--share-with` a colleague, by user id or name) go on «Ваши продажи»; «моё»
  (with `--note`, one line of why) goes on «Рядом» or adds a sale from `claimable`; `rule` takes the word back.
- `hub shift-report comment --shift <id> --text "…"`: the comment, the person's text word for word.
- `hub shift-report off-platform --shift <id> --amount <dollars> --from-whom … --what-for …`: «мимо площадки». It
  waits for the owner and is never in the sums before the owner confirms it.
- `hub shift-report submit --shift <id> --sender <id> --message <link>`: hands the shift in as its next version,
  door `telegram`, with the message and its sender recorded. It never goes without both. A shift still going can be
  handed in, and a later hand-in is the next version.

Every write carries `--sender`, the Telegram id of the message's sender, which must be the person's in the people
registry, and preferably `--message`, the message itself. The refusals, as `hub` prints them (`error.reason`,
`error.hint`):

- 403 `forbidden`: the person's switch «сдаёт смену в системе» is off. Nothing is written; their report goes the
  old way. A 403 with another code is a key without `write:shift_reports`.
- 409 `sender_not_person`: the sender is not the person (a colleague's or a lead's message about them included).
- 400 `source_ref_required`: a hand-in without the message. 400 `note_required`, `statement_not_allowed`,
  `share_with_missing`, `share_with_unknown`: a word the line does not take; 404 `not_claimable`: a sale that cannot
  be added by hand.
- A day the ledger already paid is not refused: the version is kept and the owner gets the matter «Отчёт смены
  после выплаты». The agent's answer does not say whether the day was paid.

What stays the ledger's: accrued and paid. The ledger reads every handed-in version itself from its feed
(`GET /api/v1/agent/shift-reports`); nothing about a shift handed in here is saved to the ledger another way. A
person whose switch is off reports exactly as before.

## Erasures: the ledger's own copies

A fan's erasure in Hub (`erasure:run --scope fan`, the owner's act) clears Hub's rows; the ledger keeps its own
copies of what Hub served it — the report lines' notes, «мимо площадки», the comments, the old decisions' and
questions' words, its sales' payloads — which Hub cannot reach. The ledger reads the erasures and blanks them itself.

`GET /api/v1/agent/erasures?since=<next>&limit=<1..500, 200>` (`read:team` + `read:money`, the capabilities of the
ledger's key for its shift reports' feed):

```json
{ "erasures": [{ "id": 41, "platform": "fansly", "fanRef": "123456789", "erasedAt": "2026-11-12T18:00:00.000Z" }],
  "next": "41", "serverNow": "2026-11-12T18:05:00.000Z" }
```

- `id` is the erasure's tombstone in Hub (`erasure_log`) and the cursor; `fanRef` is the fan's platform id as the
  fan scope named him (`fan:<platform>:<ref>`). That is everything the tombstone keeps of him, and everything served:
  no name, and no list of his sales — Hub's anonymized sales are not tied back to him anywhere, and a list here would
  tie them again. The ledger finds his sales by the fan id its own sales carry.
- Served once the erasure completed. Dry runs, unfinished executions and page and model scopes are never served.
  Erasures run one at a time under one lock, so they complete in the order of their ids: `next` never passes one
  not served yet. Keep `next` and ask again with it; nothing new answers the same `next`.
- An erasure none of whose pages is in the key's grant is left out, and `next` moves past it.
- After Hub's database is restored from a copy, the erasures since the copy are re-run there and get new ids, and
  Hub's ids start again from the copy's: `docs/runbooks/business-backup.md`, «Restoring for real».

## «Чья продажа» «со слов»: decisions and questions

Hub is the one home of the decisions about whose a sale is and of the questions about it (review R2b-3): the owner's
decisions of disputes, the ones carried over from the ledger, and what the team's chat agent records «со слов». The
ledger's own writers (`ledger decision add|applied|cancel`, `ledger question add|answer|drop`, `ledger accruals
claim|unclaim`) close after the switch and point here. Every write names the Telegram message and its sender
(`--sender <id> --message <link>`); the person codes are the people registry's (the same as the ledger's).

What the agent ran in the ledger, and what it runs now:

| Was | Now |
|---|---|
| `ledger decision add --page P --fan-ref R --kind owner --share C:100 --said-by W --said-at D --note N` | `hub sale decide --sale <Hub id> --kind owner --share C --said-by W --said-at D --note N --sender S --message M` |
| … `--kind split --share A:50 --share B:50` | `hub sale decide … --kind split --share A:50 --share B:50 …` |
| … `--kind pot --pot <slug>` | `hub sale decide … --kind pot --pot <slug> …` (Hub's pot name is the ledger's pot slug, `ledger pot list`) |
| … `--kind exclude` | `hub sale decide … --kind exclude …` |
| … `--kind off_platform --share C:100` | `hub sale decide --page P --kind off_platform --share C --net <mills> …` (no sale) |
| a sale not named yet (fan, page, time) | `hub sale decide --page P --fan <id or login> --at <ISO time> --net <mills> …`: the owner ties it later («привязать») |
| `--supersedes N`, `--answers Q` | the same flags |
| `ledger decision cancel N --note …` | `hub sale cancel N --note … --sender S --message M` |
| `ledger decision applied N --person C --date D` | `hub sale applied N --person C --date D` (a post-based report only; a report handed in Hub follows by itself) |
| `ledger decision list --open --md` | `hub sale decisions --open --md \| jq -r .data.markdown` (the same information; no fan's name copied: the fan as Hub knows it) |
| `ledger question add --page P … --asked-of owner\|chatters --who W --question Q --note N` | `hub sale ask --sale <id> (or --page P --fan R …) --of owner\|chatters --who W [--person A --person B] --question Q --note N --asked-at D --sender S --message M` |
| `ledger question answer Q --answer …` | `hub sale answer Q --answer … --sender S --message M` |
| `ledger question drop Q --note …` | `hub sale close Q --note … --sender S --message M` |
| `ledger question list --open --md` | `hub sale questions --open --md \| jq -r .data.markdown` |

What a decision does:

- A sale Hub knows (`--sale`, or `--page` with `--ref` the platform's transaction id): exactly the owner's decision of
  a dispute. Every report handed in Hub that holds the sale gets a new version with what the decision gives its
  person (settled; the person's later hand-ins keep it), the sale's open claims and questions are decided with it,
  their matters close, the home is computed again. The ledger's facts carry it (`resolution`, `decision`). A sale with
  an active decision refuses a second one without `--supersedes <№>` (409 `decision_exists`).
- A sale not named yet: kept with the words that will find it, in the owner's «привязать» list.
- `off_platform`: money outside the platform; no sale and no home. The person adds it to a report handed in Hub
  as «мимо площадки» (`hub shift-report off-platform`); a post-based report takes it from the list.
- A pot (`--kind pot`): Hub records whose it is («в общак <pot>»), the home follows. **Until the ledger's pots
  follow Hub's homes, the pot's bookkeeping stays the ledger's: for a pot sale run both** `hub sale decide --kind pot
  --pot <slug> …` (whose it is) **and** `ledger pot add-sale <slug> …` (the pot's money), as today.

A question asked of the owner reaches the owner as a dispute, titled by page, amount, day and people (never the
fan). One asked of the chatters waits for their answer and opens no matter; carried over from the ledger and never
answered, it stays the owner's, titled «Вопрос чаттерам без ответа с <день>: …». Refusals: 400 `bad_decision` (the
kind's rules), 400 `person_unknown`, 404 a sale or page outside the key's grant, 409 `decision_exists`,
`not_active`, `question_closed`.

### The ledger's feed of decisions

`GET /api/v1/agent/sale-decisions/feed?since=<next>&limit=<1..500>` (`read:money`): every change of a decision
about whose a sale is, from every writer (the owner's dispute, this door, the import, a link, a cancel), in the
order the feed placed it. A change is placed when the feed first finds it committed, after every place given
before, so a change committed late comes after the cursor and is never passed (the mechanism of the shift reports'
feed). The answer:

```
{
  "changes": [{
    "seq": 41,                      // its place; the cursor
    "change": "made",               // made | superseded | cancelled | linked | applied | changed
    "at": "2026-11-12T18:20:00.000Z",
    "decision": {                   // the decision as it is now: apply in order, keep by id
      "id": 12, "transactionId": 7744520, "pageLabel": "mia-1",
      "kind": "owner",              // owner | split | pot | off_platform | exclude
      "shares": [{ "person": "anna", "userId": 6, "percent": 100 }],
      "pot": null,                  // kind pot: the pot's name = the ledger's pot slug
      "outcome": "said",            // first | second | half | nobody | imported | said
      "ruleHome": "shift",
      "state": "active",            // active | superseded | cancelled
      "source": "agent",            // dispute | ledger | agent
      "saidBy": "владелец", "saidAt": "2026-11-12T09:00:00.000Z", "decidedAt": "…",
      "note": "…",                  // the reasoning, as the ledger shows it with a line's agreement
      "applied": null,              // { "person": "anna", "reportDate": "2026-11-12" } — taken into a post
      "ledgerDecisionId": null      // the ledger's number of one carried over from it
    }
  }],
  "held": [{ "seq": 44, "decisionId": 15, "pageLabel": "nova-1", "reason": "page_outside_key" }],
  "next": "43",
  "serverNow": "…"
}
```

No fan's name: the sale by Hub's id and its page. A change of a decision on a page outside the key's pages is
listed in `held` on every read until the key may read it; then it comes in `changes` at its own older `seq` — take
every item whatever its seq. What the ledger takes from it: a pot's sale (kind `pot`), a nobody's sale given to a
person (`owner`, `split` on a sale whose `ruleHome` was `nobody`), a report line's agreement (kind, shares, state,
`saidBy`, `note`).

## «Кто этот ключ»: another service accepts a hub key

For ledger, ContentOps and TaskIndex, which accept `Authorization: Bearer <hub agent key>` next to their own keys.

1. The agent sends the service its hub key as the bearer.
2. The service computes `sha256(key)` as lowercase hex (the digest Hub stores) and sends ONLY that:
   `POST /api/v1/agent/keys/introspect` with `{"keyDigest": "<64 hex>"}`, as the bearer of the service's OWN hub
   key holding `introspect:agent_keys`. Never the agent's key: a raw key in the body is a 400.
3. Hub answers `{"active": true, "agent": {"code", "displayName"}, "expiresAt", "cacheSeconds": 60,
   "staleSeconds": 3600}` or `{"active": false, "cacheSeconds": 60, "staleSeconds": 3600}`. Inactive is the same
   for an unknown digest, a revoked or expired key, a key no agent holds and an agent who left: it tells a
   digest's holder nothing it did not know. No key, digest, prefix, capability or page ever comes back.
4. The service maps `agent.code` to its own rights in its own table and audits the call under that code.
5. Cache: an answer holds 60 s (`Cache-Control: private, max-age=60, stale-if-error=3600`). When Hub cannot be
   reached (a deploy, an outage), the service keeps its last ACTIVE answer for up to an hour after it was fetched,
   then refuses clearly. An inactive answer is never extended; a 4xx from Hub is an answer, not an outage.
6. The service never logs or stores the agent's key or its digest beyond its cache key. Introspection is a read:
   the presented key's last use and expiry at Hub do not move.

What this does and does not protect. Hub never hands a service a working key or anything a key could be made of,
and a service's own key cannot be used to find keys it was not shown (a digest is 256 bits and only confirms a key
already in hand). A service that agents call still sees their keys as they arrive: keep the number of services
that accept hub keys small, give each its own key, and revoke an agent's key at Hub when a service is in doubt —
every service sees it within a minute (within the hour while Hub cannot be reached).

## The ready reads that replace `ssh … psql`

| Script | Read before | Door now |
|---|---|---|
| `/OS scripts/shift_audit.py collect` | messages, threads, follows, subscriptions, automated messages, broadcasts, AI events, activity minutes of the shift, over psql; money over `hub dataset` | `hub shift-review --person <code> --at <ISO>`: `review` (the shift, its pages, chats with messages, waits, sales, follows, AI by page and chat) and `numbers` |
| Gengar's fan watch (`work/watch-fan/watch.py`) | the fan's messages after a mark and the page's last message in that chat | `hub fan-watch --file watches.json`; carry `archivedAt` of the newest message as the next `archivedAfter` |
| Gengar's report check (`shift-sales-report/report_check.py`) | fan names, the bought PPV, its author and text, writers 7 days, last writer 60 days | `hub sale-context --file sales.json`, sales by Hub's id or by a page's platform transaction id; the check's own facts are `archive` (Hub's are `ppv`, `writers7d`, `lastWriter`: they differ, see below) |

`numbers` (by page and in total) carries the audit's `collect` summary: `chats`, `messages` (the audit's `out`),
`fanMessages` (`fan`), `follows`, `followsWritten` (`wrote`), `followsWrittenSoon` (`w30`), `reactivations`
(`react`) and `reactivationsAnswered`, `salesNetMills` (`sales`, the page's money), `tipsNetMills`,
`subscriptionsNetMills`, `ppvSent`, `ppvPurchases` (the page's PPV purchases), `replies`, `replyMedianSeconds`,
`repliesOver15`, `longestReplySeconds`, `waitingAtStart` (`wait_start`), `waitingAtStartWritten` (`ans_start`),
`waitingAtEnd` (`wait_end`), `unauthored`, `others`, `massMessages`, `fanUnattended`, `ai` by feature. Hub's own
rules hold where they differ from the script: the shift is the person's over every page they were active on; a
message is the chatter's by its author on every page; a message deleted a minute or more after it was sent counts
as seen; a mass message is the one of «Смены»; a page's own facts (followers, money) count on the pages the shift
worked. The lists the audit draws (gantt, long waits, backlog, signals, hours) come from `review.chats` and
`review.waits`.

`archive` (the report check) is the archive as `report_check.py` read it over psql, so the check keeps its numbers:
the fan's latest chat on the page by the fan's platform id; in it the page's latest message priced at the sale's
gross and sent at or before it (the check's PPV; Hub's own match is `ppv`, by the bought media or the OnlyFans
unlock), the page's messages of the 7 days before by author with no author counted (`writers7d` counts only reported
sends), and the last message with an author in the 60 days before, by the archive's time (`lastWriter` goes by the
send's report, a minute or so earlier). Deleted messages are left out. Moving the check to Hub's facts changes its
numbers: that is the owner's decision, not this door's.
