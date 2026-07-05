import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { wbClassifierRuns, wbClosingCache, wbClosingSettings, workboardContactLog, workboardState } from "../schema.ts";

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
  latest_meaningful_message_at: Date | null;
  prior_q_score: string | null;
  freeloader_episodes: string[] | null;
  lifetime_free_episodes: number;
  l2_needs_reply: boolean | null;
  l2_layer: string | null;
  l2_state: string | null;
}

export interface LoadSignalParams {
  platformAccountId: number;
  fromDate30: string; // 'YYYY-MM-DD' (UTC business date)
  fromDate90: string;
  fanId?: number; // when set, scope every aggregate to one fan (fast single-fan recompute)
}

/**
 * One row per active fan with a relationship to the page (page_fans is the candidate set).
 * All sub-aggregates are LEFT-joined so a fan with no spend/DM/sub still appears.
 */
export async function loadWorkboardSignalRows(
  db: Database,
  params: LoadSignalParams,
): Promise<WorkboardSignalRow[]> {
  const { platformAccountId, fromDate30, fromDate90, fanId } = params;
  const fanScope = fanId != null ? sql`and fan_id = ${fanId}` : sql``;
  const pfFanScope = fanId != null ? sql`and pf.fan_id = ${fanId}` : sql``;
  const flagsScope = fanId != null ? sql`where fan_id = ${fanId}` : sql``;
  const cqFanScope = fanId != null
    ? sql`and conversation_id in (select id from page_dm_threads where platform_account_id = ${platformAccountId} and fan_id = ${fanId})`
    : sql``;
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
        ${fanScope}
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
        ${fanScope}
      order by fan_id, occurred_at desc
    ),
    refund_recent as (
      select distinct on (fan_id) fan_id, occurred_at
      from transactions
      where platform_account_id = ${platformAccountId}
        and canonical_type in ('refund','chargeback')
        and occurred_at >= now() - interval '14 days'
        ${fanScope}
      order by fan_id, occurred_at desc
    ),
    current_sub as (
      select distinct on (fan_id) fan_id, price_mills
      from page_subscriptions
      where platform_account_id = ${platformAccountId} and is_current = true
        ${fanScope}
      order by fan_id, ends_at desc nulls last, id desc
    ),
    primary_thread as (
      select distinct on (fan_id)
        fan_id, id as conversation_id, last_message_id, last_message_sender_role::text as last_message_sender_role,
        last_fan_message_at, last_model_message_at, last_message_preview,
        stored_message_count, message_coverage_status::text as message_coverage_status
      from page_dm_threads
      where platform_account_id = ${platformAccountId} and is_visible = true and fan_id is not null
        ${fanScope}
      order by fan_id, last_message_at desc nulls last, id desc
    ),
    cq as (
      select
        conversation_id,
        count(*) filter (where sender_role = 'model'::dm_sender_role) as model_msgs,
        count(*) filter (where sender_role = 'fan'::dm_sender_role) as fan_msgs,
        count(*) filter (where sender_role = 'unknown'::dm_sender_role) as unknown_msgs,
        (array_agg(sender_role::text order by created_at asc))[1] as initiator_role,
        max(created_at) filter (where sender_role in ('fan'::dm_sender_role, 'model'::dm_sender_role)) as latest_meaningful_message_at,
        avg(gap_hours) as avg_gap_hours
      from (
        select
          conversation_id, sender_role, created_at,
          extract(epoch from (created_at - lag(created_at) over (partition by conversation_id order by created_at))) / 3600.0 as gap_hours
        from page_dm_messages
        where platform_account_id = ${platformAccountId}
          and deleted_at is null
          ${cqFanScope}
      ) m
      group by conversation_id
    ),
    flags as (
      select fan_id, array_agg(flag::text) as flags from fan_flags ${flagsScope} group by fan_id
    ),
    last_touch as (
      select fan_id, max(acted_at) filter (where was_productive) as last_productive_at
      from workboard_contact_log
      where platform_account_id = ${platformAccountId}
        and retracted_at is null
        ${fanScope}
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
      cq.latest_meaningful_message_at as latest_meaningful_message_at,
      ws.q_score as prior_q_score,
      ws.freeloader_episodes as freeloader_episodes,
      coalesce(ws.lifetime_free_episodes, 0)::int as lifetime_free_episodes,
      cc.needs_reply as l2_needs_reply,
      cc.layer as l2_layer,
      cc.state as l2_state
    from page_fans pf
    join fans f on f.id = pf.fan_id and f.deleted_detected_at is null
    left join fan_spend_lifetime sl on sl.platform_account_id = pf.platform_account_id and sl.fan_id = pf.fan_id
    left join spend_window sw on sw.fan_id = pf.fan_id
    left join current_sub cs on cs.fan_id = pf.fan_id
    left join primary_thread pt on pt.fan_id = pf.fan_id
    left join cq on cq.conversation_id = pt.conversation_id
    left join wb_closing_cache cc on cc.platform_account_id = pf.platform_account_id and cc.platform_message_id = pt.last_message_id and cc.superseded_at is null
    left join last_purchase lp on lp.fan_id = pf.fan_id
    left join refund_recent rr on rr.fan_id = pf.fan_id
    left join last_touch lt on lt.fan_id = pf.fan_id
    left join flags fl on fl.fan_id = pf.fan_id
    left join workboard_snoozes sn on sn.platform_account_id = pf.platform_account_id and sn.fan_id = pf.fan_id
    left join workboard_state ws on ws.platform_account_id = pf.platform_account_id and ws.fan_id = pf.fan_id
    where pf.platform_account_id = ${platformAccountId}
      ${pfFanScope}
  `);
  return result.rows;
}

export type WorkboardStateRecord = typeof workboardState.$inferInsert;

/** Remove derived rows that should no longer appear on the board. */
export async function deleteIneligibleWorkboardStates(
  db: Database,
  input: { platformAccountId: number; fanId?: number },
): Promise<number> {
  const fanFilter = input.fanId != null ? sql`and ws.fan_id = ${input.fanId}` : sql``;
  const result = await db.execute<{ fan_id: bigint }>(sql`
    delete from workboard_state ws
    where ws.platform_account_id = ${input.platformAccountId}
      ${fanFilter}
      and not exists (
        select 1
        from page_fans pf
        join fans f on f.id = pf.fan_id
        where pf.platform_account_id = ws.platform_account_id
          and pf.fan_id = ws.fan_id
          and f.deleted_detected_at is null
      )
    returning ws.fan_id
  `);
  return result.rows.length;
}

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
  external_presence_at: Date | null;
  last_fan_message_at: Date | null;
  last_model_message_at: Date | null;
  last_message_preview: string | null;
  last_message_sender_role: string | null;
  message_coverage_status: string;
  platform_conversation_id: string | null;
  l2_needs_reply: boolean | null;
  l2_state: string | null;
  l2_reason: string | null;
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
    ? sql`and ws.secondary_status = any(array[${sql.join(statuses.map((s) => sql`${s}`), sql`, `)}]::workboard_secondary_status[])`
    : sql``;

  const totalResult = await db.execute<{ total: number }>(sql`
    select count(*)::int as total
    from workboard_state ws
    join fans f on f.id = ws.fan_id and f.deleted_detected_at is null
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
      pf.external_presence_at as external_presence_at,
      pt.last_fan_message_at as last_fan_message_at,
      pt.last_model_message_at as last_model_message_at,
      pt.last_message_preview as last_message_preview,
      pt.last_message_sender_role as last_message_sender_role,
      coalesce(pt.message_coverage_status, 'pending_backfill') as message_coverage_status,
      pt.platform_conversation_id as platform_conversation_id,
      cc.needs_reply as l2_needs_reply,
      cc.state as l2_state,
      cc.reason as l2_reason
    from workboard_state ws
    join fans f on f.id = ws.fan_id and f.deleted_detected_at is null
    left join page_fans pf on pf.platform_account_id = ws.platform_account_id and pf.fan_id = ws.fan_id
    left join fan_spend_lifetime sl on sl.platform_account_id = ws.platform_account_id and sl.fan_id = ws.fan_id
    left join lateral (
      select platform_conversation_id, last_fan_message_at, last_model_message_at, last_message_preview, last_message_id,
        last_message_sender_role::text as last_message_sender_role, message_coverage_status::text as message_coverage_status
      from page_dm_threads
      where platform_account_id = ws.platform_account_id and fan_id = ws.fan_id and is_visible = true
      order by last_message_at desc nulls last, id desc
      limit 1
    ) pt on true
    left join wb_closing_cache cc on cc.platform_account_id = ws.platform_account_id and cc.platform_message_id = pt.last_message_id and cc.superseded_at is null
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
    join fans f on f.id = ws.fan_id and f.deleted_detected_at is null
    where ws.platform_account_id = ${platformAccountId}
    group by ws.tab, ws.secondary_status
  `);
  return result.rows;
}

// ── Workboard v2 spender lists (lifetime gross-spend bands) ───────────────────

/** A lifetime gross-spend band; mills, [minAmountMills, maxAmountMillsExclusive). */
export interface WorkboardSpenderBandInput {
  key: string;
  minAmountMills: bigint;
  maxAmountMillsExclusive: bigint | null;
}

export type WorkboardSpenderBandRow = WorkboardV2Row & { gross_mills: bigint; band: string };

export interface ListWorkboardSpenderBandsParams {
  platformAccountId: number;
  buckets: readonly WorkboardSpenderBandInput[];
  /** Max member rows returned per band (counts stay exact). */
  itemCap: number;
}

/**
 * The page's spender roster (every evaluated fan whose lifetime GROSS spend clears
 * the lowest band) bucketed into the gross-spend bands. Returns exact per-band
 * counts plus up to `itemCap` member rows per band (highest spenders first). The
 * member rows carry the same columns as `listWorkboardV2`, so the service maps them
 * with the shared `mapItem`. Drives the Workboard v2 "lists" mode; mirrors the
 * Fansly "[FB] $X-$Y Spenders" lists (which segment by gross, not creator-net).
 */
export async function listWorkboardSpenderBands(
  db: Database,
  params: ListWorkboardSpenderBandsParams,
): Promise<{ counts: Array<{ band: string; count: number }>; rows: WorkboardSpenderBandRow[] }> {
  const { platformAccountId, buckets, itemCap } = params;
  const minFloor = buckets.reduce((min, b) => (b.minAmountMills < min ? b.minAmountMills : min), buckets[0]!.minAmountMills);
  const grossSql = sql`coalesce(sl.gross_amount_mills, 0)`;
  const bandCase = sql`case ${sql.join(
    buckets.map((b) =>
      b.maxAmountMillsExclusive === null
        ? sql`when ${grossSql} >= ${b.minAmountMills} then ${b.key}`
        : sql`when ${grossSql} >= ${b.minAmountMills} and ${grossSql} < ${b.maxAmountMillsExclusive} then ${b.key}`,
    ),
    sql` `,
  )} end`;

  const countsResult = await db.execute<{ band: string; count: number }>(sql`
    select ${bandCase} as band, count(*)::int as count
    from workboard_state ws
    join fans f on f.id = ws.fan_id and f.deleted_detected_at is null
    left join fan_spend_lifetime sl on sl.platform_account_id = ws.platform_account_id and sl.fan_id = ws.fan_id
    where ws.platform_account_id = ${platformAccountId} and ${grossSql} >= ${minFloor}
    group by band
  `);

  const rowsResult = await db.execute<WorkboardSpenderBandRow>(sql`
    select * from (
      select inner_q.*, row_number() over (partition by inner_q.band order by inner_q.gross_mills desc, inner_q.fan_id asc) as rn
      from (
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
          coalesce(sl.gross_amount_mills, 0)::bigint as gross_mills,
          ${bandCase} as band,
          pf.subscription_expires_at as subscription_expires_at,
          pf.auto_renew as auto_renew,
          pf.external_presence_at as external_presence_at,
          pt.last_fan_message_at as last_fan_message_at,
          pt.last_model_message_at as last_model_message_at,
          pt.last_message_preview as last_message_preview,
          pt.last_message_sender_role as last_message_sender_role,
          coalesce(pt.message_coverage_status, 'pending_backfill') as message_coverage_status,
          pt.platform_conversation_id as platform_conversation_id,
          cc.needs_reply as l2_needs_reply,
          cc.state as l2_state,
          cc.reason as l2_reason
        from workboard_state ws
        join fans f on f.id = ws.fan_id and f.deleted_detected_at is null
        left join page_fans pf on pf.platform_account_id = ws.platform_account_id and pf.fan_id = ws.fan_id
        left join fan_spend_lifetime sl on sl.platform_account_id = ws.platform_account_id and sl.fan_id = ws.fan_id
        left join lateral (
          select platform_conversation_id, last_fan_message_at, last_model_message_at, last_message_preview, last_message_id,
            last_message_sender_role::text as last_message_sender_role, message_coverage_status::text as message_coverage_status
          from page_dm_threads
          where platform_account_id = ws.platform_account_id and fan_id = ws.fan_id and is_visible = true
          order by last_message_at desc nulls last, id desc
          limit 1
        ) pt on true
        left join wb_closing_cache cc on cc.platform_account_id = ws.platform_account_id and cc.platform_message_id = pt.last_message_id and cc.superseded_at is null
        where ws.platform_account_id = ${platformAccountId} and ${grossSql} >= ${minFloor}
      ) inner_q
    ) z
    where z.rn <= ${itemCap}
    order by z.gross_mills desc, z.fan_id asc
  `);

  return { counts: countsResult.rows, rows: rowsResult.rows };
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

/** Mark the one-shot reactivation attempt once a dead old-mass fan is productively touched. */
export async function markReactivationAttemptedIfDead(
  db: Database,
  input: { platformAccountId: number; fanId: number },
): Promise<boolean> {
  const result = await db.execute<{ fan_id: bigint }>(sql`
    update workboard_state
    set reactivation_attempted_at = now(), updated_at = now()
    where platform_account_id = ${input.platformAccountId}
      and fan_id = ${input.fanId}
      and tab = 'old_mass'::workboard_tab
      and mass_substate = 'dead'::workboard_mass_substate
      and reactivation_attempted_at is null
    returning fan_id
  `);
  return result.rows.length > 0;
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
      and cl.retracted_at is null
      and ws.tab = 'old_mass'::workboard_tab
  `);
  return result.rows[0]?.used ?? 0;
}

