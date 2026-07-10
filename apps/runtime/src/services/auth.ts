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
  createDeviceToken,
  findDeviceTokenByDigest,
  findModelBySlug,
  insertAccessGrant,
  listDeviceTokensForUser,
  listGrantsForUser,
  listModelsByIds,
  listPagesByIds,
  resolveGrantedPageAssignments,
  revokeAccessGrants,
  revokeDeviceTokensForUser,
  updateDeviceTokenUse,
  updateUserDisabledAt,
  updateUserMustChangePassword,
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
  mustChangePassword: boolean;
}

export interface AdminUserApiKeyStatus {
  activeKeyPrefix: string | null;
  activeKeyCount: number;
  activeKeyCreatedAt: string | null;
  activeKeyLastUsedAt: string | null;
}

export interface AdminUserDetailed extends AuthenticatedUser {
  apiKeyStatus: AdminUserApiKeyStatus | null;
  disabledAt: string | null;
  lastActiveAt: string | null;
}

export interface AuthPrincipal {
  authMethod: "session" | "api_key" | "device_token";
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
  // Stage 22: every human role is session-capable (the workboard's substrate);
  // dashboard route access stays a separate, narrower check below.
  return role === "owner" || role === "team_lead" || role === "chatter";
}

function roleCanUseDashboard(role: UserRole) {
  return role === "owner" || role === "team_lead";
}

/**
 * Stage 22 read-path toggle: assignments (legacy shadow) or the grants
 * projection. Both produce the exact listUserPageAssignments row shape — the
 * `assignedPageIds` enforcement shape is load-bearing for the middleware and
 * SSE filtering.
 */
async function listEffectivePageAssignments(app: AppContext, userId: number) {
  if (app.config?.accessGrantsReadEnabled) {
    return resolveGrantedPageAssignments(app.db, userId);
  }
  return listUserPageAssignments(app.db, userId);
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

/** Decision #126: a deactivated user is frozen on every mutation path that
 * could re-open access (credentials, assignments) — reactivate first. */
function assertUserNotDeactivated(user: { username: string; disabledAt: Date | null }) {
  if (user.disabledAt) {
    throw new BadRequestError(`User "${user.username}" is deactivated`);
  }
}

async function getAuthenticatedUserById(app: AppContext, userId: number) {
  const user = await findUserById(app.db, userId);
  // Deactivation is fail-closed at the principal root (decision #126): every
  // authenticate* path resolves through here, so a disabled row can never
  // become a principal even if a credential row survived revocation.
  if (!user || user.disabledAt) {
    return null;
  }

  const assignedPages = await listEffectivePageAssignments(app, user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
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

  const [assignedPages, activeApiKeys, allApiKeys, userDeviceTokens] = await Promise.all([
    listEffectivePageAssignments(app, user.id),
    roleCanUseApiKey(user.role) ? findActiveApiKeysForUser(app.db, user.id) : Promise.resolve([]),
    roleCanUseApiKey(user.role) ? listApiKeys(app.db, [user.id]) : Promise.resolve([]),
    roleCanUseSession(user.role) ? listDeviceTokensForUser(app.db, user.id) : Promise.resolve([]),
  ]);

  // Honest activity signal: rotation revokes the old key, so the freshest
  // last_used may live on a revoked row — scan all keys AND device tokens
  // (the #116 password flow leaves api-key columns empty forever).
  const lastActiveMs = Math.max(
    0,
    ...allApiKeys.map((key) => key.lastUsedAt?.getTime() ?? 0),
    ...userDeviceTokens.map((token) => token.lastUsedAt?.getTime() ?? 0),
  );

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    assignedPages: mapAssignedPages(assignedPages),
    apiKeyStatus: roleCanUseApiKey(user.role)
      ? {
        activeKeyPrefix: activeApiKeys[0]?.keyPrefix ?? null,
        activeKeyCount: activeApiKeys.length,
        activeKeyCreatedAt: activeApiKeys[0]?.createdAt?.toISOString() ?? null,
        activeKeyLastUsedAt: activeApiKeys[0]?.lastUsedAt?.toISOString() ?? null,
      }
      : null,
    disabledAt: user.disabledAt?.toISOString() ?? null,
    lastActiveAt: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
  } satisfies AdminUserDetailed;
}

export async function recordAudit(app: Pick<AppContext, "db">, input: AuditContext & {
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

/** Mutation + audit dual-write commit together (review R1-7). Mirrors the
 * sync-context idiom: a handle without a transaction API (unit-test fakes)
 * runs directly — the real Database always has one. */
async function withAuditTransaction<T>(
  app: Pick<AppContext, "db">,
  run: (db: AppContext["db"]) => Promise<T>,
): Promise<T> {
  const transaction = (
    app.db as AppContext["db"] & {
      transaction?: (callback: (tx: unknown) => Promise<T>) => Promise<T>;
    }
  ).transaction;

  if (typeof transaction !== "function") {
    return run(app.db);
  }

  return transaction.call(app.db, async (tx) => run(tx as unknown as AppContext["db"]));
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

  // Mutation + audit dual-write commit together (review R1-7): an audit
  // failure must not leave the user row committed behind a 500 (the retry
  // then hits "already exists").
  const created = await withAuditTransaction(app, async (dbTx) => {
    const createdUser = await createUser(dbTx, {
      username: input.username,
      role: input.role,
      passwordHash,
    });

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.created",
      targetUserId: createdUser.id,
      metadata: {
        username: createdUser.username,
        role: createdUser.role,
      },
    });

    return createdUser;
  });

  return getAuthenticatedUserById(app, created.id);
}

export async function setUserPassword(
  app: AppContext,
  input: {
    username: string;
    password: string;
    mustChangePassword?: boolean;
  },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  // Stage 22: every session-capable role may hold a password (the chatter
  // invite flow v1 is admin-set-password); content_manager stays out.
  if (!roleCanUseSession(user.role)) {
    throw new BadRequestError(`Role "${user.role}" cannot use password login`);
  }
  assertUserNotDeactivated(user);

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  await withAuditTransaction(app, async (dbTx) => {
    await updateUserPasswordHash(
      dbTx,
      user.id,
      passwordHash,
    );
    await updateUserMustChangePassword(dbTx, user.id, input.mustChangePassword ?? false);
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
        mustChangePassword: input.mustChangePassword ?? false,
      },
    });
  });
}

