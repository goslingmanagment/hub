// Fixed SQL only. Scope, filters and keyset pagination are applied by the
// existing dataset reader. No request value is interpolated here.
export const RAW_MEDIA_DATASET = `
  select m.page_id as k_page_id, m.platform::text as k_platform,
         m.media_ref as k_key, m.first_observed_at as k_occurred_at,
         null::text as k_fan, m.source_observation_id as k_observation_ref,
         case m.platform::text when 'fansly' then 'fansly_pull'
              when 'onlyfans' then 'ofapi_material_capture' else 'unknown' end as k_ingest_path,
         'converging'::text as k_convergence,
         m.platform::text as f_platform, m.media_ref as f_media_ref,
         m.owner_account_ref as f_owner_account_ref, m.filename as f_filename,
         m.mime_type as f_mime_type, m.media_type as f_media_type, m.provider_type as f_provider_type,
         m.duration_ms as f_duration_ms, m.width as f_width, m.height as f_height,
         m.original_width as f_original_width, m.original_height as f_original_height,
         m.frame_rate_milli as f_frame_rate_milli,
         m.created_at_platform as f_created_at_platform,
         m.updated_at_platform as f_updated_at_platform,
         m.first_origin as f_first_origin, m.source_kind as f_source_kind,
         m.first_observed_at as f_first_observed_at, m.last_observed_at as f_last_observed_at
    from creator_raw_media m
`;

export const POST_ATTACHMENTS_DATASET = `
  with slots as (
    select cp.*, a.attachment, a.ordinal::int as attachment_index,
           a.attachment->>'contentId' as content_ref,
           (a.attachment->>'contentType')::int as content_type,
           (a.attachment->>'pos')::int as pos
      from creator_posts cp
      cross join lateral jsonb_array_elements(
        coalesce(cp.attachment_refs,
          case when cp.attachment_count > 0 then '[{}]'::jsonb else '[]'::jsonb end)
      ) with ordinality as a(attachment, ordinal)
  ), members as (
    select s.*, b.bundle_ref, b.preview_ref as bundle_preview_ref,
           b.source_observation_id as bundle_observation_ref,
           bm.member_ref, bm.member_index,
           o.media_offer_ref, o.media_ref as offer_media_ref, o.preview_ref as offer_preview_ref,
           o.source_observation_id as offer_observation_ref,
           greatest(s.last_observed_at, b.last_observed_at, o.last_observed_at) as relation_observed_at
      from slots s
      left join creator_media_bundles b
        on s.platform::text = 'fansly' and b.page_id = s.account_id and b.bundle_ref = s.content_ref
      left join lateral (
        select null::text as member_ref, 0::int as member_index where b.bundle_ref is null
        union all
        select r.ref, r.ordinal::int from unnest(b.member_refs) with ordinality as r(ref, ordinal)
      ) bm on true
      left join creator_media o
        on s.platform::text = 'fansly' and o.page_id = s.account_id
       and o.media_offer_ref = case when b.bundle_ref is null then s.content_ref else bm.member_ref end
  )
  select m.account_id as k_page_id, m.platform::text as k_platform,
         m.account_id::text || ':' || m.platform_post_id || ':' || m.attachment_index::text || ':' ||
           coalesce(m.member_index, 0)::text || ':' || role.role as k_key,
         m.published_at as k_occurred_at, null::text as k_fan,
         m.source_observation_id as k_observation_ref,
         case m.platform::text when 'fansly' then 'fansly_pull'
              when 'onlyfans' then 'ofapi_material_capture' else 'unknown' end as k_ingest_path,
         'converging'::text as k_convergence,
         m.platform::text as f_platform, m.platform_post_id as f_post_ref,
         m.published_at as f_published_at, m.attachment_index - 1 as f_attachment_index,
         m.pos as f_pos, m.content_type as f_content_type, m.content_ref as f_content_ref,
         role.role as f_role, coalesce(m.member_index, 0) as f_member_index,
         m.bundle_ref as f_bundle_ref, m.media_offer_ref as f_media_offer_ref,
         role.preview_ref as f_preview_ref,
         case when role.role = 'main' then role.media_ref else f.media_ref end as f_media_ref,
         case
           when m.content_ref is null then 'attachment_ref_missing'
           when m.platform::text = 'fansly' and m.content_type = 7100 then 'non_media_attachment'
           when role.role <> 'main' and f.media_ref is null then 'preview_unresolved'
           when m.bundle_ref is not null and m.member_ref is null and role.role = 'main' then 'bundle_members_missing'
           when role.media_ref is null then 'media_ref_missing'
           when f.media_ref is null then 'file_metadata_missing'
           else 'resolved'
         end as f_link_state,
         (m.platform::text = 'fansly' and m.content_type = 7100
           or role.media_ref is not null and f.media_ref is not null) as k_link_complete,
         f.filename as f_filename, f.mime_type as f_mime_type,
         f.duration_ms as f_duration_ms, f.original_width as f_original_width,
         f.original_height as f_original_height,
         greatest(m.relation_observed_at, f.last_observed_at) as f_last_observed_at,
         m.source_observation_id as f_post_observation_ref,
         m.offer_observation_ref as f_offer_observation_ref,
         m.bundle_observation_ref as f_bundle_observation_ref,
         f.source_observation_id as f_file_observation_ref
    from members m
    cross join lateral (
      select 'main'::text as role,
             case when m.platform::text = 'onlyfans' then m.content_ref else m.offer_media_ref end as media_ref,
             null::text as preview_ref
      union all
      select 'offer_preview', m.offer_preview_ref, m.offer_preview_ref where m.offer_preview_ref is not null
      union all
      select 'bundle_preview', m.bundle_preview_ref, m.bundle_preview_ref
       where m.bundle_preview_ref is not null and coalesce(m.member_index, 1) = 1
    ) role
    left join creator_raw_media f on f.page_id = m.account_id and f.media_ref = role.media_ref
`;
