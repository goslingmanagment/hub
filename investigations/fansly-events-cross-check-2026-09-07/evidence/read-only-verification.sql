BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT now() AS measured_at, current_user;
SELECT v.table_name,
       has_table_privilege(current_user, 'public.' || v.table_name, 'SELECT') AS whole_table_select,
       has_any_column_privilege(current_user, 'public.' || v.table_name, 'SELECT') AS any_column_select
FROM (VALUES ('page_sync_states'), ('observations'), ('sync_http_attempts'), ('config_settings')) AS v(table_name);
SELECT table_name, string_agg(column_name, ', ' ORDER BY column_name) AS select_columns
FROM information_schema.column_privileges
WHERE grantee = current_user AND table_schema = 'public' AND privilege_type = 'SELECT'
  AND table_name IN ('page_sync_states', 'sync_http_attempts', 'config_settings')
GROUP BY table_name ORDER BY table_name;
SELECT p.label, s.stream, s.status, s.succeeded_at, s.last_error_code
FROM public.page_sync_states s JOIN public.pages p ON p.id = s.page_id
WHERE p.platform = 'fansly' AND s.stream IN ('dm_conversations', 'dm_messages', 'followers_reconcile', 'fan_earnings')
ORDER BY p.label, s.stream;
COMMIT;
