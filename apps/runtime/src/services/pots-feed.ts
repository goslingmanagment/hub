import type { AgentPotDistributionFeedItem, AgentPotDistributionsFeedResponse } from "@agency_hub_core/contracts";
import {
  holdPotDistributionChanges,
  listMatterPageLabels,
  listPotDistributionChangesAfter,
  listPotDistributionChangesHeld,
  listPotDistributionsForFeed,
  placePotDistributionChanges,
  releasePotDistributionChangesHeld,
  type PotDistributionChangeRow,
  type PotDistributionHydratedRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * The pot distributions feed (0443, Contract K2): every posted or reversed Workboard pot distribution change after a
 * cursor, in the order the feed placed it. Follows `sale-homes-feed.ts` (`release -> place -> list`) and filters the
 * caller's realm (`is_test`) in SQL BEFORE `held`, `limit`, or `next`, so test rows never enter a live key's feed,
 * held list, or cursor.
 *
 * A distribution is held for an agent key if ANY page of the pot (`pots.page_ids` union its parts' `page_id`) is
 * outside the key's granted `principal.pageIds`.
 */

type FeedApp = Pick<AppContext, "db">;

function isReadable(dist: PotDistributionHydratedRow | undefined, granted: ReadonlySet<number>): boolean {
  if (dist === undefined || dist.allPageIds.length === 0) return false;
  return dist.allPageIds.every((pageId) => granted.has(pageId));
}

function ungrantedPageLabels(
  dist: PotDistributionHydratedRow | undefined,
  granted: ReadonlySet<number>,
  labelOf: ReadonlyMap<number, string>,
): string[] {
  if (dist === undefined) return ["unknown"];
  const missing = dist.allPageIds.filter((pageId) => !granted.has(pageId));
  const labels = [...new Set(missing.map((pageId) => labelOf.get(pageId) ?? `#${pageId}`))].sort();
  return labels.length > 0 ? labels : [...new Set(dist.allPageIds.map((pageId) => labelOf.get(pageId) ?? `#${pageId}`))].sort();
}

export async function readPotDistributionsFeed(
  app: FeedApp,
  input: {
    pageIds: readonly number[];
    since?: string | undefined;
    limit: number;
    agentKeyId?: number | undefined;
    realm?: "live" | "test";
  },
  now: Date = new Date(),
): Promise<AgentPotDistributionsFeedResponse> {
  const { db } = app;
  const isTest = input.realm === "test";
  const afterSeq = input.since === undefined ? 0 : Number(input.since);

  // 1. Release held items whose pot + parts pages are all now granted (re-placed at the end under the advisory lock).
  if (input.agentKeyId !== undefined) {
    await releasePotDistributionChangesHeld(db, { agentKeyId: input.agentKeyId, pageIds: input.pageIds, isTest });
  }
  // 2. Place any newly committed changes after every place given before.
  await placePotDistributionChanges(db);
  // 3. List placed changes strictly within the caller's realm (filtering test rows BEFORE `held` and `limit`).
  const placed = await listPotDistributionChangesAfter(db, { afterSeq, limit: input.limit, isTest });

  const granted = new Set(input.pageIds);
  const placedDistIds = placed.changes.map((change) => change.distributionId);
  const hydratedPlaced = await listPotDistributionsForFeed(db, placedDistIds);

  const readable = (change: PotDistributionChangeRow) => isReadable(hydratedPlaced.get(change.distributionId), granted);
  const newlyHeld = placed.changes.filter((change) => !readable(change));
  const served = placed.changes.filter(readable);

  let allHeldRows: PotDistributionChangeRow[] = newlyHeld;
  if (input.agentKeyId !== undefined) {
    await holdPotDistributionChanges(db, { agentKeyId: input.agentKeyId, changeIds: newlyHeld.map((change) => change.id) });
    allHeldRows = await listPotDistributionChangesHeld(db, { agentKeyId: input.agentKeyId, isTest });
  }

  const extraHeldDistIds = allHeldRows
    .map((change) => change.distributionId)
    .filter((id) => !hydratedPlaced.has(id));
  const hydratedExtra = extraHeldDistIds.length > 0 ? await listPotDistributionsForFeed(db, extraHeldDistIds) : new Map<number, PotDistributionHydratedRow>();
  const hydrated = (id: number) => hydratedPlaced.get(id) ?? hydratedExtra.get(id);

  // Filter any held rows that are now readable (defensive when called without agentKeyId or raced grant).
  const heldRows = allHeldRows.filter((change) => !isReadable(hydrated(change.distributionId), granted));
  const pages = heldRows.length > 0 ? await listMatterPageLabels(db) : { labelOf: new Map<number, string>(), idOf: new Map<string, number>() };

  const changes: AgentPotDistributionFeedItem[] = [];
  for (const change of served) {
    const dist = hydrated(change.distributionId);
    if (dist === undefined) continue;
    changes.push({
      seq: change.seq,
      change: dist.reversedAt === null ? change.change : "reversed",
      at: (dist.reversedAt ?? change.at).toISOString(),
      distribution: {
        id: dist.id,
        pot: {
          code: dist.potCode,
          name: dist.potName,
          modelSlug: dist.modelSlug,
        },
        day: dist.day,
        formula: {
          kind: dist.formula.kind,
          params: dist.formula.params,
        },
        inflows: dist.inflows.map((inflow) => ({
          transactionId: inflow.transactionId,
          pageLabel: inflow.pageLabel,
          baseMills: inflow.baseMills,
        })),
        baseMills: dist.baseMills,
        lines: dist.lines.map((line) => ({
          personCode: line.personCode,
          baseMills: line.baseMills,
          basis: line.basis,
        })),
      },
    });
  }

  return {
    changes,
    held: heldRows.map((change) => ({
      seq: change.seq,
      distributionId: change.distributionId,
      pageLabels: ungrantedPageLabels(hydrated(change.distributionId), granted, pages.labelOf),
      reason: "page_outside_key" as const,
    })),
    next: String(placed.changes.at(-1)?.seq ?? afterSeq),
    more: placed.more,
    serverNow: now.toISOString(),
  };
}
