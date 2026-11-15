# R2 board screen: what the board needs from the contract

The board (apps/workboard/src/screens/report) builds on `packages/contracts/src/shift-report-board.ts` as of 2a8126577.
What it could not get from `board`, and how it does without it until the contract grows:

1. **`board.comment`** — the shift's comment («Комментарий для следующей смены»). Today only `report.view.comment`
   carries it, and the step-1 demo answered `view: null` on board shifts. The board reads `report.view?.comment`; the
   demo now fills a minimal `view` (no lines) to carry it. Ask: put the comment on `board` (the draft's while editing,
   the counted version's for a reader).
2. **`board.offPlatform`** — the «Мимо площадки» lines (the «Ещё» panel). Same story: read from `report.view.offPlatform`.
3. **`saleClaimAnswer` «Не согласен» without a note.** The contract says disagree needs one line of why; the
   prototype's «Не согласен» under the amber strip is one press. The board sends `note: null`. Ask: let the board's
   disagree pass without a note (or say which words the board should send).
4. **Hub's re-read that found sales** («Hub дочитал кошельки: ещё 2 продажи, +$40» with «Показать»): the board shows
   the line, but no row says it is one of the found ones, so «Показать» is not drawn. Ask: a row flag (e.g.
   `hubFound: boolean`).
5. **Which word of the menu asks, and whom.** The board decides it from `row.rule.owner` (a word that gives the
   person more than the rule — «моя» over «пополам», either over a colleague's, the pot's, a waiting or a decided
   sale — asks the rule's holder; the pot, waiting and decided ask the owner) and the ask's state (agreed, decided,
   silence: no new question). No money is computed, but the server is the judge: if it ever answers a mark with
   «that is a question», the board would need `row.choices` (word, statement, asks whom, hint) from Hub instead.
6. **The disputed decider's name in an ask strip.** «Олег не согласен. Спор решит владелец, до его ответа продажа
   Олега.» takes `board.decider.words`; fine as it is, listed only so the texts stay one function on the server.
