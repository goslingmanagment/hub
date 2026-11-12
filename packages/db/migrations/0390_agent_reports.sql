-- agency-hub:rollback-compatible — a new table nothing of the previous image names, and a wider agent_keys check: the previous image never writes the new capability and ignores it on a key.
-- 0390_agent_reports.sql
--
-- Agent reports (ecosystem plan §2 «Канал трафика», package O): a named
-- markdown page an agent key publishes and people read in the app — the
-- traffic routine's daily summary first. One row per slug: publishing the same
-- slug again replaces the page; `version` counts the changes of its text, the
-- previous text is not kept (each publish leaves an agent_read_audit row with
-- the body's digest and length).
--   slug                lowercase words and hyphens, the page's address
--   section             traffic | team | content | system: where it belongs in the owner's place
--   body                markdown, at most 256 KB; the app renders it, never reformats it
--   team_leads          team leads read it too (the owner reads every report; chatters none)
--   valid_hours         the page is stale this many hours after published_at; null: never
--   published_by_key_id the key that published it last
--
-- `write:reports` is the capability that publishes. The agent_keys check is
-- rewritten whole, so it carries every capability of the migrations before it
-- (`signin:*` of 0389 the last).
--
-- The read_only role is deliberately NOT granted: a report may carry money,
-- which the owner reads.

set local lock_timeout = '5s';

create table if not exists agent_reports (
  id bigserial primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (char_length(title) between 1 and 200),
  section text not null check (section in ('traffic', 'team', 'content', 'system')),
  body text not null check (octet_length(body) between 1 and 262144),
  team_leads boolean not null default false,
  valid_hours integer check (valid_hours between 1 and 8784),
  version integer not null default 1 check (version >= 1),
  published_at timestamptz not null default clock_timestamp(),
  published_by_key_id bigint references agent_keys(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

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
      'write:reports'
    ]::text[]
  );
