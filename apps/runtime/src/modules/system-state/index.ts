import { routeSchemas } from "@agency_hub_core/contracts";

import { acceptCopyReports, acceptRoutineReports, readSystemState } from "../../services/system-state.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Система → «Состояние» (ecosystem plan, package P): the owner's read of every
 * routine and copy with Hub's own health (`/api/v1/system/state`, the owner's
 * session — the route's auth), and a reporter's whole list by its agent key
 * (`/api/v1/agent/system/…`, write:system_state), audited as every agent
 * write. Database only.
 */
export function registerSystemStateRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  server.get("/api/v1/system/state", { schema: routeSchemas.systemState }, async () => readSystemState(appContext));

  async function reporterScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["write:system_state"] });
    return { principal, scope };
  }

  server.put("/api/v1/agent/system/routines", { schema: routeSchemas.agentSystemRoutines }, async (request) => {
    const { principal, scope } = await reporterScope(request, "agentSystemRoutines");
    let delivered = 0;
    try {
      const done = await acceptRoutineReports(appContext, principal, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentSystemRoutines",
        pageIds: [],
        verbatimText: false,
        requestSummary: { reporter: done.reporter, routines: done.accepted, retired: done.retired },
      });
      delivered = 1;
      return done;
    } finally {
      await scope.finish(delivered);
    }
  });

  server.put("/api/v1/agent/system/copies", { schema: routeSchemas.agentSystemCopies }, async (request) => {
    const { principal, scope } = await reporterScope(request, "agentSystemCopies");
    let delivered = 0;
    try {
      const done = await acceptCopyReports(appContext, principal, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentSystemCopies",
        pageIds: [],
        verbatimText: false,
        requestSummary: { reporter: done.reporter, copies: done.accepted, retired: done.retired },
      });
      delivered = 1;
      return done;
    } finally {
      await scope.finish(delivered);
    }
  });
}
