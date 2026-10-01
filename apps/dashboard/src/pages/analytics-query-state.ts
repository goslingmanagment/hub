/**
 * The Analytics page's state vocabulary — one state per QUERY, not per panel.
 *
 * The page used to hold every panel behind a single gate: one failed request
 * and nothing rendered, one slow request and nothing rendered. Removing that
 * gate naively is worse than keeping it, because the queries and the panels
 * are not one-to-one — `mediaTraffic` feeds the FYP chart AND Content
 * Performance's average-watch figure, `media` feeds Top Media AND Content
 * Performance, `comments` feeds two cards, and `coverage` feeds every badge on
 * the page. A panel that only knew "my data is undefined" would render a
 * pending request as an empty dataset and a failed one as a fact about the
 * world.
 *
 * So: each query is reduced to a DISCRIMINATED state here, and every consumer
 * takes that state rather than `data | undefined`. Missing data can no longer
 * be silently coerced into an empty array by a component that forgot which
 * branch it was in.
 */

/** The four things a panel's data can honestly be. */
export type AnalyticsPanelState<T> =
  /** No data yet, and the request has not answered. Never "empty". */
  | { readonly status: "loading" }
  /** No data at all, and the request failed. Never "empty", never zero. */
  | { readonly status: "error"; readonly message: string }
  /**
   * Data in hand. `refreshFailed` marks the React Query `isRefetchError`
   * case — the data is real but STALE, and saying so is the difference
   * between a cached number and a current one.
   */
  | { readonly status: "ready"; readonly data: T; readonly refreshFailed: boolean };

/**
 * The shape we need out of a React Query result. Declared structurally so the
 * tests can build one by hand without a QueryClient — and so the distinction
 * this file rests on (`isLoadingError` vs `isRefetchError`, v5) is explicit
 * rather than re-derived from `isError && data !== undefined`.
 */
export type AnalyticsQueryLike<T> = {
  readonly data: T | undefined;
  readonly isLoadingError: boolean;
  readonly isRefetchError: boolean;
  readonly error?: unknown;
};

const DEFAULT_ERROR_MESSAGE = "The request failed.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return DEFAULT_ERROR_MESSAGE;
}

/** Reduce one query to the state its consumers are allowed to render. */
export function analyticsPanelState<T>(query: AnalyticsQueryLike<T>): AnalyticsPanelState<T> {
  if (query.data !== undefined) {
    // Data first, deliberately: a refresh that failed does not un-know what we
    // already hold, it only makes it old. The flag says which.
    return { status: "ready", data: query.data, refreshFailed: query.isRefetchError };
  }
  if (query.isLoadingError) {
    return { status: "error", message: errorMessage(query.error) };
  }
  return { status: "loading" };
}

/** Project a ready state's data — the ONLY sanctioned way to reach it. */
export function panelData<T>(state: AnalyticsPanelState<T>): T | undefined {
  return state.status === "ready" ? state.data : undefined;
}

/**
 * Derive a submetric's state from the state of the query that carries it.
 *
 * This exists for exactly one edge, and it is the dangerous one: Content
 * Performance shows an ACCOUNT-level average-watch figure computed from the
 * `mediaTraffic` query, which is not the query that fills its table. Before
 * this, `accountWatchAverage(undefined)` returned null and the header rendered
 * "not served" — a verdict about the platform — while the request was merely
 * in flight or failed.
 */
export function mapPanelState<T, U>(
  state: AnalyticsPanelState<T>,
  project: (data: T) => U,
): AnalyticsPanelState<U> {
  return state.status === "ready"
    ? { status: "ready", data: project(state.data), refreshFailed: state.refreshFailed }
    : state;
}

/** The seven requests the page makes, by the name the banner shows. */
export type AnalyticsQueryId =
  | "profileTraffic"
  | "mediaTraffic"
  | "media"
  | "tags"
  | "coverage"
  | "comments"
  | "revenue";

/**
 * Which surfaces each query actually feeds.
 *
 * Written down because the map is not obvious from the component tree and
 * every hidden edge in it has produced a dishonest state at least once. The
 * failure banner names surfaces, not query variables: "media traffic failed"
 * means nothing to the person reading the page.
 */
const ANALYTICS_QUERY_SURFACES: Readonly<Record<AnalyticsQueryId, readonly string[]>> = {
  profileTraffic: ["Traffic by source"],
  mediaTraffic: ["FYP vs direct media views", "Content performance · Avg. watch"],
  media: ["Top media", "Content performance"],
  tags: ["Top FYP tags"],
  coverage: ["Coverage", "every coverage badge"],
  comments: ["Comments per post", "Likers"],
  revenue: ["Revenue mix", "Month totals"],
};

export type AnalyticsQueryEntry = {
  readonly id: AnalyticsQueryId;
  readonly failed: boolean;
  readonly refetch: () => void;
};

/**
 * The compact banner's contents: the surfaces behind every FAILED query, once
 * each. A query that failed with cached data in hand is not in here — its
 * panels stay on screen and carry their own "cached" label.
 */
export function analyticsFailureBanner(
  entries: readonly AnalyticsQueryEntry[],
): readonly string[] {
  return entries
    .filter((entry) => entry.failed)
    .flatMap((entry) => ANALYTICS_QUERY_SURFACES[entry.id]);
}

/**
 * Retry every failed request — ONCE PER QUERY.
 *
 * `media` feeds two panels and `comments` feeds two cards, so a retry wired
 * per consumer would fire the same request twice and double the load on the
 * box that was already too slow to answer it the first time. Returns the ids
 * it retried so a test can pin the count.
 */
export function retryFailedAnalytics(
  entries: readonly AnalyticsQueryEntry[],
): readonly AnalyticsQueryId[] {
  const retried: AnalyticsQueryId[] = [];
  for (const entry of entries) {
    if (!entry.failed || retried.includes(entry.id)) {
      continue;
    }
    entry.refetch();
    retried.push(entry.id);
  }
  return retried;
}
