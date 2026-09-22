import { EventEmitter } from "node:events";

import type * as DbModule from "@agency_hub_core/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DomainStreamModule from "../apps/runtime/src/services/domain-events-stream.ts";
import type * as SyncStreamModule from "../apps/runtime/src/services/events-stream.ts";

const mocks = vi.hoisted(() => {
  function hub() {
    const subscribers = new Set<unknown>();
    const unsubscribe = vi.fn();
    return {
      subscribers,
      unsubscribe,
      ready: vi.fn(async () => {}),
      subscribe: vi.fn((subscriber: unknown) => {
        subscribers.add(subscriber);
        return () => {
          unsubscribe();
          subscribers.delete(subscriber);
        };
      }),
      close: vi.fn(async () => subscribers.clear()),
    };
  }
  return {
    sync: hub(),
    domain: hub(),
    db: {
      getOfapiFanoutReplayWindow: vi.fn(),
      getMaxOfapiFanoutSeq: vi.fn(),
      getOfapiSyncReplayFloor: vi.fn(),
      listDomainEventHighWaters: vi.fn(),
      listDomainEventAccountBounds: vi.fn(),
      listDomainEventContiguousReplayEnds: vi.fn(),
      listPageOfapiAccountRefs: vi.fn(),
    },
  };
});

vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...mocks.db,
}));
vi.mock("../apps/runtime/src/services/events-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof SyncStreamModule>()),
  createSyncEventHub: () => mocks.sync,
}));
vi.mock("../apps/runtime/src/services/domain-events-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof DomainStreamModule>()),
  createDomainEventHub: () => mocks.domain,
}));

import { registerEventsRoutes } from "../apps/runtime/src/modules/events/index.ts";

beforeEach(() => {
  vi.clearAllMocks();
  for (const read of Object.values(mocks.db)) read.mockReset();
  mocks.sync.subscribers.clear();
  mocks.domain.subscribers.clear();
  mocks.db.getOfapiFanoutReplayWindow.mockResolvedValue({ latestSeq: 1, oldestRetainedSeq: 1 });
  mocks.db.getMaxOfapiFanoutSeq.mockResolvedValue(1);
  mocks.db.getOfapiSyncReplayFloor.mockResolvedValue(0);
  mocks.db.listDomainEventHighWaters.mockResolvedValue(new Map([[7, 1]]));
  mocks.db.listDomainEventAccountBounds.mockResolvedValue(new Map([[7, {
    accountId: 7, oldestRetainedSeq: 1, currentSeq: 1,
  }]]));
  mocks.db.listDomainEventContiguousReplayEnds.mockResolvedValue(new Map([[7, 1]]));
  mocks.db.listPageOfapiAccountRefs.mockResolvedValue(new Map([[7, "account-7"]]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(["v1", "v2"] as const)("%s SSE route subscription cleanup", (lane) => {
  it.each(["boundary", "after-boundary"] as const)("unsubscribes once when the %s read fails", async (failureAt) => {
    const failure = new Error("database read failed");
    const read = lane === "v1"
      ? failureAt === "boundary" ? mocks.db.getOfapiFanoutReplayWindow : mocks.db.getOfapiSyncReplayFloor
      : failureAt === "boundary" ? mocks.db.listDomainEventAccountBounds : mocks.db.listDomainEventContiguousReplayEnds;
    // The first call validates the cursor before subscribing. The second is
    // either the helper's boundary read or the route's next read after it.
    const defaultImplementation = read.getMockImplementation()!;
    read.mockImplementationOnce(defaultImplementation).mockRejectedValueOnce(failure);

    const routes = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
    const closeHooks: Array<() => Promise<void>> = [];
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    registerEventsRoutes({
      get(path: string, _options: unknown, handler: (request: unknown, reply: unknown) => Promise<unknown>) {
        routes.set(path, handler);
      },
      addHook(_name: string, hook: () => Promise<void>) {
        closeHooks.push(hook);
      },
    } as unknown as Parameters<typeof registerEventsRoutes>[0], {
      appContext: { db: {}, pool: {}, logger },
      auth: {
        requirePrincipal: async () => ({
          authMethod: "device_token", deviceTokenId: 1, assignedPageIds: [7],
          user: { role: "chatter" },
        }),
      },
      boss: null,
    } as unknown as Parameters<typeof registerEventsRoutes>[1]);

    const requestRaw = Object.assign(new EventEmitter(), { destroyed: false });
    const raw = {
      writableEnded: false,
      destroyed: false,
      writableLength: 0,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(() => {
        raw.destroyed = true;
        requestRaw.emit("close");
      }),
    };
    const hub = lane === "v1" ? mocks.sync : mocks.domain;
    try {
      const path = lane === "v1" ? "/api/v1/events/stream" : "/api/v1/events/v2/stream";
      await routes.get(path)!({
        headers: {}, cookies: {}, query: lane === "v1" ? { lastEventId: 1 } : {},
        raw: requestRaw, log: logger,
      }, { hijack: vi.fn(), raw });

      expect(read).toHaveBeenCalledTimes(2);
      expect(hub.subscribe).toHaveBeenCalledTimes(1);
      expect(raw.destroy).toHaveBeenCalledTimes(1);
      expect(requestRaw.listenerCount("close")).toBe(0);
      // Check before server shutdown: close() clears the hub's entire Set and
      // would hide a leaked per-request subscriber from this regression test.
      expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
      expect(hub.subscribers.size).toBe(0);
    } finally {
      for (const close of closeHooks) await close();
    }
  });
});
