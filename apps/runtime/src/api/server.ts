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
  type RouteAuthPolicy,
} from "../../../../packages/contracts/src/routes.ts";
import {
  getLatestSyncRunPerPage,
  listFanFlags,
  listSubscriberDailyForPage,
} from "@agency_hub_core/db";
import {
  createLogger,
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
  canAccessPage,
  requireOwner,
  SESSION_COOKIE_NAME,
  type AuthPrincipal,
} from "../services/auth.ts";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../services/errors.ts";
import {
  buildRoutePolicyIndex,
  classifyAuthPolicyDivergence,
  computeAuthPolicyVerdict,
  type AuthPolicyVerdict,
  type RoutePolicyTableRow,
} from "./auth-policy.ts";
import { createRequestAuth } from "./request-auth.ts";
import type { ApiModuleContext } from "../modules/context.ts";
import { registerAudienceRoutes } from "../modules/audience/index.ts";
import { registerCatalogRoutes } from "../modules/catalog/index.ts";
import { registerAiAdminRoutes, registerAiRoutes } from "../modules/ai/index.ts";
import { registerConversationsRoutes } from "../modules/conversations/index.ts";
import { registerEventsRoutes } from "../modules/events/index.ts";
import { registerFinanceRoutes } from "../modules/finance/index.ts";
import { registerIdentityRoutes } from "../modules/identity/index.ts";
import { registerIngestRoutes } from "../modules/ingest/index.ts";
import { registerOpsRoutes } from "../modules/ops/index.ts";
import { registerWorkboardRoutes } from "../modules/workboard/index.ts";
import {
  findPageSummaryByLabel,
  getNotificationIncidentByKey,
} from "@agency_hub_core/db";
import { getSyncStatusSnapshot } from "../services/sync-status.ts";
import {
  ensureSyncQueues,
} from "../services/sync-queue.ts";
import { recordClientVersionObservation } from "../services/client-versions.ts";
import { ensureOfapiCommandQueues } from "../services/ofapi-command-executor.ts";
import { ensureOfapiQueues } from "../services/ofapi-events.ts";

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
  const MUST_CHANGE_PASSWORD_ALLOWED_ROUTES = new Set(["me", "logout", "authChangePassword"]);
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

    // Stage 22: a session flagged must_change_password may only touch the
    // self-serve auth surface. Enforced UNCONDITIONALLY (new behavior, no
    // legacy guard to diverge from — the log-mode comparison doesn't apply).
    const pendingPrincipal = request.auth;
    if (
      pendingPrincipal
      && pendingPrincipal.authMethod === "session"
      && pendingPrincipal.user.mustChangePassword
      && !MUST_CHANGE_PASSWORD_ALLOWED_ROUTES.has(entry.key)
    ) {
      throw new ForbiddenError("Password change required before using this route");
    }

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
    boss = new PgBoss({
      connectionString: appContext.config.databaseUrl,
      // Stage 25: the api enqueues only; cron belongs to the scheduler role.
      schedule: false,
    });
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

  // --- Ops (health/sync/credits/diagnostics) --- (module: apps/runtime/src/modules/ops)
  registerOpsRoutes(server, moduleContext);

  // --- Identity (auth/sessions/users/api-keys) --- (module: apps/runtime/src/modules/identity)
  registerIdentityRoutes(server, moduleContext);

  // --- AI (gateway/usage) --- (module: apps/runtime/src/modules/ai)
  registerAiRoutes(server, moduleContext);
  registerAiAdminRoutes(server, moduleContext);

  // --- Ingest (webhook/capture/custody lanes) --- (module: apps/runtime/src/modules/ingest)
  await registerIngestRoutes(server, moduleContext);

  // --- Catalog (models/pages/credentials/proxies) --- (module: apps/runtime/src/modules/catalog)
  registerCatalogRoutes(server, moduleContext);

  // --- Finance (revenue/transactions/spenders/reporting) --- (module: apps/runtime/src/modules/finance)
  registerFinanceRoutes(server, moduleContext);

  // --- Audience (fans/subs/follows/growth) --- (module: apps/runtime/src/modules/audience)
  registerAudienceRoutes(server, moduleContext);

  // --- Conversations (profiles/threads/archive) --- (module: apps/runtime/src/modules/conversations)
  registerConversationsRoutes(server, moduleContext);

  // --- Workboard --- (module: apps/runtime/src/modules/workboard)
  registerWorkboardRoutes(server, moduleContext);

  // --- Phase 4: Dashboard + Admin routes ---

  // --- OFAPI webhook receiver + SSE sync-event fanout (ChatMuse real-time) ---

  // --- Events (stream + snapshot) --- (module: apps/runtime/src/modules/events)
  registerEventsRoutes(server, moduleContext);

  // OpenAPI JSON
  server.get("/api/v1/openapi.json", {
    schema: routeSchemas.openApiJson,
  }, async (request) => {
    await requireOpenApiDocsOwner(request);
    return normalizeOpenApiDocument(server.swagger() as Record<string, any>);
  });

  // === Admin routes ===

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
