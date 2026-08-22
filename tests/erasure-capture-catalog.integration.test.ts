// G5 slice 3b — the erasure's catalog plane, end to end against the real
// module (planErasure / executeErasure), the real CAS writer
// (putPayloadObject) and real envelope rows.
//
// The property under test is a single sentence: after an erasure, a catalog
// body survives IF AND ONLY IF an envelope survived that needs it. Everything
// below is one half of that biconditional or the resumability of the act that
// enforces it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  capturePayloadErasureSubject,
  createModel,
  createOnlyFansPage,
  deleteUnreferencedCapturePayloadObjects,
  putPayloadObject,
} from "@agency_hub_core/db";

import {
  buildCapturePayloadCatalogWork,
  sweepCapturePayloadCatalog,
} from "../apps/runtime/src/services/erasure/capture-catalog.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const FAN_A = "111000111";
const FAN_B = "222000222";
const CAPTURE_INSTANT = new Date("2026-08-14T10:00:00.000Z");
const BUCKET_MONTH = "2026-08-01";

const scope = { scopeType: "fan", platform: "onlyfans", fanRef: FAN_A } as const;

let testDb: StartedTestDatabase | null = null;
let pageId = 0;
let ownerId = 0;

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    // No lake in these cases: listLakeManifests treats an unreadable directory
    // as "no manifests", which keeps DuckDB out of a catalog-only test.
    config: { lakeDir: "/nonexistent-lake-dir" } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function one<T>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await testDb!.pool.query(text, params);
  return rows[0] as T | undefined;
}

async function count(text: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: string }>(`select count(*)::text as n from ${text}`, params);
  return Number(row?.n ?? 0);
}

function fanBody(fanRef: string, note: string) {
  return { messages: [{ fromUser: { id: fanRef }, text: note }], response: { total: 1 } };
}

/** The real writer, on the real lane pull capture uses. */
async function storeObject(body: unknown, accountId: number | null = pageId) {
  return putPayloadObject(testDb!.db, {
    representation: "canonical_json",
    json: body,
    captureInstant: CAPTURE_INSTANT,
    lane: "platform_capture",
    platformAccountId: accountId,
  });
}

let observationSeq = 0;

async function seedObservation(input: {
  payload: unknown;
  ref: { bucketMonth: string; objectId: number } | null;
}): Promise<number> {
  observationSeq += 1;
  const key = `cas-erasure:${observationSeq}`;
  const row = await one<{ id: string }>(
    `insert into observations (source, producer, platform, account_id, kind, payload,
                               payload_hash, idempotency_key, observed_at, received_at,
                               parse_version, payload_bucket_month, payload_object_id)
     values ('webhook', 'ofapi:webhook', 'onlyfans', $1, 'dm.messages', $2::jsonb,
             sha256($3::bytea), $3, now(), now(), 1, $4::date, $5)
     returning id::text as id`,
    [
      pageId,
      JSON.stringify(input.payload),
      key,
      input.ref?.bucketMonth ?? null,
      input.ref?.objectId ?? null,
    ],
  );
  await testDb!.pool.query(
    `insert into observation_keys (source, idempotency_key, observation_id, received_at)
     values ('webhook', $1, $2, now())`,
    [key, Number(row!.id)],
  );
  return Number(row!.id);
}

async function seedRawPayload(input: {
  payload: unknown;
  ref: { bucketMonth: string; objectId: number } | null;
}): Promise<number> {
  const row = await one<{ id: string }>(
    `insert into sync_raw_payloads (page_id, endpoint, request_params, response_payload,
                                    mapper_version, payload_kind, retain_until,
                                    payload_bucket_month, payload_object_id)
     values ($1, 'dm_messages', '{}'::jsonb, $2::jsonb, 'test-v1', 'dm_messages',
             now() + interval '100 years', $3::date, $4)
     returning id::text as id`,
    [pageId, JSON.stringify(input.payload), input.ref?.bucketMonth ?? null, input.ref?.objectId ?? null],
  );
  return Number(row!.id);
}

async function objectExists(objectId: number) {
  return await count(
    `capture_payload_objects where bucket_month = $1::date and object_id = $2`,
    [BUCKET_MONTH, objectId],
  ) === 1;
}

async function bodyExists(objectId: number) {
  return await count(
    `capture_json_hot_bodies where bucket_month = $1::date and object_id = $2`,
    [BUCKET_MONTH, objectId],
  ) === 1;
}

async function locationExists(objectId: number) {
  return await count(
    `capture_payload_locations where bucket_month = $1::date and object_id = $2`,
    [BUCKET_MONTH, objectId],
  ) === 1;
}

