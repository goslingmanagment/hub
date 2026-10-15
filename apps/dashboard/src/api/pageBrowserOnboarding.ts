import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  PageBrowserLoginStepResponse,
  PageBrowserMaskedProxy,
  PageBrowserProfileResponse,
  PageBrowserProfileProxyBody,
} from "@agency_hub_core/contracts";
import { kernelOperations } from "@kernel/sdk";

import { kernel } from "./sdk.js";
import type { PageBrowserLoginStep } from "./pageBrowser.js";

// A new page connected through its own server browser (Project Browser PR
// 16): the profiles no page has yet, one profile's onboarding — its proxy
// (given in the owner's draft, replaced here), its pinned exit IP, the owner's login through the same form, the account
// checked through the browser, the page created and bound.

const POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;

export const pageBrowserProfilesKey = ["pageBrowser", "profiles"] as const;

export function pageBrowserProfileKey(profileId: string) {
  return ["pageBrowser", "profile", profileId] as const;
}

/** The profiles no page has yet (made by add-profile). */
export function usePageBrowserProfiles() {
  return useQuery({
    queryKey: pageBrowserProfilesKey,
    queryFn: () => kernel.pageBrowserProfiles(),
    meta: { suppressGlobalError: true },
    refetchInterval: 15_000,
  });
}

/** A profile's onboarding: read every second while something moves (its
 *  login, an account check, the browser starting), every five otherwise. */
export function usePageBrowserProfile(profileId: string) {
  return useQuery({
    queryKey: pageBrowserProfileKey(profileId),
    queryFn: () => kernel.pageBrowserProfileGet({ params: { profileId } }),
    enabled: !!profileId,
    meta: { suppressGlobalError: true },
    refetchInterval: (query: { state: { data: PageBrowserProfileResponse | undefined } }) => {
      const data = query.state.data;
      if (data === undefined) return POLL_MS;
      const settled = data.login.state === "off" && !data.identity.pending && (data.profile.operator.exitOpen || data.profile.operator.step === null);
      return settled ? IDLE_POLL_MS : POLL_MS;
    },
  });
}

function useProfileMutation<TBody, TResult>(profileId: string, run: (body: TBody) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: run,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: pageBrowserProfileKey(profileId) });
      void qc.invalidateQueries({ queryKey: pageBrowserProfilesKey });
    },
  });
}

export function usePinPageBrowserProfile(profileId: string) {
  return useProfileMutation(profileId, (ip: string) => kernel.pageBrowserProfilePin({ params: { profileId }, body: { ip } }));
}

export function useStartPageBrowserProfileLogin(profileId: string) {
  return useProfileMutation(profileId, (_: void) => kernel.pageBrowserProfileLoginStart({ params: { profileId } }));
}

export function useFinishPageBrowserProfileLogin(profileId: string) {
  return useProfileMutation(profileId, (_: void) => kernel.pageBrowserProfileLoginFinish({ params: { profileId } }));
}

export function useClosePageBrowserProfile(profileId: string) {
  return useProfileMutation(profileId, (_: void) => kernel.pageBrowserProfileClose({ params: { profileId } }));
}

/** The account checked through the browser (no secret goes: a mutation). */
export function useVerifyPageBrowserProfile(profileId: string) {
  return useProfileMutation(profileId, (_: void) => kernel.adminVerifyCredentials({ body: { platform: "fansly", browserProfileId: profileId } }));
}

/** The page created through the browser and the profile bound to it. */
export function useCreatePageThroughBrowser(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: { modelSlug: string; label: string }) => kernel.adminCreatePage({ body: { platform: "fansly", browserProfileId: profileId, ...body } }),
    onSettled: () => {
      for (const key of [["admin", "pages"], ["pages"], ["admin", "connections"], ["overview"], pageBrowserProfilesKey, pageBrowserProfileKey(profileId)]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/**
 * The proxy of the page to be — the text the owner pasted, read by Hub, and
 * the owner's check of it (its address is the one kept) — goes straight to
 * the API, never through React Query: a mutation keeps its
 * arguments in the client's cache for its gcTime after the page is gone, and
 * the proxy's password with them (PR 15's lesson for the login form). The
 * view is read anew after it.
 */
export async function sendPageBrowserProfileProxy(qc: QueryClient, profileId: string, proxy: PageBrowserProfileProxyBody["proxy"], checkId: string): Promise<{ proxy: PageBrowserMaskedProxy }> {
  try {
    return await kernel.pageBrowserProfileProxy({ params: { profileId }, body: { proxy, checkId } });
  } finally {
    void qc.invalidateQueries({ queryKey: pageBrowserProfileKey(profileId) });
    void qc.invalidateQueries({ queryKey: pageBrowserProfilesKey });
  }
}

/** A step of the form, as the page's login sends it: straight to the API. */
export async function sendPageBrowserProfileLoginStep(qc: QueryClient, profileId: string, step: PageBrowserLoginStep): Promise<PageBrowserLoginStepResponse> {
  try {
    return step.kind === "code"
      ? await kernel.pageBrowserProfileLoginCode({ params: { profileId }, body: { code: step.code } })
      : await kernel.pageBrowserProfileLoginSubmit({ params: { profileId }, body: { login: step.login, password: step.password } });
  } finally {
    void qc.invalidateQueries({ queryKey: pageBrowserProfileKey(profileId) });
  }
}

/** The form's steps and whether one is on its way. */
export function usePageBrowserProfileLoginStep(profileId: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const send = useCallback(async (step: PageBrowserLoginStep) => {
    setPending(true);
    try {
      return await sendPageBrowserProfileLoginStep(qc, profileId, step);
    } finally {
      setPending(false);
    }
  }, [qc, profileId]);
  return { pending, send };
}

/** The live screenshot's address of a profile's browser. */
export function pageBrowserProfileScreenshotUrl(profileId: string, tick: number): string {
  return `${kernelOperations.pageBrowserProfileLoginScreenshot.path.replace(":profileId", encodeURIComponent(profileId))}?t=${tick}`;
}
