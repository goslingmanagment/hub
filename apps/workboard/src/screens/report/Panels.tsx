import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { millsFromDollars } from "@agency_hub_core/shared";
import { useClaimable } from "./data";
import { allRows, clock, day, keyOfTransaction, usd } from "./model";
import { placeBy } from "./place";
import type { BoardApi } from "./useBoard";

/**
 * What floats over the board besides «чья»: «Ещё» (its menu by the rail's «Ещё»), its two windows «Мимо площадки» and
 * «Найти продажу» in the middle of the board, and the keys under «?». A press outside closes them; Esc too (keys.ts).
 */
export function Panels({ api }: { api: BoardApi }) {
  const { panel, setPanel } = api;
  if (panel === null) return null;
  const close = () => setPanel(null);
  if (panel === "more") {
    const offs = api.report.view?.offPlatform ?? [];
    return (
      <Popover anchor="more" prefer="below" close={close} role="menu" label="Ещё">
        <button type="button" className="pi" role="menuitem" onClick={() => setPanel("off")}>
          <b>Мимо площадки{offs.length > 0 ? `: ${offs.length}` : ""}</b><span>Деньги, которые пришли не через площадку. В итог входят, когда владелец подтвердит.</span>
        </button>
        <button type="button" className="pi" role="menuitem" onClick={() => setPanel("find")}>
          <b>Найти продажу</b><span>Продажи последних 7 дней на ваших страницах, которых нет ни в одном вашем отчёте.</span>
        </button>
      </Popover>
    );
  }
  if (panel === "keys") {
    const keys: Array<[string, string[]]> = [
      ["Между продажами", ["J", "K", "↑", "↓"]], ["Галочка", ["Пробел"]], ["Чья продажа", ["Enter"]], ["Комментарий", ["C"]],
      ...(api.host === "frame" ? [["Показать на сайте", ["O"]] as [string, string[]]] : []),
      ["Сдать или подтвердить", [/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl", "Enter"]], ["Закрыть меню, свернуть", ["Esc"]],
    ];
    return (
      <Popover anchor="keys" prefer="above" close={close} role="dialog" label="Клавиши">
        <div className="keys">
          <div className="kh">Клавиши</div>
          {keys.map(([what, which]) => (
            <div className="kr" key={what}><span>{what}</span><span>{which.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>
          ))}
        </div>
      </Popover>
    );
  }
  const title = panel === "off" ? "Мимо площадки" : "Найти продажу";
  return (
    <Popover anchor={null} close={close} role="dialog" label={title}>
      <div className="dlg-h">
        <b>{title}</b>
        <button type="button" className="btn btn--quiet btn--sm" onClick={close}>Закрыть</button>
      </div>
      {panel === "off" ? <OffPlatform api={api} /> : <FindSale api={api} close={close} />}
    </Popover>
  );
}

/**
 * A floating box: by its button (`data-panel`), inside the window; without one, a window in the middle of the board.
 * A press outside it closes it.
 */
function Popover({ anchor, prefer = "below", close, role, label, children }: {
  anchor: string | null; prefer?: "below" | "above"; close: () => void; role: "menu" | "dialog"; label: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const button = () => (anchor === null ? null : document.querySelector(`[data-panel="${anchor}"]`));
  useLayoutEffect(() => {
    const box = ref.current;
    const at = button();
    if (box && at) placeBy(box, at, prefer);
  });
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null && (ref.current?.contains(target) || button()?.contains(target))) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  });
  return <div className={anchor === null ? "dlg" : "pop"} ref={ref} role={role} aria-label={label}>{children}</div>;
}

/** «Мимо площадки»: money that came past the platform; it waits for the owner and is never in the sums before. */
function OffPlatform({ api }: { api: BoardApi }) {
  const lines = api.report.view?.offPlatform ?? [];
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [what, setWhat] = useState("");
  const dollars = Number(amount.replace(",", "."));
  const ready = Number.isFinite(dollars) && dollars > 0 && from.trim() !== "" && what.trim() !== "";
  const add = async () => {
    if (!ready) return;
    const done = await api.run({ op: "offPlatformAdd", body: { amountMills: Number(millsFromDollars(dollars)), fromWhom: from.trim(), whatFor: what.trim() } }, "Добавлено: ждёт подтверждения владельца");
    if (done) {
      setAmount("");
      setFrom("");
      setWhat("");
    }
  };
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void add();
  };
  return (
    <>
      <p className="hint">Деньги, которые пришли не через площадку. В итог входят, когда владелец подтвердит.</p>
      {lines.map((line) => (
        <div className="dr" key={line.id}>
          <span>{line.fromWhom}, {line.whatFor}</span>
          <span className="a">{usd(line.amountMills)}</span>
          <span className="s">
            {line.state === "pending" ? "ждёт подтверждения владельца" : line.state === "confirmed" ? `владелец подтвердил${line.pageLabel ? `: в сумме ${line.pageLabel}` : ""}` : "владелец отклонил: в итог не входит"}
            {line.state === "pending" && <button type="button" className="lk" onClick={() => void api.run({ op: "offPlatformWithdraw", offPlatformId: line.id }, "Убрано")}>Убрать</button>}
          </span>
        </div>
      ))}
      <div className="dlg-t">Добавить</div>
      <div className="form-r">
        <input className="fld is-sum" inputMode="decimal" placeholder="Сумма, $" aria-label="Сумма в долларах" value={amount} onChange={(event) => setAmount(event.target.value)} onKeyDown={onEnter} autoFocus />
        <input className="fld" placeholder="От кого" aria-label="От кого" maxLength={200} value={from} onChange={(event) => setFrom(event.target.value)} onKeyDown={onEnter} />
      </div>
      <div className="form-r">
        <input className="fld" placeholder="За что" aria-label="За что" maxLength={300} value={what} onChange={(event) => setWhat(event.target.value)} onKeyDown={onEnter} />
        <button type="button" className="btn btn--main btn--sm" disabled={!ready || api.pending} onClick={() => void add()}>Добавить</button>
      </div>
    </>
  );
}

