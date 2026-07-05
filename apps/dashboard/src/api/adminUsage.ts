import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export function useAdminChatterUsage(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ["admin", "usage", "chatters", params],
    queryFn: () => kernel.adminChatterUsage({ query: params }),
  });
}
