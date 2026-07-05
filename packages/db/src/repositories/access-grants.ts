// Access grants (kernel Stage 22): the append-only log that replaces
// hard-deleted page assignments. A revoke STAMPS the row (revoked_by/_at) —
// "who had access to page X in June" is a query, never a reconstruction.
// Model-scope grants expand to the model's present AND future pages at read
// time; nothing is materialized.

import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "../client.ts";
import { accessGrants, models, pages } from "../schema.ts";

export type AccessGrantScopeType = "org" | "model" | "page";

export interface AccessGrantInput {
  userId: number;
  scopeType: AccessGrantScopeType;
  scopeId: number;
  grantedBy: number | null;
}

/**
 * Appends an active grant. Idempotent against an already-active identical
 * scope: re-granting is a no-op (the existing row keeps its history), so the
 * assign routes stay safely retryable.
 */
export async function insertAccessGrant(db: Database, input: AccessGrantInput) {
  const existing = await db.query.accessGrants.findFirst({
    where: and(
      eq(accessGrants.userId, input.userId),
      eq(accessGrants.scopeType, input.scopeType),
      eq(accessGrants.scopeId, input.scopeId),
      isNull(accessGrants.revokedAt),
    ),
  });
  if (existing) {
    return existing;
  }
  const [created] = await db.insert(accessGrants).values({
    userId: input.userId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    grantedBy: input.grantedBy,
  }).returning();
  return created!;
}

/** Stamps every active grant matching the scope; returns the revoked count. */
export async function revokeAccessGrants(db: Database, input: {
  userId: number;
  scopeType: AccessGrantScopeType;
  scopeId: number;
  revokedBy: number | null;
}) {
  const revoked = await db.update(accessGrants).set({
    revokedBy: input.revokedBy,
    revokedAt: new Date(),
  }).where(and(
    eq(accessGrants.userId, input.userId),
    eq(accessGrants.scopeType, input.scopeType),
    eq(accessGrants.scopeId, input.scopeId),
    isNull(accessGrants.revokedAt),
  )).returning({ id: accessGrants.id });
  return revoked.length;
}

/** Full grant history for one user (active and revoked), newest first. */
export async function listGrantsForUser(db: Database, userId: number) {
  return db.query.accessGrants.findMany({
    where: eq(accessGrants.userId, userId),
    orderBy: (table, { desc }) => [desc(table.grantedAt), desc(table.id)],
  });
}

/**
 * The live-permissions projection over grants — EXACTLY the shape and order of
 * listUserPageAssignments (the load-bearing `assignedPageIds` source): page
 * grants expand directly, model grants through pages.model_id at read time.
 */
export async function resolveGrantedPageAssignments(db: Database, userId: number) {
  const active = await db.query.accessGrants.findMany({
    where: and(eq(accessGrants.userId, userId), isNull(accessGrants.revokedAt)),
  });
  if (active.length === 0) {
    return [];
  }
  const pageIds = new Set<number>();
  const modelIds = new Set<number>();
  for (const grant of active) {
    if (grant.scopeType === "page") {
      pageIds.add(grant.scopeId);
    } else if (grant.scopeType === "model") {
      modelIds.add(grant.scopeId);
    }
    // 'org' scope: reserved future-proof label (DP 9-A single-tenant) — no
    // expansion semantics yet; deliberately inert here.
  }

  const rows = await db.select({
    pageId: pages.id,
    label: pages.label,
    platform: pages.platform,
    modelSlug: models.slug,
    modelName: models.name,
    modelId: pages.modelId,
  }).from(pages)
    .innerJoin(models, eq(models.id, pages.modelId))
    .orderBy(models.slug, pages.label);

  return rows
    .filter((row) => pageIds.has(row.pageId) || modelIds.has(row.modelId))
    .map(({ modelId: _modelId, ...row }) => row);
}

/** Display helpers for the grant admin surface. */
export async function listModelsByIds(db: Database, ids: readonly number[]) {
  return db.select({ id: models.id, slug: models.slug }).from(models)
    .where(inArray(models.id, [...ids]));
}

export async function listPagesByIds(db: Database, ids: readonly number[]) {
  return db.select({ id: pages.id, label: pages.label }).from(pages)
    .where(inArray(pages.id, [...ids]));
}
