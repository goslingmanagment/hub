import type {
  AgentShiftReportCheckBody,
  AgentShiftReportChecksResponse,
  ShiftReportAskBody,
  ShiftReportConfirmResponse,
  ShiftReportCurrentResponse,
  ShiftReportPhase,
  ShiftReportResponse,
} from "@agency_hub_core/contracts";
import {
  closeMatter,
  findHandinById,
  findHandinByShift,
  findHandinCandidate,
  findHandinProposal,
  findLatestHandinShift,
  findHandinPersonOfUser,
  findSaleSighting,
  hasShiftReportReviewer,
  insertHandinCandidate,
  insertHandinEvent,
  insertHandinProposal,
  insertHandinVersion,
  insertSaleClaim,
  listCandidatesAwaitingCheck,
  listCheckingHandins,
  listConfirmHandins,
  listHandinCandidates,
  listHandinColleagues,
  listHandinMarks,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinProposals,
  listHandinSaleFans,
  listHandinShifts,
  listHandinsOfShifts,
  listHandinVersions,
  listLateProposalHandins,
  listMatterPageLabels,
  listOffPlatform,
  listOpenMattersOfKinds,
  listSaleClaims,
  lockSaleSettlements,
  openMatter,
  reopenSaleClaim,
  setCandidateConfirmed,
  setCandidateGengarAnswer,
  setHandinMark,
  setHandinFixingFrom,
  setHandinPhase,
  setHandinPostCopied,
  setHandinProposalState,
  setSaleSightingAdded,
  updateSaleClaim,
  type CandidateHubPage,
  type CandidateRow,
  type Database,
  type HandinRow,
  type HandinVersionLine,
  type MatterActor,
  type ProposalRow,
  type ProposalWord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AgentAuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { runSaleClaims } from "./sale-claims.ts";
import { SALE_RULE } from "./sale-rule.ts";
import { matchSightings, runHubChecks, settleGoneShifts, startHubCheck, syncCheckMatters, syncLateMarks } from "./shift-handin-check.ts";
import { boardOn, hubPending, oldWayGives, phaseOf, signableOf } from "./shift-report-board-view.ts";
import {
  accessOf,
  afterPersonVersion,
  draftFacts,
  draftLines,
  handinActorOf,
  handinFor,
  ledgerDayPaid,
  linesPageSums,
  offPlatformOfRows,
  pageCatalog,
  readShiftReport,
  readSubject,
  reportDateOf,
  ruleWordsOfLine,
  subjectOf,
  writableSubject,
  writer,
  SHIFT_REPORT_MISSING_KIND,
  type HandinActor,
  type HandinPersonActor,
  type PageCatalog,
  type Subject,
} from "./shift-handins.ts";
import { checkLetsConfirm, holdsSale, lineWithProposal, lineWithWord, mayAct, proposalDelta, type BoardAction } from "./shift-report-phases.ts";
import { requireShiftOfRealm, testUserIds } from "./sandbox/realm.ts";

/**
 * The «Отчёт» board's operations (products plan 2026-11-13, package R), one service behind every door: the person's
 * session and the extension's device token (the board in a tab and in the extension's frame), an agent key «со слов»
 * (a hand-in recorded as a candidate, never a confirmation) and Gengar's check (`review:shift_reports`). The phases
 * and who may do what are shift-report-phases.ts; the board as it is read, shift-report-board-view.ts.
 *
 * «Сдать смену» records a CANDIDATE (the draft as it is at `cutoff_at`) and makes no version; «Подтверждаю» makes the
 * version from the named candidate with Gengar's proposals that are not declined, under `lockSaleSettlements`. The
 * ledger's feed keeps serving versions only. Nothing here sends anything to anyone.
 */

type BoardApp = Pick<AppContext, "db" | "config" | "logger">;
const SYSTEM: MatterActor = { door: "system" };
const DAY_MS = 86_400_000;

export const SHIFT_REPORT_CONFIRM_KIND = "shift.report.confirm";
export const SHIFT_REPORT_LATE_PROPOSALS_KIND = "shift.report.late_proposals";

const boardLink = (shiftId: number) => `/workboard/report/${shiftId}`;

interface Board {
  subject: Subject;
  catalog: PageCatalog;
  handin: HandinRow | null;
  phase: ShiftReportPhase;
}

/**
 * A change the phase does not take now (ticks and «чья» in «Проверка», «Подтвердите», «Учтён»): the route answers 409
 * with the fresh board; «Исправить» is the way back to editing.
 */
export class PhaseConflictError extends ConflictError {
  constructor(readonly shiftId: number, phase: ShiftReportPhase) {
    super(`Not now: the report is in «${phase}»; «Исправить» first`, { reason: "phase" });
  }
}

/** The report the actor acts on, with its phase; the action must be the actor's in that phase. */
async function boardFor(app: BoardApp, actor: HandinActor, shiftId: number, action: BoardAction): Promise<Board> {
  const { subject, catalog } = await writableSubject(app, actor, shiftId);
  if (!boardOn(subject)) throw new ForbiddenError("This shift is handed in the old way: the right came after it began");
  const handin = await findHandinByShift(app.db, subject.shift.id);
  const phase = phaseOf(handin);
  const access = accessOf(actor, subject, catalog).access;
  if (!mayAct({ access, kind: actor.kind, enabled: subject.enabled }, action, phase)) {
    throw new PhaseConflictError(subject.shift.id, phase);
  }
  return { subject, catalog, handin, phase };
}

// ── «Сдать смену»: a candidate ───────────────────────────────────────────────

/**
 * «Сдать смену» / «Сдать заново»: the draft as it is now becomes the report's next CANDIDATE — not a version; a shift
 * still going may be handed in (sales after `cutoff_at` are «после сдачи»). The check starts (Hub's pages, Gengar);
 * when nothing checks it, the person confirms at once. The agent's «со слов» hand-in records a candidate too and the
 * person still confirms on the board.
 */
export async function handInShiftReport(app: BoardApp, actor: HandinActor, input: { shiftId: number }, now: Date = new Date()): Promise<ShiftReportResponse> {
  if (actor.kind === "agent" && actor.sourceRef === null) throw new BadRequestError("A report is handed in «со слов» only with the message", { reason: "source_ref_required" });
  const { subject, catalog } = await boardFor(app, actor, input.shiftId, "handIn");
  const who = writer(actor);
  const pageIds = subject.shift.pages.map((page) => catalog.idOf.get(page.pageLabel)).filter((id): id is number => id !== undefined);
  const reviewed = await hasShiftReportReviewer(app.db, pageIds);
  // Hub's own check of each page (shift-handin-check.ts): its first states, and the wallet reads asked after the commit.
  const check = await startHubCheck(app.db, { subject, catalog });
  const hubWaits = check.pages.some((page) => page.state === "running" || page.state === "statement");

  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockSaleSettlements(db);
    const handin = await handinFor(db, subject);
    const marks = await listHandinMarks(db, handin.id);
    const facts = await draftFacts(db, subject, handin, catalog, now, marks);
    const lines = draftLines(facts, marks);
    const offPlatform = offPlatformOfRows(await listOffPlatform(db, handin.id), catalog.labelOf);
    const sums = linesPageSums(lines, facts.pages, offPlatform);
    const hubCheck: CandidateHubPage[] = check.pages;
    const made = await insertCandidateWithin(db, {
      handinId: handin.id, door: who.door, actorUserId: who.byUserId, agentKeyId: who.byAgentKeyId,
      telegramMessageRef: actor.kind === "agent" ? actor.sourceRef : null, telegramSenderId: actor.kind === "agent" ? actor.telegramUserId : null,
      cutoffAt: now, totalMills: sums.totalMills, pages: sums.pages, lines, offPlatform, comment: handin.comment, ruleVersion: SALE_RULE.version,
      hubCheck, at: now,
    });
    const next = checkLetsConfirm({ handedInAt: now, now, hubPending: hubWaits, gengarPending: reviewed }) ? "confirm" : "checking";
    await setHandinPhase(db, { handinId: handin.id, phase: next, at: now });
    await insertHandinEvent(db, {
      handinId: handin.id, event: "shift_report.handed_in", door: who.door, actorUserId: who.byUserId, agentKeyId: who.byAgentKeyId,
      onBehalfOfUserId: actor.kind === "agent" ? subject.shift.userId : null,
      changes: { candidate: made.number, lines: lines.length, ...(actor.kind === "agent" ? { sourceRef: actor.sourceRef, telegramUserId: actor.telegramUserId } : {}) },
      at: now,
    });
  });
  await check.ask().catch((error: unknown) => warn(app, error, "asking the wallets' read after a hand-in"));
  await closeMatter(app.db, { key: `${SHIFT_REPORT_MISSING_KIND}:${subject.shift.id}`, how: "resolved", writer: "server" }, SYSTEM, now).catch(() => undefined);
  await syncBoardMatters(app, now).catch((error: unknown) => warn(app, error, "the board's matters after a hand-in"));
  return readSubject(app, actor, subject, now);
}

