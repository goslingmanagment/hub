import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  dialogReads,
  dmBroadcastGroups,
  dmBroadcastMessages,
  workboardSnoozes,
  workboardV3FanState,
  workboardV3JobState,
  workboardV3PlanItems,
  workboardV3Touches,
  type Wb3DialogIntent,
  type Wb3DialogVerdict,
  type Wb3Dossier,
} from "../schema.ts";

// Workboard v3 data access. Raw SQL in/out; the FSM and detectors (apps/runtime)
// own the semantics. See docs/workboard-v3-prd.md §8.
//
// node-postgres parses int8 (OID 20) as bigint, so id/mills columns from raw
// db.execute() arrive as bigint; drizzle-built queries return numbers (mode:
// "number"). Helpers below normalize at the boundary.

function toNumber(value: bigint | number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

// Raw db.execute() may return timestamptz values as strings.
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// ─── Broadcast detector (M0.2) ──────────────────────────────────────────────

export async function getWb3BroadcastWatermark(
  db: Database,
  platformAccountId: number,
): Promise<Date | null> {
  const rows = await db
    .select({ scannedUntil: workboardV3JobState.broadcastScannedUntil })
    .from(workboardV3JobState)
    .where(eq(workboardV3JobState.platformAccountId, platformAccountId))
    .limit(1);
  return rows[0]?.scannedUntil ?? null;
}

export async function setWb3BroadcastWatermark(
  db: Database,
  input: { platformAccountId: number; scannedUntil: Date },
): Promise<void> {
  await db
    .insert(workboardV3JobState)
    .values({
      platformAccountId: input.platformAccountId,
      broadcastScannedUntil: input.scannedUntil,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [workboardV3JobState.platformAccountId],
      set: { broadcastScannedUntil: input.scannedUntil, updatedAt: new Date() },
    });
}

export type Wb3BroadcastScanWindow = {
  minCreatedAt: Date;
  maxCreatedAt: Date;
  maxSyncedAt: Date;
  newCount: number;
};

/** Bounds of model messages synced after the watermark (null = nothing new). */
export async function getWb3BroadcastScanWindow(
  db: Database,
  input: { platformAccountId: number; syncedAfter: Date | null },
): Promise<Wb3BroadcastScanWindow | null> {
  const result = await db.execute<{
    min_created_at: Date | null;
    max_created_at: Date | null;
    max_synced_at: Date | null;
    new_count: bigint;
  }>(sql`
    select
      min(created_at) as min_created_at,
      max(created_at) as max_created_at,
      max(synced_at) as max_synced_at,
      count(*) as new_count
    from page_dm_messages
    where platform_account_id = ${input.platformAccountId}
      and sender_role = 'model'
      -- Truncate to ms: the watermark round-trips through a JS Date, which
      -- would otherwise leave µs remainders matching "synced_at >" forever.
      and (${input.syncedAfter}::timestamptz is null
        or date_trunc('milliseconds', synced_at) > ${input.syncedAfter})
  `);
  const row = result.rows[0];
  if (!row || !row.min_created_at || !row.max_created_at || !row.max_synced_at) {
    return null;
  }
  return {
    minCreatedAt: toDate(row.min_created_at),
    maxCreatedAt: toDate(row.max_created_at),
    maxSyncedAt: toDate(row.max_synced_at),
    newCount: toNumber(row.new_count),
  };
}

export type Wb3ModelMessageRow = {
  id: number;
  conversationId: number;
  fanId: number | null;
  createdAt: Date;
  content: string;
};

/** Model messages in a created_at range, with the thread's fan (for touch credit). */
export async function listWb3ModelMessagesForScan(
  db: Database,
  input: { platformAccountId: number; from: Date; to: Date },
): Promise<Wb3ModelMessageRow[]> {
  const result = await db.execute<{
    id: bigint;
    conversation_id: bigint;
    fan_id: bigint | null;
    created_at: Date;
    content: string;
  }>(sql`
    select m.id, m.conversation_id, t.fan_id, m.created_at, m.content
    from page_dm_messages m
    join page_dm_threads t on t.id = m.conversation_id
    where m.platform_account_id = ${input.platformAccountId}
      and m.sender_role = 'model'
      and m.created_at >= ${input.from}
      and m.created_at <= ${input.to}
    order by m.created_at asc, m.id asc
  `);
  return result.rows.map((row) => ({
    id: toNumber(row.id),
    conversationId: toNumber(row.conversation_id),
    fanId: row.fan_id == null ? null : toNumber(row.fan_id),
    createdAt: toDate(row.created_at),
    content: row.content,
  }));
}

/** Existing broadcast group whose window overlaps the cluster (run continuation). */
export async function findWb3BroadcastGroup(
  db: Database,
  input: {
    platformAccountId: number;
    contentHash: string;
    overlapStart: Date;
    overlapEnd: Date;
  },
): Promise<{ id: number } | null> {
  const rows = await db
    .select({ id: dmBroadcastGroups.id })
    .from(dmBroadcastGroups)
    .where(
      and(
        eq(dmBroadcastGroups.platformAccountId, input.platformAccountId),
        eq(dmBroadcastGroups.contentHash, input.contentHash),
        sql`${dmBroadcastGroups.lastSentAt} >= ${input.overlapStart}`,
        sql`${dmBroadcastGroups.firstSentAt} <= ${input.overlapEnd}`,
      ),
    )
    .orderBy(sql`${dmBroadcastGroups.lastSentAt} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export async function createWb3BroadcastGroup(
  db: Database,
  input: {
    platformAccountId: number;
    contentHash: string;
    firstSentAt: Date;
    lastSentAt: Date;
  },
): Promise<number> {
  const [row] = await db
    .insert(dmBroadcastGroups)
    .values({
      platformAccountId: input.platformAccountId,
      contentHash: input.contentHash,
      firstSentAt: input.firstSentAt,
      lastSentAt: input.lastSentAt,
    })
    .returning({ id: dmBroadcastGroups.id });
  return row!.id;
}

export async function extendWb3BroadcastGroup(
  db: Database,
  input: { groupId: number; firstSentAt: Date; lastSentAt: Date },
): Promise<void> {
  await db.execute(sql`
    update dm_broadcast_groups
    set first_sent_at = least(first_sent_at, ${input.firstSentAt}),
        last_sent_at = greatest(last_sent_at, ${input.lastSentAt})
    where id = ${input.groupId}
  `);
}

/** Maps messages to a group; returns only the message pks that were new. */
export async function mapWb3BroadcastMessages(
  db: Database,
  input: { groupId: number; messagePks: number[] },
): Promise<number[]> {
  if (input.messagePks.length === 0) {
    return [];
  }
  const rows = await db
    .insert(dmBroadcastMessages)
    .values(input.messagePks.map((messagePk) => ({ messagePk, groupId: input.groupId })))
    .onConflictDoNothing()
    .returning({ messagePk: dmBroadcastMessages.messagePk });
  return rows.map((row) => row.messagePk);
}

export async function refreshWb3BroadcastGroupCount(
  db: Database,
  groupId: number,
): Promise<void> {
  await db.execute(sql`
    update dm_broadcast_groups
    set message_count = (select count(*) from dm_broadcast_messages where group_id = ${groupId})
    where id = ${groupId}
  `);
}

// ─── Touches (M0.3) ─────────────────────────────────────────────────────────

/** All Fansly page ids — v3 is Fansly-first (PRD §1.6). */
export async function listWb3PageIds(db: Database): Promise<number[]> {
  const result = await db.execute<{ id: bigint }>(sql`
    select id from pages where platform = 'fansly' order by id asc
  `);
  return result.rows.map((row) => toNumber(row.id));
}

export async function insertWb3Touch(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    type: "personal" | "manual";
    shiftId?: number | null;
    chatterUserId?: number | null;
    openedAt?: Date | null;
    confirmedAt?: Date | null;
  },
): Promise<number> {
  const [row] = await db
    .insert(workboardV3Touches)
    .values({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      type: input.type,
      shiftId: input.shiftId ?? null,
      chatterUserId: input.chatterUserId ?? null,
      openedAt: input.openedAt ?? null,
      confirmedAt: input.confirmedAt ?? null,
    })
    .returning({ id: workboardV3Touches.id });
  return row!.id;
}

/**
 * "Готово" pressed while an open (unconfirmed personal) touch exists — convert
 * it to a confirmed manual touch. Returns null when there is nothing open.
 */
export async function forceWb3LatestOpenTouchDone(
  db: Database,
  input: { platformAccountId: number; fanId: number; now: Date },
): Promise<number | null> {
  const result = await db.execute<{ id: bigint }>(sql`
    update workboard_v3_touches
    set type = 'manual', confirmed_at = ${input.now}
    where id = (
      select id from workboard_v3_touches
      where platform_account_id = ${input.platformAccountId}
        and fan_id = ${input.fanId}
        and type = 'personal'
        and confirmed_at is null
      order by opened_at desc nulls last, id desc
      limit 1
    )
    returning id
  `);
  const row = result.rows[0];
  return row ? toNumber(row.id) : null;
}

export type Wb3ConfirmableTouchRow = {
  touchId: number;
  fanId: number;
  shiftId: number | null;
  messagePk: number;
  messageCreatedAt: Date;
};

/**
 * Open personal touches matched to the first non-broadcast model message in
 * any of the fan's threads with created_at inside (opened_at, opened_at + window].
 */
export async function listWb3ConfirmableTouches(
  db: Database,
  input: {
    platformAccountId: number;
    now: Date;
    windowHours: number;
    lookbackDays: number;
  },
): Promise<Wb3ConfirmableTouchRow[]> {
  const result = await db.execute<{
    touch_id: bigint;
    fan_id: bigint;
    shift_id: bigint | null;
    message_pk: bigint;
    message_created_at: Date | string;
  }>(sql`
    select t.id as touch_id, t.fan_id, t.shift_id, m.id as message_pk, m.created_at as message_created_at
    from workboard_v3_touches t
    join lateral (
      select msg.id, msg.created_at
      from page_dm_messages msg
      join page_dm_threads th on th.id = msg.conversation_id
      where th.platform_account_id = t.platform_account_id
        and th.fan_id = t.fan_id
        and msg.sender_role = 'model'
        and msg.created_at > t.opened_at
        and msg.created_at <= t.opened_at + ${input.windowHours} * interval '1 hour'
        and not exists (select 1 from dm_broadcast_messages b where b.message_pk = msg.id)
      order by msg.created_at asc, msg.id asc
      limit 1
    ) m on true
    where t.platform_account_id = ${input.platformAccountId}
      and t.type = 'personal'
      and t.confirmed_at is null
      and t.opened_at is not null
      and t.opened_at > ${input.now}::timestamptz - ${input.lookbackDays} * interval '1 day'
  `);
  return result.rows.map((row) => ({
    touchId: toNumber(row.touch_id),
    fanId: toNumber(row.fan_id),
    shiftId: row.shift_id == null ? null : toNumber(row.shift_id),
    messagePk: toNumber(row.message_pk),
    messageCreatedAt: toDate(row.message_created_at),
  }));
}

export async function confirmWb3Touch(
  db: Database,
  input: { touchId: number; confirmedAt: Date; modelMessagePk: number },
): Promise<void> {
  await db
    .update(workboardV3Touches)
    .set({ confirmedAt: input.confirmedAt, modelMessagePk: input.modelMessagePk })
    .where(eq(workboardV3Touches.id, input.touchId));
}

export async function setWb3PlanItemInProgress(
  db: Database,
  planItemId: number,
): Promise<void> {
  await db
    .update(workboardV3PlanItems)
    .set({ status: "in_progress" })
    .where(eq(workboardV3PlanItems.id, planItemId));
}

export async function resolveWb3PlanItem(
  db: Database,
  input: {
    planItemId: number;
    status: "done" | "skipped" | "snoozed";
    resolvedAt: Date;
    resolvedByTouchId?: number | null;
    skipReason?: string | null;
  },
): Promise<void> {
  await db
    .update(workboardV3PlanItems)
    .set({
      status: input.status,
      resolvedAt: input.resolvedAt,
      resolvedByTouchId: input.resolvedByTouchId ?? null,
      skipReason: input.skipReason ?? null,
    })
    .where(eq(workboardV3PlanItems.id, input.planItemId));
}

/** Auto-close open plan items of the shift when a touch on the fan confirms. */
export async function resolveWb3PlanItemsForTouch(
  db: Database,
  input: { shiftId: number; fanId: number; touchId: number; resolvedAt: Date },
): Promise<number> {
  const result = await db.execute<{ id: bigint }>(sql`
    update workboard_v3_plan_items
    set status = 'done', resolved_at = ${input.resolvedAt}, resolved_by_touch_id = ${input.touchId}
    where shift_id = ${input.shiftId}
      and fan_id = ${input.fanId}
      and status in ('pending', 'in_progress')
    returning id
  `);
  return result.rows.length;
}

export async function upsertWb3Snooze(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    snoozedUntil: Date;
    reason?: string | null;
  },
): Promise<void> {
  await db
    .insert(workboardSnoozes)
    .values({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      snoozedUntil: input.snoozedUntil,
      reason: input.reason ?? null,
    })
    .onConflictDoUpdate({
      target: [workboardSnoozes.platformAccountId, workboardSnoozes.fanId],
      set: { snoozedUntil: input.snoozedUntil, reason: input.reason ?? null },
    });
}

// ─── Dialog Reads (M0.5) ────────────────────────────────────────────────────

export type Wb3DialogReadCandidate = {
  conversationId: number;
  fanId: number;
  lastFanMessagePk: number;
  segment: string | null;
  /** Recent thread tail, oldest→newest, fan/creator roles only. */
  context: Array<{ role: "fan" | "creator"; text: string }>;
};

/**
 * Threads whose latest fan message has no Dialog Read yet (the permanent cache
 * key is (conversation, last fan message) — a fan burst within the sync window
 * coalesces into one read of the newest message). Under cap pressure the order
 * is subs → spenders → fresh → mass (PRD §9), fresher tails first.
 */
export async function listWb3DialogReadCandidates(
  db: Database,
  input: { platformAccountId: number; limit: number; contextSize?: number },
): Promise<Wb3DialogReadCandidate[]> {
  const contextSize = input.contextSize ?? 15;
  const result = await db.execute<{
    conversation_id: bigint;
    fan_id: bigint;
    last_fan_message_pk: bigint;
    segment: string | null;
    context: Array<{ role: string; text: string }>;
  }>(sql`
    select t.id as conversation_id, t.fan_id, lf.id as last_fan_message_pk,
      s.segment::text as segment, ctx.context
    from page_dm_threads t
    join lateral (
      select m.id
      from page_dm_messages m
      where m.conversation_id = t.id and m.sender_role = 'fan'
      order by m.created_at desc, m.id desc
      limit 1
    ) lf on true
    left join workboard_v3_fan_state s
      on s.platform_account_id = t.platform_account_id and s.fan_id = t.fan_id
    join lateral (
      select coalesce(
        json_agg(json_build_object('role', x.role, 'text', x.content) order by x.created_at asc, x.id asc),
        '[]'::json
      ) as context
      from (
        select m2.id, m2.created_at, m2.content,
          case when m2.sender_role = 'model' then 'creator' else 'fan' end as role
        from page_dm_messages m2
        where m2.conversation_id = t.id and m2.sender_role in ('fan', 'model')
        order by m2.created_at desc, m2.id desc
        limit ${contextSize}
      ) x
    ) ctx on true
    where t.platform_account_id = ${input.platformAccountId}
      and t.fan_id is not null
      and t.is_visible
      and t.last_message_sender_role = 'fan'
      and not exists (
        select 1 from dialog_reads dr
        where dr.conversation_id = t.id and dr.last_fan_message_pk = lf.id
      )
    order by
      case s.segment::text
        when 'subscriber' then 0
        when 'spender' then 1
        when 'fresh' then 2
        when 'mass_active' then 3
        else 4
      end asc,
      t.last_fan_message_at desc nulls last,
      t.id asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    conversationId: toNumber(row.conversation_id),
    fanId: toNumber(row.fan_id),
    lastFanMessagePk: toNumber(row.last_fan_message_pk),
    segment: row.segment,
    context: (row.context ?? [])
      .filter((m) => m.role === "fan" || m.role === "creator")
      .map((m) => ({ role: m.role as "fan" | "creator", text: m.text ?? "" })),
  }));
}

