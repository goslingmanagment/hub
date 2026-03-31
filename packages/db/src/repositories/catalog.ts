import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { Platform, ProxyConfig } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  models,
  platformAccountCredentials,
  platformAccountProxies,
  platformAccounts,
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
    const [created] = await db.insert(models).values(input).returning();
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
        .insert(platformAccounts)
        .values({
          modelId: input.modelId,
          platform: input.platform,
          commissionRate: defaultCommissionRateForPlatform(input.platform),
          label: input.label,
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
    .insert(platformAccountCredentials)
    .values({
      platformAccountId: input.platformAccountId,
      encryptedSession: input.encryptedSession,
      keyVersion: input.keyVersion,
    })
    .onConflictDoUpdate({
      target: platformAccountCredentials.platformAccountId,
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
  },
) {
  const [proxy] = await db
    .insert(platformAccountProxies)
    .values({
      platformAccountId,
      url: input.url,
      encryptedAuth: input.encryptedAuth,
      keyVersion: input.keyVersion,
    })
    .onConflictDoUpdate({
      target: platformAccountProxies.platformAccountId,
      set: {
        url: input.url,
        encryptedAuth: input.encryptedAuth,
        keyVersion: input.keyVersion,
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
    .delete(platformAccountProxies)
    .where(eq(platformAccountProxies.platformAccountId, platformAccountId));
}

export async function findPageByLabel(db: Database, label: string) {
  const page = await db.query.platformAccounts.findFirst({
    where: eq(platformAccounts.label, label),
  });

  if (!page) {
    return null;
  }

  const credentials = await db.query.platformAccountCredentials.findFirst({
    where: eq(platformAccountCredentials.platformAccountId, page.id),
  });
  const proxy = await db.query.platformAccountProxies.findFirst({
    where: eq(platformAccountProxies.platformAccountId, page.id),
  });

  return { page, credentials, proxy };
}

export async function findPageById(db: Database, platformAccountId: number) {
  const page = await db.query.platformAccounts.findFirst({
    where: eq(platformAccounts.id, platformAccountId),
  });

  if (!page) {
    return null;
  }

  const credentials = await db.query.platformAccountCredentials.findFirst({
    where: eq(platformAccountCredentials.platformAccountId, page.id),
  });
  const proxy = await db.query.platformAccountProxies.findFirst({
    where: eq(platformAccountProxies.platformAccountId, page.id),
  });

  return { page, credentials, proxy };
}

export async function listFanslyPages(db: Database) {
  return listPagesByPlatform(db, "fansly");
}

export async function listPlatformAccounts(db: Database) {
  return db.query.platformAccounts.findMany();
}

export async function listPagesByPlatform(db: Database, platform: Platform) {
  return db.query.platformAccounts.findMany({
    where: eq(platformAccounts.platform, platform),
  });
}

export async function listModelsWithPageCounts(db: Database) {
  return db.execute(sql`
    select m.slug,
           m.name,
           count(pa.id)::int as page_count
    from models m
    left join platform_accounts pa on pa.model_id = m.id
    group by m.id, m.slug, m.name
    order by m.slug asc
  `);
}

export async function listAdminModels(db: Database) {
  return db.select({
    id: models.id,
    slug: models.slug,
    name: models.name,
    pageCount: sql<number>`count(${platformAccounts.id})::int`,
  }).from(models)
    .leftJoin(platformAccounts, eq(platformAccounts.modelId, models.id))
    .groupBy(models.id, models.slug, models.name)
    .orderBy(models.slug);
}

export async function updateModelBySlug(
  db: Database,
  slug: string,
  input: {
    slug?: string;
    name?: string;
  },
) {
  const patch: {
    slug?: string;
    name?: string;
  } = {};

  if (input.slug !== undefined) {
    patch.slug = input.slug;
  }
  if (input.name !== undefined) {
    patch.name = input.name;
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
        from platform_accounts pa
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
    pageCount: sql<number>`count(${platformAccounts.id})::int`,
  }).from(platformAccounts)
    .where(eq(platformAccounts.modelId, model.id));

  throw new ModelHasPagesError(slug, pageCount);
}

export async function listAdminPages(
  db: Database,
  input?: {
    pageIds?: number[];
  },
) {
  const clauses: Array<any> = [];

  if (input?.pageIds !== undefined) {
    if (input.pageIds.length === 0) {
      return [];
    }
    clauses.push(inArray(platformAccounts.id, input.pageIds));
  }

  return db.select({
    id: platformAccounts.id,
    label: platformAccounts.label,
    platform: platformAccounts.platform,
    username: platformAccounts.username,
    displayName: platformAccounts.displayName,
    followerCount: platformAccounts.followerCount,
    subscriberCount: platformAccounts.subscriberCount,
    lastLightSyncAt: platformAccounts.lastLightSyncAt,
    lastFollowerSyncAt: platformAccounts.lastFollowerSyncAt,
    modelSlug: models.slug,
    modelName: models.name,
  }).from(platformAccounts)
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(models.slug, platformAccounts.label);
}

export async function updatePageByLabel(
  db: Database,
  label: string,
  input: {
    label?: string;
    modelSlug?: string;
  },
) {
  const existing = await db.query.platformAccounts.findFirst({
    where: eq(platformAccounts.label, label),
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
      .update(platformAccounts)
      .set(patch)
      .where(eq(platformAccounts.id, existing.id))
      .returning();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      throw new DuplicatePageLabelError(input.label ?? label);
    }

    throw error;
  }

  return updated;
}

export async function deletePageByLabel(db: Database, label: string) {
  const [deleted] = await db
    .delete(platformAccounts)
    .where(eq(platformAccounts.label, label))
    .returning({
      id: platformAccounts.id,
      label: platformAccounts.label,
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
    from platform_accounts pa
    join models m on m.id = pa.model_id
    left join platform_account_proxies pap on pap.platform_account_id = pa.id
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
  const existingPage = await db.query.platformAccounts.findFirst({
    where: eq(platformAccounts.id, platformAccountId),
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

  const conflictingPage = await db.query.platformAccounts.findFirst({
    where: and(
      eq(platformAccounts.platform, existingPage.platform),
      eq(platformAccounts.platformAccountId, input.platformAccountIdValue),
      ne(platformAccounts.id, platformAccountId),
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
      .update(platformAccounts)
      .set(patch)
      .where(eq(platformAccounts.id, platformAccountId))
      .returning();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      const concurrentConflict = await db.query.platformAccounts.findFirst({
        where: and(
          eq(platformAccounts.platform, existingPage.platform),
          eq(platformAccounts.platformAccountId, input.platformAccountIdValue),
          ne(platformAccounts.id, platformAccountId),
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

export async function mergePageMetadata(
  db: Database,
  platformAccountId: number,
  metadataPatch: Record<string, unknown>,
) {
  const now = new Date();
  const patchJson = JSON.stringify(metadataPatch);

  const result = await db.execute(sql`
    update platform_accounts
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
