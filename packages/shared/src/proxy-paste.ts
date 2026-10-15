// One proxy pasted the way a provider hands it out, read into its parts
// (Project Browser, owner decision 2026-10-15: «сразу проксю вбиваем … чтобы
// она понимала разные форматы»). The same reading runs in the dashboard (the
// preview before anything is sent) and in Hub (the one that counts: the API
// reads the text again and never trusts the client's parts). Browser-safe:
// no Node module.
//
// Forms read:
//   host:port
//   host:port:login:password          login:password:host:port
//   login:password@host:port          host:port@login:password
//   socks5://login:password@host:port socks5h://…  socks://… (= socks5)
//   http://…  https://…               (read and reported: a page's browser
//                                      goes out through SOCKS5 only)
//   [2001:db8::1]:1080 …              (IPv6 in brackets, in any form above)
// Spaces, tabs and line breaks around the text are dropped; parts separated
// by spaces or tabs alone (a row copied from a table) are read as
// colon-separated. A space inside a part refuses the text: a provider's
// login or password never holds one.
//
// Every reading of the text is gathered, from every form — the @ forms and
// the colon forms alike (Astra's review of PR #627, round 2) — and only a
// valid one counts: its host an IPv4 address, an IPv6 address in brackets or
// a full name (a dot and a real TLD: `proxy.example.com`), its port a
// number from 1 to 65535. A bare word (`alice`) is no proxy's address: a
// proxy a page's browser can reach has a public address or a public name.
// One valid reading: the proxy. More than one — which number is the port and
// which the password cannot be told (`gate.example.com:1080:john.doe:5555`,
// `93.184.216.34:1080:alice@example.com:54321`) — the text is ambiguous: the
// caller asks the owner and reads it again with the reading he chose
// (`order`), which picks exactly one. Never the first form that parses.

export type PastedProxyScheme = "socks5" | "socks5h" | "http" | "https";
/** Which reading the owner chose: host:port:login:password,
 *  login:password:host:port, login:password@host:port, host:port@login:password. */
export type PastedProxyOrder = "host_first" | "user_first" | "login_at_host" | "host_at_login";

export interface PastedProxy {
  scheme: PastedProxyScheme;
  /** The text named it (false: none given — SOCKS5 is assumed). */
  schemeGiven: boolean;
  /** A lowercase name, an IPv4 address, or an IPv6 address without its
   *  brackets. */
  host: string;
  hostKind: "ipv4" | "ipv6" | "name";
  port: number;
  username: string | null;
  password: string | null;
}

export type PastedProxyRead =
  | { kind: "empty" }
  | { kind: "invalid"; reason: string }
  | { kind: "parsed"; proxy: PastedProxy; order: PastedProxyOrder | null }
  | { kind: "ambiguous"; options: Array<{ order: PastedProxyOrder; proxy: PastedProxy }> };

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const invalid = (reason: string): PastedProxyRead => ({ kind: "invalid", reason });

/** An IPv6 address as the URL parser canonicalizes it, or null. */
function ipv6Of(text: string): string | null {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(":")) return null;
  try {
    const host = new URL(`http://[${text}]/`).hostname;
    return host.slice(1, -1);
  } catch {
    return null;
  }
}

