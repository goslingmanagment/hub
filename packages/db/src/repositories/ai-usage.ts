import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { aiUsageFeatures, type AiUsageFeature } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { aiUsageEvents, users } from "../schema.ts";

type NumericValue = number | bigint | null | undefined;
export type AiGatewayProvider = "anthropic" | "openrouter";
export type AiGatewayOutcome = "completed" | "failed" | "cancelled" | "quota_denied";
export type AiGatewayFailurePhase = "connect" | "provider_response" | "stream";

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
  errorCode?: string | null;
  failurePhase?: AiGatewayFailurePhase | null;
  providerHttpStatus?: number | null;
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
  pageId: number | null;
  /** NULL when a quota denial is recorded before provider resolution. */
  provider: AiGatewayProvider | null;
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
  errorCode?: string | null;
  failurePhase?: AiGatewayFailurePhase | null;
  providerHttpStatus?: number | null;
  durationMs: number;
  isCacheHit: boolean;
  completedAt: Date;
}

export interface MarkStaleAiGatewayReservationsInput {
  reservedBefore: Date;
  recoveredAt: Date;
}

export interface ListChatterUsageSummaryInput {
  from: Date;
  toExclusive: Date;
}

/** Decision 347: one user's own report — every role, every page, no chatter filter. */
export interface ListUserUsageReportInput {
  userId: number;
  from: Date;
  toExclusive: Date;
  /** IANA zone the daily buckets are cut in (the report's business days). */
  timeZone: string;
}

export interface UserUsageDailyRow {
  date: string;
  requestCount: number;
  costMicroUsd: number;
}

