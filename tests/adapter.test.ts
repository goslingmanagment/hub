import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FanslyAdapter } from "../packages/fansly/src/adapter.ts";
import { OnlyFansAdapter } from "../packages/onlyfans/src/adapter.ts";

async function withJsonServer(
  body: unknown,
  run: (baseUrl: string, requestTimes: number[]) => Promise<void>,
) {
  const requestTimes: number[] = [];
  const server = createServer((_request, response) => {
    requestTimes.push(Date.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
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
});
