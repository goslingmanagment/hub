import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createHubClient, hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { toast } from "@agency_hub_core/ui";

/**
 * Workboard's Hub client and query cache: the generated SDK on the console's
 * cookie session, same origin. Every read and write of Workboard goes through
 * `kernel` (typed operations, answers checked against the contract).
 */

/** The console's sign-in, on this host, with the way back here. Only a path: never another origin. */
export function signInHref(returnTo: string = `${window.location.pathname}${window.location.search}${window.location.hash}`): string {
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : import.meta.env.BASE_URL;
  return `/login?${new URLSearchParams({ next: safe }).toString()}`;
}

let leaving = false;

/** An expired session: forget what was read, go to sign in, come back to the same place. */
function goSignIn() {
  if (leaving) return;
  leaving = true;
  queryClient.clear();
  window.location.assign(signInHref());
}

export const kernel = createHubClient({ onSessionExpired: goSignIn });

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** The screen says it itself (inside a window, under a button): no toast. */
      suppressGlobalError?: boolean;
    };
  }
}

/**
 * A write's fallback, when its screen says nothing itself; a read has none: the
 * screen shows «Hub не ответил» in its place. Never Hub's English.
 */
function writeFailed(error: unknown, meta?: { suppressGlobalError?: boolean }) {
  if (meta?.suppressGlobalError) return;
  const status = hubErrorStatus(error);
  if (status === 401) return;
  toast.error(status === null || status >= 500 ? "Hub не ответил: неизвестно, сохранилось ли." : "Не получилось. Hub вернул ошибку.");
}

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({ onError: (error, _variables, _context, mutation) => writeFailed(error, mutation.meta) }),
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Polls stop while the tab is hidden (TanStack's default, said out loud).
      refetchIntervalInBackground: false,
    },
    mutations: {
      // One press, one request: a write is never repeated by itself.
      retry: false,
    },
  },
});
