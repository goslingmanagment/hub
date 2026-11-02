import { routeSchemas, type ClientFanMarksResponse, type ClientOtherPagesResponse } from "@agency_hub_core/contracts";

import { readClientFanMarks, readClientOtherPages } from "../../services/client-fan-marks.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Fan marks: warnings about the open Fansly fan for the chat header — «бомж»
 * lists of the agency's Fansly pages and FANSLY BLOCKLIST posts that name him.
 * The page is in the PATH: the declared page scope resolves from `:pageLabel`
 * only. The rules are services/client-fan-marks.ts.
 */
export function registerClientFanMarksRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/fans/:fanRef/marks", {
    schema: routeSchemas.clientFanMarks,
  }, async (request): Promise<ClientFanMarksResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return readClientFanMarks(appContext, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
      query: request.query,
    });
  });

  server.post("/api/v1/client/pages/:pageLabel/other-pages", {
    schema: routeSchemas.clientOtherPages,
  }, async (request): Promise<ClientOtherPagesResponse> => {
    const principal = await requirePrincipal(request);
    return readClientOtherPages(appContext, principal, {
      pageLabel: request.params.pageLabel,
      body: request.body,
    });
  });
}
