import { ArrowUp, X } from "lucide-react";
import { Checkbox, IconButton, TextInput, platformWord } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { pagesByModel, type AdminPage } from "@/screens/access/data";
import { WEEKDAY_ORDER, WEEKDAY_WORD, type Weekday } from "./words.js";

/**
 * The pieces of the registry's forms («Пригласить», the card's changes): the
 * working pages in order, a slot by Moscow time with its days, a share and a
 * fix. Pure inputs; each form checks and sends its own body.
 */

// ── working pages, in order ──────────────────────────────────────────────────

/**
 * Pages by model with «вся модель», as «Пригласить» had them, and under them
 * the chosen ones in their order: the first is the main page. A tick adds a
 * page at the end; ↑ moves a page up.
 */
export function WorkingPagesPicker({ pages, value, onChange, disabled = false }: {
  pages: readonly AdminPage[];
  value: readonly string[];
  onChange: (labels: string[]) => void;
  disabled?: boolean;
}) {
  const picked = new Set(value);
  const toggle = (label: string, on: boolean) => onChange(on ? [...value.filter((one) => one !== label), label] : value.filter((one) => one !== label));
  const toggleModel = (labels: string[], on: boolean) => onChange(on ? [...value, ...labels.filter((label) => !picked.has(label))] : value.filter((one) => !labels.includes(one)));
  const up = (index: number) => {
    if (index === 0) return;
    const next = [...value];
    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
    onChange(next);
  };
  return (
    <div className="registry-pages">
      <div className="access-invite__models">
        {pagesByModel(pages).map((model) => {
          const labels = model.pages.map((page) => page.label);
          const count = labels.filter((label) => picked.has(label)).length;
          return (
            <div key={model.modelSlug} className="access-invite__group">
              {model.pages.length > 1 ? (
                <Checkbox
                  className="access-invite__model"
                  label={<span className="access-words">{model.modelName}<span className="access-hint">вся модель · {labels.length} {ruPlural(labels.length, "страница", "страницы", "страниц")}</span></span>}
                  checked={count === labels.length}
                  indeterminate={count > 0}
                  disabled={disabled}
                  onChange={(on) => toggleModel(labels, on)}
                />
              ) : <div className="access-invite__model access-invite__model--single">{model.modelName}</div>}
              <div className="access-invite__list">
                {model.pages.map((page) => (
                  <Checkbox
                    key={page.label}
                    className="access-invite__page"
                    label={<span className="access-words">{page.label}<span className="access-hint">{platformWord(page.platform) ?? page.platform}</span></span>}
                    checked={picked.has(page.label)}
                    disabled={disabled}
                    onChange={(on) => toggle(page.label, on)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {value.length > 0 && (
        <ol className="registry-order" aria-label="Порядок рабочих страниц">
          {value.map((label, index) => (
            <li key={label} className="registry-order__row">
              <span className="registry-order__place">{index + 1}</span>
              <span className="ui-page">{label}</span>
              {index === 0 ? <span className="access-hint">основная</span> : (
                <IconButton icon={ArrowUp} size="sm" label={`Поднять ${label}`} disabled={disabled} onClick={() => up(index)} />
              )}
              <IconButton icon={X} size="sm" label={`Убрать ${label}`} disabled={disabled} onClick={() => toggle(label, false)} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── a slot ───────────────────────────────────────────────────────────────────

export interface SlotDraft {
  start: string;
  end: string;
  weekdays: Weekday[];
}

export const EMPTY_SLOT: SlotDraft = { start: "", end: "", weekdays: [] };

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function minuteOf(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/** Nothing typed: no slot. */
export function slotEmpty(draft: SlotDraft): boolean {
  return draft.start === "" && draft.end === "" && draft.weekdays.length === 0;
}

/** What is wrong with a slot, in the owner's words (the service's own rule: a shift of 1 to 16 hours); null — nothing. */
export function slotProblem(draft: SlotDraft): string | null {
  if (!TIME.test(draft.start) || !TIME.test(draft.end)) return "Укажите начало и конец, например 08:00 и 16:00.";
  const length = (minuteOf(draft.end) - minuteOf(draft.start) + 1440) % 1440;
  if (length < 60 || length > 16 * 60) return "Смена длится от 1 до 16 часов.";
  return null;
}

/** The slot as Hub takes it: no days — the days are not set. */
export function slotBody(draft: SlotDraft): { start: string; end: string; weekdays: Weekday[] | null } {
  return { start: draft.start, end: draft.end, weekdays: draft.weekdays.length === 0 ? null : WEEKDAY_ORDER.filter((day) => draft.weekdays.includes(day)) };
}

/** Start and end by Moscow time, then the days of the week. */
export function SlotFields({ value, onChange, disabled = false, idPrefix }: {
  value: SlotDraft;
  onChange: (next: SlotDraft) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const days = new Set(value.weekdays);
  return (
    <div className="registry-slot">
      <div className="registry-slot__hours">
        <label className="registry-slot__time">
          <span className="ui-field__label">С</span>
          <TextInput id={`${idPrefix}-start`} type="time" value={value.start} disabled={disabled} onChange={(event) => onChange({ ...value, start: event.target.value })} />
        </label>
        <label className="registry-slot__time">
          <span className="ui-field__label">До</span>
          <TextInput id={`${idPrefix}-end`} type="time" value={value.end} disabled={disabled} onChange={(event) => onChange({ ...value, end: event.target.value })} />
        </label>
        <span className="access-hint">по Москве; конец раньше начала: смена через полночь</span>
      </div>
      <div className="registry-slot__days" role="group" aria-label="Дни недели">
        {WEEKDAY_ORDER.map((day) => (
          <Checkbox
            key={day}
            label={WEEKDAY_WORD[day]}
            checked={days.has(day)}
            disabled={disabled}
            onChange={(on) => onChange({ ...value, weekdays: on ? [...value.weekdays, day] : value.weekdays.filter((one) => one !== day) })}
          />
        ))}
      </div>
    </div>
  );
}

// ── money ────────────────────────────────────────────────────────────────────

/** «25» or «25,5» (%) → basis points; null — not a share. */
export function shareBasisPoints(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}

/** «5» or «5.50» ($) → mills; empty is 0; null — not a sum. */
export function fixMills(text: string): number | null {
  const trimmed = text.trim().replace(",", ".").replace(/^\$/, "");
  if (trimmed === "") return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1000);
}

/** Basis points → «25» / «25,5» for an input and a line. */
export function shareText(basisPoints: number): string {
  return (basisPoints / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}
