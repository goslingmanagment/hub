import { useMemo, useState } from "react";
import { Pencil } from "lucide-react";
import { useSetBudgetPlans } from "@/api/budgets";
import { ModalShell } from "@/components/shared/ModalShell";
import { isUnknownOutcome, UNKNOWN_OUTCOME } from "@/pages/settings/settingsFeedback";
import { BUDGET_ITEMS, INCOME_ITEM, formatUsd, itemLabel, parseUsd, type MonthView } from "./budgetsModel.js";

interface Draft {
  item: string;
  /** What the field holds. */
  text: string;
  /** The owner's plan now, micro-USD; null — none of his. */
  current: number | null;
  /** What stands in without his plan (the CEO's rate). */
  placeholder: string;
}

function dollarsText(microUsd: number): string {
  const cents = Math.round(microUsd / 10_000);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The month's items to plan: the standard ones, the month's own, «Доход» first. */
function drafts(view: MonthView): Draft[] {
  const own = new Map<string, number>();
  const standIn = new Map<string, number>();
  for (const line of view.itemLines) {
    if (line.plan === null) continue;
    (line.planSource === "plan" ? own : standIn).set(line.item, line.plan);
  }
  if (view.incomePlan !== null) own.set(INCOME_ITEM, view.incomePlan);
  const items = [INCOME_ITEM, ...new Set([...BUDGET_ITEMS, ...view.itemLines.map((line) => line.item)])];
  return items.map((item) => {
    const current = own.get(item) ?? null;
    const stand = standIn.get(item);
    return { item, text: current === null ? "" : dollarsText(current), current, placeholder: stand === undefined ? "нет плана" : `${dollarsText(stand)} — ставка` };
  });
}

/**
 * «План месяца»: the owner sets the month's plan per item in one go and it is
 * written to the ledger. An empty field removes the item's plan; the CEO's
 * salary without one keeps its rate. «Как в …» fills the fields from the month
 * before. A plan is a number, never a movement of money.
 */
export function BudgetPlanEditor({ view, previous }: { view: MonthView; previous: MonthView | null }) {
  const [open, setOpen] = useState(false);
  const label = view.hasOwnPlans ? "Изменить план" : "Задать план";
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost budget-plan-button" onClick={() => setOpen(true)}>
        <Pencil size={14} aria-hidden="true" />
        {label}
      </button>
      {open && <PlanDialog view={view} previous={previous} onClose={() => setOpen(false)} />}
    </>
  );
}

function PlanDialog({ view, previous, onClose }: { view: MonthView; previous: MonthView | null; onClose: () => void }) {
  const initial = useMemo(() => drafts(view), [view]);
  const [rows, setRows] = useState(initial);
  const save = useSetBudgetPlans();
  const previousPlans = useMemo(() => {
    if (!previous) return null;
    const plans = new Map<string, number>();
    for (const line of previous.itemLines) if (line.plan !== null && line.planSource === "plan") plans.set(line.item, line.plan);
    if (previous.incomePlan !== null) plans.set(INCOME_ITEM, previous.incomePlan);
    return plans.size > 0 ? plans : null;
  }, [previous]);

  const parsed = rows.map((row) => ({ ...row, value: row.text.trim() === "" ? null : parseUsd(row.text) }));
  const invalid = parsed.filter((row) => row.text.trim() !== "" && row.value === null);
  const changes = parsed.filter((row) => invalid.length === 0 && row.value !== row.current);
  const total = parsed.filter((row) => row.item !== INCOME_ITEM).reduce((sum, row) => sum + (row.value ?? 0), 0);

  function fillFromPrevious() {
    if (!previousPlans) return;
    setRows((current) => current.map((row) => {
      const plan = previousPlans.get(row.item);
      return plan === undefined ? row : { ...row, text: dollarsText(plan) };
    }));
  }

  function submit() {
    if (changes.length === 0) return;
    save.mutate({ plans: changes.map((row) => ({ month: view.month, item: row.item, planMicroUsd: row.value, note: "" })) }, { onSuccess: onClose });
  }

  return (
    <ModalShell title={`План на ${view.label.toLowerCase()}`} onClose={onClose} size="short">
      <form
        className="budget-plan-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {previousPlans && previous && (
          <button type="button" className="btn btn-sm" onClick={fillFromPrevious}>Как в {previous.label.toLowerCase()}</button>
        )}
        <div className="budget-plan-rows">
          {rows.map((row, i) => {
            const bad = invalid.includes(parsed[i]!);
            const fact = row.item === INCOME_ITEM ? view.earned : view.itemLines.find((line) => line.item === row.item)?.amount ?? 0;
            return (
              <label key={row.item} className={`budget-plan-row${row.item === INCOME_ITEM ? " is-income" : ""}`}>
                <span className="budget-plan-item">
                  {row.item === INCOME_ITEM ? "Доход (заработано)" : itemLabel(row.item)}
                  {fact !== null && fact > 0 && <span className="budget-muted"> · сейчас {formatUsd(fact)}</span>}
                </span>
                <span className="budget-plan-input">
                  <span className="budget-muted">$</span>
                  <input
                    className={`input w-28 text-right${bad ? " is-invalid" : ""}`}
                    inputMode="decimal"
                    aria-label={`План: ${itemLabel(row.item)}, долларов`}
                    aria-invalid={bad || undefined}
                    placeholder={row.placeholder}
                    value={row.text}
                    onChange={(event) => setRows((current) => current.map((r, j) => (j === i ? { ...r, text: event.target.value } : r)))}
                  />
                </span>
              </label>
            );
          })}
        </div>
        <p className="budget-plan-total">
          Расходы по плану: <b>{formatUsd(total)}</b>
          {invalid.length > 0 && <span className="budget-over"> · сумма вроде «1200» или «1200.50»</span>}
        </p>
        {save.isError && (
          <p className="budget-over" role="alert">
            {isUnknownOutcome(save.error) ? `${UNKNOWN_OUTCOME} Обновите экран и проверьте.` : "Не записано: ledger отказал. План прежний."}
          </p>
        )}
        <div className="budget-plan-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={changes.length === 0 || save.isPending}>
            {save.isPending ? "Сохраняем…" : changes.length === 0 ? "Сохранить" : `Сохранить (${changes.length})`}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
