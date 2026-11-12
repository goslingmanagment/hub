/**
 * Смены by person, not by login (packages/ui/src/people.ts): Hub counts a
 * login's shifts, money and days; a person with several logins (an old and a
 * new one, the owner's own and their chatter's) is one row. Their numbers are
 * the logins' sums, money an hour of the sums; the team's row stays Hub's own.
 * Pure: no reads (tests/workboard-shifts-people.test.ts).
 */
import type { PeopleIndex } from "@agency_hub_core/ui/people";
import { perHourMills } from "../../shared/metrics.js";

interface Totals {
  shifts: number;
  workedMinutes: number;
  salesNetMills: number;
  perHourMills: number | null;
}

interface Day {
  date: string;
  salesNetMills: number;
  shifts: number;
  workedMinutes: number;
}

/** A login's row as Hub answers it (`teamShiftSales` chatters). */
export interface LoginRow extends Totals {
  userId: number;
  username: string;
  previous: Totals | null;
  daily: readonly Day[];
}

/** A person's row: the login it opens (the one that worked the most), the person's name, every login of theirs. */
export interface PersonRow extends LoginRow {
  userIds: number[];
}

function sumTotals(parts: readonly Totals[]): Totals {
  const shifts = parts.reduce((sum, part) => sum + part.shifts, 0);
  const workedMinutes = parts.reduce((sum, part) => sum + part.workedMinutes, 0);
  const salesNetMills = parts.reduce((sum, part) => sum + part.salesNetMills, 0);
  return { shifts, workedMinutes, salesNetMills, perHourMills: perHourMills(salesNetMills, workedMinutes) };
}

function sumDaily(parts: ReadonlyArray<readonly Day[]>): Day[] {
  const days = new Map<string, Day>();
  for (const daily of parts) {
    for (const day of daily) {
      const seen = days.get(day.date) ?? { date: day.date, salesNetMills: 0, shifts: 0, workedMinutes: 0 };
      days.set(day.date, { date: day.date, salesNetMills: seen.salesNetMills + day.salesNetMills, shifts: seen.shifts + day.shifts, workedMinutes: seen.workedMinutes + day.workedMinutes });
    }
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/** One row a person, in Hub's order of their first login; a login alone keeps Hub's numbers as they are. */
export function loginsByPerson(logins: readonly LoginRow[], people: PeopleIndex): PersonRow[] {
  const groups = new Map<string, LoginRow[]>();
  for (const login of logins) {
    const key = people.keyOf(login.userId);
    groups.set(key, [...(groups.get(key) ?? []), login]);
  }
  return [...groups.values()].map((group): PersonRow => {
    const lead = [...group].sort((left, right) => right.shifts - left.shifts || right.salesNetMills - left.salesNetMills)[0]!;
    const name = people.nameOf(lead.userId, lead.username);
    const userIds = group.map((login) => login.userId);
    if (group.length === 1) return { ...lead, username: name, userIds };
    const before = group.flatMap((login) => (login.previous === null ? [] : [login.previous]));
    return {
      ...sumTotals(group),
      userId: lead.userId,
      username: name,
      previous: before.length === 0 ? null : sumTotals(before),
      daily: sumDaily(group.map((login) => login.daily)),
      userIds,
    };
  });
}
