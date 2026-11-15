import type { AppContext } from "../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import { closePassedCoverMatters } from "./team-questions.ts";

/**
 * Вопросы тому, кто решает (products package W): every ten minutes, the covering persons' «Вы выходите вместо …» of
 * swaps whose day has passed are closed — the question service is the one writer of those matters. Nothing is sent.
 */

export const TEAM_QUESTIONS_QUEUE = "team.questions";

export function runTeamQuestionsTick(app: Pick<AppContext, "db">, now = new Date()): Promise<{ closed: number }> {
  return closePassedCoverMatters(app, now);
}

export async function ensureTeamQuestionsQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, TEAM_QUESTIONS_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureTeamQuestionsSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(TEAM_QUESTIONS_QUEUE, "*/10 * * * *", null, { tz: "UTC" });
}