export interface UserUsageReport {
  row: Omit<ChatterUsageSummaryRow, "userId">;
  daily: UserUsageDailyRow[];
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
  cost: {
    microUsd: number;
    approximate: boolean;
  };
  gateway: {
    requestCount: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
    quotaDeniedCount: number;
    openReservationCount: number;
    providerBreakdown: {
      provider: AiGatewayProvider;
      requestCount: number;
      costMicroUsd: number;
    }[];
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
      costMicroUsd: number;
      costApproximate: boolean;
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

function rowValue(row: Record<string, unknown>, field: string) {
  return row[field] ?? row[field.toLowerCase()];
}

function normalizeRowNumber(row: Record<string, unknown>, field: string) {
  return normalizeNumber(rowValue(row, field) as NumericValue, field);
}

function normalizeRowBoolean(row: Record<string, unknown>, field: string) {
  return Boolean(rowValue(row, field));
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
      errorCode: event.errorCode ?? null,
      failurePhase: event.failurePhase ?? null,
      providerHttpStatus: event.providerHttpStatus ?? null,
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
    /** NULL = system lane (internal gateway completions). */
    userId: number | null;
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
    errorCode: null,
    failurePhase: null,
    providerHttpStatus: null,
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

/** Stage 29: a denied request leaves a ledger row too — quota_denied is a
 * first-class outcome, not silence. Duplicate client ids no-op. */
export async function recordAiGatewayQuotaDenied(
  db: Database,
  input: {
    userId: number | null;
    event: ReserveAiGatewayUsageEventInput;
  },
) {
  await db.insert(aiUsageEvents).values({
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
    quotaAccepted: false,
    gatewayOutcome: "quota_denied",
    errorCode: null,
    failurePhase: null,
    providerHttpStatus: null,
    conversationId: input.event.conversationId ?? null,
    durationMs: null,
    isCacheHit: false,
    isRegeneration: input.event.isRegeneration,
    completedAt: input.event.reservedAt,
  }).onConflictDoNothing({
    target: [aiUsageEvents.userId, aiUsageEvents.clientEventId],
  });
}

export async function finalizeAiGatewayUsageEvent(
  db: Database,
  input: {
    userId: number | null;
    event: FinalizeAiGatewayUsageEventInput;
  },
) {
  const failed = input.event.gatewayOutcome === "failed";
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
      // Successful/cancelled terminals never retain stale failure detail.
      // A failed production caller supplies the precise values; the fallback
      // keeps an unforeseen terminal failure classified rather than blank.
      errorCode: failed ? (input.event.errorCode ?? "provider_stream_failed") : null,
      failurePhase: failed ? (input.event.failurePhase ?? "stream") : null,
      providerHttpStatus: failed ? (input.event.providerHttpStatus ?? null) : null,
      durationMs: Math.max(0, Math.floor(input.event.durationMs)),
      isCacheHit: input.event.isCacheHit,
      completedAt: input.event.completedAt,
    })
    .where(sql`
      ${aiUsageEvents.userId} is not distinct from ${input.userId}
      and ${aiUsageEvents.clientEventId} = ${input.event.clientEventId}
    `)
    .returning({ id: aiUsageEvents.id });

  // The row id feeds the Stage 29 restricted-content FK; null = no such
  // reservation (the caller treats that as a failed finalize).
  return updated[0]?.id ?? null;
}

/**
 * Stage 1B AI failure streak. Only provider attempts with classified failure
 * detail participate, so pre-Stage-1B failed rows and quota denials cannot
 * manufacture an incident. Completed/cancelled provider attempts stop the
 * streak; quota denials are ignored because no generation reached a provider.
 */
export async function getAiGatewayPageConsecutiveFailureCount(
  db: Database,
  input: {
    pageId: number;
    threshold?: number;
  },
) {
  const threshold = Math.max(1, Math.floor(input.threshold ?? 3));
  const rows = await db.select({
    gatewayOutcome: aiUsageEvents.gatewayOutcome,
    errorCode: aiUsageEvents.errorCode,
    failurePhase: aiUsageEvents.failurePhase,
    providerHttpStatus: aiUsageEvents.providerHttpStatus,
  })
    .from(aiUsageEvents)
    .where(and(
      eq(aiUsageEvents.pageId, input.pageId),
      eq(aiUsageEvents.quotaAccepted, true),
      inArray(aiUsageEvents.gatewayOutcome, ["completed", "failed", "cancelled"]),
    ))
    .orderBy(desc(aiUsageEvents.completedAt), desc(aiUsageEvents.id))
    .limit(threshold);

  let consecutiveFailures = 0;
  for (const row of rows) {
    if (
      row.gatewayOutcome !== "failed"
      || row.errorCode === null
      || row.failurePhase === null
      // Billing/auth have their own immediate GLOBAL incident. They stop a
      // page-local streak so a later unrelated failure cannot duplicate the
      // same global access outage as an ai_provider_failed page incident.
      || row.errorCode === "provider_billing"
      || row.errorCode === "provider_auth"
    ) {
      break;
    }
    consecutiveFailures += 1;
  }
  return consecutiveFailures;
}

export async function markStaleAiGatewayReservationsFailed(
  db: Database,
  input: MarkStaleAiGatewayReservationsInput,
) {
  const updated = await db.update(aiUsageEvents)
    .set({
      gatewayOutcome: "failed",
      errorCode: "provider_stream_failed",
      failurePhase: "stream",
      providerHttpStatus: null,
      durationMs: sql<number>`
        greatest(
          0,
          floor(extract(epoch from (${input.recoveredAt} - ${aiUsageEvents.completedAt})) * 1000)
        )::int
      `,
    })
    .where(sql`
      ${aiUsageEvents.provider} is not null
      and ${aiUsageEvents.quotaAccepted} = true
      and ${aiUsageEvents.gatewayOutcome} is null
      and ${aiUsageEvents.completedAt} < ${input.reservedBefore}
    `)
    .returning({ id: aiUsageEvents.id });

  return updated.length;
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

/** Stage 29 per-feature budget check: global (all principals) daily totals. */
export async function getAiGatewayFeatureDailyTotals(
  db: Database,
  input: { feature: AiUsageFeature; from: Date; toExclusive: Date },
): Promise<AiGatewayDailyUsageTotals> {
  const result = await db.execute(sql`
    select count(*)::int as "requestCount",
           coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint as "costMicroUsd"
    from ${aiUsageEvents}
    where ${aiUsageEvents.feature} = ${input.feature}
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
             ${aiUsageEvents.costMicroUsd} as "costMicroUsd",
             ${aiUsageEvents.costApproximate} as "costApproximate",
             ${aiUsageEvents.provider} as provider,
             ${aiUsageEvents.gatewayOutcome} as "gatewayOutcome",
             ${aiUsageEvents.quotaAccepted} as "quotaAccepted",
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
             coalesce(sum(fe."costMicroUsd"), 0)::bigint as "costMicroUsd",
             coalesce(bool_or(fe."costApproximate"), false) as "costApproximate",
             count(fe.id) filter (
               where fe.provider is not null
                  or fe."gatewayOutcome" is not null
                  or fe."quotaAccepted" is not null
             )::int as "gatewayRequestCount",
             count(fe.id) filter (where fe."gatewayOutcome" = 'completed')::int as "gatewayCompletedCount",
             count(fe.id) filter (where fe."gatewayOutcome" = 'failed')::int as "gatewayFailedCount",
             count(fe.id) filter (where fe."gatewayOutcome" = 'cancelled')::int as "gatewayCancelledCount",
             count(fe.id) filter (where fe."gatewayOutcome" = 'quota_denied')::int as "gatewayQuotaDeniedCount",
             count(fe.id) filter (
               where fe.provider is not null
                 and fe."quotaAccepted" = true
                 and fe."gatewayOutcome" is null
             )::int as "gatewayOpenReservationCount",
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
           ut."costMicroUsd",
           ut."costApproximate",
           ut."gatewayRequestCount",
           ut."gatewayCompletedCount",
           ut."gatewayFailedCount",
           ut."gatewayCancelledCount",
           ut."gatewayQuotaDeniedCount",
           ut."gatewayOpenReservationCount",
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
             ${aiUsageEvents.costMicroUsd} as "costMicroUsd",
             ${aiUsageEvents.costApproximate} as "costApproximate",
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
           coalesce(sum(fe."costMicroUsd"), 0)::bigint as "costMicroUsd",
           coalesce(bool_or(fe."costApproximate"), false) as "costApproximate",
           count(*) filter (where fe."isRegeneration")::int as "regenerationCount"
    from filtered_events fe
    group by fe."userId", fe.feature
    order by fe."userId" asc, "requestCount" desc, fe.feature asc
  `);

  const providerBreakdownResult = await db.execute(sql`
    select ${aiUsageEvents.userId} as "userId",
           ${aiUsageEvents.provider} as provider,
           count(*)::int as "requestCount",
           coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint as "costMicroUsd"
    from ${aiUsageEvents}
    where ${aiUsageEvents.completedAt} >= ${input.from}
      and ${aiUsageEvents.completedAt} < ${input.toExclusive}
      and ${aiUsageEvents.provider} is not null
    group by ${aiUsageEvents.userId}, ${aiUsageEvents.provider}
    order by ${aiUsageEvents.userId} asc, "requestCount" desc, ${aiUsageEvents.provider} asc
  `);

  const summaries = totalsResult.rows.map((row) => {
    const inputTokens = normalizeNumber(row.inputTokens as NumericValue, "inputTokens");
    const outputTokens = normalizeNumber(row.outputTokens as NumericValue, "outputTokens");
    const cacheWriteTokens = normalizeNumber(row.cacheWriteTokens as NumericValue, "cacheWriteTokens");
    const cacheReadTokens = normalizeNumber(row.cacheReadTokens as NumericValue, "cacheReadTokens");

    return {
      userId: normalizeNumber(row.userId as NumericValue, "userId"),
      username: String(row.username ?? ""),
      totalGenerations: normalizeNumber(row.totalGenerations as NumericValue, "totalGenerations"),
      tokenCounts: {
        input: inputTokens,
        output: outputTokens,
        cacheWrite: cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheTotal: cacheWriteTokens + cacheReadTokens,
      },
      cost: {
        microUsd: normalizeRowNumber(row as Record<string, unknown>, "costMicroUsd"),
        approximate: normalizeRowBoolean(row as Record<string, unknown>, "costApproximate"),
      },
      gateway: {
        requestCount: normalizeRowNumber(row as Record<string, unknown>, "gatewayRequestCount"),
        completedCount: normalizeRowNumber(row as Record<string, unknown>, "gatewayCompletedCount"),
        failedCount: normalizeRowNumber(row as Record<string, unknown>, "gatewayFailedCount"),
        cancelledCount: normalizeRowNumber(row as Record<string, unknown>, "gatewayCancelledCount"),
        quotaDeniedCount: normalizeRowNumber(row as Record<string, unknown>, "gatewayQuotaDeniedCount"),
        openReservationCount: normalizeRowNumber(row as Record<string, unknown>, "gatewayOpenReservationCount"),
        providerBreakdown: [],
      },
      regenerateRatePct: normalizeNumber(row.regenerateRatePct as NumericValue, "regenerateRatePct"),
      warning: Boolean(row.warning),
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
    const userId = normalizeNumber(row.userId as NumericValue, "userId");
    const requestCount = normalizeNumber(row.requestCount as NumericValue, "requestCount");
    const inputTokens = normalizeNumber(row.inputTokens as NumericValue, "inputTokens");
    const outputTokens = normalizeNumber(row.outputTokens as NumericValue, "outputTokens");
    const cacheWriteTokens = normalizeNumber(row.cacheWriteTokens as NumericValue, "cacheWriteTokens");
    const cacheReadTokens = normalizeNumber(row.cacheReadTokens as NumericValue, "cacheReadTokens");
    const regenerationCount = normalizeNumber(row.regenerationCount as NumericValue, "regenerationCount");
    const totalGenerations = totalGenerationsByUser.get(userId) ?? 0;
    const breakdown = featureBreakdownByUser.get(userId) ?? [];

    breakdown.push({
      feature: normalizeFeature(row.feature, "feature"),
      requestCount,
      sharePct: roundPercentage(requestCount, totalGenerations),
      tokenCounts: {
        input: inputTokens,
        output: outputTokens,
        cacheWrite: cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheTotal: cacheWriteTokens + cacheReadTokens,
      },
      costMicroUsd: normalizeRowNumber(row as Record<string, unknown>, "costMicroUsd"),
      costApproximate: normalizeRowBoolean(row as Record<string, unknown>, "costApproximate"),
      regenerateRatePct: roundPercentage(regenerationCount, requestCount),
    });

    featureBreakdownByUser.set(userId, breakdown);
  }

  const providerBreakdownByUser = new Map<number, ChatterUsageSummaryRow["gateway"]["providerBreakdown"]>();
  for (const row of providerBreakdownResult.rows) {
    const userId = normalizeNumber(row.userId as NumericValue, "userId");
    const provider = row.provider;
    if (provider !== "anthropic" && provider !== "openrouter") {
      continue;
    }
    const breakdown = providerBreakdownByUser.get(userId) ?? [];
    breakdown.push({
      provider,
      requestCount: normalizeRowNumber(row as Record<string, unknown>, "requestCount"),
      costMicroUsd: normalizeRowNumber(row as Record<string, unknown>, "costMicroUsd"),
    });
    providerBreakdownByUser.set(userId, breakdown);
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
      gateway: {
        ...summary.gateway,
        providerBreakdown: providerBreakdownByUser.get(summary.userId) ?? [],
      },
      topFeature,
      featureBreakdown,
    } satisfies ChatterUsageSummaryRow;
  });
}

/**
 * Decision 347 (§5.2): the caller's OWN usage. Deliberately a separate query
 * from listChatterUsageSummary, which hard-filters `role = 'chatter'` (a
 * team_lead's or owner's cabinet would be empty) and from the quota totals,
 * whose per-page semantics serve the gateway budget. Same aggregation rules as
 * the admin report, plus daily buckets by completed_at in the report zone.
 */
export async function listUserUsageReport(
  db: Database,
  input: ListUserUsageReportInput,
): Promise<UserUsageReport> {
  const totalsResult = await db.execute(sql`
    with filtered_events as (
      select ${aiUsageEvents.id} as id,
             ${aiUsageEvents.inputTokens} as "inputTokens",
             ${aiUsageEvents.outputTokens} as "outputTokens",
             ${aiUsageEvents.cacheWriteTokens} as "cacheWriteTokens",
             ${aiUsageEvents.cacheReadTokens} as "cacheReadTokens",
             ${aiUsageEvents.costMicroUsd} as "costMicroUsd",
             ${aiUsageEvents.costApproximate} as "costApproximate",
             ${aiUsageEvents.provider} as provider,
             ${aiUsageEvents.gatewayOutcome} as "gatewayOutcome",
             ${aiUsageEvents.quotaAccepted} as "quotaAccepted",
             ${aiUsageEvents.isRegeneration} as "isRegeneration"
      from ${aiUsageEvents}
      where ${aiUsageEvents.userId} = ${input.userId}
        and ${aiUsageEvents.completedAt} >= ${input.from}
        and ${aiUsageEvents.completedAt} < ${input.toExclusive}
    )
    select u.username,
           count(fe.id)::int as "totalGenerations",
           coalesce(sum(fe."inputTokens"), 0)::bigint as "inputTokens",
           coalesce(sum(fe."outputTokens"), 0)::bigint as "outputTokens",
           coalesce(sum(fe."cacheWriteTokens"), 0)::bigint as "cacheWriteTokens",
           coalesce(sum(fe."cacheReadTokens"), 0)::bigint as "cacheReadTokens",
           coalesce(sum(fe."costMicroUsd"), 0)::bigint as "costMicroUsd",
           coalesce(bool_or(fe."costApproximate"), false) as "costApproximate",
           count(fe.id) filter (
             where fe.provider is not null
                or fe."gatewayOutcome" is not null
                or fe."quotaAccepted" is not null
           )::int as "gatewayRequestCount",
           count(fe.id) filter (where fe."gatewayOutcome" = 'completed')::int as "gatewayCompletedCount",
           count(fe.id) filter (where fe."gatewayOutcome" = 'failed')::int as "gatewayFailedCount",
           count(fe.id) filter (where fe."gatewayOutcome" = 'cancelled')::int as "gatewayCancelledCount",
           count(fe.id) filter (where fe."gatewayOutcome" = 'quota_denied')::int as "gatewayQuotaDeniedCount",
           count(fe.id) filter (
             where fe.provider is not null
               and fe."quotaAccepted" = true
               and fe."gatewayOutcome" is null
           )::int as "gatewayOpenReservationCount",
           count(fe.id) filter (where fe."isRegeneration")::int as "regenerationCount"
    from ${users} u
    left join filtered_events fe on true
    where u.id = ${input.userId}
    group by u.id, u.username
  `);
  const totals = totalsResult.rows[0] as Record<string, unknown> | undefined;
  if (!totals) {
    throw new Error(`User ${input.userId} not found for the usage report`);
  }

  const featureBreakdownResult = await db.execute(sql`
    select ${aiUsageEvents.feature} as feature,
           count(*)::int as "requestCount",
           coalesce(sum(${aiUsageEvents.inputTokens}), 0)::bigint as "inputTokens",
           coalesce(sum(${aiUsageEvents.outputTokens}), 0)::bigint as "outputTokens",
           coalesce(sum(${aiUsageEvents.cacheWriteTokens}), 0)::bigint as "cacheWriteTokens",
           coalesce(sum(${aiUsageEvents.cacheReadTokens}), 0)::bigint as "cacheReadTokens",
           coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint as "costMicroUsd",
           coalesce(bool_or(${aiUsageEvents.costApproximate}), false) as "costApproximate",
           count(*) filter (where ${aiUsageEvents.isRegeneration})::int as "regenerationCount"
    from ${aiUsageEvents}
    where ${aiUsageEvents.userId} = ${input.userId}
      and ${aiUsageEvents.completedAt} >= ${input.from}
      and ${aiUsageEvents.completedAt} < ${input.toExclusive}
    group by ${aiUsageEvents.feature}
    order by "requestCount" desc, ${aiUsageEvents.feature} asc
  `);

  const providerBreakdownResult = await db.execute(sql`
    select ${aiUsageEvents.provider} as provider,
           count(*)::int as "requestCount",
           coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint as "costMicroUsd"
    from ${aiUsageEvents}
    where ${aiUsageEvents.userId} = ${input.userId}
      and ${aiUsageEvents.completedAt} >= ${input.from}
      and ${aiUsageEvents.completedAt} < ${input.toExclusive}
      and ${aiUsageEvents.provider} is not null
    group by ${aiUsageEvents.provider}
    order by "requestCount" desc, ${aiUsageEvents.provider} asc
  `);

  // Daily buckets in the report zone: completed_at shifted into the zone and
  // truncated to its calendar day (the admin report's business-day boundary).
  const dailyResult = await db.execute(sql`
    select to_char(timezone(${input.timeZone}, ${aiUsageEvents.completedAt}), 'YYYY-MM-DD') as date,
           count(*)::int as "requestCount",
           coalesce(sum(${aiUsageEvents.costMicroUsd}), 0)::bigint as "costMicroUsd"
    from ${aiUsageEvents}
    where ${aiUsageEvents.userId} = ${input.userId}
      and ${aiUsageEvents.completedAt} >= ${input.from}
      and ${aiUsageEvents.completedAt} < ${input.toExclusive}
    group by 1
    order by 1 asc
  `);

  const totalGenerations = normalizeNumber(totals.totalGenerations as NumericValue, "totalGenerations");
  const inputTokens = normalizeNumber(totals.inputTokens as NumericValue, "inputTokens");
  const outputTokens = normalizeNumber(totals.outputTokens as NumericValue, "outputTokens");
  const cacheWriteTokens = normalizeNumber(totals.cacheWriteTokens as NumericValue, "cacheWriteTokens");
  const cacheReadTokens = normalizeNumber(totals.cacheReadTokens as NumericValue, "cacheReadTokens");
  const regenerationCount = normalizeRowNumber(totals, "regenerationCount");

  const featureBreakdown = featureBreakdownResult.rows.map((row) => {
    const requestCount = normalizeNumber(row.requestCount as NumericValue, "requestCount");
    const featureInput = normalizeNumber(row.inputTokens as NumericValue, "inputTokens");
    const featureOutput = normalizeNumber(row.outputTokens as NumericValue, "outputTokens");
    const featureCacheWrite = normalizeNumber(row.cacheWriteTokens as NumericValue, "cacheWriteTokens");
    const featureCacheRead = normalizeNumber(row.cacheReadTokens as NumericValue, "cacheReadTokens");
    const featureRegenerations = normalizeNumber(row.regenerationCount as NumericValue, "regenerationCount");
    return {
      feature: normalizeFeature(row.feature, "feature"),
      requestCount,
      sharePct: roundPercentage(requestCount, totalGenerations),
      tokenCounts: {
        input: featureInput,
        output: featureOutput,
        cacheWrite: featureCacheWrite,
        cacheRead: featureCacheRead,
        cacheTotal: featureCacheWrite + featureCacheRead,
      },
      costMicroUsd: normalizeRowNumber(row as Record<string, unknown>, "costMicroUsd"),
      costApproximate: normalizeRowBoolean(row as Record<string, unknown>, "costApproximate"),
      regenerateRatePct: roundPercentage(featureRegenerations, requestCount),
    };
  });

  const providerBreakdown: ChatterUsageSummaryRow["gateway"]["providerBreakdown"] = [];
  for (const row of providerBreakdownResult.rows) {
    const provider = row.provider;
    if (provider !== "anthropic" && provider !== "openrouter") {
      continue;
    }
    providerBreakdown.push({
      provider,
      requestCount: normalizeRowNumber(row as Record<string, unknown>, "requestCount"),
      costMicroUsd: normalizeRowNumber(row as Record<string, unknown>, "costMicroUsd"),
    });
  }

  const topFeature = featureBreakdown[0]
    ? {
      feature: featureBreakdown[0].feature,
      requestCount: featureBreakdown[0].requestCount,
      sharePct: featureBreakdown[0].sharePct,
    }
    : null;
  const regenerateRatePct = roundPercentage(regenerationCount, totalGenerations);

  return {
    row: {
      username: String(totals.username ?? ""),
      totalGenerations,
      tokenCounts: {
        input: inputTokens,
        output: outputTokens,
        cacheWrite: cacheWriteTokens,
        cacheRead: cacheReadTokens,
        cacheTotal: cacheWriteTokens + cacheReadTokens,
      },
      cost: {
        microUsd: normalizeRowNumber(totals, "costMicroUsd"),
        approximate: normalizeRowBoolean(totals, "costApproximate"),
      },
      gateway: {
        requestCount: normalizeRowNumber(totals, "gatewayRequestCount"),
        completedCount: normalizeRowNumber(totals, "gatewayCompletedCount"),
        failedCount: normalizeRowNumber(totals, "gatewayFailedCount"),
        cancelledCount: normalizeRowNumber(totals, "gatewayCancelledCount"),
        quotaDeniedCount: normalizeRowNumber(totals, "gatewayQuotaDeniedCount"),
        openReservationCount: normalizeRowNumber(totals, "gatewayOpenReservationCount"),
        providerBreakdown,
      },
      topFeature,
      featureBreakdown,
      regenerateRatePct,
      warning: totalGenerations > 0 && regenerateRatePct > 30,
    },
    daily: dailyResult.rows.map((row) => ({
      date: String(row.date ?? ""),
      requestCount: normalizeNumber(row.requestCount as NumericValue, "requestCount"),
      costMicroUsd: normalizeRowNumber(row as Record<string, unknown>, "costMicroUsd"),
    })),
  };
}
