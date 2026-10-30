-- agency-hub:rollback-compatible — one nullable column; the previous image never names it and its upserts still pass.
-- 0335_creator_raw_media_byte_size.sql
--
-- The byte size of a file's full rendition. OnlyFans serves it in `files.full.size`
-- of posts and the vault; it is the one size signal OF has, since OF has no filename.
-- NULL means the platform did not serve it, never zero.
ALTER TABLE creator_raw_media ADD COLUMN byte_size bigint;
