import { EventEmitter } from "node:events";

import { domainEventFrameSchema, encodeDomainEventCursor } from "@agency_hub_core/contracts";
import type * as DbModule from "@agency_hub_core/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getAccountHighWater: vi.fn(),
  getMaxOfapiFanoutSeq: vi.fn(),
  getOfapiSyncReplayFloor: vi.fn(),
  getDomainEventErasureEpoch: vi.fn(),
  listDomainEventAccountBounds: vi.fn(),
  listDomainEventContiguousReplayEnds: vi.fn(),
  listDomainEventHighWaters: vi.fn(),
  listDomainEventRecoveryRetainedCounts: vi.fn(),
  listEventsSince: vi.fn(),
  listPageOfapiAccountRefs: vi.fn(),
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  DOMAIN_EVENTS_APPENDED_CHANNEL: "domain_events_appended",
  ...dbMocks,
}));

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { registerEventsRoutes } from "../apps/runtime/src/modules/events/index.ts";
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

function event(accountSeq: number, currentAccountRef: string | null = null) {
  return {
    id: accountSeq,
    accountId: 7,
    currentAccountRef,
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

interface ParsedStreamFrame {
  lane: "domain" | "control";
  id: string;
  event: Record<string, unknown>;
}

/** Every `event: domain` frame must satisfy the PUBLISHED contract schema —
 * the vendored SDK hard-fails the whole subscription on any frame that does
 * not (sdk-runtime `frame_validation_failed`), so a manual JSON.parse here
 * would let a contract-breaking frame pass the tests. */
function parseStreamFrames(writes: string[]): ParsedStreamFrame[] {
  return writes.join("").split("\n\n").flatMap((block): ParsedStreamFrame[] => {
    const lines = block.split("\n");
    const lane = lines.includes("event: domain")
      ? "domain" as const
      : lines.includes("event: control")
        ? "control" as const
        : null;
    if (lane === null) {
      return [];
    }
    const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (id === undefined || data === undefined) {
      throw new Error(`Incomplete ${lane} frame: ${block}`);
    }
    const json: unknown = JSON.parse(data);
    if (lane === "domain") {
      const parsed = domainEventFrameSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`domain frame violates the contract schema: ${parsed.error.message}`);
      }
      return [{ lane, id, event: parsed.data as unknown as Record<string, unknown> }];
    }
    return [{ lane, id, event: json as Record<string, unknown> }];
  });
}

