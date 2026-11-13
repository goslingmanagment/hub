import { routeSchemas, type ShiftReportNotesResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { readShiftReportNotes } from "../../services/shift-report-notes.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * «Смены» and «Мои смены»: what stands between a person's shifts of a day and the report it is paid by
 * (services/shift-report-notes.ts). Any cookie session: the owner reads everyone's days, anyone else (a team lead, a
 * chatter, a narrow session) their own. The ledger is read by GET; nothing is written anywhere.
 */
export function registerShiftReportNotesRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/shift-report-notes", {
    schema: routeSchemas.shiftReportNotes,
  }, async (request): Promise<ShiftReportNotesResponse> => {
    const principal = await requirePrincipal(request);
    return readShiftReportNotes(appContext, principal, { query: request.query, pageScope: pageScopeFor(principal) });
  });
}
