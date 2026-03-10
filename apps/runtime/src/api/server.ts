import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  routeSchemas,
} from "@fansly-connect/contracts";
import { createLogger } from "@fansly-connect/shared";
import type { FastifyReply } from "fastify";
import Fastify from "fastify";
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
  authenticateApiKeyToken,
  authenticateSessionToken,
  canAccessPage,
  loginWithPassword,
  logoutSessionToken,
  requireDashboardUser,
  SESSION_COOKIE_NAME,
  type AuthPrincipal,
} from "../services/auth.ts";
import { AppError, ForbiddenError, UnauthorizedError } from "../services/errors.ts";
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

export async function buildApiServer(appContext: AppContext) {
  const server = Fastify({
    loggerInstance: appContext.logger ?? createLogger(appContext.config.logLevel),
  }).withTypeProvider<ZodTypeProvider>();

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.decorateRequest("auth");

  await server.register(cookie);
  await server.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Fansly Connect API",
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

  return server;
}
