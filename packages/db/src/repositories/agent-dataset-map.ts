/**
 * The dataset registry's other half: name -> SQL.
 *
 * The contracts package declares WHAT a dataset is (its fields, their scalar
 * kinds, its default sort). This module declares WHERE those fields come from.
 * A mandatory two-way test asserts the two agree exactly in both directions — a
 * declared field with no mapping would 500 at query time, and a mapped column
 * with no declaration would serve data the catalog never advertised.
 *
 * THE LAW (spec §10): a request string NEVER becomes a table or column name.
 * Every `source` below is a code constant; a request's `field` is first resolved
 * against the contracts registry and then used only as a KEY into `fields`, whose
 * VALUES are the code constants that reach SQL. There is no path from request
 * text to an identifier.
 *
 * Each `source` is a derived table exposing a fixed internal vocabulary:
 *   `k_page_id`   the page this row belongs to (the grant filter binds here);
 *   `k_platform`  the page's platform;
 *   `k_key`       the row's stable text key (also the cursor's tiebreak);
 *   `k_occurred_at`  the row's event instant, used by the `[from, to)` window;
 *   `k_fan`       the fan's native id, or NULL;
 *   `f_*`         one column per WIRE field, named by this module, not by the
 *                 request.
 */

// The SHARED label tables. Imported rather than restated: the `case` expressions
// this module builds for `sourceLabel`, `typeLabel` and the notification labels
// are GENERATED from these frozen constants, so a second copy of a code→label
// map cannot drift away from the first.
import { POST_ATTACHMENTS_DATASET, RAW_MEDIA_DATASET } from "./agent-content-media-sql.ts";
import { fanslyEngineLegacyStreamValuesSql } from "./sync/legacy-streams.ts";

import {
  FANSLY_MEDIA_STAT_TYPES,
  FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL,
  FANSLY_NOTIFICATION_ALERT_FAMILY_MAX,
  FANSLY_NOTIFICATION_ALERT_FAMILY_MIN,
  FANSLY_NOTIFICATION_LABEL_VERSION,
  FANSLY_NOTIFICATION_TYPES,
  FANSLY_PROFILE_STAT_FAMILIES,
  FANSLY_REVENUE_LABEL_VERSION,
  FANSLY_REVENUE_TYPES,
} from "@agency_hub_core/shared";

export interface AgentDatasetSqlMapping {
  /** A complete `select ...` producing the internal vocabulary above. */
  readonly source: string;
  /** Wire field name -> the derived table's column. Values are code constants. */
  readonly fields: Readonly<Record<string, string>>;
  /** The column the `[from, to)` window applies to; every dataset has one. */
  readonly windowColumn: string;
  /**
   * The capture planes this dataset's SQL actually reads.
   *
   * Declared per dataset rather than assumed: the first revision minted a
   * `page_fans` witness for EVERY dataset, so a `sync_streams` query claimed to
   * have read the audience table it never touches.
   */
  readonly readPlanes: readonly string[];
  /** The one temporal plane whose unbounded per-page minimum establishes this
   * dataset's capture floor. Inventory datasets omit it and stay `unknown`. */
  readonly captureFloorPlane?: string;
  /**
   * Optional boolean source column limiting rows that may be served or
   * aggregated. It deliberately does NOT constrain `captureFloorPlane`: the
   * floor describes every physical row Hub retains, not only current heads.
   */
  readonly eligibilityColumn?: string;
  /** Optional context-coverage signal evaluated over the page/window and row
   * eligibility, but deliberately outside result filters. Filters must never
   * hide a capture gap and turn an empty result into false negative evidence. */
  readonly internalCaptureGap?: {
    readonly column: string;
    readonly plane: string;
    /** Only this platform currently promises the context capture lane. */
    readonly platform?: string;
  };
  /** Optional row-level lineage exposed by the source under fixed internal
   * columns. Request text can never select or rename these columns. */
  readonly provenanceColumns?: {
    readonly observationRef: string;
    readonly ingestPath: string;
    readonly convergence: string;
  };
}

const FAN_MEMBERSHIPS = `
  select pf.platform_account_id as k_page_id,
         p.platform::text        as k_platform,
         pf.id::text             as k_key,
         pf.last_seen_at         as k_occurred_at,
         f.platform_user_id      as k_fan,
         p.platform::text        as f_platform,
         f.platform_user_id      as f_platform_user_id,
         f.username              as f_username,
         f.display_name          as f_display_name,
         case
           when pf.is_subscriber or pf.is_follower then 'active'
           when f.deleted_detected_at is not null then 'unknown'
           else 'inactive'
         end                     as f_membership_state,
         f.first_seen_at         as f_first_seen_at,
         pf.last_seen_at         as f_last_seen_at,
         pf.total_creator_net_mills as f_lifetime_spend_mills
  from page_fans pf
  join fans f on f.id = pf.fan_id
  join pages p on p.id = pf.platform_account_id
`;

const DM_THREADS = `
  select t.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         t.id::text            as k_key,
         t.last_message_at     as k_occurred_at,
         coalesce(f.platform_user_id, t.partner_platform_user_id) as k_fan,
         p.platform::text      as f_platform,
         coalesce(f.platform_user_id, t.partner_platform_user_id) as f_platform_user_id,
         t.platform_conversation_id as f_conversation_ref,
         t.last_message_at     as f_last_message_at,
         t.stored_message_count as f_message_count,
         t.unread_count        as f_unread_count,
         t.message_coverage_status::text as f_coverage_status
  from page_dm_threads t
  join pages p on p.id = t.platform_account_id
  left join fans f on f.id = t.fan_id
`;

/**
 * The raw `canonical_status` values that mean "this subscription is over".
 *
 * ONE list, read by the dataset SQL below AND by the person operation's TypeScript
 * projection. The two disagreed: #10 classified `ended` and `cancelled` as expired
 * while #3 mapped only the literal `expired` and answered `unknown` for the other
 * two, so one subscription had two states depending on which operation was asked.
 */
export const AGENT_SUBSCRIPTION_EXPIRED_STATUSES = ["expired", "ended", "cancelled"] as const;

/**
 * The wire state of one subscription row. The SQL below follows the same rules
 * and is generated from the same list, so a new terminal status cannot reach
 * only one of the two.
 *
 * `canonical_status` is the LAST status the provider sent; `is_current` carries
 * retirement. A sync that no longer sees a subscription in the provider's
 * active list sets `is_current = false` and leaves the status as it was, so an
 * `active` status on a retired row is an ended subscription, not a live one —
 * the same reading Hub's own subscriber state takes. `isCurrent` is required so
 * no caller can forget it.
 */
export function agentSubscriptionState(
  canonicalStatus: string | null | undefined,
  isCurrent: boolean,
): "active" | "expired" | "unknown" {
  if (canonicalStatus === "active") {
    return isCurrent ? "active" : "expired";
  }
  return (AGENT_SUBSCRIPTION_EXPIRED_STATUSES as readonly string[])
    .includes(canonicalStatus ?? "")
    ? "expired"
    : "unknown";
}

const SUBSCRIPTION_STATE_SQL = `case
           when s.canonical_status = 'active' and s.is_current then 'active'
           when s.canonical_status = 'active' then 'expired'
           when s.canonical_status in (${
  AGENT_SUBSCRIPTION_EXPIRED_STATUSES.map((status) => `'${status}'`).join(", ")
}) then 'expired'
           else 'unknown'
         end`;

const SUBSCRIPTIONS = `
  select s.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         s.id::text            as k_key,
         s.source_created_at   as k_occurred_at,
         f.platform_user_id    as k_fan,
         p.platform::text      as f_platform,
         f.platform_user_id    as f_platform_user_id,
         s.platform_subscription_id as f_subscription_ref,
         ${SUBSCRIPTION_STATE_SQL} as f_subscription_state,
         s.source_created_at   as f_started_at,
         s.ends_at             as f_expires_at,
         s.price_mills         as f_price_mills,
         'USD'::text           as f_currency
  from page_subscriptions s
  join pages p on p.id = s.platform_account_id
  join fans f on f.id = s.fan_id
  where s.source_created_at is not null
`;

const SUBSCRIPTION_EVENTS = `
  select e.account_id          as k_page_id,
         p.platform::text      as k_platform,
         e.id::text            as k_key,
         e.occurred_at         as k_occurred_at,
         case
           when pf.id is not null
             and e.fan_identity_ref is distinct from p.external_page_id
             then f.platform_user_id
           else null
         end                   as k_fan,
         e.observation_id      as k_observation_ref,
         'ofapi_webhook'::text as k_ingest_path,
         'final'::text         as k_convergence,
         e.occurred_at         as f_occurred_at,
         case
           when pf.id is not null
             and e.fan_identity_ref is distinct from p.external_page_id
             then f.platform_user_id
           else null
         end                   as f_fan_id,
         case e.type
           when 'subscription.started' then 'started'
           when 'subscription.renewed' then 'renewed'
         end                   as f_phase,
         nullif(e.data ->> 'subType', '') as f_sub_type
  from domain_events e
  join pages p on p.id = e.account_id
  left join fans f
    on f.platform = p.platform
   and f.platform_user_id = e.fan_identity_ref
  left join page_fans pf
    on pf.platform_account_id = e.account_id
   and pf.fan_id = f.id
  where p.platform = 'onlyfans'
    and e.type in ('subscription.started', 'subscription.renewed')
`;

