-- 0239_client_health_rollups.sql
--
-- chat-extension client_health intake (hub-pr-plan H-11b, storage variant B′).
--
-- The chat extension reports its own health every 15 minutes: its version, the
-- host build, the host-contract verdict, counters by code and perf histograms
-- (packages/contracts/src/routes-client.ts, clientHealthReportV1Schema). The
-- report arrives on the authenticated capture lane, so the hub sees who sent
-- it. It is NOT journaled in `observations`, which keeps the payload and the
-- user forever and carries both into the lake. The intake folds a report into
-- the hourly rollups below and keeps nothing else of it:
--
--   client_health_receipts         the report's client event id, so a resent
--                                  report is not counted twice
--   client_health_contract_hourly  reports and reports with a broken host
--                                  contract
--   client_health_missing_hourly   reports that missed one host anchor
--   client_health_counters_hourly  counters by code, summed
--   client_health_perf_hourly      histograms merged bucket by bucket: the
--                                  client's perf metrics (ms) and the levels
--                                  the hub buckets itself, one observation per
--                                  report: the two footprint sizes (KB) and
--                                  the client's DOM node count (nodes), which
--                                  arrives among the counters and is kept out
--                                  of the counter totals
--
-- No user, page, fan, chat, message or device column anywhere, and no report
-- body. The hour is the hour the HUB received the report (UTC), never the
-- client's window. The group columns are codes: a client version or host build
-- that is not one is filed under '(other)', and a host build the client could
-- not read is ''. The CHECKs hold that for every writer.
--
-- No scheduled deletion, no foreign key to pages or users, nothing to erase:
-- the rows name no person and no page. Nothing writes them until the owner
-- turns chatExtensionHealthIngestEnabled on. Purely additive; the previous
-- image never names these tables.

create table if not exists client_health_receipts (
  client_event_id uuid primary key,
  received_hour timestamptz not null,
  constraint client_health_receipts_hour_check check (mod(extract(epoch from received_hour), 3600) = 0)
);

comment on table client_health_receipts is
  'client_health reports already folded into the hourly rollups, by client event id. A resent report finds its row and is not counted twice. No user and no report body.';
comment on column client_health_receipts.client_event_id is
  'The capture event id the client derives from the report''s kind, version and window. The same id from another sender is the same receipt: nothing here tells senders apart.';
comment on column client_health_receipts.received_hour is 'The UTC hour the report was folded into.';

