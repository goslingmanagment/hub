import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentSyncBrowserStatus } from "@agency_hub_core/contracts";

import { EngineBrowserBlock } from "../apps/dashboard/src/pages/settings/engine/EngineBrowser.tsx";
import {
  browserAlertLines,
  browserExitIpText,
  browserHeadline,
  browserLinkText,
  browserStateText,
} from "../apps/dashboard/src/pages/settings/engine/engineBrowserDisplay.ts";

import { BROWSER_NOW as NOW, browserStatus } from "./helpers/browser-status-fixture.ts";

// The «Браузер» block of a Fansly page on the «Синк» tab (Project Browser
// plan §4.11; PR 17): what the engine last heard of the page's browser, in
// the tab's own language — its headline (working, starting, stopped by the
// owner, standing for a reason, silent, not used on Node), the alerts that
// hold first, the rows of the detail and one line on the page's card. Pages
// without a browser have no block (tests/dashboard-sync-engine.test.ts).

const NOW_MS = new Date(NOW).getTime();
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
const plain = (html: string) => html.replace(/[\u00a0\u202f]/g, " ");

function render(browser: AgentSyncBrowserStatus, options: { compact?: boolean } = {}): string {
  return plain(renderToStaticMarkup(createElement(EngineBrowserBlock, { browser, pageLabel: "lilly-1", now: NOW_MS, ...options })));
}

