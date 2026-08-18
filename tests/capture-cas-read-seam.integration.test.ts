// G5 slice 2, end to end: the payload READ seam's three modes, over bodies put
// on disk by the REAL dual write (persistRawPayload with the slice-1 canary on)
// and read back through the REAL reader functions the slice migrated.
//
// THE TRICK THAT MAKES EVERY ASSERTION DECISIVE. After a faithful dual write
// the two copies are identical, so no reader can tell you which one it used.
// So each case CORRUPTS ONE SIDE with direct SQL — behind the seam's back, the
// only way to manufacture a divergence — and then asks a real reader what it
// sees. Corrupt inline, and only `serve` still reports the original. Corrupt the
// catalog, and `serve` must fall back and report inline anyway. The answer names
// the byte source; nothing else could.
//
// The readers exercised for real, not reimplemented:
//   * runCanonicalization      — the bulk observation replay driver
//                                (listObservationsForReplay → family parse →
//                                domain_events), the widest blast radius in the
//                                slice.
//   * buildMessagePayloadEnrichments — the webhook projection reader
//                                (findObservationEnvelopesByIds), which serves
//                                the v2 event stream's frame payloads.
//   * loadRawCaptureBody       — the seam's own sync_raw_payloads reader.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  insertObservation,
  listEventsSince,
  putPayloadObject,
} from "@agency_hub_core/db";

