-- agency-hub:rollback-compatible — one new table nothing of the previous image names.
-- 0402_person_payout_details.sql
--
-- Where a person's payouts go, as the person wrote it on «Начало» (ecosystem plan 2026-11-12,
-- package J): what a newcomer tells the owner in a private message today (a Bybit UID, a wallet
-- address and its network). One free text per person, not checked, not a wallet integration.
--
-- Money-adjacent personal data: written only by the person's own session; read by that session
-- and by the owner's (the card, the payout). Never in a team lead's or another chatter's session,
-- never in an agent key's read. The read_only role is deliberately NOT granted, as with pay terms.
-- Cleared by the person: `details` null (the row stays; nothing here is deleted).

set local lock_timeout = '5s';

create table if not exists person_payout_details (
  person_id bigint primary key references people(id) on delete restrict,
  details text,
  updated_at timestamptz not null default now(),
  updated_by_user_id bigint references users(id) on delete restrict,
  constraint person_payout_details_text_check check (details is null or length(btrim(details)) between 1 and 500)
);

comment on table person_payout_details is
  'Where a person''s payouts go, as the person wrote it (0402, package J): free text; the person''s own session and the owner''s only. Null details: cleared.';
