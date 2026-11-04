-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability.
-- 0350_agent_approve_vault_albums.sql
--
-- `approve:vault_albums` (owner 2026-11-04): a key that approves vault albums
-- and nothing else. Fans do not see an album, so a content manager's own agent
-- holds this right instead of `approve:publications`, which also reaches paid
-- posts.

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
      'read:content'
    ]::text[]
  );
