import type { StatsCoverageResponse } from "@agency_hub_core/contracts";
import {
  CAPTURE_COVERAGE_HEAD_TOLERANCE_MS,
  CAPTURE_COVERAGE_PLANES,
  type CaptureCoveragePlane,
} from "@agency_hub_core/shared";

import type { AnalyticsPanelState } from "@/pages/analytics-query-state";

import { formatDays, planeLabel } from "./analytics-words.js";

export type CoverageRow = StatsCoverageResponse["planes"][number];

export type AnalyticsCoverageWindow = {
  readonly from: string;
  readonly to: string;
};

export type CoverageVerdict = {
  readonly state:
    | "complete"
    | "partial"
    | "stale"
    | "not_started"
    | "unknown"
    // The three states below are about OUR request for the coverage rows, not
    // about capture. They exist because coverage is a shared epistemic
    // dependency: every panel's badge is a claim that rests on it, and a badge
    // that silently disappears while the coverage request is in flight or
    // failed is a chart asserting completeness it cannot know.
    | "pending"
    | "unavailable"
    | "refresh_failed";
  readonly label: string;
  readonly detail: string;
};

const WINDOW_EVIDENCE_STATUSES = new Set(["provider_exhausted", "window_captured"]);
const NOT_STARTED_STATUSES = new Set(["not_started"]);
const DEFAULT_HEAD_TOLERANCE_MS = 48 * 60 * 60 * 1_000;
const STATS_WINDOW_PLANES = new Set<string>([
  CAPTURE_COVERAGE_PLANES.statsAccountDaily,
  CAPTURE_COVERAGE_PLANES.statsAccountHourly,
  CAPTURE_COVERAGE_PLANES.statsEarnings,
]);

/** The badges' words. Every incomplete reason reads "Данные неполные"; the
 *  reason itself is the badge's tooltip (`detail`). */
const PARTIAL_LABEL = "Данные неполные";

const STATUS_DETAIL: Readonly<Record<string, string>> = {
  in_progress: "Сбор ещё идёт: более старые данные пока не загружены.",
  sampled: "Данные собраны выборочно, а не полностью.",
  partial_provider_surface: "Fansly отдал только часть данных.",
  unsupported_by_observed_surface: "Для этих данных нет рабочего способа получения — ничего не собрано.",
  auth_blocked: "Сбор остановлен: Fansly не принимает данные входа.",
  contract_drift: "Fansly изменил формат ответа — сбор остановлен, чтобы не записать неверные данные.",
  not_started: "Сбор этих данных для страницы ещё не начинался.",
};

/** «Статистика медиа» — a plane as a quoted name inside a sentence. */
function quoted(plane: string): string {
  return `«${planeLabel(plane)}»`;
}

function instant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectedWindowDays(window: AnalyticsCoverageWindow): number {
  return Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / 86_400_000));
}

function headToleranceMs(plane: string): number {
  return CAPTURE_COVERAGE_HEAD_TOLERANCE_MS[plane as CaptureCoveragePlane]
    ?? DEFAULT_HEAD_TOLERANCE_MS;
}

/** History and the fresh window are temporal scopes of these three account
 * planes. Subject scopes on other planes still each require their own evidence. */
