import argon2 from "argon2";

import {
  assignUserToPage,
  createApiKey,
  createAuthSession,
  createUser,
  deleteExpiredAuthSessions,
  findActiveApiKeysForUser,
  findApiKeyByDigest,
  findAuthSessionByDigest,
  findUserById,
  findUserByUsername,
  insertAuditEvent,
  listApiKeys,
  listUserPageAssignments,
  listUsers,
  revokeApiKeysForUser,
  revokeAuthSessionsForUser,
  revokeAuthSession,
  touchApiKey,
  touchAuthSession,
  unassignUserFromPage,
  updateUserPasswordHash,
} from "@fansly-connect/db";
import {
  randomToken,
  sha256Hex,
  userRoles,
  type UserRole,
} from "@fansly-connect/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "./errors.ts";
import { findPageSummaryByLabel } from "@fansly-connect/db";

export const SESSION_COOKIE_NAME = "fc_session";

interface AuditContext {
  source: string;
  actorUserId?: number | null;
}

export interface AuthenticatedUser {
  id: number;
  username: string;
  role: UserRole;
  assignedPages: Array<{
    id: number;
    label: string;
    platform: "fansly" | "onlyfans";
    modelSlug: string;
    modelName: string;
  }>;
}

export interface AuthPrincipal {
  authMethod: "session" | "api_key";
  user: AuthenticatedUser;
  assignedPageIds: number[];
}

function roleNeedsPassword(role: UserRole) {
  return role === "owner" || role === "team_lead";
}

function roleCanUseApiKey(role: UserRole) {
  return role === "chatter";
}

function roleCanUseSession(role: UserRole) {
  return role === "owner" || role === "team_lead";
}

async function getAuthenticatedUserById(app: AppContext, userId: number) {
  const user = await findUserById(app.db, userId);
  if (!user) {
    return null;
  }

  const assignedPages = await listUserPageAssignments(app.db, user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    assignedPages: assignedPages.map((page) => ({
      id: page.pageId,
      label: page.label,
      platform: page.platform,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
    })),
  } satisfies AuthenticatedUser;
}

async function getAuthenticatedUserByUsername(app: AppContext, username: string) {
  const user = await findUserByUsername(app.db, username);
  if (!user) {
    return null;
  }

  return getAuthenticatedUserById(app, user.id);
}

async function recordAudit(app: AppContext, input: AuditContext & {
  eventType: string;
  targetUserId?: number | null;
  platformAccountId?: number | null;
  metadata?: Record<string, unknown>;
}) {
  await insertAuditEvent(app.db, {
    actorUserId: input.actorUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    platformAccountId: input.platformAccountId ?? null,
    source: input.source,
    eventType: input.eventType,
    metadata: input.metadata,
  });
}

export async function listUsersDetailed(app: AppContext) {
  const users = await listUsers(app.db);
  const result: AuthenticatedUser[] = [];

  for (const user of users) {
    const detailed = await getAuthenticatedUserById(app, user.id);
    if (detailed) {
      result.push(detailed);
    }
  }

  return result;
}

export async function createUserAccount(
  app: AppContext,
  input: {
    username: string;
    role: UserRole;
    password?: string | null;
  },
  audit: AuditContext,
) {
  if (!userRoles.includes(input.role)) {
    throw new BadRequestError(`Unsupported role "${input.role}"`);
  }

  if (roleNeedsPassword(input.role) && !input.password) {
    throw new BadRequestError(`Role "${input.role}" requires a password`);
  }

  if (!roleNeedsPassword(input.role) && input.password) {
    throw new BadRequestError(`Role "${input.role}" does not accept a password in Phase 2`);
  }

  const existing = await findUserByUsername(app.db, input.username);
  if (existing) {
    throw new BadRequestError(`User "${input.username}" already exists`);
  }

  const passwordHash = input.password
    ? await argon2.hash(input.password, { type: argon2.argon2id })
    : null;

  const created = await createUser(app.db, {
    username: input.username,
    role: input.role,
    passwordHash,
  });

  await recordAudit(app, {
    ...audit,
    eventType: "user.created",
    targetUserId: created.id,
    metadata: {
      username: created.username,
      role: created.role,
    },
  });

  return getAuthenticatedUserById(app, created.id);
}

