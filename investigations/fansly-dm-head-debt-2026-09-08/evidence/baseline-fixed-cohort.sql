BEGIN READ ONLY;
SET LOCAL statement_timeout='25s';
WITH list_bodies AS MATERIALIZED (
 SELECT o.account_id,o.received_at,coalesce(o.payload,b.body) AS body
 FROM observations o LEFT JOIN capture_json_hot_bodies b ON b.bucket_month=o.payload_bucket_month AND b.object_id=o.payload_object_id
 WHERE o.platform='fansly' AND o.kind='dm_conversations'
 AND o.received_at>='2026-09-07T23:45:00Z' AND o.received_at<'2026-09-08T01:45:00Z'
), heads AS MATERIALIZED (
 SELECT DISTINCT l.account_id,g->>'id' AS group_id,g->'lastMessage'->>'id' AS message_id,
 to_timestamp((g->'lastMessage'->>'createdAt')::numeric) AS created_at
 FROM list_bodies l CROSS JOIN LATERAL jsonb_array_elements(l.body->'aggregationData'->'groups') g
 WHERE jsonb_typeof(g->'lastMessage'->'createdAt')='number'
 AND (g->'lastMessage'->>'createdAt')::numeric>=extract(epoch FROM '2026-09-07T01:45:00Z'::timestamptz)
 AND (g->'lastMessage'->>'createdAt')::numeric<extract(epoch FROM '2026-09-08T00:45:00Z'::timestamptz)
), message_bodies AS MATERIALIZED (
 SELECT o.account_id,coalesce(o.payload,b.body) AS body
 FROM observations o LEFT JOIN capture_json_hot_bodies b ON b.bucket_month=o.payload_bucket_month AND b.object_id=o.payload_object_id
 WHERE o.platform='fansly' AND o.kind='dm_messages'
 AND o.received_at>='2026-09-07T01:45:00Z' AND o.received_at<now()
), message_ids AS MATERIALIZED (
 SELECT DISTINCT m.account_id,item->>'id' AS message_id
 FROM message_bodies m CROSS JOIN LATERAL jsonb_array_elements(m.body->'messages') item
), comparison AS (
 SELECT p.label,h.*,m.message_id IS NOT NULL AS captured FROM heads h
 JOIN pages p ON p.id=h.account_id
 LEFT JOIN message_ids m ON m.account_id=h.account_id AND m.message_id=h.message_id
)
SELECT jsonb_build_object('measured_at',now(),'role',current_user,
 'counts',(SELECT jsonb_agg(s) FROM (SELECT label,count(*) AS heads,count(*) FILTER(WHERE captured) AS captured_heads,count(*) FILTER(WHERE NOT captured) AS missing_message_capture FROM comparison GROUP BY label ORDER BY label) s));
COMMIT;
