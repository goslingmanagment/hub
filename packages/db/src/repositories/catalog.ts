import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { buildProxyEgressKey, type Platform, type ProxyConfig } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  models,
  pageCredentials,
  egressEndpoints,
  pages,
  spenderProjectionWatermarks,
} from "../schema.ts";

function defaultCommissionRateForPlatform(platform: Platform) {
  return platform === "onlyfans" ? 0.2 : 0;
}

export class PlatformAccountIdentityImmutableError extends Error {
  constructor(
    readonly label: string,
    readonly existingPlatformAccountId: string,
    readonly attemptedPlatformAccountId: string,
  ) {
    super(
      `Page "${label}" is already bound to upstream account ` +
        `"${existingPlatformAccountId}" and cannot be rebound to "${attemptedPlatformAccountId}"`,
    );
    this.name = "PlatformAccountIdentityImmutableError";
  }
}

export class PlatformAccountIdentityConflictError extends Error {
  constructor(
    readonly platform: Platform,
    readonly platformAccountId: string,
    readonly conflictingLabel: string | null,
  ) {
    super(
      conflictingLabel
        ? `Upstream account "${platform}:${platformAccountId}" is already bound to page "${conflictingLabel}"`
        : `Upstream account "${platform}:${platformAccountId}" is already bound to another page`,
    );
    this.name = "PlatformAccountIdentityConflictError";
  }
}

export class DuplicateModelSlugError extends Error {
  constructor(readonly slug: string) {
    super(`Model "${slug}" already exists`);
    this.name = "DuplicateModelSlugError";
  }
}

export class DuplicatePageLabelError extends Error {
  constructor(readonly label: string) {
    super(`Page "${label}" already exists`);
    this.name = "DuplicatePageLabelError";
  }
}

export class CatalogModelNotFoundError extends Error {
  constructor(readonly slug: string) {
    super(`Model "${slug}" not found`);
    this.name = "CatalogModelNotFoundError";
  }
}

export class CatalogPageNotFoundError extends Error {
  constructor(readonly label: string) {
    super(`Page "${label}" not found`);
    this.name = "CatalogPageNotFoundError";
  }
}

export class ModelHasPagesError extends Error {
  constructor(
    readonly slug: string,
    readonly pageCount: number,
  ) {
    super(
      `Model "${slug}" cannot be deleted while it still has ${pageCount} ` +
        `page${pageCount === 1 ? "" : "s"}`,
    );
    this.name = "ModelHasPagesError";
  }
}

function hasErrorCode(error: unknown, code: string) {
  let current: unknown = error;

  while (typeof current === "object" && current !== null) {
    if ("code" in current && current.code === code) {
      return true;
    }
    if (!("cause" in current)) {
      return false;
    }
    current = current.cause;
  }

  return false;
}

export async function createModel(db: Database, input: { slug: string; name: string }) {
  try {
    const [{ nextSortOrder }] = await db
      .select({ nextSortOrder: sql<number>`coalesce(max(${models.sortOrder}), 0) + 10` })
      .from(models);
    const [created] = await db
      .insert(models)
      .values({ slug: input.slug, name: input.name, sortOrder: nextSortOrder })
      .returning();
    return created;
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      throw new DuplicateModelSlugError(input.slug);
    }

    throw error;
  }
}

export async function findModelBySlug(db: Database, slug: string) {
  return db.query.models.findFirst({
    where: eq(models.slug, slug),
  });
}

export async function createFanslyPage(
  db: Database,
  input: {
    modelId: number;
    label: string;
  },
) {
  return createPlatformPage(db, {
    modelId: input.modelId,
    platform: "fansly",
    label: input.label,
  });
}

export async function createOnlyFansPage(
  db: Database,
  input: {
    modelId: number;
    label: string;
  },
) {
  return createPlatformPage(db, {
    modelId: input.modelId,
    platform: "onlyfans",
    label: input.label,
  });
}

/**
 * Numeric page id → OFAPI account ref for every mapped page (kernel
 * Stage 24: the v2 event stream stamps frames with the platform-native
 * account ref so OFAPI-keyed clients filter without id translation).
 */
export async function listPageOfapiAccountRefs(db: Database): Promise<Map<number, string>> {
  const result = await db.execute<{ id: number; ofapi_account_id: string }>(sql`
    select id::int as id, ofapi_account_id
    from pages
    where ofapi_account_id is not null
  `);
  return new Map(result.rows.map((row) => [row.id, row.ofapi_account_id]));
}