describe("the «Браузер» block (Project Browser PR 17)", () => {
  it("a browser that works: its rows, in the tab's language, and the CLI that steers it", () => {
    const html = render(browserStatus());
    expect(html).toContain('data-browser-state="ready"');
    expect(html).toContain("работает");
    for (const text of [
      "браузер страницы", "оператор сообщал 4 с назад", "готов", "сессия есть · аккаунт 300000000000000001",
      "203.0.113.7 (закреплён)", "1,5 МБ", "p95 180 мс", "последнее событие 3 с назад", "Chrome 155.0.7339.80 · оператор d8cb9ac",
      "пройдена в", "pnpm cli sync browser status --page lilly-1",
    ]) expect(html, text).toContain(text);
    expect(html).not.toContain("data-browser-alerts");
    expect(html).not.toContain("Остановка");
  });

  it("each headline: starting, stopped by the owner, standing for a reason, failing and retrying, silent, on Node", () => {
    const headline = (overrides: Partial<AgentSyncBrowserStatus>) => browserHeadline(browserStatus(overrides));
    const state = (patch: Partial<AgentSyncBrowserStatus["state"]>) => ({ state: { ...browserStatus().state, ...patch } });
    expect(headline(state({ step: "site_loaded" }))).toMatchObject({ kind: "starting", text: "запускается" });
    expect(headline(state({ step: "exit_closed", exitOpen: false }))).toMatchObject({ kind: "starting", text: "не запущен" });
    expect(headline({ ...state({ step: "exit_closed", exitOpen: false, stopReason: "owner_stop" }) })).toMatchObject({ kind: "stopped" });
    expect(headline({ ownerStop: { at: ago(60_000), by: "cli@x", paused: true } })).toMatchObject({ kind: "stopped" });
    expect(headline(state({ step: "exit_closed", exitOpen: false, stopReason: "exit_ip_changed" }))).toMatchObject({ kind: "halted", tone: "danger", text: "стоит: сменился выходной IP прокси" });
    expect(headline(state({ step: "exit_closed", exitOpen: false, stopReason: "proxy_unavailable", retryAt: ago(-20_000) })))
      .toMatchObject({ kind: "failing", text: "перезапуск: прокси недоступен" });
    expect(headline({ link: { lastStateAt: ago(180_000), stateAgeMs: 180_000, error: null } })).toMatchObject({ kind: "silent", text: "оператор молчит" });
    expect(headline({ link: { lastStateAt: ago(1_000), stateAgeMs: 1_000, error: "protocol_version" } })).toMatchObject({ kind: "silent" });
    expect(headline({ transport: "node" })).toMatchObject({ kind: "node", text: "не используется: страница на Node" });
    expect(headline({ transport: "node", leavePendingSince: ago(60_000) })).toMatchObject({ kind: "node", text: "уход с браузера" });
  });

  it("stopped by the owner: the stop, the pause it put and the command that lifts it", () => {
    const html = render(browserStatus({
      state: { step: "exit_closed", stopReason: "owner_stop", retryAt: null, exitOpen: false, mode: "automation", downSince: ago(120_000), stopSince: ago(120_000) },
      ownerStop: { at: "2026-10-14T11:58:00.000Z", by: "cli@hub pid 1", paused: true },
    }));
    expect(html).toContain('data-browser-state="stopped"');
    expect(html).toContain("остановлен владельцем в");
    expect(html).toContain("страница на паузе · pnpm cli sync browser start lilly-1");
    expect(html).toContain("выход закрыт · не готов 2 мин");
  });

  it("alerts first, in the warning colour; a halted or undrained buffer and a pending leave say so", () => {
    const html = render(browserStatus({
      state: { step: "exit_closed", stopReason: "exit_ip_changed", retryAt: null, exitOpen: false, mode: "automation", downSince: ago(300_000), stopSince: ago(300_000) },
      proxy: { pinnedExitIp: "203.0.113.7", pinnedAt: ago(86_400_000), exitIp: "198.51.100.9", matches: false, problem: "exit_ip_changed" },
      buffer: { ...browserStatus().buffer, haltedReason: "ahead", haltedAt: ago(600_000), undrainedSince: "2026-10-14T10:00:00.000Z" },
      alarm: { kind: "header_mismatch", at: ago(120_000), detail: { route: "account.me" } },
      alerts: [
        { kind: "exit_ip_changed", detail: "exit_ip_changed", since: ago(300_000) },
        { kind: "protocol_changed", detail: "alarm_header_mismatch", since: ago(120_000) },
      ],
    }));
    expect(html).toContain("data-browser-alerts");
    expect(html.indexOf("data-browser-alerts")).toBeLessThan(html.indexOf('data-browser-row="transport"'));
    // The kind once: a stop reason says it in its own words.
    expect(html).toContain("Тревога — сменился выходной IP прокси (5 мин)");
    expect(html).not.toContain("сменился выходной IP: сменился");
    expect(html).toContain("Тревога — Fansly изменил протокол: заголовки расходятся с сайтом (2 мин)");
    expect(html).toContain("198.51.100.9 — не совпадает с закреплённым 203.0.113.7");
    expect(html).toContain("не выгружен с");
    expect(html).toContain("приём остановлен: история буфера расходится с движком (ahead)");
    expect(html).toContain("Тревога оператора");
    expect(browserAlertLines(browserStatus({ alerts: [{ kind: "browser_down", detail: "no_state", since: null }] }), NOW_MS))
      .toEqual(["браузер недоступен: оператор молчит больше 2 мин"]);
    expect(browserStateText(browserStatus({ state: { ...browserStatus().state, mode: "manual_login" } }), NOW_MS)).toBe("готов · ручной вход");
    expect(browserLinkText(browserStatus({ link: { lastStateAt: null, stateAgeMs: null, error: "token" } }), NOW_MS)).toBe("оператор не принял токен страницы");
    expect(browserExitIpText(browserStatus({ proxy: { pinnedExitIp: null, pinnedAt: null, exitIp: null, matches: null, problem: null } }))).toBe("IP не закреплён");
  });

  it("a halt latched for the owner's decision stays so whatever an operator that started again says, with the command that lifts it (Astra PR 17, P1-1)", () => {
    const html = render(browserStatus({
      state: { step: "exit_closed", stopReason: null, retryAt: null, exitOpen: false, mode: "automation", downSince: ago(300_000), stopSince: null },
      halt: { reason: "header_mismatch", at: "2026-10-14T11:55:00.000Z" },
    }));
    expect(html).toContain('data-browser-state="halted"');
    expect(html).toContain("стоит: заголовки запросов расходятся с сайтом");
    expect(html).toMatch(/data-browser-row="halt"[^>]*>ждёт решения владельца: заголовки запросов расходятся с сайтом \(с [^)]+\) · pnpm cli sync browser start lilly-1/);
  });

  it("a number and its percent sign stay on one line", () => {
    const raw = renderToStaticMarkup(createElement(EngineBrowserBlock, {
      browser: browserStatus({ alerts: [{ kind: "buffer", detail: "buffer_80", since: null }] }), pageLabel: "lilly-1", now: NOW_MS,
    }));
    expect(raw).toContain("0,1\u00a0% потолка");
    expect(raw).toContain("заполнен на 80\u00a0%");
    expect(raw).not.toMatch(/\d %/);
  });

  it("the login line is PR 15's slot: what it passes stands beside it", () => {
    const html = plain(renderToStaticMarkup(createElement(EngineBrowserBlock, {
      browser: browserStatus({ login: { needed: true, why: "login_required" } }),
      pageLabel: "lilly-1",
      now: NOW_MS,
      loginAction: createElement("a", { href: "/pages/lilly-1/browser-login" }, "Войти в браузер"),
    })));
    expect(html).toMatch(/data-browser-row="login"[^>]*><span>нужен вход: Fansly вышел из аккаунта в браузере<\/span><span class="ml-2"><a href="\/pages\/lilly-1\/browser-login">Войти в браузер<\/a>/);
  });

  it("on the page's card: one line — the headline, the operator's word, the alerts", () => {
    const html = render(browserStatus({ alerts: [{ kind: "buffer", detail: "buffer_80", since: null }] }), { compact: true });
    expect(html).toContain('data-browser-compact="true"');
    expect(html).toContain("Браузер");
    expect(html).toContain("работает");
    expect(html).toContain("оператор сообщал 4 с назад");
    expect(html).toContain("буфер: заполнен на 80 %");
    expect(html).not.toContain("Выходной IP");
  });
});
