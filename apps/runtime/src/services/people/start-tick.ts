import { MATTER_PERSON_START_KINDS, type MatterPersonStartKind, type PersonStart, type PersonStartStepId } from "@agency_hub_core/contracts";
import {
  closeMatter,
  listOpenMattersOfKinds,
  listPersonRows,
  matterChanges,
  openMatter,
  touchMatters,
  type MatterActor,
  type MatterOpenInput,
  type PersonRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "../sync-queue.ts";
import { isNewcomerRow, loadStartFacts, personStart } from "./start.ts";

/**
 * «Начало», the owner's side (package J), every ten minutes: the matters of
 * the newcomers' way, one writer for both kinds — a newcomer with no page
 * opened to their login (`person.no_pages:<code>`), and one who stands on the
 * same place 48 hours (`person.onboarding_stuck:<code>`; the invitation not
 * opened counts, a missing page does not: that is the first kind). Each closes
 * itself when its cause goes, the person working or gone included. Nothing is
 * sent anywhere; the matters wait on the person's card and in the owner's list.
 */

export const PEOPLE_START_QUEUE = "people.start";

const SYSTEM: MatterActor = { door: "system" };

/** The owner's words for the place a newcomer stands on. */
const PLACE_WORD: Readonly<Record<PersonStartStepId, string>> = {
  install: "Установить расширение",
  extension: "Войти в расширение",
  pages: "Страница",
  activity: "Первая работа на странице",
  payout: "Куда платить",
};

interface Finding {
  key: string;
  kind: MatterPersonStartKind;
  title: string;
  evidence: Record<string, unknown>;
  link: string;
  code: string;
}

/** What should be open now for the newcomers, by key. Pure. */
export function startFindings(people: ReadonlyArray<{ row: Pick<PersonRow, "code" | "displayName">; start: PersonStart | null }>): Finding[] {
  const want: Finding[] = [];
  for (const { row, start } of people) {
    if (!start?.newcomer) continue;
    const card = `/workboard/people/${encodeURIComponent(row.code)}`;
    if (!start.steps.some((step) => step.step === "pages" && step.done)) {
      want.push({
        key: `person.no_pages:${row.code}`, kind: "person.no_pages", code: row.code,
        title: `Назначьте страницу новичку: ${row.displayName}`,
        evidence: { code: row.code }, link: `${card}/access`,
      });
    }
    if (start.stuck && start.current !== null) {
      want.push({
        key: `person.onboarding_stuck:${row.code}`, kind: "person.onboarding_stuck", code: row.code,
        title: start.signedUp
          ? `${row.displayName}: больше двух суток на шаге «${PLACE_WORD[start.current]}»`
          : `${row.displayName}: больше двух суток не открывает приглашение`,
        evidence: { code: row.code, step: start.signedUp ? start.current : "invitation", since: start.since },
        link: card,
      });
    }
  }
  return want;
}

export interface PeopleStartTally {
  opened: number;
  closed: number;
}

/** One pass: the newcomers read, their matters made what they are now (opened, updated, closed with the cause gone). */
export async function runPeopleStartTick(app: Pick<AppContext, "db" | "logger">, now = new Date()): Promise<PeopleStartTally> {
  const rows = (await listPersonRows(app.db)).filter(isNewcomerRow);
  const facts = await loadStartFacts(app.db, rows);
  const want = startFindings(rows.flatMap((row) => {
    const mine = facts.get(row.id);
    return mine ? [{ row, start: personStart(row, mine, now) }] : [];
  }));
  const open = new Map((await listOpenMattersOfKinds(app.db, [...MATTER_PERSON_START_KINDS])).map((matter) => [matter.key, matter]));
  const seen = new Set<string>();
  const touched: string[] = [];
  const tally: PeopleStartTally = { opened: 0, closed: 0 };
  for (const finding of want) {
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    const input: MatterOpenInput = {
      key: finding.key, kind: finding.kind, source: "server", title: finding.title.slice(0, 300),
      object: { type: "person", id: finding.code }, pageIds: [], owner: { role: "owner" }, money: false,
      evidence: finding.evidence, link: finding.link,
    };
    const existing = open.get(finding.key);
    if (existing !== undefined && matterChanges(existing, input).length === 0) {
      touched.push(finding.key);
      continue;
    }
    try {
      const result = await openMatter(app.db, input, SYSTEM, now);
      if (result.transition === "opened" || result.transition === "reopened") tally.opened += 1;
    } catch (error) {
      app.logger.error({ err: error, key: finding.key }, "people start: a matter could not be opened");
    }
  }
  for (const [key, matter] of open) {
    if (seen.has(key)) continue;
    try {
      const result = await closeMatter(app.db, { key, how: "cause_gone", writer: matter.source }, SYSTEM, now);
      if (result.transition === "closed") tally.closed += 1;
    } catch (error) {
      app.logger.error({ err: error, key }, "people start: a matter could not be closed");
    }
  }
  await touchMatters(app.db, touched, now);
  return tally;
}

export async function ensurePeopleStartQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PEOPLE_START_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensurePeopleStartSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  // Every ten minutes: a matter waits on the owner within ten minutes of its cause, and closes as soon after it goes.
  await boss.schedule(PEOPLE_START_QUEUE, "*/10 * * * *", null, { tz: "UTC" });
}
