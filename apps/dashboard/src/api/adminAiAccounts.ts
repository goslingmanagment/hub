import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminAiAccountUpdateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

const AI_ACCOUNTS_QUERY_KEY = ["admin", "ai-accounts"] as const;

export function useAdminAiAccounts() {
  return useQuery({
    queryKey: AI_ACCOUNTS_QUERY_KEY,
    queryFn: () => kernel.adminAiAccountsList(),
    refetchInterval: 60_000,
  });
}

export function useAdminUpdateAiAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: number; body: AdminAiAccountUpdateBody }) =>
      kernel.adminAiAccountUpdate({ params: { accountId: input.accountId }, body: input.body }),
    onSuccess: (data) => {
      qc.setQueryData(AI_ACCOUNTS_QUERY_KEY, data);
    },
  });
}
