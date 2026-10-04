import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureSyncPage,
  getNotificationIncidentByKey,
  readFanslySendAudit,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";

import { SYNC_ENGINE_PACE_VIOLATION_SUBKEY, syncEngineIncidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";
import { createPacer, type Admission, type Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { systemClock } from "../apps/runtime/src/sync/engine/ports.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { auditPagePace, auditRouteIntervals } from "../apps/runtime/src/sync/engine/send-audit.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import type { FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { checkSwitchAcceptance } from "../apps/runtime/src/sync/switch/acceptance.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { currentIntervals } from "./helpers/sync-acceptance-fixtures.ts";
import {
  makeTestActor,
  pollsRequest,
  quietLogger,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  setModeDirect,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The send audit on recorded rows (I1, I19; arena 3b-review G1): one read of
// both journals (`readFanslySendAudit`) judged by one checker — the alert
// evaluator latches what it finds on a `handover`/`live` page (the permanent
// pace latch), `sync switch check` reports it. I1 by each send's own recorded
// pause, I19 by each admission's recorded route and family intervals; a pair
// straddling the handover is in neither engine's own audit and is in this
// one; a history without the recorded intervals pages nobody and passes no
// acceptance; one owner's recorded sends are judged beside its pacer's own
// gap; a send whose instant was never recorded is judged at its admission and
// counted at its upper bound, never dropped.

const S = 2_000;

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

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function seedPage(label: string): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

/** A page live since 10 minutes ago, so its acceptance window holds the
 *  sends of the last minutes. */
async function livePage(label: string): Promise<number> {
  const pageId = await seedPage(label);
  await setModeDirect(testDb!.pool, pageId, "live");
  await testDb!.pool.query("update sync_pages set mode_changed_at = clock_timestamp() - interval '10 minutes' where page_id = $1", [pageId]);
  return pageId;
}

function evaluator(): SyncAlertEvaluator {
  return new SyncAlertEvaluator({ db: db(), logger: quietLogger, registry: createFanslyRegistry() });
}

async function paceLatch(pageId: number) {
  return getNotificationIncidentByKey(db(), syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId }));
}

/** A legacy send `secondsAgo` before now (DB clock), with its guard's pause. */
async function legacySend(pageId: number, secondsAgo: number): Promise<void> {
  await testDb!.pool.query(
    `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                                  setting_ms, jitter_u, pause_ms, captured_at, sent_at, completed_at, outcome)
     values ($1, $2, 'sync_stream', 'messages', 'worker-1', 1, 'worker', $3, $4, 0, $4,
             clock_timestamp() - make_interval(secs => $5::double precision + 0.05),
             clock_timestamp() - make_interval(secs => $5::double precision),
             clock_timestamp() - make_interval(secs => $5::double precision - 0.2), 'response')`,
    [pageId, randomUUID(), randomUUID(), S, secondsAgo],
  );
}

interface EngineSend {
  secondsAgo: number;
  operation: FanslyRoute;
  generation?: number;
  settingMs?: number;
  pauseMs?: number;
  gapPrevMs?: number | null;
  /** Default: what an admission records at the table's rates; null: an
   *  attempt admitted before 0237. */
  routeIntervalMs?: number | null;
  familyIntervalMs?: number | null;
  /** `unknown`: admitted `secondsAgo` before now, its send never marked. */
  outcome?: "response" | "unknown";
}

/** A live engine attempt as the actor journals it. */
async function engineSend(pageId: number, input: EngineSend): Promise<void> {
  const intervals = currentIntervals(input.operation);
  const unknown = input.outcome === "unknown";
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, gap_prev_ms, operation, request, outcome,
                                route_interval_ms, family_interval_ms)
     values ($1, false, 'test.resource', '', 'urgent', $2, $3, 0, $4,
             clock_timestamp() - make_interval(secs => $5::double precision + case when $6::boolean then 0 else 0.1 end),
             case when $6::boolean then null else clock_timestamp() - make_interval(secs => $5::double precision) end,
             case when $6::boolean then null else 'request_start' end, $7, $8, '{}'::jsonb, $9, $10, $11)`,
    [
      pageId, input.generation ?? 1, input.settingMs ?? S, input.pauseMs ?? input.settingMs ?? S, input.secondsAgo, unknown,
      input.gapPrevMs ?? null, input.operation, unknown ? "unknown" : "response",
      input.routeIntervalMs === undefined ? intervals.routeIntervalMs : input.routeIntervalMs,
      input.familyIntervalMs === undefined ? intervals.familyIntervalMs : input.familyIntervalMs,
    ],
  );
}

/** The arena's I19 counterexample: 15 sends 2.8 s apart on a 4 s route,
 *  each ≥ the page's pause. */
async function routeBurst(pageId: number, fromSecondsAgo: number, extra: Partial<EngineSend> = {}): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    await engineSend(pageId, { secondsAgo: fromSecondsAgo - i * 2.8, operation: "notifications.page", settingMs: 2_500, pauseMs: 2_500, ...extra });
  }
}

describe("the send audit on recorded rows", () => {
  it("reads both journals in send order and finds the cross-journal pair 1.9 s apart at S = 2 s, and only it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("audit-page");
    const since = new Date(Date.now() - 60_000);
    await legacySend(pageId, 30);
    await legacySend(pageId, 27.5);
    // The handover: the engine's first send 1.9 s after the legacy last one.
    await engineSend(pageId, { secondsAgo: 25.6, operation: "notifications.page" });
    await engineSend(pageId, { secondsAgo: 23, operation: "transactions.page" });

    const rows = await readFanslySendAudit(db(), { pageId, since });
    expect(rows.map((row) => [row.journal, row.source, row.pauseMs])).toEqual(expect.arrayContaining([
      ["legacy", "sync_stream", S], ["engine", null, S],
    ]));
    const pace = auditPagePace(rows, { start: since, until: null });
    expect(pace).toMatchObject({ verdict: "fail", pairs: 3, inconclusive: [] });
    expect(pace.violations).toEqual([expect.objectContaining({ journal: "engine", prevJournal: "legacy:sync_stream", clock: "wall", pauseMs: S })]);
    expect(pace.violations[0]!.gapMs).toBeGreaterThan(1_850);
    expect(pace.violations[0]!.gapMs).toBeLessThan(1_950);
    // The window's first send keeps its predecessor from the look-back.
    const tailSince = new Date(Date.now() - 26_000);
    const tail = auditPagePace(await readFanslySendAudit(db(), { pageId, since: tailSince }), { start: tailSince, until: null });
    expect(tail.violations).toEqual([expect.objectContaining({ journal: "engine", prevJournal: "legacy:sync_stream" })]);

    const acceptance = await checkSwitchAcceptance(db(), { pageIds: [pageId], since });
    const page = acceptance.pages[0]!;
    expect(page.checks.find((check) => check.name === "pace_combined")).toMatchObject({
      verdict: "fail", detail: { violations: 1, pairs: 3, inconclusive: 0 },
    });
    expect(page.verdict).toBe("fail");
    expect(acceptance.accepted).toBe(false);
  });

  it("the evaluator latches I1 by the send's own pause and I19 by its recorded interval; a shadow page pages nobody", async (context) => {
    if (!testDb) return context.skip();
    const live = await livePage("audit-live");
    const shadow = await seedPage("audit-shadow");
    await setModeDirect(testDb.pool, shadow, "shadow");
    for (const pageId of [live, shadow]) {
      // S = 2 500, u = 0.1: the pause is 2 750, the gap 2 600 — over the setting, short of the pause.
      await engineSend(pageId, { secondsAgo: 120, operation: "media.offer_stats", settingMs: 2_500, pauseMs: 2_750 });
      await engineSend(pageId, { secondsAgo: 117.4, operation: "transactions.page", settingMs: 2_500, pauseMs: 2_750, generation: 2 });
      await routeBurst(pageId, 60);
    }
    const result = await evaluator().runOnce();
    expect(result).toMatchObject({ paceViolations: 1, routeIntervalViolations: 14, inconclusivePairs: 0 });
    const latch = await paceLatch(live);
    expect(latch).toMatchObject({ status: "open" });
    expect(latch?.errorSummary).toContain("notifications.page");
    expect(latch?.errorSummary).toContain("\"intervalMs\":4000");
    expect(await paceLatch(shadow)).toBeNull();

    // The same rows through the acceptance: both checks fail, by the same audit.
    const since = new Date(Date.now() - 180_000);
    const page = (await checkSwitchAcceptance(db(), { pageIds: [live], since })).pages[0]!;
    expect(page.checks.find((check) => check.name === "pace_combined")).toMatchObject({
      verdict: "fail", detail: { violations: 1, firstViolations: [expect.objectContaining({ pauseMs: 2_750, clock: "wall" })] },
    });
    expect(page.checks.find((check) => check.name === "route_budgets")).toMatchObject({
      verdict: "fail", detail: { violations: 14, pairs: 14, inconclusive: 0 },
    });
  });

  it("a history admitted before the intervals were recorded pages nobody and passes no acceptance", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage("audit-before");
    await routeBurst(pageId, 60, { routeIntervalMs: null, familyIntervalMs: null });
    const result = await evaluator().runOnce();
    expect(result).toMatchObject({ paceViolations: 0, routeIntervalViolations: 0, inconclusivePairs: 14 });
    expect(await paceLatch(pageId)).toBeNull();
    const page = (await checkSwitchAcceptance(db(), { pageIds: [pageId], since: new Date(Date.now() - 120_000) })).pages[0]!;
    expect(page.checks.find((check) => check.name === "route_budgets")).toMatchObject({
      verdict: "inconclusive", detail: { violations: 0, pairs: 0, inconclusive: 14 },
    });
    expect(page.checks.find((check) => check.name === "pace_combined")).toMatchObject({ verdict: "pass" });
  });

  it("latches an interval below its ceiling's whatever the gaps, and counts an unknown outcome at its upper bound", async (context) => {
    if (!testDb) return context.skip();
    const ceiling = await livePage("audit-ceiling");
    const unknown = await livePage("audit-unknown");
    // 3.5 s apart under a recorded 3 500 ms: every pair keeps it, but the
    // route's ceiling (15/min) is 4 000 ms.
    for (const secondsAgo of [60, 56.5, 53]) {
      await engineSend(ceiling, { secondsAgo, operation: "notifications.page", routeIntervalMs: 3_500 });
    }
    // Admitted 60 s ago and never marked: it counts at its admission + 15 s,
    // so a send of its route 2 s after that is too close.
    await engineSend(unknown, { secondsAgo: 70, operation: "notifications.page" });
    await engineSend(unknown, { secondsAgo: 60, operation: "notifications.page", outcome: "unknown" });
    await engineSend(unknown, { secondsAgo: 43, operation: "notifications.page" });
    const rows = await readFanslySendAudit(db(), { pageId: unknown, since: new Date(Date.now() - 120_000) });
    expect(rows.filter((row) => row.sentAt === null).map((row) => row.countedAt !== null)).toEqual([true]);
    const audited = auditRouteIntervals(rows, { start: new Date(Date.now() - 120_000), until: null });
    expect(audited.violations).toEqual([expect.objectContaining({ kind: "route", scope: "notifications.page", intervalMs: 4_000 })]);
    expect(audited.violations[0]!.gapMs).toBeGreaterThan(1_900);
    expect(audited.violations[0]!.gapMs).toBeLessThan(2_100);

    const result = await evaluator().runOnce();
    expect(result).toMatchObject({ paceViolations: 0, routeIntervalViolations: 3 + 1 });
    expect(await paceLatch(ceiling)).toMatchObject({ status: "open", errorCode: "route_interval_below_ceiling" });
    expect(await paceLatch(unknown)).toMatchObject({ status: "open", errorCode: "route_interval_violation" });
  });

  it("judges one owner's recorded sends beside its pacer's own gap: closer than the setting latches, two clocks that disagree page nobody and pass nothing", async (context) => {
    if (!testDb) return context.skip();
    const stale = await livePage("audit-stale");
    const disagree = await livePage("audit-disagree");
    // One generation, each send recording a monotonic gap of exactly its pause
    // (the pacer refuses a send on that same number, so it never records less).
    const own = { settingMs: 2_500, pauseMs: 2_750, gapPrevMs: 2_750 };
    // The recorded sends 1 s apart: closer than the setting itself.
    await engineSend(stale, { secondsAgo: 120, operation: "media.offer_stats", ...own, gapPrevMs: null });
    await engineSend(stale, { secondsAgo: 119, operation: "transactions.page", ...own });
    // The recorded sends 2.6 s apart: over the setting, short of the pause the pacer says it kept.
    await engineSend(disagree, { secondsAgo: 120, operation: "media.offer_stats", ...own, gapPrevMs: null });
    await engineSend(disagree, { secondsAgo: 117.4, operation: "transactions.page", ...own });

    const result = await evaluator().runOnce();
    expect(result).toMatchObject({ paceViolations: 1, routeIntervalViolations: 0, inconclusivePairs: 1 });
    const latch = await paceLatch(stale);
    expect(latch).toMatchObject({ status: "open", errorCode: "pace_violation" });
    expect(latch?.errorSummary).toContain("\"clock\":\"wall\"");
    expect(latch?.errorSummary).toContain("\"pauseMs\":2750");
    expect(await paceLatch(disagree)).toBeNull();

    const since = new Date(Date.now() - 180_000);
    const report = await checkSwitchAcceptance(db(), { pageIds: [stale, disagree], since });
    const paceOf = (pageId: number) => report.pages.find((page) => page.pageId === pageId)!.checks.find((check) => check.name === "pace_combined");
    expect(paceOf(stale)).toMatchObject({ verdict: "fail", detail: { violations: 1, firstViolations: [expect.objectContaining({ clock: "wall", pauseMs: 2_750 })] } });
    expect(paceOf(disagree)).toMatchObject({
      verdict: "inconclusive",
      detail: { pairs: 0, violations: 0, inconclusive: 1, firstInconclusive: [expect.objectContaining({ open: "clocks_disagree", clock: "monotonic", gapMs: 2_750 })] },
    });
    expect(report.accepted).toBe(false);
  });

  it("the capture's own alert judges its send by both clocks: a second pacer under one generation, each honest about its own gap", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const settingMs = 400;
    const busy: ResourceModule = {
      plan: async () => ({ kind: "request", request: pollsRequest }),
      apply: async (_tx, input) => ({ work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] }),
      shadow: async (_work, _request, ctx) => ({ work: { satisfiesRevision: false, nextDueAt: ctx.now }, followups: [] }),
    };
    const registry = testRegistry([testSpec("busy.polls", busy, { kind: "goal", operations: ["polls"] })]);
    await upsertDemand(db(), { pageId, shadow: false, resource: "busy.polls", subject: "", kind: "goal", class: "urgent", demand: { reasons: ["test"] } });
    const transport = new ScriptedLiveTransport();
    const alerts = new RecordingAlerts();
    const metrics = new RecordingMetrics();
    const { actor, deps, stop, abort } = await makeTestActor({ db: db(), pageId, mode: "live", registry, transport, alerts, metrics, settingMs });
    // The bug the monotonic gap cannot see: two pacers pace one page, turn by
    // turn. Each keeps its own pause from ITS previous send and records that
    // gap truthfully; the page's sends are as close as the two interleave.
    const second = createPacer({
      clock: systemClock, rng: { next: () => 0.5 }, pause: { readSettingMs: async () => settingMs }, ownership: deps.ownership, minSettingMs: 1,
    });
    second.initTakeover(0);
    const pacers = [deps.pacer, second];
    let turn = 0;
    const current = () => pacers[turn % 2]!;
    (deps as { pacer: unknown }).pacer = {
      waitForSlot: (signal: AbortSignal) => current().waitForSlot(signal),
      arm: (...args: Parameters<Pacer["arm"]>) => current().arm(...args),
      check: (admission: Admission) => current().check(admission),
      complete: (...args: Parameters<Pacer["complete"]>) => {
        current().complete(...args);
        if (args[0].sentMono !== null) turn += 1;
      },
    };
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(() => (transport.hits.length >= 4 ? true : null), 30_000, "four sends");
    } finally {
      stop.abort();
      await run;
    }

    const journal = (await testDb.pool.query<{ id: string; gap: number | null; pause: number; setting: number; wall: number | null }>(
      `select id::text, gap_prev_ms as gap, pause_ms as pause, setting_ms as setting,
              extract(epoch from sent_at - lag(sent_at) over (order by sent_at, id)) * 1000 as wall
         from sync_attempts where page_id = $1 and sent_at is not null order by sent_at, id limit 4`,
      [pageId],
    )).rows;
    // The fourth send: its pacer's own gap (to the second send) kept the
    // pause; the page's previous recorded send (the third) was moments before.
    const fourth = journal[3]!;
    expect(Number(fourth.gap)).toBeGreaterThanOrEqual(fourth.pause);
    expect(Number(fourth.wall)).toBeLessThan(fourth.setting - 2);
    const paced = alerts.opened.filter((alert) => alert.subKey === "page_stopped" && alert.detail === "pace_violation");
    expect(paced.map((alert) => alert.context?.attemptId)).toEqual(expect.arrayContaining([Number(journal[1]!.id), Number(fourth.id)]));
    expect(metrics.get("sync_pace_violations")).toBeGreaterThanOrEqual(2);

    // The evaluator's audit re-reads the journal by the same rule: the fourth
    // send's pair fails on the recorded clocks, its monotonic gap notwithstanding.
    const since = new Date(Date.now() - 60_000);
    const audit = auditPagePace(await readFanslySendAudit(db(), { pageId, since }), { start: since, until: null });
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: Number(fourth.id), clock: "wall", pauseMs: fourth.pause }),
    ]));
  }, 60_000);

  it("a send whose instant was never recorded is judged at its admission and counted at its upper bound, never dropped", async (context) => {
    if (!testDb) return context.skip();
    const early = await livePage("audit-early");
    const proven = await livePage("audit-proven");
    const floor = await livePage("audit-floor");
    // A kill -9 with a request in flight: the attempt stays without a send
    // instant (`unknown` after the next owner's recovery).
    // Admitted 1 s after the route's last send, on a 4 s route: judged at its
    // upper bound (admission + 15 s) it could fail no interval up to 15 s.
    await engineSend(early, { secondsAgo: 70, operation: "notifications.page" });
    await engineSend(early, { secondsAgo: 69, operation: "notifications.page", outcome: "unknown" });
    // Admitted 10 s after it: whenever it left, the interval and the pause held.
    await engineSend(proven, { secondsAgo: 70, operation: "notifications.page" });
    await engineSend(proven, { secondsAgo: 60, operation: "notifications.page", outcome: "unknown" });
    // The next owner's first send 1 s after the unknown one's upper bound
    // (60 − 15 = 45 s ago): the takeover floor counts it there.
    await engineSend(floor, { secondsAgo: 70, operation: "notifications.page" });
    await engineSend(floor, { secondsAgo: 60, operation: "notifications.page", outcome: "unknown" });
    await engineSend(floor, { secondsAgo: 44, operation: "transactions.page", generation: 2 });

    const since = new Date(Date.now() - 120_000);
    const rows = await readFanslySendAudit(db(), { pageId: early, since });
    const left = rows.find((row) => row.sentAt === null)!;
    expect(left).toMatchObject({ journal: "engine", shadow: false, httpStatus: null, completedAt: null });
    expect(left.countedAt!.getTime() - left.admittedAt.getTime()).toBe(15_000);
    const window = { start: since, until: null };
    const unproven = [expect.objectContaining({ open: "send_not_recorded", judgedAt: "admission" })];
    expect(auditRouteIntervals(rows, window)).toMatchObject({ verdict: "inconclusive", pairs: 0, violations: [], inconclusive: unproven });
    expect(auditPagePace(rows, window)).toMatchObject({ verdict: "inconclusive", pairs: 0, violations: [], inconclusive: unproven });

    // Neither a judged pass nor a page: both pairs are counted as not judged.
    const result = await evaluator().runOnce();
    expect(result).toMatchObject({ paceViolations: 1, routeIntervalViolations: 0, inconclusivePairs: 2 });
    expect(await paceLatch(early)).toBeNull();
    expect(await paceLatch(proven)).toBeNull();
    const floorLatch = await paceLatch(floor);
    expect(floorLatch).toMatchObject({ status: "open", errorCode: "pace_violation" });
    expect(floorLatch?.errorSummary).toContain("\"clock\":\"wall\"");

    const report = await checkSwitchAcceptance(db(), { pageIds: [early, proven, floor], since });
    const checkOf = (pageId: number, name: string) => report.pages.find((page) => page.pageId === pageId)!.checks.find((check) => check.name === name);
    expect(checkOf(early, "route_budgets")).toMatchObject({
      verdict: "inconclusive",
      detail: { pairs: 0, violations: 0, inconclusive: 1, firstInconclusive: [expect.objectContaining({ open: "send_not_recorded", intervalMs: 4_000 })] },
    });
    expect(checkOf(early, "pace_combined")).toMatchObject({ verdict: "inconclusive", detail: { violations: 0, inconclusive: 1 } });
    // The proven pair is a judged pass of both checks — not a pair that vanished.
    expect(checkOf(proven, "route_budgets")).toMatchObject({ verdict: "pass", detail: { pairs: 1, violations: 0, inconclusive: 0 } });
    expect(checkOf(proven, "pace_combined")).toMatchObject({ verdict: "pass", detail: { pairs: 1, violations: 0, inconclusive: 0 } });
    expect(checkOf(floor, "pace_combined")).toMatchObject({ verdict: "fail", detail: { pairs: 2, violations: 1 } });
  });
});
