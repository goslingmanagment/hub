SET statement_timeout = '180s';
select t.typname, e.enumlabel, e.enumsortorder
from pg_type t join pg_enum e on e.enumtypid = t.oid
where t.typname in ('sync_stream','page_sync_status','sync_work_class','sync_request_source')
order by t.typname, e.enumsortorder;
