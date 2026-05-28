import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { fanPages, fanProfiles, fans } from "../schema.ts";
import { findVisiblePageDmConversationByPlatformConversationId } from "./page-dm.ts";

export interface AppendFanProfileInput {
  fanId: number;
  platformAccountId: number;
  body: string;
  source: string;
  createdByUserId?: number | null;
}

export async function appendFanProfile(
  db: Database,
  input: AppendFanProfileInput,
) {
  return db.transaction(async (tx) => {
    // Serialize version assignment per fan/page so version numbers stay gapless and monotonic.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`${input.platformAccountId}:${input.fanId}`}, 0))
    `);

    const [latest] = await tx
      .select({ version: fanProfiles.version })
      .from(fanProfiles)
      .where(and(
        eq(fanProfiles.fanId, input.fanId),
        eq(fanProfiles.platformAccountId, input.platformAccountId),
      ))
      .orderBy(desc(fanProfiles.version))
      .limit(1);

    const [created] = await tx
      .insert(fanProfiles)
      .values({
        fanId: input.fanId,
        platformAccountId: input.platformAccountId,
        version: (latest?.version ?? 0) + 1,
        body: input.body,
        source: input.source,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();

    return created;
  });
}

export async function getLatestFanProfile(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
  },
) {
  return db.query.fanProfiles.findFirst({
    where: and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
    ),
    orderBy: (table, { desc: orderDesc }) => [orderDesc(table.version)],
  });
}

export async function listFanProfileVersionSummaries(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
  },
) {
  return db
    .select({
      version: fanProfiles.version,
      createdAt: fanProfiles.createdAt,
    })
    .from(fanProfiles)
    .where(and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
    ))
    .orderBy(desc(fanProfiles.version));
}

export async function getFanProfileVersion(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
    version: number;
  },
) {
  return db.query.fanProfiles.findFirst({
    where: and(
      eq(fanProfiles.fanId, input.fanId),
      eq(fanProfiles.platformAccountId, input.platformAccountId),
      eq(fanProfiles.version, input.version),
    ),
  });
}

export async function getLatestFanProfileForConversation(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationId: string;
  },
) {
  const conversation = await findVisiblePageDmConversationByPlatformConversationId(db, input);
  if (!conversation?.fanId) {
    return null;
  }

  const fan = await db.query.fans.findFirst({
    where: eq(fans.id, conversation.fanId),
  });
  if (!fan) {
    return null;
  }

  const [fanPage] = await db.select({
    pageAlias: fanPages.pageAlias,
  }).from(fanPages)
    .where(and(
      eq(fanPages.platformAccountId, input.platformAccountId),
      eq(fanPages.fanId, fan.id),
    ))
    .limit(1);

  const profile = await getLatestFanProfile(db, {
    fanId: fan.id,
    platformAccountId: input.platformAccountId,
  });

  return {
    fan: {
      ...fan,
      pageAlias: fanPage?.pageAlias ?? null,
    },
    profile: profile ?? null,
  };
}
