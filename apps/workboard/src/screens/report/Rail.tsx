import { useEffect, useRef, useState, type ReactNode } from "react";
import { CommentText, Memos } from "./Memo";
import { Receipt } from "./Receipt";
import { Ico, type IconName } from "./icons";
import {
  allRows,
  bareRows,
  checkClock,
  clock,
  day,
  gengarFound,
  isLateOpen,
  isLost,
  lateProposals,
  offShiftOf,
  platformName,
  plural,
  plus,
  salesCount,
  takenFromMeOpen,
  usd,
  waitingRows,
  type Row,
} from "./model";
import { reducedMotion, type BoardApi } from "./useBoard";

/**
 * The rail beside the pages, its own card: the person's total and count («было …» after a change), Hub's and Gengar's
 * check, what wants a look, the pages (a press goes to one; the one in view is marked), the comment for the next shift,
 * and at the bottom the ONE press of the phase with a line under it. Counted, it is the report's receipt.
 */
export function Rail({ api }: { api: BoardApi }) {
  const { board, own, preview } = api;
  const counted = board.phase === "counted";
  return (
    <aside className="rail" aria-label="Итог смены">
      <div className="rail-b">
        {/* Counted, what waits for the person comes before the receipt: on a laptop the receipt fills the rail. */}
        {counted && own && <Notices api={api} />}
        {counted ? <Receipt api={api} /> : <Sum api={api} />}
        {!preview && <Checks api={api} />}
        {preview && (
          <div className="blk nts"><Notice icon="clock">Сдача смены здесь ещё не включена. Отчёт по-прежнему собирает Генгар по /smena, а вы отправляете его в «Отчётность». Здесь видно, как его посчитает Hub.</Notice></div>
        )}
        {!counted && own && !preview && <Notices api={api} />}
        {!counted && <Pages api={api} />}
        {own && !preview && !counted ? <Memos api={api} /> : <CommentText report={api.report} />}
      </div>
      <Foot api={api} />
    </aside>
  );
}

/** «Ваши продажи», the total, «было …» after a change, the count; «Ещё» while the draft is edited. */
function Sum({ api }: { api: BoardApi }) {
  const { board, own } = api;
  const total = board.totals.nowMills;
  // «Было»: Hub's (a correction, Gengar's edits), or what the person saw when «Подтверждаю» was refused as changed.
  const was = api.seenMills ?? board.totals.wasMills;
  const label = !own ? "Продаж в отчёте"
    : board.phase === "fixing" ? "Правка отчёта"
      : board.phase === "checking" && board.candidate !== null ? `Сдано в ${clock(board.candidate.madeAt)}` : "Ваши продажи";
  return (
    <div className="sum">
      <div className="sum-l">
        <span>{label}</span>
        {api.editing && (
          <button type="button" className="more" data-panel="more" aria-haspopup="menu" aria-expanded={api.panel === "more"}
            onClick={() => api.setPanel(api.panel === "more" ? null : "more")}>Ещё</button>
        )}
      </div>
      <div className="sum-v">{usd(total)}</div>
      {was !== null && was !== total && <div className="sum-was">было <s>{usd(was)}</s></div>}
      <div className="sum-s">{salesCount(board.totals.count)}</div>
    </div>
  );
}

