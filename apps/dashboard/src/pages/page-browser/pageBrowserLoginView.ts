import type { PageBrowserLoginResponse, PageBrowserLoginStepResponse } from "@agency_hub_core/contracts";

// What the owner's login page of a page's server browser shows (Project
// Browser plan §4.8; PR 15): one view per moment of the login, its words,
// and what a step's answer says. Pure: the page renders it, tests read it.

export type LoginView =
  /** The landing is recognized; the owner can open the site's login modal. */
  | { kind: "landing" }
  /** The login is closed; `problem`: why it cannot be opened. */
  | { kind: "closed"; problem: string | null }
  /** Open: the page paused, the browser on its way to the login screen. */
  | { kind: "preparing" }
  /** Open, and the browser does not answer. */
  | { kind: "unreachable" }
  /** A screen the form fills: the login, the code, the site's error.
   *  `codeFrom` "email": the code is the one Fansly e-mailed for a login
   *  from a new device, not the 2FA code. */
  | { kind: "form"; screen: "login" | "code" | "error"; fields: Array<"login" | "password" | "code">; siteError: string | null; codeFrom?: "email" }
  /** Fansly took the login: the owner closes it. */
  | { kind: "success" }
  /** A screen the form does not know: the owner opens the browser's screen. */
  | { kind: "unknown" }
  /** Closed by the owner: the engine brings the automation back. */
  | { kind: "closing" };

export type Tone = "neutral" | "progress" | "good" | "warning" | "danger";

const PROBLEMS: Record<string, string> = {
  "no browser profile is bound to the page": "к странице не привязан браузер",
  "its browser has no pinned exit IP": "у браузера не закреплён выходной IP",
  "its browser has no environment (time zone, languages, geolocation)": "у браузера не задано окружение (часовой пояс, языки, геолокация)",
  // A new page's browser (PR 16).
  "no proxy is given for the page to be": "не задан прокси новой страницы",
  "its exit IP is not pinned": "не закреплён выходной IP",
  "the profile is bound to a page": "профиль уже привязан к странице",
};

/** The API's reason a browser is not ready, in the owner's words. */
export function browserProblemText(problem: string): string {
  return PROBLEMS[problem] ?? problem;
}

export function loginViewOf(data: PageBrowserLoginResponse): LoginView {
  switch (data.login.state) {
    case "off":
      return { kind: "closed", problem: data.browser.ready ? null : browserProblemText(data.browser.problem ?? "") };
    case "ending":
      return { kind: "closing" };
    case "wanted":
      break;
  }
  // A browser that is not ready (unbound meanwhile) is out of reach too.
  if (!data.browser.ready || data.browser.reachable === false) return { kind: "unreachable" };
  const screen = data.screen;
  if (screen === null) return { kind: "preparing" };
  switch (screen.screen) {
    case "landing":
      return { kind: "landing" };
    case "success":
      return { kind: "success" };
    case "unknown":
      return { kind: "unknown" };
    default:
      return formViewOf(screen, screen.screen);
  }
}

/** The form of a screen it fills, `kind` its screen (a page's login and a
 *  new page's onboarding alike). */
export function formViewOf(screen: NonNullable<PageBrowserLoginResponse["screen"]>, kind: "login" | "code" | "error"): Extract<LoginView, { kind: "form" }> {
  return { kind: "form", screen: kind, fields: screen.fields, siteError: screen.siteError, ...(screen.codeFrom === "email" ? { codeFrom: "email" as const } : {}) };
}

/** The view's chip: its words and its tone. */
export function loginChipOf(view: LoginView): { label: string; tone: Tone } {
  switch (view.kind) {
    case "landing":
      return { label: "Окно входа ещё закрыто", tone: "progress" };
    case "closed":
      return { label: "Вход закрыт", tone: "neutral" };
    case "preparing":
      return { label: "Готовим браузер", tone: "progress" };
    case "unreachable":
      return { label: "Браузер не отвечает", tone: "danger" };
    case "form":
      if (view.screen === "error") return { label: "Fansly показал ошибку", tone: "danger" };
      if (view.screen === "login") return { label: "Ждёт логин и пароль", tone: "progress" };
      return view.codeFrom === "email" ? { label: "Ждёт код из письма", tone: "progress" } : { label: "Ждёт код 2FA", tone: "progress" };
    case "success":
      return { label: "Вход выполнен", tone: "good" };
    case "unknown":
      return { label: "Незнакомый экран", tone: "warning" };
    case "closing":
      return { label: "Возвращаем автоматику", tone: "progress" };
  }
}

/** What a step's answer says when it did not lead to a screen. */
export function stepProblemText(answer: PageBrowserLoginStepResponse): string | null {
  if (answer.unreachable) return "Браузер не ответил. Посмотрите на снимок и попробуйте ещё раз.";
  switch (answer.refused) {
    case null:
      return null;
    case "busy":
      return "Браузер ещё выполняет прошлый шаг.";
    case "screen_changed":
      return "Экран в браузере изменился — ничего не нажато. Посмотрите на снимок.";
    case "not_manual_login":
      return "Браузер не в режиме входа. Подождите пару секунд.";
    case "token":
      return "Браузер не узнал Hub: проверьте настройку браузера страницы.";
  }
}

/** The form's fields: login and password together, or the code. */
export function wantsCode(view: Extract<LoginView, { kind: "form" }>): boolean {
  return view.fields.includes("code");
}

/** The code is the one Fansly e-mailed for a login from a new device. */
export function wantsEmailCode(view: Extract<LoginView, { kind: "form" }>): boolean {
  return wantsCode(view) && view.codeFrom === "email";
}