export async function setUserPassword(
  app: AppContext,
  input: {
    username: string;
    password: string;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  if (!roleNeedsPassword(user.role)) {
    throw new BadRequestError(`Role "${user.role}" cannot use password login`);
  }

  await updateUserPasswordHash(
    app.db,
    user.id,
    await argon2.hash(input.password, { type: argon2.argon2id }),
  );
  const revokedSessions = await revokeAuthSessionsForUser(
    app.db,
    user.id,
    "password_reset",
  );

  await recordAudit(app, {
    ...audit,
    eventType: "user.password_updated",
    targetUserId: user.id,
    metadata: {
      username: user.username,
      revokedSessions: revokedSessions.length,
    },
  });
}

export async function assignPageToUser(
  app: AppContext,
  input: {
    username: string;
    pageLabel: string;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  await assignUserToPage(app.db, user.id, page.id);

  await recordAudit(app, {
    ...audit,
    eventType: "user.page_assigned",
    targetUserId: user.id,
    platformAccountId: page.id,
    metadata: {
      username: user.username,
      pageLabel: page.label,
    },
  });
}

export async function unassignPageFromUser(
  app: AppContext,
  input: {
    username: string;
    pageLabel: string;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  await unassignUserFromPage(app.db, user.id, page.id);

  await recordAudit(app, {
    ...audit,
    eventType: "user.page_unassigned",
    targetUserId: user.id,
    platformAccountId: page.id,
    metadata: {
      username: user.username,
      pageLabel: page.label,
    },
  });
}

export async function issueChatterApiKey(
  app: AppContext,
  input: {
    username: string;
    pageLabel?: string;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  if (!roleCanUseApiKey(user.role)) {
    throw new BadRequestError(`Role "${user.role}" cannot use API keys`);
  }

  const page = input.pageLabel
    ? await findPageSummaryByLabel(app.db, input.pageLabel)
    : null;
  if (input.pageLabel && !page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }
  if (page) {
    await assignUserToPage(app.db, user.id, page.id);
  }

  const activeKeys = await findActiveApiKeysForUser(app.db, user.id);
  if (activeKeys.length > 0) {
    await revokeApiKeysForUser(app.db, user.id, "rotated");
  }

  const rawKey = `fc_${randomToken(24)}`;
  const keyPrefix = rawKey.slice(0, 15);
  await createApiKey(app.db, {
    userId: user.id,
    keyPrefix,
    tokenDigest: sha256Hex(rawKey),
  });

  await recordAudit(app, {
    ...audit,
    eventType: "api_key.issued",
    targetUserId: user.id,
    platformAccountId: page?.id ?? null,
    metadata: {
      username: user.username,
      keyPrefix,
      rotatedKeys: activeKeys.length,
      pageLabel: page?.label ?? null,
    },
  });

  return {
    key: rawKey,
    keyPrefix,
  };
}

export async function revokeUserApiKeys(
  app: AppContext,
  input: {
    username: string;
    reason?: string | null;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }

  const revoked = await revokeApiKeysForUser(app.db, user.id, input.reason ?? "revoked");

  await recordAudit(app, {
    ...audit,
    eventType: "api_key.revoked",
    targetUserId: user.id,
    metadata: {
      username: user.username,
      revokedCount: revoked.length,
    },
  });

  return revoked;
}

export async function listApiKeysForUsers(
  app: AppContext,
  usernames?: string[],
) {
  if (!usernames || usernames.length === 0) {
    return listApiKeys(app.db);
  }

  const userIds: number[] = [];
  for (const username of usernames) {
    const user = await findUserByUsername(app.db, username);
    if (user) {
      userIds.push(user.id);
    }
  }

  if (userIds.length === 0) {
    return [];
  }

  return listApiKeys(app.db, userIds);
}

export async function cleanupExpiredSessions(app: AppContext, now = new Date()) {
  await deleteExpiredAuthSessions(app.db, now);
}

export async function loginWithPassword(
  app: AppContext,
  input: {
    username: string;
    password: string;
  },
) {
  const user = await findUserByUsername(app.db, input.username);

  if (!user || !roleCanUseSession(user.role) || !user.passwordHash) {
    await recordAudit(app, {
      source: "api",
      eventType: "auth.login_failed",
      metadata: { username: input.username },
    });
    throw new UnauthorizedError("Invalid username or password");
  }

  const isValid = await argon2.verify(user.passwordHash, input.password);
  if (!isValid) {
    await recordAudit(app, {
      source: "api",
      eventType: "auth.login_failed",
      targetUserId: user.id,
      metadata: { username: user.username },
    });
    throw new UnauthorizedError("Invalid username or password");
  }

  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + app.config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await createAuthSession(app.db, {
    userId: user.id,
    tokenDigest: sha256Hex(sessionToken),
    expiresAt,
  });

  const authenticatedUser = await getAuthenticatedUserById(app, user.id);
  if (!authenticatedUser) {
    throw new UnauthorizedError("Authentication failed");
  }

  await recordAudit(app, {
    source: "api",
    actorUserId: user.id,
    targetUserId: user.id,
    eventType: "auth.login",
    metadata: { username: user.username },
  });

  return {
    sessionToken,
    expiresAt,
    authMethod: "session" as const,
    user: authenticatedUser,
  };
}

export async function authenticateSessionToken(app: AppContext, sessionToken: string) {
  const session = await findAuthSessionByDigest(app.db, sha256Hex(sessionToken));
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return null;
  }

  const user = await getAuthenticatedUserById(app, session.userId);
  if (!user || !roleCanUseSession(user.role)) {
    return null;
  }

  await touchAuthSession(app.db, session.id);

  return {
    authMethod: "session" as const,
    user,
    assignedPageIds: user.assignedPages.map((page) => page.id),
  } satisfies AuthPrincipal;
}

export async function authenticateApiKeyToken(app: AppContext, apiKeyToken: string) {
  const apiKey = await findApiKeyByDigest(app.db, sha256Hex(apiKeyToken));
  if (!apiKey || apiKey.revokedAt) {
    return null;
  }

  const user = await getAuthenticatedUserById(app, apiKey.userId);
  if (!user || !roleCanUseApiKey(user.role)) {
    return null;
  }

  await touchApiKey(app.db, apiKey.id);

  return {
    authMethod: "api_key" as const,
    user,
    assignedPageIds: user.assignedPages.map((page) => page.id),
  } satisfies AuthPrincipal;
}

export async function logoutSessionToken(app: AppContext, sessionToken: string) {
  const session = await findAuthSessionByDigest(app.db, sha256Hex(sessionToken));
  if (!session || session.revokedAt) {
    return false;
  }

  await revokeAuthSession(app.db, session.id, "logout");
  await recordAudit(app, {
    source: "api",
    actorUserId: session.userId,
    targetUserId: session.userId,
    eventType: "auth.logout",
  });

  return true;
}

export function canAccessPage(principal: AuthPrincipal, pageId: number) {
  if (principal.user.role === "owner") {
    return true;
  }

  return principal.assignedPageIds.includes(pageId);
}

export function requireDashboardUser(principal: AuthPrincipal) {
  if (principal.authMethod !== "session") {
    throw new ForbiddenError("Dashboard routes require a cookie session");
  }
  if (!roleCanUseSession(principal.user.role)) {
    throw new ForbiddenError("This role cannot access dashboard routes");
  }
}

export function requireOwner(principal: AuthPrincipal) {
  requireDashboardUser(principal);
  if (principal.user.role !== "owner") {
    throw new ForbiddenError("Owner access required");
  }
}

export function requireApiKeyUser(principal: AuthPrincipal) {
  if (principal.authMethod !== "api_key") {
    throw new ForbiddenError("API key required");
  }
}

export { getAuthenticatedUserByUsername };
