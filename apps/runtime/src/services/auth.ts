import { createHash, randomUUID } from "node:crypto";

import argon2 from "argon2";

import {
  assignUserToPage,
  advanceDeviceTokenEpoch,
  createAuthSession,
  createPendingDeviceToken,
  createUser,
  deleteExpiredAuthSessions,
  deleteExpiredPendingDeviceTokens,
  deletePendingDeviceTokenById,
  deletePendingDeviceTokensForUser,
  findAgentKeyByDigest,
  findAuthSessionByDigest,
  findPendingDeviceTokenByDigest,
  findUserById,
  findUserByUsername,
  insertAuditEvent,
  insertObservation,
  isUniqueViolation,
  listActiveDeviceTokensForUser,
  listUserPageAssignments,
  listUsers,
  lockUserForDeviceTokenMutation,
  markUserDeleted,
  recordAgentKeyUse,
  revokeActiveAccountLinks,
  revokeAuthSessionsForUser,
  revokeAuthSessionsForUserExcept,
  revokeAuthSession,
  revokeDeviceTokenById,
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
  revokeAllAccessGrantsForUser,
  revokeDeviceTokensForUser,
  setDeviceTokenHarvestMachine,
  updateDeviceTokenUse,
  updateUserDisabledAt,
} from "@agency_hub_core/db";
import {
  creatableUserRoles,
  randomToken,
  sha256Hex,
  type CreatableUserRole,
  type UserRole,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  type AuthFailureReason,
} from "./errors.ts";
import { findPageSummaryByLabel } from "@agency_hub_core/db";

export const SESSION_COOKIE_NAME = "agency_hub_core_session";
/** How much of a bearer is safe to show an operator (and to store as the
 * lookup-free display prefix). Exported so a fixture cannot drift from it. */
export const KEY_PREFIX_DISPLAY_LENGTH = 10;

// Fixed argon2id hash used to equalize timing on login failure paths so that a
// missing/ineligible user is indistinguishable from a wrong password. The plaintext
// is irrelevant; it is never expected to verify successfully.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$uBvthN/XqL8U0tfIpEFZog$GEU0fF0w4vScnjMXlxqLdhsBF8L7Ixzhj8R3ISHudHA";

export interface AuditContext {
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
  /** DEPRECATED (Decision 369): a wire-only constant. See authUserSchema. */
  mustChangePassword: false;
}

export interface AdminUserDetailed extends AuthenticatedUser {
  disabledAt: string | null;
  deletedAt: string | null;
  lastActiveAt: string | null;
  /** Decision 349 (§4.1 p.12): "invited" until the invite link sets a password. */
  registrationState: "invited" | "active";
}

/**
 * A request made BY A PERSON: a cookie session or a device token, each carrying
 * the human whose grants decide what the request may read. (Decision 369 retired
 * the third lane, the API key.)
 */
