import { useEffect, useRef, useState, type ReactNode } from "react";
import { CommentText, Memos } from "./Memo";
import { Receipt } from "./Receipt";
import { Ico } from "./icons";
import { bareRows, byModel, checkClock, fanOf, offShiftOf, platformName, salesCount, usd } from "./model";
import { reducedMotion, type BoardApi } from "./useBoard";
import { checksOf, noticesOf, pressLineOf, sumLabelOf, type RailLine } from "./words";

/**
 * The rail beside the pages, its own card: the total and count («было …» after a change), Hub's and Gengar's check,
 * what wants a look, the pages (a press goes to one; the one in view is marked), the comment for the next shift (a
 * field only while the report is edited: the hand-in takes it), and at the bottom the ONE press of the phase with the
 * line of what it signs. Counted, it is the report's receipt.
 */
export function Rail({ api }: { api: BoardApi }) {
  const { board, own, preview, editing } = api;
  const counted = board.phase === "counted";
  const notices = <Lines api={api} kind="notices" lines={noticesOf(board, api.report, own && !preview)} />;
  return (
    <aside className="rail" aria-label="Итог смены">
      <div className="rail-b">
        {/* Counted, what waits for the person comes before the receipt: on a laptop the receipt fills the rail. */}
        {counted && notices}
        {counted ? <Receipt api={api} /> : <Sum api={api} />}
        {!preview && <Lines api={api} kind="checks" lines={checksOf(board, own)} clock={board.phase === "checking" ? board.candidate?.madeAt : undefined} />}
        {preview && (
          <div className="blk nts"><div className="nt"><Ico name="clock" /><span className="t">Сдача смены здесь ещё не включена. Отчёт по-прежнему собирает Генгар по /smena, а вы отправляете его в «Отчётность». Здесь видно, как его посчитает Hub.</span></div></div>
        )}
        {!counted && notices}
        {!counted && <Pages api={api} />}
        {editing ? <Memos api={api} /> : <CommentText report={api.report} />}
      </div>
      <Foot api={api} />
    </aside>
  );
}

/** The total, «было …» after a change, the count; «Ещё» while the draft is edited. */
function Sum({ api }: { api: BoardApi }) {
  const { board, own } = api;
  const total = board.totals.nowMills;
  // «Было»: Hub's (a correction, Gengar's edits), or what the person saw when «Подтверждаю» was refused as changed.
  const was = api.seenMills ?? board.totals.wasMills;
  return (
    <div className="sum">
      <div className="sum-l">
        <span>{sumLabelOf(board, own)}</span>
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

/** Lines of the rail (words.ts): the check (with its clock while it runs) or what wants a look. */
function Lines({ api, kind, lines, clock }: { api: BoardApi; kind: "checks" | "notices"; lines: RailLine[]; clock?: string | undefined }) {
  const bare = useRef(0);
  if (lines.length === 0 && clock === undefined) return null;
  const go = (one: RailLine): ReactNode => {
    if (one.bare) {
      return (
        <button type="button" className="lk" onClick={() => {
          const rows = bareRows(api.board);
          const row = rows[bare.current++ % rows.length];
          if (row === undefined) return;
          void api.commitNote().then(() => {
            api.openNote(row.key, "");
            api.show(row.key);
          });
        }}>{one.link}</button>
      );
    }
    if (one.rows.length === 0) return null;
    if (one.together || one.link !== null) {
      return <button type="button" className="lk" onClick={() => (one.together ? api.showMany(one.rows.map((row) => row.key)) : api.show(one.rows[0]!.key))}>{one.link}</button>;
    }
    return <span className="lks">{one.rows.map((row) => <button type="button" className="lk" key={row.key} onClick={() => api.show(row.key)}>{fanOf(row)}</button>)}</span>;
  };
  const checks = kind === "checks";
  return (
    <div className={`blk${checks ? "" : " nts"}`}>
      {checks ? (
        <ul className="chk">
          {lines.map((one) => (
            <li className={one.tone ? `is-${one.tone}` : undefined} key={one.key}>
              {one.mark === "spin" ? <i className="spin" /> : <Ico name={one.mark} />}
              <span>{one.text}{one.small !== null && <small>{one.small}</small>}{go(one)}</span>
            </li>
          ))}
        </ul>
      ) : lines.map((one) => (
        <div className={`nt${one.tone === "wait" ? " is-wait" : ""}`} key={one.key}>
          {one.mark === "spin" ? <i className="spin" /> : <Ico name={one.mark} />}
          <span className="t">{one.text}{" "}{go(one)}</span>
        </div>
      ))}
      {clock !== undefined && <CheckClock madeAt={clock} />}
    </div>
  );
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

/** «Страницы»: each page's sum; a press scrolls to its card, the card in view is marked. «Не в смене: …» under them. */
function Pages({ api }: { api: BoardApi }) {
  const { board } = api;
  const current = usePageInView(api);
  const off = offShiftOf(board);
  return (
    <div className="blk">
      <div className="blk-h">Страницы</div>
      <ul className="bk">
        {byModel(board.columns).map((group) => [
          group.model === null ? null : <li className="bk-m" key={`m-${group.model}`}>{group.model}</li>,
          ...group.columns.map((column) => (
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

/**
 * The rail's bottom: the ONE press of the phase, the line of what it signs, «?» with the keys. A press never waits for
 * the comment's save to let go of the mouse: it saves it first itself.
 */
function Foot({ api }: { api: BoardApi }) {
  const { board, report, own, preview, pending, host } = api;
  let press: ReactNode = null;
  if (own && !preview) {
    if (board.phase === "draft" || board.phase === "fixing") {
      press = board.phase === "fixing" ? (
        <div className="btns">
          <button type="button" className="btn btn--sec" disabled={pending} onClick={() => void api.run({ op: "reopenCancel" })}>Отмена</button>
          <button type="button" className="btn btn--main" disabled={pending} onClick={() => void api.submit()}>Сдать заново</button>
        </div>
      ) : <button type="button" className="btn btn--main btn--wide" disabled={pending} onClick={() => void api.submit()}>Сдать смену</button>;
    } else if (board.phase === "checking") {
      press = <button type="button" className="btn btn--main btn--wide" disabled>Подтверждаю</button>;
    } else if (board.phase === "confirm") {
      press = (
        <div className="btns">
          <button type="button" className="btn btn--sec" disabled={pending} onClick={() => void api.reopen()}>Исправить</button>
          <button type="button" className="btn btn--main" disabled={pending || !board.canConfirm || board.candidate === null} onClick={() => void api.confirm()}>Подтверждаю</button>
        </div>
      );
    } else {
      const copiedOf = (slug: string) => board.post?.models.find((model) => model.modelSlug === slug)?.copiedAt != null;
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
    }
  }
  const canFind = own && !preview && board.phase !== "checking";
  const line = pressLineOf(board, report, { own, preview, host });
  return (
    <div className="rail-f">
      {press}
      {canFind && (
        <button type="button" className="btn btn--quiet btn--sm btn--wide" disabled={pending} onClick={() => void api.openFind()}>
          Не вижу свою продажу
        </button>
      )}
      <div className="fl">
        <span>{line}</span>
        <button type="button" className="kq" data-panel="keys" aria-label="Клавиши" title="Клавиши" aria-expanded={api.panel === "keys"}
          onClick={() => api.setPanel(api.panel === "keys" ? null : "keys")}>?</button>
      </div>
    </div>
  );
}