/** Snooze a fan for an arbitrary number of days (v2; shares the workboard_snoozes table). */
export async function snoozeWorkboardFanV2(
  db: Database,
  input: { platformAccountId: number; fanId: number; days: number },
): Promise<{ snoozedUntil: Date } | null> {
  const result = await db.execute<{ snoozed_until: Date }>(sql`
    insert into workboard_snoozes (platform_account_id, fan_id, snoozed_until)
    values (${input.platformAccountId}, ${input.fanId}, now() + (${input.days} || ' days')::interval)
    on conflict (platform_account_id, fan_id)
    do update set snoozed_until = excluded.snoozed_until, created_at = now()
    returning snoozed_until
  `);
  const row = result.rows[0];
  return row ? { snoozedUntil: new Date(row.snoozed_until) } : null;
}

/**
 * Retract the most recent touch-log entry for a fan (undo of Готово).
 * Stage 2 destruction-door guard: the row is marked retracted, not deleted —
 * the interim form of Stage 23's contact.retracted compensating event.
 * Readers exclude retracted rows.
 */
export async function retractLastWorkboardContact(
  db: Database,
  platformAccountId: number,
  fanId: number,
): Promise<void> {
  await db.execute(sql`
    update workboard_contact_log
    set retracted_at = now()
    where id = (
      select id from workboard_contact_log
      where platform_account_id = ${platformAccountId} and fan_id = ${fanId}
        and retracted_at is null
      order by acted_at desc
      limit 1
    )
  `);
}

