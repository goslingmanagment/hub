import type { StatsCoverageResponse } from "@agency_hub_core/contracts";
import {
  CAPTURE_COVERAGE_HEAD_TOLERANCE_MS,
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

/** Judge every required plane against the window the user selected. */
export function coverageVerdict(
  rows: readonly CoverageRow[] | undefined,
  requiredPlanes: readonly string[],
  window: AnalyticsCoverageWindow,
): CoverageVerdict {
  const selectedRows: CoverageRow[] = [];
  for (const plane of requiredPlanes) {
    const planeRows = (rows ?? []).filter((row) => row.plane === plane);
    if (planeRows.length === 0) {
      return {
        state: "unknown",
        label: "coverage unknown",
        detail: `No capture-coverage row exists for required plane \`${plane}\`.`,
      };
    }
    selectedRows.push(...planeRows);
  }

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
    const tolerance = CAPTURE_COVERAGE_HEAD_TOLERANCE_MS[
      row.plane as CaptureCoveragePlane
    ] ?? DEFAULT_HEAD_TOLERANCE_MS;
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
 * The badge a panel actually renders — the capture verdict wrapped in the
 * state of the request that would have proved it.
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
 */
export function coverageBadgeVerdict(
  coverage: AnalyticsPanelState<readonly CoverageRow[]>,
  requiredPlanes: readonly string[],
  window: AnalyticsCoverageWindow,
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

  const verdict = coverageVerdict(coverage.data, requiredPlanes, window);
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
