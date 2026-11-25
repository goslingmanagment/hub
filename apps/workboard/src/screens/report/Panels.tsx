import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDismiss, useFocusScope } from "@agency_hub_core/ui";
import { millsFromDollars } from "@agency_hub_core/shared";
import { useClaimable } from "./data";
import { useFloating } from "./floating";
import { allRows, clock, day, fanOf, keyOfTransaction, usd } from "./model";
import type { BoardApi } from "./useBoard";
import { offPlatformStateOf } from "./words";

/**
 * What floats over the board besides «чья»: «Ещё» (its menu by the rail's «Ещё»), its two windows «Мимо площадки» and
 * «Найти продажу» in the middle of the board, and the keys under «?». The focus goes in when one opens and back to its
 * button when it closes; a press outside and Esc close it (`useDismiss`, `useFocusScope` of packages/ui).
 */
export function Panels({ api }: { api: BoardApi }) {
  const { panel, setPanel } = api;
  const close = useCallback(() => setPanel(null), [setPanel]);
  if (panel === null) return null;
  if (panel === "more") {
    const offs = api.report.view?.offPlatform ?? [];
    return (
      <Popover anchor="more" prefer="below" close={close} role="menu" label="Ещё" key="more">
        <button type="button" className="pi" role="menuitem" data-autofocus onClick={() => setPanel("off")}>
          Мимо площадки{offs.length > 0 ? `: ${offs.length}` : ""}
        </button>
        <button type="button" className="pi" role="menuitem" onClick={() => setPanel("find")}>Найти продажу</button>
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
      <Popover anchor="keys" prefer="above" close={close} role="dialog" label="Клавиши" key="keys">
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
  // A window opened from «Ещё» takes the focus from it, so it gives the focus back to «Ещё» when it closes.
  return (
    <Popover anchor={null} close={close} role="dialog" label={title} key={panel}>
      <div className="dlg-h">
        <b>{title}</b>
        <button type="button" className="btn btn--quiet btn--sm" onClick={close}>Закрыть</button>
      </div>
      {panel === "off" ? <OffPlatform api={api} /> : <FindSale api={api} close={close} />}
    </Popover>
  );
}

/**
 * A floating box: by its button (`data-panel`), on the side chosen when it opens, following it and closing when it
 * scrolls away; without one, a window in the middle of the board. The arrows move between a menu's items.
 */
function Popover({ anchor, prefer = "below", close, role, label, children }: {
  anchor: string | null; prefer?: "below" | "above"; close: () => void; role: "menu" | "dialog"; label: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLElement | null>(null);
  const buttonOf = useCallback(() => {
    button.current = anchor === null ? null : document.querySelector<HTMLElement>(`[data-panel="${anchor}"]`);
    return button.current;
  }, [anchor]);
  // A window in the middle of the board stands by nothing: the floating place is a menu's and a popover's only.
  useFloating(ref, buttonOf, prefer, anchor === null ? noop : close);
  const inside = useMemo(() => [ref, button], []);
  useDismiss(true, close, inside);
  useFocusScope(ref, true);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (role !== "menu" || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[at < 0 ? 0 : (at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return <div className={anchor === null ? "dlg" : "pop"} ref={ref} role={role} aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>{children}</div>;
}

const noop = () => {};

/** One write at a time from a form: Enter and the button share it, so a second Enter never posts the money twice. */
function useOnce() {
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const once = async (send: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    try {
      await send();
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return { once, sending };
}

/** «Мимо площадки»: money that came past the platform; it waits for the owner and is never in the sums before. */
function OffPlatform({ api }: { api: BoardApi }) {
  const lines = api.report.view?.offPlatform ?? [];
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [what, setWhat] = useState("");
  const { once, sending } = useOnce();
  const dollars = Number(amount.replace(",", "."));
  const ready = Number.isFinite(dollars) && dollars > 0 && from.trim() !== "" && what.trim() !== "";
  const add = () => once(async () => {
    if (!ready) return;
    const done = await api.run({ op: "offPlatformAdd", body: { amountMills: Number(millsFromDollars(dollars)), fromWhom: from.trim(), whatFor: what.trim() } }, "Добавлено: ждёт подтверждения владельца");
    if (done) {
      setAmount("");
      setFrom("");
      setWhat("");
    }
  });
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
            {offPlatformStateOf(line.state, line.pageLabel)}
            {line.state === "pending" && <button type="button" className="lk" onClick={() => void api.run({ op: "offPlatformWithdraw", offPlatformId: line.id }, "Убрано")}>Убрать</button>}
          </span>
        </div>
      ))}
      <div className="dlg-t">Добавить</div>
      <div className="form-r">
        <input className="fld is-sum" inputMode="decimal" placeholder="Сумма, $" aria-label="Сумма в долларах" value={amount} onChange={(event) => setAmount(event.target.value)} onKeyDown={onEnter} data-autofocus />
        <input className="fld" placeholder="От кого" aria-label="От кого" maxLength={200} value={from} onChange={(event) => setFrom(event.target.value)} onKeyDown={onEnter} />
      </div>
      <div className="form-r">
        <input className="fld" placeholder="За что" aria-label="За что" maxLength={300} value={what} onChange={(event) => setWhat(event.target.value)} onKeyDown={onEnter} />
        <button type="button" className="btn btn--main btn--sm" disabled={!ready || sending} onClick={() => void add()}>Добавить</button>
      </div>
    </>
  );
}

/** «Найти продажу»: claimable sales of the last 7 days + «Добавить продажу» by exact transactionRef or fan + amount (H8). */
function FindSale({ api, close }: { api: BoardApi; close: () => void }) {
  const read = useClaimable(api.report.shift.id, true);
  const [query, setQuery] = useState("");
  const [claiming, setClaiming] = useState<{ id: number; text: string } | null>(null);
  const [reportRef, setReportRef] = useState("");
  const [reportFan, setReportFan] = useState("");
  const [reportAmount, setReportAmount] = useState("");
  const [reportNote, setReportNote] = useState("");
  const { once, sending } = useOnce();
  const onBoard = new Set(allRows(api.board).map((row) => row.transactionId));
  const sales = (read.data?.sales ?? []).filter((sale) => !onBoard.has(sale.transactionId));
  const words = query.trim().toLowerCase().replace(/^@/, "");
  const found = words === "" ? [] : sales.filter((sale) =>
    [sale.fan.alias ?? null, sale.fan.name, sale.fan.username].some((name) => name !== null && name.toLowerCase().includes(words)),
  );
  const claim = (transactionId: number, note: string) => once(async () => {
    if (await api.run({ op: "line", transactionId, body: { statement: "mine", note } }, "Продажа добавлена в отчёт")) {
      setClaiming(null);
      close();
      api.show(keyOfTransaction(transactionId));
    }
  });
  const dollars = Number(reportAmount.replace(",", "."));
  const hasRef = reportRef.trim() !== "";
  const hasFanAmount = reportFan.trim() !== "" && Number.isFinite(dollars) && dollars > 0;
  const reportReady = (hasRef || hasFanAmount) && reportNote.trim() !== "";
  const addReported = () => once(async () => {
    if (!reportReady) return;
    const body = hasRef
      ? { transactionRef: reportRef.trim(), note: reportNote.trim() }
      : { fan: reportFan.trim(), amountMills: Number(millsFromDollars(dollars)), note: reportNote.trim() };
    if (await api.run({ op: "reportSale", body }, "Продажа добавлена в отчёт")) {
      setReportRef("");
      setReportFan("");
      setReportAmount("");
      setReportNote("");
      close();
    }
  });
  const saleRow = (sale: (typeof sales)[number]) => {
    const open = claiming?.id === sale.transactionId ? claiming : null;
    const shownFan = fanOf(sale);
    const loginSuffix = sale.fan.username !== null && sale.fan.username !== shownFan ? ` (@${sale.fan.username})` : "";
    return (
      <div className="dr" key={sale.transactionId}>
        <span>{sale.pageLabel} · {shownFan}{loginSuffix}</span>
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
            <button type="button" className="btn btn--main btn--sm" disabled={open.text.trim() === "" || sending} onClick={() => void claim(sale.transactionId, open.text.trim())}>Добавить</button>
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
          <div className="dlg-t">Найти среди продаж команды</div>
          <input className="fld" placeholder="Имя, логин или заметка фана" aria-label="Имя, логин или заметка фана" value={query} onChange={(event) => setQuery(event.target.value)} data-autofocus />
          {words !== "" && (found.length === 0 ? <div className="dlg-e">Таких продаж нет.</div> : found.slice(0, 50).map(saleRow))}
        </>
      )}
      <div className="dlg-t">Добавить продажу</div>
      <p className="hint">Если продажи нет в списке, укажите номер транзакции или точные данные фана и сумму. Продажа попадёт в отчёт и посчитается, как любая другая.</p>
      <div className="form-r">
        <input className="fld" placeholder="Номер транзакции" aria-label="Номер транзакции" maxLength={120} value={reportRef} onChange={(event) => setReportRef(event.target.value)} />
      </div>
      <div className="form-r">
        <input className="fld" placeholder="Или фан (логин / имя / заметка / id)" aria-label="Фан" maxLength={200} value={reportFan} onChange={(event) => setReportFan(event.target.value)} disabled={hasRef} />
        <input className="fld is-sum" inputMode="decimal" placeholder="Сумма, $" aria-label="Сумма в долларах" value={reportAmount} onChange={(event) => setReportAmount(event.target.value)} disabled={hasRef} />
      </div>
      <div className="form-r">
        <input className="fld" placeholder="Почему продажа ваша? Одной строкой" aria-label="Почему продажа ваша" maxLength={300} value={reportNote}
          onChange={(event) => setReportNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && reportReady) void addReported();
          }} />
        <button type="button" className="btn btn--main btn--sm" disabled={!reportReady || sending} onClick={() => void addReported()}>Добавить</button>
      </div>
    </>
  );
}
