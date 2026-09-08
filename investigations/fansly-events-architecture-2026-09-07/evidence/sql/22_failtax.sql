SET statement_timeout = '180s';
select o.kind,
       coalesce(o.payload #>> '{error,code}', '<null>') as err_code,
       left(coalesce(o.payload #>> '{error,summary}',''), 90) as summary,
       count(*) as n
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
  and o.kind like '%:failed'
group by 1,2,3 order by n desc;
