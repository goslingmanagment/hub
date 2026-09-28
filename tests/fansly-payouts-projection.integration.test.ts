// WP-F7 end to end: journaled payout responses become the money-out head, and
// stay reproducible from the ledger alone.
//
// The claims here are DATABASE claims, and three of them are specific to this
// family:
//
//  - THE CREDENTIAL CANNOT REACH A TABLE. The journal holds the creator's full
//    email verbatim (DP 7) and `page_payout_methods` holds `f***@…`. Asserted
//    on the VALUES in the table, not on the column list, and asserted from the
//    other end too — the raw body still has the address, because the mask is a
//    projection rule and never a capture rule.
//  - `missing_since` IS A REPLAYED FACT. It is written by the roster event
//    (`payout.method_list_observed`), never by a sweep, so a truncate-and-replay
//    reproduces it exactly. The hardest case is the one with no row events at
//    all: a method listing that comes back EMPTY.
//  - A STATUS CHANGE IS A REVISION. One new event, one head update, and the
//    label moves with the code — `unmapped:<code>` when nobody has a name for
//    it, because money that failed reported as processed is worse than an
//    honest gap.
//
// Plus the ordinary ones: replay is a no-op, mills round-trip exactly, nothing
// is ever deleted, and a rebuild reproduces every column.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendProjectionOnlyDomainEvents,
  createFanslyPage,
  createModel,
  ensureDomainEventPartitions,
  insertObservation,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import {
  FANSLY_PAYOUTS_PROJECTION,
  FANSLY_PAYOUTS_PROJECTION_TABLES,
  measureFanslyPayouts,
  rebuildFanslyPayoutsProjection,
  runFanslyPayoutsProjection,
} from "../apps/runtime/src/services/projections/fansly-payouts.ts";
import { findProjection } from "../apps/runtime/src/services/projections/registry.ts";
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
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
  resetCanonicalizeSweepRuntime();
});

const FIXTURES = path.resolve("tests/fixtures/fansly-payouts");
const PAYOUT_KINDS = ["payout_methods", "payout_requests"];
const LIVE_EMAIL = "fixture.creator@example.invalid";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function sha256(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "payouts", name: "Payouts" });
  if (!model) throw new Error("Expected the payouts test model to be created");
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "payouts-page" });
  if (!page) throw new Error("Expected the payouts test page to be created");
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    "acct-payouts",
    page.id,
  ]);
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

async function seedObservation(pageId: number, kind: string, key: string, payload: unknown) {
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:payouts",
    platform: "fansly",
    accountId: pageId,
    kind,
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `${kind}:${key}`,
  });
}

async function project(pageId: number) {
  await runCanonicalization(appStub(), { kinds: PAYOUT_KINDS });
  return await runFanslyPayoutsProjection(appStub(), { accountId: pageId });
}

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await testDb!.pool.query(sql, params);
  return result.rows as T[];
}

/**
 * Every table this projection owns, checksummed the way the §9.1 matrix does:
 * CONTENT, not row count, so a replay that loses a column still fails.
 *
 * `created_at` and `updated_at` are stripped, and only those two. They are
 * row-bookkeeping written by `now()`, so a rebuild moves them by construction.
 * `first_observed_at`, `last_observed_at` and `missing_since` all stay IN —
 * they are derived from the ledger, and a rebuild that moved one of them is
 * exactly the defect this test exists for.
 */
async function checksums(pageId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of FANSLY_PAYOUTS_PROJECTION_TABLES) {
    const result = await testDb!.pool.query(
      `select md5(string_agg(row_text, '|' order by row_text)) as digest,
              count(*)::int as rows
         from (
           select (to_jsonb(t) - 'created_at' - 'updated_at')::text as row_text
             from ${table} t where page_id = $1
         ) stripped`,
      [pageId],
    );
    const record = result.rows[0] as { digest: string | null; rows: number };
    out[table] = `${record.rows}:${record.digest ?? "empty"}`;
  }
  return out;
}

