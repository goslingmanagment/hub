import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Money, PageLabels, Tooltip, type ScreenRect } from "@agency_hub_core/ui";
import { formatDuration, formatMills, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { ShiftLink, shiftPath } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, UNANSWERED_NOW_LABEL } from "@/shared/metrics";
import type { PersonShift, PersonVisit, ReadState } from "./data.js";
import { beadSize, ribbonClock, ribbonDays, ribbonRowLabel, ribbonRowOf, ribbonRowStart, ribbonView, RIBBON_STEP_HOURS, type RibbonSale } from "./ribbon.js";
import { pagesInOrder } from "./ShiftTable.js";
import { KIND_OF, KINDS } from "./words.js";

/**
 * The person's shifts by the hour (kept from the console's «Статистика» — the
 * owner's favourite block): a row per day of the period, a bar per shift
 * (its pauses in another shade), a bead per sale — the bigger, the more money; a
 * hollow bead also counts for a colleague; a thin line is work outside a
 * shift. Only the hours that hold shifts are drawn; a row is called by the real
 * dates of those hours («пт, 6–7 нояб.» for a night, D12); today's row shows
 * once its hours begin. A bar opens that shift's review (the owner's).
 * Hover or focus tells the numbers.
 */

type Target = { kind: "shift"; shift: number } | { kind: "sale"; sale: RibbonSale } | { kind: "visit"; visit: number };
type Hover = Target & { at: ScreenRect };