create table if not exists client_health_contract_hourly (
  hour timestamptz not null,
  client_name text not null,
  client_version text not null,
  host_kind text not null,
  host_build text not null,
  reports bigint not null,
  failed_reports bigint not null,
  primary key (hour, client_name, client_version, host_kind, host_build),
  constraint client_health_contract_hourly_hour_check check (mod(extract(epoch from hour), 3600) = 0),
  constraint client_health_contract_hourly_name_check check (client_name ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_contract_hourly_version_check
    check (client_version = '(other)' or client_version ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_contract_hourly_kind_check check (host_kind ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_contract_hourly_build_check
    check (host_build in ('', '(other)') or host_build ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_contract_hourly_reports_check
    check (reports >= 0 and failed_reports >= 0 and failed_reports <= reports)
);

comment on table client_health_contract_hourly is
  'client_health reports per hub hour and client group: how many arrived and how many said the host contract was broken. No user.';
comment on column client_health_contract_hourly.hour is 'The UTC hour the hub received the reports.';
comment on column client_health_contract_hourly.client_version is
  'The client version as a code; ''(other)'' for a version that is not one.';
comment on column client_health_contract_hourly.host_build is
  'The host build fingerprint as a code; '''' when the client could not read it, ''(other)'' for a build that is not a code.';
comment on column client_health_contract_hourly.failed_reports is 'Reports with contractOk = false.';

create table if not exists client_health_missing_hourly (
  hour timestamptz not null,
  client_name text not null,
  client_version text not null,
  host_kind text not null,
  host_build text not null,
  anchor text not null,
  reports bigint not null,
  primary key (hour, client_name, client_version, host_kind, host_build, anchor),
  constraint client_health_missing_hourly_hour_check check (mod(extract(epoch from hour), 3600) = 0),
  constraint client_health_missing_hourly_name_check check (client_name ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_missing_hourly_version_check
    check (client_version = '(other)' or client_version ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_missing_hourly_kind_check check (host_kind ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_missing_hourly_build_check
    check (host_build in ('', '(other)') or host_build ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_missing_hourly_anchor_check check (anchor ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_missing_hourly_reports_check check (reports >= 0)
);

comment on table client_health_missing_hourly is
  'How many client_health reports of an hour and client group did not find one anchor of the host contract. No user.';

create table if not exists client_health_counters_hourly (
  hour timestamptz not null,
  client_name text not null,
  client_version text not null,
  host_kind text not null,
  host_build text not null,
  code text not null,
  total bigint not null,
  primary key (hour, client_name, client_version, host_kind, host_build, code),
  constraint client_health_counters_hourly_hour_check check (mod(extract(epoch from hour), 3600) = 0),
  constraint client_health_counters_hourly_name_check check (client_name ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_counters_hourly_version_check
    check (client_version = '(other)' or client_version ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_counters_hourly_kind_check check (host_kind ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_counters_hourly_build_check
    check (host_build in ('', '(other)') or host_build ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_counters_hourly_code_check check (code ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_counters_hourly_total_check check (total >= 0)
);

comment on table client_health_counters_hourly is
  'client_health counters (errors by code, prevented inserts, P1s) summed per hub hour and client group. A counter code that is a level, not a count (footprint.dom-nodes-max), is not here: it is bucketed in client_health_perf_hourly. No user.';

create table if not exists client_health_perf_hourly (
  hour timestamptz not null,
  client_name text not null,
  client_version text not null,
  host_kind text not null,
  host_build text not null,
  metric text not null,
  schema_version integer not null,
  unit text not null,
  bounds double precision[] not null,
  counts bigint[] not null,
  count bigint not null,
  sum double precision not null,
  max double precision not null,
  primary key (hour, client_name, client_version, host_kind, host_build, metric, schema_version),
  constraint client_health_perf_hourly_hour_check check (mod(extract(epoch from hour), 3600) = 0),
  constraint client_health_perf_hourly_name_check check (client_name ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_perf_hourly_version_check
    check (client_version = '(other)' or client_version ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_perf_hourly_kind_check check (host_kind ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_perf_hourly_build_check
    check (host_build in ('', '(other)') or host_build ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_perf_hourly_metric_check check (metric ~ '^[A-Za-z0-9._:-]{1,80}$'),
  constraint client_health_perf_hourly_schema_version_check check (schema_version > 0),
  constraint client_health_perf_hourly_unit_check check (unit in ('ms', 'KB', 'nodes')),
  constraint client_health_perf_hourly_buckets_check
    check (cardinality(bounds) >= 1 and cardinality(counts) = cardinality(bounds) + 1),
  constraint client_health_perf_hourly_totals_check check (count >= 0 and sum >= 0 and max >= 0)
);

comment on table client_health_perf_hourly is
  'client_health histograms merged per hub hour, client group, metric and schema version. Percentiles are read off the merged buckets, never averaged from reports. No user.';
comment on column client_health_perf_hourly.metric is
  'A perf metric of the client (CLIENT_HEALTH_PERF_METRICS, unit ms) or a level the hub buckets itself, one observation per report: a footprint size (footprint.cachesKB, footprint.logsKB, unit KB) or the largest count of the client''s own DOM nodes in the window (footprint.dom-nodes-max, unit nodes).';
comment on column client_health_perf_hourly.schema_version is
  'The version of the metric''s bounds and meaning. Rows of two versions never merge.';
comment on column client_health_perf_hourly.bounds is
  'Upper bounds of the buckets: counts[1] holds values <= bounds[1], counts[i] values in (bounds[i-1], bounds[i]], the last count values above the last bound.';
comment on column client_health_perf_hourly.counts is 'Observations per bucket, added element by element.';
comment on column client_health_perf_hourly.count is 'Observations in all buckets.';
comment on column client_health_perf_hourly.sum is 'Sum of the observed values.';
comment on column client_health_perf_hourly.max is 'The largest observed value; it tops the last bucket.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on client_health_contract_hourly to read_only;
    grant select on client_health_missing_hourly to read_only;
    grant select on client_health_counters_hourly to read_only;
    grant select on client_health_perf_hourly to read_only;
  end if;
end $$;
