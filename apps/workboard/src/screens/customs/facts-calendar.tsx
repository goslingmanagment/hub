import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { CustomBoardOrder } from "@agency_hub_core/contracts";
import { Button, cx, IconButton, Money, Segmented, StatusDot } from "@agency_hub_core/ui";
import { addDays, mondayOf, weekdayIndex } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { OrderPrice, OrderRow } from "./facts-row";
import {
  MONTHS_OF, WEEKDAYS, daysFrom, daysWord, dotted, fanName, monthTitle, priceOf, sumOf, todayOf, toneOf, type Tone,
} from "./facts-words";

/**
 * «Календарь» of the facts screen (customs facts spec §13, C5): two forms under one small switch, the choice kept in
 * this browser. «Месяц»: a Monday-to-Sunday grid from the current week (the one before it when something is overdue)
 * for at least three weeks, an order a two-line chip on its deadline day, overdue ones red in their past day; on the
 * right the orders with no deadline. «Расписание»: a small month with a dot per order on its day (a press keeps that
 * day), and the days that have orders with the same rows as «Сроки», the overdue first, the ones with no deadline last.
 * With one model picked both show that model alone (the screen's filter): what the customs lead reads before forwarding.
 */

export type CalendarForm = "month" | "agenda";
const FORM_KEY = "wb.customs.calendar";

function storedForm(): CalendarForm {
  try {
    return window.localStorage.getItem(FORM_KEY) === "agenda" ? "agenda" : "month";
  } catch {
    return "month";
  }
}

function storeForm(form: CalendarForm) {
  try {
    window.localStorage.setItem(FORM_KEY, form);
  } catch {
    // A browser that keeps nothing: the choice lasts until the page is left.
  }
}

const count = (orders: readonly unknown[]) => `${orders.length} ${ruPlural(orders.length, "заказ", "заказа", "заказов")}`;
const byPrice = (left: CustomBoardOrder, right: CustomBoardOrder) => priceOf(right) - priceOf(left) || left.id - right.id;
/** Overdue: past its day and not on hold (a hold never burns). */
const isLate = (order: CustomBoardOrder) => order.holdReason === null && order.dueLeftDays !== null && order.dueLeftDays < 0;

function ToneDot({ tone }: { tone: Tone }) {
  if (tone === "calm") return null;
  return <StatusDot tone={tone === "danger" ? "danger" : "warning"} />;
}

/** An order in its day: the fan with the tone's dot, then the code and the price. */
function Chip({ order, onOpen }: { order: CustomBoardOrder; onOpen: (code: string) => void }) {
  return (
    <button type="button" className={cx("cf-ev", isLate(order) && "cf-ev--late")} onClick={() => onOpen(order.code)}>
      <span className="cf-ev__name"><ToneDot tone={toneOf(order)} /><b>{fanName(order)}</b></span>
      <span className="cf-ev__sub"><span className="cf-code">{order.code}</span><OrderPrice order={order} /></span>
    </button>
  );
}

