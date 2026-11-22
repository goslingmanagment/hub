import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardApi } from "./useBoard";

type Report = BoardApi["report"];
type ModelComment = NonNullable<Report["view"]>["comments"][number];

/**
 * «Комментарий для следующей смены» in the rail while the report is edited (the hand-in takes it): one field per post
 * (a model's), each saving its own model; a report with no page yet, the one general field. Two models or more: each
 * field named by its model.
 */
export function Memos({ api }: { api: BoardApi }) {
  const comments = api.report.view?.comments ?? [];
  const named = comments.length > 1;
  return (
    <div className="blk">
      {named ? <span className="lbl">Комментарий для следующей смены</span> : <label className="lbl" htmlFor="memo-0">Комментарий для следующей смены</label>}
      {comments.length === 0
        ? <Memo api={api} model={null} id="memo-0" />
        : comments.map((model, index) => (
          <div key={model.modelSlug}>
            {named && <label className="sub-lbl" htmlFor={`memo-${index}`}>{model.modelName}</label>}
            <Memo api={api} model={model} id={`memo-${index}`} />
          </div>
        ))}
    </div>
  );
}

/**
 * One comment for the next shift (a model's, or the general one): saved on Enter, on leaving the field, after a pause in
 * typing, before the phase's presses (`flushMemos`) and when the board goes away. Its own write: a save never holds
 * «Сдать смену» down.
 */
function Memo({ api, model, id }: { api: BoardApi; model: ModelComment | null; id: string }) {
  const saved = model?.comment ?? api.report.view?.comment ?? "";
  const [text, setText] = useState(saved);
  const last = useRef(saved);
  const typed = useRef(saved);
  const timer = useRef<number | null>(null);
  const inFlight = useRef<Promise<unknown>>(Promise.resolve());
  const slug = model?.modelSlug ?? null;
  const { saveComment, memoFlushes } = api;
  useEffect(() => {
    // Hub's comment comes back with every read; the field keeps what is being typed.
    if (timer.current === null && text === last.current && saved !== last.current) {
      setText(saved);
      typed.current = saved;
      last.current = saved;
    }
  }, [saved, text]);
  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (typed.current !== last.current) {
      last.current = typed.current;
      inFlight.current = saveComment(typed.current, slug);
    }
    return inFlight.current;
  }, [saveComment, slug]);
  useEffect(() => {
    memoFlushes.current.add(flush);
    const flushes = memoFlushes.current;
    return () => {
      flushes.delete(flush);
      // Leaving the board (a link, another shift): what was typed is sent, not dropped.
      void flush();
    };
  }, [flush, memoFlushes]);
  return (
    <textarea className="fld memo" id={id} rows={3} value={text} placeholder="Что важно знать следующей смене" maxLength={2000}
      onChange={(event) => {
        const value = event.target.value;
        setText(value);
        typed.current = value;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void flush(), 1_000);
      }}
      onBlur={() => void flush()}
      onKeyDown={(event) => {
        // One line of text, as the post takes it: Enter saves.
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }} />
  );
}

/** What a reader reads of the comments: one text (one model, or the same for all), else each model's that is written. */
export function commentParts(report: Report): Array<{ name: string | null; text: string }> {
  const comments = report.view?.comments ?? [];
  const texts = comments.map((one) => ({ name: one.modelName, text: one.comment.trim() }));
  if (texts.length === 0) {
    const general = report.view?.comment.trim() ?? "";
    return general === "" ? [] : [{ name: null, text: general }];
  }
  if (texts.every((one) => one.text === texts[0]!.text)) return texts[0]!.text === "" ? [] : [{ name: null, text: texts[0]!.text }];
  return texts.filter((one) => one.text !== "");
}

/** A reader's comments for the next shift: of two models, each with its model's name. */
export function CommentText({ report }: { report: Report }) {
  const parts = commentParts(report);
  if (parts.length === 0) return null;
  return (
    <div className="blk memo-ro">
      <span className="lbl">Комментарий для следующей смены</span>
      {parts.map((one, index) => (
        <p key={one.name ?? index}>{one.name !== null && <b>{one.name}: </b>}{one.text}</p>
      ))}
    </div>
  );
}
