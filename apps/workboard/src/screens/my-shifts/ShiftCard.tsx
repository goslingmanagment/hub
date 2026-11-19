import { ChevronDown, ChevronUp } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Badge, Button, LinkButton, Money, PageLabels, Tooltip } from "@agency_hub_core/ui";
import { formatMills } from "@agency_hub_core/ui/format";
import { KINDS, shareOf, shareText } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftPauseText } from "@agency_hub_core/ui/shiftLive";
import { shiftDurationHint } from "@agency_hub_core/ui/shiftWhen";
import { ReportBody } from "@/shared/ReportBody";
import { ReportNoteLine } from "@/shared/ReportNote";
import type { PlacedNote } from "@/shared/reportNotes";
import { shiftPath, type BackTarget } from "@/shared/links";
import { KIND_SHORT, reportStepOf, type MyShiftRow, type ReportStep, type StatsShift } from "./model";
import { AccrualLine } from "./MyMoney";
import type { MoneyDay } from "./money";
import { ShiftNumbersLine, type ShiftNumbers } from "./MyQuality";
import { ShiftTrack } from "./ShiftTrack";

/**
 * One shift of «Мои смены» as a card: its report at a glance. When (the day, the clock, «сейчас»), the pages and the
 * time worked; the money — the report's one number («по отчёту»; a draft's, «предварительно»), else, before any report,
 * the shift's sales by the rule («по правилу»), never a third; the shift's line in time with a bead per sale; what its
 * sales are made of; its numbers; and where the report stands, with the one step to take when something is due.
 *
 * The card opens the shift's page (`/shifts/:userId/:shiftStart`: the report, its numbers and the pulse in one place);
 * its button opens the board. A report Hub has no shift for, or a post in «Отчётность», opens in place, as before.
 */

const STEP_TONE: Record<ReportStep["tone"], "warning" | "success" | "info" | "off"> = { warn: "warning", good: "success", live: "info", quiet: "off" };

/** The card's money: the report's, a draft's «предварительно», or the rule's before any report. */
function CardMoney({ row, accrual }: { row: MyShiftRow; accrual: MoneyDay | undefined }) {
  let money: ReactNode;
  if (row.totalMills !== null && row.preliminary) {
    money = (
      <Tooltip content="Черновик отчёта: сумма по правилу и вашим отметкам. Станет итоговой, когда вы сдадите смену." align="end">
        <span className="mys-card__sum"><Money mills={row.totalMills} /><span className="mys-card__sum-word mys-card__sum-word--pre">предварительно</span></span>
      </Tooltip>
    );
  } else if (row.totalMills !== null) {
    money = <span className="mys-card__sum"><Money mills={row.totalMills} strong /><span className="mys-card__sum-word">по отчёту</span></span>;
  } else if (row.hubMills !== null) {
    // No report yet: the shift's sales by the rule (`hubMills` is `ruleMills` where there is no report), said so.
    money = (
      <Tooltip content="Продажи смены по правилу «чья продажа», как их видит Hub: это не отчёт. Сумма отчёта может быть другой: в нём делят продажи с коллегами и добавляют то, чего нет в Hub." align="end">
        <span className="mys-card__sum mys-card__sum--rule"><Money mills={row.hubMills} /><span className="mys-card__sum-word">по правилу</span></span>
      </Tooltip>
    );
  } else {
    money = null;
  }
  return (
    <div className="mys-card__money">
      {money}
      {accrual !== undefined && <AccrualLine day={accrual} />}
    </div>
  );
}

