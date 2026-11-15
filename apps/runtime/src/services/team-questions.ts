import {
  TEAM_QUESTION_KIND_WORDS,
  type TeamQuestion,
  type TeamQuestionAnswerBody,
  type TeamQuestionAskBody,
  type TeamQuestionCloseBody,
  type TeamQuestionKind,
  type TeamQuestionsResponse,
  type TeamQuestionWriteResponse,
} from "@agency_hub_core/contracts";
import {
  answerTeamQuestion,
  closeMatter,
  findPageSummaryByLabel,
  findTeamQuestion,
  insertTeamQuestion,
  listHandinNames,
  listTeamQuestions,
  markTeamQuestionSeen,
  openMatter,
  withdrawTeamQuestion,
  type MatterActor,
  type TeamFacts,
  type TeamQuestionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { deciderOf, modelOfPageId, personOfLogin, personsOfLogins, requireTeamReader, teamFactsFor, teamPagesFor } from "./teams.ts";

/**
 * Вопросы тому, кто решает (products plan 2026-11-13 §4.6): the one service of a question — its row (`team_questions`,
 * 0418) and its two matters, of which it is the one writer: `question.asked` waits for the decider while the question is
 * open, `question.answered` for the asker until they have read the answer.
 *
 * - Asking: any person's session (the extension's narrow one too), on a page of their teams or their own
 *   (`teamPagesFor`). Who decides is `deciderOf` of the page's model at that moment, kind `work`: the team's lead, the
 *   owner when the team has none or its lead is the asker.
 * - Answering: the decider (any login of their person) or the owner, a full session — the narrow one is refused by the
 *   operations' list (web-session-scopes.ts, password-only).
 * - Reading: the asker, the decider and the owner; anyone else is told it does not exist.
 * Database only; no money of anyone.
 */

type QuestionsApp = Pick<AppContext, "db">;

const SYSTEM: MatterActor = { door: "system" };
const ASKED = "question.asked";
const ANSWERED = "question.answered";
const RECENT_MS = 30 * 86_400_000;

const notFound = () => new NotFoundError("No such question");

function isOwnerSession(principal: HumanAuthPrincipal): boolean {
  return principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined;
}

/** Every living login of a login's person (itself when it is nobody's). Pure. */
function loginsOf(facts: TeamFacts, userId: number): number[] {
  const person = personOfLogin(facts, userId);
  if (person === null) return [userId];
  return [...new Set([userId, ...facts.logins.filter((login) => login.personId === person).map((login) => login.userId)])];
}

const kindWord = (kind: string) => TEAM_QUESTION_KIND_WORDS[kind as TeamQuestionKind] ?? kind;

/** A question as its reader sees it. */
async function wireOf(app: QuestionsApp, facts: TeamFacts, principal: HumanAuthPrincipal, rows: readonly TeamQuestionRow[]): Promise<TeamQuestion[]> {
  const names = await listHandinNames(app.db, rows.flatMap((row) => [row.askerUserId, row.deciderUserId, row.answeredByUserId].filter((id): id is number => id !== null)));
  const own = loginsOf(facts, principal.user.id);
  const owner = isOwnerSession(principal);
  return rows.map((row) => {
    const decides = row.deciderUserId === null ? owner : own.includes(row.deciderUserId);
    return {
      id: row.id,
      kind: row.kind as TeamQuestionKind,
      text: row.text,
      pageLabel: row.pageLabel,
      fan: row.fanRef === null && row.fanName === null ? null : { fanRef: row.fanRef, name: row.fanName },
      asker: { userId: row.askerUserId, name: names.get(row.askerUserId) ?? `#${row.askerUserId}` },
      decider: row.deciderUserId === null
        ? { kind: "owner" as const, name: "Владелец" }
        : { kind: "team_lead" as const, name: names.get(row.deciderUserId) ?? `#${row.deciderUserId}` },
      door: row.door,
      askedAt: row.askedAt.toISOString(),
      state: row.state,
      answer: row.answer,
      answerText: row.answerText,
      answeredBy: row.answeredByUserId === null ? null : names.get(row.answeredByUserId) ?? `#${row.answeredByUserId}`,
      answeredAt: row.answeredAt?.toISOString() ?? null,
      seen: row.seenAt !== null,
      canAnswer: row.state === "open" && (owner || decides),
      mine: own.includes(row.askerUserId),
    };
  });
}

/** Whether the reader may see the question: its asker, its decider, the owner. */
function reads(facts: TeamFacts, principal: HumanAuthPrincipal, row: TeamQuestionRow): boolean {
  if (isOwnerSession(principal)) return true;
  const own = loginsOf(facts, principal.user.id);
  return own.includes(row.askerUserId) || (row.deciderUserId !== null && own.includes(row.deciderUserId));
}

/** The link of both matters: Workboard's «Ждут вас» with the question open. */
const linkOf = (id: number) => `/workboard/waiting?question=${id}#asks`;

async function openAsked(app: QuestionsApp, row: TeamQuestionRow, askerName: string, now: Date): Promise<void> {
  await openMatter(app.db, {
    key: `${ASKED}:${row.id}`,
    kind: ASKED,
    source: "server",
    title: `${askerName} спрашивает: ${kindWord(row.kind).toLowerCase()}`,
    object: { type: "team_question", id: String(row.id) },
    pageIds: [row.pageId],
    owner: row.deciderUserId === null ? { role: "owner" } : { userId: row.deciderUserId },
    money: false,
    // No words of the question here: they may name a fan, and the matter outlives a fan's erasure of the question.
    evidence: { questionId: row.id, kind: row.kind, askedAt: row.askedAt.toISOString() },
    link: linkOf(row.id),
  }, SYSTEM, now);
}

export async function readTeamQuestions(app: QuestionsApp, principal: AuthPrincipal, query: { id?: number | undefined }, now: Date = new Date()): Promise<TeamQuestionsResponse> {
  requireTeamReader(principal);
  const facts = await teamFactsFor(app, principal);
  if (query.id !== undefined) {
    const row = await findTeamQuestion(app.db, query.id);
    if (row === null || !reads(facts, principal, row)) throw notFound();
    return { questions: await wireOf(app, facts, principal, [row]), serverNow: now.toISOString() };
  }
  const own = loginsOf(facts, principal.user.id);
  const owner = isOwnerSession(principal);
  // The owner's are cut to his realm (a test owner's to the test pages); anyone else's are their own by person.
  const pageScope = owner ? await teamPagesFor(app, principal) : undefined;
  const rows = await listTeamQuestions(app.db, {
    askerUserIds: own, deciderUserIds: own, ownerDecides: owner, since: new Date(now.getTime() - RECENT_MS),
    ...(pageScope !== undefined ? { pageIds: pageScope } : {}),
  });
  return { questions: await wireOf(app, facts, principal, rows), serverNow: now.toISOString() };
}

export async function askTeamQuestion(app: QuestionsApp, principal: AuthPrincipal, body: TeamQuestionAskBody, now: Date = new Date()): Promise<TeamQuestionWriteResponse> {
  requireTeamReader(principal);
  const page = await findPageSummaryByLabel(app.db, body.pageLabel);
  if (!page) throw new NotFoundError(`Page "${body.pageLabel}" was not found`);
  const scope = await teamPagesFor(app, principal);
  if (scope !== undefined && !scope.includes(page.id)) throw new ForbiddenError("Page access denied");
  const facts = await teamFactsFor(app, principal);
  const modelId = modelOfPageId(facts, page.id);
  const decider = deciderOf(facts, modelId, "work", personsOfLogins(facts, [principal.user.id]));
  const id = await insertTeamQuestion(app.db, {
    askerUserId: principal.user.id, pageId: page.id, modelId, fanRef: body.fanRef ?? null, fanName: body.fanName ?? null,
    kind: body.kind, text: body.text, deciderUserId: decider.kind === "owner" ? null : decider.userId, door: body.door, at: now,
  });
  const row = (await findTeamQuestion(app.db, id))!;
  const [question] = await wireOf(app, facts, principal, [row]);
  await openAsked(app, row, question!.asker.name, now);
  return { question: question!, savedAt: now.toISOString() };
}

export async function answerQuestion(
  app: QuestionsApp, principal: AuthPrincipal, id: number, body: TeamQuestionAnswerBody, now: Date = new Date(),
): Promise<TeamQuestionWriteResponse> {
  requireTeamReader(principal);
  const facts = await teamFactsFor(app, principal);
  const row = await findTeamQuestion(app.db, id);
  if (row === null || !reads(facts, principal, row)) throw notFound();
  const decides = isOwnerSession(principal) || (row.deciderUserId !== null && principal.narrowDeviceTokenId === undefined && loginsOf(facts, principal.user.id).includes(row.deciderUserId));
  if (!decides) throw new ForbiddenError("Only whoever decides answers it");
  const text = body.text === undefined || body.text === "" ? null : body.text;
  if (!(await answerTeamQuestion(app.db, { id, answer: body.answer, text, byUserId: principal.user.id, at: now }))) {
    throw new ConflictError("The question is not open any more");
  }
  const answered = (await findTeamQuestion(app.db, id))!;
  await closeMatter(app.db, { key: `${ASKED}:${id}`, how: "resolved", writer: "server" }, SYSTEM, now);
  await openMatter(app.db, {
    key: `${ANSWERED}:${id}`,
    kind: ANSWERED,
    source: "server",
    title: `${body.answer === "yes" ? "Можно" : "Нельзя"}: ${kindWord(answered.kind).toLowerCase()}`,
    object: { type: "team_question", id: String(id) },
    pageIds: [answered.pageId],
    owner: { userId: answered.askerUserId },
    money: false,
    evidence: { questionId: id, kind: answered.kind, answer: body.answer, askedAt: answered.askedAt.toISOString(), answeredAt: now.toISOString() },
    link: linkOf(id),
  }, SYSTEM, now);
  const [question] = await wireOf(app, facts, principal, [answered]);
  return { question: question!, savedAt: now.toISOString() };
}

export async function closeQuestion(
  app: QuestionsApp, principal: AuthPrincipal, id: number, body: TeamQuestionCloseBody, now: Date = new Date(),
): Promise<TeamQuestionWriteResponse> {
  requireTeamReader(principal);
  const facts = await teamFactsFor(app, principal);
  const row = await findTeamQuestion(app.db, id);
  if (row === null || !reads(facts, principal, row)) throw notFound();
  if (!loginsOf(facts, principal.user.id).includes(row.askerUserId)) throw new ForbiddenError("Only the asker closes it");
  if (body.how === "withdraw") {
    if (!(await withdrawTeamQuestion(app.db, { id, at: now }))) throw new ConflictError("The question is not open any more");
    await closeMatter(app.db, { key: `${ASKED}:${id}`, how: "withdrawn", writer: "server" }, SYSTEM, now);
  } else {
    if (row.state !== "answered") throw new ConflictError("The question has no answer yet");
    await markTeamQuestionSeen(app.db, { id, at: now });
    await closeMatter(app.db, { key: `${ANSWERED}:${id}`, how: "resolved", writer: "server" }, SYSTEM, now);
  }
  const [question] = await wireOf(app, facts, principal, [(await findTeamQuestion(app.db, id))!]);
  return { question: question!, savedAt: now.toISOString() };
}
