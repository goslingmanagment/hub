BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT jsonb_build_object('asOf',clock_timestamp(),'role',current_user,
'readOnly',current_setting('transaction_read_only'),
'pages',has_table_privilege(current_user,'public.pages','SELECT'),
'credentials',has_table_privilege(current_user,'public.page_credentials','SELECT'),
'proxies',has_table_privilege(current_user,'public.egress_endpoints','SELECT'));
COMMIT;
