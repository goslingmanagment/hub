import { listNotedShiftStarts, listPersonRows } from "@agency_hub_core/db";
import { shiftQualityOf, type TeamNewcomersResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../bootstrap.ts";
import { teamAverage } from "./account-shift-numbers.ts";
import { requireSessionUser, type HumanAuthPrincipal } from "./auth.ts";
import { numbersOf, shiftRowsOf, teamShiftJobs } from "./chatter-numbers.ts";
import { ForbiddenError } from "./errors.ts";
import { isNewcomerRow, loadStartFacts, personStart } from "./people/start.ts";
import { personOfLogin, teamFactsFor, teamsOfPerson } from "./teams.ts";

/**
 * «Команда → Новички» (products plan §2.3, §3; package W): each newcomer's first week in the teams the viewer leads — the
 * steps of «Начало» as Hub sees them (people/start.ts), the first shifts with the review's quality (chatter-numbers.ts,
 * the stored numbers) and whether a lead wrote a note, beside the team's norm (account-shift-numbers.ts `teamAverage`).
 * Nothing is counted a second way. Who reads: the owner (every team of his realm) and a person who leads a team by its
 * records (that team); never a narrow session. No money of people; never where a person is paid.
 */

const DAY_MS = 86_400_000;
/** A working chatter is a newcomer this long after their first minute in the extension. */
const FIRST_WEEK_MS = 7 * DAY_MS;
const FIRST_SHIFTS = 5;
const NORM_DAYS = 14;

export async function readTeamNewcomers(app: AppContext, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<TeamNewcomersResponse> {
  requireSessionUser(principal);
  if (principal.narrowDeviceTokenId !== undefined) throw new ForbiddenError("«Новички» need the password");
  const owner = principal.user.role === "owner";
  const test = principal.sandbox?.test === true;
  const facts = await teamFactsFor(app, principal);
  const realm = new Set(facts.models.filter((model) => model.test === test).map((model) => model.modelId));
  const led = owner ? realm : new Set(teamsOfPerson(facts, personOfLogin(facts, principal.user.id)).lead.filter((model) => realm.has(model)));
  if (!owner && led.size === 0) throw new ForbiddenError("«Новички» are the team lead's: lead a team to read them");

  const modelOfPage = new Map(facts.pages.map((page) => [page.pageId, page.modelId]));
  const modelsOf = (personId: number) => new Set(facts.working.filter((row) => row.personId === personId).flatMap((row) => {
    const model = modelOfPage.get(row.pageId);
    return model === undefined ? [] : [model];
  }));
  const people = (await listPersonRows(app.db)).filter((row) => row.kind === "human" && row.role === "chatter" && row.isTest === test
    && (isNewcomerRow(row) || row.state === "working")
    // A lead's: of a team they lead; the owner's: every one, with no team yet too.
    && (owner || [...modelsOf(row.id)].some((model) => led.has(model))));
  const startFacts = await loadStartFacts(app.db, people);
  const firstOf = (personId: number) => startFacts.get(personId)?.firstActive?.minute ?? null;
  const newcomers = people.filter((row) => {
    if (isNewcomerRow(row)) return true;
    const first = firstOf(row.id);
    return first !== null && now.getTime() - first.getTime() < FIRST_WEEK_MS;
  });

  const answer: TeamNewcomersResponse["newcomers"] = [];
  for (const row of newcomers) {
    const mine = startFacts.get(row.id);
    const userIds = (mine?.logins ?? []).map((login) => login.userId);
    const first = firstOf(row.id);
    let shifts: TeamNewcomersResponse["newcomers"][number]["shifts"] = [];
    if (first !== null && userIds.length > 0) {
      const from = first;
      const to = new Date(Math.min(now.getTime(), first.getTime() + FIRST_WEEK_MS + DAY_MS));
      const found = await teamShiftJobs(app, { from, to, now, scope: "all", userIds });
      const jobs = [...found.jobs].sort((a, b) => a.shift.startedAt - b.shift.startedAt).slice(0, FIRST_SHIFTS);
      const rows = await shiftRowsOf(app, { jobs, openings: found.openings }, { fromTable: true, liveFallback: false });
      const noted = new Set((await listNotedShiftStarts(app.db, userIds)).map((one) => `${one.userId}:${one.startedAt.getTime()}`));
      shifts = jobs.map((job, index) => {
        const stored = rows[index];
        return {
          userId: job.userId,
          startedAt: new Date(job.shift.startedAt).toISOString(),
          endedAt: new Date(job.shift.endedAt).toISOString(),
          ongoing: job.shift.ongoing,
          pages: [...job.shift.pages.keys()].sort(),
          workedMinutes: job.shift.workedMinutes,
          quality: stored ? shiftQualityOf(numbersOf([{ row: stored, workedMinutes: job.shift.workedMinutes }])) : null,
          noted: noted.has(`${job.userId}:${job.shift.startedAt}`),
        };
      });
    }
    const teams = [...modelsOf(row.id)].filter((model) => realm.has(model))
      .map((model) => facts.models.find((one) => one.modelId === model)?.name ?? "").filter((name) => name !== "").sort((a, b) => a.localeCompare(b, "ru"));
    answer.push({
      code: row.code,
      name: row.displayName,
      state: row.state === "invited" || row.state === "set_up" ? row.state : "working",
      teams,
      start: mine ? personStart(row, mine, now) : null,
      firstActiveAt: first?.toISOString() ?? null,
      shifts,
      team: teams.length === 0 ? null : await teamAverage(app, { personId: row.id, test, from: new Date(now.getTime() - NORM_DAYS * DAY_MS), to: now, now }),
    });
  }
  answer.sort((a, b) => (b.firstActiveAt ?? "9").localeCompare(a.firstActiveAt ?? "9") || a.name.localeCompare(b.name, "ru"));
  return { newcomers: answer, serverNow: now.toISOString() };
}
