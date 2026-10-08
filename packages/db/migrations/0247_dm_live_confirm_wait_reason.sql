-- 0247_dm_live_confirm_wait_reason.sql
--
-- Fansly Sync Engine, the chat Fansly stopped serving (arena "vanished chat",
-- plan §3, R1): a socket message no longer disappears after a day.
--
-- Until now the passive parity pass gave every overlay row that had no REST
-- copy 24 hours after it became visible the verdict `not_found` — the verdict
-- a REST read gives when it covers the message's place without it — and the
-- readers hide `not_found`. A chat that answers every read with an error
-- (lora-1, 04.10: HTTP 500 «error getting group messages» on every read since
-- the fan's message) never gets a REST copy, so its socket messages vanished
-- from the chatters and the AI context a day later.
--
-- From this release the window gives no verdict. The pass defers the row:
--
--   confirm_wait_reason  why an unconfirmed row is no longer awaited:
--     age_without_rest   the parity window passed without a REST copy;
--     chat_unavailable   Fansly does not serve the chat to the page (written
--                        by the chat-unavailability episode, a later release).
--                        Null on every row that is still awaited or settled.
--
-- A deferred row keeps `confirmed_at` and `confirm_outcome` null and loses its
-- next look (`confirm_due_at` null, so it leaves the partial index
-- dm_live_messages_confirm_due): the pass never looks at it again, alert 3
-- does not count it, the readers show it. A later REST read still settles it
-- — it claims rows by `confirmed_at is null` — and clears the reason. The DM
-- apply is from now on the one writer of `not_found`.
--
-- No pair CHECK ties the reason to `confirmed_at is null`: the image before
-- this one confirms rows without naming the column, so after a rollback it
-- can leave a stale reason on a confirmed row. A reason means nothing once
-- `confirmed_at` is set; every reader of it tests both.
--
-- The backfill gives the same treatment to the timer's past verdicts: a
-- `not_found` without a source (no copy compared), given at least 24 hours
-- after the row became visible (the timer's window; the DM apply's own
-- verdicts come from a read and are left alone), with no applied
-- `messages.page` read of the chat (any of dm-messages.head, .catchup,
-- .history) sent between the row's first visibility and the verdict. 38 rows
-- on production on 2026-10-08 (of 43 timer verdicts: the other 5 are deleted
-- on the socket and had such a read): the 5 undeleted ones among them come
-- back to the readers that can show them (e.g. «enjoy baby»,
-- 963176936203370497 on lora-1). The journal of reads (`sync_attempts`) is
-- kept 30 days; a verdict older than its journal has no read to show and is
-- deferred too.
--
-- Rollback-compatible: a nullable column without a default (catalog-only), a
-- CHECK added NOT VALID and validated (the table has ≈ 15 000 rows), comments,
-- one data update. The previous image never names the column; its parity pass
-- selects `confirm_due_at <= now()` and its alert 3 `confirm_due_at is not
-- null`, so it never looks at a deferred row nor counts it, and its readers
-- show it (they hide `not_found` only). For new messages during a rollback it
-- gives its own 24-hour `not_found` again; those stay hidden after the
-- forward deploy (docs/runbooks/sync.md).
--
-- LOCKING: ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- dm_live_messages, where the previous image's live apply and parity pass
-- hold row locks for a few seconds. lock_timeout keeps the wait brief: if the
-- lock is not had in 5 s this aborts and the deploy rolls back (the 0245
-- pattern). The live apply that waits behind it fails transiently and its
-- receipt stays pending for the replay.

set local lock_timeout = '5s';

alter table dm_live_messages add column if not exists confirm_wait_reason text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'dm_live_messages_confirm_wait_reason_check') then
    alter table dm_live_messages add constraint dm_live_messages_confirm_wait_reason_check
      check (confirm_wait_reason in ('age_without_rest', 'chat_unavailable')) not valid;
  end if;
end $$;

alter table dm_live_messages validate constraint dm_live_messages_confirm_wait_reason_check;

comment on column dm_live_messages.confirm_wait_reason is
  'Why an unconfirmed row is no longer awaited (no next look, no alert, still shown): age_without_rest = the parity window passed without a REST copy; chat_unavailable = Fansly does not serve the chat to the page. A REST read that reaches the row settles it and clears this. Meaningless once confirmed_at is set.';
comment on column dm_live_messages.confirm_due_at is
  'When the passive parity check next looks for this message in the REST stores; null on a deletion stub and on a deferred row (confirm_wait_reason).';
comment on column dm_live_messages.confirm_outcome is
  'Verdict: match / mismatch (mismatch_fields) against the confirm_source copy; not_found when a REST read covered the message''s place without it (the DM apply; before this column also the 24-hour parity window); excluded when the chat is excluded from message sync.';

update dm_live_messages m
   set confirmed_at = null,
       confirm_outcome = null,
       confirm_due_at = null,
       confirm_wait_reason = 'age_without_rest',
       updated_at = clock_timestamp()
 where m.confirm_outcome = 'not_found'
   and m.confirm_source is null
   and m.confirmed_at >= m.first_visible_at + interval '24 hours'
   and not exists (
     select 1
       from sync_attempts a
      where a.page_id = m.page_id
        and not a.shadow
        and a.operation = 'messages.page'
        and a.subject = m.platform_conversation_id
        and a.apply_state = 'applied'
        and a.sent_at between m.first_visible_at and m.confirmed_at
   );
