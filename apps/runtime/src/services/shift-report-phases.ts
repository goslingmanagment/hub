import { SHIFT_REPORT_ASK_SILENCE_HOURS, SHIFT_REPORT_CHECK_MINUTES, type ShiftReportPhase } from "@agency_hub_core/contracts";
import type { HandinStatement, HandinVersionLine, ProposalRow } from "@agency_hub_core/db";

import { ConflictError } from "./errors.ts";
import { lineAmount, type Statement } from "./shift-handin-rules.ts";
import type { SaleHomeKind } from "./sale-rule.ts";

/**
 * The «Отчёт» board's rules (products plan 2026-11-13, package R), pure: the phases and who may do what in each, when
 * the check lets the person confirm, what a version made at «Подтверждаю» counts with Gengar's proposals, and when a
 * day of silence settles a question. No database (tests/shift-report-phases.test.ts); shift-report-board.ts reads and
 * writes.
 *
 *   draft     «Черновик»     the person edits; «Сдать смену» records a candidate
 *   checking  «Проверка»     Hub and Gengar check it; read only
 *   confirm   «Подтвердите»  «Подтверждаю» makes the version; «Исправить»
 *   counted   «Учтён»        «Исправить», «Досдать», a late card of Gengar
 *   fixing    «Правка»       as the draft; «Сдать заново» or «Отмена»
 *
 * Only the person confirms: no agent door has a confirm, and a colleague, a team lead or the owner reading the board
 * may do nothing on it (a colleague answers a question about a sale on their OWN board).
 */

export type BoardAction =
  | "edit" // a tick, «чья», a «нет в Hub» added
  | "note" // a sale's comment, the shift's comment
  | "ask" // «Спросить …», «Отменить»
  | "handIn" // «Сдать смену», «Сдать заново»
  | "confirm" // «Подтверждаю»
  | "reopen" // «Исправить»
  | "cancel" // «Отмена» of «Правка»
  | "resend" // «Досдать»
  | "answerProposal"; // «Не согласен», «Вернуть правку», «Принять»

export interface BoardActor {
  /** own — the shift's person; read — anyone else (owner, team lead, colleague). */
  access: "own" | "read";
  /** person — a session or the extension's device token; agent — a key «со слов». */
  kind: "person" | "agent";
  /** The person's right `submits_shift` for this shift. */
  enabled: boolean;
}

const PERSON_ACTIONS: Record<ShiftReportPhase, readonly BoardAction[]> = {
  draft: ["edit", "note", "ask", "handIn"],
  checking: [],
  confirm: ["note", "confirm", "reopen", "answerProposal"],
  counted: ["reopen", "resend", "answerProposal"],
  fixing: ["edit", "note", "ask", "handIn", "cancel"],
};

/** An agent writes the person's words «со слов» and hands in a candidate; it never confirms, reopens or answers a card. */
const AGENT_ACTIONS: readonly BoardAction[] = ["edit", "note", "handIn"];

