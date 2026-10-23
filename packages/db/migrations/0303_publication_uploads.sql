-- agency-hub:rollback-compatible — a new table; the previous image never names it.
-- 0303_publication_uploads.sql
--
-- Publications (docs/plans/2026-10-23-wall-posts, plan PR 4c): a new file
-- of an OnlyFans publication goes to OnlyFans through the OnlyFansAPI
-- uploader before the post (`POST /{account}/media/upload`, a one-use
-- `ofapi_media_…` id). The upload is its own step with its own result: an
-- `ofapi_capture_jobs` row of kind media_upload (sent once, its lost answer
-- reconciled by the upload's id — status reads and webhooks — never sent
-- again), fed from the publication file's bytes on disk through an
-- `ofapi_media_sources` row whose journaled observation names the file.
--
--   publication_uploads   which upload serves which file of which approval:
--                         one per (publication, approval, role, position).
--                         A new approval (and so a replacement) uploads
--                         again: the one-use id belongs to one post command.
--                         estimated_credits counts toward the publications'
--                         own OnlyFansAPI credits per day.

set local lock_timeout = '5s';

create table publication_uploads (
  id bigserial primary key,
  publication_id bigint not null references publications(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  revision_id bigint not null references publication_revisions(id) on delete restrict,
  role text not null,
  position integer not null,
  file_id bigint not null references publication_files(id) on delete restrict,
  ofapi_media_source_id uuid not null,
  capture_job_id uuid not null,
  estimated_credits integer not null,
  created_at timestamptz not null default now(),
  constraint publication_uploads_role_check check (role in ('media', 'preview')),
  constraint publication_uploads_credits_check check (estimated_credits >= 1),
  constraint publication_uploads_once_uniq unique (publication_id, revision_id, role, position)
);

create index publication_uploads_page_created_idx on publication_uploads (page_id, created_at);
create index publication_uploads_created_idx on publication_uploads (created_at);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on publication_uploads to read_only;
  end if;
end $$;
