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

const DEFAULT_ERROR_MESSAGE = "Причина неизвестна.";

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

