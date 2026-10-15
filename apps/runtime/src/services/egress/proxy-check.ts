import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { connect as tcpConnect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

import { nonGlobalAddressReason } from "@agency_hub_core/shared";

// The owner's check of a proxy for a page's server browser (Project Browser,
// owner decision 2026-10-15: «чекала прокси как в антик браузерах»): like
// Dolphin, AdsPower or GoLogin, Hub connects through the proxy and says
// whether it works and why not, which protocol the port actually speaks,
// how long a request through it takes, and where it goes out — its exit IP,
// country, region and city, ISP and ASN, time zone and coordinates.
//
// This is NOT a platform request and not a page's egress: it never touches
// Fansly (or any platform), it never goes through the egress resolver, and
// nothing of a page's sends it. It is the dashboard's proxy test made
// precise — `POST /api/v1/admin/proxy/test` reads only the exit IP through
// undici — run on the owner's press, once:
// - one TCP connection to the proxy; the SOCKS5 greeting exactly as the
//   page's operator sends it (RFC 1928: password login only, RFC 1929), so
//   what it says here is what the operator will meet;
// - when the port does not answer as SOCKS5, at most one more connection,
//   to tell an HTTP proxy (one `CONNECT` line, no credentials) from
//   something else;
// - through the tunnel, one HTTPS GET to an IP-info service; on its
//   failure, one GET to the fallback service over a new tunnel. No retry
//   beyond that: every step has its own deadline and the whole check one
//   overall bound (`totalMs`).
//
// The IP-info services, both HTTPS, both without a key:
// - ipinfo.io (`/json`): the widely used one, the best ISP/ASN naming; free
//   without a token, its limit counted per caller's IP — here the proxy's
//   exit, so each proxy has its own;
// - get.geojs.io (`/v1/ip/geo.json`): an independent provider and data
//   source with no published limit — the fallback when ipinfo.io refuses
//   (429) or cannot be reached.
// The destination goes to the proxy as a name (its DNS, as the operator's).
//
// The credentials are used for the SOCKS5 login and nowhere else: never
// logged, never in an error, never in the answer.
//
// The proxy is reached by an IP address only, judged before (Astra's review
// of PR #627, item 1): a name is resolved ONCE (`resolveProxyHost`), every
// address it resolves to must be a public one, and the check connects to
// that very address — nothing here resolves a name again, so a second DNS
// answer cannot point the check at Hub's own networks.

export interface ProxyCheckProxy {
  /** The proxy's IPv4 address, judged public by the caller. */
  ip: string;
  port: number;
  username: string | null;
  password: string | null;
}

/** A proxy's host resolved once: the IPv4 address to reach it at — every
 *  address the name resolved to a public one — or why not. */
export type ProxyHostRead =
  | { ip: string }
  | { problem: "dns" | "ipv6" | "private_address"; detail: string };

export interface ProxyHostOptions {
  /** A name to every address it resolves to (default: the system's DNS). */
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  /** TESTS ONLY: addresses taken as public (a test's proxy listens on
   *  loopback). */
  allow?: (ip: string) => boolean;
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/**
 * The proxy's host as an IPv4 address to connect to, resolved once: an
 * address as it is, a name by one DNS query whose every answer — IPv4 and
 * IPv6 — must be public. A page's browser reaches IPv4 only (pb-egress has
 * no IPv6), so the first IPv4 answer is the one.
 */
export async function resolveProxyHost(host: string, hostKind: "ipv4" | "ipv6" | "name", options: ProxyHostOptions = {}): Promise<ProxyHostRead> {
  const judge = (ip: string) => (options.allow?.(ip) === true ? null : nonGlobalAddressReason(ip));
  if (hostKind === "ipv6") return { problem: "ipv6", detail: "the page browsers' network is IPv4 only" };
  let addresses: string[];
  if (hostKind === "ipv4") {
    addresses = [host];
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        (options.resolve ?? resolveAll)(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), options.timeoutMs ?? PROXY_CHECK_TIMEOUTS.dnsMs);
        }),
      ]);
    } catch {
      return { problem: "dns", detail: `the name ${host} does not resolve` };
    } finally {
      clearTimeout(timer);
    }
  }
  if (addresses.length === 0) return { problem: "dns", detail: `the name ${host} resolves to no address` };
  for (const address of addresses) {
    const reason = judge(address);
    if (reason !== null) return { problem: "private_address", detail: `${hostKind === "name" ? `the name ${host} resolves to` : "the address is"} ${address}: ${reason}` };
  }
  const ip = addresses.find((address) => isIP(address) === 4);
  if (ip === undefined) return { problem: "ipv6", detail: `the name ${host} resolves to IPv6 only; the page browsers' network is IPv4 only` };
  return { ip };
}

