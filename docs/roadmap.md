# Agency Hub roadmap: Chat Memory

Written 2026-10-23 with the owner, from scratch: it replaces every earlier roadmap.
Agents write the code, so the plan is counted in weeks and days. Work starts Monday 2026-10-26.

## What Hub becomes

Hub is the team's shared memory of every chat: which fan, on which page, with which chatter,
what he bought, what he was promised. Whoever writes to a fan sees the same picture, and so do you.
People write to fans; Hub never does.

## Why

What the team's chats (Lora Чат, Ari Чат, Обучалка) and production showed on 2026-10-23:

- What the team knows about a fan lives in heads and screenshots. A shift is handed over with
  «кого оставить?» and screenshots (about 12 times a month in Ari Чат alone). Dani was sold the
  same video on two pages ("я думал все это помнят"). Ваня sexted a fan marked ❌💵 on lora-1.
- Whose sale it is gets settled by hand every shift: «долёт» appears 23 times a month in Lora Чат,
  and pay is counted from screenshots of payouts.
- Hub knows who the fan is and what he bought, but not which chatter sent a message. A shift
  audit cannot split two chatters on one page, and Hub's facts never reach the chatter in the extension.
- Promises and customs get lost: «бабки на шубу взяли… и в отчёте нихуя»; Evan waited 41 days
  for a custom.
- Fans wait: Evan 10 hours while he wanted to buy; 98 fans waiting at the end of one shift.
- Revenue for the last 30 days: Fansly 80 %, OnlyFans 20 %; ari-1 is the top page.
  OnlyMonster, Infloww and CreatorHero count chatter metrics for OnlyFans only, so nothing
  ready-made covers Fansly.

## The core

Without these four, none of the features below work.

1. **The author of every message.** The extension already sees every request the page sends,
   including text typed by hand. It reports «this message left from Никита's browser», and Hub
   keeps the author next to the archived message. Rule for the team: work in a browser with the
   extension, under your own login. Messages from a phone, another browser or OnlyMonster's own
   mass mailings stay without an author.
2. **One record per fan across pages.** On Fansly the same fan has one account on every page, so
   lora-1, lora-2 and ari-1 join on their own. OnlyFans and new accounts of the same person
   (Rick with a new nick) are linked when Hub suggests and a chatter confirms. The record holds
   his purchases on every page.
3. **Facts from the chat, written by AI.** After each conversation AI writes what the fan told
   about himself, what was promised and what was agreed. Every fact links to the message it came
   from. Where the chat says nothing, Hub says «не знаю» instead of guessing. A chatter corrects
   or deletes a fact in one click.
4. **Who is in the conversation now.** Whoever wrote to the fan in the last 15 minutes is «в
   разговоре» for everyone else. The mark drops after 15 minutes of silence or when that chatter
   closes the extension. Nobody owns a fan.

Two rules hold everywhere:

- Hub shows facts; it decides nothing about money. Who gets a sale is agreed by people,
  disputes go to the owner.
- Reply, Ping, Coach and Recap read the same record, so they stop writing generic pings.

## Features on top of the core

1. **Shift handoff.** When a chatter leaves, the next one gets a short summary per fan: who is
   still in a conversation, open promises, open customs, who is waiting. Nobody needs to ask
   «кого оставить?».
2. **Who is waiting.** A live list in the extension during the shift: fans whose last message is
   unanswered, how long they have waited, what they spend. Not a PDF after the shift.
3. **Draft shift report.** At the end of a shift Hub lists the shift's sales. For each sale it shows
   who sent the PPV and who else wrote to this fan in the last 48 hours, and how much. Example:
   «Никита — 40 messages over 2 days, Ваня — 3 messages and the PPV». The chatter marks «делим с
   Никитой» or «не моё», fixes what is wrong and confirms. The other chatter sees it. Pay is
   counted from confirmed reports only; the owner settles disputes.
4. **Customs.** A custom lives in the fan's record from payment to «отдали». Hub sees the payment
   and the video sent to the fan; the chatter confirms it is that order. Open customs are visible
   to everyone who writes to the fan. How the model shoots it stays in Telegram.
