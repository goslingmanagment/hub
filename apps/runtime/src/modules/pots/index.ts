import { routeSchemas } from "@agency_hub_core/contracts";

import { requireOwner } from "../../services/auth.ts";
import {
  closePot,
  createPagePots,
  createPot,
  postPotDistribution,
  previewPotDistribution,
  readPotDetail,
  readPotsList,
  reversePotDistribution,
  updatePotService,
} from "../../services/pots.ts";
import { readPotDistributionsFeed } from "../../services/pots-feed.ts";
import { realmOf } from "../../services/sandbox/realm.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Workboard pots (0443, H11):
 *  - Owner-only endpoints (`/api/v1/pots*`) for Workboard «Деньги → Общаки»: pot catalog, computed base balances,
 *    unrouted pot sales, legacy ledger pots archive, pure preview, immutable post, and reversal.
 *  - Agent K2 feed (`GET /api/v1/agent/pot-distributions/feed`, `read:money`) for the agency ledger.
 */
export function registerPotsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  async function owner(request: Parameters<typeof requirePrincipal>[0]) {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return principal;
  }

  server.get("/api/v1/pots", { schema: routeSchemas.potsList }, async (request) => {
    return readPotsList(appContext, await owner(request));
  });

  server.post("/api/v1/pots", { schema: routeSchemas.potCreate }, async (request) => {
    return createPot(appContext, await owner(request), request.body);
  });

  server.post("/api/v1/pots/create-page-pots", { schema: routeSchemas.potsCreatePagePots }, async (request) => {
    return createPagePots(appContext, await owner(request), request.body);
  });

  server.get("/api/v1/pots/:potId", { schema: routeSchemas.potDetail }, async (request) => {
    return readPotDetail(appContext, await owner(request), request.params.potId, new Date(), request.query.day);
  });

  server.patch("/api/v1/pots/:potId", { schema: routeSchemas.potUpdate }, async (request) => {
    return updatePotService(appContext, await owner(request), request.params.potId, request.body);
  });

  server.post("/api/v1/pots/:potId/close", { schema: routeSchemas.potClose }, async (request) => {
    return closePot(appContext, await owner(request), request.params.potId);
  });

  server.post("/api/v1/pots/:potId/preview", { schema: routeSchemas.potDistributionPreview }, async (request) => {
    return previewPotDistribution(appContext, await owner(request), request.params.potId, request.body);
  });

  server.post("/api/v1/pots/:potId/distributions", { schema: routeSchemas.potDistributionPost }, async (request) => {
    return postPotDistribution(appContext, await owner(request), request.params.potId, request.body);
  });

  server.post("/api/v1/pots/distributions/:distributionId/reverse", { schema: routeSchemas.potDistributionReverse }, async (request) => {
    return reversePotDistribution(appContext, await owner(request), request.params.distributionId, request.body);
  });

  // Contract K2: ledger's feed of posted & reversed Workboard pot distributions (`read:money`).
  // Authorized against `principal.pageIds` (all granted pages in the key's realm), filtering `is_test` BEFORE `held`.
  server.get("/api/v1/agent/pot-distributions/feed", { schema: routeSchemas.agentPotDistributionsFeed }, async (request) => {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, {
      operation: "agentPotDistributionsFeed",
      requiredCapabilities: ["read:money"],
    });
    const pageIds = principal.pageIds;
    let delivered = 0;
    try {
      const feed = await readPotDistributionsFeed(appContext, {
        pageIds,
        since: request.query.since,
        limit: request.query.limit,
        agentKeyId: principal.agentKeyId,
        realm: realmOf(principal),
      });
      delivered = feed.changes.length;
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentPotDistributionsFeed",
        pageIds,
        verbatimText: false,
        requestSummary: { returned: delivered },
      });
      return feed;
    } finally {
      await scope.finish(delivered);
    }
  });
}
