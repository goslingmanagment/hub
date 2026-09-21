-- Operational settlement is distinct from REST materialization. Keep durable
-- per-receipt evidence across later generation/activation/type policy changes.
alter table fansly_ws_hint_receipts
  add column settled_at timestamptz,
  add column settlement_kind text check (settlement_kind in ('rest_materialized','source_deleted','group_checked')),
  add column settlement_observation_id bigint,
  add constraint fansly_ws_hint_settlement_pair check ((settled_at is null) = (settlement_kind is null)),
  add constraint fansly_ws_hint_delete_evidence check (
    (settlement_observation_id is not null) = coalesce(settlement_kind = 'source_deleted', false));

create index fansly_ws_hint_exact_delete on fansly_ws_hint_receipts
  (page_id, group_ref, message_ref, generation, received_at)
  where outcome = 'mutation_debt';

-- Append columns: existing readers and an older application binary remain valid.
create or replace view fansly_ws_hint_status as
  select r.page_id, r.event_id, r.observation_id, r.received_at, r.generation,
    r.group_ref, r.message_ref, r.hint_type, r.mutation, r.outcome, r.routed_revision,
    r.hot_applied_at, r.rest_raw_page_ids,
    extract(epoch from (r.hot_applied_at - r.received_at)) as signal_to_hot_seconds,
    s.requested_revision, s.applied_revision, s.next_due_at, s.last_refresh_outcome,
    coalesce(r.settled_at, r.hot_applied_at) as settled_at,
    coalesce(r.settlement_kind, case when r.hot_applied_at is not null then
      case when r.hint_type = 'group_created' then 'group_checked' else 'rest_materialized' end end) as settlement_kind,
    r.settlement_observation_id
  from fansly_ws_hint_receipts r left join subject_refresh_state s
    on s.page_id = r.page_id and s.plane = 'fansly_ws_dm' and s.subject_ref = r.group_ref;
