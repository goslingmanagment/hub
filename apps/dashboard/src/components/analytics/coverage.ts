import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

/**
 * The one rule every chart on the Analytics page obeys:
 * **partial data is never visually indistinguishable from complete data.**
 *
 * A chart with no badge is a chart claiming its window is fully captured. That
 * claim is only ever earned by a `provider_exhausted` coverage row — the single
 * status that means the platform itself said "that is all there is". Everything
 * else, INCLUDING no coverage row at all, wears a badge.
 */

export type CoverageRow = StatsCoverageResponse["planes"][number];

export type CoverageVerdict = {
  /** `complete` is what a bare chart silently asserts, so it is the narrow case. */
  readonly state: "complete" | "partial" | "not_started" | "unknown";
  /** Short enough for a badge; specific enough to act on. */
  readonly label: string;
  /** The longer sentence, shown on hover. */
  readonly detail: string;
};

/** `provider_exhausted` is the ONLY status that earns a bare chart. A window
 *  the provider merely answered is a window, not a surface. */
const COMPLETE_STATUSES = new Set(["provider_exhausted"]);

const NOT_STARTED_STATUSES = new Set(["not_started"]);

const STATUS_DETAIL: Readonly<Record<string, string>> = {
  in_progress: "the walk is still reaching backwards — older rows are missing",
  window_captured: "one window was captured; the surface beyond it is unproven",
  sampled: "sampled rather than walked — this is not every row",
  partial_provider_surface: "the provider served only part of its own surface",
  unsupported_by_observed_surface: "no live route answers for this; nothing was captured",
  budget_deferred: "the lane hit its daily cap and deferred the rest to tomorrow",
  auth_blocked: "capture is blocked on credentials",
  contract_drift: "the response shape changed; capture parked itself rather than guess",
  not_started: "this lane has never run for this page",
};

/**
 * The verdict for one capture plane.
 *
 * NO ROWS IS NOT ZERO, and this function is where that rule becomes visible: a
 * plane with no coverage row at all returns `unknown`, never `complete`. An
 * absent row means nobody has claimed anything about this surface — which is
 * strictly weaker than a claim of emptiness.
 */
export function coverageVerdict(
  rows: readonly CoverageRow[] | undefined,
  plane: string,
): CoverageVerdict {
  const planeRows = (rows ?? []).filter((row) => row.plane === plane);
  if (planeRows.length === 0) {
    return {
      state: "unknown",
      label: "coverage unknown",
      detail:
        "No capture-coverage row exists for this plane, so nothing is known about how "
        + "far back it reaches. An empty chart here is not evidence of an empty world.",
    };
  }
  if (planeRows.every((row) => COMPLETE_STATUSES.has(row.status))) {
    return {
      state: "complete",
      label: "complete",
      detail: "The provider was exhausted for every scope of this plane.",
    };
  }
  if (planeRows.every((row) => NOT_STARTED_STATUSES.has(row.status))) {
    return {
      state: "not_started",
      label: "not started",
      detail: STATUS_DETAIL.not_started!,
    };
  }
  const weakest = planeRows.find((row) => !COMPLETE_STATUSES.has(row.status))!;
  return {
    state: "partial",
    label: `partial — ${weakest.status.replace(/_/g, " ")}`,
    detail: STATUS_DETAIL[weakest.status]
      ?? `capture reports \`${weakest.status}\` for scope \`${weakest.scopeRef}\``,
  };
}

/**
 * Fansly's own 30-day widget EXCLUDES the Suggestions visit code (44011) from
 * its percentage denominator; ours includes every raw source. The numbers
 * therefore differ, on purpose, and the difference is explained rather than
 * hidden (A8).
 *
 * It applies to the 30-DAY view only — the last-24h comparison needs no
 * denominator adjustment — so the footnote is a function of the selected range
 * rather than a permanent line of small print nobody reads.
 */
export const SUGGESTIONS_DENOMINATOR_NOTE =
  "Fansly's own 30-day widget leaves the Suggestions visit code (44011) out of its "
  + "percentage denominator. This chart counts every raw source, so its shares are "
  + "smaller than the ones on Fansly's page. Neither is wrong; they answer different "
  + "questions, and the raw codes are on every row so you can reproduce either.";
