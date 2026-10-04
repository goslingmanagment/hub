import { registerOfapiMediaRoutes } from "./ofapi-media.ts";
import { registerOfapiReadCollectionsRoutes } from "./ofapi-read-collections.ts";
import { registerOfapiExportRoutes } from "./ofapi-exports.ts";
import { registerOfapiCollectionRoutes } from "./ofapi-collection.ts";
import { randomUUID } from "node:crypto";

import { routeSchemas } from "@agency_hub_core/contracts";
import {
  ConfigOverrideTransitionError,
  ConfigOverrideVersionConflictError,
  getLatestRealDeliveryAttempt,
  getTelegramSettings,
  insertDeliveryAttempt,
  listDeliveryAttempts,
  listNotificationIncidentsWithPages,
  listSyncPages,
  recoverAndResolveNotificationIncident,
  updateTelegramSettings,
} from "@agency_hub_core/db";
import {
  collectCostWarnings,
  encryptJson,
  validateStagedOverride,
  type Platform,
} from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";

import { auditCtx, pageScopeFor } from "../../api/request-auth.ts";
import { buildConfigView } from "../../services/app-config-service.ts";
import { applyLiveConfigPatches, clearLiveConfigOverride } from "../../services/live-config.ts";
import { commitStagedConfigChange } from "../../services/staged-config.ts";
import {
  closeTelegramRequestOptions,
  deriveTelegramConnectionState,
  discoverTelegramChats,
  resolveTelegramBotToken,
  resolveTelegramCredentialSources,
  resolveTelegramCredentials,
  resolveTelegramRequestOptions,
  sendTelegramMessage,
  sendTelegramTestMessage,
  TelegramDiscoveryError,
  TelegramProxyConfigError,
} from "../../services/telegram.ts";
import {
  buildDailyRevenueTelegramReport,
  sendManualDailyRevenueTelegramReport,
} from "../../services/telegram-report.ts";
import {
  canAccessPage,
  recordAudit,
  requireApiKeyUser,
  requireDashboardUser,
  requireOwner,
} from "../../services/auth.ts";
import { listConnectionStatuses } from "../../services/connections.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../services/errors.ts";
import { getPublicSyncHealth, getSystemHealth } from "../../services/health.ts";
import {
  applyFollowersReconcileBlastRadiusOverride,
  previewFollowersReconcileBlastRadiusOverride,
} from "../../services/followers-reconcile-override.ts";
import {
  getChatterOfapiCreditsSummary,
  getOfapiCreditsDaily,
  getOfapiCreditsLedger,
  getOfapiCreditsLedgerCsv,
  getOfapiCreditsSummary,
} from "../../services/ofapi-credit-report.ts";
import { getOfapiDmColdArchiveStatus } from "../../services/ofapi-dm-archive.ts";
import { seedOwnerOfapiCaptureJobs } from "../../services/ofapi-capture-seed.ts";
import {
  getOwnerOfapiCaptureOperatorStatus,
  reconcileOwnerOfapiExportCreate,
  cancelOwnerOfapiCaptureJob,
  replayOwnerOfapiCaptureJob,
  resolveOwnerOfapiCaptureAttempt,
  revokeOwnerOfapiMessageCoverage,
  setOwnerOfapiCaptureControl,
} from "../../services/ofapi-capture-operator.ts";
import {
  captureOwnerOfapiExportArtifact,
} from "../../services/ofapi-export-artifact.ts";
import {
  approveOwnerOfapiExportPilot,
  cancelOwnerOfapiExportQuote,
  createOwnerOfapiExportQuote,
  getOwnerOfapiExportQuoteStatus,
} from "../../services/ofapi-export-quotes.ts";
import { getOfapiSpendComparison } from "../../services/ofapi-spend-comparison.ts";
import { getPageSummary } from "../../services/reporting.ts";
import { getStatusDetail, listStatus } from "../../services/sync.ts";
import {
  getPageMessagesSyncBlock,
  getPageSyncBlocks,
  getSyncBlocksOverview,
  pauseSyncBlock,
  resetFollowersReconcileStream,
  resetSyncBlock,
  resumeSyncBlock,
  triggerSyncBlock,
} from "../../services/sync-blocks.ts";
import { requestAllPagesSync, requestPageSync } from "../../services/sync-control.ts";
import {
  engineOwnedSyncPageByLabel,
  triggerEngineScope,
  type EngineLeverOutcome,
} from "../../services/sync-engine-levers.ts";
import {
  getSyncMonitorRecentRequests,
  getSyncMonitorSnapshot,
} from "../../services/sync-monitor.ts";
import { getGoldenSignalsReport } from "../../services/golden-signals.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Ops module (target §6.1): sync health, credits, incidents, config,
// diagnostics. Handlers relocated verbatim from server.ts (Stage 19 Task 3).

