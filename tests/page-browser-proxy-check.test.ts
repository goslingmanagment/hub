import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { checkProxy, GEOJS, IP_INFO_SERVICES, IPINFO, type ProxyCheckProxy } from "../apps/runtime/src/services/egress/proxy-check.ts";
import { FakeSocks, SOCKS_PASSWORD, SOCKS_USER } from "./helpers/page-browser-fakes.ts";
import {
  fakeIpInfoService,
  GEOJS_BERLIN,
  httpProxyServing,
  IPINFO_BERLIN,
  localCheckOptions,
  rawServer,
} from "./helpers/proxy-check-fakes.ts";

// The owner's «Проверить прокси» for a page's server browser (Project
// Browser, owner decision 2026-10-15), against a local SOCKS5 test server:
// works or not and why (no answer, refused, a wrong login, not SOCKS5 — and
// then what the port speaks), the latency, and the exit as an IP-info
// service names it through the proxy — the fallback service when the first
// refuses. It reaches the IP-info services only: never a platform.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(ipinfoAnswer = () => ({ status: 200, body: IPINFO_BERLIN as unknown })) {
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const ipinfo = await fakeIpInfoService(ipinfoAnswer);
  cleanups.push(ipinfo.close);
  const geojs = await fakeIpInfoService(() => ({ status: 200, body: GEOJS_BERLIN }));
  cleanups.push(geojs.close);
  return { socks, ipinfo, geojs, options: localCheckOptions(socks, ipinfo, geojs) };
}

const at = (port: number, overrides: Partial<ProxyCheckProxy> = {}): ProxyCheckProxy => ({
  ip: "127.0.0.1", port, username: SOCKS_USER, password: SOCKS_PASSWORD, ...overrides,
});

