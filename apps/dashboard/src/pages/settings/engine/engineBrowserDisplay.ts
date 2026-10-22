import type { AgentSyncBrowserStatus } from "@agency_hub_core/contracts";

import { engineAgeText, engineClockText, engineCount } from "./engineDisplay.js";

// The words of the «Браузер» block of the «Синк» tab (Project Browser plan
// §4.11; PR 17): a page's browser as the engine last heard of it
// (`/api/v1/sync/pages`, `browser`). Every judgement is the server's — its
// alerts are the evaluator's own rule; the tab names the operator's steps,
// stop reasons, alarms and alerts and turns instants into ages.

export type EngineBrowser = AgentSyncBrowserStatus;

/** A number and its unit stay on one line. */
const NBSP = "\u00a0";

/** No word from the operator for longer than this: the engine's own bound
 *  for `browser_down` (`SYNC_BROWSER_STATE_SILENT_MS`). */
export const BROWSER_SILENT_MS = 2 * 60_000;

const STEP_WORDS: Record<string, string> = {
  exit_closed: "выход закрыт",
  env_applied: "окружение применено",
  chrome_started: "Chrome запущен",
  control_attached: "управление подключено",
  selftest_passed: "самопроверка пройдена",
  exit_ip_verified: "выходной IP проверен",
  exit_open: "выход открыт",
  site_loaded: "сайт загружен",
  session_confirmed: "сессия подтверждена",
  ready: "готов",
};

const STOP_WORDS: Record<string, string> = {
  selftest_failed: "самопроверка не пройдена",
  env_mismatch: "окружение браузера не совпало с настройками",
  exit_ip_changed: "сменился выходной IP прокси",
  proxy_unavailable: "прокси недоступен",
  proxy_auth: "прокси не принимает вход",
  cdp_lost: "потеряно управление Chrome",
  holder_overflow: "переполнен держатель управления",
  buffer_full: "буфер полон",
  disk_full: "диск полон",
  buffer_unavailable: "буфер не открывается",
  request_unended: "запрос не завершился",
  chrome_crashed: "Chrome упал",
  unknown_ws_message: "неизвестное сообщение сокета",
  ws_guard_failed: "проверка сокета не встала",
  ws_unaccounted: "сокет сайта без учёта",
  header_mismatch: "заголовки запросов расходятся с сайтом",
  login_required: "нужен вход",
  halt_unreadable: "запись остановки не прочиталась — решение владельца",
  owner_stop: "остановлен",
};

const ALERT_WORDS: Record<string, string> = {
  browser_down: "браузер недоступен",
  login_required: "нужен вход",
  proxy: "прокси",
  exit_ip_changed: "сменился выходной IP",
  buffer: "буфер",
  selftest_failed: "самопроверка",
  protocol_changed: "Fansly изменил протокол",
  cdp_lost: "потеряно управление Chrome",
  site_unconfirmed: "запросы сайта ждут записи в Hub больше 2 мин",
  socket_cut: "рубеж разорвал один сокет сайта, страница работает",
  exit_ip_unknown: "выходной IP не подтверждён: запросы Hub ждут, сайт работает",
  browser_degraded: "своя неполадка браузера, страница работает",
};

const ALARM_WORDS: Record<string, string> = {
  unknown_ws_message: "неизвестное сообщение сокета",
  header_mismatch: "заголовки расходятся с сайтом",
  selftest_failed: "самопроверка не пройдена",
  overflow: "переполнение держателя",
  cdp_lost: "потеряно управление Chrome",
  fallback_release: "запрос мог уйти при потере управления",
  late_send: "запрос ушёл после срока допуска",
  buffer: "буфер заполняется",
  exit_ip_unknown: "проверка выходного IP не получила ответа",
  journal: "диагностический журнал не пишется — строки пропущены",
  env_mismatch: "экран не 1920×1080",
};

