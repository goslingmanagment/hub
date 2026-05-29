import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { wbClosingCache, workboardContactLog, workboardState } from "../schema.ts";

// Workboard v2 data access. Pure SQL in/out — the scoring engine (apps/runtime)
// maps these rows to FanSignals and back. See docs/workboard-v2-priority-design.md.

const REVENUE_TYPES_SQL = sql`('subscription','tip','message_purchase','post_purchase','stream_tip')`;
const ALA_CARTE_TYPES_SQL = sql`('tip','message_purchase','post_purchase','stream_tip')`;

/**
 * Raw per-fan signal row. The pool parses int8 (OID 20) as bigint, so id/mills
 * columns arrive as bigint; numeric columns as string; int4 as number; ts as Date.
 */
export type WorkboardSignalRow = {
  fan_id: bigint;
  ltv_mills: bigint | null;
  last_transaction_at: Date | null;
  net30: bigint | null;
  net90: bigint | null;
  alacarte90: bigint | null;
  is_subscriber: boolean;
  subscription_expires_at: Date | null;
  auto_renew: boolean | null;
  sub_price_mills: bigint | null;
  follower_since: Date | null;
  external_presence_at: Date | null;
  external_presence_observed_at: Date | null;
  last_purchase_at: Date | null;
  last_purchase_net: bigint | null;
  last_purchase_type: string | null;
  last_message_sender_role: string | null;
  last_fan_message_at: Date | null;
  last_model_message_at: Date | null;
  last_message_preview: string | null;
  stored_message_count: number;
  message_coverage_status: string;
  has_ever_fan_messaged: boolean;
  last_productive_at: Date | null;
  snoozed_until: Date | null;
  refund_recent_at: Date | null;
  flags: string[];
  mass_substate: string | null;
  reactivation_attempted_at: Date | null;
  freeloader_status: string | null;
  model_msgs: number;
  fan_msgs: number;
  unknown_msgs: number;
  initiator_role: string | null;
  avg_gap_hours: number | null;
  prior_q_score: string | null;
  freeloader_episodes: string[] | null;
  lifetime_free_episodes: number;
  l2_needs_reply: boolean | null;
  l2_layer: string | null;
}

export interface LoadSignalParams {
  platformAccountId: number;
  fromDate30: string; // 'YYYY-MM-DD' (UTC business date)
  fromDate90: string;
}

/**
 * One row per fan with a relationship to the page (page_fans is the candidate set).
 * All sub-aggregates are LEFT-joined so a fan with no spend/DM/sub still appears.
 */