function selectStatsWindowEvidence(
  rows: CoverageRow[],
  window: AnalyticsCoverageWindow,
): { rows: CoverageRow[]; issue?: CoverageVerdict } {
  const steady = rows.find((row) => row.scopeRef === "steady");
  if (steady === undefined || !WINDOW_EVIDENCE_STATUSES.has(steady.status)) return { rows };
  const steadyFrom = instant(steady.oldestCapturedAt);
  const steadyTo = instant(steady.newestCapturedAt);
  const history = rows.find((row) => row.scopeRef === "");
  const historyFrom = history === undefined ? null : instant(history.oldestCapturedAt);
  const historyTo = history === undefined ? null : instant(history.newestCapturedAt);
  const exhaustedFloor = history?.status === "provider_exhausted"
    && history.oldestCapturedAt === null;
  const remaining = rows.filter((row) => row.scopeRef !== "" && row.scopeRef !== "steady");
  const windowFrom = Date.parse(window.from);
  const windowTo = Date.parse(window.to);
  const validSteadyBounds = steadyFrom !== null && steadyTo !== null && steadyFrom <= steadyTo;
  if (validSteadyBounds && steadyFrom <= windowFrom
    && steadyTo >= windowTo - headToleranceMs(steady.plane)) {
    return { rows: [...remaining, steady] };
  }
  // A later capture gap is irrelevant to a selection entirely inside proven
  // history. Its head must reach the selection itself, not merely the tolerance.
  if (validSteadyBounds && history !== undefined && WINDOW_EVIDENCE_STATUSES.has(history.status)
    && historyTo !== null && historyTo >= windowTo
    && (exhaustedFloor || (historyFrom !== null && historyFrom <= windowFrom))) {
    return { rows: [...remaining, history] };
  }
  const partial = (detail: string): { rows: CoverageRow[]; issue: CoverageVerdict } => ({
    rows,
    issue: { state: "partial", label: PARTIAL_LABEL, detail },
  });
  if (!validSteadyBounds) {
    return partial(`Для раздела ${quoted(steady.plane)} не известны границы свежих данных.`);
  }
  if (history === undefined || !WINDOW_EVIDENCE_STATUSES.has(history.status)) return { rows };
  // A proven exhausted history may have no nonempty oldest bucket. Preserve
  // that existing floor meaning; a missing head is never proof of overlap.
  if (historyTo === null || (historyFrom === null && !exhaustedFloor)
    || (historyFrom !== null && historyFrom > historyTo)) {
    return partial(`В разделе ${quoted(steady.plane)} история не стыкуется со свежими данными.`);
  }
  if (historyTo < steadyFrom || (historyFrom !== null && steadyTo < historyFrom)) {
    return partial(`В разделе ${quoted(steady.plane)} есть пропуск между историей и свежими данными.`);
  }
  return {
    rows: [...remaining, {
      ...history,
      oldestCapturedAt: exhaustedFloor ? null
        : new Date(Math.min(historyFrom!, steadyFrom)).toISOString(),
      newestCapturedAt: new Date(Math.max(historyTo, steadyTo)).toISOString(),
    }],
  };
}

/** Judge every required plane against the window the user selected. */
export function coverageVerdict(
  rows: readonly CoverageRow[] | undefined,
  requiredPlanes: readonly string[],
  window: AnalyticsCoverageWindow,
): CoverageVerdict {
  const selectedRows: CoverageRow[] = [];
  let selectionIssue: CoverageVerdict | undefined;
  for (const plane of requiredPlanes) {
    const planeRows = (rows ?? []).filter((row) => row.plane === plane);
    if (planeRows.length === 0) {
      return {
        state: "unknown",
        label: "Полнота неизвестна",
        detail: `Нет сведений о сборе раздела ${quoted(plane)}.`,
      };
    }
    if (STATS_WINDOW_PLANES.has(plane)) {
      const selection = selectStatsWindowEvidence(planeRows, window);
      selectionIssue ??= selection.issue;
      selectedRows.push(...selection.rows);
    } else {
      selectedRows.push(...planeRows);
    }
  }
  if (selectionIssue !== undefined) return selectionIssue;

  if (selectedRows.every((row) => NOT_STARTED_STATUSES.has(row.status))) {
    return { state: "not_started", label: "Сбор не начат", detail: STATUS_DETAIL.not_started! };
  }

  const blocked = selectedRows.find((row) => !WINDOW_EVIDENCE_STATUSES.has(row.status));
  if (blocked !== undefined) {
    return {
      state: "partial",
      label: PARTIAL_LABEL,
      detail: STATUS_DETAIL[blocked.status]
        ?? `Сбор раздела ${quoted(blocked.plane)} не завершён (${blocked.status.replace(/_/g, " ")}).`,
    };
  }

  const windowFrom = Date.parse(window.from);
  const windowTo = Date.parse(window.to);
  const stale = selectedRows.find((row) => {
    const head = instant(row.newestCapturedAt) ?? instant(row.updatedAt);
    const tolerance = headToleranceMs(row.plane);
    return head === null || head < windowTo - tolerance;
  });
  if (stale !== undefined) {
    return {
      state: "stale",
      label: "Данные устарели",
      detail: `Раздел ${quoted(stale.plane)} не обновлялся до конца выбранного периода.`,
    };
  }

  const shallow = selectedRows.find((row) => {
    if (row.status === "provider_exhausted" && row.oldestCapturedAt === null) {
      return false;
    }
    const floor = instant(row.oldestCapturedAt);
    return floor === null || floor > windowFrom;
  });
  if (shallow !== undefined) {
    return {
      state: "partial",
      label: PARTIAL_LABEL,
      detail: `Раздел ${quoted(shallow.plane)} собран не с начала выбранного периода.`,
    };
  }

  const days = selectedWindowDays(window);
  return {
    state: "complete",
    label: `Полные данные за ${formatDays(days)}`,
    detail: "Все нужные разделы собраны за весь период и свежие.",
  };
}

