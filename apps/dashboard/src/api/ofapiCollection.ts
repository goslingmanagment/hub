import { queryOptions } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export const OFAPI_COLLECTION_QUERY_KEY = ["admin", "ofapi-collection"] as const;

/** Collection controls, exports and media share one revision and invalidation. */
export function ofapiCollectionQueryOptions() {
  return queryOptions({
    queryKey: OFAPI_COLLECTION_QUERY_KEY,
    queryFn: () => kernel.ofapiCollectionGet({ query: {} }),
    // All three screens render read errors inline. Keep cache-level error
    // handling consistent regardless of which observer mounted last.
    meta: { suppressGlobalError: true },
  });
}