const insertCandidateWithin = (db: Database, input: Parameters<typeof insertHandinCandidate>[1]): Promise<CandidateRow> => insertHandinCandidate(db, input);

// ── «Подтверждаю»: a version ─────────────────────────────────────────────────

/**
 * «Подтверждаю»: the named candidate, with Gengar's proposals the person did not decline, becomes the report's next
 * version, under the settlements' lock. A candidate superseded since (a correction, a re-check that found more sales)
 * is refused with the fresh board and nothing is made. Only the person: no agent door reaches here.
 */
export async function confirmShiftReport(
  app: BoardApp,
  actor: HandinPersonActor,
  input: { shiftId: number; candidateId: number; seenTotalMills?: number | undefined; seenCount?: number | undefined },
  options: { now?: Date; dayPaid?: (input: { personCode: string | null; reportDate: string }) => Promise<boolean | null> } = {},
): Promise<ShiftReportConfirmResponse> {
  const now = options.now ?? new Date();
  let board: Board;
  try {
    board = await boardFor(app, actor, input.shiftId, "confirm");
  } catch (error) {
    // Not in «Подтвердите» (checked again, corrected, counted already): the fresh board, nothing made.
    if (error instanceof ConflictError) return { confirmed: false, refused: "not_ready", report: await readShiftReport(app, actor, input.shiftId, now) };
    throw error;
  }
  const { subject, catalog, handin } = board;
  if (handin === null) return { confirmed: false, refused: "not_ready", report: await readShiftReport(app, actor, input.shiftId, now) };
  const paidDay = reportDateOf(subject.shift, handin);
  const dayPaid = await (options.dayPaid ?? ((one) => ledgerDayPaid(app, one)))({ personCode: subject.person?.code ?? null, reportDate: paidDay });
  const outcome = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockSaleSettlements(db);
    const locked = await findHandinByShift(db, subject.shift.id, { lock: true });
    const candidate = await findHandinCandidate(db, input.candidateId, { lock: true });
    if (locked === null || candidate === null || candidate.handinId !== locked.id) throw new NotFoundError("No such candidate of this report");
    if (candidate.supersededAt !== null || candidate.confirmedAt !== null) return { done: "superseded" as const };
    if (phaseOf(locked) !== "confirm") return { done: "not_ready" as const };
    // What is signed is what the board shows in «Подтвердите» (`signableOf`, the one computation of both), read here in
    // the turn: settlements since the hand-in, the person's comments now, the cards kept, «мимо площадки» confirmed.
    const { lines, offPlatform, sums, count, proposals, applied, oldWay } = await signableOf(db, { subject, catalog, handin: locked, candidate });
    // «Подтверждаю» signs what the person saw: a colleague's answer or a decision since the board was drawn changes it,
    // and then nothing is made — the fresh board says «Было …, стало …» and the person presses again.
    if ((input.seenTotalMills !== undefined && input.seenTotalMills !== sums.totalMills) || (input.seenCount !== undefined && input.seenCount !== count)) {
      return { done: "changed" as const };
    }
    const made = await insertHandinVersion(db, {
      handin: locked, door: actor.door, actorUserId: actor.userId, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null,
      totalMills: sums.totalMills, pages: sums.pages, lines, offPlatform, comment: candidate.comment, dayPaid, ruleVersion: candidate.ruleVersion,
      reportDate: subject.shift.reportDate, at: now,
    });
    await setCandidateConfirmed(db, { candidateId: candidate.id, version: made.version, at: now });
    // Every card the person kept is their own word from now on, written as their mark in this transaction (R-board §2, §4):
    // «Исправить» and «Досдать» start from the words the counted version has, and «в общак» opens the owner's matter.
    await writeAcceptedWords(db, { handinId: locked.id, lines, proposals: applied, oldWay, claimantUserId: subject.shift.userId, byUserId: actor.userId, at: now });
    for (const proposal of proposals) {
      if (proposal.state === "proposed") await setHandinProposalState(db, { id: proposal.id, state: "accepted", byUserId: actor.userId, at: now });
    }
    await setHandinPhase(db, { handinId: locked.id, phase: "counted", at: now });
    await insertHandinEvent(db, {
      handinId: locked.id, event: "shift_report.submitted", door: actor.door, actorUserId: actor.userId, agentKeyId: null, onBehalfOfUserId: null,
      changes: { version: made.version, candidate: candidate.number, lines: lines.length, proposals: proposals.filter((one) => one.state === "proposed").length },
      at: now,
    });
    return { done: "confirmed" as const, made, pages: sums.pages.map((page) => page.pageLabel) };
  });
  if (outcome.done === "confirmed") {
    await syncBoardMatters(app, now).catch((error: unknown) => warn(app, error, "the board's matters after a confirmation"));
    // A kept «в общак» reaches the owner within the minute, not at the next pass.
    await syncCheckMatters(app, now).catch((error: unknown) => warn(app, error, "the check's matters after a confirmation"));
    await afterPersonVersion(app, { subject, catalog, version: outcome.made, pages: outcome.pages, paidDay, dayPaid }, now);
  }
  const report = await readSubject(app, actor, subject, now);
  return { confirmed: outcome.done === "confirmed", refused: outcome.done === "confirmed" ? null : outcome.done, report };
}

