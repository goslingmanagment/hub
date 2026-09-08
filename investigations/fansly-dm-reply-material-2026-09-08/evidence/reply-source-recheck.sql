BEGIN READ ONLY;
SET LOCAL statement_timeout='25s';
WITH raw AS MATERIALIZED (
 SELECT o.account_id,o.received_at,coalesce(o.payload,b.body) AS body FROM observations o LEFT JOIN capture_json_hot_bodies b ON b.bucket_month=o.payload_bucket_month AND b.object_id=o.payload_object_id
 WHERE o.platform='fansly' AND o.kind='dm_messages' AND o.received_at>='2026-09-07T01:45:00Z' AND o.received_at<'2026-09-08T01:45:00Z'
), replies AS (
 SELECT DISTINCT ON(r.account_id,m->>'id') r.account_id,r.received_at,m FROM raw r CROSS JOIN LATERAL jsonb_array_elements(r.body->'messages') m
 WHERE nullif(m->>'inReplyTo','') IS NOT NULL ORDER BY r.account_id,m->>'id',r.received_at DESC
), samples AS (
 SELECT DISTINCT ON (r.account_id) p.label,m->>'id' AS message_id,m->>'groupId' AS group_id,m->>'inReplyTo' AS in_reply_to,to_timestamp((m->>'createdAt')::numeric) AS created_at
 FROM replies r JOIN pages p ON p.id=r.account_id ORDER BY r.account_id,r.received_at DESC
)
SELECT jsonb_build_object('measured_at',clock_timestamp(),'reply_counts',(SELECT jsonb_agg(x) FROM (SELECT account_id,count(*) FROM replies GROUP BY account_id) x),'samples',(SELECT jsonb_agg(x) FROM samples x));
COMMIT;