export async function createPlatformPage(
  db: Database,
  input: {
    modelId: number;
    platform: Platform;
    label: string;
  },
) {
  let created;
  try {
    [created] = await db.transaction(async (tx) => {
      const [page] = await tx
        .insert(pages)
        .values({
          modelId: input.modelId,
          platform: input.platform,
          commissionRate: defaultCommissionRateForPlatform(input.platform),
          label: input.label,
          // Stage 13: same invariant as the 0055 writer seed — Fansly pages
          // are born with the Fansly stream as their transactions writer;
          // OnlyFans pages stay unassigned until the OFAPI mapping lands
          // (setPageOfapiAccountId) or Stage 14 assigns one explicitly.
          transactionsWriter: input.platform === "fansly" ? "fansly" : null,
        })
        .returning();

      await tx.insert(spenderProjectionWatermarks).values({
        platformAccountId: page.id,
        lastRebuiltAt: new Date(0),
        updatedAt: new Date(),
      });

      return [page];
    });
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      throw new DuplicatePageLabelError(input.label);
    }

    throw error;
  }

  return created;
}

export async function storeFanslySession(
  db: Database,
  platformAccountId: number,
  encryptedSession: string,
  keyVersion: number,
) {
  return storePlatformCredentials(db, {
    platformAccountId,
    encryptedSession,
    keyVersion,
  });
}

export async function storePlatformCredentials(
  db: Database,
  input: {
    platformAccountId: number;
    encryptedSession: string;
    keyVersion: number;
  },
) {
  const [credential] = await db
    .insert(pageCredentials)
    .values({
      platformAccountId: input.platformAccountId,
      encryptedSession: input.encryptedSession,
      keyVersion: input.keyVersion,
    })
    .onConflictDoUpdate({
      target: pageCredentials.platformAccountId,
      set: {
        encryptedSession: input.encryptedSession,
        keyVersion: input.keyVersion,
        updatedAt: new Date(),
      },
    })
    .returning();
  return credential;
}

export async function storeProxyConfig(
  db: Database,
  platformAccountId: number,
  input: {
    url: string;
    encryptedAuth: string | null;
    keyVersion: number | null;
    rateLimitScopeKey?: string | null;
  },
) {
  const rateLimitScopeKey = input.rateLimitScopeKey ?? buildProxyEgressKey({ url: input.url });

  const [proxy] = await db
    .insert(egressEndpoints)
    .values({
      platformAccountId,
      url: input.url,
      encryptedAuth: input.encryptedAuth,
      keyVersion: input.keyVersion,
      rateLimitScopeKey,
    })
    .onConflictDoUpdate({
      target: egressEndpoints.platformAccountId,
      set: {
        url: input.url,
        encryptedAuth: input.encryptedAuth,
        keyVersion: input.keyVersion,
        rateLimitScopeKey,
        updatedAt: new Date(),
      },
    })
    .returning();
  return proxy;
}

export async function deleteProxyConfig(
  db: Database,
  platformAccountId: number,
) {
  await db
    .delete(egressEndpoints)
    .where(eq(egressEndpoints.platformAccountId, platformAccountId));
}

export async function findPageByLabel(db: Database, label: string) {
  const page = await db.query.pages.findFirst({
    where: and(eq(pages.label, label), eq(pages.status, "active")),
  });

  if (!page) {
    return null;
  }

  const credentials = await db.query.pageCredentials.findFirst({
    where: eq(pageCredentials.platformAccountId, page.id),
  });
  const proxy = await db.query.egressEndpoints.findFirst({
    where: eq(egressEndpoints.platformAccountId, page.id),
  });

  return { page, credentials, proxy };
}

export async function findPageById(db: Database, platformAccountId: number) {
  const page = await db.query.pages.findFirst({
    where: and(eq(pages.id, platformAccountId), eq(pages.status, "active")),
  });

  if (!page) {
    return null;
  }

  const credentials = await db.query.pageCredentials.findFirst({
    where: eq(pageCredentials.platformAccountId, page.id),
  });
  const proxy = await db.query.egressEndpoints.findFirst({
    where: eq(egressEndpoints.platformAccountId, page.id),
  });

  return { page, credentials, proxy };
}

