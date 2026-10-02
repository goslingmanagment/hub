import { listEngineOwnedFanslyPages, listFanslyFanPageIdentityBackfillTargets } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { fanslyPageSendGuard } from "./fansly-send-guard/index.ts";
import { resolvePageContext } from "./page-context.ts";
import { assertLegacyOwnsFanslyPageLabels, SYNC_ENGINE_HINTS } from "./sync-engine-guard.ts";
import { upsertHydratedFansForPageDetailed } from "./sync/fan-hydration.ts";

export interface FanslyPageAliasBackfillPageSummary {
  pageId: number;
  pageLabel: string;
  membershipsScanned: number;
  uniqueFanIds: number;
  accountsReturned: number;
  fallbackMisses: number;
  reconciledAccounts: number;
  notesSeen: number;
  notesUpserted: number;
  notesDeactivated: number;
  aliasesSet: number;
  aliasesCleared: number;
}

export async function backfillFanslyPageAliases(
  app: AppContext,
  input?: {
    pageLabels?: string[];
    chunkSize?: number;
  },
) {
  const requestedPageLabels = Array.from(new Set((input?.pageLabels ?? []).filter(Boolean)));
  // Step-3 design §3.1 item 11: a page named here that the Fansly Sync Engine
  // owns is refused before any page is resolved or sends.
  await assertLegacyOwnsFanslyPageLabels(app, requestedPageLabels, SYNC_ENGINE_HINTS.aliasBackfill);
  const pageContexts = requestedPageLabels.length > 0
    ? await Promise.all(requestedPageLabels.map((pageLabel) => resolvePageContext(app, pageLabel)))
    : [];

  for (const pageContext of pageContexts) {
    if (pageContext.platform !== "fansly") {
      throw new Error(`Page "${pageContext.page.label}" is not a Fansly page`);
    }
  }

  const requestedPageIds = pageContexts.map((pageContext) => pageContext.page.id);
  const targets = await listFanslyFanPageIdentityBackfillTargets(app.db, requestedPageIds.length > 0
    ? { platformAccountIds: requestedPageIds }
    : undefined);

  const groupedTargets = new Map<number, typeof targets>();
  for (const target of targets) {
    const current = groupedTargets.get(target.platformAccountId) ?? [];
    current.push(target);
    groupedTargets.set(target.platformAccountId, current);
  }

  // An unrestricted run leaves the pages the Fansly Sync Engine owns to the
  // engine (their fan profiles are its `fan-profiles.alias-backfill`) and
  // names them; it never resolves their context.
  const engineOwned = new Set((await listEngineOwnedFanslyPages(app.db)).map((page) => page.pageId));
  const skippedEngineOwnedPages: string[] = [];
  const contexts = pageContexts.length > 0
    ? pageContexts
    : await Promise.all(
      Array.from(groupedTargets.values())
        .map((pageTargets) => pageTargets[0])
        .filter((page): page is NonNullable<typeof page> => Boolean(page))
        .filter((page) => {
          if (!engineOwned.has(page.platformAccountId)) return true;
          skippedEngineOwnedPages.push(page.pageLabel);
          return false;
        })
        .map((page) => resolvePageContext(app, page.pageLabel)),
    );

  const chunkSize = Math.min(Math.max(input?.chunkSize ?? 100, 1), 100);
  const pages: FanslyPageAliasBackfillPageSummary[] = [];

  for (const pageContext of contexts) {
    if (pageContext.platform !== "fansly") {
      continue;
    }

    const pageTargets = groupedTargets.get(pageContext.page.id) ?? [];
    const uniqueFanIds = Array.from(new Set(pageTargets.map((target) => target.platformUserId)));
    const requestContext = {
      session: pageContext.session,
      proxy: pageContext.proxy,
      egressKey: pageContext.egressKey,
      sendGuard: fanslyPageSendGuard(app, pageContext.page.id, "alias_backfill"),
    };

    const summary: FanslyPageAliasBackfillPageSummary = {
      pageId: pageContext.page.id,
      pageLabel: pageContext.page.label,
      membershipsScanned: pageTargets.length,
      uniqueFanIds: uniqueFanIds.length,
      accountsReturned: 0,
      fallbackMisses: 0,
      reconciledAccounts: 0,
      notesSeen: 0,
      notesUpserted: 0,
      notesDeactivated: 0,
      aliasesSet: 0,
      aliasesCleared: 0,
    };

    for (let index = 0; index < uniqueFanIds.length; index += chunkSize) {
      const chunk = uniqueFanIds.slice(index, index + chunkSize);
      const response = await app.adapter.getAccountsByIdsPage(requestContext, chunk);
      const fallbackIds = chunk.filter(
        (platformUserId) => !response.parsed.some((account) => account.id === platformUserId),
      );
      const result = await upsertHydratedFansForPageDetailed(app.db, {
        platformAccountId: pageContext.page.id,
        accounts: response.parsed,
        fallbackIds,
      });

      summary.accountsReturned += response.parsed.length;
      summary.fallbackMisses += fallbackIds.length;
      summary.reconciledAccounts += result.reconciledAccountCount;
      summary.notesSeen += result.noteCount;
      summary.notesUpserted += result.upsertedNoteCount;
      summary.notesDeactivated += result.deactivatedNoteCount;
      summary.aliasesSet += result.aliasesSet;
      summary.aliasesCleared += result.aliasesCleared;
    }

    pages.push(summary);
  }

  return {
    totalPages: pages.length,
    totalMembershipsScanned: pages.reduce((sum, page) => sum + page.membershipsScanned, 0),
    totalUniqueFanIds: pages.reduce((sum, page) => sum + page.uniqueFanIds, 0),
    totalAccountsReturned: pages.reduce((sum, page) => sum + page.accountsReturned, 0),
    totalFallbackMisses: pages.reduce((sum, page) => sum + page.fallbackMisses, 0),
    totalReconciledAccounts: pages.reduce((sum, page) => sum + page.reconciledAccounts, 0),
    totalNotesSeen: pages.reduce((sum, page) => sum + page.notesSeen, 0),
    totalNotesUpserted: pages.reduce((sum, page) => sum + page.notesUpserted, 0),
    totalNotesDeactivated: pages.reduce((sum, page) => sum + page.notesDeactivated, 0),
    totalAliasesSet: pages.reduce((sum, page) => sum + page.aliasesSet, 0),
    totalAliasesCleared: pages.reduce((sum, page) => sum + page.aliasesCleared, 0),
    pages,
    skippedEngineOwnedPages,
  };
}
