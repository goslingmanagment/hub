import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureSyncPage,
  getLatestCompletedChainRebuild,
  insertRawPayload,
  putPayloadObject,
  readThreadChain,
  readThreadStoredFacts,
  SYNC_CHAIN_REBUILD_AUDIT_EVENT,
  upsertPageDmMessages,
  writeThreadChain,
  type Database,
  type SyncPageMode,
  type ThreadChainState,
} from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import {
  chainPageNeedsStoredFacts,
  emptyChain,
  foldChainPage,
  type ChainPage,
  type Segment,
  type ThreadChain,
} from "../apps/runtime/src/sync/fansly/lib/chain.ts";
import { checkEndRule, checkWindow } from "../apps/runtime/src/sync/fansly/lib/chain-checks.ts";
import {
  ChainRebuildRefusedError,
  rebuildPageChains,
  ScanGovernor,
  type ChainRebuildOptions,
} from "../apps/runtime/src/sync/fansly/lib/chain-rebuild.ts";
import { resetCaptureCasReadForTests } from "../apps/runtime/src/services/payload-reader.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fansly Sync Engine design §8.2, §8.3, §5.4 step 6: the chain rebuild from
// the legacy `/message` journal and its read-only checks, on a real Postgres
// with inline, pointer-only and unreadable bodies. The rebuilt chains equal
// the online fold of the same pages; a `--write` run on a legacy page changes
// no column but the chain columns; the CLI refuses pages the engine owns.

const CHAIN_COLUMNS = [
  "head_confirmed_id", "head_confirmed_at", "contiguous_oldest_id", "contiguous_oldest_at", "contiguous_count",
  "chain_upward_count", "chain_epoch", "history_state", "history_proof", "history_proven_at",
  "history_proof_observation_id", "history_proof_observation_received_at", "history_proof_raw_payload_id",
  "chain_source", "chain_journal_watermark",
];
const DAYTIME = () => new Date("2026-10-02T12:00:00Z");
const FANSLY_EPOCH_MS = 1561494359900n;

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  resetCaptureCasReadForTests();
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function app() {
  return { db: db(), logger: createLogger("silent") };
}

function ids(from: number, to: number): string[] {
  const out: string[] = [];
  for (let id = from; id >= to; id -= 1) out.push(String(id));
  return out;
}

function snowflake(ms: number): string {
  return String((BigInt(ms) - FANSLY_EPOCH_MS) << 22n);
}

async function seedPage(label = `rb-${randomUUID().slice(0, 8)}`): Promise<{ id: number; label: string }> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return { id: page!.id, label };
}

