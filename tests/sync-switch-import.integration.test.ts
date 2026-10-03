import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cancelLiveWorkForRollback,
  ensureFanslyPageSendGuard,
  getSyncPage,
  handFanslySendGuardBackToLegacy,
  importWorkBreaker,
  insertAuditEvent,
  lockBreakerImportFence,
  pickUrgent,
  upsertDemand,
  type Database,
  type ImportWorkBreakerInput,
} from "@agency_hub_core/db";

import { activePageHold, INDEFINITE_UNTIL } from "../apps/runtime/src/sync/engine/errors.ts";
import { routeFanslyWsReceiptDemand } from "../apps/runtime/src/sync/fansly/ws/route-receipt.ts";
import { SYNC_SWITCH_AUDIT_EVENT } from "../apps/runtime/src/sync/switch/audit.ts";
import { importLegacyState } from "../apps/runtime/src/sync/switch/import.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { wsCreated, wsMessage } from "./helpers/fansly-ws-capture.ts";
import { waitForRowLockWait } from "./helpers/lock-waits.ts";
import { setModeDirect } from "./helpers/sync-engine-host.ts";
import {
  FakeChats,
  HARNESS_OWN_REF,
  harnessConfig,
  seedChatThread,
  seedHarnessPage,
  type FakeChat,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import { switchContext, switchRegistry, testCapability } from "./helpers/sync-switch.ts";

// The switch's legacy import (design step 3 §3.5 item 7, phase I) against the
// database, without a sender: I.4 carries a legacy 429 hold AND a legacy auth
// block — the auth hold keeps the 429 hold beside itself, never overwrites it,
// and the page stays held until the later of them ends (also into the legacy
// guard if the owner rolls back with `--with-auth-hold`); I.3 merges every
// legacy chat breaker in force into the key (step 3b ruling 8): into the work
// a WS receipt of the handover (or a rollback) left open, else into a carrier
// the next work inherits — the same breaker whichever of receipt and import
// comes first, a concurrent receipt fenced, never lowering a stricter one; a
// switch after a rollback carries the newer one, and a resumed import never
// doubles one.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

/** A page in `handover` with stored credentials and a proxy (nothing is ever sent). */
async function handoverPage(label: string): Promise<HarnessPage> {
  const page = await seedHarnessPage(handles(), { mode: "shadow", proxyUrl: "http://127.0.0.1:9", label });
  await setModeDirect(testDb!.pool, page.pageId, "handover");
  return page;
}

async function switchStarted(pageId: number): Promise<void> {
  await insertAuditEvent(db(), {
    platformAccountId: pageId,
    source: "cli",
    eventType: SYNC_SWITCH_AUDIT_EVENT,
    metadata: { phase: "start", pageId, actor: "test" },
  });
}

function importOnce(page: HarnessPage) {
  const config = harnessConfig(testDb!.connectionString, "http://127.0.0.1:9");
  return importLegacyState(switchContext({ db: db(), config }), {
    pageId: page.pageId,
    registry: switchRegistry(),
    capability: testCapability("test import")(page.pageId),
  });
}

async function legacyAuthBlock(pageId: number): Promise<void> {
  await testDb!.pool.query(
    `insert into page_sync_states (page_id, stream, status, blocker_kind, blocker_code, blocked_at, cadence_seconds, slot_offset_seconds)
     values ($1, 'light', 'idle', 'auth', 'http_401', clock_timestamp(), 300, 0)
     on conflict (page_id, stream) do update set blocker_kind = 'auth'`,
    [pageId],
  );
}

async function legacyProviderHold(pageId: number, seconds: number): Promise<Date> {
  const result = await testDb!.pool.query<{ until: Date }>(
    `insert into page_sync_provider_holds (page_id, hold_until, reason, stream, armed_at)
     values ($1, clock_timestamp() + make_interval(secs => $2), 'rate_limited', 'light', clock_timestamp())
     returning hold_until as until`,
    [pageId, seconds],
  );
  return result.rows[0]!.until;
}

interface ImportedRow {
  resource: string;
  failure_count: number;
  breaker_until: Date | null;
}

async function importedBreakers(pageId: number): Promise<ImportedRow[]> {
  return (await testDb!.pool.query<ImportedRow>(
    `select resource, failure_count, breaker_until from sync_work
      where page_id = $1 and not shadow and close_reason = 'legacy_import' order by resource, id`,
    [pageId],
  )).rows;
}

describe("the switch's legacy import: holds (I.4)", () => {
  it("a legacy auth block never overwrites the carried 429 hold: the auth hold keeps it beside itself until it ends", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-holds");
    const legacyUntil = await legacyProviderHold(page.pageId, 60);
    await legacyAuthBlock(page.pageId);

    const report = await importOnce(page);
    expect(report.holds).toEqual({ rateLimitUntil: legacyUntil.toISOString(), auth: true });
    const row = (await getSyncPage(db(), page.pageId))!;
    expect(row.holdKind).toBe("auth");
    expect(row.holdUntil).toEqual(INDEFINITE_UNTIL);
    expect(row.holdDetail).toMatchObject({
      importedFrom: "page_sync_states.blocker_kind",
      streams: ["light"],
      timedHold: { kind: "rate_limit", until: legacyUntil.toISOString(), detail: { importedFrom: "page_sync_provider_holds" } },
    });
    // Both in force: nothing goes out before the 429 ends (not even a
    // candidate identity check), then the auth hold alone.
    expect(activePageHold(row, row.dbNow)).toEqual({
      kind: "auth",
      until: INDEFINITE_UNTIL,
      timed: { kind: "rate_limit", until: legacyUntil },
    });
    expect(activePageHold(row, new Date(legacyUntil.getTime() + 1))).toEqual({ kind: "auth", until: INDEFINITE_UNTIL, timed: null });
    // The owner's identity-checked renewal lifts the auth hold only.
    expect(activePageHold({ ...row, credentialsGeneration: "f".repeat(64) }, row.dbNow))
      .toEqual({ kind: "rate_limit", until: legacyUntil, timed: { kind: "rate_limit", until: legacyUntil } });

    // A resumed import changes nothing.
    await setModeDirect(testDb.pool, page.pageId, "handover");
    await importOnce(page);
    const again = (await getSyncPage(db(), page.pageId))!;
    expect(again.holdKind).toBe("auth");
    expect(again.holdDetail.timedHold).toEqual(row.holdDetail.timedHold);
  }, 60_000);

  it("an engine 429/network hold left on the row ending later than the legacy one stays the carried end", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-holds-later");
    const engineUntil = (await testDb.pool.query<{ until: Date }>(
      `update sync_pages set hold_kind = 'network', hold_until = clock_timestamp() + interval '5 minutes',
              hold_since = clock_timestamp(), hold_detail = '{"streak": 3}'::jsonb
        where page_id = $1 returning hold_until as until`,
      [page.pageId],
    )).rows[0]!.until;
    await legacyProviderHold(page.pageId, 30);
    await legacyAuthBlock(page.pageId);

    await importOnce(page);
    const row = (await getSyncPage(db(), page.pageId))!;
    expect(row.holdKind).toBe("auth");
    expect(row.holdDetail.timedHold).toEqual({ kind: "network", until: engineUntil.toISOString(), detail: { streak: 3 } });
  }, 60_000);

  it("a rollback with --with-auth-hold moves the legacy guard past the 429 hold the auth hold carries", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-holds-floor");
    const legacyUntil = await legacyProviderHold(page.pageId, 120);
    await legacyAuthBlock(page.pageId);
    await importOnce(page);
    await ensureFanslyPageSendGuard(db(), page.pageId);
    await testDb.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [page.pageId]);
    // The engine's owner released the page (rollback step 2).
    await testDb.pool.query(
      `update sync_pages set owner_released_at = clock_timestamp(), owner_release_generation = owner_generation
        where page_id = $1`,
      [page.pageId],
    );

    expect(await handFanslySendGuardBackToLegacy(db(), { pageId: page.pageId })).toEqual({ kind: "auth_hold", holdKind: "auth" });
    const handed = await handFanslySendGuardBackToLegacy(db(), { pageId: page.pageId, allowAuthHold: true });
    expect(handed.kind).toBe("handed");
    expect((handed as { lastCompletedAt: Date }).lastCompletedAt.getTime()).toBeGreaterThanOrEqual(legacyUntil.getTime());
  }, 60_000);

  for (const [file, kind] of [["dm-conversations", "rate_limit_list"], ["media-stats", "rate_limit_media_stats"]] as const) {
    it(`a rollback moves the legacy guard past an endpoint group's 429 hold in force (${kind}; legacy has no endpoint holds)`, async (context) => {
      if (!testDb) return context.skip();
      const page = await handoverPage(`import-holds-${file}`);
      await importOnce(page);
      const until = (await testDb.pool.query<{ until: Date }>(
        `update sync_pages
            set resource_holds = jsonb_build_object($2::text, jsonb_build_object(
                  'until', clock_timestamp() + interval '2 minutes', 'step', 3, 'since', clock_timestamp(), 'kind', $3::text)),
                owner_released_at = clock_timestamp(), owner_release_generation = owner_generation
          where page_id = $1
        returning (resource_holds -> $2::text ->> 'until')::timestamptz as until`,
        [page.pageId, file, kind],
      )).rows[0]!.until;
      await ensureFanslyPageSendGuard(db(), page.pageId);
      await testDb.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [page.pageId]);
      const handed = await handFanslySendGuardBackToLegacy(db(), { pageId: page.pageId });
      expect(handed.kind).toBe("handed");
      expect((handed as { lastCompletedAt: Date }).lastCompletedAt.getTime()).toBeGreaterThanOrEqual(until.getTime());
    }, 60_000);
  }
});

