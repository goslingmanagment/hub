// G5 slice 3c-2, end to end: the ~35 GB already on disk becomes addressable,
// gets proved, and then physically goes away — with every destructive step
// refusing until it has been given a reason not to.
//
// The seam under test is the real machinery: the same `putPayloadObject` the
// live capture path uses, the same partition DDL production will run, the same
// swap transaction. Six properties carry the slice and every case below is one
// of them:
//
//   1. HISTORICAL BODIES LAND IN THEIR TRUE MONTH. A July row's object is a
//      July object, in a catalog partition that did not exist until the
//      backfill created it — not a row filed under whatever month the operator
//      happened to run the command in.
//   2. THE DEDUP IS THE POINT. Two envelopes carrying the same bytes collapse
//      onto ONE object; that collapse is the whole reason the project exists.
//   3. A BODY THE CODEC REFUSES KEEPS ITS INLINE COPY FOREVER, and the
//      verification says so instead of pretending the scope is clean.
//   4. VERIFY REFUSES ANYTHING IT CANNOT ACCOUNT FOR. An unreferenced row with
//      an encodable body is an unfinished backfill, and no amount of a previous
//      run's bookkeeping makes it a blessing.
//   5. THE SWAP IS ATOMIC. Either the old partition is attached or the new one
//      is; a crash in between leaves the old one, because PostgreSQL rolls the
//      whole transaction back.
//   6. NOTHING IS DESTROYED WITHOUT THE OWNER SAYING THE EXACT NAME.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  censusCaptureRewriteScope,
  createFanslyPage,
  createModel,
  insertObservation,
  latestSettledCaptureRewriteRun,
} from "@agency_hub_core/db";

