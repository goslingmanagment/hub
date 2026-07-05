import { createHash, randomUUID } from "node:crypto";

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
  insertObservation,
  listApiKeys,
  listUserPageAssignments,
  listUsers,
  lockUserForApiKeyRotation,
  revokeApiKeysByIds,
  revokeApiKeysForUser,
  revokeAuthSessionsForUser,
  revokeAuthSession,
  touchApiKey,
  touchAuthSession,
  unassignUserFromPage,
  updateUserPasswordHash,
} from "@agency_hub_core/db";
import {
  creatableUserRoles,
  randomToken,
  sha256Hex,
  type CreatableUserRole,
  type UserRole,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "./errors.ts";
import { findPageSummaryByLabel } from "@agency_hub_core/db";

export const SESSION_COOKIE_NAME = "agency_hub_core_session";
const API_KEY_PREFIX = "agency_hub_core_";
const API_KEY_DISPLAY_LENGTH = 10;

// Fixed argon2id hash used to equalize timing on login failure paths so that a
// missing/ineligible user is indistinguishable from a wrong password. The plaintext
// is irrelevant; it is never expected to verify successfully.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$uBvthN/XqL8U0tfIpEFZog$GEU0fF0w4vScnjMXlxqLdhsBF8L7Ixzhj8R3ISHudHA";

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

export interface AdminUserApiKeyStatus {
  activeKeyPrefix: string | null;
  activeKeyCount: number;
  activeKeyCreatedAt: string | null;
  activeKeyLastUsedAt: string | null;
}

export interface AdminUserDetailed extends AuthenticatedUser {
  apiKeyStatus: AdminUserApiKeyStatus | null;
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

function mapAssignedPages(
  assignedPages: Awaited<ReturnType<typeof listUserPageAssignments>>,
): AuthenticatedUser["assignedPages"] {
  return assignedPages.map((page) => ({
    id: page.pageId,
    label: page.label,
    platform: page.platform,
    modelSlug: page.modelSlug,
    modelName: page.modelName,
  }));
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
    assignedPages: mapAssignedPages(assignedPages),
  } satisfies AuthenticatedUser;
}

async function getAuthenticatedUserByUsername(app: AppContext, username: string) {
  const user = await findUserByUsername(app.db, username);
  if (!user) {
    return null;
  }

  return getAuthenticatedUserById(app, user.id);
}

async function getAdminUserById(app: AppContext, userId: number) {
  const user = await findUserById(app.db, userId);
  if (!user) {
    return null;
  }

  const [assignedPages, activeApiKeys] = await Promise.all([
    listUserPageAssignments(app.db, user.id),
    roleCanUseApiKey(user.role) ? findActiveApiKeysForUser(app.db, user.id) : Promise.resolve([]),
  ]);

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    assignedPages: mapAssignedPages(assignedPages),
    apiKeyStatus: roleCanUseApiKey(user.role)
      ? {
        activeKeyPrefix: activeApiKeys[0]?.keyPrefix ?? null,
        activeKeyCount: activeApiKeys.length,
        activeKeyCreatedAt: activeApiKeys[0]?.createdAt?.toISOString() ?? null,
        activeKeyLastUsedAt: activeApiKeys[0]?.lastUsedAt?.toISOString() ?? null,
      }
      : null,
  } satisfies AdminUserDetailed;
}

async function recordAudit(app: Pick<AppContext, "db">, input: AuditContext & {
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

  // Stage 7 producer 6: the audit choke point dual-writes an observation.
  // Operator actions carry no natural idempotency key — each call is a
  // distinct fact, so the key is a UUID. Callers that run inside a
  // transaction get both writes atomically; a failed capture fails the
  // mutation loudly (admin actions are retryable).
  const payload = {
    source: input.source,
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    platformAccountId: input.platformAccountId ?? null,
    metadata: input.metadata ?? null,
  };
  await insertObservation(app.db, {
    source: "operator",
    producer: "api:admin",
    accountId: input.platformAccountId ?? null,
    kind: input.eventType,
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `op:${randomUUID()}`,
    actorPrincipalId: input.actorUserId ?? null,
  });
}

async function recordFailedLoginAuditBestEffort(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    username: string;
    targetUserId?: number | null;
  },
) {
  try {
    await recordAudit(app, {
      source: "api",
      eventType: "auth.login_failed",
      targetUserId: input.targetUserId ?? null,
      metadata: { username: input.username },
    });
  } catch (error) {
    app.logger.warn({
      username: input.username,
      targetUserId: input.targetUserId ?? null,
      err: error,
    }, "Failed-login audit insert failed; continuing with unauthorized response");
  }
}