import {
  publishCaptureCasDualWritePages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import { runCapturePayloadParityCheck } from "../apps/runtime/src/services/capture-payload-parity.ts";
import {
  resetCanonicalizeSweepCursors,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { buildMessagePayloadEnrichments } from "../apps/runtime/src/services/domain-events-enrich.ts";
import {
  getCaptureCasReadCounters,
  loadRawCaptureBody,
  resetCaptureCasReadForTests,
  type CaptureCasReadMode,
} from "../apps/runtime/src/services/payload-reader.ts";
import { persistRawPayload, retentionDate } from "../apps/runtime/src/services/sync/shared.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

/** "The seam did nothing at all" — every counter it owns, at rest. Spelled out
 *  in full (not toMatchObject) on purpose: a new counter that starts ticking on
 *  a path claimed to be free must fail this, which is how slice 3c-1's
 *  null-inline counters were held to the same bar. */
const ZERO_READ_COUNTERS = {
  shadowChecked: 0,
  shadowMatched: 0,
  shadowMismatched: 0,
  served: 0,
  serveFellBack: 0,
  servedNullInline: 0,
  shadowSkippedNullInline: 0,
  nullInlineUnresolved: 0,
};

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  resetCaptureCasDualWriteForTests();
  resetCaptureCasReadForTests();
  resetCanonicalizeSweepCursors();
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

function appStub() {
  return {
    db: testDb!.db,
    config: { telegramEnabled: false },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage(label = "cas-read-page") {
  const model = await createModel(testDb!.db, { slug: `m-${label}`, name: label });
  if (!model) throw new Error(`model ${label} was not created`);
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error(`page ${label} was not created`);
  return page;
}

/** One transaction page, exactly the shape the fansly earnings canonicalizer
 *  reads. `transactionId` becomes the event's dedupKey, which makes it the
 *  perfect discriminator: change it on one side and the emitted event NAMES
 *  the side that was read. */
function txBody(transactionId: string) {
  return {
    total: 1,
    data: [{
      transactionId,
      correlationAccountId: "fan-2",
      type: 2110,
      amount: 100,
      destinationAmount: 80,
      status: 2,
      createdAt: Date.parse("2026-08-15T09:00:00Z"),
    }],
  };
}

async function capture(pageId: number, payload: unknown, endpoint = "earnings_transactions") {
  return persistRawPayload(testDb!.db, {
    platformAccountId: pageId,
    endpoint,
    requestParams: {},
    responsePayload: payload,
    mapperVersion: "test-v1",
    // The retention class is a closed enum and is irrelevant to this seam;
    // dm_messages is the ordinary capture class the dual-write suite uses too.
    payloadKind: "dm_messages",
    retainUntil: retentionDate(),
  }, { platform: "fansly" });
}

/** Rewrite the INLINE observation body of every referenced row. Direct SQL on
 *  purpose: nothing in the system is allowed to do this, which is exactly why
 *  it isolates the byte source. */
async function corruptInlineObservations(transactionId: string) {
  await testDb!.pool.query(
    `update observations set payload = $1::jsonb where payload_object_id is not null`,
    [JSON.stringify(txBody(transactionId))],
  );
}

async function canonicalizedDedupKeys(pageId: number) {
  const events = await listEventsSince(testDb!.db, { accountId: pageId, afterSeq: 0 });
  return events.filter((event) => event.type === "transaction.posted").map((e) => e.dedupKey);
}

describe("capture CAS read seam — observation replay reader (runCanonicalization)", () => {
  async function seedDivergentCapture() {
    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    // The REAL dual write puts "txn-catalog" in BOTH places...
    await capture(page.id, txBody("txn-catalog"));
    // ...and then only the inline copy is rewritten.
    await corruptInlineObservations("txn-inline");
    return page;
  }

  it("inline mode replays the INLINE body and never queries the catalog", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedDivergentCapture();
    resetCaptureCasReadForTests("inline");

    await runCanonicalization(appStub());

    expect(await canonicalizedDedupKeys(page.id)).toEqual(["txn:txn-inline"]);
    expect(getCaptureCasReadCounters()).toEqual(ZERO_READ_COUNTERS);
  });

  it("shadow mode replays the INLINE body and reports the divergence", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedDivergentCapture();
    resetCaptureCasReadForTests("shadow");

    await runCanonicalization(appStub());

    // THE load-bearing assertion of shadow mode: the answer is unchanged.
    expect(await canonicalizedDedupKeys(page.id)).toEqual(["txn:txn-inline"]);
    const counters = getCaptureCasReadCounters();
    expect(counters.shadowChecked).toBe(1);
    expect(counters.shadowMatched).toBe(0);
    expect(counters.shadowMismatched).toBe(1);
    expect(counters.served).toBe(0);
  });

  it("shadow mode counts a FAITHFUL copy as matched and changes nothing", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, txBody("txn-faithful"));
    resetCaptureCasReadForTests("shadow");

    await runCanonicalization(appStub());

    expect(await canonicalizedDedupKeys(page.id)).toEqual(["txn:txn-faithful"]);
    expect(getCaptureCasReadCounters()).toMatchObject({
      shadowChecked: 1,
      shadowMatched: 1,
      shadowMismatched: 0,
    });
  });

  it("serve mode replays the CATALOG body", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedDivergentCapture();
    resetCaptureCasReadForTests("serve");

    await runCanonicalization(appStub());

    // The inline column says "txn-inline"; the emitted fact says otherwise, so
    // the bytes came from the catalog and nowhere else.
    expect(await canonicalizedDedupKeys(page.id)).toEqual(["txn:txn-catalog"]);
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 1, serveFellBack: 0 });
  });

  it("serve mode falls back to inline when the CATALOG body is gone", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedDivergentCapture();
    // Destroy the catalog side instead of the inline one. Only this test may:
    // no deleter in the system touches these tables (DP 7).
    await testDb.pool.query("delete from capture_json_hot_bodies");
    resetCaptureCasReadForTests("serve");

    await runCanonicalization(appStub());

    expect(await canonicalizedDedupKeys(page.id)).toEqual(["txn:txn-inline"]);
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 0, serveFellBack: 1 });
  });

  it("serve mode falls back to inline when the reference dangles", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedDivergentCapture();
    await testDb.pool.query(
      "update observations set payload_object_id = payload_object_id + 10000 where payload_object_id is not null",
    );
    resetCaptureCasReadForTests("serve");

    await runCanonicalization(appStub());

    expect(await canonicalizedDedupKeys(page.id)).toEqual(["txn:txn-inline"]);
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 0, serveFellBack: 1 });
  });

  it("reads inline in EVERY mode when the envelope carries no reference", async (context) => {
    if (!testDb) return void context.skip();

    for (const mode of ["inline", "shadow", "serve"] as CaptureCasReadMode[]) {
      await resetIntegrationDatabase(testDb.pool);
      resetCanonicalizeSweepCursors();
      resetCaptureCasDualWriteForTests();

      const page = await seedPage(`no-ref-${mode}`);
      // Canary OFF: the capture is byte-identical to pre-slice-1, refs null.
      await capture(page.id, txBody("txn-unreferenced"));
      resetCaptureCasReadForTests(mode);

      await runCanonicalization(appStub());

      expect(await canonicalizedDedupKeys(page.id), mode).toEqual(["txn:txn-unreferenced"]);
      // A null reference costs nothing in any mode — no query, no counter.
      expect(getCaptureCasReadCounters(), mode).toEqual(ZERO_READ_COUNTERS);
    }
  });
});

