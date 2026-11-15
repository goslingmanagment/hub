-- agency-hub:rollback-compatible — one nullable column: the previous image neither writes nor reads it; a version it makes has none, and the feed then names the report's shift, as it did.
-- 0426_shift_handin_version_shift.sql
--
-- A version keeps the shift it was made under (final review of the «Отчёт» board, products package R). The ledger keeps
-- a shift's highest version as that shift's report. A report moved to the shift that remains after a merge must not
-- leave its last version current under the old shift while its next one counts the same sales under the new shift: the
-- feed names each version's own shift, and the move makes a version with no lines under the old one. Null — a version
-- made before this column: the report's shift, as before. Versions stay immutable: nothing old is written.

set local lock_timeout = '5s';

alter table shift_handin_versions add column if not exists shift_id bigint references shifts(id) on delete restrict;