/**
 * Page ids eligible for the v2 recompute job: all Fansly pages plus OnlyFans
 * pages with an OFAPI account mapping (their DMs are fed by the webhook
 * projection, decision #49). Unmapped OnlyFans pages have no DM data to score.
 */
export async function listWorkboardRecomputePageIds(db: Database): Promise<number[]> {
  const result = await db.execute<{ id: number }>(sql`
    select id::int as id
    from pages
    where status = 'active'
      and (platform = 'fansly'::platform
       or (platform = 'onlyfans'::platform and ofapi_account_id is not null))
    order by id
  `);
  return result.rows.map((row) => row.id);
}

// ── L2 closing classifier ───────────────────────────────────────────────────

export type ClosingContextMsg = { role: string | null; text: string | null };
export type ClosingCandidateRow = {
  fan_id: bigint;
  platform_message_id: string;
  content: string;
  tab: string | null;
  /** Recent conversation window (oldest→newest, last entry is the fan tail). */
  context: ClosingContextMsg[] | null;
};

const CLOSING_CONTEXT_WINDOW = 12;

/**
 * Tails to classify: fan wrote last, unanswered > 24h, not a dead/archived/service
 * fan, and not already in the cache (cache miss = new message id). Ordered by tab
 * priority so the budget is spent on the highest-value tabs first. L1 closings are
 * filtered in TS by the caller (cheap, deterministic) before any API call. Each row
 * carries the last few messages (with roles) so the classifier reads the tail in
 * conversation context, not in isolation.
 *
 * Spenders are the exception to the 24h gate: every fan-last spender tail is
 * eligible so the spender diagnostics can cover the whole spender tab. Model-last
 * / no-dialog spenders are diagnosed deterministically outside the LLM path.
 */
