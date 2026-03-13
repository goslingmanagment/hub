import { eq, sql } from "drizzle-orm";

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
      throw new Error(`Model "${input.slug}" already exists`, {
        cause: error instanceof Error ? error : undefined,
      });
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
  const [created] = await db.transaction(async (tx) => {
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
    followerCount: number;
    subscriberCount: number;
    earningsBalanceMills: bigint;
    metadata: Record<string, unknown>;
    syncType: "light" | "followers";
  },
) {
  const now = new Date();
  const patch: {
    platformAccountId: string;
    username: string | null;
    displayName: string | null;
    followerCount: number;
    subscriberCount: number;
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
  } else {
    patch.lastFollowerSyncAt = now;
  }

  const [updated] = await db
    .update(platformAccounts)
    .set(patch)
    .where(eq(platformAccounts.id, platformAccountId))
    .returning();

  return updated;
}