/**
 * The cards the person kept, written as their own marks (who: the person; which card: `by_proposal_id`): the word, the
 * colleague of «пополам» and «отдать», and the note — Gengar's comment the person kept becomes theirs. A gift to a
 * colleague without the board is the person's «не моё» and a question to the decider (no_side), as their own would be.
 */
async function writeAcceptedWords(
  db: Database,
  input: {
    handinId: number;
    lines: readonly HandinVersionLine[];
    proposals: readonly ProposalRow[];
    oldWay: ReadonlyMap<number, number>;
    claimantUserId: number;
    byUserId: number;
    at: Date;
  },
): Promise<void> {
  const marks = await listHandinMarks(db, input.handinId);
  for (const proposal of input.proposals) {
    const line = input.lines.find((one) => one.transactionId === proposal.transactionId);
    if (line === undefined) continue;
    const mark = marks.find((one) => one.transactionId === proposal.transactionId);
    const note = line.note ?? mark?.note ?? null;
    if (proposal.kind === "note" && note === (mark?.note ?? null) && mark !== undefined) continue;
    await setHandinMark(db, {
      handinId: input.handinId, transactionId: proposal.transactionId,
      statement: proposal.kind === "note" ? mark?.statement ?? null : line.statement,
      shareWithUserId: proposal.kind === "note" ? mark?.shareWithUserId ?? null : line.shareWithUserId,
      toUserId: proposal.kind === "note" ? mark?.toUserId ?? null : line.toUserId ?? null,
      note, byUserId: input.byUserId, byAgentKeyId: null, byProposalId: proposal.id, at: input.at,
    });
    const colleague = input.oldWay.get(proposal.transactionId);
    if (colleague === undefined) continue;
    const known = (await listSaleClaims(db, { transactionIds: [proposal.transactionId] }))
      .find((claim) => claim.claimantHandinId === input.handinId && claim.sideUserId === colleague);
    const fields = {
      pageId: null, kind: "claim" as const, claimantVersion: null, statement: null, shareWithUserId: null, claimantNote: proposal.why,
      claimedAt: input.at, sideShiftId: null, state: "owner" as const, escalatedAt: input.at, escalatedWhy: "no_side" as const,
    };
    if (known === undefined) {
      await insertSaleClaim(db, { ...fields, transactionId: proposal.transactionId, claimantUserId: input.claimantUserId, claimantHandinId: input.handinId, sideUserId: colleague, origin: "draft" }, input.at);
    } else if (known.state === "withdrawn") {
      await reopenSaleClaim(db, known.id, fields, input.at);
    }
  }
}

// ── «Исправить», «Отмена», «Досдать» ─────────────────────────────────────────

/** «Исправить»: back to editing; a counted version stands until a new one is confirmed. */
export async function reopenShiftReport(app: BoardApp, actor: HandinPersonActor, input: { shiftId: number }, now: Date = new Date()): Promise<ShiftReportResponse> {
  const { subject, handin, phase } = await boardFor(app, actor, input.shiftId, "reopen");
  if (handin === null) throw new NotFoundError("Nothing handed in yet");
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (await setHandinPhase(db, { handinId: handin.id, phase: "fixing", at: now, from: [phase === "counted" && handin.phase === "draft" ? "draft" : phase] })) {
      // «Отмена» returns where «Исправить» came from.
      await setHandinFixingFrom(db, { handinId: handin.id, from: phase === "confirm" ? "confirm" : "counted" });
    }
  });
  await syncBoardMatters(app, now).catch((error: unknown) => warn(app, error, "the board's matters after «Исправить»"));
  return readSubject(app, actor, subject, now);
}

/**
 * «Отмена» of «Правка»: back to the phase «Исправить» came from — the counted report as it was (only when a counted
 * version exists: the words go back to its), or «Подтвердите» with the same candidate when it is still the newest (the
 * words go back to the candidate's) — else to the draft.
 */
export async function cancelShiftReportFix(app: BoardApp, actor: HandinPersonActor, input: { shiftId: number }, now: Date = new Date()): Promise<ShiftReportResponse> {
  const { subject, handin } = await boardFor(app, actor, input.shiftId, "cancel");
  if (handin === null) throw new NotFoundError("Nothing handed in yet");
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const locked = (await findHandinByShift(db, subject.shift.id, { lock: true }))!;
    const latest = (await listHandinVersions(db, locked.id)).at(-1) ?? null;
    const candidate = (await listHandinCandidates(db, locked.id)).at(-1) ?? null;
    const back: "counted" | "confirm" | "draft" = locked.fixingFrom === "confirm" && candidate !== null && candidate.supersededAt === null && candidate.confirmedAt === null
      ? "confirm"
      : latest !== null ? "counted" : "draft";
    const source = back === "counted" ? latest!.lines : back === "confirm" ? candidate!.lines : null;
    if (source !== null) {
      const held = new Map(source.flatMap((line) => (line.transactionId === null ? [] : [[line.transactionId, line] as const])));
      for (const mark of await listHandinMarks(db, locked.id)) {
        const line = held.get(mark.transactionId);
        const statement = line?.statement ?? null;
        const note = line?.noteByAgent === true ? null : line?.note ?? null;
        if (mark.statement === statement && mark.note === note) continue;
        await setHandinMark(db, {
          handinId: locked.id, transactionId: mark.transactionId, statement, shareWithUserId: statement === "share" ? line?.shareWithUserId ?? null : null,
          toUserId: statement === "give" ? line?.toUserId ?? null : null, note, byUserId: actor.userId, byAgentKeyId: null, at: now,
        });
      }
    }
    await setHandinPhase(db, { handinId: locked.id, phase: back, at: now, from: ["fixing"] });
    await setHandinFixingFrom(db, { handinId: locked.id, from: null });
  });
  return readSubject(app, actor, subject, now);
}

