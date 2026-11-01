import { routeSchemas } from "@agency_hub_core/contracts";

import {
  listClientOutreaches,
  readClientOutreach,
  readClientOutreachTouches,
  saveClientOutreach,
  sendClientOutreach,
} from "../../services/client-outreaches.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * «Рассылки» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md): the
 * extension lists the page's outreaches, reads one, saves its changes, claims
 * and reports each fan's send, and reads which fans were written to in the
 * last 3 days, under `/api/v1/client/pages/:pageLabel/…`. Nothing here talks
 * to a platform.
 */
export function registerOutreachRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/outreaches", { schema: routeSchemas.clientOutreaches }, async (request) => {
    const principal = await requirePrincipal(request);
    return listClientOutreaches(appContext, principal, { pageLabel: request.params.pageLabel });
  });

  server.get("/api/v1/client/pages/:pageLabel/outreaches/:outreachId", { schema: routeSchemas.clientOutreach }, async (request) => {
    const principal = await requirePrincipal(request);
    return readClientOutreach(appContext, principal, { pageLabel: request.params.pageLabel, outreachId: request.params.outreachId });
  });

  server.post("/api/v1/client/pages/:pageLabel/outreaches/:outreachId", { schema: routeSchemas.clientOutreachSave }, async (request) => {
    const principal = await requirePrincipal(request);
    return saveClientOutreach(appContext, principal, {
      pageLabel: request.params.pageLabel, outreachId: request.params.outreachId, body: request.body,
    });
  });

  server.post("/api/v1/client/pages/:pageLabel/outreaches/:outreachId/sends", { schema: routeSchemas.clientOutreachSend }, async (request) => {
    const principal = await requirePrincipal(request);
    return sendClientOutreach(appContext, request, principal, {
      pageLabel: request.params.pageLabel, outreachId: request.params.outreachId, body: request.body,
    });
  });

  server.get("/api/v1/client/pages/:pageLabel/outreach-touches", { schema: routeSchemas.clientOutreachTouches }, async (request) => {
    const principal = await requirePrincipal(request);
    return readClientOutreachTouches(appContext, principal, { pageLabel: request.params.pageLabel });
  });
}
