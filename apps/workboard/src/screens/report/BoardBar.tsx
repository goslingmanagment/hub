import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { millsFromDollars } from "@agency_hub_core/shared";
import type { BoardActions } from "./Board";
import { useClaimable } from "./data";
import { Ico } from "./icons";
import {
  bareRows,
  clock,
  day,
  gengarFound,
  isLateOpen,
  isLost,
  keyOfTransaction,
  lateProposals,
  plural,
  plus,
  salesCount,
  usd,
  waitingRows,
  allRows,
  type Row,
} from "./model";

/**
 * The bottom bar of the board, in every phase as the prototype draws it: the draft's totals, the shift's comment and
 * what points at a row; the check; «Подтверждаю» with Hub's and Gengar's lines; «Учтён» with «Скопировать пост»; the
 * correction. Plus «Ещё» (what the prototype does not draw, what worked before it): «Мимо площадки», «Найти продажу».
 */
export function BoardBar({ actions, barRef }: { actions: BoardActions; barRef: RefObject<HTMLElement | null> }) {
  const { board, report, own, preview, host, pending, run, show } = actions;
  const [more, setMore] = useState<"menu" | "off" | "find" | null>(null);
  const bare = useRef(0);
  const total = board.totals.nowMills;
  const count = board.totals.count;
  // «Было»: Hub's (a correction, Gengar's edits), or what the person saw when «Подтверждаю» was refused as changed.
  const was = actions.seenMills ?? board.totals.wasMills;
  const changed = was !== null && was !== total;
  const editing = own && !preview && (board.phase === "draft" || board.phase === "fixing");
  const candidate = board.candidate;

  const link = (row: Row, text?: string) => (
    <button type="button" className="lk is-clay" key={row.key} onClick={() => show(row.key)}>{text ?? row.fan.name ?? row.fan.username ?? ""}</button>
  );
  const links = (rows: Row[]) => <span className="lks">{rows.map((row, index) => <span key={row.key}>{index > 0 && ","}{link(row)}</span>)}</span>;

  const hubLine = (): ReactNode => {
    if (!candidate) return null;
    const hub = candidate.hub;
    const named = (state: string) => hub.pages.filter((page) => page.state === state).map((page) => page.pageLabel).join(", ");
    switch (hub.state) {
      case "running": return <span className="k"><i className="spin" />Hub сверяет суммы с кошельками</span>;
      case "matched": return <span className="k is-ok"><Ico name="check" size={14} />Hub: суммы сошлись с кошельками</span>;
      case "found": {
        const found = allRows(board).filter((row) => row.foundByHub === true);
        return (
          <span className="k is-amb"><Ico name="plus" size={14} />Hub дочитал кошельки: ещё {salesCount(hub.foundCount)}, {plus(hub.foundMills)}
            {found.length > 0 && <span className="lks"><button type="button" className="lk is-clay" onClick={() => actions.showMany(found.map((row) => row.key))}>Показать</button></span>}
          </span>
        );
      }
      // «Можно подтвердить» only where the person can: in «Проверка» there is no «Подтверждаю» yet.
      case "unchecked": return <span className="k is-amb"><Ico name="clock" size={14} />Hub не сверил {named("unchecked")}. {board.phase === "checking" ? "Сверка придёт позже." : "Можно подтвердить, сверка придёт позже."}</span>;
      case "statement": return <span className="k"><i className="spin" />Ждём выписку {named("statement")}</span>;
    }
  };

  const gengarLine = (): ReactNode => {
    if (!candidate) return null;
    const gengar = candidate.gengar.state;
    if (gengar === "reading") return <span className="k"><i className="spin" />Генгар читает переписки смены, обычно пара минут</span>;
    if (gengar === "silent") return <span className="k is-amb"><Ico name="clock" size={14} />Генгар молчит 10 минут. Можно подтвердить по проверке Hub, его проверка придёт позже.</span>;
    if (gengar === "found") {
      const found = gengarFound(board);
      if (found) return <span className="k is-g"><Ico name="pen" size={14} />{found.words}{links(found.rows)}</span>;
    }
    if (gengar === "found" || gengar === "clean") return <span className="k is-ok"><Ico name="check" size={14} />Генгар прочитал переписки: замечаний нет</span>;
    return null;
  };

  const sumWords = own ? "Ваши продажи" : "Продаж в отчёте";
  const totals = changed
    ? <span className="tot">Было <s>{usd(was!)}</s>, стало <b>{usd(total)}</b></span>
    : <span className="tot">{sumWords}: {count}, <b>{usd(total)}</b></span>;

  let status: ReactNode = null;
  let main: ReactNode;

  if (preview) {
    // Before the person hands in on the board: how Hub counts the shift, and the old way stays.
    main = (
      <>
        <span className="tot">{sumWords}: {count}, <b>{usd(total)}</b></span>
        <p className="cf"><b>Сдача смены здесь ещё не включена.</b> Отчёт по-прежнему собирает Генгар по /smena, а вы отправляете его в Отчётность. Здесь видно, как его посчитает Hub.</p>
        <span className="grow" />
      </>
    );
  } else if (board.phase === "draft" || board.phase === "fixing") {
    if (editing) {
      const lost = allRows(board).find(isLost) ?? null;
      const bareList = bareRows(board);
      const fixing = board.phase === "fixing";
      main = (
        <>
          {totals}
          <Memo actions={actions} />
          {lost && <button type="button" className="hint is-amb" onClick={() => show(lost.key)}><Ico name="plus" size={13} />Нет в Hub: {lost.fan.name} {plus(lost.netMills)}</button>}
          {bareList.length > 0 && (
            <button type="button" className="hint" title="Открыть комментарий у следующей" onClick={() => {
              const row = bareList[bare.current++ % bareList.length]!;
              void actions.commitNote().then(() => {
                actions.openNote(row.key, "");
                show(row.key);
              });
            }}><Ico name="note" size={13} />Без комментария: {salesCount(bareList.length)} от $30</button>
          )}
          <button type="button" className="hint" data-more aria-haspopup="menu" aria-expanded={more !== null} onClick={() => setMore(more === null ? "menu" : null)}>Ещё</button>
          <span className="grow" />
          {fixing && <button type="button" className="btn btn--quiet btn--lg" disabled={pending} onClick={() => void run({ op: "reopenCancel" })}>Отмена</button>}
          <button type="button" className="btn btn--main btn--lg" disabled={pending} onClick={() => {
            void actions.commitNote().then(() => run({ op: "submit" }));
          }}>{fixing ? "Сдать заново" : "Сдать смену"}</button>
        </>
      );
    } else {
      main = <>{totals}<CommentText text={report.view?.comment ?? ""} /><span className="grow" /></>;
    }
  } else if (board.phase === "checking") {
    main = (
      <>
        <span className="tot">Сдано в {candidate ? clock(candidate.madeAt) : ""} · продаж: {count}, <b>{usd(total)}</b></span>
        {hubLine()}
        {gengarLine()}
        <span className="grow" />
        {own && <span className="hint">{host === "frame" ? "Доску можно свернуть, ответ придёт сюда" : "Ответ придёт сюда"}</span>}
      </>
    );
  } else if (board.phase === "confirm") {
    const waiting = waitingRows(board);
    status = (
      <>
        {hubLine()}
        {gengarLine()}
        {waiting.length > 0 && <span className="k is-amb"><Ico name="people" size={14} />Ждут ответа, в сумму не входят:{links(waiting)}</span>}
      </>
    );
    main = own ? (
      <>
        {totals}
        <p className="cf">Вы подтверждаете: <b>{salesCount(count)} на {usd(total)}</b>. За корректность отчёта вы отвечаете материально.</p>
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--lg" disabled={pending} onClick={() => void actions.commitNote().then(() => run({ op: "reopen" }))}>Исправить</button>
        <button type="button" className="btn btn--main btn--lg" disabled={pending || !board.canConfirm || candidate === null} onClick={() => {
          if (candidate === null) return;
          void actions.commitNote().then(() => actions.confirm(candidate.id));
        }}>Подтверждаю</button>
      </>
    ) : <>{totals}<CommentText text={report.view?.comment ?? ""} /><span className="grow" /></>;
  } else {
    const incoming = allRows(board).find((row) => row.incoming?.state === "asked") ?? null;
    const late = allRows(board).find(isLateOpen) ?? null;
    const lateCards = lateProposals(board);
    const counted = <span className="tot"><Ico name="check" size={14} />Учтён в {board.countedAt ? clock(board.countedAt) : ""} · продаж: {count}, <b>{usd(total)}</b></span>;
    let what: ReactNode = <span className="grow" />;
    if (own && incoming) what = <span className="nq"><Ico name="people" size={14} />{incoming.incoming!.from.forms.nom} оспаривает вашу продажу {incoming.fan.name} {usd(incoming.netMills)}{link(incoming, "Показать")}</span>;
    else if (own && late) what = <span className="nq"><Ico name="plus" size={14} />После сдачи пришла продажа {late.fan.name} {usd(late.netMills)}{link(late, "Показать")}</span>;
    else if (own && lateCards.length > 0) what = <span className="nq"><Ico name="pen" size={14} />Генгар дочитал: {lateCards.length} {plural(lateCards.length, "правка", "правки", "правок")}{link(lateCards[0]!, "Показать")}</span>;
    else if (candidate?.gengar.state === "silent") what = <span className="nq is-q"><Ico name="clock" size={14} />Подтверждён по проверке Hub. Генгар дочитает позже, его проверка придёт сюда же.</span>;
    else if (!own && (report.view?.comment ?? "") !== "") what = <CommentText text={report.view?.comment ?? ""} />;
    // The post in «Отчётность»: quiet lines over the bar.
    const post = own ? board.post ?? null : null;
    const postLines: ReactNode[] = [];
    if (post?.late && post.copiedAt === null) {
      postLines.push(<span className="k is-amb" key="late"><Ico name="clock" size={14} />Пост за {day(`${report.shift.reportDate}T12:00:00+03:00`)} опоздал больше чем на сутки: ledger его сам не примет</span>);
    }
    const changed = (post?.models ?? []).filter((model) => model.copiedAt !== null && model.changedSinceCopy);
    if (changed.length > 0 && report.posts.length > 1) {
      postLines.push(<span className="k is-amb" key="changed"><Ico name="pen" size={14} />Пост {changed.map((model) => model.modelName).join(", ")} изменился. Исправьте прежний пост в «Отчётности», новый не пишите</span>);
    } else if (post && post.copiedAt !== null && report.posts.length <= 1 && (post.changedSinceCopy || changed.length > 0)) {
      // One model: the report's own mark. Two: only a model whose post was copied (above) — never one never sent.
      postLines.push(<span className="k is-amb" key="changed"><Ico name="pen" size={14} />Пост изменился. Исправьте прежний пост в «Отчётности», новый не пишите</span>);
    } else if (post && post.copiedAt !== null && post.seen === false) {
      postLines.push(<span className="k" key="unseen"><Ico name="clock" size={14} />Пост в «Отчётность» ещё не пришёл</span>);
    }
    status = postLines.length > 0 ? <>{postLines}</> : null;
    main = (
      <>
        {counted}
        {what}
        {!own && what !== null && <span className="grow" />}
        {own && <button type="button" className="btn btn--quiet btn--lg" disabled={pending} onClick={() => void run({ op: "reopen" })}>Исправить</button>}
        {own && report.posts.map((one) => {
          // One button per model of the shift: «Отчётность» takes one post per model, never two joined.
          const copied = post?.models.find((model) => model.modelSlug === one.modelSlug)?.copiedAt != null;
          const label = report.posts.length > 1 ? `Скопировать пост: ${one.modelName}` : "Скопировать пост";
          return (
            <button key={one.modelSlug} type="button" className={`btn ${copied ? "btn--quiet" : "btn--main"} btn--lg`} onClick={() => actions.copyPost(one.modelSlug)}>
              <Ico name={copied ? "check" : "copy"} size={14} />{label}{copied ? " · скопирован" : ""}
            </button>
          );
        })}
      </>
    );
  }

  return (
    <footer className="bar" ref={barRef}>
      {status && <div className="bar-st">{status}</div>}
      <div className="bar-m">{main}</div>
      {editing && more !== null && <More actions={actions} kind={more} setKind={setMore} />}
    </footer>
  );
}