/** «Скопировать пост»: remember it, so a later version that changes a page sum says «Пост изменился» and opens a matter. */
export async function markShiftReportPostCopied(app: BoardApp, actor: HandinPersonActor, input: { shiftId: number; model?: string | null }, now: Date = new Date()): Promise<ShiftReportResponse> {
  const { subject } = await writableSubject(app, actor, input.shiftId);
  const handin = await findHandinByShift(app.db, subject.shift.id);
  if (handin === null || handin.currentVersion === null) throw new NotFoundError("Nothing counted yet");
  // Each model's post is copied by its own button: the copy of the one named. A client before that copies them all.
  const models = (await readSubject(app, actor, subject, now)).posts.map((post) => post.modelSlug);
  if (input.model != null && !models.includes(input.model)) throw new BadRequestError("No post of this model in the report", { reason: "model_not_in_post" });
  await setHandinPostCopied(app.db, { handinId: handin.id, version: handin.currentVersion, at: now, modelSlugs: input.model == null ? models : [input.model] });
  await syncCheckMatters(app, now).catch((error: unknown) => warn(app, error, "the post's matter after a copy"));
  return readSubject(app, actor, subject, now);
}

/**
 * «Досдать»: sales that came after the hand-in and are the person's by the rule, unambiguously — no word of theirs on
 * it, no question or dispute open — go into the next version at once (the rule gave them, nothing to check). Any other
 * sale goes the ordinary way («Исправить», a question, the check): 400 `not_plain`.
 */
export async function resendShiftReport(
  app: BoardApp,
  actor: HandinPersonActor,
  input: { shiftId: number; transactionIds: readonly number[] },
  options: { now?: Date; dayPaid?: (input: { personCode: string | null; reportDate: string }) => Promise<boolean | null> } = {},
): Promise<ShiftReportResponse> {
  const now = options.now ?? new Date();
  const { subject, catalog, handin } = await boardFor(app, actor, input.shiftId, "resend");
  if (handin === null) throw new NotFoundError("Nothing handed in yet");
  const paidDay = reportDateOf(subject.shift, handin);
  const dayPaid = await (options.dayPaid ?? ((one) => ledgerDayPaid(app, one)))({ personCode: subject.person?.code ?? null, reportDate: paidDay });
  const made = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockSaleSettlements(db);
    const locked = (await findHandinByShift(db, subject.shift.id, { lock: true }))!;
    const latest = (await listHandinVersions(db, locked.id)).at(-1);
    if (latest === undefined) throw new NotFoundError("Nothing counted yet");
    const marks = await listHandinMarks(db, locked.id);
    const draft = draftLines(await draftFacts(db, subject, locked, catalog, now, marks), marks);
    // Held: a line of the counted version that counts the sale or says something of it (a word of the person's, even
    // «не моё», keeps it theirs to change by «Исправить»). A $0 line with nothing on it holds nothing (`holdsSale`): the
    // sale the rule gave the person since is taken here, in its place.
    const held = new Set(latest.lines.filter(holdsSale).flatMap((line) => (line.transactionId === null ? [] : [line.transactionId])));
    const open = await listSaleClaims(db, { transactionIds: [...input.transactionIds], states: ["asked", "owner"] });
    const take: HandinVersionLine[] = [];
    for (const id of new Set(input.transactionIds)) {
      const line = draft.find((one) => one.transactionId === id);
      const plain = line !== undefined && line.group === "mine" && line.statement === null && !line.disputed && line.amountMills > 0
        && line.rule.shareMills > 0 && !held.has(id)
        && !open.some((claim) => claim.transactionId === id);
      if (!plain) throw new BadRequestError("This sale goes the ordinary way: «Исправить»", { reason: "not_plain" });
      take.push(line);
    }
    const lines = [...latest.lines.filter((line) => !take.some((one) => one.transactionId === line.transactionId)), ...take];
    const sums = linesPageSums(lines, latest.pages.map((page) => page.pageLabel), latest.offPlatform);
    const version = await insertHandinVersion(db, {
      handin: locked, door: actor.door, actorUserId: actor.userId, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null,
      totalMills: sums.totalMills, pages: sums.pages, lines, offPlatform: latest.offPlatform, comment: latest.comment, dayPaid, ruleVersion: SALE_RULE.version,
      reportDate: subject.shift.reportDate, at: now,
    });
    await setHandinPhase(db, { handinId: locked.id, phase: "counted", at: now });
    return { version, pages: sums.pages.map((page) => page.pageLabel) };
  });
  await afterPersonVersion(app, { subject, catalog, version: made.version, pages: made.pages, paidDay, dayPaid }, now);
  return readSubject(app, actor, subject, now);
}

// ── Questions from the draft ─────────────────────────────────────────────────

/**
 * «Почему продажа ваша?» → «Спросить Олега» / «Спросить владельца»: the person's word («моя», «пополам с») is written
 * on the line — it then counts in nobody's sum, disputed — and the claim is born now, from the draft (origin `draft`):
 * the colleague the rule gives it to answers on their board or in «Ждут вас» (whether or not they hand shifts in in
 * Hub); a pot's sale, or one with nobody to ask, is the decider's at once.
 */
