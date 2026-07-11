// W8 / E5 (A22, decision #133): the pre-f8c4409 idempotency collision
// re-journal. Multi-fetch chunks journaled every fetch under one
// chunk-constant key, so only the FIRST observation of a chunk survived —
// the raw fetches all live in sync_raw_payloads. The campaign re-journals
// the missing observations verbatim under producer 'rejournal:a22' with
// per-raw-row keys: dry-run first, append-only, idempotent, and the
// canonicalize sweep then consumes the rows (domain_event_keys dedup makes
// repeats no-ops).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  insertObservation,
  listEventsSince,
  startSyncRun,
} from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  E5_COLLISION_WINDOW,
  REJOURNAL_PRODUCER,
  runObservationsRejournal,
} from "../apps/runtime/src/services/observations-rejournal.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

const IN_WINDOW = new Date("2026-07-06T10:00:00Z");

// Extension-proven earnings row shapes (mills).
const STATS_PAYLOAD = [
  { correlationAccountId: "fan-rj-1", type: 2110, totalGross: 10_000, totalNet: 8_000 },
];
const MONTHLY_PAYLOAD = [
  { correlationAccountId: "fan-rj-1", year: 2026, month: 6, type: 2110, totalGross: 3_000, totalNet: 2_400 },
];

async function insertRawPayloadRow(input: {
  pageId: number;
  syncRunId: number;
  requestSeq: number;
  endpoint: string;
  payload: unknown;
  capturedAt: Date;
}) {
  await testDb!.pool.query(
    `insert into sync_raw_payloads
       (page_id, sync_run_id, stream, request_seq, source, endpoint, request_params,
        response_payload, mapper_version, payload_kind, captured_at, retain_until)
     values ($1, $2, 'fan_earnings', $3, 'scheduled', $4, '{}'::jsonb,
             $5::jsonb, 'test-mapper', 'mapping_critical', $6, now() + interval '100 years')`,
    [input.pageId, input.syncRunId, input.requestSeq, input.endpoint,
      JSON.stringify(input.payload), input.capturedAt],
  );
}

