import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  insertObservation,
  listEventsSince,
  markObservationParsed,
  putPayloadObject,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";

import {
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
  type CanonicalizationRunOptions,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase;
let pageId: number;
const EARNINGS = CANONICALIZER_FAMILIES.find(family => family.source === "pull" && family.lane === "earnings")!;
const BODY = [{ correlationAccountId: "fan-partition", totalGross: 1000, totalNet: 800, type: 1 }];
const UNBOUND_REF = "capture-waiting-for-binding";
type Refusal = "unmapped" | "unparseable" | "unavailable";

beforeAll(async () => {
  const database = await startIntegrationTestDatabase();
  if (!database) throw new Error("PostgreSQL is required for the pass-partition regression tests");
  testDb = database;
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  resetCanonicalizeSweepRuntime();
  const model = await createModel(testDb.db, { slug: "pass-partition", name: "Pass partition" });
  if (!model) throw new Error("Expected pass-partition fixture model");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "pass-partition" });
  if (!page) throw new Error("Expected pass-partition fixture page");
  pageId = page.id;
});

function app() {
  return {
    db: testDb.db,
    logger: { info() {}, warn() {}, error() {} },
  } as never;
}

async function capture(name: string, parseVersion = 0, refusal?: Refusal) {
  const payload = refusal === "unparseable" ? [{ ...BODY[0], totalGross: "invalid" }] : BODY;
  const receipt = await insertObservation(testDb.db, {
    source: "pull", producer: "sync:fansly:fan_earnings", platform: "fansly",
    accountId: refusal === "unmapped" ? null : pageId,
    nativeAccountRef: refusal === "unmapped" ? UNBOUND_REF : null,
    kind: "fan_earnings_stats", payload,
    payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    idempotencyKey: `pass-partition:${name}`,
  });
  if (parseVersion > 0) await markObservationParsed(testDb.db, {
    observationId: receipt.observationId, receivedAt: receipt.receivedAt, parseVersion,
  });
  if (refusal === "unavailable") {
    // A retained pointer-only envelope whose catalog copy is unavailable.
    // This is an isolated fixture, not a mutation of a real captured fact.
    await testDb.pool.query(
      `update observations set payload = null, payload_bucket_month = date_trunc('month', received_at)::date,
       payload_object_id = 999999999 where id = $1 and received_at = $2`,
      [receipt.observationId, receipt.receivedAt],
    );
  }
  return receipt;
}

async function versions() {
  const result = await testDb.pool.query<{ id: string; parse_version: number }>(
    "select o.id::text as id, o.parse_version from observations o order by o.id",
  );
  return new Map(result.rows.map(row => [Number(row.id), row.parse_version]));
}

function refusedCounts(refusal: Refusal) {
  return {
    skippedUnmapped: refusal === "unmapped" ? 1 : 0,
    skippedUnparseable: refusal === "unparseable" ? 1 : 0,
    skippedUnavailable: refusal === "unavailable" ? 1 : 0,
  };
}

