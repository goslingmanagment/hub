-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0370_agent_look_media.sql
--
-- `look:media` (owner 2026-11-11): an agent key looks at its page's own media
-- — frames (≤ 512 px) Hub pulls through the page's session, never the file,
-- never a link.

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
      'look:media'
    ]::text[]
  );
