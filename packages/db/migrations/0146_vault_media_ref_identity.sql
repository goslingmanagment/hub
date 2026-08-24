-- Correct creator-vault membership identity from media offers to raw media.
--
-- Live `/media/vaultnew` observations carry `albumMedia[].mediaId` and no
-- `mediaOfferId`. The original projection therefore discarded every creator
-- membership row after capture. `media_ref` is the lossless identity: every
-- captured member has one, while one raw file can back several offer rows.

ALTER TABLE "creator_vault_album_members"
  DROP CONSTRAINT "creator_vault_album_members_pkey";

ALTER TABLE "creator_vault_album_members"
  ALTER COLUMN "media_offer_ref" DROP NOT NULL,
  ALTER COLUMN "media_ref" SET NOT NULL;

ALTER TABLE "creator_vault_album_members"
  DROP CONSTRAINT "creator_vault_album_members_refs_check";

ALTER TABLE "creator_vault_album_members"
  ADD CONSTRAINT "creator_vault_album_members_refs_check" CHECK (
    length("album_ref") > 0
    AND length("media_ref") > 0
    AND ("media_offer_ref" IS NULL OR length("media_offer_ref") > 0)
    AND ("member_ref" IS NULL OR length("member_ref") > 0)
    AND ("bundle_ref" IS NULL OR length("bundle_ref") > 0)
    AND ("preview_ref" IS NULL OR length("preview_ref") > 0)
  ),
  ADD CONSTRAINT "creator_vault_album_members_pkey"
    PRIMARY KEY ("page_id", "vault_kind", "album_ref", "media_ref");

DROP INDEX "creator_vault_album_members_page_kind_offer_idx";
DROP INDEX "creator_vault_album_members_page_offer_idx";

CREATE INDEX "creator_vault_album_members_page_kind_media_idx"
  ON "creator_vault_album_members" ("page_id", "vault_kind", "media_ref");

CREATE INDEX "creator_vault_album_members_page_offer_idx"
  ON "creator_vault_album_members" ("page_id", "media_offer_ref")
  WHERE "media_offer_ref" IS NOT NULL;
