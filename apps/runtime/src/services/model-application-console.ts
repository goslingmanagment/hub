import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import {
  getModelApplication,
  getModelApplicationSession,
  listModelApplicationEntries,
  listRecentModelApplicationSessions,
  type ModelApplicationAnswer,
  type ModelApplicationEntry,
  type ModelApplicationSessionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";
import { MODEL_APPLICATION_ABANDON_AFTER_MS } from "./model-application-sessions.ts";

// The owner's console screen Команда → Анкеты: every filling of the agency
// site's questionnaire and every sent questionnaire, merged by their last
// activity, and one of them with its answers.

type Item = KernelOperationResponse<"adminModelApplications">["items"][number];
type Detail = KernelOperationResponse<"adminModelApplication">;

const CONSOLE_LIMIT = 200;
const SESSION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionItem(
  session: ModelApplicationSessionRow,
  application: ModelApplicationEntry | null,
  now: Date,
): Item {
  const status = session.submittedAt !== null
    ? "sent"
    : now.getTime() - session.updatedAt.getTime() >= MODEL_APPLICATION_ABANDON_AFTER_MS
      ? "abandoned"
      : "filling";
  // A filling the page never reported (made by its submit) has no counts of its own.
  const counted = session.total === 0 && application !== null;
  return {
    ref: session.session,
    name: session.name ?? application?.name ?? null,
    filled: counted ? application.filled : session.filled,
    total: counted ? application.total : session.total,
    section: session.section,
    startedAt: session.startedAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    status,
    applicationId: session.applicationId,
    googleStatus: application?.googleStatus ?? null,
  };
}

function applicationItem(application: ModelApplicationEntry): Item {
  return {
    ref: String(application.id),
    name: application.name,
    filled: application.filled,
    total: application.total,
    section: null,
    startedAt: application.createdAt.toISOString(),
    updatedAt: application.createdAt.toISOString(),
    status: "sent",
    applicationId: application.id,
    googleStatus: application.googleStatus,
  };
}

export async function listModelApplicationConsole(
  app: Pick<AppContext, "db">,
  now = new Date(),
): Promise<KernelOperationResponse<"adminModelApplications">> {
  const [sessions, applications] = await Promise.all([
    listRecentModelApplicationSessions(app.db, { since: new Date(0), limit: CONSOLE_LIMIT }),
    listModelApplicationEntries(app.db, { limit: CONSOLE_LIMIT }),
  ]);
  const byId = new Map(applications.map((entry) => [entry.id, entry]));
  const items = [
    ...sessions.map((session) => sessionItem(
      session,
      session.applicationId === null ? null : byId.get(session.applicationId) ?? null,
      now,
    )),
    ...applications.filter((entry) => !entry.sessionLinked).map(applicationItem),
  ];
  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { serverNow: now.toISOString(), items: items.slice(0, CONSOLE_LIMIT) };
}

function answerName(answers: readonly ModelApplicationAnswer[]): string | null {
  const value = answers.find((answer) => answer.key === "name")?.value.trim() ?? "";
  return value === "" ? null : value;
}

export async function getModelApplicationConsoleEntry(
  app: Pick<AppContext, "db">,
  ref: string,
  now = new Date(),
): Promise<Detail> {
  if (SESSION_REF.test(ref)) {
    const session = await getModelApplicationSession(app.db, ref);
    if (!session) {
      throw new NotFoundError("No such questionnaire filling");
    }
    const application = session.applicationId === null
      ? null
      : await getModelApplication(app.db, session.applicationId);
    const entry: ModelApplicationEntry | null = application === null ? null : {
      id: application.id,
      createdAt: application.createdAt,
      form: application.form,
      name: answerName(application.answers),
      filled: application.answers.filter((answer) => answer.value.trim() !== "").length,
      total: application.answers.length,
      googleStatus: application.googleStatus,
      googleError: application.googleError,
      sessionLinked: true,
    };
    return {
      ...sessionItem(session, entry, now),
      serverNow: now.toISOString(),
      googleError: application?.googleError ?? null,
      answersFrom: application !== null ? "submitted" : session.answers !== null ? "snapshot" : "none",
      answers: application?.answers ?? session.answers ?? [],
    };
  }

  const application = await getModelApplication(app.db, Number(ref));
  if (!application) {
    throw new NotFoundError("No such questionnaire");
  }
  return {
    ...applicationItem({
      id: application.id,
      createdAt: application.createdAt,
      form: application.form,
      name: answerName(application.answers),
      filled: application.answers.filter((answer) => answer.value.trim() !== "").length,
      total: application.answers.length,
      googleStatus: application.googleStatus,
      googleError: application.googleError,
      sessionLinked: false,
    }),
    serverNow: now.toISOString(),
    googleError: application.googleError,
    answersFrom: "submitted",
    answers: application.answers,
  };
}
