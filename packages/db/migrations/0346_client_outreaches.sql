-- agency-hub:rollback-compatible — two new tables: the previous image never names them.
-- 0346_client_outreaches.sql
--
-- «Рассылки» kept by Hub (docs/plans/2026-11-01-outreach-store/spec.md): the
-- chat extension's outreach window, one outreach of one page, shared by the
-- page's team. Everyone granted the page lists its outreaches, opens any of
-- them, writes in it and sends from it; Hub sends nothing to a fan.
--
-- `client_outreaches`: the outreach. Its id is the client's own (an outreach
-- made while Hub did not answer keeps it); its author is whoever saved it
-- first, its last change whoever saved or sent from it last; the common text,
-- whether its offer carries media, the window's own state (`settings`, stored
-- as the client sent it and never read) and the order of its fans once their
-- versions are written.
--
-- `client_outreach_fans`: one fan of one outreach. Fix's version and the
-- common text it was written from (`basis`, the client's own name for it),
-- the person's own words and who wrote them, and the send: `sending` (a
-- claim with a 120-second ticket) → `sent` / `failed` (proven, may be claimed
-- again) / `uncertain` (never claimed again). A claim past its ticket reads
-- `uncertain`; the archive may later prove it went (`resolved_by`). One live
-- claim per fan of a page across all its outreaches: the partial unique index
-- below, the ticket's life checked by the code under the fan's advisory lock.
-- Every report of a send is journaled in `observations` first
-- (`client.outreach_send.v1`, `observation_id`).
--
-- Deletion: an outreach untouched for 90 days is deleted when its page's list
-- is read. This is the team's working state of a window of the extension, not
-- a captured platform fact: what a chatter reported about a send stays in
-- `observations`, and the message itself in the page's archive; neither is
-- touched.
--
-- Erasure: a fan's rows go with the fan (cascade, and the fan scope's own
-- predicate); a page's with the page.

create table if not exists client_outreaches (
  id uuid primary key,
  page_id bigint not null references pages(id),
  author_user_id bigint not null references users(id),
  created_at timestamptz not null,
  updated_by_user_id bigint not null references users(id),
  updated_at timestamptz not null,
  text text not null default '',
  with_media boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  fan_order text[] not null default '{}',
  -- The fans' page is the outreach's page (their composite key below).
  constraint client_outreaches_id_page unique (id, page_id),
  constraint client_outreaches_text_check check (length(text) <= 5000),
  constraint client_outreaches_settings_check check (jsonb_typeof(settings) = 'object'),
  -- The route keeps settings to 32 KiB of the client's JSON; this backstop leaves room for jsonb's own spacing.
  constraint client_outreaches_settings_size_check check (octet_length(settings::text) <= 65536),
  constraint client_outreaches_fan_order_check check (cardinality(fan_order) <= 1000)
);

-- The page's list, newest change first, and the lazy deletion of the untouched.
create index if not exists client_outreaches_page_updated on client_outreaches (page_id, updated_at desc);

create table if not exists client_outreach_fans (
  outreach_id uuid not null,
  fan_ref text not null,
  page_id bigint not null references pages(id),
  fan_id bigint not null references fans(id) on delete cascade,
  version text,
  basis text,
  generation_ref text,
  version_at timestamptz,
  edit text,
  edited_by_user_id bigint references users(id),
  edited_at timestamptz,
  send_state text,
  attempt_id uuid,
  sender_user_id bigint references users(id),
  clicked_at timestamptz,
  ticket_until timestamptz,
  sent_at timestamptz,
  platform_message_id text,
  failure_code text,
  resolved_by text,
  sent_text text,
  sent_media jsonb,
  observation_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (outreach_id, fan_ref),
  constraint client_outreach_fans_outreach_fk foreign key (outreach_id, page_id)
    references client_outreaches (id, page_id) on delete cascade,
  constraint client_outreach_fans_fan_ref_check check (fan_ref ~ '^[1-9][0-9]{0,29}$'),
  constraint client_outreach_fans_version_check check (version is null or length(version) <= 5000),
  constraint client_outreach_fans_basis_check check (basis is null or length(basis) between 1 and 64),
  constraint client_outreach_fans_version_basis_check check ((version is null) = (basis is null) and (version is null) = (version_at is null)),
  constraint client_outreach_fans_generation_ref_check check (generation_ref is null or (version is not null and length(generation_ref) between 1 and 100)),
  constraint client_outreach_fans_edit_check check (edit is null or length(edit) <= 5000),
  constraint client_outreach_fans_edited_check check ((edit is null) = (edited_by_user_id is null) and (edit is null) = (edited_at is null)),
  constraint client_outreach_fans_send_state_check check (send_state is null or send_state in ('sending', 'sent', 'uncertain', 'failed')),
  constraint client_outreach_fans_send_check check (
    (send_state is null) = (attempt_id is null)
    and (send_state is null) = (sender_user_id is null)
    and (send_state is null) = (clicked_at is null)
    and (send_state is null) = (sent_text is null)
  ),
  constraint client_outreach_fans_ticket_check check (coalesce(send_state = 'sending', false) = (ticket_until is not null)),
  constraint client_outreach_fans_sent_check check (coalesce(send_state = 'sent', false) = (sent_at is not null)),
  constraint client_outreach_fans_failed_check check (coalesce(send_state = 'failed', false) = (failure_code is not null)),
  constraint client_outreach_fans_failure_code_check check (failure_code is null or length(failure_code) between 1 and 64),
  constraint client_outreach_fans_resolved_by_check check (resolved_by is null or (send_state = 'sent' and resolved_by in ('archive'))),
  constraint client_outreach_fans_sent_text_check check (sent_text is null or length(sent_text) between 1 and 5000),
  constraint client_outreach_fans_message_check check (platform_message_id is null or length(platform_message_id) between 1 and 100)
);

-- One live claim per fan of a page, whatever the outreach. A claim past its
-- ticket still holds its slot here until the next claim on the fan stores it
-- `uncertain` (under the fan's lock) or a report ends it.
create unique index if not exists client_outreach_fans_sending on client_outreach_fans (page_id, fan_ref) where send_state = 'sending';
-- A fan's sends by time: touches, and the pause they give «Очереди» and «Онлайн».
create index if not exists client_outreach_fans_sends on client_outreach_fans (page_id, fan_ref, clicked_at desc) where send_state is not null;
-- The fan's rows when the fan is erased (the cascade).
create index if not exists client_outreach_fans_fan on client_outreach_fans (fan_id);

comment on table client_outreaches is
  'The chat extension''s outreaches of a page, kept by Hub and shared by the page''s team: the text, the window''s state, the order of the fans.';
comment on table client_outreach_fans is
  'One fan of one outreach: Fix''s version, the person''s words, and the send claimed once (sending, sent, uncertain, failed).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on client_outreaches, client_outreach_fans to read_only;
  end if;
end
$$;
