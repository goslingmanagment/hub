import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";

import type { UserRole } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  accountLinks,
  auditEvents,
  authSessions,
  models,
  pages,
  userPageAssignments,
  users,
  deviceTokens,
  pendingDeviceTokens,
} from "../schema.ts";

export interface CreateUserInput {
  username: string;
  role: UserRole;
  passwordHash?: string | null;
}

export interface CreateAuthSessionInput {
  userId: number;
  tokenDigest: string;
  expiresAt: Date;
}

export interface InsertAuditEventInput {
  actorUserId?: number | null;
  targetUserId?: number | null;
  platformAccountId?: number | null;
  source: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}

export async function createUser(db: Database, input: CreateUserInput) {
  const [created] = await db.insert(users).values({
    username: input.username,
    role: input.role,
    passwordHash: input.passwordHash ?? null,
  }).returning();

  return created;
}

/** A login selects only its current identity. Deleted rows keep their original
 * spelling for history but never participate in account discovery or login. */
export async function findUserByUsername(db: Database, username: string) {
  return db.query.users.findFirst({
    where: and(sql`lower(${users.username}) = lower(${username})`, isNull(users.deletedAt)),
  });
}

/** True for a PostgreSQL unique-violation (23505) anywhere in the cause chain —
 * the concurrent-create race the lower(username) index turns into a 400. */
export function isUniqueViolation(error: unknown, constraint?: string) {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && current.code === "23505") {
      if (constraint === undefined) return true;
      const named = "constraint" in current ? current.constraint : undefined;
      return named === constraint;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export async function findUserById(db: Database, userId: number) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
  });
}

export async function listUsers(db: Database) {
  return db.query.users.findMany({
    where: isNull(users.deletedAt),
    orderBy: (table, { asc }) => [asc(table.username)],
  });
}

export async function updateUserPasswordHash(
  db: Database,
  userId: number,
  passwordHash: string | null,
) {
  const [updated] = await db.update(users).set({
    passwordHash,
    updatedAt: new Date(),
  }).where(and(eq(users.id, userId), isNull(users.deletedAt))).returning();

  return updated;
}

export async function assignUserToPage(db: Database, userId: number, platformAccountId: number) {
  const [assignment] = await db.insert(userPageAssignments).values({
    userId,
    platformAccountId,
  }).onConflictDoNothing().returning();

  return assignment ?? null;
}

export async function unassignUserFromPage(db: Database, userId: number, platformAccountId: number) {
  const [assignment] = await db.delete(userPageAssignments).where(and(
    eq(userPageAssignments.userId, userId),
    eq(userPageAssignments.platformAccountId, platformAccountId),
  )).returning();

  return assignment ?? null;
}

export async function listUserPageAssignments(db: Database, userId: number) {
  return db.select({
    pageId: pages.id,
    label: pages.label,
    platform: pages.platform,
    modelSlug: models.slug,
    modelName: models.name,
  }).from(userPageAssignments)
    .innerJoin(pages, eq(pages.id, userPageAssignments.platformAccountId))
    .innerJoin(models, eq(models.id, pages.modelId))
    .where(eq(userPageAssignments.userId, userId))
    .orderBy(models.slug, pages.label);
}

export async function createAuthSession(db: Database, input: CreateAuthSessionInput) {
  const [created] = await db.insert(authSessions).values(input).returning();
  return created;
}

export async function findAuthSessionByDigest(db: Database, tokenDigest: string) {
  return db.query.authSessions.findFirst({
    where: eq(authSessions.tokenDigest, tokenDigest),
  });
}

export async function findAuthSessionById(db: Database, sessionId: number) {
  return db.query.authSessions.findFirst({
    where: eq(authSessions.id, sessionId),
  });
}

export async function touchAuthSession(db: Database, sessionId: number) {
  const [updated] = await db.update(authSessions).set({
    lastSeenAt: new Date(),
  }).where(eq(authSessions.id, sessionId)).returning();

  return updated;
}

export async function revokeAuthSession(
  db: Database,
  sessionId: number,
  revokedReason: string | null,
) {
  const [updated] = await db.update(authSessions).set({
    revokedAt: new Date(),
    revokedReason,
  }).where(eq(authSessions.id, sessionId)).returning();

  return updated;
}