export async function askShiftReport(app: BoardApp, actor: HandinPersonActor, input: { shiftId: number; body: ShiftReportAskBody }, now: Date = new Date()): Promise<ShiftReportResponse> {
  const { subject, catalog } = await boardFor(app, actor, input.shiftId, "ask");
  const note = input.body.note.trim();
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockSaleSettlements(db);
    const handin = await handinFor(db, subject);
    const marks = await listHandinMarks(db, handin.id);
    const facts = await draftFacts(db, subject, handin, catalog, now, marks);
    const one = facts.classified.find((sale) => sale.sale.transactionId === input.body.transactionId);
    if (one === undefined || one.group !== "near") throw new BadRequestError("Only a sale the rule gives someone else is asked about", { reason: "not_asked" });
    // The other side: the sale's holder by the rule; of a sale that waits for its PPV's sender, that colleague.
    const side = one.toUserId ?? (one.sale.home.kind === "waiting" ? facts.senders.get(one.sale.transactionId) ?? null : null);
    // A colleague without the board (they hand shifts in the old way) is not asked: the decider decides, no silence runs.
    const sidePerson = side === null ? null : await findHandinPersonOfUser(db, side);
    const sideOnBoard = sidePerson?.submitsShiftSince != null && sidePerson.state !== "left";
    if (input.body.statement === "share" && (side === null || input.body.shareWithUserId !== side)) {
      throw new BadRequestError("«Пополам» is asked of the sale's holder", { reason: "share_with_holder" });
    }
    await setHandinMark(db, {
      handinId: handin.id, transactionId: input.body.transactionId, statement: input.body.statement,
      shareWithUserId: input.body.statement === "share" ? side : null, note, byUserId: actor.userId, byAgentKeyId: null, at: now,
    });
    const pageId = catalog.idOf.get(one.sale.pageLabel) ?? null;
    const askable = side !== null && one.sale.home.kind !== "pot" && sideOnBoard;
    const fields = {
      pageId, kind: "claim" as const, claimantVersion: null, statement: input.body.statement, shareWithUserId: input.body.statement === "share" ? side : null,
      claimantNote: note, claimedAt: now, sideShiftId: null,
      state: askable ? "asked" as const : "owner" as const, escalatedAt: askable ? null : now, escalatedWhy: askable ? null : "no_side" as const,
    };
    const existing = (await listSaleClaims(db, { transactionIds: [input.body.transactionId] }))
      .find((claim) => claim.claimantHandinId === handin.id && (claim.sideUserId ?? 0) === (side ?? 0));
    // Settled — agreed (by an answer or a day of silence) or decided: its terms made the reports' versions; a new word
    // here would change one side's share and not the other's. The sale's terms change only by the decider now.
    const changes = existing !== undefined && (existing.statement !== fields.statement || (existing.shareWithUserId ?? null) !== fields.shareWithUserId);
    if (existing !== undefined && changes && (existing.state === "agreed" || existing.state === "decided")) {
      throw new ConflictError("This sale is already settled: only the decider changes it now", { reason: "claim_settled" });
    }
    if (existing !== undefined) {
      if (existing.state === "withdrawn") await reopenSaleClaim(db, existing.id, fields, now);
      else await updateSaleClaim(db, existing.id, { claimantNote: note, statement: fields.statement, shareWithUserId: fields.shareWithUserId }, now);
    } else {
      await insertSaleClaim(db, {
        ...fields, transactionId: input.body.transactionId, claimantUserId: subject.shift.userId, claimantHandinId: handin.id,
        sideUserId: side, origin: "draft",
      }, now);
    }
  });
  await runSaleClaims(app, now).catch((error: unknown) => warn(app, error, "the claims pass after a question"));
  return readSubject(app, actor, subject, now);
}

/** «Отменить»: the question is withdrawn and the line is back to the rule's word. */
export async function withdrawShiftReportAsk(app: BoardApp, actor: HandinPersonActor, input: { shiftId: number; transactionId: number }, now: Date = new Date()): Promise<ShiftReportResponse> {
  const { subject } = await boardFor(app, actor, input.shiftId, "ask");
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockSaleSettlements(db);
    const handin = await handinFor(db, subject);
    const open = (await listSaleClaims(db, { transactionIds: [input.transactionId], states: ["asked", "owner"] }))
      .filter((claim) => claim.claimantHandinId === handin.id);
    if (open.length === 0) throw new NotFoundError("No question open on this sale");
    for (const claim of open) await updateSaleClaim(db, claim.id, { state: "withdrawn", closedAt: now }, now, { ifState: claim.state });
    const mark = (await listHandinMarks(db, handin.id)).find((one) => one.transactionId === input.transactionId);
    await setHandinMark(db, {
      handinId: handin.id, transactionId: input.transactionId, statement: null, shareWithUserId: null, note: mark?.note ?? null,
      byUserId: actor.userId, byAgentKeyId: null, at: now,
    });
  });
  await runSaleClaims(app, now).catch((error: unknown) => warn(app, error, "the claims pass after «Отменить»"));
  return readSubject(app, actor, subject, now);
}

// ── Gengar's cards ───────────────────────────────────────────────────────────

/**
 * A card of Gengar: «Не согласен» (declined: the row stays as the person had it, the decider gets «Несогласие с
 * Генгаром»), «Вернуть правку» (back to proposed), «Принять» a late one (after the report was counted: opens «Правка»
 * with it applied as the person's own word — they accepted it; nothing changes by itself).
 */
export async function answerShiftReportProposal(
  app: BoardApp,
  actor: HandinPersonActor,
  input: { shiftId: number; proposalId: number; answer: "decline" | "restore" | "accept" },
  now: Date = new Date(),
): Promise<ShiftReportResponse> {
  const { subject, handin, phase } = await boardFor(app, actor, input.shiftId, "answerProposal");
  if (handin === null) throw new NotFoundError("No such card");
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await lockSaleSettlements(db);
    const proposal = await findHandinProposal(db, input.proposalId, { lock: true });
    if (proposal === null || proposal.handinId !== handin.id) throw new NotFoundError("No such card");
    if (input.answer === "accept") {
      if (proposal.state !== "late") throw new ConflictError("Only a card that came after the report was counted is accepted", { reason: "not_late" });
      const latest = (await listHandinVersions(db, handin.id)).at(-1);
      const line = latest?.lines.find((one) => one.transactionId === proposal.transactionId);
      if (line !== undefined) {
        const oldWay = await oldWayGives(db, [proposal]);
        const applied = oldWay.size > 0 ? lineWithWord(line, { statement: "not_mine" }) : lineWithProposal(line, proposal);
        await writeAcceptedWords(db, { handinId: handin.id, lines: [applied], proposals: [proposal], oldWay, claimantUserId: subject.shift.userId, byUserId: actor.userId, at: now });
      }
      await setHandinProposalState(db, { id: proposal.id, state: "accepted", byUserId: actor.userId, at: now });
      await setHandinPhase(db, { handinId: handin.id, phase: "fixing", at: now });
      return;
    }
    if (input.answer === "decline") {
      if (proposal.state !== "proposed" && proposal.state !== "late") throw new ConflictError("This card is answered", { reason: "answered" });
      await setHandinProposalState(db, { id: proposal.id, state: "declined", byUserId: actor.userId, at: now });
      return;
    }
    if (proposal.state !== "declined" || proposal.afterCounted || phase !== "confirm") throw new ConflictError("Nothing to bring back", { reason: "not_declined" });
    await setHandinProposalState(db, { id: proposal.id, state: "proposed", byUserId: null, at: now });
  });
  await syncBoardMatters(app, now).catch((error: unknown) => warn(app, error, "the board's matters after a card"));
  return readSubject(app, actor, subject, now);
}