const LINK_ERROR_WORDS: Record<string, string> = {
  token: "оператор не принял токен страницы",
  protocol_version: "у движка и оператора нет общей версии протокола",
  protocol_error: "ошибка протокола",
};

const PROXY_PROBLEM_WORDS: Record<string, string> = {
  unavailable: "прокси недоступен",
  auth: "прокси не принимает вход",
  exit_ip_changed: "выходной IP не совпадает с закреплённым",
};

export function browserStepWords(step: string | null): string {
  return step === null ? "нет данных" : STEP_WORDS[step] ?? step;
}

export function browserStopWords(reason: string): string {
  return STOP_WORDS[reason] ?? reason;
}

export function browserAlertWords(kind: string): string {
  return ALERT_WORDS[kind] ?? kind;
}

export function browserAlarmWords(kind: string): string {
  return ALARM_WORDS[kind] ?? kind;
}

/** What the browser is now, in one word and its tone. */
export type BrowserHeadline =
  | { kind: "node"; text: string; tone: "quiet" }
  | { kind: "silent"; text: string; tone: "warn" }
  | { kind: "stopped"; text: string; tone: "warn" }
  | { kind: "halted"; text: string; tone: "danger" }
  | { kind: "failing"; text: string; tone: "warn" }
  | { kind: "starting"; text: string; tone: "quiet" }
  | { kind: "ready"; text: string; tone: "ok" };

export function browserHeadline(browser: EngineBrowser): BrowserHeadline {
  if (browser.transport === "node") {
    return { kind: "node", text: browser.leavePendingSince === null ? "не используется: страница на Node" : "уход с браузера", tone: "quiet" };
  }
  if (browser.link.error !== null) return { kind: "silent", text: "нет связи с оператором", tone: "warn" };
  if (browser.link.stateAgeMs === null || browser.link.stateAgeMs > BROWSER_SILENT_MS) {
    return { kind: "silent", text: "оператор молчит", tone: "warn" };
  }
  const { state } = browser;
  // A halt the operator holds for the owner's decision (on its volume, kept
  // across its restarts) stays his until his start clears it.
  if (browser.halt !== null) return { kind: "halted", text: `стоит: ${browserStopWords(browser.halt.reason)}`, tone: "danger" };
  if (browser.ownerStop !== null || state.stopReason === "owner_stop") return { kind: "stopped", text: "остановлен", tone: "warn" };
  if (state.stopReason !== null && state.retryAt === null) {
    return { kind: "halted", text: `стоит: ${browserStopWords(state.stopReason)}`, tone: "danger" };
  }
  if (state.stopReason !== null) return { kind: "failing", text: `перезапуск: ${browserStopWords(state.stopReason)}`, tone: "warn" };
  if (state.step === "ready") return { kind: "ready", text: "работает", tone: "ok" };
  return { kind: "starting", text: state.step === "exit_closed" ? "не запущен" : "запускается", tone: "quiet" };
}

/** The transport line: what sends the page's requests. */
export function browserTransportText(browser: EngineBrowser, now: number): string {
  if (browser.transport === "browser") return "браузер страницы";
  if (browser.leavePendingSince !== null) {
    return `Node — ждёт подтверждения ухода с браузера (с ${engineClockText(browser.leavePendingSince, now)})`;
  }
  return "Node (браузер подключён, запросы через него не идут)";
}

/** The operator's last word, how old it is, or why the engine has none. */
export function browserLinkText(browser: EngineBrowser, now: number): string {
  if (browser.link.error !== null) return LINK_ERROR_WORDS[browser.link.error] ?? browser.link.error;
  const age = engineAgeText(browser.link.lastStateAt, now);
  return age === null ? "оператор ещё ничего не сообщал" : `оператор сообщал ${age} назад`;
}