export interface HumanAuthPrincipal {
  /** Absent by design: the discriminant only exists on the agent variant. */
  kind?: undefined;
  authMethod: "session" | "device_token";
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
>(["session", "device_token"]);

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

export function roleCanUseSession(role: UserRole) {
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
export async function listEffectivePageAssignments(app: AppContext, userId: number) {
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

/** Deleted identities remain in storage for history, never for account work. */
export async function getExistingUserById(db: AppContext["db"], userId: number) {
  const user = await findUserById(db, userId);
  if (!user || user.deletedAt) throw new NotFoundError("User not found");
  return user;
}

/** Every existing-account write takes the same identity lock and revalidates
 * permanent deletion after waiting. A reusable username is never re-resolved. */
export async function lockExistingUserById(dbTx: AppContext["db"], userId: number) {
  const user = await lockUserForDeviceTokenMutation(dbTx, userId);
  if (!user || user.deletedAt) throw new NotFoundError("User not found");
  return user;
}

/** Disabled accounts are frozen for new credentials and assignment changes;
 * a permanently deleted account can never be restored at all. */
export function assertUserNotDeactivated(user: { username: string; disabledAt: Date | null; deletedAt: Date | null }) {
  if (user.deletedAt) throw new NotFoundError("User not found");
  if (user.disabledAt) {
    throw new BadRequestError(`User "${user.username}" is deactivated`);
  }
}

async function getAuthenticatedUserById(app: AppContext, userId: number) {
  const user = await findUserById(app.db, userId);
  // Deactivation is fail-closed at the principal root (decision #126): every
  // authenticate* path resolves through here, so a disabled row can never
  // become a principal even if a credential row survived revocation.
  if (!user || user.disabledAt || user.deletedAt) {
    return null;
  }

  const assignedPages = await listEffectivePageAssignments(app, user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    // Decision 369: the #116(b) flag is retired. The column survives as a fact;
    // the wire says `false` for everyone, always.
    mustChangePassword: false,
    assignedPages: mapAssignedPages(assignedPages),
  } satisfies AuthenticatedUser;
}

export async function getAdminUserById(app: AppContext, userId: number) {
  const user = await findUserById(app.db, userId);
  if (!user || user.deletedAt) {
    return null;
  }

  const [assignedPages, userDeviceTokens] = await Promise.all([
    listEffectivePageAssignments(app, user.id),
    roleCanUseSession(user.role) ? listDeviceTokensForUser(app.db, user.id) : Promise.resolve([]),
  ]);

  // Honest activity signal: the freshest use across every device token, live or
  // revoked — a revoked row can still hold the most recent real activity.
  const lastActiveMs = Math.max(
    0,
    ...userDeviceTokens.map((token) => token.lastUsedAt?.getTime() ?? 0),
  );

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: false,
    assignedPages: mapAssignedPages(assignedPages),
    disabledAt: user.disabledAt?.toISOString() ?? null,
    deletedAt: null,
    lastActiveAt: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
    registrationState: user.passwordHash === null ? "invited" : "active",
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
 * runs directly — the real Database always has one.
 *
 * Exported because every credential mutation needs it and re-implementing it per
 * service is how one of them ends up without it (agent-read review round 2 found
 * exactly that: an issued key committed before its audit row). */
export async function withAuditTransaction<T>(
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

/** Decision 349 (Р4): two concurrent creates of the same login (any case) race
 * on the lower(username) unique index; the loser gets the same 400 the
 * pre-check gives, never a 500. */
export async function createUserOrRefuseDuplicate(
  db: AppContext["db"],
  input: Parameters<typeof createUser>[1],
) {
  let created: Awaited<ReturnType<typeof createUser>>;
  try {
    created = await createUser(db, input);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BadRequestError(`User "${input.username}" already exists`);
    }
    throw error;
  }
  if (!created) {
    throw new Error("User insert returned no row");
  }
  return created;
}

/** Decision 349 (Р4): one normalization for invite, legacy create and login. */
export function normalizeUsername(username: string) {
  return username.trim();
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

  const existing = await findUserByUsername(app.db, normalizeUsername(input.username));
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
    const createdUser = await createUserOrRefuseDuplicate(dbTx, {
      username: normalizeUsername(input.username),
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

  const user = await getAuthenticatedUserById(app, created.id);
  if (!user) throw new NotFoundError("Created account is no longer available");
  return user;
}

/**
 * Owner-set password, CLI only since Decision 369 (the HTTP route is gone; the
 * owner resets a chatter with a link). It is the SAME reset primitive the link
 * redemption uses: every sign-in of that person ends with the old password —
 * before Decision 369 this path left device tokens alive, which made "I reset his
 * password" a false statement about a laptop still holding a live token.
 */
export async function setUserPassword(
  app: AppContext,
  input: {
    userId: number;
    password: string;
  },
  audit: AuditContext,
) {
  const user = await getExistingUserById(app.db, input.userId);
  // Stage 22: every session-capable role may hold a password (the chatter
  // invite flow v1 is admin-set-password); content_manager stays out.
  if (!roleCanUseSession(user.role)) {
    throw new BadRequestError(`Role "${user.role}" cannot use password login`);
  }
  assertUserNotDeactivated(user);

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  await withAuditTransaction(app, async (dbTx) => {
    const lockedUser = await lockExistingUserById(dbTx, user.id);
    if (!roleCanUseSession(lockedUser.role)) {
      throw new BadRequestError(`Role "${lockedUser.role}" cannot use password login`);
    }
    assertUserNotDeactivated(lockedUser);
    await updateUserPasswordHash(
      dbTx,
      user.id,
      passwordHash,
    );
    // §4.4 "Завершить все входы": device tokens, reservations, sessions and the
    // epoch bump that invalidates any authority snapshot already in flight.
    const terminated = await terminateAccessTx(dbTx, user, "password_reset");
    // Decision 349 §4.1 p.6: a password set by any path retires every active link.
    const revokedAccountLinks = await revokeActiveAccountLinks(dbTx, user.id, "password_set");

    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.password_updated",
      targetUserId: user.id,
      metadata: {
        username: lockedUser.username,
        revokedDeviceTokens: terminated.deviceTokens,
        revokedSessions: terminated.sessions,
        deletedPendingDeviceTokens: terminated.pendingDeviceTokens,
        revokedAccountLinks: revokedAccountLinks.length,
      },
    });
  });
}

/** Disable keeps the login reserved and can be explicitly reversed. Both
 * lifecycle operations revoke credentials under the same immutable-user lock. */
export async function deactivateUser(
  app: AppContext,
  input: { userId: number },
  audit: AuditContext,
) {
  return withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
    assertUserCanBeOffboarded(user, audit, "deactivated");
    if (user.disabledAt) {
      throw new BadRequestError(`User "${user.username}" is already deactivated`);
    }
    await updateUserDisabledAt(dbTx, user.id, new Date());
    const revoked = await terminateAccessTx(dbTx, user, "user_deactivated");
    const links = await revokeActiveAccountLinks(dbTx, user.id, "user_deactivated");
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.deactivated",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedDeviceTokens: revoked.deviceTokens,
        revokedSessions: revoked.sessions,
        deletedPendingDeviceTokens: revoked.pendingDeviceTokens,
        revokedAccountLinks: links.length,
      },
    });
    return {
      ok: true as const,
      revokedDeviceTokens: revoked.deviceTokens,
      revokedSessions: revoked.sessions,
    };
  });
}

