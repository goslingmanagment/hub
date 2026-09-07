import { routeSchemas } from "@agency_hub_core/contracts";
import { requireOwner } from "../../services/auth.ts";
import { applyOfapiKeyScope, getOfapiKeyScope, refreshOfapiVendorUsage } from "../../services/ofapi-vendor-usage.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

export function registerOfapiVendorRoutes(server: ApiServer, ctx: ApiModuleContext) {
  server.post("/api/v1/admin/ofapi/vendor-usage", { schema: routeSchemas.ofapiVendorUsageRefresh }, async request => {
    requireOwner(await ctx.auth.requirePrincipal(request));
    return refreshOfapiVendorUsage(ctx.appContext, request.body);
  });
  server.get("/api/v1/admin/ofapi/key-scope", { schema: routeSchemas.ofapiKeyScopeGet }, async request => {
    requireOwner(await ctx.auth.requirePrincipal(request));
    return getOfapiKeyScope(ctx.appContext);
  });
  server.post("/api/v1/admin/ofapi/key-scope", { schema: routeSchemas.ofapiKeyScopeApply }, async request => {
    const principal = await ctx.auth.requirePrincipal(request);
    requireOwner(principal);
    return applyOfapiKeyScope(ctx.appContext, request.body, principal.user.id);
  });
}
