import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Ico } from "./icons";
import { usd } from "./model";
import type { ExtensionMessage, FrameMessage } from "./transport";
import "./board.css";

/**
 * The demo's own pages of the «Отчёт» board (`pnpm dev:workboard:demo` only, never a production build): an index of
 * the prototype's scenarios with their demo shifts (packages/demo/fixtures/shift-report-board.ts), and a stand-in for
 * the extension that draws the board in its frame (`__report/frame`): the handshake, the requests over the port, the
 * collapsed bar «Отчёт смены» with «Сверка» and «К отчёту», the clipboard. Handshake version 2: the key in the frame's
 * address, the port offered on load until the frame answers `ready`; `?v=1` plays an extension of an older version. Each link starts a fresh copy of its
 * scenario (the cookie `hub-demo-board`).
 */

const SCENARIOS: ReadonlyArray<{ id: number; name: string; what: string }> = [
  { id: 9_120_001, name: "Черновик", what: "Колонка на каждую страницу, галочки по правилу" },
  { id: 9_120_002, name: "Комментарий", what: "Комментарии к продажам и к смене" },
  { id: 9_120_003, name: "Забрать у коллеги", what: "Вопрос Олегу ждёт ответа" },
  { id: 9_120_004, name: "Забрать из общака", what: "Вопрос владельцу ждёт ответа" },
  { id: 9_120_005, name: "Нет в Hub", what: "Продажа, которую Hub не поймал" },
  { id: 9_120_006, name: "Проверка", what: "Hub сверяет, Генгар читает: через 4 секунды «Подтвердите»" },
  { id: 9_120_007, name: "Генгар нашёл", what: "Две правки и комментарий Генгара" },
  { id: 9_120_008, name: "Генгар прочитал", what: "Замечаний нет, остаётся подтвердить" },
  { id: 9_120_009, name: "Генгар молчит", what: "Подтвердить по проверке Hub, Генгар дочитает позже" },
  { id: 9_120_010, name: "Спор", what: "Сева считает своей продажу Ash/UK" },
  { id: 9_120_011, name: "Продажа после сдачи", what: "«Досдать» в учтённый отчёт" },
  { id: 9_120_012, name: "Учтён", what: "«Скопировать пост», «Исправить»" },
  { id: 9_120_013, name: "Правка", what: "Отчёт открыт снова: «Было …, стало …»" },
  { id: 9_120_014, name: "5 страниц", what: "Колонки уходят вбок" },
  { id: 9_120_015, name: "Страница без продаж", what: "Узкая колонка «За смену продаж нет»" },
  { id: 9_120_016, name: "Просмотр без права", what: "Сдача смены доской не включена: доска только для чтения" },
];

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const role = (as: string, next: string) => `${BASE}/__demo/role?${new URLSearchParams({ as, next: `${BASE}${next}` }).toString()}`;
/** A fresh copy of every scenario from this press on. */
const fresh = () => {
  document.cookie = `hub-demo-board=${Date.now()}; path=/; SameSite=Lax`;
};

