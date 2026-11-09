-- agency-hub:rollback-compatible — only a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0361_agent_read_team.sql
--
-- `read:team` (owner 2026-11-09): the team's work and the facts of every sale
-- on the key's pages (`agentTeamSales`) for the agency ledger, which decides
-- whose each sale is and what anyone is paid (ledger release 2).

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
      'read:team'
    ]::text[]
  );
