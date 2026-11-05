import {
  claimAbandonedModelApplicationSessions,
  recordModelApplicationProgress,
  type ModelApplicationAnswer,
  type ModelApplicationSessionDetail,
  type ModelApplicationSessionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { TooManyRequestsError } from "./errors.ts";
import {
  clip,
  formatAnswersBySection,
  formatMoscowMinute,
  MODEL_APPLICATIONS_SCREEN_URL,
  modelApplicationAddressHash,
  notifyOwnerOfModelApplication,
} from "./model-applications.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Fillings of the agency site's model questionnaire, as its page reports them
// while the model types (public POST /api/v1/model-applications/progress):
// the owner hears in Telegram when one starts and when one is left unsent.

export const MODEL_APPLICATION_ABANDON_SWEEP_QUEUE = "model-applications.abandon.sweep";
const NEW_FILLINGS_PER_ADDRESS_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60_000;
/** Silent this long and not sent: left. */
export const MODEL_APPLICATION_ABANDON_AFTER_MS = 30 * 60_000;
const ABANDON_SWEEP_LIMIT = 20;

export interface ModelApplicationProgress {
  session: string;
  form: string;
  filled: number;
  total: number;
  section?: string | undefined;
  name?: string | undefined;
  answers?: ModelApplicationAnswer[] | undefined;
  website?: string | undefined;
}

function present(text: string | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export function formatModelApplicationStartNotice(name: string | null, session: string): string {
  const head = name === null
    ? "Начали заполнять полную анкету."
    : `Начали заполнять полную анкету: ${clip(name)}.`;
  return `${head}\nСмотреть: ${MODEL_APPLICATIONS_SCREEN_URL}/${session}`;
}

export function formatModelApplicationAbandonNotice(
  session: Pick<ModelApplicationSessionRow, "session" | "name" | "filled" | "total" | "section">,
): string {
  const parts = [
    ...(session.name === null ? [] : [clip(session.name)]),
    `${session.filled} из ${session.total}`,
    ...(session.section === null ? [] : [`остановилась на разделе «${clip(session.section)}»`]),
  ];
  return `Полную анкету не дозаполнили: ${parts.join(", ")}.\nСмотреть: ${MODEL_APPLICATIONS_SCREEN_URL}/${session.session}`;
}

/**
 * One progress post: honeypot → upsert (a new filling only while its address
 * started fewer than 50 in a day) → the start notice, once per filling, not
 * awaited.
 */
export async function recordModelApplicationProgressPost(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input: { progress: ModelApplicationProgress; clientAddress: string },
): Promise<void> {
  const { progress } = input;
  if ((progress.website ?? "").trim() !== "") {
    return;
  }
  const recorded = await recordModelApplicationProgress(app.db, {
    session: progress.session.toLowerCase(),
    form: progress.form,
    filled: progress.filled,
    total: progress.total,
    section: present(progress.section),
    name: present(progress.name),
    answers: progress.answers === undefined
      ? null
      : progress.answers.map((answer) => ({
        section: answer.section,
        key: answer.key,
        label: answer.label,
        value: answer.value,
      })),
    ipHash: modelApplicationAddressHash(app.config.encryptionKey, input.clientAddress),
    maxNewPerWindow: NEW_FILLINGS_PER_ADDRESS_PER_DAY,
    newWindowMs: DAY_MS,
  });
  if (recorded.status === "rate_limited") {
    throw new TooManyRequestsError("Too many questionnaires started from this address today");
  }
  if (recorded.startClaimed) {
    void notifyOwnerOfModelApplication(app, {
      kind: "model_application_started",
      idempotencyKey: `model-application-start:${progress.session}`,
      text: formatModelApplicationStartNotice(recorded.name, progress.session.toLowerCase()),
    }).catch((error: unknown) => {
      app.logger.error({ err: error }, "model application: start notice failed");
    });
  }
}

/** Every 5 minutes: each filling left unsent for 30 minutes is told once. */
export async function runModelApplicationAbandonSweep(
  app: Pick<AppContext, "config" | "db" | "logger">,
  now = new Date(),
): Promise<{ notified: number }> {
  const left = await claimAbandonedModelApplicationSessions(app.db, {
    idleBefore: new Date(now.getTime() - MODEL_APPLICATION_ABANDON_AFTER_MS),
    limit: ABANDON_SWEEP_LIMIT,
    now,
  });
  for (const session of left) {
    try {
      await notifyOwnerOfModelApplication(app, {
        kind: "model_application_abandoned",
        idempotencyKey: `model-application-abandon:${session.session}:${session.updatedAt.toISOString()}`,
        text: formatModelApplicationAbandonNotice(session),
      });
    } catch (error) {
      app.logger.error({ err: error }, "model application: abandon notice failed");
    }
  }
  return { notified: left.length };
}

export async function ensureModelApplicationAbandonSweepQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, MODEL_APPLICATION_ABANDON_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureModelApplicationAbandonSweepSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(MODEL_APPLICATION_ABANDON_SWEEP_QUEUE, "*/5 * * * *", null, { tz: "UTC" });
}

// --- The hub CLI's live view (model-applications:live) ---

export function modelApplicationSessionStatus(session: ModelApplicationSessionRow, now: Date): string {
  if (session.submittedAt !== null) {
    return session.applicationId === null ? "отправлена" : `отправлена №${session.applicationId}`;
  }
  return now.getTime() - session.updatedAt.getTime() >= MODEL_APPLICATION_ABANDON_AFTER_MS
    ? "бросила"
    : "заполняет";
}

/** Newest activity first: name, filled/total, section, started/updated (Moscow), status. */
export function formatModelApplicationSessions(
  sessions: readonly ModelApplicationSessionRow[],
  now = new Date(),
): string {
  if (sessions.length === 0) {
    return "no questionnaire fillings in the last 24 h";
  }
  const table = [
    ["name", "filled", "section", "started (MSK)", "updated (MSK)", "status", "session (--show)"],
    ...sessions.map((session) => [
      session.name === null ? "—" : clip(session.name, 40),
      `${session.filled}/${session.total}`,
      session.section === null ? "—" : clip(session.section, 40),
      formatMoscowMinute(session.startedAt),
      formatMoscowMinute(session.updatedAt),
      modelApplicationSessionStatus(session, now),
      session.session,
    ]),
  ];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((line) => line[column]!.length)));
  return table
    .map((line) => line.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd())
    .join("\n");
}

/** One filling: where it stands, then its latest answers snapshot like `model-applications:show`. */
export function formatModelApplicationSession(session: ModelApplicationSessionDetail, now = new Date()): string {
  const head = [
    session.name === null ? "—" : session.name,
    `${session.filled}/${session.total}`,
    ...(session.section === null ? [] : [session.section]),
    modelApplicationSessionStatus(session, now),
    `started ${formatMoscowMinute(session.startedAt)} MSK`,
    `updated ${formatMoscowMinute(session.updatedAt)} MSK`,
  ].join(" · ");
  if (session.answers === null) {
    return `${head}\n\nno answers snapshot: the page sent none`;
  }
  return [head, ...formatAnswersBySection(session.answers)].join("\n");
}
