import { KernelApiError, createHubClient } from "@agency_hub_core/ui/hubClient";

import { clearDashboardSession } from "@/lib/queryClient";
import { buildLoginRoute } from "@/lib/navigation";

// The dashboard's single API client — every domain module
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

// The shared client (packages/ui/src/hubClient.ts): an expired session — any
// 401 but a failed login or a mistyped current password — sends the person to
// sign in again and back here.
export const kernel = createHubClient({ onSessionExpired: redirectToLogin });

export { KernelApiError };
