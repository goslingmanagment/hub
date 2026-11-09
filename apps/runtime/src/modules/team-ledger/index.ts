import { routeSchemas } from "@agency_hub_core/contracts";

import { readLedgerPayouts } from "../../services/ledger-payouts.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Workboard «Выплаты» from the agency ledger (`teamLedgerPayouts`, ledger
 * release 2): the chatters' accrued, paid and owed pay, read from the ledger
 * with Hub's payouts key. Owner session only (the route's auth); nothing is
 * written anywhere.
 */
export function registerTeamLedgerRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;

  server.get("/api/v1/team/ledger-payouts", { schema: routeSchemas.teamLedgerPayouts }, async (request) => {
    return readLedgerPayouts(appContext, request.query);
  });
}
