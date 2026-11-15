import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConfigUpdateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";
export { usePages as useConfigPages } from "./pages.js";

/** `enabled: false` — a person whose screen shows no switches (a content manager's «Публикации»): nothing is asked. */
export function useAdminConfig(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "config"],
    queryFn: () => kernel.adminConfig(),
    refetchInterval: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: ConfigUpdateBody) =>
      kernel.adminConfigUpdate({ body }),
    // Refetch after success AND failure: a 409 means the row changed elsewhere, so
    // the view (and overrideVersion) must refresh for the message to be true and the
    // retry to send the right expectedVersion.
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "config"] }),
  });
}

export function useClearConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({
      key,
      expectedVersion,
      note,
    }: {
      key: string;
      expectedVersion?: number;
      note?: string;
    }) =>
      kernel.adminConfigClear({ params: { key }, query: { expectedVersion, note } }),
    // Refetch after success AND failure: a 409 means the row changed elsewhere, so
    // the view (and overrideVersion) must refresh for the message to be true and the
    // retry to send the right expectedVersion.
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "config"] }),
  });
}