/** A thread with stored messages whose legacy window columns are exact. */
async function seedThread(pageId: number, groupId: string, stored: string[] = [], legacy: {
  coverage?: "pending_backfill" | "partial_window" | "complete";
  storedCountOverride?: number;
} = {}): Promise<number> {
  const createdAt = (index: number) => new Date(Date.parse("2026-09-01T00:00:00Z") - index * 60_000);
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, partner_platform_user_id,
       stored_message_count, newest_stored_message_id, oldest_stored_message_id, message_coverage_status,
       message_backfill_complete, last_fan_message_at, last_model_message_at, last_message_sync_at)
     values ($1, $2, $3, $4, $5, $6, $7::dm_message_coverage_status, $8, $9, $10, '2026-09-02T00:00:00Z')
     returning id::text as id`,
    [
      pageId, groupId, `fan-${groupId}`, legacy.storedCountOverride ?? stored.length, stored[0] ?? null,
      stored[stored.length - 1] ?? null, legacy.coverage ?? "partial_window", legacy.coverage === "complete",
      stored.length > 0 ? createdAt(0) : null, stored.length > 1 ? createdAt(1) : null,
    ],
  );
  const threadId = Number(result.rows[0]!.id);
  if (stored.length > 0) {
    await upsertPageDmMessages(db(), stored.map((id, index) => ({
      conversationId: threadId,
      platformAccountId: pageId,
      platformMessageId: id,
      senderPlatformUserId: index % 2 === 0 ? `fan-${groupId}` : "page",
      senderRole: index % 2 === 0 ? "fan" as const : "model" as const,
      createdAt: createdAt(index),
      content: `m${id}`,
      totalTipAmountCents: 0,
      inReplyToMessageId: null,
      inReplyToRootMessageId: null,
    })));
  }
  return threadId;
}

type Storage = "inline" | "pointer" | "unavailable";

interface JournalFixture {
  rawId: number;
  groupId: string | null;
  page: ChainPage | null;
}

const fixtures: JournalFixture[] = [];

function messagesBody(list: readonly string[]) {
  return {
    messages: list.map((id, index) => ({ id, createdAt: 1_756_000_000 - index, content: `c${id}`, senderId: "x" })),
    accountMedia: [],
  };
}

async function journalRow(pageId: number, params: Record<string, unknown>, body: unknown, storage: Storage = "inline"): Promise<number> {
  let payloadRef: { bucketMonth: string; objectId: number } | null = null;
  if (storage !== "inline") {
    const object = await putPayloadObject(db(), {
      representation: "canonical_json",
      json: body,
      captureInstant: new Date(),
      lane: "platform_capture",
      platformAccountId: pageId,
    });
    payloadRef = { bucketMonth: object.bucketMonth, objectId: object.objectId };
  }
  const receipt = await insertRawPayload(db(), {
    platformAccountId: pageId,
    endpoint: "dm_messages",
    requestParams: params,
    responsePayload: body,
    mapperVersion: "test",
    payloadKind: "dm_messages",
    retainUntil: new Date("2126-01-01T00:00:00Z"),
    payloadRef,
    omitInlinePayload: storage !== "inline",
  });
  if (storage === "unavailable") {
    await testDb!.pool.query("delete from capture_json_hot_bodies where bucket_month = $1 and object_id = $2", [
      payloadRef!.bucketMonth, payloadRef!.objectId,
    ]);
  }
  return receipt.id;
}

/** A `/message` page: journaled, and remembered as the page the online fold would see. */
async function messagePage(
  pageId: number,
  groupId: string,
  before: string | null,
  list: readonly string[],
  options: { limit?: number; storage?: Storage; headRepair?: boolean } = {},
): Promise<number> {
  const limit = options.limit ?? 25;
  const params: Record<string, unknown> = options.headRepair
    ? { groupId, limit, headRepair: true }
    : { groupId, limit, before };
  const rawId = await journalRow(pageId, params, messagesBody(list), options.storage);
  const capturedAt = (await testDb!.pool.query<{ captured_at: Date }>(
    "select captured_at from sync_raw_payloads where id = $1", [rawId],
  )).rows[0]!.captured_at;
  fixtures.push({
    rawId,
    groupId,
    page: options.storage === "unavailable" ? null : {
      before,
      limit,
      ids: [...list],
      createdAtMs: list.map((_id, index) => (1_756_000_000 - index) * 1000),
      capturedAt,
      witness: { kind: "raw", rawPayloadId: rawId },
    },
  });
  return rawId;
}

/** The online fold of the remembered pages of a group, from an empty chain. */
async function onlineFold(groupId: string, threadId: number, initial: ThreadChain): Promise<ThreadChain> {
  let chain = initial;
  let segment: Segment | null = null;
  for (const fixture of fixtures) {
    if (fixture.groupId !== groupId || fixture.page === null) continue;
    const stored = chainPageNeedsStoredFacts(fixture.page) ? await readThreadStoredFacts(db(), threadId) : null;
    const fold = foldChainPage(chain, segment, fixture.page, stored);
    chain = fold.chain;
    segment = fold.segment;
  }
  return chain;
}

async function snapshotsWithoutChain(pageId: number): Promise<Record<string, unknown>[]> {
  const rows = await testDb!.pool.query<{ row: Record<string, unknown> }>(
    "select to_jsonb(t) as row from page_dm_threads t where platform_account_id = $1 order by id",
    [pageId],
  );
  return rows.rows.map(({ row }) => Object.fromEntries(Object.entries(row).filter(([column]) => !CHAIN_COLUMNS.includes(column))));
}

function options(pageId: number, extra: Partial<ChainRebuildOptions> = {}): ChainRebuildOptions {
  return {
    pageId,
    write: false,
    full: false,
    batchRows: 4,
    sleepMs: 0,
    maxDurationMs: null,
    forceWindow: false,
    now: DAYTIME,
    ...extra,
  };
}

/** The page's mode, written directly: no lever reaches `handover` or `live` (I17). */
async function moveTo(pageId: number, path: readonly SyncPageMode[]): Promise<void> {
  for (const to of path) {
    await testDb!.pool.query(
      "update sync_pages set mode = $2, mode_changed_at = clock_timestamp(), mode_changed_by = 'test' where page_id = $1",
      [pageId, to],
    );
  }
}

interface Scenario {
  page: { id: number; label: string };
  threads: Record<string, number>;
}

/** The journal of one page: every row kind the rebuild meets. */
async function seedScenario(): Promise<Scenario> {
  fixtures.length = 0;
  const page = await seedPage();
  const p = page.id;
  const threads: Record<string, number> = {};
  // T1: head of 25 (pointer-only), a short page below, then the empty page ⇒ complete.
  threads.complete = await seedThread(p, "7001", ids(100040, 100001));
  // T2: the 16.09 pattern — a head of 24 of 25 with older stored messages; legacy says complete.
  threads.cut = await seedThread(p, "7002", ids(200100, 200001), { coverage: "complete" });
  // T3: a walk page without a head (not continuing), a limit-1 head repair, then the walk down.
  threads.repair = await seedThread(p, "7003", ids(300050, 300001));
  // T4: a refused body, a body without messages, an unreadable head and its orphan continuation.
  threads.broken = await seedThread(p, "7004", ids(400030, 400001));
  // T5: the engine's chain — never touched by the rebuild.
  threads.engine = await seedThread(p, "7005", ids(500010, 500001));
  // T6: a chat without messages ⇒ complete by its empty head.
  threads.emptyChat = await seedThread(p, "7006");
  // T7: a page breaking the contract.
  threads.violation = await seedThread(p, "7007", ids(700010, 700001));

  const engineChain: ThreadChainState = {
    epoch: 0,
    state: "partial",
    headId: "500010",
    headAt: new Date("2026-09-30T00:00:00Z"),
    oldestId: "500001",
    oldestCreatedAtMs: 1,
    count: 10,
    upwardCount: 0,
    proof: null,
    proofWitness: null,
    provenAt: null,
  };
  await testDb!.db.transaction((tx) => writeThreadChain(tx as unknown as Database, threads.engine!, {
    chain: engineChain, source: "engine",
  }));

  await journalRow(p, {}, messagesBody(["1"]));
  await messagePage(p, "7003", "300040", ids(300039, 300030));
  await messagePage(p, "7001", null, ids(100040, 100016), { storage: "pointer" });
  await messagePage(p, "7002", null, ids(200100, 200077));
  await journalRow(p, { groupId: "7004", limit: 25, before: null }, { contractAccepted: false, raw: { error: "drift" } });
  await journalRow(p, { groupId: "7004", limit: 25, before: null }, { data: [] });
  await messagePage(p, "7004", null, ids(400030, 400006), { storage: "unavailable" });
  await messagePage(p, "7003", null, ["300050"], { limit: 1, headRepair: true });
  await messagePage(p, "7001", "100016", ids(100015, 100001));
  await messagePage(p, "7005", null, ids(500012, 500001));
  await messagePage(p, "7004", "400006", ids(400005, 400001));
  await messagePage(p, "7006", null, []);
  await messagePage(p, "7999", null, ids(999010, 999001));
  await messagePage(p, "7003", "300050", ids(300049, 300025), { storage: "pointer" });
  await messagePage(p, "7007", null, ["700001", "700002"]);
  await messagePage(p, "7001", "100001", []);
  return { page, threads };
}

describe("sync chain rebuild", () => {
  it("dry run: folds every row kind and writes nothing", async () => {
    const { page, threads } = await seedScenario();
    const before = await snapshotsWithoutChain(page.id);
    const report = await rebuildPageChains(app(), options(page.id));

    expect(report.scan).toMatchObject({ fromRawId: 0, completed: true, stoppedBy: null, rowsScanned: 16 });
    expect(report.rows.skipped).toMatchObject({
      no_params: 1, contract_rejected: 1, no_messages_array: 1, body_unavailable: 1,
      unknown_thread: 1, engine_owned: 1, already_folded: 0,
    });
    expect(report.rows.verdicts).toMatchObject({
      started: 3, completed: 2, extended_down: 2, not_continuing: 2, contract_violation: 1,
    });
    expect(report.rows.completions).toEqual({ empty_page: 1, empty_head: 1, segment_empty_page: 0 });
    expect(report.rows.contractViolations).toEqual({ not_newest_first: 1 });
    expect(report.threads).toMatchObject({
      folded: 6, complete: 2, partial: 2, unverified: 2, none: 0, written: 0,
      completeVia: { empty_page: 1, empty_head: 1, segment_empty_page: 0, earlier_run: 0 },
    });
    expect(await snapshotsWithoutChain(page.id)).toEqual(before);
    for (const threadId of Object.values(threads)) {
      const chain = await readThreadChain(db(), threadId);
      expect(chain!.source === "engine" || chain!.source === null).toBe(true);
    }
    expect(await getLatestCompletedChainRebuild(db(), page.id)).toBeNull();
  });

  it("--write: chains equal the online fold, only chain columns change, the run is audited", async () => {
    const { page, threads } = await seedScenario();
    const before = await snapshotsWithoutChain(page.id);
    const report = await rebuildPageChains(app(), options(page.id, { write: true }));
    expect(report.threads.written).toBe(6);

    expect(await snapshotsWithoutChain(page.id)).toEqual(before);
    const through = report.scan.throughRawId;
    for (const [name, groupId] of [
      ["complete", "7001"], ["cut", "7002"], ["repair", "7003"], ["broken", "7004"], ["emptyChat", "7006"], ["violation", "7007"],
    ] as const) {
      const stored = await readThreadChain(db(), threads[name]!);
      const initial = emptyChain(stored!.storedMessageCount > 0 ? "unverified" : "none");
      expect(stored!.chain, name).toEqual(await onlineFold(groupId, threads[name]!, initial));
      expect(stored!.source, name).toBe("journal_rebuild");
      expect(stored!.journalWatermark, name).toBeGreaterThan(0);
      expect(stored!.journalWatermark, name).toBeLessThanOrEqual(through);
    }
    expect((await readThreadChain(db(), threads.complete!))!.chain).toMatchObject({
      state: "complete", proof: "empty_page", headId: "100040", oldestId: "100001", count: 40,
    });
    expect((await readThreadChain(db(), threads.cut!))!.chain).toMatchObject({ state: "partial", count: 24 });
    expect((await readThreadChain(db(), threads.repair!))!.chain).toMatchObject({
      state: "partial", headId: "300050", oldestId: "300025", count: 26,
    });
    expect((await readThreadChain(db(), threads.broken!))!.chain.state).toBe("unverified");
    expect((await readThreadChain(db(), threads.emptyChat!))!.chain).toMatchObject({ state: "complete", count: 0 });
    expect((await readThreadChain(db(), threads.engine!))!.chain).toMatchObject({ headId: "500010", count: 10 });
    expect((await readThreadChain(db(), threads.engine!))!.source).toBe("engine");

    const audit = await testDb!.pool.query<{ metadata: Record<string, unknown>; source: string }>(
      "select metadata, source from audit_events where event_type = $1 and platform_account_id = $2",
      [SYNC_CHAIN_REBUILD_AUDIT_EVENT, page.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      source: "cli",
      metadata: { scope: "page", completed: true, full: false, throughRawId: through, threadsWritten: 6 },
    });
    expect(await getLatestCompletedChainRebuild(db(), page.id)).toMatchObject({ throughRawId: through });
  });

  it("incremental runs resume from the stored chains and agree with a full rebuild", async () => {
    const { page, threads } = await seedScenario();
    const first = await rebuildPageChains(app(), options(page.id, { write: true }));
    await messagePage(page.id, "7002", "200077", ids(200076, 200052));
    await messagePage(page.id, "7001", null, ids(100042, 100018));
    await messagePage(page.id, "7003", null, ids(300060, 300036));

    const second = await rebuildPageChains(app(), options(page.id, { write: true }));
    expect(second.scan).toMatchObject({ fromRawId: first.scan.throughRawId, rowsScanned: 3, completed: true });
    expect(second.rows.verdicts).toMatchObject({ extended_down: 1, joined: 2 });
    expect(second.threads).toMatchObject({ folded: 3, written: 3, completeVia: { earlier_run: 1 } });
    const incremental = await Promise.all(Object.values(threads).map((threadId) => readThreadChain(db(), threadId)));
    expect((await readThreadChain(db(), threads.complete!))!.chain).toMatchObject({ state: "complete", count: 42, upwardCount: 2 });
    expect((await readThreadChain(db(), threads.cut!))!.chain).toMatchObject({ oldestId: "200052", count: 49 });

    const full = await rebuildPageChains(app(), options(page.id, { write: true, full: true }));
    expect(full.scan.fromRawId).toBe(0);
    const rebuilt = await Promise.all(Object.values(threads).map((threadId) => readThreadChain(db(), threadId)));
    rebuilt.forEach((row, index) => {
      const earlier = incremental[index]!;
      // A full run replaces an existing chain under a new epoch; the facts are the same.
      expect({ ...row!.chain, epoch: 0 }).toEqual({ ...earlier.chain, epoch: 0 });
      if (earlier.source === "journal_rebuild" && earlier.chain.count > 0) expect(row!.chain.epoch).toBe(earlier.chain.epoch + 1);
    });
  });

  it("a thread run is audited as such and never counts as the page's completed rebuild", async () => {
    const { page, threads } = await seedScenario();
    const report = await rebuildPageChains(app(), options(page.id, { write: true, threadId: threads.complete! }));
    expect(report.rows.folded).toBe(3);
    expect(report.threads).toMatchObject({ folded: 1, written: 1, complete: 1 });
    expect((await readThreadChain(db(), threads.cut!))!.source).toBeNull();
    expect(await getLatestCompletedChainRebuild(db(), page.id)).toBeNull();
    await expect(rebuildPageChains(app(), options(page.id, { threadId: threads.complete! + 10_000 })))
      .rejects.toThrow(/not a thread of page/);
  });

  it("never runs in the legacy night window unless forced, and stops at its time budget", async () => {
    const { page } = await seedScenario();
    const night = await rebuildPageChains(app(), options(page.id, { write: true, now: () => new Date("2026-10-02T02:00:00Z") }));
    expect(night.scan).toMatchObject({ stoppedBy: "night_window", rowsScanned: 0, completed: false });
    expect(night.threads.written).toBe(0);
    const forced = await rebuildPageChains(app(), options(page.id, { now: () => new Date("2026-10-02T02:00:00Z"), forceWindow: true }));
    expect(forced.scan.completed).toBe(true);

    let clock = Date.parse("2026-10-02T12:00:00Z");
    const budgeted = await rebuildPageChains(app(), options(page.id, {
      write: true,
      maxDurationMs: 30_000,
      now: () => new Date((clock += 20_000)),
    }));
    expect(budgeted.scan).toMatchObject({ stoppedBy: "max_duration", batches: 1, rowsScanned: 4, completed: false });
    expect(await getLatestCompletedChainRebuild(db(), page.id)).toBeNull();
  });

  it("refuses a page in handover or live (the engine is the chain writer there)", async () => {
    const { page } = await seedScenario();
    await moveTo(page.id, ["shadow"]);
    expect((await rebuildPageChains(app(), options(page.id))).mode).toBe("shadow");
    await moveTo(page.id, ["handover"]);
    await expect(rebuildPageChains(app(), options(page.id))).rejects.toBeInstanceOf(ChainRebuildRefusedError);
    await expect(rebuildPageChains(app(), options(page.id, { write: true }))).rejects.toThrow(/'handover'/);
    await moveTo(page.id, ["live"]);
    await expect(rebuildPageChains(app(), options(page.id))).rejects.toThrow(/'live'/);
  });
});

describe("sync chain CLI", () => {
  async function loadCliProgram() {
    vi.resetModules();
    const appContext = createTestAppContext(testDb!);
    vi.doMock("../apps/runtime/src/bootstrap.ts", () => ({ createAppContext: async () => appContext }));
    const { buildProgram } = await import("../apps/runtime/src/cli.ts");
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
    return program;
  }

  function captureOutput() {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    return () => JSON.parse(lines.join("\n")) as Record<string, unknown>;
  }

  it("rebuilds a page (dry run by default) and refuses a live one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: DAYTIME() });
    try {
      const { page, threads } = await seedScenario();
      await seedPage();
      const output = captureOutput();
      await (await loadCliProgram()).parseAsync(
        ["sync", "chain", "rebuild", "--page", page.label, "--sleep-ms", "0", "--batch-rows", "5"],
        { from: "user" },
      );
      const report = output() as { write: boolean; pages: Array<{ pageId: number; scan: { completed: boolean } }> };
      expect(report.write).toBe(false);
      expect(report.pages).toHaveLength(1);
      expect(report.pages[0]).toMatchObject({ pageId: page.id, scan: { completed: true } });
      expect((await readThreadChain(db(), threads.complete!))!.source).toBeNull();

      await moveTo(page.id, ["shadow", "handover", "live"]);
      await expect((await loadCliProgram()).parseAsync(
        ["sync", "chain", "rebuild", "--page", page.label, "--write"],
        { from: "user" },
      )).rejects.toThrow(/'live'/);
      expect((await readThreadChain(db(), threads.complete!))!.source).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks the stored window of a page's threads", async () => {
    const page = await seedPage();
    await seedThread(page.id, "8101", ids(810010, 810001));
    const drifting = await seedThread(page.id, "8102", ids(810110, 810101), { storedCountOverride: 9 });
    const output = captureOutput();
    await (await loadCliProgram()).parseAsync(["sync", "chain", "check-window", "--page", page.label], { from: "user" });
    expect(output()).toMatchObject({
      pageId: page.id,
      mode: "off",
      threadsChecked: 2,
      drifted: 1,
      byField: { storedMessageCount: 1, newestStoredMessageId: 0, oldestStoredMessageId: 0 },
      examples: [{ threadId: drifting, fields: { storedMessageCount: { stored: 9, recomputed: 10 } } }],
      truncated: false,
    });
    const capped = await checkWindow(app(), { pageId: page.id, maxThreads: 1, maxListed: 5 });
    expect(capped).toMatchObject({ threadsChecked: 1, drifted: 0, truncated: true });
  });
});

describe("sync chain check-end-rule", () => {
  it("finds the short-page counterexamples, unsound empty pages, first-second pages and false legacy completes", async () => {
    fixtures.length = 0;
    const page = await seedPage();
    const p = page.id;
    // Realistic chat ids (snowflakes of 2025): the message ids below decode to
    // 2019, far from any chat's first second.
    const [g1, g2, g3, g4, g5] = [1, 2, 3, 4, 5].map((day) => snowflake(Date.parse(`2025-01-0${day}T00:00:00Z`)));
    // 16.09: a head of 24 of 25, the hub stores 76 older messages; legacy calls it complete.
    const cut = await seedThread(p, g1!, ids(900100, 900001), { coverage: "complete" });
    // A short head whose next page (before = its oldest) still returned messages.
    await seedThread(p, g2!);
    // A short head, then an empty page at the chain end — but the hub stores an older message.
    await seedThread(p, g3!, ["930100", "930050"]);
    // A proper short chat: its head is the whole history.
    await seedThread(p, g4!, ids(940005, 940001), { coverage: "complete" });
    // Legacy complete, never in the journal.
    await seedThread(p, g5!, ["950001"], { coverage: "complete" });
    // First-second: the oldest message of a short head was created within 1 s of the chat.
    const chatMs = Date.parse("2025-05-01T00:00:00Z");
    const chatId = snowflake(chatMs);
    await seedThread(p, chatId);

    const old = await messagePage(p, g2!, null, ids(920100, 920090));
    await testDb!.pool.query("update sync_raw_payloads set captured_at = '2026-07-01T00:00:00Z' where id = $1", [old]);
    const cutHead = await messagePage(p, g1!, null, ids(900100, 900077));
    const shortHead = await messagePage(p, g2!, null, ids(920100, 920091));
    await messagePage(p, g2!, "920091", ids(920090, 920086));
    const unsoundHead = await messagePage(p, g3!, null, ["930100", "930099"]);
    const unsoundEnd = await messagePage(p, g3!, "930099", []);
    await messagePage(p, g4!, null, ids(940005, 940001));
    await messagePage(p, g4!, "940001", []);
    const firstSecond = await messagePage(p, chatId, null, [snowflake(chatMs + 90_000), snowflake(chatMs + 300)]);
    await messagePage(p, chatId, snowflake(chatMs + 300), []);
    await messagePage(p, g1!, null, ["900100"], { limit: 1, headRepair: true });

    const report = await checkEndRule(app(), {
      pageId: p,
      since: new Date("2026-07-05T00:00:00Z"),
      maxListed: 100,
      batchRows: 3,
      sleepMs: 0,
      maxDurationMs: null,
      forceWindow: false,
      now: DAYTIME,
    });
    expect(report.scan).toMatchObject({ completed: true, rowsScanned: 10, stoppedBy: null });
    expect(report.shortPages.counterexampleRawIds).toEqual([cutHead, shortHead, unsoundHead]);
    expect(report.shortPages.byEvidence).toEqual({ later_page: 1, stored: 2, both: 0 });
    expect(report.shortPages.details[0]).toMatchObject({
      rawId: cutHead, threadId: cut, limit: 25, items: 24, oldestId: "900077", storedOlder: 76, laterPageRawId: null,
    });
    expect(report.shortPages.details[1]).toMatchObject({ rawId: shortHead, laterPageRawId: expect.any(Number), storedOlder: 0 });
    // Five short heads and one short walk page; the limit-1 repair is never short.
    expect(report.shortPages.total).toBe(6);
    expect(report.emptyPageSoundness).toMatchObject({
      emptyPagesAtChainEnd: 3,
      withOlderStored: 1,
      hits: [{ rawId: unsoundEnd, before: "930099", storedOlder: 1 }],
    });
    expect(report.firstSecond).toEqual({
      ruleEnabled: false, shortPagesWithinOneSecond: 1, ofWhichOlderMaterial: 0, rawIds: [firstSecond],
    });
    expect(report.legacyVerdicts).toMatchObject({
      legacyComplete: 3, rebuiltComplete: 3, falseComplete: 1, notInJournal: 1,
      examples: [{ threadId: cut, rebuiltState: "partial" }],
    });
    // The fold itself never completed the cut thread.
    expect(report.rows.completions.empty_page).toBe(3);
    expect(new ScanGovernor({ batchRows: 1, sleepMs: 0, maxDurationMs: null, forceWindow: false, now: () => new Date("2026-10-02T04:59:00Z") }).stopReason())
      .toBe("night_window");
  });
});
