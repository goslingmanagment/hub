-- Decision 354: a deleted account keeps its immutable id and all historical
-- references. The human-readable login can be assigned to a DIFFERENT row.
-- Disabled accounts remain restorable and continue reserving their login.
-- Transactional migration: the uniqueness replacement is never half-applied.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users DROP CONSTRAINT users_username_unique;
DROP INDEX users_username_lower_uidx;
CREATE UNIQUE INDEX users_username_lower_uidx
  ON users (lower(username)) WHERE deleted_at IS NULL;

-- Deletion is permanent. Even a future accidental generic user update cannot
-- restore the row or give it password authority again. The old username and id
-- remain unchanged for audit/history joins.
CREATE FUNCTION preserve_deleted_user_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'User identity is immutable';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND (
    NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
    OR NEW.username IS DISTINCT FROM OLD.username
    OR NEW.password_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Deleted user identity cannot be restored or changed';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND NEW.password_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Deleted user cannot retain password authority';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND NEW.disabled_at IS NULL THEN
    RAISE EXCEPTION 'Deleted user must remain disabled';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_deleted_user_identity
  BEFORE UPDATE ON users FOR EACH ROW
  EXECUTE FUNCTION preserve_deleted_user_identity();
