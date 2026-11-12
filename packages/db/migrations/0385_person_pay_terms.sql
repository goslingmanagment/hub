-- agency-hub:rollback-compatible — one new table nothing of the previous image names.
-- 0385_person_pay_terms.sql
--
-- A person's pay terms (ecosystem plan 2026-11-12, package A), in shadow: what
-- the person earns on a model from a day on — a share of the model's money and
-- a fixed sum per shift. One row per person, model and first day; a term holds
-- until the next one of the same person and model. Today the agency ledger
-- still pays by the payout sheets' tab headers («Ставка %», «Фикс/см»); it
-- starts reading these on the owner's date, in its own change.
--
-- Money: only the owner writes these, and they never reach anyone else's
-- session (no team read, no chatter read); an agent key reads them only with
-- `read:pay_terms` (0387). The read_only role is deliberately NOT granted.
--
-- person_pay_terms — one term:
--   share_basis_points    the share of the model's money, in hundredths of a percent (2500 = 25 %)
--   fix_per_shift_mills   the fixed sum per day with a shift, mills ($0.001); 0 — none
--   valid_from            the first day (Moscow) the term holds
--   note                  the owner's line about it

set local lock_timeout = '5s';

create table if not exists person_pay_terms (
  id bigserial primary key,
  person_id bigint not null references people(id) on delete restrict,
  model_id bigint not null references models(id) on delete restrict,
  valid_from date not null,
  share_basis_points integer not null,
  fix_per_shift_mills bigint not null default 0,
  note text,
  created_at timestamptz not null default now(),
  created_by_user_id bigint references users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by_user_id bigint references users(id) on delete restrict,
  constraint person_pay_terms_key unique (person_id, model_id, valid_from),
  constraint person_pay_terms_share_check check (share_basis_points between 0 and 10000),
  constraint person_pay_terms_fix_check check (fix_per_shift_mills >= 0),
  constraint person_pay_terms_note_check check (note is null or length(note) <= 500)
);

comment on table person_pay_terms is
  'A person''s pay terms on a model from a day on (0385): share in basis points and a fix per shift in mills. Owner only; never in another person''s session.';
