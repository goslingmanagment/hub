// G5 slice 3a, end to end: the SQL sites that used to dig INSIDE the inline
// capture body now read a typed column, and fall back to the body only for rows
// written before the slice.
//
// THE TRICK THAT MAKES EVERY "new row" ASSERTION DECISIVE. After a faithful
// write the typed column and the inline extraction say the same thing, so no
// query can tell you which one answered. So each new-row case CORRUPTS THE
// INLINE BODY afterwards with direct SQL — behind the writer's back, the only
// way to manufacture a divergence — and then asks the real repository function
// what it sees. If the pre-corruption value still comes back, the typed column
// is what answered, and the site no longer needs the body. The legacy cases run
// the mirror image: a row inserted with SQL, typed columns NULL, found only
// because the fallback arm is still there.
//
// The one thing a functional assertion cannot show is that the harvest lookup
// stayed INDEX-BACKED, which is the entire reason that one predicate is an OR
// and not a coalesce. So it is pinned with EXPLAIN.

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countHarvestObservations,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  hasHarvestObservationClientEvent,
  insertObservation,
  insertRawPayload,
  listAgentObservations,
  listHarvestTransactionResidue,
  listTransactionTipContextRawPayloadsAfterId,
  OfapiMessageCoverageOperatorConflictError,
  putPayloadObject,
  revokeOfapiMessageCoverage,
  setPageOfapiAccountId,
  upsertTransaction,
} from "@agency_hub_core/db";

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

const sha256 = (value: string) => createHash("sha256").update(value).digest();

async function seedOfPage(label = "typed-harvest") {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) throw new Error(`model ${label} was not created`);
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error(`page ${label} was not created`);
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: `acct_${label}` });
  return page;
}

async function seedFanslyPage(label: string) {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) throw new Error(`model ${label} was not created`);
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error(`page ${label} was not created`);
  return page;
}

/** A harvest observation written the way the ingest lane writes it — through
 *  the repository, so the typed columns are derived from the same object the
 *  inline body gets. */
function journalHarvest(input: {
  accountId: number | null;
  kind: string;
  machineId: string;
  clientEventId: string;
  row?: Record<string, unknown>;
}) {
  const payload = {
    table: input.kind.slice("harvest.".length),
    machineId: input.machineId,
    schemaVersion: 16,
    ofapiAccountId: "acct_typed-harvest",
    ...(input.row === undefined ? {} : { row: input.row }),
  };
  return insertObservation(testDb!.db, {
    source: "client_capture",
    producer: "desktop-harvest@0.1.29",
    platform: "onlyfans",
    accountId: input.accountId,
    kind: input.kind,
    payload,
    payloadHash: sha256(`${input.machineId}:${input.clientEventId}`),
    idempotencyKey: `${input.machineId}:${input.clientEventId}`,
  });
}

/** A harvest observation as it exists in production TODAY: written before 0125,
 *  so every typed column is null and only the inline body carries the fields. */
async function journalLegacyHarvest(input: {
  accountId: number | null;
  kind: string;
  machineId: string;
  clientEventId: string;
  row?: Record<string, unknown>;
}) {
  const payload = {
    table: input.kind.slice("harvest.".length),
    machineId: input.machineId,
    schemaVersion: 16,
    ...(input.row === undefined ? {} : { row: input.row }),
  };
  const inserted = await testDb!.pool.query<{ id: string }>(
    `insert into observations (
       source, producer, platform, account_id, kind, payload, payload_hash,
       idempotency_key, received_at
     ) values (
       'client_capture', 'desktop-harvest@0.1.29', 'onlyfans', $1, $2, $3::jsonb,
       sha256(convert_to($4, 'UTF8')), $4, now()
     ) returning id::text`,
    [
      input.accountId,
      input.kind,
      JSON.stringify(payload),
      `${input.machineId}:${input.clientEventId}`,
    ],
  );
  return Number(inserted.rows[0]!.id);
}

