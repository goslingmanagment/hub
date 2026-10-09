// The golden-signal sampler (`ops.metrics.sample`, every minute) has two probes
// whose statement alone does not pin the plan: PostgreSQL picks a path that
// reads the table instead of the work, and both did on prod (2026-10-09, the
// job ran 68-102 s a minute). These guards keep the shape that pins the plan;
// tests/minutely-job-query-plans.integration.test.ts asserts the plans.

import { describe, expect, it } from "vitest";

import {
  CAPTURE_PENDING_AGE_PLANNER_SQL,
  CAPTURE_PENDING_AGE_SQL,
  computeGoldenSignals,
  readCapturePendingAgeMs,
} from "../apps/runtime/src/services/golden-signals.ts";
import { computeHealthFloorBacklogMs } from "../apps/runtime/src/services/health-floors.ts";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";

const DIALECT = new PgDialect();
type Query = Parameters<PgDialect["sqlToQuery"]>[0];

interface Executed {
  text: string;
  /** The transaction it ran in; null = straight on the pool. */
  tx: number | null;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function recordingDb(answer: (text: string) => Record<string, unknown>[] = () => []) {
  const executed: Executed[] = [];
  let transactions = 0;
  const executor = (tx: number | null) => async (query: Query) => {
    const text = squash(DIALECT.sqlToQuery(query).sql);
    executed.push({ text, tx });
    return { rows: answer(text), rowCount: 0 };
  };
  const db = {
    execute: executor(null),
    transaction: async <T>(body: (tx: unknown) => Promise<T>) => body({ execute: executor(++transactions) }),
  };
  return { db: db as never, executed };
}

const PLANNER = squash(DIALECT.sqlToQuery(CAPTURE_PENDING_AGE_PLANNER_SQL).sql);
const GAUGE = squash(DIALECT.sqlToQuery(CAPTURE_PENDING_AGE_SQL).sql);

describe("golden-signal plan guards", () => {
  it("the capture wedge gauge reads the unprocessed rows with bitmap scans off", () => {
    // The BRIN on processed_at cannot find nulls selectively; with bitmap
    // scans off the partial btree is the only cheap path.
    expect(PLANNER).toBe("set local enable_bitmapscan = off");
    expect(GAUGE).toContain("from ofapi_webhook_events where processed_at is null");
    expect(GAUGE).toContain("min(received_at)");
  });

  it("runs the gauge in a transaction of its own, the setting first", async () => {
    const { db, executed } = recordingDb((text) => text === GAUGE ? [{ age_ms: "1234.5" }] : []);
    expect(await readCapturePendingAgeMs(db)).toBe(1234.5);
    // SET LOCAL lasts until the transaction ends: outside one it is a no-op
    // (with a warning), and the gauge would plan through the BRIN again.
    expect(executed).toEqual([
      { text: PLANNER, tx: 1 },
      { text: GAUGE, tx: 1 },
    ]);
  });

  it("the sampler reads the unprocessed webhook rows only under that setting", async () => {
    const { db, executed } = recordingDb();
    await computeGoldenSignals({ db });
    const pendingReads = executed
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => /from ofapi_webhook_events where processed_at is null/.test(statement.text));
    expect(pendingReads).toHaveLength(1);
    for (const { statement, index } of pendingReads) {
      expect(statement.tx).not.toBeNull();
      const before = executed.slice(0, index).filter((other) => other.tx === statement.tx);
      expect(before.map((other) => other.text)).toEqual([PLANNER]);
    }
    // Nothing else the sampler runs shares that transaction: the setting must
    // never steer a probe that needs its bitmap scan (the capture window).
    const steered = executed.filter((statement) => statement.tx === pendingReads[0]!.statement.tx);
    expect(steered.map((statement) => statement.text)).toEqual([PLANNER, GAUGE]);
  });

  it("a kinds:null health floor takes its min per kind", async () => {
    const { db, executed } = recordingDb();
    await computeHealthFloorBacklogMs(db, {
      name: "obs_backlog_command_result_result_v1",
      source: "command_result",
      lane: "result",
      kinds: null,
      version: 1,
    });
    expect(executed).toHaveLength(1);
    // A bare min(received_at) is rewritten to `order by received_at limit 1`
    // over (parse_version, received_at), which walks every row of the version
    // until one of this source turns up. The grouping turns that rewrite off.
    expect(executed[0]!.text).toMatch(/select min\(o\.received_at\) as min_received from observations o where o\.parse_version = below_floor\.parse_version and o\.source = \$\d+ group by o\.kind \) pending$/);
  });
});
