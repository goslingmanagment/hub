-- agency-hub:rollback-compatible — one new table: the previous image never names it, and its fan erasure deletes no fan that has a row here only because the new image's erasure clears them first.
-- 0307_fan_links.sql
--
-- Chat Memory week 2 (docs/plans/2026-10-24-chat-memory/week-2.md §1): one
-- record per fan. On Fansly one fan is already one `fans` row on every page;
-- what Hub cannot know by itself is that two accounts are one person (a new
-- account, an OnlyFans account and a Fansly one). Hub suggests a pair from
-- what it holds (the same «nick/country/age» alias the team gave both, the same
-- username on both platforms, a gone account and a new one under one name),
-- and a chatter decides: `same` links the two, `different` keeps the
-- suggestion from coming back. A person is a connected group of `same` pairs.
--
-- One row per decided pair, the lower fan id first. Suggestions themselves are
-- computed when a card is read and are never stored. Who decided and when is
-- the row; the owner can undo a link (the row goes back to `different`).
--
-- Erasure: a fan's rows go with the fan, before its `fans` row (RESTRICT on
-- purpose: services/erasure FAN_FK_CURATED); an orphaned fan's rows go with it.

create table if not exists fan_links (
  fan_id bigint not null references fans(id),
  other_fan_id bigint not null references fans(id),
  decision text not null,
  reason_kind text not null,
  -- What the suggestion showed, as the chatter saw it («Zed/Atlantis/99 on lora-1»).
  reason_detail text,
  decided_by_user_id bigint not null references users(id),
  decided_at timestamptz not null default now(),
  constraint fan_links_pkey primary key (fan_id, other_fan_id),
  constraint fan_links_order_check check (fan_id < other_fan_id),
  constraint fan_links_decision_check check (decision in ('same', 'different')),
  constraint fan_links_reason_kind_check check (reason_kind in ('same_alias', 'same_username', 'replaced_account')),
  constraint fan_links_reason_detail_check check (reason_detail is null or length(reason_detail) <= 300)
);

-- The other side of a pair: a person's group is walked from either fan.
create index if not exists fan_links_other_fan on fan_links (other_fan_id);

comment on table fan_links is
  'Chat Memory: two fan accounts a chatter decided are one person (same) or not (different), from a Hub suggestion. A person is a connected group of same pairs.';
