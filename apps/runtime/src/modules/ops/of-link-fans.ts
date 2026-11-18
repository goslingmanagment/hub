import { ofLinkFansRouteSchemas } from "@agency_hub_core/contracts";

import { requireOwner } from "../../services/auth.ts";
import { getOfLinkFans, getOfLinkSource, setOfLinkSource } from "../../services/of-link-fans.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/** The page of one OnlyFans link: its fans from the local walks of its lists, and its source when it has none. */
export function registerOfLinkFansRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext: app, auth: { requirePrincipal } } = ctx;
  server.get("/api/v1/admin/of-links/fans", { schema: ofLinkFansRouteSchemas.ofLinkFansGet }, async (request) => {
    requireOwner(await requirePrincipal(request));
    return getOfLinkFans(app.db, { ...request.query, now: new Date() });
  });
  server.get("/api/v1/admin/of-links/source", { schema: ofLinkFansRouteSchemas.ofLinkSourceGet }, async (request) => {
    requireOwner(await requirePrincipal(request));
    return getOfLinkSource(app.db, request.query);
  });
  server.put("/api/v1/admin/of-links/source", { schema: ofLinkFansRouteSchemas.ofLinkSourcePut }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return setOfLinkSource(app.db, { body: request.body, actorUserId: principal.user.id, actorUsername: principal.user.username });
  });
}
