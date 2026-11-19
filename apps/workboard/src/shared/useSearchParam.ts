import { useSearchParams } from "react-router";

/**
 * The address's search and a setter of one of its parameters: a value sets it, null drops it, the others stay (a new
 * history entry, as `setSearchParams`).
 */
export function useSearchParam(): [URLSearchParams, (name: string, value: string | null) => void] {
  const [search, setSearch] = useSearchParams();
  const setParam = (name: string, value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(name);
    else next.set(name, value);
    return next;
  });
  return [search, setParam];
}
