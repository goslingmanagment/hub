-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0389_agent_key_signin_clients.sql
--
-- `signin:contentops`, `signin:taskindex`, `signin:monitor` (ecosystem plan
-- §3.2): the server key of another service exchanges a one-time sign-in code
-- for «who is this» — the person and whether they are the owner, never a Hub
-- session token — and re-checks that sign-in later. One capability per
-- service: a key redeems only its own service's codes.
--
-- The check is rewritten whole, so it carries every capability of the
-- migrations before it: `write:matters` (0383), `read:pay_terms` and
-- `propose:people` (0387).

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
      'signin:monitor'
    ]::text[]
  );
