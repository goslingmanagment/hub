import type { ShiftReportResponse } from "@agency_hub_core/contracts";
import {
  allRows,
  bareRows,
  clock,
  day,
  deciderForms,
  deciderOf,
  fanOf,
  gengarFoundRows,
  isLateOpen,
  isLost,
  oldWayOwn,
  plural,
  plus,
  said,
  salesCount,
  staysOf,
  takeStands,
  takenFromMeOpen,
  upper,
  usd,
  type Board,
  type Row,
} from "./model.js";

/**
 * The «Отчёт» board's sentences: what stands under a row (a question, a take, a colleague's word, Gengar's card), what
 * the rail says (Hub's and Gengar's check, what wants a look, the line under the press). Built from Hub's `board` and
 * Hub's words; the parts only draw them. Pure, no React.
 */

/** An icon of a sentence (icons.tsx draws it). */
export type Mark = "clock" | "people" | "plus" | "note" | "spark" | "pen" | "check" | "copy";
type Report = ShiftReportResponse;

// ── under a row ───────────────────────────────────────────────────────────────

/** A press of a strip: take the question back, or answer a colleague's word. */
export type StripAct = "unask" | "understood" | "agree" | "disagree";
export interface Strip {
  key: string;
  mark: Mark;
  /** `wait` — it waits for someone (amber); `calm` — it stands. */
  tone: "wait" | "calm";
  /** Bold, before the text: who wrote what. */
  lead: string | null;
  text: string;
  acts: StripAct[];
}

/** The strips under a row: the person's question or take, the colleague's word on the person's sale. */
export function stripsOf(board: Board, row: Row, can: { own: boolean; editing: boolean }): Strip[] {
  const out: Strip[] = [];
  const decider = deciderOf(board, row).words;
  const asked = row.ask;
  if (asked !== null && asked.state === "asked") {
    const why = upper(row.reasonWords);
    let text: string;
    if (oldWayOwn(row)) {
      // One's own sale with a colleague who hands in the old way: the word counts now, the decider decides the rest.
      const now = row.owner.kind === "share" ? "ваша половина в отчёте сразу" : "продажа ушла из отчёта";
      text = `${why || `Решит ${decider}`}: ${now}.${asked.note.trim() === "" ? "" : ` Вы написали${said(asked.note)}.`}`;
    } else {
      const whom = asked.to === "owner" || asked.oldWay === true ? deciderForms(board, row)?.acc ?? "владельца" : asked.toUser?.forms.acc ?? "коллегу";
      // Hub's reason says why it waits («день Олега уже выплачен, решит владелец»); without one, where the sale stays.
      text = `Вы спросили ${whom}${said(asked.note)}. ${why === "" ? `До ответа продажа ${staysOf(board, row)}` : why}.`;
    }
    out.push({ key: "asked", mark: "clock", tone: "wait", lead: null, text, acts: can.own && can.editing ? ["unask"] : [] });
  }
  // Written to the person at once (a take): the colleague is told and may object; «Отменить» gives it back.
  if (asked !== null && takeStands(row)) {
    const who = asked.toUser?.forms ?? null;
    out.push({
      key: "taken", mark: "people", tone: "calm", lead: null,
      text: `${asked.want.kind === "share" ? `Вы записали продажу пополам с ${who?.ins ?? "коллегой"}` : "Вы записали продажу себе"}${said(asked.note)}. `
        + `${who?.nom ?? "Коллега"} увидит это у себя и может не согласиться.`,
      acts: can.own && can.editing ? ["unask"] : [],
    });
  }
  if (asked !== null && asked.state === "disputed") {
    const who = asked.toUser;
    out.push({
      key: "disputed", mark: "people", tone: "calm", lead: null, acts: [],
      text: who === null ? `Спор решит ${decider}.` : `${who.forms.nom} против. Спор решит ${decider}, до ответа продажа ${who.forms.gen}.`,
    });
  }
  const claim = row.incoming;
  // A colleague wrote the person's sale to themself (a take): counted as written; «Понятно» or «Не согласен».
  if (claim !== null && takenFromMeOpen(row)) {
    out.push({
      key: "incoming", mark: "people", tone: "wait",
      lead: `${claim.from.forms.nom} ${claim.statement === "share" ? "записывает эту продажу пополам с вами" : "записывает эту продажу себе"}`,
      text: `${claim.note ? said(claim.note) : ""}. Если не согласны, спор решит ${decider}.`,
      acts: claim.canAnswer ? ["understood", "disagree"] : [],
    });
  }
  if (claim !== null && claim.state === "asked") {
    out.push({
      key: "incoming", mark: "people", tone: "wait",
      lead: `${claim.from.forms.nom} ${claim.statement === "share" ? "предлагает делить эту продажу пополам" : "считает эту продажу своей"}`,
      text: `${claim.note ? said(claim.note) : ""}. Пока вы не ответили, она ждёт, остальное учтено.`,
      acts: claim.canAnswer ? ["agree", "disagree"] : [],
    });
  }
  if (claim !== null && claim.state === "disputed") {
    out.push({
      key: "incoming", mark: "people", tone: "calm", lead: null, acts: [],
      text: `Вы не согласны с ${claim.from.forms.ins}. Спор решит ${decider}, до ответа продажа ваша.`,
    });
  }
  return out;
}