/** Stage 17: page -> platform-native account ref (canonicalizer context).
 * ofapiAccountId rides along because OFAPI webhook observations carry the
 * vendor account ref ("acct_…") as their native_account_ref — OF pages'
 * platform_account_id is typically empty (OFAPI-era onboarding). */
export async function listPageNativeAccountRefs(
  db: Database,
): Promise<Array<{
  id: number;
  platform: string;
  nativeAccountRef: string | null;
  ofapiAccountId: string | null;
}>> {
  const rows = await db
    .select({
      id: pages.id,
      platform: pages.platform,
      nativeAccountRef: pages.platformAccountId,
      ofapiAccountId: pages.ofapiAccountId,
    })
    .from(pages);
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    nativeAccountRef: row.nativeAccountRef ?? null,
    ofapiAccountId: row.ofapiAccountId ?? null,
  }));
}

/** Stage 13 single-writer gate: the page's assigned transactions writer. */
export async function getPageTransactionsWriterInfo(db: Database, platformAccountId: number) {
  const [page] = await db
    .select({
      transactionsWriter: pages.transactionsWriter,
      label: pages.label,
      platform: pages.platform,
    })
    .from(pages)
    .where(eq(pages.id, platformAccountId))
    .limit(1);
  return page ?? null;
}

export async function listFanslyPages(db: Database) {
  return listPagesByPlatform(db, "fansly");
}

// Stage 13: operational listings/lookups see ACTIVE pages only — a tombstoned
// page stops syncing, mapping, and appearing in admin/dashboard lists. Fact
// readers (rollup rebuilds, fact-presence, model page counts) intentionally
// keep seeing all pages: the facts remain and deleting a model under a
// tombstoned page must still be refused.
export async function listPlatformAccounts(db: Database) {
  return db.query.pages.findMany({
    where: eq(pages.status, "active"),
  });
}

export async function listPagesByPlatform(db: Database, platform: Platform) {
  return db.query.pages.findMany({
    where: and(eq(pages.platform, platform), eq(pages.status, "active")),
  });
}

export async function listModelsWithPageCounts(db: Database) {
  return db.execute(sql`
    select m.slug,
           m.name,
           count(pa.id)::int as page_count
    from models m
    left join pages pa on pa.model_id = m.id
    group by m.id, m.slug, m.name
    order by m.sort_order asc, m.slug asc
  `);
}

export async function listAdminModels(db: Database) {
  return db.select({
    id: models.id,
    slug: models.slug,
    name: models.name,
    sortOrder: models.sortOrder,
    pageCount: sql<number>`count(${pages.id})::int`,
  }).from(models)
    .leftJoin(pages, eq(pages.modelId, models.id))
    .groupBy(models.id, models.slug, models.name, models.sortOrder)
    .orderBy(models.sortOrder, models.slug);
}

export async function updateModelBySlug(
  db: Database,
  slug: string,
  input: {
    slug?: string;
    name?: string;
    sortOrder?: number;
  },
) {
  const patch: {
    slug?: string;
    name?: string;
    sortOrder?: number;
  } = {};

  if (input.slug !== undefined) {
    patch.slug = input.slug;
  }
  if (input.name !== undefined) {
    patch.name = input.name;
  }
  if (input.sortOrder !== undefined) {
    patch.sortOrder = input.sortOrder;
  }

  let updated;
  try {
    [updated] = await db
      .update(models)
      .set(patch)
      .where(eq(models.slug, slug))
      .returning();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      throw new DuplicateModelSlugError(input.slug ?? slug);
    }

    throw error;
  }

  if (!updated) {
    throw new CatalogModelNotFoundError(slug);
  }

  return updated;
}

export async function deleteModelBySlug(db: Database, slug: string) {
  const deleted = await db.execute(sql`
    delete from models m
    where m.slug = ${slug}
      and not exists (
        select 1
        from pages pa
        where pa.model_id = m.id
      )
    returning m.id
  `);

  if (deleted.rows.length > 0) {
    return;
  }

  const model = await findModelBySlug(db, slug);
  if (!model) {
    throw new CatalogModelNotFoundError(slug);
  }

  const [{ pageCount }] = await db.select({
    pageCount: sql<number>`count(${pages.id})::int`,
  }).from(pages)
    .where(eq(pages.modelId, model.id));

  throw new ModelHasPagesError(slug, pageCount);
}

