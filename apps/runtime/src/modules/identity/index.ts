import { routeSchemas } from "@agency_hub_core/contracts";
import type { FastifyReply } from "fastify";

import { auditCtx } from "../../api/request-auth.ts";
import type { AppContext } from "../../bootstrap.ts";
import {
  createAccountLinkForUsername,
  createInvite,
  inspectAccountLink,
  listAccountLinksForUsername,
  redeemAccountLink,
  revokeAccountLinkForUsername,
} from "../../services/account-links.ts";
import { getOwnUsageReport } from "../../services/ai-usage.ts";
import {
  SESSION_COOKIE_NAME,
  assignPageToUser,
  activatePendingDeviceToken,
  changeOwnPassword,
  createUserAccount,
  deactivateUser,
  deviceTokenAdoptionReport,
  getAuthenticatedUserByUsername,
  grantModelToUser,
  issueChatterApiKey,
  issueDeviceToken,
  issueDeviceTokenForUsername,
  issueDeviceTokenWithPassword,
  reservePendingDeviceToken,
  listApiKeysForUsers,
  listDeviceTokensForUsername,
  listOwnDevices,
  listUserGrants,
  listUsersDetailed,
  loginWithPassword,
  logoutSessionToken,
  normalizeClientVersionHeader,
  reactivateUser,
  revokeAllOwnDevices,
  revokeCurrentDeviceToken,
  revokeDeviceTokenForUsername,
  revokeOwnDevice,
  requireOwner,
  requireSessionUser,
  revokeDeviceTokensForUsername,
  revokeModelFromUser,
  revokeUserApiKeys,
  setUserPassword,
  setDeviceTokenHarvestCapabilityForUsername,
  terminateAllAccess,
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
  const { requirePendingDeviceToken, requirePrincipal } = ctx.auth;

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
    // "Who am I" is a HUMAN answer: this response is a user record, and
    // requirePrincipal has already refused any agent key. An agent reads its own
    // identity from the agent plane's capabilities operation instead.
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
      mustChangePassword: request.body.mustChangePassword,
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

  server.post("/api/v1/admin/users/:username/deactivate", {
    schema: routeSchemas.adminDeactivateUser,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return deactivateUser(appContext, {
      username: request.params.username,
    }, auditCtx(principal));
  });

  server.post("/api/v1/admin/users/:username/reactivate", {
    schema: routeSchemas.adminReactivateUser,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return reactivateUser(appContext, {
      username: request.params.username,
    }, auditCtx(principal));
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

  // --- Stage 22: self-serve auth surface (any live session, any human role) ---

  server.post("/api/v1/auth/change-password", {
    schema: routeSchemas.authChangePassword,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return changeOwnPassword(appContext, {
      userId: principal.user.id,
      currentPassword: request.body.currentPassword,
      newPassword: request.body.newPassword,
    });
  });

  server.post("/api/v1/auth/device-tokens", {
    schema: routeSchemas.authIssueDeviceToken,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    const authSessionId = principal.authSessionId;
    const issued = await issueDeviceToken(appContext, {
      userId: principal.user.id,
      authSessionId,
      label: request.body.label,
    }, auditCtx(principal));
    return {
      token: issued.token,
      id: issued.id,
      label: issued.label,
      keyPrefix: issued.keyPrefix,
      expiresAt: issued.expiresAt.toISOString(),
    };
  });

  server.post("/api/v1/auth/device-tokens/reservations", {
    schema: routeSchemas.authReserveDeviceToken,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    const authSessionId = principal.authSessionId;
    const reserved = await reservePendingDeviceToken(appContext, {
      userId: principal.user.id,
      authSessionId,
      label: request.body.label,
    }, auditCtx(principal));
    return {
      token: reserved.token,
      reservationId: reserved.reservationId,
      label: reserved.label,
      keyPrefix: reserved.keyPrefix,
      reservationExpiresAt: reserved.reservationExpiresAt.toISOString(),
    };
  });

  server.post("/api/v1/auth/device-tokens/activate", {
    schema: routeSchemas.authActivateDeviceToken,
  }, async (request) => {
    const credential = await requirePendingDeviceToken(request);
    const activated = await activatePendingDeviceToken(appContext, credential);
    return {
      id: activated.id,
      label: activated.label,
      keyPrefix: activated.keyPrefix,
      expiresAt: activated.expiresAt.toISOString(),
    };
  });

  server.delete("/api/v1/auth/device-tokens/current", {
    schema: routeSchemas.authRevokeCurrentDeviceToken,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return revokeCurrentDeviceToken(appContext, principal, auditCtx(principal));
  });

  // --- Stage 22: device-token + grant admin (owner) ---

  server.get("/api/v1/admin/users/:username/device-tokens", {
    schema: routeSchemas.adminListDeviceTokens,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listDeviceTokensForUsername(appContext, request.params.username);
  });

  server.post("/api/v1/admin/users/:username/device-tokens", {
    schema: routeSchemas.adminIssueDeviceToken,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    const issued = await issueDeviceTokenForUsername(appContext, {
      username: request.params.username,
      label: request.body.label,
    }, auditCtx(principal));
    return {
      token: issued.token,
      id: issued.id,
      label: issued.label,
      keyPrefix: issued.keyPrefix,
      expiresAt: issued.expiresAt.toISOString(),
    };
  });

  server.patch("/api/v1/admin/users/:username/device-tokens/:tokenId/harvest-capability", {
    schema: routeSchemas.adminSetDeviceTokenHarvestCapability,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return setDeviceTokenHarvestCapabilityForUsername(appContext, {
      username: request.params.username,
      deviceTokenId: request.params.tokenId,
      machineId: request.body.machineId,
    }, auditCtx(principal));
  });

  server.delete("/api/v1/admin/users/:username/device-tokens", {
    schema: routeSchemas.adminRevokeDeviceTokens,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return revokeDeviceTokensForUsername(appContext, {
      username: request.params.username,
    }, auditCtx(principal));
  });

  server.get("/api/v1/admin/device-token-adoption", {
    schema: routeSchemas.adminDeviceTokenAdoption,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return deviceTokenAdoptionReport(appContext);
  });

  server.post("/api/v1/admin/users/:username/models", {
    schema: routeSchemas.adminGrantModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return grantModelToUser(appContext, {
      username: request.params.username,
      modelSlug: request.body.modelSlug,
    }, auditCtx(principal));
  });

  server.delete("/api/v1/admin/users/:username/models/:modelSlug", {
    schema: routeSchemas.adminRevokeModel,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return revokeModelFromUser(appContext, {
      username: request.params.username,
      modelSlug: request.params.modelSlug,
    }, auditCtx(principal));
  });

  server.get("/api/v1/admin/users/:username/grants", {
    schema: routeSchemas.adminListUserGrants,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return { grants: await listUserGrants(appContext, request.params.username) };
  });

  // --- Decision 347: unified chatter account (PR-1A) ---
  // Legacy in-handler guards mirror the declared policy (#143 dual layer):
  // owner-session for the console, any-session for the cabinet, public for the
  // three link / sign-in routes, which are rate-limited per IP.

  server.post("/api/v1/admin/invites", {
    schema: routeSchemas.adminCreateInvite,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return createInvite(appContext, {
      username: request.body.username,
      role: request.body.role,
      pageLabels: request.body.pageLabels,
      expiresInHours: request.body.expiresInHours,
    }, auditCtx(principal));
  });

  server.post("/api/v1/admin/users/:username/links", {
    schema: routeSchemas.adminCreateAccountLink,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return createAccountLinkForUsername(appContext, {
      username: request.params.username,
      kind: request.body.kind,
      expiresInHours: request.body.expiresInHours,
    }, auditCtx(principal));
  });

  server.get("/api/v1/admin/users/:username/links", {
    schema: routeSchemas.adminListAccountLinks,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return listAccountLinksForUsername(appContext, request.params.username);
  });

  server.post("/api/v1/admin/users/:username/links/:linkId/revoke", {
    schema: routeSchemas.adminRevokeAccountLink,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return revokeAccountLinkForUsername(appContext, {
      username: request.params.username,
      linkId: request.params.linkId,
    }, auditCtx(principal));
  });

  server.delete("/api/v1/admin/users/:username/device-tokens/:tokenId", {
    schema: routeSchemas.adminRevokeDeviceToken,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return revokeDeviceTokenForUsername(appContext, {
      username: request.params.username,
      deviceTokenId: request.params.tokenId,
    }, auditCtx(principal));
  });

  server.post("/api/v1/admin/users/:username/terminate-access", {
    schema: routeSchemas.adminTerminateAllAccess,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireOwner(principal);
    return terminateAllAccess(appContext, {
      username: request.params.username,
    }, auditCtx(principal));
  });

  // Public link routes: the token travels in the body only (never the path, so
  // it never reaches an access log); per-IP limits bound guessing.
  server.post("/api/v1/auth/links/inspect", {
    schema: routeSchemas.authInspectAccountLink,
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (request) => {
    return inspectAccountLink(appContext, request.body.token);
  });

  server.post("/api/v1/auth/links/redeem", {
    schema: routeSchemas.authRedeemAccountLink,
    config: { rateLimit: { max: 10, timeWindow: 60_000 } },
  }, async (request) => {
    return redeemAccountLink(appContext, {
      token: request.body.token,
      password: request.body.password,
    });
  });

  // Р2: the single client sign-in — no cookie, one call, active or pending.
  server.post("/api/v1/auth/device-tokens/password", {
    schema: routeSchemas.authIssueDeviceTokenWithPassword,
    config: { rateLimit: { max: 20, timeWindow: 60_000 } },
  }, async (request) => {
    const issued = await issueDeviceTokenWithPassword(appContext, {
      username: request.body.username,
      password: request.body.password,
      label: request.body.label,
      mode: request.body.mode,
      clientVersion: normalizeClientVersionHeader(request.headers["x-client-version"]),
    });
    return issued.mode === "active"
      ? {
        mode: "active" as const,
        token: issued.token,
        id: issued.id,
        label: issued.label,
        keyPrefix: issued.keyPrefix,
        expiresAt: issued.expiresAt.toISOString(),
      }
      : {
        mode: "pending" as const,
        token: issued.token,
        reservationId: issued.reservationId,
        label: issued.label,
        keyPrefix: issued.keyPrefix,
        reservationExpiresAt: issued.reservationExpiresAt.toISOString(),
      };
  });

  // Cabinet (any live cookie session, any human role).
  server.get("/api/v1/auth/devices", {
    schema: routeSchemas.authListDevices,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return listOwnDevices(appContext, principal);
  });

  server.delete("/api/v1/auth/devices/:deviceId", {
    schema: routeSchemas.authRevokeDevice,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return revokeOwnDevice(appContext, principal, {
      deviceId: request.params.deviceId,
    }, auditCtx(principal));
  });

  server.post("/api/v1/auth/devices/revoke-all", {
    schema: routeSchemas.authRevokeAllDevices,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return revokeAllOwnDevices(appContext, principal, auditCtx(principal));
  });

  server.get("/api/v1/auth/usage", {
    schema: routeSchemas.authMyUsage,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    requireSessionUser(principal);
    return getOwnUsageReport(appContext, principal, request.query);
  });
}