export async function listClosingClassificationCandidates(
  db: Database,
  platformAccountId: number,
  opts: { includeContext?: boolean } = {},
): Promise<ClosingCandidateRow[]> {
  // The context lateral (per-thread json_agg over 12 messages) is only needed by the
  // classify path. Callers that just need the tail content (e.g. counting "pending")
  // pass includeContext:false to skip it entirely.
  const includeContext = opts.includeContext ?? true;
  const ctxSelect = includeContext ? sql`ctx.ctx` : sql`null::json`;
  const ctxJoin = includeContext
    ? sql`
      left join lateral (
        select json_agg(json_build_object('role', x.sender_role, 'text', x.content) order by x.created_at asc, x.id asc) as ctx
        from (
          select id, sender_role::text as sender_role, content, created_at
          from page_dm_messages
          where conversation_id = t.id
            and deleted_at is null
          order by created_at desc, id desc
          limit ${CLOSING_CONTEXT_WINDOW}
        ) x
      ) ctx on true`
    : sql``;
  const result = await db.execute<ClosingCandidateRow>(sql`
    select
      t.fan_id as fan_id,
      t.last_message_id as platform_message_id,
      coalesce(m.content, t.last_message_preview, '') as content,
      ws.tab::text as tab,
      ${ctxSelect} as context
    from page_dm_threads t
    join fans f on f.id = t.fan_id and f.deleted_detected_at is null
    left join page_dm_messages m on m.conversation_id = t.id and m.platform_message_id = t.last_message_id and m.deleted_at is null
    left join workboard_state ws on ws.platform_account_id = t.platform_account_id and ws.fan_id = t.fan_id
    left join wb_closing_cache cc on cc.platform_account_id = t.platform_account_id and cc.platform_message_id = t.last_message_id and cc.superseded_at is null
    ${ctxJoin}
    where t.platform_account_id = ${platformAccountId}
      and t.is_visible = true
      and t.fan_id is not null
      and t.last_message_id is not null
      and t.last_message_sender_role = 'fan'::dm_sender_role
      and (
        ws.tab = 'spenders'::workboard_tab
        or t.last_fan_message_at < now() - interval '24 hours'
      )
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

export type SpenderDiagnosisRow = {
  fan_id: bigint;
  platform_message_id: string | null;
  last_message_sender_role: string | null;
  last_fan_message_at: Date | null;
  last_message_preview: string | null;
  l2_needs_reply: boolean | null;
  l2_state: string | null;
};

/** One row per active Workboard-v2 spender, with the latest visible DM diagnosis inputs. */
export async function listSpenderDiagnosisRows(
  db: Database,
  platformAccountId: number,
): Promise<SpenderDiagnosisRow[]> {
  const result = await db.execute<SpenderDiagnosisRow>(sql`
    select
      ws.fan_id as fan_id,
      pt.last_message_id as platform_message_id,
      pt.last_message_sender_role as last_message_sender_role,
      pt.last_fan_message_at as last_fan_message_at,
      pt.last_message_preview as last_message_preview,
      cc.needs_reply as l2_needs_reply,
      cc.state as l2_state
    from workboard_state ws
    join fans f on f.id = ws.fan_id and f.deleted_detected_at is null
    left join lateral (
      select
        last_message_id,
        last_message_sender_role::text as last_message_sender_role,
        last_fan_message_at,
        last_message_preview
      from page_dm_threads
      where platform_account_id = ws.platform_account_id
        and fan_id = ws.fan_id
        and is_visible = true
      order by last_message_at desc nulls last, id desc
      limit 1
    ) pt on true
    left join wb_closing_cache cc
      on cc.platform_account_id = ws.platform_account_id
      and cc.platform_message_id = pt.last_message_id
      and cc.superseded_at is null
    where ws.platform_account_id = ${platformAccountId}
      and ws.tab = 'spenders'::workboard_tab
    order by ws.rank_score desc, ws.fan_id asc
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
    from wb_closing_cache c
    join page_dm_threads t
      on t.platform_account_id = c.platform_account_id and t.last_message_id = c.platform_message_id
    join fans f on f.id = t.fan_id and f.deleted_detected_at is null
    where c.platform_account_id = ${platformAccountId}
      and c.superseded_at is null
  `);
  return { total: result.rows[0]?.total ?? 0, closings: result.rows[0]?.closings ?? 0 };
}

/** Total > 24h unanswered fan-last tails on a page (drives the adaptive cap). */
export async function countUnansweredTails(db: Database, platformAccountId: number): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from page_dm_threads t
    join fans f on f.id = t.fan_id and f.deleted_detected_at is null
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

export async function reserveLlmUsageDailyCall(
  db: Database,
  input: { platformAccountId: number; businessDate: string; feature: string; cap: number },
): Promise<boolean> {
  if (input.cap <= 0) {
    return false;
  }
  const result = await db.execute<{ calls: number }>(sql`
    insert into wb_llm_usage_daily (platform_account_id, business_date, feature, calls, input_tokens, output_tokens, updated_at)
    values (${input.platformAccountId}, ${input.businessDate}::date, ${input.feature}, 1, 0, 0, now())
    on conflict (platform_account_id, business_date, feature) do update set
      calls = wb_llm_usage_daily.calls + 1,
      updated_at = now()
    where wb_llm_usage_daily.calls < ${input.cap}
    returning calls
  `);
  return result.rows.length > 0;
}

export async function addLlmUsageDailyTokens(
  db: Database,
  input: { platformAccountId: number; businessDate: string; feature: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await db.execute(sql`
    insert into wb_llm_usage_daily (platform_account_id, business_date, feature, calls, input_tokens, output_tokens, updated_at)
    values (${input.platformAccountId}, ${input.businessDate}::date, ${input.feature}, 0, ${input.inputTokens}, ${input.outputTokens}, now())
    on conflict (platform_account_id, business_date, feature) do update set
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
  state: string | null;
  reason: string | null;
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
        state: r.state,
        reason: r.reason,
      })),
    )
    .onConflictDoUpdate({
      // Matches the partial unique on ACTIVE rows (superseded_at is null):
      // a fresh run inserts new rows alongside retained superseded verdicts.
      target: [wbClosingCache.platformAccountId, wbClosingCache.platformMessageId],
      targetWhere: sql`superseded_at is null`,
      set: {
        contentHash: sql`excluded.content_hash`,
        needsReply: sql`excluded.needs_reply`,
        layer: sql`excluded.layer`,
        model: sql`excluded.model`,
        state: sql`excluded.state`,
        reason: sql`excluded.reason`,
        classifiedAt: sql`now()`,
      },
    });
}

