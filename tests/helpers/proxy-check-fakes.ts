import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";

import type { FakeSocks } from "./page-browser-fakes.ts";
import type { ProxyCheckOptions } from "../../apps/runtime/src/services/egress/proxy-check.ts";

// The proxy check's world on this machine (Project Browser, the owner's
// «Проверить прокси»): the IP-info services as local plain-HTTP servers a
// local SOCKS5 (FakeSocks) routes their names to, and ports that speak
// something else — an HTTP proxy, a silent one.

/** What ipinfo.io answers for an exit in Berlin. */
export const IPINFO_BERLIN = {
  ip: "203.0.113.7",
  hostname: "exit.example.net",
  city: "Berlin",
  region: "Land Berlin",
  country: "DE",
  loc: "52.5244,13.4105",
  org: "AS64500 Example Mobile GmbH",
  postal: "10178",
  timezone: "Europe/Berlin",
};

/** What get.geojs.io answers for the same exit. */
export const GEOJS_BERLIN = {
  ip: "203.0.113.7",
  country: "Germany",
  country_code: "DE",
  region: "Land Berlin",
  city: "Berlin",
  latitude: "52.5244",
  longitude: "13.4105",
  timezone: "Europe/Berlin",
  asn: 64500,
  organization: "AS64500 Example Mobile GmbH",
  organization_name: "Example Mobile GmbH",
};

export interface FakeService {
  port: number;
  requests: string[];
  close: () => Promise<void>;
}

/** An IP-info service: `answer()` gives its status and body. */
export async function fakeIpInfoService(answer: () => { status: number; body: unknown }): Promise<FakeService> {
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    requests.push(`${req.method} ${req.headers.host}${req.url}`);
    const { status, body } = answer();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** The check's options for this machine: the two services behind the local
 *  SOCKS5 by their real names, plain HTTP (no TLS), short deadlines. */
export function localCheckOptions(socks: FakeSocks, ipinfo: FakeService, geojs: FakeService): ProxyCheckOptions {
  socks.routes.set("ipinfo.io:443", ipinfo.port);
  socks.routes.set("get.geojs.io:443", geojs.port);
  return {
    wrap: (socket: Socket) => socket,
    timeouts: { connectMs: 2_000, answerMs: 1_000, requestMs: 3_000, totalMs: 10_000 },
  };
}

/** A TCP server whose every connection `serve` handles (a port speaking
 *  something other than SOCKS5). */
export async function rawServer(serve: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    serve(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** An HTTP proxy that reads a whole request before it answers: silent to a
 *  SOCKS5 greeting, `407` to a CONNECT. */
export function httpProxyServing(socket: Socket): void {
  let seen = "";
  socket.on("data", (chunk: Buffer) => {
    seen += chunk.toString("latin1");
    if (seen.includes("\r\n\r\n")) socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\n\r\n");
  });
}
