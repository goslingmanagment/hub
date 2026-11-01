import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { AWAITING_MASS_MIN_CHATS } from "./spender-stats.ts";

// chat-extension «Онлайн» (0321): the page's fans seen online recently with the
// facts that say why to write to each now, and what the chatters did in the
// window. The decision (reason, act, aside) is the service's
// (apps/runtime/src/services/client-online-rules.ts); this file only reads the
// facts, for the fans in the presence window alone — never the whole page.

/** One fan seen online, with the facts of his primary chat, spend, subscription and the window's marks. */
export interface OnlineCandidateRow {
  fanId: number;
  fanRef: string;
  /** The primary chat: the visible one with the newest message (the Spenders board's rule). */
  conversationRef: string | null;
  username: string | null;
  displayName: string | null;
  alias: string | null;
  /** The fan's last activity Hub knows (`page_fans.external_presence_at`). */
  seenAt: Date | null;
  seenSource: string | null;
  contactability: string | null;
  probeResolved: boolean | null;
  isSubscriber: boolean;
  /** The fan follows the page now (Fansly). */
  isFollower: boolean;
  /** The end of the fan's subscription as the page's fan row has it (`page_fans.subscription_expires_at`). */
  subscriptionExpiresAt: Date | null;
  /** The public account check (Fansly): false when it found no account (deleted or banned), null when never run. */
  publicFound: boolean | null;
  lifetimeGrossMills: number;
  last30GrossMills: number;
  /** The fan's last message in the primary chat, and in any chat of the page. */
  lastFanMessageAt: Date | null;
  anyFanMessageAt: Date | null;
  /**
   * The page's last personal message to the fan: the archive's newest outgoing message that is no mass message (a
   * Fansly one, or one text sent to AWAITING_MASS_MIN_CHATS chats of the page in its clock hour), a send the extension
   * attributed, or the chat summary's newest page message when the archive holds none newer.
   */
  answeredAt: Date | null;
  /** The archive's newest personal message to the fan alone (no chat summary fallback): a fan queue's «written to». */
  personalAt: Date | null;
  /** Messages of the primary chat in the archive, counted up to 10 (Ping's minimum). */
  messageCount: number;
  /** The current subscription: its start, end and renewal. */
  subscribedAt: Date | null;
  subscriptionEndsAt: Date | null;
  autoRenew: boolean | null;
  /** The extension's newest attributed send to the fan (who sent it is the in-conversation read's). */
  lastAttributionAt: Date | null;
  /** The newest message the window, a fan queue or an outreach sent to the fan (an outreach's that may have gone too). */
  lastSentAttemptAt: Date | null;
  /** The fan's last purchase on the page. */
  lastTransactionAt: Date | null;
  /** Since when the fan follows the page (Fansly). */
  followerSince: Date | null;
  /** «Не предлагать» and its undo: the latest of the two, who and when. */
  mark: { action: "dismissed" | "restored"; at: Date; by: string | null } | null;
}

export interface OnlineCandidateQuery {
  pageId: number;
  platform: string;
  now: Date;
  /** The presence window: fans whose last activity is at most this old. */
  minutes: number;
  /** Fans online now by the platform's own state (OnlyFans' users.online), whatever their last activity. */
  onlineRefs: readonly string[];
  limit: number;
  /** These fans instead of the presence window (a fan queue's portion): their facts, whatever their activity. */
  fanIds?: readonly number[];
}

const toDate = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

/**
 * The page's fans seen online within `minutes` (and the ones online now by
 * `onlineRefs`), newest activity first, at most `limit`, each with the facts of
 * the decision. Reads only the fans in the window: the presence index first,
 * then their chats, spend, subscription, attributed sends and the window's rows.
 */
