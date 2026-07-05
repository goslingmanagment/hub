import { routeSchemas } from "@agency_hub_core/contracts";

import { auditCtx, pageScopeFor } from "../../api/request-auth.ts";
import {
  canAccessPage,
  recordAudit,
  requireApiKeyUser,
  requireDashboardUser,
  requireOwner,
} from "../../services/auth.ts";
import { listConnectionStatuses } from "../../services/connections.ts";
import {
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../services/errors.ts";
import { getPublicSyncHealth, getSystemHealth } from "../../services/health.ts";
import {
  getChatterOfapiCreditsSummary,
  getOfapiCreditsDaily,
  getOfapiCreditsLedger,
  getOfapiCreditsLedgerCsv,
  getOfapiCreditsSummary,
} from "../../services/ofapi-credit-report.ts";
import { getOfapiDmColdArchiveStatus } from "../../services/ofapi-dm-archive.ts";
import { getOfapiSpendComparison } from "../../services/ofapi-spend-comparison.ts";
import { getPageSummary } from "../../services/reporting.ts";
import { getStatusDetail, listStatus } from "../../services/sync.ts";
import {
  getPageMessagesSyncBlock,
  getPageSyncBlocks,
  getSyncBlocksOverview,
  pauseSyncBlock,
  resetSyncBlock,
  resumeSyncBlock,
  triggerSyncBlock,
} from "../../services/sync-blocks.ts";
import { requestAllPagesSync, requestPageSync } from "../../services/sync-control.ts";
import {
  getSyncMonitorRecentRequests,
  getSyncMonitorSnapshot,
} from "../../services/sync-monitor.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Ops module (target §6.1): sync health, credits, incidents, config,
// diagnostics. Handlers relocated verbatim from server.ts (Stage 19 Task 3).

export function registerOpsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext, boss } = ctx;
  const { requirePrincipal, requireSyncHealthAccess } = ctx.auth;

  server.get("/api/v1/health", {
    schema: routeSchemas.health,
  }, async (_request, reply) => {
    const health = await getSystemHealth(appContext);
    reply.code(health.statusCode as 200 | 503);
    return health.body;
  });

  server.get("/api/v1/health/sync", {
    schema: routeSchemas.healthSync,
  }, async (request, reply) => {
    const access = await requireSyncHealthAccess(request);
    const health = await getPublicSyncHealth(appContext, {
      pageIds: access.pageIds,
    });
    reply.code(health.statusCode as 200 | 503);
    return health.body;
  });

  server.get("/api/v1/ofapi/credits/summary", {
    schema: routeSchemas.ofapiCreditsChatterSummary,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireApiKeyUser(principal);

    return getChatterOfapiCreditsSummary(appContext, {
      pageIds: principal.assignedPageIds,
    });
  });

  server.get("/api/v1/admin/ofapi/credits/summary", {
    schema: routeSchemas.adminOfapiCreditsSummary,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return getOfapiCreditsSummary(appContext);
  });

  server.get("/api/v1/admin/ofapi/credits/daily", {
    schema: routeSchemas.adminOfapiCreditsDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return getOfapiCreditsDaily(appContext, { days: request.query.days });
  });

  server.get("/api/v1/admin/ofapi/credits/ledger", {
    schema: routeSchemas.adminOfapiCreditsLedger,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return getOfapiCreditsLedger(appContext, request.query);
  });

  server.get("/api/v1/admin/ofapi/credits/ledger.csv", {
    schema: routeSchemas.adminOfapiCreditsLedgerCsv,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    // Build the export before hijacking: an invalid filter still returns a
    // normal 400 through the error handler rather than a half-written body.
    const { filename, csv, rowCount, truncated } = await getOfapiCreditsLedgerCsv(
      appContext,
      request.query,
    );
    if (truncated) {
      request.log.warn(
        { rowCount },
        "OFAPI credit ledger CSV export hit the row cap; narrow the filters for a complete extract",
      );
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-export-row-count": String(rowCount),
      "x-export-truncated": truncated ? "1" : "0",
    });
    raw.end(csv);
  });

  server.get("/api/v1/admin/ofapi/spend/comparison", {
    schema: routeSchemas.adminOfapiSpendComparison,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return getOfapiSpendComparison(appContext, request.query);
  });

  server.get("/api/v1/admin/ofapi/dm-archive/status", {
    schema: routeSchemas.adminOfapiDmColdArchiveStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    return getOfapiDmColdArchiveStatus(appContext);
  });

  server.get("/api/v1/sync/status", {
    schema: routeSchemas.syncStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const query = request.query;

    if (query.pageLabel) {
      const page = await getPageSummary(appContext, query.pageLabel);
      if (!canAccessPage(principal, page.id)) {
        throw new ForbiddenError("Page access denied");
      }
    }

    return await getSyncMonitorSnapshot(appContext, {
      pageIds: pageScopeFor(principal),
      pageLabel: query.pageLabel,
      windowHours: query.windowHours,
      eventLimit: query.eventLimit,
    }) as never;
  });

  server.get("/api/v1/sync/requests", {
    schema: routeSchemas.syncRequests,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);

    return await getSyncMonitorRecentRequests(appContext, {
      pageIds: pageScopeFor(principal),
      since: request.query.since,
      limit: request.query.limit,
    }) as never;
  });

  server.get("/api/v1/sync/overview", {
    schema: routeSchemas.syncOverview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);

    return getSyncBlocksOverview(appContext, {
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v1/pages/:pageLabel/sync/blocks", {
    schema: routeSchemas.pageSyncBlocks,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }

    return getPageSyncBlocks(appContext, {
      pageLabel: request.params.pageLabel,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v1/pages/:pageLabel/sync/blocks/messages", {
    schema: routeSchemas.pageMessagesBlock,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }

    return getPageMessagesSyncBlock(appContext, {
      pageLabel: request.params.pageLabel,
      pageIds: pageScopeFor(principal),
    });
  });

  // Sync management
  server.get("/api/v1/admin/sync/runs", {
    schema: routeSchemas.adminSyncRuns,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const query = request.query;
    const runs = await listStatus(appContext, {
      pageLabel: query.pageLabel,
      limit: query.limit,
      since: query.since ? new Date(query.since) : undefined,
    });
    return runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  });

  server.get("/api/v1/admin/sync/runs/:runId", {
    schema: routeSchemas.adminSyncRunDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const detail = await getStatusDetail(appContext, request.params.runId);
      return {
        run: {
          ...detail.run,
          startedAt: detail.run.startedAt.toISOString(),
          finishedAt: detail.run.finishedAt?.toISOString() ?? null,
        },
        events: detail.events.map((e) => ({
          ...e,
          emittedAt: e.emittedAt.toISOString(),
        })),
        attempts: detail.attempts.map((a) => ({
          ...a,
          startedAt: a.startedAt.toISOString(),
          finishedAt: a.finishedAt?.toISOString() ?? null,
        })),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("was not found")) {
        throw new NotFoundError(`Sync run ${request.params.runId} not found`);
      }
      throw error;
    }
  });

  server.post("/api/v1/admin/sync/trigger", {
    schema: routeSchemas.adminSyncTrigger,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const { pageLabel, scope } = request.body;
    await getPageSummary(appContext, pageLabel);
    if (!boss) throw new Error("Job queue not available");
    await requestPageSync(appContext, boss, {
      pageLabel,
      scope,
      reason: "manual",
    });
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_trigger",
      metadata: { pageLabel, scope },
    });
    reply.code(202);
    return { accepted: true as const, pageLabel, scope };
  });

  server.post("/api/v1/admin/sync/trigger-all", {
    schema: routeSchemas.adminSyncTriggerAll,
  }, async (request, reply) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    if (!boss) throw new Error("Job queue not available");
    const results = await requestAllPagesSync(appContext, boss, {
      scope: "all",
      reason: "manual",
    });
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_trigger_all",
      metadata: { scope: "all", pagesQueued: results.length },
    });
    reply.code(202);
    return { accepted: true as const, pagesQueued: results.length };
  });

  server.post("/api/v1/admin/sync/blocks/trigger", {
    schema: routeSchemas.adminSyncBlockTrigger,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    if (!boss) {
      throw new ServiceUnavailableError("Job queue not available");
    }
    const result = await triggerSyncBlock(appContext, boss, request.body);
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_block_trigger",
      metadata: { ...request.body },
    });
    return result;
  });

  server.post("/api/v1/admin/sync/blocks/pause", {
    schema: routeSchemas.adminSyncBlockPause,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await pauseSyncBlock(appContext, request.body);
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_block_pause",
      metadata: { ...request.body },
    });
    return result;
  });

  server.post("/api/v1/admin/sync/blocks/resume", {
    schema: routeSchemas.adminSyncBlockResume,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    if (!boss) {
      throw new ServiceUnavailableError("Job queue not available");
    }
    const result = await resumeSyncBlock(appContext, boss, request.body);
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_block_resume",
      metadata: { ...request.body },
    });
    return result;
  });

  server.post("/api/v1/admin/sync/blocks/reset", {
    schema: routeSchemas.adminSyncBlockReset,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    if (!boss) {
      throw new ServiceUnavailableError("Job queue not available");
    }
    const result = await resetSyncBlock(appContext, boss, request.body);
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_block_reset",
      metadata: { ...request.body },
    });
    return result;
  });

  // Connection management
  server.get("/api/v1/admin/connections", {
    schema: routeSchemas.adminConnections,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listConnectionStatuses(appContext, {
      pageIds: pageScopeFor(principal),
    });
  });
}
