import type { AuthPrincipal } from "./auth.ts";
import { ForbiddenError } from "./errors.ts";

/**
 * A content manager's login (`content_manager`, products plan §4.1) opens ContentOps alone: Hub signs them in and
 * hands them on (`auth/sso` → ContentOps), and has no console and no Workboard for them. THIS TABLE is every operation
 * such a login may call, AND NOTHING ELSE: every other one answers 403 before its handler runs (api/server.ts, the
 * policy hook), whatever the route's own declaration admits — so an operation added later stays closed to a content
 * manager until someone writes it here. tests/content-manager-operations.test.ts walks the whole contract.
 *
 * Their page scope (the pages of the models of their working pages, auth.ts `contentManagerPageIds`) is for the
 * ContentOps screens Hub draws later (publications, products plan §2.4): those operations join this table with them.
 */
export const CONTENT_MANAGER_OPERATIONS: ReadonlySet<string> = new Set([
  // Who am I (the frame's products: ContentOps), and the account's own sign-ins and password.
  "me",
  "authListDevices",
  "authRevokeDevice",
  "authRevokeAllDevices",
  "authChangePassword",
]);

const REFUSAL = "Ваше рабочее место в ContentOps: в Hub и Workboard у контент-менеджера разделов нет.";

/** The refusal of an operation off the table to a content manager's login; null for anyone else or an operation on it. */
export function contentManagerRefusal(routeKey: string, principal: AuthPrincipal | null | undefined): ForbiddenError | null {
  if (!principal || principal.kind === "agent" || principal.user.role !== "content_manager") return null;
  return CONTENT_MANAGER_OPERATIONS.has(routeKey) ? null : new ForbiddenError(REFUSAL);
}