/** «Найти продажу»: a sale of the last 7 days on the person's pages that no report of theirs holds, «Это моё» with a line of why. */
function FindSale({ api, close }: { api: BoardApi; close: () => void }) {
  const read = useClaimable(api.report.shift.id, true);
  const [query, setQuery] = useState("");
  const [claiming, setClaiming] = useState<{ id: number; text: string } | null>(null);
  const onBoard = new Set(allRows(api.board).map((row) => row.transactionId));
  const sales = (read.data?.sales ?? []).filter((sale) => !onBoard.has(sale.transactionId));
  const words = query.trim().toLowerCase().replace(/^@/, "");
  const nobody = sales.filter((sale) => sale.home === "nobody");
  const found = words === "" ? [] : sales.filter((sale) => sale.home !== "nobody" && [sale.fan.name, sale.fan.username].some((name) => name !== null && name.toLowerCase().includes(words)));
  const claim = async (transactionId: number, note: string) => {
    if (await api.run({ op: "line", transactionId, body: { statement: "mine", note } }, "Продажа добавлена в отчёт")) {
      setClaiming(null);
      close();
      api.show(keyOfTransaction(transactionId));
    }
  };
  const saleRow = (sale: (typeof sales)[number]) => {
    const open = claiming?.id === sale.transactionId ? claiming : null;
    return (
      <div className="dr" key={sale.transactionId}>
        <span>{sale.pageLabel} · {sale.fan.name ?? sale.fan.username}</span>
        <span className="a">{usd(sale.netMills)}</span>
        <span className="s">
          {day(sale.occurredAt)}, {clock(sale.occurredAt)} · {sale.words}
          {!open && <button type="button" className="lk" onClick={() => setClaiming({ id: sale.transactionId, text: "" })}>Это моё</button>}
        </span>
        {open && (
          <div className="form-r dr-f">
            <input className="fld" autoFocus placeholder="Почему она ваша? Одной строкой" maxLength={300} value={open.text}
              onChange={(event) => setClaiming({ ...open, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && open.text.trim() !== "") void claim(sale.transactionId, open.text.trim());
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setClaiming(null);
                }
              }} />
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setClaiming(null)}>Отмена</button>
            <button type="button" className="btn btn--main btn--sm" disabled={open.text.trim() === "" || api.pending} onClick={() => void claim(sale.transactionId, open.text.trim())}>Добавить</button>
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <p className="hint">Продажи последних 7 дней на ваших страницах, которых нет ни в одном вашем отчёте.</p>
      {read.isPending && <div className="dlg-e"><i className="spin" /></div>}
      {read.isError && <div className="dlg-e">Список не пришёл. <button type="button" className="lk" onClick={() => void read.refetch()}>Ещё раз</button></div>}
      {read.data && (
        <>
          <div className="dlg-t">Ничьи{nobody.length === 0 ? ": нет" : ""}</div>
          {nobody.map(saleRow)}
          <div className="dlg-t">Другие</div>
          <input className="fld" placeholder="Имя или логин фана" aria-label="Имя или логин фана" value={query} onChange={(event) => setQuery(event.target.value)} />
          {words !== "" && (found.length === 0 ? <div className="dlg-e">Таких продаж нет.</div> : found.slice(0, 50).map(saleRow))}
        </>
      )}
    </>
  );
}
