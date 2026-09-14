-- One current-state cost sample, not provider-list or reader completeness.
-- EXPLAIN is a utility command, so this read-only function must be VOLATILE.
CREATE FUNCTION public.fansly_dm_shadow_material_probe(
  requested_page_label text, sample_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  selected_page bigint;
  sampled_heads jsonb;
  head_values text;
  material_sql text;
  material_plan jsonb;
BEGIN
  IF current_setting('transaction_read_only') <> 'on'
    OR current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'material_probe_requires_repeatable_read_only';
  END IF;
  -- The caller sets these before SELECT. Setting statement_timeout inside a
  -- function would not install a deadline for the already-running statement.
  IF (SELECT s.setting::bigint FROM pg_catalog.pg_settings s
      WHERE s.name = 'statement_timeout') NOT BETWEEN 1 AND 5000
    OR (SELECT s.setting::bigint FROM pg_catalog.pg_settings s
      WHERE s.name = 'lock_timeout') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'material_probe_requires_bounded_timeouts';
  END IF;
  IF sample_limit IS NULL OR sample_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_material_probe_sample_limit';
  END IF;
  SELECT p.id INTO selected_page FROM public.pages p
    WHERE p.label = requested_page_label AND p.platform = 'fansly';
  IF selected_page IS NULL THEN RAISE EXCEPTION 'unknown_fansly_page'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'conversationId', c.id::text, 'messageId', c.last_message_id,
      'lastMessageAt', c.last_message_at
    ) ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC), '[]'::jsonb),
    string_agg(format('(%L::bigint, %L::text)', c.id, c.last_message_id), ', '
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC)
    INTO sampled_heads, head_values
  FROM (
    SELECT c.id, c.last_message_id, c.last_message_at
    FROM public.page_dm_threads c
    WHERE c.platform_account_id = selected_page AND c.is_visible = true
      AND c.last_message_id IS NOT NULL AND c.last_message_id <> ''
    ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC NULLS LAST
    LIMIT sample_limit
  ) c;

  IF head_values IS NOT NULL THEN
    -- Keep this query aligned with readFanslyDmShadowMaterial. Only the typed
    -- VALUES are interpolated, from the internally selected page, with %L.
    material_sql := format($material_query$
      select h.conversation_id, exists (
        select 1 from public.page_dm_messages m
        where m.conversation_id = h.conversation_id
          and m.platform_message_id = h.message_id and m.deleted_at is null
      ) as present,
      extract(epoch from d.captured_at - d.first_observed_at) * 1000 as lag_ms
      from (values %s) h(conversation_id, message_id)
      left join public.fansly_dm_head_debt d
        on d.conversation_id = h.conversation_id and d.message_id = h.message_id
    $material_query$, head_values);
    EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' || material_sql INTO material_plan;
  END IF;

  RETURN jsonb_build_object(
    'version', 1, 'page', requested_page_label, 'asOf', transaction_timestamp(),
    'scope', 'current_stored_heads_hot_material_query',
    'status', CASE WHEN head_values IS NULL THEN 'no_sample' ELSE 'measured' END,
    'sampleLimit', sample_limit, 'sampledHeads', sampled_heads, 'materialPlan', material_plan
  );
END;
$$;
REVOKE ALL ON FUNCTION public.fansly_dm_shadow_material_probe(text, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN
    GRANT EXECUTE ON FUNCTION public.fansly_dm_shadow_material_probe(text, integer) TO read_only;
  END IF;
END $$;
