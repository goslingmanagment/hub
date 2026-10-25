import {
  MASS_SEND_MIN_CHATS,
  TEAM_BROADCASTS_MAX,
  type TeamCoverageQuery,
  type TeamEmptyHoursResponse,
  type TeamGreetingsResponse,
} from "@agency_hub_core/contracts";
import { listBroadcasts, listEmptyHours, listGreetings } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";

/**
 * Chat Memory week 6, «Покрытие» (docs/plans/2026-10-24-chat-memory/week-6.md
 * §В–Г): the owner's and team leads' analytics of who the team leaves waiting.
 * The rules live in the repository (packages/db repositories/team-coverage.ts).
 * A guide, not a basis for pay. Database only and read-only.
 */

function windowOf(days: number, now: Date) {
  return { from: addUtcDays(startOfBusinessDay(now), -(days - 1)), to: now };
}

export async function readTeamEmptyHours(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamCoverageQuery; pageScope: readonly number[] | undefined },
): Promise<TeamEmptyHoursResponse> {
  // A cookie session of the owner or a team lead; a chatter and every device token are refused.
  requireDashboardUser(principal);
  const now = new Date();
  const { from, to } = windowOf(input.query.days, now);
  const rows = await listEmptyHours(app.db, { from, to, pages: input.pageScope ?? "all" });
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    pages: rows.map((row) => ({
      pageLabel: row.pageLabel,
      platform: row.platform,
      shiftsSince: row.shiftsSince?.toISOString() ?? null,
      hoursWithFans: row.hoursWithFans,
      emptyHours: row.emptyHours,
      emptyByHour: row.emptyByHour,
      fans: row.fans,
      payers: row.payers,
      waitedOverHour: row.waitedOverHour,
      waitedNetMills: row.waitedNetMills,
    })),
    serverNow: now.toISOString(),
  };
}

export async function readTeamGreetings(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamCoverageQuery; pageScope: readonly number[] | undefined },
): Promise<TeamGreetingsResponse> {
  requireDashboardUser(principal);
  const now = new Date();
  const { from, to } = windowOf(input.query.days, now);
  const pages = input.pageScope ?? "all";
  const greetings = await listGreetings(app.db, { from, to, pages, burstMinFans: MASS_SEND_MIN_CHATS });
  const broadcasts = await listBroadcasts(app.db, { from, to, pages, burstMinFans: MASS_SEND_MIN_CHATS });

  const catalog = new Map<string, { platform: string }>();
  for (const row of [...greetings, ...broadcasts]) catalog.set(row.pageLabel, { platform: row.platform });
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    pages: [...catalog.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pageLabel, { platform }]) => {
        const greeting = greetings.find((row) => row.pageLabel === pageLabel);
        const own = broadcasts.filter((row) => row.pageLabel === pageLabel);
        const sum = (key: "deliveries" | "replied" | "bought") => own.reduce((total, row) => total + row[key], 0);
        return {
          pageLabel,
          platform,
          newSubscribers: greeting?.newSubscribers ?? 0,
          autoWelcomed: greeting?.autoWelcomed ?? 0,
          greeted: greeting?.greeted ?? 0,
          greetingMedianSeconds: greeting?.greetingMedianSeconds ?? null,
          repliedWithinHour: greeting?.repliedWithinHour ?? 0,
          boughtGreeted: greeting?.boughtGreeted ?? 0,
          boughtNotGreeted: greeting?.boughtNotGreeted ?? 0,
          recent: greeting?.recent ?? 0,
          broadcasts: { sent: own.length, deliveries: sum("deliveries"), replied: sum("replied"), bought: sum("bought") },
        };
      }),
    broadcasts: broadcasts.slice(0, TEAM_BROADCASTS_MAX).map((row) => ({
      pageLabel: row.pageLabel,
      sentAt: row.sentAt.toISOString(),
      preview: row.preview,
      priceMills: row.priceMills,
      files: row.files,
      massMessage: row.massMessage,
      deliveries: row.deliveries,
      replied: row.replied,
      bought: row.bought,
      ppvBought: row.ppvBought,
    })),
    serverNow: now.toISOString(),
  };
}
