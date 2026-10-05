import { routeSchemas, type ClientFanClaimResponse, type ClientSendCustodyItem } from "@agency_hub_core/contracts";

import {
  applyClientFanClaim,
  getClientFanClaimStatus,
  resolveClientSendCustodyByStaff,
} from "../../services/client-claim.ts";
import { ClientPreviewSendRateLimitedError } from "../../services/errors.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * chat-extension H-7b: the greeting lease and the send custody of one fan
 * (`clientFanClaim`, `clientFanClaimStatus`), and the manual resolve of a held
 * send for the cabinet (`clientSendCustodyResolve`). The page is in the PATH:
 * the declared page scope resolves from `:pageLabel` only.
 */
export function registerClientClaimRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/client/pages/:pageLabel/fans/:fanRef/claim", {
    schema: routeSchemas.clientFanClaim,
  }, async (request, reply): Promise<ClientFanClaimResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403. The service
    // refuses a cookie session (403) and runs the hub's own check of the page
    // and of the owner's switches the action waits for.
    const principal = await requirePrincipal(request);
    try {
      return await applyClientFanClaim(appContext, request, principal, {
        pageLabel: request.params.pageLabel,
        fanRef: request.params.fanRef,
        body: request.body,
      });
    } catch (error) {
      if (error instanceof ClientPreviewSendRateLimitedError) {
        // The one refusal with advice: when the rate window frees a slot, in the
        // body for the SDK (its error carries no headers) and as Retry-After.
        return reply
          .code(429)
          .header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)))
          .send({
            error: error.code,
            message: error.message,
            statusCode: error.statusCode,
            retryAfterMs: error.retryAfterMs,
          });
      }
      throw error;
    }
  });

  server.get("/api/v1/client/pages/:pageLabel/fans/:fanRef/claim", {
    schema: routeSchemas.clientFanClaimStatus,
  }, async (request): Promise<ClientFanClaimResponse> => {
    const principal = await requirePrincipal(request);
    return getClientFanClaimStatus(appContext, request, principal, {
      pageLabel: request.params.pageLabel,
      fanRef: request.params.fanRef,
    });
  });

  // A cabinet route (cookie session, owner or team lead): no device token
  // reaches it, the extension's own least of all.
  server.post("/api/v1/pages/:pageLabel/client-send-custody/:attemptId/resolve", {
    schema: routeSchemas.clientSendCustodyResolve,
  }, async (request): Promise<ClientSendCustodyItem> => {
    const principal = await requirePrincipal(request);
    return resolveClientSendCustodyByStaff(appContext, principal, {
      pageLabel: request.params.pageLabel,
      attemptId: request.params.attemptId,
      body: request.body,
    });
  });
}
