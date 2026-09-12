WITH expected_runs(id) AS (
  VALUES
    (734540),
    (734541),
    (734542),
    (734543),
    (734545),
    (734546),
    (734547),
    (734548),
    (734549),
    (734552),
    (734553),
    (734554),
    (734555),
    (734556),
    (734559),
    (734560),
    (734561),
    (734562),
    (734563),
    (734564),
    (734565),
    (734566),
    (734567),
    (734571),
    (734573),
    (734575),
    (734577),
    (734579),
    (734584),
    (734587),
    (734590),
    (734593),
    (734596),
    (734599),
    (734602),
    (734604),
    (734606),
    (734608)
), captures AS MATERIALIZED (
  SELECT o.id, o.received_at,
         split_part(o.idempotency_key, ':', 3)::bigint AS run_id,
         row_number() OVER (ORDER BY o.received_at, o.id) AS page_ordinal,
         CASE WHEN o.payload IS NOT NULL THEN o.payload
           WHEN po.platform_account_id = o.account_id
             AND po.access_class = 'ordinary_capture'
             AND po.erasure_domain = 'fan_subject'
             AND po.representation = 'canonical_json'
           THEN b.body ELSE NULL END AS payload
  FROM public.observations o
  JOIN expected_runs r ON split_part(o.idempotency_key, ':', 3) = r.id::text
  LEFT JOIN public.capture_payload_objects po
    ON po.bucket_month = o.payload_bucket_month AND po.object_id = o.payload_object_id
  LEFT JOIN public.capture_json_hot_bodies b
    ON b.bucket_month = po.bucket_month AND b.object_id = po.object_id
  WHERE o.account_id = 5 AND o.source = 'pull' AND o.platform = 'fansly'
    AND o.producer = 'sync:fansly:followers_reconcile' AND o.kind = 'followers'
    AND o.received_at >= '2026-09-12T16:32:53.108Z'
    AND o.received_at < '2026-09-12T16:48:16.297Z'
), follower_rows AS MATERIALIZED (
  SELECT c.id AS observation_id, c.run_id, c.page_ordinal, f.ordinality,
         f.value ->> 'id' AS follow_id, f.value ->> 'followerId' AS fan_id,
         jsonb_typeof(f.value -> 'id') = 'string'
           AND jsonb_typeof(f.value -> 'followerId') = 'string' AS valid
  FROM captures c
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.payload -> 'followers') = 'array'
      THEN c.payload -> 'followers' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS f(value, ordinality)
), duplicate_relations AS (
  SELECT md5(f.follow_id) AS relation_digest, count(*) AS occurrences,
         jsonb_agg(jsonb_build_object(
           'observationId', f.observation_id, 'runId', f.run_id,
           'pageOrdinal', f.page_ordinal, 'rowOrdinal', f.ordinality
         ) ORDER BY f.page_ordinal, f.ordinality) AS positions
  FROM follower_rows f WHERE f.valid
  GROUP BY f.follow_id HAVING count(*) > 1
)
SELECT jsonb_build_object(
  'asOf', transaction_timestamp(),
  'pageLabel', 'lilly-2', 'revision', 2541, 'generation', 791,
  'expectedRunIds', (SELECT jsonb_agg(r.id ORDER BY r.id) FROM expected_runs r),
  'captureCount', (SELECT count(*) FROM captures),
  'capturesWithFollowerArray', (
    SELECT count(*) FROM captures c WHERE jsonb_typeof(c.payload -> 'followers') = 'array'
  ),
  'unavailablePayloads', (SELECT count(*) FROM captures c WHERE c.payload IS NULL),
  'followerRows', (SELECT count(*) FROM follower_rows),
  'invalidFollowerRows', (SELECT count(*) FROM follower_rows f WHERE f.valid IS NOT TRUE),
  'uniqueFollowIds', (SELECT count(DISTINCT f.follow_id) FROM follower_rows f WHERE f.valid),
  'uniqueFanIds', (SELECT count(DISTINCT f.fan_id) FROM follower_rows f WHERE f.valid),
  'duplicateRelations', (
    SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.relation_digest), '[]'::jsonb)
    FROM duplicate_relations d
  ),
  'captures', (
    SELECT jsonb_agg(jsonb_build_object(
      'observationId', c.id, 'runId', c.run_id, 'receivedAt', c.received_at,
      'pageOrdinal', c.page_ordinal,
      'followerCount', CASE WHEN jsonb_typeof(c.payload -> 'followers') = 'array'
        THEN jsonb_array_length(c.payload -> 'followers') ELSE NULL END
    ) ORDER BY c.page_ordinal) FROM captures c
  )
);
