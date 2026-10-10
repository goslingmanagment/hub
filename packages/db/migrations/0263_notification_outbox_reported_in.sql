-- 0263_notification_outbox_reported_in.sql
--
-- Д2 (bug hunt 2026-10-09): an alert outlives a Telegram outage.
--
-- 1. notification_delivery_outbox.reported_in_outbox_id: the missed-alerts
--    summary ("📵 Not delivered in time …") that reports this opening. The
--    paging sweep writes it when a page resolves before its opening reached
--    Telegram: the opening is retired (`exhausted`, last_error
--    'Not delivered: …') and its episode becomes one line of a summary row in
--    the same table. Null on every other row. Nullable without a default, so
--    the ALTER touches the catalog only; the FK is checked against a table of
--    a few hundred rows that are all null. No index: the column is read only
--    by acceptance queries joining a handful of summaries.
--
-- 2. The queue standing at deploy time gets the alerts' new delivery horizon
--    (ALERT_DELIVERY_MAX_ATTEMPTS = 400, ≥ 49 h): without it a deploy in the
--    middle of an outage would keep the old loss — a `resolved` row with four
--    failures would exhaust on its fifth, and the sweep never returns to a
--    page it has closed. Only `sync_failure` rows still in the queue; the AI
--    critical pair keeps its cap of 5, terminal rows are history.
--
-- Rollback-compatible: the previous image never names the column, sends a
-- summary as an ordinary `resolved` row, treats a retired opening as the
-- terminal `exhausted` it is, and honours any max_attempts.
ALTER TABLE notification_delivery_outbox
  ADD COLUMN IF NOT EXISTS reported_in_outbox_id bigint
    REFERENCES notification_delivery_outbox(id);

comment on column notification_delivery_outbox.reported_in_outbox_id is
  'The missed-alerts summary row that reports this opening: set by the paging sweep when the page resolved before Telegram accepted the opening (Д2).';

UPDATE notification_delivery_outbox
   SET max_attempts = 400
 WHERE paging_policy = 'sync_failure'
   AND state IN ('pending', 'leased')
   AND max_attempts < 400;