export async function listAdminPages(
  db: Database,
  input?: {
    pageIds?: number[];
  },
) {
  const clauses: Array<any> = [eq(pages.status, "active")];

  if (input?.pageIds !== undefined) {
    if (input.pageIds.length === 0) {
      return [];
    }
    clauses.push(inArray(pages.id, input.pageIds));
  }

  return db.select({
    id: pages.id,
    label: pages.label,
    platform: pages.platform,
    username: pages.username,
    displayName: pages.displayName,
    followerCount: pages.followerCount,
    subscriberCount: pages.subscriberCount,
    lastLightSyncAt: pages.lastLightSyncAt,
    lastFollowerSyncAt: pages.lastFollowerSyncAt,
    modelSlug: models.slug,
    modelName: models.name,
  }).from(pages)
    .innerJoin(models, eq(models.id, pages.modelId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(models.sortOrder, models.slug, pages.label);
}

export async function updatePageByLabel(
  db: Database,
  label: string,
  input: {
    label?: string;
    modelSlug?: string;
  },
) {
  const existing = await db.query.pages.findFirst({
    where: and(eq(pages.label, label), eq(pages.status, "active")),
  });
  if (!existing) {
    throw new CatalogPageNotFoundError(label);
  }

  const patch: {
    label?: string;
    modelId?: number;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };

  if (input.label !== undefined) {
    patch.label = input.label;
  }

  if (input.modelSlug !== undefined) {
    const model = await findModelBySlug(db, input.modelSlug);
    if (!model) {
      throw new CatalogModelNotFoundError(input.modelSlug);
    }
    patch.modelId = model.id;
  }

  let updated;
  try {
    [updated] = await db
      .update(pages)
      .set(patch)
      .where(eq(pages.id, existing.id))
      .returning();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      throw new DuplicatePageLabelError(input.label ?? label);
    }

    throw error;
  }

  return updated;
}

/**
 * Stage 2 destruction-door guard: page deletion fans out through the pages.id
 * CASCADE FKs (transactions included), so the admin DELETE handler refuses
 * when the page still holds business facts. Interim handler-level check —
 * Stage 13's soft-delete standard flips the FKs to RESTRICT.
 */
export async function getPageBusinessFactPresence(db: Database, label: string) {
  const result = await db.execute<{
    id: number;
    has_transactions: boolean;
    has_dm_messages: boolean;
  }>(sql`
    select p.id::int as id,
           exists(select 1 from transactions t where t.platform_account_id = p.id) as has_transactions,
           exists(select 1 from page_dm_messages m where m.platform_account_id = p.id) as has_dm_messages
    from pages p
    where p.label = ${label}
  `);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    hasTransactions: row.has_transactions,
    hasDmMessages: row.has_dm_messages,
  };
}

/**
 * Stage 13 soft-delete standard: "delete" is a tombstone UPDATE — the row and
 * every fact hanging off it remain; operational listings exclude it via
 * status. A raw DELETE on a fact-bearing page is refused at the FK level
 * (RESTRICT, migration 0056). Deleting an already-deleted page is a 404.
 */
export async function deletePageByLabel(db: Database, label: string) {
  const [deleted] = await db
    .update(pages)
    .set({
      status: "deleted",
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(pages.label, label), eq(pages.status, "active")))
    .returning({
      id: pages.id,
      label: pages.label,
    });

  if (!deleted) {
    throw new CatalogPageNotFoundError(label);
  }

  return deleted;
}

export async function listPageSummaries(db: Database) {
  return db.execute(sql`
    select pa.platform,
           m.slug as model,
           pa.label,
           pa.username,
           pa.follower_count,
           pa.subscriber_count,
           pa.last_light_sync_at,
           pa.last_follower_sync_at,
           pap.url as proxy_url,
           (pap.encrypted_auth is not null) as proxy_has_auth
    from pages pa
    join models m on m.id = pa.model_id
    left join egress_endpoints pap on pap.platform_account_id = pa.id
    where pa.status = 'active'
    order by m.slug asc, pa.label asc
  `);
}