/** The toast after a strip's press. */
export function stripToastOf(board: Board, row: Row, act: StripAct): string {
  const decider = deciderOf(board, row).words;
  const from = row.incoming?.from.forms;
  if (act === "unask") return row.ask?.taken === true ? `Продажа снова ${row.ask.toUser?.forms.gen ?? row.rule.owner.words}` : "Вопрос отменён";
  if (act === "understood") return "Записано";
  if (act === "agree") return row.incoming?.statement === "share" ? "Продажа теперь пополам" : `Продажа теперь ${from?.gen ?? "коллеги"}`;
  return `Спор решит ${decider}`;
}

/** Gengar's card under a row, in words. */
export interface CardWords {
  /** `open` — applied unless refused; `late` — after the report was counted; `declined`; `superseded` — decided otherwise. */
  state: "open" | "late" | "declined" | "superseded";
  head: string;
  /** What it changes in the person's sum: «−$24.00»; null — nothing. */
  delta: string | null;
  why: string | null;
  /** The line beside the presses. */
  note: string;
}
export function cardWordsOf(board: Board, row: Row, card: NonNullable<Row["proposal"]>): CardWords | null {
  // A card of a comment is the row's comment («написал Генгар»), never «Было …, стало …».
  if (card.kind !== "owner_change") return null;
  const from = upper(card.from?.words ?? "");
  const to = upper(card.to?.words ?? "");
  if (card.superseded === true) return { state: "superseded", head: `предлагал «${to}»`, delta: null, why: null, note: `Решено иначе: ${row.reasonWords}.` };
  if (card.state === "declined") {
    return { state: "declined", head: `предлагал «${to}»`, delta: null, why: null, note: `Вы не согласны: осталось «${from}», решит ${deciderOf(board, row).words}.` };
  }
  if (card.state !== "proposed" && card.state !== "late") return null;
  const late = card.state === "late";
  return {
    state: late ? "late" : "open",
    head: `Было «${from}», стало «${to}»`,
    delta: card.deltaMills === 0 ? null : (card.deltaMills > 0 ? "+" : "−") + usd(Math.abs(card.deltaMills)),
    why: card.why,
    note: late ? "Пришла после подтверждения: само ничего не меняется" : "Если согласны, ничего не нажимайте",
  };
}

// ── the rail ──────────────────────────────────────────────────────────────────

/** A line of the rail with the way to its rows: each row its own link (its fan, or `link`), or one link for all. */
export interface RailLine {
  key: string;
  mark: Mark | "spin";
  tone: "ok" | "wait" | "tint" | null;
  text: string;
  /** A second, quieter line. */
  small: string | null;
  rows: Row[];
  /** The link's words; null — each row by its fan. */
  link: string | null;
  /** One link lights every row (Hub's found ones). */
  together: boolean;
  /** «Написать»: the next sale without a comment. */
  bare?: boolean;
}
const line = (key: string, mark: RailLine["mark"], tone: RailLine["tone"], text: string, more: Partial<RailLine> = {}): RailLine =>
  ({ key, mark, tone, text, small: null, rows: [], link: null, together: false, ...more });

/** «Ждут ответа, в сумму не входят»: the rows of the questions and claims still open that count nothing now. */
export const waitingRows = (board: Board) => {
  const keys = new Set(board.waiting.filter((one) => one.why === "ask" || one.why === "incoming").map((one) => one.key));
  return allRows(board).filter((row) => keys.has(row.key) && row.amountMills === 0);
};

