import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

/**
 * The AI spend report's reads (owner's "Траты на ИИ"): Hub's ledger
 * (`ai_usage_events`) cut by every dimension the owner asks about, the use
 * chatters made of each answer, the dearest calls and chats, and the AI
 * settings changed around the period. Numbers only: no prompt or answer text
 * leaves the restricted record.
 */

type NumericValue = number | bigint | string | null | undefined;

function toNumber(value: NumericValue) {
  return value === null || value === undefined ? 0 : Number(value);
}

function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

export interface AiSpendRange {
  from: Date;
  toExclusive: Date;
  /** IANA zone the day and hour cuts are taken in. */
  timeZone: string;
}

export const AI_SPEND_DIMENSIONS = [
  "feature",
  "model",
  "effort",
  "window",
  "chatter",
  "page",
  "account",
  "branch",
  "outcome",
  "day",
  "hour",
  "dayFeature",
] as const;
export type AiSpendDimension = typeof AI_SPEND_DIMENSIONS[number];

/** One dimension value's ledger rows of one model, summed. */
export interface AiSpendCell {
  dimension: AiSpendDimension;
  key: string;
  label: string;
  model: string;
  calls: number;
  costMicroUsd: number;
  approximateMicroUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Cache writes of rows that name no TTL split (older rows). */
  cacheWriteUnsplitTokens: number;
  outputTokens: number;
  regenerationCalls: number;
  regenerationMicroUsd: number;
  failedCalls: number;
  failedMicroUsd: number;
}

// Window buckets: the owner's caps are 25 (Reply), 50 (Coach), 100 (Ping).
const WINDOW_BUCKET = sql`case
  when event.context_messages is null then '—'
  when event.context_messages <= 25 then '1–25'
  when event.context_messages <= 50 then '26–50'
  when event.context_messages <= 100 then '51–100'
  when event.context_messages <= 200 then '101–200'
  else '200+'
end`;

function rangeFilter(range: AiSpendRange) {
  return sql`event.completed_at >= ${range.from}
    and event.completed_at < ${range.toExclusive}
    and event.gateway_outcome in ('completed', 'failed', 'cancelled')`;
}