export async function insertWb3DialogRead(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    conversationId: number;
    lastFanMessagePk: number;
    verdict: Wb3DialogVerdict;
    model: string;
    createdAt?: Date;
  },
): Promise<void> {
  await db
    .insert(dialogReads)
    .values({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      conversationId: input.conversationId,
      lastFanMessagePk: input.lastFanMessagePk,
      verdict: input.verdict,
      model: input.model,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .onConflictDoNothing();
}

/**
 * stop_request auto-action (PRD §9): do-not-touch with a reason, reviewed in
 * Service. Inserts a placeholder gray row when the fan has no state yet — the
 * nightly recompute fixes the segment and carries the flag forward.
 */
export async function setWb3DoNotTouch(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    doNotTouch: boolean;
    reason: string | null;
    now?: Date;
  },
): Promise<void> {
  await db.execute(sql`
    insert into workboard_v3_fan_state
      (platform_account_id, fan_id, segment, do_not_touch, do_not_touch_reason, computed_at)
    values
      (${input.platformAccountId}, ${input.fanId}, 'gray',
       ${input.doNotTouch}, ${input.reason}, ${input.now ?? new Date()})
    on conflict (platform_account_id, fan_id) do update set
      do_not_touch = excluded.do_not_touch,
      do_not_touch_reason = excluded.do_not_touch_reason
  `);
}

// ─── Read-only board (Phase 1) ──────────────────────────────────────────────

/** Everything the read-time reason engine needs for one fan. */
export type Wb3BoardFanRow = {
  fan_id: bigint;
  username: string | null;
  display_name: string | null;
  page_alias: string | null;
  ltv_mills: bigint | null;
  is_subscriber: boolean;
  pf_auto_renew: boolean | null;
  subscription_expires_at: Date | string | null;
  follower_since: Date | string | null;
  page_last_transaction_at: Date | string | null;
  sub_ends_at: Date | string | null;
  sub_auto_renew: boolean | null;
  sub_auto_renew_off_detected_at: Date | string | null;
  sub_tier_name: string | null;
  segment: string;
  has_ever_replied: boolean;
  freeloader: boolean;
  do_not_touch: boolean;
  do_not_touch_reason: string | null;
  dead_attempts: number;
  dead_sleep_until: Date | string | null;
  archived_at: Date | string | null;
  last_personal_touch_at: Date | string | null;
  last_any_touch_at: Date | string | null;
  cadence_due_at: Date | string | null;
  response_rate_90d: string | number | null;
  last_fan_message_at: Date | string | null;
  last_message_at: Date | string | null;
  last_model_message_at: Date | string | null;
  worst_coverage: string | null;
  last_sender_role: string | null;
  last_message_preview: string | null;
  recent_purchase_at: Date | string | null;
  recent_purchase_type: string | null;
  recent_purchase_net_mills: bigint | null;
  last_purchase_at: Date | string | null;
  last_touch_activity_at: Date | string | null;
  verdict: Wb3DialogVerdict | null;
  verdict_created_at: Date | string | null;
  dossier: Wb3Dossier | null;
  dossier_source: string | null;
  snoozed_until: Date | string | null;
  snooze_reason: string | null;
  flags: string[];
  cross_page_touched: boolean;
};

const BOARD_ROW_SELECT = sql`
  select
    s.fan_id,
    f.username,
    f.display_name,
    pf.page_alias,
    pf.total_creator_net_mills as ltv_mills,
    pf.is_subscriber,
    pf.auto_renew as pf_auto_renew,
    pf.subscription_expires_at,
    pf.follower_since,
    pf.last_transaction_at as page_last_transaction_at,
    sub.ends_at as sub_ends_at,
    sub.auto_renew as sub_auto_renew,
    sub.auto_renew_off_detected_at as sub_auto_renew_off_detected_at,
    sub.subscription_tier_name as sub_tier_name,
    s.segment::text as segment,
    s.has_ever_replied,
    s.freeloader,
    s.do_not_touch,
    s.do_not_touch_reason,
    s.dead_attempts,
    s.dead_sleep_until,
    s.archived_at,
    s.last_personal_touch_at,
    s.last_any_touch_at,
    s.cadence_due_at,
    s.response_rate_90d,
    th.last_fan_message_at,
    th.last_message_at,
    th.last_model_message_at,
    th.worst_coverage,
    th1.last_sender_role,
    th1.last_message_preview,
    rp.occurred_at as recent_purchase_at,
    rp.canonical_type as recent_purchase_type,
    rp.creator_net_amount_mills as recent_purchase_net_mills,
    lp.last_purchase_at,
    ta.last_touch_activity_at,
    v.verdict,
    v.created_at as verdict_created_at,
    d.dossier,
    d.source::text as dossier_source,
    sn.snoozed_until,
    sn.reason as snooze_reason,
    fl.flags,
    cp.fan_id is not null as cross_page_touched
`;

function boardRowJoins(platformAccountId: number, now: Date) {
  return sql`
    from workboard_v3_fan_state s
    join page_fans pf on pf.platform_account_id = s.platform_account_id and pf.fan_id = s.fan_id
    join fans f on f.id = s.fan_id
    left join lateral (
      select max(t.last_fan_message_at) as last_fan_message_at,
        max(t.last_message_at) as last_message_at,
        max(t.last_model_message_at) as last_model_message_at,
        min(t.message_coverage_status::text) filter (where t.stored_message_count > 0) as worst_coverage
      from page_dm_threads t
      where t.platform_account_id = s.platform_account_id and t.fan_id = s.fan_id
    ) th on true
    left join lateral (
      select t.last_message_sender_role::text as last_sender_role, t.last_message_preview
      from page_dm_threads t
      where t.platform_account_id = s.platform_account_id and t.fan_id = s.fan_id
      order by t.last_message_at desc nulls last, t.id desc
      limit 1
    ) th1 on true
    left join lateral (
      select x.occurred_at, x.canonical_type::text as canonical_type, x.creator_net_amount_mills
      from transactions x
      where x.platform_account_id = s.platform_account_id and x.fan_id = s.fan_id
        and x.creator_net_amount_mills > 0 and x.is_active and x.transaction_state = 'posted'
        and x.occurred_at >= ${now}::timestamptz - interval '48 hours'
      order by x.occurred_at desc
      limit 1
    ) rp on true
    left join lateral (
      select max(x.occurred_at) as last_purchase_at
      from transactions x
      where x.platform_account_id = s.platform_account_id and x.fan_id = s.fan_id
        and x.creator_net_amount_mills > 0 and x.is_active and x.transaction_state = 'posted'
    ) lp on true
    left join lateral (
      select max(coalesce(t.confirmed_at, t.opened_at)) as last_touch_activity_at
      from workboard_v3_touches t
      where t.platform_account_id = s.platform_account_id and t.fan_id = s.fan_id
    ) ta on true
    left join lateral (
      select dr.verdict, dr.created_at
      from dialog_reads dr
      where dr.platform_account_id = s.platform_account_id and dr.fan_id = s.fan_id
      order by dr.created_at desc, dr.id desc
      limit 1
    ) v on true
    left join fan_dossiers d
      on d.platform_account_id = s.platform_account_id and d.fan_id = s.fan_id
    left join lateral (
      select w.snoozed_until, w.reason
      from workboard_snoozes w
      where w.platform_account_id = s.platform_account_id and w.fan_id = s.fan_id
      order by w.snoozed_until desc
      limit 1
    ) sn on true
    left join lateral (
      select ps.ends_at, ps.auto_renew, ps.auto_renew_off_detected_at, ps.subscription_tier_name
      from page_subscriptions ps
      where ps.platform_account_id = s.platform_account_id and ps.fan_id = s.fan_id and ps.is_current
      order by ps.ends_at desc nulls last, ps.id desc
      limit 1
    ) sub on true
    left join lateral (
      select coalesce(array_agg(ff.flag::text), '{}') as flags
      from fan_flags ff
      where ff.fan_id = s.fan_id
    ) fl on true
    left join lateral (
      select t.fan_id
      from workboard_v3_touches t
      join pages p2 on p2.id = t.platform_account_id
      where t.fan_id = s.fan_id
        and t.platform_account_id <> ${platformAccountId}
        and p2.model_id = (select model_id from pages where id = ${platformAccountId})
        and t.type in ('personal', 'manual')
        and coalesce(t.confirmed_at, t.opened_at) >= date_trunc('day', ${now}::timestamptz)
      limit 1
    ) cp on true
  `;
}

/**
 * Fans that can carry a reason today: every interval segment, dead fans whose
 * sleep is served (revival candidates), plus any fan with an unanswered tail
 * or a fresh purchase. Gray rotation comes from loadWb3GrayBatchRows.
 */
export async function loadWb3BoardRows(
  db: Database,
  input: { platformAccountId: number; now: Date; fanId?: number },
): Promise<Wb3BoardFanRow[]> {
  const fanFilter = input.fanId == null ? sql`` : sql` and s.fan_id = ${input.fanId}`;
  const include =
    input.fanId == null
      ? sql` and (
          s.segment in ('subscriber', 'spender', 'fresh', 'mass_active')
          or (s.segment = 'dead' and s.dead_sleep_until is not null and s.dead_sleep_until <= ${input.now})
          or th1.last_sender_role = 'fan'
          or rp.occurred_at is not null
        )`
      : sql``;
  const result = await db.execute<Wb3BoardFanRow>(sql`
    ${BOARD_ROW_SELECT}
    ${boardRowJoins(input.platformAccountId, input.now)}
    where s.platform_account_id = ${input.platformAccountId}${fanFilter}${include}
  `);
  return result.rows;
}

/** Gray rotation candidates: has_ever_replied first, then LRU (PRD §5). */
export async function loadWb3GrayBatchRows(
  db: Database,
  input: { platformAccountId: number; now: Date; limit: number },
): Promise<Wb3BoardFanRow[]> {
  const result = await db.execute<Wb3BoardFanRow>(sql`
    ${BOARD_ROW_SELECT}
    ${boardRowJoins(input.platformAccountId, input.now)}
    where s.platform_account_id = ${input.platformAccountId}
      and s.segment = 'gray'
      and not s.do_not_touch
    order by s.has_ever_replied desc, s.last_any_touch_at asc nulls first, s.fan_id asc
    limit ${input.limit}
  `);
  return result.rows;
}

export type Wb3ServiceCounts = {
  dead: number;
  archived: number;
  doNotTouch: number;
  snoozed: number;
};

export async function loadWb3ServiceCounts(
  db: Database,
  input: { platformAccountId: number; now: Date },
): Promise<Wb3ServiceCounts> {
  const result = await db.execute<{
    dead: bigint;
    archived: bigint;
    dnt: bigint;
    snoozed: bigint;
  }>(sql`
    select
      (select count(*) from workboard_v3_fan_state
        where platform_account_id = ${input.platformAccountId} and segment = 'dead') as dead,
      (select count(*) from workboard_v3_fan_state
        where platform_account_id = ${input.platformAccountId} and segment = 'archived') as archived,
      (select count(*) from workboard_v3_fan_state
        where platform_account_id = ${input.platformAccountId} and do_not_touch) as dnt,
      (select count(*) from workboard_snoozes
        where platform_account_id = ${input.platformAccountId} and snoozed_until > ${input.now}) as snoozed
  `);
  const row = result.rows[0]!;
  return {
    dead: toNumber(row.dead),
    archived: toNumber(row.archived),
    doNotTouch: toNumber(row.dnt),
    snoozed: toNumber(row.snoozed),
  };
}

export type Wb3ServiceListRow = {
  fanId: number;
  username: string | null;
  displayName: string | null;
  pageAlias: string | null;
  kind: "snoozed" | "do_not_touch";
  until: Date | null;
  reason: string | null;
};

export async function loadWb3ServiceRows(
  db: Database,
  input: { platformAccountId: number; now: Date; limit?: number },
): Promise<Wb3ServiceListRow[]> {
  const limit = input.limit ?? 100;
  const result = await db.execute<{
    fan_id: bigint;
    username: string | null;
    display_name: string | null;
    page_alias: string | null;
    kind: string;
    until: Date | string | null;
    reason: string | null;
  }>(sql`
    (
      select w.fan_id, f.username, f.display_name, pf.page_alias,
        'snoozed' as kind, w.snoozed_until as until, w.reason
      from workboard_snoozes w
      join fans f on f.id = w.fan_id
      left join page_fans pf on pf.platform_account_id = w.platform_account_id and pf.fan_id = w.fan_id
      where w.platform_account_id = ${input.platformAccountId} and w.snoozed_until > ${input.now}
      order by w.snoozed_until asc
      limit ${limit}
    )
    union all
    (
      select s.fan_id, f.username, f.display_name, pf.page_alias,
        'do_not_touch' as kind, null as until, s.do_not_touch_reason as reason
      from workboard_v3_fan_state s
      join fans f on f.id = s.fan_id
      left join page_fans pf on pf.platform_account_id = s.platform_account_id and pf.fan_id = s.fan_id
      where s.platform_account_id = ${input.platformAccountId} and s.do_not_touch
      order by s.fan_id asc
      limit ${limit}
    )
  `);
  return result.rows.map((row) => ({
    fanId: toNumber(row.fan_id),
    username: row.username,
    displayName: row.display_name,
    pageAlias: row.page_alias,
    kind: row.kind as "snoozed" | "do_not_touch",
    until: row.until == null ? null : toDate(row.until),
    reason: row.reason,
  }));
}

/** Кит threshold: the 10th-highest LTV on the page (null = fewer than 10 payers). */
export async function getWb3WhaleThresholdMills(
  db: Database,
  platformAccountId: number,
): Promise<number | null> {
  const result = await db.execute<{ ltv: bigint }>(sql`
    select total_creator_net_mills as ltv
    from page_fans
    where platform_account_id = ${platformAccountId} and total_creator_net_mills > 0
    order by total_creator_net_mills desc
    offset 9 limit 1
  `);
  const row = result.rows[0];
  return row ? toNumber(row.ltv) : null;
}

/** "данные на HH:MM": the latest successful DM sync for the page. */
export async function getWb3DataAsOf(
  db: Database,
  platformAccountId: number,
): Promise<Date | null> {
  const result = await db.execute<{ as_of: Date | string | null }>(sql`
    select max(succeeded_at) as as_of
    from page_sync_states
    where page_id = ${platformAccountId} and stream in ('dm_conversations', 'dm_messages')
  `);
  const value = result.rows[0]?.as_of;
  return value == null ? null : toDate(value);
}

export type Wb3FanTouchRow = {
  id: number;
  type: string;
  openedAt: Date | null;
  confirmedAt: Date | null;
  outcomeRepliedAt: Date | null;
  outcomePurchaseAt: Date | null;
  createdAt: Date;
};

export async function listWb3FanTouches(
  db: Database,
  input: { platformAccountId: number; fanId: number; limit?: number },
): Promise<Wb3FanTouchRow[]> {
  const result = await db.execute<{
    id: bigint;
    type: string;
    opened_at: Date | string | null;
    confirmed_at: Date | string | null;
    outcome_replied_at: Date | string | null;
    outcome_purchase_at: Date | string | null;
    created_at: Date | string;
  }>(sql`
    select id, type::text as type, opened_at, confirmed_at,
      outcome_replied_at, outcome_purchase_at, created_at
    from workboard_v3_touches
    where platform_account_id = ${input.platformAccountId} and fan_id = ${input.fanId}
    order by coalesce(confirmed_at, opened_at, created_at) desc, id desc
    limit ${input.limit ?? 20}
  `);
  return result.rows.map((row) => ({
    id: toNumber(row.id),
    type: row.type,
    openedAt: row.opened_at == null ? null : toDate(row.opened_at),
    confirmedAt: row.confirmed_at == null ? null : toDate(row.confirmed_at),
    outcomeRepliedAt: row.outcome_replied_at == null ? null : toDate(row.outcome_replied_at),
    outcomePurchaseAt: row.outcome_purchase_at == null ? null : toDate(row.outcome_purchase_at),
    createdAt: toDate(row.created_at),
  }));
}

// ─── Dossiers (M0.6) ────────────────────────────────────────────────────────

export type Wb3DossierCandidate = {
  fanId: number;
  segment: string;
  hasMessages: boolean;
  /** Worst coverage across the fan's threads with messages (null = no threads). */
  coverage: string | null;
};

/**
 * Backfill candidates: spenders and mass_active fans with no dossier yet.
 * Spenders without stored conversations get a transactions_only dossier.
 */
export async function listWb3DossierBackfillCandidates(
  db: Database,
  input: { platformAccountId: number; limit: number },
): Promise<Wb3DossierCandidate[]> {
  const result = await db.execute<{
    fan_id: bigint;
    segment: string;
    has_messages: boolean;
    coverage: string | null;
  }>(sql`
    select s.fan_id, s.segment::text as segment,
      coalesce(th.has_messages, false) as has_messages,
      th.coverage
    from workboard_v3_fan_state s
    left join lateral (
      select bool_or(t.stored_message_count > 0) as has_messages,
        min(t.message_coverage_status::text) filter (where t.stored_message_count > 0) as coverage
      from page_dm_threads t
      where t.platform_account_id = s.platform_account_id and t.fan_id = s.fan_id
    ) th on true
    where s.platform_account_id = ${input.platformAccountId}
      and s.segment in ('spender', 'mass_active')
      and not exists (
        select 1 from fan_dossiers d
        where d.platform_account_id = s.platform_account_id and d.fan_id = s.fan_id
      )
      and (s.segment = 'spender' or coalesce(th.has_messages, false))
    order by s.segment asc, s.fan_id asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    fanId: toNumber(row.fan_id),
    segment: row.segment,
    hasMessages: row.has_messages,
    coverage: row.coverage,
  }));
}

/**
 * Nightly refresh (PRD §9): fans active since the dossier was built, threads
 * that reached complete coverage after the build, and transactions_only
 * dossiers whose fans now have stored history.
 */
export async function listWb3DossierRebuildCandidates(
  db: Database,
  input: { platformAccountId: number; limit: number },
): Promise<Wb3DossierCandidate[]> {
  const result = await db.execute<{
    fan_id: bigint;
    segment: string;
    has_messages: boolean;
    coverage: string | null;
  }>(sql`
    select d.fan_id,
      coalesce(s.segment::text, 'spender') as segment,
      coalesce(th.has_messages, false) as has_messages,
      th.coverage
    from fan_dossiers d
    left join workboard_v3_fan_state s
      on s.platform_account_id = d.platform_account_id and s.fan_id = d.fan_id
    left join lateral (
      select bool_or(t.stored_message_count > 0) as has_messages,
        min(t.message_coverage_status::text) filter (where t.stored_message_count > 0) as coverage,
        max(t.last_fan_message_at) as last_fan_message_at
      from page_dm_threads t
      where t.platform_account_id = d.platform_account_id and t.fan_id = d.fan_id
    ) th on true
    where d.platform_account_id = ${input.platformAccountId}
      and coalesce(th.has_messages, false)
      and (
        th.last_fan_message_at > d.built_at
        or (d.source = 'transactions_only')
        or (d.coverage_at_build is distinct from 'complete' and th.coverage = 'complete')
      )
    order by d.fan_id asc
    limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    fanId: toNumber(row.fan_id),
    segment: row.segment,
    hasMessages: row.has_messages,
    coverage: row.coverage,
  }));
}

