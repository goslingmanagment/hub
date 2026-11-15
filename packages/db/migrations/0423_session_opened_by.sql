-- agency-hub:rollback-compatible — one nullable column; the old image never reads it.
-- 0423: who opened a web session that lives on no cookie of Hub's (products plan, package C4): ContentOps' own sign-in
-- page signs a person in by login and password through Hub; the Hub session behind its grant is marked here, so its
-- «Выйти» ends that session and never one the person opened in Hub or Workboard themselves. Null — Hub's own pages.
alter table auth_sessions add column if not exists opened_by text;
alter table auth_sessions drop constraint if exists auth_sessions_opened_by_check;
alter table auth_sessions add constraint auth_sessions_opened_by_check check (opened_by is null or opened_by in ('contentops'));
