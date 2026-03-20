-- telegram_settings: singleton row for UI-editable notification config
create table if not exists telegram_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default true,
  daily_report_enabled boolean not null default true,
  sync_failure_alerts_enabled boolean not null default true,
  report_hour_utc integer not null default 9 check (report_hour_utc between 0 and 23),
  encrypted_bot_token text,
  chat_id text,
  updated_at timestamptz not null default now()
);

insert into telegram_settings (id) values (1) on conflict do nothing;

-- telegram_delivery_attempts: unified log for all Telegram sends
create table if not exists telegram_delivery_attempts (
  id bigserial primary key,
  kind text not null,
  status text not null,
  notification_incident_id bigint references notification_incidents(id) on delete set null,
  report_date text,
  message_id integer,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists telegram_delivery_attempts_kind_created_idx
  on telegram_delivery_attempts (kind, created_at desc);
create index if not exists telegram_delivery_attempts_incident_idx
  on telegram_delivery_attempts (notification_incident_id) where notification_incident_id is not null;
