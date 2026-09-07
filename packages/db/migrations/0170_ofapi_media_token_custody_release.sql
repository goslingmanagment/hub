-- One-use media custody outlives its command only while that command may still
-- have spent the material. A DEFINITE non-delivery — a pre-delivery 4xx other
-- than 408/429, or a command that never dispatched — leaves the token unspent:
-- its reservation is RELEASED, never deleted (the custody row stays the record
-- of who held it and why it was freed), and the next reservation re-arms the
-- same row and fence. Indeterminate, 5xx, 429 and confirmed outcomes never
-- release; a reuse child never releases its parent's reservation.
ALTER TABLE ofapi_media_token_custody
 ADD COLUMN released_at timestamptz,
 ADD COLUMN released_reason text,
 ADD CONSTRAINT ofapi_media_token_custody_release_check
  CHECK ((released_at IS NULL) = (released_reason IS NULL));
ALTER TABLE ofapi_media_token_fences
 ADD COLUMN released_at timestamptz,
 ADD COLUMN released_reason text,
 ADD CONSTRAINT ofapi_media_token_fences_release_check
  CHECK ((released_at IS NULL) = (released_reason IS NULL));

-- A released fence guards nothing and is re-armed by the next custody claim;
-- an armed fence still rejects a different operation.
CREATE OR REPLACE FUNCTION preserve_ofapi_media_token_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 material_hash text;
 held_operation uuid;
 held_released timestamptz;
BEGIN
 material_hash := encode(sha256(convert_to(NEW.account_id || chr(10) || NEW.token,'UTF8')),'hex');
 INSERT INTO ofapi_media_token_fences(token_hash,operation_id)
  VALUES(material_hash,NEW.operation_id) ON CONFLICT DO NOTHING;
 SELECT operation_id, released_at INTO held_operation, held_released FROM ofapi_media_token_fences
  WHERE token_hash=material_hash FOR UPDATE;
 IF held_released IS NOT NULL THEN
  UPDATE ofapi_media_token_fences SET operation_id=NEW.operation_id, released_at=NULL, released_reason=NULL
   WHERE token_hash=material_hash;
  held_operation := NEW.operation_id;
 END IF;
 IF held_operation IS DISTINCT FROM NEW.operation_id THEN
  RAISE EXCEPTION 'OFAPI one-use media is already reserved' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END;
$$;
