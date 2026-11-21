import {
  SHIFT_REPORT_BARE_NOTE_FROM_MILLS,
  SHIFT_REPORT_CHECK_MINUTES,
  personNameForms,
  type PersonNameForms,
  type ShiftReportBoard,
  type ShiftReportLineBody,
  type ShiftReportOwner,
  type ShiftReportPhase,
  type ShiftReportRow,
} from "@agency_hub_core/contracts";
import { ruPlural } from "@agency_hub_core/ui/plural";

/**
 * The «Отчёт» board's words, read from Hub's `board` (shift-report-board.ts): how a row, its tick and its «чья» look,
 * what each item of the «Чья продажа» menu does and says, the phase's steps, the formats. Nothing here counts money:
 * every sum and share is Hub's (`amountMills`, `sumMills`, `totals`), and every rule is Hub's (`row.rule`, `choices`):
 * here they are only shortened into the board's words. No React here.
 */

export type Board = ShiftReportBoard;
export type Row = ShiftReportRow;

// ── formats ───────────────────────────────────────────────────────────────────

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
/** `3 продажи` (the number never apart from its word). */
export const salesCount = (count: number) => `${count}\u00a0${plural(count, "продажа", "продажи", "продаж")}`;

/** The first letter up: «моя» → «Моя». */
export const upper = (words: string) => (words === "" ? words : words[0]!.toUpperCase() + words.slice(1));

/** The person's line after a colon, in quotes; the quotes inside it as „…“ (never «…«…»»); nothing for no line. */
export const said = (note: string | null | undefined) => (note && note.trim() !== "" ? `: «${note.trim().replace(/«/g, "„").replace(/»/g, "“")}»` : "");

// ── the shift ─────────────────────────────────────────────────────────────────

/** «12 нояб., 18:00–02:00»; a shift going on: «12 нояб., 18:00–сейчас». */
export function whenOf(shift: { startedAt: string; endedAt: string; ongoing: boolean }): string {
  return `${day(shift.startedAt)}, ${clock(shift.startedAt)}–${shift.ongoing ? "сейчас" : clock(shift.endedAt)}`;
}

/** «Отчёт смены»; someone else's: «Отчёт смены: Лев». */
export const titleOf = (personName: string, own: boolean) => (own ? "Отчёт смены" : `Отчёт смены: ${personName}`);

/** «Не в смене: Mia-1, Mia-5». */
export function offShiftOf(board: Board): string {
  return board.offShift.length === 0 ? "" : `Не в смене: ${board.offShift.map((page) => page.pageLabel).join(", ")}`;
}

/** «Fansly», «OnlyFans». */
export const platformName = (platform: string) => (platform === "fansly" ? "Fansly" : "OnlyFans");

/** «До 18:00: 3 продажи Олега»; with the person's own among them: «До 18:00: 4 продажи: 3 Олега, 1 ваша». */
export function beforeWords(before: Board["columns"][number]["before"]): string {
  const whose = before.people.map((one) => one.forms.gen).join(" и ");
  const mine = before.rows.filter((row) => row.owner.kind === "me").length;
  const head = `До ${clock(before.until)}: ${salesCount(before.count)}`;
  if (mine === 0) return `${head}${whose ? ` ${whose}` : ""}`;
  const yours = `${mine} ${plural(mine, "ваша", "ваши", "ваших")}`;
  if (mine === before.count) return `${head}, ${mine === 1 ? "ваша" : "все ваши"}`;
  return `${head}: ${before.count - mine}${whose ? ` ${whose}` : " чужих"}, ${yours}`;
}

/** The person's other shift that waits for them (`board.otherShifts`). */
export type OtherShift = NonNullable<Board["otherShifts"]>[number];

/**
 * Its line above the pages: «Не сдана ваша смена 19 нояб., 08:00–11:02: 1 продажа, $40.00. В этот отчёт она не
 * входит», «Смена … ждёт вашего «Подтверждаю»», «Смена … открыта для правки», «Идёт ваша смена с 13:24».
 */
export function otherShiftWords(one: OtherShift): string {
  if (one.ongoing) return `Идёт ваша смена с ${clock(one.startedAt)}`;
  const when = `${day(one.startedAt)}, ${clock(one.startedAt)}–${clock(one.endedAt)}`;
  if (one.phase === "confirm") return `Смена ${when} ждёт вашего «Подтверждаю»`;
  if (one.phase === "fixing") return `Смена ${when} открыта для правки: сдайте её снова`;
  const sales = one.count === 0 ? "продаж в ней нет" : `${salesCount(one.count)}, ${usd(one.mills)}. В этот отчёт ${one.count === 1 ? "она не входит" : "они не входят"}`;
  return `Не сдана ваша смена ${when}: ${sales}`;
}

