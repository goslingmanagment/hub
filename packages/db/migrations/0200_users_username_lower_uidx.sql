-- Decision 349 (Р4): logins are unique case-insensitively. Transactional (no
-- CONCURRENTLY): the table holds a few dozen rows, the lock is momentary and the
-- transaction gives restart safety. Precondition (owner-run before deploy):
--   select lower(username), count(*) from users group by 1 having count(*) > 1;
-- must return zero rows, otherwise the migration fails and the deploy stops.
create unique index users_username_lower_uidx on users (lower(username));
