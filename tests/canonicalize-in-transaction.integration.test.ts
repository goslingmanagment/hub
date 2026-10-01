// The Fansly Sync Engine's inline canonicalization (design §3.7 tx 3, §3.11;
// S2-05) against Postgres:
//   - for every family the engine journals, the events it stores inside the
//     caller's transaction are the events the minutely driver stores for the
//     same observation (same rows, same order, same seq, same stamp);
//   - everything commits or rolls back with the caller's transaction;
//   - when the driver got there first, the append dedups to nothing and the
//     archive feed still finds the stored rows by dedup key
//     (`listDomainEventsByDedupKeys`);
//   - refusals, cold months and unmapped rows stay unstamped for the sweep;
//     a dropped (fenced) draft never reaches the ledger.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyMessageEventsToArchive,
  createFanslyPage,
  createModel,
  type Database,
  insertObservation,
  listDomainEventsByDedupKeys,
  listEventsSince,
} from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";
import { buildCanonicalDrafts } from "../apps/runtime/src/services/canonicalize-drafts.ts";
import {
  canonicalizeObservationInTransaction,
  DriverOnlyCanonicalizationError,
} from "../apps/runtime/src/sync/engine/canonicalize.ts";
import {
  canonicalFamilyFixtures,
  FIXTURE_FANSLY_OWN_REF,
  FIXTURE_FANSLY_PAGE_ID,
  FIXTURE_NOW,
  type CanonicalFamilyFixture,
} from "./helpers/canonicalize-family-fixtures.ts";
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
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

/** Families the engine journals: the Fansly page's pull captures and WS frames. */
const ENGINE_FIXTURES = canonicalFamilyFixtures()
  .filter((fixture) => fixture.observation.accountId === FIXTURE_FANSLY_PAGE_ID && fixture.expect === "drafts");

class Rollback extends Error {}

function appStub() {
  return { db: testDb!.db, logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;
}

async function seedFanslyPage(label: string, ownRef = FIXTURE_FANSLY_OWN_REF) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  const page = await createFanslyPage(testDb!.db, { modelId: model!.id, label });
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [ownRef, page!.id]);
  return page!.id;
}

/** Journals the fixture for `pageId` and returns the row the engine holds. */
async function journal(fixture: CanonicalFamilyFixture, pageId: number): Promise<CanonicalizableObservation> {
  const { observation } = fixture;
  const inserted = await insertObservation(testDb!.db, {
    source: observation.source as "pull",
    producer: observation.producer,
    platform: observation.platform,
    accountId: pageId,
    kind: observation.kind,
    payload: observation.payload,
    payloadHash: createHash("sha256").update(JSON.stringify(observation.payload)).digest(),
    idempotencyKey: `s205:${fixture.name}:${pageId}`,
    receivedAt: observation.receivedAt,
  });
  return { ...observation, id: inserted.observationId, accountId: pageId, receivedAt: inserted.receivedAt };
}

/** The stored rows minus what differs between two appends of the same
 *  facts by construction (identity id, insert time). */
async function storedEvents(db: Database, pageId: number) {
  const rows = await listEventsSince(db, { accountId: pageId, afterSeq: 0, limit: 10_000 });
  return rows.map(({ id: _id, createdAt: _createdAt, ...row }) => row);
}

async function parseVersion(observation: CanonicalizableObservation) {
  return (await testDb!.pool.query<{ parse_version: number }>(
    "select parse_version from observations where id = $1 and received_at = $2",
    [observation.id, observation.receivedAt],
  )).rows[0]!.parse_version;
}

/** The drafts the shared seam builds for the engine's page. */
function seamDrafts(observation: CanonicalizableObservation, pageId: number) {
  const outcome = buildCanonicalDrafts(familyForObservation(observation)!, observation, {
    ...engineContext(pageId),
    now: FIXTURE_NOW,
  });
  if (outcome.kind !== "accepted") throw new Error("fixture refused");
  return outcome.drafts;
}

function context() {
  return { nativeAccountRefByAccountId: new Map<number, string | null>(), now: FIXTURE_NOW };
}

