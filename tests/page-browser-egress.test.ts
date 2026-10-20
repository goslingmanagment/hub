import { type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { checkExitIp, ExitIpError } from "../apps/page-browser/src/egress/exit-ip.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { Egress, localOrPrivate, type EgressOptions, type TunnelRecord, type TunnelSocksFailure } from "../apps/page-browser/src/egress/proxy.ts";
import { SocksError, socksConnect, type SocksConfig } from "../apps/page-browser/src/egress/socks5.ts";
import { echoServer, fakeIpify, FakeSocks, proxyConnect, quiet, SOCKS_PASSWORD, SOCKS_USER, until } from "./helpers/page-browser-fakes.ts";

// The operator's local proxy (Project Browser plan §4.5; stage 3, PR 4):
// Chrome's only way out, through the page's SOCKS5 with its password. It
// refuses everything while the exit is closed, local and private addresses
// always, and the hosts the map of operations closes; every other host the
// site loads goes through, third-party ones too (owner decision №2; PR 6);
// to the API host only the request of an open gate window goes.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp(options: Pick<EgressOptions, "openSocket"> = {}) {
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const records: TunnelRecord[] = [];
  const socksFailures: string[] = [];
  const failures: TunnelSocksFailure[] = [];
  const egress = new Egress({
    classify: classifyFanslyHost,
    onRecord: (record) => records.push(record),
    onSocksFailure: (failure) => {
      failures.push(failure);
      socksFailures.push(failure.kind);
    },
    socksTimeoutMs: 2000,
    log: quiet,
    ...options,
  });
  const port = await egress.listen(0);
  cleanups.push(() => egress.close());
  const config: SocksConfig = { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD };
  return { egress, port, socks, records, socksFailures, failures, config };
}

function readSome(socket: Socket): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once("data", resolve);
    socket.resume();
  });
}

describe("the closed exit", () => {
  it("refuses every CONNECT and journals the refusal", async () => {
    const { egress, port, records, config } = await setUp();
    egress.setSocks(config);
    const { status, socket } = await proxyConnect(port, "apiv3.fansly.com:443");
    socket.destroy();
    expect(status).toBe(403);
    await until(() => records.length === 1);
    expect(records[0]).toMatchObject({ host: "apiv3.fansly.com", port: 443, cls: "api", refused: true, result: "refused: exit closed" });
    expect(egress.refusalsSince("apiv3.fansly.com", 443, 0)).toHaveLength(1);
  });

  it("cannot open without the page's SOCKS5", async () => {
    const { egress } = await setUp();
    expect(() => egress.openExit()).toThrow(/no SOCKS5/);
    expect(egress.exitOpen).toBe(false);
  });

  it("serves no plain HTTP of its own (the rules extension's package: tests/page-browser-extension.test.ts)", async () => {
    const { port } = await setUp();
    const response = await fetch(`http://127.0.0.1:${port}/pb-extension/update.xml`);
    expect(response.status).toBe(403);
  });
});

