import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  listDomainEventAccountBounds: vi.fn(),
  listDomainEventHighWaters: vi.fn(),
  listEventsSince: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => ({
  DOMAIN_EVENTS_APPENDED_CHANNEL: "domain_events_appended",
  ...dbMocks,
}));

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createAccountSeqGuards,
  createDomainEventHub,
  type DomainEventHub,
} from "../apps/runtime/src/services/domain-events-stream.ts";

let hub: DomainEventHub | null = null;

afterEach(async () => {
  await hub?.close();
  hub = null;
  vi.clearAllMocks();
});

describe("domain event hub readiness", () => {
  it("fails ready closed while the initial LISTEN and baseline are unavailable", async () => {
    const app = {
      db: {},
      pool: {
        connect: vi.fn().mockRejectedValue(new Error("LISTEN unavailable")),
      },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as AppContext;
    hub = createDomainEventHub(app);
    hub.subscribe({ accountIds: new Set([7]), deliver: () => undefined });

    await expect(hub.ready()).rejects.toThrow("LISTEN unavailable");
    expect(dbMocks.listDomainEventHighWaters).not.toHaveBeenCalled();
  });
});

function event(accountSeq: number) {
  return {
    id: accountSeq,
    accountId: 7,
    accountSeq,
    type: "message.created",
    occurredAt: new Date("2026-07-13T00:00:00.000Z"),
    fanIdentityRef: null,
    conversationRef: null,
    messageRef: null,
    transactionRef: null,
    data: {},
    schemaVersion: 1,
    observationId: accountSeq,
    dedupKey: `event-${accountSeq}`,
    createdAt: new Date("2026-07-13T00:00:00.000Z"),
  };
}

async function makeLiveHarness(rows: number[], head: number) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => undefined),
    release: vi.fn(),
  });
  dbMocks.listDomainEventHighWaters.mockResolvedValue(new Map([[7, 0]]));
  dbMocks.listDomainEventAccountBounds.mockResolvedValue(new Map([[7, {
    accountId: 7,
    oldestRetainedSeq: rows[0] ?? null,
    currentSeq: head,
  }]]));
  dbMocks.listEventsSince.mockImplementation(
    async (_db: unknown, input: { afterSeq: number; throughSeq: number; limit: number }) => rows
      .filter((seq) => seq > input.afterSeq && seq <= input.throughSeq)
      .slice(0, input.limit)
      .map(event),
  );
  const app = {
    db: {},
    pool: { connect: vi.fn(async () => client) },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext;
  const created = createDomainEventHub(app);
  const delivered: number[] = [];
  const continuityLosses: Array<[number, number, number]> = [];
  let accepting = true;
  created.subscribe({
    accountIds: new Set([7]),
    continuityLost: (accountId, afterSeq, throughSeq) => {
      continuityLosses.push([accountId, afterSeq, throughSeq]);
      accepting = false;
    },
    deliver: (row) => {
      if (accepting) {
        delivered.push(row.accountSeq);
      }
    },
  });
  await created.ready();
  client.emit("notification", { channel: "domain_events_appended", payload: "7:changed" });
  return { created, delivered, continuityLosses };
}

describe("domain event hub live continuity", () => {
  it("detects an internal retained-ledger hole before broadcasting a later row", async () => {
    const h = await makeLiveHarness([1, 3], 3);
    hub = h.created;
    await vi.waitFor(() => expect(h.continuityLosses).toEqual([[7, 0, 3]]));
    expect(h.delivered).toEqual([]);
  });

  it("detects a missing tail when the counter head is beyond the last returned row", async () => {
    const h = await makeLiveHarness([1], 2);
    hub = h.created;
    await vi.waitFor(() => expect(h.continuityLosses).toEqual([[7, 0, 2]]));
    expect(h.delivered).toEqual([]);
  });

  it("keeps a per-connection cursor unchanged when a jump is observed", () => {
    const guards = createAccountSeqGuards(new Map([[7, 1]]));
    expect(guards.advance(7, 3)).toEqual({ deliver: false, gap: true });
    expect(guards.watermarks().get(7)).toBe(1);
  });

  it("advances across only the exact projection checkpoint range", () => {
    const guards = createAccountSeqGuards(new Map([[7, 10]]));
    expect(guards.advanceProjectionCheckpoint(7, 13, 2)).toEqual({
      deliver: true,
      gap: false,
    });
    expect(guards.watermarks().get(7)).toBe(13);

    const rejected = createAccountSeqGuards(new Map([[7, 10]]));
    expect(rejected.advanceProjectionCheckpoint(7, 13, 1)).toEqual({
      deliver: false,
      gap: true,
    });
    expect(rejected.watermarks().get(7)).toBe(10);
  });
});