/** Hub's check of the wallets and Gengar's of the chats, while the report is checked and to be confirmed. */
export function checksOf(board: Board, own: boolean): RailLine[] {
  const candidate = board.candidate;
  if (candidate === null || (board.phase !== "checking" && board.phase !== "confirm")) return [];
  const hub = candidate.hub;
  const named = (state: string) => hub.pages.filter((page) => page.state === state).map((page) => page.pageLabel).join(", ");
  const out: RailLine[] = [];
  if (own && candidate.signatureDeclined === true) out.push(line("declined", "pen", "wait", "Проверка нашла изменения: проверьте и подтвердите"));
  switch (hub.state) {
    case "running": out.push(line("hub", "spin", null, "Hub сверяет суммы с кошельками")); break;
    case "matched": out.push(line("hub", "check", "ok", "Hub: суммы сошлись с кошельками")); break;
    case "found": {
      const found = allRows(board).filter((row) => row.foundByHub === true);
      out.push(line("hub", "plus", "wait", `Hub дочитал кошельки: ещё ${salesCount(hub.foundCount)}, ${plus(hub.foundMills)}`, { rows: found, link: "Показать", together: true }));
      break;
    }
    // «Можно подтвердить» only where the person can: in «Проверка» there is no «Подтверждаю» yet.
    case "unchecked":
      out.push(line("hub", "clock", "wait", `Hub не сверил ${named("unchecked")}`, { small: board.phase === "checking" ? "Сверка придёт позже." : "Можно подтвердить, сверка придёт позже." }));
      break;
    // ChatSpace reads the statement on the board's ask within a minute or two; the check lets the person confirm after 10.
    case "statement": out.push(line("hub", "spin", null, `Ждём выписку ${named("statement")}`, { small: "Не дольше 10 минут" })); break;
  }
  const gengar = candidate.gengar.state;
  const found = gengar === "found" ? gengarFoundRows(board) : [];
  if (gengar === "reading") out.push(line("gengar", "spin", null, "Генгар читает переписки", { small: "Обычно пара минут, не дольше 10" }));
  else if (gengar === "silent") out.push(line("gengar", "clock", "wait", "Генгар молчит 10 минут", { small: "Можно подтвердить по проверке Hub, его проверка придёт позже." }));
  else if (found.length > 0) out.push(line("gengar", "spark", "tint", gengarFoundWords(found), { rows: found }));
  else if (gengar === "found" || gengar === "clean") out.push(line("gengar", "check", "ok", "Генгар прочитал переписки: замечаний нет"));
  if (board.phase === "confirm") {
    const waiting = waitingRows(board);
    if (waiting.length > 0) out.push(line("waiting", "people", "wait", "Ждут ответа, в сумму не входят", { rows: waiting }));
  }
  return out;
}

/** «Генгар предложил 2 правки и 1 комментарий». */
function gengarFoundWords(rows: Row[]): string {
  const edits = rows.filter((row) => row.proposal?.kind === "owner_change").length;
  const notes = rows.length - edits;
  return `Генгар предложил ${[
    edits ? `${edits}\u00a0${plural(edits, "правку", "правки", "правок")}` : "",
    notes ? `${notes}\u00a0${plural(notes, "комментарий", "комментария", "комментариев")}` : "",
  ].filter(Boolean).join(" и ")}`;
}

/** What wants a look, each with the way to its rows. `own` — the person's own board; a reader sees what concerns all. */
export function noticesOf(board: Board, report: Report, own: boolean): RailLine[] {
  const out: RailLine[] = [];
  const rows = allRows(board);
  const editing = board.phase === "draft" || board.phase === "fixing";
  if (own) {
    const lost = editing ? rows.find(isLost) : undefined;
    if (lost) out.push(line("lost", "plus", "wait", `Нет в Hub: ${fanOf(lost)}, ${plus(lost.netMills)}.`, { rows: [lost], link: "Показать" }));
    for (const row of rows.filter((one) => one.incoming?.state === "asked")) {
      out.push(line(`in-${row.key}`, "people", "wait", `${row.incoming!.from.forms.nom} оспаривает вашу продажу ${fanOf(row)}, ${usd(row.netMills)}.`, { rows: [row], link: "Показать" }));
    }
    for (const row of rows.filter((one) => takenFromMeOpen(one) && one.incoming!.canAnswer && one.attention)) {
      out.push(line(`take-${row.key}`, "people", "wait", `${row.incoming!.from.forms.nom} записывает себе вашу продажу ${fanOf(row)}, ${usd(row.netMills)}.`, { rows: [row], link: "Показать" }));
    }
    if (editing) {
      const waiting = waitingRows(board);
      if (waiting.length > 0) out.push(line("waiting", "clock", "wait", "Ждут ответа, в сумму не входят:", { rows: waiting }));
      const bare = bareRows(board);
      if (bare.length > 0) out.push(line("bare", "note", "wait", `Без комментария: ${salesCount(bare.length)} от\u00a0$30.`, { link: "Написать", bare: true }));
    }
  }
  if (board.phase !== "counted") return out;
  if (own) {
    const late = rows.find(isLateOpen);
    if (late) out.push(line("late", "plus", "wait", `После сдачи пришла продажа ${fanOf(late)}, ${usd(late.netMills)}.`, { rows: [late], link: "Показать" }));
    const cards = rows.filter((row) => row.proposal?.state === "late");
    if (cards.length > 0) out.push(line("cards", "spark", "wait", `Генгар дочитал: ${cards.length}\u00a0${plural(cards.length, "правка", "правки", "правок")}.`, { rows: [cards[0]!], link: "Показать" }));
  }
  if (board.candidate?.gengar.state === "silent") out.push(line("silent", "clock", null, "Подтверждён по проверке Hub. Генгар дочитает позже, его проверка придёт сюда же."));
  if (own) out.push(...postLinesOf(board, report));
  return out;
}