// ── «Нет в Hub» ──────────────────────────────────────────────────────────────

/** «Добавить» a «нет в Hub» row: it counts on the board; a version takes it once Hub holds the sale. */
export async function addShiftReportSighting(app: BoardApp, actor: HandinPersonActor, input: { shiftId: number; sightingId: number }, now: Date = new Date()): Promise<ShiftReportResponse> {
  const { subject, catalog } = await boardFor(app, actor, input.shiftId, "edit");
  const sighting = await findSaleSighting(app.db, input.sightingId);
  const label = sighting === null ? undefined : catalog.labelOf.get(sighting.pageId);
  const at = sighting?.occurredAt.getTime() ?? 0;
  const inWindow = sighting !== null && at >= subject.shift.startedAt.getTime() && (subject.shift.state === "going" || at <= subject.shift.endedAt.getTime());
  if (sighting === null || label === undefined || !subject.shift.pages.some((page) => page.pageLabel === label) || !inWindow) {
    throw new NotFoundError("No such «нет в Hub» row on this shift");
  }
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const handin = await handinFor(db, subject);
    if (!(await setSaleSightingAdded(db, { id: sighting.id, handinId: handin.id, byUserId: actor.userId, at: now }))) {
      throw new ConflictError("Already added, or Hub holds the sale now", { reason: "taken" });
    }
  });
  return readSubject(app, actor, subject, now);
}

// ── Gengar's check (review:shift_reports) ────────────────────────────────────

/** `agentShiftReportChecks`: candidates handed in and waiting for Gengar's answer, every page of the shift in the key's grant. */
export async function readShiftReportChecks(app: BoardApp, input: { pageIds: readonly number[]; limit: number; realm?: "live" | "test" }, now: Date = new Date()): Promise<AgentShiftReportChecksResponse> {
  const granted = new Set(input.pageIds);
  // The key's realm (sandbox/realm.ts): a live key never sees a test candidate, the test team's checker only those.
  const testLogins = await testUserIds(app);
  const catalog = await pageCatalog(app.db);
  const waiting = await listCandidatesAwaitingCheck(app.db, { since: new Date(now.getTime() - 2 * DAY_MS), limit: 200 });
  const checks: AgentShiftReportChecksResponse["checks"] = [];
  for (const one of waiting) {
    if (checks.length >= input.limit) break;
    const subject = await subjectOf(app.db, one.shiftId).catch(() => null);
    if (subject === null) continue;
    if (testLogins.has(subject.shift.userId) !== (input.realm === "test")) continue;
    const labels = subject.shift.pages.map((page) => page.pageLabel);
    if (!labels.every((label) => granted.has(catalog.idOf.get(label) ?? -1))) continue;
    const ids = one.lines.flatMap((line) => (line.transactionId === null ? [] : [line.transactionId]));
    const fans = await listHandinSaleFans(app.db, ids);
    const nameIds = one.lines.flatMap((line) => [line.rule.toUserId, line.rule.senderUserId, line.shareWithUserId]).filter((id): id is number => id !== null);
    const names = await listHandinNames(app.db, [subject.shift.userId, ...nameIds]);
    const pageIds = labels.map((label) => catalog.idOf.get(label)).filter((id): id is number => id !== undefined);
    checks.push({
      candidateId: one.id,
      shiftId: subject.shift.id,
      person: subject.person?.code ?? null,
      userId: subject.shift.userId,
      personName: subject.person?.displayName ?? names.get(subject.shift.userId) ?? "",
      startedAt: subject.shift.startedAt.toISOString(),
      endedAt: subject.shift.endedAt.toISOString(),
      cutoffAt: one.cutoffAt.toISOString(),
      handedInAt: one.madeAt.toISOString(),
      pages: labels,
      lines: one.lines.flatMap((line) => (line.transactionId === null || line.pageLabel === null ? [] : [{
        transactionId: line.transactionId,
        pageLabel: line.pageLabel,
        kind: line.kind,
        occurredAt: line.occurredAt ?? new Date(0).toISOString(),
        netMills: line.netMills,
        fan: fans.get(line.transactionId) ?? { fanRef: null, name: null, username: null },
        statement: line.statement,
        withUserId: line.statement === "share" ? line.shareWithUserId : line.statement === "give" ? line.toUserId ?? null : null,
        note: line.note,
        amountMills: line.amountMills,
        ruleWords: ruleWordsOfLine(line, names),
      }])),
      comment: one.comment,
      colleagues: await listHandinColleagues(app.db, { pageIds, exceptUserIds: subject.userIds }),
    });
  }
  // The reports standing in «Подтвердите»: the same wall — the key's realm, every page of the shift in its grant.
  const awaitingConfirm: AgentShiftReportChecksResponse["awaitingConfirm"] = [];
  for (const one of await listConfirmHandins(app.db)) {
    const subject = await subjectOf(app.db, one.shiftId).catch(() => null);
    if (subject === null) continue;
    if (testLogins.has(subject.shift.userId) !== (input.realm === "test")) continue;
    const labels = subject.shift.pages.map((page) => page.pageLabel);
    if (!labels.every((label) => granted.has(catalog.idOf.get(label) ?? -1))) continue;
    const candidate = (await listHandinCandidates(app.db, one.handinId)).filter((row) => row.supersededAt === null && row.confirmedAt === null).at(-1);
    if (candidate === undefined) continue;
    const names = await listHandinNames(app.db, [subject.shift.userId]);
    awaitingConfirm.push({
      shiftId: subject.shift.id,
      candidateId: candidate.id,
      person: subject.person?.code ?? null,
      personName: subject.person?.displayName ?? names.get(subject.shift.userId) ?? "",
      pages: labels,
      startedAt: subject.shift.startedAt.toISOString(),
      // Entered «Подтвердите» for this candidate: the phase's moment, or the candidate's own hand-in when it was re-made later.
      confirmSince: new Date(Math.max(one.phaseAt.getTime(), candidate.madeAt.getTime())).toISOString(),
    });
  }
  return { checks, awaitingConfirm, serverNow: now.toISOString() };
}

/**
 * `agentShiftReportCheckAnswer`: Gengar's answer to one candidate — «замечаний нет» (no proposal) or proposals, each a
 * sale of the candidate and a legal word. Never a confirmation. After the report is counted the proposals are late: a
 * matter for the person, cards on the counted board, nothing changed by themselves.
 */
