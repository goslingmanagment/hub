import type { AgentSaleHomeFeedItem, AgentSaleHomeShare, AgentSaleHomesFeedResponse } from "@agency_hub_core/contracts";
import {
  holdSaleHomeChanges,
  listHandinPeopleOfUsers,
  listMatterPageLabels,
  listSaleHomeChangesAfter,
  listSaleHomeChangesHeld,
  listSaleHomesByTransactionIds,
  listShiftReportDatesByIds,
  placeSaleHomeChanges,
  releaseSaleHomeChangesHeld,
  type SaleHomeChangeRow,
  type SaleHomeHydratedRow,
  type SaleHomeShareRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { saleKindOf } from "./sale-kinds.ts";
import { reportDateOfSale } from "./shift-rows.ts";

/**
 * The sale homes feed (0441, Contract K1): every computed home change (`upsert` or `retract`) in `sale_homes`, after a
 * cursor, in the order the feed placed it. Follows `sale-decisions-feed.ts` (`release -> place -> list`) and filters
 * the caller's realm (`is_test`) in SQL BEFORE `held`, `limit`, or `next`, so test rows (including `retract`) never
 * enter a live key's feed, held list, or cursor.
 */

type FeedApp = Pick<AppContext, "db">;

function isEnrichedShare(share: SaleHomeShareRow): share is SaleHomeShareRow & { daySource: NonNullable<SaleHomeShareRow["daySource"]> } {
  return share.daySource !== undefined;
}

export async function readSaleHomesFeed(
  app: FeedApp,
  input: { pageIds: readonly number[]; since?: string | undefined; limit: number; agentKeyId?: number | undefined; realm?: "live" | "test" },
  now: Date = new Date(),
): Promise<AgentSaleHomesFeedResponse> {
  const { db } = app;
  const isTest = input.realm === "test";
  const afterSeq = input.since === undefined ? 0 : Number(input.since);

  // 1. Release held items whose page is now granted (re-placed at the end under the feed's advisory lock).
  if (input.agentKeyId !== undefined) {
    await releaseSaleHomeChangesHeld(db, { agentKeyId: input.agentKeyId, pageIds: input.pageIds, isTest });
  }
  // 2. Place any newly committed changes after every place given before.
  await placeSaleHomeChanges(db);
  // 3. List placed changes strictly within the caller's realm (filtering test rows BEFORE `held` and `limit`).
  const placed = await listSaleHomeChangesAfter(db, { afterSeq, limit: input.limit, isTest });

  const granted = new Set(input.pageIds);
  const readable = (change: SaleHomeChangeRow) => granted.has(change.pageId);
  let held = placed.changes.filter((change) => !readable(change));
  if (input.agentKeyId !== undefined) {
    await holdSaleHomeChanges(db, { agentKeyId: input.agentKeyId, changeIds: held.map((change) => change.id) });
    held = (await listSaleHomeChangesHeld(db, { agentKeyId: input.agentKeyId, isTest })).filter((change) => !readable(change));
  }
  const served = placed.changes.filter(readable);

  const upsertTxIds = served.filter((change) => change.op === "upsert").map((change) => change.transactionId);
  const hydrated = await listSaleHomesByTransactionIds(db, upsertTxIds);
  const pages = await listMatterPageLabels(db);

  // Legacy fallback: rows backfilled by 0441 before the first refresh may lack `personCode`/`reportDate`/`daySource`.
  const legacyRows: SaleHomeHydratedRow[] = [...hydrated.values()].filter((row) => row.shares.some((share) => !isEnrichedShare(share)));
  const legacyUserIds = legacyRows.flatMap((row) => row.shares.filter((share) => !isEnrichedShare(share)).map((share) => share.userId));
  const legacyShiftIds = legacyRows.flatMap((row) => row.shares.filter((share) => !isEnrichedShare(share) && share.shiftId !== null).map((share) => share.shiftId!));
  const legacyPeople = await listHandinPeopleOfUsers(db, legacyUserIds);
  const legacyShifts = await listShiftReportDatesByIds(db, legacyShiftIds);

  const wireShare = (home: SaleHomeHydratedRow, share: SaleHomeShareRow): AgentSaleHomeShare => {
    if (isEnrichedShare(share)) {
      return {
        personCode: share.personCode ?? null,
        userId: share.userId,
        shiftId: share.shiftId,
        workRef: share.workRef,
        reportDate: share.reportDate ?? null,
        daySource: share.daySource,
        percent: share.percent,
        mills: share.mills,
      };
    }
    const personCode = share.personCode ?? legacyPeople.get(share.userId)?.code ?? null;
    if (share.shiftId !== null) {
      const shiftInfo = legacyShifts.get(share.shiftId);
      return {
        personCode,
        userId: share.userId,
        shiftId: share.shiftId,
        workRef: share.workRef,
        reportDate: shiftInfo?.reportDate ?? null,
        daySource: shiftInfo === undefined ? "unresolved" : shiftInfo.handedIn ? "report" : "shift",
        percent: share.percent,
        mills: share.mills,
      };
    }
    if (share.workRef !== null) {
      return {
        personCode,
        userId: share.userId,
        shiftId: null,
        workRef: share.workRef,
        reportDate: null,
        daySource: "unresolved",
        percent: share.percent,
        mills: share.mills,
      };
    }
    return {
      personCode,
      userId: share.userId,
      shiftId: null,
      workRef: null,
      reportDate: reportDateOfSale(home.occurredAt.getTime()),
      daySource: "sale_day",
      percent: share.percent,
      mills: share.mills,
    };
  };

  const homes: AgentSaleHomeFeedItem[] = served.map((change) => {
    const row = change.op === "upsert" ? hydrated.get(change.transactionId) : undefined;
    const pageLabel = row?.pageLabel ?? pages.labelOf.get(change.pageId) ?? null;
    if (change.op === "retract" || row === undefined) {
      return {
        seq: change.seq,
        at: change.at.toISOString(),
        op: "retract",
        transactionId: change.transactionId,
        pageLabel,
        occurredAt: null,
        netMills: null,
        saleKind: null,
        home: null,
        reason: null,
        pot: null,
        waitsUntil: null,
        ruleVersion: null,
        shares: [],
      };
    }
    return {
      seq: change.seq,
      at: change.at.toISOString(),
      op: "upsert",
      transactionId: row.transactionId,
      pageLabel,
      occurredAt: row.occurredAt.toISOString(),
      netMills: row.netMills,
      saleKind: row.canonicalType === null ? null : saleKindOf(row.canonicalType),
      home: row.home,
      reason: row.reason,
      pot: row.pot,
      waitsUntil: row.waitsUntil?.toISOString() ?? null,
      ruleVersion: row.ruleVersion,
      shares: row.shares.map((share) => wireShare(row, share)),
    };
  });

  return {
    homes,
    held: held.map((change) => ({ seq: change.seq, transactionId: change.transactionId, reason: "page_outside_key" as const })),
    next: String(placed.changes.at(-1)?.seq ?? afterSeq),
    more: placed.more,
    serverNow: now.toISOString(),
  };
}