function assertUserCanBeOffboarded(
  user: { id: number; role: UserRole },
  audit: AuditContext,
  action: "deactivated" | "deleted",
) {
  if (user.role === "owner") throw new BadRequestError(`Owner accounts cannot be ${action}`);
  if (audit.actorUserId === user.id) throw new BadRequestError("You cannot remove your own account access");
}

/** Permanent deletion retains the row, name and every attribution FK, while
 * releasing the login for an unrelated new identity. It cannot be undone. */
export async function deleteUser(
  app: AppContext,
  input: { userId: number },
  audit: AuditContext,
) {
  return withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
    assertUserCanBeOffboarded(user, audit, "deleted");
    const deletedAt = new Date();
    const revoked = await terminateAccessTx(dbTx, user, "user_deleted");
    const links = await revokeActiveAccountLinks(dbTx, user.id, "user_deleted");
    const revokedGrants = await revokeAllAccessGrantsForUser(dbTx, {
      userId: user.id,
      revokedBy: audit.actorUserId ?? null,
      revokedAt: deletedAt,
    });
    // This table is only the legacy live projection. Its durable history is
    // the grant log above; clear it even when reads currently use grants.
    const assignments = await listUserPageAssignments(dbTx, user.id);
    for (const assignment of assignments) {
      await unassignUserFromPage(dbTx, user.id, assignment.pageId);
    }
    await markUserDeleted(dbTx, user.id, deletedAt);
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.deleted",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedDeviceTokens: revoked.deviceTokens,
        revokedSessions: revoked.sessions,
        deletedPendingDeviceTokens: revoked.pendingDeviceTokens,
        revokedAccountLinks: links.length,
        revokedGrants,
        unassignedPageIds: assignments.map((assignment) => assignment.pageId),
      },
    });
    return {
      ok: true as const,
      revokedDeviceTokens: revoked.deviceTokens,
      revokedSessions: revoked.sessions,
    };
  });
}

/** Restore only a disabled, non-deleted identity. Old credentials stay revoked;
 * a password-change requirement is preserved along with the stored password. */
export async function reactivateUser(
  app: AppContext,
  input: { userId: number },
  audit: AuditContext,
) {
  return withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
    if (!user.disabledAt) {
      throw new BadRequestError(`User "${user.username}" is not deactivated`);
    }
    await updateUserDisabledAt(dbTx, user.id, null);
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.reactivated",
      targetUserId: user.id,
      metadata: { username: user.username },
    });
    return { ok: true as const };
  });
}

/**
 * Self-serve password change (Stage 22): verifies the current password, sets
 * the new one and revokes every session — the caller re-logs-in with the new
 * credential.
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
  if (!user || user.deletedAt || user.disabledAt || !user.passwordHash) {
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
      || lockedUser.deletedAt
      || !roleCanUseSession(lockedUser.role)
      || lockedUser.passwordHash !== user.passwordHash
      || lockedUser.deviceTokenEpoch !== user.deviceTokenEpoch
    ) {
      throw new UnauthorizedError("Password authority changed while the request was in flight");
    }
    // See setUserPassword: linearize legacy token issuance with the password
    // boundary, not merely with session lookup at request entry.
    await advanceDeviceTokenEpoch(dbTx, user.id);
    await updateUserPasswordHash(dbTx, user.id, passwordHash);
    const revokedSessions = await revokeAuthSessionsForUser(dbTx, user.id, "password_changed");
    const deletedPendingDeviceTokens = await deletePendingDeviceTokensForUser(dbTx, user.id);
    const revokedAccountLinks = await revokeActiveAccountLinks(dbTx, user.id, "password_set");
    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      eventType: "user.password_changed_self",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedSessions: revokedSessions.length,
        deletedPendingDeviceTokens: deletedPendingDeviceTokens.length,
        revokedAccountLinks: revokedAccountLinks.length,
      },
    });
  });
  return { ok: true as const };
}

export async function assignPageToUser(
  app: AppContext,
  input: {
    userId: number;
    pageLabel: string;
  },
  audit: AuditContext,
) {
  const user = await getExistingUserById(app.db, input.userId);
  assertUserNotDeactivated(user);

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  // Grant + assignment + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    await assignPageToUserTx(app, dbTx, { userId: user.id, page }, audit);
  });
}

/**
 * The transaction-aware core of a page assignment (Decision 349 §5.2): callers
 * that already hold a transaction — the atomic invite — compose it; the
 * standalone route wraps it. Stage 22: the grant log is the durable record; the
 * legacy assignment row is dual-written until the read path flips.
 */