export function ShiftRibbon({ userId, backLabel, shifts, visits, days, unknownBefore, salesRead, today, canOpen }: {
  userId: number;
  /** The review's «←» comes back here under this name. */
  backLabel: string;
  shifts: readonly PersonShift[];
  visits: readonly PersonVisit[];
  /** The days to draw (known ones only), any order. */
  days: readonly string[];
  /** The first day Hub has the person's shifts, when the period starts before it. */
  unknownBefore: string | null;
  /** Whether the sales (the beads) were read. */
  salesRead: ReadState;
  today: string;
  /** The viewer may open a shift's review (the owner): bars are links. */
  canOpen: boolean;
}) {
  const clock = useMemo(() => ribbonClock(shifts), [shifts]);
  const allRows = useMemo(() => ribbonDays(days, shifts, visits, clock), [days, shifts, visits, clock]);
  const nowAt = Date.now();
  const nowRow = ribbonRowOf(nowAt, clock);
  const nowMinute = (nowAt - ribbonRowStart(nowRow, clock)) / 60_000;
  const live = shifts.some((shift) => shift.ongoing);
  const view = useMemo(() => ribbonView(allRows, live ? [nowMinute] : []), [allRows, live, nowMinute]);
  // A row whose drawn hours have not begun yet (today's, at night for a day worker) says nothing: it stays out until
  // they begin. A row going on without work stays, quiet — «not working tonight» is news.
  const rows = useMemo(
    () => allRows.filter((row) => row.pieces.length > 0 || row.visits.length > 0 || nowAt >= ribbonRowStart(row.day, clock) + view.from * 60_000),
    [allRows, clock, view.from, nowAt],
  );
  const span = view.to - view.from;
  const left = (minute: number) => `${((Math.min(Math.max(minute, view.from), view.to) - view.from) / span) * 100}%`;
  const width = (from: number, to: number) => `${(Math.max(Math.min(to, view.to) - Math.max(from, view.from), 0) / span) * 100}%`;
  // The hour marks of the clock (every 3 h) that fall inside the drawn hours; the edges of a narrowed view carry no label.
  const marks = useMemo(() => {
    const step = RIBBON_STEP_HOURS * 60;
    const list: number[] = [];
    for (let minute = Math.ceil(view.from / step) * step; minute <= view.to; minute += step) list.push(minute);
    return list;
  }, [view.from, view.to]);
  const maxSale = useMemo(() => Math.max(0, ...shifts.flatMap((shift) => (shift.saleList ?? []).map((sale) => sale.netMills))), [shifts]);
  const labels = useMemo(() => new Map(rows.map((row) => [row.day, ribbonRowLabel(row.day, clock, view)])), [rows, clock, view]);
  // «пт, 31 окт. – 1 нояб.» needs a wider column than «вс, 1–2 нояб.».
  const dayColumn = Math.max(...[...labels.values()].map((label) => label.length), 0) > 15 ? "156px" : undefined;
  const hasPauses = shifts.some((shift) => shift.pauses.length > 0);
  const density = rows.length > 20 ? "dense" : rows.length > 10 ? "medium" : "roomy";
  const [hover, setHover] = useState<Hover | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const hasOverlap = shifts.some((shift) => (shift.saleList ?? []).some((sale) => sale.overlap));
  const kindsShown = KINDS.filter((kind) => shifts.some((shift) => (shift.saleList ?? []).some((sale) => sale.kind === kind.kind)));

  const show = (element: HTMLElement, target: Target) => {
    const box = element.getBoundingClientRect();
    setHover({ ...target, at: { x: box.left, y: box.top, width: box.width, height: box.height } });
  };
  const hoverProps = (target: Target) => ({
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => { if (event.pointerType === "mouse") show(event.currentTarget, target); },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => { if (event.pointerType === "mouse") setHover(null); },
    onFocus: (event: { currentTarget: HTMLElement }) => show(event.currentTarget, target),
    onBlur: () => setHover(null),
  });
  const openShift = (index: number) => {
    const shift = shifts[index];
    if (!shift || !canOpen) return;
    navigate(shiftPath(userId, shift.startedAt, location.search), { state: { back: { to: `${location.pathname}${location.search}`, label: backLabel } } });
  };

  // A tap outside a mark closes its numbers; so do Esc and a scroll (the hint stands where the mark was).
  useEffect(() => {
    if (hover === null) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-ribbon-mark]")) setHover(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setHover(null); };
    const scroll = () => setHover(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scroll);
    };
  }, [hover]);

  return (
    <div className="people-ribbon" data-density={density} style={dayColumn ? { ["--day-col" as string]: dayColumn } : undefined}>
      <div className="people-ribbon__row people-ribbon__head" aria-hidden>
        <span />
        <div className="people-ribbon__hours">
          {marks.map((minute) => (
            <span key={minute} style={{ left: left(minute) }} data-edge={minute === view.from ? "start" : minute === view.to ? "end" : undefined}>
              {String((clock.startHour + minute / 60) % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
        <span className="people-ribbon__total-head">продажи</span>
      </div>

      <ol className="people-ribbon__days" aria-label="Смены по дням и часам, московское время">
        {rows.map((row) => (
          <li key={row.day} className="people-ribbon__row" data-today={(row.day === today && row.pieces.length > 0) || undefined}>
            <span className="people-ribbon__day">{labels.get(row.day)}</span>
            <div className="people-ribbon__track">
              {marks.filter((minute) => minute > view.from && minute < view.to).map((minute) => <span key={minute} className="people-ribbon__grid" style={{ left: left(minute) }} />)}
              {row.visits.map((visit) => {
                // Work outside a shift beyond the drawn hours stands at that edge, an arrow pointing where it was.
                const edge = visit.to <= view.from ? "start" : visit.from >= view.to ? "end" : undefined;
                return (
                  <span
                    key={`visit-${visit.visit}`}
                    className="people-ribbon__visit"
                    data-edge={edge}
                    style={edge ? undefined : { left: left(visit.from), width: width(visit.from, visit.to) }}
                    data-ribbon-mark
                    tabIndex={-1}
                    {...hoverProps({ kind: "visit", visit: visit.visit })}
                  />
                );
              })}
              {row.pieces.map((piece) => {
                const shift = shifts[piece.shift]!;
                const label = `${shiftWhen(shift).label}: продажи ${formatMills(shift.salesNetMills)}${canOpen ? ". Открыть разбор" : ""}`;
                const pauses = piece.pauses.map((pause) => (
                  <span
                    key={pause.from}
                    className="people-ribbon__pause"
                    style={{
                      left: `${((pause.from - piece.from) / Math.max(piece.to - piece.from, 1)) * 100}%`,
                      width: `${((pause.to - pause.from) / Math.max(piece.to - piece.from, 1)) * 100}%`,
                    }}
                  />
                ));
                return (
                  <span
                    key={`${piece.shift}-${piece.from}`}
                    className="people-ribbon__piece"
                    data-live={piece.live || undefined}
                    style={{ left: left(piece.from), width: width(piece.from, piece.to) }}
                    data-ribbon-mark
                    {...hoverProps({ kind: "shift", shift: piece.shift })}
                  >
                    {canOpen ? (
                      <ShiftLink userId={userId} startedAt={shift.startedAt} backLabel={backLabel} className="people-ribbon__shift">
                        <span className="ui-sr-only">{label}</span>
                        {pauses}
                      </ShiftLink>
                    ) : (
                      <span className="people-ribbon__shift" tabIndex={0} aria-label={label}>{pauses}</span>
                    )}
                  </span>
                );
              })}
              {row.sales.map((sale, index) => {
                const size = beadSize(sale.netMills, maxSale, density);
                return (
                  <span
                    key={`${sale.at}-${index}`}
                    className="people-ribbon__sale"
                    data-overlap={sale.overlap || undefined}
                    data-open={canOpen || undefined}
                    data-ribbon-mark
                    style={{ left: left(sale.minute), ["--bead" as string]: `${size}px`, ["--kind" as string]: KIND_OF[sale.kind].color }}
                    onClick={() => openShift(sale.shift)}
                    {...hoverProps({ kind: "sale", sale })}
                  />
                );
              })}
              {row.day === nowRow && live && nowMinute >= view.from && nowMinute <= view.to && (
                <span className="people-ribbon__now" style={{ left: left(nowMinute) }} aria-hidden />
              )}
            </div>
            <span className="people-ribbon__total">{row.totalMills === null ? "" : <Money mills={row.totalMills} />}</span>
          </li>
        ))}
      </ol>

      <div className="people-ribbon__foot">
        <ul className="people-ribbon__legend" aria-label="Обозначения">
          {kindsShown.map((kind) => (
            <li key={kind.kind}>
              <span aria-hidden className="people-ribbon__key-bead" style={{ background: kind.color }} />
              {kind.label}
            </li>
          ))}
          {hasOverlap && (
            <li>
              <span aria-hidden className="people-ribbon__key-bead people-ribbon__key-bead--hollow" />
              видна и у коллеги
            </li>
          )}
          <li>
            <span aria-hidden className="people-ribbon__key-shift" />
            смена
          </li>
          {hasPauses && (
            <li>
              <span aria-hidden className="people-ribbon__key-pause" />
              пауза
            </li>
          )}
          {visits.length > 0 && (
            <li>
              <span aria-hidden className="people-ribbon__key-visit" />
              работа вне смены
            </li>
          )}
        </ul>
        {salesRead === "off" && <p className="people-ribbon__note">Продажи точками Hub показывает только за последний 31 день.</p>}
        {salesRead === "failed" && <p className="people-ribbon__note">Продажи по минутам не пришли: на ленте только смены.</p>}
        {unknownBefore && <p className="people-ribbon__note">Раньше {unknownBefore} смены не записывались: расширение начало их считать в этот день.</p>}
      </div>

      <Tooltip at={hover?.at ?? null} content={hover ? <RibbonTip hover={hover} shifts={shifts} visits={visits} canOpen={canOpen} /> : null} />
    </div>
  );
}

function TipRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="people-tip__row">
      <span className="people-tip__name">{name}</span>
      <span className="people-tip__value">{children}</span>
    </div>
  );
}

function RibbonTip({ hover, shifts, visits, canOpen }: { hover: Hover; shifts: readonly PersonShift[]; visits: readonly PersonVisit[]; canOpen: boolean }) {
  if (hover.kind === "sale") {
    const { sale } = hover;
    const kind = KIND_OF[sale.kind];
    return (
      <div className="people-tip">
        <div className="people-tip__row">
          <span aria-hidden className="people-ribbon__key-bead" style={{ background: kind.color }} />
          <span className="people-tip__name">{kind.one}</span>
          <Money mills={sale.netMills} strong />
        </div>
        <div className="people-tip__note">{formatTimeOfDay(sale.at)} · {sale.pageLabel}{sale.fanName ? ` · ${sale.fanName}` : ""}</div>
        {sale.overlap && <div className="people-tip__note">Страницу вели двое, этому фану никто из них не писал: продажа видна у обоих.</div>}
      </div>
    );
  }
  if (hover.kind === "visit") {
    const visit = visits[hover.visit];
    if (!visit) return null;
    return (
      <div className="people-tip">
        <div className="people-tip__title">Работа вне смены, {formatTimeOfDay(visit.startedAt)}–{formatTimeOfDay(visit.endedAt)}</div>
        <div className="people-tip__note">
          {formatDuration(visit.workedMinutes)}, {visit.messages} {ruPlural(visit.messages, "сообщение", "сообщения", "сообщений")}. Не смена: в продажи не входит.
        </div>
      </div>
    );
  }
  const shift = shifts[hover.shift];
  if (!shift) return null;
  const numbers = shift.numbers;
  const when = shiftWhen(shift);
  return (
    <div className="people-tip">
      <div className="people-tip__title">{when.label}</div>
      <TipRow name="Продажи"><Money mills={shift.salesNetMills} strong /></TipRow>
      <TipRow name="Длительность">{when.worked}</TipRow>
      {when.withPauses && <div className="people-tip__note people-tip__note--right">{when.withPauses}</div>}
      {numbers && (
        <>
          <TipRow name={METRICS.reply.label}>{formatReplyMedian(numbers.replyMedianSeconds)}</TipRow>
          <TipRow name={shift.ongoing ? UNANSWERED_NOW_LABEL : METRICS.unanswered.label}>{formatUnanswered(numbers.unansweredAtEnd)}</TipRow>
          <TipRow name={METRICS.aiUnedited.label}>{formatAiUnedited(numbers.aiUneditedShare)}</TipRow>
        </>
      )}
      <div className="people-tip__note"><PageLabels labels={pagesInOrder(shift.pages)} max={4} /></div>
      {canOpen && <div className="people-tip__hint">Нажмите — откроется разбор смены</div>}
    </div>
  );
}
