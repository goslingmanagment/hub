import type { ReactNode } from "react";

import {
  browserAlarmText,
  browserAlertLines,
  browserBufferText,
  browserBufferTroubleLines,
  browserDeliveryText,
  browserExitIpText,
  browserHaltText,
  browserHeadline,
  browserLinkText,
  browserLoginText,
  browserOwnerStopText,
  browserSelfTestText,
  browserStateText,
  browserTransportText,
  browserVersionsText,
  BROWSER_SILENT_MS,
  type BrowserHeadline,
  type EngineBrowser,
} from "./engineBrowserDisplay.js";

// The «Браузер» block of a Fansly page on the Fansly screen (Project Browser
// plan §4.11; PR 17): only a page with a browser has one. On the page's card
// of the list it is a line with what holds; on the page's detail, the whole
// of it — the transport, the operator's last word and its start, the owner's
// stop, the login, the exit IP, the buffer, the delivery of events, the
// versions, the last self-test and alarm. The browser's alerts that hold
// come first, in the warning colour; the console's commands are in the
// screen's «Для разработчика».

const HEADLINE_TONES: Record<BrowserHeadline["tone"], string> = {
  ok: "badge badge-success",
  quiet: "badge",
  warn: "badge badge-warning",
  danger: "badge badge-danger",
};

export function EngineBrowserChip({ browser }: { browser: EngineBrowser }) {
  const headline = browserHeadline(browser);
  return (
    <span className={HEADLINE_TONES[headline.tone]} data-browser-state={headline.kind}>
      {headline.text}
    </span>
  );
}

function Row({ label, children, warn = false, testId }: { label: string; children: ReactNode; warn?: boolean; testId?: string }) {
  return (
    <>
      <span className="text-text-muted">{label}</span>
      <span className={`min-w-0 break-words ${warn ? "text-warning-dark font-medium" : "text-text-secondary"}`} data-browser-row={testId}>
        {children}
      </span>
    </>
  );
}

/** How a stop the owner decides is lifted: the browser is started again from
 *  the server console. */
const START_AGAIN = "запуск — командой из «Для разработчика»";

/**
 * A page's browser. `compact`: the card of the list — the headline, the
 * alerts and the one line that matters most. `loginAction`: the link to the
 * dashboard's login of the page's browser (PR 15, «Войти в браузер»), beside
 * the login line.
 */
export function EngineBrowserBlock({
  browser,
  pageLabel,
  compact = false,
  loginAction,
  now = Date.now(),
}: {
  browser: EngineBrowser;
  pageLabel: string;
  compact?: boolean;
  loginAction?: ReactNode;
  now?: number;
}) {
  const alerts = browserAlertLines(browser, now);
  const ownerStop = browserOwnerStopText(browser, now);
  const halt = browserHaltText(browser, now);
  const bufferTrouble = browserBufferTroubleLines(browser, now);
  const silent = browser.link.error !== null || browser.link.stateAgeMs === null || browser.link.stateAgeMs > BROWSER_SILENT_MS;
  const onBrowser = browser.transport === "browser";
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-engine-browser={pageLabel} data-browser-compact="true">
        <span className="font-medium text-text-secondary">Браузер</span>
        <EngineBrowserChip browser={browser} />
        {onBrowser && <span className="text-text-secondary">{browserLinkText(browser, now)}</span>}
        {bufferTrouble.map((line) => (
          <span key={line} className="font-medium text-warning-dark">буфер: {line}</span>
        ))}
        {alerts.map((line) => (
          <span key={line} className="font-medium text-warning-dark" data-browser-alert="true">{line}</span>
        ))}
      </div>
    );
  }
  return (
    <section className="card" aria-label="Браузер" data-engine-browser={pageLabel}>
      <div className="card-header">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="card-title">Браузер</h4>
          <EngineBrowserChip browser={browser} />
        </div>
      </div>
      <div className="card-body space-y-3">
        {alerts.length > 0 && (
          <div className="notice notice-warning flex-col gap-0.5" data-browser-alerts="true">
            {alerts.map((line) => (
              <p key={line} className="break-words font-medium" data-browser-alert="true">Тревога — {line}</p>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <Row label="Транспорт" testId="transport">{browserTransportText(browser, now)}</Row>
          <Row label="Связь" warn={onBrowser && silent} testId="link">{browserLinkText(browser, now)}</Row>
          <Row label="Состояние" warn={onBrowser && browser.state.stopReason !== null && browser.state.stopReason !== "owner_stop"} testId="state">
            {browserStateText(browser, now)}
          </Row>
          {ownerStop !== null && (
            <Row label="Остановка" warn testId="owner-stop">
              {ownerStop} · {START_AGAIN}
            </Row>
          )}
          {halt !== null && (
            <Row label="Решение" warn testId="halt">
              {/* Fansly signed the browser out: the owner's login decides it (PR 15). */}
              {browser.halt?.reason === "login_required" ? `${halt} · решается входом в браузер` : `${halt} · ${START_AGAIN}`}
            </Row>
          )}
          <Row label="Вход" warn={browser.login.needed} testId="login">
            {/* PR 15's «Войти в браузер» (the page's detail passes it): beside
                the line, or under it from its start when it does not fit. */}
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span>{browserLoginText(browser)}</span>
              {loginAction}
            </span>
          </Row>
          <Row label="Выходной IP" warn={browser.proxy.problem !== null || browser.proxy.matches === false || browser.proxy.pinnedExitIp === null} testId="exit-ip">
            {browserExitIpText(browser)}
          </Row>
          <Row label="Буфер" warn={bufferTrouble.length > 0} testId="buffer">
            {browserBufferText(browser)}
            {bufferTrouble.map((line) => <span key={line} className="block">{line}</span>)}
          </Row>
          <Row label="Доставка событий" testId="delivery">{browserDeliveryText(browser, now)}</Row>
          <Row label="Версии" testId="versions">{browserVersionsText(browser)}</Row>
          <Row label="Самопроверка" warn={browser.selfTest.ok === false} testId="selftest">{browserSelfTestText(browser, now)}</Row>
          {browser.lastAlarm !== null && (
            <Row label="Тревога оператора" testId="alarm">{browserAlarmText(browser, now)}</Row>
          )}
        </div>
      </div>
    </section>
  );
}