const TRANSACTIONS = `
  select tr.platform_account_id as k_page_id,
         p.platform::text       as k_platform,
         tr.id::text            as k_key,
         tr.occurred_at         as k_occurred_at,
         f.platform_user_id     as k_fan,
         tr.is_active           as k_eligible,
         p.platform::text       as f_platform,
         f.platform_user_id     as f_platform_user_id,
         tr.transaction_id      as f_transaction_ref,
         tr.canonical_type::text  as f_transaction_type,
         tr.transaction_state::text as f_transaction_state,
         tr.occurred_at         as f_occurred_at,
         tr.gross_amount_mills  as f_gross_mills,
         tr.creator_net_amount_mills as f_net_mills,
         tr.platform_fee_mills  as f_fee_mills,
         tr.currency::text      as f_currency,
         tr.correlation_id      as f_related_message_ref,
         tr.correlation_id      as f_correlation_ref
  from transactions tr
  join pages p on p.id = tr.platform_account_id
  left join fans f on f.id = tr.fan_id
`;

const TIP_TRANSACTIONS = `
  select tr.platform_account_id as k_page_id,
         p.platform::text       as k_platform,
         tr.id::text            as k_key,
         tr.occurred_at         as k_occurred_at,
         f.platform_user_id     as k_fan,
         tr.is_active           as k_eligible,
         (ttc.id is not null)   as k_context_captured,
         null::bigint           as k_observation_ref,
         case when p.platform::text = 'fansly'
           then 'fansly_pull' else 'unknown' end as k_ingest_path,
         case when p.platform::text = 'fansly'
           then 'converging' else 'no_material_lane' end as k_convergence,
         p.platform::text       as f_platform,
         f.platform_user_id     as f_platform_user_id,
         tr.transaction_id      as f_transaction_ref,
         tr.canonical_type::text as f_transaction_type,
         tr.transaction_state::text as f_transaction_state,
         tr.occurred_at         as f_occurred_at,
         tr.gross_amount_mills  as f_gross_mills,
         tr.creator_net_amount_mills as f_net_mills,
         tr.platform_fee_mills  as f_fee_mills,
         tr.currency::text      as f_currency,
         tr.correlation_id      as f_correlation_ref,
         case when ttc.id is null then 'not_captured' else 'captured' end
                                as f_context_state,
         ttc.captured_conversation_ref as f_captured_conversation_ref,
         ttc.tip_message_text   as f_tip_message_text
  from transactions tr
  join pages p on p.id = tr.platform_account_id
  left join fans f on f.id = tr.fan_id
  left join transaction_tip_contexts ttc
    on ttc.account_id = tr.platform_account_id
   and ttc.platform_tip_id = tr.correlation_id
   and ttc.platform::text = p.platform::text
  where tr.canonical_type::text = 'tip'
`;

const FAN_SPEND_DAILY = `
  select d.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         d.platform_account_id::text || ':' || d.fan_id::text || ':'
           || d.business_date::text || ':' || d.canonical_type::text || ':'
           || d.transaction_state::text as k_key,
         d.business_date::timestamptz as k_occurred_at,
         f.platform_user_id    as k_fan,
         p.platform::text      as f_platform,
         f.platform_user_id    as f_platform_user_id,
         d.business_date::text as f_business_date,
         d.gross_amount_mills  as f_gross_mills,
         d.creator_net_amount_mills as f_net_mills,
         d.transaction_count   as f_transaction_count,
         'USD'::text           as f_currency
  from fan_spend_daily d
  join pages p on p.id = d.platform_account_id
  join fans f on f.id = d.fan_id
`;

const FOLLOWS = `
  select fl.platform_account_id as k_page_id,
         p.platform::text       as k_platform,
         fl.id::text            as k_key,
         fl.followed_at         as k_occurred_at,
         f.platform_user_id     as k_fan,
         p.platform::text       as f_platform,
         f.platform_user_id     as f_platform_user_id,
         fl.is_active           as f_followed,
         fl.followed_at         as f_followed_at,
         case when not fl.is_active then fl.last_seen_at end as f_unfollowed_at
  from page_follows fl
  join pages p on p.id = fl.platform_account_id
  join fans f on f.id = fl.fan_id
`;

const FOLLOWERS_DAILY = `
  select df.platform_account_id as k_page_id,
         p.platform::text       as k_platform,
         df.id::text            as k_key,
         df.business_date::timestamptz as k_occurred_at,
         null::text             as k_fan,
         p.platform::text       as f_platform,
         df.business_date::text as f_business_date,
         df.known_total_followers as f_followers_count
  from daily_followers df
  join pages p on p.id = df.platform_account_id
`;

// Two alias stores with different shapes: the page-scoped operator alias and the
// historical username. Both are identity evidence, so the dataset exposes them as
// one stream with an explicit `aliasKind` rather than making the caller know
// which table an alias came from.
const FAN_ALIASES = `
  select a.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         'page:' || a.platform_account_id::text || ':' || a.fan_id::text || ':' || a.alias as k_key,
         a.last_seen_at        as k_occurred_at,
         f.platform_user_id    as k_fan,
         p.platform::text      as f_platform,
         f.platform_user_id    as f_platform_user_id,
         'alias'::text         as f_alias_kind,
         a.alias               as f_alias_value,
         a.first_seen_at       as f_first_seen_at,
         a.last_seen_at        as f_last_seen_at
  from page_fan_aliases a
  join pages p on p.id = a.platform_account_id
  join fans f on f.id = a.fan_id
  union all
  select pf.platform_account_id as k_page_id,
         p.platform::text       as k_platform,
         'username:' || pf.platform_account_id::text || ':' || u.fan_id::text || ':' || u.username as k_key,
         u.last_seen_at         as k_occurred_at,
         f.platform_user_id     as k_fan,
         p.platform::text       as f_platform,
         f.platform_user_id     as f_platform_user_id,
         'username'::text       as f_alias_kind,
         u.username             as f_alias_value,
         u.first_seen_at        as f_first_seen_at,
         u.last_seen_at         as f_last_seen_at
  from fan_username_aliases u
  join fans f on f.id = u.fan_id
  join page_fans pf on pf.fan_id = u.fan_id
  join pages p on p.id = pf.platform_account_id
`;

const FAN_NOTES = `
  select n.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         'internal:' || n.id::text as k_key,
         n.created_at          as k_occurred_at,
         f.platform_user_id    as k_fan,
         p.platform::text      as f_platform,
         f.platform_user_id    as f_platform_user_id,
         'internal:' || n.id::text as f_note_ref,
         n.body                as f_note_text,
         n.created_at          as f_created_at,
         n.created_at          as f_updated_at
  from fan_notes n
  join pages p on p.id = n.platform_account_id
  join fans f on f.id = n.fan_id
  union all
  select e.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         'external:' || e.id::text as k_key,
         coalesce(e.created_at_external, e.first_seen_at) as k_occurred_at,
         f.platform_user_id    as k_fan,
         p.platform::text      as f_platform,
         f.platform_user_id    as f_platform_user_id,
         'external:' || e.id::text as f_note_ref,
         coalesce(e.body, '')  as f_note_text,
         coalesce(e.created_at_external, e.first_seen_at) as f_created_at,
         coalesce(e.updated_at_external, e.last_seen_at)  as f_updated_at
  from page_fan_external_notes e
  join pages p on p.id = e.platform_account_id
  join fans f on f.id = e.fan_id
`;

const CREATOR_POSTS = `
  select cp.account_id          as k_page_id,
         cp.platform::text      as k_platform,
         cp.id::text            as k_key,
         cp.published_at        as k_occurred_at,
         null::text             as k_fan,
         cp.source_observation_id as k_observation_ref,
         -- V1 has one governed post-material lane per platform. This is the
         -- Agent ingest-path vocabulary, not a claim about the raw producer
         -- string; add a projection discriminator before adding a second lane.
         case cp.platform::text
           when 'fansly' then 'fansly_pull'
           when 'onlyfans' then 'ofapi_material_capture'
           else 'unknown'
         end                    as k_ingest_path,
         'converging'::text     as k_convergence,
         cp.platform::text      as f_platform,
         cp.platform_post_id    as f_post_ref,
         cp.text_plain          as f_post_text,
         cp.published_at        as f_published_at,
         cp.first_observed_at   as f_first_observed_at,
         cp.last_observed_at    as f_last_observed_at,
         cp.updated_at          as f_row_updated_at,
         cp.attachment_count    as f_attachment_count,
         cp.fyp_flags           as f_fyp_flags,
         cp.in_reply_to_ref     as f_in_reply_to_ref,
         cp.wall_refs           as f_wall_refs
  from creator_posts cp
`;

