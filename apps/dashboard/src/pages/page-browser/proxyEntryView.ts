import type {
  PageBrowserDraftView,
  PageBrowserEnvBody,
  PageBrowserMaskedProxy,
  PageBrowserProxyCheckResponse,
  PageBrowserProxyProblem,
} from "@agency_hub_core/contracts";
import {
  browserEnvProblem,
  formatPastedProxy,
  maskPastedProxy,
  pageBrowserProxyProblem,
  readPastedProxy,
  type PastedProxyOrder,
} from "@agency_hub_core/shared";

import type { Tone } from "./pageBrowserLoginView.js";

// What the one proxy field of a page's server browser shows (Project
// Browser, owner decision 2026-10-15): the pasted text read the way Hub
// reads it (the same `readPastedProxy`), its parts with the password
// masked, the question when the text reads two ways, the owner's check in
// his words, the environment proposed from the proxy's exit. Pure: the
// pages render it, tests read it.

export type ProxyPreview =
  | { kind: "empty" }
  | { kind: "invalid"; reason: string }
  | { kind: "ambiguous"; options: Array<{ order: PastedProxyOrder; label: string }> }
  | { kind: "parsed"; masked: PageBrowserMaskedProxy; problem: string | null; httpScheme: boolean };

const SCHEMES: Record<PageBrowserMaskedProxy["scheme"], string> = {
  socks5: "SOCKS5",
  socks5h: "SOCKS5 (DNS на прокси)",
  http: "HTTP",
  https: "HTTPS",
};

/** `host:port`, IPv6 in brackets. */
export function hostPortOf(proxy: Pick<PageBrowserMaskedProxy, "host" | "port">): string {
  return `${proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host}:${proxy.port}`;
}

/** The pasted text as Hub will read it. */
export function proxyPreviewOf(text: string, order: PastedProxyOrder | null): ProxyPreview {
  const read = readPastedProxy(text, order ?? undefined);
  switch (read.kind) {
    case "empty":
      return { kind: "empty" };
    case "invalid":
      return { kind: "invalid", reason: read.reason };
    case "ambiguous":
      return {
        kind: "ambiguous",
        options: read.options.map((option) => ({
          order: option.order,
          label: `адрес ${hostPortOf(option.proxy)}, логин ${option.proxy.username ?? "—"}`,
        })),
      };
    case "parsed":
      return {
        kind: "parsed",
        masked: maskPastedProxy(read.proxy),
        problem: pageBrowserProxyProblem(read.proxy),
        httpScheme: read.proxy.scheme === "http" || read.proxy.scheme === "https",
      };
  }
}

/** The parsed proxy's rows: the password never, only that it is there. */
export function maskedRows(proxy: PageBrowserMaskedProxy): Array<{ label: string; value: string }> {
  return [
    { label: "Тип", value: SCHEMES[proxy.scheme] },
    { label: "Адрес", value: proxy.host },
    { label: "Порт", value: String(proxy.port) },
    { label: "Логин", value: proxy.username ?? "—" },
    { label: "Пароль", value: proxy.passwordSet ? "••••••••" : "—" },
  ];
}

/** One line of a saved proxy. */
export function maskedLine(proxy: PageBrowserMaskedProxy): string {
  return `${SCHEMES[proxy.scheme]} · ${hostPortOf(proxy)} · логин ${proxy.username ?? "—"} · пароль ${proxy.passwordSet ? "••••••••" : "нет"}`;
}

/** The same proxy as `socks5://…`, for a pasted HTTP one whose port speaks
 *  SOCKS5 too: the field's new text (the owner's own password stays in his
 *  field; nothing of it comes from Hub). */
export function asSocks5Text(text: string, order: PastedProxyOrder | null): string | null {
  const read = readPastedProxy(text, order ?? undefined);
  return read.kind === "parsed" ? formatPastedProxy(read.proxy, "socks5") : null;
}

const PROBLEMS: Record<PageBrowserProxyProblem, string> = {
  dns: "Имя прокси не находится в DNS — проверьте адрес",
  no_answer: "Прокси не отвечает: соединение не открылось вовремя",
  refused: "Прокси отказал в соединении: на этом порту ничего не слушает",
  unreachable: "До прокси нет маршрута из сети сервера",
  not_socks5: "Порт отвечает не по SOCKS5",
  no_password_method: "SOCKS5 не принимает вход по логину и паролю, а браузер страницы входит только так",
  needs_login: "SOCKS5 просит логин и пароль — добавьте их в строку прокси",
  wrong_login: "Неверный логин или пароль прокси",
  tunnel_failed: "Логин принят, но прокси не открыл соединение наружу",
  ip_info_failed: "Прокси работает, но сервисы проверки IP через неё не ответили — повторите проверку позже",
  ipv6: "Адрес IPv6: сеть браузеров страниц только IPv4",
  private_address: "Адрес прокси локальный или частный: нужна прокси в интернете",
};

const SPOKEN: Record<NonNullable<PageBrowserProxyCheckResponse["spoken"]>, string> = {
  socks5: "SOCKS5",
  http: "HTTP-прокси",
  tls: "TLS (HTTPS-прокси)",
  unknown: "не распознан",
};

