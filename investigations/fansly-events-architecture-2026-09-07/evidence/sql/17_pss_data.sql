SET statement_timeout = '180s';
select p.label as page, s.stream, s.status, s.work_class, s.cadence_seconds,
       s.request_seq, s.applied_seq, s.last_scheduled_slot,
       s.succeeded_at, s.failed_at, s.consecutive_failures,
       s.last_error_code, left(coalesce(s.last_error_summary,''),60) as last_err,
       s.blocker_kind, s.blocker_code, s.retry_at, s.ofapi_user_paused
from page_sync_states s join pages p on p.id = s.page_id
where s.page_id in (1,2,3,4,5,10)
order by p.label, s.stream;