/**
 * Supersede every active cached verdict for a page (forces a fresh
 * re-classification run). Stage 2 destruction-door guard: prior verdicts are
 * retained as an append log — the partial unique on active rows lets the next
 * run insert fresh verdicts for the same messages.
 */
export async function supersedeClosingCacheForPage(db: Database, platformAccountId: number): Promise<number> {
  const result = await db.execute<{ id: bigint }>(sql`
    update wb_closing_cache
    set superseded_at = now()
    where platform_account_id = ${platformAccountId}
      and superseded_at is null
    returning id
  `);
  return result.rows.length;
}

// ── L2 classifier per-page settings (null = inherit env) ──────────────────────

export type ClosingSettingsRow = {
  platform_account_id: number;
  enabled: boolean | null;
  daily_cap_max: number | null;
  model: string | null;
};

export async function getClosingSettings(
  db: Database,
  platformAccountId: number,
): Promise<ClosingSettingsRow | null> {
  const result = await db.execute<ClosingSettingsRow>(sql`
    select platform_account_id::int as platform_account_id, enabled, daily_cap_max, model
    from wb_closing_settings where platform_account_id = ${platformAccountId}
  `);
  return result.rows[0] ?? null;
}

/** All per-page overrides (the all-pages classify job resolves these against env). */
export async function listClosingSettings(db: Database): Promise<ClosingSettingsRow[]> {
  const result = await db.execute<ClosingSettingsRow>(sql`
    select platform_account_id::int as platform_account_id, enabled, daily_cap_max, model
    from wb_closing_settings
  `);
  return result.rows;
}

