-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0334_agent_read_content.sql
--
-- `read:content` (owner 2026-10-29): the page's own published material and its
-- statistics — posts, attachments, files, vault, their views and likes,
-- capture coverage and sync streams — with this capability alone, without
-- `read:datasets` or `read:messages`, so without thread inventory, fans,
-- purchases or money. The ContentOps key's narrow right.

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
      'write:fan_queues',
      'read:content'
    ]::text[]
  );