export async function listOnlineCandidates(db: Database, input: OnlineCandidateQuery): Promise<OnlineCandidateRow[]> {
  const page = input.pageId;
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const refs = sql`${sql.param([...input.onlineRefs])}::text[]`;
  const result = await db.execute<{
    fan_id: string | number; fan_ref: string; conversation_ref: string | null; username: string | null; display_name: string | null;
    page_alias: string | null; seen_at: Date | string | null; seen_source: string | null; account_contactability: string | null;
    account_probe_resolved: boolean | null; is_subscriber: boolean | null; gross: string | number; gross30: string | number;
    last_fan_message_at: Date | string | null; any_fan_at: Date | string | null; answered_at: Date | string | null;
    message_count: string | number; started_at: Date | string | null; ends_at: Date | string | null; auto_renew: boolean | null;
    last_attr_at: Date | string | null; last_sent_at: Date | string | null; mark: string | null; mark_at: Date | string | null;
    mark_user: string | null; last_tx: Date | string | null; follower_since: Date | string | null; personal_at: Date | string | null;
    is_follower: boolean | null; subscription_expires_at: Date | string | null; public_found: boolean | null;
  }>(sql`
    with seen_ids as (
      ${input.fanIds === undefined ? sql`
      select pf.fan_id from page_fans pf
      where pf.platform_account_id = ${page}
        and pf.external_presence_at > ${now} - make_interval(mins => ${input.minutes})
      union
      select f.id from fans f
      where f.platform = ${input.platform} and f.platform_user_id = any(${refs})` : sql`
      select unnest(${sql.param(input.fanIds.map(String))}::bigint[]) as fan_id`}
    ),
    seen as (
      select pf.fan_id, pf.page_alias, pf.external_presence_at as seen_at, pf.external_presence_source as seen_source,
        pf.account_contactability, pf.account_probe_resolved, pf.is_subscriber, pf.follower_since,
        pf.is_follower, pf.subscription_expires_at, f.public_found
      from page_fans pf
      join seen_ids i on i.fan_id = pf.fan_id
      join fans f on f.id = pf.fan_id and f.deleted_detected_at is null
      where pf.platform_account_id = ${page}
      order by pf.external_presence_at desc nulls last, pf.fan_id
      limit ${input.limit}
    ),
    thread as (
      select distinct on (t.fan_id) t.fan_id, t.platform_conversation_id as conversation_ref,
        t.last_fan_message_at, t.last_model_message_at
      from page_dm_threads t
      join seen s on s.fan_id = t.fan_id
      where t.platform_account_id = ${page} and t.is_visible
      order by t.fan_id, t.last_message_at desc nulls last, t.platform_conversation_id desc
    ),
    any_fan as (
      select t.fan_id, max(t.last_fan_message_at) as any_fan_at
      from page_dm_threads t
      join seen s on s.fan_id = t.fan_id
      where t.platform_account_id = ${page}
      group by t.fan_id
    ),
    sub as (
      select distinct on (ps.fan_id) ps.fan_id, ps.source_created_at as started_at, ps.ends_at, ps.auto_renew
      from page_subscriptions ps
      join seen s on s.fan_id = ps.fan_id
      where ps.platform_account_id = ${page} and ps.is_current
      order by ps.fan_id, ps.source_created_at desc nulls last, ps.id desc
    ),
    spend30 as (
      select d.fan_id, coalesce(sum(d.gross_amount_mills), 0)::bigint as gross30
      from fan_spend_daily d
      join seen s on s.fan_id = d.fan_id
      where d.platform_account_id = ${page} and d.business_date >= (${now})::date - 30
      group by d.fan_id
    ),
    attributed as (
      select s.fan_id, max(a.observed_at) as last_attr_at
      from seen s
      join fans f on f.id = s.fan_id
      join client_send_attributions a on a.page_id = ${page} and a.fan_ref = f.platform_user_id
      group by s.fan_id
    ),
    window_rows as (
      select o.fan_id,
        max(o.attempted_at) filter (where o.action = 'sent') as last_sent_at,
        (array_agg(o.action order by o.attempted_at desc, o.id desc) filter (where o.action in ('dismissed', 'restored')))[1] as mark,
        (array_agg(o.attempted_at order by o.attempted_at desc, o.id desc) filter (where o.action in ('dismissed', 'restored')))[1] as mark_at,
        (array_agg(o.user_id order by o.attempted_at desc, o.id desc) filter (where o.action in ('dismissed', 'restored')))[1] as mark_user_id
      from online_attempts o
      join seen s on s.fan_id = o.fan_id
      where o.page_id = ${page}
      group by o.fan_id
    ),
    queue_sent as (
      -- A send from a fan queue closes the fan for the same three weeks as one from the window.
      select i.fan_id, max(i.done_at) as at
      from fan_queue_items i
      join seen s on s.fan_id = i.fan_id
      where i.page_id = ${page} and i.state = 'sent'
      group by i.fan_id
    ),
    outreach_sent as (
      -- So does an outreach's send that went, may have, or is on its way (0346): its moment, else its click.
      select s.fan_id, max(coalesce(o.sent_at, o.clicked_at)) as at
      from seen s
      join fans f on f.id = s.fan_id
      join client_outreach_fans o on o.page_id = ${page} and o.fan_ref = f.platform_user_id
      where o.send_state in ('sending', 'sent', 'uncertain')
      group by s.fan_id
    )
    select s.fan_id, f.platform_user_id as fan_ref, th.conversation_ref, f.username, f.display_name, s.page_alias,
      s.seen_at, s.seen_source, s.account_contactability, s.account_probe_resolved, s.is_subscriber,
      coalesce(l.gross_amount_mills, 0)::bigint as gross, coalesce(sp.gross30, 0)::bigint as gross30,
      th.last_fan_message_at, af.any_fan_at,
      greatest(
        personal.last_personal_at,
        ca.last_attr_at,
        -- The archive holds no page message newer than the chat's own summary: the summary stands.
        case when th.last_model_message_at > coalesce(outgoing.last_out_at, '-infinity'::timestamptz) then th.last_model_message_at end
      ) as answered_at,
      coalesce(counted.n, 0) as message_count,
      sb.started_at, sb.ends_at, sb.auto_renew,
      ca.last_attr_at,
      greatest(wr.last_sent_at, qs.at, os.at) as last_sent_at, wr.mark, wr.mark_at, u.username as mark_user, personal.last_personal_at as personal_at,
      l.last_transaction_at as last_tx, s.follower_since, s.is_follower, s.subscription_expires_at, s.public_found
    from seen s
    join fans f on f.id = s.fan_id
    left join fan_spend_lifetime l on l.platform_account_id = ${page} and l.fan_id = s.fan_id
    left join spend30 sp on sp.fan_id = s.fan_id
    left join thread th on th.fan_id = s.fan_id
    left join any_fan af on af.fan_id = s.fan_id
    left join sub sb on sb.fan_id = s.fan_id
    left join attributed ca on ca.fan_id = s.fan_id
    left join window_rows wr on wr.fan_id = s.fan_id
    left join queue_sent qs on qs.fan_id = s.fan_id
    left join outreach_sent os on os.fan_id = s.fan_id
    left join users u on u.id = wr.mark_user_id
    left join lateral (
      select max(m.occurred_at) as last_out_at
      from message_archive m
      where th.conversation_ref is not null and m.account_id = ${page} and m.conversation_ref = th.conversation_ref
        and m.is_sent_by_me and m.deleted_at is null
    ) outgoing on true
    left join lateral (
      -- The newest outgoing message that is no mass message, newest first: the scan stops at the first.
      select m.occurred_at as last_personal_at
      from message_archive m
      where th.conversation_ref is not null and m.account_id = ${page} and m.conversation_ref = th.conversation_ref
        and m.is_sent_by_me and m.deleted_at is null and coalesce(m.message_type, 1) <> 2
        and m.occurred_at > ${now} - interval '90 days'
        and (
          select count(*) from (
            select distinct b.conversation_ref from message_archive b
            where b.account_id = m.account_id and b.is_sent_by_me
              and b.occurred_at >= date_trunc('hour', m.occurred_at)
              and b.occurred_at < date_trunc('hour', m.occurred_at) + interval '1 hour'
              and coalesce(b.text_plain, '') = coalesce(m.text_plain, '')
              and coalesce(b.price_mills, 0) = coalesce(m.price_mills, 0)
            limit ${AWAITING_MASS_MIN_CHATS}
          ) burst
        ) < ${AWAITING_MASS_MIN_CHATS}
      order by m.occurred_at desc
      limit 1
    ) personal on true
    left join lateral (
      select count(*)::int as n from (
        select 1 from message_archive m
        where th.conversation_ref is not null and m.account_id = ${page} and m.conversation_ref = th.conversation_ref
          and m.deleted_at is null
        limit 10
      ) c
    ) counted on true
    order by s.seen_at desc nulls last, s.fan_id`);
  return result.rows.map((row) => ({
    fanId: Number(row.fan_id),
    fanRef: row.fan_ref,
    conversationRef: row.conversation_ref,
    username: row.username,
    displayName: row.display_name,
    alias: row.page_alias,
    seenAt: toDate(row.seen_at),
    seenSource: row.seen_source,
    contactability: row.account_contactability,
    probeResolved: row.account_probe_resolved,
    isSubscriber: row.is_subscriber === true,
    isFollower: row.is_follower === true,
    subscriptionExpiresAt: toDate(row.subscription_expires_at),
    publicFound: row.public_found,
    lifetimeGrossMills: Number(row.gross),
    last30GrossMills: Number(row.gross30),
    lastFanMessageAt: toDate(row.last_fan_message_at),
    anyFanMessageAt: toDate(row.any_fan_at),
    answeredAt: toDate(row.answered_at),
    personalAt: toDate(row.personal_at),
    messageCount: Number(row.message_count),
    subscribedAt: toDate(row.started_at),
    subscriptionEndsAt: toDate(row.ends_at),
    autoRenew: row.auto_renew,
    lastAttributionAt: toDate(row.last_attr_at),
    lastSentAttemptAt: toDate(row.last_sent_at),
    lastTransactionAt: toDate(row.last_tx),
    followerSince: toDate(row.follower_since),
    mark: row.mark === "dismissed" || row.mark === "restored"
      ? { action: row.mark, at: new Date(row.mark_at!), by: row.mark_user }
      : null,
  }));
}

