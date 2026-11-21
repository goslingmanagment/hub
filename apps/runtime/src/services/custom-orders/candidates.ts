import {
  CUSTOM_CANDIDATE_DAYS,
  CUSTOM_CANDIDATE_TIP_MIN_MILLS,
  type AgentCustomCandidatesResponse,
} from "@agency_hub_core/contracts";
import { listCustomCandidateTiers, listCustomCandidateTips } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { customTierOverridesNow } from "./switch.ts";

/**
 * Заказ кастома, the reader's candidates (customs facts spec §8): Hub never guesses a custom from the stream of tips, it
 * names the sales worth reading the chat around — tips of $40 and more of the last two weeks that pay no order and have
 * no finding, and fans holding a tier that includes a custom whose current period has no resolved finding — of the
 * key's pages only. Read only; the reader posts a finding or leaves the sale.
 */

const DAY_MS = 86_400_000;
const LIMIT = 500;

export async function agentCustomCandidates(
  app: Pick<AppContext, "db" | "config">,
  scope: { pageIds: readonly number[] },
  now: Date = new Date(),
): Promise<AgentCustomCandidatesResponse> {
  const overrides = await customTierOverridesNow(app);
  const [tips, tiers] = await Promise.all([
    listCustomCandidateTips(app.db, { pageIds: scope.pageIds, since: new Date(now.getTime() - CUSTOM_CANDIDATE_DAYS * DAY_MS), minMills: CUSTOM_CANDIDATE_TIP_MIN_MILLS, limit: LIMIT }),
    listCustomCandidateTiers(app.db, { pageIds: scope.pageIds, overrides, now, limit: LIMIT }),
  ]);
  return {
    tips: tips.map((tip) => ({
      saleRef: String(tip.transactionId), pageLabel: tip.pageLabel, fan: tip.fan, grossMills: tip.grossMills, at: tip.at.toISOString(), note: tip.note,
    })),
    tiers: tiers.map((tier) => ({
      pageLabel: tier.pageLabel, fan: tier.fan, tierRef: tier.tierRef, tierName: tier.tierName, endsAt: tier.endsAt?.toISOString() ?? null,
      saleRef: tier.transactionId === null ? null : String(tier.transactionId), grossMills: tier.grossMills, at: tier.at?.toISOString() ?? null,
    })),
    serverNow: now.toISOString(),
  };
}
