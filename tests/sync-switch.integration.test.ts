import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureFanslyPageSendGuard,
  completeFanslySendAttempt,
  getSyncPage,
  insertAgentKey,
  insertAuditEvent,
  listCombinedFanslySendsForPaceAudit,
  type Database,
} from "@agency_hub_core/db";

import { updatePageCredentials } from "../apps/runtime/src/services/connections.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { HistoryRequestsUnavailableError, submitHistoryRequest } from "../apps/runtime/src/sync/requests/history.ts";
import { SYNC_ROLLBACK_AUDIT_EVENT } from "../apps/runtime/src/sync/switch/audit.ts";
import { SwitchRefusedError } from "../apps/runtime/src/sync/switch/context.ts";
import { checkSwitchPreconditions } from "../apps/runtime/src/sync/switch/preconditions.ts";
import { runSyncSwitch, runSyncSwitchOpenRequests } from "../apps/runtime/src/sync/switch/switch.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  harnessConfig,
  harnessHostOptions,
  harnessRng,
  harnessRoutes,
  seedChatThread,
  until,
  type FakeArrival,
  type HarnessPage,
} from "./helpers/sync-engine.ts";
import {
  acceptedShadowReport,
  beatSync,
  LEGACY_PATH,
  legacyRoute,
  LegacySender,
  seedSwitchPage,
  switchContext,
  switchRegistry,
  testCapability,
} from "./helpers/sync-switch.ts";

// `pnpm cli sync switch` (design step 3 §3.5 item 7, J1–J4): a shadow page
// becomes the engine's, against the S2-14 harness — the production host, page
// transport and pacer, the fake origin behind the counting page proxy — with a
// stand-in legacy sender that takes the real step-1 guard for every request.
// Pinned at the origin: no legacy request after the guard flipped, the
// engine's first request ≥ 1.2 × S after the legacy one, 0 pairs closer than
// S over both journals; the flip waits for a legacy request in flight and
// never takes a closed guard; a phase that times out puts the page back in
// shadow with the guard back; a switch killed after any phase ends in the
// same place when run again; the first page opens its requests an hour
// later, a later page converts its hydration rows at once; a pre-switch
// unconfirmed overlay row gets its head read; a rollback stopped half way is
// never resumed as a switch.

const S = 300;

let testDb: StartedTestDatabase | null = null;
let server: FakeFanslyServer | null = null;
let proxy: CountingConnectProxy | null = null;
const hosts: SyncEngineHost[] = [];
const senders: LegacySender[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (!testDb) return;
  await resetIntegrationDatabase(testDb.pool);
  await ensureHarnessSettingTable(testDb.pool, S);
});

afterEach(async () => {
  await Promise.all(senders.splice(0).map((sender) => sender.stop()));
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)));
  await server?.close();
  await proxy?.close();
  server = null;
  proxy = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

interface Rig {
  server: FakeFanslyServer;
  chats: FakeChats;
  config: ReturnType<typeof harnessConfig>;
  report: string;
  lines: string[];
}

async function rig(labels: readonly string[]): Promise<Rig & { pages: HarnessPage[] }> {
  server = await FakeFanslyServer.start();
  proxy = await CountingConnectProxy.start();
  const chats = new FakeChats();
  server.route(legacyRoute());
  for (const route of harnessRoutes(chats)) server.route(route);
  const pages: HarnessPage[] = [];
  for (const [index, label] of labels.entries()) {
    // Each page its own account (the origin's /account/me answers the first's).
    pages.push(await seedSwitchPage(handles(), {
      label,
      proxyUrl: proxy.url,
      ...(index === 0 ? {} : { ownRef: `30000000000000000${index + 1}` }),
    }));
  }
  return {
    server,
    chats,
    pages,
    config: harnessConfig(testDb!.connectionString, server.apiBaseUrl),
    report: acceptedShadowReport(labels),
    lines: [],
  };
}

async function startHost(r: Rig, seed: number): Promise<SyncEngineHost> {
  const host = new SyncEngineHost(harnessHostOptions({
    db: db(),
    pool: testDb!.pool,
    connectionString: testDb!.connectionString,
    config: r.config,
    rng: harnessRng(seed),
    registry: switchRegistry(),
  }));
  hosts.push(host);
  await host.start();
  return host;
}

