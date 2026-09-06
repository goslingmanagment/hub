-- Immutable financial response evidence survives either accounting projection
-- failing. A settled receipt stays retained; recovery never reissues HTTP.
create table ofapi_credit_receipts (
  request_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  received_at timestamptz not null,
  observation jsonb not null,
  accounted_at timestamptz,
  accounting_path text check (accounting_path in ('ledger', 'physical')),
  primary key (request_id, attempt_number),
  check ((accounted_at is null) = (accounting_path is null))
);
create index ofapi_credit_receipts_pending_idx
  on ofapi_credit_receipts (received_at, request_id, attempt_number)
  where accounted_at is null;
comment on table ofapi_credit_receipts is
  'Permanent financial response evidence; no message bodies, fan IDs or secrets. Recovery only updates accounting settlement, never dispatches a vendor request.';
