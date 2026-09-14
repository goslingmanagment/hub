import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "@agency_hub_core/shared";
import {
  createModel, createOnlyFansPage, insertObservation, listEventsSince,
  listObservationsForReplay, putPayloadObject, readEnvelopeCapturePayloadBatch,
  setPageOfapiAccountId, type ReplayObservationRow,
} from "@agency_hub_core/db";
import {
  createCapturePayloadRowResolver, getCaptureCasReadCounters,
  resetCaptureCasReadForTests, resolveCapturePayloadRow, type CaptureCasReadMode,
} from "../apps/runtime/src/services/payload-reader.ts";
import { resetCanonicalizeSweepRuntime, runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;
const NOW = new Date("2026-09-12T12:00:00Z");
const webhook = CANONICALIZER_FAMILIES.find(family => family.source === "webhook")!;

beforeAll(async () => { testDb = await startIntegrationTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb!.pool);
  resetCaptureCasReadForTests();
  resetCanonicalizeSweepRuntime();
});

function app(failQueries: readonly number[] = []) {
  let queries = 0;
  const db = new Proxy(testDb!.db, { get(target, property) {
    if (property !== "execute") return Reflect.get(target, property, target);
    return (...args: Parameters<typeof target.execute>) => {
      queries += 1;
      if (failQueries.includes(queries)) throw new Error("Synthetic transient read failure");
      return target.execute(...args);
    };
  } });
  return {
    db, logger: createLogger("silent"),
    queryCount: () => queries,
  };
}

type SeedEnvelope = Partial<Pick<ReplayObservationRow, "accountId" | "nativeAccountRef" | "platform" | "kind">>;

async function seed(
  storage: "inline" | "pointer" | "dual" = "pointer",
  payload: unknown = { payload: { id: randomUUID() } },
  envelope: SeedEnvelope = {},
) {
  const object = storage === "inline" ? null : await putPayloadObject(testDb!.db, {
    representation: "canonical_json", json: payload, captureInstant: NOW, lane: "platform_capture",
    platformAccountId: envelope.accountId ?? null,
  });
  const receipt = await insertObservation(testDb!.db, {
    source: "webhook", producer: "ofapi:webhook", platform: "onlyfans", kind: "messages.deleted",
    accountId: null, nativeAccountRef: "acct_batch", ...envelope, payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: randomUUID(), receivedAt: NOW,
    payloadRef: object === null ? null : { bucketMonth: object.bucketMonth, objectId: object.objectId },
    omitInlinePayload: storage === "pointer",
  });
  return (await listObservationsForReplay(testDb!.db, { observationId: receipt.observationId, belowParseVersion: 99 }))[0]!;
}

interface WireQuery { text: string; values: unknown[] }

/** Record actual wire queries and optionally interleave a committed action
 * after one has completed. No repository or canonicalizer is mocked. */
async function withWireQueries<T>(run: () => Promise<T>, afterQuery?: (query: WireQuery) => Promise<void>) {
  const pool = testDb!.pool as unknown as {
    query: (config: unknown, values?: unknown) => Promise<unknown>;
  };
  const original = pool.query;
  const queries: WireQuery[] = [];
  pool.query = async (config, values) => {
    const query: { text: string; values?: unknown[] } = typeof config === "string" ? { text: config }
      : config as { text: string; values?: unknown[] };
    const statement = { text: query.text, values: (values as unknown[] | undefined) ?? query.values ?? [] };
    queries.push(statement);
    const result = await original.call(pool, config, values);
    await afterQuery?.(statement);
    return result;
  };
  try { return { result: await run(), queries }; }
  finally { pool.query = original; }
}

function batchQueries(queries: WireQuery[]) {
  return queries.filter(query => query.text.includes("requested(position, bucket_month, object_id)"));
}

async function mappedPage(nativeRef: string) {
  const model = await createModel(testDb!.db, { slug: randomUUID(), name: "Batch fixture" });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label: randomUUID() });
  await setPageOfapiAccountId(testDb!.db, { pageId: page!.id, ofapiAccountId: nativeRef });
  return page!;
}

