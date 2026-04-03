import { sql } from "drizzle-orm";

import { aiUsageFeatures, type AiUsageFeature } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { aiUsageEvents, users } from "../schema.ts";

type NumericValue = number | bigint | null | undefined;

export interface InsertAiUsageEventInput {
  clientEventId: string;
  feature: AiUsageFeature;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  conversationId?: string | null;
  durationMs?: number | null;
  isCacheHit: boolean;
  isRegeneration: boolean;
  completedAt: Date;
}

export interface ListChatterUsageSummaryInput {
  from: Date;
  toExclusive: Date;
}

export interface ChatterUsageSummaryRow {
  userId: number;
  username: string;
  totalGenerations: number;
  tokenCounts: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    cacheTotal: number;
  };
  topFeature: {
    feature: AiUsageFeature;
    requestCount: number;
    sharePct: number;
  } | null;
  regenerateRatePct: number;
  warning: boolean;
}

function normalizeNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${field} to be present`);
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Expected ${field} to be numeric`);
}

function normalizeNullableNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeNumber(value, field);
}

function normalizeFeature(value: unknown, field: string): AiUsageFeature {
  if (typeof value === "string" && (aiUsageFeatures as readonly string[]).includes(value)) {
    return value as AiUsageFeature;
  }

  throw new Error(`Expected ${field} to be a valid AI usage feature`);
}

export async function insertAiUsageEvents(
  db: Database,
  input: {
    userId: number;
    events: InsertAiUsageEventInput[];
  },
) {
  if (input.events.length === 0) {
    return 0;
  }

  const inserted = await db.insert(aiUsageEvents).values(
    input.events.map((event) => ({
      userId: input.userId,
      clientEventId: event.clientEventId,
      feature: event.feature,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheReadTokens: event.cacheReadTokens,
      conversationId: event.conversationId ?? null,
      durationMs: event.durationMs ?? null,
      isCacheHit: event.isCacheHit,
      isRegeneration: event.isRegeneration,
      completedAt: event.completedAt,
    })),
  ).onConflictDoNothing({
    target: [aiUsageEvents.userId, aiUsageEvents.clientEventId],
  }).returning({
    id: aiUsageEvents.id,
  });

  return inserted.length;
}

export async function listChatterUsageSummary(
  db: Database,
  input: ListChatterUsageSummaryInput,
): Promise<ChatterUsageSummaryRow[]> {
  const result = await db.execute(sql`
    with chatter_users as (
      select ${users.id} as "userId",
             ${users.username} as username
      from ${users}
      where ${users.role} = 'chatter'
    ),
    filtered_events as (
      select ${aiUsageEvents.id} as id,
             ${aiUsageEvents.userId} as "userId",
             ${aiUsageEvents.feature} as feature,
             ${aiUsageEvents.inputTokens} as "inputTokens",
             ${aiUsageEvents.outputTokens} as "outputTokens",
             ${aiUsageEvents.cacheWriteTokens} as "cacheWriteTokens",
             ${aiUsageEvents.cacheReadTokens} as "cacheReadTokens",
             ${aiUsageEvents.isRegeneration} as "isRegeneration"
      from ${aiUsageEvents}
      where ${aiUsageEvents.completedAt} >= ${input.from}
        and ${aiUsageEvents.completedAt} < ${input.toExclusive}
    ),
    usage_totals as (
      select cu."userId",
             cu.username,
             count(fe.id)::int as "totalGenerations",
             coalesce(sum(fe."inputTokens"), 0)::bigint as "inputTokens",
             coalesce(sum(fe."outputTokens"), 0)::bigint as "outputTokens",
             coalesce(sum(fe."cacheWriteTokens"), 0)::bigint as "cacheWriteTokens",
             coalesce(sum(fe."cacheReadTokens"), 0)::bigint as "cacheReadTokens",
             count(fe.id) filter (where fe."isRegeneration")::int as "regenerationCount"
      from chatter_users cu
      left join filtered_events fe on fe."userId" = cu."userId"
      group by cu."userId", cu.username
    ),
    feature_counts as (
      select fe."userId",
             fe.feature,
             count(fe.id)::int as "requestCount"
      from filtered_events fe
      group by fe."userId", fe.feature
    ),
    feature_rank as (
      select fc."userId",
             fc.feature,
             fc."requestCount",
             row_number() over (
               partition by fc."userId"
               order by fc."requestCount" desc, fc.feature asc
             ) as rn
      from feature_counts fc
    )
    select ut."userId",
           ut.username,
           ut."totalGenerations",
           ut."inputTokens",
           ut."outputTokens",
           ut."cacheWriteTokens",
           ut."cacheReadTokens",
           fr.feature as "topFeature",
           fr."requestCount" as "topFeatureRequestCount",
           case
             when fr.feature is null or ut."totalGenerations" = 0
               then null
             else round((fr."requestCount"::numeric / ut."totalGenerations"::numeric) * 100, 2)::double precision
           end as "topFeatureSharePct",
           case
             when ut."totalGenerations" = 0
               then 0::double precision
             else round((ut."regenerationCount"::numeric / ut."totalGenerations"::numeric) * 100, 2)::double precision
           end as "regenerateRatePct",
           case
             when ut."totalGenerations" = 0
               then false
             else ((ut."regenerationCount"::double precision / ut."totalGenerations"::double precision) * 100) > 30
           end as warning
    from usage_totals ut
    left join feature_rank fr
      on fr."userId" = ut."userId"
     and fr.rn = 1
    order by ut."totalGenerations" desc, ut.username asc
  `);

  return result.rows.map((row) => {
    const inputTokens = normalizeNumber((row as any).inputTokens, "inputTokens");
    const outputTokens = normalizeNumber((row as any).outputTokens, "outputTokens");
    const cacheWriteTokens = normalizeNumber((row as any).cacheWriteTokens, "cacheWriteTokens");
    const cacheReadTokens = normalizeNumber((row as any).cacheReadTokens, "cacheReadTokens");
    const topFeature = (row as any).topFeature === null || (row as any).topFeature === undefined
      ? null
      : {
        feature: normalizeFeature((row as any).topFeature, "topFeature"),
        requestCount: normalizeNumber((row as any).topFeatureRequestCount, "topFeatureRequestCount"),
        sharePct: normalizeNumber((row as any).topFeatureSharePct, "topFeatureSharePct"),
      };

    return {
      userId: normalizeNumber((row as any).userId, "userId"),
      username: String((row as any).username ?? ""),
      totalGenerations: normalizeNumber((row as any).totalGenerations, "totalGenerations"),
      tokenCounts: {
        input: inputTokens,
        output: outputTokens,
        cacheWrite: cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheTotal: cacheWriteTokens + cacheReadTokens,
      },
      topFeature,
      regenerateRatePct: normalizeNumber((row as any).regenerateRatePct, "regenerateRatePct"),
      warning: Boolean((row as any).warning),
    } satisfies ChatterUsageSummaryRow;
  });
}
