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
  isChatTeamRole,
} from "@agency_hub_core/contracts";
import {
  answerTeamQuestion,
  closeMatter,
  findPersonRowByCode,
  insertPersonDayLine,
  listApprovedSwaps,
  listPersonDaySwaps,
  lockPersonSwaps,
  listStandingSwapQuestionIds,
  listMatterPageLabels,
  listOpenMattersOfKinds,
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
import {
  deciderOf, leadsModel, loginOfPerson, modelOfPageId, pagesOfModels, personOfLogin, personsOfLogins, requireTeamAsker, requireTeamReader, teamFactsFor,
  teamPagesFor, teamsOfPerson, type Decider,
} from "./teams.ts";

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
/** «Вы выходите вместо …»: the covering person of an approved swap is told, until its day has passed or it is taken back. */
const COVER = "question.cover";
const RECENT_MS = 30 * 86_400_000;

const notFound = () => new NotFoundError("No such question");

/** A narrow door: the web session opened from the extension, or the extension's own narrow token (package R5). */
const isNarrow = (principal: HumanAuthPrincipal) => principal.narrowDeviceTokenId !== undefined || principal.clientProfile !== undefined;

function isOwnerSession(principal: HumanAuthPrincipal): boolean {
  return principal.user.role === "owner" && !isNarrow(principal);
}

/** Every living login of a login's person (itself when it is nobody's). Pure. */
function loginsOf(facts: TeamFacts, userId: number): number[] {
  const person = personOfLogin(facts, userId);
  if (person === null) return [userId];
  return [...new Set([userId, ...facts.logins.filter((login) => login.personId === person).map((login) => login.userId)])];
}

const kindWord = (kind: string) => TEAM_QUESTION_KIND_WORDS[kind as TeamQuestionKind] ?? kind;

/** Whether the viewer decides the question NOW (`deciderNow`), or is the owner; never a narrow session. */
function decidesIt(facts: TeamFacts, principal: HumanAuthPrincipal, row: TeamQuestionRow): boolean {
  if (isNarrow(principal)) return false;
  if (isOwnerSession(principal)) return true;
  const now = deciderNow(facts, row);
  if (now.kind !== "team_lead") return false;
  const me = personOfLogin(facts, principal.user.id);
  return me === null ? loginsOf(facts, principal.user.id).includes(now.userId) : now.personId === me;
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

/**
 * Who decides a question NOW: the rule (`deciderOf` of the page's model, kind `work`, the asker and a swap's absent
 * person as sides) at the moment of reading and answering — the decider stored at asking is history. «График» (a lead's
 * proposal of the standing schedule) is always the owner's.
 */
function deciderNow(facts: TeamFacts, row: TeamQuestionRow): Decider {
  if (row.kind === "schedule") return { kind: "owner" };
  const sides = personsOfLogins(facts, [row.askerUserId]);
  if (row.swap !== null && !sides.includes(row.swap.absentPersonId)) sides.push(row.swap.absentPersonId);
  return deciderOf(facts, row.modelId, "work", sides);
}

/** A question as its reader sees it. */
async function wireOf(app: QuestionsApp, facts: TeamFacts, principal: HumanAuthPrincipal, rows: readonly TeamQuestionRow[], now: Date = new Date()): Promise<TeamQuestion[]> {
  const names = await listHandinNames(app.db, rows.flatMap((row) => [row.askerUserId, row.deciderUserId, row.answeredByUserId].filter((id): id is number => id !== null)));
  const own = loginsOf(facts, principal.user.id);
  const owner = isOwnerSession(principal);
  const swaps = await swapsOf(app, facts, principal, rows, now);
  const me = personOfLogin(facts, principal.user.id);
  return rows.map((row) => {
    // An open question's decider is the rule's now; an answered one keeps whom it was asked of (history).
    const now = row.state === "open" ? deciderNow(facts, row) : null;
    const decides = now !== null && now.kind === "team_lead" && principal.narrowDeviceTokenId === undefined && (me === null ? own.includes(now.userId) : now.personId === me);
    const decider = now === null
      ? (row.deciderUserId === null ? { kind: "owner" as const, name: "Владелец" } : { kind: "team_lead" as const, name: names.get(row.deciderUserId) ?? `#${row.deciderUserId}` })
      : now.kind === "owner" ? { kind: "owner" as const, name: "Владелец" } : { kind: "team_lead" as const, name: now.name };
    return {
      id: row.id,
      kind: row.kind as TeamQuestionKind,
      text: row.text,
      pageLabel: row.pageLabel,
      fan: row.fanRef === null && row.fanName === null ? null : { fanRef: row.fanRef, name: row.fanName },
      asker: { userId: row.askerUserId, name: names.get(row.askerUserId) ?? `#${row.askerUserId}` },
      decider,
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

/**
 * Whether the reader may see the question: its asker, its decider now (`deciderNow`), whom it was asked of (history),
 * the person who covers a swap (they are named in it), the owner.
 */
function reads(facts: TeamFacts, principal: HumanAuthPrincipal, row: TeamQuestionRow): boolean {
  if (isOwnerSession(principal)) return true;
  const own = loginsOf(facts, principal.user.id);
  const me = personOfLogin(facts, principal.user.id);
  const now = deciderNow(facts, row);
  return own.includes(row.askerUserId) || (row.deciderUserId !== null && own.includes(row.deciderUserId))
    || (now.kind === "team_lead" && (me === null ? own.includes(now.userId) : now.personId === me))
    || (row.swap !== null && me !== null && row.swap.coverPersonId === me);
}

/** A question of the principal's realm (its page's), else «not found»: no question crosses the wall, by id or by list. */
async function requireQuestionOfRealm(app: QuestionsApp, principal: AuthPrincipal, row: TeamQuestionRow): Promise<void> {
  requireSameRealm(principal, await pageIsTest(app, row.pageId), notFound);
}

/** The link of both matters: Workboard's «Ждут вас» with the question open. */
const linkOf = (id: number) => `/workboard/waiting?question=${id}#asks`;

async function openAsked(app: QuestionsApp, row: TeamQuestionRow, askerName: string, decider: Decider, now: Date): Promise<string> {
  const { transition } = await openMatter(app.db, {
    key: `${ASKED}:${row.id}`,
    kind: ASKED,
    source: "server",
    title: `${askerName} спрашивает: ${kindWord(row.kind).toLowerCase()}`,
    object: { type: "team_question", id: String(row.id) },
    pageIds: [row.pageId],
    // By role, so it follows the records (matters.ts): a team lead's role matter of the page waits for the lead of its
    // model now, and for the owner while the model has none; the owner's when the rule names the owner.
    owner: decider.kind === "owner" ? { role: "owner" } : { role: "team_lead" },
    money: false,
    // No words of the question here: they may name a fan, and the matter outlives a fan's erasure of the question.
    evidence: { questionId: row.id, kind: row.kind, askedAt: row.askedAt.toISOString() },
    link: linkOf(row.id),
  }, SYSTEM, now);
  return transition;
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
  const me = personOfLogin(facts, principal.user.id);
  // The owner's are cut to his realm (a test owner's to the test pages); anyone else's: their own, the ones of the models
  // they lead now (the rule decides below, `reads`), the swaps they cover.
  const pageScope = owner ? await teamPagesFor(app, principal) : undefined;
  const led = me === null ? [] : teamsOfPerson(facts, me).lead;
  const rows = await listTeamQuestions(app.db, {
    askerUserIds: own, deciderUserIds: own, ownerDecides: owner, since: new Date(now.getTime() - RECENT_MS),
    modelIds: led, coverPersonId: me,
    ...(pageScope !== undefined ? { pageIds: pageScope } : {}),
  });
  const seen = rows.filter((row) => reads(facts, principal, row));
  return { questions: await wireOf(app, facts, principal, seen), serverNow: now.toISOString() };
}

export async function askTeamQuestion(app: QuestionsApp, principal: AuthPrincipal, body: TeamQuestionAskBody, now: Date = new Date()): Promise<TeamQuestionWriteResponse> {
  requireTeamAsker(principal, body.kind);
  const page = await findPageSummaryByLabel(app.db, body.pageLabel);
  if (!page) throw new NotFoundError(`Page "${body.pageLabel}" was not found`);
  const scope = await teamPagesFor(app, principal);
  if (scope !== undefined && !scope.includes(page.id)) throw new ForbiddenError("Page access denied");
  requireSameRealm(principal, await pageIsTest(app, page.id), () => new NotFoundError(`Page "${body.pageLabel}" was not found`));
  const facts = await teamFactsFor(app, principal);
  const modelId = modelOfPageId(facts, page.id);
  const swap = body.kind === "swap" && body.swap !== undefined ? await swapOfBody(app, facts, principal, body.swap, { modelId, scope, now }) : null;
  if (swap !== null) await refuseSwapClash(app.db, facts, swap, { asked: true });
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
  await openAsked(app, row, question!.asker.name, deciderNow(facts, row), now);
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
  // A swap is decided before its hours: once its start has passed (Moscow), «Можно» would re-decide whose the sales of that
  // junction already were.
  if (swap !== null && now.getTime() >= swapStartsAt(swap)) {
    throw new ConflictError("The swap has begun: answer «Нельзя» or let it be", { reason: "swap_started" });
  }
  // «Можно» of a swap writes the day's lines of the schedule in the answer's own transaction: both or neither.
  await app.db.transaction(async (tx) => {
    // No swap stands twice over the same hours: checked here, under the persons' lock, against what stands.
    if (swap !== null) {
      await lockPersonSwaps(tx, [swap.absentPersonId, swap.coverPersonId]);
      await refuseSwapClash(tx, facts, swap, { asked: false });
    }
    if (!(await answerTeamQuestion(tx, { id, answer: body.answer, text, byUserId: principal.user.id, at: now }))) {
      throw new ConflictError("The question is not open any more");
    }
    if (swap !== null) await writeSwapLines(tx, row.id, swap, principal.user.id);
  });
  if (swap !== null) {
    await auditSwap(app, principal, row.id, swap, "person.schedule_swap");
    await tellCover(app, facts, row, swap, "approved", now);
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

/** The instant a swap's hours begin, Moscow time. Pure. */
export function swapStartsAt(swap: Pick<TeamQuestionSwapRow, "date" | "startMinute">): number {
  return Date.parse(`${swap.date}T00:00:00+03:00`) + swap.startMinute * 60_000;
}

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
  // The chat team (contracts chat-team.ts) and working already: a content manager or a newcomer not working yet
  // (invited, set up) does not cover a shift.
  if (!isChatTeamRole(cover.role) || cover.state !== "working") throw new BadRequestError("The covering person is not of the chat team at work");
  const teamPages = new Set(input.modelId === null ? [] : pagesOfModels(facts, [input.modelId]));
  if (![...works(cover.id)].some((id) => teamPages.has(id))) throw new BadRequestError("The covering person is not of this team");
  return { date: body.date, pageIds, startMinute, endMinute, absentPersonId, coverPersonId: cover.id };
}

/** A swap's real hours, minutes since the epoch of its Moscow day: an end at or before the start is the next day's. Pure. */
function swapSpan(one: { date: string; startMinute: number; endMinute: number }): readonly [number, number] {
  const day = Date.parse(`${one.date}T00:00:00Z`) / 60_000;
  return [day + one.startMinute, day + (one.endMinute > one.startMinute ? one.endMinute : one.endMinute + 1440)];
}

/** Two swaps' hours overlap (touching is not overlapping), across midnight too. Pure. */
export function swapHoursOverlap(a: { date: string; startMinute: number; endMinute: number }, b: { date: string; startMinute: number; endMinute: number }): boolean {
  const [aFrom, aTo] = swapSpan(a);
  const [bFrom, bTo] = swapSpan(b);
  return aFrom < bTo && bFrom < aTo;
}

/** The day before, the day and the day after a Moscow day. Pure. */
const daysAround = (day: string) => [-1, 0, 1].map((shift) => new Date(Date.parse(`${day}T00:00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10));

/**
 * No swap stands twice over the same hours on any of its pages — real hours, so a swap past midnight meets the next
 * day's: the absent person off already (an approved swap not taken back), or asked for already (an open swap question —
 * at asking only; «Можно» checks what stands), or the covering person off themselves in those hours. Refused with words
 * a person reads.
 */
async function refuseSwapClash(db: QuestionsApp["db"], facts: TeamFacts, swap: TeamQuestionSwapRow, input: { asked: boolean }): Promise<void> {
  const of = (personId: number) => listPersonDaySwaps(db, { personId, days: daysAround(swap.date), pageIds: swap.pageIds });
  const clashes = (hours: ReadonlyArray<{ date: string; startMinute: number; endMinute: number }>) => hours.some((one) => swapHoursOverlap(one, swap));
  const absent = await of(swap.absentPersonId);
  if (clashes(absent.off)) throw new ConflictError("На эти часы подмена уже стоит", { reason: "swap_taken" });
  if (input.asked && clashes(absent.asked)) throw new ConflictError("Подмену на эти часы уже спросили, ждёт ответа", { reason: "swap_asked" });
  if (clashes((await of(swap.coverPersonId)).off)) {
    const name = facts.people.find((one) => one.personId === swap.coverPersonId)?.name ?? "Тот, кто выйдет,";
    throw new ConflictError(`${name} сам не выходит в эти часы`, { reason: "swap_cover_off" });
  }
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
  await tellCover(app, facts, row, row.swap, "revoked", now);
  await openMatter(app.db, {
    key: `${ANSWERED}:${id}`,
    kind: ANSWERED,
    source: "server",
    title: `Подмена на ${dayWords(row.swap.date).toLowerCase()} отменена`,
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

/** «Пн, 16 нояб.» of a Moscow day. */
function dayWords(day: string): string {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Moscow" })
    .format(new Date(`${day}T12:00:00+03:00`)).replace(/^./, (first) => first.toUpperCase());
}

/**
 * The covering person of an approved swap is told in «Ждут вас» («Вы выходите вместо …», the swap's day, hours and
 * pages), and told again when it is taken back. The matter closes itself once the day has passed
 * (`closePassedCoverMatters`). The question service is its one writer.
 */
async function tellCover(app: QuestionsApp, facts: TeamFacts, row: TeamQuestionRow, swap: TeamQuestionSwapRow, how: "approved" | "revoked", now: Date): Promise<void> {
  const userId = loginOfPerson(facts, swap.coverPersonId);
  if (userId === null) return;
  const absent = facts.people.find((person) => person.personId === swap.absentPersonId)?.name ?? "";
  const labels = (await listMatterPageLabels(app.db)).labelOf;
  const pages = swap.pageIds.map((id) => labels.get(id) ?? `#${id}`).join(", ");
  const when = `${dayWords(swap.date)}, ${slotTime(swap.startMinute)}–${slotTime(swap.endMinute)}, ${pages}`;
  await openMatter(app.db, {
    key: `${COVER}:${row.id}`,
    kind: COVER,
    source: "server",
    title: how === "approved" ? `Вы выходите вместо ${absent}: ${when}` : `Подмена отменена, вы не выходите вместо ${absent}: ${when}`,
    object: { type: "team_question", id: String(row.id) },
    pageIds: swap.pageIds,
    owner: { userId },
    money: false,
    evidence: { questionId: row.id, date: swap.date, how },
    link: linkOf(row.id),
  }, SYSTEM, now);
}

/** The covering persons' matters of swaps whose day has passed (Moscow): closed, the cause gone. Every ten minutes. */
export async function closePassedCoverMatters(app: QuestionsApp, now: Date = new Date()): Promise<{ closed: number }> {
  const today = moscowDayOf(now.getTime());
  let closed = 0;
  for (const matter of await listOpenMattersOfKinds(app.db, [COVER])) {
    const date = typeof matter.evidence.date === "string" ? matter.evidence.date : null;
    if (date === null || date >= today) continue;
    const result = await closeMatter(app.db, { key: matter.key, how: "cause_gone", writer: "server" }, SYSTEM, now);
    if (result.transition === "closed") closed += 1;
  }
  return { closed };
}

/**
 * The open questions' «… спрашивает» matters, re-addressed to whom the rule names now (`deciderNow`): a team's first lead
 * signing in takes the questions asked of the owner before; a lead gone, they go back to the owner. The same matter,
 * updated in place — never reopened or doubled. Every ten minutes.
 */
export async function readdressAskedMatters(app: QuestionsApp, now: Date = new Date()): Promise<{ readdressed: number }> {
  const open = await listOpenMattersOfKinds(app.db, [ASKED]);
  if (open.length === 0) return { readdressed: 0 };
  const facts = await teamFactsFor(app);
  let readdressed = 0;
  for (const matter of open) {
    const id = Number(matter.object?.id ?? Number.NaN);
    const row = Number.isFinite(id) ? await findTeamQuestion(app.db, id) : null;
    if (row === null || row.state !== "open") continue;
    // The same fields but the owner: the matter changes only when the rule's decider did (matters.ts compares them).
    const names = await listHandinNames(app.db, [row.askerUserId]);
    if (await openAsked(app, row, names.get(row.askerUserId) ?? `#${row.askerUserId}`, deciderNow(facts, row), now) === "updated") readdressed += 1;
  }
  return { readdressed };
}