function engineContext(pageId: number) {
  return { ...context(), nativeAccountRefByAccountId: new Map<number, string | null>([[pageId, FIXTURE_FANSLY_OWN_REF]]) };
}

describe("canonicalizeObservationInTransaction", () => {
  for (const fixture of ENGINE_FIXTURES) {
    it(`${fixture.name}: stores what the minutely driver stores for the same observation`, async (testContext) => {
      if (!testDb) {
        testContext.skip();
        return;
      }
      const pageId = await seedFanslyPage(`s205-${fixture.lane}`);
      const observation = await journal(fixture, pageId);
      const family = familyForObservation(observation)!;

      // The engine's run, inside a transaction that is then rolled back: what
      // it stored is read in the transaction, and the rollback leaves the
      // ledger exactly as the driver will find it.
      let engineRows: unknown[] = [];
      let engineResult: Awaited<ReturnType<typeof canonicalizeObservationInTransaction>> | null = null;
      await expect(testDb.db.transaction(async (tx) => {
        engineResult = await canonicalizeObservationInTransaction(tx as unknown as Database, family, observation,
          engineContext(pageId));
        engineRows = await storedEvents(tx as unknown as Database, pageId);
        throw new Rollback();
      })).rejects.toBeInstanceOf(Rollback);
      expect(engineRows.length).toBeGreaterThan(0);
      // Every appended row (the checkpoint included) was counted.
      expect(engineResult).toMatchObject({
        outcome: "stamped", parseVersion: family.version, appended: engineRows.length, deduped: 0, excluded: 0,
      });
      expect(await storedEvents(testDb.db, pageId)).toEqual([]);
      expect(await parseVersion(observation)).toBe(0);

      const driver = await runCanonicalization(appStub(), {
        families: [family], observationId: observation.id, now: FIXTURE_NOW,
      });
      expect(driver).toMatchObject({ scanned: 1, stamped: 1, errored: 0 });
      expect(await storedEvents(testDb.db, pageId)).toEqual(engineRows);
      expect(await parseVersion(observation)).toBe(family.version);
    });
  }

  it("commits the events and the stamp with the caller's transaction, and repeats as a no-op", async (testContext) => {
    if (!testDb) {
      testContext.skip();
      return;
    }
    const pageId = await seedFanslyPage("s205-commit");
    const dm = ENGINE_FIXTURES.find((fixture) => fixture.name === "pull:sync dm")!;
    const observation = await journal(dm, pageId);
    const family = familyForObservation(observation)!;

    const drafts = seamDrafts(observation, pageId);
    // received + sent (deliverable) and the material plane (projection-only),
    // so the mixed append adds the checkpoint covering the hidden row.
    expect(drafts.map((draft) => draft.type)).toEqual(["message.received", "message.sent", "message.material_observed"]);

    const first = await testDb.db.transaction((tx) =>
      canonicalizeObservationInTransaction(tx as unknown as Database, family, observation, engineContext(pageId)));
    expect(first).toMatchObject({ outcome: "stamped", appended: 4, deduped: 0, quarantine: null, excluded: 0 });
    expect(first.outcome === "stamped" ? first.messageDedupKeys : []).toEqual(drafts.map((draft) => draft.dedupKey));
    expect(await parseVersion(observation)).toBe(family.version);
    const committed = await storedEvents(testDb.db, pageId);
    expect(committed.map((row) => [row.accountSeq, row.type])).toEqual([
      [1, "message.received"], [2, "message.sent"], [3, "message.material_observed"], [4, "stream.projection_checkpoint"],
    ]);

    const again = await testDb.db.transaction((tx) =>
      canonicalizeObservationInTransaction(tx as unknown as Database, family, observation, engineContext(pageId)));
    expect(again).toMatchObject({ outcome: "stamped", appended: 0, deduped: 3 });
    expect(await storedEvents(testDb.db, pageId)).toEqual(committed);
  });

  it("feeds the archive from the stored rows of its dedup keys when the driver appended first", async (testContext) => {
    if (!testDb) {
      testContext.skip();
      return;
    }
    const pageId = await seedFanslyPage("s205-driver-first");
    const dm = ENGINE_FIXTURES.find((fixture) => fixture.name === "pull:sync dm")!;
    const observation = await journal(dm, pageId);
    const family = familyForObservation(observation)!;
    // The minutely sweep canonicalizes the engine's observation between its
    // capture (tx 2) and its apply (tx 3).
    await runCanonicalization(appStub(), { families: [family], observationId: observation.id, now: FIXTURE_NOW });
    const byDriver = await storedEvents(testDb.db, pageId);

    const archived = await testDb.db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const result = await canonicalizeObservationInTransaction(database, family, observation, engineContext(pageId));
      expect(result).toMatchObject({ outcome: "stamped", appended: 0, deduped: 3 });
      const keys = result.outcome === "stamped" ? result.messageDedupKeys : [];
      expect(keys).toHaveLength(3);
      const events = await listDomainEventsByDedupKeys(database, pageId, keys);
      // The driver's rows, whoever appended them, in seq order.
      expect(events.map((event) => [event.accountSeq, event.dedupKey]))
        .toEqual(byDriver.slice(0, 3).map((row) => [row.accountSeq, row.dedupKey]));
      return applyMessageEventsToArchive(database, { accountId: pageId, platform: "fansly", events });
    });
    expect(archived.inserted).toBeGreaterThan(0);
    expect(await storedEvents(testDb.db, pageId)).toEqual(byDriver);
    const archive = await testDb.pool.query<{ message_ref: string }>(
      "select message_ref from message_archive where account_id = $1 order by message_ref", [pageId],
    );
    expect([...new Set(archive.rows.map((row) => row.message_ref))]).toEqual(["310000000000000001", "310000000000000002"]);
  });

  it("drops an excluded draft before the append and still stamps the observation", async (testContext) => {
    if (!testDb) {
      testContext.skip();
      return;
    }
    const pageId = await seedFanslyPage("s205-exclude");
    const dm = ENGINE_FIXTURES.find((fixture) => fixture.name === "pull:sync dm")!;
    const observation = await journal(dm, pageId);
    const family = familyForObservation(observation)!;
    // The fan's message is fenced; the creator's reply is not.
    const fenced = (draft: { fanIdentityRef?: string | null; messageRef?: string | null }) =>
      draft.messageRef === "310000000000000001";
    const kept = seamDrafts(observation, pageId).filter((draft) => !fenced(draft));
    const result = await testDb.db.transaction((tx) => canonicalizeObservationInTransaction(
      tx as unknown as Database, family, observation,
      { ...engineContext(pageId), excludeDraft: async (draft) => fenced(draft) },
    ));
    expect(result).toMatchObject({
      outcome: "stamped",
      excluded: 3 - kept.length,
      messageDedupKeys: kept.map((draft) => draft.dedupKey),
    });
    const rows = await storedEvents(testDb.db, pageId);
    expect(rows.filter((row) => row.type !== "stream.projection_checkpoint").map((row) => row.dedupKey))
      .toEqual(kept.map((draft) => draft.dedupKey));
    expect(rows.some((row) => row.messageRef === "310000000000000001")).toBe(false);
    expect(await parseVersion(observation)).toBe(family.version);
  });

  it("leaves a refused, a cold-month and an unmapped observation unstamped and writes nothing", async (testContext) => {
    if (!testDb) {
      testContext.skip();
      return;
    }
    const pageId = await seedFanslyPage("s205-unstamped");
    const fixtures = canonicalFamilyFixtures();
    const rejectedFixture = fixtures.find((fixture) => fixture.expect === "rejected")!;
    const rejected = await journal(rejectedFixture, pageId);
    const family = familyForObservation(rejected)!;
    const diagnostics: string[] = [];
    expect(await testDb.db.transaction((tx) => canonicalizeObservationInTransaction(
      tx as unknown as Database, family, rejected,
      { ...engineContext(pageId), diagnostics: { record: (code) => void diagnostics.push(code) } },
    ))).toEqual({ outcome: "rejected", rejection: { code: "messages_not_array" } });
    expect(diagnostics).toEqual(["canonicalize_rejected:sync:messages_not_array"]);
    expect(await parseVersion(rejected)).toBe(0);

    // A DM dated in a month whose domain_events partition is detached.
    await testDb.pool.query(`alter table "domain_events" detach partition "domain_events_2026_02"`);
    const dm = fixtures.find((fixture) => fixture.name === "pull:sync dm")!;
    const cold = await journal({
      ...dm,
      name: "cold",
      observation: { ...dm.observation, payload: { messages: [{
        ...(dm.observation.payload as { messages: Array<Record<string, unknown>> }).messages[0],
        createdAt: Date.parse("2026-02-15T10:00:00Z"),
      }] } },
    }, pageId);
    const blocked = await testDb.db.transaction((tx) =>
      canonicalizeObservationInTransaction(tx as unknown as Database, family, cold, engineContext(pageId)));
    expect(blocked).toMatchObject({ outcome: "partition_blocked", blocked: [{ month: "2026_02", shape: "detached" }] });
    expect(await parseVersion(cold)).toBe(0);

    // A capture with no account (the engine always sets one): events need it.
    const transactions = fixtures.find((fixture) => fixture.name === "pull:sync transactions")!;
    const unmapped = await journal(transactions, pageId);
    expect(await testDb.db.transaction((tx) => canonicalizeObservationInTransaction(
      tx as unknown as Database, family, { ...unmapped, accountId: null }, engineContext(pageId),
    ))).toMatchObject({ outcome: "unmapped", excluded: 0 });
    expect(await parseVersion(unmapped)).toBe(0);
    expect(await storedEvents(testDb.db, pageId)).toEqual([]);
  });

  it("refuses the shapes only the driver appends", async (testContext) => {
    if (!testDb) {
      testContext.skip();
      return;
    }
    const exportRow: CanonicalizableObservation = {
      id: 1, source: "webhook", producer: "ofapi:webhook", platform: "onlyfans", accountId: null,
      kind: "data_exports.completed", payload: {}, observedAt: null, receivedAt: FIXTURE_NOW,
    };
    const webhookFamily = familyForObservation({ source: "webhook", kind: "messages.received" })!;
    await expect(testDb.db.transaction((tx) => canonicalizeObservationInTransaction(
      tx as unknown as Database, webhookFamily, exportRow, context(),
    ))).rejects.toBeInstanceOf(DriverOnlyCanonicalizationError);
  });
});

