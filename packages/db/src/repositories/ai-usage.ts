import { sql } from "drizzle-orm";

import { aiUsageFeatures, type AiUsageFeature } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { aiUsageEvents, users } from "../schema.ts";

type NumericValue = number | bigint | null | undefined;
export type AiGatewayProvider = "anthropic" | "openrouter";
export type AiGatewayOutcome = "completed" | "failed" | "cancelled" | "quota_denied";

export interface InsertAiUsageEventInput {
  clientEventId: string;
  feature: AiUsageFeature;
  model: string;
  pageId?: number | null;
  provider?: AiGatewayProvider | null;
  providerResponseId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicroUsd?: number;
  costApproximate?: boolean;
  quotaAccepted?: boolean | null;
  gatewayOutcome?: AiGatewayOutcome | null;
  conversationId?: string | null;
  durationMs?: number | null;
  isCacheHit: boolean;
  isRegeneration: boolean;
  completedAt: Date;
}

export interface ReserveAiGatewayUsageEventInput {
  clientEventId: string;
  feature: AiUsageFeature;
  model: string;
  pageId: number;
  provider: AiGatewayProvider;
  conversationId?: string | null;
  isRegeneration: boolean;
  reservedAt: Date;
}

export interface FinalizeAiGatewayUsageEventInput {
  clientEventId: string;
  providerResponseId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicroUsd: number;
  costApproximate: boolean;
  gatewayOutcome: Exclude<AiGatewayOutcome, "quota_denied">;
  durationMs: number;
  isCacheHit: boolean;
  completedAt: Date;
}

export interface ListChatterUsageSummaryInput {
  from: Date;
  toExclusive: Date;
}

export interface GetAiGatewayDailyUsageTotalsInput {
  userId: number;
  pageId: number;
  from: Date;
  toExclusive: Date;
}

