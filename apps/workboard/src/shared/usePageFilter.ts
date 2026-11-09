import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * The page filter (`?page=mia-1`; absent: every page). It only narrows what is
 * shown: a write never takes its page from here, always from its own row or
 * form (design-language §5.4). Hub scopes a team lead to their pages anyway.
 */
export function usePageFilter(): { page: string | null; setPage: (page: string | null) => void } {
  const [search, setSearch] = useSearchParams();
  const raw = search.get("page");
  const page = raw && raw !== "all" ? raw : null;
  const setPage = useCallback((next: string | null) => {
    setSearch((current) => {
      const updated = new URLSearchParams(current);
      if (next) updated.set("page", next);
      else updated.delete("page");
      return updated;
    });
  }, [setSearch]);
  return { page, setPage };
}