import {
  runCaptureBackfill as runCaptureBackfillService,
  runCaptureVerifyBackfill,
} from "../apps/runtime/src/services/capture-rewrite/index.ts";
import {
  measureSyncRawPayloadsCompact,
} from "../apps/runtime/src/services/capture-rewrite/measure.ts";
import {
  listCaptureParkedRelations,
  runCaptureDropParked,
  runCaptureReclaim,
} from "../apps/runtime/src/services/capture-rewrite/reclaim.ts";
import { CAPTURE_PARKING_SCHEMA } from "../apps/runtime/src/services/capture-rewrite/scope.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { waitForRelationLockWait } from "./helpers/lock-waits.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (!testDb) {
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  // TRUNCATE does not drop, and neither a parked copy nor a half-built shadow
  // lives in a table the reset knows about. Clear both so each case starts from
  // the real pre-slice shape.
  await testDb.pool.query(`drop schema if exists ${CAPTURE_PARKING_SCHEMA} cascade`);
  const strays = await testDb.pool.query<{ relname: string }>(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like '%\\_\\_skinny'
  `);
  for (const row of strays.rows) {
    await testDb.pool.query(`drop table if exists "${row.relname}" cascade`);
  }
});

/**
 * The backfill's §9.1 admission gate (#223) reads the real volume. Every case
 * below except the headroom ones is about the WALK, not about the disk, so they
 * go through this wrapper and the gate sees a fixed generous figure instead of
 * whatever the CI runner happens to have free. The headroom cases pass their
 * own reader — which is also the point of that seam existing rather than a
 * `--assume-free-bytes` an executed run could use.
 */
const AMPLE_FREE_BYTES = 1024 ** 4;

function runCaptureBackfill(
  app: Parameters<typeof runCaptureBackfillService>[0],
  options: Parameters<typeof runCaptureBackfillService>[1],
) {
  return runCaptureBackfillService(app, {
    readFreeBytes: async () => AMPLE_FREE_BYTES,
    ...options,
  });
}

const MONTH = "2026-07";
const PARTITION = "observations_2026_07";
const SCOPE = { table: "observations" as const, month: MONTH };
const RAW_SCOPE = { table: "sync_raw_payloads" as const, month: null };
const JULY = (day: number) => new Date(Date.UTC(2026, 6, day, 12, 0, 0));

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as never;
}

async function seedPage(label: string) {
  const model = await createModel(testDb!.db, { slug: `m-${label}`, name: label });
  if (!model) throw new Error("model");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error("page");
  return page;
}

async function seedObservation(input: {
  pageId: number;
  payload: unknown;
  key: string;
  day: number;
  producer?: string;
  kind?: string;
}) {
  return insertObservation(testDb!.db, {
    source: "pull",
    producer: input.producer ?? "sync:fansly:dm_messages",
    platform: "fansly",
    accountId: input.pageId,
    kind: input.kind ?? "dm_messages",
    payload: input.payload,
    payloadHash: createHash("sha256").update(JSON.stringify(input.payload)).digest(),
    idempotencyKey: input.key,
    receivedAt: JULY(input.day),
  });
}

/**
 * A body PostgreSQL stores happily and the frozen codec refuses.
 *
 * `1e999` is a legal JSON number and a legal jsonb `numeric`; node-postgres
 * parses it back with `JSON.parse`, which yields `Infinity`, and the codec
 * refuses a non-finite number because it has no JSON form to round-trip
 * through. It has to be inserted as raw SQL — `insertObservation` stringifies
 * its input, and `JSON.stringify(Infinity)` is `null`, which would canonicalize
 * perfectly well and prove nothing.
 */
async function seedCodecRefusingObservation(pageId: number, key: string) {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    `insert into observations (
       source, producer, platform, account_id, kind, payload, payload_hash,
       idempotency_key, received_at
     ) values (
       'pull', 'sync:fansly:dm_messages', 'fansly', $1, 'dm_messages',
       '{"n": 1e999}'::jsonb, $2, $3, $4
     ) returning id::text as id`,
    [pageId, createHash("sha256").update("refused").digest(), key, JULY(4).toISOString()],
  );
  return Number(rows[0]!.id);
}

/** The corpus every case starts from: 3 distinct bodies, 1 duplicated body
 *  (2 rows, 1 object) and 1 body the codec refuses. 6 rows, 4 objects. */
async function seedJulyCorpus(pageId: number) {
  const shared = { messages: [{ id: "shared", content: "same bytes" }] };
  await seedObservation({ pageId, payload: { a: 1 }, key: "k1", day: 1 });
  await seedObservation({ pageId, payload: { b: 2 }, key: "k2", day: 2 });
  await seedObservation({ pageId, payload: { c: 3 }, key: "k3", day: 3 });
  await seedObservation({ pageId, payload: shared, key: "k4", day: 3 });
  await seedObservation({ pageId, payload: shared, key: "k5", day: 3 });
  const refusedId = await seedCodecRefusingObservation(pageId, "k6");
  return { refusedId };
}

async function partitionExists(name: string) {
  const { rows } = await testDb!.pool.query<{ found: string | null }>(
    "select to_regclass($1)::text as found",
    [name],
  );
  return rows[0]?.found != null;
}

async function isAttachedToObservations(name: string) {
  const { rows } = await testDb!.pool.query<{ attached: boolean }>(
    `select exists (
       select 1 from pg_inherits i
       join pg_class p on p.oid = i.inhparent
       join pg_class c on c.oid = i.inhrelid
       where p.relname = 'observations' and c.relname = $1
     ) as attached`,
    [name],
  );
  return rows[0]?.attached === true;
}

async function blessScope(scope: typeof SCOPE | typeof RAW_SCOPE) {
  const verify = await runCaptureVerifyBackfill(appStub(), { scope, sample: 100 });
  expect(verify.refusals).toEqual([]);
  expect(verify.verdict).toBe("ok");
  return verify;
}

// ---------------------------------------------------------------------------

describe("A — capture:backfill", () => {
  it("dry-run counts what it would touch and writes nothing at all", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("bf-dry");
    await seedJulyCorpus(page.id);

    const result = await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: true,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
    });

    expect(result.census.rows).toBe(6);
    expect(result.census.unreferencedWithBody).toBe(6);
    expect(result.referenced).toBe(0);
    expect(result.runId).toBeNull();

    // A dry run leaves no tombstone: an act that did not happen must not be
    // readable later as one that did.
    const journal = await testDb.pool.query("select * from capture_rewrite_runs");
    expect(journal.rowCount).toBe(0);
    const census = await censusCaptureRewriteScope(testDb.db, SCOPE);
    expect(census.referenced).toBe(0);
  });

  it("files historical bodies under their OWN month, creating the catalog partition", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("bf-month");
    await seedJulyCorpus(page.id);

    // 0123 pre-created 2026-08 onwards; July is exactly the month production
    // data starts in and the one the migration never made.
    expect(await partitionExists("capture_payload_objects_2026_07")).toBe(false);

    const result = await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 2,
      pauseMs: 0,
      maxBatches: 0,
    });

    expect(result.monthsCreated).toEqual(["2026-07-01"]);
    expect(await partitionExists("capture_payload_objects_2026_07")).toBe(true);
    expect(await partitionExists("capture_json_hot_bodies_2026_07")).toBe(true);

    const months = await testDb.pool.query<{ m: string }>(
      "select distinct to_char(bucket_month, 'YYYY-MM') as m from capture_payload_objects",
    );
    expect(months.rows.map((row) => row.m)).toEqual(["2026-07"]);
  });

  it("dedups two envelopes carrying identical bytes onto ONE object", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("bf-dedup");
    await seedJulyCorpus(page.id);

    const result = await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
    });

    expect(result.referenced).toBe(5);
    expect(result.deduped).toBe(1);

    const objects = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from capture_payload_objects",
    );
    expect(Number(objects.rows[0]!.n)).toBe(4);

    // The duplicated pair points at the SAME object id.
    const paired = await testDb.pool.query<{ n: string }>(
      `select count(distinct payload_object_id)::text as n from observations
       where idempotency_key in ('k4', 'k5')`,
    );
    expect(Number(paired.rows[0]!.n)).toBe(1);
  });

  it("leaves a codec-refused row untouched, counts it and names its id", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("bf-refuse");
    const { refusedId } = await seedJulyCorpus(page.id);

    const result = await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
    });

    expect(result.codecRefused).toBe(1);
    expect(result.codecRefusedIds).toEqual([refusedId]);

    const row = await testDb.pool.query<{ has_body: boolean; object_id: string | null }>(
      `select (payload is not null) as has_body, payload_object_id::text as object_id
       from observations where id = $1`,
      [refusedId],
    );
    expect(row.rows[0]).toEqual({ has_body: true, object_id: null });
  });

  it("populates the slice-3a typed columns on the same pass", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("bf-typed");
    await seedObservation({
      pageId: page.id,
      producer: "desktop-harvest@1",
      kind: "harvest.fan_transactions",
      payload: { machineId: "machine-9", row: { tx_id: "tx-1", amount: "12.50", created_at: "x" } },
      key: "h1",
      day: 5,
    });

    await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
    });

    const row = await testDb.pool.query<{
      harvest_machine_id: string | null;
      harvest_tx_id: string | null;
      harvest_tx_amount: string | null;
    }>(
      `select harvest_machine_id, harvest_tx_id, harvest_tx_amount from observations
       where idempotency_key = 'h1'`,
    );
    expect(row.rows[0]).toEqual({
      harvest_machine_id: "machine-9",
      harvest_tx_id: "tx-1",
      harvest_tx_amount: "12.50",
    });
  });

  it("is resumable: --limit stops it, a re-run finishes what is left", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("bf-resume");
    await seedJulyCorpus(page.id);

    const first = await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 2,
      pauseMs: 0,
      maxBatches: 1,
    });
    expect(first.stoppedBecause).toBe("batch_limit");
    expect(first.referenced).toBe(2);

    const second = await runCaptureBackfill(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
    });
    // The predicate IS the resume point: the two already-stamped rows are not
    // scanned again.
    expect(second.scanned).toBe(4);
    expect(second.referenced).toBe(3);
    expect(second.stoppedBecause).toBe("scope_complete");

    const census = await censusCaptureRewriteScope(testDb.db, SCOPE);
    expect(census.referenced).toBe(5);
    expect(census.unreferencedWithBody).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Decision #223, finding 1 — THE COHORT THE REFERENCE SCAN CANNOT SEE.
//
// Rows captured between the slice-1 deployment (references, #215) and the
// slice-3a one (typed columns, #218) carry a reference AND null typed columns.
// The reference scan excludes them by construction — its predicate is
// `payload_object_id is null` — and the typed columns' only population lived
// inside the reference-stamping UPDATE, so nothing in the system could fill
// them. `null-bodies` would then remove the body their CAS-INLINE-FALLBACK arms
// read through.
//
// The fixture is that exact shape, reached the honest way: back-fill normally,
// then null the typed column, which leaves a row indistinguishable from one
// captured in the gap.

describe("A2 — the typed-column catch-up (#223)", () => {
  async function seedRawDmPage(label: string, count: number) {
    const page = await seedPage(label);
    for (let index = 0; index < count; index += 1) {
      await testDb!.pool.query(
        `insert into sync_raw_payloads (
           page_id, endpoint, request_params, response_payload, mapper_version,
           payload_kind, captured_at, retain_until
         ) values ($1, 'dm_messages', '{}'::jsonb, $2::jsonb, 'v1', 'dm_messages', $3, $4)`,
        [
          page.id,
          JSON.stringify({ tips: [{ id: `t${index}`, message: "note" }], messages: [] }),
          JULY(1 + index).toISOString(),
          new Date(Date.UTC(2126, 0, 1)).toISOString(),
        ],
      );
    }
    return page;
  }

  /** The pre-0125 shape: a reference, a body, and no typed column. */
  async function stripTypedColumns(table: "sync_raw_payloads" | "observations") {
    await testDb!.pool.query(
      table === "sync_raw_payloads"
        ? "update sync_raw_payloads set response_tips = null"
        : `update observations set harvest_machine_id = null, harvest_tx_id = null,
             harvest_tx_amount = null, harvest_tx_created_at = null`,
    );
  }

  it("fills a referenced row's tips slice that the reference scan cannot reach", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedRawDmPage("catchup-raw", 3);
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await stripTypedColumns("sync_raw_payloads");

    // The census SEES them even though the reference scan cannot.
    const before = await censusCaptureRewriteScope(testDb.db, RAW_SCOPE);
    expect(before.referenced).toBe(3);
    expect(before.unreferencedWithBody).toBe(0);
    expect(before.typedColumnGaps).toBe(3);

    const result = await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });

    // Nothing to reference — this is the whole point: the first walk finds no
    // work at all and the second one does all of it.
    expect(result.referenced).toBe(0);
    expect(result.typedColumnsScanned).toBe(3);
    expect(result.typedColumnsFilled).toBe(3);

    const filled = await testDb.pool.query<{ tips: unknown }>(
      "select response_tips as tips from sync_raw_payloads order by id asc",
    );
    expect(filled.rows.map((row) => row.tips)).toEqual([
      { tips: [{ id: "t0", message: "note" }] },
      { tips: [{ id: "t1", message: "note" }] },
      { tips: [{ id: "t2", message: "note" }] },
    ]);
    expect((await censusCaptureRewriteScope(testDb.db, RAW_SCOPE)).typedColumnGaps).toBe(0);
    void page;
  });

  it("fills an observation's harvest columns the same way", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("catchup-obs");
    await seedObservation({
      pageId: page.id,
      producer: "desktop-harvest@1",
      kind: "harvest.fan_transactions",
      payload: { machineId: "machine-9", row: { tx_id: "tx-1", amount: "12.50", created_at: "x" } },
      key: "h-catchup",
      day: 5,
    });
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await stripTypedColumns("observations");
    expect((await censusCaptureRewriteScope(testDb.db, SCOPE)).typedColumnGaps).toBe(1);

    const result = await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    expect(result.typedColumnsFilled).toBe(1);

    const row = await testDb.pool.query<{
      harvest_machine_id: string | null;
      harvest_tx_id: string | null;
      harvest_tx_amount: string | null;
      harvest_tx_created_at: string | null;
    }>(
      `select harvest_machine_id, harvest_tx_id, harvest_tx_amount, harvest_tx_created_at
       from observations where idempotency_key = 'h-catchup'`,
    );
    expect(row.rows[0]).toEqual({
      harvest_machine_id: "machine-9",
      harvest_tx_id: "tx-1",
      harvest_tx_amount: "12.50",
      harvest_tx_created_at: "x",
    });
  });

  it("does NOT chase rows whose bodies legitimately derive to nothing", async (context) => {
    if (!testDb) return context.skip();
    // The predicate has to be selective or it matches the whole corpus and the
    // gate below refuses forever: an ordinary DM capture has no harvest members
    // and an ordinary observation is not a harvest row at all.
    const page = await seedPage("catchup-quiet");
    await seedJulyCorpus(page.id);
    await testDb.pool.query(
      `insert into sync_raw_payloads (
         page_id, endpoint, request_params, response_payload, mapper_version,
         payload_kind, captured_at, retain_until
       ) values ($1, 'transactions', '{}'::jsonb, '{"rows": []}'::jsonb, 'v1', 'transactions', $2, $3)`,
      [page.id, JULY(2).toISOString(), new Date(Date.UTC(2126, 0, 1)).toISOString()],
    );
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });

    expect((await censusCaptureRewriteScope(testDb.db, SCOPE)).typedColumnGaps).toBe(0);
    expect((await censusCaptureRewriteScope(testDb.db, RAW_SCOPE)).typedColumnGaps).toBe(0);
  });

  it("REFUSES null-bodies while a typed column its body would fill is empty", async (context) => {
    if (!testDb) return context.skip();
    await seedRawDmPage("catchup-gate", 2);
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await blessScope(RAW_SCOPE);
    await stripTypedColumns("sync_raw_payloads");

    const refused = await runCaptureReclaim(appStub(), {
      scope: RAW_SCOPE,
      phase: "null-bodies",
      dryRun: false,
      confirm: undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
    });
    expect(refused.verdict).toBe("refused");
    expect(refused.refusals.join(" ")).toMatch(/slice-3a typed column their body would fill/);
    // Refused means NOTHING was touched: the bodies are all still there.
    const intact = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where response_payload is not null",
    );
    expect(Number(intact.rows[0]!.n)).toBe(2);

    // The catch-up is the remedy the refusal names — and running it OVERTAKES
    // the verify verdict, exactly as any other backfill does (#221's freshness
    // law), so the ritual's re-verify step is not optional after a catch-up.
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    const stale = await runCaptureReclaim(appStub(), {
      scope: RAW_SCOPE,
      phase: "null-bodies",
      dryRun: false,
      confirm: undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
    });
    expect(stale.verdict).toBe("refused");
    expect(stale.refusals.join(" ")).toMatch(/finished AFTER the verify verdict/);

    await blessScope(RAW_SCOPE);
    const allowed = await runCaptureReclaim(appStub(), {
      scope: RAW_SCOPE,
      phase: "null-bodies",
      dryRun: false,
      confirm: undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
    });
    expect(allowed.refusals).toEqual([]);
    expect(allowed.detail.nulled).toBe(2);

    // And the tip sidecar the reclaim would have destroyed is still readable —
    // this is the fact the whole finding is about.
    const tips = await testDb.pool.query<{ tips: unknown }>(
      "select response_tips as tips from sync_raw_payloads order by id asc limit 1",
    );
    expect(tips.rows[0]!.tips).toEqual({ tips: [{ id: "t0", message: "note" }] });
  });

  it("REFUSES the observations shadow phase for the same reason", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("catchup-shadow");
    await seedObservation({
      pageId: page.id,
      producer: "desktop-harvest@1",
      kind: "harvest.messages",
      payload: { machineId: "machine-77" },
      key: "h-shadow",
      day: 6,
    });
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await blessScope(SCOPE);
    await stripTypedColumns("observations");

    const refused = await runCaptureReclaim(appStub(), {
      scope: SCOPE,
      phase: "shadow",
      dryRun: false,
      confirm: undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
      now: new Date(Date.UTC(2026, 7, 15)),
    });
    expect(refused.verdict).toBe("refused");
    expect(refused.refusals.join(" ")).toMatch(/slice-3a typed column their body would fill/);
    // The shadow relation was never created: a refusal touches nothing.
    expect(await partitionExists("observations_2026_07__skinny")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Decision #223, finding 3 — THE HEADROOM LAW NOW RUNS BEFORE THE GROWTH.
//
// `capture:backfill` writes a full catalog copy of every body it walks and a
// second heap tuple per stamped row, and it had no admission check of any kind:
// the observation law was first asked at `shadow` and the raw one only AFTER
// `null-bodies`, i.e. after the bytes were already on the volume.

describe("A3 — the backfill's admission gate (#223)", () => {
  it("REFUSES to start under the floor, and writes nothing at all", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("headroom-preflight");
    await seedJulyCorpus(page.id);

    const result = await runCaptureBackfillService(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
      readFreeBytes: async () => 1024,
    });

    expect(result.stoppedBecause).toBe("refused");
    expect(result.headroom?.ok).toBe(false);
    expect(result.refusals.join(" ")).toMatch(/§9\.1 headroom/);
    expect(result.referenced).toBe(0);
    expect((await censusCaptureRewriteScope(testDb.db, SCOPE)).referenced).toBe(0);
    const objects = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from capture_payload_objects",
    );
    expect(Number(objects.rows[0]!.n)).toBe(0);

    // An EXECUTED invocation that refused still leaves a tombstone — unlike a
    // dry run, it happened, and "I was asked and I said no" is evidence.
    const run = await latestSettledCaptureRewriteRun(testDb.db, {
      operation: "backfill",
      scope: SCOPE,
    });
    expect(run?.verdict).toBe("refused");
  });

  it("STOPS mid-walk when free space reaches the floor, and resumes later", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("headroom-midrun");
    // 30 rows at batch 1: the walk re-checks every 10 batches, so it admits the
    // run generously and then hits a volume that filled up under it.
    for (let index = 0; index < 30; index += 1) {
      await seedObservation({
        pageId: page.id,
        payload: { index },
        key: `mid-${index}`,
        day: 1 + (index % 20),
      });
    }

    let reads = 0;
    const result = await runCaptureBackfillService(appStub(), {
      scope: SCOPE,
      dryRun: false,
      batch: 1,
      pauseMs: 0,
      maxBatches: 0,
      readFreeBytes: async () => {
        reads += 1;
        // The pre-flight read is ample; the first mid-run re-check is not.
        return reads === 1 ? AMPLE_FREE_BYTES : 1024;
      },
    });

    expect(result.stoppedBecause).toBe("headroom_exhausted");
    expect(result.refusals.join(" ")).toMatch(/floor this slice keeps clear/);
    // It stopped WHERE IT STOOD rather than unwinding: the work already done is
    // kept, which is what makes "re-run, it resumes" true.
    expect(result.referenced).toBe(10);
    expect((await censusCaptureRewriteScope(testDb.db, SCOPE)).referenced).toBe(10);

    const resumed = await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    expect(resumed.referenced).toBe(20);
    expect(resumed.stoppedBecause).toBe("scope_complete");
    expect((await censusCaptureRewriteScope(testDb.db, SCOPE)).unreferencedWithBody).toBe(0);
  });

  it("reports the verdict in a dry run without opening a journal row", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("headroom-dry");
    await seedJulyCorpus(page.id);

    const result = await runCaptureBackfillService(appStub(), {
      scope: SCOPE,
      dryRun: true,
      batch: 10,
      pauseMs: 0,
      maxBatches: 0,
      readFreeBytes: async () => 1024,
    });

    expect(result.stoppedBecause).toBe("refused");
    expect(result.headroom?.ok).toBe(false);
    const journal = await testDb.pool.query("select * from capture_rewrite_runs");
    expect(journal.rowCount).toBe(0);
  });
});

describe("C2 — §9.2 headroom moves in front of null-bodies (#223)", () => {
  it("REFUSES null-bodies on the inequality instead of discovering it at vacuum-full",
    async (context) => {
      if (!testDb) return context.skip();
      const page = await seedPage("headroom-null");
      for (let index = 0; index < 3; index += 1) {
        await testDb.pool.query(
          `insert into sync_raw_payloads (
             page_id, endpoint, request_params, response_payload, mapper_version,
             payload_kind, captured_at, retain_until
           ) values ($1, 'dm_messages', '{}'::jsonb, $2::jsonb, 'v1', 'dm_messages', $3, $4)`,
          [
            page.id,
            JSON.stringify({ tips: [], messages: [{ id: `m${index}` }] }),
            JULY(1 + index).toISOString(),
            new Date(Date.UTC(2126, 0, 1)).toISOString(),
          ],
        );
      }
      await runCaptureBackfill(appStub(), {
        scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
      });
      await blessScope(RAW_SCOPE);

      const refused = await runCaptureReclaim(appStub(), {
        scope: RAW_SCOPE,
        phase: "null-bodies",
        dryRun: false,
        confirm: undefined,
        batch: 100,
        pauseMs: 0,
        lockTimeoutMs: 3000,
        freeBytesOverride: 1,
      });
      expect(refused.verdict).toBe("refused");
      expect(refused.refusals.join(" ")).toMatch(/§9\.2 headroom/);
      expect(refused.refusals.join(" ")).toMatch(/before the UPDATEs/);
      // The refusal is BEFORE the mutation: every body is still inline.
      const intact = await testDb.pool.query<{ n: string }>(
        "select count(*)::text as n from sync_raw_payloads where response_payload is not null",
      );
      expect(Number(intact.rows[0]!.n)).toBe(3);
    });
});

describe("B — capture:verify-backfill", () => {
  it("blesses a finished scope and reports the refused row it accounted for", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("vf-ok");
    await seedJulyCorpus(page.id);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });

    const verify = await runCaptureVerifyBackfill(appStub(), { scope: SCOPE, sample: 100 });

    expect(verify.verdict).toBe("ok");
    expect(verify.refusals).toEqual([]);
    expect(verify.provedCodecRefused).toBe(1);
    expect(verify.unexplainedUnreferenced).toBe(0);
    expect(verify.danglingRefs).toBe(0);
    expect(verify.backfillReportedRefused).toBe(1);
    expect(verify.sample.mismatched).toBe(0);
    expect(verify.sample.compared).toBeGreaterThan(0);
    expect(verify.sample.matched).toBe(verify.sample.compared);

    const settled = await latestSettledCaptureRewriteRun(testDb.db, {
      operation: "verify",
      scope: SCOPE,
    });
    expect(settled?.verdict).toBe("ok");
  });

  it("REFUSES a scope with an unreferenced row whose body is perfectly encodable", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("vf-null");
    await seedJulyCorpus(page.id);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    // A row that arrives after the backfill: exactly the shape a crashed or
    // half-run backfill leaves behind.
    await seedObservation({ pageId: page.id, payload: { late: true }, key: "late", day: 6 });

    const verify = await runCaptureVerifyBackfill(appStub(), { scope: SCOPE, sample: 100 });

    expect(verify.verdict).toBe("refused");
    expect(verify.unexplainedUnreferenced).toBe(1);
    expect(verify.refusals.join(" ")).toMatch(/ENCODABLE body and no reference/);
    // The stored count from the earlier run is REPORTED and did not decide
    // anything: it still says 1, and the verdict is refused anyway.
    expect(verify.backfillReportedRefused).toBe(1);
  });

  it("REFUSES a scope with a reference that resolves to nothing", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("vf-dangle");
    await seedJulyCorpus(page.id);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await testDb.pool.query(
      `update observations set payload_object_id = 999999
       where idempotency_key = 'k1'`,
    );

    const verify = await runCaptureVerifyBackfill(appStub(), { scope: SCOPE, sample: 100 });
    expect(verify.verdict).toBe("refused");
    expect(verify.danglingRefs).toBe(1);
    expect(verify.refusals.join(" ")).toMatch(/does not exist/);
  });

  it("REFUSES when a sampled body no longer matches its catalog copy", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("vf-drift");
    await seedObservation({ pageId: page.id, payload: { a: 1 }, key: "d1", day: 1 });
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await testDb.pool.query(
      `update capture_json_hot_bodies set body = '{"a": 2}'::jsonb`,
    );

    const verify = await runCaptureVerifyBackfill(appStub(), { scope: SCOPE, sample: 20 });
    expect(verify.verdict).toBe("refused");
    expect(verify.sample.mismatched).toBeGreaterThan(0);
    expect(verify.sample.mismatches[0]!.reason).toBe("content_mismatch");
  });
});

describe("C — capture:reclaim, observations", () => {
  async function backfilledAndBlessed(label: string) {
    const page = await seedPage(label);
    const seeded = await seedJulyCorpus(page.id);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await blessScope(SCOPE);
    return { page, ...seeded };
  }

  const reclaim = (over: Partial<Parameters<typeof runCaptureReclaim>[1]> = {}) =>
    runCaptureReclaim(appStub(), {
      scope: SCOPE,
      phase: "shadow",
      dryRun: false,
      confirm: undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
      ...over,
    });

  it("builds a skinny shadow: inline null where a ref exists, body kept where refused", async (context) => {
    if (!testDb) return context.skip();
    const { refusedId } = await backfilledAndBlessed("rc-shadow");

    const result = await reclaim({ phase: "shadow" });
    expect(result.refusals).toEqual([]);
    expect(result.verdict).toBe("ok");
    expect(result.detail.copiedRows).toBe(6);

    const shadow = await testDb.pool.query<{
      total: string;
      with_body: string;
      refused_has_body: boolean;
    }>(`
      select count(*)::text as total,
             count(*) filter (where payload is not null)::text as with_body,
             bool_or(payload is not null) filter (where id = $1) as refused_has_body
      from "observations_2026_07__skinny"
    `, [refusedId]);
    // 6 rows come across; exactly the one the codec refused keeps its body,
    // because for that row the inline column is the only copy there is.
    expect(shadow.rows[0]).toEqual({ total: "6", with_body: "1", refused_has_body: true });

    // The source is untouched — the shadow phase takes no lock on it and
    // removes nothing from it.
    const source = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from "${PARTITION}" where payload is not null`,
    );
    expect(Number(source.rows[0]!.n)).toBe(6);
  });

  it("the shadow copy is resumable and re-runs are idempotent", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-resume");

    await reclaim({ phase: "shadow", batch: 2 });
    const first = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from "observations_2026_07__skinny"`,
    );
    expect(Number(first.rows[0]!.n)).toBe(6);

    const again = await reclaim({ phase: "shadow", batch: 2 });
    expect(again.verdict).toBe("ok");
    const second = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from "observations_2026_07__skinny"`,
    );
    expect(Number(second.rows[0]!.n)).toBe(6);
  });

  it("swaps the twin in under the partition's own name and parks the original", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-swap");
    await reclaim({ phase: "shadow" });

    const swap = await reclaim({ phase: "swap", confirm: PARTITION });
    expect(swap.refusals).toEqual([]);
    expect(swap.verdict).toBe("ok");

    // The attached partition still carries the canonical name — the tiering
    // regex, the replay guards and the erasure's parked scan all read it.
    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    const live = await testDb.pool.query<{ total: string; with_body: string }>(
      `select count(*)::text as total,
              count(*) filter (where payload is not null)::text as with_body
       from "${PARTITION}"`,
    );
    expect(live.rows[0]).toEqual({ total: "6", with_body: "1" });

    // Reading through the PARENT sees the same rows: the attach really happened.
    const viaParent = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from observations
       where received_at >= '2026-07-01' and received_at < '2026-08-01'`,
    );
    expect(Number(viaParent.rows[0]!.n)).toBe(6);

    const parked = await listCaptureParkedRelations(appStub());
    expect(parked).toHaveLength(1);
    expect(parked[0]!.relation).toMatch(/^observations_2026_07__pre_g5_\d{14}$/);
    expect(parked[0]!.rows).toBe(6);
    expect(parked[0]!.parkedAt).not.toBeNull();
  });

  it("the swap demands the exact partition name in --confirm", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-confirm");
    await reclaim({ phase: "shadow" });

    for (const confirm of [undefined, "observations", "observations_2026_08", ""]) {
      const attempt = await reclaim({ phase: "swap", confirm });
      expect(attempt.verdict, String(confirm)).toBe("refused");
      expect(attempt.refusals.join(" ")).toMatch(/--confirm must be the exact partition name/);
    }
    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    expect(await listCaptureParkedRelations(appStub())).toHaveLength(0);
  });

  it("REFUSES the current month — its partition is still being written", async (context) => {
    if (!testDb) return context.skip();
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const result = await runCaptureReclaim(appStub(), {
      scope: { table: "observations", month: currentMonth },
      phase: "shadow",
      dryRun: true,
      confirm: undefined,
      batch: 10,
      pauseMs: 0,
      lockTimeoutMs: 3000,
    });
    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/CURRENT UTC month/);
  });

  it("REFUSES §9.1's headroom inequality", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-headroom");

    const result = await reclaim({ phase: "shadow", freeBytesOverride: 1024 });
    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/§9\.1 headroom/);
    // Refused means NOTHING happened, not "happened and then complained".
    expect(await partitionExists("observations_2026_07__skinny")).toBe(false);
  });

  it("REFUSES without a fresh verify blessing", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("rc-unblessed");
    await seedJulyCorpus(page.id);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });

    const noVerify = await reclaim({ phase: "shadow" });
    expect(noVerify.verdict).toBe("refused");
    expect(noVerify.refusals.join(" ")).toMatch(/no settled capture:verify-backfill/);

    // Verify, then backfill again: the blessing now describes a scope that has
    // changed underneath it.
    await blessScope(SCOPE);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    const stale = await reclaim({ phase: "shadow" });
    expect(stale.verdict).toBe("refused");
    expect(stale.refusals.join(" ")).toMatch(/AFTER the verify verdict/);
  });

  it("REFUSES while an executed erasure has not converged", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-erasure");
    const user = await testDb.pool.query<{ id: string }>(
      `insert into users (username, password_hash, role) values ('owner-x', 'x', 'owner')
       returning id::text as id`,
    );
    await testDb.pool.query(
      `insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan, completed_at)
       values ('fan', 'fan:fansly:1', $1, false, '{}'::jsonb, null)`,
      [Number(user.rows[0]!.id)],
    );

    const result = await reclaim({ phase: "shadow" });
    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/have not completed/);
  });

  it("REFUSES a partition that is detached or parked", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-detached");
    await testDb.pool.query("create schema if not exists tiered_pending_drop");
    await testDb.pool.query(`alter table observations detach partition "${PARTITION}"`);
    await testDb.pool.query(`alter table "${PARTITION}" set schema tiered_pending_drop`);
    try {
      const result = await reclaim({ phase: "shadow" });
      expect(result.verdict).toBe("refused");
      expect(result.refusals.join(" ")).toMatch(/is DETACHED/);
    } finally {
      await testDb.pool.query(`alter table tiered_pending_drop."${PARTITION}" set schema public`);
      await testDb.pool.query(`
        alter table observations attach partition "${PARTITION}"
        for values from ('2026-07-01') to ('2026-08-01')
      `);
    }
  });

  // The crash-safety proof, at the level the design actually relies on: the
  // detach and the attach are one transaction, so a process that dies between
  // them leaves the OLD partition attached. Never neither.
  it("a crash between detach and attach rolls back to the old partition", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-crash");
    await reclaim({ phase: "shadow" });

    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query(`alter table observations detach partition "${PARTITION}"`);
      const midFlight = await client.query<{ attached: boolean }>(
        `select exists (
           select 1 from pg_inherits i
           join pg_class p on p.oid = i.inhparent
           join pg_class c on c.oid = i.inhrelid
           where p.relname = 'observations' and c.relname = $1
         ) as attached`,
        [PARTITION],
      );
      expect(midFlight.rows[0]!.attached).toBe(false);
      // The "crash".
      await client.query("rollback");
    } finally {
      client.release();
    }

    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    const rows = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from observations
       where received_at >= '2026-07-01' and received_at < '2026-08-01'`,
    );
    expect(Number(rows.rows[0]!.n)).toBe(6);
  });

  // Decision #222, finding 2. The precondition checks and the row counts used
  // to be the LAST word, and both were read outside the swap transaction. An
  // erasure committing in the gap — while the swap waited for its locks — would
  // leave the swap parking a post-erasure source and attaching a PRE-erasure
  // shadow: every erased row back, through the door the G3 fence does not watch.
  //
  // Both cases below hold the swap on its `LOCK TABLE` and move the world under
  // it, which is exactly the interleaving. The assertion is always the same:
  // REFUSED, and refused means nothing was touched.
  async function swapBlockedBy<T>(act: (holder: PoolClient) => Promise<T>) {
    const holder = await testDb!.pool.connect();
    await holder.query("begin");
    // ACCESS SHARE on the parent and its partitions: enough to make the swap's
    // ACCESS EXCLUSIVE wait, which is the whole point.
    await holder.query("select 1 from observations limit 1");

    const swapping = reclaim({ phase: "swap", confirm: PARTITION, lockTimeoutMs: 15_000 });
    try {
      // An ungranted table lock on observations proves the swap is parked on
      // its ACCESS EXCLUSIVE request; the fixed sleep here only assumed it.
      await waitForRelationLockWait(testDb!.pool, "observations", { blocked: swapping });
      await act(holder);
      await holder.query("commit");
    } finally {
      holder.release();
    }
    return swapping;
  }

  it("REFUSES under lock when an erasure deleted rows while the swap waited", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-swap-race");
    await reclaim({ phase: "shadow" });

    // Counts agree right now — 6 and 6 — which is what the pre-lock check saw.
    const swap = await swapBlockedBy(async (holder) => {
      await holder.query(
        `delete from "${PARTITION}" where id = (select max(id) from "${PARTITION}")`,
      );
    });
    const result = await swap;

    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/under lock the shadow holds 6 rows/);
    expect(result.refusals.join(" ")).toMatch(/rebuild the shadow/);
    expect(result.detail.lockedSourceRows).toBe(5);
    expect(result.detail.lockedShadowRows).toBe(6);

    // NOTHING happened: the original is still the attached partition, the
    // shadow is still a detached twin, and no copy was parked.
    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    expect(await isAttachedToObservations("observations_2026_07__skinny")).toBe(false);
    expect(await listCaptureParkedRelations(appStub())).toHaveLength(0);
    const live = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from "${PARTITION}"`,
    );
    expect(Number(live.rows[0]!.n)).toBe(5);
  });

  it("REFUSES under lock when an erasure started while the swap waited", async (context) => {
    if (!testDb) return context.skip();
    await backfilledAndBlessed("rc-swap-erasure");
    await reclaim({ phase: "shadow" });
    const user = await testDb.pool.query<{ id: string }>(
      `insert into users (username, password_hash, role) values ('owner-swap', 'x', 'owner')
       returning id::text as id`,
    );

    // An erasure that has OPENED but not yet committed its deletes is invisible
    // to any count — MVCC hides it — so the recount alone would wave this
    // through. The mid-flight tombstone is what catches it.
    const swap = await swapBlockedBy(async (holder) => {
      await holder.query(
        `insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan, completed_at)
         values ('fan', 'fan:fansly:9', $1, false, '{}'::jsonb, null)`,
        [Number(user.rows[0]!.id)],
      );
    });
    const result = await swap;

    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/have not completed/);
    expect(result.refusals.join(" ")).toMatch(/resurrect the rows they removed/);
    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    expect(await listCaptureParkedRelations(appStub())).toHaveLength(0);
  });
});

describe("C — capture:drop-parked", () => {
  async function parkOne(label: string) {
    const page = await seedPage(label);
    await seedJulyCorpus(page.id);
    await runCaptureBackfill(appStub(), {
      scope: SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await blessScope(SCOPE);
    const base = {
      scope: SCOPE,
      dryRun: false,
      confirm: undefined as string | undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
    };
    await runCaptureReclaim(appStub(), { ...base, phase: "shadow" });
    await runCaptureReclaim(appStub(), { ...base, phase: "swap", confirm: PARTITION });
    const parked = await listCaptureParkedRelations(appStub());
    return parked[0]!.relation;
  }

  it("refuses without the exact name, then destroys exactly one parked relation", async (context) => {
    if (!testDb) return context.skip();
    const relation = await parkOne("dp-ok");

    const wrong = await runCaptureDropParked(appStub(), {
      relation,
      confirm: "observations_2026_07",
      dryRun: false,
      minGraceHours: 0,
    });
    expect(wrong.verdict).toBe("refused");
    expect(wrong.refusals.join(" ")).toMatch(/--confirm must be the exact relation name/);
    expect(await partitionExists(`${CAPTURE_PARKING_SCHEMA}.${relation}`)).toBe(true);

    const dry = await runCaptureDropParked(appStub(), {
      relation,
      confirm: relation,
      dryRun: true,
      minGraceHours: 0,
    });
    expect(dry.verdict).toBe("ok");
    expect(dry.detail.rows).toBe(6);
    expect(await partitionExists(`${CAPTURE_PARKING_SCHEMA}.${relation}`)).toBe(true);

    const dropped = await runCaptureDropParked(appStub(), {
      relation,
      confirm: relation,
      dryRun: false,
      minGraceHours: 0,
    });
    expect(dropped.verdict).toBe("ok");
    expect(await partitionExists(`${CAPTURE_PARKING_SCHEMA}.${relation}`)).toBe(false);
    // The live partition is untouched — a parked copy is a duplicate, and the
    // fact lives in the twin.
    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    const live = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from "${PARTITION}"`,
    );
    expect(Number(live.rows[0]!.n)).toBe(6);

    const journal = await testDb.pool.query<{ verdict: string }>(
      "select verdict from capture_rewrite_runs where operation = 'drop_parked' order by id desc limit 1",
    );
    expect(journal.rows[0]!.verdict).toBe("ok");
  });

  it("enforces the grace window", async (context) => {
    if (!testDb) return context.skip();
    const relation = await parkOne("dp-grace");
    const result = await runCaptureDropParked(appStub(), {
      relation,
      confirm: relation,
      dryRun: false,
      minGraceHours: 24,
    });
    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/below the 24h grace window/);
    expect(await partitionExists(`${CAPTURE_PARKING_SCHEMA}.${relation}`)).toBe(true);
  });

  it("cannot reach anything outside the parking schema", async (context) => {
    if (!testDb) return context.skip();
    await parkOne("dp-scope");
    for (const relation of [PARTITION, "observations", "capture_payload_objects"]) {
      const result = await runCaptureDropParked(appStub(), {
        relation,
        confirm: relation,
        dryRun: false,
        minGraceHours: 0,
      });
      expect(result.verdict, relation).toBe("refused");
      expect(result.refusals.join(" ")).toMatch(/is not a relation in capture_pending_drop/);
    }
    expect(await isAttachedToObservations(PARTITION)).toBe(true);
    expect(await partitionExists("observations")).toBe(true);
  });
});

