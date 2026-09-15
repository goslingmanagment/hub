// Decision #222 — the erasure/capture reference race, reproduced exactly.
//
// THE INTERLEAVING THIS FILE EXISTS FOR, step by step:
//
//   1. An erasure has deleted envelopes; some catalog object reaches zero
//      references.
//   2. A CONCURRENT capture on the same page dedups onto that object:
//      `putPayloadObject` sees the existing row, hands back its reference, the
//      CAS transaction COMMITS — and the process pauses before inserting the
//      envelopes.
//   3. The erasure's catalog sweep proves zero committed references (correctly,
//      at that instant) and deletes body, location and catalog row.
//   4. The capture inserts its envelope.
//
// Under #215 step 4 wrote a dangling reference and the fact survived inline.
// Under #220 a pointer-only page writes NO inline body, so step 4 used to
// produce a row whose only body was the one step 3 destroyed: a captured fact
// that could not be read, past a CHECK that only asks for a reference, past an
// absent foreign key, and past a parity verifier that skips null-inline rows.
//
// The fix makes steps 3 and 4 STRICTLY ORDERED rather than merely unlikely: the
// sweep takes `FOR UPDATE` on its candidates before it proves anything, the
// envelope writers hold `FOR KEY SHARE` on the object until their insert
// commits. Every case below drives one side of that order to completion and
// asserts the SAME property from the other end — the captured fact is readable.

import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  censusCapturePayloadDanglingRefs,
  createModel,
  createOnlyFansPage,
  deleteUnreferencedCapturePayloadObjects,
  insertObservation,
  insertRawPayload,
  putPayloadObject,
} from "@agency_hub_core/db";

import {
  getCaptureCasDualWriteCounters,
  publishCaptureCasDualWritePages,
  publishCaptureCasPointerOnlyPages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import {
  buildCapturePayloadCatalogWork,
  sweepCapturePayloadCatalog,
} from "../apps/runtime/src/services/erasure/capture-catalog.ts";
import {
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

const FAN = "555000555";
const CAPTURE_INSTANT = new Date("2026-08-14T10:00:00.000Z");
const BUCKET_MONTH = "2026-08-01";

let testDb: StartedTestDatabase | null = null;
let pageId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  resetCaptureCasDualWriteForTests();
  resetCaptureCasReadForTests();
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
  pageId = 0;
});

/** A drizzle transaction handle, as the repositories declare their first
 *  parameter. The repositories detect a PgTransaction and compose into it. */
function asDb(tx: unknown) {
  return tx as Parameters<typeof insertObservation>[0];
}

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    config: { telegramEnabled: false, lakeDir: "/nonexistent-lake-dir" },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage(label: string) {
  const model = await createModel(testDb!.db, { slug: `race-${label}`, name: label });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label: `race-${label}` });
  pageId = page!.id;
  return page!;
}

function body(note: string) {
  return { messages: [{ fromUser: { id: FAN }, text: note }], response: { total: 1 } };
}

/** Exactly what the capture seam does first: the CAS write, in its own
 *  transaction, which COMMITS before any envelope exists. */
async function casCommit(payload: unknown) {
  const stored = await putPayloadObject(testDb!.db, {
    representation: "canonical_json",
    json: payload,
    captureInstant: CAPTURE_INSTANT,
    lane: "platform_capture",
    platformAccountId: pageId,
  });
  return { bucketMonth: stored.bucketMonth, objectId: stored.objectId };
}

/** The erasure's catalog sweep over everything that mentions the fan — the same
 *  two calls executeErasure makes, with the delete transaction already past. */
async function runCatalogSweep() {
  const work = await buildCapturePayloadCatalogWork(appStub(), {
    scopeType: "fan",
    pageIds: [pageId],
    subject: { ref: FAN, quotedLike: `%"${FAN}"%`, numericBoundaryRegex: null },
  });
  return sweepCapturePayloadCatalog(appStub(), {
    scopeRef: `fan:onlyfans:${FAN}`,
    pageIds: [pageId],
    matches: work.matches,
  });
}

async function objectExists(objectId: number) {
  const rows = await testDb!.pool.query<{ n: string }>(
    `select count(*)::text as n from capture_payload_objects
     where bucket_month = $1::date and object_id = $2`,
    [BUCKET_MONTH, objectId],
  );
  return Number(rows.rows[0]?.n ?? 0) === 1;
}

async function observationRow(id: number) {
  const rows = await testDb!.pool.query<{
    payload: unknown;
    payload_object_id: string | null;
  }>(
    `select o.payload, o.payload_object_id::text as payload_object_id
     from observations o where o.id = $1`,
    [id],
  );
  return rows.rows[0]!;
}

