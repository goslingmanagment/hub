import {
  closeMatter,
  findHandinByShift,
  listMatterPageLabels,
  listMissingHandins,
  listOpenMattersOfKinds,
  openMatter,
  type MatterActor,
  type MissingHandinCandidate,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { missingTitle } from "./shift-handin-rules.ts";
import { SHIFT_REPORTS_MISSING_KIND, SHIFT_REPORT_MISSING_KIND } from "./shift-handins.ts";

/**
 * «Смена не сдана» (ecosystem plan §6, package F): a shift closed two hours ago
 * whose report is not handed in opens `shift.report.missing:<shift id>` for the
 * person — only a person with the switch «сдаёт смену в системе» on since
 * before the shift began and with pay terms, never the owner or a service
 * login; the hand-in closes it (resolved), and so does the cause going away
 * (the shift dropped, the switch off: cause_gone). The owner gets no matter per
 * shift: after 24 hours ONE `shift.reports.missing:owner` carries the count and
 * the list, and closes when the list is empty. The server is the one writer of
 * these kinds. Database only; runs after each shift-rows pass.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A shift is missing its report two hours after it closed. */
export const MISSING_AFTER_MS = 2 * HOUR_MS;
/** The owner hears of it a day after it closed. */
export const OWNER_AFTER_MS = 24 * HOUR_MS;
/** How far back the check looks: older shifts keep whatever matter they have. */
const LOOKBACK_MS = 14 * DAY_MS;
/** The most shifts the owner's matter lists (its evidence stays under 8 KB). */
const OWNER_LIST_MAX = 40;

const SYSTEM: MatterActor = { door: "system" };
const OWNER_KEY = `${SHIFT_REPORTS_MISSING_KIND}:owner`;

export interface ShiftReportMattersTally {
  missing: number;
  opened: number;
  closed: number;
  ownerCount: number;
}

/** The owner's one matter, from the shifts missing their report for a day. Pure. */
export function ownerMissingOf(candidates: readonly MissingHandinCandidate[], now: Date): { count: number; title: string; evidence: Record<string, unknown> } | null {
  const late = candidates.filter((one) => now.getTime() - one.endedAt.getTime() >= OWNER_AFTER_MS);
  if (late.length === 0) return null;
  return {
    count: late.length,
    title: `Несданные смены: ${late.length}`,
    evidence: {
      count: late.length,
      shifts: late.slice(0, OWNER_LIST_MAX).map((one) => ({ shiftId: one.shiftId, person: one.personName, reportDate: one.reportDate })),
    },
  };
}

export async function runShiftReportMatters(app: Pick<AppContext, "db" | "logger">, now: Date = new Date()): Promise<ShiftReportMattersTally> {
  const { db } = app;
  const windowFrom = new Date(now.getTime() - LOOKBACK_MS);
  const candidates = await listMissingHandins(db, { endedAfter: windowFrom, endedBefore: new Date(now.getTime() - MISSING_AFTER_MS) });
  const pages = await listMatterPageLabels(db);
  const tally: ShiftReportMattersTally = { missing: candidates.length, opened: 0, closed: 0, ownerCount: 0 };

  const missing = new Set(candidates.map((one) => one.shiftId));
  for (const one of candidates) {
    const opened = await openMatter(db, {
      key: `${SHIFT_REPORT_MISSING_KIND}:${one.shiftId}`,
      kind: SHIFT_REPORT_MISSING_KIND,
      source: "server",
      title: missingTitle(one.startedAt, one.endedAt),
      object: { type: "shift", id: String(one.shiftId) },
      pageIds: one.pageLabels.map((label) => pages.idOf.get(label)).filter((id): id is number => id !== undefined),
      owner: { userId: one.userId },
      money: false,
      evidence: { shiftId: one.shiftId, reportDate: one.reportDate, endedAt: one.endedAt.toISOString() },
      link: `/workboard/my/shifts/${one.shiftId}`,
    }, SYSTEM, now);
    if (opened.transition === "opened" || opened.transition === "reopened") tally.opened += 1;
  }

  // The ones whose cause went away: handed in (resolved), or no longer the check's (cause_gone). Older ones stay.
  for (const matter of await listOpenMattersOfKinds(db, [SHIFT_REPORT_MISSING_KIND])) {
    const shiftId = Number(matter.object?.id ?? matter.key.slice(SHIFT_REPORT_MISSING_KIND.length + 1));
    if (!Number.isSafeInteger(shiftId) || missing.has(shiftId)) continue;
    const handin = await findHandinByShift(db, shiftId);
    const endedAt = typeof matter.evidence.endedAt === "string" ? Date.parse(matter.evidence.endedAt) : Number.NaN;
    const submitted = handin?.state === "submitted";
    if (!submitted && Number.isFinite(endedAt) && endedAt < windowFrom.getTime()) continue;
    const closed = await closeMatter(db, { key: matter.key, how: submitted ? "resolved" : "cause_gone", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") tally.closed += 1;
  }

  const owner = ownerMissingOf(candidates, now);
  if (owner === null) {
    const closed = await closeMatter(db, { key: OWNER_KEY, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") tally.closed += 1;
  } else {
    tally.ownerCount = owner.count;
    await openMatter(db, {
      key: OWNER_KEY,
      kind: SHIFT_REPORTS_MISSING_KIND,
      source: "server",
      title: owner.title,
      object: null,
      pageIds: [],
      owner: { role: "owner" },
      money: false,
      evidence: owner.evidence,
      link: "/workboard/shifts",
    }, SYSTEM, now);
  }
  if (tally.opened + tally.closed > 0) app.logger.info(tally, "shift report matters");
  return tally;
}
