import type { TeamCoverageQuery, TeamEmptyHoursResponse } from "@agency_hub_core/contracts";
import { listEmptyHours } from "@agency_hub_core/db";
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
