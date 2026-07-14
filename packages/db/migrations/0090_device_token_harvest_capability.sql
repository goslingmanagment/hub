alter table device_tokens
  add column harvest_machine_id uuid;

create unique index device_tokens_harvest_machine_uidx
  on device_tokens (harvest_machine_id)
  where harvest_machine_id is not null;
