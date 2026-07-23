import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEvents,
  createModel,
  createOnlyFansPage,
  insertObservation,
  reduceDmMessageCandidate,
  setPageOfapiAccountId,
  tombstoneDmMessageArchive,
  upsertDmMessageArchiveFromReadthrough,
} from "@agency_hub_core/db";

import { runDmCorrectionsReconcile } from "../apps/runtime/src/services/dm-corrections-reconciler.ts";
import { buildMessagePayloadEnrichments } from "../apps/runtime/src/services/domain-events-enrich.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Wave 2 corrections — the reconciler end-to-end: first events for
// REST/command-only rows (canonical dedup key, dedupe-proof against a late
// webhook), superseding events for advanced material (fp dedup key, complete
// head), the message_archive same-message superseding merge, and head-based
// enrichment for v2 frames.

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
});

const ACCT = "acct_rec";
const FAN = "999300999";

function appStub() {
  return {
    db: testDb!.db,
    config: { ofapiDmCorrectionsReconcileEnabled: true },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

async function seedPage(label = "rec-page") {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: ACCT });
  return page;
}

/** A real readthrough observation so the reconciler's lineage resolution
 * (rest_material_observation_id) points at a real journal row. */
async function seedRestRow(pageId: number, messageId: string, text: string, priceMills?: bigint) {
  const observation = await insertObservation(testDb!.db, {
    source: "readthrough",
    producer: "read-gateway",
    platform: "onlyfans",
    accountId: pageId,
    kind: "ofapi_gateway_chat_messages_v2",
    payload: { ofapiAccountId: ACCT, chatId: FAN, conversationRef: FAN, cursors: {}, body: { data: [] } },
    payloadHash: Buffer.alloc(32),
    idempotencyKey: `rec-obs-${messageId}-${text.length}-${priceMills ?? "x"}`,
  });
  const written = await upsertDmMessageArchiveFromReadthrough(testDb!.db, {
    platform: "onlyfans",
    platformAccountId: pageId,
    ofapiAccountId: ACCT,
    platformConversationId: FAN,
    fanPlatformUserId: FAN,
    platformMessageId: messageId,
    senderPlatformUserId: FAN,
    senderRole: "fan",
    isSentByMe: false,
    messageCreatedAt: new Date("2026-07-06T10:00:00Z"),
    textPlain: text,
    priceMills: priceMills ?? null,
    isTip: false,
    tipAmountMills: 0n,
    mediaMetadata: [],
    observationId: observation.observationId,
    observationReceivedAt: observation.receivedAt,
    retentionPolicy: "default",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
  });
  return { observation, written };
}

async function eventRows(accountId: number) {
  const { rows } = await testDb!.pool.query(
    `select e.id, e.type, e.schema_version, e.dedup_key, e.data, e.account_seq
     from domain_events e where e.account_id = $1 order by e.account_seq`,
    [accountId],
  );
  return rows as Array<{
    id: string;
    type: string;
    schema_version: number;
    dedup_key: string;
    data: Record<string, unknown>;
    account_seq: string;
  }>;
}