/** Hub's check of the wallets and Gengar's of the chats, while the report is checked and to be confirmed. */
function Checks({ api }: { api: BoardApi }) {
  const { board } = api;
  const candidate = board.candidate;
  if (candidate === null || (board.phase !== "checking" && board.phase !== "confirm")) return null;
  const hub = candidate.hub;
  const named = (state: string) => hub.pages.filter((page) => page.state === state).map((page) => page.pageLabel).join(", ");
  const links = (rows: Row[]) => <span className="lks">{rows.map((row) => <button type="button" className="lk" key={row.key} onClick={() => api.show(row.key)}>{row.fan.name ?? row.fan.username ?? ""}</button>)}</span>;
  const lines: ReactNode[] = [];
  if (api.own && candidate.signatureDeclined === true) {
    lines.push(<Check key="declined" icon="pen" tone="wait">Проверка нашла изменения: проверьте и подтвердите</Check>);
  }
  switch (hub.state) {
    case "running": lines.push(<Check key="hub" spin>Hub сверяет суммы с кошельками</Check>); break;
    case "matched": lines.push(<Check key="hub" icon="check" tone="ok">Hub: суммы сошлись с кошельками</Check>); break;
    case "found": {
      const found = allRows(board).filter((row) => row.foundByHub === true);
      lines.push(
        <Check key="hub" icon="plus" tone="wait">
          Hub дочитал кошельки: ещё {salesCount(hub.foundCount)}, {plus(hub.foundMills)}
          {found.length > 0 && <span className="lks"><button type="button" className="lk" onClick={() => api.showMany(found.map((row) => row.key))}>Показать</button></span>}
        </Check>,
      );
      break;
    }
    // «Можно подтвердить» only where the person can: in «Проверка» there is no «Подтверждаю» yet.
    case "unchecked": lines.push(<Check key="hub" icon="clock" tone="wait">Hub не сверил {named("unchecked")}<small>{board.phase === "checking" ? "Сверка придёт позже." : "Можно подтвердить, сверка придёт позже."}</small></Check>); break;
    // ChatSpace reads the statement on the board's ask within a minute or two; the check lets the person confirm after 10.
    case "statement": lines.push(<Check key="hub" spin>Ждём выписку {named("statement")}<small>Не дольше 10 минут</small></Check>); break;
  }
  const gengar = candidate.gengar.state;
  const found = gengar === "found" ? gengarFound(board) : null;
  if (gengar === "reading") lines.push(<Check key="gengar" spin>Генгар читает переписки<small>Обычно пара минут, не дольше 10</small></Check>);
  else if (gengar === "silent") lines.push(<Check key="gengar" icon="clock" tone="wait">Генгар молчит 10 минут<small>Можно подтвердить по проверке Hub, его проверка придёт позже.</small></Check>);
  else if (found !== null) lines.push(<Check key="gengar" icon="spark" tone="tint">{found.words}{links(found.rows)}</Check>);
  else if (gengar === "found" || gengar === "clean") lines.push(<Check key="gengar" icon="check" tone="ok">Генгар прочитал переписки: замечаний нет</Check>);
  if (board.phase === "confirm") {
    const waiting = waitingRows(board);
    if (waiting.length > 0) lines.push(<Check key="waiting" icon="people" tone="wait">Ждут ответа, в сумму не входят{links(waiting)}</Check>);
  }
  return (
    <div className="blk">
      <ul className="chk">{lines}</ul>
      {board.phase === "checking" && <CheckClock madeAt={candidate.madeAt} />}
    </div>
  );
}

function Check({ icon, tone, spin = false, children }: { icon?: IconName; tone?: "ok" | "wait" | "tint"; spin?: boolean; children: ReactNode }) {
  return <li className={tone ? `is-${tone}` : undefined}>{spin ? <i className="spin" /> : icon && <Ico name={icon} />}<span>{children}</span></li>;
}

/** The check's ten minutes: how long since the hand-in. */
function CheckClock({ madeAt }: { madeAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const time = checkClock(madeAt, now);
  return (
    <>
      <div className="prog" role="progressbar" aria-label="Проверка" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(time.part * 100)}>
        <i style={{ width: `${time.part * 100}%` }} />
      </div>
      <div className="timer"><span>{time.elapsed}</span><span>до {time.limit}</span></div>
    </>
  );
}

