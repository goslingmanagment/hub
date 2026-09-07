import { asRecord } from "./ofapi-payloads.ts";

export const OFAPI_ACCOUNT_HEALTH_EVENT_TYPES = [
  "accounts.connected", "accounts.reconnected", "accounts.disconnected",
  "accounts.session_expired", "accounts.authentication_failed",
  "accounts.otp_code_required", "accounts.face_otp_required",
] as const;

export const OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES = [
  "media_uploads.completed", "media_uploads.failed",
  "data_exports.calculating_credits", "data_exports.calculating_credits_completed",
  "data_exports.calculating_credits_failed", "data_exports.in_progress",
  "data_exports.completed", "data_exports.failed", "data_exports.cancelled",
] as const;

export const OFAPI_OPTIONAL_WEBHOOK_GROUPS = {
  subscription_expiry: ["subscriptions.expired"],
  account_lifecycle: ["accounts.disconnected"],
  media_uploads: ["media_uploads.completed", "media_uploads.failed"],
  data_exports: OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES.filter(event => event.startsWith("data_exports.")),
  engagement: ["posts.liked"],
} as const;

export function lifecycleTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

/** Compare provider occurrence, never retry arrival. The catalog has no time
 * for some legacy payloads; receipt is then an explicitly weaker fallback. */
export function ofapiAccountLifecycleTime(payload: Record<string, unknown>, receivedAt: Date): Date {
  const attempt = asRecord(payload.latestAuthAttempt);
  return lifecycleTimestamp(payload.disconnected_at) ??
    lifecycleTimestamp(attempt?.completed_at) ?? lifecycleTimestamp(attempt?.started_at) ??
    lifecycleTimestamp(payload.updated_at) ?? receivedAt;
}