export async function revokeAuthSessionsForUser(
  db: Database,
  userId: number,
  revokedReason: string | null,
) {
  return db.update(authSessions).set({
    revokedAt: new Date(),
    revokedReason,
  }).where(and(
    eq(authSessions.userId, userId),
    isNull(authSessions.revokedAt),
  )).returning();
}

export async function deleteExpiredAuthSessions(db: Database, now = new Date()) {
  return db.delete(authSessions).where(sql`${authSessions.expiresAt} < ${now}`);
}

export async function insertAuditEvent(db: Database, input: InsertAuditEventInput) {
  const [created] = await db.insert(auditEvents).values({
    actorUserId: input.actorUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    platformAccountId: input.platformAccountId ?? null,
    source: input.source,
    eventType: input.eventType,
    metadata: input.metadata ?? {},
  }).returning();

  return created;
}

// --- Device tokens (kernel Stage 22): human-bound, expiring machine credentials ---

export interface CreateDeviceTokenInput {
  userId: number;
  label: string;
  tokenDigest: string;
  keyPrefix: string;
  expiresAt: Date;
  /** Decision 349 (Р7): the issuing client's x-client-version, when known. */
  lastClientVersion?: string | null | undefined;
}

export interface CreatePendingDeviceTokenInput {
  userId: number;
  label: string;
  tokenDigest: string;
  keyPrefix: string;
  expiresAt: Date;
}

export async function createDeviceToken(db: Database, input: CreateDeviceTokenInput) {
  const [created] = await db.insert(deviceTokens).values({
    userId: input.userId,
    label: input.label,
    tokenDigest: input.tokenDigest,
    keyPrefix: input.keyPrefix,
    expiresAt: input.expiresAt,
    lastClientVersion: input.lastClientVersion ?? null,
  }).returning();
  return created!;
}

export async function createPendingDeviceToken(
  db: Database,
  input: CreatePendingDeviceTokenInput,
) {
  const [created] = await db.insert(pendingDeviceTokens).values(input).returning();
  return created!;
}

/** User-row lock shared by credential/grant writers and account lifecycle
 * operations. It closes the update-then-insert race where deletion or
 * revoke-all could miss authority created in the same transaction window.
 * The immutable ID is never changed or physically deleted. NO KEY UPDATE
 * still serializes these writers, while allowing audit/grant actor foreign
 * keys to reference another locked user without a cross-user deadlock. */
export async function lockUserForDeviceTokenMutation(db: Database, userId: number) {
  const [locked] = await db.select().from(users)
    .where(eq(users.id, userId))
    .for("no key update");
  return locked ?? null;
}

export async function advanceDeviceTokenEpoch(db: Database, userId: number) {
  const [updated] = await db.update(users).set({
    deviceTokenEpoch: sql`${users.deviceTokenEpoch} + 1`,
  }).where(and(eq(users.id, userId), isNull(users.deletedAt))).returning({
    deviceTokenEpoch: users.deviceTokenEpoch,
  });
  return updated ?? null;
}

export async function findPendingDeviceTokenByDigest(
  db: Database,
  tokenDigest: string,
  input?: { forUpdate?: boolean },
) {
  const query = db.select().from(pendingDeviceTokens)
    .where(eq(pendingDeviceTokens.tokenDigest, tokenDigest))
    .limit(1);
  const [record] = input?.forUpdate === true ? await query.for("update") : await query;
  return record ?? null;
}

export async function deletePendingDeviceTokenById(db: Database, id: number) {
  const [deleted] = await db.delete(pendingDeviceTokens)
    .where(eq(pendingDeviceTokens.id, id))
    .returning({ id: pendingDeviceTokens.id });
  return deleted ?? null;
}

export async function deletePendingDeviceTokensForUser(db: Database, userId: number) {
  return db.delete(pendingDeviceTokens)
    .where(eq(pendingDeviceTokens.userId, userId))
    .returning({ id: pendingDeviceTokens.id });
}

export async function deleteExpiredPendingDeviceTokens(db: Database, now = new Date()) {
  return db.delete(pendingDeviceTokens)
    .where(sql`${pendingDeviceTokens.expiresAt} <= ${now}`)
    .returning({ id: pendingDeviceTokens.id });
}

export async function findDeviceTokenByDigest(db: Database, tokenDigest: string) {
  return db.query.deviceTokens.findFirst({
    where: eq(deviceTokens.tokenDigest, tokenDigest),
  });
}

