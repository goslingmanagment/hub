import { Copy } from "lucide-react";
import type { TeamLedgerPayoutPrepareResponse } from "@agency_hub_core/contracts";
import { millsToDollarsNumber } from "@agency_hub_core/shared";
import { Button, Money, Notice, Skeleton, Tooltip } from "@agency_hub_core/ui";
import { formatDay, formatDayRange } from "@agency_hub_core/ui/format";
import { copySheet } from "./copy";
import { usePayoutPrepare } from "./ledger";

/**
 * «Выплата» in a person's panel (ledger L5): what to transfer, what stops it, and the chatter's message ready to copy
 * with the suggested transfer in place of the ledger's placeholder. Nothing is recorded or sent from here: the owner
 * transfers, then sends the text himself.
 */

/** «1824» or «1823.67», as the message writes a transfer. */
function transferWords(mills: number): string {
  const dollars = millsToDollarsNumber(mills);
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

function messageOf(brief: TeamLedgerPayoutPrepareResponse): string | null {
  if (brief.message === null) return null;
  if (brief.placeholder === null || brief.suggestion === null) return brief.message;
  return brief.message.split(brief.placeholder).join(transferWords(brief.suggestion.transferMills));
}

export function PayoutBrief({ slug, name }: { slug: string; name: string }) {
  const prepare = usePayoutPrepare(slug);
  if (prepare.isLoading) return <Skeleton width="100%" height={120} radius={8} />;
  // No payout tab in the ledger (404) or the ledger did not answer: the panel's numbers above still stand.
  if (prepare.isError || prepare.data === undefined) return null;
  const brief = prepare.data;
  if (brief.nothing !== null || brief.amountMills <= 0) {
    return (
      <section className="payouts-block">
        <h3 className="payouts-block__title">Выплата</h3>
        <p className="payouts-note">{brief.nothing ?? "Платить нечего."}</p>
      </section>
    );
  }
  const blockers = brief.flags.filter((flag) => flag.blocker);
  const notes = brief.flags.filter((flag) => !flag.blocker);
  const message = messageOf(brief);
  return (
    <section className="payouts-block">
      <h3 className="payouts-block__title">Выплата</h3>
      <div className="payouts-transfer">
        <span className="payouts-transfer__label">Перевести</span>
        <span className="payouts-transfer__value">
          {brief.suggestion ? <Money mills={brief.suggestion.transferMills} strong /> : <Money mills={brief.amountMills} strong />}
        </span>
        <span className="payouts-sub">
          по ledger <Money mills={brief.amountMills} />
          {brief.period && <> · {brief.period.from === brief.period.to ? formatDay(brief.period.from) : formatDayRange(brief.period.from, brief.period.to)}</>}
        </span>
        {brief.suggestion && brief.suggestion.aboveTableMills !== 0 && <span className="payouts-sub">{brief.suggestion.note}</span>}
      </div>
      {blockers.length > 0 && (
        <Notice tone="warning" title={blockers.length === 1 ? "Сначала разобраться" : `Сначала разобраться: ${blockers.length}`}>
          <ul className="payouts-flags">
            {blockers.map((flag, index) => <li key={`${flag.kind}-${index}`}>{flag.text}</li>)}
          </ul>
        </Notice>
      )}
      {notes.length > 0 && (
        <ul className="payouts-flags payouts-flags--quiet">
          {notes.map((flag, index) => <li key={`${flag.kind}-${index}`}>{flag.text}</li>)}
        </ul>
      )}
      {message !== null && (
        <>
          <pre className="payouts-message">{message}</pre>
          <div className="payouts-message__actions">
            <Tooltip content={blockers.length > 0 ? "Есть что разобрать до выплаты; текст — после перевода, с фактической суммой" : "Текст чаттеру после перевода: сумма — предложенная, поправьте, если перевели другую"} align="start">
              <Button
                variant={blockers.length > 0 ? "secondary" : "primary"}
                icon={Copy}
                onClick={() => void copySheet(message, `Скопировано: сообщение ${name}`)}
              >
                Скопировать сообщение
              </Button>
            </Tooltip>
          </div>
        </>
      )}
    </section>
  );
}