/** The post in «Отчётность»: late, changed since its copy, not seen yet. */
function postLinesOf(board: Board, report: Report): RailLine[] {
  const post = board.post ?? null;
  const out: RailLine[] = [];
  if (post?.late && post.copiedAt === null) {
    out.push(line("post-late", "clock", "wait", `Пост за ${day(`${report.shift.reportDate}T12:00:00+03:00`)} опоздал больше чем на сутки: ledger его сам не примет`));
  }
  const changed = (post?.models ?? []).filter((model) => model.copiedAt !== null && model.changedSinceCopy);
  if (changed.length > 0 && report.posts.length > 1) {
    out.push(line("post-changed", "pen", "wait", `Пост ${changed.map((model) => model.modelName).join(", ")} изменился. Исправьте прежний пост в «Отчётности», новый не пишите`));
  } else if (post && post.copiedAt !== null && report.posts.length <= 1 && (post.changedSinceCopy || changed.length > 0)) {
    // One model: the report's own mark. Two: only a model whose post was copied (above), never one never sent.
    out.push(line("post-changed", "pen", "wait", "Пост изменился. Исправьте прежний пост в «Отчётности», новый не пишите"));
  } else if (post && post.copiedAt !== null && post.seen === false) {
    out.push(line("post-unseen", "clock", null, "Пост в «Отчётность» ещё не пришёл"));
  }
  return out;
}

/** The rail's label over the total. */
export function sumLabelOf(board: Board, own: boolean): string {
  if (board.phase === "checking" && board.candidate !== null) return `Сдано в ${clock(board.candidate.madeAt)}`;
  if (!own) return "Продаж в отчёте";
  return board.phase === "fixing" ? "Правка отчёта" : "Ваши продажи";
}

/** The line under the phase's press: what it signs, said before it is pressed (owner, 19.11), Hub's count and sum. */
export function pressLineOf(board: Board, report: Report, view: { own: boolean; preview: boolean; host: "tab" | "frame" }): string {
  if (view.preview) return "";
  if (!view.own) return `Менять этот отчёт может только ${report.shift.personName}.`;
  const what = `${salesCount(board.totals.count)} на ${usd(board.totals.nowMills)}`;
  switch (board.phase) {
    case "draft": return `Сдавая, вы подтверждаете ${what} и отвечаете за них материально.`;
    case "fixing": return `Сдавая заново, вы подтверждаете ${what}. До этого действует учтённый отчёт.`;
    case "checking":
      // The second step is easy to miss (19.11: a person closed the board while it checked and never confirmed).
      return board.candidate?.signed === true
        ? `${view.host === "frame" ? "Можно свернуть" : "Можно закрыть"}: ничего не найдём, отчёт учтётся сам. Найдём, позовём подтвердить.`
        : "Дальше «Подтверждаю»: без него отчёт не учтён.";
    case "confirm": return `Вы подтверждаете ${what} и отвечаете за них материально.`;
    default: {
      const copied = (slug: string) => board.post?.models.find((model) => model.modelSlug === slug)?.copiedAt != null;
      return report.posts.some((one) => !copied(one.modelSlug)) ? "Вставьте пост в «Отчётность». Только текст, скрины не нужны." : "Только текст, скрины не нужны.";
    }
  }
}

/** A line of «Мимо площадки»: where it stands with the owner. */
export function offPlatformStateOf(state: "pending" | "confirmed" | "rejected", pageLabel: string | null | undefined): string {
  if (state === "pending") return "ждёт подтверждения владельца";
  if (state === "confirmed") return `владелец подтвердил${pageLabel ? `: в сумме ${pageLabel}` : ""}`;
  return "владелец отклонил: в итог не входит";
}
