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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeAllListeners("error");
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    throw error;
  }

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

  return true;
}

async function withJsonServer(
  body: unknown,
  run: (baseUrl: string, requestTimes: number[]) => Promise<void>,
) {
  return withServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
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

  it("builds proxy cache keys without exposing raw credentials", () => {
    const fanslyAdapter = new FanslyAdapter({
      baseUrl: "http://127.0.0.1:1",
      defaultDelayMs: 0,
    });
    const onlyFansAdapter = new OnlyFansAdapter({
      baseUrl: "http://127.0.0.1:1",
      defaultDelayMs: 0,
    });
    const proxy = {
      url: "socks5://proxy-user:proxy-pass@127.0.0.1:1080",
    };

    const fanslyKey = (fanslyAdapter as unknown as {
      buildProxyCacheKey(input: typeof proxy): string;
    }).buildProxyCacheKey(proxy);
    const onlyFansKey = (onlyFansAdapter as unknown as {
      buildProxyCacheKey(input: typeof proxy): string;
    }).buildProxyCacheKey(proxy);

    expect(fanslyKey).toContain("socks5://127.0.0.1:1080#");
    expect(fanslyKey).not.toContain("proxy-user");
    expect(fanslyKey).not.toContain("proxy-pass");
    expect(onlyFansKey).toBe(fanslyKey);
  });

  it("serializes Fansly requests from different categories with the global delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    const adapter = new FanslyAdapter({
      baseUrl: "http://127.0.0.1:1",
      defaultDelayMs: 0,
    });

    const completionTimes: number[] = [];
    const waitedMs: number[] = [];
    const firstWait = (adapter as unknown as {
      waitForRateLimit(category: string, minDelayMs: number): Promise<number>;
    }).waitForRateLimit("account", 0).then((waited) => {
      waitedMs.push(waited);
      completionTimes.push(Date.now());
    });
    const secondWait = (adapter as unknown as {
      waitForRateLimit(category: string, minDelayMs: number): Promise<number>;
    }).waitForRateLimit("transactions", 0).then((waited) => {
      waitedMs.push(waited);
      completionTimes.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all([firstWait, secondWait]);

    expect(waitedMs).toEqual([0, 1_500]);
    expect(completionTimes).toEqual([
      new Date("2026-03-10T12:00:00.000Z").getTime(),
      new Date("2026-03-10T12:00:01.500Z").getTime(),
    ]);
  });

  it("keeps Fansly same-category pacing and reports combined category plus global wait", async () => {
    const adapter = new FanslyAdapter({
      baseUrl: "http://127.0.0.1:1",
      defaultDelayMs: 1_000,
      globalDelayMs: 1_500,
    });

    const completionTimes: number[] = [];
    const waitedMs: number[] = [];
    const firstWait = (adapter as unknown as {
      waitForRateLimit(category: string, minDelayMs: number): Promise<number>;
    }).waitForRateLimit("account", 1_000).then((waited) => {
      waitedMs.push(waited);
      completionTimes.push(Date.now());
    });
    const secondWait = (adapter as unknown as {
      waitForRateLimit(category: string, minDelayMs: number): Promise<number>;
    }).waitForRateLimit("account", 1_000).then((waited) => {
      waitedMs.push(waited);
      completionTimes.push(Date.now());
    });

    await Promise.all([firstWait, secondWait]);

    expect(waitedMs[0]).toBe(0);
    expect(waitedMs[1]).toBeGreaterThan(1_000);
    expect(completionTimes[1]! - completionTimes[0]!).toBeGreaterThanOrEqual(1_400);
  });

  it("paces Fansly account lookup requests with the dedicated lookup delay", async () => {
    await withJsonServer({
      success: true,
      response: [
        {
          id: "fan-1",
          username: "fan_0001",
          displayName: "Fan 0001",
          createdAt: 1770000000000,
        },
      ],
    }, async (baseUrl, requestTimes) => {
      const adapter = new FanslyAdapter({
        baseUrl,
        defaultDelayMs: 1_000,
        globalDelayMs: 1_500,
        accountLookupDelayMs: 2_000,
      });

      await adapter.getAccountsByIdsPage({
        session: {
          authorization: "token",
        },
      }, ["fan-1"]);
      await adapter.getAccountsByIdsPage({
        session: {
          authorization: "token",
        },
      }, ["fan-2"]);
      await adapter.close();

      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(2_000);
    });
  });

  it("serializes different Fansly session tokens behind the single global clock", async () => {
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
    }, async (baseUrl, requestTimes) => {
      const adapter = new FanslyAdapter({
        baseUrl,
        defaultDelayMs: 0,
      });

      await Promise.all([
        adapter.getAccountMe({
          session: {
            authorization: "token-a",
          },
        }),
        adapter.getAccountMe({
          session: {
            authorization: "token-b",
          },
        }),
      ]);

      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1_450);
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

    const ran = await withJsonServer({
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
    if (!ran) {
      return;
    }

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

  it("rotates the Fansly direct dispatcher when a fresh connection is required", async () => {
    const adapter = new FanslyAdapter({
      baseUrl: "http://127.0.0.1:1",
      defaultDelayMs: 0,
      globalDelayMs: 0,
    });

    const initialDispatcher = (adapter as unknown as {
      directDispatcher: { close(): Promise<void> };
      resetDispatcher(input?: undefined): void;
    }).directDispatcher;
    const closeSpy = vi.spyOn(initialDispatcher, "close");

    (adapter as unknown as {
      directDispatcher: { close(): Promise<void> };
      resetDispatcher(input?: undefined): void;
    }).resetDispatcher();

    const rotatedDispatcher = (adapter as unknown as {
      directDispatcher: { close(): Promise<void> };
    }).directDispatcher;

    expect(rotatedDispatcher).not.toBe(initialDispatcher);

    await adapter.close();

    expect(closeSpy).toHaveBeenCalled();
  });

  it("retries Fansly 429 responses and respects retry-after", async () => {
    const events: Array<Record<string, unknown>> = [];
    let requestCount = 0;

    const ran = await withServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
      requestCount += 1;
      response.setHeader("content-type", "application/json");
      if (requestCount === 1) {
        response.statusCode = 429;
        response.setHeader("retry-after", "0.001");
        response.end(JSON.stringify({
          success: false,
          error: {
            message: "rate limited",
          },
        }));
        return;
      }

      response.end(JSON.stringify({
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
      }));
    }, async (baseUrl) => {
      const adapter = new FanslyAdapter({
        baseUrl,
        defaultDelayMs: 0,
        globalDelayMs: 0,
      });

      await expect(adapter.getAccountMe({
        session: {
          authorization: "token",
        },
        requestObserver: {
          async onRequestEvent(event: HttpRequestEvent) {
            events.push(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
          },
        },
      })).resolves.toMatchObject({
        parsed: {
          account: {
            id: "acct-1",
          },
        },
      });
    });
    if (!ran) {
      return;
    }

    expect(requestCount).toBe(2);
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
    expect(events[1]).toMatchObject({
      state: "retry",
      httpStatus: 429,
      retryDelayMs: 1,
    });
  });

  it("retries Fansly 5xx responses and succeeds on the next attempt", async () => {
    const events: Array<Record<string, unknown>> = [];
    let requestCount = 0;

    const ran = await withServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
      requestCount += 1;
      response.setHeader("content-type", "application/json");
      if (requestCount === 1) {
        response.statusCode = 500;
        response.setHeader("retry-after", "0.001");
        response.end(JSON.stringify({
          success: false,
          error: {
            message: "server exploded",
          },
        }));
        return;
      }

      response.end(JSON.stringify({
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
      }));
    }, async (baseUrl) => {
      const adapter = new FanslyAdapter({
        baseUrl,
        defaultDelayMs: 0,
        globalDelayMs: 0,
      });

      await adapter.getAccountMe({
        session: {
          authorization: "token",
        },
        requestObserver: {
          async onRequestEvent(event: HttpRequestEvent) {
            events.push(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
          },
        },
      });
    });
    if (!ran) {
      return;
    }

    expect(requestCount).toBe(2);
    expect(events.map((event) => [event.state, event.attemptNumber])).toEqual([
      ["started", 1],
      ["retry", 1],
      ["started", 2],
      ["success", 2],
    ]);
    expect(events[1]).toMatchObject({
      state: "retry",
      httpStatus: 500,
      retryDelayMs: 1,
    });
  });

  it("emits retry and success observer events for OnlyFans cursor pagination without leaking secrets", async () => {
    const events: Array<Record<string, unknown>> = [];
    let requestCount = 0;

    const ran = await withServer((_request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
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
    if (!ran) {
      return;
    }

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
