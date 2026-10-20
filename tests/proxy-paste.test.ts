import { describe, expect, it } from "vitest";

import {
  formatPastedProxy,
  maskPastedProxy,
  pageBrowserProxyProblem,
  pastedProxyConfig,
  readPastedProxy,
  type PastedProxy,
  type PastedProxyRead,
} from "@agency_hub_core/shared";

// One proxy pasted the way providers hand them out (Project Browser, owner
// decision 2026-10-15): the forms Hub reads, the ones it refuses and why,
// the four-part forms told apart by which end holds a host and a port, and
// the ambiguous ones it asks about.

const proxy = (overrides: Partial<PastedProxy>): PastedProxy => ({
  scheme: "socks5",
  schemeGiven: false,
  host: "203.0.113.5",
  hostKind: "ipv4",
  port: 1080,
  username: "user",
  password: "pass",
  ...overrides,
});

const parsed = (read: PastedProxyRead) => {
  if (read.kind !== "parsed") throw new Error(`not parsed: ${JSON.stringify(read)}`);
  return read.proxy;
};

describe("readPastedProxy: the forms (a table)", () => {
  const table: Array<[string, Partial<PastedProxy>]> = [
    ["203.0.113.5:1080", { username: null, password: null }],
    ["203.0.113.5:1080:user:pass", {}],
    ["user:pass:203.0.113.5:1080", {}],
    ["user:pass@203.0.113.5:1080", {}],
    ["203.0.113.5:1080@user:pass", {}],
    ["socks5://user:pass@203.0.113.5:1080", { schemeGiven: true }],
    ["http://user:pass@203.0.113.5:8080", { scheme: "http", schemeGiven: true, port: 8080 }],
    // Names: a provider's gateway.
    ["gate.provider.example.com:7000:user-zone-de:s3cr3t", { host: "gate.provider.example.com", hostKind: "name", port: 7000, username: "user-zone-de", password: "s3cr3t" }],
    // IPv6 in brackets, in each form.
    ["[2001:db8::1]:1080:user:pass", { host: "2001:db8::1", hostKind: "ipv6" }],
    // Stray spaces and line breaks; a row copied from a table.
    ["  203.0.113.5:1080:user:pass \n", {}],
    // A password with a colon or an at sign.
    ["203.0.113.5:1080:user:pa:ss", { password: "pa:ss" }],
    ["user:p@ss@203.0.113.5:1080", { password: "p@ss" }],
    // URL-encoded credentials in the URL form only.
    ["socks5://us%40er:p%3Ass@203.0.113.5:1080", { schemeGiven: true, username: "us@er", password: "p:ss" }],
    ["us%40er:pass@203.0.113.5:1080", { username: "us%40er" }],
    // A login with no password: read, refused for a page's browser below.
    ["user@203.0.113.5:1080", { password: null }],
  ];
  for (const [text, expected] of table) {
    it(JSON.stringify(text), () => {
      expect(parsed(readPastedProxy(text))).toEqual(proxy(expected));
    });
  }
});

describe("readPastedProxy: refused, with the reason in the owner's words", () => {
  const table: Array<[string, RegExp]> = [
    ["203.0.113.5", /Нет порта/],
    ["203.0.113.5:99999", /не порт/],
    // A misplaced password is never echoed back.
    ["user:s3cret-word", /не читается/],
    ["203.0.113.5:1080:user", /Три части/],
    ["socks4://203.0.113.5:1080", /SOCKS4 не подходит/],
    ["ftp://203.0.113.5:21", /не знаком/],
    ["203.0.113.5:1080:user:pass\n198.51.100.7:1080:user:pass", /несколько строк/],
    ["2001:db8::1:1080", /квадратных скобках/],
    ["user:pass@2001:db8::1:1080", /квадратных скобках/],
    ["[2001:db8::1:1080", /скобка/],
    ["socks5://user:pass@203.0.113.5:1080/path", /лишнее/],
    ["us er:pass@203.0.113.5:1080", /Пробел внутри/],
    ["user:pass:host:port", /Не понять/],
    ["203.0.113.5::user:pass", /Пустая часть/],
    ["@203.0.113.5:1080", /нет логина/],
  ];
  for (const [text, reason] of table) {
    it(JSON.stringify(text), () => {
      const read = readPastedProxy(text);
      expect(read.kind).toBe("invalid");
      expect(read.kind === "invalid" ? read.reason : "").toMatch(reason);
    });
  }

  it("never echoes a part of the text in a reason (a misplaced one may be the password)", () => {
    for (const text of ["user:s3cret-word", "s3cret-word:1080", "user:s3cret-word@host:port", "a:b:c:s3cret-word", "x y:s3cret-word@1.2.3.4:5"]) {
      const read = readPastedProxy(text);
      expect(read.kind === "invalid" ? read.reason : "", text).not.toContain("s3cret");
    }
  });
});

