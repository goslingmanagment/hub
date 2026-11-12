-- agency-hub:rollback-compatible — one nullable column: the previous image never names it, and its reads and writes of agent_keys pass as before.
-- 0411_agent_key_replaced_at.sql
--
-- A key being replaced (review round 2). An agent holds one live key at a time (person_agent_keys, its one
-- writer insertPersonAgentKey), which left no way to replace a key without downtime: the old one had to be
-- revoked first, and a key a service also signs in with closed every session of that service at once.
--
-- A new key may now be issued AS THE REPLACEMENT of the agent's live key: it takes that key's pages and
-- capabilities exactly, and the old key is not revoked — it ends by itself a day later.
--
-- replaced_at — when a replacement was issued for this key. From then its expires_at is final: the grace
--   ahead of that moment (never later than it was), and use no longer slides it (recordAgentKeyUse). Null:
--   not replaced. Nothing else of the row changes; the two keys are equal until the old one ends.

set local lock_timeout = '5s';

alter table agent_keys add column if not exists replaced_at timestamptz;

comment on column agent_keys.replaced_at is
  'When a replacement was issued for this key (0999): its expires_at is final from then and no longer slides on use. Null: not replaced.';