const POST_MONETIZATION = `
  select cp.account_id          as k_page_id,
         cp.platform::text      as k_platform,
         cp.id::text            as k_key,
         cp.published_at        as k_occurred_at,
         null::text             as k_fan,
         cp.source_observation_id as k_observation_ref,
         case cp.platform::text
           when 'fansly' then 'fansly_pull'
           else 'unknown'
         end                    as k_ingest_path,
         'converging'::text     as k_convergence,
         cp.platform::text      as f_platform,
         cp.platform_post_id    as f_post_ref,
         cp.published_at        as f_published_at,
         cp.last_observed_at    as f_last_observed_at,
         cp.tip_amount_mills    as f_post_target_tip_amount_mills,
         cp.attachment_tip_amount_mills as f_attachment_tip_amount_mills,
         cp.post_tip_total_mills as f_post_tip_total_mills,
         cp.tip_goal_linked     as f_tip_goal_linked,
         cp.tip_goal_ref        as f_tip_goal_ref,
         cp.tip_goal_label      as f_tip_goal_label_text,
         cp.tip_goal_target_mills as f_tip_goal_target_mills,
         cp.tip_goal_current_mills as f_tip_goal_current_mills,
         cp.tip_goal_amounts_hidden as f_tip_goal_amounts_hidden
  from creator_posts cp
  where cp.platform::text = 'fansly'
`;

const CREATOR_POST_TIPS = `
  select cpt.account_id         as k_page_id,
         cpt.platform::text     as k_platform,
         cpt.id::text           as k_key,
         cpt.occurred_at        as k_occurred_at,
         cpt.tip_sender_platform_user_id as k_fan,
         cpt.source_observation_id as k_observation_ref,
         case cpt.platform::text
           when 'fansly' then 'fansly_pull'
           else 'unknown'
         end                    as k_ingest_path,
         'converging'::text     as k_convergence,
         cpt.platform::text     as f_platform,
         cpt.platform_post_id   as f_post_tip_post_ref,
         cpt.platform_tip_id    as f_post_tip_ref,
         cpt.tip_sender_platform_user_id as f_tip_sender_platform_user_id,
         cpt.occurred_at        as f_post_tip_occurred_at,
         cpt.post_tip_amount_mills as f_post_tip_amount_mills,
         cpt.receiver_transaction_ref as f_receiver_transaction_ref,
         cpt.tip_goal_ref       as f_post_tip_goal_ref,
         cpt.tip_message_text   as f_post_tip_message_text
  from creator_post_tips cpt
  where cpt.platform::text = 'fansly'
`;

/**
 * Shared Fansly goals repeat on every linked creator-post head. Rank inside the
 * source projection so the public dataset has exactly one row per native goal
 * ref, while retaining how many current post heads link to it. The provider
 * snapshot winner uses the same temporal/account-sequence ordering as the
 * projection; id is only the final total-order guard for malformed legacy data.
 */
const TIP_GOALS = `
  select ranked.account_id       as k_page_id,
         ranked.platform::text   as k_platform,
         ranked.tip_goal_ref     as k_key,
         ranked.last_observed_at as k_occurred_at,
         null::text              as k_fan,
         ranked.source_observation_id as k_observation_ref,
         'fansly_pull'::text     as k_ingest_path,
         'converging'::text      as k_convergence,
         ranked.platform::text   as f_platform,
         ranked.tip_goal_ref     as f_tip_goal_ref,
         ranked.tip_goal_label   as f_tip_goal_label_text,
         ranked.tip_goal_target_mills as f_tip_goal_target_mills,
         ranked.tip_goal_current_mills as f_tip_goal_current_mills,
         ranked.tip_goal_amounts_hidden as f_tip_goal_amounts_hidden,
         ranked.last_observed_at as f_last_observed_at,
         ranked.linked_post_count as f_linked_post_count
  from (
    select cp.*,
           count(*) over (
             partition by cp.account_id, cp.platform, cp.tip_goal_ref
           ) as linked_post_count,
           row_number() over (
             partition by cp.account_id, cp.platform, cp.tip_goal_ref
             order by cp.last_observed_at desc, cp.source_account_seq desc, cp.id desc
           ) as goal_rank
    from creator_posts cp
    where cp.platform::text = 'fansly'
      and cp.tip_goal_ref is not null
  ) ranked
  where ranked.goal_rank = 1
`;

// A page the Fansly Sync Engine owns (`handover`/`live`, design step 3 §3.2
// item 6) has frozen legacy rows: its streams are reported from the engine's
// live journal instead, each registry key counted under the legacy stream(s)
// it takes over (`FANSLY_ENGINE_LEGACY_STREAMS`). Per stream: `failed` while a
// key's work is quarantined or blocked by the vendor, `paused` when the page
// or every key of the stream is paused, `running` while a read is in flight,
// else `ok`; the cursor and success instants are the newest applied attempt,
// the failure instant the newest failed one (a subject's final 404 is an
// answer, not a failure), the streak the largest open subject breaker.
const FANSLY_ENGINE_LEGACY_STREAM_VALUES = fanslyEngineLegacyStreamValuesSql();
const SYNC_STREAMS = `
  select ss.page_id       as k_page_id,
         p.platform::text as k_platform,
         ss.page_id::text || ':' || ss.stream::text as k_key,
         ss.updated_at    as k_occurred_at,
         null::text       as k_fan,
         ss.stream::text  as f_stream,
         ss.status::text  as f_sync_status,
         c.cursor_timestamp as f_cursor_at,
         ss.succeeded_at  as f_succeeded_at,
         ss.failed_at     as f_failed_at,
         ss.consecutive_failures as f_consecutive_failures
  from page_sync_states ss
  join pages p on p.id = ss.page_id
  left join page_sync_cursors c on c.page_id = ss.page_id and c.stream = ss.stream
  where not exists (
    select 1 from sync_pages esp
     where esp.page_id = ss.page_id and esp.mode in ('handover', 'live'))
  union all
  select sp.page_id       as k_page_id,
         p.platform::text as k_platform,
         sp.page_id::text || ':' || s.stream as k_key,
         greatest(wk.updated_at, att.applied_at, att.failed_at) as k_occurred_at,
         null::text       as k_fan,
         s.stream         as f_stream,
         case
           when coalesce(wk.failed, false) then 'failed'
           when sp.paused_all or s.keys <@ sp.paused_resources then 'paused'
           when coalesce(wk.running, false) then 'running'
           else 'ok'
         end              as f_sync_status,
         att.applied_at   as f_cursor_at,
         att.applied_at   as f_succeeded_at,
         att.failed_at    as f_failed_at,
         coalesce(wk.failures, 0)::int as f_consecutive_failures
  from sync_pages sp
  join pages p on p.id = sp.page_id
  cross join (
    select m.stream, array_agg(m.resource order by m.resource) as keys
      from (${FANSLY_ENGINE_LEGACY_STREAM_VALUES}) as m(resource, stream)
     group by m.stream
  ) s
  left join (
    select w.page_id, m.stream,
           bool_or(w.state = 'running') as running,
           bool_or(w.state = 'quarantined'
                   or (w.state in ('open', 'running') and w.blocked_by_vendor_at is not null)) as failed,
           max(w.failure_count) filter (where w.state in ('open', 'running', 'quarantined')) as failures,
           max(w.updated_at) as updated_at
      from sync_work w
      join (${FANSLY_ENGINE_LEGACY_STREAM_VALUES}) as m(resource, stream) on m.resource = w.resource
     where not w.shadow
     group by w.page_id, m.stream
  ) wk on wk.page_id = sp.page_id and wk.stream = s.stream
  left join (
    select a.page_id, m.stream,
           max(a.applied_at) as applied_at,
           max(coalesce(a.completed_at, a.admitted_at)) filter (
             where a.apply_state = 'quarantined'
                or (a.error_class is not null and a.error_class not in ('subject_terminal', 'not_sent'))
           ) as failed_at
      from sync_attempts a
      join (${FANSLY_ENGINE_LEGACY_STREAM_VALUES}) as m(resource, stream) on m.resource = a.resource
     where not a.shadow
     group by a.page_id, m.stream
  ) att on att.page_id = sp.page_id and att.stream = s.stream
  where sp.mode in ('handover', 'live')
    and (wk.page_id is not null or att.page_id is not null)
`;

// ── endpoints-cover (WP-S1) sources ─────────────────────────────────────────
//
// THE LABEL TABLES ARE NOT COPIED HERE. Every `case` below is GENERATED from
// the frozen table in `@agency_hub_core/shared` at module load, the way
// `SUBSCRIPTION_STATE_SQL` is generated from `AGENT_SUBSCRIPTION_EXPIRED_STATUSES`
// above. A second, hand-typed copy of a code→label map inside SQL is exactly the
// drift that made `reference/fansly_api_spec.md` §3.1 disagree with the client
// on eight of sixteen notification codes; a generated one cannot disagree.
//
// The RAW code is always selected beside its label, because the label is this
// build's reading and the code is the fact (A22-2).

/** A SQL string literal. The inputs are frozen in-repo constants, never request
 *  text — this escape exists so that stays true if a label ever gains one. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `case <expr> when <code> then '<label>' ... else <fallback> end`. */
