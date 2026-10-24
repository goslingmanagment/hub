import { routeSchemas, type ClientBootstrapResponse } from "@agency_hub_core/contracts";

import { pageScopeFor } from "../../api/request-auth.ts";
import { buildClientBootstrap } from "../../services/client-bootstrap.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";
import { registerClientFeedRoutes } from "./feed.ts";
import { registerClientProfileFromGenerationRoutes } from "./profile-from-generation.ts";
import { registerClientRecapRoutes } from "./recaps.ts";
import { registerClientAiUsageRoutes } from "./ai-usage.ts";
import { registerClientClaimRoutes } from "./claim.ts";
import { registerClientAudienceNewRoutes } from "./audience-new.ts";
import { registerClientHealthViewRoutes } from "./health.ts";
import { registerClientHeldSendsRoutes } from "./held-sends.ts";
import { registerClientSendAttributionRoutes } from "./send-attributions.ts";
import { registerClientActivityRoutes } from "./activity.ts";
import { registerClientInConversationRoutes } from "./in-conversation.ts";
import { registerClientFanCardRoutes } from "./fan-card.ts";
import { registerShiftReportRoutes } from "./shift-report.ts";
import { registerClientWinBackRoutes } from "./win-back.ts";
import { registerClientHandoffRoutes } from "./handoff.ts";
import { registerClientSpenderAwaitingReplyRoutes } from "./spender-awaiting-reply.ts";
import { registerClientSpenderStatsRoutes } from "./spender-stats.ts";

/**
 * The chat extension's routes under `/api/v1/client/` (chat-extension
 * architecture §8), and the dashboard routes about the extension. Every handler
 * of them lives in this module; the schemas live in
 * `packages/contracts/src/routes-client.ts`.
 */
export function registerClientRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.get("/api/v1/client/bootstrap", {
    schema: routeSchemas.clientBootstrap,
  }, async (request): Promise<ClientBootstrapResponse> => {
    // requirePrincipal: no principal → 401, an agent key → 403 (requireHumanPrincipal).
    const principal = await requirePrincipal(request);
    // A cookie session → 403: the bootstrap is a client's, not the dashboard's.
    return buildClientBootstrap(appContext, {
      user: principal.user,
      pageIds: pageScopeFor(principal) ?? null,
      // H-3: the client checks this before it trusts a narrow token.
      tokenClient: principal.clientProfile ?? null,
    });
  });

  registerClientRecapRoutes(server, ctx);
  registerClientFeedRoutes(server, ctx);
  registerClientProfileFromGenerationRoutes(server, ctx);
  registerClientAiUsageRoutes(server, ctx);
  registerClientSpenderStatsRoutes(server, ctx);
  registerClientSpenderAwaitingReplyRoutes(server, ctx);
  registerClientClaimRoutes(server, ctx);
  registerClientHeldSendsRoutes(server, ctx);
  registerClientAudienceNewRoutes(server, ctx);
  registerClientSendAttributionRoutes(server, ctx);
  registerClientActivityRoutes(server, ctx);
  registerClientInConversationRoutes(server, ctx);
  registerClientFanCardRoutes(server, ctx);
  registerClientWinBackRoutes(server, ctx);
  registerShiftReportRoutes(server, ctx);
  registerClientHandoffRoutes(server, ctx);
  registerClientHealthViewRoutes(server, ctx);
}
