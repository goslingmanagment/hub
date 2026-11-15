import { averageShiftQuality, isChatTeamRole, shiftQualityOf, type AccountShiftNumbersResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { numbersFromTable, numbersOf, numbersWindowOf, shiftRowsOf, teamShiftJobs } from "./chatter-numbers.ts";
import { loginsOfPeople, loginsOfPersonOf } from "./person-logins.ts";
import { pagesOfModels, teamFactsFor, teamsOfPerson } from "./teams.ts";

/**
 * A chatter's own numbers (products plan 2026-11-13 §5, package N): the signed-in person's shifts — every login of
 * theirs (person-logins.ts), every page — with the review's quality numbers per shift and for the period, and beside
 * them the average of the person's team for the same period.
 *
 * - The numbers are chatter-numbers.ts's (`teamShiftJobs`, `shiftRowsOf`, `numbersOf`); a shift's quality and the
 *   period's «в среднем за смену» are the contracts' rules (`shiftQualityOf`, `averageShiftQuality`), the same as
 *   «Смены» and «Люди» show. Nothing is counted a second way.
 * - The team is teams.ts's: the people working the pages of the models of the person's working pages, the person
 *   too. Its average is of its closed shifts that have stored numbers (`shift_numbers`): one number per quality,
 *   never a list of people, never a rank, never pay. Read from the table only, so it costs a lookup, not a recount.
 * - The test team's wall: the person's team is of their realm (a test person's models are test models only).
 */
export async function readAccountShiftNumbers(
  app: AppContext,
  principal: AuthPrincipal,
  input: { from?: string | undefined; to?: string | undefined },
): Promise<AccountShiftNumbersResponse> {
  requireSessionUser(principal);
  const now = new Date();
  const { from, to } = numbersWindowOf(input, now);
  const me = await loginsOfPersonOf(app.db, principal.user.id);

  const own = await teamShiftJobs(app, { from, to, now, scope: "all", userIds: me.userIds });
  const rows = (await shiftRowsOf(app, own, { fromTable: await numbersFromTable(app) })).map((row) => row!);
  const shifts = own.jobs.map((job, index) => ({ job, row: rows[index]!, workedMinutes: job.shift.workedMinutes }));
  const perShift = shifts.map((one) => ({ ...one, numbers: numbersOf([one]) }));
  const quality = averageShiftQuality(perShift.map((one) => shiftQualityOf(one.numbers)));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    personId: me.personId,
    period: {
      shifts: shifts.length,
      workedMinutes: shifts.reduce((sum, one) => sum + one.workedMinutes, 0),
      quality,
      numbers: numbersOf(shifts),
    },
    team: me.personId === null ? null : await teamAverage(app, { personId: me.personId, test: principal.sandbox?.test === true, from, to, now }),
    shifts: perShift
      .sort((a, b) => b.job.shift.startedAt - a.job.shift.startedAt)
      .map((one) => ({
        userId: one.job.userId,
        startedAt: new Date(one.job.shift.startedAt).toISOString(),
        endedAt: new Date(one.job.shift.endedAt).toISOString(),
        ongoing: one.job.shift.ongoing,
        pages: [...one.job.shift.pages.keys()].sort(),
        workedMinutes: one.workedMinutes,
        quality: shiftQualityOf(one.numbers),
        numbers: one.numbers,
      })),
    serverNow: now.toISOString(),
  };
}

/**
 * The average of the person's team's closed shifts with stored numbers in the period; null — no team, or no such shift.
 * «Команда → Новички» reads it as a newcomer's team norm.
 */
export async function teamAverage(
  app: AppContext,
  input: { personId: number; test: boolean; from: Date; to: Date; now: Date; /** Only these teams (the reader's: «Новички»). */ models?: ReadonlySet<number> },
): Promise<AccountShiftNumbersResponse["team"]> {
  const facts = await teamFactsFor(app);
  const teams = teamsOfPerson(facts, input.personId);
  const realmModels = new Set(facts.models.filter((model) => model.test === input.test).map((model) => model.modelId));
  const pages = new Set(pagesOfModels(facts, teams.mine.filter((model) => realmModels.has(model) && (input.models === undefined || input.models.has(model)))));
  if (pages.size === 0) return null;
  // The chat team (chat-team.ts): a content manager working the pages is not on it; a shift of anyone counts below anyway.
  const chatTeam = new Set(facts.people.filter((person) => isChatTeamRole(person.role)).map((person) => person.personId));
  const people = [...new Set([input.personId, ...facts.working.filter((row) => pages.has(row.pageId) && chatTeam.has(row.personId)).map((row) => row.personId)])];
  const logins = await loginsOfPeople(app.db, people);
  if (logins.length === 0) return null;
  const found = await teamShiftJobs(app, { from: input.from, to: input.to, now: input.now, scope: "all", userIds: logins });
  const closed = { jobs: found.jobs.filter((job) => !job.shift.ongoing), openings: found.openings };
  const rows = await shiftRowsOf(app, closed, { fromTable: true, liveFallback: false });
  const counted = closed.jobs.flatMap((job, index) => {
    const row = rows[index];
    return row ? [{ job, quality: shiftQualityOf(numbersOf([{ row, workedMinutes: job.shift.workedMinutes }])) }] : [];
  });
  if (counted.length === 0) return null;
  const loginPerson = new Map(facts.logins.map((login) => [login.userId, login.personId]));
  return {
    ...averageShiftQuality(counted.map((one) => one.quality)),
    people: new Set(counted.map((one) => loginPerson.get(one.job.userId) ?? -one.job.userId)).size,
  };
}
