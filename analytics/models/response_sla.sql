-- MACHINE-GENERATED OUTPUT TABLE (analytics_response_sla) — Kernel Stage 28
-- metrics model v1. Chat responsiveness from the message archive: for every
-- fan message, the minutes until the next own-side message in the same
-- conversation; aggregated per account per day (median + p95).
create table analytics_response_sla as
with replies as (
  select account_id,
         conversation_ref,
         occurred_at as fan_message_at,
         (
           select min(a2.occurred_at)
           from message_archive a2
           where a2.account_id = a.account_id
             and a2.conversation_ref = a.conversation_ref
             and a2.is_sent_by_me
             and a2.occurred_at > a.occurred_at
         ) as replied_at
  from message_archive a
  where not a.is_sent_by_me
    and a.deleted_at is null
)
select account_id,
       (timezone('UTC', fan_message_at))::date as business_date,
       count(*)::int as fan_messages,
       count(replied_at)::int as replied,
       percentile_cont(0.5) within group (order by extract(epoch from replied_at - fan_message_at) / 60)
         filter (where replied_at is not null) as median_response_minutes,
       percentile_cont(0.95) within group (order by extract(epoch from replied_at - fan_message_at) / 60)
         filter (where replied_at is not null) as p95_response_minutes
from replies
group by 1, 2;