/** Where the proxy goes out, as an IP-info service names it. */
export interface ProxyExit {
  ip: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  asn: string | null;
  timeZone: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface IpInfoService {
  /** Its name as the owner sees it. */
  name: string;
  host: string;
  port: number;
  path: string;
  /** The answer read, or null when it names no address. */
  read(body: unknown): ProxyExit | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 200) : null);
const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const ipOf = (value: unknown): string | null => {
  const ip = text(value);
  return ip !== null && isIP(ip) !== 0 ? ip.toLowerCase() : null;
};
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** `AS15169 Google LLC` → its ASN and its name. */
function orgOf(value: unknown): { asn: string | null; isp: string | null } {
  const org = text(value);
  if (org === null) return { asn: null, isp: null };
  const match = /^(AS\d+)\s+(.*)$/i.exec(org);
  return match === null ? { asn: null, isp: org } : { asn: match[1]!.toUpperCase(), isp: text(match[2]) };
}

export const IPINFO: IpInfoService = {
  name: "ipinfo.io",
  host: "ipinfo.io",
  port: 443,
  path: "/json",
  read(body) {
    const answer = record(body);
    const ip = ipOf(answer.ip);
    if (ip === null) return null;
    const [latitude, longitude] = (text(answer.loc) ?? "").split(",").map(number);
    const org = orgOf(answer.org);
    return {
      ip,
      country: null,
      countryCode: text(answer.country)?.toUpperCase() ?? null,
      region: text(answer.region),
      city: text(answer.city),
      isp: org.isp,
      asn: org.asn,
      timeZone: text(answer.timezone),
      latitude: latitude ?? null,
      longitude: longitude ?? null,
    };
  },
};

export const GEOJS: IpInfoService = {
  name: "get.geojs.io",
  host: "get.geojs.io",
  port: 443,
  path: "/v1/ip/geo.json",
  read(body) {
    const answer = record(body);
    const ip = ipOf(answer.ip);
    if (ip === null) return null;
    const org = orgOf(answer.organization);
    const asn = number(answer.asn);
    return {
      ip,
      country: text(answer.country),
      countryCode: text(answer.country_code)?.toUpperCase() ?? null,
      region: text(answer.region),
      city: text(answer.city),
      isp: text(answer.organization_name) ?? org.isp,
      asn: asn !== null ? `AS${asn}` : org.asn,
      timeZone: text(answer.timezone),
      latitude: number(answer.latitude),
      longitude: number(answer.longitude),
    };
  },
};

/** The services, in the order they are asked: the first, then its fallback. */
export const IP_INFO_SERVICES: readonly IpInfoService[] = [IPINFO, GEOJS];

/** Why a proxy does not work (or not for a page's browser). */
export type ProxyCheckProblem =
  /** Its name does not resolve. */
  | "dns"
  /** No answer to the connection within the deadline. */
  | "no_answer"
  /** The port refused the connection. */
  | "refused"
  /** The network has no route to it. */
  | "unreachable"
  /** It answers, but not as SOCKS5 (`spoken` says what it is). */
  | "not_socks5"
  /** A SOCKS5 that takes no login and password (the operator logs in
   *  with them only). */
  | "no_password_method"
  /** A SOCKS5 that asks for a login and a password, and none was given. */
  | "needs_login"
  /** It refused the login or the password. */
  | "wrong_login"
  /** It took the login but could not open the way to the IP-info service. */
  | "tunnel_failed"
  /** The tunnel works, but neither IP-info service answered through it. */
  | "ip_info_failed";

