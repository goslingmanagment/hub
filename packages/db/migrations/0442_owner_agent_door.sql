-- agency-hub:rollback-compatible — a nullable column on agent_keys and wider checks: the previous image never names the column, its inserts leave it null and never write `act:owner`; an `act:owner` key issued by the new image is to the previous image a key of no page and no capability of its own.
-- 0442_owner_agent_door.sql
--
-- The owner's agent door (payouts plan 2026-11-24, §1.8, H9): a key that acts AS the owner, on the owner's word, through
-- its own routes (`/api/v1/owner-agent/*`) and nothing else. Such a key holds the one capability `act:owner` and names
-- the owner's login it acts as (`acts_as_user_id`); it holds no other capability and no page (the owner's principal
-- decides what it reaches), and no key without `act:owner` names a login. Issued only by the server's CLI.

alter table agent_keys
  add column if not exists acts_as_user_id bigint references users(id) on delete restrict;

-- `act:owner`: the owner's agent door. The whole list, the union with main's (0412).
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
      'introspect:agent_keys',
      'write:customs',
      'write:shift_reports',
      'review:shift_reports',
      'act:owner'
    ]::text[]
  );

alter table agent_keys drop constraint if exists agent_keys_acts_as_check;
alter table agent_keys add constraint agent_keys_acts_as_check
  check (('act:owner' = any(capabilities)) = (acts_as_user_id is not null));

alter table agent_keys drop constraint if exists agent_keys_act_owner_alone_check;
alter table agent_keys add constraint agent_keys_act_owner_alone_check
  check (not ('act:owner' = any(capabilities)) or (cardinality(capabilities) = 1 and cardinality(page_ids) = 0));

comment on column agent_keys.acts_as_user_id is
  'The owner''s login an `act:owner` key acts as (0442, the owner''s agent door); null for every other key.';