function serializeTimestamp(value: Date | string) {
  return new Date(value).toISOString();
}

function serializeNullableTimestamp(value: Date | string | null | undefined) {
  return value == null ? null : serializeTimestamp(value);
}

function toNumber(value: number | string | bigint) {
  return typeof value === "number" ? value : Number(value);
}

// Raw-SQL row shapes (what the pg driver hands back for these queries).
type SyncRunEventRow = {
  id: number | string;
  syncRunId: number | string;
  provider: Platform;
  stream: string;
  eventType: string;
  severity: string;
  message: string;
  details: Record<string, unknown>;
  emittedAt: Date | string;
  pageLabel: string;
};

type QueueJobRow = {
  id: string;
  name: string;
  state: string;
  data: unknown;
  createdOn: Date | string;
  startedOn: Date | string | null;
  completedOn: Date | string | null;
  output: unknown;
  retryLimit: number | string;
  retryCount: number | string;
};

type DbTableStatRow = {
  schema: string;
  table: string;
  rowEstimate: number | string;
  totalBytes: number | string | bigint;
  indexBytes: number | string | bigint;
};

type DbMigrationRow = {
  name: string;
  appliedAt: Date | string;
};

type IncidentSummaryRow = {
  code: string | null;
  severity: string;
  count: number | string;
};