export type Wb3DossierDialogMessage = {
  fanId: number;
  role: "fan" | "creator";
  text: string;
  createdAt: Date;
};

/** Entire stored history for each fan (all threads merged, oldest→newest). */
export async function loadWb3DossierDialogs(
  db: Database,
  input: { platformAccountId: number; fanIds: number[] },
): Promise<Map<number, Wb3DossierDialogMessage[]>> {
  if (input.fanIds.length === 0) {
    return new Map();
  }
  const result = await db.execute<{
    fan_id: bigint;
    role: string;
    content: string;
    created_at: Date | string;
  }>(sql`
    select t.fan_id,
      case when m.sender_role = 'model' then 'creator' else 'fan' end as role,
      m.content, m.created_at
    from page_dm_messages m
    join page_dm_threads t on t.id = m.conversation_id
    where m.platform_account_id = ${input.platformAccountId}
      and t.fan_id in (${sql.join(input.fanIds.map((id) => sql`${id}`), sql`, `)})
      and m.sender_role in ('fan', 'model')
    order by t.fan_id asc, m.created_at asc, m.id asc
  `);
  const byFan = new Map<number, Wb3DossierDialogMessage[]>();
  for (const row of result.rows) {
    const fanId = toNumber(row.fan_id);
    let bucket = byFan.get(fanId);
    if (!bucket) {
      bucket = [];
      byFan.set(fanId, bucket);
    }
    bucket.push({
      fanId,
      role: row.role as "fan" | "creator",
      text: row.content,
      createdAt: toDate(row.created_at),
    });
  }
  return byFan;
}

