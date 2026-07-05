import { routeSchemas } from "@agency_hub_core/contracts";
import type { FastifyReply } from "fastify";

import { auditCtx } from "../../api/request-auth.ts";
import type { AppContext } from "../../bootstrap.ts";
import {
  SESSION_COOKIE_NAME,
  assignPageToUser,
  createUserAccount,
  getAuthenticatedUserByUsername,
  issueChatterApiKey,
  listApiKeysForUsers,
  listUsersDetailed,
  loginWithPassword,
  logoutSessionToken,
  requireOwner,
  revokeUserApiKeys,
  setUserPassword,
  unassignPageFromUser,
} from "../../services/auth.ts";
import { NotFoundError } from "../../services/errors.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Identity module (target §6.1): auth, sessions, users, api-keys. Handlers
// relocated verbatim from server.ts (Stage 19 Task 3); guards stay until the
// post-enforce-flip cleanup.

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

export function registerIdentityRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  server.post("/api/v1/auth/login", {
    schema: routeSchemas.login,
    config: {
      // Pure per-IP bound against cross-account spraying (audit B7). The
      // plugin runs at onRequest, before the body is parsed, so an IP key is
      // the only honest key here; per-account brute force is handled by the
      // escalating backoff inside loginWithPassword. request.ip is only
      // meaningful behind a proxy when TRUST_PROXY narrows trust to the
      // actual hops — see .env.production.example.
      rateLimit: {
        max: 20,
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
}
