import type { PageBrowserProfileResponse, PageBrowserProfileSummary } from "@agency_hub_core/contracts";

import { browserProblemText, formViewOf, type LoginView, type Tone } from "./pageBrowserLoginView.js";

// What the onboarding page of a new page's browser shows (Project Browser
// PR 16): its steps — the proxy, the exit IP, the login, the account and the
// page — where the owner is now, the browser's own word (its exit IP, its
// self-test), and the login's view as a page's (PR 15). Pure: the page
// renders it, tests read it.

export type StepState = "done" | "current" | "locked";

export interface OnboardingSteps {
  proxy: StepState;
  pin: StepState;
  login: StepState;
  account: StepState;
}

/** Where the owner is in the onboarding. */
export function onboardingStepsOf(data: PageBrowserProfileResponse): OnboardingSteps {
  const { profile, login } = data;
  if (login.state === "closing") return { proxy: "done", pin: "done", login: "locked", account: "locked" };
  if (!profile.proxySet) return { proxy: "current", pin: "locked", login: "locked", account: "locked" };
  // No pin yet, or the browser's own check named another IP: the pin again.
  if (profile.pinnedExitIp === null || profile.operator.stopReason === "exit_ip_changed") {
    return { proxy: "done", pin: "current", login: profile.pinnedExitIp === null ? "locked" : "current", account: "locked" };
  }
  if (login.state === "open") return { proxy: "done", pin: "done", login: "done", account: "current" };
  return { proxy: "done", pin: "done", login: "current", account: "locked" };
}

/** The browser stands for a reason of its own (not the owner's stop): what
 *  the login waits for is in the exit IP's step. */
export function browserHalted(profile: PageBrowserProfileSummary): boolean {
  return profile.operator.stopReason !== null && profile.operator.stopReason !== "owner_stop";
}

/** The login of the profile's browser as PR 15's view shows a page's. */
export function profileLoginViewOf(data: PageBrowserProfileResponse): LoginView {
  switch (data.login.state) {
    case "off":
    case "open":
      return { kind: "closed", problem: data.browser.ready ? null : browserProblemText(data.browser.problem ?? "") };
    case "closing":
      return { kind: "closing" };
    case "login":
      break;
  }
  if (!data.browser.ready || data.browser.reachable === false || browserHalted(data.profile)) return { kind: "unreachable" };
  const screen = data.screen;
  if (screen === null) return { kind: "preparing" };
  switch (screen.screen) {
    case "success":
      return { kind: "success" };
    case "unknown":
      return { kind: "unknown" };
    default:
      return formViewOf(screen, screen.screen);
  }
}

const STOPS: Record<string, string> = {
  exit_ip_changed: "браузер сам увидел через прокси другой выходной IP, чем закреплённый (опечатка в IP или прокси сменил адрес). Проверьте прокси — Hub покажет её выходной IP — и закрепите его",
  proxy_unavailable: "прокси не отвечает",
  proxy_auth: "прокси не принял логин и пароль",
  selftest_failed: "самопроверка браузера не прошла",
  env_mismatch: "окружение браузера не совпало с заданным",
  owner_stop: "браузер остановлен",
  header_mismatch: "заголовки запросов разошлись с сайтом",
  unknown_ws_message: "сайт отправил неизвестное сообщение сокета",
  buffer_unavailable: "буфер браузера не открывается",
  chrome_crashed: "Chrome упал — перезапускается",
  cdp_lost: "потеряно управление Chrome — перезапускается",
};

/** The browser's own word, in the owner's words: what it saw of its exit IP
 *  and its self-test, or why it stands. */
export function browserStatusOf(profile: PageBrowserProfileSummary): { label: string; tone: Tone; detail: string } {
  const operator = profile.operator;
  if (operator.linkError !== null) {
    return { label: "Браузер не принял Hub", tone: "danger", detail: operator.linkError === "token" ? "Токен браузера не совпал: профиль создан не тем запуском add-profile." : "Версии Hub и браузера несовместимы." };
  }
  if (operator.lastStateAt === null || operator.step === null) {
    return { label: "Ещё не запускался", tone: "neutral", detail: "Браузер запустится, когда вы начнёте вход: сначала он сам проверит свой выходной IP." };
  }
  if (operator.stopReason !== null && operator.stopReason !== "owner_stop") {
    return { label: "Браузер стоит", tone: operator.stopReason === "exit_ip_changed" ? "danger" : "warning", detail: `Причина: ${STOPS[operator.stopReason] ?? operator.stopReason}.` };
  }
  if (operator.exitOpen && operator.exitIp !== null) {
    const test = operator.selfTest === null ? "" : operator.selfTest.ok ? " Самопроверка пройдена." : ` Самопроверка не прошла (${operator.selfTest.failed ?? "?"}).`;
    const pinned = profile.pinnedExitIp === operator.exitIp ? " — это закреплённый IP." : ".";
    return { label: "Выход открыт", tone: "good", detail: `Браузер сам проверил свой выходной IP: ${operator.exitIp}${pinned}${test}` };
  }
  if (operator.stopReason === "owner_stop") return { label: "Остановлен", tone: "neutral", detail: "Браузер остановлен; профиль и сессия в нём сохранены." };
  return { label: "Запускается", tone: "progress", detail: `Шаг запуска: ${operator.step}.` };
}

/** The onboarding's chip in the list of profiles. */
export function onboardingChipOf(profile: PageBrowserProfileSummary): { label: string; tone: Tone } {
  switch (profile.onboarding) {
    case "login":
      return { label: "Идёт вход", tone: "progress" };
    case "open":
      return { label: "Вход выполнен", tone: "good" };
    case "closing":
      return { label: "Останавливаем", tone: "progress" };
    case "off":
      if (!profile.proxySet) return { label: "Нужен прокси", tone: "warning" };
      if (profile.pinnedExitIp === null) return { label: "Нужен выходной IP", tone: "warning" };
      return { label: "Готов ко входу", tone: "neutral" };
  }
}