/** Where the start stands and since when. */
export function browserStateText(browser: EngineBrowser, now: number): string {
  const { state } = browser;
  const parts = [browserStepWords(state.step)];
  if (state.stopReason !== null && state.stopReason !== "owner_stop") parts.push(browserStopWords(state.stopReason));
  if (state.retryAt !== null) parts.push(`следующая попытка в ${engineClockText(state.retryAt, now)}`);
  if (state.step !== "ready" && state.downSince !== null) {
    const age = engineAgeText(state.downSince, now);
    if (age !== null) parts.push(`не готов ${age}`);
  }
  if (state.mode === "manual_login") parts.push("ручной вход");
  return parts.join(" · ");
}

export function browserOwnerStopText(browser: EngineBrowser, now: number): string | null {
  const stop = browser.ownerStop;
  if (stop === null) return null;
  return `остановлен владельцем в ${engineClockText(stop.at, now)}${stop.paused ? ", страница на паузе" : ""}`;
}

/** A halt for the owner's decision, latched until his start. */
export function browserHaltText(browser: EngineBrowser, now: number): string | null {
  const { halt } = browser;
  if (halt === null) return null;
  return `ждёт решения владельца: ${browserStopWords(halt.reason)} (с ${engineClockText(halt.at, now)})`;
}

export function browserLoginText(browser: EngineBrowser): string {
  if (browser.login.needed) {
    return browser.login.why === "login_required" ? "нужен вход: Fansly вышел из аккаунта в браузере" : "нужен вход: Fansly не принимает сессию";
  }
  if (!browser.session.present) return "сессии нет";
  return browser.session.accountId === null ? "сессия есть" : `сессия есть · аккаунт ${browser.session.accountId}`;
}

export function browserExitIpText(browser: EngineBrowser): string {
  const { proxy } = browser;
  const problem = proxy.problem === null ? null : PROXY_PROBLEM_WORDS[proxy.problem] ?? proxy.problem;
  if (proxy.pinnedExitIp === null) return problem === null ? "IP не закреплён" : `IP не закреплён · ${problem}`;
  const parts = [proxy.exitIp === null ? `закреплён ${proxy.pinnedExitIp}` : proxy.matches === false
    ? `${proxy.exitIp} — не совпадает с закреплённым ${proxy.pinnedExitIp}`
    : `${proxy.exitIp} (закреплён)`];
  if (problem !== null && proxy.problem !== "exit_ip_changed") parts.push(problem);
  return parts.join(" · ");
}