/** A legacy breaker in force on the chat's thread (`page_dm_message_sync_health`),
 *  armed before the switch began; returns its end. */
async function legacyChatBreaker(pageId: number, threadId: number, failures: number, seconds: number): Promise<Date> {
  return (await testDb!.pool.query<{ until: Date }>(
    `insert into page_dm_message_sync_health (conversation_id, platform_account_id, failure_count, error_class, last_error,
            last_attempt_at, next_retry_at, quarantine_until)
     values ($1, $2, $3, 'vendor_500', 'HTTP 500', clock_timestamp() - interval '1 day',
             clock_timestamp() + make_interval(secs => $4), null)
     returning next_retry_at as until`,
    [threadId, pageId, failures, seconds],
  )).rows[0]!.until;
}

/** A WS receipt of a fan message in `chat`, routed by the post-ack hook in
 *  its own transaction as a live-apply driver does; `within` runs after the
 *  hook, before the commit. */
async function receipt(page: HarnessPage, chat: FakeChat, within?: () => Promise<void>): Promise<void> {
  await db().transaction(async (raw) => {
    await routeFanslyWsReceiptDemand(raw as unknown as Database, {
      pageId: page.pageId,
      observationId: 1,
      receivedAt: new Date(),
      ownRef: HARNESS_OWN_REF,
      frame: wsCreated(wsMessage({ groupId: chat.groupId, senderId: chat.fanRef })),
      liveState: "applied",
    });
    await within?.();
  });
}

