/**
 * The Hub API client of a web app: the generated SDK (typed operations,
 * responses validated at run time) on the app's cookie session, same origin.
 * Each app says what an expired session means for it (the console reloads into
 * its sign-in, Workboard goes to the console's sign-in and back).
 */
import { KernelApiError, createClient, type KernelClient } from "@kernel/sdk";

/**
 * Operations whose 401 means "these credentials are wrong", not "your session
 * expired": both are answered inside a form the person is looking at.
 */
export const AUTH_FORM_OPERATIONS: ReadonlySet<string> = new Set(["login", "authChangePassword"]);

export function createHubClient(options: { onSessionExpired: () => void }): KernelClient {
  return createClient({
    baseUrl: "",
    auth: { mode: "cookie" },
    onAuthError: (error, operation) => {
      // A failed login is a normal form error, not an expired session. So is a
      // mistyped current password in the cabinet: the kernel answers 401 there
      // too, and bouncing the person to /login would lose the form instead of
      // telling them the password did not match.
      if (error.status === 401 && !AUTH_FORM_OPERATIONS.has(operation ?? "")) {
        options.onSessionExpired();
      }
    },
  });
}

/** An answer of Hub that is an error: `status` is null when Hub did not answer at all. */
export function hubErrorStatus(error: unknown): number | null {
  return error instanceof KernelApiError ? error.status ?? null : null;
}

export { KernelApiError };
export type { KernelClient };