async function runV2Stream(input: {
  cursor: string | null;
  rows: number[];
  head: number;
  /** Seed the live hub watermark (listDomainEventHighWaters) — 0 lets a NOTIFY
   * during the stream re-deliver every row through the live lane. */
  liveWatermark?: number;
  /** Ledger head as the live hub sees it AFTER connect (bounds calls #2+);
   * defaults to `head`. A higher value models an append racing the replay. */
  liveHead?: number;
  /** Page mapping read with each ledger row. Different values prove a remap
   * can be surfaced within one open connection. */
  currentAccountRefForSeq?: (accountSeq: number) => string | null;
  /** Legacy per-connection mapping mock. Tests can make it deliberately stale
   * to prove domain frames no longer use it. */
  snapshottedAccountRef?: string | null;
  /** Fresh mapping used only by the synthetic snapshot-recovery completion
   * frame. Undefined means the stream is not expected to take that path. */
  completionAccountRef?: string | null;
  /** Called once the (gated) replay query is pending; resolves to release it. */
  duringReplay?: (harness: {
    /** Emits a NOTIFY on every captured LISTEN connection (the route keeps
     * separate clients for the v1 fanout and the domain hub; handlers filter
     * by channel themselves). */
    notifyDomainEvents: (payload: string) => void;
    writes: string[];
  }) => Promise<void>;
  /** End the response from inside the replay query (closed-stream race). */
  endDuringReplay?: boolean;
}) {
  const writes: string[] = [];
  const raw = {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  raw.write.mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  raw.end.mockImplementation(() => {
    raw.writableEnded = true;
  });
  raw.destroy.mockImplementation(() => {
    raw.destroyed = true;
  });
  const listenClients: EventEmitter[] = [];
  let replayQuerySeen = false;
  dbMocks.getMaxOfapiFanoutSeq.mockResolvedValue(0);
  dbMocks.getOfapiSyncReplayFloor.mockResolvedValue(0);
  dbMocks.getDomainEventErasureEpoch.mockResolvedValue({ epoch: 9, incomplete: false });
  dbMocks.listDomainEventHighWaters.mockResolvedValue(
    new Map([[7, input.liveWatermark ?? input.head]]),
  );
  dbMocks.listDomainEventAccountBounds.mockImplementation(async () => new Map([[7, {
    accountId: 7,
    oldestRetainedSeq: input.rows[0] ?? null,
    // Connect-time calls (cursor checks + replay boundary) all precede the
    // replay query; only the live hub drain — triggered by a NOTIFY emitted
    // while that query is gated — may observe the newer racing head.
    currentSeq: replayQuerySeen ? (input.liveHead ?? input.head) : input.head,
  }]]));
  // The live hub drain reads the counter head only (never the bounds).
  dbMocks.getAccountHighWater.mockImplementation(async () => (
    replayQuerySeen ? (input.liveHead ?? input.head) : input.head
  ));
  dbMocks.listDomainEventContiguousReplayEnds.mockResolvedValue(new Map([[7, input.head]]));
  dbMocks.listDomainEventRecoveryRetainedCounts.mockResolvedValue(
    new Map([[7, input.rows.length]]),
  );
  dbMocks.listEventsSince.mockImplementation(
    async (_db: unknown, query: { afterSeq: number; throughSeq: number; limit: number }) => {
      // The FIRST query is the connection's replay read (the hub live lane
      // only queries after a NOTIFY, which the tests emit later).
      const isReplayQuery = !replayQuerySeen;
      replayQuerySeen = true;
      if (isReplayQuery && input.endDuringReplay) {
        raw.end();
      }
      if (isReplayQuery && input.duringReplay !== undefined) {
        await input.duringReplay({
          notifyDomainEvents: (payload: string) => {
            for (const client of listenClients) {
              client.emit("notification", {
                channel: "domain_events_appended",
                payload,
              });
            }
          },
          writes,
        });
      }
      return input.rows
        .filter((seq) => seq > query.afterSeq && seq <= query.throughSeq)
        .slice(0, query.limit)
        .map((seq) => event(seq, input.currentAccountRefForSeq?.(seq) ?? null));
    },
  );
  const initialAccountRefs = input.snapshottedAccountRef == null
    ? new Map<number, string>()
    : new Map([[7, input.snapshottedAccountRef]]);
  dbMocks.listPageOfapiAccountRefs.mockResolvedValue(initialAccountRefs);
  if (input.completionAccountRef !== undefined) {
    dbMocks.listPageOfapiAccountRefs
      .mockResolvedValueOnce(initialAccountRefs)
      .mockResolvedValueOnce(
        input.completionAccountRef === null
          ? new Map()
          : new Map([[7, input.completionAccountRef]]),
      );
  }

  const listenClient = () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => undefined),
      release: vi.fn(),
    });
    listenClients.push(client);
    return client;
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const appContext = {
    db: {},
    pool: { connect: vi.fn(async () => listenClient()) },
    logger,
  } as unknown as AppContext;
  const principal = {
    authMethod: "session",
    user: {
      id: 1,
      username: "owner",
      role: "owner",
      assignedPages: [],
      mustChangePassword: false,
    },
    assignedPageIds: [],
  } as const;

  type RouteHandler = (request: unknown, reply: unknown) => Promise<unknown>;
  const routes = new Map<string, RouteHandler>();
  const closeHooks: Array<() => Promise<void>> = [];
  const server = {
    addHook: (_name: string, hook: unknown) => {
      closeHooks.push(hook as () => Promise<void>);
    },
    get: (path: string, _options: unknown, handler: unknown) => {
      routes.set(path, handler as RouteHandler);
    },
  };
  registerEventsRoutes(
    server as unknown as Parameters<typeof registerEventsRoutes>[0],
    {
      appContext,
      auth: { requirePrincipal: vi.fn(async () => principal) },
      boss: null,
    } as unknown as Parameters<typeof registerEventsRoutes>[1],
  );

  const requestRaw = Object.assign(new EventEmitter(), { destroyed: false });
  const handler = routes.get("/api/v1/events/v2/stream");
  if (handler === undefined) {
    throw new Error("v2 stream route was not registered");
  }

  try {
    await handler({
      headers: {},
      cookies: {},
      query: input.cursor === null ? {} : { cursor: input.cursor },
      log: logger,
      raw: requestRaw,
    }, {
      hijack: vi.fn(),
      raw,
    });
    // The buffered-live flush rides the connection's liveChain promise —
    // give queued microtasks a chance to write before the stream closes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    requestRaw.emit("close");
    for (const close of closeHooks) {
      await close();
    }
  }

  return parseStreamFrames(writes);
}

