-- A consumed CDN capability cannot become reusable when its fan payload is erased.
-- Keep only a one-way digest and opaque operation identity, with no parent FK.
-- Caller-chosen action UUIDs must not impersonate an erased chat operation.
ALTER TABLE ofapi_action_intents ADD COLUMN media_operation_id uuid NOT NULL DEFAULT gen_random_uuid();
UPDATE ofapi_action_intents a SET media_operation_id=a.id
 WHERE EXISTS (SELECT 1 FROM ofapi_media_token_custody c WHERE c.action_intent_id=a.id);

CREATE TABLE ofapi_media_token_fences (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 operation_id uuid NOT NULL
);

LOCK TABLE ofapi_media_token_custody IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO ofapi_media_token_fences(token_hash,operation_id)
 SELECT encode(sha256(convert_to(account_id || chr(10) || token,'UTF8')),'hex'),operation_id
 FROM ofapi_media_token_custody;

-- Older runtime instances can still write custody during a rolling deployment.
-- Preserve those claims too; deleting their personal linkage never deletes this fence.
CREATE FUNCTION preserve_ofapi_media_token_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 material_hash text;
 held_operation uuid;
BEGIN
 material_hash := encode(sha256(convert_to(NEW.account_id || chr(10) || NEW.token,'UTF8')),'hex');
 INSERT INTO ofapi_media_token_fences(token_hash,operation_id)
  VALUES(material_hash,NEW.operation_id) ON CONFLICT DO NOTHING;
 SELECT operation_id INTO held_operation FROM ofapi_media_token_fences
  WHERE token_hash=material_hash FOR UPDATE;
 IF held_operation IS DISTINCT FROM NEW.operation_id THEN
  RAISE EXCEPTION 'OFAPI one-use media is already reserved' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_ofapi_media_token_fence
 BEFORE INSERT OR UPDATE OF account_id,token,operation_id ON ofapi_media_token_custody
 FOR EACH ROW EXECUTE FUNCTION preserve_ofapi_media_token_fence();