async function erasureJournal() {
  const row = await one<{ executed_counts: Record<string, unknown> }>(
    `select executed_counts from erasure_log
     where dry_run = false and completed_at is not null
     order by id desc limit 1`,
  );
  return row!.executed_counts;
}

async function seedScope(label: string) {
  const model = await createModel(testDb!.db, { slug: `cas-erasure-${label}`, name: label });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label: `cas-erasure-${label}` });
  pageId = page!.id;
  ownerId = Number((await one<{ id: string }>(
    `insert into users (username, role) values ($1, 'owner') returning id::text as id`,
    [`cas-erasure-owner-${label}`],
  ))!.id);
  for (const [ref, name] of [[FAN_A, "Fan A"], [FAN_B, "Fan B"]] as const) {
    await testDb!.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('onlyfans', $1, $2, $2)`,
      [ref, name],
    );
  }
}

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
  observationSeq = 0;
});

describe("erasure reaches the capture payload catalog (G5 slice 3b)", () => {
  it("deletes a body whose every envelope the erasure removed, and leaves the rest alone", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedScope("delete");

    // TWO envelopes, ONE body: identical content in one month and scope dedups
    // onto a single object — the shared-body case this slice exists for.
    const subjectBody = fanBody(FAN_A, "you up?");
    const first = await storeObject(subjectBody);
    const second = await storeObject(subjectBody);
    expect(second.objectId).toBe(first.objectId);
    expect(second.created).toBe(false);

    await seedObservation({ payload: subjectBody, ref: first });
    await seedObservation({ payload: subjectBody, ref: first });

    // A bystander body that does not mention fan A at all.
    const bystanderBody = fanBody(FAN_B, "morning");
    const bystander = await storeObject(bystanderBody);
    await seedObservation({ payload: bystanderBody, ref: bystander });

    // The plan sees exactly the subject-bearing object.
    const plan = await planErasure(appStub(), scope);
    const catalogTarget = plan.targets.find((target) => target.plane === "catalog");
    expect(catalogTarget).toMatchObject({
      target: "capture_payload_objects",
      action: "delete",
      rows: 1,
    });

    const result = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(1);

    // The body, its location row and its catalog row are all gone — no orphan
    // in either direction.
    expect(await objectExists(first.objectId)).toBe(false);
    expect(await bodyExists(first.objectId)).toBe(false);
    expect(await locationExists(first.objectId)).toBe(false);

    // The bystander is untouched in all three tables.
    expect(await objectExists(bystander.objectId)).toBe(true);
    expect(await bodyExists(bystander.objectId)).toBe(true);
    expect(await locationExists(bystander.objectId)).toBe(true);

    // The tombstone journals WHICH body was destroyed, by digest and size.
    const journal = await erasureJournal();
    expect(journal.capturePayloadObjectsExamined).toBe(1);
    expect(journal.capturePayloadObjectsErased).toBe(1);
    expect(journal.capturePayloadObjectsKept).toBe(0);
    expect(journal.capturePayloadObjectsErasedManifestTruncated).toBe(false);
    expect(journal.capturePayloadObjectsErasedManifest).toEqual([
      {
        bucketMonth: BUCKET_MONTH,
        objectId: first.objectId,
        contentSha256: first.contentSha256.toString("hex"),
        logicalBytes: first.logicalBytes,
      },
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("deletes a body after its matching raw capture converges too", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedScope("keep-raw");

    const subjectBody = fanBody(FAN_A, "tip incoming");
    const object = await storeObject(subjectBody);
    // Both envelope planes carry the subject. Fan erasure must converge both
    // before the catalog sweep decides that the shared body is unreferenced.
    await seedObservation({ payload: subjectBody, ref: object });
    const rawPayloadId = await seedRawPayload({ payload: subjectBody, ref: object });

    const result = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["hot:sync_raw_payloads:delete"]).toBe(1);
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(1);

    expect(await count("sync_raw_payloads where id = $1", [rawPayloadId])).toBe(0);
    expect(await objectExists(object.objectId)).toBe(false);
    expect(await bodyExists(object.objectId)).toBe(false);

    const journal = await erasureJournal();
    expect(journal.capturePayloadObjectsExamined).toBe(1);
    expect(journal.capturePayloadObjectsErased).toBe(1);
    expect(journal.capturePayloadObjectsKept).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("inherits observation exclusivity: a shared observation's body survives with it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedScope("shared");

    const subjectBody = fanBody(FAN_A, "group blast");
    const object = await storeObject(subjectBody);
    const observationId = await seedObservation({ payload: subjectBody, ref: object });

    // Fan B's lineage points at the same observation, which is exactly what
    // makes it a SHARED capture: the module keeps it and reports it, so its
    // body has a surviving fact behind it too.
    await testDb.pool.query(
      `insert into domain_events (account_id, account_seq, type, occurred_at, fan_identity_ref,
                                  conversation_ref, data, schema_version, observation_id, dedup_key)
       values ($1, 1, 'dm.message.received', now(), $2, $2, '{}'::jsonb, 1, $3, 'shared:1')`,
      [pageId, FAN_B, observationId],
    );

    const plan = await planErasure(appStub(), scope);
    expect(plan.sharedObservations).toBe(1);

    const result = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(0);
    expect(await count(`observations where id = ${observationId}`)).toBe(1);
    expect(await objectExists(object.objectId)).toBe(true);
    expect(await bodyExists(object.objectId)).toBe(true);
    expect((await erasureJournal()).capturePayloadObjectsKept).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resumes a half-finished sweep and converges, with no double-delete and no orphan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedScope("resume");

    const objects = [];
    for (const note of ["one", "two", "three"]) {
      const body = fanBody(FAN_A, note);
      const object = await storeObject(body);
      await seedObservation({ payload: body, ref: object });
      objects.push(object);
    }

    // Crash simulation, at the worst moment there is: the delete transaction
    // committed (the envelopes are gone) and the process died after the FIRST
    // catalog batch. Both halves are reproduced literally.
    await testDb.pool.query("delete from observations");
    const work = await buildCapturePayloadCatalogWork(appStub(), {
      scopeType: "fan",
      pageIds: [pageId],
      subject: capturePayloadErasureSubject(FAN_A),
    });
    expect(work.matches).toHaveLength(3);
    const partial = await sweepCapturePayloadCatalog(appStub(), {
      scopeRef: "fan:onlyfans:" + FAN_A,
      pageIds: [pageId],
      matches: work.matches.slice(0, 1),
      batchSize: 1,
    });
    expect(partial.deleted).toHaveLength(1);

    // Re-running the whole erasure finds what is left and finishes the job.
    const result = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(2);
    for (const object of objects) {
      expect(await objectExists(object.objectId)).toBe(false);
      expect(await bodyExists(object.objectId)).toBe(false);
      expect(await locationExists(object.objectId)).toBe(false);
    }

    // A third run is a clean no-op: convergence, not an error.
    const rerun = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    expect(rerun.executedCounts["catalog:capture_payload_objects:delete"]).toBe(0);

    // And the deleter itself is idempotent when handed a reference that is
    // already gone — the shape a crash mid-batch would leave behind.
    const replay = await deleteUnreferencedCapturePayloadObjects(testDb.db, [
      { bucketMonth: BUCKET_MONTH, objectId: objects[0]!.objectId },
    ]);
    expect(replay.deleted).toHaveLength(0);
    expect(replay.retained).toHaveLength(0);
    expect(replay.alreadyGone).toHaveLength(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("proves zero references through the 0127 index, on both envelope tables", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // The whole deletion law rests on an existence probe per candidate object.
    // Unindexed, that is a sequential scan of the largest relation in the
    // system and the sweep never finishes — so the index being USABLE for this
    // exact predicate is part of the law, not an optimisation. seqscan is
    // disabled because the planner would (rightly) scan a near-empty table; the
    // assertion is that a partial index whose predicate the query implies is
    // available at all, which is the thing a wrong predicate would break.
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      for (const [table, index] of [
        // `observations` is partitioned, so the plan names the LEAF indexes the
        // migration created and attached — one per monthly partition, which is
        // also the proof that the attach loop reached every one of them.
        ["observations", "_payload_object_ref_idx"],
        ["sync_raw_payloads", "sync_raw_payloads_payload_object_ref_idx"],
      ] as const) {
        const explained = await client.query<{ "QUERY PLAN": string }>(
          `explain select 1 from ${table} e
           where e.payload_bucket_month = '2026-08-01'::date and e.payload_object_id = 1`,
        );
        const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(plan, `${table} probe plan`).toContain(index);
        expect(plan, `${table} probe plan`).not.toContain(`Seq Scan on ${table}`);
      }
      await client.query("rollback");
    } finally {
      client.release();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses to plan when an exact_bytes body is in scope, instead of silently under-erasing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedScope("exact-bytes");

    await putPayloadObject(testDb.db, {
      representation: "exact_bytes",
      canonicalBytes: Buffer.from(JSON.stringify(fanBody(FAN_A, "wire")), "utf8"),
      captureInstant: CAPTURE_INSTANT,
      lane: "platform_capture",
      platformAccountId: pageId,
      contentType: "application/json",
    });

    await expect(planErasure(appStub(), scope)).rejects.toThrow(/exact_bytes/);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