/** The comment for the next shift (one per shift): saved on Enter, on leaving the field, and after a pause in typing. */
function Memo({ actions }: { actions: BoardActions }) {
  const saved = actions.report.view?.comment ?? "";
  const [text, setText] = useState(saved);
  const last = useRef(saved);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    // Hub's comment comes back with every read; the field keeps what is being typed.
    if (timer.current === null && text === last.current && saved !== last.current) {
      setText(saved);
      last.current = saved;
    }
  }, [saved, text]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const flush = (value: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (value === last.current) return;
    last.current = value;
    void actions.run({ op: "comment", comment: value });
  };
  return (
    <input className="fld memo" value={text} placeholder="Комментарий для следующей смены" autoComplete="off" maxLength={2000} aria-label="Комментарий для следующей смены"
      onChange={(event) => {
        const value = event.target.value;
        setText(value);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(value), 1_000);
      }}
      onBlur={() => flush(text)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }} />
  );
}

/** A reader's bar: the shift's comment, for the next shift. */
function CommentText({ text }: { text: string }) {
  return text.trim() === "" ? null : <span className="memo-ro" title={text}><b>Комментарий:</b> {text}</span>;
}

/** «Ещё»: a small menu over the bar, and its two panels in the board's look. */
function More({ actions, kind, setKind }: { actions: BoardActions; kind: "menu" | "off" | "find"; setKind: (kind: "menu" | "off" | "find" | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(16);
  useEffect(() => {
    const anchor = ref.current?.closest(".bar")?.querySelector<HTMLElement>("[data-more]");
    const bar = ref.current?.closest<HTMLElement>(".bar");
    if (anchor && bar) setLeft(Math.max(8, anchor.getBoundingClientRect().left - bar.getBoundingClientRect().left - 4));
  }, [kind]);
  useEffect(() => {
    // Esc closes the panel first (before the board's own Esc, which collapses the frame).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setKind(null);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".pnl") || target?.closest(".menu") || target?.closest("[data-more]")) return;
      setKind(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [setKind]);
  const style = { left, bottom: "calc(100% + 6px)" } as const;
  if (kind === "menu") {
    const offs = actions.report.view?.offPlatform ?? [];
    return (
      <div className="menu" ref={ref} role="menu" aria-label="Ещё" style={{ ...style, width: 260 }}>
        <button type="button" className="mi" role="menuitem" onClick={() => setKind("off")}>
          <span className="mi-c" /><span className="mi-t">Мимо площадки</span><span className="mi-h">{offs.length > 0 ? `${offs.length}` : ""}</span>
        </button>
        <button type="button" className="mi" role="menuitem" onClick={() => setKind("find")}>
          <span className="mi-c" /><span className="mi-t">Найти продажу</span><span className="mi-h">за 7 дней</span>
        </button>
      </div>
    );
  }
  return (
    <div className="pnl" ref={ref} style={style}>
      {kind === "off" ? <OffPlatform actions={actions} close={() => setKind(null)} /> : <FindSale actions={actions} close={() => setKind(null)} />}
    </div>
  );
}

/** «Мимо площадки»: money that came past the platform; it waits for the owner and is never in the sums before. */
function OffPlatform({ actions, close }: { actions: BoardActions; close: () => void }) {
  const lines = actions.report.view?.offPlatform ?? [];
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [what, setWhat] = useState("");
  const dollars = Number(amount.replace(",", "."));
  const ready = Number.isFinite(dollars) && dollars > 0 && from.trim() !== "" && what.trim() !== "";
  const add = async () => {
    if (!ready) return;
    const done = await actions.run({ op: "offPlatformAdd", body: { amountMills: Number(millsFromDollars(dollars)), fromWhom: from.trim(), whatFor: what.trim() } }, "Добавлено: ждёт подтверждения владельца");
    if (done) {
      setAmount("");
      setFrom("");
      setWhat("");
    }
  };
  const onEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void add();
  };
  return (
    <>
      <div className="pnl-h">Мимо площадки<button type="button" className="lk" onClick={close}>Закрыть</button></div>
      <div className="frm-h">Деньги, которые пришли не через площадку. В итог входят, когда владелец подтвердит.</div>
      {lines.map((line) => (
        <div className="pnl-r" key={line.id}>
          <span>{line.fromWhom}, {line.whatFor}</span>
          <span className="a">{usd(line.amountMills)}</span>
          <span className="s">
            {line.state === "pending" ? "ждёт подтверждения владельца" : line.state === "confirmed" ? `владелец подтвердил${line.pageLabel ? `: в сумме ${line.pageLabel}` : ""}` : "владелец отклонил: в итог не входит"}
            {line.state === "pending" && <button type="button" className="lk" onClick={() => void actions.run({ op: "offPlatformWithdraw", offPlatformId: line.id }, "Убрано")}>Убрать</button>}
          </span>
        </div>
      ))}
      <div className="pnl-t">Добавить</div>
      <div className="frm">
        <div className="frm-r">
          <input className="fld" style={{ flex: "0 0 96px" }} inputMode="decimal" placeholder="Сумма, $" aria-label="Сумма в долларах" value={amount} onChange={(event) => setAmount(event.target.value)} onKeyDown={onEnter} autoFocus />
          <input className="fld" placeholder="От кого" aria-label="От кого" maxLength={200} value={from} onChange={(event) => setFrom(event.target.value)} onKeyDown={onEnter} />
        </div>
        <div className="frm-r">
          <input className="fld" placeholder="За что" aria-label="За что" maxLength={300} value={what} onChange={(event) => setWhat(event.target.value)} onKeyDown={onEnter} />
          <button type="button" className="btn btn--line btn--sm" disabled={!ready || actions.pending} onClick={() => void add()}>Добавить</button>
        </div>
      </div>
    </>
  );
}

/** «Найти продажу»: a sale of the last 7 days on the person's pages that no report of theirs holds, «Это моё» with a line of why. */
function FindSale({ actions, close }: { actions: BoardActions; close: () => void }) {
  const shiftId = actions.report.shift.id;
  const read = useClaimable(shiftId, true);
  const [query, setQuery] = useState("");
  const [claiming, setClaiming] = useState<{ id: number; text: string } | null>(null);
  const onBoard = new Set(allRows(actions.board).map((row) => row.transactionId));
  const sales = (read.data?.sales ?? []).filter((sale) => !onBoard.has(sale.transactionId));
  const words = query.trim().toLowerCase().replace(/^@/, "");
  const nobody = sales.filter((sale) => sale.home === "nobody");
  const found = words === "" ? [] : sales.filter((sale) => sale.home !== "nobody" && [sale.fan.name, sale.fan.username].some((name) => name !== null && name.toLowerCase().includes(words)));
  const claim = async (transactionId: number, note: string) => {
    const done = await actions.run({ op: "line", transactionId, body: { statement: "mine", note } }, "Продажа добавлена в отчёт");
    if (done) {
      setClaiming(null);
      actions.show(keyOfTransaction(transactionId));
    }
  };
  const saleRow = (sale: (typeof sales)[number]) => {
    const open = claiming?.id === sale.transactionId ? claiming : null;
    return (
      <div className="pnl-r" key={sale.transactionId}>
        <span>{sale.pageLabel} · {sale.fan.name ?? sale.fan.username}</span>
        <span className="a">{usd(sale.netMills)}</span>
        <span className="s">
          {day(sale.occurredAt)}, {clock(sale.occurredAt)} · {sale.words}
          {!open && <button type="button" className="lk is-clay" onClick={() => setClaiming({ id: sale.transactionId, text: "" })}>Это моё</button>}
        </span>
        {open && (
          <div className="frm">
            <div className="frm-r">
              <input className="fld" autoFocus placeholder="Почему она ваша? Одной строкой" maxLength={300} value={open.text}
                onChange={(event) => setClaiming({ ...open, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && open.text.trim() !== "") void claim(sale.transactionId, open.text.trim());
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setClaiming(null);
                  }
                }} />
              <button type="button" className="btn btn--line btn--sm" disabled={open.text.trim() === "" || actions.pending} onClick={() => void claim(sale.transactionId, open.text.trim())}>Добавить</button>
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => setClaiming(null)}>Отмена</button>
            </div>
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <div className="pnl-h">Найти продажу<button type="button" className="lk" onClick={close}>Закрыть</button></div>
      <div className="frm-h">Продажи последних 7 дней на ваших страницах, которых нет ни в одном вашем отчёте.</div>
      {read.isPending && <div className="emp"><i className="spin" /></div>}
      {read.isError && <div className="emp">Список не пришёл. <button type="button" className="lk" onClick={() => void read.refetch()}>Ещё раз</button></div>}
      {read.data && (
        <>
          <div className="pnl-t">Ничьи{nobody.length === 0 ? ": нет" : ""}</div>
          {nobody.map(saleRow)}
          <div className="pnl-t">Другие</div>
          <input className="fld" style={{ width: "100%" }} placeholder="Имя или логин фана" value={query} onChange={(event) => setQuery(event.target.value)} />
          {words !== "" && (found.length === 0 ? <div className="emp">Таких продаж нет.</div> : found.slice(0, 50).map(saleRow))}
        </>
      )}
    </>
  );
}

