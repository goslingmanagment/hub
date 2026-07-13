-- Typing is a lossy four-second UI hint, not a recoverable business command.
-- Rows created before the short-retention implementation still carry the old
-- 400-day horizon; cap that legacy horizon at migration time so the minutely
-- sweep can expire/purge them instead of retaining nearly a year of beacons.
-- GREATEST preserves the existing dedupe_horizon >= created_at constraint for
-- any clock-skewed/future fixture row.
update ofapi_commands
set dedupe_expires_at = greatest(created_at, now())
where kind = 'typing_active_v1'
  and dedupe_expires_at > greatest(created_at, now());
