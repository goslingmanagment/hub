-- Stage 16: two new Fansly sync streams (capability names final per target
-- §4.1; Stage 18 adopts them without rename). ADD VALUE in a per-file tx is
-- fine on PG >= 12 — the values are first used by code (0052/0054 precedent).
ALTER TYPE "sync_stream" ADD VALUE IF NOT EXISTS 'fan_earnings';
ALTER TYPE "sync_stream" ADD VALUE IF NOT EXISTS 'purchase_history';
