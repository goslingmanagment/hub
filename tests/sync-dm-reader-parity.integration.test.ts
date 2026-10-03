import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureSyncPage,
  getPageConversationMessages,
  getPageConversationPreview,
  getPageDmMessageWindowSummary,
  listAgentTranscript,
  readThreadStoredFacts,
  refreshPageDmConversationWindow,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  type Database,
} from "@agency_hub_core/db";

import { buildSyncDmReaderParityCommandGroup } from "../apps/runtime/src/sync/cli/dm-reader-parity.ts";
import { runDmReaderParity, type DmReaderParityReport } from "../apps/runtime/src/sync/parity/run.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// Step 4, S4-06 (owner decision №11): the DM reader parity on a real Postgres.
// A fixture page holds one chat that agrees in both stores and one
// discrepancy of each class: a message the archive lacks for good
// (missing_in_archive, persistent across two rounds 5 min apart), one it
// lacks only until the projection catches up (resolved by the recheck), a
// text that differs (field_mismatch), an archive-only message
// (extra_in_archive), and two messages of one second in swapped sub-second
// order (tie_order). The archive variants the parity calls are the readers
// S4-08 serves from; the run only ever reads, in READ ONLY transactions.

const PAGE_REF = "500000000000000001";
const FAN = (n: number) => `70000000000000000${n}`;
const CHAT = {
  clean: "800000000000000001",
  missing: "800000000000000002",
  field: "800000000000000003",
  extra: "800000000000000004",
  tie: "800000000000000005",
  resolved: "800000000000000006",
};

let testDb: StartedTestDatabase | null = null;
beforeAll(async () => { testDb = await startIntegrationTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { if (testDb) await resetIntegrationDatabase(testDb.pool); });

function db(): Database {
  return testDb!.db as unknown as Database;
}

// On a whole second, so the tie fixture's two instants share one second.
const base = new Date(Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000);
const at = (seconds: number, ms = 0) => new Date(base.getTime() + seconds * 1000 + ms);

async function seedPage(label = "lilly-1") {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [page!.id, PAGE_REF]);
  return page!;
}

async function seedThread(pageId: number, group: string, partner: string) {
  const [fan] = await upsertFans(db(), [{ platform: "fansly", platformUserId: partner }]);
  const row = await upsertPageDmConversation(db(), {
    platformAccountId: pageId, fanId: fan!.id, platformConversationId: group,
    partnerPlatformUserId: partner, partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: null, lastUnreadMessageId: null, lastMessageAt: at(0),
    lastMessageSenderId: partner, lastMessageSenderRole: "fan", lastMessagePreview: null,
    messageCoverageStatus: "partial_window", newestStoredMessageId: null, oldestStoredMessageId: null,
    storedMessageCount: 0, lastMessageSyncAt: at(0), isVisible: true, lastSeenGeneration: 1, metadata: {},
  });
  return row!;
}

interface MessageSeed {
  id: string;
  at: Date;
  text: string;
  model?: boolean;
  tipCents?: number;
  replyTo?: string;
}

async function hot(pageId: number, thread: { id: number; partnerPlatformUserId: string | null }, rows: MessageSeed[]) {
  await upsertPageDmMessages(db(), rows.map((row) => ({
    conversationId: thread.id, platformAccountId: pageId, platformMessageId: row.id,
    senderPlatformUserId: row.model ? PAGE_REF : thread.partnerPlatformUserId,
    senderRole: row.model ? "model" as const : "fan" as const,
    createdAt: row.at, content: row.text, totalTipAmountCents: row.tipCents ?? 0,
    inReplyToMessageId: row.replyTo ?? null, inReplyToRootMessageId: null,
  })));
  await refreshPageDmConversationWindow(db(), { conversationId: thread.id });
}