describe("the open exit", () => {
  it("tunnels a site host through the SOCKS5 with its password; closing the exit cuts the tunnel", async () => {
    const { egress, port, socks, records, config } = await setUp();
    const echo = await echoServer();
    cleanups.push(echo.close);
    socks.routes.set("fansly.com:443", echo.port);
    egress.setSocks(config);
    egress.openExit();
    const { status, socket } = await proxyConnect(port, "fansly.com:443");
    expect(status).toBe(200);
    expect(socks.logins).toEqual([{ username: SOCKS_USER, password: SOCKS_PASSWORD, ok: true }]);
    expect(socks.connects).toEqual(["fansly.com:443"]);
    socket.write("hello through the tunnel");
    expect((await readSome(socket)).toString()).toBe("hello through the tunnel");
    const closed = new Promise((resolve) => socket.once("close", resolve));
    expect(egress.closeExit("a test")).toBe(1);
    await closed;
    await until(() => records.length === 1);
    expect(records[0]).toMatchObject({ host: "fansly.com", cls: "site", refused: false, up: 24, down: 24, result: "cut: exit closed (a test)" });
  });

  it("refuses local and private addresses, special-use names, the hosts the map closes and the socket host", async () => {
    const { egress, port, socks, records, config } = await setUp();
    egress.setSocks(config);
    egress.openExit();
    const targets = ["127.0.0.1:443", "localhost:443", "10.1.2.3:443", "192.168.0.10:443", "169.254.169.254:80", "[::1]:443", "intranet:443", "apiv3.fansly.com.pb-hold.invalid:443", "stand.test:443", "chatws.fansly.com:443", "mediav2.fansly.com:443", "wsv3.fansly.com:443"];
    for (const target of targets) {
      const { status, socket } = await proxyConnect(port, target);
      socket.destroy();
      expect(status, target).toBe(403);
    }
    await until(() => records.length === targets.length);
    expect(records.map((record) => record.result)).toEqual([
      ...Array(7).fill("refused: local or private address"),
      // The placeholder of Hub's requests exists nowhere: a request Chrome let
      // go of without the operator ends here (hub-requests/page.ts).
      "refused: special-use name",
      "refused: special-use name",
      "refused: host closed by the map",
      "refused: host closed by the map",
      // No admitting path given to this proxy: a socket is never let through
      // without one (PR 10, ws/sockets.ts).
      "refused: socket (no socket path)",
    ]);
    expect(records.map((record) => record.cls)).toEqual([...Array(9).fill("denied"), "closed", "closed", "ws"]);
    expect(records.every((record) => record.refused)).toBe(true);
    // Nothing of them reached the page's SOCKS5.
    expect(socks.connects).toEqual([]);
  });

  it("lets a host that is not Fansly's through the page's SOCKS5, journaled (owner decision №2)", async () => {
    const { egress, port, socks, records, config } = await setUp();
    const echo = await echoServer();
    cleanups.push(echo.close);
    for (const host of ["www.googletagmanager.com", "widget.intercom.io", "update.googleapis.com", "leaderboard.fansly.com"]) socks.routes.set(`${host}:443`, echo.port);
    egress.setSocks(config);
    egress.openExit();
    for (const host of ["www.googletagmanager.com", "widget.intercom.io", "update.googleapis.com", "leaderboard.fansly.com"]) {
      const { status, socket } = await proxyConnect(port, `${host}:443`);
      cleanups.push(() => void socket.destroy());
      expect(status, host).toBe(200);
      socket.write("ping");
      expect((await readSome(socket)).toString()).toBe("ping");
    }
    // The name goes to the SOCKS5 as it is; closing the exit cuts them like
    // any tunnel, and each is one line of the journal.
    expect(socks.connects).toEqual(["www.googletagmanager.com:443", "widget.intercom.io:443", "update.googleapis.com:443", "leaderboard.fansly.com:443"]);
    expect(egress.closeExit("a test")).toBe(4);
    await until(() => records.length === 4);
    expect(records.map((record) => [record.host, record.cls, record.refused, record.up, record.down, record.result])).toEqual([
      ["www.googletagmanager.com", "third_party", false, 4, 4, "cut: exit closed (a test)"],
      ["widget.intercom.io", "third_party", false, 4, 4, "cut: exit closed (a test)"],
      ["update.googleapis.com", "third_party", false, 4, 4, "cut: exit closed (a test)"],
      ["leaderboard.fansly.com", "site", false, 4, 4, "cut: exit closed (a test)"],
    ]);
    // With the exit closed they are refused like everything else.
    const { status, socket } = await proxyConnect(port, "www.googletagmanager.com:443");
    socket.destroy();
    expect(status).toBe(403);
  });

  it("refuses a new tunnel to the API host without a window of the gate", async () => {
    const { egress, port, records, config } = await setUp();
    egress.setSocks(config);
    egress.openExit();
    const { status, socket } = await proxyConnect(port, "apiv3.fansly.com:443");
    socket.destroy();
    expect(status).toBe(403);
    await until(() => records.length === 1);
    expect(records[0]?.result).toBe("refused: gate closed");
  });
});

