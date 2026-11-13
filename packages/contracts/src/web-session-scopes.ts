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
 * The list is what the chatter's part of Workboard reads and does (`apps/workboard`:
 * «Мои смены» and a shift's report, «Кастомы», «Начало»): every operation a
 * screen of the chatter's menu or name menu calls is either here or on
 * NARROW_WEB_SESSION_PASSWORD_ONLY below, and the screen says so — the test
 * `tests/narrow-session-screens.test.ts` walks the screens' code and fails on
 * anything else. Never on it: a route of the account's credentials (devices,
 * password), where a person is paid, any owner or team-lead route, the
 * hand-off's own mint (a narrow session never travels to another name).
 * A read on it that could carry where a person is paid leaves it out for a
 * narrow session (the hand-off's integration test walks every read of the
 * list for it). Services read a narrow session as a chatter whatever the role.
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
  // Заявки (ecosystem package G): the other side answers a claim on their shift report.
  "saleClaimAnswer",
  // Цепочка продажи (package T): from a sale of the shift screen, whose it is down to its payout, as the person may see it.
  "saleChain",
  // «Мои деньги» on «Мои смены» (ecosystem package H1): the person's own sums, behind their switch.
  "accountPay",
  // «Мои смены»: what stands between the person's own shifts and their reports; a narrow session reads as a chatter.
  "shiftReportNotes",
  // «Кастомы» (package I): the board, an order and the steps a chatter takes on their pages' orders (the lead all of
  // them); «Ждут вас» of the extension leads to an order page.
  "customOrdersBoard",
  "customOrder",
  "customOrderCreate",
  "customOrderAct",
  "customSaleDismiss",
  // The page filter of «Кастомы»: the pages the person reaches.
  "pages",
  // «Начало» (package J): a newcomer's way, read. Of where payouts go it carries only whether it is written and when:
  // Hub leaves the text out for a narrow session (`ownPayoutDetailsSchema`), and nothing is written from here.
  "accountStart",
] as const satisfies readonly KernelOperationKey[];

/**
 * What a screen of the chatter's part calls and a narrow session must NOT do:
 * a change that needs the person's password behind it. The screen shows the
 * person the way in instead (Workboard's `PasswordWayIn`: «чтобы изменить,
 * войдите на сайте с паролем»), never an error. Not one of these is on the
 * list above.
 */
export const NARROW_WEB_SESSION_PASSWORD_ONLY = [
  // «Начало»: where a person is paid does not change from a session that needed no password.
  "accountPayoutDetailsSet",
  // «Аккаунт и устройства»: the account's devices, password and AI spend.
  "authListDevices",
  "authRevokeDevice",
  "authRevokeAllDevices",
  "authChangePassword",
  "authMyUsage",
] as const satisfies readonly KernelOperationKey[];

/** Whether a narrow web session may call the route with this key. */
export function narrowWebSessionAllows(operationKey: string): boolean {
  return (NARROW_WEB_SESSION_OPERATIONS as readonly string[]).includes(operationKey);
}
