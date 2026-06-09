import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  routeSchemas,
  type RevenueDailyTypedItem,
  type UpdateCredentialsBody,
} from "../../../../packages/contracts/src/routes.ts";
import {
  CatalogModelNotFoundError,
  CatalogPageNotFoundError,
  countDistinctFansForPages,
  createFanNote,
  createModel,
  deleteModelBySlug,
  deletePageByLabel,
  DuplicateModelSlugError,
  DuplicatePageLabelError,
  findPlatformFan,
  getLatestSyncRunPerPage,
  getRevenueBreakdownForScope,
  getRevenuePageTotals,
  listFanFlags,
  listFanPageContexts,
  listAdminModels,
  listAdminPages,
  listFanTransactionsCrossPage,
  listFanTransactionsOnPage,
  listRevenueDailyForPages,
  listTransactionsForScope,
  listSubscriberDailyForPage,
  listFollowerTotalsForPages,
  listSubscriberTotalsForPages,
  listVisiblePages,
  ModelHasPagesError,
  setFanFlags,
  updateModelBySlug,
  updatePageByLabel,
} from "@agency_hub_core/db";
import {
  createLogger,
  createProxyRequestDispatcher,
  buildProxyEgressKey,
  encryptJson,
  millsToNumber,
  normalizeProxyConfig,
  redactSensitiveText,
  resolveBusinessDateRangeForPlatform,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  toMills,
  type Period,
  type Platform,
} from "@agency_hub_core/shared";
import { FanslyApiError } from "@agency_hub_core/fansly";
import { OnlyMonsterApiError } from "@agency_hub_core/onlyfans";
import type { FastifyReply } from "fastify";
import Fastify from "fastify";
import { PgBoss } from "pg-boss";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createJsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";

import type { AppContext } from "../bootstrap.ts";
import {
  assignPageToUser,
  authenticateApiKeyToken,
  authenticateSessionToken,
  canAccessPage,
  createUserAccount,
  getAuthenticatedUserByUsername,
  issueChatterApiKey,
  listApiKeysForUsers,
  listUsersDetailed,
  loginWithPassword,
  logoutSessionToken,
  requireDashboardUser,
  requireOwner,
  revokeUserApiKeys,
  SESSION_COOKIE_NAME,
  setUserPassword,
  unassignPageFromUser,
  type AuthPrincipal,
} from "../services/auth.ts";
import { getAdminChatterUsageReport, ingestAiUsageBatch } from "../services/ai-usage.ts";
import { listConnectionStatuses, updatePageCredentials } from "../services/connections.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../services/errors.ts";
import { handleSuccessfulPageVerificationRecovery } from "../services/notification-incidents.ts";
import {
  getLatestDeliveryAttempt,
  getNotificationIncidentByKey,
  getTelegramSettings,
  insertDeliveryAttempt,
  listDeliveryAttempts,
  listNotificationIncidentsWithPages,
  recordNotificationIncidentRecovery,
  resolveNotificationIncident,
  updateTelegramSettings,
} from "@agency_hub_core/db";
import { resolveTelegramCredentials, sendTelegramMessage, sendTelegramTestMessage } from "../services/telegram.ts";
import { buildDailyRevenueTelegramReport, sendManualDailyRevenueTelegramReport } from "../services/telegram-report.ts";
import { resolvePageContext } from "../services/page-context.ts";
import {
  getCrossPageFanDetailReport,
  getModelRevenueReport,
  getOverviewGrowthReport,
  getOverviewRevenueReport,
  getPageFanDetailReport,
  getPageDeletedFansReport,
  getPageFansReport,
  getPageFollowersDailyReport,
  getPageFollowersReport,
  getPageRevenueReport,
  getPageSubscribersDailyReport,
  getPageSubscribersReport,
  getPageSummary,
  getPageTransactionsReport,
  listModelSummaries,
  listPageSummaries,
} from "../services/reporting.ts";
import {
  getPageConversationMessagesReport,
  getPageConversationPreviewReport,
} from "../services/conversations.ts";
import { getPublicSyncHealth, getSystemHealth } from "../services/health.ts";
import {
  getWorkboardReport,
  snoozeWorkboardFanReport,
  unsnoozeWorkboardFanReport,
} from "../services/workboard.ts";
import { getWorkboardPresenceReport } from "../services/workboard-presence.ts";
import {
  getWorkboardV2Lists,
  getWorkboardV2Report,
  recordWorkboardContactV2,
  snoozeWorkboardV2,
  triggerWorkboardV2Recompute,
  undoWorkboardContactV2,
  unsnoozeWorkboardV2,
} from "../services/workboard-v2/report.ts";
import {
  getWorkboardV2AiReport,
  listWorkboardV2AiRuns,
  runWorkboardV2AiClassify,
  updateWorkboardV2AiSettings,
} from "../services/workboard-v2/ai-analytics.ts";
import { getWb3Board, getWb3FanDiagnostics } from "../services/workboard-v3/board.ts";
import { assertAllowedProxyTarget } from "../services/proxy-validation.ts";
import {
  getPageConversationProfile,
  getPageFanProfile,
  getPageFanProfileVersion,
  listPageFanProfileVersions,
  upsertPageFanProfile,
} from "../services/fan-profiles.ts";
import { getSyncMonitorRecentRequests, getSyncMonitorSnapshot } from "../services/sync-monitor.ts";
import { getSyncStatusSnapshot } from "../services/sync-status.ts";
import {
  getPageMessagesSyncBlock,
  getPageSyncBlocks,
  getSyncBlocksOverview,
  pauseSyncBlock,
  resetSyncBlock,
  resumeSyncBlock,
  triggerSyncBlock,
} from "../services/sync-blocks.ts";
import {
  getSpenderBatch,
  getSpenderDetail,
  getSpenderList,
  getPageSpenderAutoListDetail,
  getPageSpenderAutoLists,
  getSpenderSeries,
  searchVisibleFans,
} from "../services/spenders.ts";
import {
  ensureSyncQueues,
} from "../services/sync-queue.ts";
import { sql } from "drizzle-orm";
import { listStatus, getStatusDetail } from "../services/sync.ts";
import { requestAllPagesSync, requestPageSync } from "../services/sync-control.ts";
import { refreshPageMetadata } from "../services/sync/shared.ts";
import { createSyncRateLimitWaiter } from "../services/sync/rate-limiter.ts";
import { buildOverallSyncUx } from "../services/sync-ux.ts";
import { onboardFanslyPage, onboardOnlyFansPage } from "../services/page-onboarding.ts";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthPrincipal | null;
  }
}

function pageScopeFor(principal: AuthPrincipal) {
  return principal.user.role === "owner" ? undefined : principal.assignedPageIds;
}

function applyCookie(reply: {
  setCookie: FastifyReply["setCookie"];
}, token: string, appContext: AppContext) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: appContext.config.isProduction ? true : "auto",
    path: "/",
    expires: new Date(Date.now() + appContext.config.sessionTtlDays * 24 * 60 * 60 * 1000),
  });
}

function clearCookie(reply: {
  clearCookie: FastifyReply["clearCookie"];
}) {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
  });
}

function serializeTimestamp(value: Date | string) {
  return new Date(value).toISOString();
}

function serializeNullableTimestamp(value: Date | string | null | undefined) {
  return value == null ? null : serializeTimestamp(value);
}

