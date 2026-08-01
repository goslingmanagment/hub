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

export interface AgentDatasetSqlMapping {
  /** A complete `select ...` producing the internal vocabulary above. */
  readonly source: string;
  /** Wire field name -> the derived table's column. Values are code constants. */
  readonly fields: Readonly<Record<string, string>>;
  /** The column the `[from, to)` window applies to; every dataset has one. */
  readonly windowColumn: string;
  /** Tiebreak columns appended to every ORDER BY so the keyset is total. */
  readonly stableKeyColumns: readonly string[];
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

/** The wire state of one raw `canonical_status`. The SQL below is generated from
 *  the same list, so a new terminal status cannot reach only one of the two. */
export function agentSubscriptionState(
  canonicalStatus: string | null | undefined,
): "active" | "expired" | "unknown" {
  if (canonicalStatus === "active") {
    return "active";
  }
  return (AGENT_SUBSCRIPTION_EXPIRED_STATUSES as readonly string[])
    .includes(canonicalStatus ?? "")
    ? "expired"
    : "unknown";
}

const SUBSCRIPTION_STATE_SQL = `case
           when s.canonical_status = 'active' then 'active'
           when s.canonical_status in (${
  AGENT_SUBSCRIPTION_EXPIRED_STATUSES.map((status) => `'${status}'`).join(", ")
}) then 'expired'
           else 'unknown'
         end`;

const SUBSCRIPTIONS = `
  select s.platform_account_id as k_page_id,
         p.platform::text      as k_platform,
         s.id::text            as k_key,
         s.ends_at             as k_occurred_at,
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
`;

const TRANSACTIONS = `
  select tr.platform_account_id as k_page_id,
         p.platform::text       as k_platform,
         tr.id::text            as k_key,
         tr.occurred_at         as k_occurred_at,
         f.platform_user_id     as k_fan,
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
         tr.correlation_id      as f_related_message_ref
  from transactions tr
  join pages p on p.id = tr.platform_account_id
  left join fans f on f.id = tr.fan_id
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
         cp.attachment_count    as f_attachment_count
  from creator_posts cp
`;

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
`;

export const AGENT_DATASET_SQL: Readonly<Record<string, AgentDatasetSqlMapping>> = {
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
    stableKeyColumns: ["k_key"],
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
    stableKeyColumns: ["k_key"],
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
    stableKeyColumns: ["k_key"],
    readPlanes: ["page_subscriptions", "fans"],
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
    },
    windowColumn: "k_occurred_at",
    stableKeyColumns: ["k_key"],
    readPlanes: ["transactions", "fans"],
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
    stableKeyColumns: ["k_key"],
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
    stableKeyColumns: ["k_key"],
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
    stableKeyColumns: ["k_key"],
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
    stableKeyColumns: ["k_key"],
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
    stableKeyColumns: ["k_key"],
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
      lastObservedAt: "f_last_observed_at",
      attachmentCount: "f_attachment_count",
    },
    windowColumn: "k_occurred_at",
    stableKeyColumns: ["k_key"],
    readPlanes: ["creator_posts"],
    captureFloorPlane: "creator_posts",
    provenanceColumns: {
      observationRef: "k_observation_ref",
      ingestPath: "k_ingest_path",
      convergence: "k_convergence",
    },
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
    stableKeyColumns: ["k_key"],
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
