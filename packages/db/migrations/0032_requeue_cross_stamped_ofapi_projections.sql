-- Pre-deploy audit B4: the DM projection runner used to stamp every settled
-- row it saw, so with OFAPI_DM_PROJECTION_ENABLED on, presence/subscription
-- journal rows (users.online/offline, subscriptions.*) were terminally marked
-- 'skipped' with the DM runner's "Event type ... is not projected" reason —
-- and the mark never demotes a settled status, so their real projections and
-- the sweep silently no-op'ed. The runner is now event-type-gated; this
-- requeues the rows it mis-stamped so the presence/subscription sweeps can
-- back-project them. The reason string is unique to the DM runner, and DM
-- event types are excluded so legitimately-skipped DM rows keep their status.
-- projection_attempts resets to 0: the only recorded attempt was the
-- mis-stamp itself (the owning projections never ran).

UPDATE "ofapi_webhook_events"
SET "projection_status" = 'pending',
    "projection_error" = NULL,
    "projection_attempts" = 0
WHERE "projection_status" = 'skipped'
  AND "projection_error" LIKE 'Event type "%" is not projected'
  AND "event_type" NOT IN (
    'messages.received',
    'messages.sent',
    'messages.deleted',
    'messages.ppv.unlocked',
    'tips.received'
  );
