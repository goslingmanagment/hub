# R2 board screen: what the board needs from the contract

Stage 2 (after the arena's round 3). The board reads these fields; until the hub side's stage 3 lands, R2 added them
to the contract itself as OPTIONAL, additive fields with the coordinator's shapes (`packages/contracts/src/
shift-report-board.ts`, `routes-shift-handins.ts`, regenerated): at the merge the hub side's definitions win.

| Field / operation | Where | Board without it |
|---|---|---|
| `board.preview` | board | falls back to the response's `enabled === false` |
| `board.previous` `{ user, comment, at }` | board | no line «От прошлой смены» |
| `board.post` `{ copiedAt, seen, changedSinceCopy, late }` | board | no post lines in the counted bar |
| `row.choices` `[{ owner, asks: { to, user, words } \| null, hint }]` | row | the client rule, restricted: on someone else's sale only «Моя», «Пополам с <держатель>» (and the rule's word to go back) |
| `row.foundByHub` | row | «Hub дочитал кошельки…» without «Показать» |
| confirm body `seenTotalMills`, `seenCount`; `refused: "changed"` | routes | sent always; «changed» and «superseded» both show «Было …, стало …» and wait for a second press |
| `POST /api/v1/shift-reports/:shiftId/post-copied` | NOT added (an operation needs runtime handlers and scopes) | sent raw through the board's own client (session or port) after «Скопировать пост»; a failure is silent; the demo answers 404 and its post states are the scenarios' stand-ins |

Still open from stage 1:
1. **`board.comment`, `board.offPlatform`**: read from `report.view` (the demo fills a minimal `view`).
2. **`saleClaimAnswer` «Не согласен» with `note: null`**: one press, as the coordinator confirmed; the server must take it.

Frame protocol (R-protocol.md): the frame posts `{ t: "open-tab" }` on the port from «Обновите ChatGoose» (an
extension of another version): not in the message table yet; an extension that does not know it ignores it.
