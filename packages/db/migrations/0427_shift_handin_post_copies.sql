-- agency-hub:rollback-compatible — a new table: the previous image neither writes nor reads it, and the report's own copy mark (post_copied_at, post_copied_version) is still written as before.
-- 0427_shift_handin_post_copies.sql
--
-- «Скопировать пост» per model (final review of the «Отчёт» board, the third reader's №2). A shift on pages of two
-- models has two posts, and «Отчётность» takes one post per model: the ledger's post reader reads one model from a text
-- and never a second. The board copies each model's post by its own button and remembers each copy: which version of
-- that model's post the person copied, and when. «Пост изменился» is then said per model.

set local lock_timeout = '5s';

create table if not exists shift_handin_post_copies (
  handin_id bigint not null references shift_handins(id) on delete restrict,
  model_slug text not null,
  version integer not null,
  copied_at timestamptz not null,
  primary key (handin_id, model_slug),
  constraint shift_handin_post_copies_model_check check (length(model_slug) between 1 and 100),
  constraint shift_handin_post_copies_version_check check (version > 0)
);
