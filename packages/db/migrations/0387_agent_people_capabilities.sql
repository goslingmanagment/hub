-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capabilities and ignores them on a key.
-- 0387_agent_people_capabilities.sql
--
-- The people registry for agent keys (ecosystem plan 2026-11-12, package A):
--   read:pay_terms  — the people feed (`agentPeople`, read:team) carries each person's pay terms too: money,
--                     for the agency ledger's key only;
--   propose:people  — an agent proposes a change about a person (or a new person); it waits for the owner.
--
-- The list keeps `write:matters` (0383, package D, merged before this one): the check is rewritten whole, so it
-- carries every capability of the migrations before it.

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
      'propose:people'
    ]::text[]
  );
