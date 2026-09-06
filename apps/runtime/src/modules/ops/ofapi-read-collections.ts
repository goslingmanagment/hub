import { ofapiReadCollectionsRouteSchemas } from "@agency_hub_core/contracts";
import { readOfapiStoredSnapshots } from "@agency_hub_core/db";
import { OFAPI_READ_CATALOG } from "@agency_hub_core/shared";
import { requireOwner } from "../../services/auth.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";
export function registerOfapiReadCollectionsRoutes(
  server: ApiServer,
  ctx: ApiModuleContext,
) {
  server.get(
    "/api/v1/admin/ofapi/collection/results",
    { schema: ofapiReadCollectionsRouteSchemas.ofapiReadCollectionsGet },
    async (request) => {
      const principal = await ctx.auth.requirePrincipal(request);
      requireOwner(principal);
      return ofapiReadCollectionsRouteSchemas.ofapiReadCollectionsGet.response[200].parse(
        {
          pageId: request.query.pageId,
          catalog: OFAPI_READ_CATALOG,
          snapshots: await readOfapiStoredSnapshots(
            ctx.appContext.db,
            request.query,
          ),
        },
      );
    },
  );
}
