import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { kernel } from "./sdk.js";

export function useAdminOfapiBannedWords() {
  return useQuery({ queryKey: ["ofapi", "banned-words"], queryFn: () => kernel.ofapiBannedWordsAdminGet(), meta: { suppressGlobalError: true } });
}
export function useRefreshOfapiBannedWords() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (maxPages: number) => kernel.ofapiBannedWordsRefresh({ body: { maxPages } }),
    meta: { suppressGlobalError: true },
    onSuccess: async result => { qc.setQueryData(["ofapi", "banned-words"], result); await qc.invalidateQueries({ queryKey: ["ofapi", "banned-words"] }); },
  });
}
