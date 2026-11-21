import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { SHIFT_REPORT_QUICK_WORDS, type ShiftReportResponse } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { KernelApiError, hubErrorStatus } from "@agency_hub_core/ui/hubClient";
import { shiftPath } from "@/shared/links";
import { BoardBar } from "./BoardBar";
import { phaseConflictReport, useBoardWrite, type Write } from "./data";
import { Ico } from "./icons";
import {
  agentNote,
  beforeWords,
  choiceToast,
  choicesOf,
  clock,
  frameState,
  keyOfOwner,
  keyOfTransaction,
  offShiftOf,
  otherShiftWords,
  ownerWord,
  plus,
  reasonLook,
  rowByKey,
  signed,
  tickChoice,
  tickLook,
  titleOf,
  upper,
  usd,
  wantsNote,
  type Board,
  type Choice,
  type Row,
} from "./model";
import type { PortTransport } from "./transport";
import "./board.css";

/**
 * The «Отчёт» board (package R): one component, in a Workboard tab (`/report/:shiftId`, the cookie session) and in the
 * extension's frame over the site (`/frame/report`, the port). The approved prototype is its specification
 * (8-docs/2026-11-13-products/report-panel-mockups/columns.html): a column per page of the shift, rows as the sites'
 * lists, the tick «в моём отчёте», the word «чья» with its menu, comments, questions, Gengar's cards, and the bar of
 * each phase. Everything it shows is Hub's `board`; a press is a write, and the board is Hub's answer.
 *
 * In a tab there is no site under the board: no «Свернуть», and a sale's number is plain text. In the frame
 * «Свернуть» hides the frame, the number asks the extension to find the row on the site, and every change of phase
 * or totals goes to the extension's bar.
 */

export type Host = "tab" | "frame";

export interface BoardActions {
  board: Board;
  report: ShiftReportResponse;
  own: boolean;
  /** The person's own board before they hand in on it (`submits_shift` off): read only, the old notice in the bar. */
  preview: boolean;
  /** «Подтверждаю» was refused because the board changed: what the person saw, for «Было …, стало …». */
  seenMills: number | null;
  /** Light rows (Hub's found ones) and scroll to the first. */
  showMany: (keys: string[]) => void;
  host: Host;
  pending: boolean;
  run: (write: Write, done?: string | null) => Promise<boolean>;
  toast: (text: string) => void;
  show: (key: string) => void;
  commitNote: () => Promise<void>;
  openNote: (key: string, draft?: string) => void;
  /** «Скопировать пост» of one model: only that model's text, never the posts joined («Отчётность» reads one model a post). */
  copyPost: (modelSlug: string) => void;
  collapse: () => void;
  confirm: (candidateId: number) => Promise<void>;
}

/** Ticks and «чья» change only while the report is a draft (or a correction), never in a preview. */
export const canTick = (row: Row, board: Board, preview: boolean) =>
  row.editable && !preview && (board.phase === "draft" || board.phase === "fixing");

const QUICK = SHIFT_REPORT_QUICK_WORDS;

