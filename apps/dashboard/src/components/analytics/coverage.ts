import type { StatsCoverageResponse } from "@agency_hub_core/contracts";
import {
  CAPTURE_COVERAGE_HEAD_TOLERANCE_MS,
  CAPTURE_COVERAGE_PLANES,
  type CaptureCoveragePlane,
} from "@agency_hub_core/shared";

import type { AnalyticsPanelState } from "@/pages/analytics-query-state";

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

const STATUS_DETAIL: Readonly<Record<string, string>> = {
  in_progress: "the walk is still reaching backwards — older rows are missing",
  sampled: "sampled rather than walked — this is not every row",
  partial_provider_surface: "the provider served only part of its own surface",
  unsupported_by_observed_surface: "no live route answers for this; nothing was captured",
  budget_deferred: "the lane hit its daily cap and deferred the rest to tomorrow",
  auth_blocked: "capture is blocked on credentials",
  contract_drift: "the response shape changed; capture parked itself rather than guess",
  not_started: "this lane has never run for this page",
};

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
    issue: { state: "partial", label: "partial — selected window", detail },
  });
  if (!validSteadyBounds) {
    return partial(`Plane \`${steady.plane}\` has no complete bounds for its fresh window.`);
  }
  if (history === undefined || !WINDOW_EVIDENCE_STATUSES.has(history.status)) return { rows };
  // A proven exhausted history may have no nonempty oldest bucket. Preserve
  // that existing floor meaning; a missing head is never proof of overlap.
  if (historyTo === null || (historyFrom === null && !exhaustedFloor)
    || (historyFrom !== null && historyFrom > historyTo)) {
    return partial(`Plane \`${steady.plane}\` has no historical bounds that connect to its fresh window.`);
  }
  if (historyTo < steadyFrom || (historyFrom !== null && steadyTo < historyFrom)) {
    return partial(`Plane \`${steady.plane}\` has a gap between historical and fresh capture.`);
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
        label: "coverage unknown",
        detail: `No capture-coverage row exists for required plane \`${plane}\`.`,
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
    return { state: "not_started", label: "not started", detail: STATUS_DETAIL.not_started! };
  }

  const blocked = selectedRows.find((row) => !WINDOW_EVIDENCE_STATUSES.has(row.status));
  if (blocked !== undefined) {
    return {
      state: "partial",
      label: `partial — ${blocked.status.replace(/_/g, " ")}`,
      detail: STATUS_DETAIL[blocked.status]
        ?? `capture reports \`${blocked.status}\` for scope \`${blocked.scopeRef}\``,
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
      label: "stale head",
      detail: `Plane \`${stale.plane}\` is not fresh through the selected window.`,
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
      label: "partial — selected window",
      detail: `Plane \`${shallow.plane}\` does not reach the selected window's start.`,
    };
  }

  const days = selectedWindowDays(window);
  return {
    state: "complete",
    label: `complete for ${days}-day window`,
    detail: "Every required plane reaches the selected floor and has a fresh head.",
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
 * `not_started` is a fact about Fansly's like lane, and stating it definitively
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
      label: "coverage pending",
      detail:
        "The capture-coverage request has not answered. Whether this window is "
        + "fully captured is unknown — it is not a claim that it is.",
    };
  }
  if (coverage.status === "error") {
    return {
      state: "unavailable",
      label: "coverage unavailable",
      detail: `The capture-coverage request failed (${coverage.message}). Nothing here `
        + "can be read as complete until it answers.",
    };
  }

  const verdict = whenAnswered(coverage.data);
  if (!coverage.refreshFailed) {
    return verdict;
  }
  return {
    state: "refresh_failed",
    label: "coverage refresh failed",
    detail: `Cached verdict: ${verdict.label}. ${verdict.detail} The refresh of the `
      + "coverage rows failed, so this verdict is as old as the cache.",
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
 * An empty chart means one thing when coverage says the lane is ramped and
 * exhausted, and the opposite when coverage has not answered at all. Panels
 * pass the sentence that is true of their own lane; this decides how much of
 * it may be asserted.
 */
export function emptyPanelReason(verdict: CoverageVerdict, laneSentence: string): string {
  if (verdict.state === "not_started" || verdict.state === "unknown") {
    return "Nothing captured for this window — and the badge above says why. "
      + "This is not a reading of zero.";
  }
  if (verdict.state === "pending" || verdict.state === "unavailable") {
    return `${laneSentence} Whether anything is missing from it is unknown until the `
      + "coverage request answers.";
  }
  return laneSentence;
}

export const SUGGESTIONS_DENOMINATOR_NOTE =
  "Fansly's own 30-day widget leaves the Suggestions visit code (44011) out of its "
  + "percentage denominator. This chart counts every raw source, so its shares are "
  + "smaller than the ones on Fansly's page. Neither is wrong; they answer different "
  + "questions, and the raw codes are on every row so you can reproduce either.";