/** What the shift's sales are made of: one thin bar of shares by kind, the shares in words. The parts are Hub's sums. */
function KindsLine({ shift }: { shift: StatsShift }) {
  const total = shift.salesNetMills;
  const count = shift.sales.length;
  const parts = KINDS.filter((kind) => shift.byKind[kind.kind] > 0).map((kind) => ({ ...kind, mills: shift.byKind[kind.kind] }));
  if (count === 0 || total <= 0) {
    return <div className="mys-kinds mys-kinds--none">{shift.ongoing ? "Продаж пока нет" : "Продаж не было"}</div>;
  }
  return (
    <div className="mys-kinds">
      <div className="mys-kinds__head">
        {count} {ruPlural(count, "продажа", "продажи", "продаж")}
      </div>
      <span className="mys-kinds__bar" role="img" aria-label={parts.map((part) => `${KIND_SHORT[part.kind]} ${shareText(shareOf(part.mills, total))}`).join(", ")}>
        {parts.map((part) => <i key={part.kind} style={{ flexGrow: part.mills, background: part.color }} />)}
      </span>
      <ul className="mys-kinds__legend">
        {parts.map((part) => (
          <li key={part.kind}>
            <Tooltip content={`${part.label}: ${formatMills(part.mills)} по правилу`} align="start">
              <span className="mys-kinds__item">
                <span aria-hidden className="wb-kind-key" style={{ background: part.color }} />
                {KIND_SHORT[part.kind]} <b>{shareText(shareOf(part.mills, total))}</b>
              </span>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ShiftCardProps {
  row: MyShiftRow;
  /** The person's login, for the shift's page; null — not known yet. */
  userId: number | null;
  /** The shift's numbers (`accountShiftNumbers`); undefined — none (yet). */
  numbers: ShiftNumbers | undefined;
  /** The period's biggest sale: the beads of every card are sized against it. */
  maxSaleMills: number;
  accrual: MoneyDay | undefined;
  note: PlacedNote | undefined;
  /** The report opened in place (a post in «Отчётность»). */
  open: boolean;
  onOpen: (open: boolean) => void;
  back: { back: BackTarget };
}

export function ShiftCard({ row, userId, numbers, maxSaleMills, accrual, note, open, onOpen, back }: ShiftCardProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const step = reportStepOf(row);
  const shift = row.shift;
  const page = shift !== null && userId !== null ? shiftPath(userId, shift.startedAt, location.search) : null;
  const board = row.hub === null ? null : `/report/${row.hub.shiftId}`;
  // A post in «Отчётность» (the old way) opens in place, as the journal's row did.
  const inPlace = row.hub === null && row.report !== null;
  const hint = row.workedMinutes !== null ? shiftDurationHint(row.when) : null;
  // The whole card opens the shift's page; a press on a button or a link stays theirs, and the report opened in place
  // is read, not left.
  const onCard = (event: MouseEvent<HTMLElement>) => {
    if (page === null || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as Element).closest("a, button, .mys-card__report")) return;
    if (window.getSelection()?.toString()) return;
    navigate(page, { state: back });
  };

  const pause = shift === null ? null : shiftPauseText(shift);

  return (
    <li className="mys-card" data-key={row.key} data-link={page !== null || undefined} onClick={onCard}>
      <div className="mys-card__head">
        <div className="mys-card__when">
          {page !== null
            ? <Link to={page} state={back} className="mys-card__day">{row.when.days}</Link>
            : <span className="mys-card__day">{row.when.days}</span>}
          <span className="mys-card__time" data-live={shift?.ongoing || undefined}>
            {shift?.ongoing && <span aria-hidden className="mys-card__dot" />}
            {row.when.time}
          </span>
          {/* A going shift in a break (a break inside one's own slot is a pause of the shift, not its end). */}
          {pause !== null && <span className="mys-card__pause">{pause}</span>}
        </div>
        <div className="mys-card__meta">
          {row.workedMinutes !== null && (
            <Tooltip content={hint ?? ""} align="start"><span>{row.when.worked} работы</span></Tooltip>
          )}
          {row.pages.length > 0 && <PageLabels labels={row.pages} />}
          {shift === null && (
            <Tooltip
              content={row.report?.source === "post"
                ? "Hub не видел в этот день вашей работы в расширении ChatGoose: к какой смене относится отчёт, неизвестно."
                : "Hub не видел в это время вашей работы в расширении ChatGoose: отчёт собрали без смены."}
              align="start"
            >
              <span className="mys-card__lost">смена в Hub не найдена</span>
            </Tooltip>
          )}
        </div>
      </div>
      <CardMoney row={row} accrual={accrual} />
      {shift !== null && <div className="mys-card__track"><ShiftTrack shift={shift} maxSaleMills={maxSaleMills} /></div>}
      {shift !== null && <div className="mys-card__kinds"><KindsLine shift={shift} /></div>}
      {numbers !== undefined && <div className="mys-card__nums"><ShiftNumbersLine shift={numbers} /></div>}
      {note !== undefined && <div className="mys-card__note"><ReportNoteLine placed={note} own sum={false} /></div>}
      <div className="mys-card__foot">
        {step.words !== "" && (
          <span className="mys-card__state">
            <Badge tone={STEP_TONE[step.tone]} bare={step.tone !== "warn"}>{step.words}</Badge>
            {step.note !== null && <span className="mys-card__state-note">{step.note}</span>}
          </span>
        )}
        <span className="mys-card__actions">
          {inPlace && (
            <Button size="md" variant="ghost" icon={open ? ChevronUp : ChevronDown} aria-expanded={open} onClick={() => onOpen(!open)}>
              {open ? "Свернуть отчёт" : "Отчёт"}
            </Button>
          )}
          {board !== null && step.action !== null && <LinkButton to={board} state={back} variant="primary" size="md">{step.action}</LinkButton>}
          {board !== null && step.action === null && <LinkButton to={board} state={back} variant="ghost" size="md">Открыть отчёт</LinkButton>}
        </span>
      </div>
      {inPlace && open && row.report !== null && <div className="mys-card__report"><ReportBody report={row.report} /></div>}
    </li>
  );
}