/**
 * OnlyFans fans online now by OnlyFansAPI's own state: the newest `users.online`
 * / `users.offline` event of each fan of the page within `hours` is `online`.
 * `since` — when that event arrived. OnlyFansAPI polls the statuses: `online`
 * reaches Hub seconds after it sees it; `offline` only about 30 minutes after
 * the fan's last activity, so a fan here may have left minutes ago.
 */
export async function listOfapiOnlineNow(
  db: Database,
  input: { pageId: number; now: Date; hours: number },
): Promise<Array<{ fanRef: string; since: Date }>> {
  const result = await db.execute<{ fan_ref: string; since: Date | string }>(sql`
    select fan_ref, since from (
      select distinct on (e.payload->'payload'->'fan'->>'id')
        e.payload->'payload'->'fan'->>'id' as fan_ref, e.event_type, e.received_at as since
      from ofapi_webhook_events e
      where e.platform_account_id = ${input.pageId}
        and e.event_type in ('users.online', 'users.offline')
        and e.received_at > ${input.now.toISOString()}::timestamptz - make_interval(hours => ${input.hours})
      order by e.payload->'payload'->'fan'->>'id', e.received_at desc, e.id desc
    ) latest
    where event_type = 'users.online' and fan_ref ~ '^[1-9][0-9]{0,29}$'`);
  return result.rows.map((row) => ({ fanRef: row.fan_ref, since: new Date(row.since) }));
}

