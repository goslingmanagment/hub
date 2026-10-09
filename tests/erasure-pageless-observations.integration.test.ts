// Arena plan §7 «Стирание» (R4, PR10) — the fan erasure reaches the public
// reader's page-less journal BEFORE that reader exists (R5).
//
// The session-less public Fansly account reader journals its raw answer with
// NO page (`account_id` null) under `account_lookup_public`, one envelope per
// batch of up to 100 fan ids. Until this release the fan erasure found
// observations only by `account_id in` the platform's pages, so it would have
// left every such row behind. The rows below are inserted through the real
// `insertObservation` (and, for the pointer-only case, the real catalog
// writer) exactly as the R5 writer's contract — services/erasure/index.ts
// PAGELESS_FAN_OBSERVATION_KINDS — says it will write them.
//
// The multi-fan verdict is the module's existing one, not a new one: an
// observation no other fan's domain events reference is erased WHOLE (a
// page-less row can have no domain events at all), so a batch that names the
// erased fan goes with every fan in it. A body is never rewritten. What the
// bystander keeps is everything that does not name the erased fan.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  putPayloadObject,
} from "@agency_hub_core/db";

import {
  ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND,
  executeErasure,
  planErasure,
} from "../apps/runtime/src/services/erasure/index.ts";
import {
  TIERED_TABLES,
  ndjsonToParquet,
  readParquetIds,
} from "../apps/runtime/src/services/tiering/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const FAN_A = "400000000000000001";
const FAN_B = "400000000000000002";
/** Asked for and not found: named only by the requested-id list. */
const FAN_C = "400000000000000003";
const CAPTURE_INSTANT = new Date("2026-10-09T10:00:00.000Z");

let testDb: StartedTestDatabase | null = null;
let ownerId = 0;
let keySeq = 0;

function appStub(lakeDir = "/nonexistent-lake-dir") {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    // Without a lake: an unreadable directory reads as "no manifests".
    config: { lakeDir } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function count(text: string, params: unknown[] = []): Promise<number> {
  const { rows } = await testDb!.pool.query<{ n: string }>(`select count(*)::text as n from ${text}`, params);
  return Number(rows[0]?.n ?? 0);
}

async function survivingIds(ids: readonly number[]): Promise<number[]> {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    "select id::text as id from observations where id = any($1::bigint[]) order by id",
    [ids],
  );
  return rows.map((row) => Number(row.id));
}

/** Fansly's `/account?ids=` envelope: one record per account that answered. */
function lookupAnswer(...ids: string[]) {
  return {
    success: true,
    response: ids.map((id) => ({ id, username: `fan${id.slice(-1)}`, displayName: null })),
  };
}

/** One page-less row as the public reader journals it (contract items 1-2). */
async function journalPageless(input: {
  payload: unknown;
  kind?: string;
  payloadRef?: { bucketMonth: string; objectId: number };
}): Promise<number> {
  keySeq += 1;
  const result = await insertObservation(testDb!.db, {
    source: "pull",
    producer: "fansly-public-lookup",
    platform: "fansly",
    accountId: null,
    nativeAccountRef: null,
    kind: input.kind ?? ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND,
    payload: input.payload,
    payloadHash: createHash("sha256").update(JSON.stringify(input.payload)).digest(),
    idempotencyKey: `fansly-public-lookup:test:${keySeq}`,
    ...(input.payloadRef === undefined ? {} : { payloadRef: input.payloadRef, omitInlinePayload: true }),
  });
  return result.observationId;
}

/** Contract item 3: a catalog copy rides the `platform_capture` lane with no
 *  platform account. */
async function storePageless(body: unknown) {
  return putPayloadObject(testDb!.db, {
    representation: "canonical_json",
    json: body,
    captureInstant: CAPTURE_INSTANT,
    lane: "platform_capture",
    platformAccountId: null,
  });
}