/** Worst thread coverage per fan — stamped on dossiers at write time. */
export async function listWb3FanCoverage(
  db: Database,
  input: { platformAccountId: number; fanIds: number[] },
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>();
  if (input.fanIds.length === 0) {
    return map;
  }
  const result = await db.execute<{ fan_id: bigint; coverage: string | null }>(sql`
    select t.fan_id,
      min(t.message_coverage_status::text) filter (where t.stored_message_count > 0) as coverage
    from page_dm_threads t
    where t.platform_account_id = ${input.platformAccountId}
      and t.fan_id in (${sql.join(input.fanIds.map((id) => sql`${id}`), sql`, `)})
    group by t.fan_id
  `);
  for (const row of result.rows) {
    map.set(toNumber(row.fan_id), row.coverage);
  }
  return map;
}

export async function upsertWb3FanDossier(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    dossier: Wb3Dossier;
    source: "history" | "transactions_only";
    coverageAtBuild: string | null;
    model: string | null;
    builtAt: Date;
  },
): Promise<void> {
  await db.execute(sql`
    insert into fan_dossiers
      (platform_account_id, fan_id, dossier, source, coverage_at_build, model, built_at)
    values
      (${input.platformAccountId}, ${input.fanId}, ${JSON.stringify(input.dossier)}::jsonb,
       ${input.source}::workboard_v3_dossier_source, ${input.coverageAtBuild}, ${input.model}, ${input.builtAt})
    on conflict (platform_account_id, fan_id) do update set
      dossier = excluded.dossier,
      source = excluded.source,
      coverage_at_build = excluded.coverage_at_build,
      model = excluded.model,
      built_at = excluded.built_at
  `);
}

