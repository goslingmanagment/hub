import {
  routeSchemas,
  type ClientOnlineAttemptResponse,
  type ClientOnlinePresenceResponse,
  type ClientOnlineResponse,
} from "@agency_hub_core/contracts";

import { readClientOnline, recordClientOnlineAttempt, recordClientOnlinePresence } from "../../services/client-online.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension «Онлайн»: the list of the page's fans seen online with why to
 * write now, the Fansly fans a tab saw active, and what the chatters did in the
 * window. The rules are services/client-online-rules.ts.
 */
export function registerClientOnlineRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/pages/:pageLabel/online", {
    schema: routeSchemas.clientOnline,
  }, async (request): Promise<ClientOnlineResponse> => {
    const principal = await requirePrincipal(request);
    return readClientOnline(appContext, principal, { pageLabel: request.params.pageLabel, query: request.query });
  });

  server.post("/api/v1/client/pages/:pageLabel/online/presence", {
    schema: routeSchemas.clientOnlinePresence,
  }, async (request): Promise<ClientOnlinePresenceResponse> => {
    const principal = await requirePrincipal(request);
    return recordClientOnlinePresence(appContext, request, principal, { pageLabel: request.params.pageLabel, body: request.body });
  });

  server.post("/api/v1/client/pages/:pageLabel/online/attempts", {
    schema: routeSchemas.clientOnlineAttempt,
  }, async (request): Promise<ClientOnlineAttemptResponse> => {
    const principal = await requirePrincipal(request);
    return recordClientOnlineAttempt(appContext, request, principal, { pageLabel: request.params.pageLabel, body: request.body });
  });
}
