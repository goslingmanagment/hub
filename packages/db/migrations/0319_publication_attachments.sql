-- agency-hub:rollback-compatible — a new table, a column with a default and a wider check: the previous image never reads them or writes an `attachment:N` item, and a post approved with more than one attachment does not match the approval it recomputes without them, so it goes back to draft before anything is sent.
-- 0319_publication_attachments.sql
--
-- Wall posts: a Fansly post of several attachments, each with its own
-- audience (owner, 2026-10-25) — a free teaser and a paid set in one post.
-- The site makes one per "Upload" window: account media or a bundle, with its
-- own permissions, in the post's `attachments` in order (the contract §12.2,
-- docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md).
--
-- - `publication_media.attachment`: which attachment a file is of — 0 the
--   post's own (its kind decides who sees it), 1… the extra ones;
-- - `publication_attachments`: who sees each extra attachment — everyone,
--   the subscribers (of every tier or of the tiers named; with a price,
--   anyone else buys it), or whoever pays (only subscribers, when
--   `subscribers_only`);
-- - `fansly_write_commands.item`: `attachment:N`, the account media or the
--   bundle of an extra attachment (the post's own keeps `''`).

set local lock_timeout = '5s';

alter table publication_media
  add column attachment smallint not null default 0,
  add constraint publication_media_attachment_check check (attachment between 0 and 9);

create table publication_attachments (
  publication_id bigint not null references publications(id) on delete cascade,
  attachment smallint not null,
  access text not null,
  tier_refs text[] not null default '{}',
  price_mills bigint,
  subscribers_only boolean not null default false,
  constraint publication_attachments_pkey primary key (publication_id, attachment),
  constraint publication_attachments_attachment_check check (attachment between 1 and 9),
  constraint publication_attachments_access_check check (access in ('everyone', 'subscribers', 'paid')),
  constraint publication_attachments_price_check check (
    (price_mills is null or price_mills > 0)
    and (access <> 'paid' or price_mills is not null)
    and (access <> 'everyone' or (price_mills is null and cardinality(tier_refs) = 0))
  ),
  constraint publication_attachments_subscribers_only_check check (
    (not subscribers_only or access = 'paid')
    and (cardinality(tier_refs) = 0 or access = 'subscribers' or subscribers_only)
  )
);

alter table fansly_write_commands drop constraint fansly_write_commands_item_check;
alter table fansly_write_commands add constraint fansly_write_commands_item_check
  check (item = '' or item ~ '^(media|preview):[0-9]+(/(part|poll):[0-9]+)?$' or item ~ '^attachment:[1-9]$');
