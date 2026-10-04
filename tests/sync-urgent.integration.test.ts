import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  getSyncWork,
  setRegistryOverride,
  settleWork,
  type Database,
  type SettleWorkInput,
} from "@agency_hub_core/db";

import {
  createWorkDoneWake,
  enqueueAndWait,
  URGENT_WORK_DONE_APPLICATION_NAME,
  UrgentWorkRefusedError,
  type EnqueueAndWaitResult,
} from "../apps/runtime/src/sync/requests/urgent.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  changedTables,
  countRows,
  quietLogger,
  seedSyncPage,
  tableCounts,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// "Enqueue work and wait" (plan §3, §15 step 2; design §7.3): the API and the
// CLIs put work on the page's queue and wait for the actor instead of calling
// Fansly. A page that is not live answers `not_live` before anything is
// written (every page in step 2); on a live page the waiter is answered by the
// actor's settle — through `fansly_sync_work_done`, or by its 250 ms re-read
// when the NOTIFY is lost — or gives up with the work's status link.

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

function handles() {
  return { db: db(), pool: testDb!.pool };
}

async function livePage(label = "lora-1") {
  return seedSyncPage(handles(), { label, mode: "live", guard: "fansly_sync_engine" });
}

/** The open work row of a key once the call has written it. */
async function openWork(pageId: number, resource: string, revision = 1) {
  return waitFor(async () => {
    const result = await testDb!.pool.query<{ id: string; demand_revision: string }>(
      `select id::text, demand_revision::text from sync_work
        where page_id = $1 and resource = $2 and state in ('open', 'running', 'quarantined')`,
      [pageId, resource],
    );
    const row = result.rows[0];
    return row !== undefined && Number(row.demand_revision) >= revision ? Number(row.id) : null;
  }, 10_000, `the open ${resource} work at revision ${revision}`);
}

/** What the actor's apply commits at the end of a step. */
async function settle(input: Omit<SettleWorkInput, "generation">) {
  await db().transaction(async (tx) => {
    await settleWork(tx as unknown as Database, { generation: 1n, ...input });
  });
}

/** The state of a promise without waiting for it. */
async function peek<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, sleep(300).then(() => "pending" as const)]);
}

describe("enqueue and wait: a page that is not live", () => {
  it("answers not_live on off and shadow pages, switching on a handover page (E10), and writes nothing", async (context) => {
    if (!testDb) return context.skip();
    const pages = [
      await seedSyncPage(handles(), { label: "page-off", mode: "off" }),
      await seedSyncPage(handles(), { label: "page-shadow", mode: "shadow" }),
      await seedSyncPage(handles(), { label: "page-handover", mode: "handover", guard: "fansly_sync_engine" }),
    ];
    const before = await tableCounts(testDb.pool);
    for (const page of pages) {
      for (const resource of ["account.verify", "account.identity", "media-download.fetch"]) {
        const result = await enqueueAndWait({ db: db() }, {
          pageId: page.pageId,
          resource,
          ...(resource === "media-download.fetch" ? { subject: "media-1" } : {}),
          ...(resource === "account.identity" ? { secretParams: "ciphertext" } : {}),
          waitMs: 1_000,
        });
        expect(result, `${page.label} ${resource}`).toEqual({ state: page.label === "page-handover" ? "switching" : "not_live" });
      }
    }
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual([]);
  });

  it("answers not_live on a page the engine has no row for: a Fansly page onboarded since the host started, an OnlyFans page", async (context) => {
    if (!testDb) return context.skip();
    const model = await createModel(db(), { slug: "model-unlisted", name: "unlisted" });
    const fansly = await createFanslyPage(db(), { modelId: model!.id, label: "fansly-unlisted" });
    const onlyFans = await createOnlyFansPage(db(), { modelId: model!.id, label: "of-unlisted" });
    const before = await tableCounts(testDb.pool);
    for (const pageId of [fansly!.id, onlyFans!.id]) {
      expect(await countRows(testDb.pool, "select count(*)::int as n from sync_pages where page_id = $1", [pageId])).toBe(0);
      const result = await enqueueAndWait({ db: db() }, { pageId, resource: "account.verify", waitMs: 1_000 });
      expect(result, `page ${pageId}`).toEqual({ state: "not_live" });
    }
    expect(changedTables(before, await tableCounts(testDb.pool))).toEqual([]);
  });

  it("refuses a key without the api trigger, a bad wait and an unknown page before writing", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await livePage();
    const refusal = async (input: Parameters<typeof enqueueAndWait>[1]) => {
      try {
        await enqueueAndWait({ db: db() }, input);
      } catch (error) {
        if (error instanceof UrgentWorkRefusedError) return error.reason;
        throw error;
      }
      throw new Error("expected a refusal");
    };
    expect(await refusal({ pageId, resource: "transactions.head" })).toBe("not_api_resource");
    expect(await refusal({ pageId, resource: "dm-messages.history", subject: "1" })).toBe("not_api_resource");
    expect(await refusal({ pageId, resource: "account.verify", subject: "1" })).toBe("bad_subject");
    expect(await refusal({ pageId, resource: "media-download.fetch" })).toBe("bad_subject");
    expect(await refusal({ pageId, resource: "account.verify", waitMs: 0 })).toBe("bad_wait");
    expect(await refusal({ pageId, resource: "account.verify", waitMs: 30_001 })).toBe("bad_wait");
    expect(await refusal({ pageId: pageId + 1_000, resource: "account.verify" })).toBe("no_page");
    await setRegistryOverride(db(), { pageId, key: "account.verify", override: { enabled: false } });
    expect(await refusal({ pageId, resource: "account.verify" })).toBe("disabled_for_page");
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_work")).toBe(0);
  });
});

