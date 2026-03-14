import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import net, { type Server as NetServer, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProxyDispatcherCacheKey } from "../packages/shared/src/proxy.ts";
import { listenOnLoopback } from "./helpers/network.ts";

const sharedHttpClientRequire = createRequire(new URL("../packages/shared/src/http-client.ts", import.meta.url));

async function loadHttpClientModule() {
  return import("../packages/shared/src/http-client.ts");
}

async function listen(server: NetServer, purpose: string) {
  return listenOnLoopback(server, purpose);
}

async function closeServer(server: NetServer) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createSocketReader(socket: Socket) {
  let buffer = Buffer.alloc(0);
  let ended = false;
  let waiter: (() => void) | null = null;

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    waiter?.();
    waiter = null;
  });
  socket.on("close", () => {
    ended = true;
    waiter?.();
    waiter = null;
  });
  socket.on("end", () => {
    ended = true;
    waiter?.();
    waiter = null;
  });

  async function waitForData() {
    if (buffer.length > 0 || ended) {
      return;
    }

    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
  }

  return {
    async readExactly(length: number) {
      while (buffer.length < length) {
        await waitForData();
        if (ended && buffer.length < length) {
          throw new Error(`Socket ended before ${length} bytes were available`);
        }
      }

      const chunk = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return chunk;
    },
  };
}

async function createTargetServer() {
  const server = createServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  const address = await listen(server, "HTTP target server tests");
  if (!address) {
    await closeServer(server).catch(() => undefined);
    return null;
  }
  return {
    server,
    url: `http://${address.host}:${address.port}/probe`,
    port: address.port,
  };
}

async function createHttpConnectProxy(expectedAuthorization: string) {
  const server = createServer((request, response) => {
    if (request.headers["proxy-authorization"] !== expectedAuthorization) {
      response.statusCode = 407;
      response.end("proxy auth required");
      return;
    }

    const absoluteUrl = request.url ? new URL(request.url) : null;
    if (!absoluteUrl) {
      response.statusCode = 400;
      response.end("missing target url");
      return;
    }

    const upstream = httpRequest({
      host: absoluteUrl.hostname,
      port: Number.parseInt(absoluteUrl.port, 10),
      method: request.method,
      path: `${absoluteUrl.pathname}${absoluteUrl.search}`,
      headers: {
        ...request.headers,
        host: absoluteUrl.host,
        connection: "close",
      },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });

    request.pipe(upstream);
    upstream.on("error", () => {
      response.statusCode = 502;
      response.end("upstream connect failed");
    });
  });

  server.on("connect", (request, clientSocket, head) => {
    if (request.headers["proxy-authorization"] !== expectedAuthorization) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }

    const [host, rawPort] = (request.url ?? "").split(":");
    const upstream = net.connect({
      host,
      port: Number.parseInt(rawPort ?? "80", 10),
    }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const destroyPair = () => {
      upstream.destroy();
      clientSocket.destroy();
    };

    upstream.on("error", destroyPair);
    clientSocket.on("error", destroyPair);
  });

  const address = await listen(server, "HTTP CONNECT proxy tests");
  if (!address) {
    await closeServer(server).catch(() => undefined);
    return null;
  }
  return {
    server,
    url: `http://${address.host}:${address.port}`,
  };
}

async function createSocks5Proxy(expectedAuth: { username: string; password: string }) {
  const server = net.createServer(async (socket) => {
    try {
      const reader = createSocketReader(socket);
      const greeting = await reader.readExactly(2);
      expect(greeting[0]).toBe(0x05);
      const methodCount = greeting[1]!;
      const methods = await reader.readExactly(methodCount);
      expect(Array.from(methods)).toContain(0x02);
      socket.write(Buffer.from([0x05, 0x02]));

      const authVersion = await reader.readExactly(2);
      expect(authVersion[0]).toBe(0x01);
      const username = (await reader.readExactly(authVersion[1]!)).toString("utf8");
      const passwordLength = (await reader.readExactly(1))[0]!;
      const password = (await reader.readExactly(passwordLength)).toString("utf8");
      const authOk = username === expectedAuth.username && password === expectedAuth.password;
      socket.write(Buffer.from([0x01, authOk ? 0x00 : 0x01]));
      if (!authOk) {
        socket.end();
        return;
      }

      const requestHeader = await reader.readExactly(4);
      expect(requestHeader[0]).toBe(0x05);
      expect(requestHeader[1]).toBe(0x01);
      const addressType = requestHeader[3]!;

      let host = "";
      if (addressType === 0x01) {
        host = Array.from(await reader.readExactly(4)).join(".");
      } else if (addressType === 0x03) {
        const hostLength = (await reader.readExactly(1))[0]!;
        host = (await reader.readExactly(hostLength)).toString("utf8");
      } else if (addressType === 0x04) {
        const bytes = await reader.readExactly(16);
        const parts: string[] = [];
        for (let index = 0; index < bytes.length; index += 2) {
          parts.push(bytes.readUInt16BE(index).toString(16));
        }
        host = parts.join(":");
      } else {
        throw new Error(`Unsupported address type ${addressType}`);
      }

      const portBytes = await reader.readExactly(2);
      const port = portBytes.readUInt16BE(0);
      const upstream = net.connect({ host, port }, () => {
        const boundAddress = upstream.localAddress && net.isIPv4(upstream.localAddress)
          ? upstream.localAddress
          : "0.0.0.0";
        const boundOctets = boundAddress.split(".").map((octet) => Number.parseInt(octet, 10));
        const boundPort = upstream.localPort ?? 0;
        socket.write(Buffer.from([
          0x05,
          0x00,
          0x00,
          0x01,
          boundOctets[0] ?? 0,
          boundOctets[1] ?? 0,
          boundOctets[2] ?? 0,
          boundOctets[3] ?? 0,
          (boundPort >> 8) & 0xff,
          boundPort & 0xff,
        ]));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });

      const destroyPair = () => {
        upstream.destroy();
        socket.destroy();
      };

      upstream.on("error", destroyPair);
      socket.on("error", destroyPair);
    } catch {
      socket.destroy();
    }
  });

  const address = await listen(server, "SOCKS5 proxy tests");
  if (!address) {
    await closeServer(server).catch(() => undefined);
    return null;
  }
  return {
    server,
    url: `socks5://${expectedAuth.username}:${expectedAuth.password}@${address.host}:${address.port}`,
  };
}