type DashboardDistResolverOptions = {
  cwd?: string;
  moduleUrl?: string;
  pathExists?: (path: string) => boolean;
};

function ancestorDirs(start: string) {
  const dirs: string[] = [];
  let current = resolve(start);

  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

export function resolveDashboardDistPath(options: DashboardDistResolverOptions = {}) {
  const pathExists = options.pathExists ?? existsSync;
  const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const roots = new Set([
    ...ancestorDirs(options.cwd ?? process.cwd()),
    ...ancestorDirs(moduleDir),
  ]);

  for (const root of roots) {
    const candidate = resolve(root, "apps/dashboard/dist");
    if (pathExists(resolve(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function serializeEpochMillisecondsTimestamp(value: Date | string | number | bigint) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(Number(value)).toISOString();
}

function toNumber(value: number | string | bigint) {
  return typeof value === "number" ? value : Number(value);
}

function serializePageMetric(value: number | null) {
  return {
    value,
    available: value !== null,
  };
}

function serializeAssignedPage(page: {
  id: number;
  label: string;
  platform: Platform;
  username: string | null;
  displayName: string | null;
  followerCount: number | null;
  subscriberCount: number | null;
  lastLightSyncAt: Date | string | null;
  lastFollowerSyncAt: Date | string | null;
  modelSlug: string;
  modelName: string;
}) {
  return {
    id: page.id,
    label: page.label,
    platform: page.platform,
    username: page.username,
    displayName: page.displayName,
    followerCount: serializePageMetric(page.followerCount),
    subscriberCount: serializePageMetric(page.subscriberCount),
    lastLightSyncAt: serializeNullableTimestamp(page.lastLightSyncAt),
    lastFollowerSyncAt: serializeNullableTimestamp(page.lastFollowerSyncAt),
    modelSlug: page.modelSlug,
    modelName: page.modelName,
  };
}

function rethrowAdminCatalogError(error: unknown): never {
  if (
    error instanceof DuplicateModelSlugError ||
    error instanceof DuplicatePageLabelError ||
    error instanceof ModelHasPagesError
  ) {
    throw new ConflictError(error.message);
  }

  if (error instanceof CatalogModelNotFoundError || error instanceof CatalogPageNotFoundError) {
    throw new NotFoundError(error.message);
  }

  throw error;
}

export async function buildApiServer(appContext: AppContext) {
  const server = Fastify({
    loggerInstance: appContext.logger ?? createLogger(appContext.config.logLevel),
    trustProxy: appContext.config.trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.decorateRequest("auth");

  await server.register(cookie);
  await server.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      error: "rate_limit_exceeded",
      message: "Too many login attempts",
      statusCode: 429,
    }),
  });
  await server.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Agency Hub Core API",
        version: "2.0.0",
        description: "Phase 2 authenticated API",
      },
      servers: [],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: SESSION_COOKIE_NAME,
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
          },
          monitoringTokenAuth: {
            type: "apiKey",
            in: "header",
            name: "x-monitoring-token",
          },
        },
      },
    },
    transform: createJsonSchemaTransform({
      skipList: ["/documentation", "/documentation/static/*"],
    }),
    transformObject: jsonSchemaTransformObject,
  });
  async function resolvePrincipal(request: {
    auth?: AuthPrincipal | null;
    headers: Record<string, string | string[] | undefined>;
    cookies: Record<string, string | undefined>;
  }) {
    if (request.auth !== undefined) {
      return request.auth;
    }

    const authorization = request.headers.authorization;
    const bearerMatch = typeof authorization === "string"
      ? /^bearer\s+(.+)$/i.exec(authorization)
      : null;
    if (bearerMatch) {
      const token = bearerMatch[1]?.trim() ?? "";
      request.auth = token ? await authenticateApiKeyToken(appContext, token) : null;
      return request.auth;
    }

    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    request.auth = sessionToken
      ? await authenticateSessionToken(appContext, sessionToken)
      : null;
    return request.auth;
  }

  async function requirePrincipal(request: {
    auth?: AuthPrincipal | null;
    headers: Record<string, string | string[] | undefined>;
    cookies: Record<string, string | undefined>;
  }) {
    const principal = await resolvePrincipal(request);
    if (!principal) {
      throw new UnauthorizedError();
    }
    return principal;
  }

  function safeStringEquals(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  function hasValidSyncHealthMonitoringToken(request: {
    headers: Record<string, string | string[] | undefined>;
  }) {
    const configuredToken = appContext.config.healthSyncMonitoringToken;
    if (!configuredToken) {
      return false;
    }

    const token = request.headers["x-monitoring-token"];
    return typeof token === "string" && safeStringEquals(token, configuredToken);
  }

  async function requireSyncHealthAccess(request: {
    auth?: AuthPrincipal | null;
    headers: Record<string, string | string[] | undefined>;
    cookies: Record<string, string | undefined>;
  }) {
    if (hasValidSyncHealthMonitoringToken(request)) {
      return {};
    }

    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return {
      pageIds: pageScopeFor(principal),
    };
  }

  async function requireOpenApiDocsOwner(request: {
    auth?: AuthPrincipal | null;
    headers: Record<string, string | string[] | undefined>;
    cookies: Record<string, string | undefined>;
  }) {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
  }

  await server.register(swaggerUi, {
    routePrefix: "/documentation",
    uiHooks: {
      onRequest: requireOpenApiDocsOwner,
    },
  });

  function isAdminPageVerifyBadRequest(error: unknown) {
    if (error instanceof BadRequestError) {
      return true;
    }

    if (error instanceof FanslyApiError || error instanceof OnlyMonsterApiError) {
      return error.status === 401 || error.status === 403;
    }

    return error instanceof Error
      && error.message === "OnlyFans page metadata is missing onlyMonsterAccountId";
  }

  server.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.code(400).send({
        error: "Bad Request",
        message: error.message,
        statusCode: 400,
      });
      return;
    }

    if (isResponseSerializationError(error)) {
      request.log.error(error);
      reply.code(500).send({
        error: "Internal Server Error",
        message: "Response validation failed",
        statusCode: 500,
      });
      return;
    }

    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
      });
      return;
    }

    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      "error" in error &&
      typeof error.error === "string" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      reply.code(error.statusCode).send({
        error: error.error,
        message: error.message,
        statusCode: error.statusCode,
      });
      return;
    }

    request.log.error(error);
    reply.code(500).send({
      error: "internal_error",
      message: "Internal Server Error",
      statusCode: 500,
    });
  });

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

  server.post("/api/v1/auth/login", {
    schema: routeSchemas.login,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 60_000,
        keyGenerator: (request) => {
          const body = request.body;
          const username =
            typeof body === "object" && body !== null && "username" in body &&
            typeof (body as { username?: unknown }).username === "string"
              ? (body as { username: string }).username
              : "";
          return `${username.toLowerCase()}|${request.ip}`;
        },
      },
    },
  }, async (request, reply) => {
    const result = await loginWithPassword(appContext, request.body);
    applyCookie(reply, result.sessionToken, appContext);
    return {
      authMethod: result.authMethod,
      user: result.user,
    };
  });

  server.post("/api/v1/auth/logout", {
    schema: routeSchemas.logout,
  }, async (request, reply) => {
    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    if (sessionToken) {
      await logoutSessionToken(appContext, sessionToken);
    }
    clearCookie(reply);
    return { ok: true as const };
  });

  server.get("/api/v1/auth/me", {
    schema: routeSchemas.me,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return {
      authMethod: principal.authMethod,
      user: principal.user,
    };
  });

  server.post("/api/v1/ai-usage/batch", {
    schema: routeSchemas.aiUsageBatch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return ingestAiUsageBatch(appContext, principal, request.body);
  });

  server.get("/api/v1/pages", {
    schema: routeSchemas.pages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return listPageSummaries(appContext, pageScopeFor(principal));
  });

  server.get("/api/v1/models", {
    schema: routeSchemas.models,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return listModelSummaries(appContext, pageScopeFor(principal));
  });

  server.get("/api/v1/overview/revenue", {
    schema: routeSchemas.overviewRevenue,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const query = request.query;
    return getOverviewRevenueReport(appContext, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v1/overview/growth", {
    schema: routeSchemas.overviewGrowth,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const query = request.query;
    return getOverviewGrowthReport(appContext, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v1/models/:modelSlug/revenue", {
    schema: routeSchemas.modelRevenue,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const query = request.query;
    return getModelRevenueReport(appContext, request.params.modelSlug, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v1/pages/:pageLabel/revenue", {
    schema: routeSchemas.pageRevenue,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageRevenueReport(appContext, request.params.pageLabel, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
    });
  });

  server.get("/api/v1/pages/:pageLabel/transactions", {
    schema: routeSchemas.pageTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }

    return getPageTransactionsReport(appContext, request.params.pageLabel, {
      limit: query.limit,
      offset: query.offset,
      type: query.type,
      state: query.state,
    });
  });

  server.get("/api/v1/pages/:pageLabel/subscribers", {
    schema: routeSchemas.pageSubscribers,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageSubscribersReport(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/subscribers/daily", {
    schema: routeSchemas.pageSubscribersDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageSubscribersDailyReport(appContext, request.params.pageLabel, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
    });
  });

  server.get("/api/v1/pages/:pageLabel/followers", {
    schema: routeSchemas.pageFollowers,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFollowersReport(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/followers/daily", {
    schema: routeSchemas.pageFollowersDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFollowersDailyReport(appContext, request.params.pageLabel, {
      period: query.period,
      custom: query.period === "custom" ? { from: query.from, to: query.to } : undefined,
    });
  });

  server.get("/api/v1/pages/:pageLabel/fans", {
    schema: routeSchemas.pageFans,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFansReport(appContext, request.params.pageLabel, query);
  });

  server.get("/api/v1/pages/:pageLabel/deleted-fans", {
    schema: routeSchemas.pageDeletedFans,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageDeletedFansReport(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/spender-autolists", {
    schema: routeSchemas.pageSpenderAutoLists,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageSpenderAutoLists(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/spender-autolists/:bucketKey", {
    schema: routeSchemas.pageSpenderAutoListDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageSpenderAutoListDetail(
      appContext,
      request.params.pageLabel,
      request.params.bucketKey,
      request.query,
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId", {
    schema: routeSchemas.pageFanDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getPageFanDetailReport(
      appContext,
      request.params.pageLabel,
      request.params.platformUserId,
      pageScopeFor(principal),
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile", {
    schema: routeSchemas.pageFanProfile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageFanProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
    );
  });

  server.put("/api/v1/pages/:pageLabel/fans/:platformUserId/profile", {
    schema: routeSchemas.upsertFanProfile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return upsertPageFanProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
      request.body.body,
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions", {
    schema: routeSchemas.pageFanProfileVersions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return listPageFanProfileVersions(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
    );
  });

  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/profile/versions/:version", {
    schema: routeSchemas.pageFanProfileVersion,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageFanProfileVersion(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.platformUserId,
      request.params.version,
    );
  });

  server.get("/api/v1/pages/:pageLabel/conversations/:conversationId/profile", {
    schema: routeSchemas.pageConversationProfile,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageConversationProfile(
      appContext,
      principal,
      request.params.pageLabel,
      request.params.conversationId,
    );
  });

  server.get("/api/v1/pages/:pageLabel/conversations/:platformConversationId/preview", {
    schema: routeSchemas.pageConversationPreview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageConversationPreviewReport(appContext, principal, request.params, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/conversations/:conversationId/messages", {
    schema: routeSchemas.pageConversationMessages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getPageConversationMessagesReport(appContext, principal, request.params, request.query);
  });

  // --- Workboard ---

  server.get("/api/v1/pages/:pageLabel/workboard", {
    schema: routeSchemas.workboard,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardReport(appContext, principal, request.params.pageLabel);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/presence", {
    schema: routeSchemas.workboardPresence,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardPresenceReport(appContext, principal, request.params.pageLabel);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/snooze", {
    schema: routeSchemas.workboardSnooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return snoozeWorkboardFanReport(appContext, principal, request.params.pageLabel, request.body);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/snooze/:fanId", {
    schema: routeSchemas.workboardUnsnooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return unsnoozeWorkboardFanReport(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v2", {
    schema: routeSchemas.workboardV2,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardV2Report(appContext, principal, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v2/lists", {
    schema: routeSchemas.workboardV2Lists,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getWorkboardV2Lists(appContext, principal, request.params.pageLabel);
  });

  // Workboard v3 (read-only, Phase 1). Gated by WB3_ENABLED like the v3 jobs.
  server.get("/api/v1/pages/:pageLabel/workboard/v3/board", {
    schema: routeSchemas.workboardV3Board,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    if (!appContext.config.wb3Enabled) {
      throw new NotFoundError("Workboard v3 is disabled (WB3_ENABLED)");
    }
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getWb3Board(appContext.db, {
      platformAccountId: page.id,
      pageLabel: request.params.pageLabel,
    });
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v3/fans/:fanId", {
    schema: routeSchemas.workboardV3FanDiagnostics,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    if (!appContext.config.wb3Enabled) {
      throw new NotFoundError("Workboard v3 is disabled (WB3_ENABLED)");
    }
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    const diagnostics = await getWb3FanDiagnostics(appContext.db, {
      platformAccountId: page.id,
      fanId: request.params.fanId,
    });
    if (!diagnostics) {
      throw new NotFoundError("Fan has no Workboard v3 state on this page");
    }
    return diagnostics;
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/contact", {
    schema: routeSchemas.workboardV2Contact,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return recordWorkboardContactV2(appContext, principal, request.params.pageLabel, request.body);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/recompute", {
    schema: routeSchemas.workboardV2Recompute,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return triggerWorkboardV2Recompute(appContext, principal, request.params.pageLabel);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/snooze", {
    schema: routeSchemas.workboardV2Snooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return snoozeWorkboardV2(appContext, principal, request.params.pageLabel, request.body);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/v2/snooze/:fanId", {
    schema: routeSchemas.workboardV2Unsnooze,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return unsnoozeWorkboardV2(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  server.delete("/api/v1/pages/:pageLabel/workboard/v2/contact/:fanId", {
    schema: routeSchemas.workboardV2UndoContact,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return undoWorkboardContactV2(appContext, principal, request.params.pageLabel, request.params.fanId);
  });

  server.get("/api/v1/pages/:pageLabel/workboard/v2/ai", {
    schema: routeSchemas.workboardV2Ai,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal); // settings/cost/verdicts are owner-only; the board's coverage banner uses a separate read
    return getWorkboardV2AiReport(appContext, principal, request.params.pageLabel);
  });

  server.put("/api/v1/pages/:pageLabel/workboard/v2/ai/settings", {
    schema: routeSchemas.workboardV2AiSettings,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return updateWorkboardV2AiSettings(appContext, principal, request.params.pageLabel, request.body);
  });

  server.post("/api/v1/pages/:pageLabel/workboard/v2/ai/classify", {
    schema: routeSchemas.workboardV2AiClassify,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return runWorkboardV2AiClassify(appContext, principal, request.params.pageLabel, request.body);
  });

  server.get("/api/v1/workboard/ai/runs", {
    schema: routeSchemas.workboardV2AiRuns,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listWorkboardV2AiRuns(appContext);
  });

  server.get("/api/v1/fans/:platform/:platformUserId", {
    schema: routeSchemas.crossPageFanDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getCrossPageFanDetailReport(appContext, {
      platform: request.params.platform,
      platformUserId: request.params.platformUserId,
      pageIds: pageScopeFor(principal),
    });
  });

  server.get("/api/v2/spenders", {
    schema: routeSchemas.spenders,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderList(appContext, principal, request.query);
  });

  server.get("/api/v2/spenders/:platform/:platformUserId", {
    schema: routeSchemas.spenderDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderDetail(appContext, principal, request.params, request.query);
  });

  server.get("/api/v2/spenders/:platform/:platformUserId/series", {
    schema: routeSchemas.spenderSeries,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    return getSpenderSeries(appContext, principal, request.params, request.query);
  });

  server.post("/api/v2/spenders:batch", {
    schema: routeSchemas.spenderBatch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderBatch(appContext, principal, request.body);
  });

  server.get("/api/v2/fans/search", {
    schema: routeSchemas.fansSearch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return searchVisibleFans(appContext, principal, request.query);
  });

  // --- Phase 4: Dashboard + Admin routes ---

  // pg-boss for enqueuing sync trigger jobs (skip when no DB, e.g. contract generation)
  let boss: PgBoss | null = null;
  const createdQueues = new Set<string>();
  if (appContext.config.databaseUrl) {
    boss = new PgBoss({ connectionString: appContext.config.databaseUrl });
    await boss.start();
    await ensureSyncQueues(boss, createdQueues);
    server.addHook("onClose", async () => {
      await boss!.stop();
    });
  }

  function initialSyncRetryFor(pageLabel: string) {
    return {
      method: "POST" as const,
      path: "/api/v1/admin/sync/trigger" as const,
      body: {
        pageLabel,
        scope: "all" as const,
      },
    };
  }

  function initialSyncWarningFor(pageLabel: string) {
    return {
      code: "initial_sync_enqueue_failed" as const,
      message: `Page "${pageLabel}" was created, but initial sync was not queued. Retry by triggering an all sync for this page.`,
    };
  }

  async function queueInitialOnboardingSync(
    pageLabel: string,
    log: Pick<typeof server.log, "error" | "warn">,
  ) {
    if (!boss) {
      log.warn({ pageLabel }, "Initial sync for created page was not queued because the job queue is unavailable");
      return {
        syncQueued: false,
        syncWarning: initialSyncWarningFor(pageLabel),
        syncRetry: initialSyncRetryFor(pageLabel),
      };
    }

    try {
      await requestPageSync(appContext, boss, {
        pageLabel,
        scope: "all",
        reason: "onboarding",
      });
      return {
        syncQueued: true,
        syncWarning: null,
        syncRetry: null,
      };
    } catch (error) {
      log.error({ err: error, pageLabel }, "Failed to queue initial sync for created page");
      return {
        syncQueued: false,
        syncWarning: initialSyncWarningFor(pageLabel),
        syncRetry: initialSyncRetryFor(pageLabel),
      };
    }
  }

  // GET /api/v1/overview
  server.get("/api/v1/overview", {
    schema: routeSchemas.overview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const pageScope = pageScopeFor(principal);
    const pages = await listVisiblePages(appContext.db, pageScope);
    const pageIds = pages.map((p) => p.id);
    const modelSet = new Map<string, { slug: string; name: string }>();
    for (const p of pages) {
      modelSet.set(p.modelSlug, { slug: p.modelSlug, name: p.modelName });
    }
    const syncSnapshot = await getSyncStatusSnapshot(appContext, {
      pageIds,
    });
    const syncByPageId = new Map(syncSnapshot.pages.map((page) => [page.pageId, page.syncUx]));
    const overallSyncUx = buildOverallSyncUx(syncSnapshot.pages.map((page) => page.syncUx));
    const connectionStatuses = await listConnectionStatuses(appContext, {
      pageIds: pageScope,
      pages,
      syncUxByPageId: syncByPageId,
    });
    const statusByPageId = new Map(connectionStatuses.map((c) => [c.id, c]));

    // Revenue 7d and 30d
    const groupedPageIds = new Map<Platform, number[]>();
    for (const p of pages) {
      const ids = groupedPageIds.get(p.platform) ?? [];
      ids.push(p.id);
      groupedPageIds.set(p.platform, ids);
    }
    const now = new Date();

    const rev7d = { revenueMills: 0n, adjustmentMills: 0n, unclassifiedMills: 0n, netEarningsMills: 0n };
    const rev30d = { revenueMills: 0n, adjustmentMills: 0n, unclassifiedMills: 0n, netEarningsMills: 0n };
    const prevRev7d = { netEarningsMills: 0n };
    const prevRev30d = { netEarningsMills: 0n };

    for (const [platform, ids] of groupedPageIds) {
      const bounds7d = resolveRevenuePeriodBoundsForPlatform(platform, "7d", now);
      const bounds30d = resolveRevenuePeriodBoundsForPlatform(platform, "30d", now);
      const compBounds7d = resolveRevenueComparisonPeriodBoundsForPlatform(platform, "7d", now);
      const compBounds30d = resolveRevenueComparisonPeriodBoundsForPlatform(platform, "30d", now);
      const [rows7d, rows30d, compRows7d, compRows30d] = await Promise.all([
        getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: bounds7d }),
        getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: bounds30d }),
        compBounds7d ? getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: compBounds7d }) : Promise.resolve([]),
        compBounds30d ? getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: compBounds30d }) : Promise.resolve([]),
      ]);
      for (const r of rows7d) {
        const m = toMills(r.netAmountMills);
        if (r.bucket === "revenue") rev7d.revenueMills += m;
        else if (r.bucket === "adjustment") rev7d.adjustmentMills += m;
        else if (r.bucket === "unclassified") rev7d.unclassifiedMills += m;
      }
      rev7d.netEarningsMills = rev7d.revenueMills + rev7d.adjustmentMills + rev7d.unclassifiedMills;
      for (const r of rows30d) {
        const m = toMills(r.netAmountMills);
        if (r.bucket === "revenue") rev30d.revenueMills += m;
        else if (r.bucket === "adjustment") rev30d.adjustmentMills += m;
        else if (r.bucket === "unclassified") rev30d.unclassifiedMills += m;
      }
      rev30d.netEarningsMills = rev30d.revenueMills + rev30d.adjustmentMills + rev30d.unclassifiedMills;
      for (const r of compRows7d) {
        prevRev7d.netEarningsMills += toMills(r.netAmountMills);
      }
      for (const r of compRows30d) {
        prevRev30d.netEarningsMills += toMills(r.netAmountMills);
      }
    }

    function computeDeltaPct(current: bigint, previous: bigint): number | null {
      if (previous === 0n) return null;
      return Number(((current - previous) * 10000n) / (previous < 0n ? -previous : previous)) / 100;
    }

    // Per-page revenue (today, 7d, 30d)
    const pageTotalsToday = new Map<number, bigint>();
    const pageTotals7d = new Map<number, bigint>();
    const pageTotals30d = new Map<number, bigint>();
    for (const [platform, ids] of groupedPageIds) {
      const [ptToday, pt7d, pt30d] = await Promise.all([
        getRevenuePageTotals(appContext.db, {
          platform,
          pageIds: ids,
          period: resolveRevenuePeriodBoundsForPlatform(platform, "today", now),
        }),
        getRevenuePageTotals(appContext.db, {
          platform,
          pageIds: ids,
          period: resolveRevenuePeriodBoundsForPlatform(platform, "7d", now),
        }),
        getRevenuePageTotals(appContext.db, {
          platform,
          pageIds: ids,
          period: resolveRevenuePeriodBoundsForPlatform(platform, "30d", now),
        }),
      ]);
      for (const r of ptToday) pageTotalsToday.set(r.pageId, toMills(r.netEarningsMills));
      for (const r of pt7d) pageTotals7d.set(r.pageId, toMills(r.netEarningsMills));
      for (const r of pt30d) pageTotals30d.set(r.pageId, toMills(r.netEarningsMills));
    }

    // Per-page new subscribers today
    const pageNewSubsToday = new Map<number, number>();
    const todayBusinessDate = resolveBusinessDateRangeForPlatform("fansly", "today", now);
    const subscriberTotals = await listSubscriberTotalsForPages(appContext.db, {
      pageIds,
      fromBusinessDate: todayBusinessDate.from,
      toBusinessDate: todayBusinessDate.toExclusive,
    });
    for (const row of subscriberTotals) {
      pageNewSubsToday.set(row.pageId, row.newSubscribers);
    }

    // Per-page new followers today
    const pageNewFollowersToday = new Map<number, number>();
    const followerTotals = await listFollowerTotalsForPages(appContext.db, {
      pageIds,
      fromBusinessDate: todayBusinessDate.from,
      toBusinessDate: todayBusinessDate.toExclusive,
    });
    for (const row of followerTotals) {
      pageNewFollowersToday.set(row.pageId, row.newFollowers);
    }
    const distinctFans = await countDistinctFansForPages(appContext.db, pageIds);

    return {
      counts: {
        models: modelSet.size,
        pages: pages.length,
        fans: distinctFans,
      },
      revenue: {
        "7d": {
          revenueMills: millsToNumber(rev7d.revenueMills),
          adjustmentMills: millsToNumber(rev7d.adjustmentMills),
          unclassifiedMills: millsToNumber(rev7d.unclassifiedMills),
          netEarningsMills: millsToNumber(rev7d.netEarningsMills),
          previousNetEarningsMills: millsToNumber(prevRev7d.netEarningsMills),
          deltaPct: computeDeltaPct(rev7d.netEarningsMills, prevRev7d.netEarningsMills),
        },
        "30d": {
          revenueMills: millsToNumber(rev30d.revenueMills),
          adjustmentMills: millsToNumber(rev30d.adjustmentMills),
          unclassifiedMills: millsToNumber(rev30d.unclassifiedMills),
          netEarningsMills: millsToNumber(rev30d.netEarningsMills),
          previousNetEarningsMills: millsToNumber(prevRev30d.netEarningsMills),
          deltaPct: computeDeltaPct(rev30d.netEarningsMills, prevRev30d.netEarningsMills),
        },
      },
      overall: {
        syncUx: overallSyncUx,
      },
      pages: pages.map((p) => {
        const status = statusByPageId.get(p.id);
        return {
          id: p.id,
          label: p.label,
          platform: p.platform,
          modelSlug: p.modelSlug,
          modelName: p.modelName,
          username: p.username,
          subscriberCount: serializePageMetric(p.subscriberCount),
          followerCount: serializePageMetric(p.followerCount),
          revenueTodayMills: millsToNumber(pageTotalsToday.get(p.id) ?? 0n),
          revenue7dMills: millsToNumber(pageTotals7d.get(p.id) ?? 0n),
          revenue30dMills: millsToNumber(pageTotals30d.get(p.id) ?? 0n),
          newSubscribersToday: pageNewSubsToday.get(p.id) ?? 0,
          newFollowersToday: pageNewFollowersToday.get(p.id) ?? 0,
          connectionStatus: status?.connectionStatus ?? "unverified",
          lastLightSyncAt: p.lastLightSyncAt?.toISOString() ?? null,
          lastFollowerSyncAt: p.lastFollowerSyncAt?.toISOString() ?? null,
          lastSyncError: status?.lastSyncError ?? null,
          syncUx: syncByPageId.get(p.id) ?? overallSyncUx,
        };
      }),
      setup: {
        hasPages: pages.length > 0,
        hasFanslyPages: pages.some((p) => p.platform === "fansly"),
        hasOnlyFansPages: pages.some((p) => p.platform === "onlyfans"),
      },
    };
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

  // Revenue daily endpoints
  async function getRevenueDailySeries(
    pageIds: number[],
    pages: Array<{ platform: Platform }>,
    query: { period: string; from?: string; to?: string; groupByType: boolean },
  ) {
    type RevenueDailyCanonicalType = RevenueDailyTypedItem["canonicalType"];
    const groupedPageIds = new Map<Platform, number[]>();
    for (let i = 0; i < pages.length; i++) {
      const ids = groupedPageIds.get(pages[i].platform) ?? [];
      ids.push(pageIds[i]);
      groupedPageIds.set(pages[i].platform, ids);
    }

    const mergedResults = new Map<string, {
      businessDate: string;
      canonicalType?: RevenueDailyCanonicalType;
      netAmountMills: bigint;
      transactionCount: number;
    }>();

    for (const [platform, ids] of groupedPageIds) {
      const range = resolveRevenueBusinessDateRangeForPlatform(
        platform,
        query.period as Period,
        new Date(),
        query.period === "custom" && query.from && query.to
          ? { from: query.from, to: query.to }
          : undefined,
      );
      if (query.groupByType) {
        const rows = await listRevenueDailyForPages(appContext.db, {
          pageIds: ids,
          fromBusinessDate: range.from,
          toBusinessDate: range.toExclusive,
          groupByType: true,
        }) as Array<{
          businessDate: string;
          canonicalType: RevenueDailyCanonicalType;
          netAmountMills: bigint;
          transactionCount: number;
        }>;

        for (const row of rows) {
          const key = `${row.businessDate}:${row.canonicalType}`;
          const current = mergedResults.get(key);
          if (current) {
            current.netAmountMills += row.netAmountMills;
            current.transactionCount += row.transactionCount;
            continue;
          }

          mergedResults.set(key, {
            businessDate: row.businessDate,
            canonicalType: row.canonicalType,
            netAmountMills: row.netAmountMills,
            transactionCount: row.transactionCount,
          });
        }
        continue;
      }

      const rows = await listRevenueDailyForPages(appContext.db, {
        pageIds: ids,
        fromBusinessDate: range.from,
        toBusinessDate: range.toExclusive,
        groupByType: false,
      }) as Array<{
        businessDate: string;
        netAmountMills: bigint;
        transactionCount: number;
      }>;

      for (const row of rows) {
        const current = mergedResults.get(row.businessDate);
        if (current) {
          current.netAmountMills += row.netAmountMills;
          current.transactionCount += row.transactionCount;
          continue;
        }

        mergedResults.set(row.businessDate, {
          businessDate: row.businessDate,
          netAmountMills: row.netAmountMills,
          transactionCount: row.transactionCount,
        });
      }
    }

    return {
      series: Array.from(mergedResults.values())
        .sort((left, right) => {
          const dateCompare = left.businessDate.localeCompare(right.businessDate);
          if (dateCompare !== 0) {
            return dateCompare;
          }
          return (left.canonicalType ?? "").localeCompare(right.canonicalType ?? "");
        })
        .map((row) => ({
          businessDate: row.businessDate,
          ...(row.canonicalType ? { canonicalType: row.canonicalType } : {}),
          netAmountMills: millsToNumber(row.netAmountMills),
          transactionCount: row.transactionCount,
        })),
    };
  }

  server.get("/api/v1/overview/revenue/daily", {
    schema: routeSchemas.overviewRevenueDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const pages = await listVisiblePages(appContext.db, pageScopeFor(principal));
    return getRevenueDailySeries(
      pages.map((p) => p.id),
      pages,
      request.query,
    );
  });

  server.get("/api/v1/pages/:pageLabel/revenue/daily", {
    schema: routeSchemas.pageRevenueDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return getRevenueDailySeries([page.id], [page], request.query);
  });

  server.get("/api/v1/models/:modelSlug/revenue/daily", {
    schema: routeSchemas.modelRevenueDaily,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const pages = (await listVisiblePages(appContext.db, pageScopeFor(principal)))
      .filter((p) => p.modelSlug === request.params.modelSlug);
    if (pages.length === 0) {
      throw new NotFoundError(`Model "${request.params.modelSlug}" not found`);
    }
    return getRevenueDailySeries(pages.map((p) => p.id), pages, request.query);
  });

  // Cross-page transactions
  server.get("/api/v1/transactions", {
    schema: routeSchemas.crossPageTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const query = request.query;
    const pageScope = pageScopeFor(principal);
    const allPages = await listVisiblePages(appContext.db, pageScope);
    const pageIds = pageScope ?? allPages.map((p) => p.id);
    const platformByLabel = new Map(allPages.map((p) => [p.label, p.platform]));

    const result = await listTransactionsForScope(appContext.db, {
      pageIds,
      pageLabel: query.pageLabel,
      canonicalType: query.type,
      transactionState: query.state,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      items: result.items.map((row) => ({
        transactionId: row.transactionId,
        rawType: row.platform === "fansly" && /^-?\d+$/.test(row.rawType)
          ? Number.parseInt(row.rawType, 10)
          : row.rawType,
        canonicalType: row.canonicalType,
        transactionState: row.transactionState,
        amountMills: millsToNumber(row.amountMills),
        destinationAmountMills: millsToNumber(row.destinationAmountMills),
        netAmountMills: millsToNumber(row.netAmountMills),
        occurredAt: new Date(row.occurredAt).toISOString(),
        sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
        fan: row.fanPlatformUserId
          ? { platformUserId: row.fanPlatformUserId, username: row.fanUsername, displayName: row.fanDisplayName }
          : null,
        pageLabel: row.pageLabel,
        platform: row.platform,
      })),
      limit: query.limit,
      offset: query.offset,
      total: result.total,
    };
  });

  // Fan transactions on page
  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/transactions", {
    schema: routeSchemas.pageFanTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    const fan = await findPlatformFan(appContext.db, page.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const result = await listFanTransactionsOnPage(appContext.db, {
      pageId: page.id,
      fanId: fan.id,
      limit: request.query.limit,
      offset: request.query.offset,
    });
    return {
      items: result.items.map((row) => ({
        transactionId: row.transactionId,
        rawType: page.platform === "fansly" && /^-?\d+$/.test(row.rawType)
          ? Number.parseInt(row.rawType, 10)
          : row.rawType,
        canonicalType: row.canonicalType,
        transactionState: row.transactionState,
        amountMills: millsToNumber(row.amountMills),
        destinationAmountMills: millsToNumber(row.destinationAmountMills),
        netAmountMills: millsToNumber(row.netAmountMills),
        occurredAt: new Date(row.occurredAt).toISOString(),
        sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
      })),
      limit: request.query.limit,
      offset: request.query.offset,
      total: result.total,
    };
  });

  // Cross-page fan transactions
  server.get("/api/v1/fans/:platform/:platformUserId/transactions", {
    schema: routeSchemas.crossPageFanTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireDashboardUser(principal);
    const fan = await findPlatformFan(appContext.db, request.params.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const fanPages = await listFanPageContexts(appContext.db, fan.id, pageScopeFor(principal));
    if (fanPages.length === 0) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const memberPageIds = fanPages.map((p) => p.pageId);
    const result = await listFanTransactionsCrossPage(appContext.db, {
      fanId: fan.id,
      pageIds: memberPageIds,
      limit: request.query.limit,
      offset: request.query.offset,
    });
    return {
      items: result.items.map((row) => ({
        transactionId: row.transactionId,
        rawType: row.platform === "fansly" && /^-?\d+$/.test(row.rawType)
          ? Number.parseInt(row.rawType, 10)
          : row.rawType,
        canonicalType: row.canonicalType,
        transactionState: row.transactionState,
        amountMills: millsToNumber(row.amountMills),
        destinationAmountMills: millsToNumber(row.destinationAmountMills),
        netAmountMills: millsToNumber(row.netAmountMills),
        occurredAt: new Date(row.occurredAt).toISOString(),
        sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
        pageLabel: row.pageLabel,
        platform: row.platform,
      })),
      limit: request.query.limit,
      offset: request.query.offset,
      total: result.total,
    };
  });

  // Create fan note
  server.post("/api/v1/pages/:pageLabel/fans/:platformUserId/notes", {
    schema: routeSchemas.createFanNote,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await getPageSummary(appContext, request.params.pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    const fan = await findPlatformFan(appContext.db, page.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const fanPageContexts = await listFanPageContexts(appContext.db, fan.id, [page.id]);
    if (fanPageContexts.length === 0) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found on page "${request.params.pageLabel}"`);
    }
    const note = await createFanNote(appContext.db, {
      fanId: fan.id,
      platformAccountId: page.id,
      authorUserId: principal.user.id,
      body: request.body.body,
    });
    return {
      id: note.id,
      fanId: note.fanId,
      platformAccountId: note.platformAccountId,
      authorUserId: note.authorUserId!,
      body: note.body,
      createdAt: new Date(note.createdAt).toISOString(),
    };
  });

  // Set fan flags
  server.patch("/api/v1/fans/:platform/:platformUserId/flags", {
    schema: routeSchemas.setFanFlags,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const fan = await findPlatformFan(appContext.db, request.params.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const fanPages = await listFanPageContexts(appContext.db, fan.id, pageScopeFor(principal));
    if (fanPages.length === 0) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const flagRows = await setFanFlags(appContext.db, {
      fanId: fan.id,
      flags: request.body.flags,
      createdByUserId: principal.user.id,
    });
    return {
      flags: flagRows.map((row) => ({
        flag: row.flag,
        createdAt: new Date(row.createdAt).toISOString(),
        createdByUserId: row.createdByUserId,
      })),
    };
  });

  // OpenAPI JSON
  server.get("/api/v1/openapi.json", {
    schema: routeSchemas.openApiJson,
  }, async (request) => {
    await requireOpenApiDocsOwner(request);
    return server.swagger();
  });

  // === Admin routes ===
  const auditCtx = (principal: AuthPrincipal) => ({
    source: "api" as const,
    actorUserId: principal.user.id,
  });

  // User management
  server.get("/api/v1/admin/users", {
    schema: routeSchemas.adminListUsers,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listUsersDetailed(appContext);
  });

  server.get("/api/v1/admin/usage/chatters", {
    schema: routeSchemas.adminChatterUsage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return getAdminChatterUsageReport(appContext, request.query);
  });

  server.post("/api/v1/admin/users", {
    schema: routeSchemas.adminCreateUser,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const user = await createUserAccount(appContext, request.body, auditCtx(principal));
    return user!;
  });

  server.patch("/api/v1/admin/users/:username/password", {
    schema: routeSchemas.adminSetPassword,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await setUserPassword(appContext, {
      username: request.params.username,
      password: request.body.password,
    }, auditCtx(principal));
    return { ok: true as const };
  });

  server.post("/api/v1/admin/users/:username/pages", {
    schema: routeSchemas.adminAssignPage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await assignPageToUser(appContext, {
      username: request.params.username,
      pageLabel: request.body.pageLabel,
    }, auditCtx(principal));
    const user = await getAuthenticatedUserByUsername(appContext, request.params.username);
    if (!user) {
      throw new NotFoundError(`User "${request.params.username}" not found`);
    }
    return user;
  });

  server.delete("/api/v1/admin/users/:username/pages/:pageLabel", {
    schema: routeSchemas.adminUnassignPage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    await unassignPageFromUser(appContext, {
      username: request.params.username,
      pageLabel: request.params.pageLabel,
    }, auditCtx(principal));
    return { ok: true as const };
  });

  // API key management
  server.get("/api/v1/admin/users/:username/api-keys", {
    schema: routeSchemas.adminListApiKeys,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const keys = await listApiKeysForUsers(appContext, [request.params.username]);
    return keys.map((k) => ({
      id: k.id,
      keyPrefix: k.keyPrefix,
      userId: k.userId,
      isActive: k.revokedAt === null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      revokedReason: k.revokedReason ?? null,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    }));
  });

  server.post("/api/v1/admin/users/:username/api-keys", {
    schema: routeSchemas.adminIssueApiKey,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return issueChatterApiKey(appContext, {
      username: request.params.username,
      pageLabel: request.body.pageLabel,
    }, auditCtx(principal));
  });

  server.delete("/api/v1/admin/users/:username/api-keys", {
    schema: routeSchemas.adminRevokeApiKeys,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const revoked = await revokeUserApiKeys(appContext, {
      username: request.params.username,
    }, auditCtx(principal));
    return { revokedCount: revoked.length };
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
    return triggerSyncBlock(appContext, boss, request.body);
  });

  server.post("/api/v1/admin/sync/blocks/pause", {
    schema: routeSchemas.adminSyncBlockPause,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return pauseSyncBlock(appContext, request.body);
  });

  server.post("/api/v1/admin/sync/blocks/resume", {
    schema: routeSchemas.adminSyncBlockResume,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    if (!boss) {
      throw new ServiceUnavailableError("Job queue not available");
    }
    return resumeSyncBlock(appContext, boss, request.body);
  });

  server.post("/api/v1/admin/sync/blocks/reset", {
    schema: routeSchemas.adminSyncBlockReset,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    if (!boss) {
      throw new ServiceUnavailableError("Job queue not available");
    }
    return resetSyncBlock(appContext, boss, request.body);
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

  server.get("/api/v1/admin/models", {
    schema: routeSchemas.adminModels,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listAdminModels(appContext.db);
  });

  server.post("/api/v1/admin/models", {
    schema: routeSchemas.adminCreateModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const model = await createModel(appContext.db, request.body);
      return { id: model.id, slug: model.slug, name: model.name };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.patch("/api/v1/admin/models/:modelSlug", {
    schema: routeSchemas.adminUpdateModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const model = await updateModelBySlug(appContext.db, request.params.modelSlug, request.body);
      return { id: model.id, slug: model.slug, name: model.name };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.delete("/api/v1/admin/models/:modelSlug", {
    schema: routeSchemas.adminDeleteModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      await deleteModelBySlug(appContext.db, request.params.modelSlug);
      return { deleted: true as const };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.get("/api/v1/admin/pages", {
    schema: routeSchemas.adminPages,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const pages = await listAdminPages(appContext.db);
    return pages.map((page) => serializeAssignedPage(page));
  });

  server.post("/api/v1/admin/pages", {
    schema: routeSchemas.adminCreatePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body = request.body;
    if (body.platform === "fansly") {
      await onboardFanslyPage(appContext, {
        modelSlug: body.modelSlug,
        label: body.label,
        session: body.session,
        proxy: body.proxy ?? null,
      });
      const syncQueueState = await queueInitialOnboardingSync(body.label, request.log);
      const page = await getPageSummary(appContext, body.label);
      return {
        page: serializeAssignedPage(page),
        verified: true,
        ...syncQueueState,
      };
    } else {
      await onboardOnlyFansPage(appContext, {
        modelSlug: body.modelSlug,
        label: body.label,
        auth: body.auth,
        username: body.username,
        proxy: body.proxy ?? null,
      });
      const syncQueueState = await queueInitialOnboardingSync(body.label, request.log);
      const page = await getPageSummary(appContext, body.label);
      return {
        page: serializeAssignedPage(page),
        verified: true,
        ...syncQueueState,
      };
    }
  });

  server.patch("/api/v1/admin/pages/:pageLabel", {
    schema: routeSchemas.adminUpdatePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const updated = await updatePageByLabel(appContext.db, request.params.pageLabel, request.body);
      const [page] = await listAdminPages(appContext.db, { pageIds: [updated.id] });
      if (!page) {
        throw new NotFoundError(`Page "${updated.label}" not found`);
      }
      return { page: serializeAssignedPage(page) };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.delete("/api/v1/admin/pages/:pageLabel", {
    schema: routeSchemas.adminDeletePage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      await deletePageByLabel(appContext.db, request.params.pageLabel);
      return { deleted: true as const };
    } catch (error) {
      rethrowAdminCatalogError(error);
    }
  });

  server.post("/api/v1/admin/credentials/verify", {
    schema: routeSchemas.adminVerifyCredentials,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body = request.body;
    try {
      const proxy = body.proxy ? normalizeProxyConfig(body.proxy) : null;
      if (proxy) {
        await assertAllowedProxyTarget(proxy);
      }
      const egressKey = buildProxyEgressKey(proxy);
      const rateLimitWaiter = createSyncRateLimitWaiter(appContext, { egressKey });

      if (body.platform === "fansly") {
        const result = await appContext.adapter.verifySession({
          session: body.session,
          proxy,
          egressKey,
          rateLimitWaiter,
        });
        return {
          valid: true as const,
          platform: "fansly" as const,
          username: result.parsed.account.username,
          displayName: result.parsed.account.displayName,
        };
      } else {
        const { findOnlyFansAccountByUsername } = await import("../services/onlyfans.ts");
        const context = {
          auth: body.auth,
          proxy,
          egressKey,
          requestObserver: null,
          rateLimitWaiter,
        };
        const account = await findOnlyFansAccountByUsername(
          appContext.onlyFansAdapter,
          context,
          body.username,
        );
        return {
          valid: true as const,
          platform: "onlyfans" as const,
          username: account.username,
          displayName: account.name ?? null,
        };
      }
    } catch (error) {
      throw new BadRequestError(
        `Credential verification failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`,
      );
    }
  });

  server.post("/api/v1/admin/proxy/test", {
    schema: routeSchemas.adminTestProxy,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const { request: undiciRequest } = await import("undici");
    let proxy: ReturnType<typeof normalizeProxyConfig>;
    try {
      proxy = normalizeProxyConfig(request.body.proxy);
      await assertAllowedProxyTarget(proxy);
    } catch (error) {
      throw new BadRequestError(
        `Proxy test failed: ${redactSensitiveText(error instanceof Error ? error.message : "Invalid proxy URL")}`,
      );
    }
    const dispatcher = createProxyRequestDispatcher(proxy);
    try {
      const { statusCode, body: responseBody } = await undiciRequest(
        "https://api.ipify.org?format=json",
        {
          method: "GET",
          signal: AbortSignal.timeout(30_000),
          dispatcher,
        },
      );
      const text = await responseBody.text();
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`IP check returned HTTP ${statusCode}`);
      }
      const data = JSON.parse(text) as { ip: string };
      return { ip: data.ip };
    } catch (error) {
      throw new BadRequestError(
        `Proxy test failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`,
      );
    } finally {
      await dispatcher.close();
    }
  });

  server.post("/api/v1/admin/pages/:pageLabel/verify", {
    schema: routeSchemas.adminVerifyPage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    try {
      const pageContext = await resolvePageContext(appContext, request.params.pageLabel);
      if (pageContext.platform === "fansly") {
        await refreshPageMetadata(appContext, pageContext, "light");
      } else {
        await refreshPageMetadata(appContext, pageContext, "light");
      }
      const recoveredAt = new Date();
      await handleSuccessfulPageVerificationRecovery(appContext, {
        platformAccountId: pageContext.page.id,
        pageLabel: pageContext.page.label,
        platform: pageContext.platform,
        recoveredAt,
      });
      return {
        verified: true,
        username: pageContext.page.username,
        platform: pageContext.platform,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      if (isAdminPageVerifyBadRequest(error)) {
        throw new BadRequestError(
          `Page verification failed: ${
            redactSensitiveText(error instanceof Error ? error.message : "Unknown error")
          }`,
        );
      }

      throw error;
    }
  });

  server.patch("/api/v1/admin/pages/:pageLabel/credentials", {
    schema: routeSchemas.adminUpdateCredentials,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body: UpdateCredentialsBody = request.body;
    return updatePageCredentials(appContext, request.params.pageLabel, body);
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

    return rows.map((r: any) => ({
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

    return rows.map((r: any) => ({
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

    const tables = tableRows.map((r: any) => ({
      schema: r.schema,
      table: r.table,
      rowEstimate: toNumber(r.rowEstimate),
      totalBytes: toNumber(r.totalBytes),
      indexBytes: toNumber(r.indexBytes),
    }));

    let migrations: any[] = [];
    try {
      const migrationRows = (await appContext.db.execute(sql`
        SELECT id as "name", applied_at as "appliedAt"
        FROM schema_migrations
        ORDER BY applied_at ASC, id ASC
      `)).rows;
      migrations = migrationRows.map((r: any) => ({
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

    const items = (await appContext.db.execute(sql`
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
    `)).rows.map((r: any) => ({
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

    const summary = (await appContext.db.execute(sql`
      SELECT e.details->>'code' as "code", ${normalizedSeverity} as "severity", count(*)::int as "count"
      FROM sync_run_events e
      WHERE (e.severity IN ('warn', 'error') OR e.event_type = 'anomaly')
        AND e.emitted_at > now() - interval '7 days'
      GROUP BY e.details->>'code', ${normalizedSeverity}
      ORDER BY count DESC
      LIMIT 20
    `)).rows.map((r: any) => ({
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
    latest: Awaited<ReturnType<typeof getLatestDeliveryAttempt>>,
  ) {
    const creds = resolveTelegramCredentials(appContext, settings);
    const configured = creds !== null;

    let connectionStatus: "not_configured" | "connected" | "last_message_failed" = "connected";
    if (!configured) {
      connectionStatus = "not_configured";
    } else if (latest?.status === "failed") {
      connectionStatus = "last_message_failed";
    }

    return {
      configured,
      botTokenSet: !!settings.encryptedBotToken || !!appContext.config.telegramBotToken,
      chatId: settings.chatId ?? appContext.config.telegramChatId ?? null,
      enabled: settings.enabled,
      dailyReportEnabled: settings.dailyReportEnabled,
      syncFailureAlertsEnabled: settings.syncFailureAlertsEnabled,
      reportHourUtc: settings.reportHourUtc,
      connectionStatus,
      lastMessageAt: latest?.createdAt?.toISOString() ?? null,
      lastMessageError: latest?.status === "failed" ? (latest.error ?? null) : null,
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
    const latest = await getLatestDeliveryAttempt(appContext.db);
    return buildNotificationsSettingsResponse(settings, latest);
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
    const latest = await getLatestDeliveryAttempt(appContext.db);
    return buildNotificationsSettingsResponse(updated, latest);
  });

  server.post("/api/v1/admin/notifications/test", {
    schema: routeSchemas.notificationsTestMessage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const result = await sendTelegramTestMessage(appContext);

    if (result.status === "sent" || result.status === "failed") {
      await insertDeliveryAttempt(appContext.db, {
        kind: "test",
        status: result.status,
        messageId: result.status === "sent" ? result.messageId : null,
        error: result.status === "failed" ? result.error : null,
      });
    }

    return {
      status: result.status,
      error: result.status === "failed" ? result.error : null,
    };
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

    const incidentKey = (rows[0] as any).incident_key as string;
    const resolvedAt = new Date();
    await recordNotificationIncidentRecovery(appContext.db, {
      incidentKey,
      recoveredAt: resolvedAt,
      now: resolvedAt,
    });
    const resolved = await resolveNotificationIncident(appContext.db, {
      incidentKey,
      maxLastSeenAt: resolvedAt,
      now: resolvedAt,
    });

    if (resolved) {
      // Best-effort send "Manually resolved" to Telegram
      const delivery = await sendTelegramMessage(appContext, {
        text: `✅ Manually resolved\nIncident: ${incidentKey}`,
      });

      if (delivery.status === "sent" || delivery.status === "failed") {
        await insertDeliveryAttempt(appContext.db, {
          kind: "incident_manually_resolved",
          status: delivery.status,
          notificationIncidentId: incidentId,
          messageId: delivery.status === "sent" ? delivery.messageId : null,
          error: delivery.status === "failed" ? delivery.error : null,
        });
      }
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

  // SPA static file serving (production only)
  const dashboardDist = resolveDashboardDistPath();
  if (dashboardDist) {
    const fastifyStatic = (await import("@fastify/static")).default;
    await server.register(fastifyStatic, { root: dashboardDist, prefix: "/", wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (!req.url.startsWith("/api/") && !req.url.startsWith("/documentation")) {
        return reply.sendFile("index.html");
      }
      reply.status(404).send({ error: "Not Found", message: "Route not found", statusCode: 404 });
    });
  }

  return server;
}