describe("readPastedProxy: the four-part forms", () => {
  it("told apart by which end holds a host and a port; a bare word is a login", () => {
    expect(readPastedProxy("203.0.113.5:1080:user:pass")).toMatchObject({ kind: "parsed", order: "host_first" });
    expect(readPastedProxy("user:pass:203.0.113.5:1080")).toMatchObject({ kind: "parsed", order: "user_first" });
    // A login that reads as a name with no TLD is a login.
    expect(readPastedProxy("gate.example.com:1080:user123:4567")).toMatchObject({ kind: "parsed", order: "host_first", proxy: { host: "gate.example.com", username: "user123", password: "4567" } });
  });

  it("both ends a host and a port: ambiguous, both readings offered; the order given settles it", () => {
    const text = "gate.example.com:1080:john.doe:5555";
    const read = readPastedProxy(text);
    expect(read.kind).toBe("ambiguous");
    expect(read.kind === "ambiguous" ? read.options.map((option) => [option.order, option.proxy.host, option.proxy.port, option.proxy.username]) : []).toEqual([
      ["host_first", "gate.example.com", 1080, "john.doe"],
      ["user_first", "john.doe", 5555, "gate.example.com"],
    ]);
    expect(parsed(readPastedProxy(text, "host_first"))).toMatchObject({ host: "gate.example.com", port: 1080, username: "john.doe", password: "5555" });
    expect(parsed(readPastedProxy(text, "user_first"))).toMatchObject({ host: "john.doe", port: 5555, username: "gate.example.com", password: "1080" });
    // Two addresses: ambiguous too.
    expect(readPastedProxy("203.0.113.5:1080:198.51.100.7:2080").kind).toBe("ambiguous");
  });
});

describe("readPastedProxy: which number is the port — every reading from every form (Astra's review of PR #627, item 2, rounds 1 and 2)", () => {
  // [text, the readings it has: "host:port login password" each; one —
  // read; more — ambiguous, the owner asked]. Logins with @, e-mails split
  // by colons, numeric logins, numeric passwords.
  const table: Array<[string, string[]]> = [
    ["203.0.113.10:1080@alice:54321", ["203.0.113.10:1080 alice 54321"]],
    ["alice:54321@203.0.113.10:1080", ["203.0.113.10:1080 alice 54321"]],
    ["93.184.216.34:1080:alice@example.com:54321", ["example.com:54321 93.184.216.34 1080:alice", "93.184.216.34:1080 alice@example.com 54321"]],
    ["alice@example.com:54321:93.184.216.34:1080", ["93.184.216.34:1080 alice@example.com 54321"]],
    ["alice@example.com:54321@93.184.216.34:1080", ["93.184.216.34:1080 alice@example.com 54321"]],
    ["93.184.216.34:1080@alice@example.com:54321", ["93.184.216.34:1080 alice@example.com 54321", "example.com:54321 93.184.216.34 1080@alice"]],
    ["93.184.216.34:1080:12345:67890", ["93.184.216.34:1080 12345 67890"]],
    ["12345:67890:93.184.216.34:1080", ["93.184.216.34:1080 12345 67890"]],
    ["12345:67890@93.184.216.34:1080", ["93.184.216.34:1080 12345 67890"]],
    ["93.184.216.34:1080@12345:67890", ["93.184.216.34:1080 12345 67890"]],
    ["gate.example.com:1080:john.doe:5555", ["gate.example.com:1080 john.doe 5555", "john.doe:5555 gate.example.com 1080"]],
    ["john.doe:5555@gate.example.com:1080", ["gate.example.com:1080 john.doe 5555", "john.doe:5555 gate.example.com 1080"]],
    ["198.51.100.7:2080@203.0.113.10:1080", ["203.0.113.10:1080 198.51.100.7 2080", "198.51.100.7:2080 203.0.113.10 1080"]],
    ["gate.example.com:1080:user123:4567", ["gate.example.com:1080 user123 4567"]],
    ["socks5://93.184.216.34:1080:alice@example.com:54321", ["example.com:54321 93.184.216.34 1080:alice", "93.184.216.34:1080 alice@example.com 54321"]],
  ];
  const line = (proxy: PastedProxy) => `${proxy.host}:${proxy.port} ${proxy.username} ${proxy.password}`;
  for (const [text, expected] of table) {
    it(JSON.stringify(text), () => {
      const read = readPastedProxy(text);
      const readings = read.kind === "parsed" ? [line(read.proxy)] : read.kind === "ambiguous" ? read.options.map((option) => line(option.proxy)) : [];
      expect(new Set(readings)).toEqual(new Set(expected));
      expect(read.kind).toBe(expected.length === 1 ? "parsed" : "ambiguous");
      // A reading's port is never a part another reading takes as its password.
      if (read.kind === "parsed") expect(JSON.stringify(maskPastedProxy(read.proxy))).not.toContain(String(read.proxy.password));
    });
  }

  it("the owner's choice picks exactly one reading, in every form; a choice the text has not is no choice", () => {
    const at = "93.184.216.34:1080:alice@example.com:54321";
    expect(parsed(readPastedProxy(at, "host_first"))).toMatchObject({ host: "93.184.216.34", port: 1080, username: "alice@example.com", password: "54321" });
    expect(parsed(readPastedProxy(at, "login_at_host"))).toMatchObject({ host: "example.com", port: 54321 });
    expect(readPastedProxy(at, "user_first").kind).toBe("ambiguous");
    expect(parsed(readPastedProxy("gate.example.com:1080:john.doe:5555", "user_first"))).toMatchObject({ host: "john.doe", port: 5555, password: "1080" });
    expect(parsed(readPastedProxy("john.doe:5555@gate.example.com:1080", "login_at_host"))).toMatchObject({ host: "gate.example.com", port: 1080, password: "5555" });
    expect(parsed(readPastedProxy("john.doe:5555@gate.example.com:1080", "host_at_login"))).toMatchObject({ host: "john.doe", port: 5555 });
  });
});

