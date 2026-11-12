import { describe, expect, it } from "vitest";

import { LOGINS_ONLY, peopleIndex, type RegistryPerson } from "../packages/ui/src/people.ts";
import { loginsByPerson, type LoginRow } from "../apps/workboard/src/screens/shifts/byPerson.ts";

// Смены count money by login (Hub); the screen shows one row a person. The week's money must not move.

const DAYS = ["2026-11-09", "2026-11-10"];

function login(userId: number, username: string, days: number[], money: number[], before: number | null): LoginRow {
  const shifts = days.reduce((sum, value) => sum + value, 0);
  const salesNetMills = money.reduce((sum, value) => sum + value, 0);
  return {
    userId, username, shifts, workedMinutes: shifts * 120, salesNetMills, perHourMills: shifts === 0 ? null : Math.round(salesNetMills / (shifts * 2)),
    previous: before === null ? null : { shifts: 1, workedMinutes: 120, salesNetMills: before, perHourMills: Math.round(before / 2) },
    daily: DAYS.map((date, index) => ({ date, shifts: days[index]!, workedMinutes: days[index]! * 120, salesNetMills: money[index]! })),
  };
}

function person(id: number, displayName: string, role: string, logins: Array<[number, string]>): RegistryPerson {
  return { id, displayName, role, logins: logins.map(([userId, username]) => ({ userId, username })) } as unknown as RegistryPerson;
}

// Den works on two logins (an old and a new one), Kate on one, the owner on none this week.
const logins = [
  login(11, "den.s", [1, 0], [40_000, 0], 10_000),
  login(12, "den-2", [0, 1], [0, 25_000], null),
  login(13, "kate.v", [1, 1], [5_000, 7_000], 9_000),
  login(1, "owner", [0, 0], [0, 0], 3_000),
];
const people = peopleIndex([
  person(1, "Денис", "chatter", [[11, "den.s"], [12, "den-2"]]),
  person(2, "Катя", "chatter", [[13, "kate.v"]]),
  person(3, "Владелец", "owner", [[1, "owner"], [14, "owner-chat"]]),
]);

describe("Смены: one row a person", () => {
  const rows = loginsByPerson(logins, people);

  it("sums a person's logins into one row named by the registry", () => {
    const den = rows.find((row) => row.username === "Денис")!;
    expect(den).toMatchObject({ userId: 11, userIds: [11, 12], shifts: 2, workedMinutes: 240, salesNetMills: 65_000 });
    expect(den.previous).toMatchObject({ shifts: 1, salesNetMills: 10_000 });
    expect(den.daily.map((day) => day.salesNetMills)).toEqual([40_000, 25_000]);
  });

  it("keeps the week's money: by person it adds up to the logins', day by day", () => {
    expect(rows.reduce((sum, row) => sum + row.salesNetMills, 0)).toBe(logins.reduce((sum, row) => sum + row.salesNetMills, 0));
    expect(rows.reduce((sum, row) => sum + (row.previous?.salesNetMills ?? 0), 0)).toBe(logins.reduce((sum, row) => sum + (row.previous?.salesNetMills ?? 0), 0));
    for (const date of DAYS) {
      const of = (list: readonly LoginRow[]) => list.reduce((sum, row) => sum + (row.daily.find((day) => day.date === date)?.salesNetMills ?? 0), 0);
      expect(of(rows)).toBe(of(logins));
    }
  });

  it("a login alone keeps Hub's numbers as they are", () => {
    const kate = rows.find((row) => row.username === "Катя")!;
    expect(kate).toMatchObject({ ...logins[2], username: "Катя", userIds: [13] });
  });

  it("the owner's login is the owner's row, which the screen drops while it has no shift; a chatter's stays", () => {
    expect(rows.map((row) => row.username)).toEqual(["Денис", "Катя", "Владелец"]);
    expect(people.worksShifts(1)).toBe(false);
    expect(people.worksShifts(13)).toBe(true);
    expect(people.worksShifts(99)).toBe(true);
  });

  it("without the registry every login is itself, as before", () => {
    expect(loginsByPerson(logins, LOGINS_ONLY).map((row) => row.username)).toEqual(["den.s", "den-2", "kate.v", "owner"]);
  });
});
