import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { UserRole } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  apiKeys,
  auditEvents,
  authSessions,
  models,
  pages,
  userPageAssignments,
  users,
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

export interface CreateApiKeyInput {
  userId: number;
  keyPrefix: string;
  tokenDigest: string;
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

export async function findUserByUsername(db: Database, username: string) {
  return db.query.users.findFirst({
    where: eq(users.username, username),
  });
}

export async function findUserById(db: Database, userId: number) {
  return db.query.users.findFirst({
    where: eq(users.id, userId),
  });
}

export async function listUsers(db: Database) {
  return db.query.users.findMany({
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
  }).where(eq(users.id, userId)).returning();

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

export async function createApiKey(db: Database, input: CreateApiKeyInput) {
  const [created] = await db.insert(apiKeys).values(input).returning();
  return created;
}

export async function findActiveApiKeysForUser(db: Database, userId: number) {
  return db.query.apiKeys.findMany({
    where: and(
      eq(apiKeys.userId, userId),
      isNull(apiKeys.revokedAt),
    ),
    orderBy: (table, { desc: orderDesc }) => [orderDesc(table.createdAt)],
  });
}

export async function revokeApiKeysForUser(
  db: Database,
  userId: number,
  revokedReason: string | null,
) {
  return db.update(apiKeys).set({
    revokedAt: new Date(),
    revokedReason,
  }).where(and(
    eq(apiKeys.userId, userId),
    isNull(apiKeys.revokedAt),
  )).returning();
}

export async function revokeApiKeysByIds(
  db: Database,
  apiKeyIds: number[],
  revokedReason: string | null,
) {
  if (apiKeyIds.length === 0) {
    return [];
  }

  return db.update(apiKeys).set({
    revokedAt: new Date(),
    revokedReason,
  }).where(and(
    inArray(apiKeys.id, apiKeyIds),
    isNull(apiKeys.revokedAt),
  )).returning();
}

export async function findApiKeyByDigest(db: Database, tokenDigest: string) {
  return db.query.apiKeys.findFirst({
    where: eq(apiKeys.tokenDigest, tokenDigest),
  });
}

export async function touchApiKey(db: Database, apiKeyId: number) {
  const [updated] = await db.update(apiKeys).set({
    lastUsedAt: new Date(),
  }).where(eq(apiKeys.id, apiKeyId)).returning();

  return updated;
}

export async function listApiKeys(db: Database, userIds?: number[]) {
  const clauses = [];
  if (userIds && userIds.length > 0) {
    clauses.push(inArray(apiKeys.userId, userIds));
  }

  return db.select({
    id: apiKeys.id,
    userId: apiKeys.userId,
    username: users.username,
    role: users.role,
    keyPrefix: apiKeys.keyPrefix,
    lastUsedAt: apiKeys.lastUsedAt,
    createdAt: apiKeys.createdAt,
    revokedAt: apiKeys.revokedAt,
    revokedReason: apiKeys.revokedReason,
  }).from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(apiKeys.createdAt));
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
