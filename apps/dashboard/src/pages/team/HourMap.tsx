import type { TeamEmptyHoursResponse } from "@agency_hub_core/contracts";
import { PageLink } from "./teamLinks.js";

/**
 * «В какие часы пусто»: a heat map, pages by Moscow hour of day, a number in
 * every cell. The fill only repeats the number (never says it alone): more than
 * half the row's top is the darker step, any other count the lighter one, zero
 * no fill and a quiet «0».
 */

type Page = TeamEmptyHoursResponse["pages"][number];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourLabel = (hour: number) => String(hour).padStart(2, "0");

function Cells({ byHour }: { byHour: readonly number[] }) {
  const max = Math.max(0, ...byHour);
  return (
    <>
      {HOURS.map((hour) => {
        const value = byHour[hour] ?? 0;
        const step = value === 0 ? "0" : value * 2 > max ? "2" : "1";
        const label = `${hourLabel(hour)}:00, пустых часов: ${value}`;
        return <td key={hour} className="hour-cell" data-step={step} title={label} aria-label={label}>{value}</td>;
      })}
    </>
  );
}

export function HourMap({ pages }: { pages: readonly Page[] }) {
  const counted = pages.filter((page) => page.shiftsSince !== null);
  const total = HOURS.map((hour) => counted.reduce((sum, page) => sum + (page.emptyByHour[hour] ?? 0), 0));
  return (
    <div className="table-wrap hour-map-wrap">
      <table className="hour-map">
        <thead>
          <tr>
            <th scope="col" className="hour-map-label"><span className="sr-only">Страница</span></th>
            {HOURS.map((hour) => <th key={hour} scope="col">{hourLabel(hour)}</th>)}
          </tr>
        </thead>
        <tbody>
          {counted.length >= 2 && (
            <tr className="hour-map-total">
              <th scope="row" className="hour-map-label">Все страницы</th>
              <Cells byHour={total} />
            </tr>
          )}
          {pages.map((page) => (
            <tr key={page.pageLabel}>
              <th scope="row" className="hour-map-label"><PageLink label={page.pageLabel} /></th>
              {page.shiftsSince === null
                ? <td colSpan={24} className="hour-map-note">смен в расширении ещё не было</td>
                : page.emptyHours === 0
                  ? <td colSpan={24} className="hour-map-note">Пустых часов нет</td>
                  : <Cells byHour={page.emptyByHour} />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
