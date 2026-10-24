import type { TeamCustomsResponse } from "@agency_hub_core/contracts";
import { listPageOpenCustoms } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";

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
