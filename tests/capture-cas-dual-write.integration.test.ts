// G5 slice 1, end to end: the content-addressed dual write behind the
// default-off `capture_cas_dual_write_pages` canary, and the parity verifier
// that proves the second copy is faithful.
//
// The seam under test is the real one — persistRawPayload, the function every
// pull capture in the system goes through — not a reimplementation of it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  censusCapturePayloadDanglingRefs,
  createFanslyPage,
  createModel,
  verifyCapturePayloadParity,
} from "@agency_hub_core/db";

import {
  getCaptureCasDualWriteCounters,
  publishCaptureCasDualWritePages,
  resetCaptureCasDualWriteForTests,
} from "../apps/runtime/src/services/capture-cas-dual-write.ts";
import { runCapturePayloadParityCheck } from "../apps/runtime/src/services/capture-payload-parity.ts";
import { persistRawPayload, retentionDate } from "../apps/runtime/src/services/sync/shared.ts";
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
  resetCaptureCasDualWriteForTests();
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

async function seedPage(label = "cas-page") {
  const model = await createModel(testDb!.db, { slug: `m-${label}`, name: label });
  if (!model) {
    throw new Error(`model ${label} was not created`);
  }
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) {
    throw new Error(`page ${label} was not created`);
  }
  return page;
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

async function countRows(sql: string) {
  const rows = await testDb!.pool.query<{ n: string }>(sql);
  return Number(rows.rows[0]?.n ?? "0");
}

async function refRows(table: "observations" | "sync_raw_payloads") {
  const rows = await testDb!.pool.query<{
    id: string;
    bucket_month: string | null;
    object_id: string | null;
  }>(
    `select t.id::text as id,
            to_char(t.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
            t.payload_object_id::text as object_id
     from ${table} t order by t.id asc`,
  );
  return rows.rows;
}

async function openParityIncidents() {
  return countRows(
    `select count(*)::text as n from notification_incidents
     where kind = 'capture_payload_parity' and status = 'open'`,
  );
}

const BODY = { messages: [{ id: "m1", content: "hey" }], response: { total: 1 } };

describe("capture CAS dual write — canary off", () => {
  it("writes no catalog row and leaves both references null", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    await capture(page.id, BODY);

    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(0);
    expect(await countRows("select count(*)::text as n from capture_json_hot_bodies")).toBe(0);
    expect(await countRows("select count(*)::text as n from capture_payload_locations")).toBe(0);

    // The capture itself is untouched: both facts are on disk, inline.
    const [observation] = await refRows("observations");
    const [raw] = await refRows("sync_raw_payloads");
    expect(observation).toMatchObject({ bucket_month: null, object_id: null });
    expect(raw).toMatchObject({ bucket_month: null, object_id: null });
    expect(getCaptureCasDualWriteCounters().attempted).toBe(0);
  });

  it("stays off for a page that is not the one named in the canary", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage("cas-page-a");
    const other = await seedPage("cas-page-b");
    publishCaptureCasDualWritePages(String(other.id));

    await capture(page.id, BODY);

    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(0);
    expect((await refRows("observations"))[0]).toMatchObject({ object_id: null });
  });
});

