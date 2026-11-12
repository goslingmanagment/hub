import type { TeamCustomsResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { awaitingGivingOf, teamCustomsOfOrders } from "./custom-orders/readers.ts";

/**
 * `teamCustoms`: the custom orders paid or shot and not given, of the pages the viewer reaches, in the route's old
 * shape (`teamCustomsOfOrders`: every row `paid`), the oldest payment first. Read-only, database only.
 */
export async function readTeamCustoms(
  app: AppContext,
  principal: AuthPrincipal,
  input: { pageScope: readonly number[] | undefined },
): Promise<TeamCustomsResponse> {
  requireDashboardUser(principal);
  return teamCustomsOfOrders(await awaitingGivingOf(app, { pageIds: input.pageScope ?? "all", limit: 200 }), new Date());
}