export async function updatePageMetadata(
  db: Database,
  platformAccountId: number,
  input: {
    platformAccountIdValue: string;
    username: string | null;
    displayName: string | null;
    followerCount: number | null;
    subscriberCount: number | null;
    earningsBalanceMills: bigint;
    metadata: Record<string, unknown>;
    syncType?: "light" | "followers";
  },
) {
  const existingPage = await db.query.pages.findFirst({
    where: eq(pages.id, platformAccountId),
  });
  if (!existingPage) {
    throw new Error(`Platform account ${platformAccountId} was not found`);
  }

  if (
    existingPage.platformAccountId &&
    existingPage.platformAccountId !== input.platformAccountIdValue
  ) {
    throw new PlatformAccountIdentityImmutableError(
      existingPage.label,
      existingPage.platformAccountId,
      input.platformAccountIdValue,
    );
  }

  const conflictingPage = await db.query.pages.findFirst({
    where: and(
      eq(pages.platform, existingPage.platform),
      eq(pages.platformAccountId, input.platformAccountIdValue),
      ne(pages.id, platformAccountId),
    ),
  });
  if (conflictingPage) {
    throw new PlatformAccountIdentityConflictError(
      existingPage.platform,
      input.platformAccountIdValue,
      conflictingPage.label,
    );
  }

  const now = new Date();
  const patch: {
    platformAccountId: string;
    username: string | null;
    displayName: string | null;
    followerCount: number | null;
    subscriberCount: number | null;
    earningsBalanceMills: bigint;
    metadata: Record<string, unknown>;
    lastVerifiedAt: Date;
    updatedAt: Date;
    lastLightSyncAt?: Date;
    lastFollowerSyncAt?: Date;
  } = {
    platformAccountId: input.platformAccountIdValue,
    username: input.username,
    displayName: input.displayName,
    followerCount: input.followerCount,
    subscriberCount: input.subscriberCount,
    earningsBalanceMills: input.earningsBalanceMills,
    metadata: input.metadata,
    lastVerifiedAt: now,
    updatedAt: now,
  };

  if (input.syncType === "light") {
    patch.lastLightSyncAt = now;
  } else if (input.syncType === "followers") {
    patch.lastFollowerSyncAt = now;
  }

  let updated;
  try {
    [updated] = await db
      .update(pages)
      .set(patch)
      .where(eq(pages.id, platformAccountId))
      .returning();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      const concurrentConflict = await db.query.pages.findFirst({
        where: and(
          eq(pages.platform, existingPage.platform),
          eq(pages.platformAccountId, input.platformAccountIdValue),
          ne(pages.id, platformAccountId),
        ),
      });
      throw new PlatformAccountIdentityConflictError(
        existingPage.platform,
        input.platformAccountIdValue,
        concurrentConflict?.label ?? null,
      );
    }

    throw error;
  }

  return updated;
}

export async function updateOnlyFansPageIdentityFromOfapi(
  db: Database,
  platformAccountId: number,
  input: {
    ofapiAccountId: string;
    username: string | null;
    displayName: string | null;
    metadata: Record<string, unknown>;
  },
) {
  const existingPage = await db.query.pages.findFirst({
    where: eq(pages.id, platformAccountId),
  });
  if (!existingPage) {
    throw new Error(`Platform account ${platformAccountId} was not found`);
  }
  if (existingPage.platform !== "onlyfans") {
    throw new Error(`Page "${existingPage.label}" is not an OnlyFans page`);
  }
  if (existingPage.ofapiAccountId !== input.ofapiAccountId) {
    throw new Error(
      `Page "${existingPage.label}" is not mapped to OFAPI account "${input.ofapiAccountId}"`,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(pages)
    .set({
      username: input.username,
      displayName: input.displayName,
      metadata: input.metadata,
      lastVerifiedAt: now,
      updatedAt: now,
    })
    .where(eq(pages.id, platformAccountId))
    .returning();

  return updated;
}

export async function mergePageMetadata(
  db: Database,
  platformAccountId: number,
  metadataPatch: Record<string, unknown>,
) {
  const now = new Date();
  const patchJson = JSON.stringify(metadataPatch);

  const result = await db.execute(sql`
    update pages
    set metadata = coalesce(metadata, '{}'::jsonb) || ${patchJson}::jsonb,
        updated_at = ${now}
    where id = ${platformAccountId}
    returning metadata
  `);

  const metadata = result.rows[0]?.metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}