/** A DNS name, lowercased and in its ASCII form, or null. */
function nameOf(text: string): string | null {
  let ascii = text.toLowerCase();
  if (!/^[\x20-\x7e]*$/.test(ascii)) {
    try {
      ascii = new URL(`http://${ascii}/`).hostname;
    } catch {
      return null;
    }
  }
  if (ascii.endsWith(".")) ascii = ascii.slice(0, -1);
  if (ascii.length === 0 || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (!labels.every((label) => LABEL.test(label))) return null;
  // All digits and dots is an IPv4 address or nothing (127.1 is not a name).
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  return ascii;
}

interface Host {
  host: string;
  kind: PastedProxy["hostKind"];
  /** Plainly a host: an address, or a name with a dot and a real TLD. */
  strong: boolean;
}

function hostOf(token: string): Host | null {
  if (token.startsWith("[") && token.endsWith("]")) {
    const v6 = ipv6Of(token.slice(1, -1));
    return v6 === null ? null : { host: v6, kind: "ipv6", strong: true };
  }
  if (IPV4.test(token)) return { host: token, kind: "ipv4", strong: true };
  const name = nameOf(token);
  if (name === null) return null;
  const labels = name.split(".");
  return { host: name, kind: "name", strong: labels.length >= 2 && TLD.test(labels.at(-1)!) };
}

function portOf(token: string): number | null {
  if (!/^\d{1,5}$/.test(token)) return null;
  const port = Number(token);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** `a:b:c` into its parts; an IPv6 address in brackets stays one part. */
function colonParts(text: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "[" && current === "") {
      const end = text.indexOf("]", index);
      if (end < 0) return null;
      current = text.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === ":") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function credentialOf(value: string, decode: boolean): string {
  if (!decode || !value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `login:password` (the password may hold a colon); a login alone has no
 *  password. */
function credentialsOf(text: string, decode: boolean): { username: string; password: string | null } | null {
  if (text.length === 0) return null;
  const colon = text.indexOf(":");
  const username = credentialOf(colon < 0 ? text : text.slice(0, colon), decode);
  const password = colon < 0 ? null : credentialOf(text.slice(colon + 1), decode);
  if (username.length === 0) return null;
  return { username, password: password === "" ? null : password };
}

function hostPortOf(text: string): { host: Host; port: number } | null {
  const parts = colonParts(text);
  if (parts === null || parts.length !== 2) return null;
  const host = hostOf(parts[0]!);
  const port = portOf(parts[1]!);
  return host === null || port === null ? null : { host, port };
}

function proxyOf(
  scheme: PastedProxyScheme,
  schemeGiven: boolean,
  at: { host: Host; port: number },
  credentials: { username: string; password: string | null } | null,
): PastedProxy {
  return {
    scheme,
    schemeGiven,
    host: at.host.host,
    hostKind: at.host.kind,
    port: at.port,
    username: credentials?.username ?? null,
    password: credentials?.password ?? null,
  };
}

/** The text as one line: invisible characters gone, the ends trimmed, the
 *  parts of a row copied from a table joined by colons; or why not. */
function lineOf(text: string): { line: string } | { empty: true } | { reason: string } {
  const lines = text.replace(INVISIBLE, "").split(/\r\n|\r|\n/).map((line) => line.replace(/[\s\u00A0]+/g, " ").trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return { empty: true };
  if (lines.length > 1) return { reason: "В поле несколько строк: вставьте одну прокси" };
  let line = lines[0]!;
  if (line.includes(" ")) {
    line = /[:@]/.test(line) ? line.replace(/ ?([:@]) ?/g, "$1") : line.split(" ").join(":");
    if (line.includes(" ")) return { reason: "Пробел внутри адреса, логина или пароля: проверьте, что вставлено" };
  }
  return { line };
}

function schemeOf(name: string): PastedProxyScheme | { reason: string } {
  switch (name.toLowerCase()) {
    case "socks5":
    case "socks":
      return "socks5";
    case "socks5h":
      return "socks5h";
    case "http":
      return "http";
    case "https":
      return "https";
    case "socks4":
    case "socks4a":
      return { reason: "SOCKS4 не подходит: браузеру страницы нужен SOCKS5 с логином и паролем" };
    default:
      return { reason: `Тип прокси «${name}» не знаком: socks5://, socks5h://, http:// или https://` };
  }
}

/**
 * Read one pasted proxy. `order` settles a four-part colon form both ends of
 * which read as a host and a port (the caller asked the owner).
 */
export function readPastedProxy(text: string, order?: PastedProxyOrder): PastedProxyRead {
  const cleaned = lineOf(text);
  if ("empty" in cleaned) return { kind: "empty" };
  if ("reason" in cleaned) return invalid(cleaned.reason);
  let rest = cleaned.line;
  let scheme: PastedProxyScheme = "socks5";
  let schemeGiven = false;
  const named = SCHEME.exec(rest);
  if (named !== null) {
    const read = schemeOf(named[1]!);
    if (typeof read !== "string") return invalid(read.reason);
    scheme = read;
    schemeGiven = true;
    rest = rest.slice(named[0].length).replace(/\/$/, "");
  }
  if (/[/?#]/.test(rest)) return invalid("После порта лишнее: нужен только адрес, порт, логин и пароль");
  // URL-encoded credentials only in the URL form, where they must be.
  const decode = schemeGiven;

  const readings = readingsOf(rest, scheme, schemeGiven, decode);
  if ("reason" in readings) return invalid(readings.reason);
  return choose(readings.readings, order) ?? invalid(problemOf(rest));
}

/** One way to read a text. */
interface Reading {
  order: PastedProxyOrder | null;
  proxy: PastedProxy;
}

const sameProxy = (a: PastedProxy, b: PastedProxy) =>
  a.host === b.host && a.port === b.port && a.username === b.username && a.password === b.password;

/** A host:port a reading may take: a valid port, and a host that can be a
 *  proxy's (an address, or a full name — never a bare word). */
function proxyHostPortOf(text: string): { host: Host; port: number } | null {
  const at = hostPortOf(text);
  return at !== null && at.host.strong ? at : null;
}

/**
 * Every valid reading of the text, from every form (Astra's review of PR
 * #627, round 2) — or why the text cannot be read at all.
 */
function readingsOf(rest: string, scheme: PastedProxyScheme, schemeGiven: boolean, decode: boolean): { readings: Reading[] } | { reason: string } {
  const readings: Reading[] = [];
  const add = (order: PastedProxyOrder | null, at: { host: Host; port: number }, credentials: { username: string; password: string | null } | null) => {
    const proxy = proxyOf(scheme, schemeGiven, at, credentials);
    if (!readings.some((reading) => sameProxy(reading.proxy, proxy))) readings.push({ order, proxy });
  };
  if (rest.includes("@")) {
    // login:password@host:port — the password may hold an @: the host is
    // after the last one.
    const last = rest.lastIndexOf("@");
    const at = proxyHostPortOf(rest.slice(last + 1));
    const credentials = credentialsOf(rest.slice(0, last), decode);
    if (at !== null && credentials !== null) add("login_at_host", at, credentials);
    // host:port@login:password — the login may hold an @: the host is
    // before the first one.
    const first = rest.indexOf("@");
    const reversedAt = proxyHostPortOf(rest.slice(0, first));
    const reversed = credentialsOf(rest.slice(first + 1), decode);
    if (reversedAt !== null && reversed !== null) add("host_at_login", reversedAt, reversed);
  }
  const parts = colonParts(rest);
  if (parts === null) return readings.length > 0 ? { readings } : { reason: "Не закрыта квадратная скобка IPv6-адреса" };
  if (parts.length === 2 && !rest.includes("@")) {
    const at = proxyHostPortOf(rest);
    if (at !== null) add(null, at, null);
  }
  if (parts.length >= 4 && parts.every((part) => part.length > 0)) {
    const n = parts.length;
    const hostFirst = proxyHostPortOf(`${parts[0]}:${parts[1]}`);
    if (hostFirst !== null) add("host_first", hostFirst, { username: parts[2]!, password: parts.slice(3).join(":") });
    const userFirst = proxyHostPortOf(`${parts[n - 2]}:${parts[n - 1]}`);
    if (userFirst !== null) add("user_first", userFirst, { username: parts[0]!, password: parts.slice(1, n - 2).join(":") });
  }
  return { readings };
}

/**
 * The reading the text has: the one the owner chose, when his choice picks
 * exactly one; else the only one; else none — ambiguous, the owner says
 * which (Astra's review of PR #627, round 2). Null: no reading.
 */
function choose(readings: Reading[], order: PastedProxyOrder | undefined): PastedProxyRead | null {
  if (readings.length === 0) return null;
  if (order !== undefined) {
    const asked = readings.filter((reading) => reading.order === order);
    if (asked.length === 1) return { kind: "parsed", proxy: asked[0]!.proxy, order };
  }
  if (readings.length === 1) return { kind: "parsed", proxy: readings[0]!.proxy, order: readings[0]!.order };
  const options = readings.flatMap((reading) => (reading.order === null ? [] : [{ order: reading.order, proxy: reading.proxy }]));
  return { kind: "ambiguous", options };
}

/** Why a text has no reading, in the owner's words — its parts never
 *  echoed (a misplaced one may be the password). */
function problemOf(rest: string): string {
  if (!rest.includes("[") && rest.includes("::") && ipv6Of(rest.replace(/:\d{1,5}$/, "")) !== null) {
    return "IPv6-адрес пишется в квадратных скобках: [2001:db8::1]:1080";
  }
  if (rest.includes("@")) {
    const last = rest.lastIndexOf("@");
    if (credentialsOf(rest.slice(0, last), false) === null) return "Перед @ нет логина";
    return hostPortProblem(rest.slice(last + 1));
  }
  const parts = colonParts(rest);
  if (parts !== null && parts.some((part) => part.length === 0)) return "Пустая часть между двоеточиями";
  if (parts === null || parts.length === 1) return "Нет порта: нужно адрес:порт";
  if (parts.length === 2) return hostPortProblem(rest);
  if (parts.length === 3) return "Три части через двоеточие: не хватает логина или пароля (адрес:порт:логин:пароль)";
  if (!rest.includes("[") && ipv6Of(rest.replace(/:\d{1,5}$/, "")) !== null) return "IPv6-адрес пишется в квадратных скобках: [2001:db8::1]:1080";
  return "Не понять, где адрес и порт: ожидается адрес:порт:логин:пароль или логин:пароль:адрес:порт; адрес — IP или полное имя";
}

function hostPortProblem(text: string): string {
  const parts = colonParts(text);
  if (parts === null || parts.length < 2) return "Нет порта: нужно адрес:порт";
  if (parts.length > 2) {
    return ipv6Of(text.replace(/:\d{1,5}$/, "")) !== null
      ? "IPv6-адрес пишется в квадратных скобках: [2001:db8::1]:1080"
      : "Лишнее двоеточие в адресе";
  }
  // The parts are never echoed: a misplaced one may be the password.
  const host = hostOf(parts[0]!);
  if (host === null || !host.strong) return "Адрес прокси не читается: нужен IP-адрес или полное имя (с точкой), затем порт";
  return "После адреса не порт: нужно число от 1 до 65535";
}

/** The proxy as Hub stores it (the shape of `egress_endpoints`): its URL
 *  without credentials and its login and password apart. `socks5h` is kept
 *  as `socks5`: Hub's SOCKS5 clients and the page's operator hand the
 *  destination's name to the proxy anyway (DNS on its side). */
export function pastedProxyConfig(proxy: PastedProxy): { url: string; username: string | null; password: string | null } {
  const scheme = proxy.scheme === "socks5h" ? "socks5" : proxy.scheme;
  const host = proxy.hostKind === "ipv6" ? `[${proxy.host}]` : proxy.host;
  return { url: `${scheme}://${host}:${proxy.port}`, username: proxy.username, password: proxy.password };
}

/** The proxy as text again, in the URL form (its credentials encoded):
 *  what the field shows after the owner chose to use it as another type. */
export function formatPastedProxy(proxy: PastedProxy, scheme: PastedProxyScheme = proxy.scheme): string {
  const host = proxy.hostKind === "ipv6" ? `[${proxy.host}]` : proxy.host;
  const credentials = proxy.username === null
    ? ""
    : `${encodeURIComponent(proxy.username)}${proxy.password === null ? "" : `:${encodeURIComponent(proxy.password)}`}@`;
  return `${scheme}://${credentials}${host}:${proxy.port}`;
}

/** What may be shown of a proxy: never its password. */
export interface MaskedProxy {
  scheme: PastedProxyScheme;
  host: string;
  port: number;
  username: string | null;
  passwordSet: boolean;
}

export function maskPastedProxy(proxy: PastedProxy): MaskedProxy {
  return { scheme: proxy.scheme, host: proxy.host, port: proxy.port, username: proxy.username, passwordSet: proxy.password !== null };
}

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/**
 * Why a page's server browser cannot go out through this proxy, in the
 * owner's words — or null. The operator dials SOCKS5 with a login and a
 * password only (RFC 1929: each 1 to 255 bytes), to an IPv4 address the
 * container's rules admit (pb-egress has no IPv6).
 */
export function pageBrowserProxyProblem(proxy: PastedProxy): string | null {
  if (proxy.scheme === "http" || proxy.scheme === "https") {
    return "Это HTTP-прокси, а браузер страницы выходит только через SOCKS5 с логином и паролем. Возьмите у поставщика SOCKS5 этой прокси — часто это тот же адрес, иногда другой порт";
  }
  if (proxy.hostKind === "ipv6") return "Адрес IPv6: сеть браузеров страниц только IPv4. Нужен IPv4-адрес или имя прокси";
  if (proxy.username === null || proxy.password === null) return "Нужны логин и пароль: браузер страницы входит в SOCKS5 только с ними";
  if (utf8Length(proxy.username) > 255 || utf8Length(proxy.password) > 255) return "Логин или пароль длиннее 255 байт: SOCKS5 такой не передаёт";
  return null;
}
