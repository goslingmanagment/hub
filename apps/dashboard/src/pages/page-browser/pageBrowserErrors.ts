import { KernelApiError } from "@/api/sdk";

// The hub writes the login's refusals in English: the screen says them in the
// owner's words by the error's code; the server's own text stays under «Подробнее».

const BY_CODE: Readonly<Record<string, string>> = {
  browser_not_ready: "Браузер страницы не готов. Причина выше.",
  login_not_open: "Вход уже закрыт. Начните его снова.",
  sync_page_not_found: "Эту страницу сбор не ведёт: войти нельзя.",
  profile_bound: "Браузер уже привязан к странице.",
  login_open: "Сначала закройте вход: при открытом входе прокси менять нельзя.",
  onboarding_refused: "Сейчас этот шаг нельзя: подключение в другом состоянии. Обновите экран.",
  onboarding_changed: "Пока проверяли аккаунт, подключение изменилось. Проверьте аккаунт ещё раз.",
  cross_origin: "Это действие принимается только с экранов консоли.",
};

/** Reasons about the proxy the server already writes in Russian: as they are. */
const RUSSIAN_CODES: ReadonlySet<string> = new Set(["proxy_empty", "proxy_ambiguous", "proxy_unusable"]);

export interface PageBrowserErrorView {
  text: string;
  /** The server's own words, for «Подробнее». */
  detail: string | null;
}

export function pageBrowserErrorView(error: unknown): PageBrowserErrorView {
  if (error instanceof KernelApiError) {
    if (error.code !== null && RUSSIAN_CODES.has(error.code)) return { text: error.message, detail: null };
    const text = error.code !== null ? BY_CODE[error.code] : undefined;
    return { text: text ?? "Не получилось. Hub вернул ошибку.", detail: error.message || null };
  }
  return { text: "Не получилось. Hub не ответил.", detail: null };
}

export function pageBrowserErrorText(error: unknown): string {
  return pageBrowserErrorView(error).text;
}
