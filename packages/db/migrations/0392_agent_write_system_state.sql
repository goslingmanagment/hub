-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0392_agent_write_system_state.sql
--
-- `write:system_state` («Состояние», ecosystem plan, package P): a reporter's
-- key sends its whole list of routines and copies. Nothing else.
--
-- The check is rewritten whole, so it carries every capability of the
-- migrations before it, through `write:reports` (0390).

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
      'write:matters',
      'read:pay_terms',
      'propose:people',
      'signin:contentops',
      'signin:taskindex',
      'signin:monitor',
      'write:reports',
      'write:system_state'
    ]::text[]
  );
