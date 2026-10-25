-- agency-hub:rollback-compatible — new columns with defaults: the previous image never reads them, and a post approved with any of them set does not match the approval it recomputes without them, so it goes back to draft before anything is sent.
-- 0317_publications_post_options.sql
--
-- Wall posts: three options of a Fansly post (owner, 2026-10-25; the
-- contract §12, docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md):
-- - `pin_wall_refs`: the walls the post is pinned on ("Pin to Walls",
--   `pinWallIds`; §12.1, §12.7);
-- - `reply_lock`: who may reply ("Lock Replies", `postReplyPermissionFlags`;
--   §12.4) — followers and/or subscribers, any of them; empty: everyone;
-- - `subscribers_only`: a paid post only subscribers may buy — of every tier,
--   or of the tiers named (§12.3, `flags` 5: subscribed AND the price).

set local lock_timeout = '5s';

alter table publications
  add column pin_wall_refs text[] not null default '{}',
  add column reply_lock text[] not null default '{}',
  add column subscribers_only boolean not null default false;

alter table publications
  add constraint publications_reply_lock_check
    check (reply_lock <@ array['followers', 'subscribers']::text[]),
  add constraint publications_subscribers_only_check
    check (not subscribers_only or kind = 'paid_post');
