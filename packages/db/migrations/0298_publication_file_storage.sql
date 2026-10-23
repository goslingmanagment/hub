-- agency-hub:rollback-compatible — two new columns of publication_files, one with a default and one nullable; the previous image never reads them and its inserts still pass.
-- 0298_publication_file_storage.sql
--
-- Files of publications (docs/plans/2026-10-23-wall-posts, plan PR 3). 0297
-- recorded an uploaded file's identity (model + sha256); its bytes now live
-- on the server's disk at <PUBLICATION_FILES_DIR>/<model_id>/<sha256> —
-- never in Postgres and never in observations, because these must be
-- deleted and collected facts are not.
--
--   stored_at          when the bytes last landed on disk: the upload, or a
--                      new upload of the same bytes for the same model. The
--                      7 days of a file nobody used count from here.
--   bytes_deleted_at   when the retention job deleted the bytes (7 days after
--                      the last publication that used the file finished). The
--                      row stays: approved revisions name the file by id and
--                      sha256. A new upload of the same bytes clears it.

set local lock_timeout = '5s';

alter table publication_files
  add column stored_at timestamptz not null default now(),
  add column bytes_deleted_at timestamptz;