export async function answerShiftReportCheck(
  app: BoardApp,
  principal: AgentAuthPrincipal,
  input: { candidateId: number; pageIds: readonly number[]; body: AgentShiftReportCheckBody },
  now: Date = new Date(),
) {
  const candidate = await findHandinCandidate(app.db, input.candidateId);
  if (candidate === null) throw new NotFoundError("Not found");
  const handin = await findHandinById(app.db, candidate.handinId);
  if (handin === null) throw new NotFoundError("Not found");
  const subject = await subjectOf(app.db, handin.shiftId);
  // The wall (sandbox/realm.ts): a candidate of the other realm is not found.
  await requireShiftOfRealm(app, principal, handin.shiftId);
  const catalog = await pageCatalog(app.db);
  const granted = new Set(input.pageIds);
  const pageIds = subject.shift.pages.map((page) => catalog.idOf.get(page.pageLabel) ?? -1);
  if (!pageIds.every((id) => granted.has(id))) throw new NotFoundError("Not found");
  if (candidate.supersededAt !== null) return { candidateId: candidate.id, recorded: 0, late: false, superseded: true, serverNow: now.toISOString() };
  const colleagues = new Set((await listHandinColleagues(app.db, { pageIds, exceptUserIds: subject.userIds })).map((one) => one.userId));
  const lineOf = new Map(candidate.lines.flatMap((line) => (line.transactionId === null ? [] : [[line.transactionId, line] as const])));
  // Validate every proposal before writing any.
  const planned = input.body.proposals.map((proposal) => {
    const line = lineOf.get(proposal.transactionId);
    if (line === undefined) throw new BadRequestError("A proposal names a sale of the candidate", { reason: "not_in_candidate" });
    if (proposal.kind === "note") {
      if (proposal.note === undefined) throw new BadRequestError("A note proposal carries the note", { reason: "note_required" });
      return { line, kind: "note" as const, toWord: null, toUserId: null, note: proposal.note.trim(), proposal };
    }
    const to = proposal.to;
    if (to === undefined) throw new BadRequestError("An owner change says the word", { reason: "word_required" });
    const userId = to.userId ?? null;
    if ((to.word === "share" || to.word === "give") && (userId === null || !colleagues.has(userId))) {
      throw new BadRequestError("«Пополам» and «отдал» name a colleague of the shift's pages", { reason: "colleague_unknown" });
    }
    if (to.word === "give" || to.word === "pot") {
      if (line.group !== "mine") throw new BadRequestError("Only one's own sale is given away", { reason: "word_not_allowed" });
    }
    return { line, kind: "owner_change" as const, toWord: to.word as ProposalWord, toUserId: to.word === "share" || to.word === "give" ? userId : null, note: null, proposal };
  });
  let late = false;
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const locked = (await findHandinByShift(db, subject.shift.id, { lock: true }))!;
    late = candidate.confirmedAt !== null || phaseOf(locked) === "counted";
    if (!(await setCandidateGengarAnswer(db, { candidateId: candidate.id, clean: planned.length === 0, at: now }))) {
      throw new ConflictError("This candidate is already answered", { reason: "answered" });
    }
    for (const one of planned) {
      const fromWord: ProposalWord = one.line.statement ?? "rule";
      const fromUserId = one.line.statement === "share" ? one.line.shareWithUserId : one.line.statement === "give" ? one.line.toUserId ?? null : null;
      await insertHandinProposal(db, {
        candidateId: candidate.id, handinId: locked.id, transactionId: one.line.transactionId!, kind: one.kind,
        fromWord: one.kind === "owner_change" ? fromWord : null, fromUserId: one.kind === "owner_change" ? fromUserId : null,
        toWord: one.toWord, toUserId: one.toUserId, note: one.note,
        deltaMills: proposalDelta(one.line, { kind: one.kind, toWord: one.toWord, toUserId: one.toUserId, note: one.note }),
        why: one.proposal.why.trim(), messageRefs: one.proposal.messageRefs, state: late ? "late" : "proposed", afterCounted: late,
        agentKeyId: principal.agentKeyId,
      }, now);
    }
  });
  await runShiftReportBoardPass(app, now).catch((error: unknown) => warn(app, error, "the board's pass after Gengar's answer"));
  return { candidateId: candidate.id, recorded: planned.length, late, superseded: false, serverNow: now.toISOString() };
}


// ── The server's timer and the board's matters ───────────────────────────────

/**
 * Each minute (with the claims pass): a report in «Проверка» goes to «Подтвердите» when Hub's check is done and
 * Gengar answered (or nobody reviews its pages) — or 10 minutes after the hand-in, whatever still runs: the Mac with
 * Gengar may sleep, the person is never held longer. Then the board's matters are made what they are.
 */
export async function runShiftReportBoardPass(app: Pick<AppContext, "db" | "logger">, now: Date = new Date()): Promise<{ moved: number; matters: number }> {
  const { db } = app;
  let moved = 0;
  // «Нет в Hub» that Hub now holds, Hub's check of every page, a shift cancelled or merged, the «после сдачи» mark.
  await matchSightings(app, now).catch((error: unknown) => warn(app, error, "matching sightings"));
  await runHubChecks(app, now).catch((error: unknown) => warn(app, error, "Hub's check"));
  await settleGoneShifts(app, now).catch((error: unknown) => warn(app, error, "cancelled and merged shifts"));
  await syncLateMarks(app, now).catch((error: unknown) => warn(app, error, "the «после сдачи» mark"));
  const catalog = await pageCatalog(db);
  for (const one of await listCheckingHandins(db, { limit: 500 })) {
    const candidate = (await listHandinCandidates(db, one.handinId)).filter((row) => row.supersededAt === null).at(-1);
    if (candidate === undefined) continue;
    const subject = await subjectOf(db, one.shiftId).catch(() => null);
    const pageIds = subject === null ? [] : subject.shift.pages.map((page) => catalog.idOf.get(page.pageLabel)).filter((id): id is number => id !== undefined);
    const gengarPending = candidate.gengarAnsweredAt === null && (await hasShiftReportReviewer(db, pageIds));
    if (!checkLetsConfirm({ handedInAt: candidate.madeAt, now, hubPending: hubPending(candidate), gengarPending })) continue;
    if (await setHandinPhase(db, { handinId: one.handinId, phase: "confirm", at: now, from: ["checking"] })) moved += 1;
  }
  const matters = await syncBoardMatters(app, now) + await syncCheckMatters(app, now).catch((error: unknown) => {
    warn(app, error, "the check's matters");
    return 0;
  });
  return { moved, matters };
}

