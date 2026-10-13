import { createServer, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { checkExitIp, ExitIpError } from "../apps/page-browser/src/egress/exit-ip.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { Egress, localOrPrivate, type TunnelRecord } from "../apps/page-browser/src/egress/proxy.ts";
import { SocksError, socksConnect, type SocksConfig } from "../apps/page-browser/src/egress/socks5.ts";
import { monoMs } from "../apps/page-browser/src/shared/util.ts";
import { echoServer, fakeIpify, FakeSocks, proxyConnect, quiet, SOCKS_PASSWORD, SOCKS_USER, until } from "./helpers/page-browser-fakes.ts";

// The operator's local proxy (Project Browser plan §4.5; stage 3, PR 4):
// Chrome's only way out, through the page's SOCKS5 with its password. It
// refuses everything while the exit is closed, local and private addresses
// always, and hosts it does not know; to the API host only the request of an
// open gate window goes.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp() {
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const records: TunnelRecord[] = [];
  const socksFailures: string[] = [];
  const egress = new Egress({
    classify: classifyFanslyHost,
    onRecord: (record) => records.push(record),
    onSocksFailure: (kind) => socksFailures.push(kind),
    socksTimeoutMs: 2000,
    log: quiet,
  });
  const port = await egress.listen(0);
  cleanups.push(() => egress.close());
  const config: SocksConfig = { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD };
  return { egress, port, socks, records, socksFailures, config };
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

  it("serves no plain HTTP", async () => {
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

  it("refuses local and private addresses, unknown hosts and the socket host", async () => {
    const { egress, port, records, config } = await setUp();
    egress.setSocks(config);
    egress.openExit();
    const targets = ["127.0.0.1:443", "localhost:443", "10.1.2.3:443", "192.168.0.10:443", "169.254.169.254:80", "[::1]:443", "intranet:443", "example.com:443", "chatws.fansly.com:443", "wsv3.fansly.com:443"];
    for (const target of targets) {
      const { status, socket } = await proxyConnect(port, target);
      socket.destroy();
      expect(status, target).toBe(403);
    }
    await until(() => records.length === targets.length);
    expect(records.map((record) => record.result)).toEqual([
      ...Array(7).fill("refused: local or private address"),
      "refused: host not allowed",
      "refused: host not allowed",
      // No admitting path given to this proxy: a socket is never let through
      // without one (PR 10, ws/sockets.ts).
      "refused: socket not admitted (no admitting path)",
    ]);
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

  it("answers a failed SOCKS5 login with 502 and reports it", async () => {
    const { egress, port, socks, records, socksFailures, config } = await setUp();
    socks.routes.set("fansly.com:443", 9);
    egress.setSocks({ ...config, password: "a wrong one" });
    egress.openExit();
    const { status, socket } = await proxyConnect(port, "fansly.com:443");
    socket.destroy();
    expect(status).toBe(502);
    await until(() => records.length === 1);
    expect(socksFailures).toEqual(["auth"]);
    expect(records[0]?.result).toMatch(/^failed: /);
  });

  it("reports a SOCKS5 that is not there", async () => {
    const { egress, port, socksFailures, config } = await setUp();
    egress.setSocks({ ...config, port: 1 });
    egress.openExit();
    const { status, socket } = await proxyConnect(port, "fansly.com:443");
    socket.destroy();
    expect(status).toBe(502);
    await until(() => socksFailures.length === 1);
    expect(socksFailures).toEqual(["unavailable"]);
  });
});

describe("the gate at the proxy", () => {
  /** A server that answers a TLS 1.3 ServerHello and keeps what it gets. */
  async function tlsLikeServer(): Promise<{ port: number; received: () => Buffer; close: () => Promise<void> }> {
    const chunks: Buffer[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => chunks.push(chunk));
      const body = Buffer.concat([Buffer.from([0x03, 0x03]), Buffer.alloc(32, 7), Buffer.from([0]), Buffer.from([0x13, 0x01, 0x00, 0x00, 0x06, 0x00, 0x2b, 0x00, 0x02, 0x03, 0x04])]);
      const handshake = Buffer.concat([Buffer.from([0x02, 0, 0, body.length]), body]);
      socket.write(Buffer.concat([Buffer.from([0x16, 0x03, 0x03, 0, handshake.length]), handshake]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    return {
      port: typeof address === "object" && address ? address.port : 0,
      received: () => Buffer.concat(chunks),
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
  }

  const tlsRecord = (type: number, size: number) => Buffer.concat([Buffer.from([type, 0x03, 0x03, (size - 5) >> 8, (size - 5) & 0xff]), Buffer.alloc(size - 5, 0xab)]);

  it("carries the admitted request's records and holds a repeat; the next window cuts the held tunnel", async () => {
    const { egress, port, socks, records, config } = await setUp();
    const server = await tlsLikeServer();
    cleanups.push(server.close);
    socks.routes.set("apiv3.fansly.com:443", server.port);
    egress.setSocks(config);
    egress.openExit();
    expect(egress.gate.open("w1", monoMs() + 15_000, 0)).toEqual({ ok: true });
    const { status, socket } = await proxyConnect(port, "apiv3.fansly.com:443");
    expect(status).toBe(200);
    await readSome(socket); // the ServerHello
    const clientHello = tlsRecord(22, 300);
    const finished = tlsRecord(23, 58);
    const preface = tlsRecord(23, 70);
    const headers = tlsRecord(23, 90);
    const ping = tlsRecord(23, 39);
    const repeat = tlsRecord(23, 90);
    socket.write(Buffer.concat([clientHello, finished, preface, headers]));
    const sent = clientHello.length + finished.length + preface.length + headers.length;
    await until(() => server.received().length === sent, 3000, "the request's records upstream");
    expect(egress.gate.state.phase).toBe("holding");
    // A control record still goes; a repeat — and all after it — is held.
    socket.write(Buffer.concat([ping, repeat, ping]));
    await until(() => server.received().length === sent + ping.length, 3000, "the control record");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.received().length).toBe(sent + ping.length);
    // A second tunnel to the API is refused while the window holds.
    const second = await proxyConnect(port, "apiv3.fansly.com:443");
    second.socket.destroy();
    expect(second.status).toBe(403);
    // The next window: what the tunnel holds was never admitted — cut, not flushed.
    const closed = new Promise((resolve) => socket.once("close", resolve));
    egress.gate.close("w1");
    egress.gate.open("w2", monoMs() + 15_000, 0);
    await closed;
    expect(server.received().length).toBe(sent + ping.length);
    await until(() => records.some((record) => record.result === "gate: bytes held from before this window"));
    const cut = records.find((record) => record.result === "gate: bytes held from before this window")!;
    expect(cut.held).toBe(repeat.length + ping.length);
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
  it("knows the spec's hosts and nothing else", () => {
    expect(classifyFanslyHost("fansly.com")).toBe("site");
    expect(classifyFanslyHost("apiv3.fansly.com")).toBe("api");
    expect(classifyFanslyHost("APIV3.fansly.com")).toBe("api");
    expect(classifyFanslyHost("wsv3.fansly.com")).toBe("ws");
    expect(classifyFanslyHost("cdn3.fansly.com")).toBe("cdn");
    expect(classifyFanslyHost("cdn.fansly.com")).toBe("cdn");
    for (const host of ["www.fansly.com", "chatws.fansly.com", "mediav2.fansly.com", "evil-apiv3.fansly.com", "apiv3.fansly.com.evil.net", "cdn3.fansly.com.evil.net", "update.googleapis.com"]) {
      expect(classifyFanslyHost(host), host).toBe("denied");
    }
  });

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
    expect(localOrPrivate("203.0.113.7", 443)).toBe(false);
    expect(localOrPrivate("2001:db8::1", 443)).toBe(false);
  });
});
