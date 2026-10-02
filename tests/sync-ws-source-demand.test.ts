import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type { Database } from "@agency_hub_core/db";

import type * as ProbeContextModule from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { noopMetrics, systemClock } from "../apps/runtime/src/sync/engine/ports.ts";
import type { DemandSignal } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_WS_SOURCE_TIMING, FanslyWsSource } from "../apps/runtime/src/sync/fansly/ws/source.ts";
import { quietLogger, testConfig } from "./helpers/sync-engine-host.ts";

// The socket source's `ws.connect` demand survives a database blip (plan §9:
// demand is kept while the database is unavailable). Nothing but the source
// ever asks for the page's connection, so a write the database refused is
// written again — the same demand, the same due time — while the source holds
// the page's socket lock and has no connection, until one write lands; a
// retry leaves a running `ws.connect` step alone (that step is the
// connection). The socket lock, the credentials generation and the open work
// are stand-ins; `tests/sync-ws-source.integration.test.ts` runs the same
// against the production host and a refusing database.

const fake = vi.hoisted(() => ({
  /** The state of the page's open `ws.connect` work (null: none). */
  connectWork: null as null | "open" | "running",
}));

vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  // The socket lock is held at once, on a session that stays alive.
  acquireFanslyWsOwnership: async () => ({ db: {}, alive: true, close: async () => undefined }),
  isFanslyWsGenerationBlocked: async () => false,
  getOpenWorkForKey: async () => (fake.connectWork === null ? null : { state: fake.connectWork }),
}));

vi.mock("../apps/runtime/src/services/egress/fansly-probe-context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeContextModule>()),
  readProbeGeneration: async () => "generation-1",
}));

const RECHECK_MS = 20;

function source(enqueue: (signals: readonly DemandSignal[]) => Promise<void>): FanslyWsSource {
  return new FanslyWsSource({
    db: {} as Database,
    config: testConfig("postgres://unused"),
    logger: quietLogger,
    clock: systemClock,
    metrics: noopMetrics,
    connectionString: "postgres://unused",
    pageId: 5,
    pageLabel: "page-5",
    enqueue,
    timing: { ...FANSLY_WS_SOURCE_TIMING, recheckMs: RECHECK_MS },
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("the socket source's ws.connect demand", () => {
  it("a write the database refused is written again, the same demand and due time, until one lands — then no more", async () => {
    fake.connectWork = null;
    const writes: DemandSignal[] = [];
    let refuse = 2;
    const ws = source(async (signals) => {
      writes.push(...signals);
      if (refuse > 0) {
        refuse -= 1;
        throw new Error("injected database blip");
      }
    });
    ws.start();
    try {
      await until(() => writes.length >= 3, "the third write");
      // Ten more re-check periods: the written demand is not written again.
      await sleep(10 * RECHECK_MS);
      expect(writes).toHaveLength(3);
      const first = writes[0]!;
      expect(first).toMatchObject({ resource: "ws.connect", params: { failures: 0 }, demand: { reason: "ws_start" } });
      expect(writes).toEqual([first, first, first]);
      expect(ws.state).toBe("owning");
    } finally {
      await ws.stop("disabled");
    }
  });

  it("a retry leaves a running ws.connect step alone", async () => {
    fake.connectWork = null;
    const writes: DemandSignal[] = [];
    let refuse = true;
    const ws = source(async (signals) => {
      writes.push(...signals);
      if (refuse) {
        // The write's outcome is unknown to the source; the work it asked
        // for is running (or another row of the key is).
        fake.connectWork = "running";
        throw new Error("injected database blip");
      }
    });
    ws.start();
    try {
      await until(() => writes.length === 1, "the first write");
      await sleep(10 * RECHECK_MS);
      expect(writes).toHaveLength(1);
      // The step ended without its Upgrade: the demand is still wanted.
      refuse = false;
      fake.connectWork = null;
      await until(() => writes.length === 2, "the second write");
      expect(writes[1]).toEqual(writes[0]);
    } finally {
      await ws.stop("disabled");
    }
  });

  it("a stopped source no longer writes a demand the database keeps refusing", async () => {
    fake.connectWork = null;
    const writes: DemandSignal[] = [];
    const ws = source(async (signals) => {
      writes.push(...signals);
      throw new Error("injected database outage");
    });
    ws.start();
    await until(() => writes.length >= 3, "three refused writes");
    await ws.stop("disabled");
    const written = writes.length;
    await sleep(10 * RECHECK_MS);
    expect(writes).toHaveLength(written);
    expect(ws.state).toBe("stopped");
  });
});
