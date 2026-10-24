-- agency-hub:rollback-compatible — nullable columns and a wider check only: the previous image never names the new columns and never writes the new source.
-- 0305_client_send_attributions_fansly.sql
--
-- Chat Memory week 1 (docs/plans/2026-10-24-chat-memory/plan.md §1): the
-- author of every message, on both sites. The chat extension on fansly.com
-- reports its page's own sends as `fansly-extension`, with the chat's group
-- id in `conversation_ref`. Every report now also says how the text was
-- written (`composed_with`: by hand, or inserted by one of the AI buttons,
-- or not known) and whether it was edited after the insert; a row of an
-- older client has neither. Each fact is journaled in `observations` before
-- its row: `observation_id` names that journal row (no foreign key — the
-- journal is partitioned and tiered).

set local lock_timeout = '5s';

alter table client_send_attributions
  add column if not exists composed_with text,
  add column if not exists edited boolean,
  add column if not exists observation_id bigint;

alter table client_send_attributions drop constraint client_send_attributions_source_check;
alter table client_send_attributions add constraint client_send_attributions_source_check
  check (source in ('chatspace-extension', 'fansly-extension'));

alter table client_send_attributions add constraint client_send_attributions_composed_with_check
  check (composed_with is null or composed_with in ('hand', 'reply', 'fix', 'hi', 'ping', 'coach', 'unknown'));
