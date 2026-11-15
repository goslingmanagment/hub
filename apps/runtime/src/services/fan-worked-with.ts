import { FAN_WORKED_WITH_SHIFTS_SHOWN, type PageFanWorkedWithResponse } from "@agency_hub_core/contracts";
import { findPageSummaryByLabel, listFanAuthorshipShifts } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { requireTeamReader } from "./teams.ts";

/**
 * «Кто с ним работал» on a fan's card (products package M): who wrote to the fan on this page, by login, and the
 * shifts of theirs those messages fell in. Read from what Hub already keeps — the author of each outgoing message
 * (`client_send_attributions`) and the shifts (`shifts`) — and computes nothing about whose a sale is.
 * The caller hands a fans reader (fan-reads.ts): any role, on a page of their teams.
 */
export async function readPageFanWorkedWith(
  app: AppContext,
  principal: AuthPrincipal,
  input: { pageLabel: string; platformUserId: string },
): Promise<PageFanWorkedWithResponse> {
  requireTeamReader(principal);
  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page) throw new NotFoundError(`Page "${input.pageLabel}" was not found`);
  if (!canAccessPage(principal, page.id)) throw new ForbiddenError("Page access denied");
  // A fan's reference is the platform's number (the attributions' check): anything else names no fan.
  if (!/^[1-9]\d{0,29}$/u.test(input.platformUserId)) throw new NotFoundError(`No fan "${input.platformUserId}" on page "${page.label}"`);

  const rows = await listFanAuthorshipShifts(app.db, { pageId: page.id, fanRef: input.platformUserId });
  const authors = new Map<number, PageFanWorkedWithResponse["authors"][number]>();
  for (const row of rows) {
    const author = authors.get(row.userId) ?? {
      userId: row.userId, username: row.username, messages: 0, priced: 0,
      firstAt: row.firstAt.toISOString(), lastAt: row.lastAt.toISOString(), shifts: 0,
    };
    author.messages += row.messages;
    author.priced += row.priced;
    if (row.firstAt.toISOString() < author.firstAt) author.firstAt = row.firstAt.toISOString();
    if (row.lastAt.toISOString() > author.lastAt) author.lastAt = row.lastAt.toISOString();
    if (row.shiftId !== null) author.shifts += 1;
    authors.set(row.userId, author);
  }
  const shiftRows = rows.filter((row) => row.shiftId !== null);
  return {
    pageLabel: page.label,
    messages: rows.reduce((sum, row) => sum + row.messages, 0),
    authors: [...authors.values()].sort((a, b) => b.messages - a.messages || b.lastAt.localeCompare(a.lastAt)),
    // Newest first (the repository's order); the messages outside a shift are in the authors' totals.
    shifts: shiftRows.slice(0, FAN_WORKED_WITH_SHIFTS_SHOWN).map((row) => ({
      shiftId: row.shiftId,
      userId: row.userId,
      username: row.username,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt.toISOString(),
      messages: row.messages,
      priced: row.priced,
    })),
    shiftsTotal: shiftRows.length,
  };
}