describe("C — capture:reclaim, sync_raw_payloads (the maintenance-rewrite route)", () => {
  async function seedRawPayloads(pageId: number, count: number) {
    for (let index = 0; index < count; index += 1) {
      await testDb!.pool.query(
        `insert into sync_raw_payloads (
           page_id, endpoint, request_params, response_payload, mapper_version,
           payload_kind, captured_at, retain_until
         ) values ($1, 'dm_messages', '{}'::jsonb, $2::jsonb, 'v1', 'dm_messages', $3, $4)`,
        [
          pageId,
          JSON.stringify({ tips: [{ id: `t${index}` }], messages: [{ id: `m${index}` }] }),
          JULY(1 + index).toISOString(),
          new Date(Date.UTC(2126, 0, 1)).toISOString(),
        ],
      );
    }
  }

  const rawReclaim = (over: Partial<Parameters<typeof runCaptureReclaim>[1]> = {}) =>
    runCaptureReclaim(appStub(), {
      scope: RAW_SCOPE,
      phase: "null-bodies",
      dryRun: false,
      confirm: undefined,
      batch: 100,
      pauseMs: 0,
      lockTimeoutMs: 3000,
      ...over,
    });

  it("backfills, blesses, then nulls the bodies the catalog already holds", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("raw-null");
    await seedRawPayloads(page.id, 4);

    const backfill = await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    expect(backfill.referenced).toBe(4);
    // The 3a slice column is filled on the same pass.
    const tips = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads where response_tips is not null",
    );
    expect(Number(tips.rows[0]!.n)).toBe(4);

    await blessScope(RAW_SCOPE);

    const result = await rawReclaim({ phase: "null-bodies" });
    expect(result.refusals).toEqual([]);
    expect(result.detail.nulled).toBe(4);

    const census = await censusCaptureRewriteScope(testDb.db, RAW_SCOPE);
    expect(census.pointerOnly).toBe(4);
    expect(census.referenced).toBe(4);
  });

  it("counts only reference-less inline bodies as compact survivors", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("raw-compact-survivors");
    await seedRawPayloads(page.id, 4);
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    // This fifth row has not been walked. Its body survives null-bodies; the
    // four CAS-backed inline duplicates above do not.
    await seedRawPayloads(page.id, 1);

    const expected = await testDb.pool.query<{ bytes: string }>(`
      select coalesce(sum(pg_column_size(response_payload)), 0)::text as bytes
      from sync_raw_payloads
      where response_payload is not null and payload_object_id is null
    `);
    const allInline = await testDb.pool.query<{ bytes: string }>(`
      select coalesce(sum(pg_column_size(response_payload)), 0)::text as bytes
      from sync_raw_payloads
      where response_payload is not null
    `);
    const expectedBytes = Number(expected.rows[0]!.bytes);
    expect(expectedBytes).toBeGreaterThan(0);
    expect(Number(allInline.rows[0]!.bytes)).toBeGreaterThan(expectedBytes);

    const measured = await measureSyncRawPayloadsCompact(testDb.db, 0);
    expect(measured.survivingInlineBytes).toBe(expectedBytes);
  });

  it("0128's CHECK makes a body-less, reference-less row unrepresentable", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("raw-check");
    await seedRawPayloads(page.id, 1);
    await expect(testDb.pool.query(
      "update sync_raw_payloads set response_payload = null",
    )).rejects.toThrow(/sync_raw_payloads_payload_presence_check/);
    void page;
  });

  it("VACUUM FULL refuses while rows still carry both copies, then reclaims", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("raw-vacuum");
    await seedRawPayloads(page.id, 6);
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await blessScope(RAW_SCOPE);

    const premature = await rawReclaim({ phase: "vacuum-full", confirm: "sync_raw_payloads" });
    expect(premature.verdict).toBe("refused");
    expect(premature.refusals.join(" ")).toMatch(/still carry BOTH copies/);

    await rawReclaim({ phase: "null-bodies" });

    const noConfirm = await rawReclaim({ phase: "vacuum-full" });
    expect(noConfirm.verdict).toBe("refused");
    expect(noConfirm.refusals.join(" ")).toMatch(/--confirm must be 'sync_raw_payloads'/);

    const tooTight = await rawReclaim({
      phase: "vacuum-full",
      confirm: "sync_raw_payloads",
      freeBytesOverride: 1,
    });
    expect(tooTight.verdict).toBe("refused");
    expect(tooTight.refusals.join(" ")).toMatch(/§9\.2 headroom/);

    const done = await rawReclaim({ phase: "vacuum-full", confirm: "sync_raw_payloads" });
    expect(done.refusals).toEqual([]);
    expect(done.verdict).toBe("ok");
    expect(done.detail.totalBytesAfter).not.toBeNull();

    // The facts survived the rewrite; only the residue went.
    const rows = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from sync_raw_payloads",
    );
    expect(Number(rows.rows[0]!.n)).toBe(6);
  });

  it("REFUSES while a runtime instance is still heartbeating", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage("raw-writers");
    await seedRawPayloads(page.id, 2);
    await runCaptureBackfill(appStub(), {
      scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
    });
    await blessScope(RAW_SCOPE);
    await testDb.pool.query(
      `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
       values ('worker', 'w1', now(), now(), '{}'::jsonb)`,
    );

    const result = await rawReclaim({ phase: "null-bodies" });
    expect(result.verdict).toBe("refused");
    expect(result.refusals.join(" ")).toMatch(/still heartbeating/);
  });

  // -------------------------------------------------------------------------
  // Decision #223, finding 4 — THE RITUAL THAT ITS OWN GATE REFUSED.
  //
  // The runbook stopped `worker` and `scheduler`; the api never stops, so the
  // check (which refuses on ANY heartbeating instance) refused indefinitely and
  // the documented ritual could not be performed. The audit found the api is a
  // capture writer too — it journals an observation on every audited admin
  // mutation and writes sync_raw_payloads itself on the page-verify route — so
  // the CHECK is right and the ritual was wrong. These cases pin both halves.
  describe("the writers-stopped matrix (#223)", () => {
    async function armRawScope(label: string) {
      const page = await seedPage(label);
      await seedRawPayloads(page.id, 2);
      await runCaptureBackfill(appStub(), {
        scope: RAW_SCOPE, dryRun: false, batch: 10, pauseMs: 0, maxBatches: 0,
      });
      await blessScope(RAW_SCOPE);
    }

    async function heartbeat(...roles: string[]) {
      for (const role of roles) {
        await testDb!.pool.query(
          `insert into runtime_instances (role, instance_id, started_at, last_seen_at, running)
           values ($1, $1 || '-1', now(), now(), '{}'::jsonb)`,
          [role],
        );
      }
    }

    it("REFUSES the documented ritual state: worker+scheduler down, api still up", async (context) => {
      if (!testDb) return context.skip();
      await armRawScope("writers-api");
      // Exactly what `docker compose stop worker scheduler` leaves behind.
      await heartbeat("api");

      const result = await rawReclaim({ phase: "null-bodies" });
      expect(result.verdict).toBe("refused");
      expect(result.detail.activeRuntimeInstances).toEqual(["api/api-1"]);
      // The refusal must tell the operator the thing that actually works. The
      // old text said "stop the worker and the scheduler first", which is the
      // state they were already in.
      expect(result.refusals.join(" ")).toMatch(/stop api, worker AND scheduler/);
      expect(result.refusals.join(" ")).toMatch(/capture-historical-rewrite\.md/);
      // Nothing was nulled while it refused.
      const intact = await testDb.pool.query<{ n: string }>(
        "select count(*)::text as n from sync_raw_payloads where response_payload is not null",
      );
      expect(Number(intact.rows[0]!.n)).toBe(2);
    });

    it("proceeds once all three roles are down — the ritual as it now reads", async (context) => {
      if (!testDb) return context.skip();
      await armRawScope("writers-none");
      const result = await rawReclaim({ phase: "null-bodies" });
      expect(result.refusals).toEqual([]);
      expect(result.detail.activeRuntimeInstances).toEqual([]);
      expect(result.detail.nulled).toBe(2);
    });

    it("still refuses for a stale-but-live heartbeat from any single role", async (context) => {
      if (!testDb) return context.skip();
      await armRawScope("writers-each");
      for (const role of ["api", "worker", "scheduler"]) {
        await testDb.pool.query("delete from runtime_instances");
        await heartbeat(role);
        const result = await rawReclaim({ phase: "null-bodies" });
        expect(result.verdict, role).toBe("refused");
        expect(result.refusals.join(" "), role).toMatch(/still heartbeating/);
      }
    });
  });

  it("rejects a phase that belongs to the other table", async (context) => {
    if (!testDb) return context.skip();
    await expect(rawReclaim({ phase: "swap" })).rejects.toThrow(/is not a phase of/);
    await expect(runCaptureReclaim(appStub(), {
      scope: SCOPE,
      phase: "vacuum-full",
      dryRun: true,
      confirm: undefined,
      batch: 10,
      pauseMs: 0,
      lockTimeoutMs: 3000,
    })).rejects.toThrow(/is not a phase of/);
  });
});