export function registerOpsRoutes(server: ApiServer, ctx: ApiModuleContext) {
  registerOfapiReadCollectionsRoutes(server, ctx);
  registerOfapiExportRoutes(server, ctx);
  registerOfapiMediaRoutes(server, ctx);
  registerOfapiCollectionRoutes(server, ctx);
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

  // Stage 25: the golden-signal acceptance instrument (monitoring-token or
  // dashboard session — same gate as detailed sync health).
  server.get("/api/v1/ops/metrics", {
    schema: routeSchemas.opsMetrics,
  }, async (request) => {
    await requireSyncHealthAccess(request);
    return getGoldenSignalsReport(appContext);
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

  server.post("/api/v1/admin/ofapi/capture-jobs/seed", {
    schema: routeSchemas.adminOfapiCaptureJobsSeed,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await seedOwnerOfapiCaptureJobs(appContext, {
      actorUserId: principal.user.id,
      dryRun: request.body.dryRun,
      goal: request.body.goal,
      targets: request.body.targets,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_capture_jobs_seed",
        metadata: {
          seedId: result.seedId,
          pageIds: [...new Set(result.results.map((item) => item.pageId))],
          requested: result.results.length,
          created: result.created,
          coalesced: result.coalesced,
          skipped: result.skipped,
        },
      });
    }
    return result;
  });

  server.get("/api/v1/admin/ofapi/capture/operator", {
    schema: routeSchemas.adminOfapiCaptureOperatorStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return getOwnerOfapiCaptureOperatorStatus(appContext);
  });

  server.post("/api/v1/admin/ofapi/capture/controls", {
    schema: routeSchemas.adminOfapiCaptureControl,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await setOwnerOfapiCaptureControl(appContext, {
      ...request.body,
      actorUserId: principal.user.id,
    });
    if (result.executed) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_capture_control_changed",
        metadata: {
          controlKey: result.controlKey,
          paused: result.next.paused,
          version: result.next.version,
          reason: result.next.reason,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/capture/attempts/:attemptId/resolve", {
    schema: routeSchemas.adminOfapiCaptureAttemptResolve,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await resolveOwnerOfapiCaptureAttempt(appContext, {
      ...request.body,
      attemptId: request.params.attemptId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_capture_attempt_resolved",
        platformAccountId: result.attempt.pageId,
        metadata: {
          attemptId: result.attempt.attemptId,
          captureJobId: result.attempt.captureJobId,
          resolution: result.attempt.certaintyResolution,
          settledCredits: result.attempt.settledCredits,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/capture/jobs/:jobId/replay", {
    schema: routeSchemas.adminOfapiCaptureJobReplay,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await replayOwnerOfapiCaptureJob(appContext, {
      ...request.body,
      jobId: request.params.jobId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_capture_job_replayed",
        metadata: {
          jobId: result.jobId,
          attemptId: result.attemptId,
          observationId: result.next.observationId,
          previousReasonCode: result.previous.reasonCode,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/capture/jobs/:jobId/cancel", {
    schema: routeSchemas.adminOfapiCaptureJobCancel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await cancelOwnerOfapiCaptureJob(appContext, {
      ...request.body,
      jobId: request.params.jobId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_capture_job_cancelled",
        platformAccountId: result.pageId,
        metadata: {
          jobId: result.jobId,
          previousState: result.previous.state,
          previousReasonCode: result.previous.reasonCode,
          reason: request.body.reason,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/capture/coverage/:pageId/:chatId/revoke", {
    schema: routeSchemas.adminOfapiCoverageRevoke,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await revokeOwnerOfapiMessageCoverage(appContext, {
      ...request.body,
      pageId: request.params.pageId,
      chatId: request.params.chatId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun && result.status === "revoked") {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_coverage_revoked",
        platformAccountId: result.pageId,
        metadata: {
          pageId: result.pageId,
          chatId: result.chatId,
          sourceAccountSeq: result.sourceAccountSeq,
          revokedAt: result.revokedAt,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/export-quotes/:jobId/reconcile-create", {
    schema: routeSchemas.adminOfapiExportCreateReconcile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await reconcileOwnerOfapiExportCreate(appContext, {
      ...request.body,
      jobId: request.params.jobId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_export_create_reconciled",
        platformAccountId: result.attempt.pageId,
        metadata: {
          jobId: result.job.jobId,
          attemptId: result.attempt.attemptId,
          action: result.action,
          state: result.job.state,
          reasonCode: result.job.reasonCode,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/export-quotes", {
    schema: routeSchemas.adminOfapiExportQuotesCreate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await createOwnerOfapiExportQuote(appContext, {
      ...request.body,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_export_quote_created",
        metadata: {
          jobId: result.jobId,
          pageId: result.pageId,
          profile: result.profile,
          targetHash: result.targetHash,
          status: result.status,
        },
      });
    }
    return result;
  });

  server.get("/api/v1/admin/ofapi/export-quotes/:jobId", {
    schema: routeSchemas.adminOfapiExportQuoteStatus,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return getOwnerOfapiExportQuoteStatus(appContext, request.params.jobId);
  });

  server.post("/api/v1/admin/ofapi/export-quotes/:jobId/approve-pilot", {
    schema: routeSchemas.adminOfapiExportPilotApprove,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await approveOwnerOfapiExportPilot(appContext, {
      ...request.body,
      jobId: request.params.jobId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_export_pilot_approved",
        metadata: {
          jobId: result.jobId,
          approvedMaxCredits: result.approvedMaxCredits,
          requiredMaxCredits: result.requiredMaxCredits,
          expectedRowVersion: result.expectedRowVersion,
          nextRowVersion: result.nextRowVersion,
          reason: request.body.reason,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/export-quotes/:jobId/capture-artifact", {
    schema: routeSchemas.adminOfapiExportArtifactCapture,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await captureOwnerOfapiExportArtifact(appContext, {
      ...request.body,
      jobId: request.params.jobId,
      actorUserId: principal.user.id,
    });
    if (!result.dryRun) {
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.ofapi_export_artifact_captured",
        platformAccountId: result.pageId,
        metadata: {
          jobId: result.jobId,
          importJobId: result.importJobId,
          artifact: result.artifact,
          classification: result.classification,
          reason: request.body.reason,
        },
      });
    }
    return result;
  });

  server.post("/api/v1/admin/ofapi/export-quotes/:jobId/cancel", {
    schema: routeSchemas.adminOfapiExportQuoteCancel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await cancelOwnerOfapiExportQuote(appContext, {
      jobId: request.params.jobId,
      actorUserId: principal.user.id,
      reason: request.body.reason,
    });
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.ofapi_export_quote_cancelled",
      metadata: {
        jobId: result.jobId,
        pageId: result.pageId,
        profile: result.profile,
        expectedState: request.body.expectedState,
        reason: request.body.reason,
      },
    });
    return result;
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
    await getPageSummary(appContext, pageLabel); // 404 for an unknown page
    // A page the Fansly Sync Engine owns: the scope's streams become the
    // engine's polls due now (live); a page being switched refuses (409).
    // Any other Fansly page is refused by `requestPageSync` (409
    // `legacy_sync_retired`): the legacy executor serves no Fansly page.
    const engine = await engineOwnedSyncPageByLabel(appContext.db, pageLabel);
    if (engine !== null) {
      const outcome = await triggerEngineScope(appContext.db, engine, scope);
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.sync_trigger",
        metadata: { pageLabel, scope, engine: outcome },
      });
      reply.code(202);
      return { accepted: true as const, pageLabel, scope };
    }
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
    // Pages the Fansly Sync Engine runs (live) are refreshed by the engine; a
    // row in `handover` is left alone (neither engine reads it); the legacy
    // executor queues the pages of the platforms it serves.
    const enginePages = await listSyncPages(appContext.db, { modes: ["live"] });
    const engine: Array<{ pageLabel: string } & EngineLeverOutcome> = [];
    for (const page of enginePages) {
      const outcome = await triggerEngineScope(appContext.db, page as typeof page & { mode: "live" }, "all");
      engine.push({ pageLabel: page.pageLabel ?? String(page.pageId), ...outcome });
    }
    const results = await requestAllPagesSync(appContext, boss, { scope: "all", reason: "manual" });
    const pagesQueued = results.length + engine.length;
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.sync_trigger_all",
      metadata: { scope: "all", pagesQueued, ...(engine.length === 0 ? {} : { engine }) },
    });
    reply.code(202);
    return { accepted: true as const, pagesQueued };
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

  server.post("/api/v1/admin/sync/followers-reconcile/reset", {
    schema: routeSchemas.adminFollowersReconcileReset,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const result = await resetFollowersReconcileStream(appContext, request.body);
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.followers_reconcile_reset",
      metadata: { ...request.body, stream: "followers_reconcile" },
    });
    return result;
  });

  server.post("/api/v1/admin/sync/followers-reconcile/blast-radius/preview", {
    schema: routeSchemas.adminFollowersReconcileOverridePreview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return previewFollowersReconcileBlastRadiusOverride(appContext, request.body);
  });

  server.post("/api/v1/admin/sync/followers-reconcile/blast-radius/apply", {
    schema: routeSchemas.adminFollowersReconcileOverrideApply,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return applyFollowersReconcileBlastRadiusOverride(
      appContext,
      request.body,
      auditCtx(principal),
    );
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

  // ---------------------------------------------------------------------------
  // Admin: logs, queue, db stats, incidents
  // ---------------------------------------------------------------------------

  server.get("/api/v1/admin/logs", {
    schema: routeSchemas.adminLogs,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const { severity, limit } = request.query;
    const normalizedSeverity = sql<string>`CASE
      WHEN e.details->>'code' = 'after_ineffective'
        AND e.severity = 'error'
        AND e.details->>'earlyStoppedBeyondBoundary' = 'true'
      THEN 'warn'
      ELSE e.severity
    END`;

    const rows = severity
      ? (await appContext.db.execute(sql`
          SELECT e.id, e.sync_run_id as "syncRunId",
                 e.provider, e.stream, e.event_type as "eventType",
                 ${normalizedSeverity} as "severity", e.message, e.details,
                 e.emitted_at as "emittedAt",
                 pa.label as "pageLabel"
          FROM sync_run_events e
          INNER JOIN sync_runs sr ON sr.id = e.sync_run_id
          INNER JOIN pages pa ON pa.id = e.page_id
          WHERE ${normalizedSeverity} = ${severity}
          ORDER BY e.emitted_at DESC
          LIMIT ${limit}
        `)).rows
      : (await appContext.db.execute(sql`
          SELECT e.id, e.sync_run_id as "syncRunId",
                 e.provider, e.stream, e.event_type as "eventType",
                 ${normalizedSeverity} as "severity", e.message, e.details,
                 e.emitted_at as "emittedAt",
                 pa.label as "pageLabel"
          FROM sync_run_events e
          INNER JOIN sync_runs sr ON sr.id = e.sync_run_id
          INNER JOIN pages pa ON pa.id = e.page_id
          ORDER BY e.emitted_at DESC
          LIMIT ${limit}
        `)).rows;

    return (rows as SyncRunEventRow[]).map((r) => ({
      id: toNumber(r.id),
      syncRunId: toNumber(r.syncRunId),
      provider: r.provider,
      stream: r.stream,
      eventType: r.eventType,
      severity: r.severity,
      message: r.message,
      details: r.details,
      emittedAt: serializeTimestamp(r.emittedAt),
      pageLabel: r.pageLabel,
    }));
  });

  server.get("/api/v1/admin/queue/jobs", {
    schema: routeSchemas.adminQueueJobs,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const { state, name, limit } = request.query;

    let condition = sql`true`;
    if (state) condition = sql`${condition} AND state = ${state}`;
    if (name) condition = sql`${condition} AND name = ${name}`;

    const rows = (await appContext.db.execute(sql`
      SELECT id, name, state, data, created_on as "createdOn",
             started_on as "startedOn", completed_on as "completedOn",
             output, retry_limit as "retryLimit", retry_count as "retryCount"
      FROM pgboss.job
      WHERE ${condition}
      ORDER BY created_on DESC
      LIMIT ${limit}
    `)).rows;

    return (rows as QueueJobRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      data: r.data,
      createdOn: serializeTimestamp(r.createdOn),
      startedOn: serializeNullableTimestamp(r.startedOn),
      completedOn: serializeNullableTimestamp(r.completedOn),
      output: r.output,
      retryLimit: toNumber(r.retryLimit),
      retryCount: toNumber(r.retryCount),
    }));
  });

  server.get("/api/v1/admin/db/stats", {
    schema: routeSchemas.adminDbStats,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const tableRows = (await appContext.db.execute(sql`
      SELECT schemaname as "schema", relname as "table",
             n_live_tup::int as "rowEstimate",
             pg_total_relation_size(schemaname || '.' || relname)::bigint as "totalBytes",
             pg_indexes_size(schemaname || '.' || relname)::bigint as "indexBytes"
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC
    `)).rows;

    const tables = (tableRows as DbTableStatRow[]).map((r) => ({
      schema: r.schema,
      table: r.table,
      rowEstimate: toNumber(r.rowEstimate),
      totalBytes: toNumber(r.totalBytes),
      indexBytes: toNumber(r.indexBytes),
    }));

    let migrations: Array<{ name: string; appliedAt: string }> = [];
    try {
      const migrationRows = (await appContext.db.execute(sql`
        SELECT id as "name", applied_at as "appliedAt"
        FROM schema_migrations
        ORDER BY applied_at ASC, id ASC
      `)).rows;
      migrations = (migrationRows as DbMigrationRow[]).map((r) => ({
        name: r.name,
        appliedAt: serializeTimestamp(r.appliedAt),
      }));
    } catch {
      // migrations table may not exist
    }

    return { tables, migrations };
  });

  server.get("/api/v1/admin/incidents", {
    schema: routeSchemas.adminIncidents,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const { severity, code, limit } = request.query;
    const normalizedSeverity = sql<string>`CASE
      WHEN e.details->>'code' = 'after_ineffective'
        AND e.severity = 'error'
        AND e.details->>'earlyStoppedBeyondBoundary' = 'true'
      THEN 'warn'
      ELSE e.severity
    END`;

    let condition = sql`(e.severity IN ('warn', 'error') OR e.event_type = 'anomaly')`;
    if (severity) condition = sql`${condition} AND ${normalizedSeverity} = ${severity}`;
    if (code) condition = sql`${condition} AND e.details->>'code' = ${code}`;

    const items = ((await appContext.db.execute(sql`
      SELECT e.id, e.sync_run_id as "syncRunId",
             e.provider, e.stream, e.event_type as "eventType",
             ${normalizedSeverity} as "severity", e.message, e.details,
             e.emitted_at as "emittedAt",
             pa.label as "pageLabel"
      FROM sync_run_events e
      INNER JOIN sync_runs sr ON sr.id = e.sync_run_id
      INNER JOIN pages pa ON pa.id = e.page_id
      WHERE ${condition}
      ORDER BY e.emitted_at DESC
      LIMIT ${limit}
    `)).rows as SyncRunEventRow[]).map((r) => ({
      id: toNumber(r.id),
      syncRunId: toNumber(r.syncRunId),
      provider: r.provider,
      stream: r.stream,
      eventType: r.eventType,
      severity: r.severity,
      message: r.message,
      details: r.details,
      emittedAt: serializeTimestamp(r.emittedAt),
      pageLabel: r.pageLabel,
    }));

    const summary = ((await appContext.db.execute(sql`
      SELECT e.details->>'code' as "code", ${normalizedSeverity} as "severity", count(*)::int as "count"
      FROM sync_run_events e
      WHERE (e.severity IN ('warn', 'error') OR e.event_type = 'anomaly')
        AND e.emitted_at > now() - interval '7 days'
      GROUP BY e.details->>'code', ${normalizedSeverity}
      ORDER BY count DESC
      LIMIT 20
    `)).rows as IncidentSummaryRow[]).map((r) => ({
      code: r.code,
      severity: r.severity,
      count: toNumber(r.count),
    }));

    return { summary, items };
  });

  // ---------------------------------------------------------------------------
  // Notifications dashboard
  // ---------------------------------------------------------------------------

  function buildNotificationsSettingsResponse(
    settings: Awaited<ReturnType<typeof getTelegramSettings>>,
    lastRealAttempt: Awaited<ReturnType<typeof getLatestRealDeliveryAttempt>>,
  ) {
    const creds = resolveTelegramCredentials(appContext, settings);
    const configured = creds !== null;
    const { botTokenSource, chatIdSource } = resolveTelegramCredentialSources(appContext, settings);

    // Only a real delivery (sent/failed) made AFTER the current credentials were
    // saved counts toward the status — a stale success from a previous bot/chat,
    // or a `skipped` attempt, must not read as "connected". `recentAttempt` is
    // null when the latest real attempt predates the current credentials.
    const { status: connectionStatus, recentAttempt } = deriveTelegramConnectionState(
      configured,
      settings.credentialsUpdatedAt,
      lastRealAttempt,
    );

    return {
      configured,
      botTokenSet: !!settings.encryptedBotToken || !!appContext.config.telegramBotToken,
      chatId: settings.chatId ?? appContext.config.telegramChatId ?? null,
      botTokenSource,
      chatIdSource,
      enabled: settings.enabled,
      dailyReportEnabled: settings.dailyReportEnabled,
      syncFailureAlertsEnabled: settings.syncFailureAlertsEnabled,
      aiCriticalAlertsEnabled: settings.aiCriticalAlertsEnabled,
      reportHourUtc: settings.reportHourUtc,
      connectionStatus,
      lastMessageAt: recentAttempt?.createdAt?.toISOString() ?? null,
      lastMessageError: recentAttempt?.status === "failed" ? (recentAttempt.error ?? null) : null,
    };
  }

  server.get("/api/v1/admin/notifications/settings", {
    schema: routeSchemas.notificationsSettings,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const settings = await getTelegramSettings(appContext.db, {
      defaultReportHourUtc: appContext.config.telegramReportHourUtc,
    });
    const lastRealAttempt = await getLatestRealDeliveryAttempt(appContext.db);
    return buildNotificationsSettingsResponse(settings, lastRealAttempt);
  });

  server.get("/api/v1/admin/config", {
    schema: routeSchemas.adminConfig,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    // Thread the PRE-boot-apply env config so desiredEffective uses the env baseline for
    // keys with no override (falls back to the boot-applied config for legacy contexts).
    const envBaseline = (appContext.rawConfig ?? appContext.config) as unknown as Record<string, unknown>;
    return buildConfigView(appContext.db, envBaseline);
  });

  // PATCH (the live editing path) and DELETE share their whole write path with the
  // audited CLI (`config set|clear`): services/live-config.ts validates (live allowlist,
  // validateConfigOverride, transition hooks), writes config_settings + config_audit_log
  // atomically, records the audit event and wakes newly opened gated streams. The
  // route adds only the owner check and the HTTP error mapping.
  server.patch("/api/v1/admin/config", {
    schema: routeSchemas.adminConfigUpdate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const { patches, note } = request.body;
    try {
      const results = await applyLiveConfigPatches(appContext, {
        patches,
        note,
        actor: { userId: principal.user.id, audit: auditCtx(principal) },
      });
      return { results };
    } catch (error) {
      if (error instanceof ConfigOverrideVersionConflictError) {
        throw new ConflictError(error.message);
      }
      if (error instanceof ConfigOverrideTransitionError) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  });

  server.delete("/api/v1/admin/config/:key", {
    schema: routeSchemas.adminConfigClear,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const { key } = request.params;
    try {
      await clearLiveConfigOverride(appContext, {
        key,
        expectedVersion: request.query.expectedVersion,
        note: request.query.note,
        actor: { userId: principal.user.id, audit: auditCtx(principal) },
      });
    } catch (error) {
      if (error instanceof ConfigOverrideVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
    return { ok: true as const, key };
  });

  // Staged-rollout flips (Stage C): write explicit boolean overrides for the boot-applied
  // flag set in the prescribed enable order. These take effect only after a restart
  // (applyBootOverrides at process start). The ordered enable/disable rules are checked
  // against the APPLIED (running) state, so a prerequisite must be restarted/applied
  // before the next step unlocks. expectedVersion is mandatory and the operator's `ack`
  // is recorded in the audit note so the acknowledgement is auditable, not just UI.
  server.patch("/api/v1/admin/config/staged", {
    schema: routeSchemas.adminConfigStaged,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const { patches, note, ack } = request.body;
    if (ack !== true) {
      throw new BadRequestError("acknowledgement required: staged flips take effect only after a restart");
    }
    // A key may appear at most once per patch — duplicates would double-audit / double-
    // bump (or self-conflict) in the atomic apply, and confuse the order graph.
    const keys = patches.map((patch) => patch.key);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestError("A patch may not set the same key twice");
    }

    // The desired-graph baseline is the CURRENT DB desired state, NOT the boot-applied
    // config (which is stale relative to later staged writes that have not been deployed).
    // A `desired: null` patch reverts the key to env (clears the override). It is VALIDATED
    // as if setting the key to its current env baseline boolean (so reverting an env-off key
    // runs the disable-dependent rule), but APPLIED as a clear (the row is deleted).
    const rawConfig = (appContext.rawConfig ?? appContext.config) as unknown as Record<string, unknown>;
    const resolvedDesired = (patch: { key: string; desired: boolean | null }): boolean =>
      patch.desired === null ? rawConfig[patch.key] === true : patch.desired;

    // Per-key value/wiring gate: every key must be a boot (staged) descriptor. A boolean
    // patch is validated as-is; a null (clear) patch is validated as its env baseline
    // boolean. Reject the whole patch on the first bad entry before any read/write (400).
    for (const patch of patches) {
      const validated = validateStagedOverride(patch.key, resolvedDesired(patch));
      if (!validated.ok) {
        throw new BadRequestError(validated.error);
      }
    }

    // Structured audit note: the ack + operator note travel with every audit row so the
    // acknowledgement is durable evidence, not merely a UI affordance.
    const auditNote = JSON.stringify({
      ack: true,
      note: note ?? null,
      // Registry-derived cost warnings for the flipped keys, so the warning that applied is
      // durable evidence alongside the ack (never trusting the client to send it).
      costWarnings: collectCostWarnings(patches.map((patch) => patch.key)),
    });

    try {
      // BLOCKER 1: the read-validate-write is delegated to one advisory-locked transaction
      // (commitStagedConfigChange). It re-reads the baseline + running snapshot INSIDE the
      // lock, runs the order gate (validateStagedTransition) against that serialized
      // snapshot, then applies the patches — so two concurrent staged commits on different
      // keys can never both pass validation and persist an invalid graph. A transition
      // failure throws BadRequestError (400); a version conflict surfaces as 409 below.
      const results = await commitStagedConfigChange(appContext.db, {
        patches: patches.map((patch) => ({
          key: patch.key,
          desired: patch.desired,
          expectedVersion: patch.expectedVersion,
        })),
        resolvedDesired,
        rawConfig,
        userId: principal.user.id,
        note: auditNote,
        groupId: randomUUID(),
      });
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.config_staged_update",
        metadata: {
          keys: patches.map((patch) => ({ key: patch.key, desired: patch.desired })),
          note: auditNote,
        },
      });
      // The atomic writer returns ConfigOverrideValue (boolean for an upsert; null for a
      // cleared key, which reverts to env).
      return { results: results.map((result) => ({ ...result, value: result.value as boolean | null })) };
    } catch (error) {
      if (error instanceof ConfigOverrideVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  server.patch("/api/v1/admin/notifications/settings", {
    schema: routeSchemas.notificationsSettingsUpdate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    await getTelegramSettings(appContext.db, {
      defaultReportHourUtc: appContext.config.telegramReportHourUtc,
    }); // ensure singleton row exists

    const { botToken, chatId, ...rest } = request.body;
    const patch: Parameters<typeof updateTelegramSettings>[1] = { ...rest };

    if (botToken !== undefined) {
      patch.encryptedBotToken = botToken === null
        ? null
        : JSON.stringify(
            encryptJson(botToken, appContext.config.encryptionKey, appContext.config.encryptionKeyVersion),
          );
    }
    if (chatId !== undefined) {
      patch.chatId = chatId;
    }

    const updated = await updateTelegramSettings(appContext.db, patch);
    const lastRealAttempt = await getLatestRealDeliveryAttempt(appContext.db);
    return buildNotificationsSettingsResponse(updated, lastRealAttempt);
  });

  server.post("/api/v1/admin/notifications/test", {
    schema: routeSchemas.notificationsTestMessage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const result = await sendTelegramTestMessage(appContext);

    await insertDeliveryAttempt(appContext.db, {
      kind: "test",
      status: result.status,
      messageId: result.status === "sent" ? result.messageId : null,
      error: result.status === "failed"
        ? result.error
        : result.status === "skipped"
          ? result.reason
          : null,
    });

    return {
      status: result.status,
      error: result.status === "failed" ? result.error : null,
    };
  });

  server.post("/api/v1/admin/notifications/discover-chats", {
    schema: routeSchemas.notificationsDiscoverChats,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    // Prefer the just-typed token (not yet saved); otherwise use the stored/env one.
    let botToken = request.body.botToken ?? null;
    if (!botToken) {
      const settings = await getTelegramSettings(appContext.db, {
        defaultReportHourUtc: appContext.config.telegramReportHourUtc,
      });
      botToken = resolveTelegramBotToken(appContext, settings);
    }
    if (!botToken) {
      throw new BadRequestError("Enter a bot token first");
    }

    try {
      const requestOptions = await resolveTelegramRequestOptions(appContext);
      try {
        return await discoverTelegramChats(botToken, requestOptions);
      } finally {
        await closeTelegramRequestOptions(requestOptions);
      }
    } catch (error) {
      if (error instanceof TelegramDiscoveryError || error instanceof TelegramProxyConfigError) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  });

  server.get("/api/v1/admin/notifications/incidents", {
    schema: routeSchemas.notificationsIncidents,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const query = request.query;
    const result = await listNotificationIncidentsWithPages(appContext.db, {
      status: query.status,
      kind: query.kind,
      pageLabel: query.pageLabel,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      items: result.items.map((item) => ({
        ...item,
        openedAt: item.openedAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
        resolvedAt: item.resolvedAt?.toISOString() ?? null,
      })),
      total: result.total,
    };
  });

  server.post("/api/v1/admin/notifications/incidents/:incidentId/resolve", {
    schema: routeSchemas.notificationsResolveIncident,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const { incidentId } = request.params;
    const rows = (await appContext.db.execute(
      sql`SELECT incident_key FROM notification_incidents WHERE id = ${incidentId}`,
    )).rows;

    if (!rows[0]) {
      throw new NotFoundError(`Incident ${incidentId} not found`);
    }

    const incidentKey = (rows[0] as { incident_key: string }).incident_key;
    const resolvedAt = new Date();
    const resolved = await recoverAndResolveNotificationIncident(appContext.db, {
      incidentKey,
      recoveredAt: resolvedAt,
      processedAt: resolvedAt,
    });

    if (resolved) {
      // Best-effort send "Manually resolved" to Telegram
      const delivery = await sendTelegramMessage(appContext, {
        text: `✅ Manually resolved\nIncident: ${incidentKey}`,
      });

      await insertDeliveryAttempt(appContext.db, {
        kind: "incident_manually_resolved",
        status: delivery.status,
        notificationIncidentId: incidentId,
        messageId: delivery.status === "sent" ? delivery.messageId : null,
        error: delivery.status === "failed"
          ? delivery.error
          : delivery.status === "skipped"
            ? delivery.reason
            : null,
      });
    }

    return { ok: true as const };
  });

  server.get("/api/v1/admin/notifications/reports/preview", {
    schema: routeSchemas.notificationsReportPreview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const report = await buildDailyRevenueTelegramReport(appContext);
    return {
      text: report.text,
      reportDate: report.reportDate,
    };
  });

  server.post("/api/v1/admin/notifications/reports/send", {
    schema: routeSchemas.notificationsReportSend,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const result = await sendManualDailyRevenueTelegramReport(appContext);
    return {
      status: result.delivery.status,
      error: result.delivery.status === "failed" ? result.delivery.error : null,
      reportDate: result.report?.reportDate ?? null,
    };
  });

  server.get("/api/v1/admin/notifications/reports/history", {
    schema: routeSchemas.notificationsReportHistory,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const attempts = await listDeliveryAttempts(appContext.db, {
      kind: ["daily_report_scheduled", "daily_report_manual"],
      limit: 50,
    });

    return {
      items: attempts.map((a) => ({
        id: a.id,
        kind: a.kind as "daily_report_scheduled" | "daily_report_manual",
        status: a.status,
        reportDate: a.reportDate,
        error: a.error,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });
}
