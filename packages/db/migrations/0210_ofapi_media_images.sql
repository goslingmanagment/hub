-- ChatGoose Desktop media images (docs/runbooks/ofapi-media.md).
--
-- Four purely additive tables; no existing table, index or constraint changes.
-- The hub keeps only locators (known file URLs), a per-resolve decision log and
-- the agency's paid-download budget. Bytes never pass through or rest on the hub.

-- Known file URLs per OFAPI account, media id, variant and source. A row keeps
-- the durable linkage (provenance, access flags, whether a free Expires-signed
-- URL was ever seen) after its signature expires: the daily cleanup clears only
-- the url/signature columns. This is a derived service cache rebuilt from
-- ofapi_webhook_events.payload and gateway observations, never a captured fact.
create table if not exists ofapi_media_locators (
  ofapi_account_id text not null,
  media_id text not null,
  variant text not null,
  source text not null,
  page_id bigint references pages(id) on delete restrict,
  url text,
  path_sha256 text,
  sig_kind text,
  expires_at timestamptz,
  media_type text,
  file_ext text,
  chat_id text,
  message_id text,
  vault_media boolean not null default false,
  can_view boolean,
  is_ready boolean,
  deleted boolean not null default false,
  had_free_url boolean not null default false,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (ofapi_account_id, media_id, variant, source),
  constraint ofapi_media_locators_variant_check check (variant in ('thumb', 'full')),
  constraint ofapi_media_locators_source_check check (source in ('webhook', 'gateway')),
  constraint ofapi_media_locators_sig_kind_check
    check (sig_kind is null or sig_kind in ('expires', 'policy', 'fansapi', 'unknown'))
);

create index if not exists ofapi_media_locators_message_idx
  on ofapi_media_locators (ofapi_account_id, message_id)
  where message_id is not null;

create index if not exists ofapi_media_locators_expiry_idx
  on ofapi_media_locators (expires_at)
  where url is not null;

create index if not exists ofapi_media_locators_page_idx
  on ofapi_media_locators (page_id);

-- One row per resolve (never per local cache hit). No URL, signature or file
-- content is ever written here: identifiers, the decision and its price only.
create table if not exists ofapi_media_fetch_log (
  id bigserial primary key,
  resolve_id uuid not null,
  client_request_id uuid not null,
  occurred_at timestamptz not null default now(),
  accrual_day date not null,
  page_id bigint references pages(id) on delete restrict,
  ofapi_account_id text not null,
  actor_user_id bigint not null,
  surface text not null,
  trigger text not null,
  media_id text not null,
  media_type text,
  variant text not null,
  path_sha256 text,
  outcome text not null,
  reason text,
  content_length bigint,
  credits_estimated integer not null default 0,
  over_cap boolean not null default false,
  had_free_url_expired boolean not null default false,
  after_reread boolean not null default false,
  certainty text not null,
  ledger_entry_id bigint,
  client_result text,
  bytes_received bigint,
  http_status integer,
  reported_at timestamptz,
  constraint ofapi_media_fetch_log_resolve_uniq unique (resolve_id),
  constraint ofapi_media_fetch_log_request_uniq unique (actor_user_id, client_request_id),
  constraint ofapi_media_fetch_log_surface_check
    check (surface in ('thread', 'gallery', 'vault', 'lightbox')),
  constraint ofapi_media_fetch_log_trigger_check check (trigger in ('auto', 'click')),
  constraint ofapi_media_fetch_log_variant_check check (variant in ('thumb', 'full')),
  constraint ofapi_media_fetch_log_outcome_check check (outcome in (
    'free_url', 'ofapi_cache', 'paid', 'cap_blocked', 'source_expired',
    'unavailable', 'refused', 'pending', 'error')),
  constraint ofapi_media_fetch_log_certainty_check
    check (certainty in ('estimated', 'confirmed', 'unknown')),
  constraint ofapi_media_fetch_log_credits_check check (credits_estimated >= 0)
);

create index if not exists ofapi_media_fetch_log_day_idx
  on ofapi_media_fetch_log (accrual_day);

create index if not exists ofapi_media_fetch_log_page_idx
  on ofapi_media_fetch_log (page_id, accrual_day);

-- The agency-wide paid-download budget: one row per UTC day of issuance.
-- Admission is `insert ... on conflict do nothing` then a conditional update.
create table if not exists ofapi_media_daily_budget (
  day date primary key,
  credits_used integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint ofapi_media_daily_budget_used_check check (credits_used >= 0)
);

-- Single-flight per file (account, media, variant): held while one resolve
-- talks to OFAPI and, after a paid hand-out, until its report or held_until.
create table if not exists ofapi_media_flights (
  flight_key text primary key,
  resolve_id uuid not null,
  held_until timestamptz not null
);
