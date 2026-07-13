alter table device_tokens
  add column harvest_machine_id uuid;

create unique index device_tokens_harvest_machine_uidx
  on device_tokens (harvest_machine_id)
  where harvest_machine_id is not null;

-- Compatibility lookup for facts accepted before harvest dedupe moved from
-- <principal>:<event> to <machine>:<event>. Non-unique deliberately: an old
-- cross-principal crash window may already have produced duplicates, and the
-- capture-first journal must never delete or rewrite those facts in migration.
create index observations_harvest_machine_client_event_idx
  on observations (
    (payload->>'machineId'),
    (split_part(idempotency_key, ':', 2))
  )
  where source = 'client_capture'
    and producer like 'desktop-harvest@%'
    and kind like 'harvest.%';
