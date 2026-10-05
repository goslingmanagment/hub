import type { ClientSendCustodyListQuery, ClientSendCustodyListResponse } from "@agency_hub_core/contracts";
import { findPageSummaryByLabel, listClientSendCustody } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";

/**
 * chat-extension H-7e: the cabinet's list of held sends (`clientSendCustodyList`),
 * what the owner and a team lead read before they resolve one by hand
 * (`resolveClientSendCustodyByStaff`, services/client-claim.ts).
 *
 * Who reads what is the resolve's own rule: a cookie session of a role that
 * uses the dashboard, on the pages that person reaches. No chat-extension
 * switch gates it: a held send must stay visible, like it stays resolvable,
 * while the extension is switched off.
 *
 * Database only: nothing here asks OnlyFans or queues work, and nothing is
 * written. No text of a message is served: the custody tables hold none.
 */
export async function listClientHeldSendsForStaff(
  app: AppContext,
  principal: AuthPrincipal,
  input: {
    query: ClientSendCustodyListQuery;
    /** The pages the principal reaches (`pageScopeFor`): undefined is every page, the owner's. */
    pageScope: readonly number[] | undefined;
  },
): Promise<ClientSendCustodyListResponse> {
  // A cookie session of the owner or a team lead; a chatter and every device token are refused.
  requireDashboardUser(principal);
  const { query } = input;

  let pages: "all" | readonly number[] = input.pageScope ?? "all";
  if (query.pageLabel !== undefined) {
    // The answers of the resolve route: 404 for a page that does not exist, 403 for one not reached.
    const page = await findPageSummaryByLabel(app.db, query.pageLabel);
    if (!page) {
      throw new NotFoundError(`Page "${query.pageLabel}" was not found`);
    }
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    pages = [page.id];
  }

  const list = await listClientSendCustody(app.db, {
    state: query.state,
    pages,
    limit: query.limit,
    offset: query.offset,
  });
  return {
    items: list.items.map((item) => ({
      attemptId: item.attemptId,
      pageLabel: item.pageLabel,
      fanRef: item.fanRef,
      userId: item.userId,
      username: item.username,
      instanceId: item.instanceId,
      purpose: item.purpose,
      state: item.state,
      generationRef: item.generationRef,
      variant: item.variant,
      partIndex: item.partIndex,
      partCount: item.partCount,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      ticketExpiresAt: item.ticketExpiresAt?.toISOString() ?? null,
      greeting: {
        state: item.greeting ? "confirmed" : "none",
        at: item.greeting?.at.toISOString() ?? null,
        source: item.greeting?.source ?? null,
        firstPartIsThisAttempt: item.greeting?.firstPartIsThisAttempt ?? false,
      },
      resolution: item.resolution && {
        outcome: item.resolution.outcome,
        at: item.resolution.at.toISOString(),
        userId: item.resolution.userId,
        username: item.resolution.username,
        note: item.resolution.note,
        platformMessageId: item.resolution.platformMessageId,
      },
    })),
    limit: query.limit,
    offset: query.offset,
    total: list.total,
    serverNow: list.now.toISOString(),
  };
}