describe("listDomainEventsByDedupKeys", () => {
  it("returns the account's stored rows of the given keys in seq order, and nothing else", async (testContext) => {
    if (!testDb) {
      testContext.skip();
      return;
    }
    const pageA = await seedFanslyPage("s205-keys-a");
    // Another page journaling the same fan message: same dedup key, other account.
    const pageB = await seedFanslyPage("s205-keys-b", "fansly-own-2");
    const dm = ENGINE_FIXTURES.find((fixture) => fixture.name === "pull:sync dm")!;
    for (const pageId of [pageB, pageA]) {
      const observation = await journal(dm, pageId);
      await testDb.db.transaction((tx) => canonicalizeObservationInTransaction(
        tx as unknown as Database, familyForObservation(observation)!, observation, engineContext(pageId)));
    }
    const rows = await listDomainEventsByDedupKeys(testDb.db, pageA, [
      "msg:sent:310000000000000002",
      "msg:received:310000000000000001",
      "msg:sent:310000000000000002",
      "msg:received:no-such-message",
    ]);
    expect(rows.map((row) => [row.accountId, row.accountSeq, row.dedupKey])).toEqual([
      [pageA, 1, "msg:received:310000000000000001"],
      [pageA, 2, "msg:sent:310000000000000002"],
    ]);
    expect(rows[0]).toMatchObject({ type: "message.received", messageRef: "310000000000000001", conversationRef: "group-alpha" });
    expect(await listDomainEventsByDedupKeys(testDb.db, pageA, [])).toEqual([]);
  });
});