describe("DM corrections reconciler (Wave 2)", () => {
  it("appends the FIRST event for a REST-only row with the CANONICAL key; a late webhook canonicalizer emission dedups against it", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedRestRow(page.id, "8001", "rest only message");

    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ scanned: 1, firstEvents: 1, superseding: 0, errored: 0 });

    const events = await eventRows(page.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.received",
      schema_version: 1,
      dedup_key: "msg:received:8001",
    });
    expect(events[0]!.data.text).toBe("rest only message");

    // Row bookkeeping closed: emitted = material, event id linked.
    const { rows } = await testDb.pool.query(
      `select emitted_fingerprint = material_fingerprint as closed, emitted_event_id::text as eid, revision_no
       from dm_message_archive where platform_message_id = '8001'`,
    );
    expect(rows[0]).toMatchObject({ closed: true, revision_no: 1 });
    expect(String(rows[0].eid)).toBe(String(events[0]!.id));

    // The late webhook's canonicalizer emission dedups silently (the
    // cross-producer proof, now covering reconciler-emitted first events).
    const late = await appendDomainEvents(testDb.db, page.id, [{
      type: "message.received",
      occurredAt: new Date("2026-07-06T10:00:00Z"),
      fanIdentityRef: FAN,
      conversationRef: FAN,
      messageRef: "8001",
      data: { text: "rest only message", price: null, isTip: false },
      schemaVersion: 1,
      observationId: 1,
      dedupKey: "msg:received:8001",
    }]);
    expect(late).toMatchObject({ appended: 0, deduped: 1 });

    // Idempotent: a second sweep finds nothing.
    expect((await runDmCorrectionsReconcile(appStub())).scanned).toBe(0);
  });

  it("appends a SUPERSEDING event (fp key, schema v2, complete head) when material advances, and the archive merge heals the projection", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // First: REST row → first event via reconciler → projector builds the row.
    await seedRestRow(page.id, "8002", "original text");
    await runDmCorrectionsReconcile(appStub());
    await runMessageArchiveProjection(appStub() as never, { accountId: page.id });
    const before = await testDb.pool.query(
      `select text_plain, price_mills::text as price from message_archive where message_ref = '8002'`,
    );
    expect(before.rows[0]).toMatchObject({ text_plain: "original text", price: null });

    // Material advances: a second readthrough fills the price.
    await seedRestRow(page.id, "8002", "original text", 6000n);
    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ superseding: 1, firstEvents: 0, errored: 0 });

    const events = await eventRows(page.id);
    expect(events).toHaveLength(2);
    const superseding = events[1]!;
    expect(superseding.schema_version).toBe(2);
    expect(superseding.dedup_key).toMatch(/^msg:received:8002:[0-9a-f]{64}$/);
    expect(String(superseding.data.supersedesEventId)).toBe(String(events[0]!.id));
    expect(superseding.data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const head = superseding.data.head as Record<string, unknown>;
    expect(head).toMatchObject({
      platformMessageId: "8002",
      text: "original text",
      priceMills: "6000",
      isSentByMe: false,
    });

    // revision_no bumped; emitted re-closed.
    const { rows } = await testDb.pool.query(
      `select revision_no, emitted_fingerprint = material_fingerprint as closed
       from dm_message_archive where platform_message_id = '8002'`,
    );
    expect(rows[0]).toMatchObject({ revision_no: 2, closed: true });

    // The projector's same-message superseding merge REPLACES material.
    await runMessageArchiveProjection(appStub() as never, { accountId: page.id });
    const after = await testDb.pool.query(
      `select text_plain, price_mills::text as price from message_archive where message_ref = '8002'`,
    );
    expect(after.rows[0]).toMatchObject({ text_plain: "original text", price: "6000" });

    // Enrichment builds the frame payload from the HEAD (no observation
    // envelope lookup for superseding frames).
    const enriched = await buildMessagePayloadEnrichments(appStub() as never, [{
      id: Number(superseding.id),
      accountId: page.id,
      currentAccountRef: ACCT,
      accountSeq: Number(superseding.account_seq),
      type: superseding.type,
      occurredAt: new Date("2026-07-06T10:00:00Z"),
      fanIdentityRef: FAN,
      conversationRef: FAN,
      messageRef: "8002",
      transactionRef: null,
      data: superseding.data,
      schemaVersion: superseding.schema_version,
      observationId: 1,
      dedupKey: superseding.dedup_key,
      createdAt: new Date(),
    }]);
    expect(enriched.get(Number(superseding.id))).toMatchObject({
      id: "8002",
      text: "original text",
      price: 6,
      isSentByMe: false,
    });
  });

  it("skip-and-counts null-ref stubs (preamble 3) without wedging the sweep", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A tombstone stub, then force a material fingerprint onto it so it
    // trips the repair signal (simulates a pathological backfill edge).
    const stub = await tombstoneDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformMessageId: "8003",
      deletedAt: new Date(),
      source: "webhook",
      sourceEventType: "messages.deleted",
      sourceIdempotencyKey: "rec-del-8003",
      sourceJournalId: 1,
      sourceReceivedAt: new Date(),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(stub.status).toBe("written");
    await testDb.pool.query(
      `update dm_message_archive set material_fingerprint = '\\x01' where platform_message_id = '8003'`,
    );
    // And a healthy REST row alongside — the sweep must process it.
    await seedRestRow(page.id, "8004", "healthy neighbor");

    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ scanned: 2, stubSkips: 1, firstEvents: 1, errored: 0 });
  });

  it("skip-and-counts unresolvable lineage — command-source rows only emit through a REAL command_result observation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // A command-source candidate whose cmd observation does NOT exist.
    const orphan = await reduceDmMessageCandidate(testDb.db, {
      source: "command",
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformMessageId: "8005",
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      senderRole: "model",
      isSentByMe: true,
      messageCreatedAt: new Date("2026-07-06T12:00:00Z"),
      textPlain: "orphan send",
      sourceIdempotencyKey: "cmd:nonexistent:confirmed",
      sourceReceivedAt: new Date("2026-07-06T12:00:01Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(orphan.status).toBe("written");
    const run = await runDmCorrectionsReconcile(appStub());
    expect(run).toMatchObject({ scanned: 1, lineageSkips: 1, firstEvents: 0 });

    // With the REAL observation in place, the next sweep emits.
    await insertObservation(testDb.db, {
      source: "command_result",
      producer: "ofapi:command-executor",
      platform: "onlyfans",
      accountId: page.id,
      kind: "command.confirmed",
      payload: { commandId: "nonexistent", state: "confirmed" },
      payloadHash: Buffer.alloc(32),
      idempotencyKey: "cmd:nonexistent:confirmed",
    });
    const second = await runDmCorrectionsReconcile(appStub());
    expect(second).toMatchObject({ scanned: 1, firstEvents: 1 });
    const events = await eventRows(page.id);
    expect(events[0]).toMatchObject({ type: "message.sent", dedup_key: "msg:sent:8005" });
  });

  it("does nothing when the flag is off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedRestRow(page.id, "8006", "flag off");
    const run = await runDmCorrectionsReconcile({
      db: testDb.db,
      config: { ofapiDmCorrectionsReconcileEnabled: false },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    expect(run.scanned).toBe(0);
    expect(await eventRows(page.id)).toHaveLength(0);
  });
});