export type StepState = "done" | "now" | "next";
/** The header's quiet steps: «Черновик · Проверка · Подтвердите · Учтён», «Правка» in the first place while fixing. */
export function stepsOf(phase: ShiftReportPhase): Array<{ label: string; state: StepState }> {
  const at = phase === "draft" || phase === "fixing" ? 0 : phase === "checking" ? 1 : phase === "confirm" ? 2 : 3;
  return [phase === "fixing" ? "Правка" : "Черновик", "Проверка", "Подтвердите", "Учтён"]
    .map((label, index) => ({ label, state: index < at ? "done" : index === at ? "now" : "next" }));
}

/** The check's own clock: «0:42» since the hand-in and how far into Hub's ten minutes (0…1). */
export function checkClock(madeAt: string, nowMs: number): { elapsed: string; limit: string; part: number } {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(madeAt)) / 1000));
  const limit = SHIFT_REPORT_CHECK_MINUTES * 60;
  const shown = Math.min(seconds, limit);
  return { elapsed: `${Math.floor(shown / 60)}:${String(shown % 60).padStart(2, "0")}`, limit: `${SHIFT_REPORT_CHECK_MINUTES}:00`, part: shown / limit };
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
/** The person's question waits for the decider, or the colleague said «Не согласен» to it. */
export const askOpen = (row: Row) => row.ask !== null && (row.ask.state === "asked" || row.ask.state === "disputed");
/** A colleague's word on the person's sale waits for them, or is disputed. */
export const incomingOpen = (row: Row) => row.incoming !== null && row.incoming.state !== "settled";
/** A colleague's sale the person wrote to themself, standing: «Отменить» gives it back. */
export const takeStands = (row: Row) => row.ask !== null && row.ask.taken === true && row.ask.state === "silence";
/** A colleague wrote the person's sale to themself and the person has not answered: «Понятно» / «Не согласен». */
export const takenFromMeOpen = (row: Row) =>
  row.incoming !== null && row.incoming.taken === true && row.incoming.state === "settled" && row.incoming.answer === null;
/** A strip under the row says what stands on it: line 2 then leaves the reason to it. */
export const hasStrip = (row: Row) => askOpen(row) || incomingOpen(row) || takeStands(row) || takenFromMeOpen(row);

/** Ticks and «чья» change only while the report is a draft (or a correction), never in a preview. */
export const canTick = (board: Board, row: Row, preview: boolean) =>
  row.editable && !preview && (board.phase === "draft" || board.phase === "fixing");
/** The row's «чья» opens its menu: it may change now and Hub offers words for it. */
export const hasMenu = (board: Board, row: Row, preview: boolean) => canTick(board, row, preview) && (row.choices?.length ?? 0) > 0;

/** The tick's look: none (before the shift), x (not in the report yet), mix (waits for an answer), on, off. */
export type TickLook = "none" | "x" | "mix" | "on" | "off";
export function tickLook(row: Row): TickLook {
  if (row.before !== null) return "none";
  if (isLost(row) || isLateOpen(row)) return "x";
  if (askOpen(row) || incomingOpen(row)) return "mix";
  return row.ticked ? "on" : "off";
}

/** Who decides this sale's dispute, and whom the texts name: a team lead by name, else «владелец». */
export const deciderOf = (board: Board, row: Row) => row.decider ?? board.decider;
export function deciderForms(board: Board, row: Row): PersonNameForms | null {
  const decider = deciderOf(board, row);
  return decider.kind === "team_lead" && decider.user !== null ? decider.user.forms : null;
}

const sameOwner = (a: ShiftReportOwner, b: ShiftReportOwner) => a.kind === b.kind && (a.userId ?? 0) === (b.userId ?? 0);

/** Someone's name forms: the board's colleague, else a plain rule on the name Hub gave. */
function formsOf(board: Board, userId: number | null, name: string | null): PersonNameForms {
  return board.colleagues.find((one) => one.userId === userId)?.forms ?? personNameForms(name ?? "");
}

/**
 * The «чья» pill of a row. `hidden` — one's own sale by the rule, ticked: the tick says «моя», the pill shows on hover
 * and focus only. `wait` — what waits (amber), `card` — Gengar's change in «Подтвердите», `tint` — one's own word.
 */
