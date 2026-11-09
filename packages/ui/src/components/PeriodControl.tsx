import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { addDays, mondayOf, type MoscowDay } from "../moscow.js";
import { PERIOD_MAX_DAYS, resolvePeriod, stepWeek, type PeriodSpec } from "../period.js";
import { Button } from "./Button.js";
import { useFocusScope } from "./focus.js";
import { useAnchoredPosition, useDismiss } from "./popover.js";
import { Segmented } from "./Segmented.js";

type Mode = "week" | "14" | "30" | "range";

function modeOf(spec: PeriodSpec): Mode {
  if (spec.kind === "week") return "week";
  if (spec.kind === "days") return spec.days === 14 ? "14" : "30";
  return "range";
}

/**
 * The one period control (spec §3): a Moscow calendar week, Monday to Sunday,
 * with arrows; the last 14 or 30 days; a range of one's own. Controlled: the app
 * keeps the value in the address (Workboard's `usePeriod`).
 *
 * The dates are always written («2–8 нояб.»), never a bare «Неделя». The arrows
 * step whole weeks and stop at the current one.
 */
export function PeriodControl({ value, today, onChange, className }: {
  value: PeriodSpec;
  /** Today in Moscow (`moscowToday()`): the end of every period. */
  today: MoscowDay;
  onChange: (spec: PeriodSpec) => void;
  className?: string;
}) {
  const resolved = resolvePeriod(value, today);
  const mode = modeOf(value);
  const [customOpen, setCustomOpen] = useState(false);
  const customAnchor = useRef<HTMLDivElement>(null);
  const atCurrentWeek = value.kind === "week" && value.monday >= mondayOf(today);

  function pick(next: Mode) {
    if (next === "range") {
      setCustomOpen(true);
      return;
    }
    if (next === "week") onChange({ kind: "week", monday: mondayOf(today) });
    else onChange({ kind: "days", days: next === "14" ? 14 : 30 });
  }

  return (
    <div className={["ui-period", className].filter(Boolean).join(" ")} role="group" aria-label="Период">
      <div className="ui-period__dates">
        {value.kind === "week" && (
          <button type="button" className="ui-period__arrow" aria-label="Неделя раньше" title="Неделя раньше" onClick={() => onChange(stepWeek(value, -1, today))}>
            <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {value.kind === "week" ? (
          <span className="ui-period__label" aria-live="polite">{resolved.label}</span>
        ) : (
          // Without arrows the dates open the form of one's own dates: never a box that does nothing.
          <button type="button" className="ui-period__label ui-period__label--alone" aria-live="polite" title="Выбрать свои даты" onClick={() => setCustomOpen(true)}>
            {resolved.label}
          </button>
        )}
        {value.kind === "week" && (
          <button
            type="button"
            className="ui-period__arrow"
            aria-label="Неделя позже"
            title={atCurrentWeek ? "Это текущая неделя" : "Неделя позже"}
            disabled={atCurrentWeek}
            onClick={() => onChange(stepWeek(value, 1, today))}
          >
            <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      <div ref={customAnchor}>
        <Segmented<Mode>
          label="Длина периода"
          value={mode}
          onChange={pick}
          reselect={["range"]}
          options={[
            { value: "week", label: "Неделя" },
            { value: "14", label: "14 дней" },
            { value: "30", label: "30 дней" },
            { value: "range", label: "Свой период" },
          ]}
        />
      </div>
      {customOpen && (
        <CustomRange
          anchor={customAnchor}
          today={today}
          initial={{ from: resolved.from, to: resolved.to }}
          onClose={() => setCustomOpen(false)}
          onPick={(from, to) => {
            setCustomOpen(false);
            onChange({ kind: "range", from, to });
          }}
        />
      )}
    </div>
  );
}

function CustomRange({ anchor, today, initial, onClose, onPick }: {
  anchor: RefObject<HTMLDivElement | null>;
  today: MoscowDay;
  initial: { from: MoscowDay; to: MoscowDay };
  onClose: () => void;
  onPick: (from: MoscowDay, to: MoscowDay) => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const box = useRef<HTMLFormElement>(null);
  const id = useId();
  const close = useCallback(() => onClose(), [onClose]);
  const style = useAnchoredPosition(anchor, box, true, { align: "end" });
  useDismiss(true, close, [box], undefined);
  useFocusScope(box, true, { trap: true });

  const earliest = addDays(today, -(PERIOD_MAX_DAYS * 2));
  const valid = Boolean(from) && Boolean(to) && from <= to && to <= today;
  const tooLong = valid && addDays(from, PERIOD_MAX_DAYS - 1) < to;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !tooLong) onPick(from, to);
  }

  return createPortal(
    <form ref={box} className="ui-popover ui-period-custom" style={style} onSubmit={submit} aria-labelledby={`${id}-title`} tabIndex={-1}>
      <p id={`${id}-title`} className="ui-period-custom__title">Свой период</p>
      <div className="ui-period-custom__fields">
        <label className="ui-field">
          <span className="ui-field__label">С</span>
          <input className="ui-input" type="date" required value={from} min={earliest} max={to || today} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="ui-field">
          <span className="ui-field__label">По</span>
          <input className="ui-input" type="date" required value={to} min={from || earliest} max={today} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>
      {tooLong && <p className="ui-field__error">Не больше года.</p>}
      <div className="ui-period-custom__actions">
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" type="submit" disabled={!valid || tooLong}>Показать</Button>
      </div>
    </form>,
    document.body,
  );
}
