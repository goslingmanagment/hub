-- agency-hub:rollback-compatible — a new table and a wider check: the previous image never names the table, and never writes a source over 100 MB (one it finds is refused as unavailable).
-- 0398_ofapi_upload_links.sql
--
-- Large files of an OnlyFans vault album go by a link (8-docs
-- 2026-11-12-of-vault-album, plan PR 7). OnlyFansAPI takes a file as bytes up
-- to 100 MB; a larger one only as `file_url`, which it downloads itself. Hub
-- serves that one file at GET /api/v1/public/vault-upload-files/<token>
-- (services/ofapi-upload-links.ts).
--
--   ofapi_upload_links  one row per link Hub handed to OnlyFansAPI: the
--                       sha256 of its token (never the token), the one file it
--                       serves, the page and the upload job it belongs to, its
--                       expiry (at most 6 hours), its revocation (the upload's
--                       outcome, or a newer link of the same job) and how many
--                       times and from which addresses it was fetched.
--
-- A link serves only while it is not revoked, not expired and its job has no
-- outcome; the route answers 404 to anything else.
--
-- ofapi_media_sources.byte_size: a source over 100 MB is now a vault album's
-- file sent by a link; the check widens to the setting's highest limit
-- (onlyfansVaultLinkMaxMb at most 10 000 MB). Its bytes stay on disk.

alter table ofapi_media_sources drop constraint ofapi_media_sources_byte_size_check;
alter table ofapi_media_sources add constraint ofapi_media_sources_byte_size_check
  check (byte_size between 1 and 10000000000);

create table if not exists ofapi_upload_links (
  id uuid primary key,
  token_sha256 bytea not null unique check (octet_length(token_sha256) = 32),
  page_id bigint not null references pages(id) on delete restrict,
  file_id bigint not null references publication_files(id) on delete restrict,
  upload_job_id uuid not null references ofapi_capture_jobs(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  fetch_count integer not null default 0 check (fetch_count >= 0),
  last_fetched_at timestamptz,
  fetched_from text[] not null default '{}',
  check (expires_at > created_at and expires_at <= created_at + interval '6 hours')
);

-- A job's live links: revoked together when its outcome comes.
create index if not exists ofapi_upload_links_job_live
  on ofapi_upload_links (upload_job_id) where revoked_at is null;
