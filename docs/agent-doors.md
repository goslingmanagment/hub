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
| Fans (watch) | `POST /api/v1/agent/team/fan-watch` (`hub fan-watch`) | `read:messages` | A watched fan's new messages on a page since a mark, and when the page last wrote to them. Tips with `read:money` |
| Fans and messages | `hub resolve`, `person`, `timeline`, `threads`, `transcript`, `search` | `read:messages` and others | The read plane: `agent-read-skill.md` |
| Money | `hub dataset` (`transactions`, `fan_spend_*`, …) | `read:datasets` + `read:money` | Typed dataset queries per page |
| Matters | `POST /api/v1/agent/matters`, `…/close`, `…/comment` | `write:matters` | Open, close, comment a matter by its reason key, for a person (by login) or a role. The agent's own kinds only |
| Agent reports | `PUT /api/v1/agent/reports/:slug` (`hub report put`), `GET /api/v1/agent/reports` | `write:reports` | A markdown page people read in the app (`traffic` is Трафик → Сводка) |
| System state | `PUT /api/v1/agent/system/routines`, `PUT …/system/copies` | `write:system_state` | A reporter's whole list of routines and copies, for Система → «Состояние» |
| Content | `hub publication-*`, `post-*`, `media-look`, `vault-album-draft` | `write:publication_drafts`, `approve:*`, `withdraw:publications`, `delete:posts`, `look:media`, `read:content` | `agent-read-skill.md`, «Drafting wall posts» and after |
| Fan queues | `hub queue-*` | `write:fan_queues` | Queues for chatters, on the word of the person who asked |
| Customs, shift reports, claims | — | — | No agent door on Hub yet: each comes with its own package. Until then the ledger and ContentOps hold them |
| Keys (for services) | `POST /api/v1/agent/keys/introspect` | `introspect:agent_keys` | Another service asks who an agent's hub key is: below |

A page outside the key's grant is the plane's static 404, the same as one that does not exist. A session never
gets through any of these doors; an agent key never gets through a session's.

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
