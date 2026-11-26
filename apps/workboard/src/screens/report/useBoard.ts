import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ShiftReportResponse } from "@agency_hub_core/contracts";
import { KernelApiError, hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { phaseConflictReport, useBoardWrite, type Write } from "./data";
import {
  agentNote,
  allRows,
  canTick,
  choiceToast,
  deciderForms,
  deciderOf,
  fanOf,
  hasMenu,
  keyOfTransaction,
  oldWayOwn,
  pickOf,
  rowByKey,
  tickChoice,
  upper,
  usd,
  type Board,
  type Choice,
  type Row,
} from "./model";
import type { PortTransport } from "./transport";
import { useBoardExtension } from "./useBoardExtension";
import { stripToastOf, type StripAct } from "./words";

/**
 * The «Отчёт» board's state and writes, in one place: what is open (the «чья» menu, a row's form, a panel), what is lit
 * and selected, and every press as Hub's write. Everything the board shows is Hub's `board`; a press is a write, and the
 * board is Hub's answer. The parts (Header, PageCard, SaleRow, OwnerMenu, Rail) only draw it and call these; the text
 * being typed stays in its field (the board is not drawn again for a letter), only its save comes here.
 *
 * In a tab there is no site under the board: no «Свернуть», and a sale's number is plain text. In the frame «Свернуть»
 * hides the frame, the number asks the extension to find the row on the site (useBoardExtension.ts).
 */

export type Host = "tab" | "frame";

/** The form of why under a row: the word chosen; the line itself is the form's own. */
export interface AskOpen { key: string; choice: Choice; initial: string }
/** «Не согласен» with Gengar's card. */
export interface RefuseOpen { key: string; proposalId: number }
/** What floats over the board besides the «чья» menu: «Ещё», its two windows, the keys. */
export type Panel = "more" | "off" | "find" | "keys" | null;

/** How long a lit row stays lit (its fade). */
const LIT_MS = 2_600;

export function useBoard({ report, host, transport, light }: {
  report: ShiftReportResponse & { board: Board };
  host: Host;
  transport: PortTransport | null;
  /** The row to light when the board opens (`?sale=`, a matter's link). */
  light: number | null;
}) {
  const board = report.board;
  const shiftId = report.shift.id;
  const own = report.access === "own";
  // The preview: Hub's flag; from an older server, whether this shift is a board shift, else the person's switch.
  const preview = own && (board.preview ?? (report.boardShift === false || report.enabled === false));
  const editing = own && !preview && (board.phase === "draft" || board.phase === "fixing");
  const write = useBoardWrite(shiftId);
  // The comment for the next shift writes apart: its save on leaving the field never holds the phase's press.
  const commentWrite = useBoardWrite(shiftId);
  const mainRef = useRef<HTMLElement>(null);

  // ── what is open ──
  const [menu, setMenu] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  /** Panel queued to open right after a phase transition (e.g. «Не вижу свою продажу» reopening a counted report). */
  const pendingPanel = useRef<Panel>(null);
  const [ask, setAsk] = useState<AskOpen | null>(null);
  /** The sale whose comment is being written; its text is the field's (`noteDraft`). */
  const [edit, setEdit] = useState<string | null>(null);
  const noteDraft = useRef("");
  const [refuse, setRefuse] = useState<RefuseOpen | null>(null);
  const [beforeOpen, setBeforeOpen] = useState<Record<string, boolean>>({});
  /** Lit rows (a link, Hub's found ones, a fresh write) for a moment, and the row the keys stand on. */
  const [lit, setLit] = useState<string[]>(light ? [keyOfTransaction(light)] : []);
  const [selected, setSelected] = useState<string | null>(null);
  /** «Подтверждаю» was refused because the board changed: what the person saw, for «было …». */
  const [seenMills, setSeenMills] = useState<number | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;

  // ── the toast ──
  const [toastText, setToastText] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const toastTimer = useRef<number | null>(null);
  const toast = useCallback((text: string) => {
    setToastText({ text, on: true });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText((one) => ({ ...one, on: false })), 2_800);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  /** A write and its toast; a failure says itself. */
  const runWith = useCallback(async (mutation: typeof write, one: Write, done?: string | null | ((answer: unknown) => string | null)): Promise<boolean> => {
    try {
      const answer = await mutation.mutateAsync(one);
      const text = typeof done === "function" ? done(answer) : done;
      if (text) toast(text);
      return true;
    } catch (error) {
      const status = hubErrorStatus(error);
      const reason = error instanceof KernelApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
      toast(reason === "claim_settled" ? "Эта продажа уже решена: изменить её может только решающий"
        : reason === "card_dispute" ? "Продажа ждёт решающего. Передумали? Нажмите «Вернуть правку»"
        : reason === "sale_not_matched" ? "Не удалось точно найти продажу. Укажите номер транзакции или точные данные фана и сумму."
        : reason === "already_decided" ? "По этой продаже уже есть решение владельца"
        : phaseConflictReport(error) !== null ? "Сейчас это не меняется: доска обновилась"
        : status === 401 && host === "frame" ? "ChatGoose не вошёл в Hub: войдите в расширении"
        : status === null || status >= 500 ? "Hub не ответил: неизвестно, сохранилось ли" : "Не получилось. Hub вернул ошибку");
      return false;
    }
  }, [toast, host]);
  const run = useCallback((one: Write, done?: string | null | ((answer: unknown) => string | null)) => runWith(write, one, done), [runWith, write]);

  // ── the comment for the next shift: each field registers its save, the phase's presses wait for it ──
  const memoFlushes = useRef(new Set<() => Promise<unknown>>());
  const saveComment = useCallback((comment: string, modelSlug: string | null) =>
    runWith(commentWrite, modelSlug === null ? { op: "comment", comment } : { op: "comment", comment, modelSlug }), [runWith, commentWrite]);
  const flushMemos = useCallback(() => Promise.all([...memoFlushes.current].map((flush) => flush())), []);

  // ── scrolling to a row ──
  const reveal = useCallback((key: string, how: "center" | "near") => {
    const main = mainRef.current;
    const element = main?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
    if (!main || !element) return;
    const box = element.getBoundingClientRect();
    const view = main.getBoundingClientRect();
    if (how === "near") {
      // The keys move a row at a time: scroll only as far as it takes to see it whole.
      if (box.top < view.top + 72) main.scrollTop -= view.top + 72 - box.top;
      else if (box.bottom > view.bottom - 24) main.scrollTop += box.bottom - view.bottom + 24;
      return;
    }
    const y = box.top - view.top + main.scrollTop - Math.max(80, (main.clientHeight - element.offsetHeight) / 2);
    main.scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? "auto" : "smooth" });
  }, []);
  const pendingReveal = useRef<string | null>(light ? keyOfTransaction(light) : null);
  useLayoutEffect(() => {
    const key = pendingReveal.current;
    if (key === null) return;
    pendingReveal.current = null;
    reveal(key, "center");
  });
  // A lit row fades and is ordinary again: its hover and the keys' fill come back.
  useEffect(() => {
    if (lit.length === 0) return;
    const timer = window.setTimeout(() => setLit([]), LIT_MS);
    return () => window.clearTimeout(timer);
  }, [lit]);

  /** Light a row and bring it into view, its folded group opened. */
  const show = useCallback((key: string) => {
    const row = rowByKey(board, key);
    if (!row) return;
    setMenu(null);
    setLit([key]);
    setSelected(key);
    if (row.before !== null) setBeforeOpen((open) => ({ ...open, [row.pageLabel]: true }));
    pendingReveal.current = key;
  }, [board]);
  /** Light several rows (Hub's found ones) and go to the first. */
  const showMany = useCallback((keys: string[]) => {
    const rows = keys.map((key) => rowByKey(board, key)).filter((row): row is Row => row !== null);
    if (rows.length === 0) return;
    setMenu(null);
    setLit(rows.map((row) => row.key));
    pendingReveal.current = rows[0]!.key;
  }, [board]);
  /**
   * A row a write is adding (a sale from «Найти продажу»): shown when Hub's board has it. The press's own `show` is
   * bound to the board before the write, where the row is not yet.
   */
  const pendingShow = useRef<string | null>(null);
  const showLater = useCallback((key: string) => {
    pendingShow.current = key;
  }, []);
  useEffect(() => {
    const key = pendingShow.current;
    if (key === null || rowByKey(board, key) === null) return;
    pendingShow.current = null;
    show(key);
  }, [board, show]);
  // A link to a row (`?sale=`, a matter's link): opens its folded group if it is there, lights and scrolls to it.
  useEffect(() => {
    if (light) show(keyOfTransaction(light));
    // Once, on the board the link opened.
  }, []);

  const { hidden, miss, setMiss } = useBoardExtension({ transport, shiftId, board, show, toast });

  // Gengar's late reading after «по проверке Hub»: «замечаний нет» clears the waiting line.
  const gengarWas = useRef(board.candidate?.gengar.state ?? null);
  useEffect(() => {
    const now = board.candidate?.gengar.state ?? null;
    if (board.phase === "counted" && gengarWas.current === "silent" && now === "clean") toast("Генгар дочитал: замечаний нет");
    gengarWas.current = now;
  }, [board.phase, board.candidate?.gengar.state, toast]);
  // A new phase closes what belonged to the old one: the windows, the menu, the forms of a draft.
  useEffect(() => {
    const next = pendingPanel.current;
    pendingPanel.current = null;
    setPanel(next);
    setMenu(null);
    setAsk(null);
    if (board.phase !== "confirm") setRefuse(null);
    // «Было …» lives while the board waits for the second press.
    if (board.phase !== "confirm") setSeenMills(null);
  }, [board.phase]);
  // The menu of a row that cannot change any more (Hub's answer, a colleague's word) closes.
  const menuRow = menu === null ? null : rowByKey(board, menu);
  useEffect(() => {
    if (menu !== null && (menuRow === null || !hasMenu(board, menuRow, preview))) setMenu(null);
  }, [board, menu, menuRow, preview]);

  // ── comments ──
  /** Save the open comment: an empty one deletes it. The word of the sale is not sent: Hub keeps it as it stands. */
  const commitNote = useCallback(async () => {
    const open = editRef.current;
    if (open === null) return;
    setEdit(null);
    const row = rowByKey(board, open);
    if (!row || row.transactionId === null) return;
    const text = noteDraft.current.trim();
    const was = row.note?.by === "person" ? row.note.text : "";
    const agent = agentNote(row);
    if (text === was || (was === "" && agent !== null && text === agent)) return;
    await run({ op: "line", transactionId: row.transactionId, body: { note: text === "" ? null : text } });
  }, [board, run]);
  const openNote = useCallback((key: string, draft?: string) => {
    const row = rowByKey(board, key);
    if (!row) return;
    if (editRef.current === key) {
      void commitNote();
      return;
    }
    void commitNote();
    setAsk(null);
    setMenu(null);
    setSelected(key);
    noteDraft.current = draft ?? row.note?.text ?? agentNote(row) ?? "";
    setEdit(key);
  }, [board, commitNote]);
  const cancelNote = useCallback(() => {
    const open = editRef.current;
    setEdit(null);
    if (open !== null) focusRow(open);
  }, []);

  // ── the menu, the tick, the questions ──
  const unask = useCallback((row: Row) => {
    if (row.transactionId === null) return Promise.resolve(false);
    return run({ op: "unask", transactionId: row.transactionId }, stripToastOf(board, row, "unask"));
  }, [run, board]);

  const apply = async (row: Row, choice: Choice) => {
    setMenu(null);
    if (row.transactionId === null) return;
    const pick = pickOf(row, choice);
    if (pick === "none") return;
    if (pick === "unask") {
      await unask(row);
      return;
    }
    // A question, «Моя» without a line of why yet, a word the decider decides: the line of why first.
    const note = personNote(row);
    if (choice.needsWhy && !(choice.question === null && choice.line.statement === "mine" && note !== null)) {
      await commitNote();
      setAsk({ key: row.key, choice, initial: choice.asks?.to === "decider" && choice.question === null ? note ?? "" : "" });
      return;
    }
    setAsk((one) => (one?.key === row.key ? null : one));
    // The word alone: Hub keeps the sale's comment as it stands.
    await run({ op: "line", transactionId: row.transactionId, body: { ...choice.line } }, choiceToast(board, row, choice));
  };

  const tick = async (row: Row) => {
    if (!canTick(board, row, preview) || row.transactionId === null) return;
    if (row.ask !== null && (row.ask.state === "asked" || row.ask.taken === true) && !oldWayOwn(row)) {
      await unask(row);
      return;
    }
    if (ask?.key === row.key) {
      setAsk(null);
      return;
    }
    const choice = tickChoice(row);
    if (choice) await apply(row, choice);
  };

  const sendAsk = async (text: string) => {
    if (ask === null) return;
    const row = rowByKey(board, ask.key);
    const why = text.trim();
    if (!row || row.transactionId === null || why === "") return;
    const question = ask.choice.question;
    if (question === null) {
      if (await run({ op: "line", transactionId: row.transactionId, body: { ...ask.choice.line, note: why } }, choiceToast(board, row, ask.choice))) setAsk(null);
      return;
    }
    const asks = ask.choice.asks;
    const transactionId = row.transactionId;
    const ok = await run({ op: "ask", transactionId, statement: question.statement, shareWithUserId: question.shareWithUserId, note: why },
      asks?.to !== "colleague" ? `Вопрос ушёл ${deciderForms(board, row)?.dat ?? "владельцу"}`
        // A colleague with the board is told, not asked: the sale is written at once (owner, 2026-11-21), unless Hub
        // sent the word to the decider (their day is already paid, someone took the sale meanwhile): the row's own
        // words say which, never «Записано вам».
        : (answer) => {
          const fresh = boardOfAnswer(answer);
          const now = fresh === null ? undefined : allRows(fresh).find((one) => one.transactionId === transactionId);
          if (now?.ask != null && now.ask.taken !== true && now.reasonWords !== "") return upper(now.reasonWords);
          return `${question.statement === "share" ? "Записано пополам" : "Записано вам"}. ${asks.forms?.nom ?? "Коллега"} узнает`;
        });
    if (ok) setAsk(null);
  };

  /** A strip's press: take the question back, or answer a colleague's word. */
  const answer = (row: Row, act: StripAct) => {
    if (act === "unask") {
      void unask(row);
      return;
    }
    const claimId = row.incoming?.claimId;
    if (claimId === undefined) return;
    void run({ op: "claim", claimId, answer: act === "disagree" ? "disagree" : "agree" }, stripToastOf(board, row, act));
  };

  /** «Не согласен» with Gengar's card: the one line of why, for whoever decides the sale. */
  const sendRefuse = async (text: string) => {
    if (refuse === null) return;
    const row = rowByKey(board, refuse.key);
    const why = text.trim();
    if (!row || why === "") return;
    if (await run({ op: "proposal", proposalId: refuse.proposalId, answer: "decline", note: why }, `Спор решит ${deciderOf(board, row).words}`)) setRefuse(null);
  };

  // ── the site ──
  /** Show the sale on the site under the frame: the extension finds the row; the frame hides until `show`. */
  const find = (row: Row) => {
    if (host !== "frame" || transport === null) return;
    void commitNote();
    setMenu(null);
    setMiss(null);
    setSelected(row.key);
    hidden.current = true;
    transport.post({ t: "find", sale: {
      transactionId: row.transactionId, pageLabel: row.pageLabel, platform: row.platform, platformRef: row.platformRef, kind: row.kind,
      occurredAt: row.occurredAt, netMills: row.netMills, grossMills: row.grossMills, fanName: row.fan.name, fanHandle: row.fan.username,
    } });
  };

  const collapse = useCallback(() => {
    void commitNote();
    void flushMemos();
    setMenu(null);
    setPanel(null);
    hidden.current = true;
    transport?.post({ t: "collapse" });
  }, [commitNote, flushMemos, transport, hidden]);

  // ── the phase's presses ──
  /** «Сдать смену» / «Сдать заново» with what the rail shows: equal to the report, it is the person's signature. */
  const submit = async () => {
    // ⌘Enter as well as the button: never a second hand-in while one is on its way.
    if (write.isPending) return;
    const seen = { seenTotalMills: board.totals.nowMills, seenCount: board.totals.count };
    await Promise.all([commitNote(), flushMemos()]);
    await run({ op: "submit", ...seen });
  };

  /**
   * «Подтверждаю» signs one exact candidate and what the person saw (the rail's total and count). A board that changed
   * is refused with the fresh one: the person sees «было …» and presses again; never pressed by itself.
   */
  const confirm = async () => {
    const candidate = board.candidate;
    if (candidate === null || !board.canConfirm || !own || preview || write.isPending) return;
    const seen = { total: board.totals.nowMills, count: board.totals.count };
    await commitNote();
    try {
      const answer = await write.mutateAsync({ op: "confirm", candidateId: candidate.id, seenTotalMills: seen.total, seenCount: seen.count });
      const { confirmed, refused } = answer as { confirmed: boolean; refused: string | null };
      setSeenMills(!confirmed && (refused === "changed" || refused === "superseded") ? seen.total : null);
      toast(confirmed ? "Отчёт учтён" : refused === "changed" || refused === "superseded" ? "Отчёт изменился: проверьте его и подтвердите снова" : "Отчёт пока нельзя подтвердить");
    } catch (error) {
      const status = hubErrorStatus(error);
      toast(status === null || status >= 500 ? "Hub не ответил: неизвестно, учтён ли отчёт" : "Не получилось. Hub вернул ошибку");
    }
  };

  const reopen = async (): Promise<boolean> => {
    await Promise.all([commitNote(), flushMemos()]);
    return run({ op: "reopen" });
  };

  /** «Не вижу свою продажу»: opens «Найти продажу» right away, reopening a counted/confirm report first when needed. */
  const openFind = async () => {
    if (!own || preview || write.isPending) return;
    if (board.phase === "draft" || board.phase === "fixing") {
      setMenu(null);
      setPanel("find");
      return;
    }
    if (board.phase === "counted" || board.phase === "confirm") {
      pendingPanel.current = "find";
      const ok = await reopen();
      if (!ok) pendingPanel.current = null;
    }
  };

  /** «Скопировать пост» of one model: only that model's text, never the posts joined («Отчётность» reads one model a post). */
  const copyPost = useCallback((modelSlug: string) => {
    const post = report.posts.find((one) => one.modelSlug === modelSlug) ?? null;
    const text = post?.text ?? "";
    if (post === null || text === "") {
      toast("Поста пока нет: он появится, когда отчёт учтён");
      return;
    }
    const ok = () => {
      // Two models: two messages. «Отчётность» (the ledger's reader) takes one model from a message, never a second.
      toast(report.posts.length > 1 ? `Пост ${post.modelName} скопирован: отправьте его в «Отчётность» отдельным сообщением` : "Пост скопирован, вставьте его в «Отчётность»");
      // Hub remembers the copy of this model's post; its failure changes nothing the person sees.
      write.mutateAsync({ op: "postCopied", model: modelSlug }).catch(() => {});
    };
    const refused = () => toast("Не получилось скопировать: браузер не дал доступ к буферу");
    const here = () => void copyHere(text).then((done) => (done ? ok() : refused()));
    if (transport) void transport.copy(text).then((done) => (done ? ok() : here()));
    else here();
  }, [report.posts, toast, transport, write]);

  /** Add a «нет в Hub» row to the report, or a sale after the hand-in to the counted one («Досдать»). */
  const addSighting = (row: Row) => {
    if (row.sighting === null) return;
    setLit([row.key]);
    void run({ op: "sighting", sightingId: row.sighting.id }, "Добавлено в отчёт");
  };
  const resend = (row: Row) => {
    if (row.transactionId === null) return;
    setLit([row.key]);
    void run({ op: "resend", transactionIds: [row.transactionId] }, `Досдано: ${fanOf(row)} ${usd(row.netMills)} в отчёте`);
  };

  return {
    board, report, host, own, preview, editing, pending: write.isPending, seenMills, mainRef,
    menu, menuRow, setMenu, panel, setPanel, ask, setAsk, edit, noteDraft, cancelNote, refuse, setRefuse, beforeOpen, setBeforeOpen,
    lit, selected, setSelected, miss,
    toastText, toast, run, show, showLater, showMany, reveal,
    commitNote, openNote, unask, apply, tick, sendAsk, answer, sendRefuse, find, collapse, submit, confirm, reopen, openFind, copyPost, addSighting, resend,
    memoFlushes, saveComment, flushMemos,
  };
}

export type BoardApi = ReturnType<typeof useBoard>;

/** The focus back on a row (a field of it closed by Esc): the keys go on from it. */
export function focusRow(key: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }));
}

/** The person's own comment of a row: a line of why already said. */
const personNote = (row: Row) => (row.note?.by === "person" ? row.note.text : null);

/** The board a write's answer carries (the fresh report), if it does. */
function boardOfAnswer(answer: unknown): Board | null {
  if (typeof answer !== "object" || answer === null || !("board" in answer)) return null;
  return (answer as { board: Board | null }).board ?? null;
}

export function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function copyHere(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // the clipboard was refused: the old way below
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;left:-999px;top:0";
  document.body.appendChild(area);
  area.select();
  let done: boolean;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  area.remove();
  return done;
}