async function rawPayloadRow(id: number) {
  const rows = await testDb!.pool.query<{
    response_payload: unknown;
    payload_object_id: string | null;
  }>(
    `select rp.response_payload, rp.payload_object_id::text as payload_object_id
     from sync_raw_payloads rp where rp.id = $1`,
    [id],
  );
  return rows.rows[0]!;
}

let observationSeq = 0;

/** The second half of the capture: the envelope inserts, carrying the reference
 *  the CAS write handed back — long enough after it for an erasure to have run.
 *  `pointerOnly` is exactly the #220 permission. */
async function insertEnvelopes(input: {
  payload: unknown;
  ref: { bucketMonth: string; objectId: number };
  pointerOnly: boolean;
}) {
  observationSeq += 1;
  const raw = await insertRawPayload(testDb!.db, {
    platformAccountId: pageId,
    endpoint: "dm_messages",
    requestParams: {},
    responsePayload: input.payload,
    mapperVersion: "test-v1",
    payloadKind: "dm_messages",
    retainUntil: retentionDate(),
    payloadRef: input.ref,
    omitInlinePayload: input.pointerOnly,
  });
  const observation = await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:onlyfans:dm_messages",
    platform: "onlyfans",
    accountId: pageId,
    kind: "dm_messages",
    payload: input.payload,
    payloadHash: Buffer.alloc(32),
    idempotencyKey: `race:${observationSeq}`,
    payloadRef: input.ref,
    omitInlinePayload: input.pointerOnly,
  });
  return { raw, observation };
}

