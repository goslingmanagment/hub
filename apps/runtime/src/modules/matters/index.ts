import { routeSchemas } from "@agency_hub_core/contracts";

import {
  agentCloseMatter,
  agentCommentMatter,
  agentOpenMatter,
  matterTextDigest,
  readClientMatters,
  readMattersList,
  readMattersWaiting,
  type AgentMatterScope,
} from "../../services/matters.ts";
import { beginAgentRequest, writeAgentAudit } from "../agent-read/index.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

/**
 * Дела (ecosystem plan, package D): a person's matters by session
 * (`/api/v1/matters`, the owner's every one), «Ждут вас» and «Решения» from
 * matters (`/api/v1/matters/waiting`), the extension's count
 * (`/api/v1/client/matters`), and an agent key's writes by reason key
 * (`/api/v1/agent/matters…`, write:matters). The routes' auth blocks decide
 * who calls; the services decide what each reads. Nothing here talks to a
 * platform.
 */
export function registerMatterRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal, requireAgentKeyPrincipal } = ctx.auth;
  const db = appContext.db;

  server.get("/api/v1/matters", { schema: routeSchemas.mattersList }, async (request) => {
    const principal = await requirePrincipal(request);
    return readMattersList(appContext, principal, request.query);
  });

  server.get("/api/v1/matters/waiting", { schema: routeSchemas.mattersWaiting }, async (request) => {
    const principal = await requirePrincipal(request);
    return readMattersWaiting(appContext, principal, request.query);
  });

  server.get("/api/v1/client/matters", { schema: routeSchemas.clientMatters }, async (request) => {
    const principal = await requirePrincipal(request);
    return readClientMatters(appContext, principal);
  });

  // --- Agent keys (write:matters) -------------------------------------------

  async function agentScope(request: Parameters<typeof requireAgentKeyPrincipal>[0], operation: string) {
    const principal = await requireAgentKeyPrincipal(request);
    const scope = await beginAgentRequest(appContext, principal, { operation, requiredCapabilities: ["write:matters"] });
    const matterScope: AgentMatterScope = { principal, pages: scope.pages.map((page) => ({ id: page.id, pageLabel: page.pageLabel })) };
    return { principal, scope, matterScope };
  }

  async function settled<T>(scope: { finish(rows: number): Promise<void> }, body: () => Promise<T>) {
    let delivered = 0;
    try {
      const result = await body();
      delivered = 1;
      return result;
    } finally {
      await scope.finish(delivered);
    }
  }

  server.post("/api/v1/agent/matters", { schema: routeSchemas.agentMatterOpen }, async (request) => {
    const { principal, scope, matterScope } = await agentScope(request, "agentMatterOpen");
    return settled(scope, async () => {
      const opened = await agentOpenMatter(appContext, matterScope, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentMatterOpen",
        pageIds: matterScope.pages.filter((page) => request.body.pageLabels?.includes(page.pageLabel)).map((page) => page.id),
        verbatimText: false,
        requestSummary: { matterId: opened.matter.id, created: opened.transition === "opened", outcome: opened.transition },
      });
      return opened;
    });
  });

  server.post("/api/v1/agent/matters/close", { schema: routeSchemas.agentMatterClose }, async (request) => {
    const { principal, scope, matterScope } = await agentScope(request, "agentMatterClose");
    return settled(scope, async () => {
      const closed = await agentCloseMatter(appContext, matterScope, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentMatterClose",
        pageIds: [],
        verbatimText: false,
        requestSummary: { matterId: closed.matter.id, outcome: closed.transition, reasonCode: request.body.how },
      });
      return closed;
    });
  });

  server.post("/api/v1/agent/matters/comment", { schema: routeSchemas.agentMatterComment }, async (request) => {
    const { principal, scope, matterScope } = await agentScope(request, "agentMatterComment");
    return settled(scope, async () => {
      const commented = await agentCommentMatter(appContext, matterScope, request.body);
      await writeAgentAudit(db, {
        agentKeyId: principal.agentKeyId,
        operation: "agentMatterComment",
        pageIds: [],
        verbatimText: false,
        requestSummary: { matterId: commented.matter.id, textSha256: matterTextDigest(request.body.text), textLength: request.body.text.length },
      });
      return commented;
    });
  });
}
