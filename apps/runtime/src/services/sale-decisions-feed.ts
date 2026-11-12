import type { AgentSaleDecisionsFeedResponse } from "@agency_hub_core/contracts";
import {
  holdSaleDecisionChanges,
  listHandinPeopleOfUsers,
  listMatterPageLabels,
  listSaleDecisionChangesAfter,
  listSaleDecisionChangesHeld,
  listSaleDecisions,
  placeSaleDecisionChanges,
  releaseSaleDecisionChangesHeld,
  type SaleDecisionChangeRow,
  type SaleDecisionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

/**
 * The decisions feed (review R2b-B): every change of a decision about whose a sale is, after a cursor, in the order the
 * feed placed it — what the ledger follows instead of keeping a second writer: a pot's sale (kind pot, the pot named by
 * the ledger's slug), a nobody's sale given to a person (owner, split), a report line's agreement (kind, shares, who
 * said it, the note). The changes are written by the decisions' own trigger (0409) whoever the writer is; a change gets
 * its place only once committed, after every place given before, so a cursor never passes one committed late. A change
 * of a decision on a page outside the key's pages is held back for the key and listed until it may read it; then it
 * gets a new place at the end of the feed and comes through the cursor, so an answer that is lost is asked again and
 * brings it again. The structured fields carry no fan's name — the sale is named by Hub's id and its page; `note` is
 * the team's free text, served as written (it may name the fan; a fan's erasure clears it).
 */

type FeedApp = Pick<AppContext, "db">;

function kindOf(decision: Pick<SaleDecisionRow, "kind" | "shares">): AgentSaleDecisionsFeedResponse["changes"][number]["decision"]["kind"] {
  if (decision.kind === "nobody") return "exclude";
  if (decision.kind === "split") return decision.shares.length === 1 && decision.shares[0]!.percent === 100 ? "owner" : "split";
  return decision.kind;
}

export async function readSaleDecisionsFeed(
  app: FeedApp,
  input: { pageIds: readonly number[]; since?: string | undefined; limit: number; agentKeyId?: number | undefined },
  now: Date = new Date(),
): Promise<AgentSaleDecisionsFeedResponse> {
  const { db } = app;
  const afterSeq = input.since === undefined ? 0 : Number(input.since);
  // What was held back for the key and it may read now gets its new place first: this read serves it by the cursor.
  if (input.agentKeyId !== undefined) await releaseSaleDecisionChangesHeld(db, { agentKeyId: input.agentKeyId, pageIds: input.pageIds });
  await placeSaleDecisionChanges(db);
  const fresh = await listSaleDecisionChangesAfter(db, { afterSeq, limit: input.limit });
  const readable = (change: SaleDecisionChangeRow) => change.pageId !== null && input.pageIds.includes(change.pageId);
  let held = fresh.changes.filter((change) => !readable(change));
  if (input.agentKeyId !== undefined) {
    await holdSaleDecisionChanges(db, { agentKeyId: input.agentKeyId, changeIds: held.map((change) => change.id) });
    held = (await listSaleDecisionChangesHeld(db, input.agentKeyId)).filter((change) => !readable(change));
  }
  const served = fresh.changes.filter(readable);
  const decisions = new Map((await listSaleDecisions(db, { ids: [...new Set([...served, ...held].map((change) => change.decisionId))] })).map((one) => [one.id, one]));
  const userIds = [...decisions.values()].flatMap((one) => [...one.shares.map((share) => share.userId), ...(one.appliedUserId === null ? [] : [one.appliedUserId])]);
  const codes = await listHandinPeopleOfUsers(db, userIds);
  const pages = await listMatterPageLabels(db);
  const labelOf = (decision: SaleDecisionRow) => (decision.pageId === null
    ? (typeof decision.ledgerRef?.pageLabel === "string" ? decision.ledgerRef.pageLabel : null)
    : pages.labelOf.get(decision.pageId) ?? null);
  return {
    changes: served.map((change) => {
      const decision = decisions.get(change.decisionId)!;
      return {
        seq: change.seq,
        change: change.change,
        at: change.at.toISOString(),
        decision: {
          id: decision.id,
          transactionId: decision.transactionId,
          pageLabel: labelOf(decision),
          kind: kindOf(decision),
          shares: decision.shares.map((share) => ({ person: codes.get(share.userId)?.code ?? null, userId: share.userId, percent: share.percent })),
          pot: decision.kind === "pot" ? decision.pot : null,
          outcome: decision.outcome,
          ruleHome: decision.ruleHome,
          state: decision.state,
          source: decision.source,
          saidBy: decision.saidBy,
          saidAt: decision.saidAt?.toISOString() ?? null,
          decidedAt: decision.decidedAt.toISOString(),
          note: decision.note,
          applied: decision.appliedAt === null || decision.appliedReportDate === null ? null
            : { person: decision.appliedUserId === null ? null : codes.get(decision.appliedUserId)?.code ?? null, reportDate: decision.appliedReportDate },
          ledgerDecisionId: decision.ledgerDecisionId,
        },
      };
    }),
    held: held.map((change) => {
      const decision = decisions.get(change.decisionId);
      return { seq: change.seq, decisionId: change.decisionId, pageLabel: decision === undefined ? null : labelOf(decision), reason: "page_outside_key" as const };
    }),
    next: String(fresh.changes.at(-1)?.seq ?? afterSeq),
    // `limit` counts places, held ones too: a page may carry fewer changes than asked while places follow.
    more: fresh.more,
    serverNow: now.toISOString(),
  };
}
