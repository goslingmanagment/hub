import { Money, Tooltip } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import { KIND_OF } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { beadSize } from "@agency_hub_core/ui/ribbon";
import type { StatsShift } from "./model";

/**
 * One shift's line on its card: the shift from its start to its end (to now while it goes on) as one bar, its pauses
 * a paler stretch, a bead per sale at its minute — the bigger, the more money; a hollow one also counts for a
 * colleague. The lead's ribbon of the person's shifts by the hour (screens/team/ShiftRibbon.tsx) draws the same marks,
 * the same sizes (`beadSize`) and colours; here each shift has its own line, as wide as the card. A bead tells its
 * sale on hover (the line says the whole in words to a screen reader; the shift's page lists every sale). Hour marks
 * under the line, so a long shift looks long.
 */

const HOUR_MS = 3_600_000;

/** The whole hours inside the shift, at most five labels: every hour, every 2, 3… */
function hourMarks(start: number, end: number): number[] {
  const hours = (end - start) / HOUR_MS;
  const step = Math.max(1, Math.ceil(hours / 5));
  const marks: number[] = [];
  // Moscow has no DST: a whole Moscow hour is a whole UTC hour.
  for (let at = Math.ceil(start / HOUR_MS) * HOUR_MS; at < end; at += HOUR_MS) {
    const hour = new Date(at + 3 * HOUR_MS).getUTCHours();
    if (hour % step === 0) marks.push(at);
  }
  return marks;
}

export function ShiftTrack({ shift, maxSaleMills }: { shift: StatsShift; maxSaleMills: number }) {
  const start = Date.parse(shift.startedAt);
  const end = Math.max(Date.parse(shift.endedAt), start + 60_000);
  const span = end - start;
  const at = (moment: number) => `${(Math.min(Math.max(moment - start, 0), span) / span) * 100}%`;
  const width = (from: number, to: number) => `${(Math.max(Math.min(to, end) - Math.max(from, start), 0) / span) * 100}%`;
  const sales = [...shift.sales].sort((a, b) => a.at.localeCompare(b.at));
  const marks = hourMarks(start, end);
  const label = [
    `${formatTimeOfDay(start)}–${shift.ongoing ? "сейчас" : formatTimeOfDay(end)}`,
    shift.pauses.length > 0 ? `${shift.pauses.length} ${ruPlural(shift.pauses.length, "пауза", "паузы", "пауз")}` : null,
    `${sales.length} ${ruPlural(sales.length, "продажа", "продажи", "продаж")}`,
  ].filter(Boolean).join(", ");
  return (
    <div className="mys-track">
      <div className="mys-track__line" role="img" aria-label={`Смена по времени: ${label}`}>
        {marks.map((mark) => <span key={mark} className="mys-track__grid" style={{ left: at(mark) }} aria-hidden />)}
        <span className="mys-track__bar" data-live={shift.ongoing || undefined} aria-hidden>
          {shift.pauses.map((pause) => (
            <span key={pause.from} className="mys-track__pause" style={{ left: at(Date.parse(pause.from)), width: width(Date.parse(pause.from), Date.parse(pause.to)) }} />
          ))}
        </span>
        {sales.map((sale, index) => {
          const kind = KIND_OF[sale.kind];
          return (
            <Tooltip
              key={`${sale.at}-${index}`}
              className="mys-track__tip"
              content={(
                <span className="mys-track__hint">
                  <span className="mys-track__hint-head">
                    <span aria-hidden className="wb-kind-key" style={{ background: kind.color }} />
                    {kind.one}
                    <Money mills={sale.netMills} strong />
                  </span>
                  <span>{formatTimeOfDay(sale.at)} · {sale.pageLabel}{sale.fanName ? ` · ${sale.fanName}` : ""}</span>
                  {sale.overlap && <span>Страницу вели двое, этому фану никто из вас не писал: продажа видна у обоих.</span>}
                </span>
              )}
            >
              <span
                className="mys-track__sale"
                data-overlap={sale.overlap || undefined}
                style={{ left: at(Date.parse(sale.at)), ["--bead" as string]: `${beadSize(sale.netMills, maxSaleMills, "medium")}px`, ["--kind" as string]: kind.color }}
              />
            </Tooltip>
          );
        })}
        {shift.ongoing && <span className="mys-track__now" aria-hidden />}
      </div>
      <div className="mys-track__hours" aria-hidden>
        {marks.map((mark) => (
          <span key={mark} style={{ left: at(mark) }}>{String(new Date(mark + 3 * HOUR_MS).getUTCHours()).padStart(2, "0")}</span>
        ))}
      </div>
    </div>
  );
}
