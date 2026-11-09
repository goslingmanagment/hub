import { formatPercent } from "@agency_hub_core/ui/format";
import { REPLY_NORM_SECONDS, waitText } from "@agency_hub_core/ui/shiftReview";

/**
 * The words of a shift's three quality numbers, one place for every screen
 * (spec §3 r2, D1): the journal, the people, the person's card and the review
 * say the same label, the same definition and format the same way. The numbers
 * themselves come from the review's rules (`@agency_hub_core/ui/shiftReview`:
 * `shiftQuality`, `reviewQuality`, `qualityOfChatterNumbers`, `averageQuality`).
 *
 *   import { METRICS, formatReplyMedian } from "@/shared/metrics";
 *   <th>{METRICS.reply.label}</th>                      «Ответ, медиана»
 *   <Tooltip content={METRICS.reply.hint}>…</Tooltip>   the definition
 *   METRICS.reply.perShift                               «Ответ, медиана, в среднем за смену»
 */

export interface MetricWords {
  /** The full label: a fact line, a table's header where it fits. */
  label: string;
  /** A narrow column's header; the full label then goes in its hint. */
  short: string;
  /** A period's average over its shifts. */
  perShift: string;
  /** The definition, for a tooltip under the label: plain words, no jargon. */
  hint: string;
}

export const METRICS = {
  reply: {
    label: "Ответ, медиана",
    short: "Ответ",
    perShift: "Ответ, медиана, в среднем за смену",
    hint: "Половина ответов фанам в смену была быстрее, половина — медленнее. Ответ — личное сообщение фану, который ждал; "
      + "ожидание с прошлой смены считается с её начала. Рассылки не в счёте.",
  },
  unanswered: {
    label: "Без ответа к концу",
    short: "Без ответа",
    perShift: "Без ответа к концу, в среднем за смену",
    hint: "Фаны чаттера, которые писали в смену (или начали ждать в ней) и не получили ответа до её конца. "
      + "Фаны после сообщения коллеги и молчавшие с прошлых смен не в счёте.",
  },
  aiUnedited: {
    label: "ИИ без правки",
    short: "ИИ без правки",
    perShift: "ИИ без правки, в среднем за смену",
    hint: "Доля сообщений чаттера с текстом, где текст ИИ ушёл фану как есть, без правки. "
      + "Приветствия Hi не в счёте; свой черновик, который ИИ перевёл или поправил, — не «без правки».",
  },
} as const satisfies Record<string, MetricWords>;

export type MetricKey = keyof typeof METRICS;

/** The live label of «Без ответа к концу» while the shift goes on. */
export const UNANSWERED_NOW_LABEL = "Ждут ответа сейчас";

/** One more sentence for a period's average: what is averaged. */
export const PER_SHIFT_HINT = "Среднее по сменам периода: у каждой смены своё число, то же, что в её разборе.";

/** «2 мин 39 с», «47 с», «1 ч 5 мин» — the review's own wording (`waitText`); null is «—». */
export function formatReplyMedian(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? "—" : waitText(seconds);
}

/** «3»; a period's average with one decimal: «1,4». null is «—». */
export function formatUnanswered(value: number | null | undefined, options: { average?: boolean } = {}): string {
  if (value === null || value === undefined) return "—";
  if (!options.average) return String(Math.round(value));
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 0 });
}

/** «32 %» from a share 0…1; null is «—». */
export function formatAiUnedited(share: number | null | undefined): string {
  return share === null || share === undefined ? "—" : formatPercent(100 * share);
}

/** The owner's reply norm, minutes (5–10 мин; past the upper end a wait is long). */
export const REPLY_NORM_MINUTES = REPLY_NORM_SECONDS / 60;

export {
  averageQuality,
  qualityOfChatterNumbers,
  reviewQuality,
  shiftQuality,
  type PeriodQuality,
  type ShiftQuality,
} from "@agency_hub_core/ui/shiftReview";