async function typedColumns(idempotencyKey: string) {
  const result = await testDb!.pool.query<Record<string, string | null>>(
    `select harvest_machine_id, harvest_tx_id, harvest_tx_amount, harvest_tx_created_at
     from observations where idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0]!;
}

/** Rewrites the inline body behind the writer's back. Nothing in production
 *  does this; it is how a test proves WHICH copy answered a query. */
async function corruptInlinePayload(idempotencyKey: string, payload: unknown) {
  await testDb!.pool.query(
    "update observations set payload = $2::jsonb where idempotency_key = $1",
    [idempotencyKey, JSON.stringify(payload)],
  );
}

describe("G5 slice 3a: harvest lookups read the typed machine column", () => {
  it("finds a new row by its typed column, with the inline body corrupted", async () => {
    const page = await seedOfPage();
    await journalHarvest({
      accountId: page.id,
      kind: "harvest.messages",
      machineId: "machine-typed",
      clientEventId: "ev-typed",
    });

    expect((await typedColumns("machine-typed:ev-typed")).harvest_machine_id)
      .toBe("machine-typed");
    expect(await hasHarvestObservationClientEvent(testDb!.db, {
      machineId: "machine-typed",
      clientEventId: "ev-typed",
    })).toBe(true);

    // The inline body now says something else entirely. A lookup that still
    // answers "yes" cannot have read it.
    await corruptInlinePayload("machine-typed:ev-typed", { machineId: "wiped" });
    expect(await hasHarvestObservationClientEvent(testDb!.db, {
      machineId: "machine-typed",
      clientEventId: "ev-typed",
    })).toBe(true);
    expect(await countHarvestObservations(testDb!.db, {
      machineId: "machine-typed",
      kind: "harvest.messages",
    })).toBe(1);
  });

  it("still finds a pre-slice row through the inline fallback", async () => {
    const page = await seedOfPage();
    await journalLegacyHarvest({
      accountId: page.id,
      kind: "harvest.messages",
      machineId: "machine-legacy",
      clientEventId: "ev-legacy",
    });

    expect((await typedColumns("machine-legacy:ev-legacy")).harvest_machine_id).toBeNull();
    expect(await hasHarvestObservationClientEvent(testDb!.db, {
      machineId: "machine-legacy",
      clientEventId: "ev-legacy",
    })).toBe(true);
    expect(await hasHarvestObservationClientEvent(testDb!.db, {
      machineId: "another-machine",
      clientEventId: "ev-legacy",
    })).toBe(false);
    expect(await countHarvestObservations(testDb!.db, {
      machineId: "machine-legacy",
      kind: "harvest.messages",
    })).toBe(1);
  });

  it("counts both generations of row under one machine", async () => {
    const page = await seedOfPage();
    await journalLegacyHarvest({
      accountId: page.id,
      kind: "harvest.messages",
      machineId: "machine-mixed",
      clientEventId: "ev-old",
    });
    await journalHarvest({
      accountId: page.id,
      kind: "harvest.messages",
      machineId: "machine-mixed",
      clientEventId: "ev-new",
    });

    expect(await countHarvestObservations(testDb!.db, {
      machineId: "machine-mixed",
      kind: "harvest.messages",
    })).toBe(2);
    // Kind is exact and the machine is exact: neither generation leaks across.
    expect(await countHarvestObservations(testDb!.db, {
      machineId: "machine-mixed",
      kind: "harvest.fan_transactions",
    })).toBe(0);
    expect(await countHarvestObservations(testDb!.db, {
      machineId: "other-machine",
      kind: "harvest.messages",
    })).toBe(0);
  });

  it("keeps the lookup on an index for BOTH arms of the fallback", async () => {
    // This is why the predicate is an OR and not a coalesce: coalesce over two
    // columns is unindexable, and the alternative to an index here is a scan of
    // the largest table in the system. Both arms must reach their own partial
    // index — 0126's typed twin and 0096's expression original.
    //
    // THE FIXTURE HAS TO BE BIG ENOUGH TO BE A QUESTION. This pin used to seed
    // 40 rows, and at 40 rows EVERY access path costs one page: the planner
    // picks essentially at random, so the pin passed or failed on which indexes
    // happened to exist rather than on which one is right. Migration 0144 (the
    // health-floor index) made that visible — it was chosen here purely because
    // it was the smallest thing to scan. Measured across fixture sizes, the two
    // harvest indexes win from ~400 rows upward and the margin only grows, so
    // the background below puts the table past that threshold. If this pin ever
    // fails again, check the ROW COUNT before believing the plan.
    const page = await seedOfPage();
    for (let index = 0; index < 20; index += 1) {
      await journalHarvest({
        accountId: page.id,
        kind: "harvest.messages",
        machineId: "machine-plan",
        clientEventId: `ev-plan-${index}`,
      });
      await journalLegacyHarvest({
        accountId: page.id,
        kind: "harvest.messages",
        machineId: "machine-plan",
        clientEventId: `ev-plan-legacy-${index}`,
      });
    }
    // Background traffic of both generations, written straight to SQL because
    // this is about table SHAPE, not about the write path (the cases above own
    // that). Half carry the typed column, half are pre-slice rows that only the
    // expression index can find — the same mix production has mid-backfill.
    await testDb!.pool.query(`
      insert into observations (
        source, producer, platform, kind, payload, payload_hash,
        idempotency_key, received_at, parse_version, harvest_machine_id
      )
      select 'client_capture', 'desktop-harvest@1.4.0', 'onlyfans', 'harvest.messages',
             jsonb_build_object('machineId', 'machine-bg-' || (n % 40)),
             '\\x00'::bytea,
             'machine-bg-' || (n % 40) || ':ev-bg-' || lpad(n::text, 8, '0'),
             now() - make_interval(secs => n), 2,
             case when n % 2 = 0 then 'machine-bg-' || (n % 40) else null end
      from generate_series(1, 800) as n
    `);
    await testDb!.pool.query("analyze observations");

    const client = await testDb!.pool.connect();
    let plan: string;
    try {
      await client.query("begin");
      // A test-sized table is always cheapest to seq-scan; turning that off is
      // what makes the question "IS there an index path" answerable at all.
      await client.query("set local enable_seqscan = off");
      const explained = await client.query<{ "QUERY PLAN": string }>(`
        explain (analyze, buffers)
        select 1
        from observations
        where source = 'client_capture'
          and producer like 'desktop-harvest@%'
          and kind like 'harvest.%'
          and split_part(idempotency_key, ':', 2) = 'ev-plan-0'
          and (
            harvest_machine_id = 'machine-plan'
            or (harvest_machine_id is null and payload->>'machineId' = 'machine-plan')
          )
        limit 1
      `);
      plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
      await client.query("rollback");
    } finally {
      client.release();
    }

    expect(plan).toContain("harvest_machine_typed_idx");
    expect(plan).toContain("harvest_machine_client_event_idx");
    expect(plan).not.toContain("Seq Scan");
    // A NAME is not the property that matters — "bounded" is. Both arms are
    // equality probes, so the populated partition must read a handful of pages
    // and touch a handful of rows no matter how large the table gets. A path
    // that degraded into "scan every client_capture row and filter" would still
    // be an index scan and would still carry an index NAME; it would not stay
    // under these numbers.
    // Only the EXECUTION half: the trailing "Planning:" block reports the
    // catalog reads for fourteen partitions and says nothing about the path.
    const executed = plan.split(/^Planning:$/m)[0] ?? plan;
    const scanned = [...executed.matchAll(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/g)]
      .map((match) => Number(match[1]));
    expect(Math.max(...scanned)).toBeLessThanOrEqual(5);
    const buffers = [...executed.matchAll(/Buffers: shared hit=(\d+)(?: read=(\d+))?/g)]
      .map((match) => Number(match[1]) + Number(match[2] ?? 0));
    expect(Math.max(...buffers)).toBeLessThanOrEqual(64);
  });
});

describe("G5 slice 3a: the harvest residue report reads typed row members", () => {
  it("reports a new row from its columns and a pre-slice row from its body", async () => {
    const page = await seedOfPage();
    await upsertTransaction(testDb!.db, {
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

    // Matched against truth: never residue, from either generation of row.
    await journalHarvest({
      accountId: page.id,
      kind: "harvest.fan_transactions",
      machineId: "machine-res",
      clientEventId: "ev-known",
      row: { tx_id: "tx-known", amount: 5, created_at: "2025-10-01T00:00:00+00:00" },
    });
    await journalHarvest({
      accountId: page.id,
      kind: "harvest.fan_transactions",
      machineId: "machine-res",
      clientEventId: "ev-new-missing",
      row: { tx_id: "tx-new-missing", amount: 7.5, created_at: "2025-10-02T00:00:00+00:00" },
    });
    await journalLegacyHarvest({
      accountId: page.id,
      kind: "harvest.fan_transactions",
      machineId: "machine-res",
      clientEventId: "ev-old-missing",
      row: { tx_id: "tx-old-missing", amount: 9, created_at: "2025-10-03T00:00:00+00:00" },
    });

    const columns = await typedColumns("machine-res:ev-new-missing");
    expect(columns).toEqual({
      harvest_machine_id: "machine-res",
      harvest_tx_id: "tx-new-missing",
      harvest_tx_amount: "7.5",
      harvest_tx_created_at: "2025-10-02T00:00:00+00:00",
    });
    expect((await typedColumns("machine-res:ev-old-missing")).harvest_tx_id).toBeNull();

    // Corrupting the new row's body must change nothing it reports.
    await corruptInlinePayload("machine-res:ev-new-missing", {
      machineId: "wiped",
      row: { tx_id: "wiped", amount: "wiped", created_at: "wiped" },
    });

    const residue = await listHarvestTransactionResidue(testDb!.db, {
      machineId: "machine-res",
      limit: 10,
    });
    expect(residue.total).toBe(2);
    expect(residue.sample.map((row) => row.txId).sort())
      .toEqual(["tx-new-missing", "tx-old-missing"]);
    expect(residue.sample.map((row) => ({ tx: row.txId, amount: row.amount, at: row.createdAt })))
      .toEqual(expect.arrayContaining([
        { tx: "tx-new-missing", amount: "7.5", at: "2025-10-02T00:00:00+00:00" },
        { tx: "tx-old-missing", amount: "9", at: "2025-10-03T00:00:00+00:00" },
      ]));
  });
});

describe("G5 slice 3a: the DM tip replay reads the typed slice column", () => {
  async function captureDmRaw(accountId: number, responsePayload: unknown) {
    return insertRawPayload(testDb!.db, {
      platformAccountId: accountId,
      endpoint: "dm_messages",
      requestParams: { groupId: "group-1" },
      responsePayload,
      mapperVersion: "test",
      payloadKind: "dm_messages",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
  }

  const tips = [{ id: "tip-1", message: "exact note", senderId: "fan-1", createdAt: 1 }];

  it("serves a new capture's slice with the heavy body corrupted", async () => {
    const page = await seedFanslyPage("typed-tips-new");
    const raw = await captureDmRaw(page.id, {
      messages: [{ id: "heavy", media: "x".repeat(50_000) }],
      tips,
    });

    const stored = await testDb!.pool.query<{ response_tips: unknown }>(
      "select response_tips from sync_raw_payloads where id = $1",
      [raw.id],
    );
    expect(stored.rows[0]!.response_tips).toEqual({ tips });

    await testDb!.pool.query(
      `update sync_raw_payloads set response_payload = '{"tips": "wiped"}'::jsonb where id = $1`,
      [raw.id],
    );
    const rows = await listTransactionTipContextRawPayloadsAfterId(testDb!.db, {
      afterId: raw.id - 1,
      throughId: raw.id,
      accountId: page.id,
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.responsePayload).toEqual({ tips });
  });

  it("narrows a pre-slice capture from the inline body", async () => {
    const page = await seedFanslyPage("typed-tips-legacy");
    const raw = await captureDmRaw(page.id, {
      messages: [{ id: "heavy", media: "x".repeat(50_000) }],
      tips,
    });
    // Age the row into the pre-0125 world: no slice column, body intact.
    await testDb!.pool.query(
      "update sync_raw_payloads set response_tips = null where id = $1",
      [raw.id],
    );

    const rows = await listTransactionTipContextRawPayloadsAfterId(testDb!.db, {
      afterId: raw.id - 1,
      throughId: raw.id,
      accountId: page.id,
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    // Still narrowed, and still WITHOUT the 50 KB of messages — the fallback is
    // the old CASE, not a whole-body read.
    expect(rows[0]!.responsePayload).toEqual({ tips });
  });

  it("keeps an absent sidecar absent in both generations", async () => {
    const page = await seedFanslyPage("typed-tips-absent");
    const raw = await captureDmRaw(page.id, { messages: [] });
    expect((await testDb!.pool.query<{ response_tips: unknown }>(
      "select response_tips from sync_raw_payloads where id = $1",
      [raw.id],
    )).rows[0]!.response_tips).toEqual({ tips: null });

    const readOne = async () => (await listTransactionTipContextRawPayloadsAfterId(testDb!.db, {
      afterId: raw.id - 1,
      throughId: raw.id,
      accountId: page.id,
      limit: 10,
    }))[0]!.responsePayload;

    expect(await readOne()).toEqual({ tips: null });
    await testDb!.pool.query(
      "update sync_raw_payloads set response_tips = null where id = $1",
      [raw.id],
    );
    expect(await readOne()).toEqual({ tips: null });
  });
});

describe("G5 slice 3a: the agent plane sizes a body by the catalog", () => {
  it("reports catalog logical_bytes for a referenced row and octet_length for a legacy one", async () => {
    const page = await seedFanslyPage("typed-agent-bytes");
    const body = { data: [{ transactionId: "tx-1", amount: 100 }], total: 1 };
    const captureInstant = new Date();
    const object = await putPayloadObject(testDb!.db, {
      representation: "canonical_json",
      json: body,
      captureInstant,
      lane: "platform_capture",
      platformAccountId: page.id,
    });

    await insertObservation(testDb!.db, {
      source: "pull",
      producer: "sync:fansly:transactions",
      platform: "fansly",
      accountId: page.id,
      kind: "earnings_transactions",
      payload: body,
      payloadHash: sha256("referenced"),
      idempotencyKey: "agent-bytes-referenced",
      payloadRef: { bucketMonth: object.bucketMonth, objectId: object.objectId },
    });
    await insertObservation(testDb!.db, {
      source: "pull",
      producer: "sync:fansly:transactions",
      platform: "fansly",
      accountId: page.id,
      kind: "earnings_transactions",
      payload: body,
      payloadHash: sha256("legacy"),
      idempotencyKey: "agent-bytes-legacy",
    });

    const inlineBytes = await testDb!.pool.query<{ n: string }>(
      `select octet_length(payload::text)::text as n
       from observations where idempotency_key = 'agent-bytes-legacy'`,
    );
    const inline = Number(inlineBytes.rows[0]!.n);
    // The two numbers MUST differ, or this test could not tell them apart:
    // jsonb's text rendering pads its separators, the canonical codec does not.
    expect(object.logicalBytes).not.toBe(inline);

    const now = Date.now();
    const { rows } = await listAgentObservations(testDb!.db, {
      pageIds: [page.id],
      from: new Date(now - 60 * 60 * 1000),
      to: new Date(now + 60 * 60 * 1000),
      sortDir: "asc",
      limit: 10,
    });
    const byKind = new Map(rows.map((row) => [row.payloadSha256, row.payloadBytes]));
    expect(byKind.get(sha256("referenced").toString("hex"))).toBe(object.logicalBytes);
    expect(byKind.get(sha256("legacy").toString("hex"))).toBe(inline);
  });
});

describe("G5 slice 3a: the coverage-revoke idempotency proof", () => {
  const chatId = "42";

  async function seedCoverage(pageId: number, proofObservationId: number) {
    await testDb!.pool.query(
      `insert into ofapi_message_coverage (
         page_id, chat_id, classification, source, frozen_head_id, oldest_message_id,
         target, target_hash, page_chain_hash, raw_count, accepted_count,
         boundary_duplicate_count, explicitly_irrelevant_count, rejected_count,
         parse_debt, required_serving_high_water, proof_observation_id,
         proof_observation_received_at, proof_policy_version, source_contract_version,
         parser_version, source_account_seq
       ) values (
         $1, $2, 'continuous_history', 'pagination_exhausted', '100', '1',
         '{}'::jsonb, repeat('a', 64), repeat('b', 64), 1, 1,
         0, 0, 0,
         0, 1, $3,
         now(), 'v1', 'v1',
         'v1', 7
       )`,
      [pageId, chatId, proofObservationId],
    );
  }

  async function journalPriorRevocation(pageId: number, actionId: string, payload: unknown) {
    const result = await insertObservation(testDb!.db, {
      source: "operator",
      producer: "ofapi-coverage-operator",
      platform: "onlyfans",
      accountId: pageId,
      kind: "ofapi.coverage_revoked.v1",
      payload,
      payloadHash: sha256(actionId),
      idempotencyKey: `ofapi-coverage-revoke:${actionId}`,
    });
    return result.observationId;
  }

  it("reads a referenced prior proof from the catalog, not from the inline body", async () => {
    const page = await seedOfPage("typed-coverage-ref");
    const actionId = randomUUID();
    const payload = { actionId, pageId: page.id, chatId, reason: "defect" };
    const observationId = await journalPriorRevocation(page.id, actionId, payload);
    await seedCoverage(page.id, observationId);

    const object = await putPayloadObject(testDb!.db, {
      representation: "canonical_json",
      json: payload,
      captureInstant: new Date(),
      lane: "operator_action",
      platformAccountId: page.id,
    });
    // Point the envelope at the catalog copy AND corrupt the inline one: the
    // proof can only still resolve if it read the catalog.
    await testDb!.pool.query(
      `update observations
       set payload_bucket_month = $2::date, payload_object_id = $3,
           payload = '{"pageId": -1, "chatId": "corrupted"}'::jsonb
       where id = $1`,
      [observationId, object.bucketMonth, object.objectId],
    );

    expect(await revokeOfapiMessageCoverage(testDb!.db, {
      actionId,
      pageId: page.id,
      chatId,
      expectedSourceAccountSeq: 7,
      actorUserId: 1,
      reason: "defect",
      execute: true,
    })).toMatchObject({ status: "already_reconciled", pageId: page.id, chatId });
  });

  it("still proves a pre-slice prior revocation from the inline body", async () => {
    const page = await seedOfPage("typed-coverage-inline");
    const actionId = randomUUID();
    const observationId = await journalPriorRevocation(page.id, actionId, {
      actionId,
      pageId: page.id,
      chatId,
      reason: "defect",
    });
    await seedCoverage(page.id, observationId);

    expect(await revokeOfapiMessageCoverage(testDb!.db, {
      actionId,
      pageId: page.id,
      chatId,
      expectedSourceAccountSeq: 7,
      actorUserId: 1,
      reason: "defect",
      execute: true,
    })).toMatchObject({ status: "already_reconciled" });
  });

  it("raises the operator conflict when the prior proof belongs to another chat", async () => {
    const page = await seedOfPage("typed-coverage-conflict");
    const actionId = randomUUID();
    const observationId = await journalPriorRevocation(page.id, actionId, {
      actionId,
      pageId: page.id,
      chatId: "99",
      reason: "defect",
    });
    await seedCoverage(page.id, observationId);

    await expect(revokeOfapiMessageCoverage(testDb!.db, {
      actionId,
      pageId: page.id,
      chatId,
      expectedSourceAccountSeq: 7,
      actorUserId: 1,
      reason: "defect",
      execute: true,
    })).rejects.toBeInstanceOf(OfapiMessageCoverageOperatorConflictError);
  });
});
