BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='2s';
EXPLAIN (FORMAT JSON)
with page as (
	      select p.id as page_id, p.ofapi_account_id
	      from pages p
	      where p.id = 1
	    ),
	    -- Select only refs here, then load EVERY version of those refs below.
	    -- Filtering the wide arms by time would let an older in-window copy win
	    -- when the preferred source moved that message outside the window.
	    window_refs as materialized (
	      select ma.message_ref
	      from message_archive ma
	      where ma.account_id = 1
	        and ma.platform = 'fansly'
	        and ma.conversation_ref = '790634843078664193'
	        and (
	    ma.occurred_at is null or (ma.occurred_at >= '2026-09-07T00:04:57.999Z' and ma.occurred_at < '2026-09-07T00:04:58.001Z')
	  )
	      union
	      select d.platform_message_id as message_ref
	      from dm_message_archive d
	      where d.platform = 'fansly'
	        and d.platform_account_id = 1
	        and d.platform_conversation_id = '790634843078664193'
	        and (
	    d.message_created_at is null or (d.message_created_at >= '2026-09-07T00:04:57.999Z' and d.message_created_at < '2026-09-07T00:04:58.001Z')
	  )
	      union
	      select m.platform_message_id as message_ref
	      from page_dm_messages m
	      join page_dm_threads t on t.id = m.conversation_id
	      where t.platform_account_id = 1
	        and t.platform_conversation_id = '790634843078664193'
	        and (
	    m.created_at is null or (m.created_at >= '2026-09-07T00:04:57.999Z' and m.created_at < '2026-09-07T00:04:58.001Z')
	  )
	    ),
	    archive_arm as (
	      select ma.message_ref,
	             ma.native_message_id::text as native_message_ref,
	             ma.occurred_at as event_time,
	             ma.text_plain,
	             ma.text_html,
	             ma.sender_role::text as sender_role,
	             ma.fan_native_id as sender_hint,
	             ma.is_sent_by_me,
	             ma.price_mills,
	             ma.is_opened,
	             ma.is_new,
	             ma.is_tip,
	             ma.tip_amount_mills,
	             ma.tip_text_plain,
	             ma.in_reply_to_ref,
	             ma.reply_metadata,
	             ma.media_metadata,
	             ma.origin_class,
	             ma.material_observed_at,
	             ma.vendor_changed_at,
	             ma.source_account_seq,
	             ma.serving_contract_version,
	             ma.backfill_source,
	             ma.content_pending,
	             ma.deleted_at,
	             ma.fan_native_id as fan_platform_user_id,
	             'message_archive'::text as source_plane,
	             1 as source_rank
	      from message_archive ma
	      join window_refs r on r.message_ref = ma.message_ref
	      where ma.account_id = 1
	        and ma.platform = 'fansly'
	        and ma.conversation_ref = '790634843078664193'
	    ),
	    -- Structurally OnlyFans-only (ofapi_account_id is NOT NULL there); on Fansly
	    -- this arm simply matches nothing, which is why #6 needs no platform branch.
	    dm_arm as (
	      select d.platform_message_id as message_ref,
	             null::text as native_message_ref,
	             d.message_created_at as event_time,
	             d.text_plain,
	             null::text as text_html,
	             d.sender_role::text as sender_role,
	             d.sender_platform_user_id as sender_hint,
	             d.is_sent_by_me,
	             d.price_mills,
	             d.is_opened,
	             null::boolean as is_new,
	             d.is_tip,
	             d.tip_amount_mills,
	             null::text as tip_text_plain,
	             d.in_reply_to_message_id as in_reply_to_ref,
	             null::jsonb as reply_metadata,
	             d.media_metadata,
	             null::text as origin_class,
	             d.rest_material_observed_at as material_observed_at,
	             d.rest_platform_changed_at as vendor_changed_at,
	             null::bigint as source_account_seq,
	             0 as serving_contract_version,
	             d.source as backfill_source,
	             (d.message_created_at is null) as content_pending,
	             d.deleted_at,
	             d.fan_platform_user_id,
	             'dm_message_archive'::text as source_plane,
	             2 as source_rank
	      from dm_message_archive d
	      join window_refs r on r.message_ref = d.platform_message_id
	      where d.platform = 'fansly'
	        and d.platform_account_id = 1
	        and d.platform_conversation_id = '790634843078664193'
	    ),
	    hot_arm as (
	      select m.platform_message_id as message_ref,
	             null::text as native_message_ref,
	             m.created_at as event_time,
	             m.content as text_plain,
	             null::text as text_html,
	             m.sender_role::text as sender_role,
	             m.sender_platform_user_id as sender_hint,
	             (m.sender_role = 'model') as is_sent_by_me,
	             null::bigint as price_mills,
	             (m.purchased_at is not null) as is_opened,
	             null::boolean as is_new,
	             (m.total_tip_amount_cents > 0) as is_tip,
	             (m.total_tip_amount_cents::bigint * 10) as tip_amount_mills,
	             null::text as tip_text_plain,
	             m.in_reply_to_message_id as in_reply_to_ref,
	             null::jsonb as reply_metadata,
	             '[]'::jsonb as media_metadata,
	             null::text as origin_class,
	             null::timestamptz as material_observed_at,
	             null::timestamptz as vendor_changed_at,
	             null::bigint as source_account_seq,
	             0 as serving_contract_version,
	             null::text as backfill_source,
	             false as content_pending,
	             m.deleted_at,
	             t.partner_platform_user_id as fan_platform_user_id,
	             'page_dm_messages'::text as source_plane,
	             0 as source_rank
	      from page_dm_messages m
	      join page_dm_threads t on t.id = m.conversation_id
	      join window_refs r on r.message_ref = m.platform_message_id
	      where t.platform_account_id = 1
	        and t.platform_conversation_id = '790634843078664193'
	    ),
	    candidates as (
	      select * from archive_arm
	      union all select * from dm_arm
	      union all select * from hot_arm
	    ),
	    candidate_refs as (select distinct c.message_ref from candidates c),
	    -- A delete webhook carries no chat scope, so its tombstone stub has a NULL
	    -- conversation id: it is reachable only through the account-wide unique key.
	    cross_tombstones as (
	      select r.message_ref
	      from candidate_refs r
	      cross join page
	      join dm_message_archive d
	        on d.ofapi_account_id = page.ofapi_account_id
	       and d.platform_message_id = r.message_ref
	      where page.ofapi_account_id is not null
	        and d.deleted_at is not null
	    ),
	    tombstoned as (
	      select c.message_ref from candidates c where c.deleted_at is not null
	      union
	      select ct.message_ref from cross_tombstones ct
	    ),
	    hot_upgrade as (
	      select m.platform_message_id as message_ref, m.purchased_at
	      from page_dm_messages m
	      join page_dm_threads t on t.id = m.conversation_id
	      join window_refs r on r.message_ref = m.platform_message_id
	      where t.platform_account_id = 1
	        and t.platform_conversation_id = '790634843078664193'
	        and m.purchased_at is not null
	    ),
	    -- Dedup happens HERE, before any limit: a page truncated by duplicates would
	    -- under-report and the count would be a lie.
	    best as (
	      select distinct on (c.message_ref) c.*
	      from candidates c
	      order by c.message_ref, c.source_rank desc
	    ),
	    unioned as (
	      select b.*,
	             (b.message_ref in (select t.message_ref from tombstoned t)) as is_tombstoned,
	             case when h.purchased_at is not null then true else b.is_opened end as is_opened_upgraded
	      from best b
	      left join hot_upgrade h on h.message_ref = b.message_ref
	    ),
	    u as (
	      select unioned.*,
	             to_char(unioned.event_time at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as k_sort,
	             unioned.message_ref as k_key
	      from unioned
	    )
	    select u.message_ref,
	           u.native_message_ref,
	           u.event_time,
	           u.text_plain,
	           u.text_html,
	           u.sender_role,
	           u.sender_hint,
	           u.is_sent_by_me,
	           u.price_mills::text as price_mills,
	           u.is_opened_upgraded as is_opened,
	           u.is_new,
	           u.is_tip,
	           u.tip_amount_mills::text as tip_amount_mills,
	           u.tip_text_plain,
	           u.in_reply_to_ref,
	           u.reply_metadata,
	           u.media_metadata,
	           u.origin_class,
	           u.material_observed_at,
	           u.vendor_changed_at,
	           u.source_account_seq::text as source_account_seq,
	           u.serving_contract_version,
	           u.backfill_source,
	           u.content_pending,
	           u.deleted_at,
	           u.fan_platform_user_id,
	           u.source_plane,
	           u.is_tombstoned,
	           u.k_sort,
	           u.k_key
	    from u
	    where (
	    u.event_time is null or (u.event_time >= '2026-09-07T00:04:57.999Z' and u.event_time < '2026-09-07T00:04:58.001Z')
	  )
	      and true
	      and (TRUE or not u.is_tombstoned)
	      and true
	      and (NULL::text is null or u.sender_role = NULL)
	      and true
	      and true
	      and true
	    order by k_sort asc nulls last, k_key asc
	    limit 200;
ROLLBACK;
