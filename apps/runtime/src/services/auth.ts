import { createHash, randomUUID } from "node:crypto";

import argon2 from "argon2";

import {
  assignUserToPage,
  advanceDeviceTokenEpoch,
  createApiKey,
  createAuthSession,
  createPendingDeviceToken,
  createUser,
  deleteExpiredAuthSessions,
  deleteExpiredPendingDeviceTokens,
  deletePendingDeviceTokenById,
  deletePendingDeviceTokensForUser,
  findActiveApiKeysForUser,
  findAgentKeyByDigest,
  findApiKeyByDigest,
  findAuthSessionByDigest,
  findAuthSessionById,
  findPendingDeviceTokenByDigest,
  findUserById,
  findUserByUsername,
  insertAuditEvent,
  insertObservation,
  listApiKeys,
  listUserPageAssignments,
  listUsers,
  lockUserForApiKeyRotation,
  lockUserForDeviceTokenMutation,
  recordAgentKeyUse,
  revokeApiKeysByIds,
  revokeApiKeysForUser,
  revokeAuthSessionsForUser,
  revokeAuthSession,
  revokeDeviceTokenById,
  touchApiKey,
  touchAuthSession,
  unassignUserFromPage,
  updateUserPasswordHash,
  createDeviceToken,
  findDeviceTokenByDigest,
  findDeviceTokenForUser,
  findModelBySlug,
  insertAccessGrant,
  listDeviceTokensForUser,
  listGrantsForUser,
  listModelsByIds,
  listPagesByIds,
  resolveGrantedPageAssignments,
  revokeAccessGrants,
  revokeDeviceTokensForUser,
  setDeviceTokenHarvestMachine,
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
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "./errors.ts";
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
  /** Set instead of `actorUserId` when the actor is an agent key (no human);
   *  recorded inside the audit metadata, since `actor_user_id` references users. */
  actorAgentKeyId?: number | null;
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

/**
 * A request made BY A PERSON: a cookie session, an API key or a device token,
 * each carrying the human whose grants decide what the request may read.
 */
export interface HumanAuthPrincipal {
  /** Absent by design: the discriminant only exists on the agent variant. */
  kind?: undefined;
  authMethod: "session" | "api_key" | "device_token";
  user: AuthenticatedUser;
  assignedPageIds: number[];
  /** Present only for a device-token principal; never caller-controlled. */
  deviceTokenId?: number;
  /** Present only for a cookie-session principal; used to revalidate a
   * reserve request after taking the user credential-mutation lock. */
  authSessionId?: number;
  /** Owner-bound capability carried by this exact device token. */
  harvestMachineId?: string;
}

/**
 * Agent Read Plane principal (slice 0b). There is deliberately NO `user` here.
 *
 * The key's creator is the owner, and an owner-shaped principal would walk
 * straight through `canAccessPage`'s owner short-circuit and every roles-gated
 * route, making the key's explicit `pageIds` grant decorative. Modelling the
 * agent as its own variant makes that impossible to express: TypeScript refuses
 * every `principal.user` read until the site says what an agent gets instead,
 * and the answer for a human-only surface is always "refused".
 */
export interface AgentAuthPrincipal {
  kind: "agent";
  authMethod: "agent_key";
  agentKeyId: number;
  /** Operator-facing key name; safe for logs and audit rows, never secret. */
  keyName: string;
  /** Values from AGENT_CAPABILITIES; stored per key, checked per operation. */
  capabilities: readonly string[];
  /** The explicit page grant. No wildcard, never widened by role. */
  pageIds: number[];
}

export type AuthPrincipal = HumanAuthPrincipal | AgentAuthPrincipal;

/** The authentication methods that existed before the agent plane. */
const HUMAN_AUTH_METHODS: ReadonlySet<AuthPrincipal["authMethod"]> = new Set<
  AuthPrincipal["authMethod"]
>(["session", "api_key", "device_token"]);

export function isAgentPrincipal(principal: AuthPrincipal): principal is AgentAuthPrincipal {
  return principal.kind === "agent";
}

/**
 * Fail-closed narrowing for every pre-agent surface. The check is an explicit
 * ALLOWLIST of the human authentication methods rather than `!== "agent"`, so a
 * future principal kind is refused by default instead of inheriting access.
 */
export function requireHumanPrincipal(
  principal: AuthPrincipal,
): asserts principal is HumanAuthPrincipal {
  if (isAgentPrincipal(principal) || !HUMAN_AUTH_METHODS.has(principal.authMethod)) {
    throw new ForbiddenError("This route is not available to agent keys");
  }
}

/** The mirror guard: an agent-plane route admits nothing but an agent key. */
export function requireAgentPrincipal(
  principal: AuthPrincipal,
): asserts principal is AgentAuthPrincipal {
  if (!isAgentPrincipal(principal)) {
    throw new ForbiddenError("This route requires an agent key");
  }
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
  // An agent key has no row in `users`, so its identity travels in the metadata
  // rather than in actor_user_id; a human audit row is byte-identical to before.
  const metadata = input.actorAgentKeyId == null
    ? input.metadata
    : { ...input.metadata, actorAgentKeyId: input.actorAgentKeyId };

  await insertAuditEvent(app.db, {
    actorUserId: input.actorUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    platformAccountId: input.platformAccountId ?? null,
    source: input.source,
    eventType: input.eventType,
    metadata,
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
    metadata: metadata ?? null,
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
    const lockedUser = await lockUserForDeviceTokenMutation(dbTx, user.id);
    if (!lockedUser) {
      throw new NotFoundError(`User "${input.username}" not found`);
    }
    if (!roleCanUseSession(lockedUser.role)) {
      throw new BadRequestError(`Role "${lockedUser.role}" cannot use password login`);
    }
    assertUserNotDeactivated(lockedUser);
    // Invalidate the authority snapshot held by any legacy/admin issuance
    // request that authenticated before this password reset and is waiting on
    // the same user row lock.  Session revocation alone cannot stop that
    // already-resolved principal from minting a post-reset token.
    await advanceDeviceTokenEpoch(dbTx, user.id);
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
    const deletedPendingDeviceTokens = await deletePendingDeviceTokensForUser(dbTx, user.id);

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.password_updated",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedSessions: revokedSessions.length,
        deletedPendingDeviceTokens: deletedPendingDeviceTokens.length,
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
    await lockUserForDeviceTokenMutation(dbTx, user.id);
    await updateUserDisabledAt(dbTx, user.id, new Date());
    const revokedKeys = await revokeApiKeysForUser(dbTx, user.id, "user_deactivated");
    const revokedTokens = await revokeDeviceTokensForUser(dbTx, user.id, "user_deactivated");
    const revokedSessions = await revokeAuthSessionsForUser(dbTx, user.id, "user_deactivated");
    const deletedPendingDeviceTokens = await deletePendingDeviceTokensForUser(dbTx, user.id);

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.deactivated",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedApiKeys: revokedKeys.length,
        revokedDeviceTokens: revokedTokens.length,
        revokedSessions: revokedSessions.length,
        deletedPendingDeviceTokens: deletedPendingDeviceTokens.length,
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
    const lockedUser = await lockUserForDeviceTokenMutation(dbTx, user.id);
    if (
      !lockedUser
      || lockedUser.disabledAt
      || !roleCanUseSession(lockedUser.role)
      || lockedUser.passwordHash !== user.passwordHash
    ) {
      throw new UnauthorizedError("Password authority changed while the request was in flight");
    }
    // See setUserPassword: linearize legacy token issuance with the password
    // boundary, not merely with session lookup at request entry.
    await advanceDeviceTokenEpoch(dbTx, user.id);
    await updateUserPasswordHash(dbTx, user.id, passwordHash);
    await updateUserMustChangePassword(dbTx, user.id, false);
    const revokedSessions = await revokeAuthSessionsForUser(dbTx, user.id, "password_changed");
    const deletedPendingDeviceTokens = await deletePendingDeviceTokensForUser(dbTx, user.id);
    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      eventType: "user.password_changed_self",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedSessions: revokedSessions.length,
        deletedPendingDeviceTokens: deletedPendingDeviceTokens.length,
      },
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

/** D116(c) fleet-gate foundation (desktop D19). Per ACTIVE chatter: does a
 * live device token exist whose last_used_at is fresher than the window, and
 * how many API keys remain active. Read-only. Probe/script automation shares
 * the chatter role (no schema flag yet), so this deliberately publishes
 * summary COUNTS instead of an all-chatters go/no-go boolean — that flag
 * would be permanently false until the service-account split classifies
 * accounts; phase-2 CI applies policy over the rows then. apiKeyLastUsedAt
 * deliberately spans revoked keys (rotation moves the real last use onto a
 * revoked row — same idiom as getAdminUserById). */
export const DEVICE_TOKEN_ADOPTION_FRESH_WINDOW_DAYS = 14;

export async function deviceTokenAdoptionReport(app: AppContext, now = new Date()) {
  const freshFloor = now.getTime()
    - DEVICE_TOKEN_ADOPTION_FRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const users = await listUsers(app.db);
  const chatters = [];
  for (const user of users) {
    if (user.role !== "chatter" || user.disabledAt) continue;
    const tokens = await listDeviceTokensForUser(app.db, user.id);
    const liveTokens = tokens.filter(
      (token) => token.revokedAt === null && token.expiresAt > now,
    );
    // Both token fields describe ONE row: the live token most recently used.
    // Multiple live tokens per user are routine (one per machine, issue never
    // revokes siblings) — an independent max(expiresAt) could advertise a
    // never-used sibling's 90 days while the token actually in daily use dies
    // at its 365-day hard cap tomorrow (Stage 22 max lifetime).
    const anchorToken = liveTokens.reduce<(typeof liveTokens)[number] | null>(
      (best, token) => (
        token.lastUsedAt !== null
          && (best === null || token.lastUsedAt > best.lastUsedAt!)
          ? token
          : best
      ),
      null,
    );
    const keys = await listApiKeys(app.db, [user.id]);
    const lastKeyUse = keys.reduce<Date | null>((max, key) => (
      key.lastUsedAt && (max === null || key.lastUsedAt > max) ? key.lastUsedAt : max
    ), null);
    chatters.push({
      username: user.username,
      hasFreshDeviceToken: anchorToken !== null
        && anchorToken.lastUsedAt!.getTime() >= freshFloor,
      deviceTokenLastUsedAt: anchorToken?.lastUsedAt?.toISOString() ?? null,
      deviceTokenExpiresAt: anchorToken?.expiresAt.toISOString() ?? null,
      activeApiKeys: keys.filter((key) => key.revokedAt === null).length,
      apiKeyLastUsedAt: lastKeyUse?.toISOString() ?? null,
    });
  }
  return {
    generatedAt: now.toISOString(),
    freshWindowDays: DEVICE_TOKEN_ADOPTION_FRESH_WINDOW_DAYS,
    chatters,
    summary: {
      activeChatters: chatters.length,
      onFreshTokens: chatters.filter((row) => row.hasFreshDeviceToken).length,
      withActiveApiKeys: chatters.filter((row) => row.activeApiKeys > 0).length,
    },
  };
}

export async function cleanupExpiredSessions(app: AppContext, now = new Date()) {
  await Promise.all([
    deleteExpiredAuthSessions(app.db, now),
    deleteExpiredPendingDeviceTokens(app.db, now),
  ]);
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
    authSessionId: session.id,
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
  // The agent branch comes FIRST and returns: an agent key is granted exactly
  // the pages it was issued for, and the owner short-circuit below must stay
  // unreachable for it (the key's creator is the owner).
  if (isAgentPrincipal(principal)) {
    return principal.pageIds.includes(pageId);
  }

  if (principal.user.role === "owner") {
    return true;
  }

  return principal.assignedPageIds.includes(pageId);
}

export function requireDashboardUser(
  principal: AuthPrincipal,
): asserts principal is HumanAuthPrincipal {
  if (principal.authMethod !== "session") {
    throw new ForbiddenError("Dashboard routes require a cookie session");
  }
  if (!roleCanUseDashboard(principal.user.role)) {
    throw new ForbiddenError("This role cannot access dashboard routes");
  }
}

/**
 * Any live cookie session, any human role (self-serve auth surface). Asserts
 * rather than returns, so the narrowed `principal.authSessionId` is available to
 * the caller and an agent key cannot reach the body at all.
 */
export function requireSessionUser(
  principal: AuthPrincipal,
): asserts principal is HumanAuthPrincipal & { authSessionId: number } {
  if (principal.authMethod !== "session" || principal.authSessionId === undefined) {
    throw new ForbiddenError("This route requires a cookie session");
  }
}

export function requireOwner(principal: AuthPrincipal): asserts principal is HumanAuthPrincipal {
  requireDashboardUser(principal);
  if (principal.user.role !== "owner") {
    throw new ForbiddenError("Owner access required");
  }
}

export function requireApiKeyUser(
  principal: AuthPrincipal,
): asserts principal is HumanAuthPrincipal {
  if (principal.authMethod !== "api_key" && principal.authMethod !== "device_token") {
    throw new ForbiddenError("Bearer credential required");
  }
}

export function requireDeviceTokenUser(principal: AuthPrincipal) {
  if (principal.authMethod !== "device_token" || principal.deviceTokenId === undefined) {
    throw new ForbiddenError("Device-token bearer required");
  }
  return principal.deviceTokenId;
}

export function requireHarvestDeviceToken(principal: AuthPrincipal) {
  requireHumanPrincipal(principal);
  const deviceTokenId = requireDeviceTokenUser(principal);
  if (!principal.harvestMachineId) {
    throw new ForbiddenError("This device token has no Desktop harvest capability");
  }
  return { deviceTokenId, machineId: principal.harvestMachineId };
}

/**
 * Identity fields for logs and warnings, for EITHER principal variant. Log
 * statements must not be the reason a fail-closed union needs a `user` — an
 * agent contributes its key id and name, never a fabricated user.
 */
export function principalLogFields(principal: AuthPrincipal) {
  return isAgentPrincipal(principal)
    ? {
      authMethod: principal.authMethod,
      agentKeyId: principal.agentKeyId,
      agentKeyName: principal.keyName,
    }
    : {
      authMethod: principal.authMethod,
      userId: principal.user.id,
      username: principal.user.username,
      role: principal.user.role,
    };
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
  // The log-only window is a HUMAN-role calibration device; it never applies to
  // an agent key, which has no role to calibrate and is refused outright.
  requireHumanPrincipal(principal);
  try {
    requireDashboardUser(principal);
  } catch (error) {
    if (app.config.revenueRouteRoleEnforcement === "enforce") {
      throw error;
    }
    app.logger.warn({
      path: routePath,
      ...principalLogFields(principal),
    }, "would-deny: revenue route requires a dashboard session role (log-only mode)");
  }
}


// --- Device tokens (kernel Stage 22) ---

export const DEVICE_TOKEN_PREFIX = "agency_hub_device_";
/** Reservation prefix intentionally unknown to pre-0092 Core builds.  A
 * rollback therefore routes it as a legacy API key and fails authentication
 * even after a newer Core has activated the digest into device_tokens. */
export const PENDING_DEVICE_TOKEN_PREFIX = "agency_hub_pending_device_";
const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PENDING_DEVICE_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Sliding refresh never extends past creation + this hard cap. */
const DEVICE_TOKEN_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** Refresh writes are throttled: bump only when it gains at least a day. */
const DEVICE_TOKEN_REFRESH_GRANULARITY_MS = 24 * 60 * 60 * 1000;

export async function issueDeviceToken(
  app: AppContext,
  input: {
    userId: number;
    /** Present for the self-serve session route; omitted for owner/CLI issue. */
    authSessionId?: number;
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
    const lockedUser = await lockUserForDeviceTokenMutation(dbTx, user.id);
    if (!lockedUser) {
      throw new NotFoundError("User not found");
    }
    if (!roleCanUseSession(lockedUser.role)) {
      throw new BadRequestError(`Role "${lockedUser.role}" cannot hold device tokens`);
    }
    assertUserNotDeactivated(lockedUser);
    if (lockedUser.deviceTokenEpoch !== user.deviceTokenEpoch) {
      throw new ConflictError("Device-token authority changed while issuance was in flight");
    }
    if (input.authSessionId !== undefined) {
      const session = await findAuthSessionById(dbTx, input.authSessionId);
      if (
        !session
        || session.userId !== lockedUser.id
        || session.revokedAt
        || session.expiresAt <= new Date()
      ) {
        throw new UnauthorizedError("Session is no longer eligible to issue a device token");
      }
    }
    const createdToken = await createDeviceToken(dbTx, {
      userId: lockedUser.id,
      label: input.label,
      tokenDigest: sha256Hex(rawToken),
      keyPrefix,
      expiresAt,
    });

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.issued",
      targetUserId: lockedUser.id,
      metadata: { username: lockedUser.username, label: input.label, keyPrefix },
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

/** Reserve a server-generated token without making it an application bearer.
 * The caller's session is revalidated after the user mutation lock is held, so
 * a password reset cannot race an already-authenticated request into creating
 * a fresh pending credential after session revocation. */
export async function reservePendingDeviceToken(
  app: AppContext,
  input: {
    userId: number;
    authSessionId: number;
    label: string;
  },
  audit: AuditContext,
) {
  const userAtStart = await findUserById(app.db, input.userId);
  if (!userAtStart || userAtStart.disabledAt || !roleCanUseSession(userAtStart.role)) {
    throw new UnauthorizedError("Session is no longer eligible to reserve a device token");
  }
  const tokenBody = randomToken(24);
  const rawToken = `${PENDING_DEVICE_TOKEN_PREFIX}${tokenBody}`;
  const keyPrefix = `${PENDING_DEVICE_TOKEN_PREFIX}${tokenBody.slice(0, API_KEY_DISPLAY_LENGTH)}`;

  const created = await withAuditTransaction(app, async (dbTx) => {
    const user = await lockUserForDeviceTokenMutation(dbTx, input.userId);
    const session = await findAuthSessionById(dbTx, input.authSessionId);
    if (
      !user
      || user.disabledAt
      || !roleCanUseSession(user.role)
      || !session
      || session.userId !== user.id
      || session.revokedAt
      || session.expiresAt <= new Date()
      || user.deviceTokenEpoch !== userAtStart.deviceTokenEpoch
    ) {
      throw new UnauthorizedError("Session is no longer eligible to reserve a device token");
    }
    const expiresAt = new Date(Date.now() + PENDING_DEVICE_TOKEN_TTL_MS);

    const reservation = await createPendingDeviceToken(dbTx, {
      userId: user.id,
      label: input.label,
      tokenDigest: sha256Hex(rawToken),
      keyPrefix,
      expiresAt,
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.reserved",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        label: input.label,
        keyPrefix,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return reservation;
  });

  return {
    token: rawToken,
    reservationId: created.id,
    label: created.label,
    keyPrefix,
    reservationExpiresAt: created.expiresAt,
  };
}

export interface PendingDeviceTokenActivationCredential {
  token: string;
  userId: number;
  state: "pending" | "active";
}

/** Specialized authentication for the activation route.  It admits only the
 * 0092 reservation prefix.  An already-moved active row is recognized solely
 * to make a lost activation response retry idempotent. */
export async function authenticatePendingDeviceTokenForActivation(
  app: AppContext,
  rawToken: string,
): Promise<PendingDeviceTokenActivationCredential | null> {
  if (!rawToken.startsWith(PENDING_DEVICE_TOKEN_PREFIX)) {
    return null;
  }
  const digest = sha256Hex(rawToken);
  const now = new Date();
  const pending = await findPendingDeviceTokenByDigest(app.db, digest);
  if (pending && pending.expiresAt > now) {
    const user = await findUserById(app.db, pending.userId);
    if (user && !user.disabledAt && roleCanUseSession(user.role)) {
      return { token: rawToken, userId: user.id, state: "pending" };
    }
    return null;
  }
  const active = await findDeviceTokenByDigest(app.db, digest);
  if (!active || active.revokedAt || active.expiresAt <= now) {
    return null;
  }
  const user = await findUserById(app.db, active.userId);
  return user && !user.disabledAt && roleCanUseSession(user.role)
    ? { token: rawToken, userId: user.id, state: "active" }
    : null;
}

/** Atomically linearizes activation against password reset, disable,
 * revoke-all and another activation.  Both pending and user rows are locked in
 * the common user-then-pending order. */
export async function activatePendingDeviceToken(
  app: AppContext,
  credential: PendingDeviceTokenActivationCredential,
) {
  if (!credential.token.startsWith(PENDING_DEVICE_TOKEN_PREFIX)) {
    throw new UnauthorizedError("Invalid pending device token");
  }
  const digest = sha256Hex(credential.token);
  const activated = await withAuditTransaction(app, async (dbTx) => {
    const user = await lockUserForDeviceTokenMutation(dbTx, credential.userId);
    if (!user || user.disabledAt || !roleCanUseSession(user.role)) {
      throw new UnauthorizedError("Invalid pending device token");
    }
    // Time is sampled only after the potentially long row-lock wait.  A
    // reservation that expires while revoke/reset owns the lock cannot cross
    // its TTL on a stale pre-wait timestamp.
    const now = new Date();

    const pending = await findPendingDeviceTokenByDigest(dbTx, digest, { forUpdate: true });
    if (pending !== null) {
      if (pending.userId !== user.id || pending.expiresAt <= now) {
        throw new UnauthorizedError("Pending device token has expired");
      }
      const expiresAt = new Date(now.getTime() + DEVICE_TOKEN_TTL_MS);
      const active = await createDeviceToken(dbTx, {
        userId: pending.userId,
        label: pending.label,
        tokenDigest: pending.tokenDigest,
        keyPrefix: pending.keyPrefix,
        expiresAt,
      });
      await deletePendingDeviceTokenById(dbTx, pending.id);
      await recordAudit({ db: dbTx }, {
        source: "api",
        actorUserId: user.id,
        targetUserId: user.id,
        eventType: "device_token.activated",
        metadata: {
          username: user.username,
          deviceTokenId: active.id,
          label: active.label,
          keyPrefix: active.keyPrefix,
        },
      });
      return active;
    }

    // Response-loss retry: the digest has already moved.  Never resurrect a
    // revoked/expired row and never accept a legacy-prefix active token here.
    const active = await findDeviceTokenByDigest(dbTx, digest);
    if (
      !active
      || active.userId !== user.id
      || active.revokedAt
      || active.expiresAt <= now
      || !credential.token.startsWith(PENDING_DEVICE_TOKEN_PREFIX)
    ) {
      throw new UnauthorizedError("Invalid pending device token");
    }
    return active;
  });

  return {
    id: activated.id,
    label: activated.label,
    keyPrefix: activated.keyPrefix,
    expiresAt: activated.expiresAt,
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
    deviceTokenId: record.id,
    ...(record.harvestMachineId ? { harvestMachineId: record.harvestMachineId } : {}),
  } satisfies AuthPrincipal;
}

// --- Agent Read Plane keys (agent-read slice 0b) ---

/** Distinct prefix: an agent key is never mistaken for a human credential. */
export const AGENT_KEY_TOKEN_PREFIX = "agency_hub_agent_";

/**
 * Authenticates an agent key into the `user`-less agent principal.
 *
 * Revoked and expired keys are refused by `recordAgentKeyUse` itself: its WHERE
 * clause carries the `revoked_at is null and expires_at > now` guard, so a dead
 * key matches nothing, gets neither a fresh `last_used_at` nor a resurrected
 * expiry, and returns null here. The lookup before it exists only so an unknown
 * digest and a dead key are the same non-answer; nothing about the row is
 * revealed either way.
 */
export async function authenticateAgentKey(app: AppContext, agentKeyToken: string) {
  const record = await findAgentKeyByDigest(app.db, sha256Hex(agentKeyToken));
  if (!record) {
    return null;
  }

  // Slides expires_at (+90 days, clamped to created_at + 365) and stamps
  // last_used_at in ONE guarded statement; null means the key was revoked or
  // already expired between the lookup and the write.
  const used = await recordAgentKeyUse(app.db, { id: record.id });
  if (!used) {
    return null;
  }

  return {
    kind: "agent" as const,
    authMethod: "agent_key" as const,
    agentKeyId: record.id,
    keyName: record.name,
    capabilities: record.capabilities,
    pageIds: record.pageIds,
  } satisfies AgentAuthPrincipal;
}

/** Prefix-discriminated bearer authentication: agent key, api key or device token. */
export async function authenticateBearerToken(app: AppContext, token: string) {
  if (token.startsWith(DEVICE_TOKEN_PREFIX) || token.startsWith(PENDING_DEVICE_TOKEN_PREFIX)) {
    return authenticateDeviceToken(app, token);
  }
  // Before the api-key fallback: an agent key must never be resolved by the
  // legacy path, whose principal would carry a human user.
  if (token.startsWith(AGENT_KEY_TOKEN_PREFIX)) {
    return authenticateAgentKey(app, token);
  }
  return authenticateApiKeyToken(app, token);
}

export async function listDeviceTokensForUsername(app: AppContext, username: string) {
  const user = await findUserByUsername(app.db, username);
  if (!user) {
    throw new NotFoundError(`User "${username}" not found`);
  }
  const tokens = await listDeviceTokensForUser(app.db, user.id);
  return tokens.map((token) => deviceTokenResponse(token));
}

function deviceTokenResponse(token: Awaited<ReturnType<typeof listDeviceTokensForUser>>[number]) {
  return {
    id: token.id,
    label: token.label,
    keyPrefix: token.keyPrefix,
    harvestMachineId: token.harvestMachineId ?? null,
    isActive: token.revokedAt === null && token.expiresAt > new Date(),
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
    revokedAt: token.revokedAt?.toISOString() ?? null,
    revokedReason: token.revokedReason ?? null,
  };
}

export async function setDeviceTokenHarvestCapabilityForUsername(
  app: AppContext,
  input: { username: string; deviceTokenId: number; machineId: string | null },
  audit: AuditContext,
) {
  const user = await findUserByUsername(app.db, input.username);
  if (!user) {
    throw new NotFoundError(`User "${input.username}" not found`);
  }

  return withAuditTransaction(app, async (dbTx) => {
    const token = await findDeviceTokenForUser(dbTx, {
      deviceTokenId: input.deviceTokenId,
      userId: user.id,
    });
    if (!token) {
      throw new NotFoundError(`Device token ${input.deviceTokenId} not found for "${input.username}"`);
    }
    if (token.revokedAt || token.expiresAt <= new Date()) {
      throw new BadRequestError("Harvest capability requires an active device token");
    }

    const changed = await setDeviceTokenHarvestMachine(dbTx, {
      deviceTokenId: token.id,
      userId: user.id,
      machineId: input.machineId,
    });
    if (!changed.updated) {
      throw new BadRequestError("Harvest capability requires an active device token");
    }

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.harvest_capability_changed",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        deviceTokenId: token.id,
        previousMachineId: token.harvestMachineId ?? null,
        machineId: input.machineId,
        replacedTokenId: changed.replacedTokenId,
      },
    });

    return deviceTokenResponse(changed.updated);
  });
}

export async function revokeCurrentDeviceToken(
  app: AppContext,
  principal: AuthPrincipal,
  audit: AuditContext,
) {
  requireHumanPrincipal(principal);
  const deviceTokenId = requireDeviceTokenUser(principal);
  await withAuditTransaction(app, async (dbTx) => {
    const revoked = await revokeDeviceTokenById(dbTx, {
      deviceTokenId,
      userId: principal.user.id,
      reason: "self_revoked",
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.self_revoked",
      targetUserId: principal.user.id,
      metadata: {
        username: principal.user.username,
        deviceTokenId,
        changed: revoked !== null,
      },
    });
  });
  return { revoked: true as const };
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
    await lockUserForDeviceTokenMutation(dbTx, user.id);
    await advanceDeviceTokenEpoch(dbTx, user.id);
    const revokedTokens = await revokeDeviceTokensForUser(dbTx, user.id, "revoked");
    const deletedPendingDeviceTokens = await deletePendingDeviceTokensForUser(dbTx, user.id);
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.revoked",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedCount: revokedTokens.length,
        deletedPendingDeviceTokens: deletedPendingDeviceTokens.length,
      },
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