function bytesText(bytes: number): string {
  if (bytes < 1024) return `${engineCount(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  return `${(bytes / 1024 ** 3).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ГБ`;
}

function msText(ms: number): string {
  if (ms < 1000) return `${engineCount(ms)} мс`;
  const seconds = ms / 1000;
  if (seconds < 120) return `${seconds.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
  return `${engineCount(seconds / 60)} мин`;
}

export function browserBufferText(browser: EngineBrowser): string {
  const { buffer } = browser;
  if (buffer.bytes === null) return "нет данных";
  const parts = [bytesText(buffer.bytes)];
  if (buffer.oldestAgeMs !== null && buffer.bytes > 0) parts.push(`старейшее ${msText(buffer.oldestAgeMs)}`);
  if (buffer.percent !== null) parts.push(`${buffer.percent.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}${NBSP}% потолка`);
  return parts.join(" · ");
}

/** A buffer the engine takes nothing of, and one a stopped container kept:
 *  each its line (none: nothing wrong with it). */
export function browserBufferTroubleLines(browser: EngineBrowser, now: number): string[] {
  const { buffer } = browser;
  const lines: string[] = [];
  if (buffer.haltedReason !== null) {
    lines.push(`приём остановлен: история буфера расходится с движком (${buffer.haltedReason})`);
  }
  if (buffer.undrainedSince !== null) {
    lines.push(`не выгружен с ${engineClockText(buffer.undrainedSince, now)}: контейнер остановлен раньше выгрузки`);
  }
  return lines;
}

export function browserDeliveryText(browser: EngineBrowser, now: number): string {
  const { delivery } = browser;
  const parts: string[] = [];
  if (delivery.p95Ms !== null) parts.push(`p95 ${msText(delivery.p95Ms)}`);
  if (delivery.p50Ms !== null) parts.push(`p50 ${msText(delivery.p50Ms)}`);
  const last = engineAgeText(delivery.lastEventAt, now);
  // The site socket's last open or message the intake committed (#614: the
  // loss boundary): other events of the buffer do not move it.
  parts.push(last === null ? "событий сокета ещё не было" : `последнее событие сокета ${last.replaceAll(" ", NBSP)} назад`);
  return parts.join(" · ");
}

export function browserVersionsText(browser: EngineBrowser): string {
  const chrome = browser.versions.chrome === null ? "Chrome —" : `Chrome ${browser.versions.chrome}`;
  return browser.versions.operator === null ? chrome : `${chrome} · оператор ${browser.versions.operator}`;
}

export function browserSelfTestText(browser: EngineBrowser, now: number): string {
  const { selfTest } = browser;
  if (selfTest.ok === null) return "не проводилась";
  const at = selfTest.at === null ? "" : ` в ${engineClockText(selfTest.at, now)}`;
  return selfTest.ok ? `пройдена${at}` : `не пройдена${at}: ${selfTest.failed ?? "?"}`;
}

export function browserAlarmText(browser: EngineBrowser, now: number): string | null {
  const alarm = browser.lastAlarm;
  if (alarm === null) return null;
  const age = engineAgeText(alarm.at, now);
  return `${browserAlarmWords(alarm.kind)}${age === null ? "" : `, ${age} назад`}`;
}

/** The browser's alerts that hold now, in words — the kind once: a stop
 *  reason says it in its own words, any other reason follows the kind. */
export function browserAlertLines(browser: EngineBrowser, now: number): string[] {
  return browser.alerts.map((alert) => {
    const since = alert.since === null ? null : engineAgeText(alert.since, now);
    const stop = STOP_WORDS[alert.detail];
    const reason = stop === undefined ? alarmDetailWords(alert.detail) : null;
    const words = stop ?? `${browserAlertWords(alert.kind)}${reason === null ? "" : `: ${reason}`}`;
    return `${words}${since === null ? "" : ` (${since.replace(" ", NBSP)})`}`;
  });
}

function alarmDetailWords(detail: string): string | null {
  if (detail === "no_state") return "оператор молчит больше 2 мин";
  // The kind's own words say it all.
  if (detail === "site_unconfirmed") return null;
  if (detail.startsWith("link_")) return LINK_ERROR_WORDS[detail.slice(5)] ?? detail;
  if (detail.startsWith("alarm_")) return browserAlarmWords(detail.slice(6));
  if (detail.startsWith("buffer_")) return `заполнен на ${detail.slice(7)}${NBSP}%`;
  if (detail.startsWith("not_up:")) return `не поднимается (${browserStepWords(detail.slice(7))})`;
  if (detail.startsWith("hub_send_blocked:")) return `запросы Hub не уходят (${HUB_SEND_BLOCK_WORDS[detail.slice(17)] ?? detail.slice(17)})`;
  return detail;
}

/** Why Hub's requests do not go (the operator's `hubSend`, protocol minor 5). */
const HUB_SEND_BLOCK_WORDS: Readonly<Record<string, string>> = {
  client_check: "сайт считает fansly-client-check или fansly-client-ts иначе",
  header_parity: "заголовки запроса Hub разошлись с заголовками сайта — до перезапуска Chrome",
  manual_login: "идёт ручной вход",
  page_not_up: "страница не поднята",
  exit_ip_unknown: "выходной IP не подтверждён — проверка повторяется",
  buffer: "буфер не принимает записи",
  site_not_loaded: "сайт не загружен во вкладке",
  no_session: "нет живой сессии сайта",
  no_template: "сайт ещё не сделал запроса с авторизацией",
};
