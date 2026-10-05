# Held sends of the chat extension

How the owner or a team lead judges a send from the extension's preview whose
outcome the hub never learned, and what each answer does. The rights behind the
page are in `docs/identity-rights-matrix.md`; the rules a send follows are
chat-extension `docs/architecture.md` §6.7.7–§6.7.8.

The console is «Зависшие отправки» in the sidebar (`/held-sends`), for the
owner on every page and for a team lead on the pages assigned to them. A
chatter does not see it.

## What a held send is

When a person presses Send in the extension's preview, the extension first
tells the hub (a *dispatch*), then hands the message to ChatSpace, then reports
back: sent, with the OnlyFans message id, or failed, with proof that ChatSpace
never took it. The hub waits 10 seconds for that report.

If no report comes (the tab was reloaded, the answer was lost, the network
dropped, OnlyFans answered 401), nobody knows whether the message went out. The
hub then **holds the fan**: no further send to that fan from anyone's preview,
and no first greeting for them, until a person looks at the chat and says what
happened. Nothing frees a held send by itself: not time, not a new sign-in, not
the end of the greeting lease. The extension shows the sender «Неизвестно, ушло
ли сообщение. Повторно не отправляем».

A held send blocks the extension's preview only. The person can still write to
the fan by hand in the ChatSpace composer.

Without sending from the preview (`previewSend` off) there are no held sends.

## What the page shows

«Ждут разбора» lists every held send, the longest held first:

| Column | What it is |
|---|---|
| Страница и фан | The page, and the fan's OnlyFans id (a link to what the hub knows of the fan) |
| Что отправляли | A greeting or a reply from the preview, which part of a split message, and for a greeting which of the offered variants |
| Кто отправлял | The person's login and the short id of the extension install it came from |
| Когда | When it was dispatched, in your local time, and how long the hub has been without a report |
| Приветствие фана | Whether the fan's first greeting is on record at all |

It does **not** show the text. The hub holds no text of a message sent from the
preview: the person who sent it knows what it said.

A send still inside its 10 seconds is not listed: it is in flight, not held.
Sends of a deleted page are not listed.

«Разобранные» is the trail of the resolves: who resolved which send, when, with
which outcome, the recorded message id if any, and the note.

## How to judge one

1. Open the chat with that fan where you normally work with OnlyFans. Opening
   a chat marks it read on OnlyFans, as it always does.
2. Look for an outgoing message at about the time in «Когда». If you do not know
   what was sent, ask the person in «Кто отправлял». «часть 2 из 3» means the
   second message of a split one: look for that part, not for the whole.
3. Choose by what the chat shows:

| What you see | Answer |
|---|---|
| The message is in the chat | «Сообщение ушло» |
| The message is not in the chat, and it is not waiting to be sent anywhere | «Сообщение не ушло» |
| ChatSpace on the sender's machine still shows it as not delivered | Neither yet. It can still go out from there if someone presses Resend. Settle that first, then answer |
| «Приветствие фана» says «Есть: эту часть отправили вручную» and the chat has the message **once** | «Сообщение не ушло»: the one message is the hand-sent one, already on record. The question is only about the send from the preview |
| The same, and the chat has the message **twice** | «Сообщение ушло»: both went out |
| You cannot see the chat, or cannot tell | Leave it held and find out. Held is the safe state |

**There is no rule "not in the hub's archive, so not sent".** The hub's copy of
a chat can lag and can have holes, and the dashboard's fan page may not show a
message that did go out. A message you find in the hub's copy at the right time
is evidence that it went out. Its absence there is evidence of nothing. Look at
the chat itself.

When in doubt between the two answers, do not guess «не ушло». A wrong «ушло»
costs one message the fan never got, which a person can still send by hand. A
wrong «не ушло» lets the same message, or a second greeting, go to the fan.

## What each answer does

Press «Разобрать», choose the answer, write why (required, up to 500
characters), «Записать».

**«Сообщение ушло»**

- The send is closed as sent; the part will not be sent again.
- If it was the first part of a greeting, the fan is greeted, for good. Only the
  person who dispatched it can send the remaining parts of that greeting.
- «ID сообщения в OnlyFans» is optional. Fill it only with the id of this very
  message. An id already recorded for another send is refused.

**«Сообщение не ушло»**

- The send is closed as not sent; the fan is free again for the preview.
- That part can be dispatched again. If it was a greeting and no greeting is on
  record, anyone on the page can greet the fan again.
- The hub refuses it while the send is younger than 10 seconds (the message may
  still be leaving). Wait and press again.

A resolve is final. The same resolve again changes nothing; the opposite one is
refused. There is no undo: if «ушло» was wrong, the person writes to the fan by
hand; if «не ушло» was wrong, nothing takes the duplicate back.

If the extension reports the outcome while you are looking (a late proof of the
same message), the send leaves the list by itself and the dialog says there is
nothing left to resolve.

## What is recorded

Every resolve writes one audit event, `client.send_custody_resolved`, in the
same transaction: who resolved, the page, the attempt id, the outcome, whether
the send was still in flight or held, and whether a message id was recorded.
The fan's id and the note are not in the audit event; the note is kept on the
send itself and shown under «Разобранные».

Reading the page records nothing.

## While the extension is switched off

The page and the resolve do not depend on any chat-extension switch
(`chatExtensionEnabled`, `chatExtensionFeatures`). A send held before the
extension was switched off stays listed and resolvable.

## What the hub does not know

- The text of the message.
- Anything the extension said after the dispatch. A held send is one with no
  report; a late "failed" that arrives after the 10 seconds is refused and not
  kept.
- Whether ChatSpace still has the message waiting. Only the sender's machine
  shows that.

The page does not notify anyone: a held send shows up when someone opens the
page (the list refreshes every 30 seconds while it is open).

## Routes and code

| | |
|---|---|
| List | `GET /api/v1/client-send-custody?state=held\|resolved&pageLabel=&limit=&offset=` (`clientSendCustodyList`) |
| Resolve | `POST /api/v1/pages/{label}/client-send-custody/{attempt}/resolve` (`clientSendCustodyResolve`) |
| Both | A cookie session of the owner or a team lead; no device token, the extension's least of all |

Code: `apps/runtime/src/services/client-held-sends.ts`,
`packages/db/src/repositories/client-send-custody-list.ts`, the resolve in
`apps/runtime/src/services/client-claim.ts`; the page in
`apps/dashboard/src/pages/ClientHeldSendsPage.tsx`. Tests:
`tests/client-held-sends.integration.test.ts`,
`tests/client-held-sends-contract.test.ts`,
`tests/dashboard-client-held-sends.test.ts`, and the resolve in
`tests/client-claim-routes.integration.test.ts`.