describe("enqueue and wait: a live page", () => {
  it("writes the registry's work and is answered by the actor's settle through NOTIFY", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await livePage();
    const wake = createWorkDoneWake({ connectionString: testDb.connectionString, logger: quietLogger });
    await wake.start();
    try {
      expect(await countRows(testDb.pool,
        "select count(*)::int as n from pg_stat_activity where application_name = $1 and datname = current_database()",
        [URGENT_WORK_DONE_APPLICATION_NAME])).toBe(1);
      const pending = enqueueAndWait({ db: db(), workDone: wake }, {
        pageId,
        resource: "account.verify",
        params: { requestedBy: "test" },
        waitMs: 20_000,
      });
      const workId = await openWork(pageId, "account.verify");
      const row = await getSyncWork(db(), workId);
      expect(row).toMatchObject({
        kind: "trigger",
        class: "urgent",
        subject: "",
        demandRevision: 1,
        appliedRevision: 0,
        params: { requestedBy: "test" },
      });
      // The registry's result SLO (30 s) is the deadline.
      expect(row!.deadlineAt).not.toBeNull();
      expect(row!.deadlineAt!.getTime() - row!.createdAt.getTime()).toBeGreaterThan(25_000);

      const settledAt = Date.now();
      await settle({ workId, servedRevision: 1, satisfiesRevision: true, close: "done", closeReason: "applied", result: { accountId: "own" } });
      const result = await pending;
      expect(result).toEqual({ state: "done", workId, satisfied: true, result: { accountId: "own" }, closeReason: "applied" });
      // Woken by the notification, well before a few re-reads.
      expect(Date.now() - settledAt).toBeLessThan(1_000);
      expect(wake.notifications).toBeGreaterThanOrEqual(1);
    } finally {
      await wake.close();
    }
  }, 30_000);

  it("an older read never answers a newer demand (I11)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await livePage();
    const first = enqueueAndWait({ db: db() }, { pageId, resource: "account.verify", waitMs: 20_000 });
    const workId = await openWork(pageId, "account.verify");
    const second = enqueueAndWait({ db: db() }, { pageId, resource: "account.verify", waitMs: 20_000 });
    expect(await openWork(pageId, "account.verify", 2)).toBe(workId);

    // The step admitted at revision 1 serves the first caller only; the row
    // stays open for the demand that arrived meanwhile.
    await settle({ workId, servedRevision: 1, satisfiesRevision: true, close: "done", closeReason: "applied", result: { n: 1 } });
    expect(await first).toEqual({ state: "done", workId, satisfied: true, result: { n: 1 }, closeReason: null });
    expect(await peek(second)).toBe("pending");
    expect((await getSyncWork(db(), workId))?.state).toBe("open");

    await settle({ workId, servedRevision: 2, satisfiesRevision: true, close: "done", closeReason: "applied", result: { n: 2 } });
    expect(await second).toEqual({ state: "done", workId, satisfied: true, result: { n: 2 }, closeReason: "applied" });
  }, 30_000);

  it("without a NOTIFY the 250 ms re-read still answers", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await livePage();
    const pending = enqueueAndWait({ db: db(), workDone: null }, { pageId, resource: "account.verify", waitMs: 20_000 });
    const workId = await openWork(pageId, "account.verify");
    const settledAt = Date.now();
    await settle({ workId, servedRevision: 1, satisfiesRevision: true, close: "done", closeReason: "applied" });
    expect(await pending).toMatchObject({ state: "done", workId, satisfied: true });
    expect(Date.now() - settledAt).toBeLessThan(1_500);
  }, 30_000);

  it("gives up with the work's status link; quarantined work answers queued at once", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await livePage("lora-7");
    const startedAt = Date.now();
    const queued = await enqueueAndWait({ db: db() }, { pageId, resource: "media-download.fetch", subject: "media-9", waitMs: 400 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    const workId = await openWork(pageId, "media-download.fetch");
    expect(queued).toEqual({ state: "queued", workId, statusUrl: `/api/v1/sync/pages/${label}/work/${workId}` });
    // The registry's class for a media fetch is planned.
    expect((await getSyncWork(db(), workId))?.class).toBe("planned");

    await testDb.pool.query("update sync_work set state = 'quarantined', waiting_reason = 'quarantined' where id = $1", [workId]);
    const quarantinedAt = Date.now();
    const again = await enqueueAndWait({ db: db() }, { pageId, resource: "media-download.fetch", subject: "media-9", waitMs: 20_000 });
    expect(again).toEqual({ state: "queued", workId, statusUrl: `/api/v1/sync/pages/${label}/work/${workId}` });
    expect(Date.now() - quarantinedAt).toBeLessThan(2_000);
    // The demand still merged into the quarantined row (the owner's requeue serves it).
    expect((await getSyncWork(db(), workId))?.demandRevision).toBe(2);
  }, 30_000);

  it("work closed without serving the demand ends the wait unsatisfied", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await livePage();
    const pending = enqueueAndWait({ db: db() }, { pageId, resource: "account.verify", waitMs: 20_000 });
    const workId = await openWork(pageId, "account.verify");
    await testDb.pool.query(
      `update sync_work set state = 'superseded', closed_at = clock_timestamp(), close_reason = 'mode_change'
        where id = $1`,
      [workId],
    );
    const result: EnqueueAndWaitResult = await pending;
    expect(result).toEqual({ state: "done", workId, satisfied: false, result: null, closeReason: "mode_change" });
  }, 30_000);

  it("a candidate's secret parameters ride on a fresh row only and are dropped when it closes", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await livePage();
    const first = await enqueueAndWait({ db: db() }, { pageId, resource: "account.identity", secretParams: "cipher-1", waitMs: 200 });
    expect(first.state).toBe("queued");
    const workId = await openWork(pageId, "account.identity");
    const secretOf = async () => (await testDb!.pool.query<{ secret_params: string | null; demand_revision: string }>(
      "select secret_params, demand_revision::text from sync_work where id = $1", [workId])).rows[0];
    expect(await secretOf()).toEqual({ secret_params: "cipher-1", demand_revision: "1" });

    await expect(enqueueAndWait({ db: db() }, { pageId, resource: "account.identity", secretParams: "cipher-2", waitMs: 200 }))
      .rejects.toMatchObject({ reason: "secret_busy" });
    // The other candidate's row is untouched: no demand merged, no secret swapped.
    expect(await secretOf()).toEqual({ secret_params: "cipher-1", demand_revision: "1" });

    await settle({ workId, servedRevision: 1, satisfiesRevision: true, close: "done", closeReason: "applied" });
    expect(await secretOf()).toEqual({ secret_params: null, demand_revision: "1" });
    // The key is free again: the next candidate gets its own row.
    const next = await enqueueAndWait({ db: db() }, { pageId, resource: "account.identity", secretParams: "cipher-2", waitMs: 200 });
    expect(next.state).toBe("queued");
    expect(next.state === "queued" ? next.workId : null).not.toBe(workId);
  }, 30_000);
});
