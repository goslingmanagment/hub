import type { KernelOperationKey } from "./sdk-runtime.ts";

/**
 * The NARROW web session (ecosystem plan §3.2 p.4): the one the chat extension
 * opens in the browser from its device token, without a password
 * (`authWebLink` → `authSsoAccept`). Its row carries the device token it lives
 * by (`auth_sessions.narrow_device_token_id`); it stops signing in the moment
 * that token is revoked or expires.
 *
 * It opens only the team's place: the API server refuses every route outside
 * this list with a reason-less 403, whatever the person's role — an owner's
 * device included — and `requireDashboardUser` refuses it, so no owner or team
 * route, stream, export, screen or document opens with it. Routes that take no
 * principal (`public`, `hmac`) are not subject to it: sign-out works.
 *
 * The list is the chatter's part of Workboard (`apps/workboard`, «Мои смены»):
 * who is signed in, their own shifts and their own reports. A screen of the
 * team's place that a narrow session should open joins here in its own PR.
 * Never on it: a route of the account's credentials (devices, password), any
 * owner or team-lead route, the hand-off's own mint (a narrow session never
 * travels to another name).
 */
export const NARROW_WEB_SESSION_OPERATIONS = [
  "me",
  "accountChatterStats",
  "accountReports",
  // The chatter's strip «Ждут вас» above «Мои смены»: a narrow session reads as a chatter (their own, never money).
  "mattersList",
  // Отчёт смены (ecosystem package F): the shift screen the extension opens, «Сдать смену» on it.
  "shiftReport",
  "shiftReportsList",
  "shiftReportClaimable",
  "shiftReportLineSet",
  "shiftReportCommentSet",
  "shiftReportOffPlatformAdd",
  "shiftReportOffPlatformWithdraw",
  "shiftReportSubmit",
] as const satisfies readonly KernelOperationKey[];

/** Whether a narrow web session may call the route with this key. */
export function narrowWebSessionAllows(operationKey: string): boolean {
  return (NARROW_WEB_SESSION_OPERATIONS as readonly string[]).includes(operationKey);
}
