-- agency-hub:rollback-compatible — a new incident kind only; the previous image never names it.

-- What OnlyFans itself writes to a page (its "OnlyFans" notifications tab)
-- pages the owner as its own incident kind, one latch per notice; the owner
-- closes it on the screen. From 2026-11-01 OnlyFans may hold a page's
-- earnings when a request for information is not answered promptly.

set local lock_timeout = '5s';

alter type notification_incident_kind add value if not exists 'ofapi_platform_notice';
