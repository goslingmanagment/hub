import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createClient } from "@kernel/sdk";
import { createHubClient, hubErrorStatus, type KernelClient } from "@agency_hub_core/ui/hubClient";
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

let current: KernelClient = createHubClient({ onSessionExpired: goSignIn });

/**
 * Workboard's one client. In the extension's frame (`setFrameClient`, products package R5: «Записать кастом» and
 * «Спросить» over the site) every request goes over the extension's port instead — no cookie, never a sign-in — so a
 * frame screen is the screen itself, never a copy of it.
 */
export const kernel: KernelClient = new Proxy({} as KernelClient, {
  get(_target, key) {
    const value = (current as unknown as Record<PropertyKey, unknown>)[key];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(current) : value;
  },
});

let framed = false;

/** The extension's frame: the client of every screen sends its requests with this `fetch` (the port's). */
export function setFrameClient(fetchImpl: typeof fetch): void {
  current = createClient({ baseUrl: "", fetch: fetchImpl });
  framed = true;
}

/**
 * Whether this page is a screen in the extension's frame (`setFrameClient`): its requests run with the extension's
 * device token, which Hub reads as a narrow session (no password), and a sign-in never happens inside it.
 */
export function inExtensionFrame(): boolean {
  return framed;
}

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
