-- A4: cover the owner ledger list's filtered + ordered + paginated access paths.
-- The list orders by (occurred_at desc, id desc) and filters by page_id or
-- operation; today only source and a bare occurred_at index exist, so page/
-- operation filters fall back to a seq scan + sort. These composites let Postgres
-- read the requested page straight from the index with no sort.
create index if not exists ofapi_credit_ledger_page_occurred_at_id_idx
  on ofapi_credit_ledger (page_id, occurred_at desc, id desc);

create index if not exists ofapi_credit_ledger_operation_occurred_at_id_idx
  on ofapi_credit_ledger (operation, occurred_at desc, id desc);

-- Matches the default (unfiltered / date-range-only) order+limit exactly, unlike
-- the ascending occurred_at-only index which still needs a sort for the id tiebreak.
create index if not exists ofapi_credit_ledger_occurred_at_id_idx
  on ofapi_credit_ledger (occurred_at desc, id desc);