export interface AiGatewayDailyUsageTotals {
  requestCount: number;
  costMicroUsd: number;
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
  featureBreakdown: {
    feature: AiUsageFeature;
    requestCount: number;
    sharePct: number;
    tokenCounts: {
      input: number;
      output: number;
      cacheWrite: number;
      cacheRead: number;
      cacheTotal: number;
    };
    regenerateRatePct: number;
  }[];
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

function roundPercentage(numerator: number, denominator: number) {
  if (denominator === 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 10000) / 100;
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
      pageId: event.pageId ?? null,
      provider: event.provider ?? null,
      providerResponseId: event.providerResponseId ?? null,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheReadTokens: event.cacheReadTokens,
      costMicroUsd: event.costMicroUsd ?? 0,
      costApproximate: event.costApproximate ?? false,
      quotaAccepted: event.quotaAccepted ?? null,
      gatewayOutcome: event.gatewayOutcome ?? null,
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

export async function reserveAiGatewayUsageEvent(
  db: Database,
  input: {
    userId: number;
    event: ReserveAiGatewayUsageEventInput;
  },
) {
  const inserted = await db.insert(aiUsageEvents).values({
    userId: input.userId,
    clientEventId: input.event.clientEventId,
    feature: input.event.feature,
    model: input.event.model,
    pageId: input.event.pageId,
    provider: input.event.provider,
    providerResponseId: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costMicroUsd: 0,
    costApproximate: false,
    quotaAccepted: true,
    gatewayOutcome: null,
    conversationId: input.event.conversationId ?? null,
    durationMs: null,
    isCacheHit: false,
    isRegeneration: input.event.isRegeneration,
    completedAt: input.event.reservedAt,
  }).onConflictDoNothing({
    target: [aiUsageEvents.userId, aiUsageEvents.clientEventId],
  }).returning({
    id: aiUsageEvents.id,
  });

  return inserted.length === 1;
}

export async function finalizeAiGatewayUsageEvent(
  db: Database,
  input: {
    userId: number;
    event: FinalizeAiGatewayUsageEventInput;
  },
) {
  const updated = await db.update(aiUsageEvents)
    .set({
      providerResponseId: input.event.providerResponseId ?? null,
      inputTokens: input.event.inputTokens,
      outputTokens: input.event.outputTokens,
      cacheWriteTokens: input.event.cacheWriteTokens,
      cacheReadTokens: input.event.cacheReadTokens,
      costMicroUsd: input.event.costMicroUsd,
      costApproximate: input.event.costApproximate,
      gatewayOutcome: input.event.gatewayOutcome,
      durationMs: Math.max(0, Math.floor(input.event.durationMs)),
      isCacheHit: input.event.isCacheHit,
      completedAt: input.event.completedAt,
    })
    .where(sql`
      ${aiUsageEvents.userId} = ${input.userId}
      and ${aiUsageEvents.clientEventId} = ${input.event.clientEventId}
    `)
    .returning({ id: aiUsageEvents.id });

  return updated.length === 1;
}

export async function getAiGatewayDailyUsageTotals(
  db: Database,
  input: GetAiGatewayDailyUsageTotalsInput,
): Promise<AiGatewayDailyUsageTotals> {
  const result = await db.execute(sql`
    select count(*)::int as "requestCount",
           coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint as "costMicroUsd"
    from ${aiUsageEvents}
    where ${aiUsageEvents.userId} = ${input.userId}
      and ${aiUsageEvents.pageId} = ${input.pageId}
      and ${aiUsageEvents.completedAt} >= ${input.from}
      and ${aiUsageEvents.completedAt} < ${input.toExclusive}
      and (
        ${aiUsageEvents.provider} is not null
        or ${aiUsageEvents.gatewayOutcome} is not null
        or ${aiUsageEvents.quotaAccepted} is not null
      )
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;

  return {
    requestCount: normalizeNumber(row?.requestCount as NumericValue, "requestCount"),
    costMicroUsd: normalizeNumber(row?.costMicroUsd as NumericValue, "costMicroUsd"),
  };
}

export async function listChatterUsageSummary(
  db: Database,
  input: ListChatterUsageSummaryInput,
): Promise<ChatterUsageSummaryRow[]> {
  const totalsResult = await db.execute(sql`
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
    )
    select ut."userId",
           ut.username,
           ut."totalGenerations",
           ut."inputTokens",
           ut."outputTokens",
           ut."cacheWriteTokens",
           ut."cacheReadTokens",
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
    order by ut."totalGenerations" desc, ut.username asc
  `);

  const featureBreakdownResult = await db.execute(sql`
    with filtered_events as (
      select ${aiUsageEvents.userId} as "userId",
             ${aiUsageEvents.feature} as feature,
             ${aiUsageEvents.inputTokens} as "inputTokens",
             ${aiUsageEvents.outputTokens} as "outputTokens",
             ${aiUsageEvents.cacheWriteTokens} as "cacheWriteTokens",
             ${aiUsageEvents.cacheReadTokens} as "cacheReadTokens",
             ${aiUsageEvents.isRegeneration} as "isRegeneration"
      from ${aiUsageEvents}
      where ${aiUsageEvents.completedAt} >= ${input.from}
        and ${aiUsageEvents.completedAt} < ${input.toExclusive}
    )
    select fe."userId",
           fe.feature,
           count(*)::int as "requestCount",
           coalesce(sum(fe."inputTokens"), 0)::bigint as "inputTokens",
           coalesce(sum(fe."outputTokens"), 0)::bigint as "outputTokens",
           coalesce(sum(fe."cacheWriteTokens"), 0)::bigint as "cacheWriteTokens",
           coalesce(sum(fe."cacheReadTokens"), 0)::bigint as "cacheReadTokens",
           count(*) filter (where fe."isRegeneration")::int as "regenerationCount"
    from filtered_events fe
    group by fe."userId", fe.feature
    order by fe."userId" asc, "requestCount" desc, fe.feature asc
  `);

  const summaries = totalsResult.rows.map((row) => {
    const inputTokens = normalizeNumber((row as any).inputTokens, "inputTokens");
    const outputTokens = normalizeNumber((row as any).outputTokens, "outputTokens");
    const cacheWriteTokens = normalizeNumber((row as any).cacheWriteTokens, "cacheWriteTokens");
    const cacheReadTokens = normalizeNumber((row as any).cacheReadTokens, "cacheReadTokens");

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
      regenerateRatePct: normalizeNumber((row as any).regenerateRatePct, "regenerateRatePct"),
      warning: Boolean((row as any).warning),
    };
  });

  const totalGenerationsByUser = new Map(
    summaries.map((summary) => [summary.userId, summary.totalGenerations]),
  );
  const featureBreakdownByUser = new Map<
    number,
    ChatterUsageSummaryRow["featureBreakdown"]
  >();

  for (const row of featureBreakdownResult.rows) {
    const userId = normalizeNumber((row as any).userId, "userId");
    const requestCount = normalizeNumber((row as any).requestCount, "requestCount");
    const inputTokens = normalizeNumber((row as any).inputTokens, "inputTokens");
    const outputTokens = normalizeNumber((row as any).outputTokens, "outputTokens");
    const cacheWriteTokens = normalizeNumber((row as any).cacheWriteTokens, "cacheWriteTokens");
    const cacheReadTokens = normalizeNumber((row as any).cacheReadTokens, "cacheReadTokens");
    const regenerationCount = normalizeNumber((row as any).regenerationCount, "regenerationCount");
    const totalGenerations = totalGenerationsByUser.get(userId) ?? 0;
    const breakdown = featureBreakdownByUser.get(userId) ?? [];

    breakdown.push({
      feature: normalizeFeature((row as any).feature, "feature"),
      requestCount,
      sharePct: roundPercentage(requestCount, totalGenerations),
      tokenCounts: {
        input: inputTokens,
        output: outputTokens,
        cacheWrite: cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheTotal: cacheWriteTokens + cacheReadTokens,
      },
      regenerateRatePct: roundPercentage(regenerationCount, requestCount),
    });

    featureBreakdownByUser.set(userId, breakdown);
  }

  return summaries.map((summary) => {
    const featureBreakdown = featureBreakdownByUser.get(summary.userId) ?? [];
    const topFeature = featureBreakdown[0]
      ? {
        feature: featureBreakdown[0].feature,
        requestCount: featureBreakdown[0].requestCount,
        sharePct: featureBreakdown[0].sharePct,
      }
      : null;

    return {
      ...summary,
      topFeature,
      featureBreakdown,
    } satisfies ChatterUsageSummaryRow;
  });
}
