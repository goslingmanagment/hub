import { useCallback, useRef } from "react";
import { useLocation, useSearchParams } from "react-router";
import { keepAllPages } from "./pageParam.js";

/** A change of the list's own parameters; the position resets unless asked. Stable across renders. */
export function useListParams() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const latest = useRef({ setSearch, state: location.state as unknown });
  latest.current = { setSearch, state: location.state as unknown };
  const update = useCallback((changes: Readonly<Record<string, string | null>>, options: { keepPosition?: boolean } = {}) => {
    latest.current.setSearch((previous) => {
      const next = keepAllPages(previous, new URLSearchParams(previous));
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!options.keepPosition && !("offset" in changes)) next.delete("offset");
      return next;
    }, { replace: true, state: latest.current.state });
  }, []);
  return { search, update };
}