// ─── Recompute signals (M0.4) ───────────────────────────────────────────────

export type Wb3SegmentValue =
  | "subscriber"
  | "spender"
  | "fresh"
  | "gray"
  | "mass_active"
  | "dead"
  | "archived";

/** Per-fan nightly signal row (money, threads, touches, dossier, prior state). */
export type Wb3FanSignalRow = {
  fan_id: bigint;
  ltv_mills: bigint | null;
  is_subscriber: boolean;
  auto_renew: boolean | null;
  subscription_expires_at: Date | string | null;
  follower_since: Date | string | null;
  page_last_transaction_at: Date | string | null;
  paid_mills: bigint | null;
  last_purchase_at: Date | string | null;
  last_fan_message_at: Date | string | null;
  any_fan_message: boolean;
  last_personal_touch_at: Date | string | null;
  last_broadcast_touch_at: Date | string | null;
  last_any_touch_at: Date | string | null;
  personal_touch_count: bigint;
  fifth_personal_touch_at: Date | string | null;
  outcome_total_90: bigint;
  outcome_replied_90: bigint;
  revival_touch_at: Date | string | null;
  dossier_ending: string | null;
  prior_segment: string | null;
  prior_has_ever_replied: boolean | null;
  prior_do_not_touch: boolean | null;
  prior_do_not_touch_reason: string | null;
  prior_dead_sleep_until: Date | string | null;
  prior_archived_at: Date | string | null;
};