/**
 * Decision #126: offboarding is a tombstone, never a DELETE — fact tables
 * reference users.id (ofapi_commands is RESTRICT) and spend/audit attribution
 * must survive. Tombstone + every credential revocation commit together;
 * getAuthenticatedUserById fails closed on the tombstone as the belt.
 */
export async function deactivateUser(
  app: AppContext,
  input: { username: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  if (user.role === "owner") {
    throw new BadRequestError("Owner accounts cannot be deactivated");
  }
  if (audit.actorUserId != null && audit.actorUserId === user.id) {
    throw new BadRequestError("You cannot deactivate your own account");
  }
  if (user.disabledAt) {
    throw new BadRequestError(`User "${user.username}" is already deactivated`);
  }

  return withAuditTransaction(app, async (dbTx) => {
    await updateUserDisabledAt(dbTx, user.id, new Date());
    const revokedKeys = await revokeApiKeysForUser(dbTx, user.id, "user_deactivated");
    const revokedTokens = await revokeDeviceTokensForUser(dbTx, user.id, "user_deactivated");
    const revokedSessions = await revokeAuthSessionsForUser(dbTx, user.id, "user_deactivated");

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.deactivated",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedApiKeys: revokedKeys.length,
        revokedDeviceTokens: revokedTokens.length,
        revokedSessions: revokedSessions.length,
      },
    });

    return {
      ok: true as const,
      revokedApiKeys: revokedKeys.length,
      revokedDeviceTokens: revokedTokens.length,
      revokedSessions: revokedSessions.length,
    };
  });
}

/** Clears the #126 tombstone. The stored password works again immediately;
 * keys and device tokens stay revoked — issue fresh ones. */
