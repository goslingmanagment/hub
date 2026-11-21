import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  frameState,
  keyOfOwner,
  keyOfTransaction,
  rowByKey,
  tickChoice,
  upper,
  usd,
  type Board,
  type Choice,
  type Row,
} from "./model";
import type { PortTransport } from "./transport";

/**
 * The «Отчёт» board's state and writes, in one place: what is open (the «чья» menu, a row's form, a panel), what is lit
 * and selected, and every press as Hub's write. Everything the board shows is Hub's `board`; a press is a write, and the
 * board is Hub's answer. The parts (Header, PageCard, SaleRow, OwnerMenu, Rail) only draw it and call these.
 *
 * In a tab there is no site under the board: no «Свернуть», and a sale's number is plain text. In the frame «Свернуть»
 * hides the frame, the number asks the extension to find the row on the site, and every change of phase or totals goes
 * to the extension's bar.
 */

export type Host = "tab" | "frame";

/** «Почему продажа ваша?» under a row: the word chosen and the line of why. */
export interface AskDraft { key: string; choice: Choice; text: string }
/** A sale's comment being written. */
export interface NoteDraft { key: string; draft: string }
/** «Не согласен» with Gengar's card: the one line of why, sent to whoever decides the sale. */
export interface RefuseDraft { key: string; proposalId: number; text: string }
/** What floats over the board besides the «чья» menu: «Ещё», its two panels, the keys. */
export type Panel = "more" | "off" | "find" | "keys" | null;

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
  const mainRef = useRef<HTMLElement>(null);

  // ── what is open ──
  const [menu, setMenu] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [ask, setAsk] = useState<AskDraft | null>(null);
  const [edit, setEdit] = useState<NoteDraft | null>(null);
  const [refuse, setRefuse] = useState<RefuseDraft | null>(null);
  const [beforeOpen, setBeforeOpen] = useState<Record<string, boolean>>({});
  /** Lit rows (a link, Hub's found ones, a fresh write), and the row the keys stand on. */
  const [lit, setLit] = useState<string[]>(light ? [keyOfTransaction(light)] : []);
  const [selected, setSelected] = useState<string | null>(null);
  /** The site could not find the row: a quiet line under it until the person's next action. */
  const [miss, setMiss] = useState<{ key: string | null; words: string } | null>(null);
  /** «Подтверждаю» was refused because the board changed: what the person saw, for «Было …». */
  const [seenMills, setSeenMills] = useState<number | null>(null);
  /** The frame is hidden by the extension (after «Свернуть» or a sale's number) until it says `show`. */
  const hidden = useRef(false);
  const missToast = useRef<string | null>(null);
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

  const run = useCallback(async (one: Write, done?: string | null | ((answer: unknown) => string | null)): Promise<boolean> => {
    try {
      const answer = await write.mutateAsync(one);
      const text = typeof done === "function" ? done(answer) : done;
      if (text) toast(text);
      return true;
    } catch (error) {
      const status = hubErrorStatus(error);
      const reason = error instanceof KernelApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
      toast(reason === "claim_settled" ? "Эта продажа уже решена: изменить её может только решающий"
        : reason === "card_dispute" ? "Продажа ждёт решающего. Передумали? Нажмите «Вернуть правку»"
        : phaseConflictReport(error) !== null ? "Сейчас это не меняется: доска обновилась"
        : status === 401 && host === "frame" ? "ChatGoose не вошёл в Hub: войдите в расширении"
        : status === null || status >= 500 ? "Hub не ответил: неизвестно, сохранилось ли" : "Не получилось. Hub вернул ошибку");
      return false;
    }
  }, [write, toast, host]);

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
  // A link to a row (`?sale=`, a matter's link): opens its folded group if it is there, lights and scrolls to it.
  useEffect(() => {
    if (light) show(keyOfTransaction(light));
    // Once, on the board the link opened.
  }, []);

  // ── the extension ──
  useEffect(() => {
    if (!transport) return;
    return transport.on((message) => {
      if (message.t === "show") {
        hidden.current = false;
        if (typeof message.transactionId === "number") show(keyOfTransaction(message.transactionId));
        // What the site did not find is said once the board is seen again.
        if (missToast.current !== null) {
          toast(missToast.current);
          missToast.current = null;
        }
      } else if (message.t === "found" && !message.ok && message.words) {
        // The extension could not find the row on the site: a toast when the board is visible, and a quiet line under
        // the row until the person's next action. `ok: true` needs nothing.
        const words = message.words;
        setMiss({ key: message.transactionId === null ? null : keyOfTransaction(message.transactionId), words });
        if (hidden.current) missToast.current = words;
        else toast(words);
      }
    });
  }, [transport, show, toast]);
  // The quiet line «Строка на сайте не найдена…» leaves with the next action on the visible board.
  useEffect(() => {
    if (miss === null) return;
    const clear = () => {
      if (!hidden.current) setMiss(null);
    };
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("keydown", clear, true);
    return () => {
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("keydown", clear, true);
    };
  }, [miss]);
  // What the extension's bar shows: sent on every change of phase or totals.
  const state = useMemo(() => JSON.stringify(frameState(shiftId, board)), [shiftId, board]);
  useEffect(() => {
    transport?.post(JSON.parse(state) as ReturnType<typeof frameState>);
  }, [transport, state]);
  // An OnlyFans page that waits for ChatSpace's statement: ask the extension to read it again, once per candidate.
  const statementAsked = useRef<number | null>(null);
  useEffect(() => {
    const candidate = board.candidate;
    if (!transport || !candidate || statementAsked.current === candidate.id) return;
    const pages = candidate.hub.pages.filter((page) => page.state === "statement").map((page) => page.pageLabel);
    if (pages.length === 0) return;
    statementAsked.current = candidate.id;
    transport.post({ t: "statement", pages });
  }, [transport, board.candidate]);
  // Gengar's late reading after «по проверке Hub»: «замечаний нет» clears the waiting line.
  const gengarWas = useRef(board.candidate?.gengar.state ?? null);
  useEffect(() => {
    const now = board.candidate?.gengar.state ?? null;
    if (board.phase === "counted" && gengarWas.current === "silent" && now === "clean") toast("Генгар дочитал: замечаний нет");
    gengarWas.current = now;
  }, [board.phase, board.candidate?.gengar.state, toast]);
  // «Было …» lives while the board waits for the second press.
  useEffect(() => {
    if (board.phase !== "confirm") setSeenMills(null);
  }, [board.phase]);

  // ── comments ──
  /** Save the open comment: an empty one deletes it. */
  const commitNote = useCallback(async () => {
    const open = editRef.current;
    if (open === null) return;
    setEdit(null);
    const row = rowByKey(board, open.key);
    if (!row || row.transactionId === null) return;
    const text = open.draft.trim();
    const was = row.note?.by === "person" ? row.note.text : "";
    const agent = agentNote(row);
    if (text === was || (was === "" && agent !== null && text === agent)) return;
    await run({ op: "line", transactionId: row.transactionId, body: { ...lineOf(row), note: text === "" ? null : text } });
  }, [board, run]);
  const openNote = useCallback((key: string, draft?: string) => {
    const row = rowByKey(board, key);
    if (!row) return;
    if (editRef.current?.key === key) {
      void commitNote();
      return;
    }
    void commitNote();
    setAsk(null);
    setMenu(null);
    setSelected(key);
    setEdit({ key, draft: draft ?? (row.note?.text ?? agentNote(row) ?? "") });
  }, [board, commitNote]);

  // ── the menu, the tick, the questions ──
  const unask = useCallback((row: Row) => {
    if (row.transactionId === null) return Promise.resolve(false);
    return run({ op: "unask", transactionId: row.transactionId }, row.ask?.taken === true ? takenBack(row) : "Вопрос отменён");
  }, [run]);

  const apply = async (row: Row, choice: Choice) => {
    setMenu(null);
    if (row.transactionId === null) return;
    const asking = row.ask !== null && row.ask.state === "asked";
    if ((asking || row.ask?.taken === true) && choice.key === keyOfOwner(row.owner)) {
      await unask(row);
      return;
    }
    // A word that makes the person's share larger on someone else's sale takes one line of why (the server refuses it
    // without): the same field, and with no one to ask the sale is taken at once.
    if (choice.question !== null || (choice.line.statement === "mine" && personNote(row) === null)) {
      await commitNote();
      setAsk((one) => ({ key: row.key, choice, text: one?.key === row.key ? one.text : "" }));
      return;
    }
    setAsk((one) => (one?.key === row.key ? null : one));
    await run({ op: "line", transactionId: row.transactionId, body: { ...choice.line, note: personNote(row) } }, choiceToast(board, row, choice));
  };

  const tick = async (row: Row) => {
    if (!canTick(board, row, preview) || row.transactionId === null) return;
    if (row.ask !== null && (row.ask.state === "asked" || row.ask.taken === true)) {
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

  const sendAsk = async () => {
    if (ask === null) return;
    const row = rowByKey(board, ask.key);
    const text = ask.text.trim();
    if (!row || row.transactionId === null || text === "") return;
    const question = ask.choice.question;
    if (question === null) {
      const taken = await run({ op: "line", transactionId: row.transactionId, body: { ...ask.choice.line, note: text } }, choiceToast(board, row, ask.choice));
      if (taken) setAsk(null);
      return;
    }
    const asks = ask.choice.asks;
    const transactionId = row.transactionId;
    const ok = await run({ op: "ask", transactionId, statement: question.statement, shareWithUserId: question.shareWithUserId, note: text },
      asks?.to !== "colleague" ? `Вопрос ушёл ${deciderForms(board, row)?.dat ?? "владельцу"}`
        // A colleague with the board is told, not asked: the sale is written at once (owner, 2026-11-21), unless Hub
        // sent the word to the decider (their day is already paid, someone took the sale meanwhile): the row's own
        // words say which, never «Записано вам».
        : (answer) => {
          const fresh = boardOfAnswer(answer);
          const now = fresh === null ? undefined : allRows(fresh).find((one) => one.transactionId === transactionId);
          if (now?.ask != null && now.ask.taken !== true && now.reasonWords !== "") return upper(now.reasonWords);
          return `${question.statement === "share" ? "Записано пополам" : "Записано вам"}. ${asks.forms?.nom ?? ""} узнает`;
        });
    if (ok) setAsk(null);
  };

  const sendRefuse = async () => {
    if (refuse === null) return;
    const row = rowByKey(board, refuse.key);
    const text = refuse.text.trim();
    if (!row || text === "") return;
    if (await run({ op: "proposal", proposalId: refuse.proposalId, answer: "decline", note: text }, `Спор решит ${deciderOf(board, row).words}`)) setRefuse(null);
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
    setMenu(null);
    setPanel(null);
    hidden.current = true;
    transport?.post({ t: "collapse" });
  }, [commitNote, transport]);

  // ── the phase's presses ──
  /** «Сдать смену» / «Сдать заново» with what the rail shows: equal to the report, it is the person's signature. */
  const submit = async () => {
    const seen = { seenTotalMills: board.totals.nowMills, seenCount: board.totals.count };
    await commitNote();
    await run({ op: "submit", ...seen });
  };

  /**
   * «Подтверждаю» signs one exact candidate and what the person saw (the rail's total and count). A board that changed
   * is refused with the fresh one: the person sees «было …» and presses again; never pressed by itself.
   */
  const confirm = async () => {
    const candidate = board.candidate;
    if (candidate === null || !board.canConfirm) return;
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

  const reopen = async () => {
    await commitNote();
    await run({ op: "reopen" });
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
    void run({ op: "resend", transactionIds: [row.transactionId] }, `Досдано: ${row.fan.name ?? ""} ${usd(row.netMills)} в отчёте`);
  };

  return {
    board, report, host, own, preview, editing, pending: write.isPending, seenMills, mainRef,
    menu, setMenu, panel, setPanel, ask, setAsk, edit, setEdit, refuse, setRefuse, beforeOpen, setBeforeOpen,
    lit, selected, setSelected, miss,
    toastText, toast, run, show, showMany, reveal,
    commitNote, openNote, unask, apply, tick, sendAsk, sendRefuse, find, collapse, submit, confirm, reopen, copyPost, addSighting, resend,
  };
}

export type BoardApi = ReturnType<typeof useBoard>;

/** The row's current word as a line's body: kept when only its comment changes. */
function lineOf(row: Row) {
  return {
    statement: row.statement,
    shareWithUserId: row.statement === "share" ? row.owner.userId : null,
    toUserId: row.statement === "give" ? row.owner.userId : null,
  };
}

/** The person's own comment of a row, sent along with a new word so the word does not drop it. */
const personNote = (row: Row) => (row.note?.by === "person" ? row.note.text : null);
/** A take given back: «Продажа снова Олега». */
const takenBack = (row: Row) => `Продажа снова ${row.ask?.toUser?.forms.gen ?? row.rule.owner.words}`;

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
