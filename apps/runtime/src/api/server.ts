import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  routeSchemas,
  routeSecurityFromAuth,
  type RevenueDailyTypedItem,
  type RouteAuthPolicy,
  type UpdateCredentialsBody,
} from "../../../../packages/contracts/src/routes.ts";
import {
  CatalogModelNotFoundError,
  CatalogPageNotFoundError,
  clearConfigOverride,
  ConfigOverrideVersionConflictError,
  countDistinctFansForPages,
  createModel,
  deleteModelBySlug,
  deletePageByLabel,
  DuplicateModelSlugError,
  DuplicatePageLabelError,
  setConfigOverridesAtomic,
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
  updateModelBySlug,
  updatePageByLabel,
} from "@agency_hub_core/db";
import {
  createLogger,
  createProxyRequestDispatcher,
  buildProxyEgressKey,
  encryptJson,
  collectCostWarnings,
  getDescriptor,
  millsToNumber,
  normalizeProxyConfig,
  redactSensitiveText,
  resolveBusinessDateRangeForPlatform,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  toMills,
  validateConfigOverride,
  validateStagedOverride,
  type ConfigOverrideValue,
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
  canAccessPage,
  enforceRevenueRouteRoleScope,
  recordAudit,
  requireApiKeyUser,
  requireDashboardUser,
  requireOwner,
  SESSION_COOKIE_NAME,
  type AuthPrincipal,
} from "../services/auth.ts";
import { buildConfigView } from "../services/app-config-service.ts";
import { LIVE_CONFIG_KEYS } from "../services/effective-config.ts";
import { commitStagedConfigChange } from "../services/staged-config.ts";
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
  buildRoutePolicyIndex,
  classifyAuthPolicyDivergence,
  computeAuthPolicyVerdict,
  type AuthPolicyVerdict,
  type RoutePolicyTableRow,
} from "./auth-policy.ts";
import { auditCtx, createRequestAuth, pageScopeFor } from "./request-auth.ts";
import type { ApiModuleContext } from "../modules/context.ts";
import { registerAudienceRoutes } from "../modules/audience/index.ts";
import { registerAiRoutes } from "../modules/ai/index.ts";
import { registerConversationsRoutes } from "../modules/conversations/index.ts";
import { registerEventsRoutes } from "../modules/events/index.ts";
import { registerIdentityRoutes } from "../modules/identity/index.ts";
import { registerIngestRoutes } from "../modules/ingest/index.ts";
import { registerWorkboardRoutes } from "../modules/workboard/index.ts";
import {
  findPageSummaryByLabel,
  getLatestRealDeliveryAttempt,
  getNotificationIncidentByKey,
  getTelegramSettings,
  insertDeliveryAttempt,
  listDeliveryAttempts,
  listNotificationIncidentsWithPages,
  recordNotificationIncidentRecovery,
  resolveNotificationIncident,
  updateTelegramSettings,
} from "@agency_hub_core/db";
import {
  deriveTelegramConnectionState,
  discoverTelegramChats,
  closeTelegramRequestOptions,
  resolveTelegramBotToken,
  resolveTelegramCredentials,
  resolveTelegramCredentialSources,
  sendTelegramMessage,
  sendTelegramTestMessage,
  TelegramDiscoveryError,
  TelegramProxyConfigError,
  resolveTelegramRequestOptions,
} from "../services/telegram.ts";
import { buildDailyRevenueTelegramReport, sendManualDailyRevenueTelegramReport } from "../services/telegram-report.ts";
import { resolvePageContext } from "../services/page-context.ts";
import {
  getModelRevenueReport,
  getOverviewRevenueReport,
  getPageRevenueReport,
  getPageSummary,
  getPageTransactionsReport,
  listModelSummaries,
  listPageSummaries,
} from "../services/reporting.ts";
import { getPublicSyncHealth, getSystemHealth } from "../services/health.ts";
import { assertAllowedProxyTarget } from "../services/proxy-validation.ts";
import { getSyncMonitorRecentRequests, getSyncMonitorSnapshot } from "../services/sync-monitor.ts";
import { getSyncStatusSnapshot } from "../services/sync-status.ts";
import { getSyncStatusSummarySnapshot } from "../services/sync-summary.ts";
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
} from "../services/spenders.ts";
import {
  ensureSyncQueues,
} from "../services/sync-queue.ts";
import {
  getChatterOfapiCreditsSummary,
  getOfapiCreditsDaily,
  getOfapiCreditsLedger,
  getOfapiCreditsLedgerCsv,
  getOfapiCreditsSummary,
} from "../services/ofapi-credit-report.ts";
import { recordClientVersionObservation } from "../services/client-versions.ts";
import { ensureOfapiCommandQueues } from "../services/ofapi-command-executor.ts";
import { getOfapiDmColdArchiveStatus } from "../services/ofapi-dm-archive.ts";
import { getOfapiSpendComparison } from "../services/ofapi-spend-comparison.ts";
import { ensureOfapiQueues } from "../services/ofapi-events.ts";
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
    authPolicy?: { routeKey: string; verdict: AuthPolicyVerdict };
  }
  interface FastifyInstance {
    /** Route → auth declaration rows, collected at registration (Stage 19). */
    routePolicyTable: RoutePolicyTableRow[];
  }
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

