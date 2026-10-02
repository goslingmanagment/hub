import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cancelLiveWorkForRollback,
  ensureFanslyPageSendGuard,
  getSyncPage,
  handFanslySendGuardBackToLegacy,
  importClosedWorkBreaker,
  insertAuditEvent,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";

import { activePageHold, INDEFINITE_UNTIL } from "../apps/runtime/src/sync/engine/errors.ts";
import { SYNC_SWITCH_AUDIT_EVENT } from "../apps/runtime/src/sync/switch/audit.ts";
import { importLegacyState } from "../apps/runtime/src/sync/switch/import.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { setModeDirect } from "./helpers/sync-engine-host.ts";
import { FakeChats, harnessConfig, seedChatThread, seedHarnessPage, type HarnessPage } from "./helpers/sync-engine.ts";
import { switchContext, switchRegistry, testCapability } from "./helpers/sync-switch.ts";

// The switch's legacy import (design step 3 §3.5 item 7, phase I) against the
// database, without a sender: I.4 carries a legacy 429 hold AND a legacy auth
// block — the auth hold keeps the 429 hold beside itself, never overwrites it,
// and the page stays held until the later of them ends (also into the legacy
// guard if the owner rolls back with `--with-auth-hold`); I.3 imports the
// newest legacy chat breaker on every switch — a switch after a rollback never
// skips a newer one because an earlier switch imported one — and a resumed
// import never doubles it.

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

describe("the switch's legacy import: chat breakers (I.3)", () => {
  it("a switch after a rollback imports the newer legacy breaker; a resumed import never doubles one", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-breakers");
    const chat = new FakeChats().add({ count: 2, ageMs: 3_600_000 });
    const threadId = await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages });
    const firstUntil = (await testDb.pool.query<{ until: Date }>(
      `insert into page_dm_message_sync_health (conversation_id, platform_account_id, failure_count, error_class, last_error,
              last_attempt_at, next_retry_at, quarantine_until)
       values ($1, $2, 2, 'vendor_500', 'HTTP 500', clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 hour', null)
       returning next_retry_at as until`,
      [threadId, page.pageId],
    )).rows[0]!.until;

    // The first switch, its import run twice (resumed): one row per DM key.
    await switchStarted(page.pageId);
    expect((await importOnce(page)).breakers).toBe(3);
    await setModeDirect(testDb.pool, page.pageId, "handover");
    expect((await importOnce(page)).breakers).toBe(0);
    const first = await importedBreakers(page.pageId);
    expect(first.map((row) => [row.resource, row.failure_count, row.breaker_until?.getTime()])).toEqual([
      ["dm-messages.catchup", 2, firstUntil.getTime()],
      ["dm-messages.head", 2, firstUntil.getTime()],
      ["dm-messages.history", 2, firstUntil.getTime()],
    ]);

    // Live: the head key's work inherits the breaker; the rollback closes it.
    // Back on the legacy engine the chat failed again — a newer breaker.
    await upsertDemand(db(), {
      pageId: page.pageId, shadow: false, resource: "dm-messages.head", subject: chat.groupId, kind: "trigger", class: "urgent",
    });
    await cancelLiveWorkForRollback(db(), { pageId: page.pageId, closeReason: "rolled_back" });
    const secondUntil = (await testDb.pool.query<{ until: Date }>(
      `update page_dm_message_sync_health
          set failure_count = 4, last_attempt_at = clock_timestamp() - interval '1 minute',
              next_retry_at = clock_timestamp() + interval '6 hours'
        where conversation_id = $1 returning next_retry_at as until`,
      [threadId],
    )).rows[0]!.until;

    // The second switch carries it onto every key, the head key included.
    await setModeDirect(testDb.pool, page.pageId, "handover");
    await switchStarted(page.pageId);
    expect((await importOnce(page)).breakers).toBe(3);
    const second = (await importedBreakers(page.pageId)).filter((row) => row.failure_count === 4);
    expect(second.map((row) => [row.resource, row.breaker_until?.getTime()])).toEqual([
      ["dm-messages.catchup", secondUntil.getTime()],
      ["dm-messages.head", secondUntil.getTime()],
      ["dm-messages.history", secondUntil.getTime()],
    ]);
    // The next demand of each key inherits the newest legacy breaker.
    for (const [resource, workClass] of [["dm-messages.head", "urgent"], ["dm-messages.catchup", "planned"]] as const) {
      await upsertDemand(db(), { pageId: page.pageId, shadow: false, resource, subject: chat.groupId, kind: "trigger", class: workClass });
    }
    const open = await testDb.pool.query<{ resource: string; failure_count: number; breaker_until: Date }>(
      `select resource, failure_count, breaker_until from sync_work
        where page_id = $1 and not shadow and state = 'open' and resource in ('dm-messages.head', 'dm-messages.catchup')
        order by resource`,
      [page.pageId],
    );
    expect(open.rows.map((row) => [row.resource, row.failure_count, row.breaker_until.getTime()])).toEqual([
      ["dm-messages.catchup", 4, secondUntil.getTime()],
      ["dm-messages.head", 4, secondUntil.getTime()],
    ]);
  }, 60_000);

  it("a newer breaker of the key is imported even when an older import is the key's newest closed row", async (context) => {
    if (!testDb) return context.skip();
    const page = await handoverPage("import-breaker-row");
    const base = { pageId: page.pageId, resource: "dm-messages.history", subject: "chat-1", kind: "goal" as const, class: "requests" as const };
    const earlier = new Date(Date.now() + 3_600_000);
    const later = new Date(Date.now() + 6 * 3_600_000);
    expect(await importClosedWorkBreaker(db(), { ...base, failureCount: 2, breakerUntil: earlier, lastErrorClass: "legacy:vendor_500" })).toBe(true);
    expect(await importClosedWorkBreaker(db(), { ...base, failureCount: 2, breakerUntil: earlier, lastErrorClass: "legacy:vendor_500" })).toBe(false);
    expect(await importClosedWorkBreaker(db(), { ...base, failureCount: 4, breakerUntil: later, lastErrorClass: "legacy:vendor_500" })).toBe(true);
    const created = await upsertDemand(db(), { ...base, shadow: false });
    const work = await testDb.pool.query<{ failure_count: number; breaker_until: Date }>(
      "select failure_count, breaker_until from sync_work where id = $1", [created.id],
    );
    expect(work.rows.map((row) => [row.failure_count, row.breaker_until.getTime()])).toEqual([[4, later.getTime()]]);
  }, 60_000);
});
