import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  fans,
  onlyFansPublicProfileResolutions,
  spenderLifetimePage,
} from "../schema.ts";

export type OnlyFansPublicProfileResolutionStatus =
  | "resolved"
  | "not_found"
  | "unavailable"
  | "failed"
  | "rate_limited";

export interface OnlyFansPublicProfileResolutionCandidate {
  fanId: number;
  platformUserId: string;
  previousAttemptCount: number;
}

export interface UpsertOnlyFansPublicProfileResolutionInput {
  fanId: number;
  platformUserId: string;
  status: OnlyFansPublicProfileResolutionStatus;
  username?: string | null;
  displayName?: string | null;
  attemptedAt: Date;
  resolvedAt?: Date | null;
  nextAttemptAfter?: Date | null;
  lastError?: string | null;
}

function blankTextSql(column: SQLWrapper) {
  return sql`nullif(btrim(coalesce(${column}, '')), '') is null`;
}

function technicalOnlyFansUsernameSql() {
  return sql`
    lower(btrim(coalesce(${fans.username}, ''))) = lower('u' || ${fans.platformUserId})
  `;
}

export async function listOnlyFansPublicProfileResolutionCandidates(
  db: Database,
  input: {
    platformAccountId: number;
    limit: number;
    now?: Date;
  },
): Promise<OnlyFansPublicProfileResolutionCandidate[]> {
  if (input.limit <= 0) {
    return [];
  }

  const now = input.now ?? new Date();
  const rows = await db.select({
    fanId: fans.id,
    platformUserId: fans.platformUserId,
    previousAttemptCount: sql<number>`
      coalesce(${onlyFansPublicProfileResolutions.attemptCount}, 0)::int
    `,
  })
    .from(spenderLifetimePage)
    .innerJoin(fans, eq(fans.id, spenderLifetimePage.fanId))
    .leftJoin(
      onlyFansPublicProfileResolutions,
      eq(onlyFansPublicProfileResolutions.fanId, fans.id),
    )
    .where(and(
      eq(spenderLifetimePage.platformAccountId, input.platformAccountId),
      eq(fans.platform, "onlyfans"),
      or(
        blankTextSql(fans.displayName),
        blankTextSql(fans.username),
        technicalOnlyFansUsernameSql(),
      ),
      or(
        isNull(onlyFansPublicProfileResolutions.fanId),
        isNull(onlyFansPublicProfileResolutions.nextAttemptAfter),
        lte(onlyFansPublicProfileResolutions.nextAttemptAfter, now),
      ),
    ))
    .orderBy(
      desc(spenderLifetimePage.grossAmountMills),
      desc(spenderLifetimePage.lastTransactionAt),
      asc(fans.id),
    )
    .limit(input.limit);

  return rows.map((row) => ({
    fanId: row.fanId,
    platformUserId: row.platformUserId,
    previousAttemptCount: row.previousAttemptCount,
  }));
}

export async function upsertOnlyFansPublicProfileResolution(
  db: Database,
  input: UpsertOnlyFansPublicProfileResolutionInput,
) {
  await db.insert(onlyFansPublicProfileResolutions)
    .values({
      fanId: input.fanId,
      platformUserId: input.platformUserId,
      status: input.status,
      username: input.username ?? null,
      displayName: input.displayName ?? null,
      attemptCount: 1,
      lastAttemptedAt: input.attemptedAt,
      resolvedAt: input.resolvedAt ?? null,
      nextAttemptAfter: input.nextAttemptAfter ?? null,
      lastError: input.lastError ?? null,
      updatedAt: input.attemptedAt,
    })
    .onConflictDoUpdate({
      target: onlyFansPublicProfileResolutions.fanId,
      set: {
        platformUserId: sql`excluded.platform_user_id`,
        status: sql`excluded.status`,
        username: sql`excluded.username`,
        displayName: sql`excluded.display_name`,
        attemptCount: sql`${onlyFansPublicProfileResolutions.attemptCount} + 1`,
        lastAttemptedAt: sql`excluded.last_attempted_at`,
        resolvedAt: sql`excluded.resolved_at`,
        nextAttemptAfter: sql`excluded.next_attempt_after`,
        lastError: sql`excluded.last_error`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}