export interface ProxyCheckResult {
  ok: boolean;
  problem: { code: ProxyCheckProblem; detail: string } | null;
  /** What the port speaks: null — never reached. */
  spoken: "socks5" | "http" | "tls" | "unknown" | null;
  /** `ip:port` the proxy's name resolved to: what a page container's rules
   *  admit. */
  socksEndpoint: string | null;
  /** One request through the proxy: the tunnel, TLS and the answer. */
  latencyMs: number | null;
  exit: ProxyExit | null;
  /** The service that named the exit. */
  ipInfoService: string | null;
}

export interface ProxyCheckOptions {
  services?: readonly IpInfoService[];
  /** The stream the IP-info request goes over: TLS to the service by default
   *  (tests talk plain HTTP to a local server behind a local SOCKS5). */
  wrap?: (socket: Socket, host: string) => Duplex;
  timeouts?: Partial<ProxyCheckTimeouts>;
}

export interface ProxyCheckTimeouts {
  dnsMs: number;
  connectMs: number;
  /** Each answer of the SOCKS5 or HTTP handshake. */
  answerMs: number;
  /** The tunnel to a service, its TLS and its answer. */
  requestMs: number;
  /** The whole check. */
  totalMs: number;
}

export const PROXY_CHECK_TIMEOUTS: ProxyCheckTimeouts = { dnsMs: 5_000, connectMs: 8_000, answerMs: 6_000, requestMs: 10_000, totalMs: 30_000 };

class CheckFailure extends Error {
  constructor(readonly code: ProxyCheckProblem, readonly detail: string, readonly spoken: ProxyCheckResult["spoken"] = null) {
    super(detail);
    this.name = "CheckFailure";
  }
}