export async function listAiSpendCells(db: Database, range: AiSpendRange): Promise<AiSpendCell[]> {
  const result = await db.execute(sql`
    with base as (
      select event.*,
             (event.completed_at at time zone ${range.timeZone}) as local_at,
             ${WINDOW_BUCKET} as window_bucket,
             member.username,
             page.label as page_label,
             account.label as account_label
      from ai_usage_events event
      left join users member on member.id = event.user_id
      left join pages page on page.id = event.page_id
      left join ai_provider_accounts account on account.id = event.provider_account_id
      where ${rangeFilter(range)}
    )
    select cut.dimension,
           cut.key,
           cut.label,
           base.model,
           count(*) as calls,
           coalesce(sum(base.cost_micro_usd), 0) as cost,
           coalesce(sum(base.cost_micro_usd) filter (where base.cost_approximate), 0) as approximate,
           coalesce(sum(base.input_tokens), 0) as input,
           coalesce(sum(base.cache_read_tokens), 0) as cache_read,
           coalesce(sum(base.cache_write_5m_tokens), 0) as cache_write_5m,
           coalesce(sum(base.cache_write_1h_tokens), 0) as cache_write_1h,
           coalesce(sum(base.cache_write_tokens) filter (
             where base.cache_write_5m_tokens is null and base.cache_write_1h_tokens is null), 0) as cache_write_unsplit,
           coalesce(sum(base.output_tokens), 0) as output,
           count(*) filter (where base.is_regeneration) as regeneration_calls,
           coalesce(sum(base.cost_micro_usd) filter (where base.is_regeneration), 0) as regeneration_cost,
           count(*) filter (where base.gateway_outcome <> 'completed') as failed_calls,
           coalesce(sum(base.cost_micro_usd) filter (where base.gateway_outcome <> 'completed'), 0) as failed_cost
    from base
    cross join lateral (values
      ('feature', base.feature::text, base.feature::text),
      ('model', base.model, base.model),
      ('effort', coalesce(base.reasoning_effort, '—'), coalesce(base.reasoning_effort, '—')),
      ('window', base.window_bucket, base.window_bucket),
      ('chatter', coalesce(base.user_id::text, 'background'), coalesce(base.username, 'background')),
      ('page', coalesce(base.page_id::text, '—'), coalesce(base.page_label, '—')),
      ('account', coalesce(base.provider_account_id::text, '—'), coalesce(base.account_label, '—')),
      ('branch', case when base.user_id is null then 'background' else 'human' end,
                 case when base.user_id is null then 'background' else 'human' end),
      ('outcome', base.gateway_outcome, base.gateway_outcome),
      ('day', to_char(base.local_at, 'YYYY-MM-DD'), to_char(base.local_at, 'YYYY-MM-DD')),
      ('hour', to_char(base.local_at, 'HH24'), to_char(base.local_at, 'HH24')),
      ('dayFeature', to_char(base.local_at, 'YYYY-MM-DD') || '|' || base.feature::text, base.feature::text)
    ) as cut(dimension, key, label)
    group by cut.dimension, cut.key, cut.label, base.model
  `);
  return rowsOf<Record<string, NumericValue> & { dimension: AiSpendDimension; key: string; label: string; model: string }>(result)
    .map((row) => ({
      dimension: row.dimension,
      key: row.key,
      label: row.label,
      model: row.model,
      calls: toNumber(row.calls),
      costMicroUsd: toNumber(row.cost),
      approximateMicroUsd: toNumber(row.approximate),
      inputTokens: toNumber(row.input),
      cacheReadTokens: toNumber(row.cache_read),
      cacheWrite5mTokens: toNumber(row.cache_write_5m),
      cacheWrite1hTokens: toNumber(row.cache_write_1h),
      cacheWriteUnsplitTokens: toNumber(row.cache_write_unsplit),
      outputTokens: toNumber(row.output),
      regenerationCalls: toNumber(row.regeneration_calls),
      regenerationMicroUsd: toNumber(row.regeneration_cost),
      failedCalls: toNumber(row.failed_calls),
      failedMicroUsd: toNumber(row.failed_cost),
    }));
}

export interface AiSpendFeatureUseRow {
  feature: string;
  calls: number;
  costMicroUsd: number;
  /** Answers a chatter copied, inserted, edited or sent. */
  usedCalls: number;
  /** Answers sent to a fan at least once. */
  sentCalls: number;
  /** Messages sent from those answers (a split answer sends several). */
  sentMessages: number;
  unusedCalls: number;
  unusedMicroUsd: number;
}

/** What chatters did with each feature's answers (chatters' calls only). */
export async function listAiSpendFeatureUse(db: Database, range: AiSpendRange): Promise<AiSpendFeatureUseRow[]> {
  const result = await db.execute(sql`
    with generation as (
      select event.feature::text as feature,
             event.cost_micro_usd as cost,
             content.generation_ref
      from ai_usage_events event
      left join ai_generation_content content on content.usage_event_id = event.id
      where ${rangeFilter(range)}
        and event.user_id is not null
    ),
    use as (
      select acceptance.generation_ref,
             bool_or(acceptance.lifecycle in ('copied', 'inserted', 'edited', 'sent')) as used,
             count(*) filter (where acceptance.lifecycle = 'sent') as sent
      from ai_acceptance_events acceptance
      where acceptance.generation_ref in (
        select generation.generation_ref from generation where generation.generation_ref is not null)
      group by acceptance.generation_ref
    )
    select generation.feature,
           count(*) as calls,
           coalesce(sum(generation.cost), 0) as cost,
           count(*) filter (where use.used) as used_calls,
           count(*) filter (where use.sent > 0) as sent_calls,
           coalesce(sum(use.sent), 0) as sent_messages,
           count(*) filter (where use.used is not true) as unused_calls,
           coalesce(sum(generation.cost) filter (where use.used is not true), 0) as unused_cost
    from generation
    left join use on use.generation_ref = generation.generation_ref
    group by generation.feature
  `);
  return rowsOf<Record<string, NumericValue> & { feature: string }>(result).map((row) => ({
    feature: row.feature,
    calls: toNumber(row.calls),
    costMicroUsd: toNumber(row.cost),
    usedCalls: toNumber(row.used_calls),
    sentCalls: toNumber(row.sent_calls),
    sentMessages: toNumber(row.sent_messages),
    unusedCalls: toNumber(row.unused_calls),
    unusedMicroUsd: toNumber(row.unused_cost),
  }));
}

