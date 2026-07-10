import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  advanceDmEmittedFingerprint,
  computeDmMaterialFingerprint,
  createModel,
  createOnlyFansPage,
  listDmRepairSignalRows,
  reduceDmMessageCandidate,
  setPageOfapiAccountId,
  upsertDmMessageArchive,
  upsertDmMessageArchiveFromReadthrough,
  type MessageFactCandidate,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Wave 2 corrections — the candidate reducer's NEW bookkeeping on top of the
// (already-pinned) amendment-3 merge semantics: material fingerprints from
// the reduced head, emitted discipline per design note §1, per-field
// provenance, the repair-signal listing, and the guarded emitted advance.

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

const ACCT = "acct_cand";
const FAN = "888200888";

async function seedPage(label = "cand-page") {
  const model = await createModel(testDb!.db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(testDb!.db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  await setPageOfapiAccountId(testDb!.db, { pageId: page.id, ofapiAccountId: ACCT });
  return page;
}

function webhookCandidate(
  pageId: number,
  overrides: Partial<MessageFactCandidate> = {},
): MessageFactCandidate {
  return {
    source: "webhook",
    platform: "onlyfans",
    platformAccountId: pageId,
    ofapiAccountId: ACCT,
    platformMessageId: "7001",
    platformConversationId: FAN,
    fanPlatformUserId: FAN,
    senderPlatformUserId: FAN,
    senderRole: "fan",
    isSentByMe: false,
    messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
    textPlain: "hello",
    priceMills: null,
    isOpened: null,
    isTip: false,
    tipAmountMills: 0n,
    inReplyToMessageId: null,
    mediaMetadata: [],
    sourceEventType: "messages.received",
    sourceIdempotencyKey: `cand-wh-${overrides.platformMessageId ?? "7001"}-${overrides.sourceReceivedAt?.getTime() ?? "a"}`,
    sourceJournalId: 1,
    sourceReceivedAt: new Date("2026-07-05T10:00:01Z"),
    retentionPolicy: "default",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function fingerprintColumns(messageId: string) {
  const { rows } = await testDb!.pool.query(
    `select encode(material_fingerprint, 'hex') as material,
            encode(emitted_fingerprint, 'hex') as emitted,
            emitted_event_id, revision_no, material_field_provenance,
            rest_platform_changed_at
     from dm_message_archive where platform_message_id = $1`,
    [messageId],
  );
  return rows[0] as {
    material: string | null;
    emitted: string | null;
    emitted_event_id: string | null;
    revision_no: number;
    material_field_provenance: Record<string, string>;
    rest_platform_changed_at: Date | null;
  } | undefined;
}

describe("candidate reducer bookkeeping (Wave 2)", () => {
  it("webhook INSERT sets material fingerprint from the reduced head AND emitted = material (design note §1)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const result = await reduceDmMessageCandidate(testDb.db, webhookCandidate(page.id));
    expect(result.status).toBe("written");
    expect(result.materialChanged).toBe(true);

    const row = await fingerprintColumns("7001");
    expect(row!.material).not.toBeNull();
    // Webhook first-write: the canonicalizer emits the first ledger event
    // from the same journal row — emitted = material, no reconciler append.
    expect(row!.emitted).toBe(row!.material);
    expect(row!.revision_no).toBe(1);
    expect(row!.material_field_provenance.textPlain).toBe("webhook");
    // The fingerprint matches an independent computation over the head.
    const expected = computeDmMaterialFingerprint({
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "hello",
      priceMills: null,
      isOpened: null,
      isTip: false,
      tipAmountMills: 0n,
      inReplyToMessageId: null,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      mediaMetadata: [],
    });
    expect(row!.material).toBe(expected.toString("hex"));
    // In-ledger webhook row: NOT in the repair-signal list.
    expect(await listDmRepairSignalRows(testDb.db, {})).toHaveLength(0);
  });

  it("REST INSERT leaves emitted NULL (reconciler appends the first event) and stores platform changedAt separately", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const result = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7002",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T11:00:00Z"),
      textPlain: "rest only",
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: 515151,
      observationReceivedAt: new Date("2026-07-05T11:00:05Z"),
      platformChangedAt: new Date("2026-07-05T11:00:02Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(result.status).toBe("written");
    const row = await fingerprintColumns("7002");
    expect(row!.material).not.toBeNull();
    expect(row!.emitted).toBeNull();
    expect(row!.rest_platform_changed_at).toEqual(new Date("2026-07-05T11:00:02Z"));
    expect(row!.material_field_provenance.textPlain).toBe("rest_reconcile");
    // No ledger event yet → the repair signal flags it for the reconciler.
    const flagged = await listDmRepairSignalRows(testDb.db, {});
    expect(flagged.map((r) => r.platformMessageId)).toEqual(["7002"]);
  });

  it("material advance moves material fingerprint but not emitted; guarded advance closes the gap; stale advance refuses", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await reduceDmMessageCandidate(testDb.db, webhookCandidate(page.id, { platformMessageId: "7003", sourceIdempotencyKey: "cand-7003-a" }));
    const before = await fingerprintColumns("7003");
    // REST fills price → material advances, emitted stays (webhook-era fp).
    const advanced = await upsertDmMessageArchiveFromReadthrough(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7003",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "hello",
      priceMills: 4000n,
      isTip: false,
      tipAmountMills: 0n,
      mediaMetadata: [],
      observationId: 626262,
      observationReceivedAt: new Date("2026-07-05T12:00:00Z"),
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    expect(advanced.status).toBe("written");
    const after = await fingerprintColumns("7003");
    expect(after!.material).not.toBe(before!.material);
    expect(after!.emitted).toBe(before!.emitted);
    expect(after!.material_field_provenance.priceMills).toBe("rest_reconcile");
    expect(after!.material_field_provenance.textPlain).toBe("webhook");

    const flagged = await listDmRepairSignalRows(testDb.db, {});
    expect(flagged.map((r) => r.platformMessageId)).toEqual(["7003"]);
    const rowId = flagged[0]!.id;

    // A STALE advance (old fingerprint) must refuse — the row stays flagged.
    const staleOk = await advanceDmEmittedFingerprint(testDb.db, {
      rowId,
      fingerprint: Buffer.from(before!.material!, "hex"),
      eventId: 90001,
      superseding: true,
    });
    expect(staleOk).toBe(false);

    // The guarded advance with the CURRENT fingerprint closes the gap and
    // bumps revision_no (superseding append).
    const ok = await advanceDmEmittedFingerprint(testDb.db, {
      rowId,
      fingerprint: Buffer.from(after!.material!, "hex"),
      eventId: 90002,
      superseding: true,
    });
    expect(ok).toBe(true);
    const closed = await fingerprintColumns("7003");
    expect(closed!.emitted).toBe(closed!.material);
    expect(String(closed!.emitted_event_id)).toBe("90002");
    expect(closed!.revision_no).toBe(2);
    expect(await listDmRepairSignalRows(testDb.db, {})).toHaveLength(0);
  });

  it("a material no-op leaves fingerprints, provenance, and updated_at untouched", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7004",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "same",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "cand-7004-a",
      sourceJournalId: 1,
      sourceReceivedAt: new Date("2026-07-05T10:00:01Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    const before = await fingerprintColumns("7004");
    // Same material re-delivered (retry): true no-op.
    const replay = await upsertDmMessageArchive(testDb.db, {
      platform: "onlyfans",
      platformAccountId: page.id,
      ofapiAccountId: ACCT,
      platformConversationId: FAN,
      fanPlatformUserId: FAN,
      platformMessageId: "7004",
      senderPlatformUserId: FAN,
      senderRole: "fan",
      isSentByMe: false,
      messageCreatedAt: new Date("2026-07-05T10:00:00Z"),
      textPlain: "same",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.received",
      sourceIdempotencyKey: "cand-7004-b",
      sourceJournalId: 2,
      sourceReceivedAt: new Date("2026-07-05T10:05:00Z"),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-02T00:00:00Z"),
    });
    expect(replay.status).toBe("noop");
    const after = await fingerprintColumns("7004");
    expect(after).toEqual(before);
  });
});