const REPLIES: Record<number, string> = {
  1: "general failure",
  2: "not allowed by the proxy's rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** A connection to the proxy, or why not; kept in `open` until the check
 *  ends (its overall bound closes what is still open). */
function connectTo(ip: string, port: number, timeoutMs: number, open: Set<Socket>): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: ip, port });
    open.add(socket);
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CheckFailure("no_answer", `no answer to the connection in ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      const code = error.code ?? "";
      if (code === "ECONNREFUSED") reject(new CheckFailure("refused", "the port refused the connection"));
      else if (code === "EHOSTUNREACH" || code === "ENETUNREACH") reject(new CheckFailure("unreachable", `no route to the proxy (${code})`));
      else if (code === "ETIMEDOUT") reject(new CheckFailure("no_answer", "the connection timed out"));
      else reject(new CheckFailure("no_answer", `the connection failed (${code || "error"})`));
    });
  });
}

/** Reads a socket's bytes as they come, `need(buffer)` deciding when there
 *  is enough; null on a close or the deadline. */
class Reader {
  #buffer = Buffer.alloc(0);
  #closed = false;
  #wake: (() => void) | null = null;

  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#wake?.();
    });
    const closed = () => {
      this.#closed = true;
      this.#wake?.();
    };
    socket.on("end", closed);
    socket.on("close", closed);
    socket.on("error", closed);
  }

  /** At least `count` bytes, or what came before the close or the deadline. */
  async take(count: number, timeoutMs: number): Promise<{ bytes: Buffer; complete: boolean; closed: boolean }> {
    const deadline = Date.now() + timeoutMs;
    while (this.#buffer.length < count && !this.#closed && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
    const complete = this.#buffer.length >= count;
    const bytes = this.#buffer.subarray(0, complete ? count : this.#buffer.length);
    this.#buffer = this.#buffer.subarray(bytes.length);
    return { bytes, complete, closed: this.#closed };
  }

  /** What is left after the handshake, handed back to the socket. */
  detach(): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("end");
    this.socket.removeAllListeners("close");
    this.socket.removeAllListeners("error");
    this.socket.on("error", () => undefined);
    this.socket.pause();
    if (this.#buffer.length > 0) this.socket.unshift(this.#buffer);
  }
}

/** What the first bytes of an answer that is not SOCKS5 say it is. */
function spokenOf(bytes: Buffer): "http" | "tls" | "unknown" {
  if (bytes.subarray(0, 5).toString("latin1") === "HTTP/") return "http";
  if (bytes.length >= 2 && (bytes[0] === 0x15 || bytes[0] === 0x16) && bytes[1] === 0x03) return "tls";
  return "unknown";
}

/** The second look at a port that did not answer as SOCKS5: one `CONNECT`
 *  line (no credentials) — an HTTP proxy answers it `HTTP/…`. */
async function probeHttp(ip: string, port: number, timeouts: ProxyCheckTimeouts, open: Set<Socket>): Promise<"http" | "tls" | "unknown"> {
  let socket: Socket | null = null;
  try {
    socket = await connectTo(ip, port, timeouts.connectMs, open);
    const reader = new Reader(socket);
    socket.write("CONNECT ipinfo.io:443 HTTP/1.1\r\nHost: ipinfo.io:443\r\n\r\n");
    const answer = await reader.take(5, timeouts.answerMs);
    return answer.bytes.length === 0 ? "unknown" : spokenOf(answer.bytes);
  } catch {
    return "unknown";
  } finally {
    socket?.destroy();
  }
}

/**
 * A SOCKS5 tunnel to `host:port` (a name: the proxy's DNS), with the login
 * the operator would use. The socket comes back paused, its handshake's
 * listeners gone.
 */
async function socksTunnel(ip: string, proxy: ProxyCheckProxy, host: string, port: number, timeouts: ProxyCheckTimeouts, open: Set<Socket>): Promise<Socket> {
  const socket = await connectTo(ip, proxy.port, timeouts.connectMs, open);
  const reader = new Reader(socket);
  try {
    // The operator's greeting: one method, the password login.
    socket.write(Buffer.from([5, 1, 2]));
    const greeting = await reader.take(2, timeouts.answerMs);
    if (!greeting.complete || greeting.bytes[0] !== 5) {
      if (greeting.bytes.length > 0) {
        const spoken = spokenOf(greeting.bytes);
        throw new CheckFailure("not_socks5", `the port answered ${spoken === "unknown" ? "something" : spoken.toUpperCase()}, not SOCKS5`, spoken);
      }
      throw new CheckFailure("not_socks5", greeting.closed ? "the port closed the connection without a SOCKS5 answer" : "the port took the connection but did not answer as SOCKS5", "unknown");
    }
    if (greeting.bytes[1] !== 2) {
      throw new CheckFailure("no_password_method", greeting.bytes[1] === 0 ? "the SOCKS5 server wants no login" : "the SOCKS5 server takes no login and password", "socks5");
    }
    if (proxy.username === null || proxy.password === null) throw new CheckFailure("needs_login", "the SOCKS5 server asks for a login and a password", "socks5");
    const user = Buffer.from(proxy.username, "utf8");
    const pass = Buffer.from(proxy.password, "utf8");
    if (user.length > 255 || pass.length > 255) throw new CheckFailure("wrong_login", "the login or the password is longer than SOCKS5 carries (255 bytes)", "socks5");
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const auth = await reader.take(2, timeouts.answerMs);
    if (!auth.complete) {
      throw new CheckFailure("wrong_login", auth.closed ? "the SOCKS5 server closed the connection after the login" : "the SOCKS5 server did not answer the login", "socks5");
    }
    if (auth.bytes[1] !== 0) throw new CheckFailure("wrong_login", "the SOCKS5 server refused the login or the password", "socks5");
    const name = Buffer.from(host, "utf8");
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port, 0);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]));
    const head = await reader.take(5, timeouts.requestMs);
    if (!head.complete || head.bytes[0] !== 5) throw new CheckFailure("tunnel_failed", head.complete ? "a malformed SOCKS5 reply" : `no SOCKS5 reply to the connect to ${host}`, "socks5");
    if (head.bytes[1] !== 0) throw new CheckFailure("tunnel_failed", `the proxy could not reach ${host}: ${REPLIES[head.bytes[1]!] ?? `reply ${head.bytes[1]}`}`, "socks5");
    const atyp = head.bytes[3];
    const addressLength = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + head.bytes[4]! : -1;
    if (addressLength < 0) throw new CheckFailure("tunnel_failed", "a malformed SOCKS5 reply", "socks5");
    const rest = await reader.take(addressLength + 2 - 1, timeouts.answerMs);
    if (!rest.complete) throw new CheckFailure("tunnel_failed", "a SOCKS5 reply cut short", "socks5");
    reader.detach();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function tlsWrap(socket: Socket, host: string): Duplex {
  return tlsConnect({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
}

/** One GET through the tunnel; the answer's JSON, or why not. */
function getJson(stream: Duplex, service: IpInfoService, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no answer in ${timeoutMs} ms`));
    }, timeoutMs);
    const req = httpRequest(
      {
        host: service.host,
        port: service.port,
        path: service.path,
        method: "GET",
        headers: { host: service.host, accept: "application/json", "user-agent": "proxy-check", connection: "close" },
        createConnection: () => stream as Socket,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 65_536) req.destroy(new Error("the answer is too long"));
        });
        res.on("end", () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? "?"}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("an answer that is not JSON"));
          }
        });
      },
    );
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