async function journalOnPage(pageId: number, payload: unknown): Promise<number> {
  keySeq += 1;
  const result = await insertObservation(testDb!.db, {
    source: "pull",
    producer: "fansly-sync:fan-profiles",
    platform: "fansly",
    accountId: pageId,
    kind: "account_lookup",
    payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `fansly-sync:${pageId}:test:${keySeq}`,
  });
  return result.observationId;
}

async function seedCatalog(label: string) {
  const model = await createModel(testDb!.db, { slug: `pageless-${label}`, name: label });
  const page = await createFanslyPage(testDb!.db, { modelId: model!.id, label: `pageless-${label}` });
  ownerId = Number((await testDb!.pool.query<{ id: string }>(
    "insert into users (username, role) values ($1, 'owner') returning id::text as id",
    [`pageless-owner-${label}`],
  )).rows[0]!.id);
  for (const ref of [FAN_A, FAN_B]) {
    await testDb!.pool.query(
      `insert into fans (platform, platform_user_id, username, display_name)
       values ('fansly', $1, $2, $2)`,
      [ref, `fan${ref.slice(-1)}`],
    );
  }
  return { model: model!, page: page! };
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
    // The reset empties `public` only; parked partitions live elsewhere.
    await testDb.pool.query("drop schema if exists tiered_pending_drop cascade");
  }
  keySeq = 0;
});

let lakeDir = "";

afterEach(async () => {
  if (lakeDir) {
    await rm(lakeDir, { recursive: true, force: true });
    lakeDir = "";
  }
});

// ── Tiered planes, built the way tests/erasure.integration.test.ts builds
// them: a month detached into `tiered_pending_drop` and its Parquet export
// with a manifest. Until the owner drops the parked table a tiered row lives
// in both; after the drop only in the lake.

const TIERED_MONTH = "2026_09";
const TIERED_AT = "2026-09-15T00:00:00Z";
const PARKED_OBSERVATIONS = `tiered_pending_drop.observations_${TIERED_MONTH}`;

interface TieredObservation {
  id: number;
  platform: string | null;
  accountId: number | null;
  nativeAccountRef?: string | null;
  kind: string;
  payload: unknown;
  payloadRef?: { bucketMonth: string; objectId: number };
}

async function parkObservations(rows: readonly TieredObservation[]): Promise<void> {
  await testDb!.pool.query("create schema if not exists tiered_pending_drop");
  await testDb!.pool.query(
    `create table if not exists ${PARKED_OBSERVATIONS} (like observations including all)`,
  );
  for (const row of rows) {
    await testDb!.pool.query(
      `insert into ${PARKED_OBSERVATIONS}
         (id, source, producer, platform, account_id, native_account_ref, kind, payload,
          payload_hash, idempotency_key, received_at, parse_version,
          payload_bucket_month, payload_object_id)
       overriding system value
       values ($1, 'pull', 'tiered', $2, $3, $4, $5, $6::jsonb, sha256($7::bytea), $7, $8, 0,
               $9::date, $10)`,
      [
        row.id, row.platform, row.accountId, row.nativeAccountRef ?? null, row.kind,
        row.payload === null ? null : JSON.stringify(row.payload), `tiered:${row.id}`, TIERED_AT,
        row.payloadRef?.bucketMonth ?? null, row.payloadRef?.objectId ?? null,
      ],
    );
  }
}

/** The idempotency claim never tiers: it stays in `observation_keys`. */
async function claimKeys(rows: readonly TieredObservation[]): Promise<void> {
  for (const row of rows) {
    await testDb!.pool.query(
      `insert into observation_keys (source, idempotency_key, observation_id, received_at)
       values ('pull', $1, $2, $3)`,
      [`tiered:${row.id}`, row.id, TIERED_AT],
    );
  }
}

