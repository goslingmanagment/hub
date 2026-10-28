import {
  routeSchemas,
  type ClientFanNoteAttributionsResponse,
  type ClientNoteAttributionsResponse,
} from "@agency_hub_core/contracts";

import { applyClientNoteAttributions, readClientFanNoteAttributions } from "../../services/client-note-attributions.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * note-attribution-v1: who wrote each fan note (`clientNoteAttributions`), and
 * note-attribution-read-v1: who created each note of a fan and who edited it
 * last (`clientFanNoteAttributions`). The page is in the PATH: the declared page scope resolves from `:pageLabel`
 * only. The rules are services/client-note-attributions.ts.
 */
export function registerClientNoteAttributionRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/pages/:pageLabel/note-attributions", {
    schema: routeSchemas.clientNoteAttributions,
  }, async (request): Promise<ClientNoteAttributionsResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and checks the page grant.
    const principal = await requirePrincipal(request);
    return applyClientNoteAttributions(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      body: request.body,
    });
  });

  server.get("/api/v1/client/pages/:pageLabel/fans/:fanRef/note-attributions", {
    schema: routeSchemas.clientFanNoteAttributions,
  }, async (request): Promise<ClientFanNoteAttributionsResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service refuses a cookie session (403).
    const principal = await requirePrincipal(request);
    return readClientFanNoteAttributions(appContext, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
    });
  });
}
