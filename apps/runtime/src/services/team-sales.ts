import {
  MASS_SEND_MIN_CHATS,
  PPV_PRICE_BUCKETS,
  type TeamSalesPpvResponse,
  type TeamSalesQuery,
} from "@agency_hub_core/contracts";
import { listPpvFacts, type PpvFactRow } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";

/**
 * Chat Memory week 6 «Продажи» (docs/plans/2026-10-24-chat-memory/week-6.md):
 * A — PPV conversion by page, chatter and price (`teamSalesPpv`). What counts
 * as a personal PPV, bought and its net is the repository's
 * (packages/db repositories/team-sales.ts). A guide, not a basis for pay.
 * Database only and read-only.
 */

type PpvCounts = TeamSalesPpvResponse["pages"][number]["total"];
type PpvByPrice = TeamSalesPpvResponse["pages"][number]["byPrice"];

/** The PPV_PRICE_BUCKETS key of a price: up to and including each bound. Pure. */
export function priceBucketOf(priceMills: number): string {
  return PPV_PRICE_BUCKETS.find((bucket) => bucket.upToMills === null || priceMills <= bucket.upToMills)!.key;
}

function countsOf(rows: readonly PpvFactRow[]): PpvCounts {
  const bought = rows.filter((row) => row.bought);
  return { sent: rows.length, bought: bought.length, netMills: bought.reduce((sum, row) => sum + row.netMills, 0) };
}

/** Every bucket in its order, empty ones included. Pure. */
export function byPriceOf(rows: readonly PpvFactRow[]): PpvByPrice {
  return PPV_PRICE_BUCKETS.map((bucket) => ({
    bucket: bucket.key,
    ...countsOf(rows.filter((row) => priceBucketOf(row.priceMills) === bucket.key)),
  }));
}

export async function readTeamSalesPpv(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamSalesQuery; pageScope: readonly number[] | undefined },
): Promise<TeamSalesPpvResponse> {
  // A cookie session of the owner or a team lead; a chatter and every device token are refused.
  requireDashboardUser(principal);
  const now = new Date();
  const from = addUtcDays(startOfBusinessDay(now), -(input.query.days - 1));
  const rows = await listPpvFacts(app.db, { from, to: now, pages: input.pageScope ?? "all", burstMinFans: MASS_SEND_MIN_CHATS });

  const pages = new Map<number, PpvFactRow[]>();
  const chatters = new Map<number, PpvFactRow[]>();
  for (const row of rows) {
    pages.set(row.pageId, [...(pages.get(row.pageId) ?? []), row]);
    if (row.userId !== null) chatters.set(row.userId, [...(chatters.get(row.userId) ?? []), row]);
  }

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    pages: [...pages.values()]
      .map((own) => ({
        pageLabel: own[0]!.pageLabel,
        platform: own[0]!.platform,
        total: countsOf(own),
        byPrice: byPriceOf(own),
        firstPpv: byPriceOf(own.filter((row) => row.firstPpv)),
        withoutAuthor: own.filter((row) => row.userId === null).length,
      }))
      .sort((a, b) => b.total.netMills - a.total.netMills || a.pageLabel.localeCompare(b.pageLabel)),
    chatters: [...chatters.entries()]
      .map(([userId, own]) => ({ userId, username: own[0]!.username ?? "", total: countsOf(own), byPrice: byPriceOf(own) }))
      .sort((a, b) => a.username.localeCompare(b.username)),
    serverNow: now.toISOString(),
  };
}
