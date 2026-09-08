SET statement_timeout = '180s';
select p.label as page, s.stream, s.status, s.phase,
       s.succeeded_at, s.failed_at, s.consecutive_failures,
       s.last_error_code, left(coalesce(s.last_error_summary,''),50) as last_err,
       s.blocker_kind, s.blocker_code, s.updated_at
from page_sync_states s join pages p on p.id = s.page_id
where s.page_id in (1,2,3,4,5,10)
order by p.label, s.stream;
