-- agency-hub:rollback-compatible — a new table; the previous image never names it.
-- 0300_fansly_write_commands.sql
--
-- Wall posts on Fansly (docs/plans/2026-10-23-wall-posts, plan PR 6): the write
-- commands of a page's Fansly Sync Engine actor. One row is ONE request Hub
-- sends to Fansly for a publication's dispatch (publication_dispatches, 0298):
-- an upload begun or completed, account media, a bundle, the post, the story,
-- a scheduled post taken off the schedule. The dispatch is the publication's
-- "once" (one create, one withdraw); these rows are the requests inside it, the
-- way an OnlyFans dispatch points at its owner action. Nothing writes rows yet:
-- the producer comes with PR 9, and no write route is sendable before the
-- stand's capture verifies it.
--
-- One attempt (spec §8.2): a row leaves `queued` only in the admission
-- transaction of its single request (its sync_attempts row), with the
-- request's fingerprint (method, host, path with query, the body's sha256)
-- written before anything is sent. It goes back to `queued` only when that
-- attempt provably never left (aborted before the send). Every other end is
-- `answered`, `rejected` or `unknown`, and such a row is never sent again: a
-- person decides an unknown one. `refused`: never sent (a switch was off, the
-- approval moved, its window passed); the producer may queue the step again.
-- At most one row per dispatch, step and item that is not refused.

set local lock_timeout = '5s';

create table fansly_write_commands (
  id bigserial primary key,
  page_id bigint not null references pages(id) on delete restrict,
  dispatch_id bigint not null references publication_dispatches(id) on delete restrict,
  publication_id bigint not null references publications(id) on delete restrict,
  -- The request: which route of the chain, and for which of the publication's
  -- files (`media:<position>`, `preview:<position>`; '' for the publication).
  step text not null,
  item text not null default '',
  -- `urgent` only for a story in its window (spec §3.5); everything else
  -- yields to the page's urgent reads.
  priority text not null default 'background',
  not_before timestamptz not null default now(),
  -- Not sent after this (a story's 30 minutes, a scheduled post's time): it is
  -- refused, never sent late.
  not_after timestamptz,
  state text not null default 'queued',
  state_reason text,
  -- The engine's work row and the one attempt of this request (both kept as
  -- plain ids: the journal outlives neither by design).
  work_id bigint,
  attempt_id bigint,
  -- Attempts that provably never left (aborted before the send).
  not_sent_count integer not null default 0,
  -- What the admission sent: method, host, path with query, body, and its
  -- fingerprint; written in the admission's transaction, before the send.
  request jsonb,
  request_fingerprint text,
  -- The ids the answer gave (upload, media, account media, bundle, post).
  result jsonb,
  http_status integer,
  observation_id bigint,
  created_at timestamptz not null default now(),
  admitted_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint fansly_write_commands_step_check check (step in (
    'upload_create', 'upload_complete', 'account_media', 'account_media_bundle', 'post', 'story', 'post_cancel')),
  constraint fansly_write_commands_item_check check (item = '' or item ~ '^(media|preview):[0-9]+$'),
  constraint fansly_write_commands_priority_check check (priority in ('background', 'urgent')),
  constraint fansly_write_commands_state_check check (state in ('queued', 'sending', 'answered', 'rejected', 'unknown', 'refused')),
  constraint fansly_write_commands_window_check check (not_after is null or not_after > not_before),
  constraint fansly_write_commands_not_sent_check check (not_sent_count >= 0),
  -- Never admitted: no attempt. Admitted: its attempt and its fingerprint.
  constraint fansly_write_commands_attempt_check check (
    (state in ('queued', 'refused') and attempt_id is null)
    or (state not in ('queued', 'refused') and attempt_id is not null and request_fingerprint is not null and admitted_at is not null)
  ),
  constraint fansly_write_commands_fingerprint_check check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint fansly_write_commands_settled_check check ((state in ('queued', 'sending')) = (settled_at is null))
);

-- One request per dispatch, step and item: a second one exists only after the
-- first was refused, never beside one that went or may have gone.
create unique index fansly_write_commands_once_uidx on fansly_write_commands (dispatch_id, step, item)
  where state <> 'refused';
create index fansly_write_commands_page_state_idx on fansly_write_commands (page_id, state, id);
create index fansly_write_commands_publication_idx on fansly_write_commands (publication_id, id);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on fansly_write_commands to read_only;
  end if;
end $$;
