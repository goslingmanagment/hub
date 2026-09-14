import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer, connect, type Socket } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import { listenOnLoopback } from "./network.ts";

const username = "fixture-user";
const password = "fixture-password";
const proxyAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

/** Both proxies accept only the fixed Fansly authority and tunnel to loopback.
 * TLS still verifies wsv3.fansly.com against the child's test-only trust root. */
export async function startFanslyProbeNetwork(protocol: "http" | "socks5", refuse = false, rest?: {
  status: number; body?: string; location?: string; hang?: boolean;
}, upgradeStatus = 101, stallClose = false) {
  const destination = rest ? "apiv3.fansly.com:443" : "wsv3.fansly.com:443";
  const sockets = new Set<Socket>();
  const destinations: string[] = [];
  const upgrades: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const requests: { url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const frames: number[] = [];
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const target = createHttpsServer({
    key: await readFile(new URL(`../fixtures/fansly-${rest ? "binding" : "probe"}.key.pem`, import.meta.url)),
    cert: await readFile(new URL(`../fixtures/fansly-${rest ? "binding" : "probe"}.cert.pem`, import.meta.url)),
  });
  target.on("request", (request, response) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers });
    if (!rest || rest.hang) return;
    response.writeHead(rest.status, { "content-type": "application/json",
      ...(rest.location ? { location: rest.location } : {}) });
    // Chunked bodies exercise the streaming limit without trusting Content-Length.
    response.write(rest.body ?? "");
    response.end();
  });
  target.on("connection", track);
  target.on("tlsClientError", () => {}); // The untrusted-CA case deliberately fails.
  target.on("upgrade", (request, socket) => {
    upgrades.push({ url: request.url, headers: request.headers });
    if (upgradeStatus !== 101) {
      socket.end(`HTTP/1.1 ${upgradeStatus} Rejected\r\nContent-Length: 0\r\n`
        + "X-Private-Fixture: fixture-provider-secret\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const pong = Buffer.from('{"t":2,"d":"{}"}');
    // Upgrade + first frame in ONE write exercises Undici's upgrade-head path.
    socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
      Buffer.from([0x81, pong.length]), pong,
    ]));
    socket.once("data", (data: Buffer) => {
      frames.push(data[0]! & 0x0f);
      if (!stallClose) socket.end(Buffer.from([0x88, 2, 3, 232]));
    });
  });
  const proxy = createServer();
  async function stop() {
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, target].map((server) => server.listening
      ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()));
  }
  try {
    const address = await listenOnLoopback(target, "Fansly probe TLS fixture");
    if (!address) { await stop(); return null; }
    proxy.on("connection", (socket) => {
      track(socket);
      let buffer = Buffer.alloc(0);
      let stage: "greeting" | "auth" | "destination" = "greeting";
      const tunnel = (leftover: Buffer, response: Buffer | string) => {
        socket.removeListener("data", receive);
        const upstream = track(connect({ host: "127.0.0.1", port: address.port }, () => {
          socket.write(response);
          if (leftover.length) upstream.write(leftover);
          socket.pipe(upstream).pipe(socket);
        }));
        socket.once("close", () => upstream.destroy());
        upstream.once("close", () => socket.destroy());
      };
      const receive = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 4096) { socket.destroy(); return; }
        if (protocol === "http") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const header = buffer.subarray(0, end).toString();
          const authority = header.split("\r\n")[0]?.split(" ")[1] ?? "";
          destinations.push(authority);
          if (refuse || authority !== destination
            || !header.toLowerCase().includes(`proxy-authorization: ${proxyAuth}`.toLowerCase())) {
            socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
          } else tunnel(buffer.subarray(end + 4), "HTTP/1.1 200 Connection Established\r\n\r\n");
          return;
        }
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
          if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]!).includes(2)) {
            socket.destroy(); return;
          }
          buffer = buffer.subarray(2 + buffer[1]!);
          socket.write(Buffer.from([5, 2]));
          stage = "auth";
        }
        if (stage === "auth") {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]!) return;
          const userEnd = 2 + buffer[1]!;
          const end = userEnd + 1 + buffer[userEnd]!;
          if (buffer.length < end) return;
          if (buffer[0] !== 1 || buffer.subarray(2, userEnd).toString() !== username
            || buffer.subarray(userEnd + 1, end).toString() !== password) {
            socket.end(Buffer.from([1, 1])); return;
          }
          buffer = buffer.subarray(end);
          socket.write(Buffer.from([1, 0]));
          stage = "destination";
        }
        if (buffer.length < 5) return;
        const end = 7 + buffer[4]!;
        if (buffer.length < end) return;
        const authority = `${buffer.subarray(5, end - 2)}:${buffer.readUInt16BE(end - 2)}`;
        destinations.push(authority);
        if (refuse || buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3
          || authority !== destination) {
          socket.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        } else tunnel(buffer.subarray(end), Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      };
      socket.on("data", receive);
    });
    const proxyAddress = await listenOnLoopback(proxy, "Fansly probe proxy fixture");
    if (!proxyAddress) { await stop(); return null; }
    return {
      url: `${protocol}://${proxyAddress.host}:${proxyAddress.port}`,
      username, password, destinations, upgrades, requests, frames, stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