async function shadowRunning(host: SyncEngineHost, pageId: number): Promise<void> {
  await until(async () => host.state(pageId).kind === "running", 15_000, "the shadow owner");
}

function legacySender(r: Rig, pageId: number): LegacySender {
  const sender = new LegacySender({ db: db(), config: r.config }, pageId, `${r.server.origin}${LEGACY_PATH}`, () => S).start();
  senders.push(sender);
  return sender;
}

function ctx(r: Rig, overrides: Parameters<typeof switchContext>[1] = {}) {
  return switchContext({ db: db(), config: r.config, report: r.report, lines: r.lines }, overrides);
}

function switchOf(r: Rig, label: string, overrides: Parameters<typeof switchContext>[1] = {}) {
  return runSyncSwitch(ctx(r, overrides), {
    pageLabel: label,
    shadowReportPath: "/tmp/shadow-report.json",
    dryRun: false,
    registry: switchRegistry(),
    capabilityFor: testCapability("test switch"),
  });
}

async function phases(pageId: number): Promise<string[]> {
  const result = await testDb!.pool.query<{ phase: string }>(
    "select metadata ->> 'phase' as phase from audit_events where event_type = 'admin.sync_switch' and platform_account_id = $1 order by id",
    [pageId],
  );
  return result.rows.map((row) => row.phase);
}

async function guardOf(pageId: number) {
  return (await testDb!.pool.query<{ owner_engine: string; engine_switched_at: Date | null; last_completed_at: Date; holder_token: string | null }>(
    "select owner_engine, engine_switched_at, last_completed_at, holder_token from fansly_page_send_guards where page_id = $1",
    [pageId],
  )).rows[0]!;
}

function gaps(arrivals: readonly FakeArrival[]): number[] {
  return arrivals.slice(1).map((arrival, index) => arrival.mono - arrivals[index]!.mono);
}

