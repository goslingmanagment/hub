BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='1s';
SELECT jsonb_build_object('identity',jsonb_build_object('role',current_user,'readOnly',current_setting('transaction_read_only'),'isolation',current_setting('transaction_isolation'),'asOf',statement_timestamp()),'migrations',(SELECT jsonb_agg(jsonb_build_object('id',id,'appliedAt',applied_at) ORDER BY id) FROM schema_migrations WHERE id >= '0180' AND id < '0200'));
ROLLBACK;
