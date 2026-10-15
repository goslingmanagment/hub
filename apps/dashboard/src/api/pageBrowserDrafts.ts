import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  PageBrowserDraftSaveBody,
  PageBrowserDraftView,
  PageBrowserProxyCheckBody,
  PageBrowserProxyCheckResponse,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";
import { pageBrowserProfilesKey } from "./pageBrowserOnboarding.js";

// A page's server browser started in the dashboard (Project Browser, owner
// decision 2026-10-15): the drafts `add-profile` makes browsers from, the
// owner's proxy check, and the draft's save. A pasted proxy holds its
// password: what carries it — the check of a pasted text, the save — goes
// straight to the API and never through React Query (a mutation keeps its
// arguments in the client's cache for its gcTime: PR 15's lesson). What
// comes back holds no password.

export const pageBrowserDraftsKey = ["pageBrowser", "drafts"] as const;

/** The drafts and the pages that may move to their browser. */
export function usePageBrowserDrafts() {
  return useQuery({
    queryKey: pageBrowserDraftsKey,
    queryFn: () => kernel.pageBrowserDrafts(),
    meta: { suppressGlobalError: true },
    refetchInterval: 15_000,
  });
}

/** The owner's «Проверить прокси»: straight to the API. */
export function checkPageBrowserProxy(source: PageBrowserProxyCheckBody["source"]): Promise<PageBrowserProxyCheckResponse> {
  return kernel.pageBrowserProxyCheck({ body: { source } });
}

/** The draft saved: straight to the API; the lists read anew after it. */
export async function savePageBrowserDraft(qc: QueryClient, name: string, body: PageBrowserDraftSaveBody): Promise<PageBrowserDraftView> {
  try {
    return await kernel.pageBrowserDraftSave({ params: { name }, body });
  } finally {
    void qc.invalidateQueries({ queryKey: pageBrowserDraftsKey });
  }
}

/** A draft deleted (no secret goes: a mutation). */
export function useDeletePageBrowserDraft() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (name: string) => kernel.pageBrowserDraftDelete({ params: { name } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: pageBrowserDraftsKey });
      void qc.invalidateQueries({ queryKey: pageBrowserProfilesKey });
    },
  });
}
