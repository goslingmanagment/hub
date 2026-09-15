-- Decision 343: B0 capture-only; no business writer or polling changes.
alter table observations drop constraint observations_source_check;
alter table observations add constraint observations_source_check check (
  source in ('webhook','pull','client_capture','readthrough','command_result','operator','ofapi_capture','fansly_ws')
) not valid;

create table fansly_ws_connections (
  id uuid primary key,
  page_id bigint not null references pages(id) on delete restrict,
  generation text not null,
  started_at timestamptz not null default clock_timestamp(),
  last_guard_at timestamptz not null default clock_timestamp(),
  verified_at timestamptz,
  last_capture_at timestamptz,
  last_ordinal bigint not null default 0,
  closed_at timestamptz,
  stop_reason text,
  -- Every attempt starts with an unresolved coverage gap. B0 never claims
  -- REST repaired transient facts, or that a pong closed a prior gap.
  gap_since timestamptz not null default clock_timestamp(),
  gap_state text not null default 'unknown' check (gap_state = 'unknown'),
  check (generation ~ '^[0-9a-f]{64}$')
);
create index fansly_ws_connections_page_time on fansly_ws_connections(page_id, started_at desc);

create table fansly_ws_decode_receipts (
  observation_id bigint primary key,
  page_id bigint not null references pages(id) on delete restrict,
  received_at timestamptz not null,
  decoded_at timestamptz,
  nodes jsonb,
  -- Pending includes a crash after raw commit; unknown children remain debt.
  state text not null default 'pending' check (state in ('pending','retained','debt'))
);
create index fansly_ws_decode_pending on fansly_ws_decode_receipts(observation_id) where state = 'pending';
do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on fansly_ws_connections, fansly_ws_decode_receipts to read_only;
  end if;
end $$;

-- The raw codec keeps nested JSON strings intact. Search those strings at
-- erasure time, including escaped Unicode refs. Only this tagged codec uses
-- the recursive arm; existing capture representation/identity is unchanged.
create function fansly_ws_json_contains(value jsonb, subject text, depth integer default 0)
returns boolean language plpgsql immutable parallel safe as $$
declare child jsonb; decoded jsonb; raw text;
begin
  if depth > 32 then return true; end if;
  case jsonb_typeof(value)
    when 'string' then
      raw := value #>> '{}';
      if position(subject in raw) > 0 then return true; end if;
      begin decoded := raw::jsonb; exception when others then return false; end;
      if decoded = value then return false; end if;
      return fansly_ws_json_contains(decoded, subject, depth + 1);
    when 'number' then return value::text = subject;
    when 'array' then
      for child in select jsonb_array_elements(value) loop
        if fansly_ws_json_contains(child, subject, depth + 1) then return true; end if;
      end loop;
    when 'object' then
      for child in select v from jsonb_each(value) as entry(k,v) loop
        if fansly_ws_json_contains(child, subject, depth + 1) then return true; end if;
      end loop;
    else return false;
  end case;
  return false;
end $$;
