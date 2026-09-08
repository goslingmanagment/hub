BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT now() AS measured_at, current_user, current_setting('transaction_read_only');
SELECT page_label, state, count(*) AS heads,
       count(*) FILTER (WHERE NOT is_visible) AS hidden,
       count(*) FILTER (WHERE NOT identity_resolved) AS unresolved_identity,
       count(*) FILTER (WHERE coalesce(excluded_reason, '') <> '') AS excluded,
       min(first_observed_at) AS oldest_observed_at,
       min(message_at) AS oldest_message_at,
       max(now() - first_observed_at) AS oldest_debt_age,
       sum(attempts) AS completed_unconfirmed_attempts
FROM fansly_dm_head_debt_report
GROUP BY page_label, state ORDER BY page_label, state;
SELECT page_label, platform_conversation_id, message_id, state, attempts,
       first_observed_at, message_at, next_retry_at, history_coverage,
       is_visible, identity_resolved, excluded_reason
FROM fansly_dm_head_debt_report
WHERE captured_at IS NULL
ORDER BY first_observed_at, page_label, platform_conversation_id, message_id
LIMIT 50;
COMMIT;