describe("sync switch", () => {
  it("(a) runs A → B → R → I → C: no legacy request after the flip, the engine's first ≥ 1.2 × S after the legacy one, 0 pairs closer than S", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-a"]);
    const page = r.pages[0]!;
    const host = await startHost(r, 11);
    await shadowRunning(host, page.pageId);
    const startedAt = new Date();
    const legacy = legacySender(r, page.pageId);
    await until(async () => legacy.sent >= 3, 15_000, "legacy sends");

    const outcome = await switchOf(r, page.pageLabel);
    expect(outcome).toEqual({ exitCode: 0, phase: "done", page: page.pageLabel });
    expect(await phases(page.pageId)).toEqual([
      "start", "A_handover", "A_guard_handed", "B_stopped", "R_rebuilt", "I_imported", "C_live", "C_owner", "C_requests", "done",
    ]);

    // The engine's reads go out once the takeover verify passed.
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 2, 20_000, "engine reads");
    await until(async () => legacy.refused >= 1, 5_000, "a refused legacy capture");
    const guard = await guardOf(page.pageId);
    expect(guard.owner_engine).toBe("fansly_sync_engine");
    expect((await testDb.pool.query(
      "select count(*)::int as n from fansly_send_log where page_id = $1 and captured_at > $2", [page.pageId, guard.engine_switched_at],
    )).rows[0].n).toBe(0);

    // At the origin: every legacy request before the engine's first, ≥ 1.2 × S apart.
    const legacyArrivals = r.server.arrivalsAt(LEGACY_PATH);
    const engineArrivals = r.server.arrivals.filter((arrival) => !arrival.path.startsWith(LEGACY_PATH));
    expect(engineArrivals[0]!.path.split("?")[0]).toBe("/api/v1/account/me");
    expect(legacyArrivals.at(-1)!.mono).toBeLessThan(engineArrivals[0]!.mono);
    expect(engineArrivals[0]!.mono - legacyArrivals.at(-1)!.mono).toBeGreaterThanOrEqual(1.2 * S);
    expect(gaps(r.server.arrivals).filter((gap) => gap < S)).toEqual([]);
    const combined = await listCombinedFanslySendsForPaceAudit(db(), { pageId: page.pageId, since: startedAt });
    expect(combined.some((send) => send.journal === "legacy:sync_stream")).toBe(true);
    expect(combined.some((send) => send.journal === "engine")).toBe(true);
    expect(combined.filter((send) => send.violation)).toEqual([]);

    const row = (await getSyncPage(db(), page.pageId))!;
    expect(row.mode).toBe("live");
    expect(row.legacyImportedAt).not.toBeNull();
    // The first page ever switched: requests open an hour after C.
    expect(row.requestsEnabledAt!.getTime() - row.dbNow.getTime()).toBeGreaterThan(55 * 60_000);
    // The takeover verify proved the stored session (G1).
    await until(async () => (await getSyncPage(db(), page.pageId))!.credentialsGeneration !== null, 10_000, "the verified generation");
    expect(legacy.failure).toBeNull();
  }, 120_000);

  it("(b) the flip waits for a legacy request in flight", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-b"]);
    const page = r.pages[0]!;
    const host = await startHost(r, 12);
    await shadowRunning(host, page.pageId);
    const token = randomUUID();
    const captured = await captureFanslyPageSendGuard(db(), {
      pageId: page.pageId, token, source: "sync_stream", operation: "messages",
      holder: { host: "legacy-worker", pid: 7, pidStart: null, pidNs: null, bootId: null, instance: randomUUID(), role: "worker" },
      settingMs: S, leaseMs: 60_000, captureWaitMs: 0, captureRefusals: 0,
    });
    expect(captured.kind).toBe("captured");
    const switching = switchOf(r, page.pageLabel);
    await sleep(800);
    expect((await guardOf(page.pageId)).owner_engine).toBe("legacy");
    const completed = await completeFanslySendAttempt(db(), {
      pageId: page.pageId, token, nextU: 0, outcome: "response", outcomeDetail: null, httpStatus: 200, sentAt: new Date(), sendOffsetMs: 0,
    });
    expect(completed.released).toBe(true);
    expect(await switching).toMatchObject({ exitCode: 0, phase: "done" });
    const guard = await guardOf(page.pageId);
    expect(guard.owner_engine).toBe("fansly_sync_engine");
    expect(guard.engine_switched_at!.getTime()).toBeGreaterThanOrEqual(guard.last_completed_at.getTime());
  }, 120_000);

  for (const [name, kind] of [
    ["(c) a guard closed by an overrun lease", "closed"],
    ["(h) a legacy request that never completes", "held"],
  ] as const) it(`${name}: the switch never flips it and goes back to shadow (exit 2)`, async (context) => {
    if (!testDb) return context.skip();
    const r = await rig([`switch-${kind}`]);
    const page = r.pages[0]!;
    const host = await startHost(r, 13);
    await shadowRunning(host, page.pageId);
    const captured = await captureFanslyPageSendGuard(db(), {
      pageId: page.pageId, token: randomUUID(), source: "sync_stream", operation: "messages",
      holder: { host: "gone", pid: 7, pidStart: null, pidNs: null, bootId: null, instance: randomUUID(), role: "worker" },
      settingMs: S, leaseMs: 60_000, captureWaitMs: 0, captureRefusals: 0,
    });
    expect(captured.kind).toBe("captured");
    const switching = switchOf(r, page.pageLabel);
    if (kind === "closed") {
      // During A the holder overruns its lease and nobody confirms it gone
      // (the step-1 sweeper closes the row).
      await sleep(300);
      await testDb.pool.query(
        `update fansly_page_send_guards set lease_until = clock_timestamp() - interval '1 second',
                closed_reason = 'lease_expired_unconfirmed', closed_at = clock_timestamp()
          where page_id = $1`,
        [page.pageId],
      );
    }
    const outcome = await switching;
    expect(outcome).toMatchObject({ exitCode: 2, phase: "reverted" });
    expect((await guardOf(page.pageId)).owner_engine).toBe("legacy");
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("shadow");
    expect(await phases(page.pageId)).toEqual(["start", "A_handover", "reverting", "reverted"]);
    expect(r.lines.some((line) => line.includes(kind === "closed" ? "confirm-terminated" : "holds the guard"))).toBe(true);
    // Nothing reached the origin from the engine.
    expect(r.server.arrivals).toEqual([]);
    if (kind === "closed") {
      // A guard that is closed already refuses the switch before A.
      r.lines.length = 0;
      await expect(switchOf(r, page.pageLabel)).rejects.toBeInstanceOf(SwitchRefusedError);
      expect(r.lines).toContainEqual(expect.stringMatching(/^FAIL guard_row: owner legacy, closed \(lease_expired_unconfirmed\): fansly-send-guard confirm-terminated/));
    }
  }, 60_000);

  it("(d) B times out on an open legacy run: the guard goes back, the hook's live work is cancelled, legacy resumes", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-d"]);
    const page = r.pages[0]!;
    const host = await startHost(r, 14);
    await shadowRunning(host, page.pageId);
    await testDb.pool.query(
      "insert into sync_runs (page_id, stream, outcome, started_at) values ($1, 'dm_messages', 'running', clock_timestamp())",
      [page.pageId],
    );
    const outcome = await switchOf(r, page.pageLabel, {
      // A WS receipt routed during handover leaves live demand behind.
      print: (line) => {
        r.lines.push(line);
        if (line.startsWith("A ") && line.includes("send guard handed")) {
          void testDb!.pool.query(
            `insert into sync_work (page_id, shadow, resource, subject, kind, class) values ($1, false, 'transactions.head', '', 'trigger', 'urgent')`,
            [page.pageId],
          );
        }
      },
    });
    expect(outcome).toMatchObject({ exitCode: 2, phase: "reverted" });
    expect(r.lines.some((line) => line.includes("open_runs=1"))).toBe(true);
    expect((await guardOf(page.pageId)).owner_engine).toBe("legacy");
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("shadow");
    const work = await testDb.pool.query<{ state: string; close_reason: string }>(
      "select state, close_reason from sync_work where page_id = $1 and not shadow", [page.pageId],
    );
    expect(work.rows).toEqual([{ state: "cancelled", close_reason: "switch_reverted" }]);
    expect(await phases(page.pageId)).toEqual(["start", "A_handover", "A_guard_handed", "reverting", "reverted"]);
    // The legacy engine sends again, ≥ 1.2 × S after the hand-back.
    const legacy = legacySender(r, page.pageId);
    await until(async () => legacy.sent >= 1, 10_000, "a legacy send after the revert");
  }, 60_000);

  it("(e) a switch killed after each phase and run again ends in the same place, the import not doubled", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-e"]);
    const page = r.pages[0]!;
    const chat = r.chats.add({ count: 3, ageMs: 3_600_000 });
    const threadId = await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages.slice(0, 2) });
    // Legacy state the import carries: a chat breaker and a head debt.
    await testDb.pool.query(
      `insert into page_dm_message_sync_health (conversation_id, platform_account_id, failure_count, error_class, last_error,
              last_attempt_at, next_retry_at, quarantine_until)
       values ($1, $2, 7, 'vendor_500', 'HTTP 500', clock_timestamp() - interval '1 day', clock_timestamp() + interval '1 hour', null)`,
      [threadId, page.pageId],
    );
    await testDb.pool.query(
      "insert into fansly_dm_head_debt (conversation_id, message_id, message_at) values ($1, $2, now())",
      [threadId, chat.messages[2]!.id],
    );
    const host = await startHost(r, 15);
    await shadowRunning(host, page.pageId);

    for (const killAt of ["A ", "B ", "R ", "I ", "C "]) {
      let killed = false;
      await switchOf(r, page.pageLabel, {
        print: (line) => {
          r.lines.push(line);
          if (!killed && line.startsWith(killAt)) {
            killed = true;
            throw new Error(`killed after ${killAt.trim()}`);
          }
        },
      }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith("killed")) throw error;
      });
      expect(killed).toBe(true);
    }
    expect(await switchOf(r, page.pageLabel)).toMatchObject({ exitCode: 0, phase: "done" });
    const row = (await getSyncPage(db(), page.pageId))!;
    expect(row.mode).toBe("live");
    expect((await guardOf(page.pageId)).owner_engine).toBe("fansly_sync_engine");
    // One closed breaker row per DM key, one catch-up, one takeover verify.
    const work = await testDb.pool.query<{ resource: string; state: string; failure_count: number; close_reason: string | null }>(
      `select resource, state, failure_count, close_reason from sync_work
        where page_id = $1 and not shadow and resource like 'dm-messages.%' order by resource, id`,
      [page.pageId],
    );
    expect(work.rows.filter((entry) => entry.close_reason === "legacy_import")).toEqual([
      { resource: "dm-messages.catchup", state: "cancelled", failure_count: 5, close_reason: "legacy_import" },
      { resource: "dm-messages.head", state: "cancelled", failure_count: 5, close_reason: "legacy_import" },
      { resource: "dm-messages.history", state: "cancelled", failure_count: 5, close_reason: "legacy_import" },
    ]);
    expect(work.rows.filter((entry) => entry.resource === "dm-messages.catchup" && entry.close_reason !== "legacy_import")).toHaveLength(1);
    expect((await testDb.pool.query(
      "select count(*)::int as n from sync_work where page_id = $1 and not shadow and resource = 'account.verify'", [page.pageId],
    )).rows[0].n).toBe(1);
    // The legacy breaker rows are untouched (J5).
    expect((await testDb.pool.query(
      "select failure_count from page_dm_message_sync_health where conversation_id = $1", [threadId],
    )).rows[0].failure_count).toBe(7);
  }, 180_000);

  it("(g) the first page opens its requests an hour later; a later page converts its hydration requests at once", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-g1", "switch-g2"]);
    const [first, second] = r.pages as [HarnessPage, HarnessPage];
    const key = await insertAgentKey(testDb.db, {
      name: "switch", keyPrefix: "agency_hub_agent_switch", keyDigest: "d".repeat(64),
      capabilities: ["read:messages", "request:hydration"], pageIds: [first.pageId, second.pageId],
      dailyRequestBudget: 5000, dailyRowBudget: 500_000, expiresAt: new Date(Date.now() + 86_400_000), createdBy: null,
    });
    const hydration = async (pageId: number, groupId: string) => (await testDb!.pool.query<{ id: string; request_ref: string }>(
      `insert into agent_hydration_requests (request_ref, agent_key_id, page_id, conversation_ref, state, target_before_message_ref,
              reason_sha256, reason_length, idempotency_key, request_fingerprint, coverage_fingerprint, admissible, expires_at)
       values (gen_random_uuid(), $1, $2, $3, 'requested', '999999999999999999', $4, 10, gen_random_uuid(), $4, $4, true,
               now() + interval '1 day')
       returning id::text as id, request_ref::text as request_ref`,
      [key.id, pageId, groupId, "a".repeat(64)],
    )).rows[0]!;
    const host = await startHost(r, 16);
    await shadowRunning(host, first.pageId);
    await shadowRunning(host, second.pageId);

    expect(await switchOf(r, first.pageLabel)).toMatchObject({ exitCode: 0 });
    const late = await hydration(first.pageId, "777000000000000001");
    // Intake refuses until the hour passed.
    await expect(submitHistoryRequest({ db: db(), rawConfig: r.config }, {
      pageId: first.pageId, requester: { kind: "owner_cli", userId: null },
      fans: [{ kind: "conversation", conversationRef: "777000000000000001" }], depth: { kind: "all" },
      reason: "control", idempotencyKey: randomUUID(),
    })).rejects.toBeInstanceOf(HistoryRequestsUnavailableError);
    await expect(runSyncSwitchOpenRequests(ctx(r), { pageLabel: first.pageLabel })).rejects.toBeInstanceOf(SwitchRefusedError);
    await testDb.pool.query("update sync_pages set requests_enabled_at = clock_timestamp() - interval '1 second' where page_id = $1", [first.pageId]);
    expect(await runSyncSwitchOpenRequests(ctx(r), { pageLabel: first.pageLabel })).toMatchObject({ exitCode: 0, phase: "H_converted:1" });
    // Run again: nothing more to convert, the same history request.
    expect(await runSyncSwitchOpenRequests(ctx(r), { pageLabel: first.pageLabel })).toMatchObject({ phase: "H_converted:0" });

    const earlier = await hydration(second.pageId, "777000000000000002");
    await beatSync(testDb.pool, "0123456789abcdef0123456789abcdef01234567");
    r.report = acceptedShadowReport(["switch-g2"]);
    expect(await switchOf(r, second.pageLabel)).toMatchObject({ exitCode: 0, phase: "done" });
    const secondRow = (await getSyncPage(db(), second.pageId))!;
    expect(secondRow.requestsEnabledAt!.getTime()).toBeLessThanOrEqual(secondRow.dbNow.getTime());

    for (const legacyRow of [late, earlier]) {
      const state = await testDb.pool.query<{ state: string }>("select state from agent_hydration_requests where id = $1", [legacyRow.id]);
      expect(state.rows[0]!.state).toBe("expired");
      const event = await testDb.pool.query<{ detail: { cause: string; ref: string } }>(
        "select detail from agent_hydration_events where request_id = $1 and kind = 'expired'", [legacyRow.id],
      );
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0]!.detail.cause).toBe("converted_to_history_request");
      const history = await testDb.pool.query<{ requester_kind: string; depth_kind: string }>(
        "select requester_kind, depth_kind from history_requests where request_ref = $1::uuid", [event.rows[0]!.detail.ref],
      );
      expect(history.rows).toEqual([{ requester_kind: "switch_migration", depth_kind: "before_boundary" }]);
    }
  }, 180_000);

  it("(i) a fan message the legacy engine had not confirmed before A gets one urgent head read after C", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-i"]);
    const page = r.pages[0]!;
    const chat = r.chats.add({ count: 4, ageMs: 600_000 });
    await seedChatThread(handles(), page.pageId, chat, { stored: chat.messages.slice(0, 2) });
    const unconfirmed = chat.messages[3]!;
    await testDb.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
              is_sent_by_page, created_at, content, field_mask, decoder_version, first_visible_at, confirm_due_at)
       values ($1, $2, $3, $4, false, to_timestamp($5::double precision / 1000), 'hi', 1, 1, now() - interval '10 minutes', now())`,
      [page.pageId, unconfirmed.id, chat.groupId, unconfirmed.senderId, unconfirmed.createdAtMs],
    );
    const host = await startHost(r, 17);
    await shadowRunning(host, page.pageId);
    expect(await switchOf(r, page.pageLabel)).toMatchObject({ exitCode: 0 });
    const head = await testDb.pool.query<{ demand: { messageIds: string[]; reasons: string[] } }>(
      "select demand from sync_work where page_id = $1 and not shadow and resource = 'dm-messages.head' and subject = $2",
      [page.pageId, chat.groupId],
    );
    expect(head.rows).toHaveLength(1);
    expect(head.rows[0]!.demand.reasons).toContain("takeover_unconfirmed");
    expect(head.rows[0]!.demand.messageIds).toEqual([unconfirmed.id]);
    await until(async () => r.server.arrivals.some((arrival) => arrival.path.includes(`groupId=${chat.groupId}`)), 20_000, "the head read");
    await until(async () => (await testDb!.pool.query(
      "select confirmed_at from dm_live_messages where page_id = $1 and platform_message_id = $2", [page.pageId, unconfirmed.id],
    )).rows[0].confirmed_at !== null, 20_000, "the overlay confirmation");
  }, 120_000);

  it("(j) refuses a page a rollback left in handover; dry-runs every precondition", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-j"]);
    const page = r.pages[0]!;

    // The dry run lists every check and changes nothing; an unknown build and
    // a settling hydration request refuse.
    const dry = await runSyncSwitch(ctx(r), {
      pageLabel: page.pageLabel, shadowReportPath: "/tmp/r.json", dryRun: true, registry: switchRegistry(), capabilityFor: testCapability("dry"),
    });
    // No shadow owner beats yet (no host): `page_shadow` fails.
    expect(dry.exitCode).toBe(1);
    expect(r.lines.filter((line) => line.startsWith("FAIL")).map((line) => line.split(":")[0])).toEqual(["FAIL page_shadow"]);
    await beatSync(testDb.pool, null);
    const unknown = await checkSwitchPreconditions(ctx(r), { page: (await getSyncPage(db(), page.pageId))!, shadowReportPath: "/tmp/r.json" });
    expect(unknown.checks.find((check) => check.name === "build_identity")).toMatchObject({ ok: false });
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("shadow");

    await testDb.pool.query("update sync_pages set mode = 'handover' where page_id = $1", [page.pageId]);
    await insertAuditEvent(db(), {
      platformAccountId: page.pageId, source: "cli", eventType: SYNC_ROLLBACK_AUDIT_EVENT,
      metadata: { step: "2_released", pageId: page.pageId, actor: "test" },
    });
    await expect(switchOf(r, page.pageLabel)).rejects.toThrow(/a rollback stopped at step 2_released; a switch never resumes it/);
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("handover");
  }, 60_000);

  it("(k) a legacy 429 hold and a legacy auth block are both carried: nothing goes out before the 429 ends, the owner's renewal lifts only the auth hold", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-k"]);
    const page = r.pages[0]!;
    const host = await startHost(r, 19);
    await shadowRunning(host, page.pageId);
    // The legacy engine is waiting out a 429 and has a stream blocked on its credentials.
    await testDb.pool.query(
      `insert into page_sync_states (page_id, stream, status, blocker_kind, blocker_code, blocked_at, cadence_seconds, slot_offset_seconds)
       values ($1, 'light', 'idle', 'auth', 'http_401', clock_timestamp(), 300, 0)
       on conflict (page_id, stream) do update set blocker_kind = 'auth'`,
      [page.pageId],
    );
    const legacyUntil = (await testDb.pool.query<{ until: Date }>(
      `insert into page_sync_provider_holds (page_id, hold_until, reason, stream, armed_at)
       values ($1, clock_timestamp() + interval '10 seconds', 'rate_limited', 'light', clock_timestamp())
       returning hold_until as until`,
      [page.pageId],
    )).rows[0]!.until;

    expect(await switchOf(r, page.pageLabel)).toMatchObject({ exitCode: 0, phase: "done" });
    const held = (await getSyncPage(db(), page.pageId))!;
    expect(held.holdKind).toBe("auth");
    expect(held.holdDetail.timedHold).toMatchObject({ kind: "rate_limit", until: legacyUntil.toISOString() });

    // The owner renews the credentials at once: the identity check (the only
    // work an auth hold lets through) waits for the 429's end.
    const app = createTestAppContext(testDb, { fanslySendGuardSettingMs: S });
    const renewed = await updatePageCredentials(app, page.pageLabel, {
      platform: "fansly",
      session: { authorization: "fresh-token", fanslyClientId: "client-id", fanslyClientCheck: "client-check", fanslySessionId: "session-id" },
    });
    expect(renewed).toMatchObject({ updated: true, verified: true });
    const engineArrivals = r.server.arrivals.filter((arrival) => !arrival.path.startsWith(LEGACY_PATH));
    expect(engineArrivals[0]!.path.split("?")[0]).toBe("/api/v1/account/me");
    // The 429 hold's end is the database's instant; the origin's clock is this
    // process's (a small skew allowed — without the carried hold the check
    // went out seconds earlier).
    expect(engineArrivals[0]!.wallMs).toBeGreaterThanOrEqual(legacyUntil.getTime() - 250);
    // The renewal lifted the auth hold: the engine's reads go out.
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 20_000, "engine reads after the renewal");
    expect(gaps(r.server.arrivals).filter((gap) => gap < S)).toEqual([]);
  }, 120_000);

  it("B waits while the page's socket lock is held by a legacy receiver", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig(["switch-ws"]);
    const page = r.pages[0]!;
    const host = await startHost(r, 18);
    await shadowRunning(host, page.pageId);
    const receiver = new Client({ connectionString: testDb.connectionString });
    clients.push(receiver);
    await receiver.connect();
    await receiver.query("select pg_advisory_lock(58213, $1::int)", [page.pageId]);
    const switching = switchOf(r, page.pageLabel);
    await sleep(1_200);
    expect((await getSyncPage(db(), page.pageId))!.mode).toBe("handover");
    expect((await getSyncPage(db(), page.pageId))!.legacyImportedAt).toBeNull();
    await receiver.query("select pg_advisory_unlock(58213, $1::int)", [page.pageId]);
    expect(await switching).toMatchObject({ exitCode: 0, phase: "done" });
  }, 60_000);
});
