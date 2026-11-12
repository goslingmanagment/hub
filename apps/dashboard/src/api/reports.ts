import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// Agent reports (package O): the pages agents publish, read by the owner's
// session (a team lead's reads only the ones opened to team leads). An agent
// republishes a page a few times a day: a minute between reads is plenty.

const REPORTS_STALE_MS = 60_000;

export function useAgentReports() {
  return useQuery({
    queryKey: ["reports"],
    queryFn: () => kernel.reportsList(),
    staleTime: REPORTS_STALE_MS,
  });
}

export function useAgentReport(slug: string | undefined) {
  return useQuery({
    queryKey: ["reports", slug],
    queryFn: () => kernel.reportGet({ params: { slug: slug! } }),
    enabled: slug !== undefined,
    staleTime: REPORTS_STALE_MS,
  });
}
