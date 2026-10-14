import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { PageBrowserLoginResponse, PageBrowserLoginStepResponse } from "@agency_hub_core/contracts";
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

/** A step of the form: the login and the password, or the code. */
export type PageBrowserLoginStep =
  | { kind: "submit"; login: string; password: string }
  | { kind: "code"; code: string };

/**
 * A step of the form goes straight to the API — never through React Query:
 * a mutation keeps its arguments (`state.variables`) in the client's mutation
 * cache for its gcTime (300 s) after the page is gone, and the password or
 * the code with them (Astra's review of PR 15). No retry; the step's argument
 * lives in this call only. The login's state is read anew after it.
 */
export async function sendPageBrowserLoginStep(qc: QueryClient, pageLabel: string, step: PageBrowserLoginStep): Promise<PageBrowserLoginStepResponse> {
  try {
    return step.kind === "code"
      ? await kernel.pageBrowserLoginCode({ params: { pageLabel }, body: { code: step.code } })
      : await kernel.pageBrowserLoginSubmit({ params: { pageLabel }, body: { login: step.login, password: step.password } });
  } finally {
    void qc.invalidateQueries({ queryKey: pageBrowserLoginKey(pageLabel) });
  }
}

/** The form's steps (`sendPageBrowserLoginStep`) and whether one is on its way. */
export function usePageBrowserLoginStep(pageLabel: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const send = useCallback(async (step: PageBrowserLoginStep) => {
    setPending(true);
    try {
      return await sendPageBrowserLoginStep(qc, pageLabel, step);
    } finally {
      setPending(false);
    }
  }, [qc, pageLabel]);
  return { pending, send };
}

/** The live screenshot's address (same origin: the session cookie goes with
 *  the image's request); `tick` makes each second's a new one. */
export function pageBrowserScreenshotUrl(pageLabel: string, tick: number): string {
  return `${kernelOperations.pageBrowserLoginScreenshot.path.replace(":pageLabel", encodeURIComponent(pageLabel))}?t=${tick}`;
}
