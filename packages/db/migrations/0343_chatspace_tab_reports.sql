-- agency-hub:rollback-compatible — a new table and a new incident kind only; the previous image names neither.

-- The always-on ChatSpace tab (apps/chatspace-browser): its last report per
-- install of the extension — the view the tab sits on (its sign-in page when
-- OnlyMonster's session is gone) and the socket's coverage of each OnlyMonster
-- account open in it. Only the server's hub user (CHATSPACE_SERVER_USERNAME)
-- is kept; the API's ops watchdog pages the owner from it (incident kind
-- `chatspace_tab`). One row per install, overwritten every minute: nothing of
-- it is a fact of the archive.

set local lock_timeout = '5s';

create table if not exists chatspace_tab_reports (
  user_id bigint not null references users(id) on delete cascade,
  instance_id text not null,
  reported_at timestamptz not null,
  extension_version text not null,
  route text not null,
  accounts jsonb not null,
  primary key (user_id, instance_id)
);

alter type notification_incident_kind add value if not exists 'chatspace_tab';
