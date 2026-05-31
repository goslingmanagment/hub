ALTER TABLE "models"
  ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;

-- Backfill existing rows preserving the current alphabetical order, with gaps
-- between values so creators can be reordered by swapping positions.
WITH ordered AS (
  SELECT "id", (row_number() OVER (ORDER BY "slug" ASC)) * 10 AS pos
  FROM "models"
)
UPDATE "models" AS m
SET "sort_order" = ordered.pos
FROM ordered
WHERE ordered."id" = m."id";
