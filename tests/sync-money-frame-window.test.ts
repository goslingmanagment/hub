import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbModule from "@agency_hub_core/db";
import type { Database, FanslyWsLivePayloadResolver, SyncWsWindowReceipt } from "@agency_hub_core/db";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { SYNC_MONEY_FRAME_MS, SYNC_MONEY_LOOKBACK_MS } from "../apps/runtime/src/sync/engine/alerts.ts";
import {
  createMoneyFrameWindow,
  moneyFramesMissing,
  readMoneyFrames,
  type MoneyFrame,
} from "../apps/runtime/src/sync/fansly/ws/money-frames.ts";
import { serviceFrame, wrapped } from "./helpers/fansly-ws-fixtures.ts";

// Alert 3's moving money window (`createMoneyFrameWindow`) against the full
// read (`readMoneyFrames`) over the same database at every evaluation
// instant: an in-memory model of the receipts' window statement (its floor,
// pages, `skipIds`), of the bodies and of the ledger, driven by a moving clock
// with late and back-dated receipts, late commits, late ledger rows, erased
// bodies and deleted receipts, transient body failures, page-set changes,
// clock steps and failing reads. Money news: the frames judged and the frames
// missing must be the same, step after step.

interface ModelReceipt {
  id: number;
  pageId: number;
  receivedAt: number;
  /** When its transaction commits (visible from then on). */
  visibleAt: number;
  frame: string | null;
  bodyErased: boolean;
  deleted: boolean;
}

const world = {
  now: 0,
  receipts: [] as ModelReceipt[],
  /** `${pageId}:${transactionId}` → ledger created_at. */
  ledger: new Map<string, number>(),
  failNextList: false,
  rowsReturned: 0,
};

vi.mock("@agency_hub_core/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    // The window statement of `listSyncWsReceiptsInWindow`, as the database
    // answers it at `world.now`.
    listSyncWsReceiptsInWindow: async (
      _db: Database,
      input: { from: Date; to: Date; pageIds?: readonly number[]; afterId?: number; limit: number; skipIds?: readonly number[] },
    ): Promise<SyncWsWindowReceipt[]> => {
      if (world.failNextList) {
        world.failNextList = false;
        throw new Error("connection reset");
      }
      const visible = world.receipts.filter((r) => r.visibleAt <= world.now && !r.deleted);
      const floorAt = input.from.getTime() - 1;
      const floor = Math.max(0, ...visible.filter((r) => r.receivedAt <= floorAt).map((r) => r.id));
      const skip = new Set(input.skipIds ?? []);
      const rows = visible
        .filter((r) => r.id > Math.max(input.afterId ?? 0, floor)
          && r.receivedAt >= input.from.getTime() && r.receivedAt < input.to.getTime()
          && (input.pageIds === undefined || input.pageIds.includes(r.pageId))
          && !skip.has(r.id))
        .sort((a, b) => a.id - b.id)
        .slice(0, input.limit);
      world.rowsReturned += rows.length;
      return rows.map((r) => ({
        observationId: r.id,
        pageId: r.pageId,
        receivedAt: new Date(r.receivedAt),
        ownRef: "100000000000000001",
        missing: r.bodyErased,
        payload: r.bodyErased ? null : r.frame === null ? { codec: "other" } : { codec: FANSLY_WS_CAPTURE_KIND, frame: r.frame },
        payloadRef: null,
      }));
    },
    readLedgerTransactionsCreatedAt: async (
      _db: Database,
      input: { pageId: number; transactionIds: readonly string[] },
    ): Promise<Map<string, Date>> => {
      const found = new Map<string, Date>();
      for (const id of input.transactionIds) {
        const createdAt = world.ledger.get(`${input.pageId}:${id}`);
        if (createdAt !== undefined && createdAt <= world.now) found.set(id, new Date(createdAt));
      }
      return found;
    },
  };
});

const db = {} as Database;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Deterministic random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tx = (id: string, type: number, status: number) => serviceFrame({ type: 3, transaction: { id, type, status } }, 6);
const message = (n: number) => serviceFrame({ type: 1, message: { id: `9${n}`, senderId: "200000000000000001", groupId: "300000000000000001", content: "x", createdAt: 1 } });

function frameKey(frame: MoneyFrame): string {
  return [frame.pageId, frame.observationId, frame.transactionId, frame.receivedAt.getTime(), frame.ledgerCreatedAt?.getTime() ?? "none"].join("|");
}

function missingOf(frames: readonly MoneyFrame[], now: Date) {
  return [...moneyFramesMissing(frames, now, SYNC_MONEY_FRAME_MS)]
    .map(([pageId, entry]) => `${pageId}:${entry.count}:${entry.oldestReceivedAt.getTime()}`)
    .sort();
}

beforeEach(() => {
  world.now = Date.parse("2026-11-10T00:00:00.000Z");
  world.receipts = [];
  world.ledger = new Map();
  world.failNextList = false;
  world.rowsReturned = 0;
});

