import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

/** Система → «Состояние»: Hub's health, every routine and copy as judged now. Refreshed every minute. */
export function useSystemState() {
  return useQuery({
    queryKey: ["system", "state"],
    queryFn: () => kernel.systemState(),
    refetchInterval: 60_000,
  });
}
