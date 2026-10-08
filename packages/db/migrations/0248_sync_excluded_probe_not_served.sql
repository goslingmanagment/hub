-- 0248_sync_excluded_probe_not_served.sql
--
-- Excluded-chat probes Fansly already answered (owner decision №8; arena
-- "vanished chat", plan D1 / M3). `probe.excluded-chat` took a non-2xx for the
-- chat's answer only when it was a 403 or a declared client status: a 500 was
-- a `subject_failure`, so a chat Fansly answers
--   500 {"success":false,"error":{"code":500,"details":"error getting group messages"}}
-- kept its probe open on the subject's ladder (one request a day once blocked,
-- for good), and the failures of five such chats held the whole `probe` file,
-- `probe.manual` with it. From this release a `subject_failure` whose body is
-- Fansly's own error envelope closes the probe `served: false`,
-- `not_served:<status>` (`fansly/resources/probe.ts`), and failures of the
-- `probe.*` keys never start a hold of their file.
--
-- This closes the probes the old rule left open, from what they recorded and
-- without a request: every open `probe.excluded-chat` work whose LATEST
-- answered attempt (outcome 'response') is a `subject_failure` whose journaled
-- body (`dm_messages:failed`, `payload.bodyText`) is a well-formed Fansly error
-- envelope — `success: false`, a numeric `error.code`, a non-empty
-- `error.details` (`isFanslyErrorEnvelope`) — and served the work's current
-- demand. It is closed as the outcome hook closes it: `done`,
-- `not_served:<status>`, its breaker cleared, nothing waiting, and the hook's
-- result `{served: false, httpStatus, errorClass: 'subject_failure'}` plus the
-- evidence: the attempt the answer was read from (`attemptId`,
-- `observationId`), every attempt of the work (`attemptIds`; the journal of
-- attempts lives 30 days) and `closedBy`. A probe whose latest answer is
-- anything else (a 2xx not applied yet, a proxy's HTML or an empty 5xx, a
-- 401, a 429) is left to the engine; a probe answered and closed meanwhile is
-- not open and is not touched, nor is one `running` while the previous
-- image's `sync` still works (the new image closes it at its next answer).
--
-- (Production, 2026-10-08: the 20 open probes of lilly-1, page 4, works 77515
-- to 77534 — 125 attempts, every one that 500 with that envelope.)
--
-- The resource hold of the `probe` file is NOT lifted here: it ends by itself,
-- and the probes' failures no longer start one.
--
-- Data only: one statement, no DDL. A database without such a probe (a new
-- one, or this migration applied before) changes nothing.
--
-- After the deploy (read-only):
--   pnpm cli sync excluded report --page lilly-1     (20 not_served, 0 pending)
--
-- Rollback-compatible: the previous image reads a done work as done (nothing
-- picks it, and its report judges `done` with `served: false` as not served)
-- and ignores the extra keys of the result.
with answered as (
  select distinct on (a.work_id)
         a.work_id, a.id as attempt_id, a.http_status, a.error_class, a.demand_revision,
         a.observation_id, a.observation_received_at
    from sync_work w
    join sync_attempts a on a.work_id = w.id and a.page_id = w.page_id and not a.shadow
   where w.resource = 'probe.excluded-chat'
     and w.state = 'open'
     and not w.shadow
     and a.outcome = 'response'
   order by a.work_id, a.id desc
), refused as (
  select x.work_id, x.attempt_id, x.http_status, x.demand_revision, x.observation_id
    from answered x
    join observations o on o.id = x.observation_id and o.received_at = x.observation_received_at
   cross join lateral (
     select case when pg_input_is_valid(o.payload ->> 'bodyText', 'jsonb')
                 then (o.payload ->> 'bodyText')::jsonb end as body
   ) b
   where x.error_class = 'subject_failure'
     and x.http_status is not null
     and o.kind = 'dm_messages:failed'
     and jsonb_typeof(b.body) = 'object'
     and b.body -> 'success' = 'false'::jsonb
     and jsonb_typeof(b.body -> 'error') = 'object'
     and jsonb_typeof(b.body -> 'error' -> 'code') = 'number'
     and jsonb_typeof(b.body -> 'error' -> 'details') = 'string'
     and (b.body -> 'error' ->> 'details') ~ '[^[:space:]]'
     and coalesce(jsonb_typeof(b.body -> 'error' -> 'message'), 'string') = 'string'
)
update sync_work w
   set state = 'done',
       closed_at = clock_timestamp(),
       close_reason = 'not_served:' || r.http_status,
       applied_revision = greatest(w.applied_revision, least(w.demand_revision, r.demand_revision)),
       secret_params = null,
       waiting_reason = null,
       waiting_until = null,
       failure_count = 0,
       breaker_until = null,
       blocked_by_vendor_at = null,
       last_error_class = 'subject_failure',
       result = jsonb_build_object(
         'served', false,
         'httpStatus', r.http_status,
         'errorClass', 'subject_failure',
         'attemptId', r.attempt_id,
         'observationId', r.observation_id,
         'attemptIds', (select jsonb_agg(a.id order by a.id)
                          from sync_attempts a
                         where a.work_id = w.id and a.page_id = w.page_id and not a.shadow),
         'closedBy', 'migration sync_excluded_probe_not_served'),
       updated_at = clock_timestamp()
  from refused r
 where w.id = r.work_id
   and w.state = 'open'
   and w.demand_revision <= r.demand_revision;