function codeCaseSql(
  expression: string,
  entries: readonly (readonly [number, string])[],
  fallback: string,
): string {
  const whens = entries
    .map(([code, label]) => `when ${code} then ${sqlText(label)}`)
    .join("\n             ");
  return `case ${expression}\n             ${whens}\n             else ${fallback}\n           end`;
}

const PROFILE_FAMILY_CODES = Object.keys(FANSLY_PROFILE_STAT_FAMILIES).map(Number);

/** `type - (type % 10)`, as text, for a numeric source code; NULL otherwise. */
const PROFILE_FAMILY_EXPR =
  `case when t.source_code ~ '^[0-9]+$'
             then (t.source_code::bigint - (t.source_code::bigint % 10))::text
             else null::text end`;

/** True only for a code this label version actually knows: the MEMBERSHIP test
 *  comes first (members 0 and 1 are the only observed ones), then the family
 *  lookup — the same guard order `profileStatLabel` pins in TypeScript. A new
 *  member of a known family (10002, 44002) must read `unknown:<code>`, never be
 *  absorbed into its family's label. */
const PROFILE_KNOWN_EXPR =
  `t.source_code ~ '^[0-9]+$'
           and (t.source_code::bigint % 10) in (0, 1)
           and (t.source_code::bigint - (t.source_code::bigint % 10))
               in (${PROFILE_FAMILY_CODES.join(", ")})`;

const PROFILE_LABEL_SQL = `case
           when ${PROFILE_KNOWN_EXPR}
           then (${codeCaseSql(
  "(t.source_code::bigint - (t.source_code::bigint % 10))",
  Object.entries(FANSLY_PROFILE_STAT_FAMILIES).map(
    ([code, label]) => [Number(code), label] as const,
  ),
  "null::text",
)})
                || (case when (t.source_code::bigint % 10) = 1
                         then '_visits' else '_dwell' end)
           else 'unknown:' || t.source_code
         end`;

const PROFILE_MEASURE_SQL = `case
           when ${PROFILE_KNOWN_EXPR}
           then (case when (t.source_code::bigint % 10) = 1 then 'visits' else 'dwell' end)
           else null::text
         end`;

const MEDIA_LABEL_SQL = `${codeCaseSql(
  "case when t.source_code ~ '^[0-9]+$' then t.source_code::bigint else null end",
  Object.entries(FANSLY_MEDIA_STAT_TYPES).map(
    ([code, label]) => [Number(code), label] as const,
  ),
  "'unknown:' || t.source_code",
)}`;

/** `account_media` rows carry the 0/1 MEDIA codes; `account_profile` rows carry
 *  the 8-code profile structure. One table, two vocabularies — branching on the
 *  subject kind is what keeps a media row from being labelled `unknown:1`. */
const TRAFFIC_LABEL_SQL = `case
           when t.subject_kind = 'account_profile' then (${PROFILE_LABEL_SQL})
           else (${MEDIA_LABEL_SQL})
         end`;

const TRAFFIC_FAMILY_SQL = `case
           when t.subject_kind = 'account_profile' then (${PROFILE_FAMILY_EXPR})
           else null::text
         end`;

const TRAFFIC_MEASURE_SQL = `case
           when t.subject_kind = 'account_profile' then (${PROFILE_MEASURE_SQL})
           else null::text
         end`;

const REVENUE_LABEL_SQL = codeCaseSql(
  "r.type_code",
  FANSLY_REVENUE_TYPES.map((row) => [row.code, row.label] as const),
  "'unmapped:' || r.type_code::text",
);

const REVENUE_ERA_SQL = codeCaseSql(
  "r.type_code",
  FANSLY_REVENUE_TYPES.map((row) => [row.code, row.era] as const),
  "null::text",
);

/** Only rows the table can NAME. A code it declares but gives no label reads
 *  `unknown:<code>`, because "we cannot name it" is the honest answer. */
const NOTIFICATION_NAMED_ROWS = FANSLY_NOTIFICATION_TYPES
  .filter((row): row is typeof row & { label: string } => row.label !== null);

const NOTIFICATION_LABEL_SQL = codeCaseSql(
  "n.type_code",
  NOTIFICATION_NAMED_ROWS.map((row) => [row.code, row.label] as const),
  `case when n.type_code between ${FANSLY_NOTIFICATION_ALERT_FAMILY_MIN}
                             and ${FANSLY_NOTIFICATION_ALERT_FAMILY_MAX}
             then ${sqlText(FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL)}
             else 'unknown:' || n.type_code::text end`,
);

const NOTIFICATION_CONFIDENCE_SQL = codeCaseSql(
  "n.type_code",
  NOTIFICATION_NAMED_ROWS.map((row) => [row.code, row.confidence] as const),
  `case when n.type_code between ${FANSLY_NOTIFICATION_ALERT_FAMILY_MIN}
                             and ${FANSLY_NOTIFICATION_ALERT_FAMILY_MAX}
             then 'inferred'
             else null::text end`,
);

/** A stable text key for a bucket row. `to_char` rather than `::text` so the
 *  key does not change with the session's DateStyle. */
const BUCKET_KEY_SQL =
  `to_char(t.bucket_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF00')`;

const TRAFFIC_DAILY = `
  select t.page_id            as k_page_id,
         p.platform::text     as k_platform,
         t.page_id::text || ':' || t.subject_kind || ':' || t.subject_ref || ':'
           || t.period_ms::text || ':' || ${BUCKET_KEY_SQL} || ':' || t.source_code as k_key,
         t.bucket_start       as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         t.subject_kind       as f_subject_kind,
         t.subject_ref        as f_subject_ref,
         t.period_ms          as f_period_ms,
         t.bucket_start       as f_bucket_start,
         t.source_code        as f_source_code,
         ${TRAFFIC_LABEL_SQL} as f_source_label,
         t.mapping_version    as f_mapping_version,
         ${TRAFFIC_FAMILY_SQL} as f_family,
         ${TRAFFIC_MEASURE_SQL} as f_measure,
         t.views              as f_views,
         t.preview_views      as f_preview_views,
         t.unique_viewers     as f_unique_viewers,
         t.preview_unique_viewers as f_preview_unique_viewers,
         t.interaction_time_ms as f_interaction_time_ms,
         t.preview_interaction_time_ms as f_preview_interaction_time_ms
  from stats_traffic_buckets t
  join pages p on p.id = t.page_id
  where t.subject_kind in ('account_profile', 'account_media')
`;

const MEDIA_STATS = `
  select t.page_id            as k_page_id,
         p.platform::text     as k_platform,
         t.page_id::text || ':' || t.subject_ref || ':' || t.period_ms::text || ':'
           || ${BUCKET_KEY_SQL} || ':' || t.source_code as k_key,
         t.bucket_start       as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         t.subject_ref        as f_media_offer_ref,
         m.media_type         as f_media_type,
         m.mime_type          as f_mime_type,
         m.duration_ms        as f_duration_ms,
         t.period_ms          as f_period_ms,
         t.bucket_start       as f_bucket_start,
         t.source_code        as f_source_code,
         ${MEDIA_LABEL_SQL}   as f_source_label,
         t.mapping_version    as f_mapping_version,
         t.views              as f_views,
         t.preview_views      as f_preview_views,
         t.unique_viewers     as f_unique_viewers,
         t.preview_unique_viewers as f_preview_unique_viewers,
         t.interaction_time_ms as f_interaction_time_ms,
         t.preview_interaction_time_ms as f_preview_interaction_time_ms,
         m.price_mills        as f_price_mills,
         m.sales_count        as f_sales_count,
         m.sales_net_mills    as f_sales_net_mills,
         -- A12: net / 0.8, DERIVED here and never stored. Null in stays null
         -- out — an unserved sale total is not a sale of zero.
         case when m.sales_net_mills is null then null
              else (m.sales_net_mills * 5 + 2) / 4 end as f_sales_gross_mills_derived
  from stats_traffic_buckets t
  join pages p on p.id = t.page_id
  left join creator_media m
    on m.page_id = t.page_id and m.media_offer_ref = t.subject_ref
  where t.subject_kind = 'media_offer'
`;

const TOP_MEDIA = `
  select tm.page_id           as k_page_id,
         p.platform::text     as k_platform,
         tm.page_id::text || ':' || tm.plane || ':' || tm.period_ms::text || ':'
           || to_char(tm.requested_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF00')
           || ':' || to_char(tm.requested_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF00')
           || ':' || tm.media_offer_ref as k_key,
         tm.requested_end     as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         tm.plane             as f_plane,
         tm.rank              as f_rank,
         tm.media_offer_ref   as f_media_offer_ref,
         tm.bundle_ref        as f_bundle_ref,
         tm.period_ms         as f_period_ms,
         tm.requested_start   as f_requested_start,
         tm.requested_end     as f_requested_end,
         tm.views             as f_views,
         tm.preview_views     as f_preview_views,
         tm.interaction_time_ms as f_interaction_time_ms,
         tm.preview_interaction_time_ms as f_preview_interaction_time_ms,
         tm.observed_at       as f_observed_at
  from stats_top_media tm
  join pages p on p.id = tm.page_id
`;

