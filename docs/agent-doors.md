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

## Doors by object

| Object | Door | Capability | Notes |
|---|---|---|---|
| People | `GET /api/v1/agent/people` | `read:team` | Who is who: code, kind, role, state, logins, working pages, schedule, Telegram. Pay terms only with `read:pay_terms` (the ledger's key). `?since=` for changes |
| People | `POST /api/v1/agent/people/proposals`, `GET …/proposals` | `propose:people` | A change about a person, or a new person; it waits for the owner. Never pay terms |
| Shifts | `GET /api/v1/agent/team/shift-review` (`hub shift-review`) | `read:team` + `read:money` | «Разбор смены» of one shift on the key's pages and the shift audit's numbers from it. Texts with `read:messages`; the AI's own texts never |
| Shifts and sales | `POST /api/v1/agent/team/sales` | `read:team` + `read:money` | The team's work and every sale on the key's pages in a window (≤ 31 days), with the facts whose a sale is: holders, the bought PPV's sender, post tip, Campaign, last writer, marks, the owner's split |
| Sales (report check) | `POST /api/v1/agent/team/sale-context` (`hub sale-context`) | `read:team` + `read:money` | Each sale's fan, the PPV it bought (its text with `read:messages`), who wrote to the fan in 48 h, 7 days, last in 60 days |
| Sales (chain of money) | `GET /api/v1/agent/team/sale-chain` (`hub sale-chain <id>`) | `read:team` + `read:money` | From one sale: whose it is (home, why, the owner's decision, an open claim), the shift, the report of that day (Hub's version or the ledger's post), accrual and payout as states. Never a pay sum |
| Fans (watch) | `POST /api/v1/agent/team/fan-watch` (`hub fan-watch`) | `read:messages` | A watched fan's new messages on a page since a mark, and when the page last wrote to them. Tips with `read:money` |
| Fans and messages | `hub resolve`, `person`, `timeline`, `threads`, `transcript`, `search` | `read:messages` and others | The read plane: `agent-read-skill.md` |
| Money | `hub dataset` (`transactions`, `fan_spend_*`, …) | `read:datasets` + `read:money` | Typed dataset queries per page |
| Matters | `POST /api/v1/agent/matters`, `…/close`, `…/comment` | `write:matters` | Open, close, comment a matter by its reason key, for a person (by login) or a role. The agent's own kinds only |
| Agent reports | `PUT /api/v1/agent/reports/:slug` (`hub report put`), `GET /api/v1/agent/reports` | `write:reports` | A markdown page people read in the app (`traffic` is Трафик → Сводка) |
| System state | `PUT /api/v1/agent/system/routines`, `PUT …/system/copies` | `write:system_state` | A reporter's whole list of routines and copies, for Система → «Состояние» |
| Content | `hub publication-*`, `post-*`, `media-look`, `vault-album-draft` | `write:publication_drafts`, `approve:*`, `withdraw:publications`, `delete:posts`, `look:media`, `read:content` | `agent-read-skill.md`, «Drafting wall posts» and after |
| Fan queues | `hub queue-*` | `write:fan_queues` | Queues for chatters, on the word of the person who asked |
| Custom orders | `GET/POST /api/v1/agent/custom-orders`, `POST …/custom-orders/:code`, `POST …/custom-orders/cards` (`hub custom list\|create\|step\|cards`) | `write:customs` | Record an order from the card (Gengar's `/tz`), write what the models' group says (at the model, deliveries in parts, revisions, refusals, cancels, messages), report cards with no order. Never a payment or «отдали»: those are people's |
| Shift reports «со слов» | `GET /api/v1/agent/shift-reports/draft`, `GET …/claimable`, `POST …/line`, `…/comment`, `…/off-platform`, `…/submit` (`hub shift-report show\|claimable\|line\|comment\|off-platform\|submit`) | `write:shift_reports` | Gengar's `/smena` fills and hands in the report of a person whose switch «сдаёт смену в системе» is on, from the person's own words: below |
| Shift reports (the ledger's feed) | `GET /api/v1/agent/shift-reports` | `read:team` + `read:money` | Every version handed in, after a cursor: what the ledger accrues and pays from |
| Claims | — | — | No agent door on Hub yet: it comes with its own package. Until then the ledger holds them |
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
| Gengar's report check (`shift-sales-report/report_check.py`) | fan names, the bought PPV, its author and text, writers 7 days, last writer 60 days | `hub sale-context --file sales.json`, sales by Hub's id or by a page's platform transaction id |

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