describe("a page's browser and the proxy read", () => {
  it("SOCKS5 with a login and a password, on IPv4 or a name: usable", () => {
    expect(pageBrowserProxyProblem(parsed(readPastedProxy("203.0.113.5:1080:user:pass")))).toBeNull();
    expect(pageBrowserProxyProblem(parsed(readPastedProxy("socks5h://user:pass@gate.example.com:1080")))).toBeNull();
  });

  it("HTTP, IPv6, no login or password, an overlong one: refused, with why", () => {
    expect(pageBrowserProxyProblem(parsed(readPastedProxy("http://user:pass@203.0.113.5:8080")))).toMatch(/HTTP-прокси.*SOCKS5/);
    expect(pageBrowserProxyProblem(parsed(readPastedProxy("[2001:db8::1]:1080:user:pass")))).toMatch(/IPv6/);
    expect(pageBrowserProxyProblem(parsed(readPastedProxy("203.0.113.5:1080")))).toMatch(/логин и пароль/);
    expect(pageBrowserProxyProblem(parsed(readPastedProxy("user@203.0.113.5:1080")))).toMatch(/логин и пароль/);
    expect(pageBrowserProxyProblem(proxy({ password: "x".repeat(256) }))).toMatch(/255 байт/);
  });

  it("stored as Hub stores a proxy: the URL without credentials (socks5h as socks5), IPv6 in brackets", () => {
    expect(pastedProxyConfig(parsed(readPastedProxy("socks5h://user:pass@Gate.Example.com:1080")))).toEqual({ url: "socks5://gate.example.com:1080", username: "user", password: "pass" });
    expect(pastedProxyConfig(parsed(readPastedProxy("[2001:db8::1]:1080:user:pass"))).url).toBe("socks5://[2001:db8::1]:1080");
  });

  it("masked: no password; written again as a URL with its credentials encoded", () => {
    const read = parsed(readPastedProxy("203.0.113.5:8080:us@er:p:ss"));
    expect(maskPastedProxy(read)).toEqual({ scheme: "socks5", host: "203.0.113.5", port: 8080, username: "us@er", passwordSet: true });
    expect(JSON.stringify(maskPastedProxy(read))).not.toContain("p:ss");
    const http = parsed(readPastedProxy("http://user:p%40ss@203.0.113.5:8080"));
    const asSocks = formatPastedProxy(http, "socks5");
    expect(asSocks).toBe("socks5://user:p%40ss@203.0.113.5:8080");
    expect(parsed(readPastedProxy(asSocks))).toMatchObject({ scheme: "socks5", password: "p@ss" });
  });
});