async function writeLakeFile(
  table: "observations" | "domain_events",
  docs: Array<Record<string, unknown>>,
): Promise<string> {
  const spec = TIERED_TABLES.find((candidate) => candidate.table === table)!;
  const dir = path.join(lakeDir, spec.plane, table, "2026");
  await mkdir(dir, { recursive: true });
  const parquet = path.join(dir, "09.parquet");
  const scratch = path.join(lakeDir, `seed-${table}.ndjson`);
  await writeFile(scratch, docs.map((doc) => JSON.stringify(doc)).join("\n") + "\n");
  await ndjsonToParquet(scratch, parquet, spec.columns);
  await rm(scratch);
  const ids = docs.map((doc) => Number(doc.id));
  await writeFile(path.join(dir, "09.manifest.json"), JSON.stringify({
    table,
    partition: `${table}_${TIERED_MONTH}`,
    rowCount: docs.length,
    restrictedRowCount: 0,
    minId: Math.min(...ids),
    maxId: Math.max(...ids),
    sha256: createHash("sha256").update(await readFile(parquet)).digest("hex"),
    restrictedSha256: null,
    exportedAt: "2026-10-01T00:00:00Z",
  }, null, 2));
  return parquet;
}

function lakeObservation(row: TieredObservation): Record<string, unknown> {
  return {
    id: row.id,
    source: "pull",
    producer: "tiered",
    platform: row.platform,
    account_id: row.accountId,
    native_account_ref: row.nativeAccountRef ?? null,
    kind: row.kind,
    payload: row.payload,
    payload_hash: "00",
    idempotency_key: `tiered:${row.id}`,
    observed_at: TIERED_AT,
    received_at: TIERED_AT,
    actor_principal_id: null,
    parse_version: 0,
    payload_bucket_month: row.payloadRef?.bucketMonth ?? null,
    payload_object_id: row.payloadRef?.objectId ?? null,
  };
}

async function parkedIds(): Promise<number[]> {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    `select id::text as id from ${PARKED_OBSERVATIONS} order by id`,
  );
  return rows.map((row) => Number(row.id));
}

async function objectAlive(ref: { bucketMonth: string; objectId: number }): Promise<boolean> {
  return await count(
    "capture_payload_objects where bucket_month = $1::date and object_id = $2",
    [ref.bucketMonth, ref.objectId],
  ) === 1 && await count(
    "capture_json_hot_bodies where bucket_month = $1::date and object_id = $2",
    [ref.bucketMonth, ref.objectId],
  ) === 1;
}