export async function upsertClosingSettings(
  db: Database,
  input: { platformAccountId: number; enabled: boolean | null; dailyCapMax: number | null; model: string | null },
): Promise<void> {
  await db
    .insert(wbClosingSettings)
    .values({
      platformAccountId: input.platformAccountId,
      enabled: input.enabled,
      dailyCapMax: input.dailyCapMax,
      model: input.model,
    })
    .onConflictDoUpdate({
      target: [wbClosingSettings.platformAccountId],
      set: {
        enabled: sql`excluded.enabled`,
        dailyCapMax: sql`excluded.daily_cap_max`,
        model: sql`excluded.model`,
        updatedAt: sql`now()`,
      },
    });
}

// ── L2 analytics (for the AI panel) ───────────────────────────────────────────

/** Verdict counts grouped by semantic state (null state shown as '(unset)'). */
export async function getClosingStateDistribution(
  db: Database,
  platformAccountId: number,
): Promise<Array<{ state: string; count: number }>> {
  const result = await db.execute<{ state: string; count: number }>(sql`
    select coalesce(state, '(unset)') as state, count(*)::int as count
    from wb_closing_cache c
    join page_dm_threads t
      on t.platform_account_id = c.platform_account_id and t.last_message_id = c.platform_message_id
    join fans f on f.id = t.fan_id and f.deleted_detected_at is null
    where c.platform_account_id = ${platformAccountId}
      and c.superseded_at is null
    group by state order by count desc
  `);
  return result.rows;
}

