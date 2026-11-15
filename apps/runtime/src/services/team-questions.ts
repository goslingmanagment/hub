import {
  TEAM_QUESTION_KIND_WORDS,
  type TeamQuestion,
  type TeamQuestionAnswerBody,
  type TeamQuestionAskBody,
  type TeamQuestionCloseBody,
  type TeamQuestionKind,
  type TeamQuestionsResponse,
  type TeamQuestionSwap,
  type TeamQuestionSwapBody,
  type TeamQuestionWriteResponse,
  type TeamSwapsResponse,
} from "@agency_hub_core/contracts";
import {
  answerTeamQuestion,
  closeMatter,
  findPersonRowByCode,
  insertPersonDayLine,
  listApprovedSwaps,
  listStandingSwapQuestionIds,
  listMatterPageLabels,
  listPersonRows,
  revokePersonDayLines,
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
  type TeamQuestionSwap as TeamQuestionSwapRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { recordAudit, type AuthPrincipal, type HumanAuthPrincipal } from "./auth.ts";
import { moscowDayOf } from "./chatter-shifts.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { slotMinute, slotTime } from "./people/index.ts";
import { pageIsTest, requireSameRealm } from "./sandbox/realm.ts";
import { deciderOf, leadsModel, modelOfPageId, pagesOfModels, personOfLogin, personsOfLogins, requireTeamReader, teamFactsFor, teamPagesFor } from "./teams.ts";

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
 * - The test realm (sandbox/realm.ts): a question lives in its page's realm; a principal of the other realm — the live
 *   owner and a test question, the test owner and a live one — is told it does not exist, by id as in the list.
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

/** Whether the viewer decides the question: its decider (any login of their person) or the owner; never a narrow session. */
function decidesIt(facts: TeamFacts, principal: HumanAuthPrincipal, row: TeamQuestionRow): boolean {
  if (principal.narrowDeviceTokenId !== undefined) return false;
  return isOwnerSession(principal) || (row.deciderUserId !== null && loginsOf(facts, principal.user.id).includes(row.deciderUserId));
}

/** A swap's details as a reader sees them: the people by code and name, the pages by label; whether it stands. */
async function swapsOf(app: QuestionsApp, facts: TeamFacts, principal: HumanAuthPrincipal, rows: readonly TeamQuestionRow[], now: Date): Promise<Map<number, TeamQuestionSwap>> {
  const out = new Map<number, TeamQuestionSwap>();
  const withSwap = rows.filter((row) => row.swap !== null);
  if (withSwap.length === 0) return out;
  const realm = principal.sandbox?.test === true ? "test" : "live";
  const people = new Map((await listPersonRows(app.db, realm)).map((one) => [one.id, one]));
  const labels = (await listMatterPageLabels(app.db)).labelOf;
  const standing = await listStandingSwapQuestionIds(app.db, withSwap.map((row) => row.id));
  const today = moscowDayOf(now.getTime());
  for (const row of withSwap) {
    const swap = row.swap!;
    const person = (id: number) => ({ code: people.get(id)?.code ?? "", name: people.get(id)?.displayName ?? `#${id}` });
    const approved = row.answer === "yes" && standing.has(row.id);
    out.set(row.id, {
      date: swap.date,
      pages: swap.pageIds.map((id) => labels.get(id) ?? `#${id}`),
      start: slotTime(swap.startMinute),
      end: slotTime(swap.endMinute),
      absent: person(swap.absentPersonId),
      cover: person(swap.coverPersonId),
      approved,
      revoked: row.answer === "yes" && !approved,
      canRevoke: approved && swap.date > today && decidesIt(facts, principal, row),
    });
  }
  return out;
}

/** A question as its reader sees it. */
async function wireOf(app: QuestionsApp, facts: TeamFacts, principal: HumanAuthPrincipal, rows: readonly TeamQuestionRow[], now: Date = new Date()): Promise<TeamQuestion[]> {
  const names = await listHandinNames(app.db, rows.flatMap((row) => [row.askerUserId, row.deciderUserId, row.answeredByUserId].filter((id): id is number => id !== null)));
  const own = loginsOf(facts, principal.user.id);
  const owner = isOwnerSession(principal);
  const swaps = await swapsOf(app, facts, principal, rows, now);
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
      swap: swaps.get(row.id) ?? null,
    };
  });
}

/** Whether the reader may see the question: its asker, its decider, the owner. */
function reads(facts: TeamFacts, principal: HumanAuthPrincipal, row: TeamQuestionRow): boolean {
  if (isOwnerSession(principal)) return true;
  const own = loginsOf(facts, principal.user.id);
  return own.includes(row.askerUserId) || (row.deciderUserId !== null && own.includes(row.deciderUserId));
}

