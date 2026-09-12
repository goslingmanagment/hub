import {
  crossPageTransactionListQuerySchema,
  type CrossPageTransactionListQuery,
  type CrossPageTransactionListResponse,
} from "@agency_hub_core/contracts";

export function parseTransactionSearch(search: URLSearchParams) {
  const input = Object.fromEntries(
    [...search].filter(([key]) => key !== "backTo"),
  );
  return crossPageTransactionListQuerySchema.safeParse({ ...input, limit: 50 });
}

/** An older server can ignore additive query parameters. Never display its
 * unfiltered items as proof of the number the user clicked. */
export function matchesTransactionScope(
  response: CrossPageTransactionListResponse,
  query: CrossPageTransactionListQuery,
): boolean {
  const scope = response.scope;
  return Boolean(
    scope &&
      response.summary &&
      scope.pageLabel === (query.pageLabel ?? null) &&
      scope.from === (query.from ? new Date(query.from).toISOString() : null) &&
      scope.to === (query.to ? new Date(query.to).toISOString() : null) &&
      scope.type === (query.type ?? null) &&
      scope.state === (query.state ?? null) &&
      scope.reportableOnly === query.reportableOnly,
  );
}
