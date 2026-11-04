import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { FansSearchResponse } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

const MIN_LENGTH = 2;
const PAUSE_MS = 250;
const LIMIT = 5;

export interface FanSearchResult {
  items: FansSearchResponse["items"];
  /** Still reading. */
  pending: boolean;
  /** A read did not answer: said as such, never as «ничего не нашлось». */
  failed: boolean;
}

/**
 * Fans by name and handle across every page the viewer reaches. The server asks
 * for a platform with the agency scope, so these are two reads. From two letters,
 * after a short pause, a few rows each.
 */
export function useFansSearch(text: string): FanSearchResult {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const value = text.trim();
    const timer = window.setTimeout(() => setQuery(value.length >= MIN_LENGTH ? value : ""), PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const results = useQueries({
    queries: (["fansly", "onlyfans"] as const).map((platform) => ({
      queryKey: ["fans-search", platform, query] as const,
      queryFn: () => kernel.fansSearch({ query: { scope: "agency" as const, platform, query, limit: LIMIT, offset: 0 } }),
      enabled: query.length >= MIN_LENGTH,
      staleTime: 30_000,
      meta: { suppressGlobalError: true },
    })),
  });

  return {
    items: results.flatMap((result) => result.data?.items ?? []),
    pending: text.trim().length >= MIN_LENGTH && (query !== text.trim() || results.some((result) => result.isFetching)),
    failed: results.some((result) => result.isError),
  };
}
