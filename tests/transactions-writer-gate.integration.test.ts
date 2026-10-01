import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  insertObservation,
  setPageOfapiAccountId,
  upsertOfapiSpendProjectionEvent,
  upsertTransaction,
} from "@agency_hub_core/db";
import { createHash } from "node:crypto";

import { applyOfapiSpendProjectionTransactions } from "../apps/runtime/src/services/ofapi-spend-transaction-ingest.ts";
import { loadWriteEligibility } from "../apps/runtime/src/services/ofapi-transactions-backfill.ts";
import {
  assertPageTransactionsWriter,
  WrongTransactionsWriterError,
} from "../apps/runtime/src/services/transactions-writer-gate.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let journalId = 0;

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
  journalId = 0;
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiSpendTransactionIngestEnabled: true,
  });
});

async function seedOfapiPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  return page;
}

async function seedProjectedTransaction(input: {
  pageId: number;
  ofapiAccountId: string;
  transactionId: string;
  sourceIdempotencyKey: string;
}) {
  journalId += 1;
  await upsertOfapiSpendProjectionEvent(appContext.db, {
    domainKey: `transactions.new:${input.transactionId}`,
    projectionStatus: "projected",
    sourceEventType: "transactions.new",
    sourceIdempotencyKey: input.sourceIdempotencyKey,
    journalId,
    ofapiAccountId: input.ofapiAccountId,
    pageId: input.pageId,
    fanPlatformUserId: "9000001",
    transactionId: input.transactionId,
    occurredAt: new Date("2026-06-20T12:00:00.000Z"),
    category: "tip",
    currency: "USD",
    grossAmountMills: 5_000n,
    creatorNetAmountMills: 4_000n,
    eventStatus: "settled",
  });
}

