/**
 * «Мои смены»: how the person answers and writes (`accountShiftNumbers`, package N). The period's three quality
 * numbers in the header, each with the team's average of the same period in grey; a shift's own numbers on its card.
 * The team's is one number, never a list of people. The words are Workboard's (shared/metrics.ts). Every number of a
 * shift here is this one read's (the person's, all pages): never beside the same number of another read.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { Tooltip } from "@agency_hub_core/ui";
import { formatCount } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { METRICS, PER_SHIFT_HINT, UNANSWERED_NOW_LABEL, formatAiUnedited, formatReplyMedian, formatUnanswered } from "@/shared/metrics";

type Answer = KernelOperationResponse<"accountShiftNumbers">;
type Quality = Answer["shifts"][number]["quality"];
type Average = Answer["period"]["quality"];

interface Cell {
  key: string;
  label: string;
  hint: string;
  value: string;
  team: string | null;
}

function cellsOf(quality: Quality | Average, team: Average | null, average: boolean): Cell[] {
  return [
    { key: "reply", label: METRICS.reply.label, hint: METRICS.reply.hint, value: formatReplyMedian(quality.replyMedianSeconds), team: team ? formatReplyMedian(team.replyMedianSeconds) : null },
    {
      key: "unanswered", label: METRICS.unanswered.label, hint: METRICS.unanswered.hint,
      value: formatUnanswered(quality.unansweredAtEnd, { average }), team: team ? formatUnanswered(team.unansweredAtEnd, { average: true }) : null,
    },
    { key: "ai", label: METRICS.aiUnedited.label, hint: METRICS.aiUnedited.hint, value: formatAiUnedited(quality.aiUneditedShare), team: team ? formatAiUnedited(team.aiUneditedShare) : null },
  ];
}

function Cells({ cells, className }: { cells: readonly Cell[]; className: string }) {
  return (
    <dl className={className}>
      {cells.map((cell) => (
        <div key={cell.key} className="mys-quality__item">
          <dt><Tooltip content={cell.hint}><span className="mys-quality__label">{cell.label}</span></Tooltip></dt>
          <dd>
            <span className="mys-quality__value">{cell.value}</span>
            {cell.team !== null && <span className="mys-quality__team"> · команда {cell.team}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The period's line under the header's facts. */
export function PeriodQualityLine({ answer }: { answer: Answer }) {
  if (answer.period.shifts === 0) return null;
  return (
    <div className="mys-quality" title={PER_SHIFT_HINT}>
      <Cells cells={cellsOf(answer.period.quality, answer.team, true)} className="mys-quality__list" />
    </div>
  );
}

export type ShiftNumbers = Answer["shifts"][number];

/**
 * A shift's numbers on its card, one compact row: what the person did (messages, PPV sent → bought, fans written to →
 * paid) and how they answered (the three quality numbers). A number shows only where the read has it.
 */
export function ShiftNumbersLine({ shift }: { shift: Pick<ShiftNumbers, "numbers" | "quality" | "ongoing"> }) {
  const { numbers, quality } = shift;
  const items: Array<{ key: string; label: string; value: string; hint: string }> = [
    {
      key: "messages", label: ruPlural(numbers.messages, "сообщение", "сообщения", "сообщений"), value: formatCount(numbers.messages),
      hint: "Личные сообщения фанам за смену, на всех страницах. Рассылки не в счёте.",
    },
  ];
  if (numbers.ppvSent > 0) {
    items.push({
      key: "ppv", label: "PPV", value: `${formatCount(numbers.ppvSent)} → ${formatCount(numbers.ppvBought)}`,
      hint: `Платных сообщений отправлено ${formatCount(numbers.ppvSent)}, из них куплено ${formatCount(numbers.ppvBought)}.`,
    });
  }
  if (numbers.fansWritten > 0) {
    items.push({
      key: "fans", label: "Фаны", value: `${formatCount(numbers.fansWritten)} → ${formatCount(numbers.fansPaid)}`,
      hint: `Вы писали ${formatCount(numbers.fansWritten)} фанам, из них ${formatCount(numbers.fansPaid)} заплатили до конца смены.`,
    });
  }
  if (quality.replyMedianSeconds !== null) {
    items.push({ key: "reply", label: METRICS.reply.label, value: formatReplyMedian(quality.replyMedianSeconds), hint: METRICS.reply.hint });
  }
  items.push({
    key: "unanswered", label: shift.ongoing ? UNANSWERED_NOW_LABEL : METRICS.unanswered.label, value: formatUnanswered(quality.unansweredAtEnd),
    hint: METRICS.unanswered.hint,
  });
  if (quality.aiUneditedShare !== null) {
    items.push({ key: "ai", label: METRICS.aiUnedited.label, value: formatAiUnedited(quality.aiUneditedShare), hint: METRICS.aiUnedited.hint });
  }
  return (
    <ul className="mys-nums" aria-label="Числа смены">
      {items.map((item) => (
        <li key={item.key} className="mys-nums__item">
          <Tooltip content={item.hint} align="start">
            {/* A count reads «121 сообщение»; the rest «PPV 8 → 3», «Ответ, медиана 4 мин 31 с». */}
            <span className="mys-nums__pair">
              {item.key === "messages"
                ? <><b>{item.value}</b> {item.label}</>
                : <><span className="mys-nums__label">{item.label}</span> <b>{item.value}</b></>}
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/** The shift of the answer that is this row's: the same start, else the one that overlaps it most (a start can move between two reads). */
export function numbersOfRow(answer: Answer | undefined, shift: { startedAt: string; endedAt: string } | null): Answer["shifts"][number] | undefined {
  if (!answer || shift === null) return undefined;
  const exact = answer.shifts.find((one) => one.startedAt === shift.startedAt);
  if (exact) return exact;
  const start = Date.parse(shift.startedAt);
  const end = Date.parse(shift.endedAt);
  let best: Answer["shifts"][number] | undefined;
  let bestOverlap = 0;
  for (const one of answer.shifts) {
    const overlap = Math.min(end, Date.parse(one.endedAt)) - Math.max(start, Date.parse(one.startedAt));
    if (overlap > bestOverlap) {
      best = one;
      bestOverlap = overlap;
    }
  }
  return best;
}