describe("money frame window", () => {
  it.each([1, 2, 3, 4, 5])("judges and misses the same money frames as the full read, pass after pass (seed %i)", async (seed) => {
    const random = rng(seed);
    const window = createMoneyFrameWindow();
    let nextId = 1;
    let nextTx = 1;
    let pageIds = [1, 2, 3];
    let fullRows = 0;
    let windowRows = 0;
    let judged = 0;
    let missingSeen = 0;
    let failures = 0;
    let step = 0;
    // A transient failure of the body's store: the same answer for both reads
    // of one step, another the next step.
    const resolvePayload: FanslyWsLivePayloadResolver = async (_db, observationId, source) => {
      if ((observationId * 7919 + step * 104729) % 23 === 0) throw new Error("store unavailable");
      return source.payload;
    };

    for (step = 0; step < 600; step += 1) {
      // The clock: the evaluator's 30 s, with jitter, a rare jump and a rare step back.
      const roll = random();
      world.now += roll < 0.02 ? -Math.floor(random() * 10 * MINUTE)
        : roll < 0.04 ? Math.floor(random() * 90 * MINUTE)
        : 30 * SECOND + Math.floor((random() - 0.5) * 4 * SECOND);

      // New receipts since the last pass, of any page (pages the alert does not watch too).
      const arrivals = Math.floor(random() * 25);
      for (let i = 0; i < arrivals; i += 1) {
        const lagRoll = random();
        // Arrival lag behind `received_at`: mostly none, sometimes a buffered
        // replay of seconds, minutes, beyond the window.
        const lag = lagRoll < 0.8 ? Math.floor(random() * 500)
          : lagRoll < 0.93 ? Math.floor(random() * 30 * SECOND)
          : lagRoll < 0.98 ? Math.floor(random() * 20 * MINUTE)
          : Math.floor(random() * 90 * MINUTE);
        // Late commit: the id is taken now, the row is seen later.
        const commitDelay = random() < 0.05 ? Math.floor(random() * 3 * MINUTE) : 0;
        const pageId = 1 + Math.floor(random() * 4);
        const kind = random();
        let frame: string | null;
        if (kind < 0.12) {
          const txId = String(800000000000000000 + nextTx);
          nextTx += 1;
          const status = random() < 0.85 ? 1 : 2;
          const type = random() < 0.9 ? 2110 : 16012;
          frame = wrapped(10001, [tx(txId, type, status), ...(random() < 0.3 ? [tx(String(900000000000000000 + nextTx), 2110, 1)] : [])]);
          // The ledger: soon, late, much later, or never.
          const ledgerRoll = random();
          const ledgerAt = ledgerRoll < 0.6 ? world.now + Math.floor(random() * 2 * MINUTE)
            : ledgerRoll < 0.85 ? world.now + Math.floor(random() * 40 * MINUTE)
            : null;
          if (ledgerAt !== null) world.ledger.set(`${pageId}:${txId}`, ledgerAt);
        } else if (kind < 0.95) {
          frame = wrapped(10001, [message(nextId)]);
        } else {
          frame = kind < 0.97 ? "not a socket frame" : null;
        }
        world.receipts.push({
          id: nextId,
          pageId,
          receivedAt: world.now - lag,
          visibleAt: world.now + commitDelay,
          frame,
          bodyErased: false,
          deleted: false,
        });
        nextId += 1;
      }

      // Erasure: a body gone (the receipt stays), or the receipt deleted.
      for (const receipt of world.receipts) {
        if (receipt.receivedAt < world.now - 2 * SYNC_MONEY_LOOKBACK_MS) continue;
        const erase = random();
        if (erase < 0.003) receipt.bodyErased = true;
        else if (erase < 0.005) receipt.deleted = true;
      }

      // The watched pages change now and then (added, removed, paused).
      if (random() < 0.05) pageIds = [1, 2, 3, 4].filter(() => random() < 0.7);

      const now = new Date(world.now);
      const input = {
        from: new Date(world.now - SYNC_MONEY_LOOKBACK_MS),
        to: new Date(world.now - SYNC_MONEY_FRAME_MS),
        pageIds,
        resolvePayload,
      };

      // Any failure of the window's read resets it.
      if (random() < 0.03 && pageIds.length > 0) {
        world.failNextList = true;
        await expect(window.read(db, input)).rejects.toThrow("connection reset");
        expect(window.size).toBe(0);
        failures += 1;
      }

      world.rowsReturned = 0;
      const full = await readMoneyFrames(db, input);
      fullRows += world.rowsReturned;
      world.rowsReturned = 0;
      const incremental = await window.read(db, input);
      windowRows += world.rowsReturned;

      expect(incremental.map(frameKey).sort(), `step ${step}`).toEqual(full.map(frameKey).sort());
      expect(missingOf(incremental, now), `step ${step}`).toEqual(missingOf(full, now));

      // Memory: only receipts of the last window are held.
      const inLastWindow = world.receipts.filter((r) => r.receivedAt >= input.from.getTime() && r.receivedAt < input.to.getTime()).length;
      expect(window.size).toBeLessThanOrEqual(inLastWindow);

      judged += full.length;
      missingSeen += missingOf(full, now).length;
    }

    // The stream exercised what it is for, and the window read less.
    expect(judged).toBeGreaterThan(500);
    expect(missingSeen).toBeGreaterThan(20);
    expect(failures).toBeGreaterThan(5);
    // (A harsh stream: 12 % money and 9 % unreadable receipts, re-read on
    // every pass, and a reset every ~20 passes.)
    expect(windowRows).toBeLessThan(fullRows / 2);
  });
});
