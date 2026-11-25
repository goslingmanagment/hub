import {
  listPersonDayLineRows,
  listPersonLoginRows,
  listPersonScheduleSlotRows,
  listWorkingPagesOnDay,
  listWorkingPeopleOnDay,
  type Database,
  type PeopleRealm,
} from "@agency_hub_core/db";

import { moscowDayOf } from "./chatter-shifts.ts";
import { suggestSoloPagePerson, type SoloPageCandidate, type SoloPageSuggestion } from "./sale-claim-rules.ts";
import type { RuleSlot } from "./sale-rule.ts";
import { RULE_WEEKDAYS, type RuleWeekday } from "./schedule-slots.ts";

const DAY_MS = 86_400_000;
const WEEKDAY_SET: ReadonlySet<string> = new Set(RULE_WEEKDAYS);

export interface ParticipantLookupContext {
  people: SoloPageCandidate[];
  workingPages: Array<{ personId: number; pageId: number }>;
  slots: RuleSlot[];
}

export async function loadParticipantContext(
  db: Database,
  realm: "live" | "test",
  day: string,
): Promise<ParticipantLookupContext> {
  const peopleRows = await listWorkingPeopleOnDay(db, realm, day);
  const personIds = peopleRows.map((person) => person.id);
  if (personIds.length === 0) return { people: [], workingPages: [], slots: [] };
  const workingPages = await listWorkingPagesOnDay(db, personIds, day);
  const standing = await listPersonScheduleSlotRows(db, personIds);
  const dayMs = Date.parse(`${day}T00:00:00+03:00`);
  const personIdSet = new Set(personIds);
  const dayLines = Number.isNaN(dayMs)
    ? []
    : (await listPersonDayLineRows(db, { from: moscowDayOf(dayMs - DAY_MS), to: moscowDayOf(dayMs + DAY_MS) }))
      .filter((row) => personIdSet.has(row.personId));
  const slots: RuleSlot[] = [...standing, ...dayLines].map((slot) => ({
    personId: slot.personId,
    pageId: slot.pageId,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
    weekdays: slot.weekdays === null ? null : slot.weekdays.filter((d): d is RuleWeekday => WEEKDAY_SET.has(d)),
    validFrom: slot.validFrom,
    validTo: slot.validTo,
    ...(slot.kind === null ? {} : { day: slot.kind }),
  }));
  const people: SoloPageCandidate[] = peopleRows.map((person) => ({
    personId: person.id,
    code: person.code,
    displayName: person.displayName,
    kind: person.kind,
    role: person.role,
    state: person.state,
    leftOn: person.leftOn,
  }));
  return { people, workingPages, slots };
}

/** One registry and schedule snapshot per sale day. A suggestion never grants a share. */
export async function soloPageSuggestions(
  db: Database,
  realm: PeopleRealm,
  sales: ReadonlyArray<{ transactionId: number; pageId: number; day: string; home: string; reason: string }>,
): Promise<Map<number, SoloPageSuggestion | null>> {
  const targets = sales.filter((sale) => sale.home === "nobody" && sale.reason === "no_holder");
  const suggestions = new Map<number, SoloPageSuggestion | null>();
  const days = new Map<string, typeof targets>();
  for (const sale of targets) {
    const entries = days.get(sale.day);
    if (entries) entries.push(sale);
    else days.set(sale.day, [sale]);
  }
  for (const [day, entries] of days) {
    const ctx = await loadParticipantContext(db, realm, day);
    const logins = await listPersonLoginRows(db, ctx.people.map((p) => p.personId));
    const byPage = new Map<number, SoloPageSuggestion | null>();
    for (const sale of entries) {
      if (!byPage.has(sale.pageId)) {
        byPage.set(sale.pageId, suggestSoloPagePerson({ ...ctx, logins, pageId: sale.pageId, saleDay: day }));
      }
      suggestions.set(sale.transactionId, byPage.get(sale.pageId)!);
    }
  }
  return suggestions;
}

/**
 * Which of `pageIds` have `personId` as their sole active chat-team worker on Moscow `day`
 * (same registry + schedule snapshot as `soloPageSuggestions`).
 */
export async function soloPagesForPerson(
  db: Database,
  realm: PeopleRealm,
  personId: number,
  day: string,
  pageIds: readonly number[],
): Promise<Set<number>> {
  const unique = [...new Set(pageIds)];
  if (unique.length === 0) return new Set();
  const ctx = await loadParticipantContext(db, realm, day);
  const logins = await listPersonLoginRows(db, ctx.people.map((p) => p.personId));
  const solo = new Set<number>();
  for (const pageId of unique) {
    const suggestion = suggestSoloPagePerson({ ...ctx, logins, pageId, saleDay: day });
    if (suggestion?.personId === personId) solo.add(pageId);
  }
  return solo;
}