/**
 * The page's known spenders a probe of who is online asks about (chat-extension «Онлайн» on OnlyFans,
 * `clientOnlineProbe`): fans linked to the page who ever paid it, the most paid first (the newest purchase breaks a
 * tie), at most `limit`. Their numeric platform ids only: the probe sends them to the platform as numbers.
 */
export async function listOnlineProbeCandidates(db: Database, input: { pageId: number; limit: number }): Promise<string[]> {
  const result = await db.execute<{ fan_ref: string }>(sql`
    select f.platform_user_id as fan_ref
    from fan_spend_lifetime l
    join fans f on f.id = l.fan_id and f.deleted_detected_at is null
    join page_fans pf on pf.fan_id = l.fan_id and pf.platform_account_id = l.platform_account_id
    where l.platform_account_id = ${input.pageId} and l.gross_amount_mills > 0
      and f.platform_user_id ~ '^[1-9][0-9]{0,29}$'
    order by l.gross_amount_mills desc, l.last_transaction_at desc nulls last, l.fan_id
    limit ${input.limit}`);
  return result.rows.map((row) => row.fan_ref);
}

export interface OnlineAttemptInput {
  pageId: number;
  fanId: number;
  fanRef: string;
  conversationRef: string | null;
  userId: number;
  action: "sent" | "dismissed" | "restored";
  act: string | null;
  templateId: string | null;
  reason: string | null;
  attemptedAt: Date;
  observationId: number;
}

export async function insertOnlineAttempt(db: Database, input: OnlineAttemptInput): Promise<number> {
  const result = await db.execute<{ id: string | number }>(sql`
    insert into online_attempts (page_id, fan_id, fan_ref, conversation_ref, user_id, action, act, template_id, reason, attempted_at, observation_id)
    values (${input.pageId}, ${input.fanId}, ${input.fanRef}, ${input.conversationRef}, ${input.userId}, ${input.action},
      ${input.act}, ${input.templateId}, ${input.reason}, ${input.attemptedAt.toISOString()}::timestamptz, ${input.observationId})
    returning id`);
  return Number(result.rows[0]!.id);
}
