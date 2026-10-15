import { useQuery } from "@tanstack/react-query";
import { clientHeldSendsQueryOptions } from "./clientHeldSends.js";
import { kernel } from "./sdk.js";

/**
 * How much in «Требует внимания» waits for a person: held extension sends
 * (owner and team leads) and open incidents (owner). The sidebar and the
 * section's tabs show these counts, so a queue no longer sits unnoticed
 * until someone happens to open it. A failed count shows nothing — it
 * never claims an empty queue.
 */
export function useAttentionCounts(role: string) {
  const held = useQuery(clientHeldSendsQueryOptions({ state: "held", limit: 1, offset: 0 }));
  const incidents = useQuery({
    queryKey: ["notifications", "incidents", { status: "open", limit: 1 }],
    queryFn: () => kernel.notificationsIncidents({ query: { status: "open", limit: 1 } as Parameters<typeof kernel.notificationsIncidents>[0]["query"] }),
    enabled: role === "owner",
    refetchInterval: 60_000,
    meta: { suppressGlobalError: true },
  });
  const heldSends = held.data?.total ?? null;
  const openIncidents = role === "owner" ? incidents.data?.total ?? null : null;
  const total = (heldSends ?? 0) + (openIncidents ?? 0);
  return { heldSends, openIncidents, total };
}