5. **Shifts and chatter numbers.** The actual shift comes from the extension: in, active, out,
   with a pause after 10 idle minutes. Eight numbers per shift, the same for Fansly and OnlyFans:
   hours worked; revenue of the shift and per hour (from confirmed reports only); fans written to
   and how many of them paid; PPV sent and bought, average price sold; share of PPV among messages
   (golden ratio); median reply time (replies within an hour); fans left waiting at the end;
   written by hand, with Reply or with Fix. The numbers are a guide, not a basis for pay.

## Not doing (decided 2026-10-23)

- No autopilot: when a page has no chatter, AI does not answer. Empty shifts are filled by hiring.
- No Telegram alert to the owner when a whale waits; the «who is waiting» list is enough.
- No «already seen» marks across pages: content is not shared between pages, and within a page
  the extension already shows it.
- No sales-attribution algorithm: too much human factor (one warms a fan up for days, another
  closes him with one PPV).
- No «25+ metrics» like OnlyMonster: eight numbers.
- Nothing built is removed: voice notes, chat review, help-me, scan and the empty fan tables stay.

## Plan by week

**Week 1, 26.10–01.11: author and shift**
- Mon–Tue: Hub accepts «message sent by this chatter» from clients (journaled in `observations`
  first), links it to the archived message and keeps the author.
- Tue–Wed: ChatGoose (fansly-chat) reports every message that leaves the tab: typed by hand,
  Reply, Fix, PPV. Release.
- Wed–Thu: chat-extension (OnlyFans in OnlyMonster) does the same. onlyfans-chat sends already
  carry the chatter.
- Thu: actual shift from extension activity, with the 10-minute idle pause.
- Fri: «в разговоре» mark (15 minutes) in the API and in the ChatGoose chat list; a warning before
  writing to a fan someone else is talking to.
- In parallel: close capture gaps the memory depends on: full history for active threads on every
  Fansly page (most are partial now), OnlyFans thread history, lilly-1 transactions (none since 17.09).
- Done when: Никита's and Ваня's evening on ari-1 splits exactly; at least 95 % of outgoing
  messages from team browsers have an author.

**Week 2, 02.11–08.11: the fan record**
- One record per fan: Fansly pages join by account; OnlyFans and new accounts by Hub's suggestion
  and a chatter's confirmation.
- Purchases and spend on every page in one card.
- Facts from the chat after each conversation (when the 15-minute mark drops), with links;
  correction in the card.
- The card in ChatGoose and chat-extension; Reply, Ping, Coach, Recap and Генгар read it.
- Done when: on ari-1 the card shows the ❌💵 history from lora-1; Rick's new nick is suggested
  as Rick.

**Week 3, 09.11–15.11: handoff and who is waiting**
- «Who is waiting» list in the extension for the pages the chatter works.
- Handoff summary for the next chatter.
- Done when: for a whole week Ari Чат has no «кого оставить?».

**Week 4, 16.11–22.11: customs and the draft shift report**
- Customs in the fan record: Hub suggests from payments and facts, the chatter confirms; open
  customs per page.
- Draft shift report: facts per sale, «делим с …» marks, confirmation, disputes in the owner's
  dashboard, confirmed reports exported for pay.
- Done when: a week of shift reports goes through drafts and no sale is settled by screenshots.

**Week 5, 23.11–29.11: chatter numbers**
- Eight numbers per shift and per week for each chatter in the dashboard.
- The shift audit (/OS) switches to author-based numbers.
- Done when: the owner sees each chatter's week without asking anyone.

## How we know it works

- «кого оставить?» and «чей долёт» disappear from the team chats.
- At least 95 % of outgoing messages from team browsers have an author.
- Chatters correct a small share of AI facts, and the correction rate falls week to week.
- The owner stops spending nights in the chats to find out what happened.

## Risks

- Messages outside the extension have no author → the team rule above; Hub shows how many
  messages per page have no author.
- AI facts can be wrong → a link on every fact, «не знаю» instead of a guess, one-click correction.
- AI cost → facts run once per conversation, not per message; spend is visible in Usage.
- Fansly pace → the author comes from what the page already sent: zero extra Fansly requests.
- OnlyFans data costs OnlyFansAPI credits → OnlyFans history is filled within the credit budget.
