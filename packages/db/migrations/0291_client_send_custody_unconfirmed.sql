-- agency-hub:no-transaction
-- agency-hub:rollback-compatible
-- 0291_client_send_custody_unconfirmed.sql
--
-- chat-extension send custody, audit 2026-10-20 row 2: an unknown outcome no
-- longer holds the fan. A dispatch whose ticket ran out with no proof is set
-- aside by the next dispatch to the fan as `unconfirmed`: it leaves the fan's
-- one open send (client_send_custody_one_open) and its part
-- (client_send_custody_part_once), both partial on other states, so the person
-- may send again by a new click. A late `sent` report or the manual resolve
-- still ends it.
--
-- Additive: the state check takes one more value; no row changes. The swap
-- holds ACCESS EXCLUSIVE only briefly, bounded per try. Rollback-compatible:
-- only the new code writes the state, and no row has it until a dispatch under
-- that code sets one aside.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..60 loop
    begin
      set local lock_timeout = '1s';
      alter table client_send_custody
        drop constraint if exists client_send_custody_state_check,
        add constraint client_send_custody_state_check check (
          state in ('dispatching', 'sent', 'failed', 'resolved_sent', 'resolved_not_sent', 'unconfirmed')
        ) not valid;
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise exception 'could not lock client_send_custody to admit the unconfirmed state';
end
$do$;
-- agency-hub:statement
alter table client_send_custody validate constraint client_send_custody_state_check;
-- agency-hub:statement
comment on column client_send_custody.state is
  'dispatching | sent | failed | resolved_sent | resolved_not_sent | unconfirmed (a dispatch past its ticket with no proof, set aside by a later dispatch to the fan; holds nothing, a late sent report or a manual resolve may still end it).';
