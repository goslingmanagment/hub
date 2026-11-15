import type { AuthPrincipal } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";

/**
 * The two screens of ContentOps that Hub draws (products plan §2.4, package C2): «Публикации» (`/frame/publications`)
 * and «Статистика» (`/frame/content-stats`), pages of Hub without its frame inside ContentOps' own. EVERY operation they
 * call is here, with who may call it: `content_manager` — the owner and a content manager, the latter cut to the pages
 * of their models (`pageScopeFor`, the handlers); `owner` — the owner alone, as before. The owner's standing rules stay
 * his: deleting a live post from a wall, «Снять всё» on a page, a page's publishing settings and the global switches.
 * tests/content-screens-rights.integration.test.ts walks every row as the owner, the content managers of two models, a
 * team lead and a chatter; tests/content-manager-operations.test.ts keeps every publication route of the contract on
 * this table, so a new one is decided here before anyone gets it.
 */
export const CONTENT_SCREEN_OPERATIONS: Readonly<Record<string, "content_manager" | "owner">> = {
  // «Публикации»: the feed, the platforms' schedules, the card and its actions.
  adminPublicationList: "content_manager",
  adminPublicationGet: "content_manager",
  adminPublicationApprove: "content_manager",
  adminPublicationCancel: "content_manager",
  adminPublicationWithdraw: "content_manager",
  adminPublicationReplace: "content_manager",
  adminPublicationResolve: "content_manager",
  adminPublicationQueueList: "content_manager",
  adminPublicationQueueRefresh: "content_manager",
  adminPublicationSettingsList: "content_manager",
  adminPublicationDeletePost: "owner",
  adminPublicationWithdrawPage: "owner",
  adminPublicationSettingsUpdate: "owner",
  adminConfig: "owner",
  adminConfigUpdate: "owner",
  adminConfigClear: "owner",
  syncOverview: "owner",
  syncPages: "owner",
  // «Статистика»: what of a page's media is watched, bought and commented.
  creatorStatsContent: "content_manager",
  creatorStatsMedia: "content_manager",
  contentComments: "content_manager",
  // Both: who is signed in, and the pages to choose from (the person's scope).
  me: "content_manager",
  pages: "content_manager",
};

/**
 * A content manager's login (`content_manager`, products plan §4.1) opens ContentOps alone: Hub signs them in and
 * hands them on (`auth/sso` → ContentOps), and has no console and no Workboard for them. THIS TABLE is every operation
 * such a login may call, AND NOTHING ELSE: every other one answers 403 before its handler runs (api/server.ts, the
 * policy hook), whatever the route's own declaration admits — so an operation added later stays closed to a content
 * manager until someone writes it here. tests/content-manager-operations.test.ts walks the whole contract.
 */
export const CONTENT_MANAGER_OPERATIONS: ReadonlySet<string> = new Set([
  // Who am I (the frame's products: ContentOps), and the account's own sign-ins and password.
  "me",
  "authListDevices",
  "authRevokeDevice",
  "authRevokeAllDevices",
  "authChangePassword",
  // The two screens Hub draws inside ContentOps, on the pages of their models.
  ...Object.entries(CONTENT_SCREEN_OPERATIONS).filter(([, who]) => who === "content_manager").map(([key]) => key),
]);

const REFUSAL = "Ваше рабочее место в ContentOps: в Hub и Workboard у контент-менеджера разделов нет.";

/** The refusal of an operation off the table to a content manager's login; null for anyone else or an operation on it. */
export function contentManagerRefusal(routeKey: string, principal: AuthPrincipal | null | undefined): ForbiddenError | null {
  if (!principal || principal.kind === "agent" || principal.user.role !== "content_manager") return null;
  return CONTENT_MANAGER_OPERATIONS.has(routeKey) ? null : new ForbiddenError(REFUSAL);
}
