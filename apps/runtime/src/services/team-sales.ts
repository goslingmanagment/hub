import {
  MASS_SEND_MIN_CHATS,
  PPV_PRICE_BUCKETS,
  REPLY_DELAY_BUCKETS,
  type TeamSalesPpvResponse,
  type TeamSalesQuery,
  type TeamSalesRepliesResponse,
} from "@agency_hub_core/contracts";
import { listPpvFacts, listReplyDelayCounts, type PpvFactRow, type ReplyDelayCountRow } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";

/**
 * Chat Memory week 6 «Продажи» (docs/plans/2026-10-24-chat-memory/week-6.md):
 * A — PPV conversion by page, chatter and price (`teamSalesPpv`); B — reply
 * time against purchases (`teamSalesReplies`). What counts as a personal PPV,
 * a reply, bought and the net is the repository's (packages/db
 * repositories/team-sales.ts). A guide, not a basis for pay.
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

const DAY_MS = 86_400_000;
const DELAY_BOUNDS = REPLY_DELAY_BUCKETS.flatMap((bucket) => (bucket.underSeconds === null ? [] : [bucket.underSeconds]));

type ReplyByDelay = TeamSalesRepliesResponse["pages"][number]["byDelay"];

/** Every delay bucket in its order, empty ones included; a row's `bucket` indexes REPLY_DELAY_BUCKETS. Pure. */
export function byDelayOf(rows: readonly Pick<ReplyDelayCountRow, "bucket" | "replies" | "bought">[]): ReplyByDelay {
  return REPLY_DELAY_BUCKETS.map((bucket, index) => {
    const own = rows.filter((row) => row.bucket === index);
    return {
      bucket: bucket.key,
      replies: own.reduce((sum, row) => sum + row.replies, 0),
      bought: own.reduce((sum, row) => sum + row.bought, 0),
    };
  });
}

function totalOf(byDelay: ReplyByDelay) {
  return byDelay.reduce((total, cell) => ({ replies: total.replies + cell.replies, bought: total.bought + cell.bought }), { replies: 0, bought: 0 });
}

export async function readTeamSalesReplies(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamSalesQuery; pageScope: readonly number[] | undefined },
): Promise<TeamSalesRepliesResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const from = addUtcDays(startOfBusinessDay(now), -(input.query.days - 1));
  // A reply's day for a purchase must be over: the newest replies are left for later.
  const to = new Date(now.getTime() - DAY_MS);
  const rows = to <= from ? [] : await listReplyDelayCounts(app.db, {
    from, to, pages: input.pageScope ?? "all", burstMinFans: MASS_SEND_MIN_CHATS, delayBounds: DELAY_BOUNDS,
  });

  const pages = new Map<number, ReplyDelayCountRow[]>();
  const chatters = new Map<number, ReplyDelayCountRow[]>();
  for (const row of rows) {
    pages.set(row.pageId, [...(pages.get(row.pageId) ?? []), row]);
    if (row.userId !== null) chatters.set(row.userId, [...(chatters.get(row.userId) ?? []), row]);
  }
  const tableOf = (own: readonly ReplyDelayCountRow[]) => {
    const byDelay = byDelayOf(own);
    return { total: totalOf(byDelay), byDelay };
  };

  return {
    from: from.toISOString(),
    to: (to <= from ? from : to).toISOString(),
    pages: [...pages.values()]
      .map((own) => ({ pageLabel: own[0]!.pageLabel, platform: own[0]!.platform, ...tableOf(own) }))
      .sort((a, b) => b.total.replies - a.total.replies || a.pageLabel.localeCompare(b.pageLabel)),
    chatters: [...chatters.entries()]
      .map(([userId, own]) => ({ userId, username: own[0]!.username ?? "", ...tableOf(own) }))
      .sort((a, b) => a.username.localeCompare(b.username)),
    serverNow: now.toISOString(),
  };
}
