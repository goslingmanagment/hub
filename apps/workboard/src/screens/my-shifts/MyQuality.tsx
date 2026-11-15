/**
 * «Мои смены»: how the person answers and writes (`accountShiftNumbers`, package N). The period's three quality
 * numbers in the header, each with the team's average of the same period in grey; a shift's own three under its row.
 * The team's is one number, never a list of people. The words are Workboard's (shared/metrics.ts).
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { Tooltip } from "@agency_hub_core/ui";
import { METRICS, PER_SHIFT_HINT, formatAiUnedited, formatReplyMedian, formatUnanswered } from "@/shared/metrics";

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

/** One shift's numbers, opened under its row. */
export function ShiftQualityLine({ quality }: { quality: Quality }) {
  return <Cells cells={cellsOf(quality, null, false)} className="mys-quality__list mys-quality__list--shift" />;
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
