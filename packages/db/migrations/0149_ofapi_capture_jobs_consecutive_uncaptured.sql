-- 0149: decision #246 — capture jobs park after a bounded run of reservations
-- that produced no captured response, instead of retrying a safe read every
-- 60 s until the job cap (production 2026-08-28..30: one post_paginate job on
-- lora-vip-of dispatched 1 000 times without a single captured page).
ALTER TABLE "ofapi_capture_jobs"
  ADD COLUMN "consecutive_uncaptured" integer NOT NULL DEFAULT 0
    CHECK ("consecutive_uncaptured" >= 0);