/**
 * Check a proxy as a page's browser would use it: SOCKS5, its login, a way
 * out — and where that way out is. Never throws for the proxy's own
 * failures: they are the answer.
 */
export async function checkProxy(proxy: ProxyCheckProxy, options: ProxyCheckOptions = {}): Promise<ProxyCheckResult> {
  const timeouts = { ...PROXY_CHECK_TIMEOUTS, ...options.timeouts };
  const services = options.services ?? IP_INFO_SERVICES;
  const wrap = options.wrap ?? tlsWrap;
  let socksEndpoint: string | null = null;
  let spoken: ProxyCheckResult["spoken"] = null;
  const open = new Set<Socket>();
  const run = async (): Promise<ProxyCheckResult> => {
    // An address only: no name is resolved here.
    const ip = proxy.ip;
    if (isIP(ip) !== 4) throw new CheckFailure("dns", "the proxy is not given as an IPv4 address");
    socksEndpoint = `${ip}:${proxy.port}`;
    const failures: string[] = [];
    let tunnelsOnly = true;
    for (const service of services) {
      let socket: Socket;
      const started = performance.now();
      try {
        socket = await socksTunnel(ip, proxy, service.host, service.port, timeouts, open);
      } catch (error) {
        if (error instanceof CheckFailure && error.code === "not_socks5" && error.spoken === "unknown") {
          // Silent or garbled: one more look, as an HTTP proxy.
          const second = await probeHttp(ip, proxy.port, timeouts, open);
          throw new CheckFailure("not_socks5", second === "unknown" ? error.detail : `the port speaks ${second.toUpperCase()}, not SOCKS5`, second);
        }
        // The way to this service only (a provider may block one host):
        // the next service is asked.
        if (error instanceof CheckFailure && error.code === "tunnel_failed") {
          spoken = "socks5";
          failures.push(error.detail);
          continue;
        }
        // The proxy itself failed: the next service would meet the same.
        throw error;
      }
      tunnelsOnly = false;
      spoken = "socks5";
      const stream = wrap(socket, service.host);
      socket.resume();
      try {
        const body = await getJson(stream, service, timeouts.requestMs);
        const exit = service.read(body);
        if (exit === null) {
          failures.push(`${service.name}: no address in its answer`);
          continue;
        }
        return { ok: true, problem: null, spoken, socksEndpoint, latencyMs: Math.round(performance.now() - started), exit, ipInfoService: service.name };
      } catch (error) {
        failures.push(`${service.name}: ${error instanceof Error ? error.message : "failed"}`);
      } finally {
        stream.destroy();
        socket.destroy();
      }
    }
    throw new CheckFailure(tunnelsOnly && failures.length > 0 ? "tunnel_failed" : "ip_info_failed", failures.join("; ") || "no IP-info service", "socks5");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckFailure("no_answer", `the check took longer than ${timeouts.totalMs} ms`)), timeouts.totalMs);
      }),
    ]);
  } catch (error) {
    const failure = error instanceof CheckFailure ? error : new CheckFailure("no_answer", "the check failed");
    return {
      ok: false,
      problem: { code: failure.code, detail: failure.detail },
      spoken: failure.spoken ?? spoken,
      socksEndpoint,
      latencyMs: null,
      exit: null,
      ipInfoService: null,
    };
  } finally {
    clearTimeout(timer);
    for (const socket of open) socket.destroy();
  }
}