export interface Pill {
  text: string;
  tone: "plain" | "tint" | "wait" | "card";
  hidden: boolean;
}
export function pillOf(board: Board, row: Row): Pill | null {
  if (row.before !== null) return null;
  const pill = (text: string, tone: Pill["tone"], hidden = false): Pill => ({ text, tone, hidden });
  if (isLost(row)) return pill("нет в Hub", "wait");
  if (isLateOpen(row)) return pill("после сдачи", "wait");
  if (row.ask !== null && askOpen(row)) {
    return pill(row.ask.state === "disputed" ? "спор" : row.ask.to === "owner" ? `ждём ${deciderForms(board, row)?.gen ?? "владельца"}` : "ждём ответа", "wait");
  }
  if (row.incoming !== null && incomingOpen(row)) return pill(row.incoming.state === "disputed" ? "спор" : "ждёт ответа", "wait");
  const owner = row.owner;
  const text = owner.kind === "user" && row.statement === "give" ? `отдал ${formsOf(board, owner.userId, owner.name).dat}`
    : owner.kind === "user" || owner.kind === "waiting" ? "чужая"
      : owner.words;
  const card = board.phase === "confirm" && row.proposal?.kind === "owner_change" && row.proposal.state === "proposed" && row.proposal.superseded !== true;
  if (card) return pill(text, "card");
  const mine = owner.kind === "me" || owner.kind === "share";
  return pill(text, mine ? "tint" : "plain", owner.kind === "me" && row.ticked && sameOwner(owner, row.rule.owner));
}

/** Line 2's reason: Hub's words, when they say something a strip under the row does not say already. */
export function reasonOf(row: Row): { text: string; tone: "plain" | "wait" | "tint" } | null {
  if (row.reasonWords === "" || (row.before === null && hasStrip(row))) return null;
  if (isLost(row) || isLateOpen(row)) return { text: row.reasonWords, tone: "wait" };
  const card = row.proposal?.kind === "owner_change" && row.proposal.state === "proposed" && row.proposal.superseded !== true;
  return { text: row.reasonWords, tone: card ? "tint" : "plain" };
}

/** The amount column: the person's half of a shared sale «из» the sale; on OnlyFans what the fan paid under the net. */
export function amountOf(row: Row): { main: string; sub: string | null; title: string | null } {
  const half = row.owner.kind === "share" && row.amountMills > 0 && row.amountMills < row.netMills;
  if (half) return { main: plus(row.amountMills), sub: `из ${plus(row.netMills)}`, title: null };
  if (row.grossMills !== null) {
    return { main: plus(row.netMills), sub: `из ${usd(row.grossMills)}`, title: `Фан заплатил ${usd(row.grossMills)}, после комиссии ${usd(row.netMills)}` };
  }
  return { main: plus(row.netMills), sub: null, title: null };
}

/** The comment asks for itself: one's own sale from $30 without a comment. */
export const wantsNote = (row: Row) => row.ticked && row.netMills >= SHIFT_REPORT_BARE_NOTE_FROM_MILLS && row.note === null;
/** «Без комментария: N продаж от $30»: the rows it points at, in the board's order. */
export const bareRows = (board: Board) => allRows(board).filter((row) => row.canNote && wantsNote(row));

/** Gengar's comment on a row: the row's own note by the agent, or a card of kind note. */
export function agentNote(row: Row): string | null {
  if (row.note !== null && row.note.by === "agent") return row.note.text;
  if (row.note === null && row.proposal?.kind === "note" && row.proposal.note !== null && row.proposal.state !== "declined") return row.proposal.note;
  return null;
}

/** The comment a row shows: the person's or someone else's (named), else Gengar's («написал Генгар»); null — none. */
export function noteOf(row: Row): { text: string; by: string | null } | null {
  if (row.note !== null && row.note.by !== "agent") return { text: row.note.text, by: row.note.by === "other" ? row.note.byName : null };
  const agent = agentNote(row);
  return agent === null ? null : { text: agent, by: "написал Генгар" };
}

// ── «Чья продажа»: the menu ───────────────────────────────────────────────────

/** A word of the menu: `me`, `share:<userId>`, `user:<userId>`, `waiting:<userId>`, `pot`, `nobody`, `decide`. */
export type ChoiceKey = string;

export function keyOfOwner(owner: ShiftReportOwner): ChoiceKey | null {
  switch (owner.kind) {
    case "me": return "me";
    case "share": return owner.userId === null ? null : `share:${owner.userId}`;
    case "user": return owner.userId === null ? null : `user:${owner.userId}`;
    case "waiting": return `waiting:${owner.userId ?? ""}`;
    default: return owner.kind;
  }
}