describe("the page's SOCKS5", () => {
  it("logs in with the page's login and password and connects by name", async () => {
    const { socks, config } = await setUp();
    const echo = await echoServer();
    cleanups.push(echo.close);
    socks.routes.set("api.ipify.org:443", echo.port);
    const socket = await socksConnect(config, "api.ipify.org", 443);
    socket.resume();
    socket.write("ping");
    expect((await readSome(socket)).toString()).toBe("ping");
    socket.destroy();
    expect(socks.logins).toEqual([{ username: SOCKS_USER, password: SOCKS_PASSWORD, ok: true }]);
    expect(socks.connects).toEqual(["api.ipify.org:443"]);
  });

  it("tells a refused login from an unreachable SOCKS5 and an unreachable destination, without the password in the error", async () => {
    const { socks, config } = await setUp();
    const auth = await socksConnect({ ...config, password: "nope" }, "fansly.com", 443).catch((error: unknown) => error);
    expect(auth).toBeInstanceOf(SocksError);
    expect((auth as SocksError).kind).toBe("auth");
    const down = await socksConnect({ ...config, port: 1 }, "fansly.com", 443).catch((error: unknown) => error);
    expect((down as SocksError).kind).toBe("unavailable");
    const refused = await socksConnect(config, "nowhere.example", 443).catch((error: unknown) => error);
    expect((refused as SocksError).kind).toBe("refused");
    // The step it failed at, and the server's reply to the CONNECT.
    expect([auth, down, refused].map((error) => [(error as SocksError).step, (error as SocksError).rep])).toEqual([["auth", null], ["greeting", null], ["connect", 4]]);
    socks.answers.set("dropped.example:443", "drop");
    const dropped = await socksConnect(config, "dropped.example", 443).catch((error: unknown) => error);
    expect([(dropped as SocksError).kind, (dropped as SocksError).step, (dropped as SocksError).rep]).toEqual(["unavailable", "connect", null]);
    for (const error of [auth, down, refused]) expect(String((error as Error).message)).not.toContain(SOCKS_PASSWORD);
    expect(socks.logins.filter((login) => !login.ok)).toHaveLength(1);
  });
});

describe("the exit IP", () => {
  const plain = { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket };

  it("is what the IP service answers through the SOCKS5", async () => {
    const { socks, config } = await setUp();
    const ipify = await fakeIpify(() => "203.0.113.7\n");
    cleanups.push(ipify.close);
    socks.routes.set("api.ipify.org:443", ipify.port);
    expect(await checkExitIp(config, plain, 3000)).toBe("203.0.113.7");
  });

  it("fails on a refused login, and on an answer that is not an address", async () => {
    const { socks, config } = await setUp();
    const ipify = await fakeIpify(() => "<html>blocked</html>");
    cleanups.push(ipify.close);
    socks.routes.set("api.ipify.org:443", ipify.port);
    await expect(checkExitIp(config, plain, 3000)).rejects.toBeInstanceOf(ExitIpError);
    const auth = await checkExitIp({ ...config, password: "nope" }, plain, 3000).catch((error: unknown) => error);
    expect((auth as SocksError).kind).toBe("auth");
  });
});

describe("hosts", () => {
  it("refuses local and private destinations and invalid ports", () => {
    for (const [host, port] of [
      ["127.0.0.1", 443],
      ["10.0.0.1", 443],
      ["172.16.5.4", 443],
      ["100.64.0.1", 443],
      ["169.254.169.254", 80],
      ["224.0.0.1", 443],
      ["::1", 443],
      ["fd00::1", 443],
      ["fe80::1", 443],
      ["::ffff:127.0.0.1", 443],
      ["localhost", 443],
      ["db.internal", 443],
      ["fansly.com", 0],
      ["fansly.com", 70000],
    ] as const) {
      expect(localOrPrivate(host, port), `${host}:${port}`).toBe(true);
    }
    expect(localOrPrivate("fansly.com", 443)).toBe(false);
    expect(localOrPrivate("1.1.1.1", 443)).toBe(false);
    expect(localOrPrivate("2606:4700:4700::1111", 443)).toBe(false);
    // Special-use literals (IANA's registry): documentation, benchmarking,
    // IETF assignments, discard-only.
    for (const host of ["192.0.0.8", "192.0.2.10", "198.18.0.1", "198.19.1.1", "198.51.100.9", "203.0.113.7", "2001:db8::1", "100::1"]) expect(localOrPrivate(host, 443), host).toBe(true);
  });
});
