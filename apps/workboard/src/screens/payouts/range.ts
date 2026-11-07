import { formatDayRange } from "@agency_hub_core/ui/format";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import type { PayoutsView } from "./data";

/** The days Hub exported in words, and what is still going on in them (В3). */
export interface RangeWords {
  /** «2–7 нояб.»: the export's own days, not the period's label. */
  range: string;
  /** After the range on the screen: « — неделя ещё идёт», « — по сегодня», or "". */
  note: string;
  /** After the range in a toast: « — неделя не закончена», « — по сегодня», or "". */
  copyNote: string;
}

/**
 * The days Hub exported (В3): «2–7 нояб.». While the export reaches today its
 * sums still grow, and the words say so — a block pasted into the sheet must
 * not pass for a closed week.
 */
export function rangeWords(view: Pick<PayoutsView, "from" | "to">, week: boolean): RangeWords {
  const running = view.to >= moscowToday();
  return {
    range: formatDayRange(view.from, view.to),
    note: running ? (week ? " — неделя ещё идёт" : " — по сегодня") : "",
    copyNote: running ? (week ? " — неделя не закончена" : " — по сегодня") : "",
  };
}