describe("transactions single-writer gate (Stage 13)", () => {
  it("refuses every writer on an unassigned page and opens one incident", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // An OnlyFans page WITHOUT an OFAPI mapping has no writer assigned.
    const model = await createModel(appContext.db, { slug: "unassigned", name: "U" });
    const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label: "unassigned-of" });

    await expect(assertPageTransactionsWriter(appContext, {
      platformAccountId: page.id,
      attemptedWriter: "onlymonster",
    })).rejects.toThrow(WrongTransactionsWriterError);
    await expect(assertPageTransactionsWriter(appContext, {
      platformAccountId: page.id,
      attemptedWriter: "ofapi",
    })).rejects.toThrow(/unassigned/);

    const incidents = await testDb.pool.query<{ kind: string; status: string }>(
      "select kind, status from notification_incidents where kind = 'wrong_transactions_writer'",
    );
    expect(incidents.rows).toHaveLength(1);
    expect(incidents.rows[0]?.status).toBe("open");
  });

  it("passes the writer the page was born with / mapped to", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(appContext.db, { slug: "writers", name: "W" });
    const fansly = await createFanslyPage(appContext.db, { modelId: model.id, label: "born-fansly" });
    await expect(assertPageTransactionsWriter(appContext, {
      platformAccountId: fansly.id,
      attemptedWriter: "fansly",
    })).resolves.toBeUndefined();
    await expect(assertPageTransactionsWriter(appContext, {
      platformAccountId: fansly.id,
      attemptedWriter: "onlymonster",
    })).rejects.toThrow(/'fansly'/);

    const mapped = await seedOfapiPage("mapped-of", "acct-mapped");
    await expect(assertPageTransactionsWriter(appContext, {
      platformAccountId: mapped.id,
      attemptedWriter: "ofapi",
    })).resolves.toBeUndefined();
  });

  it("ingest refuses a wrongly-assigned page, keeps rows pending, applies after reassignment with the observation link", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("gate-of", "acct-gate");
    const idempotencyKey = "wh-delivery-gate-1";

    // The Stage 7 observation the webhook producer journaled for this delivery.
    const payload = { event: "transactions.new", tx: "tx-gate-1" };
    const observation = await insertObservation(appContext.db, {
      source: "webhook",
      producer: "ofapi:webhook",
      platform: "onlyfans",
      kind: "transactions.new",
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey,
    });
    expect(observation.inserted).toBe(true);

    await seedProjectedTransaction({
      pageId: page.id,
      ofapiAccountId: "acct-gate",
      transactionId: "tx-gate-1",
      sourceIdempotencyKey: idempotencyKey,
    });

    // Force a wrong writer assignment; the ingest must refuse THIS page.
    await testDb.pool.query(
      "update pages set transactions_writer = 'fansly' where id = $1",
      [page.id],
    );
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(0);

    const refusedIncident = await testDb.pool.query(
      "select 1 from notification_incidents where kind = 'wrong_transactions_writer' and platform_account_id = $1",
      [page.id],
    );
    expect(refusedIncident.rows).toHaveLength(1);
    const noRows = await testDb.pool.query(
      "select 1 from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(noRows.rows).toHaveLength(0);

    // Fix the assignment: the same pending rows apply — nothing was lost —
    // stamped with provenance and linked to the journaled observation.
    await testDb.pool.query(
      "update pages set transactions_writer = 'ofapi' where id = $1",
      [page.id],
    );
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(1);

    const row = await testDb.pool.query<{
      source: string;
      source_observation_id: string | null;
      currency: string;
    }>(
      `select source, source_observation_id::text as source_observation_id, currency
       from transactions where platform_account_id = $1 and transaction_id = 'tx-gate-1'`,
      [page.id],
    );
    expect(row.rows[0]?.source).toBe("ofapi:webhook");
    expect(row.rows[0]?.source_observation_id).toBe(String(observation.observationId));
    expect(row.rows[0]?.currency).toBe("USD");
  });

  it("rejects an unknown provenance value at the CHECK level", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const model = await createModel(appContext.db, { slug: "check", name: "C" });
    const page = await createFanslyPage(appContext.db, { modelId: model.id, label: "check-page" });
    await expect(testDb.pool.query(
      `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type,
         transaction_state, raw_status, gross_amount_mills, source_destination_amount_mills,
         creator_net_amount_mills, occurred_at, source)
       values ($1, 'bad-source-tx', '2110', 'tip', 'posted', '1', 1000, 1000, 800, now(), 'made_up')`,
      [page.id],
    )).rejects.toThrow(/transactions_source_check/);
  });

  it("REST backfill upsert preserves webhook provenance (source + observation link) (review R2-2)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("prov", "acct-prov");
    if (!page) {
      throw new Error("Failed to seed provenance page");
    }
    const observation = await insertObservation(appContext.db, {
      source: "pull",
      producer: "test:provenance",
      platform: "onlyfans",
      accountId: page.id,
      kind: "test_fixture",
      payload: { fixture: true },
      payloadHash: createHash("sha256").update(JSON.stringify({ fixture: true })).digest(),
      idempotencyKey: `test:provenance:${page.id}`,
    });

    const base = {
      platformAccountId: page.id,
      transactionId: "prov-1",
      rawType: "tip",
      canonicalType: "tip" as const,
      transactionState: "posted" as const,
      rawStatus: "done",
      grossAmountMills: 10_000n,
      sourceDestinationAmountMills: 10_000n,
      creatorNetAmountMills: 8_000n,
      occurredAt: new Date("2026-07-01T00:00:00Z"),
    };
    await upsertTransaction(appContext.db, {
      ...base,
      source: "ofapi:webhook",
      sourceObservationId: observation.observationId,
    });
    await upsertTransaction(appContext.db, {
      ...base,
      source: "ofapi:rest",
      grossAmountMills: 12_000n,
    });

    const first = await testDb.pool.query<{
      source: string;
      source_observation_id: string | null;
      gross_amount_mills: string;
    }>(
      `select source, source_observation_id::text as source_observation_id, gross_amount_mills::text as gross_amount_mills
       from transactions where platform_account_id = $1 and transaction_id = 'prov-1'`,
      [page.id],
    );
    // Webhook provenance survives; amounts still converge (Audit B2).
    expect(first.rows[0]?.source).toBe("ofapi:webhook");
    expect(first.rows[0]?.source_observation_id).toBe(String(observation.observationId));
    expect(first.rows[0]?.gross_amount_mills).toBe("12000");

    // Reverse order upgrades: REST first, webhook after wins provenance.
    await upsertTransaction(appContext.db, { ...base, transactionId: "prov-2", source: "ofapi:rest" });
    await upsertTransaction(appContext.db, {
      ...base,
      transactionId: "prov-2",
      source: "ofapi:webhook",
      sourceObservationId: observation.observationId,
    });
    const second = await testDb.pool.query<{ source: string; source_observation_id: string | null }>(
      `select source, source_observation_id::text as source_observation_id
       from transactions where platform_account_id = $1 and transaction_id = 'prov-2'`,
      [page.id],
    );
    expect(second.rows[0]?.source).toBe("ofapi:webhook");
    expect(second.rows[0]?.source_observation_id).toBe(String(observation.observationId));
  });

  it("truth ingest skips backlog rows for tombstoned pages (review R2-4)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("tomb", "acct-tomb");
    if (!page) {
      throw new Error("Failed to seed tomb page");
    }
    await seedProjectedTransaction({
      pageId: page.id,
      ofapiAccountId: "acct-tomb",
      transactionId: "tomb-tx-1",
      sourceIdempotencyKey: "whk:tomb-1",
    });
    // The event was journaled pre-tombstone; the page dies before the sweep.
    await testDb.pool.query(
      "update pages set status = 'deleted', deleted_at = now() where id = $1",
      [page.id],
    );

    const applied = await applyOfapiSpendProjectionTransactions(appContext);
    expect(applied).toBe(0);
    const written = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(written.rows[0]?.n).toBe("0");
  });

  it("backfill eligibility refuses a tombstoned page (review R2-4)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("tomb2", "acct-tomb2");
    if (!page) {
      throw new Error("Failed to seed tomb2 page");
    }
    await testDb.pool.query(
      "update pages set status = 'deleted', deleted_at = now() where id = $1",
      [page.id],
    );

    const eligibility = await loadWriteEligibility(appContext.db, {
      pageId: page.id,
      from: new Date("2026-01-01T00:00:00Z"),
      to: null,
    });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe("page_not_active");
  });
});
