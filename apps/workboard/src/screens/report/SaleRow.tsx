import { Ico } from "./icons";
import { RowUnder } from "./RowUnder";
import {
  amountOf,
  canTick,
  clock,
  fanOf,
  hasMenu,
  isLateOpen,
  isLost,
  noteOf,
  pillOf,
  reasonOf,
  rowTitleOf,
  tickLook,
  wantsNote,
  type Row,
} from "./model";
import type { BoardApi } from "./useBoard";

/**
 * One sale as a row of its page's card: the tick, the time, the site's own words and the fan, the «чья» pill, the
 * amount, the comment icon; line 2 is the sale's number on the site and the reason when it says something. Under it:
 * what stands on the sale (RowUnder).
 */
export function SaleRow({ api, row }: { api: BoardApi; row: Row }) {
  const { board, preview, host, own } = api;
  const fansly = row.platform === "fansly";
  const time = clock(row.occurredAt);
  const findable = host === "frame";
  const findTitle = fansly ? `Показать на Fansly, номер ${row.platformRef ?? ""}` : "Показать в выписке ChatSpace";
  const reason = reasonOf(board, row);
  const amount = amountOf(row);
  const noteShown = noteOf(row) !== null;
  const cls = ["row"];
  if (!row.ticked) cls.push("is-off");
  if (row.before !== null) cls.push("is-before");
  if (api.lit.includes(row.key)) cls.push("is-hl");
  if (api.selected === row.key) cls.push("is-sel");
  return (
    // The keys move the focus from row to row (J, K, the arrows): a focused row is the one they act on.
    <div className={cls.join(" ")} data-row={row.key} tabIndex={-1} onFocus={() => api.setSelected(row.key)}>
      <Tick api={api} row={row} />
      {fansly || !findable
        ? <span className="tm">{time}</span>
        : <button type="button" className="tm is-find" title={findTitle} onClick={() => api.find(row)}>{time}</button>}
      <div className="ds">
        <div className="l1" title={rowTitleOf(row)}>{row.siteWords} <b>{fanOf(row)}</b></div>
        {(row.refLabel !== null || reason !== null) && (
          <div className="l2">
            {row.refLabel !== null && (findable
              ? <button type="button" className="ref" title={findTitle} onClick={() => api.find(row)}>{row.refLabel}</button>
              : <span className="ref is-plain" title={row.platformRef ?? undefined}>{row.refLabel}</span>)}
            {reason !== null && (
              // No break before the reason's first word: line 2 flows as text, never leaving a «·» alone at a line's end.
              <span className={`why${reason.tone === "plain" ? "" : ` is-${reason.tone}`}`}>{row.refLabel !== null ? " · " : ""}{reason.text}</span>
            )}
          </div>
        )}
      </div>
      <div className="ow">
        {own && !preview && isLost(row) && (board.phase === "draft" || board.phase === "fixing") && (
          <button type="button" className="btn btn--sec btn--xs" disabled={api.pending} onClick={() => api.addSighting(row)}><Ico name="plus" size={13} />Добавить</button>
        )}
        {own && !preview && isLateOpen(row) && board.phase === "counted" && row.transactionId !== null && (
          <button type="button" className="btn btn--sec btn--xs" disabled={api.pending} onClick={() => api.resend(row)}>Досдать</button>
        )}
        <OwnerPill api={api} row={row} />
      </div>
      <div className="am" title={amount.title ?? undefined}>
        <div className="am1">{amount.main}</div>
        {amount.sub !== null && <div className="am2">{amount.sub}</div>}
      </div>
      <div className="cmc">
        {row.canNote && !preview && !noteShown && api.edit !== row.key && (
          <button type="button" className={`cm${wantsNote(row) ? " is-ask" : ""}`} aria-label="Комментарий к продаже"
            title={wantsNote(row) ? "Продажа от $30: напишите пару слов" : "Комментарий"}
            onClick={() => api.openNote(row.key)}><Ico name="note" size={17} /></button>
        )}
      </div>
      <RowUnder api={api} row={row} />
    </div>
  );
}

function Tick({ api, row }: { api: BoardApi; row: Row }) {
  const look = tickLook(row);
  if (look === "none") return <span className="ck is-none" aria-hidden="true" />;
  if (look === "x") return <span className="ck is-x" title="Пока не в отчёте" aria-hidden="true" />;
  const cls = look === "mix" ? " is-mix" : look === "on" ? " is-on" : "";
  const inner = look === "mix" ? <Ico name="dash" size={13} /> : look === "on" ? <Ico name="tick" size={14} /> : null;
  const checked = look === "mix" ? "mixed" as const : look === "on";
  const label = `${row.siteWords} ${fanOf(row)}, ${clock(row.occurredAt)}`;
  if (!canTick(api.board, row, api.preview)) {
    return <span className={`ck${cls}`} role="checkbox" aria-checked={checked} aria-disabled="true" aria-label={label}>{inner}</span>;
  }
  const tip = look === "mix" ? "Ждём ответа. Нажмите, чтобы отменить вопрос"
    : row.ask?.taken === true ? `${row.ask.want.kind === "share" ? "Записано пополам" : "Записано вам"}. Снять галочку: вернуть ${row.ask.toUser?.forms.dat ?? "по правилу"}`
      : look === "on" ? "В вашем отчёте. Снять галочку" : "Не в отчёте. Поставить галочку";
  return (
    <button type="button" className={`ck${cls}`} role="checkbox" aria-checked={checked} aria-label={label} title={tip} onClick={() => void api.tick(row)}>
      {inner}
    </button>
  );
}

/** «чья»: a button that opens the menu while the row may change, else a quiet word; hidden on one's own ticked sale. */
function OwnerPill({ api, row }: { api: BoardApi; row: Row }) {
  const pill = pillOf(api.board, row);
  if (pill === null) return null;
  const cls = `pill is-${pill.tone}${pill.hidden ? " is-hid" : ""}`;
  if (!hasMenu(api.board, row, api.preview)) return pill.hidden ? null : <span className={cls}>{pill.text}</span>;
  const open = api.menu === row.key;
  return (
    <button type="button" className={cls} data-menu={row.key} aria-haspopup="menu" aria-expanded={open} title="Чья продажа"
      onClick={() => {
        api.setPanel(null);
        api.setSelected(row.key);
        api.setMenu(open ? null : row.key);
      }}>
      <span>{pill.text}</span><Ico name="chev" size={12} />
    </button>
  );
}