export type RecentClosingVerdictRow = {
  platform_message_id: string;
  tail: string;
  state: string | null;
  needs_reply: boolean;
  reason: string | null;
  model: string | null;
  classified_at: Date;
};

export async function listRecentClosingVerdicts(
  db: Database,
  platformAccountId: number,
  limit: number,
): Promise<RecentClosingVerdictRow[]> {
  const result = await db.execute<RecentClosingVerdictRow>(sql`
    select
      c.platform_message_id as platform_message_id,
      left(coalesce(t.last_message_preview, ''), 140) as tail,
      c.state as state,
      c.needs_reply as needs_reply,
      c.reason as reason,
      c.model as model,
      c.classified_at as classified_at
    from wb_closing_cache c
    join page_dm_threads t
      on t.platform_account_id = c.platform_account_id and t.last_message_id = c.platform_message_id
    join fans f on f.id = t.fan_id and f.deleted_detected_at is null
    where c.platform_account_id = ${platformAccountId}
      and c.superseded_at is null
    order by c.classified_at desc
    limit ${limit}
  `);
  return result.rows;
}

// ── L2 classifier run log (the dashboard's activity logger) ───────────────────

export interface ClassifierRunInsert {
  platformAccountId: number;
  trigger: "cron" | "manual" | "reclassify";
  model: string | null;
  classified: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  deferred: number;
  cleared: number;
  status?: string;
  error?: string | null;
}

export async function insertClassifierRun(db: Database, input: ClassifierRunInsert): Promise<void> {
  await db.insert(wbClassifierRuns).values({
    platformAccountId: input.platformAccountId,
    trigger: input.trigger,
    model: input.model,
    classified: input.classified,
    calls: input.calls,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    deferred: input.deferred,
    cleared: input.cleared,
    status: input.status ?? "ok",
    error: input.error ?? null,
  });
}

/** Insert a run row in the 'running' state (for async manual runs); returns its id. */
export async function insertClassifierRunRunning(
  db: Database,
  input: { platformAccountId: number; trigger: "manual" | "reclassify"; model: string | null },
): Promise<number> {
  const [row] = await db
    .insert(wbClassifierRuns)
    .values({ platformAccountId: input.platformAccountId, trigger: input.trigger, model: input.model, status: "running" })
    .returning({ id: wbClassifierRuns.id });
  return row!.id;
}

const CLASSIFIER_RUN_LOCK_NAMESPACE = 9_002_001;

/**
 * Atomically starts a manual classifier run for a page. The advisory transaction
 * lock closes the SELECT→INSERT race across API processes.
 */
