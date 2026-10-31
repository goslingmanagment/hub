-- agency-hub:rollback-compatible — a nullable column only; the previous image never names it.

-- The always-on ChatSpace tab's report (chatspace-tab-state-v2): ChatSpace's socket itself — connecting, open or
-- closed and since when, authenticated, its subscription set readable — as the extension's tap saw it, beside the
-- accounts (each with `subscribed`). The API's ops watchdog pages a socket down for 5 minutes and a page of the server
-- user not subscribed 10 minutes after the tab came up; a subscribed account that is quiet never pages.

set local lock_timeout = '5s';

alter table chatspace_tab_reports add column if not exists socket jsonb;