export async function findDeviceTokenForUser(
  db: Database,
  input: { deviceTokenId: number; userId: number },
) {
  return db.query.deviceTokens.findFirst({
    where: and(
      eq(deviceTokens.id, input.deviceTokenId),
      eq(deviceTokens.userId, input.userId),
    ),
  });
}

/**
 * Owner-controlled transfer of the one-machine harvest capability. The
 * advisory lock serializes grants for one machine so two concurrent admin
 * requests cannot surface a unique-index 500 or leave the authority unclear.
 */
export async function setDeviceTokenHarvestMachine(
  db: Database,
  input: { deviceTokenId: number; userId: number; machineId: string | null },
) {
  let replacedTokenId: number | null = null;
  if (input.machineId) {
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`desktop-harvest:${input.machineId}`}, 0)
      )
    `);
    const previous = await db.query.deviceTokens.findFirst({
      where: eq(deviceTokens.harvestMachineId, input.machineId),
    });
    if (previous && previous.id !== input.deviceTokenId) {
      replacedTokenId = previous.id;
      await db.update(deviceTokens).set({
        harvestMachineId: null,
      }).where(eq(deviceTokens.id, previous.id));
    }
  }

  const [updated] = await db.update(deviceTokens).set({
    harvestMachineId: input.machineId,
  }).where(and(
    eq(deviceTokens.id, input.deviceTokenId),
    eq(deviceTokens.userId, input.userId),
    isNull(deviceTokens.revokedAt),
  )).returning();

  return { updated: updated ?? null, replacedTokenId };
}

export async function updateDeviceTokenUse(db: Database, deviceTokenId: number, input: {
  lastUsedAt: Date;
  expiresAt?: Date;
  /** Decision 349 (Р7): stamped by the SAME statement as lastUsedAt; a request
   * without the header leaves the previous value in place. */
  lastClientVersion?: string | null;
}) {
  await db.update(deviceTokens).set({
    lastUsedAt: input.lastUsedAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(typeof input.lastClientVersion === "string"
      ? { lastClientVersion: input.lastClientVersion }
      : {}),
  }).where(eq(deviceTokens.id, deviceTokenId));
}

export async function listDeviceTokensForUser(db: Database, userId: number) {
  return db.query.deviceTokens.findMany({
    where: eq(deviceTokens.userId, userId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

/** The caller's live devices (Decision 349 cabinet): not revoked, not expired. */
export async function listActiveDeviceTokensForUser(db: Database, userId: number, now = new Date()) {
  return db.query.deviceTokens.findMany({
    where: and(
      eq(deviceTokens.userId, userId),
      isNull(deviceTokens.revokedAt),
      gt(deviceTokens.expiresAt, now),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

/** "Sign out on all devices" keeps the session that issued the request. */
export async function revokeAuthSessionsForUserExcept(
  db: Database,
  input: { userId: number; keepSessionId: number; revokedReason: string | null },
) {
  return db.update(authSessions).set({
    revokedAt: new Date(),
    revokedReason: input.revokedReason,
  }).where(and(
    eq(authSessions.userId, input.userId),
    ne(authSessions.id, input.keepSessionId),
    isNull(authSessions.revokedAt),
  )).returning({ id: authSessions.id });
}

export async function revokeDeviceTokensForUser(db: Database, userId: number, reason: string) {
  return db.update(deviceTokens).set({
    revokedAt: new Date(),
    revokedReason: reason,
  }).where(and(
    eq(deviceTokens.userId, userId),
    isNull(deviceTokens.revokedAt),
  )).returning({ id: deviceTokens.id });
}

export async function revokeDeviceTokenById(
  db: Database,
  input: { deviceTokenId: number; userId: number; reason: string },
) {
  const [revoked] = await db.update(deviceTokens).set({
    revokedAt: new Date(),
    revokedReason: input.reason,
  }).where(and(
    eq(deviceTokens.id, input.deviceTokenId),
    eq(deviceTokens.userId, input.userId),
    isNull(deviceTokens.revokedAt),
  )).returning({ id: deviceTokens.id });
  return revoked ?? null;
}

export async function updateUserDisabledAt(
  db: Database,
  userId: number,
  disabledAt: Date | null,
) {
  const [updated] = await db.update(users).set({
    disabledAt,
    updatedAt: new Date(),
  }).where(and(eq(users.id, userId), isNull(users.deletedAt))).returning();

  return updated;
}

/** Call while holding the user lock, after revoking credentials in the same
 * transaction. Password removal and the permanent tombstone are one update. */
export async function markUserDeleted(db: Database, userId: number, deletedAt: Date) {
  const [updated] = await db.update(users).set({
    deletedAt,
    // Pre-deletion builds only understand disabled_at. Keep that barrier
    // closed too; a rollback cannot turn the retained row into a principal.
    disabledAt: sql`coalesce(${users.disabledAt}, ${deletedAt})`,
    passwordHash: null,
    mustChangePassword: false,
    updatedAt: deletedAt,
  }).where(and(eq(users.id, userId), isNull(users.deletedAt))).returning();
  return updated;
}

// --- Account links (Decision 349): one-time invite / password-reset links ---
// Never deleted: a used, expired or revoked link is a fact. Writers take the
// user row lock (lockUserForDeviceTokenMutation) BEFORE touching a link row —
// the same users -> credential order the device-token paths use.

export type AccountLinkKind = "invite" | "password_reset";

export interface CreateAccountLinkInput {
  userId: number;
  kind: AccountLinkKind;
  tokenDigest: string;
  keyPrefix: string;
  createdBy: number | null;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export async function createAccountLink(db: Database, input: CreateAccountLinkInput) {
  const [created] = await db.insert(accountLinks).values({
    userId: input.userId,
    kind: input.kind,
    tokenDigest: input.tokenDigest,
    keyPrefix: input.keyPrefix,
    createdBy: input.createdBy,
    expiresAt: input.expiresAt,
    metadata: input.metadata ?? {},
  }).returning();
  return created!;
}

export async function findAccountLinkByDigest(
  db: Database,
  tokenDigest: string,
  input?: { forUpdate?: boolean },
) {
  const query = db.select().from(accountLinks)
    .where(eq(accountLinks.tokenDigest, tokenDigest))
    .limit(1);
  const [record] = input?.forUpdate === true ? await query.for("update") : await query;
  return record ?? null;
}

export async function findAccountLinkForUser(
  db: Database,
  input: { linkId: number; userId: number },
) {
  const record = await db.query.accountLinks.findFirst({
    where: and(
      eq(accountLinks.id, input.linkId),
      eq(accountLinks.userId, input.userId),
    ),
  });
  return record ?? null;
}

export async function listAccountLinks(db: Database, userId: number) {
  return db.query.accountLinks.findMany({
    where: eq(accountLinks.userId, userId),
    orderBy: (table, { desc: orderDesc }) => [orderDesc(table.createdAt), orderDesc(table.id)],
  });
}

/** Revokes every still-active link of the user (supersede / password set /
 * deactivation / access termination). Returns the revoked ids. */
export async function revokeActiveAccountLinks(db: Database, userId: number, reason: string) {
  return db.update(accountLinks).set({
    revokedAt: new Date(),
    revokedReason: reason,
  }).where(and(
    eq(accountLinks.userId, userId),
    isNull(accountLinks.usedAt),
    isNull(accountLinks.revokedAt),
  )).returning({ id: accountLinks.id });
}

export async function revokeAccountLinkById(
  db: Database,
  input: { linkId: number; userId: number; reason: string },
) {
  const [revoked] = await db.update(accountLinks).set({
    revokedAt: new Date(),
    revokedReason: input.reason,
  }).where(and(
    eq(accountLinks.id, input.linkId),
    eq(accountLinks.userId, input.userId),
    isNull(accountLinks.usedAt),
    isNull(accountLinks.revokedAt),
  )).returning();
  return revoked ?? null;
}

export async function markAccountLinkUsed(db: Database, linkId: number, usedAt: Date) {
  const [updated] = await db.update(accountLinks).set({ usedAt })
    .where(and(eq(accountLinks.id, linkId), isNull(accountLinks.usedAt)))
    .returning({ id: accountLinks.id });
  return updated ?? null;
}

/** Has the user ever redeemed a link of this kind? (§4.1 p.4: an invite may be
 * re-issued only to an unfinished registration.) */
export async function hasRedeemedAccountLink(db: Database, userId: number, kind: AccountLinkKind) {
  const [row] = await db.select({ id: accountLinks.id }).from(accountLinks)
    .where(and(
      eq(accountLinks.userId, userId),
      eq(accountLinks.kind, kind),
      sql`${accountLinks.usedAt} is not null`,
    ))
    .limit(1);
  return row !== undefined;
}