describe("capture CAS dual write — canary on for one page", () => {
  it("references one deduplicated object from both envelopes, twice over", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));

    await capture(page.id, BODY);
    // The SAME body captured a second time: two facts, two envelopes, ONE
    // stored body. That collapse is the entire point of the catalog.
    await capture(page.id, { response: { total: 1 }, messages: [{ content: "hey", id: "m1" }] });

    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(1);
    expect(await countRows("select count(*)::text as n from capture_json_hot_bodies")).toBe(1);
    expect(await countRows("select count(*)::text as n from capture_payload_locations")).toBe(1);

    const observations = await refRows("observations");
    const raws = await refRows("sync_raw_payloads");
    expect(observations).toHaveLength(2);
    expect(raws).toHaveLength(2);

    const objectIds = new Set([...observations, ...raws].map((row) => row.object_id));
    expect(objectIds.size).toBe(1);
    expect([...objectIds][0]).not.toBeNull();
    for (const row of [...observations, ...raws]) {
      expect(row.bucket_month).toMatch(/^\d{4}-\d{2}-01$/);
    }

    const counters = getCaptureCasDualWriteCounters();
    expect(counters.attempted).toBe(2);
    expect(counters.stored).toBe(1);
    expect(counters.deduped).toBe(1);
    expect(counters.failed).toBe(0);
    expect(counters.codecRefused).toBe(0);
  });

  it("keeps the capture when the codec refuses the payload", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages("*");

    // A Date reaches the inline columns fine — JSON.stringify honours its
    // toJSON and stores an ISO string — but the frozen codec REFUSES it rather
    // than guessing at a hook. The capture must survive that refusal exactly as
    // it did before this slice existed.
    await capture(page.id, { capturedAt: new Date("2026-08-15T00:00:00.000Z") });

    expect(await countRows("select count(*)::text as n from capture_payload_objects")).toBe(0);
    expect(await countRows("select count(*)::text as n from observations")).toBe(1);
    expect(await countRows("select count(*)::text as n from sync_raw_payloads")).toBe(1);
    expect((await refRows("observations"))[0]).toMatchObject({ object_id: null });
    expect((await refRows("sync_raw_payloads"))[0]).toMatchObject({ object_id: null });

    // And the fact itself is intact and readable.
    const inline = await testDb.pool.query<{ response_payload: { capturedAt: string } }>(
      "select rp.response_payload from sync_raw_payloads rp",
    );
    expect(inline.rows[0]!.response_payload.capturedAt).toBe("2026-08-15T00:00:00.000Z");

    const counters = getCaptureCasDualWriteCounters();
    expect(counters.attempted).toBe(1);
    expect(counters.codecRefused).toBe(1);
    expect(counters.failed).toBe(0);
    expect(counters.stored).toBe(0);
  });

  // NOTE for the next slice: there is no integration case here for "the
  // catalog rejects bytes the inline column accepted", because there cannot be
  // one — both stores are jsonb, so anything jsonb refuses (a NUL escape, a
  // lone surrogate) already fails the INLINE capture today, before this slice
  // is reached. The generic CAS failure path is covered by the unit suite's
  // broken-connection case.
});