async function outcomes(rows: ReplayObservationRow[], batch: boolean, mode: CaptureCasReadMode, failures: readonly number[] = []) {
  resetCaptureCasReadForTests(mode);
  const context = app(failures);
  const resolve = batch ? createCapturePayloadRowResolver(context, "observation", rows)
    : (row: ReplayObservationRow) => resolveCapturePayloadRow(context, "observation", row.id, row);
  const results = [];
  for (const row of rows) {
    try { results.push({ id: row.id, payload: (await resolve(row)).payload }); }
    catch (error) {
      const failure = error as { name: string; detail: { reason: string } };
      results.push({ id: row.id, error: failure.name, reason: failure.detail.reason });
    }
  }
  return { results, counters: getCaptureCasReadCounters(), queries: context.queryCount() };
}

describe("bounded fresh capture payload reads", () => {
  it.each(["inline", "shadow", "serve"] as const)("keeps mixed-body outcomes and counters in %s mode", async mode => {
    const rows = [await seed("inline"), await seed(), await seed("dual"), await seed("pointer", null)];
    const missingBody = await seed();
    await testDb!.pool.query("delete from capture_json_hot_bodies where bucket_month=$1 and object_id=$2",
      [missingBody.payloadRef!.bucketMonth, missingBody.payloadRef!.objectId]);
    rows.push(missingBody);
    const missingObject = await seed("inline");
    missingObject.payload = null;
    missingObject.payloadRef = { bucketMonth: "2026-09-01", objectId: 99999999 };
    rows.push(missingObject);
    const wrongObject = await putPayloadObject(testDb!.db, {
      representation: "exact_bytes", canonicalBytes: Buffer.from("synthetic bytes"), captureInstant: NOW, lane: "platform_capture",
    });
    const wrongRepresentation = await seed("inline");
    wrongRepresentation.payload = null;
    wrongRepresentation.payloadRef = { bucketMonth: wrongObject.bucketMonth, objectId: wrongObject.objectId };
    rows.push(wrongRepresentation);
    rows.push(await seed("pointer", { text: "x".repeat(600_000) }));
    const single = await outcomes(rows, false, mode);
    const batched = await outcomes(rows, true, mode);
    expect(batched.results).toEqual(single.results);
    expect(batched.counters).toEqual(single.counters);
    expect(batched.queries).toBe(mode === "inline" ? 2 : 3); // batch + large body + optional dual-copy read
    expect(single.queries).toBe(mode === "inline" ? 6 : 7);
  });

  it("keeps inline rows free of catalog queries and limits pointer groups to eight", async () => {
    const inline = await Promise.all(Array.from({ length: 12 }, () => seed("inline")));
    expect((await outcomes(inline, true, "shadow")).queries).toBe(0);
    const pointers = await Promise.all(Array.from({ length: 17 }, () => seed()));
    expect((await outcomes(pointers, true, "inline")).queries).toBe(3);
    await expect(readEnvelopeCapturePayloadBatch(testDb!.db, { envelope: "observation", refs: pointers.slice(0, 9).map(row => row.payloadRef!) }))
      .rejects.toThrow("at most eight");
  });

  it("falls back after a batch failure without rejecting healthy sibling rows", async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, () => seed()));
    const expected = await outcomes(rows, false, "inline");
    const recovered = await outcomes(rows, true, "inline", [1]);
    expect(recovered.results).toEqual(expected.results);
    expect(recovered.counters).toEqual(expected.counters);
    expect(recovered.queries).toBe(9);
    const oneBad = await outcomes(rows, true, "inline", [1, 2]);
    expect(oneBad.results[0]).toMatchObject({ error: "CapturePayloadUnavailableError", reason: "read_error" });
    expect(oneBad.results.slice(1)).toEqual(expected.results.slice(1));
    expect(oneBad.counters).toMatchObject({ servedNullInline: 7, nullInlineUnresolved: 1 });
  });

  it("reads repaired bodies and changed references on the next visit", async () => {
    const originalBody = { payload: { id: "restored-original" } };
    const first = await seed("pointer", originalBody);
    const second = await seed();
    const replacement = await seed();
    const context = app();
    const resolve = createCapturePayloadRowResolver(context, "observation", [first, second]);
    await resolve(first); // prefetches second's original reference
    second.payloadRef = replacement.payloadRef;
    const expected = await resolveCapturePayloadRow(context, "observation", replacement.id, replacement);
    expect((await resolve(second)).payload).toEqual(expected.payload);
    const ref = first.payloadRef!;
    await testDb!.pool.query("delete from capture_json_hot_bodies where bucket_month=$1 and object_id=$2", [ref.bucketMonth, ref.objectId]);
    expect((await outcomes([first, second], true, "inline")).results[0])
      .toMatchObject({ error: "CapturePayloadUnavailableError", reason: "body_missing" });
    await testDb!.pool.query("insert into capture_json_hot_bodies(bucket_month,object_id,body) values ($1,$2,$3::jsonb)",
      [ref.bucketMonth, ref.objectId, JSON.stringify(originalBody)]);
    expect((await outcomes([first, second], true, "inline")).results[0])
      .toMatchObject({ payload: originalBody });
  });

  it("returns duplicate references by position without sharing mutable parsed values", async () => {
    const row = await seed();
    const results = await readEnvelopeCapturePayloadBatch(testDb!.db, { envelope: "observation", refs: [row.payloadRef!, row.payloadRef!] });
    expect(results[0]).toEqual(results[1]);
    if (results[0]!.status !== "loaded" || results[1]!.status !== "loaded") throw new Error("Expected loaded bodies");
    expect(results[0]!.json).not.toBe(results[1]!.json);
  });

  it("keeps replay debt, late binding, stamp/dedup and dry-run behavior", async () => {
    const rows = await Promise.all(Array.from({ length: 9 }, () => seed()));
    const context = app();
    const options = { families: [webhook], useSweepCursor: true, now: NOW };
    const firstRead = await withWireQueries(() => runCanonicalization(context, options));
    const againRead = await withWireQueries(() => runCanonicalization(context, options));
    const first = firstRead.result;
    const again = againRead.result;
    expect(first).toEqual(again);
    expect(first).toMatchObject({ scanned: 9, skippedUnmapped: 9, stamped: 0, errored: 0 });
    expect(batchQueries(firstRead.queries)).toHaveLength(1);
    expect(batchQueries(againRead.queries)).toHaveLength(1);
    const page = await mappedPage("acct_batch");
    const dryRun = await withWireQueries(() => runCanonicalization(context, { ...options, dryRun: true }));
    expect(dryRun.result).toMatchObject({ appended: 9, stamped: 0 });
    expect(batchQueries(dryRun.queries)).toEqual([]);
    const mappedRun = await withWireQueries(() => runCanonicalization(context, options));
    expect(mappedRun.result).toMatchObject({ appended: 9, stamped: 9 });
    expect(batchQueries(mappedRun.queries)).toEqual([]);
    expect(mappedRun.queries.filter(query => query.text.includes("from capture_payload_objects o"))).toHaveLength(9);
    expect(await runCanonicalization(context, options)).toMatchObject({ scanned: 0, appended: 0 });
    expect(await runCanonicalization(context, { ...options, useSweepCursor: false, belowParseVersion: 99 }))
      .toMatchObject({ deduped: 9, stamped: 9, appended: 0 });
    expect((await listEventsSince(testDb!.db, { accountId: page!.id, afterSeq: 0 })).map(event => event.observationId).sort((a,b) => a-b))
      .toEqual(rows.map(row => row.id).sort((a,b) => a-b));
  });

  it("never prefetches mapped, ambiguous or export neighbors of an unmapped row", async () => {
    const page = await mappedPage("acct_bound");
    const first = await seed();
    const direct = await seed("pointer", undefined, { accountId: page.id });
    const byRef = await seed("pointer", undefined, { nativeAccountRef: "acct_bound" });
    const noRef = await seed("pointer", undefined, { nativeAccountRef: null });
    const noPlatform = await seed("pointer", undefined, { platform: null });
    const exported = await seed("pointer", {
      event: "data_exports.completed",
      payload: { id: "data_export_batch", status: "completed", account_ids: ["acct_bound"] },
    }, { kind: "data_exports.completed" });
    const last = await seed();
    // The same native text on a different platform remains unmapped.
    const otherPlatform = await seed("pointer", undefined, { platform: "fansly", nativeAccountRef: "acct_bound" });
    const empty = await seed("pointer", null);
    const { result, queries } = await withWireQueries(() => runCanonicalization(app(), { families: [webhook], now: NOW }));
    expect(result).toMatchObject({ scanned: 9, appended: 3, stamped: 4, skippedUnmapped: 5, errored: 0 });
    const batches = batchQueries(queries);
    expect(batches).toHaveLength(1);
    const prefetchedIds = batches[0]!.values.filter((_value, index) => index % 3 === 2).map(Number);
    expect(prefetchedIds).toEqual([first, last, otherPlatform, empty].map(row => row.payloadRef!.objectId));
    for (const row of [direct, byRef, noRef, noPlatform, exported]) {
      expect(prefetchedIds).not.toContain(row.payloadRef!.objectId);
    }
    // A valid empty capture keeps the existing zero-draft stamp.
    expect(await listObservationsForReplay(testDb!.db, { observationId: empty.id, belowParseVersion: webhook.version }))
      .toEqual([]);
  });

  it("does not resurrect a mapped pointer body erased between processing two pages' rows", async () => {
    const firstPage = await mappedPage("acct_first");
    const erasedPage = await mappedPage("acct_erased");
    const first = await seed("pointer", undefined, { accountId: firstPage.id, nativeAccountRef: "acct_first" });
    const second = await seed("pointer", undefined, { accountId: erasedPage.id, nativeAccountRef: "acct_erased" });
    const owner = await testDb!.pool.query<{ id: string }>(
      "insert into users(username,role) values ($1,'owner') returning id::text as id", [randomUUID()],
    );
    const lakeDir = await mkdtemp(path.join(tmpdir(), "binding-batch-erasure-"));
    let erased = false;
    try {
      const { result, queries } = await withWireQueries(
        () => runCanonicalization(app(), { families: [webhook], now: NOW }),
        async query => {
          if (erased || !query.text.includes("update observations set parse_version") || Number(query.values[1]) !== first.id) return;
          erased = true;
          const deletion = await executeErasure({
            db: testDb!.db, pool: testDb!.pool, logger: createLogger("silent"), config: { lakeDir },
          } as never, { scopeType: "page", pageLabel: erasedPage.label }, { initiatedBy: Number(owner.rows[0]!.id) });
          expect(deletion.executedCounts["catalog:capture_payload_objects:delete"]).toBe(1);
        },
      );
      expect(erased).toBe(true);
      expect(result).toMatchObject({ scanned: 2, appended: 1, stamped: 1, skippedUnavailable: 1, errored: 0 });
      expect(batchQueries(queries)).toEqual([]);
      expect(await listEventsSince(testDb!.db, { accountId: erasedPage.id, afterSeq: 0 })).toEqual([]);
      expect(await listObservationsForReplay(testDb!.db, { observationId: second.id, belowParseVersion: 99 })).toEqual([]);
      // The retained in-memory row sees the same unavailable result through
      // the original per-row seam after the governed erasure committed.
      await expect(resolveCapturePayloadRow(app(), "observation", second.id, second))
        .rejects.toMatchObject({ name: "CapturePayloadUnavailableError", detail: { reason: "object_missing" } });
      expect((await testDb!.pool.query("select id from pages where id=$1", [erasedPage.id])).rows).toHaveLength(1);
    } finally {
      await rm(lakeDir, { recursive: true, force: true });
    }
  }, 30_000);
});
