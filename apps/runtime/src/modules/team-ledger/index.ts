import { routeSchemas } from "@agency_hub_core/contracts";

import { readLedgerPayoutPrepare, readLedgerPayouts } from "../../services/ledger-payouts.ts";
import { readTeamLedgerQuestions } from "../../services/ledger-questions.ts";
import { readTeamLedgerReports } from "../../services/ledger-team-reports.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Workboard «Выплаты» from the agency ledger (`teamLedgerPayouts`, ledger
 * release 2): the chatters' accrued, paid and owed pay, read from the ledger
 * with Hub's payouts key; and every chatter's shift reports (`teamLedgerReports`):
 * the pay base the ledger reads from the posts, the drafts, the posts it could
 * not use; and the open questions «whose is this sale» (`teamLedgerQuestions`). Owner session only (the routes'
 * auth); nothing is written anywhere.
 */
export function registerTeamLedgerRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;

  server.get("/api/v1/team/ledger-payouts", { schema: routeSchemas.teamLedgerPayouts }, async (request) => {
    return readLedgerPayouts(appContext, request.query);
  });

  // One person's payout brief (ledger L5): the transfer, the lines, the blockers and the chatter's message draft.
  server.get("/api/v1/team/ledger-payouts/prepare", { schema: routeSchemas.teamLedgerPayoutPrepare }, async (request) => {
    return readLedgerPayoutPrepare(appContext, request.query);
  });

  server.get("/api/v1/team/ledger-reports", { schema: routeSchemas.teamLedgerReports }, async (request) => {
    return readTeamLedgerReports(appContext, request.query);
  });

  // The open questions «whose is this sale» the chat agent asked (Решения → «Чья продажа»): read only, the owner
  // answers the agent in the chat.
  server.get("/api/v1/team/ledger-questions", { schema: routeSchemas.teamLedgerQuestions }, async () => {
    return readTeamLedgerQuestions(appContext);
  });
}