describe("the proxy check (Project Browser: «Проверить прокси»)", () => {
  it("works: SOCKS5 spoken, the login taken, the exit and its place named by ipinfo.io through the proxy", async () => {
    const { socks, ipinfo, geojs, options } = await world();
    const result = await checkProxy(at(socks.port), options);
    expect(result).toMatchObject({
      ok: true,
      problem: null,
      spoken: "socks5",
      socksEndpoint: `127.0.0.1:${socks.port}`,
      ipInfoService: "ipinfo.io",
      exit: {
        ip: "203.0.113.7", countryCode: "DE", region: "Land Berlin", city: "Berlin",
        isp: "Example Mobile GmbH", asn: "AS64500", timeZone: "Europe/Berlin", latitude: 52.5244, longitude: 13.4105,
      },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // The operator's login, by name to the service; the fallback not asked.
    expect(socks.logins).toEqual([{ username: SOCKS_USER, password: SOCKS_PASSWORD, ok: true }]);
    expect(socks.connects).toEqual(["ipinfo.io:443"]);
    expect(ipinfo.requests).toEqual(["GET ipinfo.io/json"]);
    expect(geojs.requests).toEqual([]);
  });

  it("the first service refuses (429): the fallback, get.geojs.io, over a new tunnel — once", async () => {
    const { socks, geojs, options } = await world(() => ({ status: 429, body: { error: "rate limited" } }));
    const result = await checkProxy(at(socks.port), options);
    expect(result).toMatchObject({ ok: true, ipInfoService: "get.geojs.io", exit: { ip: "203.0.113.7", country: "Germany", countryCode: "DE", asn: "AS64500", isp: "Example Mobile GmbH" } });
    expect(socks.connects).toEqual(["ipinfo.io:443", "get.geojs.io:443"]);
    expect(geojs.requests).toEqual(["GET get.geojs.io/v1/ip/geo.json"]);
  });

  it("neither service answers: the tunnel works, the exit is not known — said so, no more tries", async () => {
    const { socks, options } = await world(() => ({ status: 503, body: {} }));
    socks.routes.delete("get.geojs.io:443");
    const result = await checkProxy(at(socks.port), options);
    expect(result).toMatchObject({ ok: false, spoken: "socks5", exit: null, problem: { code: "ip_info_failed" } });
    expect(result.problem!.detail).toContain("ipinfo.io: HTTP 503");
    expect(socks.connects).toEqual(["ipinfo.io:443", "get.geojs.io:443"]);
  });

  it("a wrong password: refused by the proxy, said as such, nothing more asked", async () => {
    const { socks, ipinfo, options } = await world();
    const result = await checkProxy(at(socks.port, { password: "wrong-password" }), options);
    expect(result).toMatchObject({ ok: false, spoken: "socks5", problem: { code: "wrong_login" }, exit: null });
    expect(socks.connects).toEqual([]);
    expect(ipinfo.requests).toEqual([]);
    // The answer never carries the password.
    expect(JSON.stringify(result)).not.toContain("wrong-password");
  });

  it("no login given, and the proxy asks for one", async () => {
    const { socks, options } = await world();
    expect(await checkProxy(at(socks.port, { username: null, password: null }), options)).toMatchObject({ ok: false, spoken: "socks5", problem: { code: "needs_login" } });
  });

  it("a SOCKS5 that takes no password login (the operator logs in with one only)", async () => {
    const { options } = await world();
    const open = await rawServer((socket) => socket.once("data", () => socket.end(Buffer.from([5, 0xff]))));
    cleanups.push(open.close);
    expect(await checkProxy(at(open.port), options)).toMatchObject({ ok: false, spoken: "socks5", problem: { code: "no_password_method" } });
  });

  it("not SOCKS5: an HTTP proxy that answers the greeting at once, and one that waits for a whole request — told apart from silence", async () => {
    const { options } = await world();
    const loud = await rawServer((socket) => socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")));
    cleanups.push(loud.close);
    expect(await checkProxy(at(loud.port), options)).toMatchObject({ ok: false, spoken: "http", problem: { code: "not_socks5" } });
    const patient = await rawServer(httpProxyServing);
    cleanups.push(patient.close);
    const http = await checkProxy(at(patient.port), options);
    expect(http).toMatchObject({ ok: false, spoken: "http", problem: { code: "not_socks5", detail: "the port speaks HTTP, not SOCKS5" } });
    const silent = await rawServer(() => undefined);
    cleanups.push(silent.close);
    expect(await checkProxy(at(silent.port), options)).toMatchObject({ ok: false, spoken: "unknown", problem: { code: "not_socks5" } });
    // A TLS port (an HTTPS proxy) answers a stranger with an alert.
    const tls = await rawServer((socket) => socket.once("data", () => socket.end(Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46]))));
    cleanups.push(tls.close);
    expect(await checkProxy(at(tls.port), options)).toMatchObject({ ok: false, spoken: "tls", problem: { code: "not_socks5" } });
  });

  it("refused, no answer in time: each in its own word, within its deadline", async () => {
    const { options } = await world();
    const closed = await rawServer(() => undefined);
    const port = closed.port;
    await closed.close();
    expect(await checkProxy(at(port), options)).toMatchObject({ ok: false, spoken: null, problem: { code: "refused" } });
    // 192.0.2.1 (TEST-NET-1) takes nothing: no answer — or no route.
    const started = Date.now();
    const black = await checkProxy(at(9, { ip: "192.0.2.1" }), { ...options, timeouts: { ...options.timeouts, connectMs: 300 } });
    expect(["no_answer", "unreachable"]).toContain(black.problem?.code);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the proxy could not reach either service: the SOCKS5 replies' reasons", async () => {
    const { socks, options } = await world();
    socks.routes.clear();
    const result = await checkProxy(at(socks.port), options);
    expect(result).toMatchObject({ ok: false, spoken: "socks5", problem: { code: "tunnel_failed" } });
    // Each service asked once.
    expect(result.problem!.detail).toBe("the proxy could not reach ipinfo.io: host unreachable; the proxy could not reach get.geojs.io: host unreachable");
    expect(socks.connects).toEqual(["ipinfo.io:443", "get.geojs.io:443"]);
  });

  it("takes an address only: nothing in the check resolves a name", async () => {
    const { options } = await world();
    expect(await checkProxy(at(1080, { ip: "proxy.example.test" }), options)).toMatchObject({ ok: false, problem: { code: "dns" }, spoken: null });
    const source = readFileSync(new URL("../apps/runtime/src/services/egress/proxy-check.ts", import.meta.url), "utf8");
    // The one DNS query is resolveProxyHost's, before the check.
    expect(source.match(/lookup\(/g)).toHaveLength(1);
  });

  it("asks the IP-info services only — never a platform — by HTTPS, in this order", () => {
    expect(IP_INFO_SERVICES).toEqual([IPINFO, GEOJS]);
    expect(IP_INFO_SERVICES.map((service) => `${service.host}:${service.port}${service.path}`)).toEqual(["ipinfo.io:443/json", "get.geojs.io:443/v1/ip/geo.json"]);
    const source = readFileSync(new URL("../apps/runtime/src/services/egress/proxy-check.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/fansly\.com|onlyfans\.com|onlyfansapi/i);
  });

  it("reads the services' answers: ipinfo.io's org into ASN and ISP, geojs's strings into numbers; no address — nothing", () => {
    expect(IPINFO.read({ ...IPINFO_BERLIN, org: "Example ISP" })).toMatchObject({ asn: null, isp: "Example ISP" });
    expect(IPINFO.read({ bogon: true, ip: "not-an-ip" })).toBeNull();
    expect(GEOJS.read(GEOJS_BERLIN)).toMatchObject({ latitude: 52.5244, longitude: 13.4105, asn: "AS64500" });
    expect(GEOJS.read({})).toBeNull();
  });
});