export async function reactivateUser(
  app: AppContext,
  input: { username: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  if (!user.disabledAt) {
    throw new BadRequestError(`User "${user.username}" is not deactivated`);
  }

  await withAuditTransaction(app, async (dbTx) => {
    await updateUserDisabledAt(dbTx, user.id, null);
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.reactivated",
      targetUserId: user.id,
      metadata: { username: user.username },
    });
  });

  return { ok: true as const };
}

/**
 * Self-serve password change (Stage 22): verifies the current password, sets
 * the new one, clears must_change_password, and revokes every session — the
 * caller re-logs-in with the new credential.
 */
export async function changeOwnPassword(
  app: AppContext,
  input: {
    userId: number;
    currentPassword: string;
    newPassword: string;
  },
) {
  const user = await findUserById(app.db, input.userId);
  if (!user || !user.passwordHash) {
    throw new UnauthorizedError("Invalid current password");
  }
  const isValid = await argon2.verify(user.passwordHash, input.currentPassword);
  if (!isValid) {
    throw new UnauthorizedError("Invalid current password");
  }

  const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
  await withAuditTransaction(app, async (dbTx) => {
    await updateUserPasswordHash(dbTx, user.id, passwordHash);
    await updateUserMustChangePassword(dbTx, user.id, false);
    const revokedSessions = await revokeAuthSessionsForUser(dbTx, user.id, "password_changed");
    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      eventType: "user.password_changed_self",
      targetUserId: user.id,
      metadata: { username: user.username, revokedSessions: revokedSessions.length },
    });
  });
  return { ok: true as const };
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
  assertUserNotDeactivated(user);

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  // Stage 22: the grant log is the durable record; the legacy assignment row
  // is dual-written until the read path flips (then the table freezes).
  // Grant + assignment + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    await insertAccessGrant(dbTx, {
      userId: user.id,
      scopeType: "page",
      scopeId: page.id,
      grantedBy: audit.actorUserId ?? null,
    });
    if (!app.config?.accessGrantsReadEnabled) {
      await assignUserToPage(dbTx, user.id, page.id);
    }

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.page_assigned",
      targetUserId: user.id,
      platformAccountId: page.id,
      metadata: {
        username: user.username,
        pageLabel: page.label,
      },
    });
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

  // Stage 22: revoke = a stamp on the grant log, never a delete. The legacy
  // hard-delete continues only while assignments are still the read path.
  // Revoke + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    await revokeAccessGrants(dbTx, {
      userId: user.id,
      scopeType: "page",
      scopeId: page.id,
      revokedBy: audit.actorUserId ?? null,
    });
    if (!app.config?.accessGrantsReadEnabled) {
      await unassignUserFromPage(dbTx, user.id, page.id);
    }

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.page_unassigned",
      targetUserId: user.id,
      platformAccountId: page.id,
      metadata: {
        username: user.username,
        pageLabel: page.label,
      },
    });
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
  assertUserNotDeactivated(user);

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
  await withAuditTransaction(app, async (dbTx) => {
    await lockUserForApiKeyRotation(dbTx, user.id);
    if (page) {
      await insertAccessGrant(dbTx, {
        userId: user.id,
        scopeType: "page",
        scopeId: page.id,
        grantedBy: audit.actorUserId ?? null,
      });
      if (!app.config?.accessGrantsReadEnabled) {
        await assignUserToPage(dbTx, user.id, page.id);
      }
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

  const assignedPages = await listEffectivePageAssignments(app, user.id);

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

  // Revoke + audit commit together (review R1-7).
  const revoked = await withAuditTransaction(app, async (dbTx) => {
    const revokedKeys = await revokeApiKeysForUser(dbTx, user.id, input.reason ?? "revoked");

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "api_key.revoked",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedCount: revokedKeys.length,
      },
    });

    return revokedKeys;
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

  // Deactivated shares the invalid-credentials path (decision #126): the same
  // 401, dummy verify, and backoff as an unknown username — no oracle.
  if (!user || !roleCanUseSession(user.role) || !user.passwordHash || user.disabledAt) {
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

  const authenticatedUser = await getAuthenticatedUserById(app, user.id);
  if (!authenticatedUser) {
    throw new UnauthorizedError("Authentication failed");
  }

  // Session row + audit dual-write commit together (review R1-7): an audit
  // failure must not leave a usable-but-undisclosed session row behind a 500.
  const sessionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + app.config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await withAuditTransaction(app, async (dbTx) => {
    await createAuthSession(dbTx, {
      userId: user.id,
      tokenDigest: sha256Hex(sessionToken),
      expiresAt,
    });

    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      targetUserId: user.id,
      eventType: "auth.login",
      metadata: { username: user.username },
    });
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

  // Revoke + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    await revokeAuthSession(dbTx, session.id, "logout");
    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: session.userId,
      targetUserId: session.userId,
      eventType: "auth.logout",
    });
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
  if (!roleCanUseDashboard(principal.user.role)) {
    throw new ForbiddenError("This role cannot access dashboard routes");
  }
}

