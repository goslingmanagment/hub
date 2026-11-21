import { Ico } from "./icons";
import { SaleRow } from "./SaleRow";
import { beforeWords, platformName, usd, type Board } from "./model";
import type { BoardApi } from "./useBoard";

type Column = Board["columns"][number];

/**
 * A page of the shift: its title row («Mia-2 Fansly» left, «3 из 5 $36.00» right) over its card, the shift's sales as an
 * inset grouped list, newest first, and the sales before the shift folded into the card's last row.
 */
export function PageCard({ api, column }: { api: BoardApi; column: Column }) {
  const platform = platformName(column.platform);
  const open = api.beforeOpen[column.pageLabel] === true;
  return (
    <section className="pg" data-page={column.pageLabel} aria-label={`${column.pageLabel}, ${platform}`}>
      <header className="pg-h">
        <h2 className="pg-n">{column.pageLabel}</h2>
        <span className="pg-p">{platform}</span>
        {column.attention && <i className="pg-dot" title="Есть что посмотреть" />}
        <span className="pg-c">{column.of > 0 ? `${column.marked} из ${column.of}` : ""}</span>
        <span className={`pg-s${column.sumMills === 0 ? " is-zero" : ""}`}>{usd(column.sumMills)}</span>
      </header>
      <div className="card">
        {column.of === 0
          ? <div className="empty">За смену продаж нет</div>
          : column.rows.map((row) => <SaleRow api={api} row={row} key={row.key} />)}
        {column.before.count > 0 && (
          <>
            <button type="button" className="bf" aria-expanded={open}
              onClick={() => api.setBeforeOpen((was) => ({ ...was, [column.pageLabel]: !open }))}>
              <Ico name="chev" size={14} /><span>{beforeWords(column.before)}</span>
            </button>
            {open && column.before.rows.map((row) => <SaleRow api={api} row={row} key={row.key} />)}
          </>
        )}
      </div>
    </section>
  );
}
