import { Ico } from "./icons";
import { deciderOf, signed, upper, type Row } from "./model";
import type { BoardApi } from "./useBoard";

type Card = NonNullable<Row["proposal"]>;

/**
 * Gengar's proposal of whose a sale is, inside its page's card under the row: «Было «…», стало «…»», what it changes in
 * the person's sum, why; «Не согласен» (applied unless declined: «Если согласны, ничего не нажимайте»), «Вернуть правку»
 * after a refusal, «Принять» on a card that came after the report was counted; a card a decision outranked since.
 */
export function GengarCard({ api, row, card }: { api: BoardApi; row: Row; card: Card }) {
  const { own, pending, run } = api;
  const from = upper(card.from?.words ?? "");
  const to = upper(card.to?.words ?? "");
  const proposalId = card.id;
  const decider = deciderOf(api.board, row).words;
  const who = <span className="gc-who"><Ico name="spark" size={14} />{card.by}</span>;
  if (card.superseded === true) {
    // Decided or agreed since: the settlement outranks the card, which changes nothing.
    return (
      <div className="gc is-no">
        <div className="gc-h">{who}<span className="gc-ch">предлагал «{to}»</span></div>
        <div className="gc-a">Решено иначе: {row.reasonWords}.</div>
      </div>
    );
  }
  if (card.state === "declined") {
    return (
      <div className="gc is-no">
        <div className="gc-h">{who}<span className="gc-ch">предлагал «{to}»</span></div>
        <div className="gc-a">
          <span>Вы не согласны: осталось «{from}», решит {decider}.</span>
          {own && <button type="button" className="lk" disabled={pending} onClick={() => void run({ op: "proposal", proposalId, answer: "restore" })}>Вернуть правку</button>}
        </div>
      </div>
    );
  }
  if (card.state !== "proposed" && card.state !== "late") return null;
  const late = card.state === "late";
  return (
    <div className="gc">
      <div className="gc-h">
        {who}<span className="gc-ch">Было «{from}», стало «{to}»</span>
        {card.deltaMills !== 0 && <span className="gc-d">{signed(card.deltaMills)}</span>}
      </div>
      <p className="gc-t">{card.why}</p>
      <div className="gc-a">
        {own && late && (
          <button type="button" className="btn btn--sec btn--xs" disabled={pending}
            onClick={() => void run({ op: "proposal", proposalId, answer: "accept" }, "Правка принята: проверьте и сдайте заново")}>Принять</button>
        )}
        {own && <button type="button" className="btn btn--sec btn--xs" disabled={pending} onClick={() => api.setRefuse({ key: row.key, proposalId, text: "" })}>Не согласен</button>}
        <span>{late ? "Пришла после подтверждения: само ничего не меняется" : "Если согласны, ничего не нажимайте"}</span>
      </div>
    </div>
  );
}