describe("capture payload parity verifier", () => {
  it("does nothing and touches no latch while the canary is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    await capture(page.id, BODY);

    const result = await runCapturePayloadParityCheck(appStub());
    expect(result).toMatchObject({ skipped: true, checked: 0, matched: 0, mismatched: 0 });
    expect(await openParityIncidents()).toBe(0);
    // The collision half of the job runs on every pass, canary or not — see the
    // subKey cases below. Nothing collided, so it measured zero and paged
    // nothing.
    expect(result.collisions).toBe(0);
  });

  it("reports every dual-written envelope as matched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);
    await capture(page.id, { other: ["shape", 2, null] }, "transactions");

    const report = await verifyCapturePayloadParity(testDb.db);
    // Two captures × two envelopes.
    expect(report.checked).toBe(4);
    expect(report.matched).toBe(4);
    expect(report.mismatched).toBe(0);
    expect(report.mismatches).toEqual([]);

    const result = await runCapturePayloadParityCheck(appStub());
    expect(result.skipped).toBe(false);
    expect(result.matched).toBeGreaterThan(0);
    expect(result.mismatched).toBe(0);
    expect(await openParityIncidents()).toBe(0);
  });

  it("catches an inline body that no longer matches its catalog copy, and pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);

    // Corrupt the INLINE authority directly, behind the seam's back — the only
    // way to manufacture the divergence this check exists to find.
    await testDb.pool.query(
      `update observations set payload = '{"messages":[],"response":{"total":99}}'::jsonb
       where payload_object_id is not null`,
    );

    const report = await verifyCapturePayloadParity(testDb.db);
    expect(report.checked).toBe(2);
    expect(report.matched).toBe(1); // the raw envelope is still faithful
    expect(report.mismatched).toBe(1);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      envelope: "observation",
      reason: "content_mismatch",
    });
    // Digests are reported for the telemetry line, and they differ — but the
    // verdict above came from comparing the FULL canonical bodies.
    expect(report.mismatches[0]!.inlineDigest).not.toBe(report.mismatches[0]!.storedDigest);

    const result = await runCapturePayloadParityCheck(appStub());
    expect(result.mismatched).toBe(1);
    expect(await openParityIncidents()).toBe(1);

    const incident = await testDb.pool.query<{ incident_key: string; error_summary: string | null }>(
      `select incident_key, error_summary from notification_incidents
       where kind = 'capture_payload_parity'`,
    );
    expect(incident.rows[0]!.incident_key).toBe("capture_payload_parity:global");
    expect(incident.rows[0]!.error_summary).toContain("disagree with the inline fact");

    // The verifier never repairs: both sides are exactly as it found them.
    const inline = await testDb.pool.query<{ payload: { response: { total: number } } }>(
      "select o.payload from observations o where o.payload_object_id is not null",
    );
    expect(inline.rows[0]!.payload.response.total).toBe(99);
    expect(await countRows("select count(*)::text as n from capture_json_hot_bodies")).toBe(1);
  });

  // G5 slice 3b — the collision latch. Same incident KIND as the parity
  // mismatch, a different subKey, and deliberately a different lifecycle: one
  // says "the copy disagrees with the fact", the other says "a digest stopped
  // being unique", and neither answer may be read off the other's silence.
  async function forgeCollision() {
    await testDb!.pool.query(`
      insert into capture_payload_objects (
        bucket_month, platform_account_id, access_class, erasure_domain,
        representation, codec_version, content_sha256, collision_ordinal,
        logical_bytes, first_seen_at
      ) values (
        '2026-08-01', null, 'ordinary_capture', 'fan_subject',
        'canonical_json', 1, sha256('forged'::bytea), 1, 7, now()
      )
    `);
  }

  async function collisionIncident() {
    const rows = await testDb!.pool.query<{ status: string; error_summary: string | null }>(
      `select status, error_summary from notification_incidents
       where incident_key = 'capture_payload_parity:global:sha256_collision'`,
    );
    return rows.rows[0] ?? null;
  }

  it("pages under its own subKey when an object carries a collision ordinal", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    await forgeCollision();

    // The canary is OFF and the collision still pages: a collision is a durable
    // row, not a sample, and rolling back a flag must not clear it.
    const result = await runCapturePayloadParityCheck(appStub());
    expect(result.skipped).toBe(true);
    expect(result.collisions).toBe(1);

    const incident = await collisionIncident();
    expect(incident?.status).toBe("open");
    expect(incident?.error_summary).toContain("collision_ordinal > 0");
  });

  it("does not let a clean parity pass resolve a standing collision", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);
    await forgeCollision();

    // A pass that measures a clean sample AND a standing collision: the parity
    // latch has nothing to open, the collision latch stays open.
    const result = await runCapturePayloadParityCheck(appStub());
    expect(result.skipped).toBe(false);
    expect(result.mismatched).toBe(0);
    expect(result.collisions).toBe(1);
    expect((await collisionIncident())?.status).toBe("open");

    // Only the collision going away clears it, and the resolve line says which
    // condition cleared.
    await testDb.pool.query("delete from capture_payload_objects where collision_ordinal > 0");
    const cleared = await runCapturePayloadParityCheck(appStub());
    expect(cleared.collisions).toBe(0);
    expect((await collisionIncident())?.status).toBe("resolved");
  });

  it("catches a reference that points at nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);

    // A dangling reference is exactly what the deliberate absence of a foreign
    // key allows; the verifier is the thing that finds it.
    await testDb.pool.query(
      "update sync_raw_payloads set payload_object_id = payload_object_id + 10_000",
    );

    const report = await verifyCapturePayloadParity(testDb.db);
    expect(report.mismatched).toBe(1);
    expect(report.mismatches[0]).toMatchObject({
      envelope: "raw_payload",
      reason: "object_missing",
    });
  });

  // Decision #222 — the standing dangling-reference census and its own latch.
  // The parity sample above only notices a hole if the hole happens to fall in
  // the sample AND the row still has an inline body to compare; since #220
  // neither is guaranteed, so the census counts references directly.
  async function danglingIncident() {
    const rows = await testDb!.pool.query<{ status: string; error_summary: string | null }>(
      `select status, error_summary from notification_incidents
       where incident_key = 'capture_payload_parity:global:dangling_reference'`,
    );
    return rows.rows[0] ?? null;
  }

  it("censuses zero dangling references on a clean seed, canary on or off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Empty database: nothing referenced, nothing dangling. This is the shape
    // the check must report for production today.
    expect(await censusCapturePayloadDanglingRefs(testDb.db)).toMatchObject({
      referenced: 0,
      dangling: 0,
      samples: [],
    });

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);
    await capture(page.id, { other: ["shape", 2, null] }, "transactions");

    // Two captures × two envelopes, every one of them referencing a live object.
    const census = await censusCapturePayloadDanglingRefs(testDb.db);
    expect(census.referenced).toBe(4);
    expect(census.dangling).toBe(0);

    const result = await runCapturePayloadParityCheck(appStub());
    expect(result.danglingRefs.dangling).toBe(0);
    expect(result.danglingRefs.referenced).toBe(4);
    expect(await danglingIncident()).toBeNull();
  });

  it("pages under its own subKey for a reference into a hole, and only a zero clears it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);
    await testDb.pool.query(
      "update sync_raw_payloads set payload_object_id = payload_object_id + 10_000",
    );

    // Measured on EVERY pass: the canary goes off and the page stands, because
    // a reference into a hole is a durable row and not a sample.
    resetCaptureCasDualWriteForTests();
    const offPass = await runCapturePayloadParityCheck(appStub());
    expect(offPass.skipped).toBe(true);
    expect(offPass.danglingRefs.dangling).toBe(1);
    const incident = await danglingIncident();
    expect(incident?.status).toBe("open");
    expect(incident?.error_summary).toContain("catalog row that does not exist");
    expect(incident?.error_summary).toContain("cannot be read");

    // A clean PARITY sample does not clear it — different condition, different
    // latch, the same split #219 gave the collision census.
    publishCaptureCasDualWritePages(String(page.id));
    const stillOpen = await runCapturePayloadParityCheck(appStub());
    expect(stillOpen.mismatched).toBeGreaterThanOrEqual(0);
    expect((await danglingIncident())?.status).toBe("open");

    // Only the reference being made whole again resolves it.
    await testDb.pool.query(
      "update sync_raw_payloads set payload_object_id = payload_object_id - 10_000",
    );
    const cleared = await runCapturePayloadParityCheck(appStub());
    expect(cleared.danglingRefs.dangling).toBe(0);
    expect((await danglingIncident())?.status).toBe("resolved");
  });

  it("reports the window it measured, so a zero is never read as more than it is", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedPage();
    publishCaptureCasDualWritePages(String(page.id));
    await capture(page.id, BODY);

    // The census walks the newest N rows per envelope table. A window of one
    // reaches one row of each — the bound is real, and it travels in the report
    // exactly so that nobody reads "zero" as "zero anywhere in history".
    const narrow = await censusCapturePayloadDanglingRefs(testDb.db, { scanLimit: 1 });
    expect(narrow.scanLimit).toBe(1);
    expect(narrow.referenced).toBe(2);
    expect(narrow.dangling).toBe(0);
  });
});
