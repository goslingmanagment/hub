export type AnalyticsQuerySnapshot = {
  readonly label: string;
  readonly isError: boolean;
  readonly isSuccess: boolean;
};

export type AnalyticsQueryState =
  | { readonly state: "error"; readonly failedLabels: readonly string[] }
  | { readonly state: "loading" }
  | { readonly state: "ready" };

/** Empty charts are legal only after every query has succeeded. */
export function analyticsQueryState(
  queries: readonly AnalyticsQuerySnapshot[],
): AnalyticsQueryState {
  const failedLabels = queries.filter((query) => query.isError).map((query) => query.label);
  if (failedLabels.length > 0) {
    return { state: "error", failedLabels };
  }
  if (queries.some((query) => !query.isSuccess)) {
    return { state: "loading" };
  }
  return { state: "ready" };
}