export async function assignPageToUserTx(
  app: Pick<AppContext, "config">,
  dbTx: AppContext["db"],
  input: {
    userId: number;
    page: { id: number; label: string };
  },
  audit: AuditContext,
) {
  const user = await lockExistingUserById(dbTx, input.userId);
  assertUserNotDeactivated(user);
  await insertAccessGrant(dbTx, {
    userId: user.id,
    scopeType: "page",
    scopeId: input.page.id,
    grantedBy: audit.actorUserId ?? null,
  });
  if (!app.config?.accessGrantsReadEnabled) {
    await assignUserToPage(dbTx, user.id, input.page.id);
  }

  await recordAudit({ db: dbTx }, {
    ...audit,
    eventType: "user.page_assigned",
    targetUserId: user.id,
    platformAccountId: input.page.id,
    metadata: {
      username: user.username,
      pageLabel: input.page.label,
    },
  });
}

export async function unassignPageFromUser(
  app: AppContext,
  input: {
    userId: number;
    pageLabel: string;
  },
  audit: AuditContext,
) {
  const user = await getExistingUserById(app.db, input.userId);

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${input.pageLabel}" not found`);
  }

  // Stage 22: revoke = a stamp on the grant log, never a delete. The legacy
  // hard-delete continues only while assignments are still the read path.
  // Revoke + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    const lockedUser = await lockExistingUserById(dbTx, user.id);
    assertUserNotDeactivated(lockedUser);
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
        username: lockedUser.username,
        pageLabel: page.label,
      },
    });
  });
}

