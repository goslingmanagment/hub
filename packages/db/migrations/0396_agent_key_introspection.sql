-- agency-hub:rollback-compatible — a wider agent_keys check and a new index: the previous image never writes the new capability, ignores it on a key, and reads nothing through the index.
-- 0396_agent_key_introspection.sql
--
-- Agents as participants (ecosystem plan §3.3, package M1):
--
-- `introspect:agent_keys` — another service's server (ledger, ContentOps,
-- TaskIndex) asks Hub who an agent's hub key is: it presents its OWN key with
-- this capability and the sha256 of the key the agent showed it, never the key
-- itself, and learns the agent person's code, whether the key is active and
-- when it expires. No key material ever comes back.
--
-- agent_read_audit (agent_key_id, id desc) — the keys screen shows each key's
-- last call: the newest audit row of one key, without reading the whole table.
--
-- The check is rewritten whole, so it carries every capability of the
-- migrations before it: `write:matters` (0383), `read:pay_terms` and
-- `propose:people` (0387), `signin:*` (0389), `write:reports` (0390),
-- `write:system_state` (0392).

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
      'write:system_state',
      'introspect:agent_keys'
    ]::text[]
  );

create index if not exists agent_read_audit_key_last_idx
  on agent_read_audit (agent_key_id, id desc)
  where agent_key_id is not null;
