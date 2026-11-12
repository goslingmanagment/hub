-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0383_agent_write_matters.sql
--
-- `write:matters` (ecosystem plan, package D): an agent key opens, closes and
-- comments matters by their reason key — its own kinds only; the kinds the
-- server mirrors stay the server's.

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
      'withdraw:publications',
      'delete:posts',
      'look:media',
      'write:matters'
    ]::text[]
  );
