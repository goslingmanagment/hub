import { afterEach, describe, expect, it } from "vitest";

import { readPastedProxy, type PastedProxy } from "@agency_hub_core/shared";

import { resolveProxyHost } from "../apps/runtime/src/services/egress/proxy-check.ts";
import { ProxyCheckLedger } from "../apps/runtime/src/services/page-browser-proxy-checks.ts";
import { checkPageBrowserProxy, endpointOfCheck } from "../apps/runtime/src/services/page-browser-proxy-entry.ts";
import { FakeSocks, SOCKS_PASSWORD, SOCKS_USER } from "./helpers/page-browser-fakes.ts";
import { fakeIpInfoService, GEOJS_BERLIN, IPINFO_BERLIN, localCheckOptions } from "./helpers/proxy-check-fakes.ts";

// The owner's proxy is reached at the address Hub judged, and nowhere else
// (Astra's review of PR #627, item 1): a name is resolved once, every
// address it resolves to must be public, and the check connects to that
// very address — a second DNS answer (DNS rebinding) cannot point it at
// Hub's own networks, loopback or the metadata service.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const named = (port: number): PastedProxy => {
  const read = readPastedProxy(`gate.provider.example:${port}:${SOCKS_USER}:${SOCKS_PASSWORD}`);
  if (read.kind !== "parsed") throw new Error("not parsed");
  return read.proxy;
};

describe("the proxy's host: resolved once, every address judged (Astra's review of PR #627, item 1)", () => {
  it("every address of the answer must be public, IPv4 and IPv6 alike", async () => {
    const resolveTo = (addresses: string[]) => ({ resolve: async () => addresses });
    expect(await resolveProxyHost("gate.provider.example", "name", resolveTo(["93.184.216.34"]))).toEqual({ ip: "93.184.216.34" });
    for (const addresses of [
      ["93.184.216.34", "127.0.0.1"],
      ["10.230.0.3"],
      ["93.184.216.34", "172.17.0.1"],
      ["169.254.169.254"],
      ["::1", "93.184.216.34"],
      ["93.184.216.34", "::ffff:10.230.1.10"],
    ]) {
      expect(await resolveProxyHost("gate.provider.example", "name", resolveTo(addresses)), addresses.join(" ")).toMatchObject({ problem: "private_address" });
    }
    expect(await resolveProxyHost("gate.provider.example", "name", resolveTo(["2a00:1450:4001:82a::200e"]))).toMatchObject({ problem: "ipv6" });
    expect(await resolveProxyHost("gate.provider.example", "name", { resolve: async () => { throw new Error("ENOTFOUND"); } })).toMatchObject({ problem: "dns" });
    expect(await resolveProxyHost("127.0.0.1", "ipv4")).toMatchObject({ problem: "private_address" });
    expect(await resolveProxyHost("10.230.0.2", "ipv4")).toMatchObject({ problem: "private_address", detail: expect.stringContaining("Docker") });
    expect(await resolveProxyHost("2001:db8::1", "ipv6")).toMatchObject({ problem: "ipv6" });
  });

  it("DNS rebinding: the check connects to the address it judged — a later answer pointing inside is never asked for, never dialled", async () => {
    const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
    await socks.start();
    cleanups.push(() => socks.stop());
    const ipinfo = await fakeIpInfoService(() => ({ status: 200, body: IPINFO_BERLIN }));
    cleanups.push(ipinfo.close);
    const geojs = await fakeIpInfoService(() => ({ status: 200, body: GEOJS_BERLIN }));
    cleanups.push(geojs.close);
    const options = localCheckOptions(socks, ipinfo, geojs);
    // The first answer is the "public" one (this machine's loopback stands
    // for it); every later answer points at Hub's own network.
    const answers: string[][] = [];
    const resolve = async () => {
      const answer = answers.length === 0 ? ["127.0.0.1"] : ["10.230.0.3"];
      answers.push(answer);
      return answer;
    };
    const allowAddresses = (ip: string) => ip === "127.0.0.1";
    const result = await checkPageBrowserProxy(named(socks.port), new ProxyCheckLedger(), { options, resolve, allowAddresses });
    expect(result).toMatchObject({ ok: true, socksEndpoint: `127.0.0.1:${socks.port}`, exit: { ip: "203.0.113.7" } });
    expect(answers).toEqual([["127.0.0.1"]]);
    expect(socks.logins).toEqual([{ username: SOCKS_USER, password: SOCKS_PASSWORD, ok: true }]);

    // An answer with one inside address among public ones: refused before any connection.
    const mixed = await checkPageBrowserProxy(named(socks.port), new ProxyCheckLedger(), { options, resolve: async () => ["127.0.0.1", "10.230.0.3"], allowAddresses });
    expect(mixed).toMatchObject({ ok: false, problem: { code: "private_address" }, spoken: null, socksEndpoint: null });
    expect(socks.logins).toHaveLength(1);
  });

  it("a save takes the address its check connected to — of that very proxy, while fresh — and resolves nothing (Astra's review of PR #627, round 2)", async () => {
    const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
    await socks.start();
    cleanups.push(() => socks.stop());
    const ipinfo = await fakeIpInfoService(() => ({ status: 200, body: IPINFO_BERLIN }));
    cleanups.push(ipinfo.close);
    const geojs = await fakeIpInfoService(() => ({ status: 200, body: GEOJS_BERLIN }));
    cleanups.push(geojs.close);
    let clock = 1_000_000;
    const ledger = new ProxyCheckLedger({ now: () => clock });
    const allowAddresses = (ip: string) => ip === "127.0.0.1" || ip === "93.184.216.34";
    // The check connects to the first answer; DNS then names another public address.
    let answer = ["127.0.0.1"];
    let asked = 0;
    const overrides = { options: localCheckOptions(socks, ipinfo, geojs), resolve: async () => { asked += 1; return answer; }, allowAddresses };
    const proxy = named(socks.port);
    const checked = await checkPageBrowserProxy(proxy, ledger, overrides);
    expect(checked).toMatchObject({ ok: true, socksEndpoint: `127.0.0.1:${socks.port}`, checkId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    answer = ["93.184.216.34"];
    expect(endpointOfCheck(ledger, checked.checkId!, proxy, overrides)).toBe(`127.0.0.1:${socks.port}`);
    expect(asked).toBe(1);
    // Another proxy (another password), an unknown check, a stale one: refused.
    expect(() => endpointOfCheck(ledger, checked.checkId!, { ...proxy, password: "other" }, overrides)).toThrow(expect.objectContaining({ reason: "check_other_proxy" }));
    expect(() => endpointOfCheck(ledger, "00000000-0000-4000-8000-000000000000", proxy, overrides)).toThrow(expect.objectContaining({ reason: "check_missing" }));
    clock += 11 * 60_000;
    expect(() => endpointOfCheck(ledger, checked.checkId!, proxy, overrides)).toThrow(expect.objectContaining({ reason: "check_stale" }));
    // A check that did not log in through the proxy gives no id.
    clock = 1_000_000;
    expect(await checkPageBrowserProxy({ ...proxy, password: "wrong" }, ledger, { ...overrides, resolve: async () => ["127.0.0.1"] })).toMatchObject({ ok: false, checkId: null });
  });
});
