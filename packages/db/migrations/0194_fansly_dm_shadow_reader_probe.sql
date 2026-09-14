-- One current-state cost sample, not provider-list or reader completeness.
-- EXPLAIN is a utility command, so this read-only function must be VOLATILE.
CREATE FUNCTION public.fansly_dm_shadow_reader_probe(
  requested_page_label text, sample_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  selected_page bigint;
  sampled_heads jsonb;
  head_values text;
  reader_sql text;
  reader_plan jsonb;
BEGIN
  IF current_setting('transaction_read_only') <> 'on'
    OR current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'reader_probe_requires_repeatable_read_only';
  END IF;
  -- The caller sets these before SELECT. Setting statement_timeout inside a
  -- function would not install a deadline for the already-running statement.
  IF (SELECT s.setting::bigint FROM pg_catalog.pg_settings s
      WHERE s.name = 'statement_timeout') NOT BETWEEN 1 AND 5000
    OR (SELECT s.setting::bigint FROM pg_catalog.pg_settings s
      WHERE s.name = 'lock_timeout') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'reader_probe_requires_bounded_timeouts';
  END IF;
  IF sample_limit IS NULL OR sample_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_reader_probe_sample_limit';
  END IF;
  SELECT p.id INTO selected_page FROM public.pages p
    WHERE p.label = requested_page_label AND p.platform = 'fansly';
  IF selected_page IS NULL THEN RAISE EXCEPTION 'unknown_fansly_page'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'conversationId', c.id::text, 'conversationRef', c.platform_conversation_id,
      'messageId', c.last_message_id,
      'lastMessageAt', c.last_message_at
    ) ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC), '[]'::jsonb),
    string_agg(format('(%L::integer, %L::text, %L::text)',
      c.ordinal, c.platform_conversation_id, c.last_message_id), ', '
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC)
    INTO sampled_heads, head_values
  FROM (
    SELECT c.id, c.platform_conversation_id, c.last_message_id, c.last_message_at,
      (row_number() OVER (ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC) - 1)::integer AS ordinal
    FROM public.page_dm_threads c
    WHERE c.platform_account_id = selected_page AND c.is_visible = true
      AND c.last_message_id IS NOT NULL AND c.last_message_id <> ''
    ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC NULLS LAST
    LIMIT sample_limit
  ) c;

  IF head_values IS NOT NULL THEN
    -- Fixed exact-ID reader query, pinned against queryFanslyDmReaderHeads.
    -- All interpolation is typed, quoted data selected internally for one page.
    reader_sql := format($reader_query$
    with page as (
      select p.id, p.ofapi_account_id from public.pages p
      where p.id = %L::bigint and p.platform = 'fansly'
    ), targets(ordinal, group_ref, message_id) as (values %s),
    candidates as materialized (
      select h.ordinal, ma.deleted_at, ma.content_pending,
        1 as source_rank, 'message_archive'::text as source
      from targets h cross join page p
      join public.message_archive ma on ma.account_id = p.id and ma.platform = 'fansly'
        and ma.conversation_ref = h.group_ref and ma.message_ref = h.message_id
      union all
      select h.ordinal, d.deleted_at, d.message_created_at is null,
        2, 'dm_message_archive'::text
      from targets h cross join page p
      join public.dm_message_archive d on d.platform_account_id = p.id and d.platform = 'fansly'
        and d.platform_conversation_id = h.group_ref and d.platform_message_id = h.message_id
      union all
      select h.ordinal, m.deleted_at, false, 0, 'hot'::text
      from targets h cross join page p
      join public.page_dm_threads t on t.platform_account_id = p.id
        and t.platform_conversation_id = h.group_ref
      join public.page_dm_messages m on m.conversation_id = t.id and m.platform_message_id = h.message_id
    ), tombstoned as (
      select c.ordinal from candidates c where c.deleted_at is not null
      union
      select h.ordinal from targets h cross join page p
      join public.dm_message_archive d on d.ofapi_account_id = p.ofapi_account_id
        and d.platform = 'fansly' and d.platform_message_id = h.message_id
        and d.deleted_at is not null
      where exists (select 1 from candidates c where c.ordinal = h.ordinal)
    ), best as (
      select distinct on (c.ordinal) c.* from candidates c
      order by c.ordinal, c.source_rank desc
    )
    select h.ordinal, case
      when not exists (select 1 from page) then null
      when b.ordinal is null then 'missing'
      when exists (select 1 from tombstoned t where t.ordinal = h.ordinal) then 'deleted'
      when b.content_pending then 'content_pending'
      else 'materialized' end as state,
      b.source, exists (select 1 from candidates c where c.ordinal = h.ordinal
        and c.source_rank = 0 and c.deleted_at is null) as live_hot_copy
    from targets h left join best b on b.ordinal = h.ordinal
    order by h.ordinal
    $reader_query$, selected_page, head_values);
    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || reader_sql INTO reader_plan;
  END IF;

  RETURN jsonb_build_object(
    'version', 1, 'page', requested_page_label, 'asOf', transaction_timestamp(),
    'scope', 'current_stored_heads_agent_reader_state_query',
    'status', CASE WHEN head_values IS NULL THEN 'no_sample' ELSE 'measured' END,
    'sampleLimit', sample_limit, 'sampledHeads', sampled_heads, 'readerPlan', reader_plan
  );
END;
$$;
REVOKE ALL ON FUNCTION public.fansly_dm_shadow_reader_probe(text, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION public.fansly_dm_shadow_reader_probe(text, integer) TO read_only;
  END IF;
END $$;