export function normalizeOpenApiDocument<T extends Record<string, any>>(spec: T): T {
  // Deterministic path order: swagger emits paths in ROUTE REGISTRATION order,
  // which the Stage 19 module extraction shuffles as handlers relocate. Sorting
  // decouples the published document (and the api-types diff gate) from where a
  // route happens to register.
  if (spec.paths && typeof spec.paths === "object") {
    (spec as Record<string, any>).paths = Object.fromEntries(
      Object.entries(spec.paths as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }

  const csvResponse = spec.paths?.["/api/v1/admin/ofapi/credits/ledger.csv"]
    ?.get?.responses?.["200"];
  const jsonContent = csvResponse?.content?.["application/json"];
  if (csvResponse && jsonContent) {
    csvResponse.content = {
      "text/csv": jsonContent,
    };
  }

  return spec;
}

export async function buildApiServer(appContext: AppContext) {
  const server = Fastify({
    loggerInstance: appContext.logger ?? createLogger(appContext.config.logLevel),
    trustProxy: appContext.config.trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.decorateRequest("auth");
  server.decorateRequest("authPolicy");

  // Stage 4 fleet-verify: the desktop stamps x-client-version on every call;
  // one "Desktop client version observed" log line per (version, address)
  // gives the exit check its data source.
  server.addHook("onRequest", async (request) => {
    recordClientVersionObservation({
      version: request.headers["x-client-version"],
      remoteAddress: request.ip,
      logger: request.log,
    });
  });

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
    transform: (() => {
      const baseTransform = createJsonSchemaTransform({
        skipList: ["/documentation", "/documentation/static/*"],
      });
      // The declarative `auth` block (kernel Stage 19) is not itself wire
      // contract: strip it, and DERIVE the operation's `security` from it so the
      // published document cannot disagree with what the middleware enforces.
      return (input: Parameters<typeof baseTransform>[0]) => {
        if (input.schema && "auth" in input.schema) {
          const { auth, ...schema } =
            input.schema as unknown as { auth: RouteAuthPolicy } & Record<string, unknown>;
          const security = routeSecurityFromAuth(auth);
          return baseTransform({
            ...input,
            schema: (security ? { ...schema, security } : schema) as unknown as typeof input.schema,
          });
        }
        return baseTransform(input);
      };
    })(),
    transformObject: jsonSchemaTransformObject,
  });
  // Request-level principal helpers, shared with the extracted modules
  // (Stage 19): same bodies, factored into one factory.
  const requestAuth = createRequestAuth(appContext);
  const {
    resolvePrincipal,
    requirePrincipal,
    hasValidSyncHealthMonitoringToken,
    requireSyncHealthAccess,
  } = requestAuth;

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

  // --- Declarative route authorization (kernel Stage 19) ---
  // One middleware, one verdict per request, computed from the route schema's
  // `auth` declaration before any handler runs. In "log" mode the verdict is
  // recorded and compared onResponse with what the legacy in-handler guards
  // actually answered; in "enforce" mode a denying verdict refuses the request
  // here. Legacy guards stay in place until the post-flip cleanup, so rollback
  // is AUTH_POLICY_ENFORCEMENT=log.
  const routePolicyIndex = buildRoutePolicyIndex();
  const isAuthPolicyEnforced = () => appContext.config.authPolicyEnforcement === "enforce";

  // Route → declaration table, collected at registration time. Feeds the
  // generated authorization-policy document (and Stage 20's SDK generator needs
  // the same method/path introspection).
  const routePolicyTable: RoutePolicyTableRow[] = [];
  server.decorate("routePolicyTable", routePolicyTable);
  server.addHook("onRoute", (route) => {
    const entry = routePolicyIndex.get(route.schema);
    if (!entry) {
      return;
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") {
        continue; // fastify's auto-added HEAD twin of every GET
      }
      routePolicyTable.push({ method, url: route.url, routeKey: entry.key, auth: entry.auth });
    }
  });

  server.addHook("onRequest", async (request) => {
    const entry = routePolicyIndex.get(request.routeOptions.schema);
    if (!entry) {
      return; // outside the contract surface (documentation UI, 404s)
    }
    if (!entry.auth) {
      // The contracts CI gate makes this unreachable; fail closed if it drifts.
      request.log.error({ routeKey: entry.key }, "auth-policy: route has no auth declaration");
      if (isAuthPolicyEnforced()) {
        throw new ForbiddenError("Route has no authorization declaration");
      }
      return;
    }
    const params = request.params as Record<string, unknown> | null;
    const pageLabelParam = typeof params?.pageLabel === "string" ? params.pageLabel : undefined;
    const verdict = await computeAuthPolicyVerdict({
      auth: entry.auth,
      resolvePrincipal: () => resolvePrincipal(request),
      hasMonitoringToken: () => hasValidSyncHealthMonitoringToken(request),
      resolvePageAccess: async (pageLabel) => {
        const page = await findPageSummaryByLabel(appContext.db, pageLabel);
        if (!page) {
          return "not-found";
        }
        const principal = await resolvePrincipal(request);
        return principal && canAccessPage(principal, page.id) ? "ok" : "denied";
      },
      pageLabelParam,
    });
    request.authPolicy = { routeKey: entry.key, verdict };
    if (!verdict.allow && isAuthPolicyEnforced()) {
      switch (verdict.statusCode) {
        case 401:
          throw new UnauthorizedError();
        case 404:
          throw new NotFoundError(`Page "${pageLabelParam}" was not found`);
        default:
          throw new ForbiddenError(`Authorization policy denied this request (${verdict.reason})`);
      }
    }
  });

  server.addHook("onResponse", async (request, reply) => {
    if (isAuthPolicyEnforced()) {
      return;
    }
    const decided = request.authPolicy;
    if (!decided) {
      return;
    }
    const divergence = classifyAuthPolicyDivergence(decided.verdict, reply.statusCode);
    if (!divergence) {
      return;
    }
    request.log.warn({
      routeKey: decided.routeKey,
      method: request.method,
      path: request.routeOptions.url,
      statusCode: reply.statusCode,
      verdict: decided.verdict,
      userId: request.auth?.user.id,
      role: request.auth?.user.role,
      authMethod: request.auth?.authMethod,
    }, `auth-policy ${divergence}: middleware verdict diverges from the legacy guards`);
  });

  // pg-boss for enqueuing sync trigger jobs (skip when no DB, e.g. contract
  // generation). Created before any route registers so the module context below
  // can carry it.
  let boss: PgBoss | null = null;
  const createdQueues = new Set<string>();
  if (appContext.config.databaseUrl) {
    boss = new PgBoss({ connectionString: appContext.config.databaseUrl });
    // Without a listener an EventEmitter 'error' throws and takes the API
    // down on a transient Postgres blip (audit B8). Log only: this instance
    // merely enqueues jobs, and /health covers API liveness.
    boss.on("error", (error) => {
      appContext.logger.error({ err: error }, "pg-boss api error");
    });
    await boss.start();
    await ensureSyncQueues(boss, createdQueues);
    await ensureOfapiQueues(boss, createdQueues);
    await ensureOfapiCommandQueues(boss, createdQueues);
    server.addHook("onClose", async () => {
      await boss!.stop();
    });
  }

  // What every extracted bounded-context module receives (Stage 19 Task 3).
  const moduleContext: ApiModuleContext = {
    appContext,
    auth: requestAuth,
    boss,
  };

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

  // --- Identity (auth/sessions/users/api-keys) --- (module: apps/runtime/src/modules/identity)
  registerIdentityRoutes(server, moduleContext);

  // --- AI (gateway/usage) --- (module: apps/runtime/src/modules/ai)
  registerAiRoutes(server, moduleContext);

  // --- Ingest (webhook/capture/custody lanes) --- (module: apps/runtime/src/modules/ingest)
  await registerIngestRoutes(server, moduleContext);

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

  // --- Audience (fans/subs/follows/growth) --- (module: apps/runtime/src/modules/audience)
  registerAudienceRoutes(server, moduleContext);

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
    enforceRevenueRouteRoleScope(appContext, principal, "/api/v1/pages/:pageLabel/revenue");
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
    enforceRevenueRouteRoleScope(appContext, principal, "/api/v1/pages/:pageLabel/transactions");

    return getPageTransactionsReport(appContext, request.params.pageLabel, {
      limit: query.limit,
      offset: query.offset,
      type: query.type,
      state: query.state,
    });
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

  // --- Conversations (profiles/threads/archive) --- (module: apps/runtime/src/modules/conversations)
  registerConversationsRoutes(server, moduleContext);

  // --- Workboard --- (module: apps/runtime/src/modules/workboard)
  registerWorkboardRoutes(server, moduleContext);

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

  // --- Phase 4: Dashboard + Admin routes ---

  // --- OFAPI webhook receiver + SSE sync-event fanout (ChatMuse real-time) ---

  // --- Events (stream + snapshot) --- (module: apps/runtime/src/modules/events)
  registerEventsRoutes(server, moduleContext);

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
    const syncSnapshot = await getSyncStatusSummarySnapshot(appContext, {
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
    enforceRevenueRouteRoleScope(appContext, principal, "/api/v1/pages/:pageLabel/revenue/daily");
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
    enforceRevenueRouteRoleScope(appContext, principal, "/api/v1/pages/:pageLabel/fans/:platformUserId/transactions");
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

  // OpenAPI JSON
  server.get("/api/v1/openapi.json", {
    schema: routeSchemas.openApiJson,
  }, async (request) => {
    await requireOpenApiDocsOwner(request);
    return normalizeOpenApiDocument(server.swagger() as Record<string, any>);
  });

  // === Admin routes ===

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
    // Stage 13 soft-delete standard (replaces the Stage 2 handler-level 409):
    // "delete" tombstones the page — its facts remain and the RESTRICT FKs
    // (migration 0056) make an actual row DELETE structurally impossible on a
    // fact-bearing page. Same response shape as before.
    try {
      await deletePageByLabel(appContext.db, request.params.pageLabel);
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.page_soft_delete",
        metadata: { pageLabel: request.params.pageLabel },
      });
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
    const result = await updatePageCredentials(appContext, request.params.pageLabel, body);
    // Field names only — credential VALUES must never reach the audit/observation row.
    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.page_credentials_update",
      metadata: { pageLabel: request.params.pageLabel, fields: Object.keys(body) },
    });
    return result;
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

  // PATCH (the live editing path) rejects any key that is not wired to the runtime
  // overlay (`runtimeApply === 'live'`), so an override can never be written for a key
  // the runtime would not actually apply without a restart. Still required to be
  // `editable` (the policy class) — staged/boot flags use the separate staged endpoint.
  function assertLiveEditableReloadKey(key: string) {
    if (!LIVE_CONFIG_KEYS.has(key)) {
      throw new BadRequestError(`Config key is not runtime-editable: ${key}`);
    }
    const descriptor = getDescriptor(key);
    if (!descriptor) {
      throw new BadRequestError(`Unknown config key: ${key}`);
    }
    if (descriptor.editability !== "editable") {
      throw new BadRequestError(`Config key is not editable: ${key}`);
    }
    if (descriptor.runtimeApply !== "live") {
      throw new BadRequestError(`Config key does not apply at runtime: ${key}`);
    }
  }

  // DELETE clears ONLY an `editability === 'editable'` override (a stuck editable knob —
  // including a non-live editable tunable like ofapiDmDailyCreditBudget). It rejects
  // 'staged' and 'never' keys: a staged (boot) flag is reverted to env exclusively via the
  // staged endpoint (`desired: null`), which enforces the mandatory expectedVersion + ack
  // and the order/disable rules — the generic DELETE would bypass all of that.
  function assertClearableKey(key: string) {
    const descriptor = getDescriptor(key);
    if (!descriptor) {
      throw new BadRequestError(`Unknown config key: ${key}`);
    }
    if (descriptor.editability !== "editable") {
      throw new BadRequestError(`Config key is not editable: ${key}`);
    }
  }

  server.patch("/api/v1/admin/config", {
    schema: routeSchemas.adminConfigUpdate,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);

    const { patches, note } = request.body;
    // A key may appear at most once per patch — duplicates would double-audit / double-
    // bump the version (or self-conflict) inside the atomic apply.
    const keys = patches.map((patch) => patch.key);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestError("A patch may not set the same key twice");
    }
    // Validate every key/value up front so a bad entry rejects the whole patch before
    // anything is written. Persist the CLAMPED value so processes and UI agree.
    const validatedPatches = patches.map((patch) => {
      assertLiveEditableReloadKey(patch.key);
      const validated = validateConfigOverride(patch.key, patch.value);
      if (!validated.ok) {
        throw new BadRequestError(validated.error);
      }
      return { key: patch.key, value: validated.value, expectedVersion: patch.expectedVersion };
    });

    // Fold the patched keys' descriptor costWarnings into the audit note so the warning that
    // applied is durable evidence. The live path has no ack gate (unlike staged), so this is
    // its only durable cost record; derived from the registry server-side, never the client.
    const costWarnings = collectCostWarnings(validatedPatches.map((patch) => patch.key));
    const auditNote =
      Object.keys(costWarnings).length > 0
        ? `${note ? `${note} ` : ""}[cost-warnings] ${Object.entries(costWarnings)
            .map(([key, warning]) => `${key}: ${warning}`)
            .join("; ")}`
        : note;

    try {
      // One transaction, all-or-nothing: a conflict on any key rolls back every key.
      const results = await setConfigOverridesAtomic(appContext.db, {
        patches: validatedPatches,
        userId: principal.user.id,
        note: auditNote,
        groupId: randomUUID(),
      });
      await recordAudit(appContext, {
        ...auditCtx(principal),
        eventType: "admin.config_update",
        metadata: {
          keys: results.map((result) => ({ key: result.key, version: result.version })),
          note: auditNote ?? null,
        },
      });
      // The live PATCH only ever sends upserts (never a clear), so every result carries a
      // non-null value/version — narrow the atomic writer's (now nullable) shape back.
      return {
        results: results as Array<{ key: string; value: ConfigOverrideValue; version: number }>,
      };
    } catch (error) {
      if (error instanceof ConfigOverrideVersionConflictError) {
        throw new ConflictError(error.message);
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
    assertClearableKey(key);

    try {
      await clearConfigOverride(appContext.db, {
        key,
        expectedVersion: request.query.expectedVersion,
        userId: principal.user.id,
        note: request.query.note,
        groupId: randomUUID(),
      });
    } catch (error) {
      if (error instanceof ConfigOverrideVersionConflictError) {
        throw new ConflictError(error.message);
      }
      throw error;
    }

    await recordAudit(appContext, {
      ...auditCtx(principal),
      eventType: "admin.config_clear",
      metadata: { key, note: request.query.note ?? null },
    });
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
