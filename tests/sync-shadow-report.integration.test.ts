import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { insertAuditEvent, insertObservation, listSyncPages, type Database } from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import { buildSyncReportCommandGroup } from "../apps/runtime/src/sync/cli/report.ts";
import type { EngineRegistry, ReplayContext, ReplayObservation, ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { buildShadowReport, type ShadowReport } from "../apps/runtime/src/sync/report/shadow-report.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, wsCreated, wsMessage, wsTransaction, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { setModeDirect } from "./helpers/sync-engine-host.ts";

// `pnpm cli sync shadow report` (design §3.12) over a fixture: part A in its
// read-only window transaction (demand vs the computed expectation, the legacy
// volume, socket frame → shadow admission vs the legacy arrival, the pacer),
// part B's replay mechanics (newest first, since / at least N, a failing or
// writing replay costs only its own verdict) and the chain and ETA scans.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

const OWN = "100000000000000001";
const FAN = "200000000000000001";
const GROUP = "300000000000000001";
const TX = "777000000000000001";
const MINUTE = 60_000;
/** Legacy listed the fixture's chats long before any frame of the window. */
const LISTED_BEFORE = () => new Date(Date.now() - 24 * 3_600_000);
const logger = createLogger("silent");

function db(): Database {
  return testDb!.db as unknown as Database;
}

function ctx() {
  return { db: db(), logger };
}

async function shadowPage(): Promise<WsCapturePage> {
  const page = await seedWsCapturePage({ db: db(), pool: testDb!.pool }, { ownRef: OWN, label: "lilly-1" });
  await setModeDirect(testDb!.pool, page.pageId, "shadow");
  await seedWsThread({ db: db(), pool: testDb!.pool }, { pageId: page.pageId, groupId: GROUP, fanRef: FAN, firstSeenAt: LISTED_BEFORE() });
  return page;
}

async function shadowAttempt(pageId: number, input: { resource: string; workClass: string; subject?: string; at: Date }): Promise<void> {
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, operation, request, outcome, apply_state)
     values ($1, true, $2, $3, $4, 1, 2000, 0, 2000, $5, $5::timestamptz + interval '50 milliseconds', 'shadow', 'x', '{}'::jsonb, 'shadow', 'skipped')`,
    [pageId, input.resource, input.subject ?? "", input.workClass, input.at],
  );
}

/** The live hour of the fixture: [start, start + 1 h), one hour ago. */
async function seedWindow(page: WsCapturePage, start: Date): Promise<void> {
  const at = (ms: number) => new Date(start.getTime() + ms);
  // Two notification polls (period 30 min: 2 expected in the hour).
  await shadowAttempt(page.pageId, { resource: "notifications.forward", workClass: "planned", at: at(10 * MINUTE) });
  await shadowAttempt(page.pageId, { resource: "notifications.forward", workClass: "planned", at: at(40 * MINUTE) });
  // A fan message on the socket, read 6 s later.
  const message = wsMessage({ groupId: GROUP, senderId: FAN });
  await page.capture(wsCreated(message), at(12 * MINUTE));
  await shadowAttempt(page.pageId, { resource: "dm-messages.head", workClass: "urgent", subject: GROUP, at: at(12 * MINUTE + 6_000) });
  // A new ledger row on the socket, read 3 s later; legacy stored it 30 min later.
  await page.capture(wsTransaction(TX, 1), at(20 * MINUTE));
  await shadowAttempt(page.pageId, { resource: "transactions.head", workClass: "urgent", at: at(20 * MINUTE + 3_000) });
  await testDb!.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
                               gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, created_at)
     values ($1, $2, '2110', 'tip', 'posted', '1', 0, 0, 0, $3, 'fansly:rest', $3::timestamptz + interval '30 minutes')`,
    [page.pageId, TX, at(20 * MINUTE)],
  );
  // A backlog walk.
  for (let i = 0; i < 3; i += 1) {
    await shadowAttempt(page.pageId, { resource: "media-stats.walk", workClass: "planned", at: at((45 + i) * MINUTE) });
  }
  // The legacy engine's socket hints of the hour.
  for (let i = 0; i < 4; i += 1) {
    await testDb!.pool.query(
      `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                                    captured_at, sent_at)
       values ($1, $2, 'ws_hint', 'messages.page', 'worker-1', 1, 'worker', $3, $4, $4)`,
      [page.pageId, randomUUID(), randomUUID(), at((5 + i) * MINUTE)],
    );
  }
}

