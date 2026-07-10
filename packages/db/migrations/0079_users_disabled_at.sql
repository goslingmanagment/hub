-- 0079: user deactivation tombstone (decision #126). Chatters and staff are
-- never hard-DELETEd — fact tables reference users.id (ofapi_commands is
-- RESTRICT) and spend/audit attribution must survive offboarding. Deactivation
-- mirrors the Stage 13 pages soft-delete standard: NULL = active; a set
-- timestamp freezes the account (login, api-key, device-token auth all refuse)
-- and hides it from the default admin list.
ALTER TABLE users ADD COLUMN disabled_at timestamptz;
