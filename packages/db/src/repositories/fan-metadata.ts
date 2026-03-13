import { and, eq, inArray } from "drizzle-orm";

import type { FanFlagType } from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import { fanFlags, fanNotes, fanSummaries } from "../schema.ts";

export async function listFanNotesForPages(
  db: Database,
  fanId: number,
  platformAccountIds: number[],
) {
  if (platformAccountIds.length === 0) {
    return [];
  }

  return db.query.fanNotes.findMany({
    where: and(
      eq(fanNotes.fanId, fanId),
      inArray(fanNotes.platformAccountId, platformAccountIds),
    ),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
}

export async function listFanSummariesForPages(
  db: Database,
  fanId: number,
  platformAccountIds: number[],
) {
  if (platformAccountIds.length === 0) {
    return [];
  }

  return db.query.fanSummaries.findMany({
    where: and(
      eq(fanSummaries.fanId, fanId),
      inArray(fanSummaries.platformAccountId, platformAccountIds),
    ),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
}

export async function listFanFlags(db: Database, fanId: number) {
  return db.query.fanFlags.findMany({
    where: eq(fanFlags.fanId, fanId),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
}

export async function createFanNote(
  db: Database,
  input: {
    fanId: number;
    platformAccountId: number;
    authorUserId: number;
    body: string;
  },
) {
  const [note] = await db
    .insert(fanNotes)
    .values({
      fanId: input.fanId,
      platformAccountId: input.platformAccountId,
      authorUserId: input.authorUserId,
      body: input.body,
    })
    .returning();

  return note;
}

export async function setFanFlags(
  db: Database,
  input: {
    fanId: number;
    flags: FanFlagType[];
    createdByUserId: number;
  },
) {
  return db.transaction(async (tx) => {
    await tx.delete(fanFlags).where(eq(fanFlags.fanId, input.fanId));

    if (input.flags.length === 0) {
      return [];
    }

    return tx
      .insert(fanFlags)
      .values(
        input.flags.map((flag) => ({
          fanId: input.fanId,
          flag,
          createdByUserId: input.createdByUserId,
        })),
      )
      .returning();
  });
}