async function seedCollisionCorpus() {
  const db = testDb!.db;
  const model = await createModel(db, { slug: "rj-model", name: "RJ" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(db, { modelId: model.id, label: "rj-fansly" });
  if (!page) throw new Error("page seed failed");

  // Chunk A (COLLIDED, pre-fix): stats + monthly journaled under ONE
  // chunk-constant key — only the stats observation survived.
  const runA = await startSyncRun(db, {
    platformAccountId: page.id, stream: "fan_earnings", trigger: "scheduled",
  });
  if (!runA) throw new Error("run seed failed");
  await insertRawPayloadRow({
    pageId: page.id, syncRunId: runA.id, requestSeq: 7,
    endpoint: "fan_earnings_stats", payload: STATS_PAYLOAD, capturedAt: IN_WINDOW,
  });
  await insertRawPayloadRow({
    pageId: page.id, syncRunId: runA.id, requestSeq: 7,
    endpoint: "fan_earnings_monthly", payload: MONTHLY_PAYLOAD, capturedAt: IN_WINDOW,
  });
  await insertObservation(db, {
    source: "pull",
    producer: "sync:fansly:fan_earnings",
    platform: "fansly",
    accountId: page.id,
    kind: "fan_earnings_stats",
    payload: STATS_PAYLOAD,
    payloadHash: Buffer.alloc(32),
    idempotencyKey: `${page.id}:fan_earnings:${runA.id}:7`, // the OLD chunk-constant key
  });

  // Chunk B (HEALTHY, post-fix): both fetches journaled under per-fetch keys.
  const runB = await startSyncRun(db, {
    platformAccountId: page.id, stream: "fan_earnings", trigger: "scheduled",
  });
  if (!runB) throw new Error("run seed failed");
  await insertRawPayloadRow({
    pageId: page.id, syncRunId: runB.id, requestSeq: 8,
    endpoint: "fan_earnings_stats", payload: STATS_PAYLOAD, capturedAt: IN_WINDOW,
  });
  await insertRawPayloadRow({
    pageId: page.id, syncRunId: runB.id, requestSeq: 8,
    endpoint: "fan_earnings_monthly", payload: MONTHLY_PAYLOAD, capturedAt: IN_WINDOW,
  });
  await insertObservation(db, {
    source: "pull", producer: "sync:fansly:fan_earnings", platform: "fansly",
    accountId: page.id, kind: "fan_earnings_stats", payload: STATS_PAYLOAD,
    payloadHash: Buffer.alloc(32), idempotencyKey: `${page.id}:fan_earnings:${runB.id}:8.1`,
  });
  await insertObservation(db, {
    source: "pull", producer: "sync:fansly:fan_earnings", platform: "fansly",
    accountId: page.id, kind: "fan_earnings_monthly", payload: MONTHLY_PAYLOAD,
    payloadHash: Buffer.alloc(32), idempotencyKey: `${page.id}:fan_earnings:${runB.id}:8.2`,
  });

  return { page, runA, runB };
}

async function observationCount(): Promise<number> {
  const result = await testDb!.pool.query<{ n: string }>(
    "select count(*)::text as n from observations",
  );
  return Number(result.rows[0]!.n);
}

describe("observations:rejournal-collisions (E5/A22)", () => {
  it("dry-run reports the swallowed fetch per stream and writes NOTHING", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedCollisionCorpus();
    const before = await observationCount();

    const dry = await runObservationsRejournal(appStub(), { dryRun: true });
    // Collided chunk: 2 raws / 1 observation; healthy chunk: 2 raws / 2.
    expect(dry.dryRun).toBe(true);
    expect(dry.window.from).toBe(E5_COLLISION_WINDOW.from.toISOString());
    expect(dry.groupsScanned).toBe(2);
    expect(dry.perStream.fan_earnings).toEqual({
      rawFetches: 4,
      observed: 3,
      missing: 1,
      rejournaled: 0,
      alreadyRejournaled: 0,
    });
    expect(await observationCount()).toBe(before);
  });

  it("write mode re-journals the missing fetch verbatim; re-runs are no-ops; the sweep consumes it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page, runA } = await seedCollisionCorpus();

    const write = await runObservationsRejournal(appStub(), { dryRun: false });
    expect(write.perStream.fan_earnings).toMatchObject({
      missing: 1,
      rejournaled: 1,
      alreadyRejournaled: 0,
    });

    // The re-journaled observation: verbatim payload, provenance producer,
    // fresh per-raw-row key — the swallowed fan_earnings_monthly fetch of
    // chunk A.
    const row = await testDb.pool.query<{
      kind: string; platform: string; account_id: string; payload: unknown; idempotency_key: string;
    }>(
      "select kind, platform, account_id::text, payload, idempotency_key from observations where producer = $1",
      [REJOURNAL_PRODUCER],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      kind: "fan_earnings_monthly",
      platform: "fansly",
      account_id: String(page.id),
    });
    expect(row.rows[0]!.payload).toEqual(MONTHLY_PAYLOAD);
    expect(row.rows[0]!.idempotency_key.startsWith(`${REJOURNAL_PRODUCER}:`)).toBe(true);
    void runA;

    // Idempotence: the campaign re-run writes nothing new.
    const again = await runObservationsRejournal(appStub(), { dryRun: false });
    expect(again.perStream.fan_earnings).toMatchObject({
      missing: 1,
      rejournaled: 0,
      alreadyRejournaled: 1,
    });

    // Capture-first payoff: the sweep canonicalizes the re-journaled fetch —
    // the monthly window's fan.earnings_observed exists now.
    const sweep = await runCanonicalization(appStub());
    expect(sweep.errored).toBe(0);
    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    const windows = events
      .filter((event) => event.type === "fan.earnings_observed")
      .map((event) => (event.data as { window: string }).window)
      .sort();
    expect(windows).toContain("2026-06"); // from the re-journaled monthly fetch
    expect(windows).toContain("lifetime"); // from the surviving stats twin

    // And repeats stay no-ops end to end (domain_event_keys dedup).
    const sweepAgain = await runCanonicalization(appStub(), { belowParseVersion: 99 });
    expect(sweepAgain.appended).toBe(0);
  });
});
