import type { TeamCustomsResponse } from "@agency_hub_core/contracts";
import { listPageOpenCustoms } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { awaitingGivingOf, customOrdersReadOn, teamCustomsOfOrders } from "./custom-orders/readers.ts";

/**
 * Chat Memory week 4 (week-4.md §1): the open customs of the pages the viewer
 * reaches (`teamCustoms`) — ordered or paid and not delivered, the oldest
 * payment first. Read-only, database only.
 */
export async function readTeamCustoms(
  app: AppContext,
  principal: AuthPrincipal,
  input: { pageScope: readonly number[] | undefined },
): Promise<TeamCustomsResponse> {
  requireDashboardUser(principal);
  // Package I: behind the owner's setting, the custom orders paid or shot and not given; off — the old table.
  if (await customOrdersReadOn(app)) {
    return teamCustomsOfOrders(await awaitingGivingOf(app, { pageIds: input.pageScope ?? "all", limit: 200 }), new Date());
  }
  const customs = await listPageOpenCustoms(app.db, { pageIds: input.pageScope ?? "all", limit: 200 });
  return {
    customs: customs.map((custom) => ({
      id: custom.id,
      pageLabel: custom.pageLabel,
      fanRef: custom.fanRef,
      description: custom.description,
      priceMills: custom.priceMills,
      state: custom.state,
      paidAt: custom.paidAt === null ? null : custom.paidAt.toISOString(),
      createdBy: custom.createdBy,
      createdAt: custom.createdAt.toISOString(),
    })),
    serverNow: new Date().toISOString(),
  };
}
