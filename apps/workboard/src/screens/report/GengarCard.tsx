import { Ico } from "./icons";
import type { Row } from "./model";
import type { BoardApi } from "./useBoard";
import { cardWordsOf } from "./words";

type Card = NonNullable<Row["proposal"]>;

/**
 * Gengar's proposal of whose a sale is, inside its page's card under the row (words.ts `cardWordsOf`): «Было «…», стало
 * «…»», the change of the person's sum, why; «Не согласен» (applied unless declined), «Вернуть правку» after a refusal,
 * «Принять» on a card that came after the report was counted; a card a decision outranked since.
 */
export function GengarCard({ api, row, card }: { api: BoardApi; row: Row; card: Card }) {
  const words = cardWordsOf(api.board, row, card);
  if (words === null) return null;
  const { own, pending, run } = api;
  const proposalId = card.id;
  const who = <span className="gc-who"><Ico name="spark" size={14} />{card.by}</span>;
  if (words.state === "superseded" || words.state === "declined") {
    return (
      <div className="gc is-no">
        <div className="gc-h">{who}<span className="gc-ch">{words.head}</span></div>
        <div className="gc-a">
          <span>{words.note}</span>
          {own && words.state === "declined" && (
            <button type="button" className="lk" disabled={pending} onClick={() => void run({ op: "proposal", proposalId, answer: "restore" })}>Вернуть правку</button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="gc">
      <div className="gc-h">
        {who}<span className="gc-ch">{words.head}</span>
        {words.delta !== null && <span className="gc-d">{words.delta}</span>}
      </div>
      {words.why !== null && <p className="gc-t">{words.why}</p>}
      <div className="gc-a">
        {own && words.state === "late" && (
          <button type="button" className="btn btn--sec btn--xs" disabled={pending}
            onClick={() => void run({ op: "proposal", proposalId, answer: "accept" }, "Правка принята: проверьте и сдайте заново")}>Принять</button>
        )}
        {own && <button type="button" className="btn btn--sec btn--xs" disabled={pending} onClick={() => api.setRefuse({ key: row.key, proposalId })}>Не согласен</button>}
        <span>{words.note}</span>
      </div>
    </div>
  );
}