/**
 * The board's matters, the server their one writer: the person's «Подтвердите отчёт» while their report waits in
 * «Подтвердите» (never the owner's, whatever the wait), and «Генгар дочитал: N правок» while a late card waits. Each
 * closes itself when the cause is gone.
 */
async function syncBoardMatters(app: Pick<AppContext, "db" | "logger">, now: Date): Promise<number> {
  const { db } = app;
  const pages = await listMatterPageLabels(db);
  let touched = 0;
  const wantConfirm = new Set<string>();
  for (const one of await listConfirmHandins(db)) {
    const subject = await subjectOf(db, one.shiftId).catch(() => null);
    if (subject === null) continue;
    const key = `${SHIFT_REPORT_CONFIRM_KIND}:${one.shiftId}`;
    wantConfirm.add(key);
    const opened = await openMatter(db, {
      key, kind: SHIFT_REPORT_CONFIRM_KIND, source: "server",
      title: `Подтвердите отчёт смены ${subject.shift.reportDate.slice(8, 10)}.${subject.shift.reportDate.slice(5, 7)}`,
      object: { type: "shift", id: String(one.shiftId) },
      pageIds: subject.shift.pages.map((page) => pages.idOf.get(page.pageLabel)).filter((id): id is number => id !== undefined),
      owner: { userId: one.userId }, money: false,
      evidence: { shiftId: one.shiftId, since: one.phaseAt.toISOString() },
      link: boardLink(one.shiftId),
    }, SYSTEM, now);
    if (opened.transition !== "unchanged") touched += 1;
  }
  const wantLate = new Set<string>();
  for (const one of await listLateProposalHandins(db)) {
    const handin = await findHandinById(db, one.handinId);
    if (handin === null) continue;
    const key = `${SHIFT_REPORT_LATE_PROPOSALS_KIND}:${one.handinId}`;
    wantLate.add(key);
    const opened = await openMatter(db, {
      key, kind: SHIFT_REPORT_LATE_PROPOSALS_KIND, source: "server",
      title: `Генгар дочитал: ${one.count} ${one.count % 10 === 1 && one.count % 100 !== 11 ? "правка" : one.count % 10 >= 2 && one.count % 10 <= 4 && (one.count % 100 < 12 || one.count % 100 > 14) ? "правки" : "правок"}`,
      object: { type: "shift", id: String(handin.shiftId) }, pageIds: [], owner: { userId: handin.userId }, money: false,
      evidence: { shiftId: handin.shiftId, count: one.count }, link: boardLink(handin.shiftId),
    }, SYSTEM, now);
    if (opened.transition !== "unchanged") touched += 1;
  }
  for (const matter of await listOpenMattersOfKinds(db, [SHIFT_REPORT_CONFIRM_KIND, SHIFT_REPORT_LATE_PROPOSALS_KIND])) {
    if (wantConfirm.has(matter.key) || wantLate.has(matter.key)) continue;
    const closed = await closeMatter(db, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") touched += 1;
  }
  return touched;
}


// ── The current shift, the pulse ─────────────────────────────────────────────

/**
 * The person's own shift that needs them most: the running one, else the newest not counted, else the newest (of the
 * last week, begun after the right was granted). Null — none.
 */
async function currentShiftOf(app: Pick<AppContext, "db">, userId: number, now: Date): Promise<{ shiftId: number; handin: HandinRow | null } | null> {
  const person = (await listHandinPeopleOfUsers(app.db, [userId])).get(userId) ?? null;
  const since = person?.submitsShiftSince ?? null;
  if (since === null) return null;
  const userIds = [...new Set([userId, ...(person?.userIds ?? [])])];
  const shifts = (await listHandinShifts(app.db, { userIds, from: new Date(Math.max(since.getTime(), now.getTime() - 7 * DAY_MS)), to: new Date(now.getTime() + 60_000) }))
    .filter((shift) => shift.state !== "dropped" && shift.state !== "merged" && shift.startedAt.getTime() >= since.getTime())
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  if (shifts.length === 0) {
    const latest = await findLatestHandinShift(app.db, { userIds, before: now });
    return latest === null || latest.startedAt.getTime() < since.getTime() ? null : { shiftId: latest.id, handin: await findHandinByShift(app.db, latest.id) };
  }
  const handins = await listHandinsOfShifts(app.db, shifts.map((shift) => shift.id));
  const going = shifts.find((shift) => shift.state === "going");
  const open = shifts.find((shift) => phaseOf(handins.get(shift.id) ?? null) !== "counted");
  const pick = going ?? open ?? shifts[0]!;
  return { shiftId: pick.id, handin: handins.get(pick.id) ?? null };
}

/** `shiftReportCurrent`: the board of the person's shift that needs them most. */
export async function readCurrentShiftReport(app: BoardApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<ShiftReportCurrentResponse> {
  const actor = handinActorOf(principal);
  const current = await currentShiftOf(app, actor.userId, now);
  if (current === null) return { report: null, phase: null, serverNow: now.toISOString() };
  const report = await readShiftReport(app, actor, current.shiftId, now);
  return { report, phase: report.board?.phase ?? null, serverNow: now.toISOString() };
}

/**
 * The pulse's `report` (`clientActivity`): the shift that needs the person most, its phase and whether it waits for
 * them — «Подтвердите», a question to them, a late card of Gengar. Null — no board for this person. Cheap: no draft is
 * computed (a row «после сдачи» lights the dot when the board is read).
 */
export async function pulseReport(app: Pick<AppContext, "db">, userId: number, now: Date = new Date()): Promise<{ shiftId: number; phase: ShiftReportPhase; needsMe: boolean } | null> {
  const current = await currentShiftOf(app, userId, now);
  if (current === null) return null;
  const phase = phaseOf(current.handin);
  const person = (await listHandinPeopleOfUsers(app.db, [userId])).get(userId) ?? null;
  const asked = await listSaleClaims(app.db, { sideUserIds: person?.userIds ?? [userId], states: ["asked"], kinds: ["claim"], limit: 1 });
  const late = current.handin === null ? false : (await listHandinProposals(app.db, current.handin.id)).some((one) => one.state === "late");
  // «После сдачи» from the cheap mark the minute pass keeps (`late_sales`): no draft is computed here.
  const afterHandIn = (current.handin?.lateSales ?? 0) > 0;
  return { shiftId: current.shiftId, phase, needsMe: phase === "confirm" || asked.length > 0 || late || afterHandIn };
}

function warn(app: Pick<AppContext, "logger">, error: unknown, what: string) {
  app.logger.warn({ err: error instanceof Error ? error.message : String(error) }, `shift report board: ${what} failed; the next pass will`);
}

