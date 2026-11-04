import { Link } from "react-router";
import { formatMills } from "@/lib/format";
import { SOURCE_LABELS } from "@/lib/revenueDisplay";
import { MoneyDelta } from "./Delta.js";

/** One kind of income of a report, with its previous window when it has one. */
export interface IncomeKindRow {
  canonicalType: string;
  currentNetMills: number;
  previousNetMills: number | null;
  deltaNetMills: number | null;
  deltaPct: number | null;
}

/** The report's kinds, biggest first: `comparison.sources`, for all time `breakdown`.
 *  Nothing is computed here: every sum is the server's. */
export function incomeKindRows(report: {
  comparison?: { sources: ReadonlyArray<IncomeKindRow> } | null | undefined;
  breakdown: ReadonlyArray<{ canonicalType: string; netAmountMills: number }>;
}): IncomeKindRow[] {
  const rows = report.comparison?.sources ?? report.breakdown.map((source) => ({
    canonicalType: source.canonicalType,
    currentNetMills: source.netAmountMills,
    previousNetMills: null,
    deltaNetMills: null,
    deltaPct: null,
  }));
  return [...rows].sort((a, b) => b.currentNetMills - a.currentNetMills || a.canonicalType.localeCompare(b.canonicalType));
}

/**
 * «Вид дохода · Доход · Прошлый период · Изменение», the same table wherever money is
 * broken down: Главная, a page's summary. `amountLink`: a sum opens the operations it
 * is made of, with the exact window (`buildRevenueTransactionsRoute`). `compare`
 * false drops the two columns: there is nothing to compare all time with.
 */
export function IncomeKinds({ rows, label, compare, previousLabel = "Прошлый период", amountLink, total }: {
  rows: readonly IncomeKindRow[];
  /** What the table is about, for a screen reader: «Виды дохода lora-1». */
  label: string;
  compare: boolean;
  previousLabel?: string;
  amountLink?: ((row: IncomeKindRow, previous: boolean) => string | null) | undefined;
  /** The last row, from the server's own total. */
  total?: { label: string; currentNetMills: number; previousNetMills: number | null; deltaNetMills: number | null; deltaPct: number | null } | undefined;
}) {
  const amount = (row: IncomeKindRow, previous: boolean) => {
    const value = previous ? row.previousNetMills : row.currentNetMills;
    if (value === null) return "—";
    const to = amountLink?.(row, previous) ?? null;
    return to ? <Link className="money-link" to={to}>{formatMills(value)}</Link> : formatMills(value);
  };
  return (
    <div className="table-wrap">
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Вид дохода</th>
            <th scope="col" className="num">Доход</th>
            {compare && <th scope="col" className="num">{previousLabel}</th>}
            {compare && <th scope="col" className="num">Изменение</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.canonicalType}>
              <th scope="row">{SOURCE_LABELS[row.canonicalType] ?? row.canonicalType}</th>
              <td className="num">{amount(row, false)}</td>
              {compare && <td className="num muted">{amount(row, true)}</td>}
              {compare && <td className="num"><MoneyDelta mills={row.deltaNetMills} pct={row.deltaPct} bare /></td>}
            </tr>
          ))}
          {total && (
            <tr className="row-total">
              <th scope="row">{total.label}</th>
              <td className="num">{formatMills(total.currentNetMills)}</td>
              {compare && <td className="num">{total.previousNetMills === null ? "—" : formatMills(total.previousNetMills)}</td>}
              {compare && <td className="num"><MoneyDelta mills={total.deltaNetMills} pct={total.deltaPct} bare /></td>}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
