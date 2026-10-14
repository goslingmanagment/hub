import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PageBrowserLoginCodeBody, PageBrowserLoginResponse, PageBrowserLoginSubmitBody } from "@agency_hub_core/contracts";
import { kernelOperations } from "@kernel/sdk";

import { kernel } from "./sdk.js";

// The owner's login of a page's server browser (Project Browser PR 15): its
// state and the screen it shows, the owner's steps, the live screenshot.

const POLL_MS = 1_000;

export function pageBrowserLoginKey(pageLabel: string) {
  return ["pageBrowser", "login", pageLabel] as const;
}

/** The login's state; read every second while the login is open. */
export function usePageBrowserLogin(pageLabel: string) {
  return useQuery({
    queryKey: pageBrowserLoginKey(pageLabel),
    queryFn: () => kernel.pageBrowserLoginGet({ params: { pageLabel } }),
    enabled: !!pageLabel,
    meta: { suppressGlobalError: true },
    refetchInterval: (query: { state: { data: PageBrowserLoginResponse | undefined } }) =>
      (query.state.data?.login.state ?? "off") === "off" ? false : POLL_MS,
  });
}

function useLoginMutation<TBody, TResult>(pageLabel: string, run: (body: TBody) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: run,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: pageBrowserLoginKey(pageLabel) });
    },
  });
}

export function useStartPageBrowserLogin(pageLabel: string) {
  return useLoginMutation(pageLabel, (_: void) => kernel.pageBrowserLoginStart({ params: { pageLabel } }));
}

export function useFinishPageBrowserLogin(pageLabel: string) {
  return useLoginMutation(pageLabel, (_: void) => kernel.pageBrowserLoginFinish({ params: { pageLabel } }));
}

export function useSubmitPageBrowserLogin(pageLabel: string) {
  return useLoginMutation(pageLabel, (body: PageBrowserLoginSubmitBody) => kernel.pageBrowserLoginSubmit({ params: { pageLabel }, body }));
}

export function useSubmitPageBrowserCode(pageLabel: string) {
  return useLoginMutation(pageLabel, (body: PageBrowserLoginCodeBody) => kernel.pageBrowserLoginCode({ params: { pageLabel }, body }));
}

/** The live screenshot's address (same origin: the session cookie goes with
 *  the image's request); `tick` makes each second's a new one. */
export function pageBrowserScreenshotUrl(pageLabel: string, tick: number): string {
  return `${kernelOperations.pageBrowserLoginScreenshot.path.replace(":pageLabel", encodeURIComponent(pageLabel))}?t=${tick}`;
}
