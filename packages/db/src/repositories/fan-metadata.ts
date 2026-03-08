import { and, eq, inArray } from "drizzle-orm";

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