export async function loadWb3FanSignalRows(
  db: Database,
  input: { platformAccountId: number; now: Date },
): Promise<Wb3FanSignalRow[]> {
  const from90 = new Date(input.now.getTime() - 90 * 86_400_000);
  const result = await db.execute<Wb3FanSignalRow>(sql`
    with txn as (
      select fan_id,
        sum(creator_net_amount_mills) filter (where creator_net_amount_mills > 0) as paid_mills,
        max(occurred_at) filter (where creator_net_amount_mills > 0) as last_purchase_at
      from transactions
      where platform_account_id = ${input.platformAccountId}
        and is_active and transaction_state = 'posted' and fan_id is not null
      group by fan_id
    ),
    th as (
      select fan_id,
        max(last_fan_message_at) as last_fan_message_at,
        bool_or(last_fan_message_at is not null) as any_fan_message
      from page_dm_threads
      where platform_account_id = ${input.platformAccountId} and fan_id is not null
      group by fan_id
    ),
    msg_any as (
      select t.fan_id, count(*) as fan_msg_count
      from page_dm_messages m
      join page_dm_threads t on t.id = m.conversation_id
      where m.platform_account_id = ${input.platformAccountId}
        and m.sender_role = 'fan' and t.fan_id is not null
      group by t.fan_id
    ),
    touch as (
      select fan_id,
        max(confirmed_at) filter (where type in ('personal','manual')) as last_personal_touch_at,
        max(confirmed_at) filter (where type = 'broadcast') as last_broadcast_touch_at,
        max(confirmed_at) as last_any_touch_at,
        count(*) filter (where type in ('personal','manual') and confirmed_at is not null) as personal_touch_count,
        (array_agg(confirmed_at order by confirmed_at)
          filter (where type in ('personal','manual') and confirmed_at is not null))[5] as fifth_personal_touch_at,
        count(*) filter (where type in ('personal','manual') and confirmed_at >= ${from90}
          and outcome_computed_at is not null) as outcome_total_90,
        count(*) filter (where type in ('personal','manual') and confirmed_at >= ${from90}
          and outcome_computed_at is not null and outcome_replied_at is not null) as outcome_replied_90
      from workboard_v3_touches
      where platform_account_id = ${input.platformAccountId}
      group by fan_id
    ),
    revival as (
      select t.fan_id, min(t.confirmed_at) as revival_touch_at
      from workboard_v3_touches t
      join workboard_v3_fan_state s
        on s.platform_account_id = t.platform_account_id and s.fan_id = t.fan_id
      where t.platform_account_id = ${input.platformAccountId}
        and t.type in ('personal','manual') and t.confirmed_at is not null
        and s.dead_sleep_until is not null and t.confirmed_at > s.dead_sleep_until
      group by t.fan_id
    )
    select
      pf.fan_id,
      pf.total_creator_net_mills as ltv_mills,
      pf.is_subscriber,
      pf.auto_renew,
      pf.subscription_expires_at,
      pf.follower_since,
      pf.last_transaction_at as page_last_transaction_at,
      txn.paid_mills,
      txn.last_purchase_at,
      th.last_fan_message_at,
      (coalesce(th.any_fan_message, false) or coalesce(msg_any.fan_msg_count, 0) > 0) as any_fan_message,
      touch.last_personal_touch_at,
      touch.last_broadcast_touch_at,
      touch.last_any_touch_at,
      coalesce(touch.personal_touch_count, 0) as personal_touch_count,
      touch.fifth_personal_touch_at,
      coalesce(touch.outcome_total_90, 0) as outcome_total_90,
      coalesce(touch.outcome_replied_90, 0) as outcome_replied_90,
      revival.revival_touch_at,
      d.dossier->>'ending' as dossier_ending,
      s.segment::text as prior_segment,
      s.has_ever_replied as prior_has_ever_replied,
      s.do_not_touch as prior_do_not_touch,
      s.do_not_touch_reason as prior_do_not_touch_reason,
      s.dead_sleep_until as prior_dead_sleep_until,
      s.archived_at as prior_archived_at
    from page_fans pf
    left join txn on txn.fan_id = pf.fan_id
    left join th on th.fan_id = pf.fan_id
    left join msg_any on msg_any.fan_id = pf.fan_id
    left join touch on touch.fan_id = pf.fan_id
    left join revival on revival.fan_id = pf.fan_id
    left join fan_dossiers d
      on d.platform_account_id = pf.platform_account_id and d.fan_id = pf.fan_id
    left join workboard_v3_fan_state s
      on s.platform_account_id = pf.platform_account_id and s.fan_id = pf.fan_id
    where pf.platform_account_id = ${input.platformAccountId}
  `);
  return result.rows;
}