export async function listUsersDetailed(app: AppContext) {
  const users = await listUsers(app.db);
  const result: AdminUserDetailed[] = [];

  for (const user of users) {
    const detailed = await getAdminUserById(app, user.id);
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
    role: CreatableUserRole;
    password?: string | null;
  },
  audit: AuditContext,
) {
  if (!creatableUserRoles.includes(input.role)) {
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

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  await app.db.transaction(async (tx) => {
    const dbTx = tx as unknown as typeof app.db;
    await updateUserPasswordHash(
      dbTx,
      user.id,
      passwordHash,
    );
    const revokedSessions = await revokeAuthSessionsForUser(
      dbTx,
      user.id,
      "password_reset",
    );

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.password_updated",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedSessions: revokedSessions.length,
      },
    });
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

  const tokenBody = randomToken(24);
  const rawKey = `${API_KEY_PREFIX}${tokenBody}`;
  const keyPrefix = `${API_KEY_PREFIX}${tokenBody.slice(0, API_KEY_DISPLAY_LENGTH)}`;
  const tokenDigest = sha256Hex(rawKey);
  await app.db.transaction(async (tx) => {
    const dbTx = tx as unknown as typeof app.db;
    await lockUserForApiKeyRotation(dbTx, user.id);
    if (page) {
      await assignUserToPage(dbTx, user.id, page.id);
    }

    const activeKeys = await findActiveApiKeysForUser(dbTx, user.id);
    await createApiKey(dbTx, {
      userId: user.id,
      keyPrefix,
      tokenDigest,
    });

    await recordAudit({ db: dbTx }, {
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

    await revokeApiKeysByIds(
      dbTx,
      activeKeys.map((activeKey) => activeKey.id),
      "rotated",
    );
  });

  const assignedPages = await listUserPageAssignments(app.db, user.id);

  return {
    key: rawKey,
    keyPrefix,
    assignedPages: mapAssignedPages(assignedPages),
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

// Audit B7: the route-level @fastify/rate-limit plugin runs at onRequest where
// the body is not yet parsed, so it can only honestly key on the client IP.
// This registry adds the per-account half: consecutive failures for a username
// earn an escalating lockout regardless of which IPs the attempts come from.
// State is in-memory (one API process) and keyed per AppContext so parallel
// test servers stay isolated; a restart clearing it only resets the backoff.
interface LoginBackoffEntry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

const LOGIN_BACKOFF_FREE_FAILURES = 5;
const LOGIN_BACKOFF_BASE_LOCK_MS = 30_000;
const LOGIN_BACKOFF_MAX_LOCK_MS = 15 * 60_000;
const LOGIN_BACKOFF_FORGET_MS = 30 * 60_000;
const LOGIN_BACKOFF_MAX_TRACKED_ACCOUNTS = 10_000;

const loginBackoffRegistries = new WeakMap<object, Map<string, LoginBackoffEntry>>();

function loginBackoffRegistryFor(app: AppContext): Map<string, LoginBackoffEntry> {
  let registry = loginBackoffRegistries.get(app);
  if (!registry) {
    registry = new Map();
    loginBackoffRegistries.set(app, registry);
  }
  return registry;
}

function loginBackoffKey(username: string): string {
  return username.trim().toLowerCase();
}

// Applies to existing and unknown usernames alike, so the 429 carries no
// username-enumeration signal.
function assertLoginNotBackedOff(app: AppContext, username: string, now: number): void {
  const registry = loginBackoffRegistryFor(app);
  const key = loginBackoffKey(username);
  const entry = registry.get(key);
  if (!entry) {
    return;
  }

  if (now - entry.lastFailureAt >= LOGIN_BACKOFF_FORGET_MS) {
    registry.delete(key);
    return;
  }

  if (entry.lockedUntil > now) {
    throw new TooManyRequestsError("Too many login attempts");
  }
}

function recordLoginFailureForBackoff(app: AppContext, username: string, now: number): void {
  const registry = loginBackoffRegistryFor(app);
  const key = loginBackoffKey(username);
  const previous = registry.get(key);
  const failures = previous && now - previous.lastFailureAt < LOGIN_BACKOFF_FORGET_MS
    ? previous.failures + 1
    : 1;
  const lockMs = failures >= LOGIN_BACKOFF_FREE_FAILURES
    ? Math.min(
      LOGIN_BACKOFF_BASE_LOCK_MS * 2 ** (failures - LOGIN_BACKOFF_FREE_FAILURES),
      LOGIN_BACKOFF_MAX_LOCK_MS,
    )
    : 0;

  // Delete-then-set keeps Map insertion order aligned with recency so the
  // size-cap eviction below drops the stalest usernames first.
  registry.delete(key);
  registry.set(key, { failures, lastFailureAt: now, lockedUntil: now + lockMs });

  if (registry.size <= LOGIN_BACKOFF_MAX_TRACKED_ACCOUNTS) {
    return;
  }

  for (const [trackedKey, entry] of registry) {
    if (now - entry.lastFailureAt >= LOGIN_BACKOFF_FORGET_MS && entry.lockedUntil <= now) {
      registry.delete(trackedKey);
    }
  }

  // Still over the cap means an active spray across many usernames; the
  // per-IP limiter is the primary bound there, so shedding the stalest
  // entries is safe.
  while (registry.size > LOGIN_BACKOFF_MAX_TRACKED_ACCOUNTS) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    registry.delete(oldest);
  }
}

function clearLoginBackoff(app: AppContext, username: string): void {
  loginBackoffRegistryFor(app).delete(loginBackoffKey(username));
}

export async function loginWithPassword(
  app: AppContext,
  input: {
    username: string;
    password: string;
  },
) {
  const now = Date.now();
  assertLoginNotBackedOff(app, input.username, now);

  const user = await findUserByUsername(app.db, input.username);

  if (!user || !roleCanUseSession(user.role) || !user.passwordHash) {
    // Run a dummy verification so this path takes comparable time to the
    // wrong-password path below, avoiding a username-enumeration timing oracle.
    await argon2.verify(DUMMY_PASSWORD_HASH, input.password).catch(() => false);
    recordLoginFailureForBackoff(app, input.username, now);
    await recordFailedLoginAuditBestEffort(app, {
      username: input.username,
    });
    throw new UnauthorizedError("Invalid username or password");
  }

  const isValid = await argon2.verify(user.passwordHash, input.password);
  if (!isValid) {
    recordLoginFailureForBackoff(app, input.username, now);
    await recordFailedLoginAuditBestEffort(app, {
      username: user.username,
      targetUserId: user.id,
    });
    throw new UnauthorizedError("Invalid username or password");
  }

  clearLoginBackoff(app, input.username);

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

/**
 * Stage 2 chatter-read-scope fix: raw revenue/transaction reads are a
 * dashboard-session-role surface (owner/team_lead) — a leaked chatter bearer
 * key must not read a page's ledger. REVENUE_ROUTE_ROLE_ENFORCEMENT starts in
 * "log" (serve normally, log `would-deny`) for a 48 h observation window, then
 * flips to "enforce" (403). Callers keep their canAccessPage page-scope check
 * on top; this narrows role scope only.
 */
export function enforceRevenueRouteRoleScope(
  app: Pick<AppContext, "config" | "logger">,
  principal: AuthPrincipal,
  routePath: string,
) {
  try {
    requireDashboardUser(principal);
  } catch (error) {
    if (app.config.revenueRouteRoleEnforcement === "enforce") {
      throw error;
    }
    app.logger.warn({
      path: routePath,
      userId: principal.user.id,
      username: principal.user.username,
      role: principal.user.role,
      authMethod: principal.authMethod,
    }, "would-deny: revenue route requires a dashboard session role (log-only mode)");
  }
}

export { getAuthenticatedUserByUsername };
