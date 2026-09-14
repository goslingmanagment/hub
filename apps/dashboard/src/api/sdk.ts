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

export const kernel = createClient({
  baseUrl: "",
  auth: { mode: "cookie" },
  onAuthError: (error, operation) => {
    // A failed login is a normal form error, not an expired session.
    if (error.status === 401 && operation !== "login") {
      redirectToLogin();
    }
  },
});

export { KernelApiError };
