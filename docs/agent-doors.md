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
| People | `GET /api/v1/agent/people` (`hub people`) | `read:team` | Who is who: code, kind, role, state, logins, working pages, schedule, Telegram, rights (`rightGrants`: each with when it was granted). Pay terms only with `read:pay_terms` (the ledger's key). `?since=` (`--since`) for changes |
| People | `POST /api/v1/agent/people/proposals`, `GET …/proposals` (`hub people propose\|proposals`) | `propose:people` | A change about a person (their working pages, schedule slot, state, Telegram, any field of the owner's edit), or a new person; it waits for the owner in Hub «Люди», and nothing changes until the owner accepts it. The way to change who works what and when: the registry is the home, not the person's card in the knowledge base. Never pay terms, never an invitation. `proposals` lists the key's own and what became of them |
| Shifts | `GET /api/v1/agent/team/shift-review` (`hub shift-review`) | `read:team` + `read:money` | «Разбор смены» of one shift on the key's pages and the shift audit's numbers from it. Texts with `read:messages`; the AI's own texts never |
| Shifts and sales | `POST /api/v1/agent/team/sales` | `read:team` + `read:money` | The team's work (with optional `personCode` and `reportDate`) and every sale on the key's pages in a window (≤ 31 days), with the facts whose a sale is computed from: holders, the bought PPV's sender, post tip, Campaign, last writer, `marks: []` (kept for backwards compatibility), the owner's split (`resolution`) and `decision` (`{kind: split\|nobody\|pot, pot}`) |
| Sales (report check) | `POST /api/v1/agent/team/sale-context` (`hub sale-context`) | `read:team` + `read:money` | Each sale's fan, the PPV it bought (its text with `read:messages`), who wrote to the fan in 48 h, 7 days, last in 60 days; `archive`: the fan's chat as the report check reads the archive (the priced message, the page's messages of 7 days by author, the last author of 60 days) |
| Sales (chain of money) | `GET /api/v1/agent/team/sale-chain` (`hub sale-chain <id>`) | `read:team` + `read:money` | From one sale: whose it is (home, why, the owner's decision, an open claim), the shift, the report of that day (Hub's version or the ledger's post), accrual and payout as states. Never a pay sum |
| Fans (watch) | `POST /api/v1/agent/team/fan-watch` (`hub fan-watch`) | `read:messages` | A watched fan's new messages on a page since a mark (the archive's time, to the microsecond), and when the page last wrote to them. Tips with `read:money` |
| Fans and messages | `hub resolve`, `person`, `timeline`, `threads`, `transcript`, `search` | `read:messages` and others | The read plane: `agent-read-skill.md` |
| Money | `hub dataset` (`transactions`, `fan_spend_*`, …) | `read:datasets` + `read:money` | Typed dataset queries per page |
| Matters | `POST /api/v1/agent/matters`, `…/close`, `…/comment` | `write:matters` | Open, close, comment a matter by its reason key, for a person (by login) or a role. The agent's own kinds only |
| Agent reports | `PUT /api/v1/agent/reports/:slug` (`hub report put`), `GET /api/v1/agent/reports` | `write:reports` | A markdown page people read in the app (`traffic` is Трафик → Сводка). Section `learn` is Workboard «Обучение»: the owner reads it at once, the team only after he switches «Показывать команде» on for that page (it stays on when the page is republished) |
| System state | `PUT /api/v1/agent/system/routines`, `PUT …/system/copies` | `write:system_state` | A reporter's whole list of routines and copies, for Система → «Состояние» |
| Content | `hub publication-*`, `post-*`, `media-look`, `vault-album-draft` | `write:publication_drafts`, `approve:*`, `withdraw:publications`, `delete:posts`, `look:media`, `read:content` | `agent-read-skill.md`, «Drafting wall posts» and after |
| Fan queues | `hub queue-*` | `write:fan_queues` | Queues for chatters, on the word of the person who asked |
| Custom orders | `GET/POST /api/v1/agent/custom-orders`, `POST …/custom-orders/:code`, `POST …/custom-orders/cards` (`hub custom list\|create\|step\|cards`) | `write:customs`; a payment `+ read:money`; «отдан», the fan, «where is it» `+ read:messages` | Record an order from the card (Gengar's `/tz`) with its price, its taker and the sales that paid it, write what the models' group says (at the model, deliveries in parts, revisions, refusals, cancels, messages, the deadline, an issue), report cards with no order. The agent names sales and messages Hub already holds; Hub verifies each; a person can undo it, and the undo is remembered: below |
| Custom orders on a person's word | `POST …/custom-orders/:code` `{action: "board"}`, `POST /api/v1/agent/custom-findings/:findingId` (`hub custom board\|finding`) | `write:customs` + `read:messages` | Any step of Workboard «Кастомы», and a finding's answer, as the person who asked takes it there (`onBehalfOf` + `requestRef`): below |
| Custom orders: what changed | `GET /api/v1/agent/custom-orders/events?after=` (`hub custom events`) | `write:customs` + `read:messages` | The orders' history and people's answers to findings on the key's pages after a cursor, the oldest first: below |
| Custom orders (findings) | `POST /api/v1/agent/custom-findings` (`hub custom findings post\|dismiss`) | `write:customs` + `read:money` + `read:messages` | A trace of a custom with no order the reader found, or a candidate it read as no custom: below |
| Shift reports «со слов» | `GET /api/v1/agent/shift-reports/draft`, `GET …/claimable`, `POST …/line`, `…/comment`, `…/off-platform`, `…/submit` (`hub shift-report show\|claimable\|line\|comment\|off-platform\|submit`) | `write:shift_reports` | Gengar's `/smena` fills and hands in the report of a person whose switch «сдаёт смену в системе» is on, from the person's own words: below |
| Shift reports (Gengar's check) | `GET /api/v1/agent/shift-reports/checks`, `POST …/checks/:candidateId` | `review:shift_reports` | The candidates handed in and waiting for the check (`checks`), on the key's pages and of its realm; the answer «замечаний нет» or proposals, never a confirmation. `awaitingConfirm`: the reports standing in «Подтвердите» — shift, candidate, person's code and name, pages, `startedAt`, `confirmSince` (when it entered «Подтвердите» for its current candidate): what the reminder «Отчёт не подтверждён сутки» reads |
| Shift reports (the ledger's feed) | `GET /api/v1/agent/shift-reports` | `read:team` + `read:money` | Every version handed in, after a cursor (`next`, a place `seq`): what the ledger accrues and pays from. `held` lists the versions held back for the key's pages on every read until the key may read them; then each gets a new place at the end of the feed and comes in `reports` through the cursor. How to read it: below |
| Erasures (the ledger's feed) | `GET /api/v1/agent/erasures` | `read:team` + `read:money` | Every fan erasure Hub completed, after a cursor: the platform and the fan's ref, for the ledger to blank its own copies: below |
| «Чья продажа» «со слов» | `POST /api/v1/agent/sale-decisions`, `…/cancel`, `…/applied`, `GET …/sale-decisions`; `POST /api/v1/agent/sale-questions`, `…/answer`, `…/close`, `GET …/sale-questions` (`hub sale decide\|cancel\|applied\|decisions\|ask\|answer\|close\|questions`) | `write:shift_reports` (the lists: or `read:team`) | Decisions and questions about whose a sale is, in their one home: below |
| «Чья продажа» (the ledger's feed) | `GET /api/v1/agent/sale-decisions/feed` | `read:money` | Every change of a decision after a cursor, in the order made: what the ledger follows instead of writing its own. Below |
| Computed sale homes (the ledger's feed) | `GET /api/v1/agent/sale-homes/feed` | `read:money` | Every change (`upsert` or `retract`) of `sale_homes` after a cursor, with `personCode`, `reportDate`, and `daySource` on every share. Test realm filtered before `held`. Below |
| Pot distributions (the ledger's feed, K2) | `GET /api/v1/agent/pot-distributions/feed` | `read:money` | Every posted or reversed Workboard pot distribution after a cursor (`changes`, `held`, `next`, `more`, `serverNow`), in base mills. Test realm filtered before `held`. Below |
| Claims | `GET /api/v1/agent/sale-claims`, `POST …/sale-claims/answer` | `write:shift_reports` (the list: or `read:team`) | The claims and decisions of a person or a sale; the other side's answer «со слов» |
| Keys (for services) | `POST /api/v1/agent/keys/introspect` | `introspect:agent_keys` | Another service asks who an agent's hub key is: below |

A page outside the key's grant is the plane's static 404, the same as one that does not exist. A session never
gets through any of these doors; an agent key never gets through a session's.

**Not an agent door: the person door.** `/api/v1/person/*` (`services/person-door.ts`) is ContentOps' server acting
AS the person signed in there (its key `signin:contentops` plus that person's live sign-in grant): ContentOps' own
screens «Публикации», «Статистика» and «Съёмка» (custom orders' shooting steps). The rights are the person's, every
change is recorded as the person's. No agent calls it. Hub has no screens of publications or content statistics any
more (their old addresses lead into ContentOps); an agent's own publication door is unchanged: `hub publication-*`,
`/api/v1/agent/publications…`, `/api/v1/agent/pages/:pageLabel/publication…`, by its capabilities.

**The test realm.** The test team on production (the model «Тест», pages `test-1` and `test-of` and the stand-ins
`test-<liveLabel>` of live pages, people `t-*`) is behind a wall (`services/sandbox/realm.ts`): a live key never reads
its people, shifts, sales, reports, questions or matters, and no feed serves them to it; a test key reads only them.
The one test key is `sandbox-checker` (`read:team`, `read:money`, `review:shift_reports` on the test pages, the
stand-ins too): it plays Gengar's check of a handed-in report without touching anything live. A `t-…` login or a
`test-…` page in a live key's answer is a hole in the wall. A stand-in is how a test login's extension works a live
page's real site account: it stores only the pulse and the board's own writes (what the extension reports of the real
account, wallet sightings and send and note attributions, is accepted and dropped), its Fansly proxy is its live
page's, and a test login reads nothing of a real fan.

## Custom orders: what the agent names

An order's facts (paid, at the model, shot, given) are kept true from what Hub holds, not from a person's click. The
agent never states a fact: it names a sale or a message Hub already has, Hub checks it and takes the step, and a
person can undo it. An undo of what an agent or the system applied is remembered (`custom_order_rejections`): neither
applies that sale or that message to the order again; a person who applies it by hand takes the memory away. Every
page a call names is one of the key's pages (another answers 404, the same as one that does not exist), and a key
holding `write:customs` alone gains none of the calls below that need more. The CLI: `hub custom create --price
<dollars> --sale <saleRef or pageLabel:transactionRef> …`, `hub custom step K-… --step payment|given|fan|fan_asked|deadline|issue|issue_clear`,
`hub custom list --state live`, `hub custom findings post --file …` and `hub custom findings dismiss --source … --ref … --at …`
(`hub custom <command> --help` for the flags).

| Call | Also needs | What Hub checks |
|---|---|---|
| `create` / step `edit` with `deadlineOn` | — | as before: a field a person edited is never overwritten (409 `edited_by_person`) |
| `create` / step `edit` with `priceMills` | `read:money` | as `edit` |
| `create` / step `edit` with `holdReason` | `read:messages` | as `edit` |
| `create` with `sales`, step `payment` (`sale`: `{saleRef}` or `{pageLabel, transactionRef}`) | `read:money` | the sale is on a page of the order's model among the key's pages; an account's of the order's fan (any account of the person); a tip, a subscription or a message purchase; held by no other order; not reversed; not taken off this order by a person. `create` never fails because of a sale: the order is recorded and `sales` answers each — `linked`, `already`, or `refused` with its reason. A `create` that finds the order by its card or its code takes the price and the sales too |
| step `given` with `messageRef` | `read:messages` | the page's message on a page of the order's model among the key's pages, to an account of the order's fan (the chat's fan), sent after the order was recorded and after its last revision request and a person's last «не отдан» (409 `before_revision`), with media; a priced one (its own price or a media offer's) bought. The purchase of its one priced offer becomes the order's payment in the same step; the same message named again links a purchase the mark was set without. While the order has its code-named files (the vault files named with its code since its last revision), only a message that carried one of them to the order's fan since then (Hub's own evidence: say the finished file sent while raw parts named with the code never were); any other is refused (409 `code_named_file`): Hub's own rule finds that delivery; 409 `version_changed` when the order moved while it was checked (read it again). Never by a word |
| step `fan` with `pageLabel` and `fanRef` (the fan's platform id) | `read:messages` | the fan has an account on that page; the order has no fan and its fan was not erased; the page becomes the order's when it has none (another page than the order's: 409 `other_page`) |
| step `fan_asked` with `messageRef` | `read:messages` | the fan's message in a chat of the order's fan on the order's page, sent after the order was recorded (409 `before_order`). An ask the page has answered since, and any ask while one stands, change nothing (`unchanged`); Hub takes the ask off by itself once the page writes to the fan |
| step `deadline` with `reason` | — | as `edit`: never over a deadline a person set |
| steps `issue` (≤ 200 characters), `issue_clear` | `read:messages` | the shape; `issue_clear` only of an issue this agent set (409 `not_yours`: a person settles another's) |
| `GET …/custom-orders?state=live` | — | the open orders and the given ones not closed yet. The facts (`facts`, `priceMills`, `holdReason`, `issue`, …) are on the wire only for a key with `read:money`; to it an order whose money is not complete also carries `unlinkedSales`: the fan's sales of the last 30 days (a fan often pays before the card), on the key's pages of the order's model, that pay no order and no person took off it (at most 10). Read the chat around one before naming it back. Every read (the list, `code`, `telegramRef`) carries `acceptedBy`, `acceptedByUserId` and `givenBy`; to a key with `read:messages` each order also carries `move` (whose move, the board's one rule: `who`, `whoKind`, `userId`, a shot order's `giver` and `onShift`) and `burning`. `leader` («у кого сейчас») follows the same rule; answer people from `move`, never from `leader` alone |
| `create` with `acceptedBy`, `authorTelegramId` + `cardKind`; steps `card`, `at_model` with them; step `accepted_by` | — | «Принял», below |
| `POST …/custom-findings` | `read:money` + `read:messages` | each finding once by `(source, ref)`; a sale's is Hub's sale on the key's pages (its page, fan, sum and time are Hub's). `notCustom` keeps a new one dismissed as «не кастом»; a finding Hub has stays as it is — its check's leader resolves it |

The refusals are 409 with `error.reason`: `capability_missing` (in `sales`), `not_found`, `order_no_page`,
`order_no_fan`, `other_model`, `other_fan`, `wrong_kind`, `taken`, `reversed`, `rejected`, `not_allowed` for a sale;
`not_page_message`, `not_fan_message`, `before_order`, `before_revision`, `no_media`, `not_bought`, `code_named_file`,
`rejected`, `version_changed` for a message; `fan_known`, `other_page`, `fan_unknown` for the fan; `card_other_order` for a
`create` whose card link is one order's and whose card text names another; `open_orders` for a second open order of the
fan without `another` (two creates of one fan at once are taken one after the other). A step that needs a capability the
key lacks is 403 `agent_capability_missing`.

### «Принял»: who took an order

The order's taker answers for giving a shot order to the fan: they watch the video whole and give it (the owner,
2026-11-22). Whoever is on shift on the page may give it too, and anyone may; nobody else is obliged. With no taker the
order's check leader names one. `move` says it: `giver: "taker"` — «посмотреть ролик целиком и отдать фану»;
`giver: "lead"` — «указать, кто принял»; `onShift` — someone else on shift now, who may give it too.

A taker is a living login of a person who works on the order's page (`person_working_pages`, of the page's realm, not a
content manager's). It is named by a login or by a numeric Telegram id (`people.telegram_user_id`), never by a name:
two people may share one. Its history event is `custom_order.accepted_by` `{from, to, name, source, ref}`, `source` one
of `manual` (a person on the board), `agent`, `card`, `sale`, `backfill`.

- A person's choice (the board's «Принял», «Записать кастом», a finding's «записать заказ», or `board` on their word)
  is theirs: it replaces any taker, and no evidence changes it again (`person_fields`: `acceptedBy`).
- Evidence fills only an order with none, and never one a person decided: `create` with `acceptedBy`; a `work` card
  (`cardKind: "work"`, the card in the chatters' work chat) whose author's `authorTelegramId` is such a person; a
  linked sale whose one home (`sale_homes`) is one chatter's whole; the backfill's `acceptedBy`. A `model` card (the
  copy in the model's group) never names a taker. `create` never fails for the taker: `taker` in the answer says `set`
  (and its `source`), or `unchanged` with `taker_set` (another is set), `person_set` (a person decided it),
  `taker_unknown` (nobody of that login or Telegram id works on the order's page). A `card`/`at_model` step answers the
  same `taker`.
- Step `accepted_by` with `acceptedBy` (a login of the order's page): only while the order names none — 409
  `taker_set` / `person_set` otherwise, `taker_unknown` for nobody of the page; the same taker again is `unchanged`. A
  set taker is corrected by a person: the board, or `board` on their word.

### On a person's word: any board step, any finding's answer

When a person asks the agent to do or correct something on a custom order, the agent takes the board's own step as
that person: `POST …/custom-orders/:code` `{action: "board", step: <the board's step body>, onBehalfOf: <their login>,
requestRef: <the Telegram message where they asked>}` (`hub custom board K-… --step … --on-behalf-of … --request …`).
`step` is exactly what Workboard «Кастомы» sends (`customOrderAct`'s body): hold and unhold, given by their word, ungive,
unpay, close, cancel, checked, paid_word, accepted_by (replacing a set taker too), edit over fields a person set, the
card, the deadline, the price…. Hub reads the person as the board does (their role, pages, teams, realm: the key's
realm only) and checks their own right to the step by the board's own code (`boardStepAs`): the agent never gets more
than the person (409 `not_allowed`; an order the person does not see is the same). What it sets is the person's (an
agent's or the system's evidence never overwrites it). Every event of it records the door `api`, the key, `onBehalfOf`
and `requestRef`. A finding is answered the same way: `POST /api/v1/agent/custom-findings/:findingId` `{step:
<customFindingAct's body: record | link | dismiss | reopen>, onBehalfOf, requestRef}` (`hub custom finding <id> --step …`),
by the person's own right (the check's leader of its page, the customs lead, the owner; else 404), its answer kept in
the finding's history (`custom_finding.*`). Without `onBehalfOf` + `requestRef` the agent's door stays the verified-fact
door above.

### What changed

`GET /api/v1/agent/custom-orders/events?after=<event id>&limit=` (`hub custom events --after …`): the history of the
orders of the key's pages (and, for a live key, of no known page) — every `custom_order.*` step of every door — and
people's answers to findings (`custom_finding.*`), after the cursor, the oldest first, at most 200: `id`, `at`, `code`
(or `findingId`), `event`, `door`, `actor` (a person's name and login; null — a key or Hub), `agentKey`, `onBehalfOf`,
`changes`; `next` is the next call's `after`. So the agent learns what people changed on the board.

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
  the newest first. Nobody's sales are hidden from chatters and team leads, except those whose fan the person wrote to.
- `hub shift-report line --shift <id> --sale <transactionId> --statement not_mine|share|mine|rule`: the person's word
  on a sale. «не моё» and «делим с…» (`--share-with` a colleague, by user id or name) go on «Ваши продажи»; «моё»
  (with `--note`, one line of why) goes on «Рядом» or adds a sale from `claimable`; `rule` takes the word back.
  «моё» on a nobody's sale is the person's word and counts the whole net at once (owner, 2026-11-26): no question to
  the owner. When another person's handed-in report holds that sale, the line counts 0 and the hand-in makes it a
  claim with that colleague, as any take of a colleague's sale. A sale the owner left «никому» takes no word.
  A «не моё» stays on its line, among «Ваши продажи» and counting nothing, in every later version until `rule`
  takes it back — also when the word itself made the sale nobody's (everyone of its home said it).
- `hub shift-report line --shift <id> --report-sale --ref <transactionRef> | --fan <fan> --amount <dollars> --note …`:
  «Не вижу свою продажу» — a nobody's sale the person does not see, found by its exact reference or by the fan and
  the amount on the person's pages within the key's grant. Exactly one match writes the person's «моё» on it, counted
  as above; none or several are the same 404 `sale_not_matched`, so nothing tells whether a hidden sale exists.
- `hub shift-report comment --shift <id> --text "…" [--model <slug>]`: the comment, the person's text word for word.
  A shift on two models' pages is two posts, each with its model's comment: `--model` (a slug of the report's
  `view.comments`) sets that model's alone; without it the one text goes into every post.
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

## Shift reports: the ledger's feed

`GET /api/v1/agent/shift-reports?since=<next>&limit=<1..500, 200>` (`read:team` + `read:money`) answers
`{ reports, held, next, more, serverNow }`. What a reader does:

- **The cursor.** Keep `next` and ask again with `since=<next>`. `next` is the last place read, served or held; it
  equals the `since` asked when nothing is new. A version is placed when the feed first finds it committed, after
  every place given before, so one committed late comes after the cursor and is never passed.
- **`limit` counts places, not reports.** A place whose version is held back for the key counts too, so an answer may
  carry fewer `reports` than `limit` — none even — while more follow. `more: true` says places follow `next`: read
  on. The end of the feed is `more: false` (equally: `next` is the `since` asked). «Fewer reports than the limit»
  is not the end.
- **Keep versions by `id`, and a report's newest by `version`.** A version may come more than once (below), and a
  version of a report may come after a newer one of the same report: the report of a shift is the version with the
  highest `version` for its `shiftId`, never «the last one read».
- **`held`.** A version with a line of a page outside the key's pages is not served: `held` lists it (`id`, `seq`,
  `shiftId`, `person`, `reportDate`, `pageLabels`: no sums, no lines) on every read until the key may read those
  pages. Then it gets a **new place at the end of the feed** and leaves `held`; from there it is an ordinary item of
  `reports`, served by the cursor. Nothing is «served once»: an answer that never arrived is asked again with the
  same `since` and brings the same items. A reader needs no acknowledgement and no special case — only the three
  rules above. A place never moves except to the end, so a reader whose cursor had passed the old place (it had the
  version at that time, or held it) meets it once more at the new one.
- **`pages` names the page of every line.** A version's `pages` carry every page of its `lines`, with `0` where
  nothing is counted (a sale of «Рядом» on a page the shift did not hold, a disputed «моё»); a page's amount is the
  sum of its lines' `amountMills` rounded to the cent, plus a confirmed «мимо площадки» on it.
- **`reportDate` is the version's own day.** A version carries the shift's day when the person handed it in; a version
  the system makes (a decision, an agreement, «мимо площадки», a cancelled decision) keeps the report's day. The post
  in «Отчётность» and Hub's question «is the day paid» use the same day.
- **`madeFor`** says why the system made a version: `claim` (an agreement, or the owner's `first | second | half |
  nobody`), `off_platform`, `decision` with `outcome: "said"` (a decision recorded «со слов»: the version carries
  what it gives) or `outcome: "cancelled"` (that decision was cancelled: the version carries what rules without it —
  an agreement of the two sides, else the rule with the person's own word, a disputed «моё» counting `0` again).

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
(`--sender <id> --message <link>`); the person codes are the people registry's (the same as the ledger's). A code
names the person's live login (neither disabled nor deleted; of two live ones, the older), and a decision, a question or
`applied` is recorded on it; a person with no live login left (who left the team) is still known, by the oldest of
their logins.

What the agent ran in the ledger, and what it runs now:

| Was | Now |
|---|---|
| `ledger decision add --page P --fan-ref R --kind owner --share C:100 --said-by W --said-at D --note N` | `hub sale decide --sale <Hub id> --kind owner --share C --said-by W --said-at D --note N --sender S --message M` |
| … `--kind split --share A:50 --share B:50` | `hub sale decide … --kind split --share A:50 --share B:50 …` |
| … `--kind pot --pot <slug>` | `hub sale decide … --kind pot --pot <slug> …` (Hub's pot name is the ledger's pot slug, `ledger pot list`) |
| … `--kind exclude` | `hub sale decide … --kind exclude …` |
| … `--kind off_platform --share C:100` | `hub sale decide --page P --kind off_platform --share C --net <mills> …` (no sale) |
| a sale not named yet (fan, page, time) | `hub sale decide --page P --fan <id or login> --at <ISO time> --net <mills> …`: the owner ties it later («привязать») |
| `--supersedes N`, `--answers Q` | the same flags; what they may name is narrower than in the ledger: below |
| `ledger decision cancel N --note …` | `hub sale cancel N --note … --sender S --message M`: the reports it settled get a new version (`versions` in the answer) |
| `ledger decision applied N --person C --date D` | `hub sale applied N --person C --date D` (a post-based report only; a report handed in Hub follows by itself) |
| `ledger decision list --open --md` | `hub sale decisions --open --md \| jq -r .data.markdown` (the same information; the fan is named as Hub's own rows name him, nothing is copied from the ledger; a note is the team's free text, as written) |
| `ledger question add --page P … --asked-of owner\|chatters --who W --question Q --note N` | `hub sale ask --sale <id> (or --page P --fan R …) --of owner\|chatters --who W [--person A --person B] --question Q --note N --asked-at D --sender S --message M` |
| `ledger question answer Q --answer …` | `hub sale answer Q --answer … --sender S --message M` |
| `ledger question drop Q --note …` | `hub sale close Q --note … --sender S --message M` |
| `ledger question list --open --md` | `hub sale questions --open [--person <code\|id>] [--from YYYY-MM-DD --to YYYY-MM-DD] --md \| jq -r .data.markdown` |

What a decision does:

- A sale Hub knows (`--sale`, or `--page` with `--ref` the platform's transaction id): exactly the owner's decision of
  a dispute. Every report handed in Hub that holds the sale gets a new version with what the decision gives its
  person (settled; the person's later hand-ins keep it; a share is the person's under any of their logins), the
  sale's open claims and questions are decided with it, their matters close, the home is computed again. The
  ledger's facts carry it (`resolution`, `decision`). A sale with an active decision refuses a second one without
  `--supersedes <№>` (409 `decision_exists`).
- `--supersedes <№>` names the active decision of the very sale; a decision that names no sale replaces one of the
  same page and fan. `--answers <№>` names an open question about the same sale (or, neither naming a sale, the same
  page and fan). Anything else of the key's pages is 409 `other_sale`; a number of another page answers exactly as
  one that does not exist (409 `not_active`, `question_closed`). All of it is checked in the transaction that writes.
- **A decision a signed-in decider made is never changed through this door.** One made in Workboard (a dispute's —
  the owner's or the deciding lead's — and «никому» of a week) or by the owner's agent door (below), all of them
  `decided_by_user_id`, is changed only there: 409 `owner_decision` here, whatever the sender — the owner's own
  Telegram id included (payouts plan §11, «Защита слова владельца»).
- **To change the owner's word recorded from his message, record his own words with his own message.** A decision a
  key recorded from the owner's own message (its sender, kept as `said_by_telegram_id`, is the owner's Telegram id in
  the people registry) is his word: `--sender` is the owner's Telegram id (the one the people registry holds for the
  person whose role is owner), `--message` his message. Then `hub sale cancel <№> …` and `hub sale decide …
  --supersedes <№>` go the usual way, and the reports follow. With any other sender — a chatter's or a lead's message
  retelling him, an owner whose Telegram id the registry does not hold — it is 409 `owner_decision` and nothing
  changes. What a key recorded from anyone else's message and what was carried over from the ledger a key cancels and
  replaces on any message. Whether a sender is the owner is read from the registry when the decision is changed;
  decisions recorded before the sender was kept carry none.
- `hub sale cancel`: the decision is cancelled and, in the same transaction, every report handed in Hub that it had
  settled gets a new version with what rules now — an agreement of the two sides, else the rule with the person's
  own word (a disputed «моё» counts nothing again) — exactly what handing in again would write. A decision it had
  replaced does not come back. The claims and questions it decided wait again (a claim, when the reports make it
  again), the home is computed without it, and a day the ledger already paid raises the owner's matter «Отчёт смены
  после выплаты». `versions` lists the reports that changed.
- `hub sale decisions --open`: the active decisions not taken into a post (`applied`) that someone still waits for —
  one is `held` (left out) only when the reports handed in Hub hold the sale for everyone it gives a share to; a
  person it gives a share to whose report does not hold the sale keeps it open, whoever else's report has the line.
- A sale not named yet: kept with the words that will find it, in the owner's «привязать» list.
- `off_platform`: money outside the platform; no sale and no home. The person adds it to a report handed in Hub
  as «мимо площадки» (`hub shift-report off-platform`); a post-based report takes it from the list.
- A pot (`--kind pot`): Hub records whose it is («в общак <pot>»), the home follows — and the pot's money follows
  the decision. For a sale of the day the ledger's setting `sale_decisions_hub_from` names, or later, `hub sale
  decide --kind pot --pot <slug> …` alone gives the sale to the pot: the ledger's job `hub-decisions` reads the
  decision and writes the pot's purchase from it (within the hour; a decision cancelled or replaced takes the
  purchase off). `ledger pot add-sale <slug> …` is only for a sale of a day before that one and for money Hub does
  not see. **Never both for one sale**: the purchase would be counted twice.

A question asked of the owner reaches the owner as a dispute, titled by page, amount, day and people (never the
fan). One asked of the chatters waits for their answer and opens no matter; carried over from the ledger and never
answered, it stays the owner's, titled «Вопрос чаттерам без ответа с <день>: …». A question's text is the question
and, on its own line, its note (`--note`): free words of the team, shown in `--md` as written. Refusals: 400
`bad_decision` (the kind's rules), 400 `person_unknown`, 404 a sale, a page, a decision or a question outside the
key's grant (one that names no page included), 409 `decision_exists`, `not_active`, `question_closed`, `other_sale`,
`owner_decision` (a decision a signed-in decider made, on any message; the owner's word recorded from his message,
and the message is not his),
`claim_closed` (a claim of the sale closed while the decision was being written: read the sale again). A question is
answered or closed once: a second `hub sale answer` or `hub sale close`, or one after a decision answered it, is 409
`question_closed` and changes nothing.

`hub sale questions --open --person <code|id> [--from YYYY-MM-DD --to YYYY-MM-DD] [--md]` (`GET /api/v1/agent/sale-questions?open=true&person=…`)
delegates to Hub's one canonical selector (`services/payout-sale-blockers.ts`, `payoutSaleBlockers`) — the exact same
selector Workboard's payout panel (`PayoutBrief`, «Открытые вопросы по его продажам») reads:
- Resolves `<code|id>` (registry code, person id, login id or username) in the key's realm across ALL of the person's
  logins (active and disabled/deleted) and ALL of their working pages; a person outside the key's realm is 404.
- Returns both open sale questions (`question`, `imported`) and open shift-report disputes (`claim`, `double`) where the
  person is a party (`claimant`, `side`, `share_with`, or sale home holder), is named in `who` or the question text, or
  where an unattributed open question sits on one of their working pages; another person's question is excluded.
- Realm, page-grant and person-relevance filtering run BEFORE any row limit, so unrelated rows never crowd out a
  person's open blockers.
- Unlinked open questions without a page (`page_id IS NULL`) are surfaced to the owner in Workboard's payout panel
  (`match: "unlinked"`), never to an agent key; when the key's grant misses any working page of the person, or relevant
  null-page questions exist, or the row cap triggers, the answer carries `coverage: { state: "partial", reasons: […] }`
  (and `--md` appends a partial-coverage warning line) so a partial read never reads as "no blockers".

Carried over from the ledger (`sale-claims:import`, on the server): run again with fresh files it writes nothing
twice and completes what an earlier run left out — a decision the ledger marked taken into a post (`applied`: the
person, the date) is marked so in Hub and leaves `--open`; a question's note joins its text.

### The ledger's feed of decisions

`GET /api/v1/agent/sale-decisions/feed?since=<next>&limit=<1..500>` (`read:money`): every change of a decision
about whose a sale is, from every writer (the owner's dispute, this door, the import, a link, a cancel), in the
order the feed placed it. A change is placed when the feed first finds it committed, after every place given
before, so a change committed late comes after the cursor and is never passed (the mechanism of the shift reports'
feed, and the same reading rules: `limit` counts places, `more` says whether places follow, the end is `more:
false`). The answer:

```
{
  "changes": [{
    "seq": 41,                      // its place; the cursor
    "change": "made",               // made | superseded | cancelled | linked | applied | changed
    "at": "2026-11-12T18:20:00.000Z",
    "decision": {                   // the decision as it is now: apply in order, keep by id
      "id": 12, "transactionId": 1234567, "pageLabel": "mia-1",
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
  "next": "44",                     // the last place read, served or held
  "more": false,                    // places follow `next`: read on
  "serverNow": "…"
}
```

The structured fields carry no fan's name: the sale is named by Hub's id and its page. `note` is the team's free
text, served as written — it often names the fan — and a fan's erasure clears it in Hub (the ledger blanks its own
copy from the erasures feed). A change of a decision on a page outside the key's pages is listed in `held` on every
read until the key may read it; then it gets a new place at the end of the feed and comes in `changes` through the
cursor, so an answer that never arrived is asked again and brings it again. It may come after later changes of the
same decision, and a second time for a reader whose cursor had passed its old place: keep decisions by `id` and go
by `decision.state` (each change carries the decision as it is now), not by the order of the `change` words. What
the ledger takes from it: a pot's sale (kind `pot`), a nobody's sale given to a person (`owner`, `split` on a sale
whose `ruleHome` was `nobody`), a report line's agreement (kind, shares, state, `saidBy`, `note`).

### The ledger's feed of computed sale homes

`GET /api/v1/agent/sale-homes/feed?since=<next>&limit=<1..500, 200>` (`read:money`): every computed home change in
`sale_homes` (`upsert` or `retract`), after a cursor, in the order the feed placed it. Same cursor and placement
mechanism as the shift reports' and decisions' feeds (`release -> place -> list` under an advisory lock; late commits
land after the cursor; `limit` counts placed positions including `held`; the end is `more: false`). Test-realm changes
(including `retract`) are filtered before `held`, so they never enter a live key's feed, held list, or cursor.

```json
{
  "homes": [{
    "seq": 41,
    "at": "2026-11-12T18:20:00.000Z",
    "op": "upsert",
    "transactionId": 1234567,
    "pageLabel": "mia-1",
    "occurredAt": "2026-11-12T17:10:00.000Z",
    "netMills": 24000,
    "saleKind": "ppv",
    "home": "shift",
    "reason": "holder",
    "pot": null,
    "waitsUntil": null,
    "ruleVersion": "2026-11-12.1",
    "shares": [{
      "personCode": "anna",
      "userId": 6,
      "shiftId": 88,
      "workRef": "6:2026-11-12T13:00:00.000Z",
      "reportDate": "2026-11-12",
      "daySource": "report",
      "percent": 100,
      "mills": 24000
    }]
  }],
  "held": [{ "seq": 44, "transactionId": 1234568, "reason": "page_outside_key" }],
  "next": "44",
  "more": false,
  "serverNow": "2026-11-12T18:21:00.000Z"
}
```

- Every entry carries the sale's current state (apply whenever `seq` is greater; replay is safe). On `retract`,
  upsert-only fields are `null` and `shares` is `[]`.
- Every share carries `personCode` (from the people registry, or `null`), `reportDate` (Moscow `YYYY-MM-DD`, or `null`
  when `daySource` is `unresolved`), and `daySource` (`report` | `shift` | `visit` | `holding_shift` | `sale_day` |
  `unresolved`), computed by the same pure `landShare` rule screens use.
- Changes on pages outside the key's grant appear in `held` until granted, then receive a new `seq` at the end of the
  feed and come through `homes` via the cursor.

## Pot distributions (K2): the ledger's feed

`GET /api/v1/agent/pot-distributions/feed?since=<digits>&limit=<1..500, 200>` (`read:money`) delivers every posted or
reversed Workboard pot distribution (0443) after the cursor, using the same `release -> place -> list` cursor mechanics
as `sale-homes/feed` (with `is_test` filtered before `held`, `limit`, and `next`):

```json
{
  "changes": [{
    "seq": 12,
    "change": "posted",
    "at": "2026-12-02T11:25:00.000Z",
    "distribution": {
      "id": 101,
      "pot": { "code": "page-mia-1", "name": "Общак mia-1", "modelSlug": "mia-hart" },
      "day": "2026-12-02",
      "formula": { "kind": "equal", "params": {} },
      "inflows": [{ "transactionId": 910001, "pageLabel": "mia-1", "baseMills": 40000 }],
      "baseMills": 40000,
      "lines": [
        { "personCode": "alex.k", "baseMills": 20000, "basis": "1/2" },
        { "personCode": "kate.v", "baseMills": 20000, "basis": "1/2" }
      ]
    }
  }],
  "held": [{ "seq": 13, "distributionId": 102, "pageLabels": ["nova-1"], "reason": "page_outside_key" }],
  "next": "13",
  "more": false,
  "serverNow": "2026-12-02T11:26:00.000Z"
}
```

- Hub emits base in mills only (`baseMills`), never pay or rates; the ledger computes each person's pay from `lines`.
- `change` is `"posted"` on initial distribution creation and `"reversed"` when reversed once (carries the same
  distribution snapshot so the ledger can reverse its posted lines idempotently by `distribution.id`).
- A distribution is held whenever ANY page of `pots.page_ids` or `pot_distribution_parts.page_id` is outside the key's
  granted pages (`held[].pageLabels` lists the missing granted labels); once all its pages are granted, it receives a
  new `seq` at the end of the feed and leaves `held`.

## The owner's agent door (`act:owner`)

The owner's own agent acting AS the owner, on the owner's word, with the owner's reason on every call (payouts plan
2026-11-24, §1.8; `services/owner-agent-door.ts`). Not an agent key of the plane: an `act:owner` key holds that one
capability, no page, names the live owner's login it acts as (`agent_keys.acts_as_user_id`, 0442), and reaches one
route, `POST /api/v1/owner-agent/call` — every other route refuses it (403), and that route refuses every other key and
session. Issued only on the server: `cli.js owner-agent-keys:issue <name> --owner <login> --days N` (the token is
printed once). The dashboard lists it and may revoke it; it never issues, changes or replaces one (409
`owner_agent_key`): to rotate, revoke it and issue another. It is no agent's key for another service
(`agentKeyIntrospect` answers `active: false`). A key acting as a disabled or deleted owner, or as the test team's
owner, is no principal (401).

The CLI is `hub owner …` with the owner's desk's key: `HUB_OWNER_KEY`, or `HUB_OWNER_KEY=…` in
`~/.config/hub/owner-desk` (mode 600) — never `HUB_AGENT_KEY` and never a cron's file. `--why` on every command.

| Operation | `hub owner …` | What it does |
|---|---|---|
| `shiftReport.list` | `shift-report list --person C --from D --to D` | A person's shifts (≤ 62 Moscow days) with their stored reports: state, phase, version, total |
| `shiftReport.show` | `shift-report show --shift N [--version V]` | A stored version whole (the newest by default); never a draft |
| `shiftReport.versions` | `shift-report versions --shift N` | The stored versions, newest first |
| `sale.show` | `sale show --sale N` | Whose a sale is by the rule, its decisions and claims, whether a dispute is open |
| `sale.decide` | `sale decide --sale N --kind owner\|split\|exclude --share C[:P] --note W [--supersedes №]` | The owner's decision of a known sale: the reports follow, as a dispute's decision. An open dispute (a claim or a question waiting): 409 `open_dispute` — decide it in Workboard. An active decision: name it (409 `decision_exists`) |
| `sale.cancel` | `sale cancel № --note W` | Cancels an active decision; the reports it settled get a new version |
| `sale.close` | `sale close № --note W` | Closes an open sale question without a decision, once (409 `question_closed`) |
| `people.show` | `people show C` | A person: who, logins, pages, schedule, rights, onboarding, the owner's note. Never pay terms, payout details, keys or proposals |
| `people.edit` | `people edit C [--display-name] [--note] [--state] [--left-on] [--working-page …] [--json '{"onboarding":…,"schedule":…}']`; `people set C [--state] [--left-on D] [--working-page …] [--schedule '{…}']` | Those fields of a person (kind human) and nothing else (400; a right, a login, a key, the role, Telegram, pay terms, a proposal: 403). A person with a content manager's login: their working pages are the owner's own (409 `content_manager_pages`). `people set` is the same operation with the state, the day left, the working pages and a schedule line alone |
| `custom.board` | `custom board [--page L]` | «Кастомы» as the owner's board shows it: the live orders, the findings' line, what changed by itself |
| `custom.show` | `custom show K-N` | An order whole: card, messages, payments, history, the steps the owner may take |
| `custom.step` | `custom step K-N --step S [--json '{…}']` | One step of the board as the owner, none of money: `edit` (`{"card":{…}}` — the changed fields, never «Оплата»), `deadline`, `fan`, `card`, `checked`, `at_model`, `partly`, `shot`, `revision`, `refused`, `given`, `ungive`, `retract`, `close`, `hold`, `unhold`, `issue_clear`, `fan_asked_clear`, `accepted_by`. Never `payment`, `unpay`, `paid_word`, `cancel` (it gives the order's sales back) or a price (403) |
| `customFinding.list` | `custom-finding list` | «Найдено без заказа»: the open findings and those an agent dismissed in two weeks |
| `customFinding.answer` | `custom-finding answer N --step dismiss\|reopen\|link\|record [--reason R] [--code K-N] [--json '{"card":…}']` | A finding answered as the owner. A finding that names a sale (a sale's, a shift report line's) is never recorded or linked here — that pays the order with the sale: 409 `finding_pays`, nothing written; the owner does it on the board. A record names no agreed total and no «Оплата» |
| `matter.list` | `matter list [--state] [--kind] [--page] [--limit]` | The owner's matters (every one), with whether each kind is known |
| `matter.close` | `matter close KEY --how resolved\|withdrawn\|cause_gone [--note]` | An agent's matter, closed by its writer (as the agent's door closes it). Any other kind closes through its own step — a sale's, a question's, a custom's, Hub's own pass, the ledger, ContentOps: 409 `matter_kind_service`, naming it |
| `matter.comment` | `matter comment KEY --text W` | A comment in a matter's history, any kind's |
| `learn.list` | `learn list` | The pages of «Обучение», each with whether the team reads it |
| `learn.show` | `learn show SLUG` | A page with its text |
| `learn.approve` | `learn approve SLUG [--take-back]` | The team reads the page from now (or no more). Its audit row `learn_page.approval` names the key |
| `swap.list` | `swap list` | The approved swaps of the next 14 days |
| `swap.approve` | `swap approve № [--text W]` | «Можно» to a swap question: the day's lines are written (once its hours began: 409 `swap_started`). Another kind of question: 409 `not_swap` |
| `swap.revoke` | `swap revoke №` | An approved swap taken back before its day; its lines are marked |
| `decision.unlinked` | `decision unlinked` | Decisions carried over from the ledger that name no sale yet, with the sales each may be |
| `decision.link` | `decision link № --sale N` | Ties one to its sale of the live agency: it rules the sale from now, the reports follow as for a decision |
| `pot.list` | `pot list` | Workboard pots with live base balances, unrouted pot sales, and live models/people catalog (pure DB read, no ledger call) |
| `pot.show` | `pot show C` | One live pot by its code: eligible sales with remaining base, active participants, and distributions |
| `pot.create` | `pot create C --name W --model M --page … --opens-on D --participants-mode … [--formula …] [--auto-post] [--json '{…}']` | Creates a live Workboard pot (page pot or event pot); writes `pot.created` audit row |
| `pot.update` | `pot update C [--name] [--page …] [--opens-on] [--closes-on] [--intake …] [--participants-mode] [--auto-post] [--json '{…}']` | Updates an open live Workboard pot; writes `pot.updated` audit row |
| `pot.preview` | `pot preview C [--day D] [--json '{…}']` | Pure preview of a pot distribution in base mills (writes nothing) |
| `pot.post` | `pot post C [--day D] [--json '{…}']` | Posts an immutable pot distribution in base mills (emits K2 `posted`, writes `pot.distribution_posted` audit row) |
| `pot.reverse` | `pot reverse № --reason W` | Reverses a posted pot distribution once (restores remaining base, emits K2 `reversed`, writes `pot.distribution_reversed` audit row) |
| `pot.close` | `pot close C` | Closes an open live pot (historical posted distributions stay intact; writes `pot.closed` audit row) |

`hub owner call <op> --json '{…}' --why …` runs any operation of the table; `hub owner ops` lists them (no call).

Every call, in this order: (1) the key — an `act:owner` key of an active owner of the live realm; (2) the reason,
header `x-hub-owner-reason`, 1 to 500 characters after trimming, UTF-8 percent-encoded (`encodeURIComponent`), never a
fan's name — else 400 `owner_reason` before anything; (3) the operation — on the table, else 403; (4) the audit row
`owner_agent.call` (the owner as actor, the key, the operation, the reason), written before anything runs — a call
that cannot be recorded does not run; (5) nothing the door never takes anywhere in the arguments — a key of
`OWNER_AGENT_NEVER.fields` at any depth, in any case, with or without `_` (`rights`, `payTerms`, `payoutDetails`,
`priceMills`, `price`, `payment`, `paid_word`, `proposal`, …), or a step (`action`) of its `steps` (`payment`,
`unpay`, `paid_word`, `cancel`) — else 403, nothing run but the audit row; (6) the arguments by the operation's strict
schema — an unknown field is 400 `owner_agent_args`; (7) the operation, as the owner's own principal. 60 calls a
minute per key; answers are `Cache-Control: no-store`.

What it writes and how it is named:
- A decision: `sale_owner_decisions` `source 'agent'`, `decided_by_user_id` the owner, `agent_key_id` the key. The bot
  door never changes it (above).
- A report's new version made by it: the owner's own Workboard version (`door 'workboard'`, `actor_user_id` the owner,
  no key: 0400's rule and the ledger's reading are as they were); its history row (`object_events`
  `shift_report.settled`) names the key (`actor_agent_key_id`), the owner it acts for (`on_behalf_of_user_id`) and
  the door `api`.
- A person's change: the audit row `person.updated` under the owner, with the key in its metadata.
- A custom's step, a finding's answer, a matter's close or comment: their history rows (`object_events`
  `custom_order.*`, `custom_finding.*`, `matter.*`) name the key, the owner on whose behalf, door `api`, no person; what
  the step sets is the owner's own (as his hand on the board: an agent never overwrites it).
- A swap approved or taken back: the persons' audit rows (`person.schedule_swap`, `person.schedule_swap_revoked`) under
  the owner, source `owner_agent`, the key in their metadata; «Обучение»'s approval: `learn_page.approval`, the same.
- A decision tied to its sale: the reports' new versions and their history, as a decision of the door (above).
- Workboard pots (`pot.create`, `pot.update`, `pot.post`, `pot.reverse`, `pot.close`): audit rows (`pot.created`,
  `pot.updated`, `pot.distribution_posted`, `pot.distribution_reversed`, `pot.closed`) under the owner, source
  `owner_agent`, with the key in their metadata.
- A read (`pot.list`, `pot.show`, `pot.preview`, and all other read operations) writes nothing but its own audit row
  (and its observation): no check runs, no phase moves, no take settles.

Never on this door (a predicate and a test hold it, `OWNER_AGENT_NEVER`): keys, passwords, sessions, devices,
invitations; erasure and deletion, the page browser, sends and broadcasts; pay terms, payout details, transfers,
prices, discounts; configs, prompts, the pace, master switches; signing for a chatter, the test wall; people's rights,
logins, role, Telegram; a person's proposals (their stored change may carry rights); a custom's payment, its undoing,
the owner's word on it, its cancel and its price.

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