describe("disjoint capture and replay passes", () => {
  it.each([3, 4, 5])("uses all %i pages for valid capture when replay is empty", async maxPages => {
    const receipts = [];
    for (let index = 0; index <= maxPages; index++) receipts.push(await capture(`capacity-${index}`));
    const options = { families: [EARNINGS], useSweepCursor: true, pageSize: 1, maxPagesPerFamily: maxPages };
    expect(await runCanonicalization(app(), options)).toMatchObject({
      scanned: maxPages, stamped: maxPages, appended: maxPages * 2, errored: 0,
    });
    expect([...(await versions()).values()]).toEqual([
      ...Array.from({ length: maxPages }, () => EARNINGS.version), 0,
    ]);
    resetCanonicalizeSweepRuntime();
    expect(await runCanonicalization(app(), options)).toMatchObject({ scanned: 1, stamped: 1, appended: 2 });
    expect((await versions()).get(receipts.at(-1)!.observationId)).toBe(EARNINGS.version);
  });

  it("runs reserved positive replay before returning its unused pages to capture", async () => {
    const fresh = [];
    for (let index = 0; index < 4; index++) fresh.push(await capture(`small-replay-fresh-${index}`));
    const old = await capture("small-replay-old", EARNINGS.version - 1);
    expect(await runCanonicalization(app(), {
      families: [EARNINGS], useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 5,
    })).toMatchObject({ scanned: 5, stamped: 5, appended: 10, errored: 0 });
    const order = await testDb.pool.query<{ observation_id: number }>(
      `select de.observation_id::int as observation_id from domain_events de
       where de.type = 'fan.earnings_observed' order by de.account_seq`,
    );
    expect(order.rows.map(row => row.observation_id)).toEqual([
      fresh[0]!.observationId, fresh[1]!.observationId, old.observationId,
      fresh[2]!.observationId, fresh[3]!.observationId,
    ]);
  });

  it.each([
    { pendingCount: 1, pageSize: 2, name: "partial page already wrapped" },
    { pendingCount: 2, pageSize: 1, name: "full page at the end of the quota" },
  ])("does not reopen a poison prefix after $name", async ({ pendingCount, pageSize }) => {
    for (let index = 0; index < pendingCount; index++) await capture(`poison-${index}`, 0, "unparseable");
    expect(await runCanonicalization(app(), {
      families: [EARNINGS], useSweepCursor: true, pageSize, maxPagesPerFamily: 4,
    })).toMatchObject({
      scanned: pendingCount, skippedUnparseable: pendingCount, stamped: 0, appended: 0, errored: 0,
    });
    expect([...(await versions()).values()]).toEqual(Array.from({ length: pendingCount }, () => 0));
  });

  it.each(["unmapped", "unparseable", "unavailable"] as const)(
    "reserves replay work when the oldest zero-version row is %s, including after restart",
    async refusal => {
      const pending = await capture("pending", 0, refusal);
      const old = await capture("old", EARNINGS.version - 1);
      const options = {
        families: [EARNINGS], useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 2,
      };

      // This is the original regression: with only <version on replay, the
      // pending row consumes BOTH pages and the older parser debt is untouched.
      // Each real earnings append also writes its projection checkpoint.
      expect(await runCanonicalization(app(), options)).toMatchObject({
        scanned: 2, stamped: 1, appended: 2, errored: 0, ...refusedCounts(refusal),
      });
      expect(await versions()).toEqual(new Map([
        [pending.observationId, 0], [old.observationId, EARNINGS.version],
      ]));

      const fresh = await capture("fresh-after-restart");
      const nextOld = await capture("next-old", EARNINGS.version - 1);
      resetCanonicalizeSweepRuntime();
      expect(await runCanonicalization(app(), options)).toMatchObject({
        scanned: 2, stamped: 2, appended: 4, errored: 0,
        skippedUnmapped: 0, skippedUnparseable: 0, skippedUnavailable: 0,
      });
      const afterRestart = await versions();
      expect(afterRestart.get(fresh.observationId)).toBe(EARNINGS.version);
      expect(afterRestart.get(nextOld.observationId)).toBe(EARNINGS.version);
      expect(afterRestart.get(pending.observationId)).toBe(0);

      // Exhausting the two durable cursors wraps them. The zero-version debt
      // is still reachable on the next cycle and is visited once, not twice.
      expect(await runCanonicalization(app(), options)).toMatchObject({ scanned: 0 });
      resetCanonicalizeSweepRuntime();
      expect(await runCanonicalization(app(), options)).toMatchObject({
        scanned: 1, stamped: 0, appended: 0, errored: 0, ...refusedCounts(refusal),
      });
      expect((await versions()).get(pending.observationId)).toBe(0);
    },
  );

  it.each(["unmapped", "unavailable"] as const)(
    "processes a previously %s zero-version row after repair",
    async refusal => {
      const pending = await capture("repair", 0, refusal);
      const options = {
        families: [EARNINGS], useSweepCursor: true, pageSize: 10, maxPagesPerFamily: 2,
      };
      expect(await runCanonicalization(app(), options)).toMatchObject({
        scanned: 1, stamped: 0, appended: 0, errored: 0, ...refusedCounts(refusal),
      });
      if (refusal === "unmapped") {
        await updatePageMetadata(testDb.db, pageId, {
          platformAccountIdValue: UNBOUND_REF, username: null, displayName: null,
          followerCount: null, subscriberCount: null, earningsBalanceMills: millsFromInteger(0), metadata: {},
        });
      } else {
        // Reattach the original body's catalog reference; no parse stamp is
        // forged and the body still has to pass through the real read seam.
        const object = await putPayloadObject(testDb.db, {
          representation: "canonical_json", json: BODY, captureInstant: pending.receivedAt,
          lane: "platform_capture", platformAccountId: pageId,
        });
        await testDb.pool.query(
          `update observations set payload_bucket_month = $1::date, payload_object_id = $2
           where id = $3 and received_at = $4`,
          [object.bucketMonth, object.objectId, pending.observationId, pending.receivedAt],
        );
      }
      resetCanonicalizeSweepRuntime();
      expect(await runCanonicalization(app(), options)).toMatchObject({
        scanned: 1, stamped: 1, appended: 2, errored: 0,
        skippedUnmapped: 0, skippedUnparseable: 0, skippedUnavailable: 0,
      });
      expect((await versions()).get(pending.observationId)).toBe(EARNINGS.version);
      const events = await listEventsSince(testDb.db, { accountId: pageId, afterSeq: 0 });
      expect(events.filter(event => event.type === "fan.earnings_observed")).toHaveLength(1);
    },
  );

  const unsplitModes: Array<{ name: string; options: CanonicalizationRunOptions; prioritizeUnparsed?: boolean }> = [
    { name: "ordinary CLI replay", options: {} },
    { name: "non-prioritized sweep", options: { useSweepCursor: true }, prioritizeUnparsed: false },
    { name: "dry-run", options: { useSweepCursor: true, dryRun: true } },
    { name: "single-page sweep", options: { useSweepCursor: true, maxPagesPerFamily: 1 } },
  ];
  it.each(unsplitModes)("keeps version zero in $name", async ({ options, prioritizeUnparsed }) => {
    const fresh = await capture("unsplit-fresh");
    const old = await capture("unsplit-old", EARNINGS.version - 1);
    expect(await runCanonicalization(app(), {
      families: [{ ...EARNINGS, prioritizeUnparsed: prioritizeUnparsed ?? true }],
      pageSize: 10, maxPagesPerFamily: 2, ...options,
    })).toMatchObject({
      scanned: 2, stamped: options.dryRun ? 0 : 2, appended: options.dryRun ? 2 : 4, errored: 0,
    });
    expect(await versions()).toEqual(new Map([
      [fresh.observationId, options.dryRun ? 0 : EARNINGS.version],
      [old.observationId, options.dryRun ? EARNINGS.version - 1 : EARNINGS.version],
    ]));
  });

  it("keeps an exact-observation replay eligible at version zero", async () => {
    const first = await capture("exact-first");
    const exact = await capture("exact-target");
    expect(await runCanonicalization(app(), {
      families: [EARNINGS], observationId: exact.observationId,
    })).toMatchObject({ scanned: 1, stamped: 1, appended: 2, errored: 0 });
    expect(await versions()).toEqual(new Map([
      [first.observationId, 0], [exact.observationId, EARNINGS.version],
    ]));
  });

  it("preserves an explicit CLI version ceiling of one and its stamp", async () => {
    const fresh = await capture("ceiling-fresh");
    const old = await capture("ceiling-old", EARNINGS.version - 1);
    expect(await runCanonicalization(app(), {
      families: [EARNINGS], useSweepCursor: true, belowParseVersion: 1,
      pageSize: 10, maxPagesPerFamily: 2,
    })).toMatchObject({ scanned: 1, stamped: 1, appended: 2, errored: 0 });
    expect(await versions()).toEqual(new Map([
      [fresh.observationId, 1], [old.observationId, EARNINGS.version - 1],
    ]));
  });

  it("retains a family's higher minimum instead of reopening unsettled captures", async () => {
    const pending = await capture("minimum-zero");
    const belowMinimum = await capture("minimum-one", 1);
    const eligible = await capture("minimum-eligible", EARNINGS.version - 1);
    expect(await runCanonicalization(app(), {
      families: [{ ...EARNINGS, minimumParseVersion: EARNINGS.version - 1 }],
      useSweepCursor: true, pageSize: 10, maxPagesPerFamily: 2,
    })).toMatchObject({ scanned: 1, stamped: 1, appended: 2, errored: 0 });
    expect(await versions()).toEqual(new Map([
      [pending.observationId, 0], [belowMinimum.observationId, 1], [eligible.observationId, EARNINGS.version],
    ]));
  });

  it("reopens positive parser debt on a version bump alongside new zero-version captures", async () => {
    const fresh = await capture("bump-fresh");
    const old = await capture("bump-old", EARNINGS.version);
    const bumpedVersion = EARNINGS.version + 1;
    expect(await runCanonicalization(app(), {
      families: [{ ...EARNINGS, version: bumpedVersion }],
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 2,
    })).toMatchObject({ scanned: 2, stamped: 2, appended: 4, errored: 0 });
    expect(await versions()).toEqual(new Map([
      [fresh.observationId, bumpedVersion], [old.observationId, bumpedVersion],
    ]));
  });
});
