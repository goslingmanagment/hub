import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

// A fake Fansly origin (plain HTTP on loopback) behind a local HTTP CONNECT
// proxy, for the send-guard tests. The origin records the moment every request
// ARRIVES — before it answers, so a recorded arrival always precedes the
// sender's completion — on this process's monotonic clock and wall clock.

export interface FakeFanslyArrival {
  monotonicMs: number;
  wallMs: number;
  path: string;
}

export interface FakeFanslyNetwork {
  baseUrl: string;
  proxyUrl: string;
  arrivals: FakeFanslyArrival[];
  tunnels: number;
  close(): Promise<void>;
}

const accountMeBody = JSON.stringify({
  success: true,
  response: {
    account: {
      id: "acct-guard",
      username: "guard",
      displayName: null,
      createdAt: 0,
      followCount: 0,
      subscriberCount: 0,
    },
  },
});

export async function startFakeFanslyNetwork(options: {
  /** How the origin answers; default: /account/me after 0–40 ms. */
  respond?: (request: IncomingMessage, response: ServerResponse) => void;
  /** The delay before a CONNECT tunnel is established. */
  tunnelDelayMs?: () => number;
  /** Close the connection after this share of responses (forces new tunnels). */
  closeShare?: number;
} = {}): Promise<FakeFanslyNetwork> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };
  const arrivals: FakeFanslyArrival[] = [];
  const closeShare = options.closeShare ?? 0;
  const origin = createServer((request, response) => {
    arrivals.push({ monotonicMs: performance.now(), wallMs: Date.now(), path: request.url ?? "" });
    if (options.respond) {
      options.respond(request, response);
      return;
    }
    setTimeout(() => {
      response.writeHead(200, {
        "content-type": "application/json",
        ...(Math.random() < closeShare ? { connection: "close" } : {}),
      });
      response.end(accountMeBody);
    }, Math.random() * 40);
  });
  origin.on("connection", track);

  const network: FakeFanslyNetwork = {
    baseUrl: "",
    proxyUrl: "",
    arrivals,
    tunnels: 0,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
    },
  };

  const proxy = createServer();
  proxy.on("connection", track);
  proxy.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    network.tunnels += 1;
    const [host, port] = (request.url ?? "").split(":");
    setTimeout(() => {
      if (client.destroyed) return;
      const upstream = connect(Number(port), host ?? "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      // A client that gave up still delivers what it wrote: the pipe ends the
      // upstream after the last byte instead of cutting it.
      upstream.on("close", () => client.destroy());
    }, Math.max(0, options.tunnelDelayMs?.() ?? 0));
  });

  await Promise.all([
    new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve())),
    new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve())),
  ]);
  network.baseUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  network.proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  return network;
}