export async function loadWorkboardSignalRows(
  db: Database,
  params: LoadSignalParams,
): Promise<WorkboardSignalRow[]> {
  const { platformAccountId, fromDate30, fromDate90 } = params;
  const result = await db.execute<WorkboardSignalRow>(sql`
    with spend_window as (
      select
        fan_id,
        coalesce(sum(case when business_date >= ${fromDate30}::date then creator_net_amount_mills else 0 end), 0)::bigint as net30,
        coalesce(sum(creator_net_amount_mills), 0)::bigint as net90,
        coalesce(sum(case when canonical_type in ${ALA_CARTE_TYPES_SQL} then creator_net_amount_mills else 0 end), 0)::bigint as alacarte90
      from fan_spend_daily
      where platform_account_id = ${platformAccountId}
        and transaction_state = 'posted'::transaction_state
        and canonical_type in ${REVENUE_TYPES_SQL}
        and business_date >= ${fromDate90}::date
      group by fan_id
    ),
    last_purchase as (
      select distinct on (fan_id) fan_id, occurred_at, creator_net_amount_mills, canonical_type::text as canonical_type
      from transactions
      where platform_account_id = ${platformAccountId}
        and is_active = true
        and transaction_state = 'posted'::transaction_state
        and canonical_type in ${REVENUE_TYPES_SQL}
        and creator_net_amount_mills > 0
      order by fan_id, occurred_at desc
    ),
    refund_recent as (
      select distinct on (fan_id) fan_id, occurred_at
      from transactions
      where platform_account_id = ${platformAccountId}
        and canonical_type in ('refund','chargeback')
        and occurred_at >= now() - interval '14 days'
      order by fan_id, occurred_at desc
    ),
    current_sub as (
      select distinct on (fan_id) fan_id, price_mills
      from page_subscriptions
      where platform_account_id = ${platformAccountId} and is_current = true
      order by fan_id, ends_at desc nulls last, id desc
    ),
    primary_thread as (
      select distinct on (fan_id)
        fan_id, id as conversation_id, last_message_id, last_message_sender_role::text as last_message_sender_role,
        last_fan_message_at, last_model_message_at, last_message_preview,
        stored_message_count, message_coverage_status::text as message_coverage_status
      from page_dm_threads
      where platform_account_id = ${platformAccountId} and is_visible = true and fan_id is not null
      order by fan_id, last_message_at desc nulls last, id desc
    ),
    cq as (
      select
        conversation_id,
        count(*) filter (where sender_role = 'model'::dm_sender_role) as model_msgs,
        count(*) filter (where sender_role = 'fan'::dm_sender_role) as fan_msgs,
        count(*) filter (where sender_role = 'unknown'::dm_sender_role) as unknown_msgs,
        (array_agg(sender_role::text order by created_at asc))[1] as initiator_role,
        avg(gap_hours) as avg_gap_hours
      from (
        select
          conversation_id, sender_role, created_at,
          extract(epoch from (created_at - lag(created_at) over (partition by conversation_id order by created_at))) / 3600.0 as gap_hours
        from page_dm_messages
        where platform_account_id = ${platformAccountId}
      ) m
      group by conversation_id
    ),
    flags as (
      select fan_id, array_agg(flag::text) as flags from fan_flags group by fan_id
    ),
    last_touch as (
      select fan_id, max(acted_at) filter (where was_productive) as last_productive_at
      from workboard_contact_log
      where platform_account_id = ${platformAccountId}
      group by fan_id
    )
    select
      pf.fan_id as fan_id,
      coalesce(sl.creator_net_amount_mills, 0)::bigint as ltv_mills,
      sl.last_transaction_at as last_transaction_at,
      coalesce(sw.net30, 0)::bigint as net30,
      coalesce(sw.net90, 0)::bigint as net90,
      coalesce(sw.alacarte90, 0)::bigint as alacarte90,
      pf.is_subscriber as is_subscriber,
      pf.subscription_expires_at as subscription_expires_at,
      pf.auto_renew as auto_renew,
      cs.price_mills as sub_price_mills,
      pf.follower_since as follower_since,
      pf.external_presence_at as external_presence_at,
      pf.external_presence_observed_at as external_presence_observed_at,
      lp.occurred_at as last_purchase_at,
      lp.creator_net_amount_mills as last_purchase_net,
      lp.canonical_type as last_purchase_type,
      pt.last_message_sender_role as last_message_sender_role,
      pt.last_fan_message_at as last_fan_message_at,
      pt.last_model_message_at as last_model_message_at,
      pt.last_message_preview as last_message_preview,
      coalesce(pt.stored_message_count, 0) as stored_message_count,
      coalesce(pt.message_coverage_status, 'pending_backfill') as message_coverage_status,
      (pt.last_fan_message_at is not null) as has_ever_fan_messaged,
      lt.last_productive_at as last_productive_at,
      sn.snoozed_until as snoozed_until,
      rr.occurred_at as refund_recent_at,
      coalesce(fl.flags, '{}') as flags,
      ws.mass_substate::text as mass_substate,
      ws.reactivation_attempted_at as reactivation_attempted_at,
      ws.freeloader_status::text as freeloader_status,
      coalesce(cq.model_msgs, 0)::int as model_msgs,
      coalesce(cq.fan_msgs, 0)::int as fan_msgs,
      coalesce(cq.unknown_msgs, 0)::int as unknown_msgs,
      cq.initiator_role as initiator_role,
      cq.avg_gap_hours as avg_gap_hours,
      ws.q_score as prior_q_score,
      ws.freeloader_episodes as freeloader_episodes,
      coalesce(ws.lifetime_free_episodes, 0)::int as lifetime_free_episodes,
      cc.needs_reply as l2_needs_reply,
      cc.layer as l2_layer
    from page_fans pf
    left join fan_spend_lifetime sl on sl.platform_account_id = pf.platform_account_id and sl.fan_id = pf.fan_id
    left join spend_window sw on sw.fan_id = pf.fan_id
    left join current_sub cs on cs.fan_id = pf.fan_id
    left join primary_thread pt on pt.fan_id = pf.fan_id
    left join cq on cq.conversation_id = pt.conversation_id
    left join wb_closing_cache cc on cc.platform_account_id = pf.platform_account_id and cc.platform_message_id = pt.last_message_id
    left join last_purchase lp on lp.fan_id = pf.fan_id
    left join refund_recent rr on rr.fan_id = pf.fan_id
    left join last_touch lt on lt.fan_id = pf.fan_id
    left join flags fl on fl.fan_id = pf.fan_id
    left join workboard_snoozes sn on sn.platform_account_id = pf.platform_account_id and sn.fan_id = pf.fan_id
    left join workboard_state ws on ws.platform_account_id = pf.platform_account_id and ws.fan_id = pf.fan_id
    where pf.platform_account_id = ${platformAccountId}
  `);
  return result.rows;
}

