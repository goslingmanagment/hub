import { agentReportBodyBytes, routeSchemas } from "@agency_hub_core/contracts";

import {
  agentReportBodyDigest,
  publishAgentReport,
  readAgentReportsForAgent,
  readReport,
  readReportsList,
} from "../../services/agent-reports.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Agent reports (ecosystem plan, package O): an agent key with write:reports
 * publishes a named markdown page (`PUT /api/v1/agent/reports/:slug`) and
 * lists what is published (`GET /api/v1/agent/reports`); a person reads them
 * by session (`/api/v1/reports…`). The routes' auth blocks decide who calls,
 * the service what each reads. Every publish leaves an audit row with the
 * body's digest and length, never its text. Nothing here talks to a platform.
 */
export function registerAgentReportRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  server.get("/api/v1/reports", { schema: routeSchemas.reportsList }, async (request) => {
    const principal = await requirePrincipal(request);
    return readReportsList(appContext, principal);
  });

  server.get("/api/v1/reports/:slug", { schema: routeSchemas.reportGet }, async (request) => {
    const principal = await requirePrincipal(request);
    return readReport(appContext, principal, request.params.slug);
  });

  // --- Agent keys (write:reports) -------------------------------------------

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["write:reports"] });
    return { principal, scope };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>, rows: (result: T) => number) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = rows(result);
      return result;
    } finally {
      await scope.finish(delivered);
    }
  }

  server.put("/api/v1/agent/reports/:slug", { schema: routeSchemas.agentReportPut }, async (request) => {
    const { principal, scope } = await agentScope(request, "agentReportPut");
    return settled(scope, async () => {
      const published = await publishAgentReport(appContext, { slug: request.params.slug, body: request.body, agentKeyId: principal.agentKeyId });
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentReportPut",
        pageIds: [],
        verbatimText: false,
        requestSummary: {
          reportSlug: published.report.slug,
          reportVersion: published.report.version,
          created: published.report.version === 1 && published.changed,
          textSha256: agentReportBodyDigest(request.body.body),
          textLength: agentReportBodyBytes(request.body.body),
        },
      });
      return published;
    }, () => 1);
  });

  server.get("/api/v1/agent/reports", { schema: routeSchemas.agentReportList }, async (request) => {
    const { scope } = await agentScope(request, "agentReportList");
    return settled(scope, () => readAgentReportsForAgent(appContext), (result) => result.reports.length);
  });
}