describe("shared http client helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("formats nested undici causes with socket metadata", async () => {
    const { formatObservedError } = await loadHttpClientModule();
    const socketError = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
      socket: {
        remoteAddress: "203.0.113.10",
        remotePort: 443,
      },
    });
    const error = new TypeError("fetch failed", { cause: socketError });

    expect(formatObservedError(error)).toContain("TypeError: fetch failed");
    expect(formatObservedError(error)).toContain("cause(1): SocketError: other side closed");
    expect(formatObservedError(error)).toContain("code=UND_ERR_SOCKET");
    expect(formatObservedError(error)).toContain("socket={remoteAddress=203.0.113.10, remotePort=443}");
  });

  it("redacts inline proxy credentials from formatted errors", async () => {
    const { formatObservedError } = await loadHttpClientModule();
    const error = new Error("Proxy connect failed for socks5://user:pass@127.0.0.1:1080");
    expect(formatObservedError(error)).toContain("socks5://127.0.0.1:1080 (auth)");
    expect(formatObservedError(error)).not.toContain("user:pass");
  });

  it("detects timeout errors through the nested cause chain", async () => {
    const { classifyTransportError } = await loadHttpClientModule();
    const timeoutError = Object.assign(new Error("connect timed out"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new TypeError("fetch failed", { cause: timeoutError });

    expect(classifyTransportError(error)).toBe("timeout");
  });

  it("parses retry-after seconds and http-date values", async () => {
    const { parseRetryAfterDelayMs } = await loadHttpClientModule();
    const now = Date.parse("2026-03-13T00:00:00.000Z");

    expect(parseRetryAfterDelayMs("0.001", now)).toBe(1);
    expect(parseRetryAfterDelayMs("Fri, 13 Mar 2026 00:00:05 GMT", now)).toBe(5_000);
  });

  it("falls back to exponential retry delays when retry-after is absent", async () => {
    const {
      exponentialRetryDelayMs,
      resolveRetryDelayMs,
    } = await loadHttpClientModule();
    expect(exponentialRetryDelayMs(1)).toBe(5_000);
    expect(exponentialRetryDelayMs(2)).toBe(10_000);
    expect(resolveRetryDelayMs(null, 3)).toBe(20_000);
  });

  it("builds proxy cache keys without exposing raw credentials", () => {
    const key = buildProxyDispatcherCacheKey({
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    });

    expect(key).toContain("socks5://127.0.0.1:1080#");
    expect(key).not.toContain("proxy-user");
    expect(key).not.toContain("proxy-pass");
  });

  it("dispatches requests through an HTTP proxy", async () => {
    const { createProxyRequestDispatcher } = await loadHttpClientModule();
    const target = await createTargetServer();
    const proxy = await createHttpConnectProxy("Basic dXNlcjpwYXNz");
    if (!target || !proxy) {
      return;
    }
    const dispatcher = createProxyRequestDispatcher({
      url: proxy.url,
      username: "user",
      password: "pass",
    });

    try {
      const response = await fetch(target.url, { dispatcher } as RequestInit & { dispatcher: typeof dispatcher });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await dispatcher.close();
      await closeServer(proxy.server);
      await closeServer(target.server);
    }
  });

  it("dispatches requests through a SOCKS5 proxy", async () => {
    const { createProxyRequestDispatcher } = await loadHttpClientModule();
    const target = await createTargetServer();
    const proxy = await createSocks5Proxy({
      username: "socks-user",
      password: "socks-pass",
    });
    if (!target || !proxy) {
      return;
    }
    const dispatcher = createProxyRequestDispatcher({
      url: proxy.url,
    });

    try {
      const response = await fetch(target.url, { dispatcher } as RequestInit & { dispatcher: typeof dispatcher });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await dispatcher.close();
      await closeServer(proxy.server);
      await closeServer(target.server);
    }
  });

  it("uses the default HTTPS port for SOCKS destinations when the URL omits it", async () => {
    const { SocksClient } = sharedHttpClientRequire("socks") as {
      SocksClient: {
        createConnection: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const createConnectionSpy = vi.spyOn(SocksClient, "createConnection").mockRejectedValue(new Error("stop"));
    const { createProxyRequestDispatcher } = await loadHttpClientModule();
    const dispatcher = createProxyRequestDispatcher({
      url: "socks5://socks-user:socks-pass@127.0.0.1:1080",
    });

    try {
      await expect(fetch("https://apiv3.fansly.com/api/v1/account/me", {
        dispatcher,
      } as RequestInit & { dispatcher: typeof dispatcher })).rejects.toThrow("fetch failed");
    } finally {
      await dispatcher.close();
    }

    expect(createConnectionSpy).toHaveBeenCalledTimes(1);
    expect(createConnectionSpy.mock.calls[0]?.[0]).toMatchObject({
      command: "connect",
      destination: {
        host: "apiv3.fansly.com",
        port: 443,
      },
    });
  });
});