/** The person's own part of the sale a word gives: all, half, none. Only for what a tick means; never a sum. */
const RANK: Record<string, number> = { me: 2, share: 1 };
const kindOfKey = (key: ChoiceKey | null) => (key === null ? "" : key.split(":")[0]!);
const rankOf = (key: ChoiceKey | null) => RANK[kindOfKey(key)] ?? 0;

export interface Choice {
  key: ChoiceKey;
  owner: ShiftReportOwner;
  /** In a sentence: «моя», «пополам с Севой», «Олега», «общак», «ничья». */
  words: string;
  /** Hub's grey text: «по правилу», «сообщим Олегу», «решит владелец»; empty — none. */
  hint: string;
  /** Who is told of it or decides it (Hub's `asks`); null — it applies as it is. */
  asks: { to: "colleague" | "decider"; forms: PersonNameForms | null; words: string } | null;
  /**
   * The word on someone else's sale that makes the person's share larger: it takes a line of why and goes as a question
   * (`ask`: written at once and the colleague told, or the decider's). Null — a mark (`line`).
   */
  question: { statement: "mine" | "share"; shareWithUserId: number | null } | null;
  /** The mark it is when it is not a question. */
  line: Pick<ShiftReportLineBody, "statement" | "shareWithUserId" | "toUserId">;
}

/** The mark a word is: the rule's own word clears the mark. */
function lineOfKey(key: ChoiceKey, ruleKey: ChoiceKey | null): Choice["line"] {
  const [kind, id] = key.split(":");
  const userId = id === undefined || id === "" ? null : Number(id);
  return key === ruleKey ? { statement: null }
    : kind === "me" ? { statement: "mine" }
      : kind === "share" ? { statement: "share", shareWithUserId: userId }
        : kind === "user" ? { statement: "give", toUserId: userId }
          : kind === "pot" ? { statement: "pot" } : { statement: "not_mine" };
}

/**
 * Hub's menu of a row (`row.choices`), in its order. One's own sale offers «Общак» and «Ничья» besides the rule's word;
 * someone else's only the rule's word, «Моя» and «Пополам с <держатель>» — and only there a word is a question (on one's
 * own sale Hub sends «пополам» or «отдать» with a colleague without the board to the decider by the mark itself).
 */
export function choicesOf(row: Row): Choice[] {
  const ruleKey = keyOfOwner(row.rule.owner);
  const listed = (row.choices ?? []).flatMap((one) => {
    const key = keyOfOwner(one.owner);
    return key === null ? [] : [{ one, key }];
  });
  const ownSale = listed.some(({ key }) => (key === "pot" || key === "nobody") && key !== ruleKey);
  return listed.map(({ one, key }) => {
    const grows = !ownSale && one.asks !== null && (key === "me" || key.startsWith("share:"));
    return {
      key,
      owner: one.owner,
      words: one.owner.words,
      hint: one.hint,
      asks: one.asks === null ? null : { to: one.asks.to, forms: one.asks.user?.forms ?? null, words: one.asks.words },
      question: grows ? { statement: key === "me" ? "mine" as const : "share" as const, shareWithUserId: key === "me" ? null : one.owner.userId } : null,
      line: lineOfKey(key, ruleKey),
    };
  });
}

/** The key the menu marks: the word asked for while the question waits, else Hub's current word. */
function currentKeyOf(row: Row): ChoiceKey | null {
  if (row.ask !== null && askOpen(row)) return keyOfOwner(row.ask.want);
  const marked = row.choices?.find((one) => one.current === true);
  return keyOfOwner(marked?.owner ?? row.owner);
}

/** The menu's label of a word: «Моя», «Пополам с Севой», a colleague by name («Олег»), «Общак», «Ничья». */
function labelOf(choice: Choice): string {
  const kind = kindOfKey(choice.key);
  if (kind === "user" || kind === "waiting") return choice.owner.name ?? upper(choice.words);
  return upper(choice.words);
}

/** Where the sale stays until the decider answers. */
function staysOf(board: Board, row: Row): string {
  const rule = row.rule.owner;
  if (rule.kind === "me" || rule.kind === "share") return "ждёт отдельно";
  if (rule.kind === "pot") return "остаётся в общаке";
  if (rule.kind === "user" || rule.kind === "waiting") return `остаётся ${formsOf(board, rule.userId, rule.name).gen}`;
  return "ждёт решения";
}