describe("capture CAS read seam — webhook projection reader (buildMessagePayloadEnrichments)", () => {
  const WEBHOOK_KIND = "messages.received";

  function webhookBody(text: string) {
    return {
      event: WEBHOOK_KIND,
      account_id: "acct_x",
      payload: {
        id: 9001,
        createdAt: "2026-08-15T10:00:00+00:00",
        fromUser: { id: 777 },
        text,
        price: 0,
      },
    };
  }

  /** The webhook lane has no CAS writer yet (slice 1 carries pull capture
   *  only), so the reference is assembled here from the SAME two calls the
   *  dual write makes — putPayloadObject, then insertObservation carrying its
   *  ref — rather than from a hand-written row. */
  async function seedWebhookObservation(pageId: number) {
    const db = testDb!.db;
    const stored = await putPayloadObject(db, {
      representation: "canonical_json",
      json: webhookBody("catalog text"),
      captureInstant: new Date(),
      lane: "platform_capture",
      platformAccountId: pageId,
    });
    const inserted = await insertObservation(db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: pageId,
      kind: WEBHOOK_KIND,
      payload: webhookBody("catalog text"),
      payloadHash: createHash("sha256").update("wh-cas-1").digest(),
      idempotencyKey: "evt-cas-read-1",
      payloadRef: { bucketMonth: stored.bucketMonth, objectId: stored.objectId },
    });
    // Diverge the inline copy so the served text names its source.
    await testDb!.pool.query(
      `update observations set payload = $1::jsonb where id = $2`,
      [JSON.stringify(webhookBody("inline text")), inserted.observationId],
    );
    return inserted.observationId;
  }

  function frame(observationId: number, pageId: number) {
    return {
      id: 5001,
      accountId: pageId,
      currentAccountRef: "acct_x",
      accountSeq: 1,
      type: "message.received",
      occurredAt: new Date("2026-08-15T10:00:00Z"),
      fanIdentityRef: "777",
      conversationRef: "777",
      messageRef: "9001",
      transactionRef: null,
      data: {},
      schemaVersion: 1,
      observationId,
      dedupKey: "msg:received:9001",
      createdAt: new Date(),
    };
  }

  it.each([
    ["inline", "inline text"],
    ["shadow", "inline text"],
    ["serve", "catalog text"],
  ])("%s mode serves the %s", async (mode, expectedText) => {
    if (!testDb) return;

    const page = await seedPage(`wh-${mode}`);
    const observationId = await seedWebhookObservation(page.id);
    resetCaptureCasReadForTests(mode as CaptureCasReadMode);

    const enriched = await buildMessagePayloadEnrichments(
      appStub(),
      [frame(observationId, page.id) as never],
    );

    expect(enriched.get(5001)).toMatchObject({ id: "9001", text: expectedText });
  });

  it("shadow mode reports the divergence without touching the enrichment", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedPage("wh-shadow-counters");
    const observationId = await seedWebhookObservation(page.id);
    resetCaptureCasReadForTests("shadow");

    const enriched = await buildMessagePayloadEnrichments(
      appStub(),
      [frame(observationId, page.id) as never],
    );

    expect(enriched.get(5001)).toMatchObject({ text: "inline text" });
    expect(getCaptureCasReadCounters()).toMatchObject({
      shadowChecked: 1,
      shadowMatched: 0,
      shadowMismatched: 1,
    });
  });
});

