import { routeSchemas, type AccountPayResponse } from "@agency_hub_core/contracts";

import { readAccountPay } from "../../services/ledger-person-pay.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * «Мои деньги»: the caller's own pay from the agency ledger, behind the person's switch «видит свои деньги»
 * (services/ledger-person-pay.ts). Any cookie session; the person is the session user's, found through the people
 * registry, never one named in the request. Nothing is written anywhere.
 */
export function registerAccountPayRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/account/pay", {
    schema: routeSchemas.accountPay,
  }, async (request): Promise<AccountPayResponse> => {
    const principal = await requirePrincipal(request);
    return readAccountPay(appContext, principal, request.query);
  });
}
