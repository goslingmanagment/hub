import {
  SHIFT_REPORT_BARE_NOTE_FROM_MILLS,
  personNameForms,
  type PersonNameForms,
  type ShiftReportBoard,
  type ShiftReportLineBody,
  type ShiftReportOwner,
  type ShiftReportRow,
} from "@agency_hub_core/contracts";
import { ruPlural } from "@agency_hub_core/ui/plural";

/**
 * The «Отчёт» board's words, read from Hub's `board` (shift-report-board.ts): how a row, its tick and its «чья» look,
 * what each item of the «Чья продажа» menu does, and the prototype's formats. Nothing here counts money: every sum and
 * share is Hub's (`amountMills`, `sumMills`, `totals`). No React here.
 */

export type Board = ShiftReportBoard;
export type Row = ShiftReportRow;
export type Colleague = Board["colleagues"][number];

// ── formats, as the prototype writes them ─────────────────────────────────────

const dollars = (mills: number) => mills / 1000;
/** `$477.40`, `$1,204.00`. */
export function usd(mills: number): string {
  return `$${dollars(mills).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
/** Fansly's way: `+$48`, `+$17.60`. */
export function plus(mills: number): string {
  return `+$${mills % 1000 === 0 ? dollars(mills) : dollars(mills).toFixed(2)}`;
}
/** A card's change of the person's sum: `+$8.00`, `−$24.00`. */
export function signed(mills: number): string {
  return `${mills > 0 ? "+" : "−"}${usd(Math.abs(mills))}`;
}

const clockFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
const dayFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
/** `22:30`, Moscow. */
export const clock = (iso: string) => clockFormat.format(new Date(iso));
/** `12 нояб.`, Moscow. */
export const day = (iso: string) => dayFormat.format(new Date(iso));

export const plural = (count: number, one: string, few: string, many: string) => ruPlural(count, one, few, many);
/** `3 продажи`. */
export const salesCount = (count: number) => `${count} ${plural(count, "продажа", "продажи", "продаж")}`;

/** The first letter up: «моя» → «Моя» (a word in a card's quotes). */
export const upper = (words: string) => (words === "" ? words : words[0]!.toUpperCase() + words.slice(1));

// ── the shift ─────────────────────────────────────────────────────────────────

/** «Отчёт смены, 12 нояб., 18:00–02:00»; someone else's: «Отчёт смены: Лев, 12 нояб., 18:00–02:00». */
export function titleOf(shift: { startedAt: string; endedAt: string; personName: string; ongoing: boolean }, own: boolean): string {
  const when = `${day(shift.startedAt)}, ${clock(shift.startedAt)}–${shift.ongoing ? "сейчас" : clock(shift.endedAt)}`;
  return own ? `Отчёт смены, ${when}` : `Отчёт смены: ${shift.personName}, ${when}`;
}

/** «Mia-1 не в смене». */
export function offShiftOf(board: Board): string {
  return board.offShift.length === 0 ? "" : `${board.offShift.map((page) => page.pageLabel).join(", ")} не в смене`;
}

/** «До 18:00: 3 продажи Олега». */
export function beforeWords(before: Board["columns"][number]["before"]): string {
  const whose = before.people.map((one) => one.forms.gen).join(" и ");
  return `До ${clock(before.until)}: ${salesCount(before.count)}${whose ? ` ${whose}` : ""}`;
}

export const allRows = (board: Board): Row[] => board.columns.flatMap((column) => column.rows);
export const rowByKey = (board: Board, key: string): Row | null =>
  board.columns.flatMap((column) => [...column.rows, ...column.before.rows]).find((row) => row.key === key) ?? null;
export const keyOfTransaction = (transactionId: number) => `t${transactionId}`;

// ── a row ─────────────────────────────────────────────────────────────────────

/** A row Hub does not hold yet («нет в Hub»), not added. */
export const isLost = (row: Row) => row.sighting !== null && !row.sighting.added;
/** A sale after the hand-in, not yet in the report («после сдачи»). */
export const isLateOpen = (row: Row) => row.late && !row.ticked;
const askOpen = (row: Row) => row.ask !== null && (row.ask.state === "asked" || row.ask.state === "disputed");
const incomingOpen = (row: Row) => row.incoming !== null && row.incoming.state !== "settled";

/** The tick's look: none (before the shift), x (not in the report yet), mix (waits for an answer), on, off. */
export type TickLook = "none" | "x" | "mix" | "on" | "off";
export function tickLook(row: Row): TickLook {
  if (row.before !== null) return "none";
  if (isLost(row) || isLateOpen(row)) return "x";
  if (askOpen(row) || incomingOpen(row)) return "mix";
  return row.ticked ? "on" : "off";
}

/** The word «чья» on line 2 and its look. */
export function ownerWord(row: Row): { text: string; cls: string } {
  if (isLost(row)) return { text: "нет в Hub", cls: "is-amb" };
  if (isLateOpen(row)) return { text: "после сдачи", cls: "is-amb" };
  // While a question waits the word is not the quiet «моя» of the rule (the prototype's `ownerInfo`).
  if (askOpen(row) || incomingOpen(row)) return { text: row.owner.words, cls: "" };
  if (row.owner.kind === "share" && row.ticked) return { text: row.owner.words, cls: "is-half" };
  return { text: row.owner.words, cls: row.owner.kind === "me" ? "is-me" : "" };
}

/** The grey reason after the word: amber while a question waits, green for one's half. */
export function reasonLook(row: Row): string {
  if (askOpen(row) || incomingOpen(row)) return "is-amb";
  if (row.owner.kind === "share" && row.ticked && !isLost(row) && !isLateOpen(row)) return "is-money";
  return "";
}

/** «Комментарий» asks for itself: one's own sale from $30 without a comment. */
export const wantsNote = (row: Row) => row.ticked && row.netMills >= SHIFT_REPORT_BARE_NOTE_FROM_MILLS && row.note === null;
/** «Без комментария: N продаж от $30»: the rows it points at, in the board's order. */
export const bareRows = (board: Board) => allRows(board).filter((row) => row.canNote && wantsNote(row));

/** Gengar's comment on a row: the row's own note by the agent, or a card of kind note. */
export function agentNote(row: Row): string | null {
  if (row.note !== null && row.note.by === "agent") return row.note.text;
  if (row.note === null && row.proposal?.kind === "note" && row.proposal.note !== null && row.proposal.state !== "declined") return row.proposal.note;
  return null;
}

// ── «Чья продажа»: the menu ───────────────────────────────────────────────────

/** A word of the menu: `me`, `share:<userId>`, `user:<userId>`, `pot`, `nobody`. */
export type ChoiceKey = string;

export function keyOfOwner(owner: ShiftReportOwner): ChoiceKey | null {
  switch (owner.kind) {
    case "me": return "me";
    case "share": return owner.userId === null ? null : `share:${owner.userId}`;
    case "user": return owner.userId === null ? null : `user:${owner.userId}`;
    case "pot": return "pot";
    case "nobody": return "nobody";
    default: return null;
  }
}

/** The person's own part of the sale a word gives: all, half, none. Only for which words ask; never a sum. */
const RANK: Record<string, number> = { me: 2, share: 1 };
const rankOf = (key: ChoiceKey | null) => (key === null ? 0 : RANK[key.split(":")[0]!] ?? 0);

/** Someone's name forms: the board's colleague, else a plain rule on the name Hub gave. */
function formsOf(board: Board, userId: number | null, name: string | null): PersonNameForms {
  const colleague = board.colleagues.find((one) => one.userId === userId);
  return colleague?.forms ?? personNameForms(name ?? "");
}

export interface Ask {
  /** colleague — the rule's holder answers; owner — the pot's, or the decider's. */
  to: "colleague" | "owner";
  forms: PersonNameForms | null;
  statement: "mine" | "share";
  shareWithUserId: number | null;
}

export interface Choice {
  key: ChoiceKey;
  /** In the menu: «Моя», «Пополам с Севой», «Олега», «Общак», «Ничья». */
  label: string;
  /** In a sentence: «моя», «пополам с Севой», «Олега», «общак», «ничья». */
  words: string;
  /** «по правилу», «спросим Олега», «решит владелец». */
  hint: string;
  /** The word makes the person's share larger at someone's cost: a question, not a mark. */
  ask: Ask | null;
  /** The mark it is when it is not a question. */
  line: Pick<ShiftReportLineBody, "statement" | "shareWithUserId" | "toUserId">;
}

/** Whether the row is the person's own by the rule (all of it, or half): only then may it go to someone else. */
const ownByRule = (row: Row) => row.rule.owner.kind === "me" || row.rule.owner.kind === "share";

/** The menu «Чья продажа» of a row, in groups (a line between them). The current word is `currentKey`. */
export function choicesOf(board: Board, row: Row): { groups: Choice[][]; currentKey: ChoiceKey | null } {
  const ruleKey = keyOfOwner(row.rule.owner);
  const granted = row.ask !== null && (row.ask.state === "agreed" || row.ask.state === "decided" || row.ask.state === "silence");
  const holder = row.rule.owner;
  const choice = (key: ChoiceKey, label: string, words: string): Choice => {
    const [kind, id] = key.split(":");
    const userId = id === undefined ? null : Number(id);
    const asks = !granted && key !== ruleKey && rankOf(key) > rankOf(ruleKey) && holder.kind !== "me" && holder.kind !== "nobody";
    const ask: Ask | null = !asks ? null : {
      to: holder.kind === "user" || holder.kind === "share" ? "colleague" : "owner",
      forms: holder.kind === "user" || holder.kind === "share" ? formsOf(board, holder.userId, holder.name) : null,
      statement: kind === "me" ? "mine" : "share",
      shareWithUserId: kind === "share" ? userId : null,
    };
    const hint = key === ruleKey ? "по правилу" : ask === null ? "" : ask.to === "owner" ? "решит владелец" : `спросим ${ask.forms!.acc}`;
    const line: Choice["line"] = key === ruleKey ? { statement: null }
      : kind === "me" ? { statement: "mine" }
        : kind === "share" ? { statement: "share", shareWithUserId: userId }
          : kind === "user" ? { statement: "give", toUserId: userId }
            : kind === "pot" ? { statement: "pot" } : { statement: "not_mine" };
    return { key, label, words, hint, ask, line };
  };
  const me = choice("me", "Моя", "моя");
  const halves = board.colleagues.map((one) => choice(`share:${one.userId}`, `Пополам с ${one.forms.ins}`, `пополам с ${one.forms.ins}`));
  const people = board.colleagues.map((one) => choice(`user:${one.userId}`, one.forms.gen, one.forms.gen));
  const pot = choice("pot", "Общак", "общак");
  const nobody = choice("nobody", "Ничья", "ничья");
  let groups: Choice[][];
  if (ownByRule(row)) {
    groups = [[me, ...halves], people, [pot, nobody]];
  } else {
    // Someone else's sale (a colleague's, the pot's, nobody's): one cannot give it away; «Моя» and «Пополам с …» ask its holder.
    const rule = [...people, pot, nobody].find((one) => one.key === ruleKey);
    groups = [[me, ...halves], ...(rule ? [[rule]] : [])];
  }
  const currentKey = row.ask !== null && askOpen(row) ? keyOfOwner(row.ask.want) : keyOfOwner(row.owner);
  return { groups, currentKey };
}

/** The word a tick press means (the prototype's `ACT.tick`): off — back to the rule, the half to its partner, or nobody; on — the rule's own word, or «моя». */
export function tickChoice(board: Board, row: Row): Choice | null {
  const { groups } = choicesOf(board, row);
  const all = groups.flat();
  const ruleKey = keyOfOwner(row.rule.owner);
  const find = (key: ChoiceKey | null) => all.find((one) => one.key === key) ?? null;
  if (row.ticked) {
    if (rankOf(ruleKey) === 0) return find(ruleKey);
    if (row.owner.kind === "share" && row.owner.userId !== null) return find(`user:${row.owner.userId}`);
    return find("nobody");
  }
  return rankOf(ruleKey) > 0 ? find(ruleKey) : find("me");
}

/** The prototype's toast after a word that applies at once. */
export function choiceToast(row: Row, choice: Choice, board: Board): string | null {
  const ruleKey = keyOfOwner(row.rule.owner);
  const [kind, id] = choice.key.split(":");
  const forms = id === undefined ? null : formsOf(board, Number(id), null);
  if (kind === "share" && choice.key !== ruleKey && forms) return `${forms.nom} увидит: продажа пополам`;
  if (row.ticked && rankOf(choice.key) === 0) return `Убрано из отчёта, продажа ${choice.words}`;
  if (kind === "user" && choice.key !== ruleKey && forms) return `Продажа теперь ${forms.gen}`;
  return null;
}

// ── the bar ───────────────────────────────────────────────────────────────────

/** «Генгар предложил 2 правки и 1 комментарий:» and the rows it links to, in the board's order. */
export function gengarFound(board: Board): { words: string; rows: Row[] } | null {
  const rows = allRows(board).filter((row) => (row.proposal?.kind === "owner_change" && row.proposal.state !== "late") || agentNote(row) !== null);
  if (rows.length === 0) return null;
  const edits = rows.filter((row) => row.proposal?.kind === "owner_change").length;
  const notes = rows.length - edits;
  const what = [
    edits ? `${edits} ${plural(edits, "правку", "правки", "правок")}` : "",
    notes ? `${notes} ${plural(notes, "комментарий", "комментария", "комментариев")}` : "",
  ].filter(Boolean).join(" и ");
  return { words: `Генгар предложил ${what}:`, rows };
}

/** Gengar's cards that came after the report was counted: «Принять» / «Не согласен». */
export const lateProposals = (board: Board) => allRows(board).filter((row) => row.proposal?.state === "late");

/** «Ждут ответа, в сумму не входят: …»: the rows of the questions and claims still open. */
export const waitingRows = (board: Board) => {
  const keys = new Set(board.waiting.filter((one) => one.why === "ask" || one.why === "incoming").map((one) => one.key));
  return allRows(board).filter((row) => keys.has(row.key));
};

/** The frame's `state` message: what the collapsed bar shows. */
export function frameState(shiftId: number | null, board: Board | null) {
  return board === null
    ? { t: "state" as const, shiftId, phase: "none" as const, chip: "", count: 0, totalMills: 0, needsMe: false }
    : { t: "state" as const, shiftId, phase: board.phase, chip: board.chip, count: board.totals.count, totalMills: board.totals.nowMills, needsMe: board.needsMe };
}
