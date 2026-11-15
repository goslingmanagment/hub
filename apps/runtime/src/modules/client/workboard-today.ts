import { routeSchemas, type AccountShiftsResponse, type WorkboardTodayResponse } from "@agency_hub_core/contracts";

import { requireHumanPrincipal } from "../../services/auth.ts";
import { readAccountShifts } from "../../services/own-shift-rows.ts";
import { readWorkboardToday } from "../../services/workboard-today.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Workboard «Сегодня» and the person's own shifts with their reports (products package W): the caller's own, any
 * cookie session (the narrow one too); the team part of «Сегодня» only for whoever leads a team. Nothing is written.
 */
export function registerWorkboardTodayRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/account/shifts", { schema: routeSchemas.accountShifts }, async (request): Promise<AccountShiftsResponse> => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readAccountShifts(appContext, principal, request.query);
  });

  server.get("/api/v1/workboard/today", { schema: routeSchemas.workboardToday }, async (request): Promise<WorkboardTodayResponse> => {
    const principal = await requirePrincipal(request);
    requireHumanPrincipal(principal);
    return readWorkboardToday(appContext, principal);
  });
}
