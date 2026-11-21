import type { KeyboardEvent, ReactNode } from "react";
import { SHIFT_REPORT_QUICK_WORDS, SHIFT_REPORT_TAKE_REASONS } from "@agency_hub_core/contracts";
import { GengarCard } from "./GengarCard";
import { Ico, type IconName } from "./icons";
import {
  canTick,
  deciderForms,
  deciderOf,
  footOf,
  noteOf,
  said,
  takeStands,
  takenFromMeOpen,
  upper,
  type Row,
} from "./model";
import type { BoardApi } from "./useBoard";

/**
 * What stands under a row, inside its card: the site's «not found», the form «Почему продажа ваша?», the strips of a
 * question, a take and a colleague's word, Gengar's card and its «Не согласен», the comment (its form or its line).
 * A sale of the shift before shows only its comment (the next shift reads it).
 */
export function RowUnder({ api, row }: { api: BoardApi; row: Row }) {
  const parts: ReactNode[] = [];
  if (row.before === null) {
    if (api.miss !== null && api.miss.key === row.key) parts.push(<div className="miss" key="miss">{api.miss.words}</div>);
    if (api.ask?.key === row.key) parts.push(<AskForm api={api} row={row} key="ask" />);
    parts.push(...strips(api, row));
    if (row.proposal !== null && row.proposal.kind === "owner_change" && (api.board.phase === "confirm" || row.proposal.state === "late")) {
      parts.push(<GengarCard api={api} row={row} card={row.proposal} key="card" />);
    }
    if (api.refuse?.key === row.key) parts.push(<RefuseForm api={api} row={row} key="refuse" />);
  }
  const note = noteOf(row);
  if (api.edit?.key === row.key) parts.push(<NoteForm api={api} key="note" />);
  else if (note !== null) parts.push(<NoteLine api={api} row={row} note={note} key="note" />);
  return parts.length > 0 ? <div className="ux">{parts}</div> : null;
}

function Strip({ icon, tone, children, actions }: { icon: IconName; tone: "wait" | "calm"; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`strip is-${tone}`}>
      <Ico name={icon} />
      <span className="t">{children}</span>
      {actions && <span className="acts">{actions}</span>}
    </div>
  );
}

/** The strips of a question, a take and a colleague's word on the row. */
function strips(api: BoardApi, row: Row): ReactNode[] {
  const { board, own, pending, run } = api;
  const decider = deciderOf(board, row).words;
  const out: ReactNode[] = [];
  const asked = row.ask;
  const undo = (label = "Отменить") => <button type="button" className="lk" onClick={() => void api.unask(row)}>{label}</button>;
  if (asked !== null && asked.state === "asked") {
    const whom = deciderForms(board, row)?.acc ?? "владельца";
    const rule = row.rule.owner;
    out.push(
      <Strip icon="clock" tone="wait" key="asked" actions={own && undo()}>
        {asked.oldWay
          // The colleague hands in the old way: the question went to the decider at once (the server's words).
          ? <>Вы спросили{said(asked.note)}. {upper(row.reasonWords)}.</>
          // A colleague's sale someone else already wrote to themself or disputed: the decider's, the rule's until then.
          : asked.to === "owner" && (rule.kind === "user" || rule.kind === "share" || rule.kind === "waiting")
          ? <>Вы спросили {whom}{said(asked.note)}. До ответа продажа {rule.words}.</>
          : asked.to === "owner"
          ? <>Вы спросили {whom}{said(asked.note)}. До ответа продажа в общаке.</>
          : <>Вы спросили {asked.toUser?.forms.acc ?? ""}{said(asked.note)}. Согласится, продажа станет {asked.want.kind === "share" ? "пополам" : "вашей"}.</>}
      </Strip>,
    );
  }
  // Written to the person at once (a take): the colleague is told and may object; «Отменить» gives it back.
  if (asked !== null && takeStands(row)) {
    const who = asked.toUser?.forms;
    out.push(
      <Strip icon="people" tone="calm" key="taken" actions={own && canTick(board, row, api.preview) && undo()}>
        {asked.want.kind === "share" ? `Вы записали продажу пополам с ${who?.ins ?? "коллегой"}` : "Вы записали продажу себе"}{said(asked.note)}.
        {" "}{who?.nom ?? "Коллега"} увидит это у себя и может не согласиться.
      </Strip>,
    );
  }
  if (asked !== null && asked.state === "disputed") {
    const who = asked.toUser;
    out.push(
      <Strip icon="people" tone="calm" key="disputed">
        {who ? `${who.forms.nom} не согласен. Спор решит ${decider}, до его ответа продажа ${who.forms.gen}.` : `Спор решит ${decider}.`}
      </Strip>,
    );
  }
  const claim = row.incoming;
  // A colleague wrote the person's sale to themself (a take): counted as written; «Понятно» or «Не согласен».
  if (claim !== null && takenFromMeOpen(row)) {
    const claimId = claim.claimId;
    out.push(
      <Strip icon="people" tone="wait" key="incoming" actions={claim.canAnswer && (
        <>
          <button type="button" className="btn btn--sec btn--xs" disabled={pending} onClick={() => void run({ op: "claim", claimId, answer: "agree" }, "Записано")}>Понятно</button>
          <button type="button" className="btn btn--sec btn--xs" disabled={pending} onClick={() => void run({ op: "claim", claimId, answer: "disagree" }, `Спор решит ${decider}`)}>Не согласен</button>
        </>
      )}>
        <b>{claim.from.forms.nom} {claim.statement === "share" ? "записывает эту продажу пополам с вами" : "записывает эту продажу себе"}</b>
        {claim.note ? `${said(claim.note)}.` : "."} Если не согласны, спор решит {decider}.
      </Strip>,
    );
  }
  if (claim !== null && claim.state === "asked") {
    const claimId = claim.claimId;
    out.push(
      <Strip icon="people" tone="wait" key="incoming" actions={claim.canAnswer && (
        <>
          <button type="button" className="btn btn--sec btn--xs" disabled={pending}
            onClick={() => void run({ op: "claim", claimId, answer: "agree" }, claim.statement === "share" ? "Продажа теперь пополам" : `Продажа теперь ${claim.from.forms.gen}`)}>Согласен</button>
          <button type="button" className="btn btn--sec btn--xs" disabled={pending} onClick={() => void run({ op: "claim", claimId, answer: "disagree" }, `Спор решит ${decider}`)}>Не согласен</button>
        </>
      )}>
        <b>{claim.from.forms.nom} {claim.statement === "share" ? "предлагает делить эту продажу пополам" : "считает эту продажу своей"}</b>
        {claim.note ? `${said(claim.note)}.` : "."} Пока вы не ответили, она ждёт, остальное учтено.
      </Strip>,
    );
  }
  if (claim !== null && claim.state === "disputed") {
    out.push(
      <Strip icon="people" tone="calm" key="incoming">
        Вы не согласны с {claim.from.forms.ins}. Спор решит {decider}, до его ответа продажа ваша.
      </Strip>,
    );
  }
  return out;
}

