// G5 slice 3c-1, end to end: a capture whose body is written ONCE, in the
// content-addressed catalog, with the inline column left SQL NULL.
//
// The seam under test is the real one — persistRawPayload, the function every
// pull capture in the system goes through — and the readers are the real
// readers. Three properties carry the slice, and every case below is one of
// them:
//
//   1. THE WORST CASE IS BOTH COPIES, NEVER NONE. A page must be in BOTH
//      canaries and the catalog write must have succeeded; anything else writes
//      the inline body exactly as before. The database enforces the floor with a
//      CHECK, so even a hand-forged row cannot address zero bodies.
//   2. A NULL INLINE BODY IS REACHABLE IN EVERY READ MODE. Especially `inline`,
//      the rollback target of slice 2 — the escape hatch must not be the hazard.
//   3. NOTHING DOWNSTREAM SILENTLY DEGRADES. The typed columns of slice 3a are
//      derived before the body is dropped; the parity verifier reports what it
//      could not compare instead of scoring it as matched; the erasure still
//      finds the fan and still kills the body; the re-journal still re-hashes
//      the same bytes.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  putPayloadObject,
  startSyncRun,
  verifyCapturePayloadParity,
} from "@agency_hub_core/db";

import {
  getCaptureCasDualWriteCounters,
  publishCaptureCasDualWritePages,
  publishCaptureCasPointerOnlyPages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  E5_COLLISION_WINDOW,
  REJOURNAL_PRODUCER,
  runObservationsRejournal,
} from "../apps/runtime/src/services/observations-rejournal.ts";
import {
  type CaptureCasReadMode,
  getCaptureCasReadCounters,
  loadObservationPayload,
  loadRawCaptureBody,
  resetCaptureCasReadForTests,
} from "../apps/runtime/src/services/payload-reader.ts";
import { persistRawPayload, retentionDate } from "../apps/runtime/src/services/sync/shared.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  resetCaptureCasDualWriteForTests();
  resetCaptureCasReadForTests();
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    config: { telegramEnabled: false, lakeDir: "/nonexistent-lake-dir" },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

const BODY = {
  messages: [{ id: "m1", content: "hey" }],
  tips: [{ id: "tip-1", message: "exact note", senderId: "fan-1", createdAt: 1 }],
  response: { total: 1 },
};

async function seedFanslyPage(label = "pointer-page") {
  const model = await createModel(testDb!.db, { slug: `m-${label}`, name: label });
  if (!model) throw new Error(`model ${label} was not created`);
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error(`page ${label} was not created`);
  return page;
}

/** Both canaries on for this page: the only configuration in which a body stops
 *  being written inline. */
function armPointerOnly(pageId: number) {
  publishCaptureCasDualWritePages(String(pageId));
  publishCaptureCasPointerOnlyPages(String(pageId));
}

async function capture(pageId: number, payload: unknown, endpoint = "dm_messages") {
  return persistRawPayload(testDb!.db, {
    platformAccountId: pageId,
    endpoint,
    requestParams: {},
    responsePayload: payload,
    mapperVersion: "test-v1",
    payloadKind: "dm_messages",
    retainUntil: retentionDate(),
  }, { platform: "fansly" });
}

interface EnvelopeRow {
  id: number;
  inlineIsNull: boolean;
  bucketMonth: string | null;
  objectId: number | null;
}

async function observationRows(): Promise<EnvelopeRow[]> {
  const { rows } = await testDb!.pool.query<{
    id: string;
    inline_is_null: boolean;
    bucket_month: string | null;
    object_id: string | null;
  }>(
    `select o.id::text as id, (o.payload is null) as inline_is_null,
            to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
            o.payload_object_id::text as object_id
     from observations o order by o.id asc`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    inlineIsNull: row.inline_is_null,
    bucketMonth: row.bucket_month,
    objectId: row.object_id === null ? null : Number(row.object_id),
  }));
}