interface KeyRow {
  id: string;
  state: string;
  failure_count: number;
  breaker_until: Date | null;
  blocked_by_vendor_at: Date | null;
  last_error_class: string | null;
  demand_revision: string;
  demand: unknown;
  due_at: Date;
  deadline_at: Date | null;
  waiting_reason: string | null;
  result: unknown;
  close_reason: string | null;
}

/** Every live row of a key, oldest first. */
async function keyRows(pageId: number, resource: string, subject: string): Promise<KeyRow[]> {
  return (await testDb!.pool.query<KeyRow>(
    `select id::text, state, failure_count, breaker_until, blocked_by_vendor_at, last_error_class, demand_revision::text,
            demand, due_at, deadline_at, waiting_reason, result, close_reason
       from sync_work where page_id = $1 and not shadow and resource = $2 and subject = $3 order by id`,
    [pageId, resource, subject],
  )).rows;
}

async function openRow(pageId: number, resource: string, subject: string): Promise<KeyRow> {
  const open = (await keyRows(pageId, resource, subject)).filter((row) => ["open", "running", "quarantined"].includes(row.state));
  expect(open).toHaveLength(1);
  return open[0]!;
}

/** The breaker of a row: what the import merges and a new row inherits. */
function breakerOf(row: KeyRow) {
  return {
    failureCount: row.failure_count,
    breakerUntil: row.breaker_until?.getTime() ?? null,
    blockedByVendorAt: row.blocked_by_vendor_at?.getTime() ?? null,
    lastErrorClass: row.last_error_class,
  };
}

