BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '1s';
SELECT jsonb_build_object(
 'identity', jsonb_build_object('role',current_user,'readOnly',current_setting('transaction_read_only'),
   'isolation',current_setting('transaction_isolation'),'asOf',statement_timestamp()),
 'timeline', public.fansly_followers_diagnostic_timeline('2026-09-12T18:00:00Z','2026-09-13T00:02:35.324525+00:00',0,null,500)
);
ROLLBACK;