/** What wants the person's look, each with the way to its row. */
function Notices({ api }: { api: BoardApi }) {
  const { board, report } = api;
  const bare = useRef(0);
  const rows = allRows(board);
  const go = (row: Row, text = "Показать") => <button type="button" className="lk" onClick={() => api.show(row.key)}>{text}</button>;
  const out: ReactNode[] = [];
  const editing = board.phase === "draft" || board.phase === "fixing";
  const lost = editing ? rows.find(isLost) : undefined;
  if (lost) out.push(<Notice key="lost" icon="plus" tone="wait">Нет в Hub: {lost.fan.name}, {plus(lost.netMills)}. {go(lost)}</Notice>);
  for (const row of rows.filter((one) => one.incoming?.state === "asked")) {
    out.push(<Notice key={`in-${row.key}`} icon="people" tone="wait">{row.incoming!.from.forms.nom} оспаривает вашу продажу {row.fan.name}, {usd(row.netMills)}. {go(row)}</Notice>);
  }
  for (const row of rows.filter((one) => takenFromMeOpen(one) && one.incoming!.canAnswer && one.attention)) {
    out.push(<Notice key={`take-${row.key}`} icon="people" tone="wait">{row.incoming!.from.forms.nom} записывает себе вашу продажу {row.fan.name}, {usd(row.netMills)}. {go(row)}</Notice>);
  }
  if (editing) {
    const waiting = waitingRows(board);
    if (waiting.length > 0) {
      out.push(<Notice key="waiting" icon="clock" tone="wait">Ждут ответа, в сумму не входят: {waiting.map((row, index) => <span key={row.key}>{index > 0 && ", "}{go(row, row.fan.name ?? "")}</span>)}</Notice>);
    }
    const bareList = bareRows(board);
    if (bareList.length > 0) {
      out.push(
        <Notice key="bare" icon="note" tone="wait">
          Без комментария: {salesCount(bareList.length)} от{"\u00a0"}$30.{" "}
          <button type="button" className="lk" onClick={() => {
            const row = bareList[bare.current++ % bareList.length]!;
            void api.commitNote().then(() => {
              api.openNote(row.key, "");
              api.show(row.key);
            });
          }}>Написать</button>
        </Notice>,
      );
    }
  }
  if (board.phase === "counted") {
    const late = rows.find(isLateOpen);
    if (late) out.push(<Notice key="late" icon="plus" tone="wait">После сдачи пришла продажа {late.fan.name}, {usd(late.netMills)}. {go(late)}</Notice>);
    const cards = lateProposals(board);
    if (cards.length > 0) out.push(<Notice key="cards" icon="spark" tone="wait">Генгар дочитал: {cards.length} {plural(cards.length, "правка", "правки", "правок")}. {go(cards[0]!)}</Notice>);
    if (board.candidate?.gengar.state === "silent") out.push(<Notice key="silent" icon="clock">Подтверждён по проверке Hub. Генгар дочитает позже, его проверка придёт сюда же.</Notice>);
    const post = board.post ?? null;
    if (post?.late && post.copiedAt === null) {
      out.push(<Notice key="post-late" icon="clock" tone="wait">Пост за {day(`${report.shift.reportDate}T12:00:00+03:00`)} опоздал больше чем на сутки: ledger его сам не примет</Notice>);
    }
    const changed = (post?.models ?? []).filter((model) => model.copiedAt !== null && model.changedSinceCopy);
    if (changed.length > 0 && report.posts.length > 1) {
      out.push(<Notice key="post-changed" icon="pen" tone="wait">Пост {changed.map((model) => model.modelName).join(", ")} изменился. Исправьте прежний пост в «Отчётности», новый не пишите</Notice>);
    } else if (post && post.copiedAt !== null && report.posts.length <= 1 && (post.changedSinceCopy || changed.length > 0)) {
      // One model: the report's own mark. Two: only a model whose post was copied (above), never one never sent.
      out.push(<Notice key="post-changed" icon="pen" tone="wait">Пост изменился. Исправьте прежний пост в «Отчётности», новый не пишите</Notice>);
    } else if (post && post.copiedAt !== null && post.seen === false) {
      out.push(<Notice key="post-unseen" icon="clock">Пост в «Отчётность» ещё не пришёл</Notice>);
    }
  }
  return out.length > 0 ? <div className="blk nts">{out}</div> : null;
}

function Notice({ icon, tone, children }: { icon: IconName; tone?: "wait"; children: ReactNode }) {
  return <div className={`nt${tone ? ` is-${tone}` : ""}`}><Ico name={icon} /><span className="t">{children}</span></div>;
}

/** «Страницы»: each page's sum; a press scrolls to its card, the card in view is marked. «Не в смене: …» under them. */
function Pages({ api }: { api: BoardApi }) {
  const { board } = api;
  const current = usePageInView(api);
  const models = [...new Set(board.columns.map((column) => column.modelName ?? ""))];
  const off = offShiftOf(board);
  return (
    <div className="blk">
      <div className="blk-h">Страницы</div>
      <ul className="bk">
        {models.map((model) => [
          models.length > 1 && model !== "" ? <li className="bk-m" key={`m-${model}`}>{model}</li> : null,
          ...board.columns.filter((column) => (column.modelName ?? "") === model).map((column) => (
            <li key={column.pageLabel}>
              <button type="button" className={column.pageLabel === current.label ? "is-on" : undefined} aria-current={column.pageLabel === current.label ? "location" : undefined}
                onClick={() => current.go(column.pageLabel)}>
                <span className="n">{column.pageLabel}</span><span className="p">{platformName(column.platform)}</span>
                <span className={`v${column.sumMills === 0 ? " is-zero" : ""}`}>{usd(column.sumMills)}</span>
              </button>
            </li>
          )),
        ])}
      </ul>
      {off !== "" && <div className="offs">{off}</div>}
    </div>
  );
}

