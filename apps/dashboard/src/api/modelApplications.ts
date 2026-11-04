import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// Команда → Анкеты (owner-session): the site's model questionnaire, followed
// live — both reads are polled every 5 s while their screen is open.

const MODEL_APPLICATIONS_POLL_MS = 5_000;

export function useModelApplications() {
  return useQuery({
    queryKey: ["admin", "modelApplications"],
    queryFn: () => kernel.adminModelApplications(),
    refetchInterval: MODEL_APPLICATIONS_POLL_MS,
  });
}

export function useModelApplication(ref: string | undefined) {
  return useQuery({
    queryKey: ["admin", "modelApplications", ref],
    queryFn: () => kernel.adminModelApplication({ params: { ref: ref! } }),
    enabled: ref !== undefined,
    refetchInterval: MODEL_APPLICATIONS_POLL_MS,
  });
}