/** A list beside the month: «Без срока», and what falls before or after the weeks shown. */
function Tray({ title, orders, note, onOpen }: { title: string; orders: readonly CustomBoardOrder[]; note: (order: CustomBoardOrder) => string | null; onOpen: (code: string) => void }) {
  if (orders.length === 0) return null;
  return (
    <section className="cf-tray">
      <h3 className="cf-tray__head"><b>{title}</b><span>{orders.length}, <Money mills={sumOf(orders)} /></span></h3>
      <ul>
        {orders.map((order) => (
          <li key={order.id}>
            <button type="button" className="cf-tray__item" onClick={() => onOpen(order.code)}>
              <span className="cf-tray__l1">
                <ToneDot tone={toneOf(order)} />
                <b>{fanName(order)}</b>
                <span className="cf-code">{order.code}</span>
                <span className="cf-tray__sum"><OrderPrice order={order} /></span>
              </span>
              <span className="cf-tray__l2">
                {[order.pageLabel ?? "страница не определена", order.volume, note(order)].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MonthForm({ orders, today, onOpen }: { orders: readonly CustomBoardOrder[]; today: string; onOpen: (code: string) => void }) {
  const [shift, setShift] = useState(0);
  const dated = orders.filter((order) => order.deadlineOn !== null);
  const days = dated.map((order) => order.deadlineOn!).sort();
  const first = days[0] !== undefined && days[0] < today ? days[0] : today;
  // From the week of the earliest overdue day, but no more than a week back; at least three weeks, at most five.
  const baseStart = [mondayOf(first), addDays(mondayOf(today), -7)].sort().at(-1)!;
  const last = days.at(-1) !== undefined && days.at(-1)! > today ? days.at(-1)! : today;
  const weeks = Math.min(5, Math.max(3, Math.round(daysFrom(baseStart, mondayOf(last)) / 7) + 1));
  const start = addDays(baseStart, shift * 7);
  const end = addDays(start, weeks * 7);
  const cells = Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
  const at = (day: string) => dated.filter((order) => order.deadlineOn === day).sort(byPrice);
  return (
    <div className="cf-month">
      <div className="cf-month__main">
        <div className="cf-cal-bar">
          <h2 className="cf-cal-title">{monthTitle(addDays(start, 7))}</h2>
          <span className="cf-cal-nav">
            <Button size="sm" disabled={shift === 0} onClick={() => setShift(0)}>Сегодня</Button>
            <IconButton icon={ChevronLeft} label="Раньше" onClick={() => setShift(shift - 1)} />
            <IconButton icon={ChevronRight} label="Позже" onClick={() => setShift(shift + 1)} />
          </span>
        </div>
        <div className="cf-month__wd" aria-hidden>
          {WEEKDAYS.map((day, index) => <span key={day} className={index > 4 ? "cf-rest" : undefined}>{day}</span>)}
        </div>
        <div className="cf-month__grid">
          {cells.map((day) => (
            <div key={day} className={cx("cf-cell", day === today && "cf-cell--today", day < today && "cf-cell--past", weekdayIndex(day) > 4 && "cf-cell--rest")}>
              <span className="cf-cell__num">
                <b>{Number(day.slice(8, 10))}</b>
                {day === today ? <small>сегодня</small> : day.endsWith("-01") ? <small>{MONTHS_OF[Number(day.slice(5, 7)) - 1]!.slice(0, 3)}</small> : null}
              </span>
              {at(day).map((order) => <Chip key={order.id} order={order} onOpen={onOpen} />)}
            </div>
          ))}
        </div>
      </div>
      <aside className="cf-month__side">
        <Tray title="Срок прошёл раньше" orders={dated.filter((order) => order.deadlineOn! < start).sort(byPrice)} note={(order) => `срок был ${dotted(order.deadlineOn!)}`} onOpen={onOpen} />
        <Tray
          title="Без срока"
          orders={orders.filter((order) => order.deadlineOn === null).sort(byPrice)}
          note={(order) => (order.holdReason !== null ? `на паузе: ${order.holdReason}` : null)}
          onOpen={onOpen}
        />
        <Tray title="Позже" orders={dated.filter((order) => order.deadlineOn! >= end).sort(byPrice)} note={(order) => `до ${dotted(order.deadlineOn!)}`} onOpen={onOpen} />
      </aside>
    </div>
  );
}

function AgendaForm({ orders, today, onOpen }: { orders: readonly CustomBoardOrder[]; today: string; onOpen: (code: string) => void }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const dated = orders.filter((order) => order.deadlineOn !== null);
  const at = (day: string) => dated.filter((order) => order.deadlineOn === day).sort(byPrice);
  const firstOfMonth = `${month}-01`;
  const start = mondayOf(firstOfMonth);
  const lastOfMonth = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const weeks = Math.round(daysFrom(start, mondayOf(lastOfMonth)) / 7) + 1;
  const keys = [...new Set(dated.map((order) => order.deadlineOn!))].sort().filter((day) => picked === null || day === picked);
  const loose = orders.filter((order) => order.deadlineOn === null).sort(byPrice);
  return (
    <div className="cf-agenda">
      <aside className="cf-agenda__side">
        <div className="cf-cal-bar">
          <h2 className="cf-cal-title cf-cal-title--sm">{monthTitle(firstOfMonth)}</h2>
          <span className="cf-cal-nav">
            <IconButton icon={ChevronLeft} label="Прошлый месяц" onClick={() => setMonth(shiftMonth(month, -1))} />
            <IconButton icon={ChevronRight} label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))} />
          </span>
        </div>
        <div className="cf-mini">
          {WEEKDAYS.map((day, index) => <span key={day} className={cx("cf-mini__wd", index > 4 && "cf-rest")}>{day}</span>)}
          {Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index)).map((day) => {
            const those = at(day);
            return (
              <button
                key={day}
                type="button"
                className={cx("cf-mini__d", day === today && "cf-mini__d--today", !day.startsWith(month) && "cf-mini__d--out", picked === day && "cf-mini__d--on", those.length === 0 && "cf-mini__d--free")}
                disabled={those.length === 0}
                aria-pressed={picked === day}
                aria-label={`${Number(day.slice(8, 10))} ${MONTHS_OF[Number(day.slice(5, 7)) - 1]}: ${count(those)}`}
                onClick={() => setPicked(picked === day ? null : day)}
              >
                <b>{Number(day.slice(8, 10))}</b>
                <span className="cf-mini__dots">{those.slice(0, 3).map((order) => <i key={order.id} className={cx("cf-mini__dot", `cf-mini__dot--${toneOf(order)}`)} />)}</span>
              </button>
            );
          })}
        </div>
        {picked !== null && <Button size="sm" className="cf-agenda__all" onClick={() => setPicked(null)}>Показать все дни</Button>}
      </aside>
      <div className="cf-agenda__main">
        {keys.length === 0 && (picked !== null || loose.length === 0) && <p className="cf-muted">В эти дни заказов со сроком нет.</p>}
        {keys.map((day) => {
          const left = daysFrom(today, day);
          return (
            <section key={day} className={cx("cf-aday", left < 0 && "cf-aday--late", left === 0 && "cf-aday--today")}>
              <div className="cf-aday__date">
                <b>{Number(day.slice(8, 10))}</b>
                <span>{MONTHS_OF[Number(day.slice(5, 7)) - 1]}, {WEEKDAYS[weekdayIndex(day)]}</span>
                <small>{left < 0 ? `просрочено ${daysWord(left)}` : left === 0 ? "сегодня" : left === 1 ? "завтра" : `через ${daysWord(left)}`}</small>
              </div>
              <ul className="cf-aday__list">{at(day).map((order) => <OrderRow key={order.id} order={order} onOpen={onOpen} agenda />)}</ul>
            </section>
          );
        })}
        {picked === null && loose.length > 0 && (
          <section className="cf-aday cf-aday--loose">
            <div className="cf-aday__date">
              <b>—</b>
              <span>без срока</span>
              <small>{count(loose)}, <Money mills={sumOf(loose)} /></small>
            </div>
            <ul className="cf-aday__list">{loose.map((order) => <OrderRow key={order.id} order={order} onOpen={onOpen} agenda />)}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** `YYYY-MM` moved by whole months. */
function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (number - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function CalendarView({ orders, serverNow, onOpen }: { orders: readonly CustomBoardOrder[]; serverNow: string; onOpen: (code: string) => void }) {
  const [form, setForm] = useState<CalendarForm>(storedForm);
  const today = todayOf(serverNow);
  return (
    <div className="cf-cal">
      <Segmented
        size="sm"
        label="Вид календаря"
        value={form}
        onChange={(next) => {
          setForm(next);
          storeForm(next);
        }}
        options={[{ value: "month", label: "Месяц" }, { value: "agenda", label: "Расписание" }]}
      />
      {orders.length === 0
        ? <p className="cf-muted cf-empty">Заказов в работе нет.</p>
        : form === "month" ? <MonthForm orders={orders} today={today} onOpen={onOpen} /> : <AgendaForm orders={orders} today={today} onOpen={onOpen} />}
    </div>
  );
}