/** The chat's urgent head reads a pick would admit at `now`. */
async function headPicks(pageId: number, now: Date): Promise<string[]> {
  return (await pickUrgent(db(), { pageId, shadow: false, now }))
    .filter((work) => work.resource === "dm-messages.head")
    .map((work) => String(work.id));
}

describe("the switch's legacy import: chat breakers (I.3, step 3b ruling 8)", () => {
  for (const receiptFirst of [true, false]) {
    const order = receiptFirst ? "a handover receipt, then the import" : "the import, then a handover receipt";
    it(`${order}: the chat's open head read waits for the legacy breaker; its demand stays`, async (context) => {
      if (!testDb) return context.skip();
      const page = await handoverPage(receiptFirst ? "import-order-receipt" : "import-order-import");
      const chat = new FakeChats().add({ count: 2, ageMs: 3_600_000 });
      const threadId = await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages });
      const until = await legacyChatBreaker(page.pageId, threadId, 2, 3_600);
      await switchStarted(page.pageId);

      let opened: KeyRow | null = null;
      if (receiptFirst) {
        await receipt(page, chat);
        opened = await openRow(page.pageId, "dm-messages.head", chat.groupId);
        expect(breakerOf(opened)).toEqual({ failureCount: 0, breakerUntil: null, blockedByVendorAt: null, lastErrorClass: null });
      }
      const report = await importOnce(page);
      expect(report).toMatchObject({ breakers: 3, breakersOnOpenWork: receiptFirst ? 1 : 0 });
      if (!receiptFirst) await receipt(page, chat);

      // Either order: the same breaker on the head work, a carrier for the
      // keys without open work (and for the head key only when it had none).
      const head = await openRow(page.pageId, "dm-messages.head", chat.groupId);
      expect(breakerOf(head)).toEqual({
        failureCount: 2, breakerUntil: until.getTime(), blockedByVendorAt: null, lastErrorClass: "legacy:vendor_500",
      });
      expect((await importedBreakers(page.pageId)).map((row) => row.resource)).toEqual(receiptFirst
        ? ["dm-messages.catchup", "dm-messages.history"]
        : ["dm-messages.catchup", "dm-messages.head", "dm-messages.history"]);
      if (opened !== null) {
        // The receipt's work itself: nothing but its breaker moved.
        const { id, state, demand_revision, demand, due_at, deadline_at, waiting_reason } = opened;
        expect(head).toMatchObject({ id, state, demand_revision, demand, due_at, deadline_at, waiting_reason });
      }

      // A pick passes it over until the legacy breaker ends, then takes it.
      expect(await headPicks(page.pageId, new Date(until.getTime() - 1_000))).toEqual([]);
      expect(await headPicks(page.pageId, new Date(until.getTime() + 1))).toEqual([head.id]);

      // A resumed import raises nothing and writes nothing.
      const before = await keyRows(page.pageId, "dm-messages.head", chat.groupId);
      await setModeDirect(testDb.pool, page.pageId, "handover");
      expect(await importOnce(page)).toMatchObject({ breakers: 0, breakersOnOpenWork: 0 });
      expect(await keyRows(page.pageId, "dm-messages.head", chat.groupId)).toEqual(before);
      expect(await importedBreakers(page.pageId)).toHaveLength(receiptFirst ? 2 : 3);
    }, 60_000);
  }

  it("never lowers a stricter breaker of the open work; a quarantined work keeps its quarantine", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-breaker-monotonic");
    const chat = new FakeChats().add({ count: 2, ageMs: 3_600_000 });
    const threadId = await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages });
    const until = await legacyChatBreaker(page.pageId, threadId, 2, 3_600);
    await switchStarted(page.pageId);
    // The head work: the engine's own breaker, stricter than legacy's.
    const head = await upsertDemand(db(), {
      pageId: page.pageId, shadow: false, resource: "dm-messages.head", subject: chat.groupId, kind: "trigger", class: "urgent",
    });
    await testDb.pool.query(
      `update sync_work set failure_count = 5, breaker_until = clock_timestamp() + interval '1 day',
              blocked_by_vendor_at = clock_timestamp(), last_error_class = 'subject_failure' where id = $1`,
      [head.id],
    );
    const stricter = breakerOf(await openRow(page.pageId, "dm-messages.head", chat.groupId));
    // The catch-up work: quarantined, no breaker.
    const catchup = await upsertDemand(db(), {
      pageId: page.pageId, shadow: false, resource: "dm-messages.catchup", subject: chat.groupId, kind: "trigger", class: "planned",
    });
    const quarantine = { reason: "contract_violation", detail: { field: "messages" }, attemptId: null, at: "2026-10-03T00:00:00.000Z" };
    await testDb.pool.query(
      `update sync_work set state = 'quarantined', waiting_reason = 'quarantined', result = jsonb_build_object('quarantine', $2::jsonb)
        where id = $1`,
      [catchup.id, JSON.stringify(quarantine)],
    );

    const report = await importOnce(page);
    expect(report).toMatchObject({ breakers: 2, breakersOnOpenWork: 1 });
    expect(breakerOf(await openRow(page.pageId, "dm-messages.head", chat.groupId))).toEqual(stricter);
    const quarantined = await openRow(page.pageId, "dm-messages.catchup", chat.groupId);
    expect(quarantined).toMatchObject({ state: "quarantined", waiting_reason: "quarantined", result: { quarantine } });
    expect(breakerOf(quarantined)).toEqual({
      failureCount: 2, breakerUntil: until.getTime(), blockedByVendorAt: null, lastErrorClass: "legacy:vendor_500",
    });
    // Only the history key, with no work, got a carrier.
    expect((await importedBreakers(page.pageId)).map((row) => row.resource)).toEqual(["dm-messages.history"]);
  }, 60_000);

  it("a switch after a rollback merges the newer legacy breaker into the history work the rollback kept; a resumed import never doubles one", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-breakers");
    const chat = new FakeChats().add({ count: 2, ageMs: 3_600_000 });
    const threadId = await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages });
    const firstUntil = await legacyChatBreaker(page.pageId, threadId, 2, 3_600);

    // The first switch, its import run twice (resumed): one carrier per DM key.
    await switchStarted(page.pageId);
    expect(await importOnce(page)).toMatchObject({ breakers: 3, breakersOnOpenWork: 0 });
    await setModeDirect(testDb.pool, page.pageId, "handover");
    expect(await importOnce(page)).toMatchObject({ breakers: 0, breakersOnOpenWork: 0 });
    const first = await importedBreakers(page.pageId);
    expect(first.map((row) => [row.resource, row.failure_count, row.breaker_until?.getTime()])).toEqual([
      ["dm-messages.catchup", 2, firstUntil.getTime()],
      ["dm-messages.head", 2, firstUntil.getTime()],
      ["dm-messages.history", 2, firstUntil.getTime()],
    ]);

    // Live: the head and history works inherit the breaker; the rollback
    // cancels the head work and keeps the history work open (paused). Back on
    // the legacy engine the chat failed again — a newer breaker.
    for (const [resource, kind, workClass] of [
      ["dm-messages.head", "trigger", "urgent"], ["dm-messages.history", "goal", "requests"],
    ] as const) {
      await upsertDemand(db(), { pageId: page.pageId, shadow: false, resource, subject: chat.groupId, kind, class: workClass });
    }
    await cancelLiveWorkForRollback(db(), { pageId: page.pageId, closeReason: "rolled_back" });
    const secondUntil = (await testDb.pool.query<{ until: Date }>(
      `update page_dm_message_sync_health
          set failure_count = 4, last_attempt_at = clock_timestamp() - interval '1 minute',
              next_retry_at = clock_timestamp() + interval '6 hours'
        where conversation_id = $1 returning next_retry_at as until`,
      [threadId],
    )).rows[0]!.until;

    // The second switch: the history work takes it, the other keys' carriers
    // carry it; a resumed import writes nothing more.
    await setModeDirect(testDb.pool, page.pageId, "handover");
    await switchStarted(page.pageId);
    expect(await importOnce(page)).toMatchObject({ breakers: 3, breakersOnOpenWork: 1 });
    await setModeDirect(testDb.pool, page.pageId, "handover");
    expect(await importOnce(page)).toMatchObject({ breakers: 0, breakersOnOpenWork: 0 });
    const second = (await importedBreakers(page.pageId)).filter((row) => row.failure_count === 4);
    expect(second.map((row) => [row.resource, row.breaker_until?.getTime()])).toEqual([
      ["dm-messages.catchup", secondUntil.getTime()],
      ["dm-messages.head", secondUntil.getTime()],
    ]);
    const history = await openRow(page.pageId, "dm-messages.history", chat.groupId);
    expect([history.failure_count, history.breaker_until?.getTime()]).toEqual([4, secondUntil.getTime()]);
    // The next demand of each other key inherits the newest legacy breaker.
    for (const [resource, workClass] of [["dm-messages.head", "urgent"], ["dm-messages.catchup", "planned"]] as const) {
      await upsertDemand(db(), { pageId: page.pageId, shadow: false, resource, subject: chat.groupId, kind: "trigger", class: workClass });
      const open = await openRow(page.pageId, resource, chat.groupId);
      expect([open.failure_count, open.breaker_until?.getTime()]).toEqual([4, secondUntil.getTime()]);
    }
  }, 60_000);

  it("a carrier merges the key's newest closed row: a newer breaker is imported, a weaker one never lowers it", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-breaker-row");
    const key = { pageId: page.pageId, resource: "dm-messages.head", subject: "chat-1", kind: "trigger" as const, class: "urgent" as const };
    const now = Date.now();
    const hours = (n: number) => now + n * 3_600_000;
    const legacy = (failureCount: number, endsIn: number): ImportWorkBreakerInput =>
      ({ ...key, failureCount, breakerUntil: new Date(hours(endsIn)), lastErrorClass: "legacy:vendor_500" });
    const carriers = async () => (await keyRows(page.pageId, key.resource, key.subject))
      .filter((row) => row.close_reason === "legacy_import")
      .map(breakerOf);

    // An older import is the key's newest closed row: the same breaker again
    // is nothing new, a newer one is imported.
    expect(await importWorkBreaker(db(), legacy(2, 1))).toEqual({ target: "carrier", raised: true });
    expect(await importWorkBreaker(db(), legacy(2, 1))).toEqual({ target: "carrier", raised: false });
    expect(await importWorkBreaker(db(), legacy(4, 6))).toEqual({ target: "carrier", raised: true });
    expect(await carriers()).toEqual([
      { failureCount: 2, breakerUntil: hours(1), blockedByVendorAt: null, lastErrorClass: "legacy:vendor_500" },
      { failureCount: 4, breakerUntil: hours(6), blockedByVendorAt: null, lastErrorClass: "legacy:vendor_500" },
    ]);

    // The engine's own work of the key, blocked by the vendor, then closed by
    // a rollback: a weaker legacy breaker adds nothing; a later end is
    // imported with the work's failures and its block.
    const work = await upsertDemand(db(), { ...key, shadow: false });
    const blockedAt = (await testDb.pool.query<{ at: Date }>(
      `update sync_work set failure_count = 5, blocked_by_vendor_at = clock_timestamp(), last_error_class = 'subject_failure'
        where id = $1 returning blocked_by_vendor_at as at`,
      [work.id],
    )).rows[0]!.at;
    await cancelLiveWorkForRollback(db(), { pageId: page.pageId, closeReason: "rolled_back" });
    expect(await importWorkBreaker(db(), legacy(3, 2))).toEqual({ target: "carrier", raised: false });
    expect(await importWorkBreaker(db(), legacy(3, 12))).toEqual({ target: "carrier", raised: true });
    const newest = { failureCount: 5, breakerUntil: hours(12), blockedByVendorAt: blockedAt.getTime(), lastErrorClass: "legacy:vendor_500" };
    expect((await carriers()).at(-1)).toEqual(newest);
    // The key's next work inherits it.
    await upsertDemand(db(), { ...key, shadow: false });
    expect(breakerOf(await openRow(page.pageId, key.resource, key.subject))).toEqual(newest);
  }, 60_000);
});

