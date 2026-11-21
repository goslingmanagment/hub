import { useEffect, useRef, useState } from "react";
import type { BoardApi } from "./useBoard";

type Report = BoardApi["report"];
type ModelComment = NonNullable<Report["view"]>["comments"][number];

/**
 * «Комментарий для следующей смены» in the rail: one field per post (a model's), each saving its own model; a report
 * with no page yet, the one general field. Two models or more: each field named by its model.
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

/** One comment for the next shift (a model's, or the general one): saved on Enter, on leaving the field, and after a pause in typing. */
function Memo({ api, model, id }: { api: BoardApi; model: ModelComment | null; id: string }) {
  const saved = model?.comment ?? api.report.view?.comment ?? "";
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
    void api.run(model === null ? { op: "comment", comment: value } : { op: "comment", comment: value, modelSlug: model.modelSlug });
  };
  return (
    <textarea className="fld memo" id={id} rows={3} value={text} placeholder="Что важно знать следующей смене" maxLength={2000}
      onChange={(event) => {
        const value = event.target.value;
        setText(value);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(value), 1_000);
      }}
      onBlur={() => flush(text)}
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
