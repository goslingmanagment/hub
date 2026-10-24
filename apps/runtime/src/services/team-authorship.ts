import { MASS_SEND_MIN_CHATS, type TeamAuthorshipQuery, type TeamAuthorshipResponse } from "@agency_hub_core/contracts";
import { listPageAuthors, listPageAuthorshipDays } from "@agency_hub_core/db";
import { addUtcDays, startOfBusinessDay } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";

/**
 * Chat Memory week 1 (docs/plans/2026-10-24-chat-memory/plan.md §1, «Доля без
 * автора»): how many of each page's personal outgoing messages have an author
 * (`teamAuthorship`), per Moscow day — the number the roadmap's «at least 95 %
 * of outgoing messages from team browsers have an author» is read from.
 * What counts as personal and as «in a shift» is the repository's
 * (packages/db repositories/message-authorship.ts).
 *
 * Database only and read-only.
 */
export async function readTeamAuthorship(
  app: AppContext,
  principal: AuthPrincipal,
  input: { query: TeamAuthorshipQuery; pageScope: readonly number[] | undefined },
): Promise<TeamAuthorshipResponse> {
  // A cookie session of the owner or a team lead; a chatter and every device token are refused.
  requireDashboardUser(principal);
  const now = new Date();
  const from = addUtcDays(startOfBusinessDay(now), -(input.query.days - 1));
  const pages: "all" | readonly number[] = input.pageScope ?? "all";

  const days = await listPageAuthorshipDays(app.db, { from, to: now, pages, burstMinFans: MASS_SEND_MIN_CHATS });
  const authors = await listPageAuthors(app.db, { from, to: now, pages });
  // The pages that had either: personal messages, or messages with an author.
  const catalog = new Map<number, { id: number; label: string; platform: string }>();
  for (const row of [...days, ...authors]) catalog.set(row.pageId, { id: row.pageId, label: row.pageLabel, platform: row.platform });

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    pages: [...catalog.values()]
      .map((page) => {
        const own = days.filter((day) => day.pageId === page.id);
        const sum = (key: "personal" | "authored" | "inShift" | "inShiftAuthored") => own.reduce((total, day) => total + day[key], 0);
        return {
          pageLabel: page.label,
          platform: page.platform,
          total: { personal: sum("personal"), authored: sum("authored"), inShift: sum("inShift"), inShiftAuthored: sum("inShiftAuthored") },
          days: own.map(({ day, personal, authored, inShift, inShiftAuthored }) => ({ day, personal, authored, inShift, inShiftAuthored })),
          authors: authors
            .filter((author) => author.pageId === page.id)
            .map(({ userId, username, messages }) => ({ userId, username, messages })),
        };
      })
      .sort((a, b) => b.total.personal - a.total.personal),
    serverNow: now.toISOString(),
  };
}