export interface CheckView {
  tone: Tone;
  title: string;
  /** Why not, in the owner's words (null: it works). */
  reason: string | null;
  /** The pasted type differs from what the port speaks: offer to save it as
   *  SOCKS5. */
  offerSocks5: boolean;
  rows: Array<{ label: string; value: string }>;
}

/** A country's name in Russian, by its code. */
export function countryNameOf(code: string | null, fallback: string | null): string | null {
  if (code === null) return fallback;
  try {
    return new Intl.DisplayNames(["ru"], { type: "region" }).of(code) ?? fallback ?? code;
  } catch {
    return fallback ?? code;
  }
}

/** The owner's check, in his words. */
export function checkViewOf(result: PageBrowserProxyCheckResponse): CheckView {
  const httpScheme = result.proxy.scheme === "http" || result.proxy.scheme === "https";
  const rows: CheckView["rows"] = [];
  if (result.spoken !== null) rows.push({ label: "Протокол", value: SPOKEN[result.spoken] });
  if (result.latencyMs !== null) rows.push({ label: "Задержка", value: `${result.latencyMs} мс` });
  const exit = result.exit;
  if (exit !== null) {
    rows.push({ label: "Выходной IP", value: exit.ip });
    const country = countryNameOf(exit.countryCode, exit.country);
    if (country !== null) rows.push({ label: "Страна", value: exit.countryCode === null ? country : `${country} (${exit.countryCode})` });
    const place = [...new Set([exit.city, exit.region].filter((part): part is string => part !== null))];
    if (place.length > 0) rows.push({ label: "Город, регион", value: place.join(", ") });
    const isp = [exit.isp, exit.asn].filter((part): part is string => part !== null);
    if (isp.length > 0) rows.push({ label: "Провайдер", value: isp.join(" · ") });
    if (exit.timeZone !== null) rows.push({ label: "Часовой пояс", value: exit.timeZone });
  }
  if (result.ipInfoService !== null) rows.push({ label: "Данные о месте", value: `${result.ipInfoService}, через прокси` });
  if (result.ok) {
    if (httpScheme) {
      return { tone: "warning", title: "Порт отвечает по SOCKS5", reason: "Вставлена как HTTP-прокси, но этот порт говорит и SOCKS5 — браузеру страницы подойдёт как SOCKS5.", offerSocks5: true, rows };
    }
    return { tone: "good", title: "Прокси работает", reason: null, offerSocks5: false, rows };
  }
  const code = result.problem?.code ?? "no_answer";
  let reason = PROBLEMS[code];
  if (code === "not_socks5") {
    reason = result.spoken === "http"
      ? "Это HTTP-прокси, а браузер страницы выходит только через SOCKS5 с логином и паролем. Возьмите у поставщика SOCKS5 этой прокси — часто тот же адрес, другой порт"
      : result.spoken === "tls"
        ? "Порт ждёт TLS (HTTPS-прокси), а браузеру страницы нужен SOCKS5"
        : "Порт принял соединение, но не ответил как SOCKS5";
  }
  return { tone: "danger", title: "Прокси не подходит", reason, offerSocks5: false, rows };
}

/** The environment's fields as the form edits them. */
export interface EnvFields {
  timeZone: string;
  languages: string;
  latitude: string;
  longitude: string;
  accuracyM: string;
}

export const EMPTY_ENV_FIELDS: EnvFields = { timeZone: "", languages: "", latitude: "", longitude: "", accuracyM: "" };

export function envFieldsOf(env: PageBrowserEnvBody): EnvFields {
  return {
    timeZone: env.timeZone,
    languages: env.languages.join(", "),
    latitude: String(env.geolocation.latitude),
    longitude: String(env.geolocation.longitude),
    accuracyM: String(env.geolocation.accuracyM),
  };
}

const numberOf = (value: string) => (value.trim() === "" ? Number.NaN : Number(value.trim().replace(",", ".")));

/** The fields as the environment Hub takes, or why not (the operator's
 *  rules, in the owner's words). */
export function envOfFields(fields: EnvFields): { env: PageBrowserEnvBody; problem: null } | { env: null; problem: string } {
  const env: PageBrowserEnvBody = {
    timeZone: fields.timeZone.trim(),
    languages: fields.languages.split(/[\s,;]+/).map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    geolocation: { latitude: numberOf(fields.latitude), longitude: numberOf(fields.longitude), accuracyM: numberOf(fields.accuracyM) },
  };
  const problem = browserEnvProblem(env);
  return problem === null ? { env, problem: null } : { env: null, problem };
}

/** One line of an environment. */
export function envLine(env: PageBrowserEnvBody): string {
  const { latitude, longitude, accuracyM } = env.geolocation;
  return `${env.timeZone} · ${env.languages.join(", ")} · ${latitude}, ${longitude} ±${accuracyM} м`;
}

/** A draft's chip in the list. */
export function draftChipOf(draft: PageBrowserDraftView): { label: string; tone: Tone } {
  if (draft.page !== null && draft.proxy === null) return { label: "У страницы нет прокси", tone: "danger" };
  if (draft.env === null) return { label: "Нет окружения", tone: "warning" };
  return { label: "Ждёт add-profile", tone: "progress" };
}
