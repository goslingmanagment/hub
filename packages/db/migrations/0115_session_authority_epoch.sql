-- UV-001: linearize password mutation with session login.
--
-- The device-token plane already carries an authority generation
-- (users.device_token_epoch, 0092); the session plane had none, so a login
-- that verified a password before a reset committed could insert its session
-- row after the reset's revocation sweep and keep a fully valid cookie.
--
-- Expand-only and deploy-safe: both columns default to 0, so every live
-- session keeps matching its user's epoch and no one is logged out by the
-- migration itself. The first password-authority boundary after the deploy
-- advances users.session_epoch, which is exactly when those sessions were
-- meant to die anyway.

ALTER TABLE "users"
  ADD COLUMN "session_epoch" bigint DEFAULT 0 NOT NULL;

ALTER TABLE "auth_sessions"
  ADD COLUMN "session_epoch" bigint DEFAULT 0 NOT NULL;