/** A question of the principal's realm (its page's), else «not found»: no question crosses the wall, by id or by list. */
async function requireQuestionOfRealm(app: QuestionsApp, principal: AuthPrincipal, row: TeamQuestionRow): Promise<void> {
  requireSameRealm(principal, await pageIsTest(app, row.pageId), notFound);
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
    await requireQuestionOfRealm(app, principal, row);
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
  requireSameRealm(principal, await pageIsTest(app, page.id), () => new NotFoundError(`Page "${body.pageLabel}" was not found`));
  const facts = await teamFactsFor(app, principal);
  const modelId = modelOfPageId(facts, page.id);
  const swap = body.kind === "swap" && body.swap !== undefined ? await swapOfBody(app, facts, principal, body.swap, { modelId, scope, now }) : null;
  if (body.kind !== "swap" && body.swap !== undefined) throw new BadRequestError("A swap's details belong to the kind «Подмена»");
  // The absent person is a side too: a lead asking for a person of their team, or that person, never decides it.
  const sides = personsOfLogins(facts, [principal.user.id]);
  if (swap !== null && !sides.includes(swap.absentPersonId)) sides.push(swap.absentPersonId);
  const decider = deciderOf(facts, modelId, "work", sides);
  // «График» (a lead's proposal of the standing schedule) is always the owner's: he changes it on the person's card.
  const deciderUserId = body.kind === "schedule" || decider.kind === "owner" ? null : decider.userId;
  const id = await insertTeamQuestion(app.db, {
    askerUserId: principal.user.id, pageId: swap === null ? page.id : swap.pageIds[0]!, modelId, fanRef: body.fanRef ?? null, fanName: body.fanName ?? null,
    kind: body.kind, text: body.text, deciderUserId, door: body.door, at: now, swap,
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
  await requireQuestionOfRealm(app, principal, row);
  if (!decidesIt(facts, principal, row)) throw new ForbiddenError("Only whoever decides answers it");
  const text = body.text === undefined || body.text === "" ? null : body.text;
  const swap = row.kind === "swap" && body.answer === "yes" ? row.swap : null;
  if (swap !== null && swap.date < moscowDayOf(now.getTime())) throw new ConflictError("The swap's day has passed: answer «Нельзя» or let it be");
  // «Можно» of a swap writes the day's lines of the schedule in the answer's own transaction: both or neither.
  await app.db.transaction(async (tx) => {
    if (!(await answerTeamQuestion(tx, { id, answer: body.answer, text, byUserId: principal.user.id, at: now }))) {
      throw new ConflictError("The question is not open any more");
    }
    if (swap !== null) await writeSwapLines(tx, row.id, swap, principal.user.id);
  });
  if (swap !== null) await auditSwap(app, principal, row.id, swap, "person.schedule_swap");
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
  await requireQuestionOfRealm(app, principal, row);
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

// ── «Подмена» (products package W, 0422) ────────────────────────────────────

/** The swap of an ask, checked: a day ahead, pages of one team, a covering person of that team, the absent person's pages. */
async function swapOfBody(
  app: QuestionsApp,
  facts: TeamFacts,
  principal: HumanAuthPrincipal,
  body: TeamQuestionSwapBody,
  input: { modelId: number | null; scope: number[] | undefined; now: Date },
): Promise<TeamQuestionSwapRow> {
  const today = moscowDayOf(input.now.getTime());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date) || Number.isNaN(Date.parse(`${body.date}T00:00:00Z`)) || body.date <= today) {
    throw new BadRequestError("A swap is asked for a day ahead");
  }
  const labels = (await listMatterPageLabels(app.db)).idOf;
  const pageIds = [...new Set(body.pageLabels.map((label) => {
    const id = labels.get(label);
    if (id === undefined) throw new NotFoundError(`Page "${label}" was not found`);
    if (input.scope !== undefined && !input.scope.includes(id)) throw new ForbiddenError("Page access denied");
    if (modelOfPageId(facts, id) !== input.modelId) throw new BadRequestError("A swap's pages are of one team");
    return id;
  }))];
  const startMinute = slotMinute(body.start);
  const endMinute = slotMinute(body.end);
  const length = (endMinute - startMinute + 1440) % 1440;
  if (length < 60 || length > 960) throw new BadRequestError("A slot lasts an hour to sixteen hours");
  const test = principal.sandbox?.test === true;
  const personOf = async (code: string) => {
    const row = await findPersonRowByCode(app.db, code);
    if (row === null || row.isTest !== test || row.state === "left" || row.kind !== "human") throw new NotFoundError(`No person «${code}» here`);
    return row;
  };
  const asker = personOfLogin(facts, principal.user.id);
  const absent = body.absentPersonCode === undefined ? null : await personOf(body.absentPersonCode);
  const absentPersonId = absent?.id ?? asker;
  if (absentPersonId === null) throw new BadRequestError("Name whose slot it is");
  // Asking for another person is their lead's (or the owner's).
  if (absentPersonId !== asker && !(input.modelId !== null && await leadsModel(app, principal, input.modelId))) {
    throw new ForbiddenError("A swap for another person is asked by the team's lead");
  }
  const works = (personId: number) => new Set(facts.working.filter((row) => row.personId === personId).map((row) => row.pageId));
  const absentPages = works(absentPersonId);
  if (pageIds.some((id) => !absentPages.has(id))) throw new BadRequestError("The absent person does not work one of these pages");
  const cover = await personOf(body.coverPersonCode);
  if (cover.id === absentPersonId) throw new BadRequestError("Someone else covers");
  const teamPages = new Set(input.modelId === null ? [] : pagesOfModels(facts, [input.modelId]));
  if (![...works(cover.id)].some((id) => teamPages.has(id))) throw new BadRequestError("The covering person is not of this team");
  return { date: body.date, pageIds, startMinute, endMinute, absentPersonId, coverPersonId: cover.id };
}

/**
 * The swap's lines of its day, written by the registry's one writer of day lines (`insertPersonDayLine`): the covering
 * person's `cover` line and the absent person's `off` line on each page. In the caller's transaction.
 */
async function writeSwapLines(db: Parameters<typeof insertPersonDayLine>[0], questionId: number, swap: TeamQuestionSwapRow, byUserId: number): Promise<void> {
  for (const pageId of swap.pageIds) {
    const line = { pageId, day: swap.date, startMinute: swap.startMinute, endMinute: swap.endMinute, questionId, createdByUserId: byUserId };
    await insertPersonDayLine(db, { ...line, personId: swap.coverPersonId, kind: "cover" });
    await insertPersonDayLine(db, { ...line, personId: swap.absentPersonId, kind: "off" });
  }
}

/** The persons' history (the audit log, as every change of a person): who covers whom, when, by whose word. */
async function auditSwap(app: QuestionsApp, principal: HumanAuthPrincipal, questionId: number, swap: TeamQuestionSwapRow, eventType: string): Promise<void> {
  for (const [personId, role] of [[swap.coverPersonId, "cover"], [swap.absentPersonId, "off"]] as const) {
    await recordAudit(app, {
      source: "workboard", actorUserId: principal.user.id, eventType,
      metadata: { personId, role, questionId, date: swap.date, pageIds: swap.pageIds, start: slotTime(swap.startMinute), end: slotTime(swap.endMinute) },
    });
  }
}

/** «Отменить подмену»: its decider or the owner, before the day; the lines are marked taken back, never deleted. */
export async function revokeSwap(app: QuestionsApp, principal: AuthPrincipal, id: number, now: Date = new Date()): Promise<TeamQuestionWriteResponse> {
  requireTeamReader(principal);
  const facts = await teamFactsFor(app, principal);
  const row = await findTeamQuestion(app.db, id);
  if (row === null || !reads(facts, principal, row) || row.swap === null) throw notFound();
  await requireQuestionOfRealm(app, principal, row);
  if (!decidesIt(facts, principal, row)) throw new ForbiddenError("Only whoever decided it takes it back");
  if (row.swap.date <= moscowDayOf(now.getTime())) throw new ConflictError("The swap's day has come: it stays");
  const taken = await revokePersonDayLines(app.db, { questionId: id, byUserId: principal.user.id, at: now });
  if (taken === 0) throw new ConflictError("Nothing to take back: the swap is not standing");
  await auditSwap(app, principal, id, row.swap, "person.schedule_swap_revoked");
  await openMatter(app.db, {
    key: `${ANSWERED}:${id}`,
    kind: ANSWERED,
    source: "server",
    title: `Подмена на ${row.swap.date} отменена`,
    object: { type: "team_question", id: String(id) },
    pageIds: [row.pageId],
    owner: { userId: row.askerUserId },
    money: false,
    evidence: { questionId: id, kind: row.kind, answer: "revoked", askedAt: row.askedAt.toISOString(), answeredAt: now.toISOString() },
    link: linkOf(id),
  }, SYSTEM, now);
  const [question] = await wireOf(app, facts, principal, [(await findTeamQuestion(app.db, id))!], now);
  return { question: question!, savedAt: now.toISOString() };
}

/** «График»: the approved swaps of the next 14 days (and today) on the viewer's teams' pages. */
export async function readTeamSwaps(app: QuestionsApp, principal: AuthPrincipal, now: Date = new Date()): Promise<TeamSwapsResponse> {
  requireTeamReader(principal);
  const facts = await teamFactsFor(app, principal);
  const today = moscowDayOf(now.getTime());
  const to = moscowDayOf(now.getTime() + 14 * 86_400_000);
  const scope = await teamPagesFor(app, principal);
  const test = principal.sandbox?.test === true;
  const realmPages = new Set(facts.pages.filter((page) => page.test === test).map((page) => page.pageId));
  const rows = (await listApprovedSwaps(app.db, { from: today, to }))
    .filter((row) => row.swap!.pageIds.every((id) => realmPages.has(id) && (scope === undefined || scope.includes(id))));
  const swaps = await swapsOf(app, facts, principal, rows, now);
  return {
    swaps: rows.flatMap((row) => {
      const swap = swaps.get(row.id);
      return swap === undefined ? [] : [{ ...swap, questionId: row.id }];
    }),
    serverNow: now.toISOString(),
  };
}