export function ReportBoard({ report, host, transport, light }: {
  report: ShiftReportResponse & { board: Board };
  host: Host;
  transport?: PortTransport | null;
  /** The row to light when the board opens (`?sale=`, a matter's link). */
  light?: number | null;
}) {
  const board = report.board;
  const shiftId = report.shift.id;
  const own = report.access === "own";
  // The preview: Hub's flag; from an older server, whether this shift is a board shift, else the person's switch.
  const preview = own && (board.preview ?? (report.boardShift === false || report.enabled === false));
  const write = useBoardWrite(shiftId);
  const [seenMills, setSeenMills] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ key: string; choice: Choice; text: string } | null>(null);
  const [edit, setEdit] = useState<{ key: string; draft: string } | null>(null);
  /** «Это моё» on a nobody's sale before the shift: its one line of why. */
  const [claimForm, setClaimForm] = useState<{ key: string; text: string } | null>(null);
  /** «Не согласен» with a card of Gengar: the one line of why, sent with it to whoever decides the sale. */
  const [refuse, setRefuse] = useState<{ key: string; proposalId: number; text: string } | null>(null);
  /** The frame is hidden by the extension (after «Свернуть» or a sale's number) until it says `show`. */
  const hidden = useRef(false);
  const missToast = useRef<string | null>(null);
  const [miss, setMiss] = useState<{ key: string | null; words: string } | null>(null);
  const [lit, setLit] = useState<string[]>(light ? [keyOfTransaction(light)] : []);
  const setHl = useCallback((key: string | null) => setLit(key === null ? [] : [key]), []);
  const [beforeOpen, setBeforeOpen] = useState<Record<string, boolean>>({});
  const [toastText, setToastText] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const toastTimer = useRef<number | null>(null);
  const editRef = useRef(edit);
  editRef.current = edit;

  const toast = useCallback((text: string) => {
    setToastText({ text, on: true });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText((one) => ({ ...one, on: false })), 2_600);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  const run = useCallback(async (one: Write, done?: string | null): Promise<boolean> => {
    try {
      await write.mutateAsync(one);
      if (done) toast(done);
      return true;
    } catch (error) {
      const status = hubErrorStatus(error);
      const reason = error instanceof KernelApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
      toast(reason === "claim_settled" ? "Эта продажа уже решена: изменить её может только решающий"
        : reason === "card_dispute" ? "Продажа ждёт решающего. Передумали — нажмите «Вернуть правку»"
        : phaseConflictReport(error) !== null ? "Сейчас это не меняется: доска обновилась"
        : status === 401 && host === "frame" ? "ChatGoose не вошёл в Hub: войдите в расширении"
        : status === null || status >= 500 ? "Hub не ответил: неизвестно, сохранилось ли" : "Не получилось. Hub вернул ошибку");
      return false;
    }
  }, [write, toast, host]);

  /** Scroll the row into view in its column (the prototype's `revealBoard`). */
  const reveal = useCallback((key: string, smooth: boolean) => {
    const root = rootRef.current;
    const element = root?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
    const cols = colsRef.current;
    if (!element || !cols) return;
    const body = element.closest<HTMLElement>(".cb");
    const column = element.closest<HTMLElement>(".col");
    if (!body || !column) return;
    const columnBox = column.getBoundingClientRect();
    const view = cols.getBoundingClientRect();
    if (columnBox.left < view.left || columnBox.right > view.right) cols.scrollLeft += columnBox.left - view.left - Math.max(0, (view.width - columnBox.width) / 2);
    const y = element.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - Math.max(12, (body.clientHeight - element.offsetHeight) / 2);
    body.scrollTo({ top: Math.max(0, y), behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }, []);

  const pendingReveal = useRef<{ key: string; smooth: boolean } | null>(light ? { key: keyOfTransaction(light), smooth: false } : null);
  const show = useCallback((key: string) => {
    const row = rowByKey(board, key);
    if (!row) return;
    setMenu(null);
    setHl(key);
    if (row.before !== null) setBeforeOpen((open) => ({ ...open, [row.pageLabel]: true }));
    pendingReveal.current = { key, smooth: true };
  }, [board, setHl]);
  const showMany = useCallback((keys: string[]) => {
    const rows = keys.map((key) => rowByKey(board, key)).filter((row): row is Row => row !== null);
    if (rows.length === 0) return;
    setMenu(null);
    setLit(rows.map((row) => row.key));
    pendingReveal.current = { key: rows[0]!.key, smooth: true };
  }, [board]);
  // A link to a row (`?sale=`, a matter's link): opens its folded group if it is there, lights and scrolls to it.
  useEffect(() => {
    if (light) show(keyOfTransaction(light));
    // Once, on the board the link opened.
  }, []);
  useLayoutEffect(() => {
    const next = pendingReveal.current;
    if (next === null) return;
    pendingReveal.current = null;
    reveal(next.key, next.smooth);
  });

  // A light from outside: the extension's «К отчёту» (`show`).
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

  /** Save the open comment (the prototype's `commitNote`): an empty one deletes it. */
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
    setAsk(null);
    setEdit({ key, draft: draft ?? (row.note?.text ?? agentNote(row) ?? "") });
  }, [board]);

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
    if (transport) {
      void transport.copy(text).then((done) => (done ? ok() : copyHere(text).then((here) => (here ? ok() : toast("Не получилось скопировать: браузер не дал доступ к буферу")))));
      return;
    }
    void copyHere(text).then((done) => (done ? ok() : toast("Не получилось скопировать: браузер не дал доступ к буферу")));
  }, [report.posts, toast, transport, write]);

  const collapse = useCallback(() => {
    void commitNote();
    setMenu(null);
    hidden.current = true;
    transport?.post({ t: "collapse" });
  }, [commitNote, transport]);

  /**
   * «Подтверждаю» signs one exact candidate and what the person saw (the bar's total and count). A board that changed
   * is refused with the fresh one: the person sees «Было …, стало …» and presses again; never pressed by itself.
   */
  const confirm = useCallback(async (candidateId: number) => {
    const seen = { total: board.totals.nowMills, count: board.totals.count };
    try {
      const answer = await write.mutateAsync({ op: "confirm", candidateId, seenTotalMills: seen.total, seenCount: seen.count });
      const { confirmed, refused } = answer as { confirmed: boolean; refused: string | null };
      setSeenMills(!confirmed && (refused === "changed" || refused === "superseded") ? seen.total : null);
      toast(confirmed ? "Отчёт учтён" : refused === "changed" || refused === "superseded" ? "Отчёт изменился: проверьте его и подтвердите снова" : "Отчёт пока нельзя подтвердить");
    } catch (error) {
      const status = hubErrorStatus(error);
      toast(status === null || status >= 500 ? "Hub не ответил: неизвестно, учтён ли отчёт" : "Не получилось. Hub вернул ошибку");
    }
  }, [write, toast, board.totals.nowMills, board.totals.count]);
  // «Было …» lives while the board waits for the second press.
  useEffect(() => {
    if (board.phase !== "confirm") setSeenMills(null);
  }, [board.phase]);

  const actions: BoardActions = {
    board, report, own, preview, seenMills, showMany, host, pending: write.isPending, run, toast, show, commitNote, openNote, copyPost, collapse, confirm,
  };

  // ── rows' own presses ──

  const apply = async (row: Row, choice: Choice) => {
    setMenu(null);
    if (row.transactionId === null) return;
    const asking = row.ask !== null && row.ask.state === "asked";
    if (asking && choice.key === keyOfOwner(row.owner)) {
      await run({ op: "unask", transactionId: row.transactionId }, "Вопрос отменён");
      return;
    }
    // «Моя» on a sale the rule does not give the person takes one line of why, question or not (the server refuses
    // the word without it): the same field, and with no one to ask the sale is taken at once.
    if (choice.ask !== null || (choice.line.statement === "mine" && personNote(row) === null)) {
      await commitNote();
      setAsk((one) => ({ key: row.key, choice, text: one?.key === row.key ? one.text : "" }));
      return;
    }
    setAsk((one) => (one?.key === row.key ? null : one));
    await run({ op: "line", transactionId: row.transactionId, body: { ...choice.line, note: personNote(row) } }, choiceToast(row, choice, board));
  };

  const tick = async (row: Row) => {
    if (!canTick(row, board, preview) || row.transactionId === null) return;
    if (row.ask !== null && row.ask.state === "asked") {
      await run({ op: "unask", transactionId: row.transactionId }, "Вопрос отменён");
      return;
    }
    if (ask?.key === row.key) {
      setAsk(null);
      return;
    }
    const choice = tickChoice(board, row);
    if (choice) await apply(row, choice);
  };

  const sendAsk = async () => {
    if (ask === null) return;
    const row = rowByKey(board, ask.key);
    const text = ask.text.trim();
    if (!row || row.transactionId === null || text === "") return;
    if (ask.choice.ask === null) {
      const taken = await run({ op: "line", transactionId: row.transactionId, body: { ...ask.choice.line, note: text } }, choiceToast(row, ask.choice, board));
      if (taken) setAsk(null);
      return;
    }
    const to = ask.choice.ask;
    const ok = await run({ op: "ask", transactionId: row.transactionId, statement: to.statement, shareWithUserId: to.shareWithUserId, note: text },
      to.to === "owner" ? `Вопрос ушёл ${(row.decider ?? board.decider).kind === "team_lead" && (row.decider ?? board.decider).user ? (row.decider ?? board.decider).user!.forms.dat : "владельцу"}` : `Вопрос ушёл ${to.forms?.dat ?? ""}`);
    if (ok) setAsk(null);
  };

  /** Whether «Это моё» on a nobody's sale before the shift is offered now (Hub's `claimable`, the person's own board). */
  const canClaim = (row: Row) => row.before?.claimable === true && own && !preview
    && (board.phase === "draft" || board.phase === "fixing" || board.phase === "confirm" || board.phase === "counted");

  /**
   * «Это моё» → «Забрать»: the sale becomes the person's line with their line of why (the claim of «Найти продажу»). A
   * report handed in opens for «Правка» first («Исправить»): the person hands it in again, «Отмена» takes it back.
   */
  const sendClaim = async () => {
    if (claimForm === null) return;
    const row = rowByKey(board, claimForm.key);
    const text = claimForm.text.trim();
    if (!row || row.transactionId === null || text === "") return;
    await commitNote();
    const handedIn = board.phase === "confirm" || board.phase === "counted";
    if (handedIn && !(await run({ op: "reopen" }))) return;
    const taken = await run({ op: "line", transactionId: row.transactionId, body: { statement: "mine", note: text } },
      handedIn ? "Продажа в отчёте. Нажмите «Сдать заново»" : "Продажа добавлена в отчёт");
    if (taken) {
      setClaimForm(null);
      show(row.key);
    }
  };

  // ── keys: Esc closes the menu and the fields, Enter saves them ──

  // In the frame, Esc with nothing open collapses the board (the extension relies on it: the frame holds the keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (menu !== null) {
        setMenu(null);
        event.preventDefault();
        return;
      }
      if (host === "frame") {
        event.preventDefault();
        collapse();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu, host, collapse]);

  // A click outside the menu closes it.
  useEffect(() => {
    if (menu === null) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".menu") || target?.closest(`[data-menu="${CSS.escape(menu)}"]`)) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  // The toast stands over the bar, whatever its height.
  const barRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const view = viewRef.current;
    if (!bar || !view) return;
    const set = () => view.style.setProperty("--tb", `${bar.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // A field that opens takes the focus, the caret at its end.
  const focusField = (element: HTMLInputElement | null) => {
    if (!element || document.activeElement === element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  };

  // ── drawing ──

  const ownerHtml = (row: Row) => {
    const word = ownerWord(row);
    if (canTick(row, board, preview) && (row.choices === undefined || row.choices.length > 0)) {
      const open = menu === row.key;
      return (
        <button type="button" className={`ow ${word.cls}`} data-menu={row.key} aria-haspopup="menu" aria-expanded={open} title="Чья продажа"
          onClick={() => setMenu(open ? null : row.key)}>
          <span className="owt">{word.text}</span><Ico name="chev" size={12} />
        </button>
      );
    }
    return <span className={`ow ${word.cls}`}><span className="owt">{word.text}</span></span>;
  };

  const checkHtml = (row: Row) => {
    const look = tickLook(row);
    if (look === "none") return <span className="ck is-none" />;
    if (look === "x") return <span className="ck is-x" title="Пока не в отчёте" />;
    const cls = look === "mix" ? " is-mix" : look === "on" ? " is-on" : "";
    const inner = look === "mix" ? <Ico name="dash" size={12} /> : look === "on" ? <Ico name="tick" size={12} /> : null;
    const checked = look === "mix" ? "mixed" : look === "on";
    const label = `${row.siteWords} ${row.fan.name ?? ""}, ${clock(row.occurredAt)}`;
    if (!canTick(row, board, preview)) return <span className={`ck${cls}`} role="checkbox" aria-checked={checked} aria-disabled="true" aria-label={label}>{inner}</span>;
    const tip = look === "mix" ? "Ждём ответа. Нажмите, чтобы отменить вопрос" : look === "on" ? "В вашем отчёте. Снять галочку" : "Не ваша. Поставить галочку, забрать в отчёт";
    return (
      <button type="button" className={`ck${cls}`} role="checkbox" aria-checked={checked} aria-label={label} title={tip} onClick={() => void tick(row)}>
        {inner}
      </button>
    );
  };

  const whereHtml = (row: Row) => {
    const fansly = row.platform === "fansly";
    const text = fansly ? row.refLabel ?? "" : clock(row.occurredAt);
    if (host === "frame") {
      const title = fansly ? `Показать на Fansly, номер ${row.platformRef ?? ""}` : "Показать в выписке ChatSpace";
      return (
        <button type="button" className="tx" title={title} onClick={() => {
          void commitNote();
          setMenu(null);
          setMiss(null);
          hidden.current = true;
          transport?.post({ t: "find", sale: {
            transactionId: row.transactionId, pageLabel: row.pageLabel, platform: row.platform, platformRef: row.platformRef, kind: row.kind,
            occurredAt: row.occurredAt, netMills: row.netMills, grossMills: row.grossMills, fanName: row.fan.name, fanHandle: row.fan.username,
          } });
        }}>{text}</button>
      );
    }
    return <span className="tx is-plain" title={fansly ? row.platformRef ?? undefined : undefined}>{text}</span>;
  };

  /** A row's saved comment: the person's, someone else's (named), or Gengar's (serif, «написал Генгар»). */
  const noteLine = (row: Row): ReactNode => {
    const agent = agentNote(row);
    const text = row.note?.by !== "agent" && row.note !== null ? row.note.text : agent;
    if (!text) return null;
    const byAgent = text === agent && (row.note === null || row.note.by === "agent");
    return (
      <div className="nt" key="nt">
        <Ico name="note" size={13} />
        <span className={`t${byAgent ? " is-g" : ""}`}>{text}</span>
        {byAgent && <span className="by">написал Генгар</span>}
        {row.note?.by === "other" && <span className="by">{row.note.byName}</span>}
      </div>
    );
  };

  const underHtml = (row: Row): ReactNode => {
    // A sale of the shift before: only its comment (the next shift reads it), and a nobody's sale's «Это моё».
    if (row.before !== null) {
      const taking = claimForm?.key === row.key && canClaim(row);
      if (!row.note && !taking) return null;
      const handedIn = board.phase === "confirm" || board.phase === "counted";
      return (
        <div className={`ux${taking ? " is-act" : ""}`}>
          {noteLine(row)}
          {taking && (
            <div className="frm" key="claim">
              <label className="frm-l" htmlFor={`claim-${row.key}`}>Почему продажа ваша?</label>
              <div className="frm-r">
                <input className="fld" id={`claim-${row.key}`} ref={focusField} value={claimForm.text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
                  onChange={(event) => setClaimForm({ key: row.key, text: event.target.value })}
                  onKeyDown={(event) => onField(event, () => void sendClaim(), () => setClaimForm(null))} />
                <button type="button" className="btn btn--line btn--sm" disabled={claimForm.text.trim() === "" || write.isPending} onClick={() => void sendClaim()}>Забрать</button>
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setClaimForm(null)}>Отмена</button>
              </div>
              <div className="frm-h">{handedIn
                ? "Отчёт откроется для правки: продажа войдёт в него, потом нажмите «Сдать заново»."
                : "Продажа ничья: станет вашей и войдёт в отчёт."}</div>
            </div>
          )}
        </div>
      );
    }
    const parts: ReactNode[] = [];
    if (miss !== null && miss.key === row.key) parts.push(<div className="miss" key="miss">{miss.words}</div>);
    if (ask?.key === row.key) {
      const to = ask.choice.ask;
      const decider = (row.decider ?? board.decider).kind === "team_lead" && (row.decider ?? board.decider).user ? (row.decider ?? board.decider).user!.forms : null;
      const whom = to === null ? "" : to.to === "owner" ? decider?.acc ?? "владельца" : to.forms?.acc ?? "";
      // The server's own words when it sends the question straight to the decider («Олег сдаёт смену по-старому, решит владелец»).
      const hint = to === null ? "Спрашивать некого: продажа станет вашей сразу."
        : to.words ?? (to.to === "owner" ? "Решит владелец. До его ответа продажа остаётся в общаке." : `${to.forms?.nom ?? ""} ответит в ChatGoose. Пока он не согласился, продажа его.`);
      parts.push(
        <div className="frm" key="ask">
          <label className="frm-l" htmlFor={`ask-${row.key}`}>Почему продажа ваша?</label>
          <div className="frm-r">
            <input className="fld" id={`ask-${row.key}`} ref={focusField} value={ask.text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
              onChange={(event) => setAsk({ ...ask, text: event.target.value })}
              onKeyDown={(event) => onField(event, () => void sendAsk(), () => setAsk(null))} />
            <button type="button" className="btn btn--line btn--sm" disabled={ask.text.trim() === "" || write.isPending} onClick={() => void sendAsk()}>{to === null ? "Забрать" : `Спросить ${whom}`}</button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setAsk(null)}>Отмена</button>
          </div>
          <div className="frm-h">{hint}</div>
        </div>,
      );
    }
    const asked = row.ask;
    if (asked !== null && asked.state === "asked" && row.transactionId !== null) {
      const transactionId = row.transactionId;
      parts.push(
        <div className="u" key="asked">
          <span className="t">{asked.oldWay
            // The colleague hands in the old way: the question went to the decider at once (the server's words).
            ? <>Вы спросили{said(asked.note)}. {upper(row.reasonWords)}.</>
            : asked.to === "owner"
            ? <>Вы спросили владельца{said(asked.note)}. До его ответа продажа в общаке.</>
            : <>Вы спросили {asked.toUser?.forms.acc ?? ""}{said(asked.note)}. Согласится, продажа станет {asked.want.kind === "share" ? "пополам" : "вашей"}.</>}</span>
          {own && <button type="button" className="lk" onClick={() => void run({ op: "unask", transactionId }, "Вопрос отменён")}>Отменить</button>}
        </div>,
      );
    }
    if (asked !== null && asked.state === "disputed") {
      const who = asked.toUser;
      parts.push(
        <div className="u" key="disputed">
          <span className="t">{who ? `${who.forms.nom} не согласен. Спор решит ${(row.decider ?? board.decider).words}, до его ответа продажа ${who.forms.gen}.` : `Спор решит ${(row.decider ?? board.decider).words}.`}</span>
        </div>,
      );
    }
    const claim = row.incoming;
    if (claim !== null && claim.state !== "settled") {
      const claimId = claim.claimId;
      parts.push(claim.state === "asked" ? (
        <div className="u" key="incoming">
          <span className="t">
            <b>{claim.from.forms.nom} {claim.statement === "share" ? "предлагает делить эту продажу пополам:" : "считает эту продажу своей:"}</b>
            {claim.note ? <> «{claim.note}».</> : null} Пока вы не ответили, она ждёт, остальное учтено.
            {claim.canAnswer && (
              <span className="u-a">
                <button type="button" className="btn btn--line btn--xs" disabled={write.isPending}
                  onClick={() => void run({ op: "claim", claimId, answer: "agree" }, claim.statement === "share" ? "Продажа теперь пополам" : `Продажа теперь ${claim.from.forms.gen}`)}>Согласен</button>
                <button type="button" className="btn btn--line btn--xs" disabled={write.isPending}
                  onClick={() => void run({ op: "claim", claimId, answer: "disagree" }, `Спор решит ${(row.decider ?? board.decider).words}`)}>Не согласен</button>
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="u" key="incoming">
          <span className="t">Вы не согласны с {claim.from.forms.ins}. Спор решит {(row.decider ?? board.decider).words}: продажа ждёт, остальное учтено.</span>
        </div>
      ));
    }
    const card = row.proposal;
    if (card !== null && card.kind === "owner_change" && (board.phase === "confirm" || card.state === "late")) {
      const from = upper(card.from?.words ?? "");
      const to = upper(card.to?.words ?? "");
      const proposalId = card.id;
      if (card.superseded === true) {
        // Decided or agreed since: the settlement outranks the card, which changes nothing.
        parts.push(
          <div className="gc is-no" key="card">
            <div className="gc-h"><b>{card.by}</b><span>предлагал «{to}»</span></div>
            <div className="gc-a"><span className="grow">Решено иначе: {row.reasonWords}.</span></div>
          </div>,
        );
      } else if (card.state === "proposed" || card.state === "late") {
        parts.push(
          <div className="gc" key="card">
            <div className="gc-h"><b>{card.by}</b><span>было «{from}», стало «{to}»</span>{card.deltaMills !== 0 && <span className={`gc-d${card.deltaMills > 0 ? " is-up" : ""}`}>{signed(card.deltaMills)}</span>}</div>
            <div className="gc-t">{card.why}</div>
            <div className="gc-a">
              {card.state === "late" ? (
                <>
                  {own && <button type="button" className="btn btn--line btn--xs" disabled={write.isPending} onClick={() => void run({ op: "proposal", proposalId, answer: "accept" }, "Правка принята: проверьте и сдайте заново")}>Принять</button>}
                  {own && <button type="button" className="btn btn--line btn--xs" disabled={write.isPending} onClick={() => setRefuse({ key: row.key, proposalId, text: "" })}>Не согласен</button>}
                  <span>Пришла после подтверждения: само ничего не меняется</span>
                </>
              ) : (
                <>
                  {own && <button type="button" className="btn btn--line btn--xs" disabled={write.isPending} onClick={() => setRefuse({ key: row.key, proposalId, text: "" })}>Не согласен</button>}
                  <span>Если согласны, ничего не нажимайте</span>
                </>
              )}
            </div>
          </div>,
        );
      } else if (card.state === "declined") {
        parts.push(
          <div className="gc is-no" key="card">
            <div className="gc-h"><b>{card.by}</b><span>предлагал «{to}»</span></div>
            <div className="gc-a">
              <span className="grow">Вы не согласны: осталось «{from}», решит {(row.decider ?? board.decider).words}.</span>
              {own && <button type="button" className="lk is-clay" disabled={write.isPending} onClick={() => void run({ op: "proposal", proposalId, answer: "restore" })}>Вернуть правку</button>}
            </div>
          </div>,
        );
      }
    }
    if (refuse !== null && refuse.key === row.key) {
      const send = async () => {
        const text = refuse.text.trim();
        if (text === "") return;
        if (await run({ op: "proposal", proposalId: refuse.proposalId, answer: "decline", note: text }, `Спор решит ${(row.decider ?? board.decider).words}`)) setRefuse(null);
      };
      parts.push(
        <div className="frm" key="refuse">
          <label className="frm-l" htmlFor={`refuse-${row.key}`}>Почему вы не согласны?</label>
          <div className="frm-r">
            <input className="fld" id={`refuse-${row.key}`} ref={focusField} value={refuse.text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
              onChange={(event) => setRefuse({ ...refuse, text: event.target.value })}
              onKeyDown={(event) => onField(event, () => void send(), () => setRefuse(null))} />
            <button type="button" className="btn btn--line btn--sm" disabled={refuse.text.trim() === "" || write.isPending} onClick={() => void send()}>Не согласен</button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setRefuse(null)}>Отмена</button>
          </div>
          <div className="frm-h">Решит {(row.decider ?? board.decider).words}: Генгар предложил, вы объясните.</div>
        </div>,
      );
    }
    if (edit?.key === row.key) {
      const save = () => void commitNote();
      parts.push(
        <div className="frm" key="note">
          <div className="frm-r">
            <input className="fld" ref={focusField} value={edit.draft} placeholder="Комментарий к продаже" autoComplete="off" maxLength={300} aria-label="Комментарий к продаже"
              onChange={(event) => setEdit({ ...edit, draft: event.target.value })}
              onKeyDown={(event) => onField(event, save, () => setEdit(null))} />
            <button type="button" className="btn btn--line btn--sm" onClick={save}>Сохранить</button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setEdit(null)}>Отмена</button>
          </div>
          <div className="qw">
            {QUICK.map((word) => (
              <button type="button" key={word} onMouseDown={(event) => event.preventDefault()} onClick={() => {
                const was = edit.draft.replace(/[\s,]+$/, "");
                setEdit({ ...edit, draft: was ? `${was}, ${word}` : word });
              }}>{word}</button>
            ))}
          </div>
        </div>,
      );
    } else {
      const line = noteLine(row);
      if (line) parts.push(line);
    }
    return parts.length ? <div className="ux">{parts}</div> : null;
  };

  const rowHtml = (row: Row) => {
    const fansly = row.platform === "fansly";
    const amount = fansly
      ? <div className="r-a"><span className="tm">{clock(row.occurredAt)}</span>{plus(row.netMills)}</div>
      : <div className="r-a" title={`Фан заплатил ${usd(row.grossMills ?? row.netMills)}, после комиссии ${usd(row.netMills)}`}><span className="g">{usd(row.grossMills ?? row.netMills)}</span>{usd(row.netMills)}</div>;
    const title = (
      <div className="r-t" title={`${row.siteWords} ${row.fan.name ?? ""}${row.fan.username ? ` @${row.fan.username}` : ""}`}>
        <span className="pw">{row.siteWords}</span><b>{row.fan.name ?? row.fan.username ?? ""}</b>
      </div>
    );
    if (row.before !== null) {
      const claimable = canClaim(row);
      return (
        <div className={`r is-dim is-not${lit.includes(row.key) ? " is-hl" : ""}`} data-row={row.key} key={row.key}>
          {checkHtml(row)}{title}{amount}
          <div className={`r2${claimable ? " is-act" : ""}`}>
            {whereHtml(row)}<span className="rs" title={row.reasonWords || undefined}>{row.reasonWords}</span>
            {claimable && claimForm?.key !== row.key && (
              <button type="button" className="btn btn--line btn--xs" disabled={write.isPending} onClick={() => {
                void commitNote();
                setAsk(null);
                setClaimForm({ key: row.key, text: "" });
                setHl(row.key);
              }}>Это моё</button>
            )}
          </div>
          {underHtml(row)}
        </div>
      );
    }
    let end: ReactNode = null;
    if (row.sighting !== null && !row.sighting.added) {
      const sightingId = row.sighting.id;
      end = own && !preview && (board.phase === "draft" || board.phase === "fixing")
        ? <button type="button" className="btn btn--line btn--xs" disabled={write.isPending} onClick={() => { setHl(row.key); void run({ op: "sighting", sightingId }, "Добавлено в отчёт"); }}><Ico name="plus" size={12} />Добавить</button>
        : null;
    } else if (row.late && !row.ticked) {
      const transactionId = row.transactionId;
      end = own && !preview && transactionId !== null && board.phase === "counted"
        ? <button type="button" className="btn btn--line btn--xs" disabled={write.isPending} onClick={() => { setHl(row.key); void run({ op: "resend", transactionIds: [transactionId] }, `Досдано: ${row.fan.name ?? ""} ${usd(row.netMills)} в отчёте`); }}>Досдать</button>
        : null;
    } else if (row.canNote && !preview) {
      end = (
        <button type="button" className={`cm${wantsNote(row) ? " is-ask" : ""}`} title="Комментарий" aria-label="Комментарий" onClick={() => {
          if (edit?.key === row.key) {
            void commitNote();
            return;
          }
          void commitNote();
          openNote(row.key);
          setHl(row.key);
        }}><Ico name="note" size={14} className="cm-i" /><span className="cm-w">Комментарий</span></button>
      );
    }
    const reason = row.reasonWords;
    const cls = ["r"];
    if (!row.ticked) cls.push("is-not");
    if (lit.includes(row.key)) cls.push("is-hl");
    return (
      <div className={cls.join(" ")} data-row={row.key} key={row.key}>
        {checkHtml(row)}{title}{amount}
        <div className="r2">
          {whereHtml(row)}
          {ownerHtml(row)}
          {reason && <><span className="sep">·</span><span className={`rs ${reasonLook(row)}`} title={row.owner.kind === "share" && row.ticked ? row.rule.words || reason : reason}>{reason}</span></>}
          {end}
        </div>
        {underHtml(row)}
      </div>
    );
  };

  const beforeHtml = (column: Board["columns"][number]) => {
    if (column.before.count === 0) return null;
    const open = !!beforeOpen[column.pageLabel];
    return (
      <>
        <button type="button" className="bf" aria-expanded={open} onClick={() => setBeforeOpen((one) => ({ ...one, [column.pageLabel]: !open }))}>
          {beforeWords(column.before)}<Ico name="chev" size={12} />
        </button>
        {open && column.before.rows.map(rowHtml)}
      </>
    );
  };

  const platformName = (platform: string) => (platform === "fansly" ? "Fansly" : "OnlyFans");
  const columnHtml = (column: Board["columns"][number]) => {
    if (column.of === 0) {
      return (
        <section className="col is-empty" key={column.pageLabel} aria-label={`${column.pageLabel}, ${platformName(column.platform)}`}>
          <div className="ch"><span className="ch-n">{column.pageLabel}</span><span className="ch-p">{platformName(column.platform)}</span></div>
          <div className="cb"><div className="emp">За смену продаж нет</div>{beforeHtml(column)}</div>
        </section>
      );
    }
    return (
      <section className="col" key={column.pageLabel} aria-label={`${column.pageLabel}, ${platformName(column.platform)}`}>
        <div className="ch">
          <span className="ch-n">{column.pageLabel}</span><span className="ch-p">{platformName(column.platform)}</span>
          {column.attention && <i className="dot" title="Есть что посмотреть" />}
          <span className="ch-s">отмечено {column.marked} из {column.of}, <b>{usd(column.sumMills)}</b></span>
        </div>
        <div className="cb">{column.rows.map(rowHtml)}{beforeHtml(column)}</div>
      </section>
    );
  };

  const chip = (() => {
    switch (board.phase) {
      case "checking": return <span className="chip"><i className="spin" />{board.chip}</span>;
      case "confirm": case "fixing": return <span className="chip is-clay">{board.chip}</span>;
      case "counted": return <span className="chip is-good"><Ico name="check" size={12} />{board.chip}</span>;
      default: return <span className="chip">{board.chip}</span>;
    }
  })();

  const menuRow = menu === null ? null : rowByKey(board, menu);

  return (
    <div className="rb" ref={rootRef}>
      <div className="view" ref={viewRef}>
        <section className="board" aria-label="Отчёт смены">
          <header className="bh">
            {host === "tab" && (
              // In a tab the board is the whole window: the way back to Workboard (asked for on 19.11).
              <Link to="/" className="btn btn--quiet btn--sm bh-back" title="Вернуться в Workboard"><Ico name="back" size={14} />На главную</Link>
            )}
            <span className="bh-t"><Ico name="report" />{titleOf(report.shift, own)}</span>
            {board.offShift.length > 0 && <span className="bh-off">{offShiftOf(board)}</span>}
            <span className="bh-sum">{chip}</span>
            <span className="bh-sum" style={{ marginLeft: 0 }}>Итого<b>{usd(board.totals.nowMills)}</b></span>
            {host === "tab" && board.phase === "counted" && <Link to={shiftPath(report.shift.userId, report.shift.startedAt)} className="btn btn--quiet btn--sm">Итог смены</Link>}
            {host === "frame" && (
              <button type="button" className="btn btn--quiet btn--sm" title="Свернуть доску в полосу внизу" onClick={collapse}><Ico name="min" size={14} />Свернуть</button>
            )}
          </header>
          {own && board.previous && board.previous.comment.trim() !== "" && (
            <div className="prev" title={board.previous.comment}>
              <Ico name="note" size={13} />
              <span className="t">От прошлой смены{board.previous.user ? ` (${board.previous.user.forms.nom})` : ""}: „{board.previous.comment}“</span>
            </div>
          )}
          {own && (board.otherShifts ?? []).map((one) => (
            // Another shift of the person waits for them: its sales count only in its own report, so the way is here.
            <div className={`oth${one.ongoing ? "" : " is-wait"}`} key={one.shiftId}>
              <Ico name="report" size={13} />
              <span className="t">{otherShiftWords(one)}</span>
              <Link
                to={host === "tab" ? `/report/${one.shiftId}` : { search: `?shift=${one.shiftId}` }}
                className="btn btn--line btn--sm"
                onClick={() => void commitNote()}
              >{one.ongoing ? "Вернуться" : "Открыть"}</Link>
            </div>
          ))}
          <div className="cols" ref={colsRef}>{board.columns.map(columnHtml)}</div>
          <BoardBar actions={actions} barRef={barRef} />
        </section>
        {menuRow && <OwnerMenu row={menuRow} board={board} viewRef={viewRef} barRef={barRef} onPick={(choice) => void apply(menuRow, choice)} />}
        <div className={`toast${toastText.on ? " is-on" : ""}`} role="status">{toastText.text}</div>
      </div>
    </div>
  );
}

/** The menu «Чья продажа» under its word (the prototype's `renderMenu` and `placeMenu`). */
function OwnerMenu({ row, board, viewRef, barRef, onPick }: {
  row: Row;
  board: Board;
  viewRef: React.RefObject<HTMLDivElement | null>;
  barRef: React.RefObject<HTMLElement | null>;
  onPick: (choice: Choice) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { groups, currentKey } = choicesOf(board, row);
  const place = useCallback(() => {
    const element = ref.current;
    const view = viewRef.current;
    const button = view?.querySelector<HTMLElement>(`[data-menu="${CSS.escape(row.key)}"]`);
    if (!element || !view) return;
    if (!button) {
      element.style.display = "none";
      return;
    }
    element.style.display = "";
    const box = view.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    const limit = barRef.current ? barRef.current.getBoundingClientRect().top : box.bottom;
    const down = at.bottom + 4 + element.offsetHeight < limit - 6;
    element.style.left = `${Math.round(Math.min(at.left - box.left - 4, box.width - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.round((down ? at.bottom + 4 : at.top - 4 - element.offsetHeight) - box.top)}px`;
  }, [row.key, viewRef, barRef]);
  useLayoutEffect(() => {
    place();
  });
  useEffect(() => {
    document.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [place]);
  return (
    <div className="menu" ref={ref} role="menu" aria-label="Чья продажа">
      {groups.map((group, index) => (
        <div key={index} style={{ display: "contents" }}>
          {index > 0 && <i />}
          {group.map((choice) => {
            const on = choice.key === currentKey;
            return (
              <button type="button" key={choice.key} className={`mi${on ? " is-on" : ""}`} role="menuitemradio" aria-checked={on} onClick={() => onPick(choice)}>
                <span className="mi-c">{on && <Ico name="check" size={13} />}</span>
                <span className="mi-t">{choice.label}</span>
                <span className="mi-h">{choice.hint}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Enter saves a field, Esc leaves it. */
function onField(event: ReactKeyboardEvent<HTMLInputElement>, save: () => void, cancel: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
    event.preventDefault();
    save();
  }
}

/** The row's current word as a line's body: kept when only its comment changes. */
function lineOf(row: Row): Pick<Write & { op: "line" }, "body">["body"] {
  return {
    statement: row.statement,
    shareWithUserId: row.statement === "share" ? row.owner.userId : null,
    toUserId: row.statement === "give" ? row.owner.userId : null,
  };
}

/** The person's own comment of a row, sent along with a new word so the word does not drop it. */
const personNote = (row: Row) => (row.note?.by === "person" ? row.note.text : null);
/** The one line of why after «Вы спросили …»: «: «…»», or nothing when the question carries none (a «пополам» from a handed-in version). */
const said = (note: string | null | undefined) => (note && note.trim() !== "" ? `: «${note.trim()}»` : "");

function reducedMotion(): boolean {
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

