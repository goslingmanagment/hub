BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT now(), current_user;
SELECT o.kind, count(*) AS captured_rows_6d, count(*)::numeric/6 AS rows_per_day
FROM observations o
WHERE o.received_at >= timestamptz '2026-09-01 00:00:00+00'
  AND o.received_at < timestamptz '2026-09-07 00:00:00+00'
  AND o.producer = 'sync:fansly:dm_conversations'
GROUP BY o.kind ORDER BY count(*) DESC;
COMMIT;
