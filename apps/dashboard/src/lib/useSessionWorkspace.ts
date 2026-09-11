import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SetStateAction } from "react";

/** UI-only state survives route remounts. Cleared with the authenticated query cache on logout. */
export function useSessionWorkspace<T>(name: string, initialValue: () => T) {
  const client = useQueryClient();
  const key = ["dashboard-workspace", name];
  const { data } = useQuery<T>({
    queryKey: key,
    queryFn: () => client.getQueryData<T>(key) ?? initialValue(),
    initialData: initialValue,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const lifetime = client.getQueryCache().find({ queryKey: key, exact: true });
  const read = () => { const current = client.getQueryData<T>(key); return (current === undefined ? data : current) as T; };
  const update = (value: SetStateAction<T>) => {
    // A reply from a logged-out session cannot recreate this workspace or overwrite
    // a new session's workspace even if it uses the same logical key.
    if (client.getQueryCache().find({ queryKey: key, exact: true }) !== lifetime) return;
    client.setQueryData<T>(key, previous =>
      typeof value === "function" ? (value as (previous: T) => T)(previous === undefined ? data as T : previous) : value);
  };
  return [data as T, update, read] as const;
}
