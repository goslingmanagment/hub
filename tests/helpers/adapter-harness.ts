import { createRequire } from "node:module";

import { vi } from "vitest";

import type { HttpRequestEvent } from "@agency_hub_core/shared";

type MockDispatcher = {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  label: string;
};

function createDispatcher(label: string): MockDispatcher {
  return {
    label,
    close: vi.fn(async () => undefined),
  };
}

export function toJsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

export function fanslyAccountResponse() {
  return toJsonResponse({
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
  });
}

export function fanslyTransactionsResponse() {
  return toJsonResponse({
    success: true,
    response: {
      total: 0,
      data: [],
    },
  });
}

export function fanslyFollowersResponse() {
  return toJsonResponse({
    success: true,
    response: {
      followers: [{
        id: "follow-1",
        followerId: "fan-1",
      }],
      aggregationData: {
        accounts: [],
      },
    },
  });
}

export function onlyFansAccountsResponse() {
  return toJsonResponse({
    accounts: [{
      id: 11,
      platform_account_id: "acct-11",
      username: "lana",
      name: "Lana",
    }],
  });
}

export async function loadAdapters() {
  vi.resetModules();

  vi.doMock("node:timers/promises", () => ({
    setTimeout: (delayMs: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }),
  }));

  const directDispatchers: MockDispatcher[] = [];
  const proxyDispatchers: MockDispatcher[] = [];
  const adapterRequire = createRequire(new URL("../../packages/fansly/src/adapter.ts", import.meta.url));
  const undiciModule = adapterRequire("undici") as {
    fetch: (...args: unknown[]) => Promise<unknown>;
  };
  const fetchMock = vi.spyOn(undiciModule, "fetch");

  const httpClientModule = await import("../../packages/shared/src/http-client.ts");
  const createRequestDispatcher = vi.spyOn(httpClientModule, "createRequestDispatcher")
    .mockImplementation(() => {
      const dispatcher = createDispatcher(`direct-${directDispatchers.length}`);
      directDispatchers.push(dispatcher);
      return dispatcher as never;
    });
  const createProxyRequestDispatcher = vi.spyOn(httpClientModule, "createProxyRequestDispatcher")
    .mockImplementation(() => {
      const dispatcher = createDispatcher(`proxy-${proxyDispatchers.length}`);
      proxyDispatchers.push(dispatcher);
      return dispatcher as never;
    });

  const { FanslyAdapter, POST_BATCH_SIZE } = await import("../../packages/fansly/src/adapter.ts");

  return {
    FanslyAdapter,
    POST_BATCH_SIZE,
    createProxyRequestDispatcher,
    createRequestDispatcher,
    directDispatchers,
    fetchMock,
    proxyDispatchers,
  };
}

export function captureEvents() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    requestObserver: {
      async onRequestEvent(event: HttpRequestEvent) {
        events.push(JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
      },
    },
  };
}

export function cleanupAdapterHarness() {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("node:timers/promises");
}