async function makeLiveHarness(
  rows: number[], head: number, eventForSeq: (seq: number) => ReturnType<typeof event> = event,
) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => undefined),
    release: vi.fn(),
  });
  dbMocks.listDomainEventHighWaters.mockResolvedValue(new Map([[7, 0]]));
  dbMocks.getAccountHighWater.mockResolvedValue(head);
  dbMocks.listDomainEventAccountBounds.mockResolvedValue(new Map([[7, {
    accountId: 7,
    oldestRetainedSeq: rows[0] ?? null,
    currentSeq: head,
  }]]));
  dbMocks.listEventsSince.mockImplementation(
    async (_db: unknown, input: { afterSeq: number; throughSeq: number; limit: number }) => rows
      .filter((seq) => seq > input.afterSeq && seq <= input.throughSeq)
      .slice(0, input.limit)
      .map(eventForSeq),
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
  it("keeps legacy earnings visible and hides only checkpointed v2 earnings live", async () => {
    const harness = await makeLiveHarness([1, 2, 3, 4], 4, (seq) => ({
      ...event(seq),
      type: seq < 3 ? "fan.earnings_observed" : seq === 3 ? "stream.projection_checkpoint" : "message.created",
      schemaVersion: seq === 2 ? 2 : 1,
      data: seq === 3 ? { hiddenCount: 1 } : {},
    }));
    hub = harness.created;
    await vi.waitFor(() => expect(harness.delivered).toEqual([1, 3, 4]));
    expect(harness.continuityLosses).toEqual([]);
  });

  it("reads the live head from the counter only, never the retention bounds (diag 2026-09-11)", async () => {
    const h = await makeLiveHarness([1, 2], 2);
    hub = h.created;
    await vi.waitFor(() => expect(h.delivered).toEqual([1, 2]));
    expect(dbMocks.getAccountHighWater).toHaveBeenCalledWith({}, 7);
    expect(dbMocks.listDomainEventAccountBounds).not.toHaveBeenCalled();
  });

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

describe("domain event v2 replay completion", () => {
  it("writes every replayed domain frame before the replay-completed control marker", async () => {
    const frames = await runV2Stream({
      cursor: encodeDomainEventCursor(new Map([[7, 0]])),
      rows: [1, 2],
      head: 2,
    });

    const markerIndex = frames.findIndex(
      (frame) => frame.lane === "control" && frame.event["type"] === "replay_completed",
    );
    const replayed = frames.filter((frame) => frame.lane === "domain");
    expect(replayed.length).toBeGreaterThan(0);
    expect(markerIndex).toBeGreaterThan(0);
    expect(replayed.every((frame) => frames.indexOf(frame) < markerIndex)).toBe(true);
    expect(frames[markerIndex]?.event).toEqual({ type: "replay_completed" });
    // The marker's id is contract-documented as a resume-safe cursor: it must
    // repeat the delivered watermark (all replayed rows), not a zero/genesis
    // cursor that would force a full re-replay or a 409 on reconnect.
    expect(frames[markerIndex]?.id).toBe(encodeDomainEventCursor(new Map([[7, 2]])));
  });

  it("writes the replay-completed marker immediately on a fresh connection", async () => {
    const frames = await runV2Stream({ cursor: null, rows: [1, 2], head: 2 });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.lane).toBe("control");
    expect(frames[0]?.event).toEqual({ type: "replay_completed" });
    // On a cursor-less connect the marker is the FIRST (and on a quiet page
    // the only) id a client sees — it must already encode the account heads
    // (grant-scoped: fresh connects mint the bound v3 cursor).
    expect(frames[0]?.id).toBe(
      encodeDomainEventCursor(new Map([[7, 2]]), { scope: 'granted' }),
    );
  });

  it("flushes a remapped live frame after replay with its per-row current account ref", async () => {
    const frames = await runV2Stream({
      cursor: encodeDomainEventCursor(new Map([[7, 0]])),
      rows: [1, 2, 3],
      // Replay ceiling (account bounds at connect) stops at 2 — row 3 exists
      // only in the live lane, exactly like an append racing the replay.
      head: 2,
      liveHead: 3,
      liveWatermark: 0,
      snapshottedAccountRef: "acct_connection_snapshot",
      currentAccountRefForSeq: (seq) => seq <= 2 ? "acct_replay" : "acct_live_remapped",
      // While the replay query is pending, a NOTIFY delivers rows through the
      // live hub lane; replayDone is false, so the connection must buffer
      // them and flush strictly after the control marker.
      duringReplay: async ({ notifyDomainEvents }) => {
        notifyDomainEvents("7:changed");
        for (let tick = 0; tick < 5; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
    });

    const markerIndex = frames.findIndex((frame) => frame.lane === "control");
    expect(markerIndex).toBeGreaterThan(0);
    const domainSeqs = frames
      .filter((frame) => frame.lane === "domain")
      .map((frame) => ({
        seq: frame.event["accountSeq"] as number,
        accountRef: frame.event["accountRef"] as string | null,
        index: frames.indexOf(frame),
      }));
    // Replay wrote 1..2 before the marker; the buffered live row 3 (delivered
    // during replay) must come after it, exactly once.
    expect(domainSeqs.filter((f) => f.index < markerIndex).map((f) => f.seq)).toEqual([1, 2]);
    expect(domainSeqs.filter((f) => f.index > markerIndex).map((f) => f.seq)).toEqual([3]);
    expect(domainSeqs.map(({ seq, accountRef }) => ({ seq, accountRef }))).toEqual([
      { seq: 1, accountRef: "acct_replay" },
      { seq: 2, accountRef: "acct_replay" },
      { seq: 3, accountRef: "acct_live_remapped" },
    ]);
    // One connection-time read remains for the owner-only ephemeral page set;
    // the deliberately stale value above did not stamp either domain lane.
    expect(dbMocks.listPageOfapiAccountRefs).toHaveBeenCalledTimes(1);
  });

  it("refreshes the account ref for the synthetic snapshot-recovery completion frame", async () => {
    const cursor = encodeDomainEventCursor(new Map([[7, 0]]), {
      recovery: {
        kind: "snapshot",
        erasureEpoch: 9,
        base: new Map([[7, 0]]),
        targets: new Map([[7, 2]]),
        retainedCounts: new Map([[7, 2]]),
      },
    });
    const frames = await runV2Stream({
      cursor,
      rows: [1, 2],
      head: 2,
      snapshottedAccountRef: "acct_connection_snapshot",
      completionAccountRef: "acct_fresh_completion",
      currentAccountRefForSeq: () => "acct_fresh_completion",
    });

    const completion = frames.find(
      (frame) => frame.lane === "domain"
        && frame.event["type"] === "stream.snapshot_replay_completed",
    );
    expect(completion?.event["accountRef"]).toBe("acct_fresh_completion");
    expect(dbMocks.listPageOfapiAccountRefs).toHaveBeenCalledTimes(2);
  });

  // On the ordinary replay path a dead stream exits through the pre-existing
  // check before the marker block, so this case proves end-to-end behavior
  // (no marker, no extra reads, no throw).
  it("stops all stream work without throwing when the connection died during replay", async () => {
    const frames = await runV2Stream({
      cursor: encodeDomainEventCursor(new Map([[7, 0]])),
      rows: [1, 2],
      head: 2,
      endDuringReplay: true,
    });

    expect(frames.filter((frame) => frame.lane === "control")).toHaveLength(0);
    // The handler must bail after the one replay read — a dead connection
    // never pays for further batches.
    expect(dbMocks.listEventsSince).toHaveBeenCalledTimes(1);
  });
});