const TOP_TAGS = `
  select tt.page_id           as k_page_id,
         p.platform::text     as k_platform,
         tt.page_id::text || ':' || tt.plane || ':' || tt.period_ms::text || ':'
           || to_char(tt.requested_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF00')
           || ':' || to_char(tt.requested_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSOF00')
           || ':' || tt.tag_ref as k_key,
         tt.requested_end     as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         tt.plane             as f_plane,
         tt.rank              as f_rank,
         tt.tag_ref           as f_tag_ref,
         tt.tag_name          as f_tag_name,
         tt.period_ms         as f_period_ms,
         tt.requested_start   as f_requested_start,
         tt.requested_end     as f_requested_end,
         tt.views             as f_views,
         tt.preview_views     as f_preview_views,
         tt.interaction_time_ms as f_interaction_time_ms,
         tt.preview_interaction_time_ms as f_preview_interaction_time_ms,
         tt.observed_at       as f_observed_at
  from stats_top_tags tt
  join pages p on p.id = tt.page_id
`;

const REVENUE_MIX = `
  select r.page_id            as k_page_id,
         p.platform::text     as k_platform,
         r.page_id::text || ':' || r.business_date::text || ':' || r.type_code::text as k_key,
         r.business_date::timestamptz as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         r.business_date::text as f_business_date,
         r.type_code          as f_type_code,
         ${REVENUE_LABEL_SQL} as f_type_label,
         ${REVENUE_ERA_SQL}   as f_type_era,
         ${FANSLY_REVENUE_LABEL_VERSION}::int as f_mapping_version,
         r.gross_mills        as f_gross_mills,
         r.net_mills          as f_net_mills,
         r.last_observed_at   as f_last_observed_at
  from revenue_mix_daily r
  join pages p on p.id = r.page_id
`;

const MESSAGE_MEDIA_SALES = `
  select o.page_id            as k_page_id,
         p.platform::text     as k_platform,
         o.page_id::text || ':' || o.message_ref || ':' || o.offer_ordinal::text as k_key,
         o.message_created_at as k_occurred_at,
         o.fan_platform_user_id as k_fan,
         p.platform::text     as f_platform,
         o.message_ref        as f_message_ref,
         o.conversation_ref   as f_conversation_ref,
         o.offer_ordinal      as f_offer_ordinal,
         o.media_offer_ref    as f_media_offer_ref,
         o.bundle_ref         as f_bundle_ref,
         o.offer_type         as f_offer_type,
         o.mime_type          as f_mime_type,
         o.duration_ms        as f_duration_ms,
         o.price_mills        as f_price_mills,
         o.purchase_state     as f_purchase_state,
         o.order_ref          as f_order_ref,
         o.sales_count        as f_sales_count,
         o.sales_net_mills    as f_sales_net_mills,
         o.fan_platform_user_id as f_fan_platform_user_id,
         o.message_created_at as f_message_created_at,
         o.last_observed_at   as f_last_observed_at
  from message_media_offers o
  join pages p on p.id = o.page_id
`;

const POST_COMMENTS_DATASET = `
  select c.page_id            as k_page_id,
         p.platform::text     as k_platform,
         c.id::text           as k_key,
         c.occurred_at        as k_occurred_at,
         c.author_ref         as k_fan,
         p.platform::text     as f_platform,
         c.comment_ref        as f_comment_ref,
         c.parent_post_ref    as f_parent_post_ref,
         c.root_post_ref      as f_root_post_ref,
         c.author_ref         as f_author_ref,
         c.author_username    as f_author_username,
         c.text_plain         as f_comment_text,
         c.like_count         as f_like_count,
         c.tip_total_mills    as f_tip_total_mills,
         c.attachment_tip_mills as f_attachment_tip_mills,
         c.attachment_count   as f_attachment_count,
         c.occurred_at        as f_occurred_at,
         c.changed_at         as f_changed_at,
         c.discovered_via     as f_discovered_via,
         c.possibly_truncated as f_possibly_truncated,
         c.missing_since      as f_missing_since
  from post_comments c
  join pages p on p.id = c.page_id
`;

const POST_LIKES_DATASET = `
  select l.page_id            as k_page_id,
         p.platform::text     as k_platform,
         l.page_id::text || ':' || l.subject_kind || ':' || l.subject_ref || ':'
           || l.liker_platform_user_id as k_key,
         l.occurred_at        as k_occurred_at,
         l.liker_platform_user_id as k_fan,
         p.platform::text     as f_platform,
         l.subject_kind       as f_subject_kind,
         l.subject_ref        as f_subject_ref,
         l.liker_platform_user_id as f_liker_platform_user_id,
         l.state              as f_state,
         l.occurred_at        as f_occurred_at,
         l.discovered_via     as f_discovered_via
  from post_likes l
  join pages p on p.id = l.page_id
`;

const VAULT_MEDIA = `
  select vm.page_id           as k_page_id,
         p.platform::text     as k_platform,
         vm.page_id::text || ':' || vm.vault_kind || ':' || vm.album_ref || ':' || vm.media_ref as k_key,
         vm.first_observed_at as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         vm.vault_kind        as f_vault_kind,
         vm.album_ref         as f_album_ref,
         va.title             as f_album_title,
         scan.completed_at    as f_last_full_walk_at,
         scan.walk_ref        as f_full_walk_ref,
         cardinality(scan.seen_media_refs) as f_full_walk_observed_count,
         vm.custom_filename   as f_custom_filename,
         rm.filename          as f_filename,
         rm.mime_type         as f_mime_type,
         rm.duration_ms       as f_duration_ms,
         rm.original_width    as f_original_width,
         rm.original_height   as f_original_height,
         vm.media_ref         as f_media_ref,
         vm.media_offer_ref   as f_media_offer_ref,
         vm.member_ref        as f_member_ref,
         vm.media_type        as f_media_type,
         vm.bundle_ref        as f_bundle_ref,
         vm.created_at_platform as f_created_at_platform,
         vm.missing_since     as f_missing_since,
         vm.first_observed_at as f_first_observed_at,
         vm.last_observed_at  as f_last_observed_at,
         greatest(vm.updated_at, va.updated_at, rm.updated_at, scan.updated_at) as f_row_updated_at
  from creator_vault_album_members vm
  join pages p on p.id = vm.page_id
  left join creator_vault_albums va
    on va.page_id = vm.page_id and va.vault_kind = vm.vault_kind and va.album_ref = vm.album_ref
  left join creator_raw_media rm on rm.page_id = vm.page_id and rm.media_ref = vm.media_ref
  left join creator_vault_album_scans scan
    on scan.page_id = vm.page_id and scan.vault_kind = vm.vault_kind and scan.album_ref = vm.album_ref
`;

const PLATFORM_NOTIFICATIONS = `
  select n.page_id            as k_page_id,
         p.platform::text     as k_platform,
         n.page_id::text || ':' || n.notification_ref as k_key,
         n.occurred_at        as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         n.notification_ref   as f_notification_ref,
         n.type_code          as f_type_code,
         ${NOTIFICATION_LABEL_SQL} as f_type_label,
         ${NOTIFICATION_CONFIDENCE_SQL} as f_type_confidence,
         ${FANSLY_NOTIFICATION_LABEL_VERSION}::int as f_mapping_version,
         n.correlation_ref    as f_correlation_ref,
         n.correlation_group_ref as f_correlation_group_ref,
         n.occurred_at        as f_occurred_at,
         n.acknowledged_at    as f_acknowledged_at
  from platform_notifications n
  join pages p on p.id = n.page_id
`;

const SUBSCRIPTION_TIERS = `
  select ti.page_id           as k_page_id,
         p.platform::text     as k_platform,
         ti.page_id::text || ':' || ti.tier_ref || ':' || coalesce(pl.plan_ref, '') as k_key,
         coalesce(pl.last_observed_at, ti.last_observed_at) as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         ti.tier_ref          as f_tier_ref,
         ti.name              as f_tier_name,
         ti.pos               as f_tier_pos,
         ti.base_price_mills  as f_base_price_mills,
         ti.max_subscribers   as f_max_subscribers,
         pl.plan_ref          as f_plan_ref,
         pl.status            as f_plan_status,
         pl.duration_days     as f_duration_days,
         pl.price_mills       as f_price_mills,
         jsonb_array_length(coalesce(pl.promos, '[]'::jsonb)) as f_promo_count,
         coalesce(pl.missing_since, ti.missing_since) as f_missing_since,
         coalesce(pl.last_observed_at, ti.last_observed_at) as f_last_observed_at
  from page_subscription_tiers ti
  join pages p on p.id = ti.page_id
  left join page_subscription_tier_plans pl
    on pl.page_id = ti.page_id and pl.tier_ref = ti.tier_ref
`;