/** The page whose card is in view in the list, and the way to scroll to one (the marker waits for the scroll). */
function usePageInView(api: BoardApi) {
  const first = api.board.columns[0]?.pageLabel ?? null;
  const [label, setLabel] = useState(first);
  const hold = useRef(0);
  useEffect(() => {
    const main = api.mainRef.current;
    if (!main) return;
    let frame = 0;
    const spy = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (Date.now() < hold.current) return;
        const sections = [...main.querySelectorAll<HTMLElement>("[data-page]")];
        if (sections.length === 0) return;
        const top = main.getBoundingClientRect().top + 24;
        let now = sections[0]!.dataset.page ?? null;
        for (const section of sections) if (section.getBoundingClientRect().top <= top) now = section.dataset.page ?? now;
        if (main.scrollTop > 4 && main.scrollTop + main.clientHeight >= main.scrollHeight - 2) now = sections.at(-1)!.dataset.page ?? now;
        setLabel(now);
      });
    };
    main.addEventListener("scroll", spy, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      main.removeEventListener("scroll", spy);
    };
  }, [api.mainRef]);
  const go = (page: string) => {
    const main = api.mainRef.current;
    const section = main?.querySelector<HTMLElement>(`[data-page="${CSS.escape(page)}"]`);
    if (!main || !section) return;
    setLabel(page);
    hold.current = Date.now() + 900;
    const top = section.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    main.scrollTo({ top: Math.max(0, top - 4), behavior: reducedMotion() ? "auto" : "smooth" });
  };
  return { label, go };
}

/** The rail's bottom: the ONE press of the phase, the line under it, «?» with the keys. */
function Foot({ api }: { api: BoardApi }) {
  const { board, report, own, preview, pending, host } = api;
  let press: ReactNode = null;
  let line: string;
  if (preview) {
    line = "Здесь только видно, как Hub посчитает смену.";
  } else if (!own) {
    line = `Менять этот отчёт может только ${report.shift.personName}.`;
  } else if (board.phase === "draft" || board.phase === "fixing") {
    const fixing = board.phase === "fixing";
    press = fixing ? (
      <div className="btns">
        <button type="button" className="btn btn--sec" disabled={pending} onClick={() => void api.run({ op: "reopenCancel" })}>Отмена</button>
        <button type="button" className="btn btn--main" disabled={pending} onClick={() => void api.submit()}>Сдать заново</button>
      </div>
    ) : <button type="button" className="btn btn--main btn--wide" disabled={pending} onClick={() => void api.submit()}>Сдать смену</button>;
    // People asked on the first days whether screenshots go with the report (19.11): they do not.
    line = fixing ? "Учтённый отчёт действует, пока вы не подтвердите новый." : "Вы отвечаете за отчёт материально. Скрины не нужны.";
  } else if (board.phase === "checking") {
    // The second step is easy to miss (19.11: a person closed the board while it checked and never confirmed).
    const signed = board.candidate?.signed === true;
    press = <button type="button" className="btn btn--main btn--wide" disabled>Подтверждаю</button>;
    const leave = host === "frame" ? "Можно свернуть" : "Можно закрыть";
    line = signed ? `${leave}: ничего не найдём, отчёт учтётся сам. Найдём, позовём подтвердить.` : "Дальше «Подтверждаю»: без него отчёт не учтён.";
  } else if (board.phase === "confirm") {
    press = (
      <div className="btns">
        <button type="button" className="btn btn--sec" disabled={pending} onClick={() => void api.reopen()}>Исправить</button>
        <button type="button" className="btn btn--main" disabled={pending || !board.canConfirm || board.candidate === null} onClick={() => void api.confirm()}>Подтверждаю</button>
      </div>
    );
    line = "Вы отвечаете за отчёт материально.";
  } else {
    const post = board.post ?? null;
    const copiedOf = (slug: string) => post?.models.find((model) => model.modelSlug === slug)?.copiedAt != null;
    press = (
      <>
        {report.posts.map((one) => {
          // One button per model of the shift: «Отчётность» takes one post per model, never two joined.
          const copied = copiedOf(one.modelSlug);
          const two = report.posts.length > 1;
          const label = copied ? two ? `Пост ${one.modelName} скопирован` : "Пост скопирован" : two ? `Скопировать пост: ${one.modelName}` : "Скопировать пост";
          return (
            <button key={one.modelSlug} type="button" className={`btn ${copied ? "btn--sec" : "btn--main"} btn--wide`} title={copied ? "Скопировать ещё раз" : undefined}
              onClick={() => api.copyPost(one.modelSlug)}>
              <Ico name={copied ? "check" : "copy"} size={15} />{label}
            </button>
          );
        })}
        <button type="button" className="btn btn--sec btn--wide" disabled={pending} onClick={() => void api.reopen()}>Исправить</button>
      </>
    );
    line = report.posts.some((one) => !copiedOf(one.modelSlug)) ? "Вставьте пост в «Отчётность». Только текст, скрины не нужны." : "Только текст, скрины не нужны.";
  }
  return (
    <div className="rail-f">
      {press}
      <div className="fl">
        <span>{line}</span>
        <button type="button" className="kq" data-panel="keys" aria-label="Клавиши" title="Клавиши" aria-expanded={api.panel === "keys"}
          onClick={() => api.setPanel(api.panel === "keys" ? null : "keys")}>?</button>
      </div>
    </div>
  );
}
