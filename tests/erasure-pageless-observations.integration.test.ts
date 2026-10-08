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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

function appStub() {
  return {
    db: testDb!.db,
    pool: testDb!.pool,
    // No lake here: an unreadable directory reads as "no manifests".
    config: { lakeDir: "/nonexistent-lake-dir" } as never,
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
  }
  keySeq = 0;
});

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
