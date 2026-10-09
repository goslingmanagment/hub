import { ofLinksRouteSchemas } from "@agency_hub_core/contracts";

import { requireOwner } from "../../services/auth.ts";
import { BadRequestError, NotFoundError } from "../../services/errors.ts";
import { getOfLinkChannels, getOfLinkHistory, getOfLinks, OfLinksRequestError } from "../../services/of-links.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

async function answered<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof OfLinksRequestError) {
      throw error.kind === "not_found" ? new NotFoundError(error.message) : new BadRequestError(error.message);
    }
    throw error;
  }
}

/** «Ссылки OnlyFans» (traffic sources plan, PR 12): owner-only local reads of
 * the link series, its bindings and its collection state. */
export function registerOfLinksRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext: app, auth: { requirePrincipal } } = ctx;
  server.get("/api/v1/admin/of-links", { schema: ofLinksRouteSchemas.ofLinksGet }, async (request) => {
    requireOwner(await requirePrincipal(request));
    return answered(() => getOfLinks(app.db, { pageId: request.query.pageId, now: new Date() }));
  });
  server.get("/api/v1/admin/of-links/history", { schema: ofLinksRouteSchemas.ofLinksHistoryGet }, async (request) => {
    requireOwner(await requirePrincipal(request));
    return answered(() => getOfLinkHistory(app.db, { ...request.query, now: new Date() }));
  });
  server.get("/api/v1/admin/of-links/channels", { schema: ofLinksRouteSchemas.ofLinksChannelsGet }, async (request) => {
    requireOwner(await requirePrincipal(request));
    return answered(() => getOfLinkChannels(app.db, { ...request.query, now: new Date() }));
  });
}
