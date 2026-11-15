import type { KernelOperationKey } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import type { AuthPrincipal } from "./auth.ts";
import { teamPagesFor } from "./teams.ts";

/**
 * «Фаны» in Workboard (products package M, plan §4.2): who sees which fans. The owner every page (as before); anyone
 * else signed in by a cookie (a team lead, a chatter, the extension's narrow session) the fans of the pages of their
 * teams — the one cut of package T, `teamPagesFor`: their teams' pages plus the pages their login was granted. A
 * device token (the extension's own reads go through its client routes) and an agent key read by their grant, exactly
 * as before.
 *
 * The cut is applied by handing the reads a principal whose granted pages ARE that cut: every check they already make
 * (`canAccessPage`, `pageScopeFor`, the spender scope) then answers by it, so no read gets a second rule.
 */
const FAN_READS: readonly KernelOperationKey[] = [
  "spenders",
  "spenderDetail",
  "spenderSeries",
  "spenderBatch",
  "pageSpenderAutoLists",
  "pageSpenderAutoListDetail",
  "pageSubscribers",
  "pageFollowers",
  "pageDeletedFans",
  "pageFanCard",
  "pageFanDetail",
  "pageFanProfile",
  "pageFanProfileVersions",
  "pageFanProfileVersion",
  "pageFanTransactions",
  "pageFanWorkedWith",
  "crossPageFanDetail",
  "crossPageFanTransactions",
  "pageConversationPreview",
  "fanPages",
];
export const FAN_READ_OPERATIONS: ReadonlySet<string> = new Set<string>(FAN_READS);

/** The principal a fans read answers: a non-owner cookie session sees its teams' pages (see above). */
export async function asFanReader<P extends AuthPrincipal>(app: Pick<AppContext, "db">, principal: P): Promise<P> {
  if (principal.kind === "agent" || principal.authMethod !== "session" || principal.user.role === "owner") return principal;
  const pages = await teamPagesFor(app as AppContext, principal);
  return pages === undefined ? principal : { ...principal, assignedPageIds: pages };
}