/** Why the sale is whose the rule says, in full: the menu's footer over the rule's word. */
export function ruleFoot(board: Board, row: Row): string {
  const rule = row.rule.owner;
  const words = row.rule.words;
  const why = words === "" ? "" : `: ${words}`;
  const forms = formsOf(board, rule.userId, rule.name);
  switch (rule.kind) {
    case "me": return `По правилу продажа ваша${why}.`;
    case "share": return `По правилу продажа пополам с ${forms.ins}${why}.`;
    case "user": return `По правилу продажа ${forms.gen}${why}.`;
    case "waiting": {
      const until = row.rule.waitsUntil;
      return `${forms.nom} отправил этот PPV, поэтому продажа его. Сейчас он не на смене: продажа уйдёт в его следующую смену.`
        + (until === undefined ? "" : ` Если смены не будет до ${day(until)}, продажа станет ничьей.`);
    }
    default: return `По правилу ${words || rule.words}.`;
  }
}

/** What choosing a word does, in full: the menu's footer and the hint of the form «Почему продажа ваша?». */
export function footOf(board: Board, row: Row, choice: Choice): string {
  if (choice.key === keyOfOwner(row.rule.owner)) return ruleFoot(board, row);
  const kind = kindOfKey(choice.key);
  const decides = `решит ${deciderOf(board, row).words}`;
  if (choice.asks?.to === "colleague") {
    return `Продажа сразу станет ${kind === "me" ? "вашей" : "пополам"}. ${choice.asks.forms?.nom ?? "Коллега"} узнает и может не согласиться.`;
  }
  if (choice.asks !== null) return `${upper(choice.asks.words || decides)}. До ответа продажа ${staysOf(board, row)}.`;
  const forms = formsOf(board, choice.owner.userId, choice.owner.name);
  switch (kind) {
    case "me": return "Продажа станет вашей сразу.";
    case "share": return `Продажа сразу станет пополам, ${forms.nom} увидит.`;
    case "user": return `Продажа сразу станет ${forms.gen}, ${forms.nom} увидит и может отказаться.`;
    case "pot": return `Продажа уйдёт в общак, дальше ${choice.hint || decides}.`;
    default: return row.ticked ? "Продажа уйдёт из отчёта и станет ничьей." : "Продажа станет ничьей.";
  }
}

/** The short consequence beside a word: «по правилу», «сообщим», «решит владелец», «уйдёт из отчёта», «сразу». */
function shortOf(board: Board, row: Row, choice: Choice): string {
  if (choice.key === keyOfOwner(row.rule.owner)) return "по правилу";
  if (choice.asks?.to === "colleague") return "сообщим";
  const decides = `решит ${deciderOf(board, row).words}`;
  if (choice.asks !== null) return decides;
  switch (kindOfKey(choice.key)) {
    case "pot": return choice.hint || decides;
    case "nobody": return row.ticked ? "уйдёт из отчёта" : "";
    case "me": return "сразу";
    default: return "";
  }
}

export interface MenuItem {
  choice: Choice;
  label: string;
  /** Beside the word. */
  short: string;
  /** In the menu's footer, while the word is hovered or focused. */
  foot: string;
}
/** A colleague of the matrix «пополам / отдать»: named once, the second line only when it says something. */
export interface MenuColleague {
  userId: number;
  name: string;
  note: string;
  share: MenuItem | null;
  give: MenuItem | null;
}
export interface OwnerMenu {
  /** «Kai/Berlin, +$26». */
  subject: string;
  items: MenuItem[];
  colleagues: MenuColleague[];
  currentKey: ChoiceKey | null;
  /** The footer when nothing is hovered: the current word's, or how to take a question back. */
  foot: string;
}

/**
 * The menu «Чья продажа» of a row, built from Hub's `choices`: the plain words («Моя», «Общак», «Ничья», the rule's
 * colleague) each with its short consequence, and the colleagues one may give the sale to as a matrix — each named once,
 * «пополам» and «отдать» in two columns. Pure.
 */