/** D116(c) fleet-gate foundation (desktop D19). Per ACTIVE chatter: does a
 * live device token exist whose last_used_at is fresher than the window.
 * Read-only. Probe/script automation shares
 * the chatter role (no schema flag yet), so this deliberately publishes
 * summary COUNTS instead of an all-chatters go/no-go boolean — that flag
 * would be permanently false until the service-account split classifies
 * accounts; phase-2 CI applies policy over the rows then. */
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
    chatters.push({
      username: user.username,
      hasFreshDeviceToken: anchorToken !== null
        && anchorToken.lastUsedAt!.getTime() >= freshFloor,
      deviceTokenLastUsedAt: anchorToken?.lastUsedAt?.toISOString() ?? null,
      deviceTokenExpiresAt: anchorToken?.expiresAt.toISOString() ?? null,
    });
  }
  return {
    generatedAt: now.toISOString(),
    freshWindowDays: DEVICE_TOKEN_ADOPTION_FRESH_WINDOW_DAYS,
    chatters,
    summary: {
      activeChatters: chatters.length,
      onFreshTokens: chatters.filter((row) => row.hasFreshDeviceToken).length,
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

/** The user row as it stands under the credential-mutation lock. */
export type LockedUserRow = NonNullable<Awaited<ReturnType<typeof lockUserForDeviceTokenMutation>>>;

/**
 * Decision 349 §4.3 — the ONE password check for every password-based sign-in
 * (cookie login and device sign-in alike), closing the login race:
 *
 * 1. the shared per-account backoff;
 * 2. lookup (case-insensitive); unknown / deactivated / no password / not
 *    session-capable → dummy verify, backoff, `auth.login_failed`, 401 — the
 *    same answer as a wrong password, no oracle;
 * 3. argon2 verify OUTSIDE the transaction (it is slow; the lock stays short);
 * 4. INSIDE the transaction: `FOR UPDATE` on the user row, then the hash, the
 *    tombstone and the device-token epoch are compared with what was verified.
 *    A reset, a deactivation or a revoke-all that committed while this request
 *    was in flight makes the request 401 — it never mints on stale authority;
 * 5. only then does `run` create the session or token in the SAME transaction.
 */
export async function verifyPasswordAndLockUser<T>(
  app: AppContext,
  input: {
    username: string;
    password: string;
  },
  run: (dbTx: AppContext["db"], user: LockedUserRow) => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const username = normalizeUsername(input.username);
  assertLoginNotBackedOff(app, username, now);

  const user = await findUserByUsername(app.db, username);

  // Deactivated shares the invalid-credentials path (decision #126): the same
  // 401, dummy verify, and backoff as an unknown username — no oracle.
  if (!user || !roleCanUseSession(user.role) || !user.passwordHash || user.disabledAt || user.deletedAt) {
    // Run a dummy verification so this path takes comparable time to the
    // wrong-password path below, avoiding a username-enumeration timing oracle.
    await argon2.verify(DUMMY_PASSWORD_HASH, input.password).catch(() => false);
    recordLoginFailureForBackoff(app, username, now);
    await recordFailedLoginAuditBestEffort(app, {
      username,
    });
    throw new UnauthorizedError("Invalid username or password");
  }

  const isValid = await argon2.verify(user.passwordHash, input.password);
  if (!isValid) {
    recordLoginFailureForBackoff(app, username, now);
    await recordFailedLoginAuditBestEffort(app, {
      username: user.username,
      targetUserId: user.id,
    });
    throw new UnauthorizedError("Invalid username or password");
  }

  clearLoginBackoff(app, username);

  // Credential row + audit dual-write commit together (review R1-7), and the
  // authority is re-read under the lock: what was verified must still be true.
  return withAuditTransaction(app, async (dbTx) => {
    const locked = await lockUserForDeviceTokenMutation(dbTx, user.id);
    if (
      !locked
      || locked.disabledAt
      || locked.deletedAt
      || !roleCanUseSession(locked.role)
      || locked.passwordHash !== user.passwordHash
      || locked.deviceTokenEpoch !== user.deviceTokenEpoch
    ) {
      // The same wording as a wrong password: which boundary won the race is
      // not the caller's business.
      throw new UnauthorizedError("Invalid username or password");
    }
    return run(dbTx, locked);
  });
}

export async function loginWithPassword(
  app: AppContext,
  input: {
    username: string;
    password: string;
  },
) {
  // Session row + audit dual-write commit together (review R1-7): an audit
  // failure must not leave a usable-but-undisclosed session row behind a 500.
  const sessionToken = randomToken(32);
  let expiresAt = new Date(0);
  const user = await verifyPasswordAndLockUser(app, input, async (dbTx, locked) => {
    expiresAt = new Date(Date.now() + app.config.sessionTtlDays * 24 * 60 * 60 * 1000);
    await createAuthSession(dbTx, {
      userId: locked.id,
      tokenDigest: sha256Hex(sessionToken),
      expiresAt,
    });

    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: locked.id,
      targetUserId: locked.id,
      eventType: "auth.login",
      metadata: { username: locked.username },
    });
    return locked;
  });

  const authenticatedUser = await getAuthenticatedUserById(app, user.id);
  if (!authenticatedUser) {
    throw new UnauthorizedError("Authentication failed");
  }

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

/** Policy kind `apiKey` (Decision 369 kept the NAME, retired the credential):
 * the one bearer a person can hold is a device token. */
export function requireApiKeyUser(
  principal: AuthPrincipal,
): asserts principal is HumanAuthPrincipal {
  if (principal.authMethod !== "device_token") {
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
/** Reservation prefix intentionally unknown to pre-0092 Core builds, which
 * fail its authentication even after a newer Core has activated the digest
 * into device_tokens. */
export const PENDING_DEVICE_TOKEN_PREFIX = "agency_hub_pending_device_";
export const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PENDING_DEVICE_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Sliding refresh never extends past creation + this hard cap. */
const DEVICE_TOKEN_MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** Refresh writes are throttled: bump only when it gains at least a day. */
const DEVICE_TOKEN_REFRESH_GRANULARITY_MS = 24 * 60 * 60 * 1000;

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
    if (user && !user.disabledAt && !user.deletedAt && roleCanUseSession(user.role)) {
      return { token: rawToken, userId: user.id, state: "pending" };
    }
    return null;
  }
  const active = await findDeviceTokenByDigest(app.db, digest);
  if (!active || active.revokedAt || active.expiresAt <= now) {
    return null;
  }
  const user = await findUserById(app.db, active.userId);
  return user && !user.disabledAt && !user.deletedAt && roleCanUseSession(user.role)
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
    if (!user || user.disabledAt || user.deletedAt || !roleCanUseSession(user.role)) {
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

/** Decision 349 §4.5: why a presented bearer was refused, when that is safe to
 * say. Only a device token that MATCHED a row carries a reason. */
export interface AuthFailure {
  reason: AuthFailureReason;
}

export type DeviceTokenAuthResult =
  | { principal: HumanAuthPrincipal; failure: null }
  | { principal: null; failure: AuthFailure | null };

/** x-client-version as the device-token lane records it: a short trimmed
 * string or nothing (the same bounds client-versions.ts logs under). */
export function normalizeClientVersionHeader(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const version = value.trim();
  return version.length > 0 && version.length <= 64 ? version : null;
}

export async function authenticateDeviceToken(
  app: AppContext,
  deviceToken: string,
  options?: { clientVersion?: string | null },
): Promise<DeviceTokenAuthResult> {
  const record = await findDeviceTokenByDigest(app.db, sha256Hex(deviceToken));
  const now = new Date();
  if (!record) {
    // Unknown digest: no reason — a reason here would be an enumeration oracle.
    return { principal: null, failure: null };
  }
  if (record.revokedAt) {
    return { principal: null, failure: { reason: "token_revoked" } };
  }
  if (record.expiresAt <= now) {
    return { principal: null, failure: { reason: "token_expired" } };
  }

  const user = await getAuthenticatedUserById(app, record.userId);
  if (!user || !roleCanUseSession(user.role)) {
    // Unreachable by design (deactivation revokes every token); if a row ever
    // survives, fail closed without a reason.
    return { principal: null, failure: null };
  }

  // Sliding expiry: each (throttled) use extends the token up to the hard cap;
  // an idle device dies at expires_at. The client version rides the same
  // statement (Р7): one write per request, never a second.
  const cap = new Date(record.createdAt.getTime() + DEVICE_TOKEN_MAX_LIFETIME_MS);
  const slid = new Date(Math.min(now.getTime() + DEVICE_TOKEN_TTL_MS, cap.getTime()));
  const worthBumping = slid.getTime() - record.expiresAt.getTime() >= DEVICE_TOKEN_REFRESH_GRANULARITY_MS;
  const clientVersion = options?.clientVersion ?? null;
  await updateDeviceTokenUse(app.db, record.id, {
    lastUsedAt: now,
    ...(worthBumping ? { expiresAt: slid } : {}),
    ...(clientVersion !== null && clientVersion !== record.lastClientVersion
      ? { lastClientVersion: clientVersion }
      : {}),
  });

  return {
    principal: {
      authMethod: "device_token" as const,
      user,
      assignedPageIds: user.assignedPages.map((page) => page.id),
      deviceTokenId: record.id,
      ...(record.harvestMachineId ? { harvestMachineId: record.harvestMachineId } : {}),
    },
    failure: null,
  };
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

export interface BearerAuthResult {
  principal: AuthPrincipal | null;
  /** Set only by the device-token lane (Decision 349 §4.5). */
  failure: AuthFailure | null;
}

/** Prefix-discriminated bearer authentication with the structured refusal:
 * device token or agent key. The request layer memoizes both halves.
 *
 * Decision 369: there is no longer a fallback branch. A bearer whose prefix
 * matches neither lane is nobody — the api-key lane that used to catch every
 * unknown string is gone, and an unrecognized credential now fails closed with
 * no database lookup and no reason (an enumeration oracle would be the only
 * thing a reason could buy here). */
export async function authenticateBearerCredential(
  app: AppContext,
  token: string,
  options?: { clientVersion?: string | null },
): Promise<BearerAuthResult> {
  if (token.startsWith(DEVICE_TOKEN_PREFIX) || token.startsWith(PENDING_DEVICE_TOKEN_PREFIX)) {
    return authenticateDeviceToken(app, token, options);
  }
  if (token.startsWith(AGENT_KEY_TOKEN_PREFIX)) {
    return { principal: await authenticateAgentKey(app, token), failure: null };
  }
  return { principal: null, failure: null };
}

/** Prefix-discriminated bearer authentication: device token or agent key — the
 * principal-only view (SSE revalidation and the older callers). */
export async function authenticateBearerToken(app: AppContext, token: string) {
  return (await authenticateBearerCredential(app, token)).principal;
}

export async function listDeviceTokensForUserId(app: AppContext, userId: number) {
  const user = await getExistingUserById(app.db, userId);
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
    lastClientVersion: token.lastClientVersion ?? null,
    createdAt: token.createdAt.toISOString(),
    revokedAt: token.revokedAt?.toISOString() ?? null,
    revokedReason: token.revokedReason ?? null,
  };
}

export async function setDeviceTokenHarvestCapabilityForUserId(
  app: AppContext,
  input: { userId: number; deviceTokenId: number; machineId: string | null },
  audit: AuditContext,
) {

  return withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
    assertUserNotDeactivated(user);
    const token = await findDeviceTokenForUser(dbTx, {
      deviceTokenId: input.deviceTokenId,
      userId: user.id,
    });
    if (!token) {
      throw new NotFoundError(`Device token ${input.deviceTokenId} not found for "${input.userId}"`);
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
    await lockExistingUserById(dbTx, principal.user.id);
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

export async function revokeDeviceTokensForUserId(
  app: AppContext,
  input: { userId: number },
  audit: AuditContext,
) {
  // Revoke + audit commit together (review R1-7).
  const revoked = await withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
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

// --- Decision 349: password-based device sign-in and the revocation ladder ---

/** Static device-token issuance policy shared by the cookie and password lanes. */
function mintDeviceTokenMaterial(mode: "active" | "pending") {
  const tokenBody = randomToken(24);
  const prefix = mode === "active" ? DEVICE_TOKEN_PREFIX : PENDING_DEVICE_TOKEN_PREFIX;
  return {
    rawToken: `${prefix}${tokenBody}`,
    keyPrefix: `${prefix}${tokenBody.slice(0, KEY_PREFIX_DISPLAY_LENGTH)}`,
  };
}

export type IssuedDeviceCredential =
  | {
    mode: "active";
    token: string;
    id: number;
    label: string;
    keyPrefix: string;
    expiresAt: Date;
  }
  | {
    mode: "pending";
    token: string;
    reservationId: number;
    label: string;
    keyPrefix: string;
    reservationExpiresAt: Date;
  };

/**
 * Р2: the single client sign-in — username + password → a device token
 * (`active`, the extension) or a reservation to activate (`pending`, the
 * desktop), with no cookie session anywhere. Rides the §4.3 core, so a reset
 * that commits mid-request wins and the request answers 401.
 */
export async function issueDeviceTokenWithPassword(
  app: AppContext,
  input: {
    username: string;
    password: string;
    label: string;
    mode: "active" | "pending";
    clientVersion: string | null;
  },
): Promise<IssuedDeviceCredential> {
  const material = mintDeviceTokenMaterial(input.mode);
  return verifyPasswordAndLockUser(app, input, async (dbTx, user) => {
    // Time is sampled after the lock wait, as activation does.
    const now = Date.now();
    if (input.mode === "active") {
      const expiresAt = new Date(now + DEVICE_TOKEN_TTL_MS);
      const created = await createDeviceToken(dbTx, {
        userId: user.id,
        label: input.label,
        tokenDigest: sha256Hex(material.rawToken),
        keyPrefix: material.keyPrefix,
        expiresAt,
        lastClientVersion: input.clientVersion,
      });
      await recordAudit({ db: dbTx }, {
        source: "api",
        actorUserId: user.id,
        targetUserId: user.id,
        eventType: "device_token.issued",
        metadata: {
          username: user.username,
          label: input.label,
          keyPrefix: material.keyPrefix,
          via: "password",
          clientVersion: input.clientVersion,
        },
      });
      return {
        mode: "active",
        token: material.rawToken,
        id: created.id,
        label: created.label,
        keyPrefix: material.keyPrefix,
        expiresAt,
      };
    }

    const expiresAt = new Date(now + PENDING_DEVICE_TOKEN_TTL_MS);
    const reservation = await createPendingDeviceToken(dbTx, {
      userId: user.id,
      label: input.label,
      tokenDigest: sha256Hex(material.rawToken),
      keyPrefix: material.keyPrefix,
      expiresAt,
    });
    await recordAudit({ db: dbTx }, {
      source: "api",
      actorUserId: user.id,
      targetUserId: user.id,
      eventType: "device_token.reserved",
      metadata: {
        username: user.username,
        label: input.label,
        keyPrefix: material.keyPrefix,
        expiresAt: expiresAt.toISOString(),
        via: "password",
        clientVersion: input.clientVersion,
      },
    });
    return {
      mode: "pending",
      token: material.rawToken,
      reservationId: reservation.id,
      label: reservation.label,
      keyPrefix: material.keyPrefix,
      reservationExpiresAt: reservation.expiresAt,
    };
  });
}

/**
 * §4.4 "Завершить все входы" inside a transaction that already holds the user
 * lock: device tokens, reservations, sessions, epoch. Shared by the owner
 * action, the CLI password reset and the link-based reset.
 */
export async function terminateAccessTx(
  dbTx: AppContext["db"],
  user: { id: number },
  reason: string,
) {
  await advanceDeviceTokenEpoch(dbTx, user.id);
  const deviceTokens = await revokeDeviceTokensForUser(dbTx, user.id, reason);
  const pending = await deletePendingDeviceTokensForUser(dbTx, user.id);
  const sessions = await revokeAuthSessionsForUser(dbTx, user.id, reason);
  return {
    deviceTokens: deviceTokens.length,
    pendingDeviceTokens: pending.length,
    sessions: sessions.length,
  };
}

/** Owner action "Завершить все входы" (§4.4): every credential and every
 * active link, epoch advanced. The password stays; the account stays enabled. */
export async function terminateAllAccess(
  app: AppContext,
  input: { userId: number },
  audit: AuditContext,
) {

  return withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
    if (user.role === "owner") {
      throw new BadRequestError("Owner sign-ins cannot be terminated this way");
    }
    const terminated = await terminateAccessTx(dbTx, user, "access_terminated");
    const links = await revokeActiveAccountLinks(dbTx, user.id, "access_terminated");
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "user.access_terminated",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        revokedDeviceTokens: terminated.deviceTokens,
        deletedPendingDeviceTokens: terminated.pendingDeviceTokens,
        revokedSessions: terminated.sessions,
        revokedAccountLinks: links.length,
      },
    });
    return {
      deviceTokens: terminated.deviceTokens,
      sessions: terminated.sessions,
      links: links.length,
    };
  });
}

/** Owner action "Отозвать вход" (§4.4): exactly one device token. */
export async function revokeDeviceTokenForUserId(
  app: AppContext,
  input: { userId: number; deviceTokenId: number },
  audit: AuditContext,
) {
  return withAuditTransaction(app, async (dbTx) => {
    const user = await lockExistingUserById(dbTx, input.userId);
    const token = await findDeviceTokenForUser(dbTx, {
      deviceTokenId: input.deviceTokenId,
      userId: user.id,
    });
    if (!token) {
      throw new NotFoundError(`Device ${input.deviceTokenId} not found for "${input.userId}"`);
    }
    const revoked = await revokeDeviceTokenById(dbTx, {
      deviceTokenId: token.id,
      userId: user.id,
      reason: "revoked_by_owner",
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.revoked_by_owner",
      targetUserId: user.id,
      metadata: {
        username: user.username,
        deviceTokenId: token.id,
        label: token.label,
        changed: revoked !== null,
      },
    });
    return { revoked: true as const };
  });
}

function ownDeviceResponse(token: Awaited<ReturnType<typeof listActiveDeviceTokensForUser>>[number]) {
  return {
    id: token.id,
    label: token.label,
    keyPrefix: token.keyPrefix,
    lastClientVersion: token.lastClientVersion ?? null,
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

/** Cabinet: the caller's live devices. Revoked and expired rows stay in the
 * owner's list; the person sees only what can still sign in. */
export async function listOwnDevices(app: AppContext, principal: AuthPrincipal) {
  requireSessionUser(principal);
  const tokens = await listActiveDeviceTokensForUser(app.db, principal.user.id, new Date());
  return tokens.map((token) => ownDeviceResponse(token));
}

/** Cabinet "Выйти с этого устройства": one of the caller's own device tokens.
 * A device that is not the caller's is 404 — never 403, which would confirm
 * the id exists. */
export async function revokeOwnDevice(
  app: AppContext,
  principal: AuthPrincipal,
  input: { deviceId: number },
  audit: AuditContext,
) {
  requireSessionUser(principal);
  const userId = principal.user.id;
  return withAuditTransaction(app, async (dbTx) => {
    await lockExistingUserById(dbTx, userId);
    const token = await findDeviceTokenForUser(dbTx, { deviceTokenId: input.deviceId, userId });
    if (!token) {
      throw new NotFoundError("Device not found");
    }
    const revoked = await revokeDeviceTokenById(dbTx, {
      deviceTokenId: token.id,
      userId,
      reason: "self_revoked",
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "device_token.self_revoked",
      targetUserId: userId,
      metadata: {
        username: principal.user.username,
        deviceTokenId: token.id,
        label: token.label,
        changed: revoked !== null,
      },
    });
    return { revoked: true as const };
  });
}

/** Cabinet "Выйти на всех устройствах" (§4.4 self): every device token and
 * reservation, every session EXCEPT the one making the request, epoch++. */
export async function revokeAllOwnDevices(
  app: AppContext,
  principal: AuthPrincipal,
  audit: AuditContext,
) {
  requireSessionUser(principal);
  const userId = principal.user.id;
  const keepSessionId = principal.authSessionId;
  return withAuditTransaction(app, async (dbTx) => {
    await lockExistingUserById(dbTx, userId);
    await advanceDeviceTokenEpoch(dbTx, userId);
    const deviceTokens = await revokeDeviceTokensForUser(dbTx, userId, "self_revoked_all");
    const pending = await deletePendingDeviceTokensForUser(dbTx, userId);
    const sessions = await revokeAuthSessionsForUserExcept(dbTx, {
      userId,
      keepSessionId,
      revokedReason: "self_revoked_all",
    });
    await recordAudit({ db: dbTx }, {
      ...audit,
      eventType: "auth.devices_revoked_all",
      targetUserId: userId,
      metadata: {
        username: principal.user.username,
        revokedDeviceTokens: deviceTokens.length,
        deletedPendingDeviceTokens: pending.length,
        revokedSessions: sessions.length,
        keptSessionId: keepSessionId,
      },
    });
    return { deviceTokens: deviceTokens.length, sessions: sessions.length };
  });
}

// --- Model-scope grants (kernel Stage 22) ---

export async function grantModelToUser(
  app: AppContext,
  input: { userId: number; modelSlug: string },
  audit: AuditContext,
) {
  const user = await getExistingUserById(app.db, input.userId);
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" not found`);
  }
  // Grant + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    const lockedUser = await lockExistingUserById(dbTx, user.id);
    assertUserNotDeactivated(lockedUser);
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
      metadata: { username: lockedUser.username, modelSlug: model.slug },
    });
  });
  return { ok: true as const };
}

export async function revokeModelFromUser(
  app: AppContext,
  input: { userId: number; modelSlug: string },
  audit: AuditContext,
) {
  const user = await getExistingUserById(app.db, input.userId);
  const model = await findModelBySlug(app.db, input.modelSlug);
  if (!model) {
    throw new NotFoundError(`Model "${input.modelSlug}" not found`);
  }
  // Revoke + audit commit together (review R1-7).
  await withAuditTransaction(app, async (dbTx) => {
    const lockedUser = await lockExistingUserById(dbTx, user.id);
    assertUserNotDeactivated(lockedUser);
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
      metadata: { username: lockedUser.username, modelSlug: model.slug },
    });
  });
  return { ok: true as const };
}

/** Grant history for the admin surface — scope labels resolved for display. */
export async function listUserGrants(app: AppContext, userId: number) {
  const user = await getExistingUserById(app.db, userId);
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