export interface AiSpendCallRow {
  id: number;
  completedAt: Date;
  feature: string;
  model: string;
  reasoningEffort: string | null;
  contextMessages: number | null;
  username: string | null;
  pageLabel: string | null;
  accountLabel: string | null;
  conversationId: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  costApproximate: boolean;
  outcome: string;
  isRegeneration: boolean;
}

export async function listAiSpendTopCalls(db: Database, range: AiSpendRange & { limit: number }): Promise<AiSpendCallRow[]> {
  const result = await db.execute(sql`
    select event.id,
           event.completed_at,
           event.feature::text as feature,
           event.model,
           event.reasoning_effort,
           event.context_messages,
           member.username,
           page.label as page_label,
           account.label as account_label,
           event.conversation_id,
           event.input_tokens,
           event.cache_read_tokens,
           event.cache_write_tokens,
           event.output_tokens,
           event.cost_micro_usd,
           event.cost_approximate,
           event.gateway_outcome,
           event.is_regeneration
    from ai_usage_events event
    left join users member on member.id = event.user_id
    left join pages page on page.id = event.page_id
    left join ai_provider_accounts account on account.id = event.provider_account_id
    where ${rangeFilter(range)}
    order by event.cost_micro_usd desc, event.id desc
    limit ${range.limit}
  `);
  return rowsOf<Record<string, unknown>>(result).map((row) => ({
    id: toNumber(row.id as NumericValue),
    completedAt: new Date(row.completed_at as string | Date),
    feature: row.feature as string,
    model: row.model as string,
    reasoningEffort: (row.reasoning_effort as string | null) ?? null,
    contextMessages: row.context_messages === null ? null : toNumber(row.context_messages as NumericValue),
    username: (row.username as string | null) ?? null,
    pageLabel: (row.page_label as string | null) ?? null,
    accountLabel: (row.account_label as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    inputTokens: toNumber(row.input_tokens as NumericValue),
    cacheReadTokens: toNumber(row.cache_read_tokens as NumericValue),
    cacheWriteTokens: toNumber(row.cache_write_tokens as NumericValue),
    outputTokens: toNumber(row.output_tokens as NumericValue),
    costMicroUsd: toNumber(row.cost_micro_usd as NumericValue),
    costApproximate: row.cost_approximate === true,
    outcome: row.gateway_outcome as string,
    isRegeneration: row.is_regeneration === true,
  }));
}

export interface AiSpendConversationRow {
  pageLabel: string | null;
  conversationId: string;
  calls: number;
  costMicroUsd: number;
  features: string[];
}

/** The chats AI spent most on, and how many chats it spent on at all. */
export async function listAiSpendConversations(db: Database, range: AiSpendRange & { limit: number }) {
  const [top, totals] = await Promise.all([
    db.execute(sql`
      select page.label as page_label,
             event.conversation_id,
             count(*) as calls,
             coalesce(sum(event.cost_micro_usd), 0) as cost,
             array_agg(distinct event.feature::text order by event.feature::text) as features
      from ai_usage_events event
      left join pages page on page.id = event.page_id
      where ${rangeFilter(range)}
        and event.conversation_id is not null
      group by page.label, event.conversation_id
      order by cost desc
      limit ${range.limit}
    `),
    db.execute(sql`
      select count(distinct (event.page_id, event.conversation_id)) as conversations,
             coalesce(sum(event.cost_micro_usd), 0) as cost
      from ai_usage_events event
      where ${rangeFilter(range)}
        and event.conversation_id is not null
    `),
  ]);
  const [total] = rowsOf<{ conversations: NumericValue; cost: NumericValue }>(totals);
  return {
    conversations: toNumber(total?.conversations),
    costMicroUsd: toNumber(total?.cost),
    top: rowsOf<{ page_label: string | null; conversation_id: string; calls: NumericValue; cost: NumericValue; features: string[] }>(top)
      .map((row): AiSpendConversationRow => ({
        pageLabel: row.page_label,
        conversationId: row.conversation_id,
        calls: toNumber(row.calls),
        costMicroUsd: toNumber(row.cost),
        features: row.features ?? [],
      })),
  };
}

/** A chatter's AI spend by minute: what a shift's minutes are summed from. */
export async function listAiSpendByChatterMinute(db: Database, range: Omit<AiSpendRange, "timeZone">) {
  const result = await db.execute(sql`
    select event.user_id,
           date_trunc('minute', event.completed_at) as minute,
           coalesce(sum(event.cost_micro_usd), 0) as cost
    from ai_usage_events event
    where event.completed_at >= ${range.from}
      and event.completed_at < ${range.toExclusive}
      and event.gateway_outcome in ('completed', 'failed', 'cancelled')
      and event.user_id is not null
    group by event.user_id, date_trunc('minute', event.completed_at)
  `);
  return rowsOf<{ user_id: NumericValue; minute: Date | string; cost: NumericValue }>(result).map((row) => ({
    userId: toNumber(row.user_id),
    minute: new Date(row.minute),
    costMicroUsd: toNumber(row.cost),
  }));
}

export interface AiSettingChangeRow {
  changedAt: Date;
  key: string;
  username: string | null;
  oldValue: unknown;
  newValue: unknown;
}

/** Live AI settings the owner changed (config_audit_log), oldest first. */
export async function listAiSettingChanges(db: Database, range: { from: Date; toExclusive: Date }): Promise<AiSettingChangeRow[]> {
  const result = await db.execute(sql`
    select log.changed_at, log.key, member.username, log.old_value, log.new_value
    from config_audit_log log
    left join users member on member.id = log.user_id
    where log.changed_at >= ${range.from}
      and log.changed_at < ${range.toExclusive}
      and (log.key like 'ai%' or log.key like 'chatMuseAi%' or log.key like 'fanFacts%')
    order by log.changed_at, log.id
  `);
  return rowsOf<{ changed_at: Date | string; key: string; username: string | null; old_value: unknown; new_value: unknown }>(result)
    .map((row) => ({
      changedAt: new Date(row.changed_at),
      key: row.key,
      username: row.username,
      oldValue: row.old_value,
      newValue: row.new_value,
    }));
}

/** Ledger spend in a window, optionally of some features only. */
export async function sumAiSpendBetween(
  db: Database,
  input: { from: Date; toExclusive: Date; features?: readonly string[] },
): Promise<number> {
  const result = await db.execute(sql`
    select coalesce(sum(event.cost_micro_usd), 0) as cost
    from ai_usage_events event
    where event.completed_at >= ${input.from}
      and event.completed_at < ${input.toExclusive}
      and event.gateway_outcome in ('completed', 'failed', 'cancelled')
      ${input.features && input.features.length > 0
        ? sql`and event.feature::text in (${sql.join(input.features.map((feature) => sql`${feature}`), sql`, `)})`
        : sql``}
  `);
  const [row] = rowsOf<{ cost: NumericValue }>(result);
  return toNumber(row?.cost);
}