export type Wb3FanMessageRow = {
  fanId: number;
  messagePk: number;
  createdAt: Date;
  content: string;
  /** Dialog Read intent for this exact message when one exists. */
  intent: Wb3DialogIntent | null;
};

/** Fan messages of the last `sinceDays` with verdict intents — L1 runs in TS. */
export async function loadWb3FanMessageRows(
  db: Database,
  input: { platformAccountId: number; now: Date; sinceDays: number },
): Promise<Wb3FanMessageRow[]> {
  const since = new Date(input.now.getTime() - input.sinceDays * 86_400_000);
  const result = await db.execute<{
    fan_id: bigint;
    message_pk: bigint;
    created_at: Date | string;
    content: string;
    intent: string | null;
  }>(sql`
    select t.fan_id, m.id as message_pk, m.created_at, m.content,
      dr.verdict->>'intent' as intent
    from page_dm_messages m
    join page_dm_threads t on t.id = m.conversation_id
    left join dialog_reads dr on dr.last_fan_message_pk = m.id
    where m.platform_account_id = ${input.platformAccountId}
      and m.sender_role = 'fan'
      and m.created_at >= ${since}
      and t.fan_id is not null
    order by t.fan_id asc, m.created_at asc
  `);
  return result.rows.map((row) => ({
    fanId: toNumber(row.fan_id),
    messagePk: toNumber(row.message_pk),
    createdAt: toDate(row.created_at),
    content: row.content,
    intent: (row.intent as Wb3DialogIntent | null) ?? null,
  }));
}