export type WorkboardStateRecord = typeof workboardState.$inferInsert;

/** Batch upsert computed states (chunk callers to ~500 rows). */
export async function upsertWorkboardStates(
  db: Database,
  records: WorkboardStateRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  await db
    .insert(workboardState)
    .values(records)
    .onConflictDoUpdate({
      target: [workboardState.platformAccountId, workboardState.fanId],
      set: {
        tab: sql`excluded.tab`,
        massSubstate: sql`excluded.mass_substate`,
        valueScore: sql`excluded.value_score`,
        urgencyScore: sql`excluded.urgency_score`,
        rankScore: sql`excluded.rank_score`,
        secondaryStatus: sql`excluded.secondary_status`,
        valueTier: sql`excluded.value_tier`,
        urgencySeverity: sql`excluded.urgency_severity`,
        needsReply: sql`excluded.needs_reply`,
        needsHumanTriage: sql`excluded.needs_human_triage`,
        isPurchaseFollowup: sql`excluded.is_purchase_followup`,
        whyNowCode: sql`excluded.why_now_code`,
        whyNowValue: sql`excluded.why_now_value`,
        reasonChips: sql`excluded.reason_chips`,
        followupDueAt: sql`excluded.followup_due_at`,
        valueConfidence: sql`excluded.value_confidence`,
        qScore: sql`excluded.q_score`,
        qConfidence: sql`excluded.q_confidence`,
        freeloaderStatus: sql`excluded.freeloader_status`,
        freeloaderEpisodes: sql`excluded.freeloader_episodes`,
        lifetimeFreeEpisodes: sql`excluded.lifetime_free_episodes`,
        serviceReason: sql`excluded.service_reason`,
        lastEvalAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}

export type WorkboardV2Row = {
  fan_id: bigint;
  platform_user_id: string | null;
  page_alias: string | null;
  username: string | null;
  display_name: string | null;
  tab: string;
  mass_substate: string | null;
  value_score: string;
  urgency_score: string;
  rank_score: string;
  secondary_status: string;
  value_tier: string;
  urgency_severity: string;
  needs_reply: boolean;
  needs_human_triage: boolean;
  is_purchase_followup: boolean;
  why_now_code: string | null;
  why_now_value: string | null;
  reason_chips: string[];
  followup_due_at: Date | null;
  value_confidence: string;
  q_score: string | null;
  q_confidence: string;
  service_reason: string | null;
  ltv_mills: bigint;
  subscription_expires_at: Date | null;
  auto_renew: boolean | null;
  last_fan_message_at: Date | null;
  last_model_message_at: Date | null;
  last_message_preview: string | null;
  last_message_sender_role: string | null;
  message_coverage_status: string;
  l2_needs_reply: boolean | null;
}

export interface ListWorkboardV2Params {
  platformAccountId: number;
  tab: string;
  statuses?: string[];
  limit: number;
  offset: number;
}

export async function listWorkboardV2(
  db: Database,
  params: ListWorkboardV2Params,
): Promise<{ total: number; rows: WorkboardV2Row[] }> {
  const { platformAccountId, tab, statuses, limit, offset } = params;
  const statusFilter = statuses && statuses.length > 0
    ? sql`and ws.secondary_status = any(${sql.raw(`array[${statuses.map((s) => `'${s.replace(/'/g, "")}'`).join(",")}]`)}::workboard_secondary_status[])`
    : sql``;

  const totalResult = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from workboard_state ws
    where ws.platform_account_id = ${platformAccountId} and ws.tab = ${tab}::workboard_tab ${statusFilter}
  `);

  const result = await db.execute<WorkboardV2Row>(sql`
    select
      ws.fan_id as fan_id,
      f.platform_user_id as platform_user_id,
      pf.page_alias as page_alias,
      f.username as username,
      f.display_name as display_name,
      ws.tab::text as tab,
      ws.mass_substate::text as mass_substate,
      ws.value_score as value_score,
      ws.urgency_score as urgency_score,
      ws.rank_score as rank_score,
      ws.secondary_status::text as secondary_status,
      ws.value_tier as value_tier,
      ws.urgency_severity as urgency_severity,
      ws.needs_reply as needs_reply,
      ws.needs_human_triage as needs_human_triage,
      ws.is_purchase_followup as is_purchase_followup,
      ws.why_now_code as why_now_code,
      ws.why_now_value as why_now_value,
      ws.reason_chips as reason_chips,
      ws.followup_due_at as followup_due_at,
      ws.value_confidence as value_confidence,
      ws.q_score as q_score,
      ws.q_confidence as q_confidence,
      ws.service_reason as service_reason,
      coalesce(sl.creator_net_amount_mills, 0)::bigint as ltv_mills,
      pf.subscription_expires_at as subscription_expires_at,
      pf.auto_renew as auto_renew,
      pt.last_fan_message_at as last_fan_message_at,
      pt.last_model_message_at as last_model_message_at,
      pt.last_message_preview as last_message_preview,
      pt.last_message_sender_role as last_message_sender_role,
      coalesce(pt.message_coverage_status, 'pending_backfill') as message_coverage_status,
      cc.needs_reply as l2_needs_reply
    from workboard_state ws
    join fans f on f.id = ws.fan_id
    left join page_fans pf on pf.platform_account_id = ws.platform_account_id and pf.fan_id = ws.fan_id
    left join fan_spend_lifetime sl on sl.platform_account_id = ws.platform_account_id and sl.fan_id = ws.fan_id
    left join lateral (
      select last_fan_message_at, last_model_message_at, last_message_preview, last_message_id,
        last_message_sender_role::text as last_message_sender_role, message_coverage_status::text as message_coverage_status
      from page_dm_threads
      where platform_account_id = ws.platform_account_id and fan_id = ws.fan_id and is_visible = true
      order by last_message_at desc nulls last, id desc
      limit 1
    ) pt on true
    left join wb_closing_cache cc on cc.platform_account_id = ws.platform_account_id and cc.platform_message_id = pt.last_message_id
    where ws.platform_account_id = ${platformAccountId} and ws.tab = ${tab}::workboard_tab ${statusFilter}
    order by ws.is_purchase_followup desc, ws.rank_score desc, ws.fan_id asc
    limit ${limit} offset ${offset}
  `);

  return { total: totalResult.rows[0]?.total ?? 0, rows: result.rows };
}

/** Per-(tab, secondary_status) counts for the header counters. */
export async function getWorkboardV2Counts(
  db: Database,
  platformAccountId: number,
): Promise<Array<{ tab: string; secondary_status: string; count: number }>> {
  const result = await db.execute<{ tab: string; secondary_status: string; count: number }>(sql`
    select ws.tab::text as tab, ws.secondary_status::text as secondary_status, count(*)::int as count
    from workboard_state ws
    where ws.platform_account_id = ${platformAccountId}
    group by ws.tab, ws.secondary_status
  `);
  return result.rows;
}

export interface AppendContactInput {
  modelId: number;
  platformAccountId: number;
  fanId: number;
  businessDate: string; // 'YYYY-MM-DD'
  action: "opened" | "handled" | "snoozed";
  wasProductive: boolean;
}

export async function appendWorkboardContact(db: Database, input: AppendContactInput): Promise<void> {
  await db.insert(workboardContactLog).values({
    modelId: input.modelId,
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
    businessDate: input.businessDate,
    action: input.action,
    wasProductive: input.wasProductive,
  });
}

/** Count today's productive touches on Old-mass fans (drives the residual cap meter). */
export async function countOldMassContactsToday(
  db: Database,
  platformAccountId: number,
  businessDate: string,
): Promise<number> {
  const result = await db.execute<{ used: number }>(sql`
    select count(*)::int as used
    from workboard_contact_log cl
    join workboard_state ws
      on ws.platform_account_id = cl.platform_account_id and ws.fan_id = cl.fan_id
    where cl.platform_account_id = ${platformAccountId}
      and cl.business_date = ${businessDate}::date
      and cl.was_productive = true
      and ws.tab = 'old_mass'::workboard_tab
  `);
  return result.rows[0]?.used ?? 0;
}

/** Page ids eligible for the v2 recompute job (Fansly first, matching v1 scope). */
export async function listWorkboardRecomputePageIds(db: Database): Promise<number[]> {
  const result = await db.execute<{ id: number }>(sql`
    select id from pages where platform = 'fansly'::platform order by id
  `);
  return result.rows.map((row) => row.id);
}

// ── L2 closing classifier ───────────────────────────────────────────────────

export type ClosingCandidateRow = {
  fan_id: bigint;
  platform_message_id: string;
  content: string;
  tab: string | null;
};

/**
 * Tails to classify: fan wrote last, unanswered > 24h, not a dead/archived/service
 * fan, and not already in the cache (cache miss = new message id). Ordered by tab
 * priority so the budget is spent on the highest-value tabs first. L1 closings are
 * filtered in TS by the caller (cheap, deterministic) before any API call.
 */
export async function listClosingClassificationCandidates(
  db: Database,
  platformAccountId: number,
): Promise<ClosingCandidateRow[]> {
  const result = await db.execute<ClosingCandidateRow>(sql`
    select
      t.fan_id as fan_id,
      t.last_message_id as platform_message_id,
      coalesce(m.content, t.last_message_preview, '') as content,
      ws.tab::text as tab
    from page_dm_threads t
    left join page_dm_messages m on m.conversation_id = t.id and m.platform_message_id = t.last_message_id
    left join workboard_state ws on ws.platform_account_id = t.platform_account_id and ws.fan_id = t.fan_id
    left join wb_closing_cache cc on cc.platform_account_id = t.platform_account_id and cc.platform_message_id = t.last_message_id
    where t.platform_account_id = ${platformAccountId}
      and t.is_visible = true
      and t.fan_id is not null
      and t.last_message_id is not null
      and t.last_message_sender_role = 'fan'::dm_sender_role
      and t.last_fan_message_at < now() - interval '24 hours'
      and cc.id is null
      and (ws.tab is null or ws.tab <> 'service'::workboard_tab)
      and (ws.mass_substate is null or ws.mass_substate not in ('dead'::workboard_mass_substate, 'archived'::workboard_mass_substate))
    order by
      case ws.tab
        when 'subscribers'::workboard_tab then 1
        when 'spenders'::workboard_tab then 2
        when 'fresh_mass'::workboard_tab then 3
        when 'old_mass'::workboard_tab then 4
        else 5
      end,
      t.last_fan_message_at asc
  `);
  return result.rows;
}

/** Cached L2 verdict totals for a page — total classified + how many were closings. */
export async function countClosingCache(
  db: Database,
  platformAccountId: number,
): Promise<{ total: number; closings: number }> {
  const result = await db.execute<{ total: number; closings: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where needs_reply = false)::int as closings
    from wb_closing_cache where platform_account_id = ${platformAccountId}
  `);
  return { total: result.rows[0]?.total ?? 0, closings: result.rows[0]?.closings ?? 0 };
}

/** Total > 24h unanswered fan-last tails on a page (drives the adaptive cap). */
export async function countUnansweredTails(db: Database, platformAccountId: number): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from page_dm_threads t
    where t.platform_account_id = ${platformAccountId}
      and t.is_visible = true
      and t.fan_id is not null
      and t.last_message_sender_role = 'fan'::dm_sender_role
      and t.last_fan_message_at < now() - interval '24 hours'
  `);
  return result.rows[0]?.n ?? 0;
}

export async function getLlmUsageDaily(
  db: Database,
  platformAccountId: number,
  businessDate: string,
  feature: string,
): Promise<{ calls: number; inputTokens: number; outputTokens: number }> {
  const result = await db.execute<{ calls: number; input_tokens: number; output_tokens: number }>(sql`
    select calls, input_tokens, output_tokens
    from wb_llm_usage_daily
    where platform_account_id = ${platformAccountId} and business_date = ${businessDate}::date and feature = ${feature}
  `);
  const row = result.rows[0];
  return {
    calls: row?.calls ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
  };
}

export async function incrementLlmUsageDaily(
  db: Database,
  input: { platformAccountId: number; businessDate: string; feature: string; calls: number; inputTokens: number; outputTokens: number },
): Promise<void> {
  await db.execute(sql`
    insert into wb_llm_usage_daily (platform_account_id, business_date, feature, calls, input_tokens, output_tokens, updated_at)
    values (${input.platformAccountId}, ${input.businessDate}::date, ${input.feature}, ${input.calls}, ${input.inputTokens}, ${input.outputTokens}, now())
    on conflict (platform_account_id, business_date, feature) do update set
      calls = wb_llm_usage_daily.calls + excluded.calls,
      input_tokens = wb_llm_usage_daily.input_tokens + excluded.input_tokens,
      output_tokens = wb_llm_usage_daily.output_tokens + excluded.output_tokens,
      updated_at = now()
  `);
}

export interface ClosingCacheUpsert {
  platformAccountId: number;
  platformMessageId: string;
  contentHash: string;
  needsReply: boolean;
  layer: "l2" | "over_cap";
  model: string | null;
}

export async function upsertClosingCache(db: Database, rows: ClosingCacheUpsert[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db
    .insert(wbClosingCache)
    .values(
      rows.map((r) => ({
        platformAccountId: r.platformAccountId,
        platformMessageId: r.platformMessageId,
        contentHash: r.contentHash,
        needsReply: r.needsReply,
        layer: r.layer,
        model: r.model,
      })),
    )
    .onConflictDoUpdate({
      target: [wbClosingCache.platformAccountId, wbClosingCache.platformMessageId],
      set: {
        contentHash: sql`excluded.content_hash`,
        needsReply: sql`excluded.needs_reply`,
        layer: sql`excluded.layer`,
        model: sql`excluded.model`,
        classifiedAt: sql`now()`,
      },
    });
}
