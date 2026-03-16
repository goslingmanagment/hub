import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  routeSchemas,
  type RevenueDailyTypedItem,
} from "@agency_hub_core/contracts";
import {
  countDistinctFansForPages,
  createFanNote,
  createModel,
  findPlatformFan,
  getLatestSyncRunPerPage,
  getRevenueBreakdownForScope,
  getRevenuePageTotals,
  listFanFlags,
  listFanPageContexts,
  listFanTransactionsCrossPage,
  listFanTransactionsOnPage,
  listRevenueDailyForPages,
  listTransactionsForScope,
  listSubscriberDailyForPage,
  listFollowerTotalsForPages,
  listSubscriberTotalsForPages,
  listVisiblePages,
  setFanFlags,
} from "@agency_hub_core/db";
import {
  createLogger,
  millsToNumber,
  redactSensitiveText,
  resolveBusinessDateRangeForPlatform,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  toMills,
  type Period,
  type Platform,
} from "@agency_hub_core/shared";
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
import { listConnectionStatuses, updatePageCredentials } from "../services/connections.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../services/errors.ts";
import { resolvePageContext } from "../services/page-context.ts";
import {
  getCrossPageFanDetailReport,
  getModelRevenueReport,
  getOverviewRevenueReport,
  getPageFanDetailReport,
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
  getSpenderBatch,
  getSpenderDetail,
  getSpenderList,
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
import { onboardFanslyPage, onboardOnlyFansPage } from "../services/page-onboarding.ts";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthPrincipal | null;
  }
}

function isProduction() {
  return process.env.NODE_ENV === "production";
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
    secure: isProduction(),
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

function serializeEpochMillisecondsTimestamp(value: Date | string | number | bigint) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(Number(value)).toISOString();
}

function toNumber(value: number | string | bigint) {
  return typeof value === "number" ? value : Number(value);
}

