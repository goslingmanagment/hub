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

// The «Браузер» block of a Fansly page on the «Синк» tab (Project Browser
// plan §4.11; PR 17): only a page with a browser has one. On the page's card
// of the list it is a line with what holds; on the page's detail, the whole
// of it — the transport, the operator's last word and its start, the owner's
// stop, the login, the exit IP, the buffer, the delivery of events, the
// versions, the last self-test and alarm — and the commands of the owner's
// CLI. The browser's alerts that hold come first, in the warning colour.

const HEADLINE_TONES: Record<BrowserHeadline["tone"], string> = {
  ok: "border-green/30 bg-green/10 text-green",
  quiet: "border-border bg-hover-alt text-text-secondary",
  warn: "border-warning/30 bg-warning/10 text-warning-dark",
  danger: "border-danger/30 bg-danger/[0.06] text-danger",
};

export function EngineBrowserChip({ browser }: { browser: EngineBrowser }) {
  const headline = browserHeadline(browser);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${HEADLINE_TONES[headline.tone]}`}
      data-browser-state={headline.kind}
    >
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
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs" data-engine-browser={pageLabel} data-browser-compact="true">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Браузер</span>
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
    <section className="rounded-xl border border-border bg-card px-5 py-4" aria-label="Браузер" data-engine-browser={pageLabel}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Браузер</h3>
        <EngineBrowserChip browser={browser} />
      </div>
      {alerts.length > 0 && (
        <div className="mb-3 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 space-y-0.5" data-browser-alerts="true">
          {alerts.map((line) => (
            <p key={line} className="break-words text-xs font-medium text-warning-dark" data-browser-alert="true">Тревога — {line}</p>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <Row label="Транспорт" testId="transport">{browserTransportText(browser, now)}</Row>
        <Row label="Связь" warn={onBrowser && silent} testId="link">{browserLinkText(browser, now)}</Row>
        <Row label="Состояние" warn={onBrowser && browser.state.stopReason !== null && browser.state.stopReason !== "owner_stop"} testId="state">
          {browserStateText(browser, now)}
        </Row>
        {ownerStop !== null && (
          <Row label="Остановка" warn testId="owner-stop">
            {ownerStop} · pnpm cli sync browser start {pageLabel}
          </Row>
        )}
        {halt !== null && (
          <Row label="Решение" warn testId="halt">
            {/* Fansly signed the browser out: the owner's login decides it (PR 15). */}
            {browser.halt?.reason === "login_required" ? `${halt} · решается входом в браузер` : `${halt} · pnpm cli sync browser start ${pageLabel}`}
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
        {browser.alarm !== null && (
          <Row label="Тревога оператора" testId="alarm">{browserAlarmText(browser, now)}</Row>
        )}
      </div>
      <p className="mt-3 text-[11px] text-text-muted">
        pnpm cli sync browser status --page {pageLabel} · stop {pageLabel} · start {pageLabel} · selftest {pageLabel}
      </p>
    </section>
  );
}