describe("erasure vs capture: the reference race (#222)", () => {
  it("keeps a pointer-only fact readable when the sweep took the object first", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedPage("pointer-only");
    const payload = body("you up?");

    // STEP 2 — the CAS transaction commits and the process pauses. Nothing
    // references this object yet, which is precisely what makes it a candidate.
    const ref = await casCommit(payload);

    // STEP 3 — the erasure sweep runs in that gap and correctly proves zero
    // references, so the body, its location and its catalog row all die.
    const swept = await runCatalogSweep();
    expect(swept.deleted).toHaveLength(1);
    expect(await objectExists(ref.objectId)).toBe(false);

    // STEP 4 — the capture resumes with a reference to a hole, and asks for the
    // pointer-only treatment: no inline body at all. This is the step that used
    // to lose the fact.
    const { raw, observation } = await insertEnvelopes({ payload, ref, pointerOnly: true });
    expect(raw.payloadRefVanished).toBe(true);
    expect(observation.payloadRefVanished).toBe(true);

    // The reference was DROPPED and the inline body written instead — the
    // pre-G5 shape of a capture, which is always readable.
    const rawRow = await rawPayloadRow(raw.id);
    expect(rawRow.payload_object_id).toBeNull();
    expect(rawRow.response_payload).toEqual(payload);
    const obsRow = await observationRow(observation.observationId);
    expect(obsRow.payload_object_id).toBeNull();
    expect(obsRow.payload).toEqual(payload);

    // …and readable END TO END, through the real seam every reader goes through.
    expect((await loadRawCaptureBody(appStub(), raw.id))?.payload).toEqual(payload);
    expect(
      (await loadObservationPayload(appStub(), observation.observationId))?.payload,
    ).toEqual(payload);

    // No lie is left behind for the hourly job to find, either.
    expect((await censusCapturePayloadDanglingRefs(testDb.db)).dangling).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes the same window for a dual-written capture, which used to keep a lying reference", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedPage("dual-write");
    const payload = body("tip incoming");

    const ref = await casCommit(payload);
    expect((await runCatalogSweep()).deleted).toHaveLength(1);

    // The non-pointer-only variant. A dangling reference here was never a lost
    // fact — the inline body is written regardless — but it is still a lie, and
    // the verifier reports it as `object_missing`. Closing it uniformly beats
    // special-casing which envelopes are allowed to lie.
    const { raw, observation } = await insertEnvelopes({ payload, ref, pointerOnly: false });
    expect(raw.payloadRefVanished).toBe(true);
    expect(observation.payloadRefVanished).toBe(true);

    const rawRow = await rawPayloadRow(raw.id);
    expect(rawRow.payload_object_id).toBeNull();
    expect(rawRow.response_payload).toEqual(payload);
    const obsRow = await observationRow(observation.observationId);
    expect(obsRow.payload_object_id).toBeNull();
    expect(obsRow.payload).toEqual(payload);

    expect((await censusCapturePayloadDanglingRefs(testDb.db)).dangling).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("makes the sweep WAIT for a capture that got there first, and then keep the body", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await seedPage("writer-first");
    const payload = body("group blast");
    const ref = await casCommit(payload);

    // The other side of the order, and the half that cannot be tested without
    // two live connections: the capture takes its liveness lock and holds it,
    // the sweep blocks on `FOR UPDATE`, and when it finally looks the envelope
    // is there. If the lock were not held — or if the sweep computed its verdict
    // before taking it — this body would die under a live reference.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = testDb.db.transaction(async (tx) => {
      await insertObservation(asDb(tx), {
        source: "pull",
        producer: "sync:onlyfans:dm_messages",
        platform: "onlyfans",
        accountId: pageId,
        kind: "dm_messages",
        payload,
        payloadHash: Buffer.alloc(32),
        idempotencyKey: "race:writer-first",
        payloadRef: ref,
        omitInlinePayload: true,
      });
      await held;
    });

    // Let the writer reach its lock, then start the sweep and let it block.
    await sleep(300);
    const sweeping = runCatalogSweep();
    await sleep(500);
    release();
    await writer;
    const swept = await sweeping;

    expect(swept.deleted).toHaveLength(0);
    expect(swept.retained).toBe(1);
    expect(await objectExists(ref.objectId)).toBe(true);

    // The pointer-only row kept its reference, and the reference still resolves.
    const rows = await testDb.pool.query<{ id: string; payload: unknown; object_id: string | null }>(
      `select o.id::text as id, o.payload, o.payload_object_id::text as object_id
       from observations o`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.payload).toBeNull();
    expect(Number(rows.rows[0]!.object_id)).toBe(ref.objectId);
    expect(
      (await loadObservationPayload(appStub(), Number(rows.rows[0]!.id)))?.payload,
    ).toEqual(payload);
    expect((await censusCapturePayloadDanglingRefs(testDb.db)).dangling).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("runs the whole interleaving through the real capture seam, and the fact survives", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    // persistRawPayload takes new Date() for the CAS bucket. Keep it in the
    // fixture's month, otherwise September captures never dedup onto August's
    // object and this test stops exercising the race at the month boundary.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CAPTURE_INSTANT);
    await seedPage("real-seam");
    publishCaptureCasDualWritePages(String(pageId));
    publishCaptureCasPointerOnlyPages(String(pageId));
    const payload = body("through the seam");

    // The interleaving verbatim, with `persistRawPayload` — the function every
    // pull capture in the system goes through — as the capture side and the real
    // sanctioned deleter as the erasure side. It is deterministic because the
    // two lock modes make it so: the sweep holds `FOR UPDATE` on the object, so
    // the capture's CAS write (plain reads) still DEDUPS onto it and its
    // envelope insert then blocks exactly where the fix put the barrier.
    const ref = await casCommit(payload);

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked = () => {};
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const sweeping = testDb.db.transaction(async (tx) => {
      const result = await deleteUnreferencedCapturePayloadObjects(asDb(tx), [ref]);
      signalLocked();
      await held;
      return result;
    });
    await locked;

    const capturing = persistRawPayload(testDb.db, {
      platformAccountId: pageId,
      endpoint: "dm_messages",
      requestParams: {},
      responsePayload: payload,
      mapperVersion: "test-v1",
      payloadKind: "dm_messages",
      retainUntil: retentionDate(),
    }, { platform: "onlyfans" });

    // Observe the actual barrier instead of guessing how fast the CI runner is.
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
        const activity = await testDb.pool.query<{ blocked: boolean }>(`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query ilike '%capture_payload_objects%' and query ilike '%for key share%') as blocked
        `);
        blocked = activity.rows[0]?.blocked === true;
        if (!blocked) await sleep(25);
      }
      expect(blocked, "capture must wait on the erasure's object lock").toBe(true);
    } finally {
      release();
    }
    expect((await sweeping).deleted).toHaveLength(1);
    const receipt = await capturing;

    // The capture completed, its reference was dropped, its body is inline, and
    // BOTH envelopes are readable end to end.
    expect(receipt.payloadRefVanished).toBe(true);
    expect(await objectExists(ref.objectId)).toBe(false);
    expect((await rawPayloadRow(receipt.id)).payload_object_id).toBeNull();
    expect((await loadRawCaptureBody(appStub(), receipt.id))?.payload).toEqual(payload);

    const observations = await testDb.pool.query<{ id: string; object_id: string | null }>(
      `select o.id::text as id, o.payload_object_id::text as object_id from observations o`,
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]!.object_id).toBeNull();
    expect(
      (await loadObservationPayload(appStub(), Number(observations.rows[0]!.id)))?.payload,
    ).toEqual(payload);

    // The seam counted the race — once per envelope — and paged nothing: the
    // read/write paths own no alarm (#217), the hourly census does.
    expect(getCaptureCasDualWriteCounters().refVanished).toBe(2);
    expect((await censusCapturePayloadDanglingRefs(testDb.db)).dangling).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
