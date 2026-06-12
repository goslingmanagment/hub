// Deterministic ports of the audit B3 simulation scenarios
// (tests/audit-artifacts/sse-b3-sim.ts) against the redesigned hub: NOTIFY is a
// wake-up only and one serialized drain reads the journal forward from the
// watermark, so each scenario that reproduced a defect now asserts the contract
// holds — in-order, exactly-once, loss-free delivery.

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getMaxOfapiFanoutSeq: vi.fn(),
  listOfapiSyncEventsForReplay: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);
vi.mock("../apps/runtime/src/services/ofapi-events.ts", () => ({
  OFAPI_SYNC_EVENT_CHANNEL: "ofapi_sync_events",
}));

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createSyncEventHub,
  type SyncEventFrame,
  type SyncEventHub,
} from "../apps/runtime/src/services/events-stream.ts";

const PAGE = 7;

function frame(id: number): SyncEventFrame {
  return { id, platformAccountId: PAGE, syncEvent: { seq: id } };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

interface Harness {
  hub: SyncEventHub;
  delivered: number[];
  /** Commits a processed journal row (visible to the next drain read). */
  settle(id: number): void;
  /** Emits a LISTEN notification on the current fake connection. */
  notify(payload: string): void;
  /** Makes the next n journal reads throw (a transient pool blip). */
  failNextReads(n: number): void;
  /** Emits a connection error, dropping the LISTEN client (hub reconnects). */
  dropListen(): void;
}

function makeHarness(input: {
  baselineSeq: number;
  journal?: number[];
  onDeliver?: (frame: SyncEventFrame, harness: Harness) => void;
}): Harness {
  const journal: SyncEventFrame[] = (input.journal ?? []).map(frame);
  let failReads = 0;

  dbMocks.getMaxOfapiFanoutSeq.mockResolvedValue(input.baselineSeq);
  dbMocks.listOfapiSyncEventsForReplay.mockImplementation(
    async (_db: unknown, query: { afterSeq: number; limit: number }) => {
      if (failReads > 0) {
        failReads -= 1;
        throw new Error("transient pool blip");
      }
      return journal
        .filter((row) => row.id > query.afterSeq)
        .sort((a, b) => a.id - b.id)
        .slice(0, query.limit);
    },
  );

  const clients: Array<EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const app = {
    db: {},
    pool: {
      connect: vi.fn(async () => {
        const client = Object.assign(new EventEmitter(), {
          query: vi.fn(async () => undefined),
          release: vi.fn(),
        });
        clients.push(client);
        return client;
      }),
    },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as AppContext;

  const hub = createSyncEventHub(app);
  const delivered: number[] = [];
  const harness: Harness = {
    hub,
    delivered,
    settle: (id) => journal.push(frame(id)),
    notify: (payload) => {
      clients.at(-1)!.emit("notification", { channel: "ofapi_sync_events", payload });
    },
    failNextReads: (n) => {
      failReads = n;
    },
    dropListen: () => {
      clients.at(-1)!.emit("error", new Error("connection lost"));
    },
  };
  hub.subscribe({
    pageIds: new Set([PAGE]),
    deliver: (row) => {
      delivered.push(row.id);
      input.onDeliver?.(row, harness);
    },
  });
  return harness;
}

let activeHub: SyncEventHub | null = null;

afterEach(async () => {
  await activeHub?.close();
  activeHub = null;
  vi.clearAllMocks();
});

describe("sync event hub delivery contract (audit B3)", () => {
  // Sim scenario A: void handleNotification().catch() swallowed a transient
  // fetch error, the frame was never broadcast or retried, and once a later
  // frame advanced Last-Event-ID the strict > replay could never recover it.
  it("retries a failed journal read from the unadvanced watermark instead of losing the frame", async () => {
    const h = makeHarness({ baselineSeq: 99 });
    activeHub = h.hub;
    await h.hub.ready();

    h.settle(100);
    h.settle(101);
    h.settle(102);
    h.failNextReads(1);
    h.notify("100");

    // Nothing was delivered off the failed read, and nothing was skipped: the
    // retry drain (1s backoff) delivers the full run in order.
    await vi.waitFor(() => expect(h.delivered).toEqual([100, 101, 102]), { timeout: 4_000 });
  });

  it("delivers frames stranded by a failed read on the next wake-up, in order", async () => {
    const h = makeHarness({ baselineSeq: 99 });
    activeHub = h.hub;
    await h.hub.ready();

    h.settle(100);
    h.failNextReads(1);
    h.notify("100");
    h.settle(101);
    h.notify("101");

    // The 101 wake-up must re-read from 99, not from a watermark advanced past
    // the failed 100.
    await vi.waitFor(() => expect(h.delivered).toEqual([100, 101]));
  });

  // Sim scenarios B/B': independent per-notification fetches broadcast 101
  // before 100, losing 100 on a disconnect in the gap or duplicating 101 on
  // resume. Wake-up order must not matter.
  it("delivers in fanout-seq order exactly once regardless of notification order", async () => {
    const h = makeHarness({ baselineSeq: 99 });
    activeHub = h.hub;
    await h.hub.ready();

    h.settle(100);
    h.settle(101);
    h.notify("101");
    h.notify("100");
    h.notify("101");

    await vi.waitFor(() => expect(h.delivered).toEqual([100, 101]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.delivered).toEqual([100, 101]);
  });

  // Sim scenario C: a live NOTIFY arriving mid-catch-up bumped the shared
  // watermark to its own seq, so the next catch-up batch read past the gap and
  // frames 601..700 were skipped hub-wide.
  it("does not skip journal rows when a live wake-up arrives mid-catch-up", async () => {
    let h: Harness;
    h = makeHarness({
      baselineSeq: 100,
      journal: range(101, 700),
      onDeliver: (row) => {
        // Last frame of the first 500-row batch: a new frame settles and its
        // live wake-up lands before the second batch is read.
        if (row.id === 600) {
          h.settle(999);
          h.notify("999");
        }
      },
    });
    activeHub = h.hub;
    await h.hub.ready();

    await vi.waitFor(() => expect(h.delivered.at(-1)).toBe(999));
    expect(h.delivered).toEqual([...range(101, 700), 999]);
  });

  it("catches up through the same drain after a LISTEN drop", async () => {
    const h = makeHarness({ baselineSeq: 99 });
    activeHub = h.hub;
    await h.hub.ready();

    h.settle(100);
    h.notify("100");
    await vi.waitFor(() => expect(h.delivered).toEqual([100]));

    // Connection dies; frames settle while no LISTEN exists (their NOTIFYs are
    // lost). The reconnect's catch-up must deliver exactly the gap.
    h.dropListen();
    h.settle(101);
    h.settle(102);

    await vi.waitFor(() => expect(h.delivered).toEqual([100, 101, 102]), { timeout: 4_000 });
  });
});
