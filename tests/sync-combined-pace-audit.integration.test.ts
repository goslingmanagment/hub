import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensureSyncPage,
  getNotificationIncidentByKey,
  listCombinedFanslySendsForPaceAudit,
  type Database,
} from "@agency_hub_core/db";

import { SYNC_ENGINE_PACE_VIOLATION_SUBKEY, syncEngineIncidentKey } from "../apps/runtime/src/services/notification-incidents.ts";
import { SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { checkSwitchAcceptance } from "../apps/runtime/src/sync/switch/acceptance.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { quietLogger, setModeDirect } from "./helpers/sync-engine-host.ts";

// The combined pace audit (design step 3 §3.5 item 2, G4, E12): the engine
// audits `sync_attempts`, the legacy monitor `fansly_send_log` — a pair of
// sends straddling the handover is in neither. One statement reads both
// journals in send order; the engine's alert evaluator latches a violation of
// a `handover`/`live` page from it, and the switch's acceptance check reports
// it.

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

/** A legacy send `secondsAgo` before now (DB clock). */
async function legacySend(pageId: number, secondsAgo: number): Promise<void> {
  await testDb!.pool.query(
    `insert into fansly_send_log (page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                                  setting_ms, captured_at, sent_at, completed_at, outcome)
     values ($1, $2, 'sync_stream', 'messages', 'worker-1', 1, 'worker', $3, $4,
             clock_timestamp() - make_interval(secs => $5::double precision + 0.05),
             clock_timestamp() - make_interval(secs => $5::double precision),
             clock_timestamp() - make_interval(secs => $5::double precision - 0.2), 'response')`,
    [pageId, randomUUID(), randomUUID(), S, secondsAgo],
  );
}

/** A live engine send `secondsAgo` before now. */
async function engineSend(pageId: number, secondsAgo: number): Promise<void> {
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, operation, request, outcome)
     values ($1, false, 'transactions.head', '', 'urgent', 1, $2, 0, $2,
             clock_timestamp() - make_interval(secs => $3::double precision + 0.1),
             clock_timestamp() - make_interval(secs => $3::double precision),
             'request_start', 'transactions.page', '{}'::jsonb, 'response')`,
    [pageId, S, secondsAgo],
  );
}

describe("the combined pace audit", () => {
  it("finds the cross-journal pair 1.9 s apart at S = 2 s, and only it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("audit-page");
    const since = new Date(Date.now() - 60_000);
    await legacySend(pageId, 30);
    await legacySend(pageId, 27.5);
    // The handover: the engine's first send 1.9 s after the legacy last one.
    await engineSend(pageId, 25.6);
    await engineSend(pageId, 23);

    const sends = await listCombinedFanslySendsForPaceAudit(db(), { pageId, since });
    expect(sends.map((send) => send.journal)).toEqual(["legacy:sync_stream", "legacy:sync_stream", "engine", "engine"]);
    const violations = sends.filter((send) => send.violation);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ journal: "engine", prevJournal: "legacy:sync_stream", settingMs: S });
    expect(violations[0]!.gapMs).toBeGreaterThan(1_850);
    expect(violations[0]!.gapMs).toBeLessThan(1_950);
    // The window's first send keeps its predecessor from the 10-minute look-back.
    const tail = await listCombinedFanslySendsForPaceAudit(db(), { pageId, since: new Date(Date.now() - 26_000) });
    expect(tail[0]).toMatchObject({ journal: "engine", prevJournal: "legacy:sync_stream", violation: true });

    const acceptance = await checkSwitchAcceptance(db(), { pageIds: [pageId], since });
    const page = acceptance.pages[0]!;
    expect(page.checks.find((check) => check.name === "pace_combined")).toMatchObject({
      verdict: "fail", detail: { violations: 1, pairs: 3 },
    });
    expect(page.verdict).toBe("fail");
    expect(acceptance.accepted).toBe(false);
  });

  it("latches the pace alert of a live page from a cross-journal pair; a shadow page's pair pages nobody", async (context) => {
    if (!testDb) return context.skip();
    const live = await seedPage("audit-live");
    const shadow = await seedPage("audit-shadow");
    await setModeDirect(testDb.pool, live, "live");
    await setModeDirect(testDb.pool, shadow, "shadow");
    for (const pageId of [live, shadow]) {
      await legacySend(pageId, 20);
      await engineSend(pageId, 18.5);
    }
    const evaluator = new SyncAlertEvaluator({ db: db(), logger: quietLogger, registry: createFanslyRegistry() });
    const result = await evaluator.runOnce();
    expect(result?.paceViolations).toBe(1);
    const latch = await getNotificationIncidentByKey(db(), syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId: live }));
    expect(latch?.status).toBe("open");
    expect(latch?.errorSummary).toContain("legacy:sync_stream");
    expect(await getNotificationIncidentByKey(db(), syncEngineIncidentKey({ subKey: SYNC_ENGINE_PACE_VIOLATION_SUBKEY, pageId: shadow })))
      .toBeNull();
  });
});
