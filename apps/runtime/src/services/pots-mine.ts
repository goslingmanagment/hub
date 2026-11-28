import type { AccountPot, AccountPotsQuery, AccountPotsResponse } from "@agency_hub_core/contracts";
import { ACCOUNT_POTS_MAX_DAYS } from "@agency_hub_core/contracts";
import {
  findPersonIdOfLogin,
  findPersonRowById,
  listMatterPageLabels,
  listOwnPotLines,
  readPotsSwitch,
  type PotRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { moscowDayOf } from "./chatter-shifts.ts";
import { checkWindow } from "./ledger-payouts.ts";
import { loadParticipantContext, type ParticipantLookupContext } from "./page-workers.ts";
import { listPendingPotSales } from "./pots.ts";
import { computePotDistributionLines, resolvePotParticipants } from "./pots-rules.ts";
import { realmOf } from "./sandbox/realm.ts";

/**
 * A person's own share of the Workboard pots (`accountPots`, «Сегодня»): what the pots gave them — their own lines of
 * the window's non-reversed distributions — and what is still to come — their line of the pots' base not distributed
 * yet, split as the pot would split it among that sale day's participants. The person is the session user's, through
 * the people registry, in the principal's realm; nothing in the request names them. Base mills only (the share counts
 * into the person's sales and the ledger pays it at their own rate): no pay, no rate, no term, and nothing of anyone
 * else — not a colleague's code, line or base; of another line only how many there were. Database only: no lock, no
 * ledger.
 */
export async function readAccountPots(
  app: Pick<AppContext, "db">,
  principal: AuthPrincipal,
  query: AccountPotsQuery,
  now: Date = new Date(),
): Promise<AccountPotsResponse> {
  requireSessionUser(principal);
  checkWindow(query.from, query.to, ACCOUNT_POTS_MAX_DAYS);
  const db = app.db;
  const { potsFrom } = await readPotsSwitch(db);
  const on = potsFrom !== null && potsFrom <= query.to;
  const answer: AccountPotsResponse = {
    on, potsFrom, from: query.from, to: query.to, totalMills: 0, pendingMills: 0, pots: [], serverNow: now.toISOString(),
  };
  if (!on) return answer;
  const personId = await findPersonIdOfLogin(db, principal.user.id);
  const person = personId === null ? null : await findPersonRowById(db, personId);
  if (person === null) return answer;

  const realm = realmOf(principal);
  const [lines, pending, pages] = await Promise.all([
    listOwnPotLines(db, { personCode: person.code, from: query.from, to: query.to, realm }),
    listPendingPotSales(db, realm),
    listMatterPageLabels(db),
  ]);

  // One registry and schedule snapshot per day (participants are of a day: the sale's, or today).
  const contexts = new Map<string, Promise<ParticipantLookupContext>>();
  const contextOf = (day: string) => {
    let context = contexts.get(day);
    if (context === undefined) {
      context = loadParticipantContext(db, realm, day);
      contexts.set(day, context);
    }
    return context;
  };
  const participantsOf = async (pot: PotRow, day: string) => resolvePotParticipants({
    ...await contextOf(day), day, mode: pot.participantsMode, pageIds: pot.pageIds, listed: pot.participants,
  });

  interface Mine { code: string; name: string; pageIds: readonly number[]; mine: number; count: number; lastSplit: number | null; pending: number; today: boolean }
  const byPot = new Map<number, Mine>();
  const mineOf = (potId: number, pot: { code: string; name: string; pageIds: readonly number[] }) => {
    let entry = byPot.get(potId);
    if (entry === undefined) {
      entry = { code: pot.code, name: pot.name, pageIds: pot.pageIds, mine: 0, count: 0, lastSplit: null, pending: 0, today: false };
      byPot.set(potId, entry);
    }
    return entry;
  };

  // Oldest first: the last line seen is the latest distribution's.
  for (const line of lines) {
    const entry = mineOf(line.potId, { code: line.potCode, name: line.potName, pageIds: line.potPageIds });
    entry.mine += line.baseMills;
    entry.count += 1;
    entry.lastSplit = line.splitCount;
  }

  // What is still to come: the person's line of each pending sale, by the pot's formula among the sale day's
  // participants (an auto-posted pot splits equally). A manual formula's shares are the owner's to write: no estimate.
  for (const sale of pending.pending) {
    if (sale.pot.formula.kind === "manual") continue;
    const participants = await participantsOf(sale.pot, sale.day);
    if (!participants.includes(person.code)) continue;
    const computed = computePotDistributionLines({ baseMills: sale.remainingMills, formula: sale.pot.formula, participants });
    const own = computed.ok ? computed.lines.find((one) => one.personCode === person.code) : undefined;
    if (own === undefined || own.baseMills <= 0) continue;
    mineOf(sale.pot.id, sale.pot).pending += own.baseMills;
  }

  // Among today's participants of an open pot.
  const today = moscowDayOf(now.getTime());
  if (pending.potsFrom !== null && today >= pending.potsFrom) {
    for (const pot of pending.pots) {
      if (pot.state !== "open" || pot.opensOn > today || (pot.closesOn !== null && today > pot.closesOn)) continue;
      if ((await participantsOf(pot, today)).includes(person.code)) mineOf(pot.id, pot).today = true;
    }
  }

  const pots: AccountPot[] = [...byPot.values()]
    .sort((left, right) => right.mine + right.pending - (left.mine + left.pending) || left.code.localeCompare(right.code))
    .map((entry) => ({
      code: entry.code,
      name: entry.name,
      pageLabels: entry.pageIds.map((id) => pages.labelOf.get(id) ?? `#${id}`),
      mineMills: entry.mine,
      distributions: entry.count,
      lastSplit: entry.lastSplit,
      pendingMills: entry.pending,
      participantToday: entry.today,
    }));
  return {
    ...answer,
    totalMills: pots.reduce((sum, pot) => sum + pot.mineMills, 0),
    pendingMills: pots.reduce((sum, pot) => sum + pot.pendingMills, 0),
    pots,
  };
}