async function rawRows(): Promise<EnvelopeRow[]> {
  const { rows } = await testDb!.pool.query<{
    id: string;
    inline_is_null: boolean;
    bucket_month: string | null;
    object_id: string | null;
  }>(
    `select rp.id::text as id, (rp.response_payload is null) as inline_is_null,
            to_char(rp.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
            rp.payload_object_id::text as object_id
     from sync_raw_payloads rp order by rp.id asc`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    inlineIsNull: row.inline_is_null,
    bucketMonth: row.bucket_month,
    objectId: row.object_id === null ? null : Number(row.object_id),
  }));
}

describe("G5 slice 3c-1: the capture writes ONE copy", () => {
  it("leaves both inline bodies null, keeps the references, the hash and the typed columns", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage();
    armPointerOnly(page.id);

    await capture(page.id, BODY);

    const [observation] = await observationRows();
    const [raw] = await rawRows();
    expect(observation!.inlineIsNull).toBe(true);
    expect(raw!.inlineIsNull).toBe(true);
    // The pointer is there, on both envelopes, addressing ONE deduplicated body.
    expect(observation!.objectId).not.toBeNull();
    expect(raw!.objectId).toBe(observation!.objectId);
    expect(raw!.bucketMonth).toMatch(/^\d{4}-\d{2}-01$/);
    expect(await countRows("select count(*)::text as n from capture_json_hot_bodies")).toBe(1);

    // payload_hash is computed by the producer from the payload OBJECT, before
    // anything decides where the bytes live, so it is the SAME digest the row
    // would have carried with its body inline. This is why 0128 leaves the
    // column NOT NULL.
    const hashed = await testDb.pool.query<{ hash: string }>(
      `select encode(o.payload_hash, 'hex') as hash from observations o`,
    );
    expect(hashed.rows[0]!.hash).toBe(
      createHash("sha256").update(JSON.stringify(BODY)).digest("hex"),
    );

    // Slice 3a's typed column is derived from the same object, ALSO before the
    // drop — the DM tip replay keeps working on a row with no body.
    const tips = await testDb.pool.query<{ response_tips: { tips: unknown } }>(
      `select rp.response_tips from sync_raw_payloads rp`,
    );
    expect(tips.rows[0]!.response_tips).toEqual({ tips: BODY.tips });

    expect(getCaptureCasDualWriteCounters()).toMatchObject({
      attempted: 1,
      stored: 1,
      pointerOnly: 1,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("derives an observation's typed columns before dropping the body", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage("pointer-typed");
    const payload = {
      table: "fan_transactions",
      machineId: "machine-pointer",
      row: { tx_id: "tx-pointer", amount: 12.5, created_at: "2026-08-18T00:00:00+00:00" },
    };
    const object = await putPayloadObject(testDb.db, {
      representation: "canonical_json",
      json: payload,
      captureInstant: new Date(),
      lane: "platform_capture",
      platformAccountId: page.id,
    });

    await insertObservation(testDb.db, {
      source: "client_capture",
      producer: "desktop-harvest@0.1.29",
      platform: "onlyfans",
      accountId: page.id,
      kind: "harvest.fan_transactions",
      payload,
      payloadHash: createHash("sha256").update("pointer-typed").digest(),
      idempotencyKey: "machine-pointer:ev-pointer",
      payloadRef: { bucketMonth: object.bucketMonth, objectId: object.objectId },
      omitInlinePayload: true,
    });

    const { rows } = await testDb.pool.query<Record<string, string | null>>(
      `select (payload is null)::text as inline_is_null, harvest_machine_id,
              harvest_tx_id, harvest_tx_amount, harvest_tx_created_at
       from observations where idempotency_key = 'machine-pointer:ev-pointer'`,
    );
    // The body is gone from the row and every queryable field survived it: the
    // derivation reads the OBJECT, not the column.
    expect(rows[0]).toEqual({
      inline_is_null: "true",
      harvest_machine_id: "machine-pointer",
      harvest_tx_id: "tx-pointer",
      harvest_tx_amount: "12.5",
      harvest_tx_created_at: "2026-08-18T00:00:00+00:00",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("writes the inline body when the catalog write fails, pointer-only or not", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage("pointer-codec");
    armPointerOnly(page.id);

    // A Date reaches the inline columns fine and the frozen codec REFUSES it.
    // Capture-first is untouched by this slice: no reference, no permission.
    await capture(page.id, { capturedAt: new Date("2026-08-18T00:00:00.000Z") });

    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(0);
    const [observation] = await observationRows();
    const [raw] = await rawRows();
    expect(observation!.inlineIsNull).toBe(false);
    expect(raw!.inlineIsNull).toBe(false);
    expect(observation!.objectId).toBeNull();

    const inline = await testDb.pool.query<{ response_payload: { capturedAt: string } }>(
      "select rp.response_payload from sync_raw_payloads rp",
    );
    expect(inline.rows[0]!.response_payload.capturedAt).toBe("2026-08-18T00:00:00.000Z");
    expect(getCaptureCasDualWriteCounters()).toMatchObject({
      codecRefused: 1,
      pointerOnly: 0,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("writes BOTH copies for a page in the pointer-only list but not the dual-write one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage("pointer-unpaired");
    // The construction law: no dual write, no reference, no pointer. A page
    // listed here alone behaves like a page listed nowhere.
    publishCaptureCasPointerOnlyPages(String(page.id));

    await capture(page.id, BODY);

    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(0);
    expect((await observationRows())[0]!.inlineIsNull).toBe(false);
    expect((await rawRows())[0]!.inlineIsNull).toBe(false);
    expect(getCaptureCasDualWriteCounters()).toMatchObject({ attempted: 0, pointerOnly: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a hand-forged row that addresses no body at all", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage("pointer-check");

    // THE INVARIANT OF THE SLICE, enforced by the database rather than by the
    // writer that happens to be careful today. Neither table will accept a row
    // with no inline body and no reference.
    await expect(testDb.pool.query(
      `insert into observations (source, producer, platform, account_id, kind, payload,
                                 payload_hash, idempotency_key, received_at)
       values ('pull', 'forged', 'fansly', $1, 'dm_messages', null,
               sha256('forged'::bytea), 'forged-observation', now())`,
      [page.id],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(testDb.pool.query(
      `insert into sync_raw_payloads (page_id, endpoint, request_params, response_payload,
                                      mapper_version, payload_kind, retain_until)
       values ($1, 'dm_messages', '{}'::jsonb, null, 'test-v1', 'dm_messages',
               now() + interval '100 years')`,
      [page.id],
    )).rejects.toMatchObject({ code: "23514" });

    // …and accepts the same rows the moment they carry a reference instead.
    const object = await putPayloadObject(testDb.db, {
      representation: "canonical_json",
      json: BODY,
      captureInstant: new Date(),
      lane: "platform_capture",
      platformAccountId: page.id,
    });
    await testDb.pool.query(
      `insert into observations (source, producer, platform, account_id, kind, payload,
                                 payload_hash, idempotency_key, received_at,
                                 payload_bucket_month, payload_object_id)
       values ('pull', 'forged', 'fansly', $1, 'dm_messages', null,
               sha256('forged'::bytea), 'forged-observation', now(), $2::date, $3)`,
      [page.id, object.bucketMonth, object.objectId],
    );
    expect(await countRows("select count(*)::text as n from observations")).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("G5 slice 3c-1: a pointer-only body is reachable in EVERY read mode", () => {
  it.each(["inline", "shadow", "serve"] as const)(
    "serves the catalog body in %s mode",
    async (mode: CaptureCasReadMode) => {
      if (!testDb) {
        return;
      }
      const page = await seedFanslyPage(`pointer-read-${mode}`);
      armPointerOnly(page.id);
      const raw = await capture(page.id, BODY);
      const [observation] = await observationRows();

      // THE CRITICAL CASE IS `inline`. That mode is slice 2's rollback target;
      // if it answered from the (null) column, an operator reaching for the
      // escape hatch would blank every pointer-only row in the system.
      resetCaptureCasReadForTests(mode);

      const rawRead = await loadRawCaptureBody(appStub(), raw.id);
      expect(rawRead!.payload, mode).toEqual(BODY);
      const observationRead = await loadObservationPayload(appStub(), observation!.id);
      expect(observationRead!.payload, mode).toEqual(BODY);

      // Counted as necessity, not as preference: `served` belongs to rows that
      // HAD a choice, and only those go away if the mode is rolled back.
      expect(getCaptureCasReadCounters(), mode).toMatchObject({
        servedNullInline: 2,
        served: 0,
        serveFellBack: 0,
        nullInlineUnresolved: 0,
        shadowChecked: 0,
        shadowMatched: 0,
        shadowSkippedNullInline: mode === "shadow" ? 2 : 0,
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("G5 slice 3c-1: the parity verifier reports what it cannot compare", () => {
  it("counts a pointer-only envelope as skipped, never as matched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage("pointer-parity");

    // One dual-written capture (two comparable envelopes)…
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);
    // …then the same page goes pointer-only (two more envelopes, no inline
    // body). A DIFFERENT body, so the catalog does not dedup the two captures
    // onto one object and each envelope pair is its own case.
    publishCaptureCasPointerOnlyPages(String(page.id));
    await capture(page.id, { messages: [{ id: "m2", content: "second" }] });

    const report = await verifyCapturePayloadParity(testDb.db);
    expect(report.checked).toBe(2);
    expect(report.matched).toBe(2);
    expect(report.mismatched).toBe(0);
    // The two pointer-only envelopes are NOT in `checked` and NOT in `matched`:
    // there is no second reading of those facts, so "the copies agree" is a
    // claim nothing measured.
    expect(report.skippedNullInline).toBe(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("G5 slice 3c-1: the re-journal re-hashes a pointer-only body", () => {
  it("reads through the seam in inline mode and journals the same digest", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedFanslyPage("pointer-rejournal");
    const inWindow = new Date(E5_COLLISION_WINDOW.from.getTime() + 60 * 60 * 1000);
    const payloads = [
      [{ correlationAccountId: "fan-p-1", type: 2110, totalGross: 10_000, totalNet: 8_000 }],
      [{ correlationAccountId: "fan-p-1", year: 2026, month: 6, type: 2110, totalGross: 3_000, totalNet: 2_400 }],
    ];

    const run = await startSyncRun(testDb.db, {
      platformAccountId: page.id,
      stream: "fan_earnings",
      trigger: "scheduled",
    });
    if (!run) throw new Error("sync run seed failed");
    const runId = run.id;

    // Two fetches of one chunk, both written POINTER-ONLY (the shape slice 3c-1
    // produces), under the one chunk-constant key the E5 collision left behind.
    const endpoints = ["fan_earnings_stats", "fan_earnings_monthly"];
    for (const [index, endpoint] of endpoints.entries()) {
      // The object's month bucket follows the CAPTURE INSTANT, not the
      // envelope's captured_at: the E5 window predates this test database's
      // catalog partitions, and the two dates are independent by design.
      const object = await putPayloadObject(testDb.db, {
        representation: "canonical_json",
        json: payloads[index],
        captureInstant: new Date(),
        lane: "platform_capture",
        platformAccountId: page.id,
      });
      await testDb.pool.query(
        `insert into sync_raw_payloads
           (page_id, sync_run_id, stream, request_seq, source, endpoint, request_params,
            response_payload, mapper_version, payload_kind, captured_at, retain_until,
            payload_bucket_month, payload_object_id)
         values ($1, $2, 'fan_earnings', 7, 'scheduled', $3, '{}'::jsonb,
                 null, 'test-mapper', 'mapping_critical', $4, now() + interval '100 years',
                 $5::date, $6)`,
        [page.id, runId, endpoint, inWindow, object.bucketMonth, object.objectId],
      );
    }
    await insertObservation(testDb.db, {
      source: "pull",
      producer: "sync:fansly:fan_earnings",
      platform: "fansly",
      accountId: page.id,
      kind: "fan_earnings_stats",
      payload: payloads[0],
      payloadHash: Buffer.alloc(32),
      idempotencyKey: `${page.id}:fan_earnings:${runId}:7`,
    });

    // INLINE mode on purpose: the re-journal must not depend on the read mode to
    // see a body that only the catalog has.
    resetCaptureCasReadForTests("inline");
    const result = await runObservationsRejournal(appStub(), { dryRun: false });
    expect(result.totals.missing).toBe(1);
    expect(result.totals.rejournaled).toBe(1);

    const journaled = await testDb.pool.query<{ payload: unknown; hash: string }>(
      `select o.payload, encode(o.payload_hash, 'hex') as hash
       from observations o where o.producer = $1`,
      [REJOURNAL_PRODUCER],
    );
    // It re-hashes what it READ, and what it read came out of the catalog. The
    // expected digest is taken from the stored body by a DIFFERENT path (the
    // body table, straight through pg) so the assertion is not circular: both
    // sides are jsonb, which normalizes key order identically, which is exactly
    // the property #217 pinned and this row now depends on completely.
    expect(journaled.rows[0]!.payload).toEqual(payloads[1]);
    const storedBody = await testDb.pool.query<{ body: unknown }>(
      `select b.body from capture_json_hot_bodies b
       join sync_raw_payloads rp
         on rp.payload_bucket_month = b.bucket_month and rp.payload_object_id = b.object_id
       where rp.endpoint = 'fan_earnings_monthly'`,
    );
    expect(journaled.rows[0]!.hash).toBe(
      createHash("sha256").update(JSON.stringify(storedBody.rows[0]!.body)).digest("hex"),
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("G5 slice 3c-1: erasure still reaches a pointer-only fan", () => {
  const FAN_A = "111000111";

  it("finds the envelope through the catalog and kills the last copy of the body", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const model = await createModel(testDb.db, { slug: "pointer-erasure", name: "pointer" });
    const page = await createOnlyFansPage(testDb.db, {
      modelId: model!.id,
      label: "pointer-erasure",
    });
    const owner = await testDb.pool.query<{ id: string }>(
      `insert into users (username, role) values ('pointer-erasure-owner', 'owner')
       returning id::text as id`,
    );
    await testDb.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('onlyfans', $1, 'Fan A', 'Fan A')`,
      [FAN_A],
    );

    const body = { messages: [{ fromUser: { id: FAN_A }, text: "you up?" }], response: { total: 1 } };
    const object = await putPayloadObject(testDb.db, {
      representation: "canonical_json",
      json: body,
      captureInstant: new Date(),
      lane: "platform_capture",
      platformAccountId: page!.id,
    });
    // A pointer-only observation: the fan ref appears NOWHERE on the row — the
    // inline subject match cannot see it, and only slice 3b's catalog arm can.
    await testDb.pool.query(
      `insert into observations (source, producer, platform, account_id, kind, payload,
                                 payload_hash, idempotency_key, received_at, parse_version,
                                 payload_bucket_month, payload_object_id)
       values ('webhook', 'ofapi:webhook', 'onlyfans', $1, 'dm.messages', null,
               sha256('pointer-erasure'::bytea), 'pointer-erasure:1', now(), 1, $2::date, $3)`,
      [page!.id, object.bucketMonth, object.objectId],
    );
    await testDb.pool.query(
      `insert into observation_keys (source, idempotency_key, observation_id, received_at)
       select 'webhook', 'pointer-erasure:1', o.id, o.received_at from observations o`,
    );

    const scope = { scopeType: "fan", platform: "onlyfans", fanRef: FAN_A } as const;
    const plan = await planErasure(appStub(), scope);
    expect(plan.targets.find((target) => target.plane === "catalog"))
      .toMatchObject({ target: "capture_payload_objects", action: "delete", rows: 1 });

    const result = await executeErasure(appStub(), scope, {
      initiatedBy: Number(owner.rows[0]!.id),
    });
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(1);

    // The envelope went, and with it the ONLY copy of the body — catalog row,
    // location row and body row alike. (The erasure journals its own
    // `erasure.executed` operator observation, so the table is not empty.)
    expect(await countRows(
      `select count(*)::text as n from observations
       where idempotency_key = 'pointer-erasure:1'`,
    )).toBe(0);
    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(0);
    expect(await countRows("select count(*)::text as n from capture_json_hot_bodies")).toBe(0);
    expect(await countRows("select count(*)::text as n from capture_payload_locations")).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

async function countRows(text: string) {
  const { rows } = await testDb!.pool.query<{ n: string }>(text);
  return Number(rows[0]?.n ?? "0");
}