/** Any live cookie session, any human role (self-serve auth surface). */
export function requireSessionUser(principal: AuthPrincipal) {
  if (principal.authMethod !== "session") {
    throw new ForbiddenError("This route requires a cookie session");
  }
}

export function requireOwner(principal: AuthPrincipal) {
  requireDashboardUser(principal);
  if (principal.user.role !== "owner") {
    throw new ForbiddenError("Owner access required");
  }
}

export function requireApiKeyUser(principal: AuthPrincipal) {
  if (principal.authMethod !== "api_key" && principal.authMethod !== "device_token") {
    throw new ForbiddenError("Bearer credential required");
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


// --- Device tokens (kernel Stage 22) ---

export const DEVICE_TOKEN_PREFIX = "agency_hub_device_";
const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Sliding refresh never extends past creation + this hard cap. */
const DEVICE_TOKEN_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** Refresh writes are throttled: bump only when it gains at least a day. */
const DEVICE_TOKEN_REFRESH_GRANULARITY_MS = 24 * 60 * 60 * 1000;

export async function issueDeviceToken(
  app: AppContext,
  input: {
    userId: number;
    label: string;
  },
  audit: AuditContext,
) {
  const user = await findUserById(app.db, input.userId);
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (!roleCanUseSession(user.role)) {
    throw new BadRequestError(`Role "${user.role}" cannot hold device tokens`);
  }
  assertUserNotDeactivated(user);

  const tokenBody = randomToken(24);
  const rawToken = `${DEVICE_TOKEN_PREFIX}${tokenBody}`;
  const keyPrefix = `${DEVICE_TOKEN_PREFIX}${tokenBody.slice(0, API_KEY_DISPLAY_LENGTH)}`;
  const expiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
  // Token row + audit commit together (review R1-7).
  const created = await withAuditTransaction(app, async (dbTx) => {
    const createdToken = await createDeviceToken(dbTx, {
      userId: user.id,
      label: input.label,
      tokenDigest: sha256Hex(rawToken),
      keyPrefix,
      expiresAt,
    });

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.issued",
      targetUserId: user.id,
      metadata: { username: user.username, label: input.label, keyPrefix },
    });

    return createdToken;
  });

  return {
    token: rawToken,
    id: created.id,
    label: created.label,
    keyPrefix,
    expiresAt,
  };
}

export async function authenticateDeviceToken(app: AppContext, deviceToken: string) {
  const record = await findDeviceTokenByDigest(app.db, sha256Hex(deviceToken));
  const now = new Date();
  if (!record || record.revokedAt || record.expiresAt <= now) {
    return null;
  }

  const user = await getAuthenticatedUserById(app, record.userId);
  if (!user || !roleCanUseSession(user.role)) {
    return null;
  }

  // Sliding expiry: each (throttled) use extends the token up to the hard cap;
  // an idle device dies at expires_at.
  const cap = new Date(record.createdAt.getTime() + DEVICE_TOKEN_MAX_LIFETIME_MS);
  const slid = new Date(Math.min(now.getTime() + DEVICE_TOKEN_TTL_MS, cap.getTime()));
  const worthBumping = slid.getTime() - record.expiresAt.getTime() >= DEVICE_TOKEN_REFRESH_GRANULARITY_MS;
  await updateDeviceTokenUse(app.db, record.id, {
    lastUsedAt: now,
    ...(worthBumping ? { expiresAt: slid } : {}),
  });

  return {
    authMethod: "device_token" as const,
    user,
    assignedPageIds: user.assignedPages.map((page) => page.id),
  } satisfies AuthPrincipal;
}