describe("fan erasure reaches the public reader's page-less journal (arena §7)", () => {
  it("erases every page-less lookup naming the fan, whole, inline and pointer-only; the bystander's own lookups survive", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { page } = await seedCatalog("fan");
    const scope = { scopeType: "fan", platform: "fansly", fanRef: FAN_A } as const;

    // Names A: a batch with the bystander, A alone, A only as an asked-for id
    // (a requested-id list, contract item 2), and a failed answer's body.
    const batch = await journalPageless({ payload: lookupAnswer(FAN_A, FAN_B) });
    const aloneA = await journalPageless({ payload: lookupAnswer(FAN_A) });
    const requestedA = await journalPageless({
      payload: { requestedIds: [FAN_A, FAN_C], answer: lookupAnswer(FAN_C) },
    });
    const failedA = await journalPageless({
      kind: `${ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND}:failed`,
      payload: { requestedIds: [FAN_A], status: 500, bodyText: "upstream error", truncated: false },
    });
    // Pointer-only: the body lives only in the catalog (G5 slice 3c-1).
    const bodyA = lookupAnswer(FAN_A, FAN_C);
    const objectA = await storePageless(bodyA);
    const pointerA = await journalPageless({ payload: bodyA, payloadRef: objectA });
    // The page-bound arm that was always there, for comparison.
    const onPageA = await journalOnPage(page.id, lookupAnswer(FAN_A));

    // Does not name A: the bystander's own lookups, inline and pointer-only.
    const aloneB = await journalPageless({ payload: lookupAnswer(FAN_B) });
    const bodyB = lookupAnswer(FAN_B, FAN_C);
    const objectB = await storePageless(bodyB);
    const pointerB = await journalPageless({ payload: bodyB, payloadRef: objectB });
    // Names A but is not on the list: page-less rows of other kinds — the
    // erasure's own audit trail among them — stay out of its reach.
    keySeq += 1;
    const operatorWitness = (await insertObservation(testDb.db, {
      source: "operator",
      producer: "audit",
      platform: null,
      accountId: null,
      kind: "erasure.executed",
      payload: { subject: FAN_A },
      payloadHash: createHash("sha256").update(FAN_A).digest(),
      idempotencyKey: `audit:test:${keySeq}`,
    })).observationId;

    const pointerRow = (await testDb.pool.query<{ inline: boolean }>(
      "select payload is not null as inline from observations where id = $1",
      [pointerA],
    )).rows[0]!;
    expect(pointerRow.inline, "the pointer-only row carries no inline body").toBe(false);

    const erased = [batch, aloneA, requestedA, failedA, pointerA, onPageA];
    const kept = [aloneB, pointerB, operatorWitness];

    // ── Dry run: every row naming A is a target; none is "shared" — a
    // page-less row has no domain events to share it by.
    const plan = await planErasure(appStub(), scope);
    const planRows = new Map(plan.targets.map((target) => [
      `${target.plane}:${target.target}:${target.action}`,
      target.rows,
    ]));
    expect(planRows.get("ledger:observations:delete")).toBe(erased.length);
    expect(planRows.get("ledger:observation_keys:delete")).toBe(erased.length);
    expect(planRows.get("catalog:capture_payload_objects:delete")).toBe(1);
    expect(plan.sharedObservations).toBe(0);
    expect(await survivingIds([...erased, ...kept])).toEqual([...erased, ...kept].sort((a, b) => a - b));

    // ── Execute.
    const result = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["ledger:observations:delete"]).toBe(erased.length);
    expect(result.executedCounts["ledger:observation_keys:delete"]).toBe(erased.length);
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(1);

    // A's rows are gone, the B+A batch whole with them; B's own rows and the
    // operator witness stay.
    expect(await survivingIds(erased)).toEqual([]);
    expect(await survivingIds(kept)).toEqual([...kept].sort((a, b) => a - b));
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [erased])).toBe(0);
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [kept])).toBe(kept.length);
    expect(await count(
      `observations where account_id is null and kind like '${ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND}%'
         and payload::text like $1`,
      [`%"${FAN_A}"%`],
    )).toBe(0);

    // The catalog body that named A died with its last envelope; B's lives.
    expect(await count(
      "capture_payload_objects where bucket_month = $1::date and object_id = $2",
      [objectA.bucketMonth, objectA.objectId],
    )).toBe(0);
    expect(await count(
      "capture_payload_objects where bucket_month = $1::date and object_id = $2",
      [objectB.bucketMonth, objectB.objectId],
    )).toBe(1);

    // The fan rows: A erased, the bystander untouched.
    expect(await count("fans where platform_user_id = $1", [FAN_A])).toBe(0);
    expect(await count("fans where platform_user_id = $1", [FAN_B])).toBe(1);

    // ── A re-run converges to zero.
    const rerun = await executeErasure(appStub(), scope, { initiatedBy: ownerId });
    for (const [key, value] of Object.entries(rerun.executedCounts)) {
      expect(value, key).toBe(0);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a page or model erasure leaves page-less rows alone, and a fan erasure on another platform does not reach them", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { model, page } = await seedCatalog("page");
    // An OnlyFans page, so an OnlyFans fan scope resolves at all.
    const ofModel = await createModel(testDb.db, { slug: "pageless-of", name: "of" });
    await createOnlyFansPage(testDb.db, { modelId: ofModel!.id, label: "pageless-of" });

    const pageless = await journalPageless({ payload: lookupAnswer(FAN_A, FAN_B) });
    const onPage = await journalOnPage(page.id, lookupAnswer(FAN_A));

    // The same digits as an OnlyFans fan ref: the page-less arm is Fansly's.
    const ofPlan = await planErasure(appStub(), { scopeType: "fan", platform: "onlyfans", fanRef: FAN_A });
    expect(ofPlan.targets.find((target) => target.target === "observations")?.rows).toBe(0);

    const pageResult = await executeErasure(
      appStub(),
      { scopeType: "page", pageLabel: page.label },
      { initiatedBy: ownerId },
    );
    expect(pageResult.executedCounts["ledger:observations:delete"]).toBe(1);
    expect(await survivingIds([pageless, onPage])).toEqual([pageless]);

    const modelResult = await executeErasure(
      appStub(),
      { scopeType: "model", modelSlug: model.slug },
      { initiatedBy: ownerId },
    );
    expect(modelResult.executedCounts["ledger:observations:delete"]).toBe(0);
    expect(await survivingIds([pageless])).toEqual([pageless]);
    expect(await count("observation_keys where observation_id = $1", [pageless])).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

// Arena R4 review (astra, PR #510): the page-less reach has to hold in the
// tiered planes too — the parked partition and the Parquet lake.
describe("the page-less reach in the tiered planes (parked partition and lake)", () => {
  it("a page erasure's lake rewrite keeps every row its predicate does not name: page-less rows and other pages' rows", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    lakeDir = await mkdtemp(path.join(tmpdir(), "pageless-lake-"));
    const { page: fanslyPage } = await seedCatalog("page-lake");
    const ofModel = await createModel(testDb.db, { slug: "pageless-lake-of", name: "of" });
    const ofPage = (await createOnlyFansPage(testDb.db, { modelId: ofModel!.id, label: "pageless-lake-of" }))!;
    // A native ref makes the page predicate `account_id in … or
    // native_account_ref in …`, the shape whose NULL arm dropped bystanders.
    await testDb.pool.query("update pages set ofapi_account_id = 'acct_erased' where id = $1", [ofPage.id]);

    const rows: TieredObservation[] = [
      // The erased page's row.
      { id: 910001, platform: "onlyfans", accountId: ofPage.id, nativeAccountRef: "acct_erased", kind: "messages.received", payload: { user_id: "77" } },
      // Today's shape: an OnlyFans webhook for an account no page is bound to.
      { id: 910002, platform: "onlyfans", accountId: null, nativeAccountRef: "acct_unbound", kind: "messages.received", payload: { user_id: "78" } },
      // The public reader's page-less row.
      { id: 910003, platform: "fansly", accountId: null, kind: ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND, payload: lookupAnswer(FAN_A) },
      // Another page's row without a native ref.
      { id: 910004, platform: "fansly", accountId: fanslyPage.id, kind: "account_lookup", payload: lookupAnswer(FAN_B) },
    ];
    await parkObservations(rows);
    await claimKeys(rows);
    const parquet = await writeLakeFile("observations", rows.map(lakeObservation));

    const ofErasure = await executeErasure(
      appStub(lakeDir),
      { scopeType: "page", pageLabel: ofPage.label },
      { initiatedBy: ownerId },
    );
    const lakeKey = "lake:capture/observations/2026/09.parquet:rewrite";
    expect(ofErasure.plan.targets.find((target) => target.plane === "lake")?.rows).toBe(1);
    expect(ofErasure.executedCounts[lakeKey]).toBe(1);
    expect(await readParquetIds(parquet)).toEqual([910002, 910003, 910004]);
    expect(await parkedIds()).toEqual([910002, 910003, 910004]);

    // A page scope without native refs: `account_id in …` alone.
    const fanslyErasure = await executeErasure(
      appStub(lakeDir),
      { scopeType: "page", pageLabel: fanslyPage.label },
      { initiatedBy: ownerId },
    );
    expect(fanslyErasure.executedCounts[lakeKey]).toBe(1);
    expect(await readParquetIds(parquet)).toEqual([910002, 910003]);
    expect(await parkedIds()).toEqual([910002, 910003]);
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [[910002, 910003]])).toBe(2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a fan erasure reaches a tiered page-less lookup, but not a page-less row of another kind, a pointer-only page row or a page event without a fan", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    lakeDir = await mkdtemp(path.join(tmpdir(), "pageless-lake-"));
    const { page } = await seedCatalog("fan-lake");
    const scope = { scopeType: "fan", platform: "fansly", fanRef: FAN_A } as const;
    const pageBody = { response: [{ postId: "p1", accountId: FAN_B }] };
    const pageObject = await putPayloadObject(testDb.db, {
      representation: "canonical_json",
      json: pageBody,
      captureInstant: CAPTURE_INSTANT,
      lane: "platform_capture",
      platformAccountId: page.id,
    });

    const rows: TieredObservation[] = [
      // Reached: the listed kind, page-less, naming A.
      { id: 920001, platform: "fansly", accountId: null, kind: ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND, payload: lookupAnswer(FAN_A, FAN_B) },
      // Not reached: page-less, naming A, of a kind not on the list — the
      // PostgreSQL arms keep it, so the lake must too (parked copy included).
      { id: 920002, platform: "fansly", accountId: null, kind: "unlisted.pageless.kind", payload: { subject: FAN_A } },
      // A pointer-only page row: NULL payload in the lake.
      { id: 920003, platform: "fansly", accountId: page.id, kind: "posts", payload: null, payloadRef: pageObject },
      // A's page row, and a page row no fan is named in.
      { id: 920004, platform: "fansly", accountId: page.id, kind: "dm_messages", payload: { fromUser: { id: FAN_A } } },
      { id: 920005, platform: "fansly", accountId: page.id, kind: "posts", payload: { post: "p2" } },
    ];
    await parkObservations(rows);
    await claimKeys(rows);
    const obsParquet = await writeLakeFile("observations", rows.map(lakeObservation));
    const event = (id: number, fanRef: string | null, observationId: number) => ({
      id,
      account_id: page.id,
      account_seq: id,
      type: fanRef === null ? "post.observed" : "message.received",
      occurred_at: TIERED_AT,
      fan_identity_ref: fanRef,
      conversation_ref: fanRef,
      message_ref: null,
      transaction_ref: null,
      post_ref: null,
      data: {},
      schema_version: 1,
      observation_id: observationId,
      dedup_key: `tiered:event:${id}`,
      created_at: TIERED_AT,
    });
    const eventParquet = await writeLakeFile("domain_events", [
      event(930001, FAN_A, 920004),
      event(930002, null, 920005),
    ]);

    const plan = await planErasure(appStub(lakeDir), scope);
    const planRows = new Map(plan.targets.map((target) => [
      `${target.plane}:${target.target}:${target.action}`,
      target.rows,
    ]));
    expect(planRows.get(`ledger:${PARKED_OBSERVATIONS}:delete`)).toBe(2);
    expect(planRows.get("lake:capture/observations/2026/09.parquet:rewrite")).toBe(2);
    expect(planRows.get("lake:ledger/domain_events/2026/09.parquet:rewrite")).toBe(1);

    const result = await executeErasure(appStub(lakeDir), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["lake:capture/observations/2026/09.parquet:rewrite"]).toBe(2);
    expect(result.executedCounts["lake:ledger/domain_events/2026/09.parquet:rewrite"]).toBe(1);

    expect(await parkedIds()).toEqual([920002, 920003, 920005]);
    expect(await readParquetIds(obsParquet)).toEqual([920002, 920003, 920005]);
    expect(await readParquetIds(eventParquet)).toEqual([930002]);
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [[920001, 920004]])).toBe(0);
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [[920002, 920003, 920005]])).toBe(3);
    expect(await objectAlive(pageObject)).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a tiered catalog-only lookup naming the fan is erased with its keys and body; a body a kept tiered row still needs survives", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    lakeDir = await mkdtemp(path.join(tmpdir(), "pageless-lake-"));
    await seedCatalog("catalog-lake");
    const scope = { scopeType: "fan", platform: "fansly", fanRef: FAN_A } as const;

    const objectA = await storePageless(lookupAnswer(FAN_A));
    const objectALakeOnly = await storePageless(lookupAnswer(FAN_A, FAN_C));
    const objectB = await storePageless(lookupAnswer(FAN_B));
    // Bodies naming A that rows the erasure KEEPS still need: one referenced
    // from the lake only, one from the parked partition only.
    const keptInLake = await storePageless({ subject: FAN_A, note: "lake" });
    const keptParked = await storePageless({ subject: FAN_A, note: "parked" });

    const pointer = (
      id: number,
      kind: string,
      payloadRef: { bucketMonth: string; objectId: number },
    ): TieredObservation => ({ id, platform: "fansly", accountId: null, kind, payload: null, payloadRef });
    const parkedAndLake = [
      pointer(940001, ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND, objectA),
      pointer(940003, ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND, objectB),
    ];
    const lakeOnly = [
      // Its parked table was dropped by the owner: the lake is all there is.
      pointer(940002, ACCOUNT_LOOKUP_PUBLIC_OBSERVATION_KIND, objectALakeOnly),
      pointer(940004, "unlisted.pageless.kind", keptInLake),
    ];
    const parkedOnly = [pointer(940005, "unlisted.pageless.kind", keptParked)];
    await parkObservations([...parkedAndLake, ...parkedOnly]);
    await claimKeys([...parkedAndLake, ...lakeOnly, ...parkedOnly]);
    const parquet = await writeLakeFile("observations", [...parkedAndLake, ...lakeOnly].map(lakeObservation));

    const plan = await planErasure(appStub(lakeDir), scope);
    const planRows = new Map(plan.targets.map((target) => [
      `${target.plane}:${target.target}:${target.action}`,
      target.rows,
    ]));
    // Every body naming A is in scope; only those of erased rows may die.
    expect(planRows.get("catalog:capture_payload_objects:delete")).toBe(4);
    expect(planRows.get("ledger:observation_keys:delete")).toBe(2);
    expect(planRows.get(`ledger:${PARKED_OBSERVATIONS}:delete`)).toBe(1);
    expect(planRows.get("lake:capture/observations/2026/09.parquet:rewrite")).toBe(2);

    const result = await executeErasure(appStub(lakeDir), scope, { initiatedBy: ownerId });
    expect(result.executedCounts["catalog:capture_payload_objects:delete"]).toBe(2);
    expect(result.executedCounts["ledger:observation_keys:delete"]).toBe(2);

    expect(await parkedIds()).toEqual([940003, 940005]);
    expect(await readParquetIds(parquet)).toEqual([940003, 940004]);
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [[940001, 940002]])).toBe(0);
    expect(await count("observation_keys where observation_id = any($1::bigint[])", [[940003, 940004, 940005]])).toBe(3);
    expect(await objectAlive(objectA)).toBe(false);
    expect(await objectAlive(objectALakeOnly)).toBe(false);
    expect(await objectAlive(objectB)).toBe(true);
    expect(await objectAlive(keptInLake)).toBe(true);
    expect(await objectAlive(keptParked)).toBe(true);

    // Converged: nothing left to erase, and no kept row points at a hole.
    const rerun = await executeErasure(appStub(lakeDir), scope, { initiatedBy: ownerId });
    for (const [key, value] of Object.entries(rerun.executedCounts)) {
      expect(value, key).toBe(0);
    }
    expect(await objectAlive(keptInLake)).toBe(true);
    expect(await objectAlive(keptParked)).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
