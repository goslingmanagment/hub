BEGIN READ ONLY;
SET LOCAL statement_timeout = '25s';
SELECT now() AS measured_at, current_user;
SELECT split_part(o.producer, ':', 3) AS stream, count(*) AS captured_rows_6d,
       count(*) FILTER (WHERE o.kind LIKE '%:failed') AS failure_rows,
       round(count(*)::numeric/6, 2) AS captured_rows_per_day,
       round((count(*) FILTER (WHERE o.kind NOT LIKE '%:failed'))::numeric/6, 2) AS nonfailure_rows_per_day
FROM observations o
WHERE o.received_at >= timestamptz '2026-09-01 00:00:00+00'
  AND o.received_at < timestamptz '2026-09-07 00:00:00+00'
  AND o.platform = 'fansly' AND o.source = 'pull'
GROUP BY 1 ORDER BY count(*) DESC;
SELECT count(*) AS rows_14d,
       count(*) FILTER (WHERE o.kind LIKE '%:failed') AS failure_rows_14d,
       count(*) FILTER (WHERE o.kind LIKE '%:failed' AND coalesce(o.payload #>> '{error,summary}', '') LIKE '%(429)%') AS terminal_429_rows,
       count(*) FILTER (WHERE o.kind LIKE '%:failed' AND coalesce(o.payload #>> '{error,summary}', '') LIKE '%(403)%') AS terminal_403_rows
FROM observations o
WHERE o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  AND o.received_at < timestamptz '2026-09-07 00:00:00+00'
  AND o.platform = 'fansly' AND o.source = 'pull';
SELECT p.label, count(*) AS list_rows_2d, count(DISTINCT split_part(split_part(o.idempotency_key, ':', 4), '.', 1)) AS inferred_sweeps,
       round(count(*)::numeric / NULLIF(count(DISTINCT split_part(split_part(o.idempotency_key, ':', 4), '.', 1)), 0), 2) AS list_rows_per_sweep
FROM observations o JOIN pages p ON p.id = o.account_id
WHERE o.received_at >= timestamptz '2026-09-05 00:00:00+00'
  AND o.received_at < timestamptz '2026-09-07 00:00:00+00'
  AND o.producer = 'sync:fansly:dm_conversations' AND o.kind = 'dm_conversations'
GROUP BY p.label ORDER BY p.label;
COMMIT;