/**
 * A look that reached the ledger as a ROSTER and nothing else: the first
 * method roster again, at a later instant, with no row event before it. That
 * is what an unchanged returning method minted under the hash-only
 * `payoutmethod:v1` row key (the row events deduped), and a truncate-and-replay
 * of that history still feeds the projector exactly this.
 */
async function appendRosterOnlyLook(pageId: number) {
  const [roster] = await rows<{ data: unknown; schema_version: number; observation_id: string }>(
    `select data, schema_version, observation_id::text
       from domain_events
      where account_id = $1 and type = 'payout.method_list_observed'
      order by account_seq limit 1`,
    [pageId],
  );
  const occurredAt = new Date();
  const observationId = Number(roster!.observation_id);
  await appendProjectionOnlyDomainEvents(testDb!.db, pageId, [{
    type: "payout.method_list_observed",
    occurredAt,
    data: roster!.data,
    schemaVersion: roster!.schema_version,
    observationId,
    dedupKey: `test:roster-only-look:${pageId}`,
  }], {
    occurredAt,
    observationId,
    dedupKey: `test:roster-only-look:checkpoint:${pageId}`,
  });
}

/** Every string anywhere in a value, so a credential cannot hide in a jsonb
 *  column or a nested array. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) allStrings(item, out);
  }
  return out;
}

describe("[sync-critical] WP-F7 payouts projection", () => {
  it("projects both surfaces, and replaying appends nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "payout_methods", "m1", fixture("payout-methods").rows);
    await seedObservation(
      page.id,
      "payout_requests",
      "r1",
      fixture("payout-requests-page").page,
    );
    const first = await project(page.id);
    expect(first.methods).toBe(2);
    expect(first.payouts).toBe(3);

    const before = await checksums(page.id);
    const second = await project(page.id);
    // A REPLAY IS A NO-OP: the dedup keys are content-addressed, so nothing new
    // is appended and nothing new is applied.
    expect(second.applied).toBe(0);
    expect(await checksums(page.id)).toEqual(before);
  });

  it("NEVER lets a payout credential reach a serving table", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "payout_methods", "m1", fixture("payout-methods").rows);
    await project(page.id);

    const methods = await rows(
      `select method_ref, provider_id, provider_label, type, flags, status,
              masked_label, metadata_parse_ok, missing_since
         from page_payout_methods where page_id = $1 order by method_ref`,
      [page.id],
    );
    expect(methods).toHaveLength(2);
    expect(methods[0]).toMatchObject({
      provider_id: 2,
      // PAXUM, not PayPal (A22-4).
      provider_label: "paxum",
      masked_label: "f***@example.invalid",
      metadata_parse_ok: true,
      missing_since: null,
    });
    expect(methods[1]).toMatchObject({
      provider_id: 30,
      provider_label: "usdt",
      masked_label: "****1a2b",
    });

    // ASSERTED ON THE VALUES, not on the column list: a future column that
    // carried the address would pass a column-name check and fail this one.
    const everything = await rows(
      `select to_jsonb(t) as row from page_payout_methods t where page_id = $1`,
      [page.id],
    );
    for (const record of everything) {
      for (const value of allStrings(record.row)) {
        expect(value).not.toContain(LIVE_EMAIL);
        expect(value).not.toMatch(/[\w.+-]{2,}@[\w.-]+\.[a-z]{2,}/iu);
      }
    }

    // AND FROM THE OTHER END. The journal still has it, verbatim, because
    // capture-first means the mask is a projection rule: a scrubber at the
    // journal would have destroyed the only copy of the fact, and the fact is
    // what a rebuild replays from.
    const journaled = await rows<{ payload: unknown }>(
      `select payload from observations where account_id = $1 and kind = 'payout_methods'`,
      [page.id],
    );
    expect(JSON.stringify(journaled[0]?.payload)).toContain(LIVE_EMAIL);

    // And the DATABASE refuses the shape independently of the parser: a label
    // carrying an `@` must be the pinned mask.
    await expect(testDb!.pool.query(
      `insert into page_payout_methods (
         page_id, platform, method_ref, provider_label, masked_label,
         first_observed_at, last_observed_at, content_hash,
         source_event_id, source_observation_id, source_account_seq
       ) values ($1, 'fansly', 'leak', 'paxum', $2, now(), now(), repeat('a', 64), 1, 1, 1)`,
      [page.id, LIVE_EMAIL],
    )).rejects.toThrow(/masked_label/);
  });

  it("lets NOTHING out of an unknown provider, and records an unreadable one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "payout_methods",
      "adv",
      fixture("payout-methods-adversarial").rows,
    );
    await project(page.id);

    const methods = await rows(
      `select method_ref, provider_id, provider_label, masked_label, metadata_parse_ok
         from page_payout_methods where page_id = $1 order by method_ref`,
      [page.id],
    );
    expect(methods).toHaveLength(3);

    // PROVIDER 99 — a provider that does not exist today, whose payload looks
    // exactly like provider 30's. A shape-keyed decoder would have published
    // whatever it chose to end `field1` with.
    const future = methods.find((row) => row.method_ref === "000900000000009101")!;
    expect(future.provider_id).toBe(99);
    expect(future.provider_label).toBe("unmapped:99");
    expect(future.masked_label).toBeNull();

    // UNREADABLE METADATA — the row still exists, and says so.
    const broken = methods.find((row) => row.method_ref === "000900000000009102")!;
    expect(broken.metadata_parse_ok).toBe(false);
    expect(broken.masked_label).toBeNull();

    // Nothing from any of it reached ANY column of the table.
    const everything = await rows(
      `select to_jsonb(t) as row from page_payout_methods t where page_id = $1`,
      [page.id],
    );
    const serialized = JSON.stringify(everything);
    for (const secret of [
      "FUTURECOIN",
      "0xFIXTUREWALLET",
      "RECOVERY",
      "cafebabe",
      "unterminated",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // The journal has all of it. That is the point of journaling first.
    const journaled = await rows<{ payload: unknown }>(
      `select payload from observations where account_id = $1 and kind = 'payout_methods'`,
      [page.id],
    );
    expect(JSON.stringify(journaled[0]?.payload)).toContain("RECOVERY");
  });

  it("stores mills EXACTLY and the status one code deep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(
      page.id,
      "payout_requests",
      "r1",
      fixture("payout-requests-page").page,
    );
    await project(page.id);

    const payouts = await rows(
      `select payout_ref, amount_mills, method_ref, status_code, status_label,
              status_confidence, requested_at, updated_at_platform, version
         from page_payout_requests where page_id = $1 order by payout_ref`,
      [page.id],
    );
    expect(payouts).toHaveLength(3);
    // $131 on screen, 131 000 on the wire, 131 000 in the column. There is no
    // scaling anywhere on this lane. Compared as BIGINTS — the column is bigint
    // mills and the driver hands it back as one, so a float that happened to
    // print the same digits could not satisfy this.
    expect(payouts[0]!.amount_mills).toBe(131000n);
    expect(payouts[1]!.amount_mills).toBe(2102632n);
    expect(payouts[2]!.amount_mills).toBe(1600n);

    expect(payouts[0]).toMatchObject({
      status_code: 8,
      status_label: "Processed",
      status_confidence: "mapped",
    });
    // The one code nobody has a label for. The ROW IS STILL THERE — dropping it
    // would make the history quietly agree with itself and disagree with the
    // platform.
    expect(payouts[1]).toMatchObject({
      status_code: 4,
      status_label: "unmapped:4",
      status_confidence: "unmapped",
    });

    // The 2023-dated row keeps its TRUE date in the projection, even though its
    // EVENT is dated at receipt (§3.2b).
    const oldest = payouts.find((row) => row.payout_ref === "000900000000008003")!;
    expect(new Date(oldest.requested_at as string).getUTCFullYear()).toBe(2023);

    const census = await measureFanslyPayouts(testDb!.db, page.id);
    expect(census.requests).toBe(3);
    expect(census.oldestRequestedAt?.getUTCFullYear()).toBe(2023);
  });

  it("treats a status change as a REVISION: one new event, one head update", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const page1 = fixture("payout-requests-page").page as {
      total: number;
      data: Record<string, unknown>[];
    };
    await seedObservation(page.id, "payout_requests", "r1", page1);
    await project(page.id);

    const moved = {
      total: page1.total,
      data: [{ ...page1.data[0], status: 4, version: 9 }, ...page1.data.slice(1)],
    };
    await seedObservation(page.id, "payout_requests", "r2", moved);
    const second = await project(page.id);
    expect(second.payouts).toBe(1);

    const head = await rows(
      `select status_code, status_label, status_confidence, version
         from page_payout_requests where page_id = $1 and payout_ref = $2`,
      [page.id, "000900000000008001"],
    );
    expect(head[0]).toMatchObject({
      status_code: 4,
      status_label: "unmapped:4",
      status_confidence: "unmapped",
      version: 9,
    });

    // NOTHING WAS DELETED and nothing was overwritten in place: the ledger grew
    // by exactly one event, which is what makes the head reproducible.
    const events = await rows<{ n: string }>(
      `select count(*)::text as n from domain_events
        where account_id = $1 and type = 'payout.observed'`,
      [page.id],
    );
    expect(Number(events[0]!.n)).toBe(4);
    expect((await rows(`select 1 from page_payout_requests where page_id = $1`, [page.id])))
      .toHaveLength(3);
  });

  it("marks a removed method missing, and un-marks it when it returns", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const both = fixture("payout-methods").rows as Record<string, unknown>[];
    await seedObservation(page.id, "payout_methods", "m1", both);
    await project(page.id);

    // The creator removes the USDT method. It produces ONE row event (the
    // survivor) and a roster naming only that one.
    await seedObservation(page.id, "payout_methods", "m2", [both[0]]);
    await project(page.id);

    const marked = await rows(
      `select method_ref, missing_since from page_payout_methods
        where page_id = $1 order by method_ref`,
      [page.id],
    );
    expect(marked[0]!.missing_since).toBeNull();
    expect(marked[1]!.missing_since).not.toBeNull();
    const firstMark = marked[1]!.missing_since;

    // A SECOND listing without it must NOT move the timestamp: the instant a
    // method FIRST went missing is the interesting one.
    await seedObservation(page.id, "payout_methods", "m3", [both[0]]);
    await project(page.id);
    const stillMarked = await rows(
      `select missing_since from page_payout_methods
        where page_id = $1 and method_ref = $2`,
      [page.id, "000900000000009002"],
    );
    expect(stillMarked[0]!.missing_since).toEqual(firstMark);

    // AND IT COMES BACK UNCHANGED. Its row event is keyed per LOOK
    // (`payoutmethod:v2`), so it reaches the projector and its own upsert clears
    // the mark. Under the hash-only `payoutmethod:v1` key that row event
    // deduped, and only the roster could un-mark it; the roster's clear half
    // stays for those events (the next test replays that shape).
    await seedObservation(page.id, "payout_methods", "m4", both);
    await project(page.id);
    const cleared = await rows(
      `select missing_since from page_payout_methods
        where page_id = $1 and method_ref = $2`,
      [page.id, "000900000000009002"],
    );
    expect(cleared[0]!.missing_since).toBeNull();
  });

  it("un-marks a returning method from the roster alone, as hash-keyed row events replay", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const both = fixture("payout-methods").rows as Record<string, unknown>[];
    await seedObservation(page.id, "payout_methods", "m1", both);
    await project(page.id);
    await seedObservation(page.id, "payout_methods", "m2", [both[0]]);
    await project(page.id);

    // The method comes back UNCHANGED in the ledger's older shape: a roster
    // with no row event before it (see `appendRosterOnlyLook`). No upsert runs,
    // so the roster's clear half is the only thing that can un-mark it — the
    // case a rebuild over pre-`payoutmethod:v2` history depends on.
    await appendRosterOnlyLook(page.id);
    const result = await runFanslyPayoutsProjection(appStub(), { accountId: page.id });
    expect(result.methods).toBe(0);
    expect(result.clearedMissing).toBe(1);
    const cleared = await rows(
      `select missing_since from page_payout_methods
        where page_id = $1 and method_ref = $2`,
      [page.id, "000900000000009002"],
    );
    expect(cleared[0]!.missing_since).toBeNull();
  });

  it("marks EVERY method missing on an EMPTY listing — the case with no row events", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedObservation(page.id, "payout_methods", "m1", fixture("payout-methods").rows);
    await project(page.id);

    await seedObservation(page.id, "payout_methods", "empty", []);
    const result = await project(page.id);
    expect(result.markedMissing).toBe(2);

    const marked = await rows<{ n: string }>(
      `select count(*)::text as n from page_payout_methods
        where page_id = $1 and missing_since is not null`,
      [page.id],
    );
    expect(Number(marked[0]!.n)).toBe(2);
    // NEVER A DELETE (DP 7). The rows are still there, and they still carry the
    // mask that says what they were.
    const survivors = await rows<{ n: string }>(
      `select count(*)::text as n from page_payout_methods where page_id = $1`,
      [page.id],
    );
    expect(Number(survivors[0]!.n)).toBe(2);
  });

  it("reproduces every column, `missing_since` included, from the ledger alone", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const both = fixture("payout-methods").rows as Record<string, unknown>[];
    await seedObservation(page.id, "payout_methods", "m1", both);
    await seedObservation(
      page.id,
      "payout_requests",
      "r1",
      fixture("payout-requests-page").page,
    );
    await project(page.id);
    // Make the state interesting BEFORE the checksum: a marked method is the
    // hardest thing for a rebuild to reproduce, because nothing in a row event
    // says it.
    await seedObservation(page.id, "payout_methods", "m2", [both[0]]);
    await project(page.id);

    const before = await checksums(page.id);
    expect(before["page_payout_methods"]).not.toMatch(/^0:/);
    expect(before["page_payout_requests"]).not.toMatch(/^0:/);

    const rebuilt = await rebuildFanslyPayoutsProjection(appStub(), { accountId: page.id });
    expect(rebuilt.applied).toBeGreaterThan(0);
    // BYTE FOR BYTE, without reading a single observation body.
    expect(await checksums(page.id)).toEqual(before);

    const watermark = await rows<{ n: string }>(
      `select count(*)::text as n from projection_seq_watermarks
        where projection = $1 and account_id = $2`,
      [FANSLY_PAYOUTS_PROJECTION, page.id],
    );
    expect(Number(watermark[0]!.n)).toBe(1);
  });

  it("is registered with its tables, its types and a truncate-replay rebuild", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const definition = findProjection(FANSLY_PAYOUTS_PROJECTION);
    expect(definition).toBeDefined();
    expect(definition?.stateClass).toBe("fact_projection");
    expect(definition?.rebuildKind).toBe("truncate_replay");
    expect([...(definition?.tables ?? [])].sort()).toEqual([
      "page_payout_methods",
      "page_payout_requests",
    ]);
    expect([...(definition?.eventTypes ?? [])].sort()).toEqual([
      "payout.method_list_observed",
      "payout.method_observed",
      "payout.observed",
    ]);
  });
});
