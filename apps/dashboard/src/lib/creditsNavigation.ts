/** The server supplies a dense UTC day series for the exact breakdown window.
 * Use those days, including zero days, rather than recalculating with the browser clock. */
export function creditBreakdownWindow(
  days: readonly { day: string }[] | undefined,
) {
  const dates = days?.map((row) => row.day).sort();
  if (!dates?.length) return null;
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}

/** Inclusive date inputs become the ledger's UTC [from, to) bounds. An invalid
 * range is an input error, not evidence that no ledger rows exist. */
export function creditLedgerDateRange(fromDate: string, toDate: string): {
  from: string | undefined;
  to: string | undefined;
  error: string | null;
} {
  const parseDay = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
  };
  const start = fromDate ? parseDay(fromDate) : null;
  const end = toDate ? parseDay(toDate) : null;
  if (fromDate && !start || toDate && !end) {
    return { from: undefined, to: undefined, error: "Введите корректные даты диапазона." };
  }
  if (start && end && start > end) {
    return { from: undefined, to: undefined, error: "Дата «с» должна быть раньше даты «по» или совпадать с ней." };
  }
  if (end) end.setUTCDate(end.getUTCDate() + 1);
  return { from: start?.toISOString(), to: end?.toISOString(), error: null };
}
