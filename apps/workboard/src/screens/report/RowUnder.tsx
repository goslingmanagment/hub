import { useState, type KeyboardEvent, type ReactNode } from "react";
import { SHIFT_REPORT_QUICK_WORDS, SHIFT_REPORT_TAKE_REASONS } from "@agency_hub_core/contracts";
import { GengarCard } from "./GengarCard";
import { Ico } from "./icons";
import { deciderOf, noteOf, whyFormOf, type Row } from "./model";
import { focusRow, type AskOpen, type BoardApi } from "./useBoard";
import { stripsOf, type StripAct } from "./words";

/**
 * What stands under a row, inside its card: the site's «not found», the form of why, the strips of a question, a take
 * and a colleague's word, Gengar's card and its «Не согласен», the comment (its form or its line). A sale of the shift
 * before shows only its comment (the next shift reads it). The text being typed is the field's own.
 */
export function RowUnder({ api, row }: { api: BoardApi; row: Row }) {
  const parts: ReactNode[] = [];
  if (row.before === null) {
    if (api.miss !== null && api.miss.key === row.key) parts.push(<div className="miss" key="miss">{api.miss.words}</div>);
    if (api.ask?.key === row.key) parts.push(<AskForm api={api} row={row} ask={api.ask} key={`ask-${api.ask.choice.key}`} />);
    for (const strip of stripsOf(api.board, row, { own: api.own, editing: api.editing })) {
      parts.push(
        <div className={`strip is-${strip.tone}`} key={strip.key}>
          <Ico name={strip.mark} />
          <span className="t">{strip.lead !== null && <b>{strip.lead}</b>}{strip.text}</span>
          {strip.acts.length > 0 && <span className="acts">{strip.acts.map((act) => <StripPress api={api} row={row} act={act} key={act} />)}</span>}
        </div>,
      );
    }
    if (row.proposal !== null && row.proposal.kind === "owner_change" && (api.board.phase === "confirm" || row.proposal.state === "late")) {
      parts.push(<GengarCard api={api} row={row} card={row.proposal} key="card" />);
    }
    if (api.refuse?.key === row.key) parts.push(<RefuseForm api={api} row={row} key="refuse" />);
  }
  const note = noteOf(row);
  if (api.edit === row.key) parts.push(<NoteForm api={api} key="note" />);
  else if (note !== null) parts.push(<NoteLine api={api} row={row} note={note} key="note" />);
  return parts.length > 0 ? <div className="ux">{parts}</div> : null;
}

const STRIP_PRESS: Record<StripAct, string> = { unask: "Отменить", understood: "Понятно", agree: "Согласен", disagree: "Не согласен" };

function StripPress({ api, row, act }: { api: BoardApi; row: Row; act: StripAct }) {
  if (act === "unask") return <button type="button" className="lk" disabled={api.pending} onClick={() => api.answer(row, act)}>{STRIP_PRESS[act]}</button>;
  return <button type="button" className="btn btn--sec btn--xs" disabled={api.pending} onClick={() => api.answer(row, act)}>{STRIP_PRESS[act]}</button>;
}

/** The one line of why a word takes: a question, «Моя», a word the decider decides. */
function AskForm({ api, row, ask }: { api: BoardApi; row: Row; ask: AskOpen }) {
  const [text, setText] = useState(ask.initial);
  const words = whyFormOf(api.board, row, ask.choice);
  const id = `ask-${row.key}`;
  const cancel = () => {
    api.setAsk(null);
    focusRow(row.key);
  };
  return (
    <div className="form">
      <label htmlFor={id}>{words.label}</label>
      <div className="form-r">
        <input className="fld" id={id} ref={focusField} value={text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => onField(event, () => void api.sendAsk(text), cancel)} />
      </div>
      <div className="form-r">
        {words.reasons && <QuickWords words={SHIFT_REPORT_TAKE_REASONS} text={text} onText={setText} />}
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--sm" onClick={cancel}>Отмена</button>
        <button type="button" className="btn btn--main btn--sm" disabled={text.trim() === "" || api.pending} onClick={() => void api.sendAsk(text)}>{words.send}</button>
      </div>
      <div className="hint">{words.hint}</div>
    </div>
  );
}

/** «Не согласен» with Gengar's card: why, in one line, for whoever decides the sale. */
function RefuseForm({ api, row }: { api: BoardApi; row: Row }) {
  const [text, setText] = useState("");
  const id = `refuse-${row.key}`;
  const cancel = () => {
    api.setRefuse(null);
    focusRow(row.key);
  };
  return (
    <div className="form">
      <label htmlFor={id}>Почему вы не согласны?</label>
      <div className="form-r">
        <input className="fld" id={id} ref={focusField} value={text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => onField(event, () => void api.sendRefuse(text), cancel)} />
        <button type="button" className="btn btn--quiet btn--sm" onClick={cancel}>Отмена</button>
        <button type="button" className="btn btn--main btn--sm" disabled={text.trim() === "" || api.pending} onClick={() => void api.sendRefuse(text)}>Не согласен</button>
      </div>
      <div className="hint">Решит {deciderOf(api.board, row).words}: Генгар предложил, вы объясните.</div>
    </div>
  );
}

/** A sale's comment being written: Enter saves, Esc leaves (the focus back on its row); the quick words append. */
function NoteForm({ api }: { api: BoardApi }) {
  const [text, setText] = useState(api.noteDraft.current);
  const change = (value: string) => {
    setText(value);
    api.noteDraft.current = value;
  };
  const save = () => void api.commitNote();
  return (
    <div className="form">
      <textarea className="fld" ref={focusField} rows={2} value={text} placeholder="Комментарий к продаже" maxLength={300} aria-label="Комментарий к продаже"
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => onField(event, save, api.cancelNote)} />
      <div className="form-r">
        <QuickWords words={SHIFT_REPORT_QUICK_WORDS} text={text} onText={change} />
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--sm" onClick={api.cancelNote}>Отмена</button>
        <button type="button" className="btn btn--main btn--sm" onClick={save}>Сохранить</button>
      </div>
    </div>
  );
}

/** A row's saved comment: the person's, someone else's (named), or Gengar's; a press edits it. */
function NoteLine({ api, row, note }: { api: BoardApi; row: Row; note: NonNullable<ReturnType<typeof noteOf>> }) {
  const body = (
    <>
      <Ico name="note" size={15} />
      <span className="t">{note.text}{note.by !== null && <span className="by"> {note.by}</span>}</span>
    </>
  );
  return row.canNote && !api.preview
    ? <button type="button" className="note" title="Изменить комментарий" onClick={() => api.openNote(row.key)}>{body}</button>
    : <div className="note">{body}</div>;
}

function QuickWords({ words, text, onText }: { words: readonly string[]; text: string; onText: (text: string) => void }) {
  return (
    <div className="qw">
      {words.map((word) => (
        <button type="button" key={word} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          const was = text.replace(/[\s,]+$/, "");
          onText(was ? `${was}, ${word}` : word);
        }}>{word}</button>
      ))}
    </div>
  );
}

/**
 * A field that opens takes the focus, the caret at its end. A frame later: a menu that closed in the same press gives
 * the focus back to its pill first, and the field takes it after.
 */
function focusField(element: HTMLInputElement | HTMLTextAreaElement | null) {
  if (!element) return;
  requestAnimationFrame(() => {
    if (!element.isConnected || document.activeElement === element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  });
}

/** Enter saves a field (Shift+Enter is a new line of a comment), Esc leaves it. */
function onField(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, save: () => void, cancel: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    save();
  }
}