const PAYOUTS = `
  select pr.page_id           as k_page_id,
         p.platform::text     as k_platform,
         pr.page_id::text || ':' || pr.payout_ref as k_key,
         pr.requested_at      as k_occurred_at,
         null::text           as k_fan,
         p.platform::text     as f_platform,
         pr.payout_ref        as f_payout_ref,
         pr.amount_mills      as f_amount_mills,
         pr.status_code       as f_status_code,
         pr.status_label      as f_status_label,
         pr.status_confidence as f_status_confidence,
         pr.method_ref        as f_method_ref,
         pm.provider_id       as f_method_provider_id,
         pm.provider_label    as f_method_provider_label,
         -- OURS, never the provider's. \`metadata\` is deliberately not joined:
         -- provider 2 (Paxum) returns a plaintext email address there.
         pm.masked_label      as f_method_masked_label,
         pr.requested_at      as f_requested_at,
         pr.updated_at_platform as f_updated_at_platform
  from page_payout_requests pr
  join pages p on p.id = pr.page_id
  left join page_payout_methods pm
    on pm.page_id = pr.page_id and pm.method_ref = pr.method_ref
`;

const CAPTURE_COVERAGE = `
  select cc.page_id           as k_page_id,
         cc.platform::text    as k_platform,
         cc.page_id::text || ':' || cc.plane || ':' || cc.scope_ref as k_key,
         cc.updated_at        as k_occurred_at,
         null::text           as k_fan,
         cc.platform::text    as f_platform,
         cc.plane             as f_plane,
         cc.scope_ref         as f_scope_ref,
         cc.status            as f_status,
         cc.acquisition_mode  as f_acquisition_mode,
         cc.proof             as f_proof,
         cc.oldest_captured_at as f_oldest_captured_at,
         cc.newest_captured_at as f_newest_captured_at,
         cc.expected_count    as f_expected_count,
         cc.observed_unique_count as f_observed_unique_count,
         cc.reason_code       as f_reason_code,
         cc.next_probe_at     as f_next_probe_at,
         cc.updated_at        as f_updated_at
  from capture_coverage cc
`;

