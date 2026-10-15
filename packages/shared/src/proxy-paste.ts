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
// The four-part colon forms are told apart by which end holds a valid host
// and port: `1.2.3.4:1080:user:pass` is host first, `user:pass:1.2.3.4:1080`
// is the login first. A host here is an IPv4 address, an IPv6 address in
// brackets or a name with a dot (`proxy.example.com`) — a bare word is a
// login. When both ends read as a host and a port (`gate.example.com:1080:
// john.doe:5555`) the text is ambiguous: the caller asks which it is and
// reads it again with the order given.

export type PastedProxyScheme = "socks5" | "socks5h" | "http" | "https";
export type PastedProxyOrder = "host_first" | "user_first";

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

  // Why the @ forms did not read (an @ may also be part of a login or a
  // password in the colon forms: those are tried next).
  let atProblem: string | null = null;
  if (rest.includes("@")) {
    // login:password@host:port — the password may hold an @: the host is
    // after the last one.
    const last = rest.lastIndexOf("@");
    const at = hostPortOf(rest.slice(last + 1));
    const credentials = credentialsOf(rest.slice(0, last), decode);
    if (at !== null && credentials !== null) return { kind: "parsed", proxy: proxyOf(scheme, schemeGiven, at, credentials), order: null };
    // host:port@login:password
    const first = rest.indexOf("@");
    const reversedAt = hostPortOf(rest.slice(0, first));
    const reversed = credentialsOf(rest.slice(first + 1), decode);
    if (reversedAt !== null && reversed !== null) return { kind: "parsed", proxy: proxyOf(scheme, schemeGiven, reversedAt, reversed), order: "host_first" };
    atProblem = credentials === null ? "Перед @ нет логина" : hostPortProblem(rest.slice(last + 1));
  }
  const colonRead = readColonForm(rest, scheme, schemeGiven, order);
  return atProblem !== null && colonRead.kind === "invalid" ? invalid(atProblem) : colonRead;
}

/** The colon forms: host:port, and the four parts either way round. */
function readColonForm(rest: string, scheme: PastedProxyScheme, schemeGiven: boolean, order: PastedProxyOrder | undefined): PastedProxyRead {
  const parts = colonParts(rest);
  if (parts === null) return invalid("Не закрыта квадратная скобка IPv6-адреса");
  if (!rest.includes("[") && rest.includes("::") && ipv6Of(rest.replace(/:\d{1,5}$/, "")) !== null) {
    return invalid("IPv6-адрес пишется в квадратных скобках: [2001:db8::1]:1080");
  }
  if (parts.some((part) => part.length === 0)) return invalid("Пустая часть между двоеточиями");
  if (parts.length === 1) return invalid("Нет порта: нужно адрес:порт");
  if (parts.length === 2) {
    const at = hostPortOf(rest);
    return at === null ? invalid(hostPortProblem(rest)) : { kind: "parsed", proxy: proxyOf(scheme, schemeGiven, at, null), order: null };
  }
  if (parts.length === 3) return invalid("Три части через двоеточие: не хватает логина или пароля (адрес:порт:логин:пароль)");

  const n = parts.length;
  const hostFirstAt = hostOf(parts[0]!);
  const hostFirstPort = portOf(parts[1]!);
  const userFirstAt = hostOf(parts[n - 2]!);
  const userFirstPort = portOf(parts[n - 1]!);
  const hostFirst = hostFirstAt !== null && hostFirstAt.strong && hostFirstPort !== null
    ? proxyOf(scheme, schemeGiven, { host: hostFirstAt, port: hostFirstPort }, { username: parts[2]!, password: parts.slice(3).join(":") })
    : null;
  const userFirst = userFirstAt !== null && userFirstAt.strong && userFirstPort !== null
    ? proxyOf(scheme, schemeGiven, { host: userFirstAt, port: userFirstPort }, { username: parts[0]!, password: parts.slice(1, n - 2).join(":") })
    : null;
  if (order === "host_first" && hostFirst !== null) return { kind: "parsed", proxy: hostFirst, order };
  if (order === "user_first" && userFirst !== null) return { kind: "parsed", proxy: userFirst, order };
  if (hostFirst !== null && userFirst !== null) {
    return { kind: "ambiguous", options: [{ order: "host_first", proxy: hostFirst }, { order: "user_first", proxy: userFirst }] };
  }
  if (hostFirst !== null) return { kind: "parsed", proxy: hostFirst, order: "host_first" };
  if (userFirst !== null) return { kind: "parsed", proxy: userFirst, order: "user_first" };
  if (!rest.includes("[") && ipv6Of(rest.replace(/:\d{1,5}$/, "")) !== null) {
    return invalid("IPv6-адрес пишется в квадратных скобках: [2001:db8::1]:1080");
  }
  return invalid("Не понять, где адрес и порт: ожидается адрес:порт:логин:пароль или логин:пароль:адрес:порт");
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
  if (hostOf(parts[0]!) === null) return "Адрес прокси не читается: нужно имя или IP-адрес, затем порт";
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
