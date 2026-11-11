-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0366_agent_withdraw_publications.sql
--
-- `withdraw:publications` (owner 2026-11-11): an agent key takes a Hub post
-- off the platform's schedule on its pages, as the owner's «Снять» does, and
-- reads the page's schedule to see it.

set local lock_timeout = '5s';

alter table agent_keys
  drop constraint agent_keys_capabilities_check,
  add constraint agent_keys_capabilities_check check (
    capabilities <@ array[
      'read:messages',
      'read:money',
      'read:observations_envelope',
      'read:datasets',
      'request:hydration',
      'write:publication_drafts',
      'approve:publications',
      'approve:vault_albums',
      'write:fan_queues',
      'read:content',
      'read:team',
      'withdraw:publications'
    ]::text[]
  );