/** Prefix-discriminated bearer authentication: api key or device token. */
export async function authenticateBearerToken(app: AppContext, token: string) {
  if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
    return authenticateDeviceToken(app, token);
  }
  return authenticateApiKeyToken(app, token);
}

export async function listDeviceTokensForUsername(app: AppContext, username: string) {
  const user = await findUserByUsername(app.db, username);
  if (!user) {
    throw new NotFoundError(`User "${username}" not found`);
  }
  const tokens = await listDeviceTokensForUser(app.db, user.id);
  return tokens.map((token) => ({
    id: token.id,
    label: token.label,
    keyPrefix: token.keyPrefix,
    isActive: token.revokedAt === null && token.expiresAt > new Date(),
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
    revokedAt: token.revokedAt?.toISOString() ?? null,
    revokedReason: token.revokedReason ?? null,
  }));
}

export async function issueDeviceTokenForUsername(
  app: AppContext,
  input: { username: string; label: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  return issueDeviceToken(app, { userId: user.id, label: input.label }, audit);
}

export async function revokeDeviceTokensForUsername(
  app: AppContext,
  input: { username: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  // Revoke + audit commit together (review R1-7).
  const revoked = await withAuditTransaction(app, async (dbTx) => {
    const revokedTokens = await revokeDeviceTokensForUser(dbTx, user.id, "revoked");
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.revoked",
      targetUserId: user.id,
      metadata: { username: user.username, revokedCount: revokedTokens.length },
    });
    return revokedTokens;
  });
  return { revokedCount: revoked.length };
}

// --- Model-scope grants (kernel Stage 22) ---

export async function grantModelToUser(
  app: AppContext,
  input: { username: string; modelSlug: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" not found`);
  }
  // Grant + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    await insertAccessGrant(dbTx, {
      userId: user.id,
      scopeType: "model",
      scopeId: model.id,
      grantedBy: audit.actorUserId ?? null,
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.model_granted",
      targetUserId: user.id,
      metadata: { username: user.username, modelSlug: model.slug },
    });
  });
  return { ok: true as const };
}

export async function revokeModelFromUser(
  app: AppContext,
  input: { username: string; modelSlug: string },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" not found`);
  }
  // Revoke + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    await revokeAccessGrants(dbTx, {
      userId: user.id,
      scopeType: "model",
      scopeId: model.id,
      revokedBy: audit.actorUserId ?? null,
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.model_revoked",
      targetUserId: user.id,
      metadata: { username: user.username, modelSlug: model.slug },
    });
  });
  return { ok: true as const };
}

/** Grant history for the admin surface — scope labels resolved for display. */
export async function listUserGrants(app: AppContext, username: string) {
  const user = await findUserByUsername(app.db, username);
  if (!user) {
    throw new NotFoundError(`User "${username}" not found`);
  }
  const grants = await listGrantsForUser(app.db, user.id);
  const modelIds = grants.filter((g) => g.scopeType === "model").map((g) => g.scopeId);
  const pageIds = grants.filter((g) => g.scopeType === "page").map((g) => g.scopeId);
  const [modelRows, pageRows] = await Promise.all([
    modelIds.length > 0 ? listModelsByIds(app.db, modelIds) : Promise.resolve([]),
    pageIds.length > 0 ? listPagesByIds(app.db, pageIds) : Promise.resolve([]),
  ]);
  const modelLabels = new Map(modelRows.map((row) => [row.id, row.slug]));
  const pageLabels = new Map(pageRows.map((row) => [row.id, row.label]));

  return grants.map((grant) => ({
    id: grant.id,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
    scopeLabel: grant.scopeType === "model"
      ? modelLabels.get(grant.scopeId) ?? null
      : grant.scopeType === "page"
        ? pageLabels.get(grant.scopeId) ?? null
        : null,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt.toISOString(),
    revokedBy: grant.revokedBy,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  }));
}

export { getAuthenticatedUserByUsername };