/** «Почему продажа ваша?»: the one line of why a word on someone else's sale takes. */
function AskForm({ api, row }: { api: BoardApi; row: Row }) {
  const ask = api.ask!;
  const asks = ask.choice.asks;
  const send = ask.choice.question === null ? "Забрать"
    : asks?.to === "colleague" ? ask.choice.question.statement === "share" ? "Записать пополам" : "Записать себе"
      : `Спросить ${deciderForms(api.board, row)?.acc ?? "владельца"}`;
  const id = `ask-${row.key}`;
  return (
    <div className="form">
      <label htmlFor={id}>Почему продажа ваша?</label>
      <div className="form-r">
        <input className="fld" id={id} ref={focusField} value={ask.text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
          onChange={(event) => api.setAsk({ ...ask, text: event.target.value })}
          onKeyDown={(event) => onField(event, () => void api.sendAsk(), () => api.setAsk(null))} />
      </div>
      <div className="form-r">
        <QuickWords words={SHIFT_REPORT_TAKE_REASONS} text={ask.text} onText={(text) => api.setAsk({ ...ask, text })} />
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => api.setAsk(null)}>Отмена</button>
        <button type="button" className="btn btn--main btn--sm" disabled={ask.text.trim() === "" || api.pending} onClick={() => void api.sendAsk()}>{send}</button>
      </div>
      <div className="hint">{footOf(api.board, row, ask.choice)}</div>
    </div>
  );
}

/** «Не согласен» with Gengar's card: why, in one line, for whoever decides the sale. */
function RefuseForm({ api, row }: { api: BoardApi; row: Row }) {
  const refuse = api.refuse!;
  const id = `refuse-${row.key}`;
  return (
    <div className="form">
      <label htmlFor={id}>Почему вы не согласны?</label>
      <div className="form-r">
        <input className="fld" id={id} ref={focusField} value={refuse.text} placeholder="Одной строкой" autoComplete="off" maxLength={300}
          onChange={(event) => api.setRefuse({ ...refuse, text: event.target.value })}
          onKeyDown={(event) => onField(event, () => void api.sendRefuse(), () => api.setRefuse(null))} />
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => api.setRefuse(null)}>Отмена</button>
        <button type="button" className="btn btn--main btn--sm" disabled={refuse.text.trim() === "" || api.pending} onClick={() => void api.sendRefuse()}>Не согласен</button>
      </div>
      <div className="hint">Решит {deciderOf(api.board, row).words}: Генгар предложил, вы объясните.</div>
    </div>
  );
}

/** A sale's comment being written: Enter saves, Esc leaves; the quick words append. */
function NoteForm({ api }: { api: BoardApi }) {
  const edit = api.edit!;
  const save = () => void api.commitNote();
  return (
    <div className="form">
      <textarea className="fld" ref={focusField} rows={2} value={edit.draft} placeholder="Комментарий к продаже" maxLength={300} aria-label="Комментарий к продаже"
        onChange={(event) => api.setEdit({ ...edit, draft: event.target.value })}
        onKeyDown={(event) => onField(event, save, () => api.setEdit(null))} />
      <div className="form-r">
        <QuickWords words={SHIFT_REPORT_QUICK_WORDS} text={edit.draft} onText={(draft) => api.setEdit({ ...edit, draft })} />
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => api.setEdit(null)}>Отмена</button>
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

/** A field that opens takes the focus, the caret at its end. */
function focusField(element: HTMLInputElement | HTMLTextAreaElement | null) {
  if (!element || document.activeElement === element) return;
  element.focus({ preventScroll: true });
  element.setSelectionRange(element.value.length, element.value.length);
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
