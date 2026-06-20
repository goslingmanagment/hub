alter table ofapi_webhook_events
  add column if not exists archive_status text default 'none' not null,
  add column if not exists archive_error text,
  add column if not exists archive_attempts integer default 0 not null,
  add column if not exists archived_at timestamp with time zone;

alter table ofapi_webhook_events
  drop constraint if exists ofapi_webhook_events_archive_status_check;

alter table ofapi_webhook_events
  add constraint ofapi_webhook_events_archive_status_check
  check (archive_status in ('none', 'pending', 'archived', 'skipped', 'failed'));

create index if not exists ofapi_webhook_events_archive_idx
  on ofapi_webhook_events (archive_status, id)
  where archive_status in ('pending', 'failed');
