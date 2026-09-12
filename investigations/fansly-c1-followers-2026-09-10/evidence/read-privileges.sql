BEGIN READ ONLY;
SET LOCAL statement_timeout = '5000ms';
SELECT current_user, current_setting('transaction_read_only');
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
AND p.proname ~ '(sync|follower)'
AND has_function_privilege(current_user,p.oid,'EXECUTE') ORDER BY 1,2;
SELECT table_schema,table_name FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog','information_schema')
AND table_name ~ '(sync|follower)' AND has_table_privilege(current_user,
  format('%I.%I',table_schema,table_name),'SELECT') ORDER BY 1,2;
COMMIT;