export function ownerMenu(board: Board, row: Row): OwnerMenu {
  const choices = choicesOf(row);
  const ruleKey = keyOfOwner(row.rule.owner);
  const currentKey = currentKeyOf(row);
  const waits = row.ask !== null && askOpen(row);
  const item = (choice: Choice, label = labelOf(choice)): MenuItem => ({
    choice,
    label,
    short: waits && choice.key === currentKey ? "ждём ответа" : shortOf(board, row, choice),
    foot: footOf(board, row, choice),
  });
  // A colleague one may give the sale to (an own sale) has both words in the matrix; else every word is a plain item.
  const givers = new Set(choices.filter((one) => one.key.startsWith("user:") && one.key !== ruleKey).map((one) => one.owner.userId));
  const items: MenuItem[] = [];
  const colleagues = new Map<number, MenuColleague>();
  for (const choice of choices) {
    const kind = kindOfKey(choice.key);
    const userId = choice.owner.userId;
    if ((kind !== "share" && kind !== "user") || userId === null || !givers.has(userId)) {
      items.push(item(choice));
      continue;
    }
    const forms = formsOf(board, userId, choice.owner.name);
    const one = colleagues.get(userId) ?? { userId, name: forms.nom, note: "", share: null, give: null };
    const shown = item(choice, kind === "share" ? `Пополам с ${forms.ins}` : `Отдать ${forms.dat}`);
    if (kind === "share") one.share = shown;
    else one.give = shown;
    colleagues.set(userId, one);
  }
  for (const one of colleagues.values()) {
    // The second line only when it differs from a plain word: the decider's, or the rule's own half.
    const decider = [one.share, one.give].find((shown) => shown !== null && shown.choice.asks?.to === "decider");
    one.note = decider?.short ?? (one.share?.choice.key === ruleKey ? "по правилу" : "");
    // A radio has no words of its own: its footer names it (the rule's own word says it already).
    for (const shown of [one.share, one.give]) if (shown !== null && shown.choice.key !== ruleKey) shown.foot = `${shown.label}. ${shown.foot}`;
  }
  const current = choices.find((one) => one.key === currentKey) ?? null;
  return {
    subject: `${row.fan.name ?? row.fan.username ?? ""}, ${plus(row.netMills)}`,
    items,
    colleagues: [...colleagues.values()],
    currentKey,
    foot: waits ? "Вопрос задан. Выберите прежний вариант, чтобы отменить его."
      : current !== null ? footOf(board, row, current) : ruleFoot(board, row),
  };
}

/** The word a tick press means: off — back to the rule, the half to its partner, or nobody; on — the rule's own word, or «моя». */
export function tickChoice(row: Row): Choice | null {
  const all = choicesOf(row);
  const ruleKey = keyOfOwner(row.rule.owner);
  const find = (key: ChoiceKey | null) => all.find((one) => one.key === key) ?? null;
  if (row.ticked) {
    if (rankOf(ruleKey) === 0) return find(ruleKey);
    if (row.owner.kind === "share" && row.owner.userId !== null) return find(`user:${row.owner.userId}`);
    return find("nobody");
  }
  return rankOf(ruleKey) > 0 ? find(ruleKey) : find("me");
}

/** The toast after a word that applies at once. */
export function choiceToast(board: Board, row: Row, choice: Choice): string | null {
  const ruleKey = keyOfOwner(row.rule.owner);
  const kind = kindOfKey(choice.key);
  if (choice.asks?.to === "decider" && choice.key !== ruleKey) return `${upper(choice.asks.words)}: до ответа продажа ждёт отдельно`;
  const forms = choice.owner.userId === null ? null : formsOf(board, choice.owner.userId, choice.owner.name);
  if (kind === "share" && choice.key !== ruleKey && forms) return `${forms.nom} увидит: продажа пополам`;
  if (row.ticked && rankOf(choice.key) === 0) return `Убрано из отчёта, продажа ${choice.words}`;
  if (kind === "user" && choice.key !== ruleKey && forms) return `Продажа теперь ${forms.gen}`;
  return null;
}

// ── the rail ──────────────────────────────────────────────────────────────────

/** «Генгар предложил 2 правки и 1 комментарий» and the rows it links to, in the board's order. */
export function gengarFound(board: Board): { words: string; rows: Row[] } | null {
  const rows = allRows(board).filter((row) => (row.proposal?.kind === "owner_change" && row.proposal.state !== "late") || agentNote(row) !== null);
  if (rows.length === 0) return null;
  const edits = rows.filter((row) => row.proposal?.kind === "owner_change").length;
  const notes = rows.length - edits;
  const what = [
    edits ? `${edits}\u00a0${plural(edits, "правку", "правки", "правок")}` : "",
    notes ? `${notes}\u00a0${plural(notes, "комментарий", "комментария", "комментариев")}` : "",
  ].filter(Boolean).join(" и ");
  return { words: `Генгар предложил ${what}`, rows };
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