async function archive(pageId: number, group: string, partner: string, rows: MessageSeed[]) {
  for (const row of rows) {
    await testDb!.pool.query(`
      insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
        is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills, in_reply_to_ref)
      values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
      pageId, group, row.id, partner, row.model ? "model" : "fan", row.model === true, row.at, row.text,
      (row.tipCents ?? 0) > 0, (row.tipCents ?? 0) * 10, row.replyTo ?? null,
    ]);
  }
}

/** One chat in both stores, as the projection writes it: the archive's text
 *  is normalized, its tip in mills; plus one socket message neither holds. */
async function seedCleanChat(pageId: number) {
  const thread = await seedThread(pageId, CHAT.clean, FAN(1));
  const rows: MessageSeed[] = [
    { id: "900000000000000101", at: at(0), text: "  hello  ", tipCents: 499 },
    { id: "900000000000000102", at: at(60), text: "hi <br> there", model: true },
    { id: "900000000000000103", at: at(120), text: "ok", replyTo: "900000000000000102" },
  ];
  await hot(pageId, thread, rows);
  await archive(pageId, CHAT.clean, FAN(1), rows.map((row) => ({
    ...row, text: row.text === "  hello  " ? "hello" : row.text === "hi <br> there" ? "hi\nthere" : row.text,
  })));
  await testDb!.pool.query(`
    insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
      is_sent_by_page, created_at, content, decoder_version, first_visible_at, confirm_due_at)
    values ($1, '900000000000000104', $2, $3, false, $4, 'from the socket', 1, $4, $4)`, [
    pageId, CHAT.clean, FAN(1), at(180),
  ]);
  return thread;
}

/** The discrepancies that do not fail the parity: an archive-only message,
 *  a sub-second tie, and a message the archive receives between the rounds. */
async function seedBenignChats(pageId: number) {
  const extra = await seedThread(pageId, CHAT.extra, FAN(4));
  await hot(pageId, extra, [{ id: "900000000000000401", at: at(0), text: "kept" }]);
  await archive(pageId, CHAT.extra, FAN(4), [
    { id: "900000000000000401", at: at(0), text: "kept" },
    { id: "900000000000000402", at: at(30), text: "september sidecar" },
  ]);

  const tie = await seedThread(pageId, CHAT.tie, FAN(5));
  const tieRows = (swap: boolean): MessageSeed[] => [
    { id: "900000000000000501", at: at(0), text: "first" },
    { id: "900000000000000502", at: at(60, swap ? 900 : 100), text: "same second a" },
    { id: "900000000000000503", at: at(60, swap ? 100 : 900), text: "same second b" },
    { id: "900000000000000504", at: at(120), text: "last" },
  ];
  await hot(pageId, tie, tieRows(false));
  await archive(pageId, CHAT.tie, FAN(5), tieRows(true));

  const resolved = await seedThread(pageId, CHAT.resolved, FAN(6));
  const late: MessageSeed = { id: "900000000000000601", at: at(10), text: "projected late" };
  await hot(pageId, resolved, [late]);
  return { catchUp: () => archive(pageId, CHAT.resolved, FAN(6), [late]) };
}

/** The discrepancies that fail it: a message the archive never gets, and a
 *  text the two stores disagree on. */
async function seedFailingChats(pageId: number) {
  const missing = await seedThread(pageId, CHAT.missing, FAN(2));
  await hot(pageId, missing, [
    { id: "900000000000000201", at: at(0), text: "archived" },
    { id: "900000000000000202", at: at(30), text: "never archived" },
  ]);
  await archive(pageId, CHAT.missing, FAN(2), [{ id: "900000000000000201", at: at(0), text: "archived" }]);

  const field = await seedThread(pageId, CHAT.field, FAN(3));
  await hot(pageId, field, [{ id: "900000000000000301", at: at(0), text: "price 10" }]);
  await archive(pageId, CHAT.field, FAN(3), [{ id: "900000000000000301", at: at(0), text: "price 20" }]);
}

/** A fake clock that a sleep advances, with a hook between the rounds; the
 *  db behind a guard that records every transaction's mode and any read
 *  outside a transaction. */
function harness(onSleep?: () => Promise<void>) {
  let clock = Date.now();
  const transactions: unknown[] = [];
  let readsOutsideTransactions = 0;
  const guarded = new Proxy(db(), {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (body: (tx: Database) => Promise<unknown>, config?: unknown) => {
          transactions.push(config);
          return target.transaction(body as never, config as never);
        };
      }
      if (property === "execute" || property === "select" || property === "query") readsOutsideTransactions += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    deps: {
      db: guarded,
      now: () => new Date(clock),
      sleep: async (ms: number) => {
        clock += ms;
        await onSleep?.();
      },
    },
    transactions,
    readsOutsideTransactions: () => readsOutsideTransactions,
  };
}

async function storeFingerprint() {
  const result = await testDb!.pool.query<{ fingerprint: string }>(`
    select concat_ws('|',
      (select count(*) || ':' || coalesce(max(updated_at)::text, '') from page_dm_threads),
      (select count(*) || ':' || coalesce(max(synced_at)::text, '') from page_dm_messages),
      (select count(*) || ':' || coalesce(max(updated_at)::text, '') from message_archive),
      (select count(*) || ':' || coalesce(max(updated_at)::text, '') from dm_live_messages),
      (select count(*) from sync_pages)) as fingerprint`);
  return result.rows[0]!.fingerprint;
}

const keyed = (report: DmReaderParityReport, parityClass: keyof DmReaderParityReport["classes"]) =>
  report.classes[parityClass].items.map((item) => [item.conversationRef, item.messageId, item.aspect, item.status]);

describe("the archive variants S4-08 serves from", () => {
  it("serve the same chat as page_dm_messages: tips mills→cents, sender ids, overlay, transcript, summaries", async () => {
    const page = await seedPage();
    const thread = await seedCleanChat(page.id);
    const input = { platformAccountId: page.id, platformConversationId: CHAT.clean, liveOverlay: true };

    const fromArchive = await getPageConversationMessages(db(), { ...input, store: "message_archive" });
    expect(fromArchive!.messages).toEqual([
      { messageId: "900000000000000104", senderRole: "fan", content: "from the socket", createdAt: at(180), tipAmountCents: 0,
        provenance: { source: "live", apiUnavailable: false } },
      { messageId: "900000000000000103", senderRole: "fan", content: "ok", createdAt: at(120), tipAmountCents: 0,
        provenance: { source: "rest" } },
      { messageId: "900000000000000102", senderRole: "model", content: "hi\nthere", createdAt: at(60), tipAmountCents: 0,
        provenance: { source: "rest" } },
      { messageId: "900000000000000101", senderRole: "fan", content: "hello", createdAt: at(0), tipAmountCents: 499,
        provenance: { source: "rest" } },
    ]);
    const fromHot = await getPageConversationMessages(db(), input);
    expect(fromHot!.messages.map((row) => [row.messageId, row.tipAmountCents, row.provenance]))
      .toEqual(fromArchive!.messages.map((row) => [row.messageId, row.tipAmountCents, row.provenance]));
    expect(fromArchive!.conversation).toEqual(fromHot!.conversation);

    const preview = await getPageConversationPreview(db(), { ...input, store: "message_archive" });
    const hotPreview = await getPageConversationPreview(db(), input);
    expect(preview!.messages.map((row) => [row.platformMessageId, row.senderPlatformUserId, row.totalTipAmountCents]))
      .toEqual(hotPreview!.messages.map((row) => [row.platformMessageId, row.senderPlatformUserId, row.totalTipAmountCents]));
    expect(preview!.messages.find((row) => row.senderRole === "model")!.senderPlatformUserId).toBe(PAGE_REF);
    // Confirmed-only (no overlay), oldest first, like the hot preview.
    const plain = await getPageConversationPreview(db(), { ...input, liveOverlay: false, store: "message_archive" });
    expect(plain!.messages.map((row) => row.platformMessageId))
      .toEqual(["900000000000000101", "900000000000000102", "900000000000000103"]);

    const transcriptInput = {
      pageId: page.id, platform: "fansly", conversationRef: CHAT.clean, from: new Date(0), to: new Date(Date.now() + 86_400_000),
      sortDir: "desc" as const, limit: 100, filters: {}, archiveFloor: null,
    };
    const withHot = await listAgentTranscript(db(), transcriptInput);
    const archiveOnly = await listAgentTranscript(db(), { ...transcriptInput, hotArm: false });
    expect(archiveOnly.rows.map((row) => [row.messageRef, row.sourcePlane, row.inReplyToRef]))
      .toEqual(withHot.rows.map((row) => [row.messageRef, row.sourcePlane, row.inReplyToRef]));
    expect(archiveOnly.witnesses.map((witness) => witness.plane).sort()).toEqual(["dm_message_archive", "message_archive"]);

    expect(await readThreadStoredFacts(db(), thread.id, { store: "message_archive" }))
      .toEqual(await readThreadStoredFacts(db(), thread.id));
    expect(await getPageDmMessageWindowSummary(db(), thread.id, { store: "message_archive" }))
      .toEqual(await getPageDmMessageWindowSummary(db(), thread.id));
  });

  it("hide what the archive tombstoned or has not filled, and read PPV state from the archive alone", async () => {
    const page = await seedPage();
    const thread = await seedCleanChat(page.id);
    await testDb!.pool.query(
      "update message_archive set deleted_at = now() where message_ref = '900000000000000103'",
    );
    await testDb!.pool.query(
      "update message_archive set content_pending = true where message_ref = '900000000000000102'",
    );
    await testDb!.pool.query(
      "update page_dm_messages set purchased_at = now() where platform_message_id = '900000000000000101'",
    );
    const fromArchive = await getPageConversationMessages(db(), {
      platformAccountId: page.id, platformConversationId: CHAT.clean, store: "message_archive",
    });
    expect(fromArchive!.messages.map((row) => row.messageId)).toEqual(["900000000000000101"]);
    expect(await readThreadStoredFacts(db(), thread.id, { store: "message_archive" }))
      .toEqual({ nonDeletedCount: 1, oldestNonDeletedId: "900000000000000101" });

    const transcriptInput = {
      pageId: page.id, platform: "fansly", conversationRef: CHAT.clean, from: new Date(0), to: new Date(Date.now() + 86_400_000),
      sortDir: "desc" as const, limit: 100, filters: {}, archiveFloor: null,
    };
    const opened = (rows: Awaited<ReturnType<typeof listAgentTranscript>>["rows"]) =>
      rows.find((row) => row.messageRef === "900000000000000101")!.isOpened;
    expect(opened((await listAgentTranscript(db(), transcriptInput)).rows)).toBe(true);
    expect(opened((await listAgentTranscript(db(), { ...transcriptInput, hotArm: false })).rows)).toBeNull();
  });
});

describe("sync dm-reader-parity", () => {
  it("finds one discrepancy of each class, fails on the persistent missing message and the field, and only reads", async () => {
    const page = await seedPage();
    await seedCleanChat(page.id);
    const { catchUp } = await seedBenignChats(page.id);
    await seedFailingChats(page.id);
    let caughtUp = false;
    const run = harness(async () => {
      if (!caughtUp) await catchUp();
      caughtUp = true;
    });

    const report = await runDmReaderParity(run.deps, {
      windowMs: 3_600_000, rounds: 2, intervalMs: 300_000, full: false,
    });

    expect(report.rounds).toHaveLength(2);
    expect(report.verdict).toBe("fail");
    expect(report.failReasons).toEqual(["1 persistent missing_in_archive", "1 field_mismatch"]);
    expect(keyed(report, "missing_in_archive")).toEqual(expect.arrayContaining([
      [CHAT.missing, "900000000000000202", "row", "persistent"],
      [CHAT.resolved, "900000000000000601", "row", "resolved"],
      [CHAT.resolved, null, "thread", "resolved"],
    ]));
    expect(report.classes.missing_in_archive).toMatchObject({ total: 3, persistent: 1, resolved: 2, open: 0 });
    const persistent = report.classes.missing_in_archive.items.find((item) => item.status === "persistent")!;
    expect(persistent.readers).toEqual(expect.arrayContaining(["A1.messages@25", "A2.preview@25", "A3.transcript", "A4.summary"]));

    expect(report.classes.field_mismatch.items.map((item) => [item.conversationRef, item.messageId, item.aspect, item.hot, item.archive]))
      .toEqual([[CHAT.field, "900000000000000301", "text", "price 10", "price 20"]]);
    expect(report.classes.field_mismatch.items[0]!.readers)
      .toEqual(expect.arrayContaining(["A1.messages@25", "A1.messages@100", "A2.preview@25"]));

    expect(keyed(report, "extra_in_archive")).toEqual([[CHAT.extra, "900000000000000402", "row", null]]);
    expect(report.extraInArchive).toEqual({
      messages: 1,
      threads: [expect.objectContaining({ pageLabel: "lilly-1", conversationRef: CHAT.extra, messages: 1 })],
    });
    expect(report.classes.tie_order.items.map((item) => [item.conversationRef, item.messageId]))
      .toEqual(expect.arrayContaining([[CHAT.tie, "900000000000000503"], [CHAT.tie, "900000000000000502"]]));
    // The clean chat (normalized text, mills→cents, the socket message) agrees everywhere.
    expect(Object.values(report.classes).flatMap((entry) => entry.items).filter((item) => item.conversationRef === CHAT.clean))
      .toEqual([]);
    expect(report.pages).toEqual([expect.objectContaining({
      pageLabel: "lilly-1", threadsChecked: 6, lifetimeThreads: 1, lifetimeChecked: 1, storeDifferenceThreads: 3,
    })]);

    expect(run.transactions.length).toBeGreaterThan(0);
    expect(run.transactions.every((config) => (config as { accessMode?: string }).accessMode === "read only")).toBe(true);
    expect(run.readsOutsideTransactions()).toBe(0);
    expect(caughtUp).toBe(true);
  });

  it("--full compares every hot row and lists the archive-only rows; a clean page with benign differences passes", async () => {
    const page = await seedPage();
    await seedCleanChat(page.id);
    const { catchUp } = await seedBenignChats(page.id);
    await catchUp();
    const run = harness();
    const before = await storeFingerprint();

    const report = await runDmReaderParity(run.deps, {
      windowMs: 60_000, rounds: 1, intervalMs: 60_000, full: true,
    });

    expect(await storeFingerprint()).toBe(before);
    expect(report.verdict).toBe("pass");
    expect(report.failReasons).toEqual([]);
    expect(report.full).toMatchObject({ hotRows: 9, storeDifferenceThreads: 1, completed: true });
    expect(report.classes.extra_in_archive.items[0]!.readers).toEqual(expect.arrayContaining(["A4.summary", "full"]));
    expect(report.classes.missing_in_archive.total).toBe(0);
    expect(report.classes.field_mismatch.total).toBe(0);
    expect(report.classes.tie_order.total).toBeGreaterThan(0);
  });

  it("--full alone finds what the sample would miss", async () => {
    const page = await seedPage();
    await seedFailingChats(page.id);
    const run = harness();
    const report = await runDmReaderParity(run.deps, { windowMs: 60_000, rounds: 1, intervalMs: 60_000, full: true });
    const fullItems = Object.values(report.classes).flatMap((entry) => entry.items)
      .filter((item) => item.readers.includes("full"))
      .map((item) => [item.class, item.messageId, item.aspect]);
    expect(fullItems).toEqual(expect.arrayContaining([
      ["missing_in_archive", "900000000000000202", "row"],
      ["field_mismatch", "900000000000000301", "text"],
    ]));
    expect(report.verdict).toBe("fail");
  });

  it("the CLI writes the JSON report, prints the owner's summary and exits 0 on a pass", async () => {
    const page = await seedPage();
    await seedCleanChat(page.id);
    const written: Array<{ path: string; json: string }> = [];
    const printed: string[] = [];
    const exitCodes: number[] = [];
    const sync = buildSyncDmReaderParityCommandGroup({
      openContext: async () => ({ db: db(), close: async () => undefined }),
      print: (line) => printed.push(line),
      progress: () => undefined,
      writeReport: async (path, json) => { written.push({ path, json }); },
      setExitCode: (code) => exitCodes.push(code),
    });
    await sync.parseAsync([
      "dm-reader-parity", "--window", "1m", "--rounds", "1", "--interval", "1m", "--page", "lilly-1", "--out", "/tmp/parity.json",
    ], { from: "user" });

    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe("/tmp/parity.json");
    const report = JSON.parse(written[0]!.json) as DmReaderParityReport;
    expect(report).toMatchObject({ command: "sync dm-reader-parity", verdict: "pass", options: { page: "lilly-1", rounds: 1 } });
    expect(printed[0]).toBe("sync dm-reader-parity: PASS");
    expect(printed.at(-1)).toBe("  report: /tmp/parity.json");
    expect(exitCodes).toEqual([]);
  });
});
