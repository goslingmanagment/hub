import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import { connect as connectTcp } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createProxyRequestDispatcher } from "@agency_hub_core/shared";

import {
  createOfapiClient,
  OfapiApiError,
} from "../apps/runtime/src/services/ofapi.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";

let server: Server | null = null;
const extraServers: Server[] = [];

afterEach(() => {
  server?.close();
  server = null;
  while (extraServers.length > 0) {
    extraServers.pop()?.close();
  }
});

async function listenOnLocalhost(serverToStart: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(0, "127.0.0.1", () => {
      const address = serverToStart.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not bind to a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("OFAPI proxy read client", () => {
  it("lists transactions with startDate/marker and reports credit spend", async () => {
    const upstreamRequests: string[] = [];
    server = createServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [{ id: "tx-1" }],
        _meta: {
          _credits: { used: 2, balance: 998 },
          _cache: { is_cached: false },
        },
        _pagination: {
          next_page: `https://app.onlyfansapi.com/api/${ACCOUNT}/transactions?marker=456`,
        },
      }));
    });
    const baseUrl = await listenOnLocalhost(server);
    const spend: Array<{ operation: string; credits: number; pageId: number | null }> = [];
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
      onCreditSpend: (observation) => {
        spend.push({
          operation: observation.operation,
          credits: observation.credits,
          pageId: observation.pageId,
        });
      },
    });

    const page = await client.listTransactions!({ pageId: 42 }, ACCOUNT, {
      limit: 100,
      startDate: "2026-06-01 00:00:00",
      marker: "123",
      pageIndex: 3,
    });

    expect(upstreamRequests).toEqual([
      `/${ACCOUNT}/transactions?limit=100&startDate=2026-06-01+00%3A00%3A00&marker=123`,
    ]);
    expect(page.items).toEqual([{ id: "tx-1" }]);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextMarker).toBe("456");
    expect(spend).toEqual([{ operation: "ofapi_transactions", credits: 2, pageId: 42 }]);
  });

  it("parses transactions wrapped as data.list with a data nextMarker", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: {
          list: [{ id: "tx-1" }, { id: "tx-2" }],
          hasMore: true,
          nextMarker: 1782465831,
        },
        _meta: {
          _credits: { used: 1, balance: 997 },
        },
      }));
    });
    const baseUrl = await listenOnLocalhost(server);
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const page = await client.listTransactions!({ pageId: 42 }, ACCOUNT, {
      limit: 3,
      startDate: "2026-06-01 00:00:00",
    });

    expect(page.items).toEqual([{ id: "tx-1" }, { id: "tx-2" }]);
    expect(page.hasNextPage).toBe(true);
    expect(page.nextMarker).toBe("1782465831");
  });

  it("routes proxy reads through the supplied dispatcher", async () => {
    const upstreamRequests: string[] = [];
    const proxyRequests: string[] = [];
    const upstream = createServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: 123 }] }));
    });
    extraServers.push(upstream);
    const baseUrl = await listenOnLocalhost(upstream);

    const proxy = createServer((request, response) => {
      proxyRequests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      let target: URL;
      try {
        target = new URL(request.url ?? "/", baseUrl);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const proxied = httpRequest(target, {
        method: request.method,
        headers: request.headers,
      }, (proxiedResponse) => {
        response.writeHead(proxiedResponse.statusCode ?? 502, proxiedResponse.headers);
        proxiedResponse.pipe(response);
      });
      proxied.on("error", () => {
        response.writeHead(502).end();
      });
      request.pipe(proxied);
    });
    proxy.on("connect", (request, clientSocket, head) => {
      proxyRequests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      const [host, portText] = (request.url ?? "").split(":");
      const port = Number(portText);
      if (!host || !Number.isFinite(port)) {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const upstreamSocket = connectTcp(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstreamSocket.write(head);
        }
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
      upstreamSocket.on("error", () => {
        clientSocket.end();
      });
      clientSocket.on("error", () => {
        upstreamSocket.destroy();
      });
    });
    extraServers.push(proxy);
    const proxyUrl = await listenOnLocalhost(proxy);
    const dispatcher = createProxyRequestDispatcher({ url: proxyUrl });
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
    });

    try {
      const response = await client.proxyRead!({
        pageId: 1,
        dispatcher,
      }, {
        operation: "ofapi_gateway_chat_messages",
        pathname: `/${ACCOUNT}/chats/123/messages`,
        query: { limit: "30", order: "desc" },
        fallbackCredits: 1,
        fallbackEstimated: true,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ id: 123 }] });
      expect(proxyRequests).toHaveLength(1);
      expect(upstreamRequests).toEqual([`/${ACCOUNT}/chats/123/messages?limit=30&order=desc`]);
    } finally {
      await dispatcher.close();
    }
  });

  it("maps response body stream failures to a controlled upstream error", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.destroy(new Error("scripted upstream body failure"));
    });
    const baseUrl = await listenOnLocalhost(server);
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
    });

    expect(client.proxyRead).toBeDefined();
    const promise = client.proxyRead!({ pageId: 1 }, {
      operation: "ofapi_gateway_chat_messages",
      pathname: `/${ACCOUNT}/chats/123/messages`,
      query: { limit: "30", order: "desc" },
      fallbackCredits: 1,
      fallbackEstimated: true,
    });

    await expect(promise).rejects.toMatchObject({
      name: "OfapiApiError",
      status: null,
    });
    await expect(promise).rejects.toBeInstanceOf(OfapiApiError);
    await expect(promise).rejects.toThrow("OFAPI response body read failed");
  });
});
