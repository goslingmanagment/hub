import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HttpRequestEvent } from "@fansly-connect/shared";

import { FanslyAdapter } from "../packages/fansly/src/adapter.ts";
import { OnlyFansAdapter } from "../packages/onlyfans/src/adapter.ts";

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void,
  run: (baseUrl: string, requestTimes: number[]) => Promise<void>,
) {
  const requestTimes: number[] = [];
  const server = createServer((request, response) => {
    requestTimes.push(Date.now());
    return handler(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`, requestTimes);
  } finally {
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
}

async function withJsonServer(
  body: unknown,
  run: (baseUrl: string, requestTimes: number[]) => Promise<void>,
) {
  await withServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }, run);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("adapter hardening", () => {
  it("reuses Fansly proxy agents, attaches the 30s timeout, and closes cached agents", async () => {
    await withJsonServer({
      success: true,
      response: {
        account: {
          id: "acct-1",
          username: "lana",
          displayName: "Lana",
          followCount: 0,
          subscriberCount: 0,
        },
      },
    }, async (baseUrl) => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const adapter = new FanslyAdapter({
        baseUrl,
        defaultDelayMs: 0,
      });
      const proxy = {
        url: "http://proxy.example:8080",
        username: "user",
        password: "pass",
      };

      const firstDispatcher = (adapter as unknown as {
        buildProxyDispatcher(input: typeof proxy): { close(): Promise<void> };
        proxyAgents: Map<string, { close(): Promise<void> }>;
      }).buildProxyDispatcher(proxy);
      const secondDispatcher = (adapter as unknown as {
        buildProxyDispatcher(input: typeof proxy): { close(): Promise<void> };
        proxyAgents: Map<string, { close(): Promise<void> }>;
      }).buildProxyDispatcher(proxy);
      const closeSpy = vi.spyOn(firstDispatcher, "close");

      await adapter.getAccountMe({
        session: {
          authorization: "token",
        },
      });
      await adapter.close();

      expect(firstDispatcher).toBe(secondDispatcher);
      expect((adapter as unknown as {
        proxyAgents: Map<string, unknown>;
      }).proxyAgents.size).toBe(0);
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  it("serializes OnlyFans same-category waits one second apart and reuses proxy agents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    const adapter = new OnlyFansAdapter({
      baseUrl: "http://127.0.0.1:1",
      defaultDelayMs: 1_000,
    });
    const proxy = {
      url: "http://proxy.example:8080",
    };

    const firstDispatcher = (adapter as unknown as {
      buildProxyDispatcher(input: typeof proxy): { close(): Promise<void> };
      proxyAgents: Map<string, { close(): Promise<void> }>;
    }).buildProxyDispatcher(proxy);
    const secondDispatcher = (adapter as unknown as {
      buildProxyDispatcher(input: typeof proxy): { close(): Promise<void> };
      proxyAgents: Map<string, { close(): Promise<void> }>;
    }).buildProxyDispatcher(proxy);

    const completionTimes: number[] = [];
    const firstWait = (adapter as unknown as {
      waitForRateLimit(category: string, minDelayMs: number): Promise<void>;
    }).waitForRateLimit("accounts", 1_000).then(() => {
      completionTimes.push(Date.now());
    });
    const secondWait = (adapter as unknown as {
      waitForRateLimit(category: string, minDelayMs: number): Promise<void>;
    }).waitForRateLimit("accounts", 1_000).then(() => {
      completionTimes.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([firstWait, secondWait]);

    const closeSpy = vi.spyOn(firstDispatcher, "close");
    await adapter.close();

    expect(firstDispatcher).toBe(secondDispatcher);
    expect(completionTimes).toEqual([
      new Date("2026-03-10T12:00:00.000Z").getTime(),
      new Date("2026-03-10T12:00:01.000Z").getTime(),
    ]);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("emits sanitized Fansly request observer events for offset pagination", async () => {
    const events: Array<Record<string, unknown>> = [];

    await withJsonServer({
      success: true,
      response: {
        followers: [
          {
            id: "follow-1",
            followerId: "fan-1",
          },
        ],
        aggregationData: {
          accounts: [],
        },
      },
    }, async (baseUrl) => {
      const adapter = new FanslyAdapter({
        baseUrl,
        defaultDelayMs: 0,
      });

      await adapter.getFollowersPage({
        session: {
          authorization: "super-secret-token",
        },
        requestObserver: {
          async onRequestEvent(event: HttpRequestEvent) {
            events.push(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
          },
        },
      }, "acct-secret-123", {
        offset: 200,
        limit: 100,
        after: "raw-follow-cursor",
      });
    });

    expect(events.map((event) => event.state)).toEqual(["started", "success"]);
    expect(events[0]).toMatchObject({
      operation: "followers",
      endpointTemplate: "/account/:accountId/followersnew",
      attemptNumber: 1,
      pagination: {
        offset: 200,
        limit: 100,
      },
      requestMetadata: {
        offset: 200,
        limit: 100,
        afterPresent: true,
        beforePresent: false,
      },
    });
    expect(JSON.stringify(events)).not.toContain("acct-secret-123");
    expect(JSON.stringify(events)).not.toContain("raw-follow-cursor");
    expect(JSON.stringify(events)).not.toContain("super-secret-token");
  });

  it("emits retry and success observer events for OnlyFans cursor pagination without leaking secrets", async () => {
    const events: Array<Record<string, unknown>> = [];
    let requestCount = 0;

    await withServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
      requestCount += 1;
      response.setHeader("content-type", "application/json");
      if (requestCount === 1) {
        response.statusCode = 429;
        response.setHeader("retry-after", "0.001");
        response.end(JSON.stringify({ error: "rate limited" }));
        return;
      }

      response.end(JSON.stringify({
        items: [
          {
            id: "txn-1",
            amount: 12.5,
            fan: { id: "fan-1" },
            type: "tip",
            status: "posted",
            timestamp: "2026-03-10T12:00:00.000Z",
          },
        ],
        cursor: "next-secret-cursor",
      }));
    }, async (baseUrl) => {
      const adapter = new OnlyFansAdapter({
        baseUrl,
        defaultDelayMs: 0,
      });

      await adapter.getTransactionsPage({
        auth: {
          token: "om-super-secret-token",
        },
        requestObserver: {
          async onRequestEvent(event: HttpRequestEvent) {
            events.push(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
          },
        },
      }, "platform-account-secret", {
        start: new Date("2026-03-10T00:00:00.000Z"),
        end: new Date("2026-03-11T00:00:00.000Z"),
        cursor: "cursor-secret-123",
        limit: 50,
        pageIndex: 3,
      });
    });

    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
    expect(events[0]).toMatchObject({
      operation: "onlymonster_transactions",
      endpointTemplate: "/api/v0/platforms/onlyfans/accounts/:platformAccountId/transactions",
      pagination: {
        pageIndex: 3,
        cursorPresent: true,
      },
      requestMetadata: {
        cursorPresent: true,
        limit: 50,
      },
    });
    expect(events[1]).toMatchObject({
      state: "retry",
      httpStatus: 429,
      retryDelayMs: 1,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("platform-account-secret");
    expect(serialized).not.toContain("cursor-secret-123");
    expect(serialized).not.toContain("next-secret-cursor");
    expect(serialized).not.toContain("om-super-secret-token");
  });
});
