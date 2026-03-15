create index if not exists transactions_pending_boundary_idx
  on transactions(platform_account_id, transaction_state, occurred_at);