export async function insertClassifierRunRunningIfIdle(
  db: Database,
  input: { platformAccountId: number; trigger: "manual" | "reclassify"; model: string | null },
): Promise<{ id: number; alreadyRunning: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLASSIFIER_RUN_LOCK_NAMESPACE}, ${input.platformAccountId})`);
    const active = await tx.execute<{ id: number }>(sql`
      select id::int as id from wb_classifier_runs
      where platform_account_id = ${input.platformAccountId}
        and status = 'running'
        and created_at > now() - interval '15 minutes'
      order by id desc limit 1
    `);
    const activeRow = active.rows[0];
    if (activeRow) {
      return { id: activeRow.id, alreadyRunning: true };
    }
    const [row] = await tx
      .insert(wbClassifierRuns)
      .values({ platformAccountId: input.platformAccountId, trigger: input.trigger, model: input.model, status: "running" })
      .returning({ id: wbClassifierRuns.id });
    return { id: row!.id, alreadyRunning: false };
  });
}

/** Finalize a 'running' run row with its terminal counts/status. */
export async function finishClassifierRun(
  db: Database,
  id: number,
  input: {
    status: "ok" | "error";
    classified?: number;
    calls?: number;
    inputTokens?: number;
    outputTokens?: number;
    deferred?: number;
    cleared?: number;
    error?: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    update wb_classifier_runs set
      status = ${input.status},
      classified = ${input.classified ?? 0},
      calls = ${input.calls ?? 0},
      input_tokens = ${input.inputTokens ?? 0},
      output_tokens = ${input.outputTokens ?? 0},
      deferred = ${input.deferred ?? 0},
      cleared = ${input.cleared ?? 0},
      error = ${input.error ?? null}
    where id = ${id}
  `);
}

/**
 * Reconcile orphaned runs: a manual run executes detached in the API process, so a
 * process restart can leave a row stuck in 'running'. Mark long-stuck rows as errored
 * so the dashboard never shows a perpetual "выполняется…". Called on run-log reads.
 */
export async function failStaleClassifierRuns(db: Database, olderThanMinutes: number): Promise<void> {
  await db.execute(sql`
    update wb_classifier_runs
    set status = 'error', error = coalesce(error, 'прервано (перезапуск процесса)')
    where status = 'running' and created_at < now() - (${olderThanMinutes} || ' minutes')::interval
  `);
}

/** An in-flight manual run for a page (status running, started < 15 min ago), if any. */
export async function getActiveClassifierRun(
  db: Database,
  platformAccountId: number,
): Promise<{ id: number } | null> {
  const result = await db.execute<{ id: number }>(sql`
    select id::int as id from wb_classifier_runs
    where platform_account_id = ${platformAccountId}
      and status = 'running'
      and created_at > now() - interval '15 minutes'
    order by id desc limit 1
  `);
  return result.rows[0] ?? null;
}

export type ClassifierRunRow = {
  id: number;
  page_label: string | null;
  trigger: string;
  model: string | null;
  classified: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  deferred: number;
  cleared: number;
  status: string;
  error: string | null;
  created_at: Date;
};

/** Most recent classifier runs across all pages (newest first), with the page label. */
export async function listClassifierRuns(db: Database, limit: number): Promise<ClassifierRunRow[]> {
  const result = await db.execute<ClassifierRunRow>(sql`
    select
      r.id::int as id,
      p.label as page_label,
      r.trigger as trigger,
      r.model as model,
      r.classified as classified,
      r.calls as calls,
      r.input_tokens as input_tokens,
      r.output_tokens as output_tokens,
      r.deferred as deferred,
      r.cleared as cleared,
      r.status as status,
      r.error as error,
      r.created_at as created_at
    from wb_classifier_runs r
    left join pages p on p.id = r.platform_account_id
    order by r.created_at desc, r.id desc
    limit ${limit}
  `);
  return result.rows;
}

/** Daily LLM usage rows for a feature since a business date (powers the cost trend). */
export async function getLlmUsageRange(
  db: Database,
  platformAccountId: number,
  feature: string,
  fromBusinessDate: string,
): Promise<Array<{ business_date: string; calls: number; input_tokens: number; output_tokens: number }>> {
  const result = await db.execute<{ business_date: string; calls: number; input_tokens: number; output_tokens: number }>(sql`
    select business_date::text as business_date, calls, input_tokens, output_tokens
    from wb_llm_usage_daily
    where platform_account_id = ${platformAccountId} and feature = ${feature} and business_date >= ${fromBusinessDate}::date
    order by business_date asc
  `);
  return result.rows;
}