describe("the shadow report (design §3.12)", () => {
  it("part A: demand vs its expectation, the legacy volume, the live-path decisions and the pacer, in one read-only snapshot", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    await seedWindow(page, start);
    const at = (ms: number) => new Date(start.getTime() + ms);
    // A fan message in a chat excluded from message sync: no key reads it.
    const excluded = "300000000000000009";
    await seedWsThread({ db: db(), pool: testDb.pool }, {
      pageId: page.pageId, groupId: excluded, fanRef: "200000000000000009", excluded: true, firstSeenAt: LISTED_BEFORE(),
    });
    await page.capture(wsCreated(wsMessage({ groupId: excluded, senderId: "200000000000000009" })), at(30 * MINUTE));
    // A message the chain confirmed by a capture before its frame: no key reads it.
    const confirmed = "300000000000000008";
    await seedWsThread({ db: db(), pool: testDb.pool }, {
      pageId: page.pageId, groupId: confirmed, fanRef: "200000000000000008", firstSeenAt: LISTED_BEFORE(),
      headConfirmedId: "400000000000000002", headConfirmedAt: at(34 * MINUTE),
    });
    await page.capture(
      wsCreated(wsMessage({ id: "400000000000000001", groupId: confirmed, senderId: "200000000000000008" })),
      at(35 * MINUTE),
    );
    // A new fan's first message: legacy lists the chat 2 min after the frame,
    // so the router did not know it then and the shadow finds the chat 4 s later.
    const fresh = "300000000000000007";
    await page.capture(wsCreated(wsMessage({ groupId: fresh, senderId: "200000000000000007" })), at(25 * MINUTE));
    await seedWsThread({ db: db(), pool: testDb.pool }, {
      pageId: page.pageId, groupId: fresh, fanRef: "200000000000000007", firstSeenAt: at(27 * MINUTE),
    });
    await shadowAttempt(page.pageId, { resource: "dm-conversations.find", workClass: "urgent", subject: fresh, at: at(25 * MINUTE + 4_000) });
    const report = await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()),
      registry: createStubRegistry(),
      window: { start, end: new Date(start.getTime() + 3_600_000) },
      journal: null,
      maxListed: 50,
    });
    const window = report.window!;
    const demand = window.demand[0]!;
    const row = (resource: string) => demand.resources.find((entry) => entry.resource === resource);
    expect(row("notifications.forward")).toMatchObject({ observed: 2, expected: 2, verdict: "ok" });
    expect(row("dm-messages.head")).toMatchObject({ class: "urgent", observed: 1, expected: 1, verdict: "ok" });
    expect(row("transactions.head")).toMatchObject({ observed: 1, expected: 1, verdict: "ok" });
    // The new chat's frame implies finding the chat, not reading its head.
    expect(row("dm-conversations.find")).toMatchObject({ class: "urgent", observed: 1, expected: 1, verdict: "ok" });
    // A 30-minute poll that never ran is listed with its reason.
    expect(row("dm-conversations.head")).toMatchObject({ observed: 0, expected: 2, verdict: "outside" });
    expect(demand.walks).toContainEqual({ resource: "media-stats.walk", observed: 3, oneTimeBacklog: true });
    expect(demand.attempts).toEqual({ urgent: 3, requests: 0, planned: 5 });
    expect(demand.steadyState).toBe(5);
    expect(demand.inBand).toBe(false);

    expect(window.livePath.fanMessages).toMatchObject({
      frames: 2,
      notRead: 2,
      notReadReasons: { excluded_chat: 1, confirmed_before_frame: 1 },
      shadowAdmissionLagMs: { p50: 4_000, p95: 6_000 },
      withoutShadowAdmission: 0,
      withoutLegacyArrival: 2,
      meetsTarget: true,
    });
    expect(window.livePath.transactions).toMatchObject({
      frames: 1,
      shadowAdmissionLagMs: { p50: 3_000, p95: 3_000 },
      legacyArrivalLagMs: { p50: 30 * MINUTE, p95: 30 * MINUTE },
      meetsTarget: true,
    });
    // Too few frames in the hour: the routing decisions of the day before are replayed offline.
    expect(window.livePath.offline).toMatchObject({ receipts: 0, byResource: [] });

    const hints = window.legacy.find((entry) => entry.ref === "sender:ws_hint")!;
    expect(hints).toMatchObject({ basis: "window", legacy: 4, explained: true });
    expect(hints.shadowKeys).toEqual(expect.arrayContaining(["dm-messages.head"]));

    expect(window.pacer).toMatchObject({ violations: 0, pages: [{ page: "lilly-1", sends: 8, violations: 0 }] });
    expect(window.verdict).toMatchObject({ a1: false, a3: true, a4: true });
    expect(report.verdict.accepted).toBe(false);
    expect(report.summary.at(-1)).toContain("not accepted");
  });

  it("part B: replays newest first since a date and at least N per kind; a failing or writing replay costs only its verdict", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const now = Date.now();
    const observe = async (verdict: string, receivedAt: Date) => {
      const payload = { verdict };
      await insertObservation(db(), {
        source: "pull",
        producer: "test",
        platform: "fansly",
        accountId: page.pageId,
        nativeAccountRef: OWN,
        kind: "account_me",
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `test:${randomUUID()}`,
        receivedAt,
      });
    };
    for (const [i, verdict] of ["match", "match", "mismatch", "write", "match"].entries()) {
      await observe(verdict, new Date(now - (30 + i) * MINUTE));
    }
    for (const [i, verdict] of ["throw", "match", "match"].entries()) {
      await observe(verdict, new Date(now - (180 + i) * MINUTE));
    }
    const report = await buildShadowReport(ctx(), {
      pages: await listSyncPages(db()),
      registry: createStubRegistry(),
      window: null,
      journal: {
        replaySince: new Date(now - 2 * 3_600_000),
        replayMinPerKind: 7,
        replayMaxPerKind: 1_000,
        chainsSince: new Date(now - 24 * 3_600_000),
        pacing: { batchRows: 3, sleepMs: 0, maxDurationMs: null, forceWindow: true },
        expectedCounterexampleRawIds: [],
      },
      maxListed: 10,
    });
    const journal = report.journal!;
    const accountMe = journal.replay.find((row) => row.kind === "account_me")!;
    // 5 since the date + 2 older to reach 7; the oldest observation is left out.
    expect(accountMe).toMatchObject({ resource: "account.poll", total: 7, matched: 4, mismatched: 3, notReplayable: 0, meetsTarget: false });
    expect(accountMe.mismatches.map((row) => row.reason).sort()).toEqual(["differs", "replay_failed:25006", "replay_failed:Error"]);
    expect(accountMe.mismatches.every((row) => row.page === "lilly-1")).toBe(true);
    // Kinds without a single observation are listed as such.
    expect(journal.replay.find((row) => row.kind === "dm_messages")).toMatchObject({ total: 0, notReplayableReasons: { no_observation: 1 } });

    expect(journal.chains).toEqual([expect.objectContaining({ page: "lilly-1" })]);
    const chain = journal.chains[0]!;
    expect("error" in chain.rebuild ? chain.rebuild.error : chain.rebuild.scan.completed).toBe(true);
    expect("error" in chain.endRule ? chain.endRule.error : chain.endRule.emptyPageSoundness.hits).toEqual([]);
    expect(journal.septemberSixteen).toEqual({ expected: [], listed: [], missing: [] });
    expect(journal.eta).toHaveLength(1);
    expect(report.verdict).toMatchObject({ a1: null, b5: false, b6: true, b7: true, accepted: false });
  });

  it("part B: a kind with observations of which none was judged fails B5; legacy's own refusals leave the ratio", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const now = Date.now();
    const observe = async (kind: string, verdict: string, minutesAgo: number) => {
      const payload = { verdict, nonce: randomUUID() };
      await insertObservation(db(), {
        source: "pull",
        producer: "test",
        platform: "fansly",
        accountId: page.pageId,
        nativeAccountRef: OWN,
        kind,
        payload,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
        idempotencyKey: `test:${randomUUID()}`,
        receivedAt: new Date(now - minutesAgo * MINUTE),
      });
    };
    const report = async () => buildShadowReport(ctx(), {
      pages: await listSyncPages(db()),
      registry: createStubRegistry(),
      window: null,
      journal: {
        replaySince: new Date(now - 2 * 3_600_000),
        replayMinPerKind: 1,
        replayMaxPerKind: 1_000,
        chainsSince: new Date(now - 24 * 3_600_000),
        pacing: { batchRows: 10, sleepMs: 0, maxDurationMs: null, forceWindow: true },
        expectedCounterexampleRawIds: [],
      },
      maxListed: 10,
    });
    // Three matches and one body legacy itself refused: 3 / 3.
    for (const [i, verdict] of ["match", "match", "skip:legacy_refused_body_trimmed", "match"].entries()) {
      await observe("account_me", verdict, 10 + i);
    }
    const passing = await report();
    expect(passing.journal!.replay.find((row) => row.kind === "account_me")).toMatchObject({
      total: 4, matched: 3, mismatched: 0, notReplayable: 1, excused: 1, ratio: 1, meetsTarget: true,
    });
    expect(passing.verdict).toMatchObject({ b5: true, b6: true, b7: true });

    // A kind whose every observation was not judged (here: no page identity)
    // is no pass, whatever the other kinds say.
    await observe("followers", "skip:page_account_unknown", 5);
    await observe("followers", "skip:page_account_unknown", 6);
    const failing = await report();
    expect(failing.journal!.replay.find((row) => row.kind === "followers")).toMatchObject({
      total: 2, matched: 0, notReplayable: 2, excused: 0, ratio: 0, meetsTarget: false,
      notReplayableReasons: { page_account_unknown: 2 },
    });
    expect(failing.verdict).toMatchObject({ b5: false, accepted: false });
    expect(failing.summary).toContainEqual(expect.stringMatching(/below 99\.9 %: followers 0\.00 %/));
    expect(failing.summary).toContainEqual(
      "B5 not replayable: account_me legacy_refused_body_trimmed 1 (legacy refusal, left out); followers page_account_unknown 2",
    );

    // Not judged counts as not matched: 3 matches of 4 observations.
    await observe("account_me", "skip:body_unavailable", 1);
    const partial = (await report()).journal!.replay.find((row) => row.kind === "account_me");
    expect(partial).toMatchObject({ total: 5, matched: 3, excused: 1, ratio: 0.75, meetsTarget: false });
  });

  it("the CLI: `sync shadow report --part a` and `sync alerts ack`", async (context) => {
    if (!testDb) return context.skip();
    const page = await shadowPage();
    const start = new Date(Math.floor((Date.now() - 2 * 3_600_000) / MINUTE) * MINUTE);
    await seedWindow(page, start);
    const printed: string[] = [];
    const written: Array<{ path: string; text: string }> = [];
    const command = () => buildSyncReportCommandGroup({
      openContext: async () => ({ ...ctx(), close: async () => undefined }),
      print: (line) => void printed.push(line),
      writeFile: async (path, text) => void written.push({ path, text }),
      now: () => new Date(),
    });
    await command().parseAsync([
      "shadow", "report", "--part", "a", "--window", `${start.toISOString()}/${new Date(start.getTime() + 3_600_000).toISOString()}`,
      "--out", "/tmp/shadow-report.json",
    ], { from: "user" });
    const report = JSON.parse(printed.at(-1)!) as ShadowReport;
    expect(report.verdict).toMatchObject({ a4: true, b5: null });
    expect(written).toEqual([{ path: "/tmp/shadow-report.json", text: `${printed.at(-1)}\n` }]);

    await command().parseAsync(["alerts", "ack", "--page", "lilly-1", "--note", "looked"], { from: "user" });
    expect(printed.at(-1)).toMatch(/^lilly-1: pace latch was not open at /);
    await expect(command().parseAsync(["shadow", "report", "--part", "a"], { from: "user" })).rejects.toThrow(/--window/);
  });
});

/** Every key replays by the fixture payload's `verdict` (`skip:<reason>`: not replayable). */
function createStubRegistry(): Pick<EngineRegistry, "module"> {
  const module = {
    async replay(observation: ReplayObservation, replayCtx: ReplayContext) {
      const verdict = (observation.payload as { verdict?: string } | null)?.verdict;
      if (verdict === "throw") throw new Error("boom");
      if (verdict === "write") await insertAuditEvent(replayCtx.db, { source: "test", eventType: "test.replay_write" });
      if (verdict?.startsWith("skip:") === true) return { kind: "not_replayable" as const, reason: verdict.slice("skip:".length) };
      return verdict === "match" ? { kind: "match" as const } : { kind: "mismatch" as const, reason: "differs" };
    },
  } as unknown as ResourceModule;
  return { module: async () => module };
}
