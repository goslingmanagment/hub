-- OFAPI account health + credit ops (Phase 3 of docs/ofapi-integration-plan.md).
-- pages.ofapi_auth_status mirrors the latest accounts.* webhook state for the
-- mapped OFAPI account (raw event suffix: connected | reconnected |
-- session_expired | authentication_failed | otp_code_required |
-- face_otp_required), advanced forward-only by received_at.
-- New notification incident kinds cover OFAPI auth states (per page) and the
-- account-global credit/webhook-silence conditions; global incidents carry no
-- page, so notification_incidents.platform_account_id becomes nullable.

ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'ofapi_auth';
ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'ofapi_low_credit';
ALTER TYPE "notification_incident_kind" ADD VALUE IF NOT EXISTS 'ofapi_webhook_silence';

ALTER TABLE "notification_incidents" ALTER COLUMN "platform_account_id" DROP NOT NULL;

ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "ofapi_auth_status" text;
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "ofapi_auth_changed_at" timestamp with time zone;
