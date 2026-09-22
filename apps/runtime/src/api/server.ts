import { registerOfapiVendorRoutes } from "../modules/ofapi-vendor/index.ts";
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
import { createLogger } from "@agency_hub_core/shared";
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
  isAgentPrincipal,
  principalLogFields,
  requireOwner,
  SESSION_COOKIE_NAME,
  type AuthFailure,
  type AuthPrincipal,
  type PendingDeviceTokenActivationCredential,
} from "../services/auth.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OfapiCollectionRefusedError,
  SnapshotRestartRequiredError,
  TooManyRequestsError,
  UnauthorizedError,
} from "../services/errors.ts";
import {
  buildRoutePolicyIndex,
  classifyAuthPolicyDivergence,
  computeAuthPolicyVerdict,
  type AuthPolicyVerdict,
  type RoutePolicyEntry,
  type RoutePolicyTableRow,
} from "./auth-policy.ts";
import { formatRequestValidationMessage } from "./error-boundary.ts";
import { createRequestAuth, unauthorizedFor } from "./request-auth.ts";
import type { ApiModuleContext } from "../modules/context.ts";
import { registerAgentReadRoutes } from "../modules/agent-read/index.ts";
import { registerAudienceRoutes } from "../modules/audience/index.ts";
import { registerCatalogRoutes } from "../modules/catalog/index.ts";
import { registerAiAdminRoutes, registerAiRoutes } from "../modules/ai/index.ts";
import { registerConversationsRoutes } from "../modules/conversations/index.ts";
import { registerEventsRoutes } from "../modules/events/index.ts";
import { registerFinanceRoutes } from "../modules/finance/index.ts";
import { registerIdentityRoutes } from "../modules/identity/index.ts";
import { registerIngestRoutes } from "../modules/ingest/index.ts";
import { registerInsightsRoutes } from "../modules/insights/index.ts";
import { registerOpsRoutes } from "../modules/ops/index.ts";
import { registerVoiceRoutes } from "../modules/voice/index.ts";
import { findPageSummaryByLabel } from "@agency_hub_core/db";
import {
  ensureSyncQueues,
  reconcileQueueRetention,
} from "../services/sync-queue.ts";
import { recordClientVersionObservation } from "../services/client-versions.ts";
import { ensureOfapiCommandQueues } from "../services/ofapi-command-executor.ts";
import { ensureOfapiQueues } from "../services/ofapi-events.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    hubAuthPolicy?: RoutePolicyEntry;
  }
  interface FastifyRequest {
    auth?: AuthPrincipal | null;
    authFailure?: AuthFailure | null;
    pendingDeviceTokenAuth?: PendingDeviceTokenActivationCredential | null;
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

export function normalizeOpenApiDocument<T extends Record<string, unknown>>(spec: T): T {
  // Deterministic path order: swagger emits paths in ROUTE REGISTRATION order,
  // which the Stage 19 module extraction shuffles as handlers relocate. Sorting
  // decouples the published document (and the api-types diff gate) from where a
  // route happens to register.
  if (spec.paths && typeof spec.paths === "object") {
    (spec as Record<string, unknown>).paths = Object.fromEntries(
      Object.entries(spec.paths as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  }

  const paths = spec.paths as
    | Record<
        string,
        | { get?: { responses?: Record<string, { content?: Record<string, unknown> } | undefined> } }
        | undefined
      >
    | undefined;
  const csvResponse = paths?.["/api/v1/admin/ofapi/credits/ledger.csv"]
    ?.get?.responses?.["200"];
  const jsonContent = csvResponse?.content?.["application/json"];
  if (csvResponse && jsonContent) {
    csvResponse.content = {
      "text/csv": jsonContent,
    };
  }

  // Voice-note audio (Task 6): the handler writes raw audio/mpeg bytes, but the
  // Zod Fastify transformer only accepts a Zod schema for the 200 body, so the
  // route declares z.string() and we rewrite the media type here. OpenAPI paths
  // use `{param}` brace syntax.
  const audioResponse = paths?.["/api/v1/pages/{pageLabel}/voice-notes/{id}/audio"]
    ?.get?.responses?.["200"];
  const audioJsonContent = audioResponse?.content?.["application/json"] as
    | { schema?: Record<string, unknown> }
    | undefined;
  if (audioResponse && audioJsonContent) {
    // The Zod transformer only accepts a Zod schema for the body, so the route
    // declares z.string() → a bare `type: string`. Rewrite it to the OpenAPI
    // binary payload so external generators decode the MP3 as bytes, not text.
    audioResponse.content = {
      "audio/mpeg": {
        ...audioJsonContent,
        schema: { ...(audioJsonContent.schema ?? {}), type: "string", format: "binary" },
      },
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
  server.decorateRequest("authFailure");
  server.decorateRequest("pendingDeviceTokenAuth");
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
    // The plugin THROWS whatever this returns (@fastify/rate-limit index.js:
    // `throw params.errorResponseBuilder(req, respCtx)`), so the value has to
    // survive the error boundary. It used to be a plain `{error, message,
    // statusCode}` literal, which only reached the client because the boundary
    // had a duck-typed passthrough; #184 removed that passthrough on purpose
    // and this became a 500 — brute-force replies said "internal error"
    // instead of "rate limited", so clients retried on the wrong semantics.
    // An AppError is the boundary's own contract: same wire shape as before,
    // no duck-typing reintroduced.
    // Neutral wording (Decision 349 §2): the limiter now guards link
    // inspection and redemption as well as the two sign-in routes.
    errorResponseBuilder: () => new TooManyRequestsError("Too many attempts"),
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
          // The Agent Read Plane key. A SEPARATE scheme from bearerAuth even
          // though both travel in `Authorization: Bearer`: merging them would
          // publish a contract claiming a chatter api key can call the agent
          // plane, which is exactly what the middleware refuses.
          agentKeyAuth: {
            type: "http",
            scheme: "bearer",
            description: "Agent Read Plane key (prefix agency_hub_agent_)",
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
    resolvePendingDeviceToken,
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
  const isAuthPolicyEnforced = () => appContext.config.authPolicyEnforcement === "enforce";

  // Route → declaration table, collected at registration time. Feeds the
  // generated authorization-policy document (and Stage 20's SDK generator needs
  // the same method/path introspection).
  const routePolicyTable: RoutePolicyTableRow[] = [];
  server.decorate("routePolicyTable", routePolicyTable);
  const isApiRoute = (url: string | undefined) => url === "/api" || url?.startsWith("/api/") === true;
  server.addHook("onRoute", (route) => {
    const entry = routePolicyIndex.get(route.schema);
    if (!entry) {
      if (isApiRoute(route.url)) {
        throw new Error(`API route ${route.url} must use a registered contract schema`);
      }
      return;
    }
    if (!entry.auth) {
      throw new Error(`API route ${route.url} has no authorization declaration`);
    }
    if (entry.auth.scope === "page" && !route.url.split("/").includes(":pageLabel")) {
      throw new Error(`Page-scoped API route ${route.url} must declare :pageLabel`);
    }
    // Resolve schema identity once, while registering. Keep plugin settings
    // (rate limits, etc.) and bind the same policy to Fastify's HEAD twin.
    route.config = { ...route.config, hubAuthPolicy: entry };
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === "HEAD") {
        continue; // fastify's auto-added HEAD twin of every GET
      }
      routePolicyTable.push({ method, url: route.url, routeKey: entry.key, auth: entry.auth });
    }
  });

  server.addHook("onRequest", async (request) => {
    const entry = request.routeOptions.config.hubAuthPolicy;
    if (!entry) {
      if (isApiRoute(request.routeOptions.url)) {
        request.log.error({ path: request.routeOptions.url }, "auth-policy: API route has no authorization binding");
        if (isAuthPolicyEnforced()) {
          throw new ForbiddenError("Route has no authorization binding");
        }
      }
      return; // documentation/static routes and unmatched requests retain their own handling
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
      resolvePendingDeviceToken: async () => (await resolvePendingDeviceToken(request)) !== null,
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

    // Decision 370: the Stage 22 must_change_password route allowlist is gone
    // with the flag. Nothing reads the column any more; `mustChangePassword` on
    // the wire is a deprecated constant `false`.

    if (!verdict.allow && isAuthPolicyEnforced()) {
      switch (verdict.statusCode) {
        case 401:
          // Decision 349 §4.5: the device-token lane's structured reason
          // travels on the middleware's 401 exactly as on the handler's.
          throw unauthorizedFor(request);
        case 404:
          // The message names the label for a HUMAN (the dashboard's own error
          // states read it) and is STATIC for an agent: on the read plane a page
          // outside the grant and a page that does not exist must be byte-for-byte
          // the same answer, and this refusal happens BEFORE the handler, so it
          // has to match the handler's own static 404 exactly.
          throw request.auth && isAgentPrincipal(request.auth)
            ? new NotFoundError()
            : new NotFoundError(`Page "${pageLabelParam}" was not found`);
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
      // Identity fields per principal variant: an agent key logs its key id, a
      // human logs the user — neither borrows the other's shape.
      ...(request.auth ? principalLogFields(request.auth) : {}),
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
      // S7: job deletion only happens on a maintenance pass, so the effective
      // cadence is deleteAfterSeconds PLUS up to one interval. pg-boss defaults
      // this to 24h, which would double the 24h heartbeat retention pinned in
      // services/queue-retention.ts. Must match the worker and scheduler roles.
      maintenanceIntervalSeconds: 3600,
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
    // S7: LAST, after every queue this role creates exists — updateQueue on a
    // queue that has not been created yet matches zero rows.
    await reconcileQueueRetention(boss);
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
        message: formatRequestValidationMessage(error, [
          request.body,
          request.query,
          request.params,
        ]),
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

    if (error instanceof SnapshotRestartRequiredError) {
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
        replayFloor: error.replayFloor,
        snapshotPath: error.snapshotPath,
      });
      return;
    }

    if (error instanceof OfapiCollectionRefusedError) {
      // Documented structured extension (docs/error-handling.md §3): the
      // machine reason and, for a time-bound cap, the reset advice.
      if (error.retryAfterMs !== null) {
        reply.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
      }
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
        reason: error.reason,
        retryAfterMs: error.retryAfterMs,
      });
      return;
    }

    if (
      (error instanceof UnauthorizedError
        || error instanceof ConflictError
        || error instanceof BadRequestError)
      && error.reason !== null
    ) {
      // Documented structured extension (docs/error-handling.md §3): the
      // machine `reason` beside the code — token_revoked | token_expired on a
      // 401 for a presented device token, used | expired | revoked on the
      // account-link 409, too_short | too_long | common on the redeem 400.
      // A reason-less error keeps the plain envelope.
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
        reason: error.reason,
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

  // --- Voice notes (page-scoped render/status/audio) --- (module: apps/runtime/src/modules/voice)
  registerVoiceRoutes(server, moduleContext);

  // --- Phase 4: Dashboard + Admin routes ---

  // --- OFAPI webhook receiver + SSE sync-event fanout (ChatMuse real-time) ---

  // --- Insights (WP-S1 endpoints-cover serving: stats/content/money reads) ---
  // (module: apps/runtime/src/modules/insights). READ-ONLY: serving never
  // authorizes capture.
  registerInsightsRoutes(server, moduleContext);

  // --- Agent Read Plane (operations 1-10) --- (module: apps/runtime/src/modules/agent-read)
  registerAgentReadRoutes(server, moduleContext);

  // --- Events (stream + snapshot) --- (module: apps/runtime/src/modules/events)
  registerEventsRoutes(server, moduleContext);
  registerOfapiVendorRoutes(server, moduleContext);

  // OpenAPI JSON
  server.get("/api/v1/openapi.json", {
    schema: routeSchemas.openApiJson,
  }, async (request) => {
    await requireOpenApiDocsOwner(request);
    return normalizeOpenApiDocument(server.swagger() as unknown as Record<string, unknown>);
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
