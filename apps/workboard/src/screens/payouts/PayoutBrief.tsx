import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import type { TeamLedgerPayoutPersonResponse, TeamLedgerPayoutPrepareResponse } from "@agency_hub_core/contracts";
import { millsToDollarsNumber } from "@agency_hub_core/shared";
import { Button, Money, Notice, Skeleton, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatDay, formatDayRange } from "@agency_hub_core/ui/format";
import { useOwnerCard } from "@/screens/people/registry";
import { PeopleMessageSend } from "@/shared/peopleMessages";
import { copyText } from "./copy";
import { usePayoutPrepare } from "./ledger";

/**
 * «Выплата» in a person's panel: the payout calculation the ledger gives (L5 `payout prepare`) — its lines, each a
 * week of a tab with its formula, a remainder of a day, the old debt or a manual posting with its reason; the total to
 * pay; what to look at before paying; and the person's message ready to copy with the suggested transfer in place of
 * the ledger's placeholder. Nothing is recorded or sent from here: the owner transfers, then sends the text himself.
 */

type Line = TeamLedgerPayoutPrepareResponse["lines"][number];
type Adjustment = TeamLedgerPayoutPersonResponse["adjustments"][number];

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

/** What a line is about, in one word: the tab's model, else the kind. */
const KIND_WORD: Record<string, string> = { opening: "старый долг", other: "поправка", unsplit: "прочее" };

/** The memo of a manual posting: the adjustment of the line's day with its sum (to the cent). */
function memoOf(line: Line, adjustments: readonly Adjustment[]): string | null {
  if (line.kind !== "other" || line.from === null) return null;
  const found = adjustments.find((one) => one.date === line.from && Math.abs(one.amountMills - line.shownMills) < 10 && one.memo.trim() !== "");
  return found?.memo.trim() ?? null;
}

export function PayoutBrief({ slug, name, adjustments, fallback }: {
  slug: string;
  name: string;
  /** The period's manual postings with their memo (the person read), to name a «поправка» line. */
  adjustments: readonly Adjustment[];
  /** What stands in when the ledger gives no calculation (no payout tab, or it did not answer). */
  fallback?: ReactNode;
}) {
  const prepare = usePayoutPrepare(slug);
  if (prepare.isLoading) return <Skeleton width="100%" height={120} radius={8} />;
  // No payout tab in the ledger (404) or the ledger did not answer: the panel's numbers above still stand.
  if (prepare.isError || prepare.data === undefined) return <>{fallback ?? null}</>;
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
  const columns: Column<Line>[] = [
    { key: "what", header: "Что", nowrap: true, cell: (line) => line.model ?? KIND_WORD[line.kind] ?? line.kind, footer: <span className="payouts-total">К выплате</span> },
    {
      key: "how",
      header: "Расчёт",
      grow: true,
      cell: (line) => {
        const memo = memoOf(line, adjustments);
        return <span className="payouts-line">{line.text}{memo && <span className="payouts-sub">{memo}</span>}</span>;
      },
    },
    { key: "sum", header: "Сумма", numeric: true, nowrap: true, cell: (line) => <Money mills={line.shownMills} />, footer: <Money mills={brief.amountMills} strong /> },
  ];
  return (
    <section className="payouts-block">
      <h3 className="payouts-block__title">Выплата</h3>
      {brief.lines.length > 0 && (
        <Table label={`Расчёт выплаты ${name}`} columns={columns} rows={brief.lines} rowKey={(line) => `${line.kind}-${line.model ?? ""}-${line.from ?? ""}-${line.text}`} dense stickyHeader={false} fit={false} />
      )}
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
      <PayoutTo slug={slug} />
      {blockers.length > 0 && (
        <Notice tone="warning" title={blockers.length === 1 ? "Перед выплатой разобраться" : `Перед выплатой разобраться: ${blockers.length}`}>
          <ul className="payouts-flags">
            {blockers.map((flag, index) => <li key={`${flag.kind}-${index}`}>{flag.text}</li>)}
          </ul>
        </Notice>
      )}
      {notes.length > 0 && (
        <ul className="payouts-flags payouts-flags--quiet" aria-label="Посмотреть перед выплатой">
          {notes.map((flag, index) => <li key={`${flag.kind}-${index}`}>{flag.text}</li>)}
        </ul>
      )}
      {message !== null && (
        <>
          <pre className="payouts-message">{message}</pre>
          <div className="payouts-message__actions">
            <Tooltip content={blockers.length > 0 ? "Есть что разобрать до выплаты; текст после перевода, с фактической суммой" : "Текст человеку после перевода: сумма предложенная, поправьте, если перевели другую"} align="start">
              <Button
                variant={blockers.length > 0 ? "secondary" : "primary"}
                icon={Copy}
                onClick={() => void copyText(message, `Скопировано: сообщение ${name}`)}
              >
                Скопировать
              </Button>
            </Tooltip>
            {/* Сообщения людям: only while the owner turned the payout text on and the bot is set. */}
            <PeopleMessageSend kind="payout.text" who={{ person: slug }} text={message} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Where to transfer, as the person wrote it on «Начало» (the people registry,
 * the owner's card): the ledger's code of a person is the registry's. Nothing
 * when the registry has no such person or did not answer.
 */
function PayoutTo({ slug }: { slug: string }) {
  const card = useOwnerCard(slug, true);
  if (!card.data) return null;
  const details = card.data.payoutDetails;
  return (
    <div className="payouts-transfer">
      <span className="payouts-transfer__label">Куда</span>
      {details
        ? <span className="payouts-to">{details.text}</span>
        : <span className="payouts-sub">Человек не написал в Hub, куда платить: спросите в личных сообщениях.</span>}
    </div>
  );
}
