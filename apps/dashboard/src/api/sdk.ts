import { KernelApiError, createClient } from "@kernel/sdk";

import { clearDashboardSession } from "@/lib/queryClient";
import { buildLoginRoute } from "@/lib/navigation";

// Kernel Stage 20: the dashboard's single API client — every domain module
// goes through the generated SDK (typed operations, runtime-validated
// responses). Direct fetch and the old hand-rolled client are lint-banned in
// src/api/.

function redirectToLogin() {
  if (typeof window === "undefined") {
    return;
  }

  if (window.location.pathname === "/login") {
    return;
  }

  clearDashboardSession();
  window.location.assign(buildLoginRoute(`${window.location.pathname}${window.location.search}${window.location.hash}`));
}

// Operations whose 401 means "these credentials are wrong", not "your session
// expired" — both are answered inside a form the person is looking at.
const AUTH_FORM_OPERATIONS = new Set(["login", "authChangePassword"]);

export const kernel = createClient({
  baseUrl: "",
  auth: { mode: "cookie" },
  onAuthError: (error, operation) => {
    // A failed login is a normal form error, not an expired session. So is a
    // mistyped current password in the cabinet (Decision 351): the kernel
    // answers 401 there too, and bouncing the person to /login would lose the
    // form instead of telling them the password did not match.
    if (error.status === 401 && !AUTH_FORM_OPERATIONS.has(operation ?? "")) {
      redirectToLogin();
    }
  },
});

export { KernelApiError };
