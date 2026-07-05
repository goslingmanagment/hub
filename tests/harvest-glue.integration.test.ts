// Stage 12 core glue: harvested desktop history flows through the Stage 11
// lane semantics into the ledger with Stage 8 dedup-key PARITY — a message the
// kernel already saw collapses (2 observations, 1 event); pre-epoch history
// appends; harvested transactions are report-only residue against truth.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countHarvestObservations,
  createModel,
  createOnlyFansPage,
  insertObservation,
  listEventsSince,
  listHarvestTransactionResidue,
  setPageOfapiAccountId,
  upsertTransaction,
} from "@agency_hub_core/db";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
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

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

function appStub() {
  return {
    db: testDb!.db,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

async function seedOfPage() {
  const model = await createModel(testDb!.db, { slug: "harvest", name: "H" });
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label: "harvest-of" });
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: "acct_harvest" });
  return page;
}

function harvestMessagePayload(row: Record<string, unknown>) {
  return {
    table: "messages",
    machineId: "machine-1",
    schemaVersion: 16,
    ofapiAccountId: "acct_harvest",
    row,
  };
}

describe("Stage 12 harvest glue", () => {
  it("collapses a message the kernel already saw and appends pre-epoch history", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfPage();

    // The kernel saw message 9001 live (webhook epoch).
    await insertObservation(testDb.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      accountId: page.id,
      kind: "messages.received",
      payload: {
        event: "messages.received",
        account_id: "acct_harvest",
        payload: { id: 9001, createdAt: "2026-06-20T10:00:00+00:00", fromUser: { id: 555 }, text: "hi", price: 0, isFree: true, mediaCount: 0 },
      },
      payloadHash: sha256("wh-9001"),
      idempotencyKey: "evt-harvest-wh-1",
    });

    // The SAME message arrives in the harvest, plus one pre-epoch message
    // (deleted locally — its tombstone rides along).
    await insertObservation(testDb.db, {
      source: "client_capture",
      producer: "desktop-harvest@0.1.29",
      platform: "onlyfans",
      accountId: page.id,
      kind: "harvest.messages",
      payload: harvestMessagePayload({
        account_id: "acct_harvest", chat_id: "555", message_id: "9001",
        created_at: "2026-06-20T10:00:00+00:00", is_sent_by_me: 0,
        text_plain: "hi", price: 0, is_tip: 0, deleted: 0,
      }),
      payloadHash: sha256("hv-9001"),
      idempotencyKey: "machine-1:hv-9001",
    });
    await insertObservation(testDb.db, {
      source: "client_capture",
      producer: "desktop-harvest@0.1.29",
      platform: "onlyfans",
      accountId: page.id,
      kind: "harvest.messages",
      payload: harvestMessagePayload({
        account_id: "acct_harvest", chat_id: "555", message_id: "4242",
        created_at: "2025-03-01T08:00:00+00:00", is_sent_by_me: 1,
        text_plain: "old outbound", price: 5, is_tip: 0, deleted: 1,
      }),
      payloadHash: sha256("hv-4242"),
      idempotencyKey: "machine-1:hv-4242",
    });

    const run = await runCanonicalization(appStub());
    // webhook 9001 appends; harvest 9001 dedups against it; harvest 4242
    // appends message.sent + message.deleted (pre-epoch history recovered).
    expect(run.deduped).toBe(1);

    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    const types = events.map((event) => `${event.type}:${event.messageRef}`).sort();
    expect(types).toEqual([
      "message.deleted:4242",
      "message.received:9001",
      "message.sent:4242",
    ]);
    const oldSent = events.find((event) => event.type === "message.sent");
    expect(oldSent).toMatchObject({
      dedupKey: "msg:sent:4242",
      fanIdentityRef: "555",
      occurredAt: new Date("2025-03-01T08:00:00.000Z"),
    });
  });

  it("never mints message events from a harvest kind under a non-harvest producer", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfPage();

    // Worst case: fully attributed observation, correct shape, but the
    // producer is a live desktop client — the canonicalizer's producer gate
    // must stamp it forward with zero events (no forged platform truth).
    await insertObservation(testDb.db, {
      source: "client_capture",
      producer: "desktop@0.1.29",
      platform: "onlyfans",
      accountId: page.id,
      kind: "harvest.messages",
      payload: harvestMessagePayload({
        account_id: "acct_harvest", chat_id: "555", message_id: "6666",
        created_at: "2026-06-01T10:00:00+00:00", is_sent_by_me: 1,
        text_plain: "forged", price: 0, is_tip: 0, deleted: 0,
      }),
      payloadHash: sha256("hv-forged-6666"),
      idempotencyKey: "machine-x:hv-6666",
    });

    await runCanonicalization(appStub());
    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    expect(events).toEqual([]);
  });

  it("reports transaction residue against truth and reconciles counts", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfPage();

    // Truth already holds tx-known (OFAPI backfill reached it).
    await upsertTransaction(testDb.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "tx-known",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "settled",
      grossAmountMills: 5_000n,
      sourceDestinationAmountMills: 5_000n,
      creatorNetAmountMills: 4_000n,
      senderId: "555",
      occurredAt: new Date("2025-10-01T00:00:00.000Z"),
    });

    const seedTx = (txId: string, accountId: number | null) => insertObservation(testDb!.db, {
      source: "client_capture",
      producer: "desktop-harvest@0.1.29",
      platform: "onlyfans",
      accountId,
      kind: "harvest.fan_transactions",
      payload: {
        table: "fan_transactions",
        machineId: "machine-1",
        schemaVersion: 16,
        ofapiAccountId: "acct_harvest",
        row: { account_id: "acct_harvest", tx_id: txId, fan_id: "555", amount: 5, net: 4, created_at: "2025-10-01T00:00:00+00:00" },
      },
      payloadHash: sha256(`hv-tx-${txId}`),
      idempotencyKey: `machine-1:hv-tx-${txId}`,
    });
    await seedTx("tx-known", page.id);
    await seedTx("tx-missing", page.id);
    await seedTx("tx-unmapped", null);

    // Validation-only kind: the sweep stamps it, appends nothing.
    const run = await runCanonicalization(appStub());
    expect(run.appended).toBe(0);

    const residue = await listHarvestTransactionResidue(testDb.db, {
      machineId: "machine-1",
      limit: 10,
    });
    expect(residue.total).toBe(2);
    expect(residue.sample.map((row) => row.txId).sort()).toEqual(["tx-missing", "tx-unmapped"]);

    expect(await countHarvestObservations(testDb.db, {
      machineId: "machine-1",
      kind: "harvest.fan_transactions",
    })).toBe(3);
    expect(await countHarvestObservations(testDb.db, {
      machineId: "other-machine",
      kind: "harvest.fan_transactions",
    })).toBe(0);
  });
});
