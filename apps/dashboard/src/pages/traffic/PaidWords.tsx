import { formatMills } from "@/lib/format";
import type { PaidFigure } from "./sourcesView.js";

/** «заплачено $900» with its quiet words: «по всем его источникам», «часть в другой валюте»; «журнал не отвечает»
 *  when the ledger did not answer. Shared by «Источники» and the page of one source. */
export function PaidWords({ paid, figureClass }: { paid: PaidFigure; figureClass?: string }) {
  if (paid.state === "unavailable") return <span className="ts-money-flag">заплачено: журнал не отвечает</span>;
  const flags = [...(paid.shared ? ["по всем его источникам"] : []), ...(paid.otherCurrency ? ["часть в другой валюте"] : [])];
  return (
    <span>
      заплачено <b className={figureClass}>{formatMills(paid.mills ?? 0)}</b>
      {flags.length > 0 && <span className="ts-money-flag"> {flags.join(", ")}</span>}
    </span>
  );
}
