import {
  crossPageTransactionListQuerySchema,
  type CrossPageTransactionListQuery,
  type CrossPageTransactionListResponse,
} from "@agency_hub_core/contracts";
import { pageFromSearch } from "./pageParam.js";

export function parseTransactionSearch(search: URLSearchParams) {
  const input = Object.fromEntries(
    [...search].filter(([key]) => key !== "backTo" && key !== "page" && key !== "period"),
  );
  const page = pageFromSearch(search);
  return crossPageTransactionListQuerySchema.safeParse({ ...input, ...(page ? { pageLabel: page } : {}), limit: 50 });
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