export function ReportDemoIndex() {
  useEffect(() => {
    document.title = "Отчёт смены: демо";
  }, []);
  const cell = { padding: "8px 12px", borderBottom: "1px solid var(--rule)", textAlign: "left" as const, verticalAlign: "top" as const };
  return (
    <div className="rb" style={{ overflowY: "auto" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 16px 40px" }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 600, color: "var(--ink-strong)" }}>Отчёт смены: сценарии прототипа</h1>
        <p style={{ margin: "0 0 18px", color: "var(--ink-muted)" }}>Демо на выдуманных данных. Каждая ссылка открывает свежую копию сценария; дальше доска прокликивается до конца, как прототип.</p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--ink-muted)" }}><th style={cell}>Сценарий</th><th style={cell}>Смена</th><th style={cell}>Открыть</th></tr>
          </thead>
          <tbody>
            {SCENARIOS.map((one) => (
              <tr key={one.id}>
                <td style={cell}><b style={{ color: "var(--ink-strong)" }}>{one.name}</b><br /><span style={{ color: "var(--ink-muted)" }}>{one.what}</span></td>
                <td style={{ ...cell, fontVariantNumeric: "tabular-nums", color: "var(--ink-muted)" }}>{one.id}</td>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>
                  <a className="lk is-clay" onClick={fresh} href={role("chatter", `/report/${one.id}`)}>Чаттер, вкладка</a>{"  ·  "}
                  <a className="lk is-clay" onClick={fresh} href={role("chatter", `/__report/frame?shift=${one.id}`)}>Чаттер, в рамке</a>{"  ·  "}
                  <a className="lk" onClick={fresh} href={role("owner", `/report/${one.id}`)}>Владелец читает</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ marginTop: 18, color: "var(--ink-muted)" }}>
          Рамка расширения: <code>{BASE}/frame/report?shift=&lt;смена&gt;</code> принимает порт от сайта (здесь его роль играет страница «в рамке»).
          Без ключа или порта за 10 секунд говорит «Откройте отчёт из ChatGoose»; расширение старой версии:{" "}
          <a className="lk is-clay" onClick={fresh} href={role("chatter", "/__report/frame?shift=9120001&v=1")}>«Обновите ChatGoose»</a>.
        </p>
      </div>
    </div>
  );
}

const MINI_CSS = `
.rb .mini{position:absolute;left:0;right:0;bottom:0;z-index:8;display:flex;align-items:center;gap:14px;height:44px;padding:0 10px 0 16px;background:var(--raised);box-shadow:0 -1px 0 var(--rule-2),0 -12px 30px -16px rgb(0 0 0 / .9);white-space:nowrap}
.rb .mini-t{display:flex;align-items:center;gap:7px;font-weight:600;color:var(--ink-strong)}
.rb .mini-t .ico{color:var(--clay)}
.rb .mini-c{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ink-2)}
.rb .mini-c b{font-weight:600;color:var(--ink-strong)}
.rb .mini-s{color:var(--ink-muted)}
.rb .mini-s b{font-weight:600;color:var(--ink-strong);font-variant-numeric:tabular-nums}
.rb .site{position:absolute;inset:0 0 44px;display:flex;align-items:center;justify-content:center;color:var(--ink-faint)}
`;

/** The site's own words of a sale, as the extension says them in «Сверка». */
function siteWords(sale: { platform: string; kind: string }): string {
  if (sale.kind === "tip" || sale.kind === "stream_tip") return "Tip from";
  if (sale.kind === "subscription") return sale.platform === "fansly" ? "Subscription Sale to" : "Subscription from";
  return sale.platform === "fansly" ? "Media Sale to" : "Payment for message from";
}

/** The demo site's answer to «show on the site» (the extension's `found`). */
function foundOf(sale: { pageLabel: string; platform: string; occurredAt: string; netMills: number; fanName: string | null }): { ok: boolean; words?: string } {
  if (sale.pageLabel === "Mia-2" || sale.pageLabel === "Mia Free") return { ok: true };
  if (sale.platform === "fansly") return { ok: false, words: `Откройте вкладку ${sale.pageLabel}, строка найдётся сама` };
  const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(sale.occurredAt));
  const money = sale.netMills % 1000 === 0 ? `$${sale.netMills / 1000}` : `$${(sale.netMills / 1000).toFixed(2)}`;
  return { ok: false, words: `Строка на сайте не найдена: ${time}, ${money}, ${sale.fanName ?? ""}` };
}

/** The extension's part, played by the demo: the frame over a «site», its port, its bar. */
export function ReportDemoFrame() {
  const [search] = useSearchParams();
  const shift = search.get("shift");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<Extract<FrameMessage, { t: "state" }> | null>(null);
  const [compare, setCompare] = useState<Extract<FrameMessage, { t: "find" }>["sale"] | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // The extension's key for this frame (handshake v2): in the frame's address only. `?v=1` plays an old extension.
  const [key] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  const version = Number(search.get("v") ?? 2);
  useEffect(() => {
    document.title = "Отчёт смены: рамка";
    const frame = frameRef.current;
    if (!frame) return;
    let tries = 0;
    let timer: number | null = null;
    const offer = () => {
      if (portRef.current || tries >= 20 || !frame.contentWindow) return;
      tries += 1;
      const channel = new MessageChannel();
      const answer = (message: ExtensionMessage) => channel.port1.postMessage(message);
      channel.port1.onmessage = (message) => {
        const one = message.data as FrameMessage;
        if (one.t === "ready") {
          portRef.current = channel.port1;
          if (timer !== null) window.clearInterval(timer);
        } else if (one.t === "open-tab") {
          window.location.assign(`${BASE}/report/${shift ?? ""}`);
        } else if (one.t === "fetch") {
          void fetch(one.path, { method: one.method, body: one.body, headers: one.body === null ? {} : { "content-type": "application/json" }, credentials: "same-origin" })
            .then(async (response) => answer({ t: "fetch:result", id: one.id, status: response.status, body: await response.text() }))
            .catch(() => answer({ t: "fetch:result", id: one.id, error: "network" }));
        } else if (one.t === "state") {
          setState(one);
        } else if (one.t === "collapse") {
          setCompare(null);
          setOpen(false);
        } else if (one.t === "find") {
          setCompare(one.sale);
          setOpen(false);
          // The site under this demo frame is Mia-2's wallet and Mia Free's statement: their rows are found; a sale of
          // another Fansly page waits for that page's tab; Mia VIP's row is not in the statement.
          const result = foundOf(one.sale);
          setMissing(result.ok ? null : result.words ?? null);
          answer({ t: "found", transactionId: one.sale.transactionId, ...result });
        } else if (one.t === "copy") {
          void navigator.clipboard.writeText(one.text).then(() => answer({ t: "copy:result", ok: true }), () => answer({ t: "copy:result", ok: false }));
        }
      };
      frame.contentWindow.postMessage({ cg: "report-board/port", v: version, key }, window.location.origin, [channel.port2]);
    };
    // On the frame's load, then every 500 ms (a new channel each time) until the frame says ready, at most 20 times.
    const onLoad = () => {
      offer();
      timer = window.setInterval(offer, 500);
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [key, version, shift]);
  const back = () => {
    const transactionId = compare?.transactionId ?? null;
    setOpen(true);
    setCompare(null);
    setMissing(null);
    portRef.current?.postMessage({ t: "show", transactionId } satisfies ExtensionMessage);
  };
  const src = `${BASE}/frame/report${shift ? `?shift=${encodeURIComponent(shift)}` : ""}#k=${key}&v=2`;
  return (
    <div className="rb">
      <style>{MINI_CSS}</style>
      <div className="view">
        <div className="site">Здесь сайт: кошелёк Fansly или выписка ChatSpace{compare ? `. Строка: ${compare.pageLabel}, ${compare.fanName ?? ""}, ${usd(compare.netMills)}` : ""}</div>
        <iframe ref={frameRef} src={src} title="Отчёт смены" allow="clipboard-write" referrerPolicy="no-referrer"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, display: open ? "block" : "none", zIndex: 10 }} />
        {!open && (
          <section className="mini" aria-label="Отчёт смены, свёрнут">
            <span className="mini-t"><Ico name="report" />Отчёт смены</span>
            {state && state.phase !== "none" && <span className={`chip${state.phase === "confirm" || state.phase === "fixing" ? " is-clay" : state.phase === "counted" ? " is-good" : ""}`}>{state.chip}</span>}
            {compare && missing !== null && <span className="mini-c">{missing}</span>}
            {compare && missing === null && <span className="mini-c">Сверка: <b>{compare.pageLabel}</b>, {siteWords(compare)} {compare.fanName}, {compare.platformRef ? `#…${compare.platformRef.slice(-4)}` : new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(compare.occurredAt))}</span>}
            <span className="grow" />
            {state && state.phase !== "none" && <span className="mini-s">Ваши продажи: {state.count}, <b>{usd(state.totalMills)}</b></span>}
            <button type="button" className="btn btn--line btn--sm" onClick={back}>{compare ? "К отчёту" : "Отчёт"}</button>
          </section>
        )}
      </div>
    </div>
  );
}
