import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { MoneyBudgetRow } from "@agency_hub_core/contracts";
import { Tooltip } from "@/components/shared/Tooltip";
import { formatBusinessDateShort } from "@/lib/format";
import { formatUsd, monthShort } from "./budgetsModel.js";

/**
 * A bar on one scale for the whole card: the fill is the fact, the tick is the
 * plan; what goes past the plan is in the overspend colour. No plan — no tick.
 */
export function BulletBar({ value, plan, max, tone = "neutral", fillClass }: {
  value: number;
  plan: number | null;
  max: number;
  /** spend: past the plan is bad; earn: reaching the plan is good. */
  tone?: "spend" | "earn" | "neutral";
  /** A colour of its own (a traffic channel's), instead of the tone's. */
  fillClass?: string | undefined;
}) {
  const pct = (x: number) => (max > 0 ? Math.max(0, Math.min(100, (x / max) * 100)) : 0);
  const fill = pct(value);
  const mark = plan === null ? null : pct(plan);
  const over = tone === "spend" && plan !== null && value > plan;
  // Spans, not divs: the bar also stands inside a tile's paragraph.
  return (
    <span className="budget-bar" aria-hidden="true">
      <span className={`budget-bar-fill ${fillClass ?? `budget-bar-${tone}`}`} style={{ width: `${over && mark !== null ? mark : fill}%` }} />
      {over && mark !== null && <span className="budget-bar-over" style={{ left: `${mark}%`, width: `${Math.max(0.5, fill - mark)}%` }} />}
      {mark !== null && <span className="budget-bar-mark" style={{ left: `calc(${mark}% - 1px)` }} />}
    </span>
  );
}

/** The arrow that opens a line's payments. */
export function Expander({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="home-expander" aria-expanded={open} aria-label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}

/** The payments of a line: day, who, the model, the sum; the note in full on hover. */
export function PaymentRows({ rows, colSpan, names }: { rows: readonly MoneyBudgetRow[]; colSpan: number; names: Readonly<Record<string, string>> }) {
  const sorted = [...rows].sort((left, right) => right.date.localeCompare(left.date) || right.num - left.num);
  return (
    <tr className="budget-payments">
      <td colSpan={colSpan}>
        <ul className="budget-payment-list">
          {sorted.map((row) => (
            <li key={`${row.num}-${row.advanceFrom ?? ""}`} className="budget-payment">
              <span className="budget-payment-date">{formatBusinessDateShort(row.date)}</span>
              <span className="budget-payment-who">
                {row.counterparty}
                {row.model && <span className="budget-muted"> · {modelNameOf(row.model, names)}</span>}
                {row.advanceFrom && <span className="budget-chip">аванс из {monthShort(row.advanceFrom)}</span>}
              </span>
              <span className="budget-payment-note" title={row.note && row.note !== "—" ? row.note : undefined}>
                {noteText(row.note)}
              </span>
              <span className="budget-payment-sum">
                {row.incomplete ? "≈ " : ""}{formatUsd(row.amountMicroUsd, { cents: true })}
                <span className="budget-muted budget-payment-num">#{row.num}</span>
              </span>
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

/** The note as words: without the movement ids the journal keeps for itself (`withdrawal:123;`, `p2p:…`). */
export function noteText(note: string): string {
  if (!note || note === "—") return "";
  return note.replace(/\b(?:withdrawal|deposit|internal_deposit|internal_transfer|p2p|order|tx):[\w-]+[;,.]?\s*/gi, "").trim();
}

function modelNameOf(code: string, names: Readonly<Record<string, string>>): string {
  return code.split(",").map((part) => names[part.trim()] ?? part.trim()).join(", ");
}

/** A table of lines that each open their payments: one open at a time keeps the card short. */
export function useOpenLine() {
  const [open, setOpen] = useState<string | null>(null);
  return { open, toggle: (key: string) => setOpen((current) => (current === key ? null : key)) };
}

export function LineRow({ open, onToggle, label, sub, children, rows, colSpan, names, empty }: {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  rows: readonly MoneyBudgetRow[];
  colSpan: number;
  names: Readonly<Record<string, string>>;
  /** No payments: nothing to open. */
  empty?: boolean;
}) {
  const canOpen = !empty && rows.length > 0;
  return (
    <Fragment>
      <tr className={`${open ? "is-expanded " : ""}${canOpen ? "budget-row-open" : ""}`.trim()} onClick={canOpen ? onToggle : undefined}>
        <td>
          <span className="budget-line-name">
            {canOpen
              ? <Expander open={open} onClick={onToggle} label={`${open ? "Свернуть" : "Показать"} платежи: ${typeof label === "string" ? label : ""}`} />
              : <span className="budget-expander-space" />}
            <span className="budget-line-label">{label}</span>
            {sub && <span className="budget-muted budget-line-sub">{sub}</span>}
          </span>
        </td>
        {children}
      </tr>
      {open && canOpen && <PaymentRows rows={rows} colSpan={colSpan} names={names} />}
    </Fragment>
  );
}

/** A number with its explanation on hover. */
export function Hint({ text, children }: { text: ReactNode; children: ReactNode }) {
  return <Tooltip content={<span className="budget-hint">{text}</span>} focusable><span className="budget-hinted">{children}</span></Tooltip>;
}
