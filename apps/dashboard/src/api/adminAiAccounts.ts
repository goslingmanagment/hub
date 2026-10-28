import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminAiAccountUpdateBody,
  AdminAiReconciliationImportBody,
  AdminAiReconciliationKeyBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

const AI_ACCOUNTS_QUERY_KEY = ["admin", "ai-accounts"] as const;

export function useAdminAiAccounts() {
  return useQuery({
    queryKey: AI_ACCOUNTS_QUERY_KEY,
    queryFn: () => kernel.adminAiAccountsList(),
    refetchInterval: 60_000,
  });
}

/** Hub's ledger against Anthropic's bill per account and UTC day (the Admin
 * API sync's reports or the owner's Cost CSV). */
export function useAdminAiReconciliation(days: number) {
  return useQuery({
    queryKey: ["admin", "ai-reconciliation", days] as const,
    queryFn: () => kernel.adminAiReconciliation({ query: { days } }),
    refetchInterval: 5 * 60_000,
  });
}

function useRefreshReconciliation() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ["admin", "ai-reconciliation"] }),
    qc.invalidateQueries({ queryKey: AI_ACCOUNTS_QUERY_KEY }),
  ]);
}

/** The owner's Cost CSV from the Anthropic console, for one account's organization. */
export function useAdminAiReconciliationImport() {
  const refresh = useRefreshReconciliation();
  return useMutation({
    mutationFn: (body: AdminAiReconciliationImportBody) => kernel.adminAiReconciliationImport({ body }),
    onSuccess: () => refresh(),
  });
}

/** The owner's decision on whose an API key is. */
export function useAdminAiReconciliationKey() {
  const refresh = useRefreshReconciliation();
  return useMutation({
    mutationFn: (body: AdminAiReconciliationKeyBody) => kernel.adminAiReconciliationKeyUpdate({ body }),
    onSuccess: () => refresh(),
  });
}

/** The ElevenLabs account behind voice notes, as Hub's 30-min check last saw it. */
export function useAdminVoiceAccount() {
  return useQuery({
    queryKey: ["admin", "voice-account"] as const,
    queryFn: () => kernel.adminVoiceAccount(),
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
