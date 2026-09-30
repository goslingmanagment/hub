-- Owner decision 2026-09-30: Hub re-reads a fan's Fansly profile (username,
-- display name, the creator's notes and custom name on the fan) at most once a
-- day; a fan never looked up is looked up at once. The day is kept per page:
-- the notes a lookup returns belong to the page whose session asked, so the
-- stamps live on the fan's page membership.
--
-- account_lookup_at is written only by fan hydration (fan-hydration.ts), in
-- the same transaction that stores the lookup's result: the account's names
-- and notes, or deletion evidence when Fansly returned no account. A page
-- write that rolls back leaves no stamp, so the next run looks the fan up.
--
-- The DM partner probe (fansly-account-probe.ts) stores no profile, only its
-- verdict, so it keeps its own pair: hydration never reuses a probe's answer.
--
-- Purely additive: nullable, no default, so the ALTER only touches the
-- catalog. Existing rows start NULL (never looked up), and the first run
-- after the deploy looks every fan up once, as before.
ALTER TABLE page_fans
  ADD COLUMN IF NOT EXISTS account_lookup_at timestamptz,
  ADD COLUMN IF NOT EXISTS account_probe_at timestamptz,
  ADD COLUMN IF NOT EXISTS account_probe_resolved boolean;

COMMENT ON COLUMN page_fans.account_lookup_at IS
  'When a Fansly account lookup through this page last returned for this fan and Hub stored its result (the account, or deletion evidence when none came back). Sync lanes do not look the fan up again through this page within a day.';
COMMENT ON COLUMN page_fans.account_probe_at IS
  'When the DM partner probe through this page last got an answer for this fan; the probe does not ask again within a day.';
COMMENT ON COLUMN page_fans.account_probe_resolved IS
  'That probe''s answer: true when Fansly returned the account, false when it returned none.';
