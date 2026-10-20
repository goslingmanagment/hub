import {
  createServer,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  createOfapiClient,
  OfapiGovernedRequestError,
} from "../apps/runtime/src/services/ofapi.ts";

const ACCOUNT = "acct_01000000000000000000000000000000";

let server: Server | null = null;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = null;
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

  it("omits a standalone chargeback endDate and sends it with startDate", async () => {
    const upstreamRequests: string[] = [];
    server = createServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      // The documented body: no continuation field (see ofapi-request-audit).
      response.end(JSON.stringify({ data: { list: [], marker: null } }));
    });
    const baseUrl = await listenOnLocalhost(server);
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
    });

    // A standalone upper bound is not a valid OFAPI range and must not leak
    // onto the wire even if a caller accidentally supplies it.
    await client.listChargebacks!({ pageId: 42 }, ACCOUNT, {
      limit: 100,
      endDate: "2026-07-19 12:00:00",
    });
    await client.listChargebacks!({ pageId: 42 }, ACCOUNT, {
      limit: 100,
      offset: 100,
      startDate: "2026-04-20 12:00:00",
      endDate: "2026-07-19 12:00:00",
    });

    expect(upstreamRequests).toEqual([
      `/${ACCOUNT}/chargebacks?limit=100`,
      `/${ACCOUNT}/chargebacks?limit=100&offset=100&start_date=2026-04-20+12%3A00%3A00&end_date=2026-07-19+12%3A00%3A00`,
    ]);
  });
});

describe("OFAPI governed raw transport", () => {
  it.each([false, true])("keeps a thrown authority check pre-dispatch even when cleanup fails: %s", async (cleanupFails) => {
    let upstreamRequests = 0;
    server = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200).end("unexpected");
    });
    const baseUrl = await listenOnLocalhost(server);
    const admitted: string[] = [], cancelled: string[] = [], spend: unknown[] = [];
    const client = createOfapiClient({
      baseUrl, apiKey: "test-key", restDelayMs: 0,
      beforeCollectionRequest: async request => { admitted.push(request.requestId); },
      onCollectionCancelled: async requestId => {
        cancelled.push(requestId);
        if (cleanupFails) throw new Error("Reservation cleanup unavailable");
      },
      onCreditSpend: receipt => { spend.push(receipt); },
    });
    await expect(client.dispatchGovernedRaw!({ pageId: 42 }, {
      attemptId: "authority-changed", operation: "ofapi_capture_chat_messages", method: "GET",
      pathname: `/${ACCOUNT}/chats/123/messages`, priorityClass: "bulk",
      deadlineAt: new Date(Date.now() + 10000),
      beforeDispatch: async () => { throw new Error("Account authority changed"); },
    })).rejects.toMatchObject({ name: "OfapiGovernedRequestError", phase: "pre_dispatch", reason: "cancelled" });
    expect(admitted).toEqual(["authority-changed"]);
    expect(cancelled).toEqual(admitted);
    expect(upstreamRequests).toBe(0);
    expect(spend).toEqual([]);
  });

  it("captures byte-exact response once without the legacy spend sink", async () => {
    const expectedBody = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
    const requests: Array<{ url: string; attemptId: string | undefined }> = [];
    server = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        attemptId: Array.isArray(request.headers["x-agency-hub-attempt-id"])
          ? request.headers["x-agency-hub-attempt-id"][0]
          : request.headers["x-agency-hub-attempt-id"],
      });
      response.writeHead(429, {
        "content-type": "application/octet-stream",
        "retry-after": "17",
      });
      response.end(expectedBody);
    });
    const baseUrl = await listenOnLocalhost(server);
    const spend: unknown[] = [];
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
      onCreditSpend: (observation) => {
        spend.push(observation);
      },
    });
    let fenceChecks = 0;

    const result = await client.dispatchGovernedRaw!({ pageId: 42 }, {
      attemptId: "attempt-1",
      operation: "ofapi_capture_chat_messages",
      method: "GET",
      pathname: `/${ACCOUNT}/chats/123/messages`,
      query: { limit: "30" },
      priorityClass: "bulk",
      deadlineAt: new Date(Date.now() + 10_000),
      beforeDispatch: async () => {
        fenceChecks += 1;
        return true;
      },
    });

    expect(fenceChecks).toBe(1);
    expect(requests).toEqual([{
      url: `/${ACCOUNT}/chats/123/messages?limit=30`,
      attemptId: "attempt-1",
    }]);
    expect(result.status).toBe(429);
    expect(result.bodyBytes.equals(expectedBody)).toBe(true);
    expect(result.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "retry-after": "17",
    });
    expect(spend).toEqual([]);
  });

  it("does not contact OFAPI when the durable dispatch fence is lost", async () => {
    let upstreamRequests = 0;
    server = createServer((_request, response) => {
      upstreamRequests += 1;
      response.writeHead(200).end("unexpected");
    });
    const baseUrl = await listenOnLocalhost(server);
    const client = createOfapiClient({
      baseUrl,
      apiKey: "test-key",
      restDelayMs: 0,
    });

    const promise = client.dispatchGovernedRaw!({ pageId: 42 }, {
      attemptId: "attempt-lost-fence",
      operation: "ofapi_capture_chat_messages",
      method: "GET",
      pathname: `/${ACCOUNT}/chats/123/messages`,
      priorityClass: "bulk",
      deadlineAt: new Date(Date.now() + 10_000),
      beforeDispatch: async () => false,
    });

    await expect(promise).rejects.toMatchObject({
      name: "OfapiGovernedRequestError",
      phase: "pre_dispatch",
      reason: "cancelled",
    });
    await expect(promise).rejects.toBeInstanceOf(OfapiGovernedRequestError);
    expect(upstreamRequests).toBe(0);
  });
});
