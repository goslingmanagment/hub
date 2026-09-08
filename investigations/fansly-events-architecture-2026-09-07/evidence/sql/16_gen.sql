SET statement_timeout = '180s';
-- 4th key field for dm_conversations: distinct values per page per day (sweep generations?)
select p.label as page, (o.received_at at time zone 'UTC')::date as utc_day,
       count(distinct split_part(split_part(o.idempotency_key,':',4),'.',1)) as distinct_gen,
       count(distinct split_part(o.idempotency_key,':',3)) as runs,
       count(*) as reqs
from observations o join pages p on p.id=o.account_id
where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.producer='sync:fansly:dm_conversations' and o.kind='dm_conversations'
group by 1,2 order by 1,2;