/**
 * The badge a panel actually renders — its verdict wrapped in the state of the
 * coverage request that would have proved it.
 *
 * `coverageVerdict()` above judges capture from ROWS. It cannot be reached
 * until we hold rows, and the three ways of not holding them are different
 * facts:
 *
 *  - pending: nobody knows yet. Not "complete", and never no badge at all.
 *  - unavailable: the request failed. The panel still shows its data — the
 *    data is not in doubt — but its completeness is.
 *  - refresh_failed: we hold rows and the refresh failed. The cached verdict
 *    is reported WITH the failure, because an old "complete" is exactly the
 *    badge that would otherwise vanish and leave a confident chart behind.
 *
 * `whenAnswered` is a CALLBACK, not a value, because a panel whose verdict is
 * a constant is wrapped by exactly the same rule: the Likers card's
 * `not_started` is a fact about Fansly's likes, and stating it definitively
 * over a coverage request that failed is the same lie as any other badge that
 * silently reads "complete".
 */
export function coverageRequestVerdict(
  coverage: AnalyticsPanelState<readonly CoverageRow[]>,
  whenAnswered: (rows: readonly CoverageRow[]) => CoverageVerdict,
): CoverageVerdict {
  if (coverage.status === "loading") {
    return {
      state: "pending",
      label: "Проверяем полноту",
      detail:
        "Сведения о сборе данных ещё загружаются. Пока неизвестно, полные ли "
        + "данные за этот период, — и это не утверждение, что полные.",
    };
  }
  if (coverage.status === "error") {
    return {
      state: "unavailable",
      label: "Полнота не проверена",
      detail: `Не удалось загрузить сведения о сборе данных (${coverage.message}). `
        + "Пока они не загрузятся, данные нельзя считать полными.",
    };
  }

  const verdict = whenAnswered(coverage.data);
  if (!coverage.refreshFailed) {
    return verdict;
  }
  return {
    state: "refresh_failed",
    label: "Полнота: не удалось обновить",
    detail: `Последняя известная оценка: ${verdict.label}. ${verdict.detail} Обновить `
      + "сведения о сборе не удалось, поэтому оценка может быть устаревшей.",
  };
}

/** The plane-judging badge: `coverageVerdict()` under the request's own state. */
export function coverageBadgeVerdict(
  coverage: AnalyticsPanelState<readonly CoverageRow[]>,
  requiredPlanes: readonly string[],
  window: AnalyticsCoverageWindow,
): CoverageVerdict {
  return coverageRequestVerdict(
    coverage,
    (rows) => coverageVerdict(rows, requiredPlanes, window),
  );
}

/**
 * The sentence an EMPTY panel is allowed to say, given what its badge knows.
 *
 * An empty chart means one thing when coverage says the walk reached its end,
 * and the opposite when coverage has not answered at all. Panels pass the
 * sentence that is true of their own data; this decides how much of it may be
 * asserted.
 */
export function emptyPanelReason(verdict: CoverageVerdict, sentence: string): string {
  if (verdict.state === "not_started" || verdict.state === "unknown") {
    return "За этот период ничего не собрано — причина указана в отметке у заголовка. "
      + "Это не означает ноль.";
  }
  if (verdict.state === "pending" || verdict.state === "unavailable") {
    return `${sentence} Полны ли данные, станет известно, когда загрузятся `
      + "сведения о сборе.";
  }
  return sentence;
}

export const SUGGESTIONS_DENOMINATOR_NOTE =
  "Виджет Fansly за 30 дней не учитывает визиты из «Рекомендаций» при расчёте "
  + "процентов. Здесь учтены все источники, поэтому доли меньше, чем на странице "
  + "Fansly. Оба расчёта верны — они отвечают на разные вопросы.";