export async function buildApiServer(appContext: AppContext) {
  const server = Fastify({
    loggerInstance: appContext.logger ?? createLogger(appContext.config.logLevel),
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
        },
      },
    },
    transform: createJsonSchemaTransform({
      skipList: ["/documentation", "/documentation/static/*"],
    }),
    transformObject: jsonSchemaTransformObject,
  });
  await server.register(swaggerUi, {
    routePrefix: "/documentation",
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
    if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length).trim();
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
  }, async () => ({
    status: "ok" as const,
  }));

  server.post("/api/v1/auth/login", {
    schema: routeSchemas.login,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 60_000,
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
    requireDashboardUser(principal);
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
    const fanCount = await countDistinctFansForPages(appContext.db, pageIds);
    const connectionStatuses = await listConnectionStatuses(appContext, {
      pageIds: pageScope,
      pages,
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

    return {
      counts: {
        models: modelSet.size,
        pages: pages.length,
        fans: fanCount,
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
      pages: pages.map((p) => {
        const status = statusByPageId.get(p.id);
        return {
          id: p.id,
          label: p.label,
          platform: p.platform,
          modelSlug: p.modelSlug,
          modelName: p.modelName,
          username: p.username,
          subscriberCount: p.subscriberCount,
          followerCount: p.followerCount,
          revenueTodayMills: millsToNumber(pageTotalsToday.get(p.id) ?? 0n),
          revenue7dMills: millsToNumber(pageTotals7d.get(p.id) ?? 0n),
          revenue30dMills: millsToNumber(pageTotals30d.get(p.id) ?? 0n),
          newSubscribersToday: pageNewSubsToday.get(p.id) ?? 0,
          newFollowersToday: pageNewFollowersToday.get(p.id) ?? 0,
          connectionStatus: status?.connectionStatus ?? "unverified",
          lastLightSyncAt: p.lastLightSyncAt?.toISOString() ?? null,
          lastFollowerSyncAt: p.lastFollowerSyncAt?.toISOString() ?? null,
          lastSyncError: status?.lastSyncError ?? null,
        };
      }),
      setup: {
        hasPages: pages.length > 0,
        hasFanslyPages: pages.some((p) => p.platform === "fansly"),
        hasOnlyFansPages: pages.some((p) => p.platform === "onlyfans"),
      },
    };
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
      const range = resolveBusinessDateRangeForPlatform(
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
    requireDashboardUser(principal);
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
  }, async () => {
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
      revokedAt: k.revokedAt?.toISOString() ?? null,
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

  server.post("/api/v1/admin/models", {
    schema: routeSchemas.adminCreateModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const model = await createModel(appContext.db, request.body);
    return { id: model.id, slug: model.slug, name: model.name };
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
      if (!boss) throw new Error("Job queue not available");
      try {
        await requestPageSync(appContext, boss, {
          pageLabel: body.label,
          scope: "all",
          reason: "onboarding",
        });
      } catch (error) {
        request.log.error({ err: error, pageLabel: body.label }, "Failed to queue initial sync for created page");
        throw new ServiceUnavailableError(
          `Page "${body.label}" was created, but the automatic sync could not be queued`,
        );
      }
      const page = await getPageSummary(appContext, body.label);
      return {
        page: {
          id: page.id,
          label: page.label,
          platform: page.platform,
          username: page.username,
          displayName: page.displayName,
          followerCount: page.followerCount,
          subscriberCount: page.subscriberCount,
          lastLightSyncAt: page.lastLightSyncAt?.toISOString() ?? null,
          lastFollowerSyncAt: page.lastFollowerSyncAt?.toISOString() ?? null,
          modelSlug: page.modelSlug,
          modelName: page.modelName,
        },
        verified: true,
      };
    } else {
      await onboardOnlyFansPage(appContext, {
        modelSlug: body.modelSlug,
        label: body.label,
        auth: body.auth,
        username: body.username,
        proxy: body.proxy ?? null,
      });
      if (!boss) throw new Error("Job queue not available");
      try {
        await requestPageSync(appContext, boss, {
          pageLabel: body.label,
          scope: "all",
          reason: "onboarding",
        });
      } catch (error) {
        request.log.error({ err: error, pageLabel: body.label }, "Failed to queue initial sync for created page");
        throw new ServiceUnavailableError(
          `Page "${body.label}" was created, but the automatic sync could not be queued`,
        );
      }
      const page = await getPageSummary(appContext, body.label);
      return {
        page: {
          id: page.id,
          label: page.label,
          platform: page.platform,
          username: page.username,
          displayName: page.displayName,
          followerCount: page.followerCount,
          subscriberCount: page.subscriberCount,
          lastLightSyncAt: page.lastLightSyncAt?.toISOString() ?? null,
          lastFollowerSyncAt: page.lastFollowerSyncAt?.toISOString() ?? null,
          modelSlug: page.modelSlug,
          modelName: page.modelName,
        },
        verified: true,
      };
    }
  });

  server.post("/api/v1/admin/credentials/verify", {
    schema: routeSchemas.adminVerifyCredentials,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const body = request.body;
    try {
      if (body.platform === "fansly") {
        const result = await appContext.adapter.verifySession({
          session: body.session,
          proxy: body.proxy ?? null,
        });
        return {
          valid: true as const,
          platform: "fansly" as const,
          username: result.parsed.account.username,
          displayName: result.parsed.account.displayName,
        };
      } else {
        const { findOnlyFansAccountByUsername } = await import("../services/onlyfans.ts");
        const context = { auth: body.auth, proxy: body.proxy ?? null };
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
      return {
        verified: true,
        username: pageContext.page.username,
        platform: pageContext.platform,
      };
    } catch (error) {
      throw new BadRequestError(
        `Page verification failed: ${redactSensitiveText(error instanceof Error ? error.message : "Unknown error")}`,
      );
    }
  });

  server.patch("/api/v1/admin/pages/:pageLabel/credentials", {
    schema: routeSchemas.adminUpdateCredentials,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return updatePageCredentials(appContext, request.params.pageLabel, request.body as any);
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

    const rows = severity
      ? (await appContext.db.execute(sql`
          SELECT e.id, e.sync_run_id as "syncRunId",
                 e.provider, e.stream, e.event_type as "eventType",
                 e.severity, e.message, e.details,
                 e.emitted_at as "emittedAt",
                 pa.label as "pageLabel"
          FROM sync_run_events e
          INNER JOIN sync_runs sr ON sr.id = e.sync_run_id
          INNER JOIN platform_accounts pa ON pa.id = e.platform_account_id
          WHERE e.severity = ${severity}
          ORDER BY e.emitted_at DESC
          LIMIT ${limit}
        `)).rows
      : (await appContext.db.execute(sql`
          SELECT e.id, e.sync_run_id as "syncRunId",
                 e.provider, e.stream, e.event_type as "eventType",
                 e.severity, e.message, e.details,
                 e.emitted_at as "emittedAt",
                 pa.label as "pageLabel"
          FROM sync_run_events e
          INNER JOIN sync_runs sr ON sr.id = e.sync_run_id
          INNER JOIN platform_accounts pa ON pa.id = e.platform_account_id
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
        SELECT id, hash, created_at::bigint as "createdAtMs"
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at ASC
      `)).rows;
      migrations = migrationRows.map((r: any) => ({
        id: toNumber(r.id),
        hash: r.hash,
        createdAt: serializeEpochMillisecondsTimestamp(r.createdAtMs),
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

    let condition = sql`(e.severity IN ('warn', 'error') OR e.event_type = 'anomaly')`;
    if (severity) condition = sql`${condition} AND e.severity = ${severity}`;
    if (code) condition = sql`${condition} AND e.details->>'code' = ${code}`;

    const items = (await appContext.db.execute(sql`
      SELECT e.id, e.sync_run_id as "syncRunId",
             e.provider, e.stream, e.event_type as "eventType",
             e.severity, e.message, e.details,
             e.emitted_at as "emittedAt",
             pa.label as "pageLabel"
      FROM sync_run_events e
      INNER JOIN sync_runs sr ON sr.id = e.sync_run_id
      INNER JOIN platform_accounts pa ON pa.id = e.platform_account_id
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
      SELECT e.details->>'code' as "code", e.severity, count(*)::int as "count"
      FROM sync_run_events e
      WHERE (e.severity IN ('warn', 'error') OR e.event_type = 'anomaly')
        AND e.emitted_at > now() - interval '7 days'
      GROUP BY e.details->>'code', e.severity
      ORDER BY count DESC
      LIMIT 20
    `)).rows.map((r: any) => ({
      code: r.code,
      severity: r.severity,
      count: toNumber(r.count),
    }));

    return { summary, items };
  });

  // SPA static file serving (production only)
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const dashboardDist = resolve(import.meta.dirname, "../../dashboard/dist");
  if (existsSync(dashboardDist)) {
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