describe("capture CAS read seam — raw capture reader (loadRawCaptureBody)", () => {
  async function seedRaw() {
    const page = await seedPage("raw-read");
    publishCaptureCasDualWritePages(String(page.id));
    // Keys deliberately NOT in sorted order, so the key-order question below is
    // a real question and not a coincidence of the fixture.
    const raw = await capture(page.id, {
      zeta: 1,
      alpha: { nested: "value", beta: [1, 2, 3] },
      middle: null,
    }, "dm_messages");
    return { page, rawId: raw.id };
  }

  it("serves the catalog body, and it JSON.stringifies identically to inline", async (context) => {
    if (!testDb) return void context.skip();

    const { rawId } = await seedRaw();

    resetCaptureCasReadForTests("inline");
    const fromInline = await loadRawCaptureBody(appStub(), rawId);

    resetCaptureCasReadForTests("serve");
    const fromCatalog = await loadRawCaptureBody(appStub(), rawId);

    expect(getCaptureCasReadCounters()).toMatchObject({ served: 1, serveFellBack: 0 });
    expect(fromCatalog!.payload).toEqual(fromInline!.payload);
    // The property the rejournal path depends on: it re-hashes what it reads
    // with sha256(JSON.stringify(payload)), so the two byte sources must
    // stringify identically. They do because BOTH are stored as jsonb, which
    // normalizes key order the same way on both sides — the canonical codec's
    // own ordering never survives into what a reader sees.
    expect(JSON.stringify(fromCatalog!.payload)).toBe(JSON.stringify(fromInline!.payload));
    expect(sha256Of(fromCatalog!.payload)).toBe(sha256Of(fromInline!.payload));
  });

  it("falls back to inline when the catalog body is missing", async (context) => {
    if (!testDb) return void context.skip();

    const { rawId } = await seedRaw();
    await testDb.pool.query("delete from capture_json_hot_bodies");

    resetCaptureCasReadForTests("serve");
    const read = await loadRawCaptureBody(appStub(), rawId);

    expect(read!.payload).toMatchObject({ zeta: 1, middle: null });
    expect(getCaptureCasReadCounters()).toMatchObject({ served: 0, serveFellBack: 1 });
  });
});

function sha256Of(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

describe("capture CAS read seam — the read path owns no alarm", () => {
  it("a shadow mismatch never opens the parity incident; only the verifier does", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, txBody("txn-catalog"));
    await corruptInlineObservations("txn-inline");
    resetCaptureCasReadForTests("shadow");

    await runCanonicalization(appStub());
    expect(getCaptureCasReadCounters().shadowMismatched).toBe(1);

    // The read path saw the divergence FIRST and deliberately did nothing about
    // the latch: an alarm needs an owner that runs on a schedule and can also
    // say "measured and clean".
    const beforeVerifier = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from notification_incidents
       where kind = 'capture_payload_parity' and status = 'open'`,
    );
    expect(Number(beforeVerifier.rows[0]!.n)).toBe(0);

    // The hourly verifier is the sole authority, and it pages.
    const report = await runCapturePayloadParityCheck(appStub());
    expect(report.mismatched).toBeGreaterThan(0);
    const afterVerifier = await testDb.pool.query<{ n: string }>(
      `select count(*)::text as n from notification_incidents
       where kind = 'capture_payload_parity' and status = 'open'`,
    );
    expect(Number(afterVerifier.rows[0]!.n)).toBe(1);
  });

  it("carries the read counters on the verifier's one telemetry line", async (context) => {
    if (!testDb) return void context.skip();

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, txBody("txn-telemetry"));
    resetCaptureCasReadForTests("shadow");
    await runCanonicalization(appStub());

    const lines: Array<Record<string, unknown>> = [];
    const app = {
      db: testDb.db,
      config: { telegramEnabled: false },
      logger: {
        info: (fields: Record<string, unknown>) => lines.push(fields),
        warn: () => {},
        error: () => {},
      },
    } as never;

    await runCapturePayloadParityCheck(app);

    const line = lines.find((entry) => entry.readCounters !== undefined);
    expect(line).toBeDefined();
    expect(line).toMatchObject({ readMode: "shadow" });
    expect(line!.readCounters).toMatchObject({ shadowChecked: 1, shadowMatched: 1 });
    expect(line!.writeCounters).toBeDefined();
  });
});