export const AGENT_DATASET_SQL: Readonly<Record<string, AgentDatasetSqlMapping>> = {
  ofapi_financial_snapshots: {
    source: `select s.page_id k_page_id,'onlyfans'::text k_platform,
      concat(s.id,':',i.ordinality,':',m.ordinality) k_key,s.observed_at k_occurred_at,null::text k_fan,
      'onlyfans'::text f_platform,'onlyfansapi'::text f_source,s.operation f_operation,
      m.value->>'path' f_metric_path,m.value->>'unit' f_unit,m.value->>'value' f_raw_value,
      (m.value->>'valueMills')::bigint f_value_mills,
      coalesce(s.query->>'start_date',s.query->>'startDate')::timestamptz f_window_from,
      coalesce(s.query->>'end_date',s.query->>'endDate')::timestamptz f_window_to,
      s.granularity f_granularity,s.observed_at f_observed_at,
      s.coverage->>'state' f_coverage_state,s.coverage->>'reason' f_coverage_reason,
      s.observation_id::text f_observation_ref
      from ofapi_read_snapshots s
      cross join lateral jsonb_array_elements(s.items) with ordinality i(value,ordinality)
      cross join lateral jsonb_array_elements(coalesce(i.value->'metrics','[]'::jsonb)) with ordinality m(value,ordinality)
      where s.category='balances'`,
    fields:{platform:"f_platform",source:"f_source",operation:"f_operation",metricPath:"f_metric_path",unit:"f_unit",rawValue:"f_raw_value",valueMills:"f_value_mills",windowFrom:"f_window_from",windowTo:"f_window_to",granularity:"f_granularity",observedAt:"f_observed_at",coverageState:"f_coverage_state",coverageReason:"f_coverage_reason",observationRef:"f_observation_ref"},
    windowColumn:"k_occurred_at",readPlanes:["ofapi_read_snapshots"],captureFloorPlane:"ofapi_read_snapshots",
  },
  ofapi_payout_requests: {
    // One row per invoice; the newest observation wins because a request's
    // state moves (new -> done/rejected) while its id stays. The window and the
    // floor run on requestedAt, so the floor is the oldest request Hub holds.
    source: `select distinct on (s.page_id, i.value->>'nativeId')
      s.page_id k_page_id,'onlyfans'::text k_platform,
      concat(s.page_id,':',i.value->>'nativeId') k_key,
      case when i.value->>'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'
        then (i.value->>'occurredAt')::timestamptz end k_occurred_at,
      null::text k_fan,
      'onlyfans'::text f_platform,
      i.value->>'nativeId' f_payout_ref,
      case when i.value#>>'{attributes,amount,unit}'='mills'
        then (i.value#>>'{attributes,amount,value}')::bigint end f_amount_mills,
      i.value#>>'{attributes,currency}' f_currency,
      i.value#>>'{attributes,state}' f_state,
      i.value#>>'{attributes,rejectReason}' f_reject_reason,
      case when i.value->>'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}'
        then (i.value->>'occurredAt')::timestamptz end f_requested_at,
      s.observed_at f_last_observed_at,
      s.observation_id::text f_observation_ref
      from ofapi_read_snapshots s
      cross join lateral jsonb_array_elements(s.items) i(value)
      where s.operation='ofapi_read_payout_requests' and coalesce(i.value->>'nativeId','')<>''
      order by s.page_id, i.value->>'nativeId', s.observed_at desc, s.id desc`,
    fields:{platform:"f_platform",payoutRef:"f_payout_ref",amountMills:"f_amount_mills",currency:"f_currency",state:"f_state",rejectReason:"f_reject_reason",requestedAt:"f_requested_at",lastObservedAt:"f_last_observed_at",observationRef:"f_observation_ref"},
    windowColumn:"k_occurred_at",readPlanes:["ofapi_read_snapshots"],captureFloorPlane:"ofapi_read_snapshots",
  },
  fan_memberships: {
    source: FAN_MEMBERSHIPS,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      username: "f_username",
      displayName: "f_display_name",
      membershipState: "f_membership_state",
      firstSeenAt: "f_first_seen_at",
      lastSeenAt: "f_last_seen_at",
      lifetimeSpendMills: "f_lifetime_spend_mills",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_fans", "fans"],
  },
  dm_threads: {
    source: DM_THREADS,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      conversationRef: "f_conversation_ref",
      lastMessageAt: "f_last_message_at",
      messageCount: "f_message_count",
      unreadCount: "f_unread_count",
      coverageStatus: "f_coverage_status",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_dm_threads", "fans"],
  },
  subscriptions: {
    source: SUBSCRIPTIONS,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      subscriptionRef: "f_subscription_ref",
      subscriptionState: "f_subscription_state",
      startedAt: "f_started_at",
      expiresAt: "f_expires_at",
      priceMills: "f_price_mills",
      currency: "f_currency",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_subscriptions", "fans"],
  },
  subscription_events: {
    source: SUBSCRIPTION_EVENTS,
    fields: {
      occurredAt: "f_occurred_at",
      fanId: "f_fan_id",
      phase: "f_phase",
      subType: "f_sub_type",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["domain_events", "fans", "page_fans"],
    captureFloorPlane: "domain_events",
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
  },
  transactions: {
    source: TRANSACTIONS,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      transactionRef: "f_transaction_ref",
      transactionType: "f_transaction_type",
      transactionState: "f_transaction_state",
      occurredAt: "f_occurred_at",
      grossMills: "f_gross_mills",
      netMills: "f_net_mills",
      feeMills: "f_fee_mills",
      currency: "f_currency",
      relatedMessageRef: "f_related_message_ref",
      correlationRef: "f_correlation_ref",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["transactions", "fans"],
    captureFloorPlane: "transactions",
    eligibilityColumn: "k_eligible",
  },
  tip_transactions: {
    source: TIP_TRANSACTIONS,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      transactionRef: "f_transaction_ref",
      transactionType: "f_transaction_type",
      transactionState: "f_transaction_state",
      occurredAt: "f_occurred_at",
      grossMills: "f_gross_mills",
      netMills: "f_net_mills",
      feeMills: "f_fee_mills",
      currency: "f_currency",
      correlationRef: "f_correlation_ref",
      contextState: "f_context_state",
      capturedConversationRef: "f_captured_conversation_ref",
      tipMessageText: "f_tip_message_text",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["transactions", "transaction_tip_contexts", "fans"],
    captureFloorPlane: "transactions",
    eligibilityColumn: "k_eligible",
    internalCaptureGap: {
      column: "k_context_captured",
      plane: "transaction_tip_contexts",
      platform: "fansly",
    },
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
  },
  fan_spend_daily: {
    source: FAN_SPEND_DAILY,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      businessDate: "f_business_date",
      grossMills: "f_gross_mills",
      netMills: "f_net_mills",
      transactionCount: "f_transaction_count",
      currency: "f_currency",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["fan_spend_daily", "fans"],
  },
  follows: {
    source: FOLLOWS,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      followed: "f_followed",
      followedAt: "f_followed_at",
      unfollowedAt: "f_unfollowed_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_follows", "fans"],
  },
  followers_daily: {
    source: FOLLOWERS_DAILY,
    fields: {
      platform: "f_platform",
      businessDate: "f_business_date",
      followersCount: "f_followers_count",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["daily_followers"],
  },
  fan_aliases: {
    source: FAN_ALIASES,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      aliasKind: "f_alias_kind",
      aliasValue: "f_alias_value",
      firstSeenAt: "f_first_seen_at",
      lastSeenAt: "f_last_seen_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_fan_aliases", "fan_username_aliases", "fans", "page_fans"],
  },
  fan_notes: {
    source: FAN_NOTES,
    fields: {
      platform: "f_platform",
      platformUserId: "f_platform_user_id",
      noteRef: "f_note_ref",
      noteText: "f_note_text",
      createdAt: "f_created_at",
      updatedAt: "f_updated_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["fan_notes", "fans"],
  },
  posts: {
    source: CREATOR_POSTS,
    fields: {
      platform: "f_platform",
      postRef: "f_post_ref",
      postText: "f_post_text",
      publishedAt: "f_published_at",
      firstObservedAt: "f_first_observed_at",
      lastObservedAt: "f_last_observed_at", rowUpdatedAt: "f_row_updated_at",
      attachmentCount: "f_attachment_count",
      fypFlags: "f_fyp_flags",
      inReplyToRef: "f_in_reply_to_ref",
      wallRefs: "f_wall_refs",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_posts"],
    captureFloorPlane: "creator_posts",
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
  },
  raw_media: {
    source: RAW_MEDIA_DATASET,
    fields: {
      platform: "f_platform", mediaRef: "f_media_ref", ownerAccountRef: "f_owner_account_ref",
      filename: "f_filename", mimeType: "f_mime_type", mediaType: "f_media_type", providerType: "f_provider_type", durationMs: "f_duration_ms",
      width: "f_width", height: "f_height", originalWidth: "f_original_width", originalHeight: "f_original_height",
      frameRateMilli: "f_frame_rate_milli", createdAtPlatform: "f_created_at_platform",
      updatedAtPlatform: "f_updated_at_platform", firstOrigin: "f_first_origin", sourceKind: "f_source_kind",
      firstObservedAt: "f_first_observed_at", lastObservedAt: "f_last_observed_at", rowUpdatedAt: "f_row_updated_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_raw_media"],
    provenanceColumns: { observationRef: "k_observation_ref", ingestPath: "k_ingest_path", convergence: "k_convergence" },
  },
  post_attachments: {
    source: POST_ATTACHMENTS_DATASET,
    fields: {
      platform: "f_platform", postRef: "f_post_ref", publishedAt: "f_published_at",
      attachmentIndex: "f_attachment_index", pos: "f_pos", contentType: "f_content_type", contentRef: "f_content_ref",
      role: "f_role", memberIndex: "f_member_index", bundleRef: "f_bundle_ref", mediaOfferRef: "f_media_offer_ref",
      previewRef: "f_preview_ref", mediaRef: "f_media_ref", linkState: "f_link_state",
      filename: "f_filename", mimeType: "f_mime_type", durationMs: "f_duration_ms",
      originalWidth: "f_original_width", originalHeight: "f_original_height", lastObservedAt: "f_last_observed_at", rowUpdatedAt: "f_row_updated_at",
      postObservationRef: "f_post_observation_ref", offerObservationRef: "f_offer_observation_ref",
      bundleObservationRef: "f_bundle_observation_ref", fileObservationRef: "f_file_observation_ref",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_posts", "creator_media", "creator_media_bundles", "creator_raw_media"],
    captureFloorPlane: "creator_posts",
    internalCaptureGap: { column: "k_link_complete", plane: "creator_raw_media" },
    provenanceColumns: { observationRef: "k_observation_ref", ingestPath: "k_ingest_path", convergence: "k_convergence" },
  },
  post_monetization: {
    source: POST_MONETIZATION,
    fields: {
      platform: "f_platform",
      postRef: "f_post_ref",
      publishedAt: "f_published_at",
      lastObservedAt: "f_last_observed_at",
      postTargetTipAmountMills: "f_post_target_tip_amount_mills",
      attachmentTipAmountMills: "f_attachment_tip_amount_mills",
      postTipTotalMills: "f_post_tip_total_mills",
      tipGoalLinked: "f_tip_goal_linked",
      tipGoalRef: "f_tip_goal_ref",
      tipGoalLabelText: "f_tip_goal_label_text",
      tipGoalTargetMills: "f_tip_goal_target_mills",
      tipGoalCurrentMills: "f_tip_goal_current_mills",
      tipGoalAmountsHidden: "f_tip_goal_amounts_hidden",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_posts"],
    captureFloorPlane: "creator_posts",
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
  },
  post_tips: {
    source: CREATOR_POST_TIPS,
    fields: {
      platform: "f_platform",
      postTipPostRef: "f_post_tip_post_ref",
      postTipRef: "f_post_tip_ref",
      tipSenderPlatformUserId: "f_tip_sender_platform_user_id",
      postTipOccurredAt: "f_post_tip_occurred_at",
      postTipAmountMills: "f_post_tip_amount_mills",
      receiverTransactionRef: "f_receiver_transaction_ref",
      postTipGoalRef: "f_post_tip_goal_ref",
      postTipMessageText: "f_post_tip_message_text",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_post_tips"],
    captureFloorPlane: "creator_post_tips",
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
  },
  tip_goals: {
    source: TIP_GOALS,
    fields: {
      platform: "f_platform",
      tipGoalRef: "f_tip_goal_ref",
      tipGoalLabelText: "f_tip_goal_label_text",
      tipGoalTargetMills: "f_tip_goal_target_mills",
      tipGoalCurrentMills: "f_tip_goal_current_mills",
      tipGoalAmountsHidden: "f_tip_goal_amounts_hidden",
      lastObservedAt: "f_last_observed_at",
      linkedPostCount: "f_linked_post_count",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_posts"],
    // This source is ranked and goal-only: min(k_occurred_at) would be the
    // oldest WINNING goal snapshot, not the physical creator_posts floor.
    // Keep the named plane's floor unknown instead of manufacturing a later
    // floor (and a false before_capture_floor gap) from a derived view.
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
  },
  // ── endpoints-cover (WP-S1) ────────────────────────────────────────────────
  // Every mapping below declares a NON-EMPTY `readPlanes` and a
  // `captureFloorPlane`. `readPlanes: []` would have been the path of least
  // resistance and is forbidden for these: it silently turns off the
  // capture-floor epistemics, and an empty answer with no floor is exactly the
  // "asked about January, got nothing, concluded nothing happened" failure the
  // whole plane exists to prevent.
  traffic_daily: {
    source: TRAFFIC_DAILY,
    fields: {
      platform: "f_platform",
      subjectKind: "f_subject_kind",
      subjectRef: "f_subject_ref",
      periodMs: "f_period_ms",
      bucketStart: "f_bucket_start",
      sourceCode: "f_source_code",
      sourceLabel: "f_source_label",
      mappingVersion: "f_mapping_version",
      family: "f_family",
      measure: "f_measure",
      views: "f_views",
      previewViews: "f_preview_views",
      uniqueViewers: "f_unique_viewers",
      previewUniqueViewers: "f_preview_unique_viewers",
      interactionTimeMs: "f_interaction_time_ms",
      previewInteractionTimeMs: "f_preview_interaction_time_ms",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["stats_traffic_buckets"],
    captureFloorPlane: "stats_traffic_buckets",
  },
  media_stats: {
    source: MEDIA_STATS,
    fields: {
      platform: "f_platform",
      mediaOfferRef: "f_media_offer_ref",
      mediaType: "f_media_type",
      mimeType: "f_mime_type",
      durationMs: "f_duration_ms",
      periodMs: "f_period_ms",
      bucketStart: "f_bucket_start",
      sourceCode: "f_source_code",
      sourceLabel: "f_source_label",
      mappingVersion: "f_mapping_version",
      views: "f_views",
      previewViews: "f_preview_views",
      uniqueViewers: "f_unique_viewers",
      previewUniqueViewers: "f_preview_unique_viewers",
      interactionTimeMs: "f_interaction_time_ms",
      previewInteractionTimeMs: "f_preview_interaction_time_ms",
      priceMills: "f_price_mills",
      salesCount: "f_sales_count",
      salesNetMills: "f_sales_net_mills",
      salesGrossMillsDerived: "f_sales_gross_mills_derived",
    },
    windowColumn: "k_occurred_at",
    // The catalogue head is a LEFT join and is an inventory store: a bucket can
    // arrive before the media row exists. The floor therefore belongs to the
    // temporal plane, and `creator_media` stays a read plane with no floor.
    readPlanes: ["stats_traffic_buckets", "creator_media"],
    captureFloorPlane: "stats_traffic_buckets",
  },
  top_media: {
    source: TOP_MEDIA,
    fields: {
      platform: "f_platform",
      plane: "f_plane",
      rank: "f_rank",
      mediaOfferRef: "f_media_offer_ref",
      bundleRef: "f_bundle_ref",
      periodMs: "f_period_ms",
      requestedStart: "f_requested_start",
      requestedEnd: "f_requested_end",
      views: "f_views",
      previewViews: "f_preview_views",
      interactionTimeMs: "f_interaction_time_ms",
      previewInteractionTimeMs: "f_preview_interaction_time_ms",
      observedAt: "f_observed_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["stats_top_media"],
    captureFloorPlane: "stats_top_media",
  },
  top_tags: {
    source: TOP_TAGS,
    fields: {
      platform: "f_platform",
      plane: "f_plane",
      rank: "f_rank",
      tagRef: "f_tag_ref",
      tagName: "f_tag_name",
      periodMs: "f_period_ms",
      requestedStart: "f_requested_start",
      requestedEnd: "f_requested_end",
      views: "f_views",
      previewViews: "f_preview_views",
      interactionTimeMs: "f_interaction_time_ms",
      previewInteractionTimeMs: "f_preview_interaction_time_ms",
      observedAt: "f_observed_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["stats_top_tags"],
    captureFloorPlane: "stats_top_tags",
  },
  revenue_mix: {
    source: REVENUE_MIX,
    fields: {
      platform: "f_platform",
      businessDate: "f_business_date",
      typeCode: "f_type_code",
      typeLabel: "f_type_label",
      typeEra: "f_type_era",
      mappingVersion: "f_mapping_version",
      grossMills: "f_gross_mills",
      netMills: "f_net_mills",
      lastObservedAt: "f_last_observed_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["revenue_mix_daily"],
    captureFloorPlane: "revenue_mix_daily",
  },
  message_media_sales: {
    source: MESSAGE_MEDIA_SALES,
    fields: {
      platform: "f_platform",
      messageRef: "f_message_ref",
      conversationRef: "f_conversation_ref",
      offerOrdinal: "f_offer_ordinal",
      mediaOfferRef: "f_media_offer_ref",
      bundleRef: "f_bundle_ref",
      offerType: "f_offer_type",
      mimeType: "f_mime_type",
      durationMs: "f_duration_ms",
      priceMills: "f_price_mills",
      purchaseState: "f_purchase_state",
      orderRef: "f_order_ref",
      salesCount: "f_sales_count",
      salesNetMills: "f_sales_net_mills",
      fanPlatformUserId: "f_fan_platform_user_id",
      messageCreatedAt: "f_message_created_at",
      lastObservedAt: "f_last_observed_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["message_media_offers"],
    captureFloorPlane: "message_media_offers",
  },
  comments: {
    source: POST_COMMENTS_DATASET,
    fields: {
      platform: "f_platform",
      commentRef: "f_comment_ref",
      parentPostRef: "f_parent_post_ref",
      rootPostRef: "f_root_post_ref",
      authorRef: "f_author_ref",
      authorUsername: "f_author_username",
      commentText: "f_comment_text",
      likeCount: "f_like_count",
      tipTotalMills: "f_tip_total_mills",
      attachmentTipMills: "f_attachment_tip_mills",
      attachmentCount: "f_attachment_count",
      occurredAt: "f_occurred_at",
      changedAt: "f_changed_at",
      discoveredVia: "f_discovered_via",
      possiblyTruncated: "f_possibly_truncated",
      missingSince: "f_missing_since",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["post_comments"],
    captureFloorPlane: "post_comments",
  },
  likes: {
    source: POST_LIKES_DATASET,
    fields: {
      platform: "f_platform",
      subjectKind: "f_subject_kind",
      subjectRef: "f_subject_ref",
      likerPlatformUserId: "f_liker_platform_user_id",
      state: "f_state",
      occurredAt: "f_occurred_at",
      discoveredVia: "f_discovered_via",
    },
    windowColumn: "k_occurred_at",
    // The plane is declared even though the table is EMPTY on Fansly: that is
    // the difference between "we looked and there is nothing" and "nobody ever
    // built this", and the floor coming back `unknown` is the honest signal.
    readPlanes: ["post_likes"],
    captureFloorPlane: "post_likes",
  },
  vault_media: {
    source: VAULT_MEDIA,
    fields: {
      platform: "f_platform",
      vaultKind: "f_vault_kind",
      albumRef: "f_album_ref",
      albumTitle: "f_album_title",
      lastFullWalkAt: "f_last_full_walk_at",
      fullWalkRef: "f_full_walk_ref",
      fullWalkObservedCount: "f_full_walk_observed_count",
      customFilename: "f_custom_filename",
      filename: "f_filename",
      mimeType: "f_mime_type",
      durationMs: "f_duration_ms",
      originalWidth: "f_original_width",
      originalHeight: "f_original_height",
      mediaRef: "f_media_ref",
      mediaOfferRef: "f_media_offer_ref",
      memberRef: "f_member_ref",
      mediaType: "f_media_type",
      bundleRef: "f_bundle_ref",
      createdAtPlatform: "f_created_at_platform",
      missingSince: "f_missing_since",
      firstObservedAt: "f_first_observed_at",
      lastObservedAt: "f_last_observed_at", rowUpdatedAt: "f_row_updated_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["creator_vault_album_members", "creator_vault_albums", "creator_raw_media", "creator_vault_album_scans"],
    captureFloorPlane: "creator_vault_album_members",
  },
  notifications: {
    source: PLATFORM_NOTIFICATIONS,
    fields: {
      platform: "f_platform",
      notificationRef: "f_notification_ref",
      typeCode: "f_type_code",
      typeLabel: "f_type_label",
      typeConfidence: "f_type_confidence",
      mappingVersion: "f_mapping_version",
      correlationRef: "f_correlation_ref",
      correlationGroupRef: "f_correlation_group_ref",
      occurredAt: "f_occurred_at",
      acknowledgedAt: "f_acknowledged_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["platform_notifications"],
    captureFloorPlane: "platform_notifications",
  },
  subscription_tiers: {
    source: SUBSCRIPTION_TIERS,
    fields: {
      platform: "f_platform",
      tierRef: "f_tier_ref",
      tierName: "f_tier_name",
      tierPos: "f_tier_pos",
      basePriceMills: "f_base_price_mills",
      maxSubscribers: "f_max_subscribers",
      planRef: "f_plan_ref",
      planStatus: "f_plan_status",
      durationDays: "f_duration_days",
      priceMills: "f_price_mills",
      promoCount: "f_promo_count",
      missingSince: "f_missing_since",
      lastObservedAt: "f_last_observed_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_subscription_tiers", "page_subscription_tier_plans"],
    // The PLAN is where the price lives, and a tier with no plan row still
    // appears (LEFT join) — so the floor is the tier head's, which is the one
    // store every row of this dataset has.
    captureFloorPlane: "page_subscription_tiers",
  },
  payouts: {
    source: PAYOUTS,
    fields: {
      platform: "f_platform",
      payoutRef: "f_payout_ref",
      amountMills: "f_amount_mills",
      statusCode: "f_status_code",
      statusLabel: "f_status_label",
      statusConfidence: "f_status_confidence",
      methodRef: "f_method_ref",
      methodProviderId: "f_method_provider_id",
      methodProviderLabel: "f_method_provider_label",
      methodMaskedLabel: "f_method_masked_label",
      requestedAt: "f_requested_at",
      updatedAtPlatform: "f_updated_at_platform",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["page_payout_requests", "page_payout_methods"],
    captureFloorPlane: "page_payout_requests",
  },
  capture_coverage: {
    source: CAPTURE_COVERAGE,
    fields: {
      platform: "f_platform",
      plane: "f_plane",
      scopeRef: "f_scope_ref",
      status: "f_status",
      acquisitionMode: "f_acquisition_mode",
      proof: "f_proof",
      oldestCapturedAt: "f_oldest_captured_at",
      newestCapturedAt: "f_newest_captured_at",
      expectedCount: "f_expected_count",
      observedUniqueCount: "f_observed_unique_count",
      reasonCode: "f_reason_code",
      nextProbeAt: "f_next_probe_at",
      updatedAt: "f_updated_at",
    },
    windowColumn: "k_occurred_at",
    readPlanes: ["capture_coverage"],
    // `min(updated_at)` is when THIS page's coverage bookkeeping begins — a real
    // floor for this plane, and not to be confused with `oldestCapturedAt`,
    // which is the floor of the plane a row DESCRIBES.
    captureFloorPlane: "capture_coverage",
  },
  sync_streams: {
    source: SYNC_STREAMS,
    fields: {
      stream: "f_stream",
      syncStatus: "f_sync_status",
      cursorAt: "f_cursor_at",
      succeededAt: "f_succeeded_at",
      failedAt: "f_failed_at",
      consecutiveFailures: "f_consecutive_failures",
    },
    windowColumn: "k_occurred_at",
    // Sync state is not a claim plane: no claim class answers for it, so this
    // dataset honestly reads NOTHING the registry knows about.
    readPlanes: [],
  },
};

/** Boundary lookup for a dataset name that arrived in a path. Map, not object
 *  indexing: a prototype key must never resolve to a real mapping. */
const MAPPING_BY_NAME: ReadonlyMap<string, AgentDatasetSqlMapping> = new Map(
  Object.entries(AGENT_DATASET_SQL),
);

export function agentDatasetSqlMapping(dataset: string): AgentDatasetSqlMapping | undefined {
  return MAPPING_BY_NAME.get(dataset);
}
