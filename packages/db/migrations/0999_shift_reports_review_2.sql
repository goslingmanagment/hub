-- agency-hub:rollback-compatible — nullable columns, wider checks and a scrub of copied words: the previous image never names the columns, writes none of the new values and reads the scrubbed rows as before.
-- 0999_shift_reports_review_2.sql (the number is the coordinator's to give)
--
-- Review round 2b of the shift report and the claims.
--
-- shift_handin_versions.report_date — the shift's report date when the version was made (`shifts.report_date` then):
--   a night shift whose first word came before midnight is reported on the day it ended in, not frozen at the
--   first mark's. The report's own `shift_handins.report_date` follows its newest version. Null — a version older
--   than this column (its report's date stands for it).

set local lock_timeout = '5s';

alter table shift_handin_versions add column if not exists report_date date;
comment on column shift_handin_versions.report_date is
  'The shift''s report date when this version was made; null — older than 0999 (the report''s date stands).';