/** Whether the actor may do the action on a report in this phase. */
export function mayAct(actor: BoardActor, action: BoardAction, phase: ShiftReportPhase): boolean {
  if (actor.access !== "own" || !actor.enabled) return false;
  if (actor.kind === "agent") return AGENT_ACTIONS.includes(action) && (phase === "draft" || phase === "fixing");
  return PERSON_ACTIONS[phase].includes(action);
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

/**
 * Whether the check lets the person confirm: Hub has no page still reading and Gengar answered (or nobody reviews the
 * shift's pages) — or the server's timer: 10 minutes since the hand-in, whatever is still running.
 */
export function checkLetsConfirm(input: { handedInAt: Date; now: Date; hubPending: boolean; gengarPending: boolean }): boolean {
  if (!input.hubPending && !input.gengarPending) return true;
  return input.now.getTime() - input.handedInAt.getTime() >= SHIFT_REPORT_CHECK_MINUTES * 60_000;
}

/** Gengar's state on the board. */
export function gengarState(input: { reviewed: boolean; answeredAt: Date | null; clean: boolean | null; handedInAt: Date; now: Date }): "idle" | "reading" | "found" | "clean" | "silent" {
  if (input.answeredAt !== null) return input.clean === true ? "clean" : "found";
  if (!input.reviewed) return "idle";
  return input.now.getTime() - input.handedInAt.getTime() >= SHIFT_REPORT_CHECK_MINUTES * 60_000 ? "silent" : "reading";
}

/**
 * A day of silence (R-board §4): a question to a colleague nobody answered for a day settles for the one who asked. A
 * question with nobody to ask (the pot, the owner's) never settles by silence.
 */
export function silenceSettles(claim: { kind: string; state: string; sideUserId: number | null; createdAt: Date }, now: Date): boolean {
  return claim.kind === "claim" && claim.state === "asked" && claim.sideUserId !== null
    && now.getTime() - claim.createdAt.getTime() >= SHIFT_REPORT_ASK_SILENCE_HOURS * 3_600_000;
}

/** The word a statement is to the arithmetic of a line (`lineAmount`): given away and to the pot count as «не моё». */
export function arithmeticStatement(statement: HandinStatement | null): Statement | null {
  return statement === "give" || statement === "pot" ? "not_mine" : statement;
}

/** A line with another word: what it counts then, by the same arithmetic the draft uses. Pure. */
export function lineWithWord(
  line: HandinVersionLine,
  word: { statement: HandinStatement | null; shareWithUserId?: number | null; toUserId?: number | null },
): HandinVersionLine {
  const amount = lineAmount({
    group: line.group,
    netMills: line.netMills,
    shareMills: line.rule.shareMills,
    homeKind: line.rule.home as SaleHomeKind,
    statement: arithmeticStatement(word.statement),
    alreadyIn: line.alreadyIn !== null,
    claimed: line.added && line.group === "mine" && line.statement === "mine",
  });
  const next: HandinVersionLine = {
    ...line,
    statement: word.statement,
    shareWithUserId: word.statement === "share" ? word.shareWithUserId ?? null : null,
    toUserId: word.statement === "give" ? word.toUserId ?? null : null,
    amountMills: amount.amountMills,
    disputed: amount.disputed,
  };
  if (amount.claimedMills === undefined) delete next.claimedMills;
  else next.claimedMills = amount.claimedMills;
  delete next.settled;
  return next;
}

/** A proposal on its line: whose (owner_change) or a comment Gengar wrote (note, only where the person wrote none). Pure. */
export function lineWithProposal(line: HandinVersionLine, proposal: Pick<ProposalRow, "kind" | "toWord" | "toUserId" | "note">): HandinVersionLine {
  if (proposal.kind === "note") {
    if (line.note !== null && line.note.trim() !== "") return line;
    return { ...line, note: proposal.note, noteByAgent: true };
  }
  if (proposal.toWord === null) return line;
  if (proposal.toWord === "rule") return lineWithWord(line, { statement: null });
  return lineWithWord(line, {
    statement: proposal.toWord,
    shareWithUserId: proposal.toWord === "share" ? proposal.toUserId : null,
    toUserId: proposal.toWord === "give" ? proposal.toUserId : null,
  });
}

/** What a proposal changes in the person's sum. Pure. */
export function proposalDelta(line: HandinVersionLine, proposal: Pick<ProposalRow, "kind" | "toWord" | "toUserId" | "note">): number {
  return lineWithProposal(line, proposal).amountMills - line.amountMills;
}

/**
 * The lines a version is made of at «Подтверждаю»: the candidate's, each with its proposal applied unless the person
 * declined it. A late proposal (after the report was counted) is never applied here: it opens «Правка» only when the
 * person accepts it. Pure.
 */
export function confirmedLines(
  lines: readonly HandinVersionLine[],
  proposals: ReadonlyArray<Pick<ProposalRow, "transactionId" | "kind" | "toWord" | "toUserId" | "note" | "state">>,
): HandinVersionLine[] {
  return lines.map((line) => {
    let out = line;
    for (const proposal of proposals) {
      if (proposal.transactionId !== line.transactionId || proposal.state !== "proposed") continue;
      // A decision or an agreement on the sale outranks a card: it changes nothing of whose the sale is (`cardSuperseded`).
      if (cardSuperseded(proposal, out)) continue;
      out = lineWithProposal(out, proposal);
    }
    return out;
  });
}

/**
 * A card of whose the sale is, on a line a decision or an agreement settles: the settlement outranks it — the card
 * changes nothing and is shown «решено иначе» (round 2, N3). A note card is never superseded. Pure.
 */
export function cardSuperseded(proposal: Pick<ProposalRow, "kind">, line: Pick<HandinVersionLine, "settled">): boolean {
  return proposal.kind === "owner_change" && line.settled !== undefined;
}

/**
 * A candidate's lines with what changed since the hand-in outside the person's words, read in the confirmation's turn
 * (`lockSaleSettlements`): a decision, an agreement or a cancel of a sale (a line the draft now settles takes the draft's
 * amount; one settled before and not any more goes back to it), and the person's other reports — a sale another report
 * of theirs took meanwhile counts 0 here (`alreadyIn`), and a «долёт» the draft no longer offers leaves the version. The
 * sales and the words stay the candidate's: a sale counts in one report only (review 12.11, round 3). Pure.
 */
export function withSettlementsNow(lines: readonly HandinVersionLine[], draft: readonly HandinVersionLine[]): HandinVersionLine[] {
  const now = new Map(draft.flatMap((line) => (line.transactionId === null ? [] : [[line.transactionId, line] as const])));
  return lines.flatMap((line) => {
    const fresh = line.transactionId === null ? undefined : now.get(line.transactionId);
    if (fresh === undefined) return line.added ? [] : [line];
    if (fresh.alreadyIn !== null && line.alreadyIn === null) {
      const held: HandinVersionLine = { ...line, alreadyIn: fresh.alreadyIn, amountMills: 0, disputed: false };
      delete held.settled;
      delete held.claimedMills;
      return [held];
    }
    // A line that waits now and did not then (the person's «Не согласен» with a card since: the decider decides).
    if (fresh.settled === undefined && line.settled === undefined && fresh.disputed && !line.disputed && fresh.amountMills === 0) {
      return [{ ...line, amountMills: 0, disputed: true, ...(fresh.claimedMills === undefined ? {} : { claimedMills: fresh.claimedMills }) }];
    }
    if (fresh.settled === undefined && line.settled === undefined) return [line];
    const next: HandinVersionLine = { ...line, amountMills: fresh.amountMills, disputed: fresh.disputed };
    if (fresh.settled === undefined) delete next.settled;
    else next.settled = fresh.settled;
    if (fresh.claimedMills === undefined) delete next.claimedMills;
    else next.claimedMills = fresh.claimedMills;
    return [next];
  });
}

/**
 * What «Подтверждаю» would sign now, line by line — the one computation the board's «Подтвердите» shows and the
 * confirmation writes: the candidate's sales and words, what was settled since the hand-in (`withSettlementsNow`), the
 * person's comment of each sale as it is now (a comment written in «Подтвердите» is signed, never dropped), the cards of
 * Gengar not declined, and «отдать» a colleague without the board as the person's «не моё» (`oldWay`: the decider's).
 * Pure.
 */
export function signedLines(input: {
  candidate: readonly HandinVersionLine[];
  draft: readonly HandinVersionLine[];
  proposals: ReadonlyArray<Pick<ProposalRow, "transactionId" | "kind" | "toWord" | "toUserId" | "note" | "state">>;
  /** The person's comment of each sale now, by transaction (their marks); a sale with no mark keeps the candidate's. */
  notes: ReadonlyMap<number, string | null>;
  oldWay: ReadonlyMap<number, number>;
}): HandinVersionLine[] {
  const settled = withSettlementsNow(input.candidate, input.draft).map((line) => {
    if (line.transactionId === null || !input.notes.has(line.transactionId)) return line;
    const note = input.notes.get(line.transactionId) ?? null;
    if (note === line.note) return line;
    const next: HandinVersionLine = { ...line, note };
    delete next.noteByAgent;
    return next;
  });
  return confirmedLines(settled, input.proposals)
    .map((line) => (line.transactionId !== null && input.oldWay.has(line.transactionId) && line.settled === undefined ? lineWithWord(line, { statement: "not_mine" }) : line));
}

/**
 * Whether a line of what is checked or counted holds its sale: it counts it, or it carries the person's word, a dispute
 * or a settlement. A line at $0 with nothing on it («Рядом», nobody's) holds nothing: when the rule gives the sale to the
 * person after the hand-in — a colleague gave it, a decision — it comes «после сдачи» and «Досдать» takes it, as a sale
 * that came after does. `countLateSales` (packages/db shift-handin-check.ts) reads the same in SQL. Pure.
 */
export function holdsSale(line: Pick<HandinVersionLine, "amountMills" | "statement" | "disputed" | "settled">): boolean {
  return line.amountMills > 0 || line.statement !== null || line.disputed || line.settled !== undefined;
}