/** A gate a transaction waits on before its commit. */
function gate(): { open: () => void; passed: Promise<void> } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => { open = resolve; });
  return { open, passed };
}

describe("the breaker import fence: a handover receipt and the import never interleave", () => {
  /** The import's merge of the chat's head breaker, as `importLegacyState`
   *  runs it: under the fence, `within` before the commit. */
  function fencedImport(page: HarnessPage, chat: FakeChat, until: Date, within?: () => Promise<void>) {
    return db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await lockBreakerImportFence(tx, { pageId: page.pageId, side: "import" });
      const result = await importWorkBreaker(tx, {
        pageId: page.pageId, resource: "dm-messages.head", subject: chat.groupId, kind: "trigger", class: "urgent",
        failureCount: 2, breakerUntil: until, lastErrorClass: "legacy:vendor_500",
      });
      await within?.();
      return result;
    });
  }

  async function chatPage(label: string): Promise<{ page: HarnessPage; chat: FakeChat; until: Date }> {
    const page = await handoverPage(label);
    const chat = new FakeChats().add({ count: 1, ageMs: 3_600_000 });
    await seedChatThread(handles(), page.pageId, chat);
    return { page, chat, until: new Date(Date.now() + 3_600_000) };
  }

  it("a receipt in flight: the import waits for its commit and merges into the work it opened", async (context) => {
    if (!testDb) return context.skip();
    const { page, chat, until } = await chatPage("fence-receipt-first");
    const routed = gate();
    const commit = gate();
    try {
      const receiptTx = receipt(page, chat, async () => { routed.open(); await commit.passed; });
      await routed.passed;
      const importTx = fencedImport(page, chat, until);
      await waitForRowLockWait(testDb.pool, ["%pg_advisory_xact_lock(%"], { blocked: importTx });
      commit.open();
      await receiptTx;
      expect(await importTx).toEqual({ target: "open_work", raised: true });
    } finally {
      commit.open();
    }
    expect(breakerOf(await openRow(page.pageId, "dm-messages.head", chat.groupId)))
      .toMatchObject({ failureCount: 2, breakerUntil: until.getTime() });
  }, 60_000);

  it("an import in flight: the receipt waits for its commit and its new work inherits the breaker", async (context) => {
    if (!testDb) return context.skip();
    const { page, chat, until } = await chatPage("fence-import-first");
    const imported = gate();
    const commit = gate();
    try {
      const importTx = fencedImport(page, chat, until, async () => { imported.open(); await commit.passed; });
      await imported.passed;
      const receiptTx = receipt(page, chat);
      await waitForRowLockWait(testDb.pool, ["%pg_advisory_xact_lock_shared(%"], { blocked: receiptTx });
      commit.open();
      expect(await importTx).toEqual({ target: "carrier", raised: true });
      await receiptTx;
    } finally {
      commit.open();
    }
    expect(breakerOf(await openRow(page.pageId, "dm-messages.head", chat.groupId)))
      .toMatchObject({ failureCount: 2, breakerUntil: until.getTime() });
  }, 60_000);

  it("a live page's receipt never waits for the fence", async (context) => {
    if (!testDb) return context.skip();
    const { page, chat } = await chatPage("fence-live");
    await setModeDirect(testDb.pool, page.pageId, "live");
    const held = gate();
    const commit = gate();
    try {
      const fence = db().transaction(async (raw) => {
        await lockBreakerImportFence(raw as unknown as Database, { pageId: page.pageId, side: "import" });
        held.open();
        await commit.passed;
      });
      await held.passed;
      await receipt(page, chat);
      expect(await openRow(page.pageId, "dm-messages.head", chat.groupId)).toMatchObject({ state: "open" });
      commit.open();
      await fence;
    } finally {
      commit.open();
    }
  }, 60_000);
});
