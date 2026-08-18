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

import {
  censusCaptureRewriteScope,
  createFanslyPage,
  createModel,
  insertObservation,
  latestSettledCaptureRewriteRun,
} from "@agency_hub_core/db";

import {
  runCaptureBackfill,
  runCaptureVerifyBackfill,
} from "../apps/runtime/src/services/capture-rewrite/index.ts";
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