/**
 * Outcome loop (PRD §10): stamps replied/purchase-within-window for touches
 * older than the outcome window. Set-based; one statement per page.
 */
export async function stampWb3TouchOutcomes(
  db: Database,
  input: { platformAccountId: number; now: Date; outcomeWindowHours: number },
): Promise<number> {
  const result = await db.execute<{ id: bigint }>(sql`
    update workboard_v3_touches t
    set outcome_replied_at = sub.replied_at,
        outcome_purchase_at = sub.purchase_at,
        outcome_computed_at = ${input.now}
    from (
      select t2.id,
        (select min(m.created_at)
          from page_dm_messages m
          join page_dm_threads th on th.id = m.conversation_id
          where th.platform_account_id = t2.platform_account_id
            and th.fan_id = t2.fan_id
            and m.sender_role = 'fan'
            and m.created_at > coalesce(t2.confirmed_at, t2.opened_at, t2.created_at)
            and m.created_at <= coalesce(t2.confirmed_at, t2.opened_at, t2.created_at)
              + ${input.outcomeWindowHours} * interval '1 hour') as replied_at,
        (select min(x.occurred_at)
          from transactions x
          where x.platform_account_id = t2.platform_account_id
            and x.fan_id = t2.fan_id
            and x.creator_net_amount_mills > 0 and x.is_active and x.transaction_state = 'posted'
            and x.occurred_at > coalesce(t2.confirmed_at, t2.opened_at, t2.created_at)
            and x.occurred_at <= coalesce(t2.confirmed_at, t2.opened_at, t2.created_at)
              + ${input.outcomeWindowHours} * interval '1 hour') as purchase_at
      from workboard_v3_touches t2
      where t2.platform_account_id = ${input.platformAccountId}
        and t2.outcome_computed_at is null
        and coalesce(t2.confirmed_at, t2.opened_at, t2.created_at)
          < ${input.now}::timestamptz - ${input.outcomeWindowHours} * interval '1 hour'
    ) sub
    where t.id = sub.id
    returning t.id
  `);
  return result.rows.length;
}

export type Wb3FanStateRecord = {
  platformAccountId: number;
  fanId: number;
  segment: Wb3SegmentValue;
  hasEverReplied: boolean;
  freeloader: boolean;
  doNotTouch: boolean;
  doNotTouchReason: string | null;
  deadAttempts: number;
  deadSleepUntil: Date | null;
  archivedAt: Date | null;
  lastPersonalTouchAt: Date | null;
  lastAnyTouchAt: Date | null;
  cadenceDueAt: Date | null;
  responseRate90d: number | null;
  computedAt: Date;
};

export async function upsertWb3FanStates(
  db: Database,
  records: Wb3FanStateRecord[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  await db
    .insert(workboardV3FanState)
    .values(records)
    .onConflictDoUpdate({
      target: [workboardV3FanState.platformAccountId, workboardV3FanState.fanId],
      set: {
        segment: sql`excluded.segment`,
        hasEverReplied: sql`excluded.has_ever_replied`,
        freeloader: sql`excluded.freeloader`,
        doNotTouch: sql`excluded.do_not_touch`,
        doNotTouchReason: sql`excluded.do_not_touch_reason`,
        deadAttempts: sql`excluded.dead_attempts`,
        deadSleepUntil: sql`excluded.dead_sleep_until`,
        archivedAt: sql`excluded.archived_at`,
        lastPersonalTouchAt: sql`excluded.last_personal_touch_at`,
        lastAnyTouchAt: sql`excluded.last_any_touch_at`,
        cadenceDueAt: sql`excluded.cadence_due_at`,
        responseRate90d: sql`excluded.response_rate_90d`,
        computedAt: sql`excluded.computed_at`,
      },
    });
}

/** Drops states for fans no longer present on the page. */
export async function deleteWb3FanStatesForMissingFans(
  db: Database,
  platformAccountId: number,
): Promise<number> {
  const result = await db.execute<{ fan_id: bigint }>(sql`
    delete from workboard_v3_fan_state s
    where s.platform_account_id = ${platformAccountId}
      and not exists (
        select 1 from page_fans pf
        where pf.platform_account_id = s.platform_account_id and pf.fan_id = s.fan_id
      )
    returning s.fan_id
  `);
  return result.rows.length;
}

export async function insertWb3BroadcastTouches(
  db: Database,
  rows: Array<{
    platformAccountId: number;
    fanId: number;
    confirmedAt: Date;
    modelMessagePk: number;
  }>,
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await db
    .insert(workboardV3Touches)
    .values(
      rows.map((row) => ({
        platformAccountId: row.platformAccountId,
        fanId: row.fanId,
        type: "broadcast" as const,
        confirmedAt: row.confirmedAt,
        modelMessagePk: row.modelMessagePk,
        createdAt: row.confirmedAt,
      })),
    )
    .returning({ id: workboardV3Touches.id });
  return inserted.length;
}
