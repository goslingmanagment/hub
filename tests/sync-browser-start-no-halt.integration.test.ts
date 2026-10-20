import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findPageBrowser, insertPageBrowser, type Database } from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { startPageBrowser, stopPageBrowsers } from "../apps/runtime/src/sync/browser-levers.ts";
import { SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { harnessConfig, seedHarnessPage } from "./helpers/sync-engine.ts";

// `sync browser start --if-no-halt --if-stop <command>` (Project Browser
// PR 18 on PR 17): the Chrome update's start of a page's browser never clears
// a halt held for the owner's decision, and lifts only the stop the update's
// own command made — while Hub mirrors a halt, or the stop in force is
// another's (the owner stopped the page since, or started it), the start is
// refused in its own transaction and nothing changes.

const HALT = "55555555-5555-4555-8555-555555555555";

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

async function stoppedBrowserPage() {
  const label = `upd-${randomUUID().slice(0, 8)}`;
  const { pageId } = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: null, label });
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId, container: `page-browser-${label}`, pageId,
    ...sealPageBrowserSecrets(harnessConfig(testDb!.connectionString), { engineToken: "e", apiToken: "a", vncPassword: "v" }),
  });
  await testDb!.pool.query("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
  const [stop] = await stopPageBrowsers(db(), { pageLabel: label, actor: "page-browser-update" });
  return { label, pageId, profileId, stopId: stop!.command.id };
}

async function pageRow(pageId: number) {
  const result = await testDb!.pool.query("select paused_all, browser_stop_paused from sync_pages where page_id = $1", [pageId]);
  return result.rows[0] as { paused_all: boolean; browser_stop_paused: boolean };
}
async function commands(pageId: number) {
  const result = await testDb!.pool.query("select kind, halt_id from page_browser_commands where page_id = $1 order by id", [pageId]);
  return result.rows as Array<{ kind: string; halt_id: string | null }>;
}

describe("sync browser start --if-no-halt", () => {
  it("a halt Hub mirrors refuses it whole: the stop, its pause and the halt stay, no command is asked", async (context) => {
    if (!testDb) return context.skip();
    const page = await stoppedBrowserPage();
    await testDb.pool.query("update page_browsers set halt_reason = 'exit_ip_changed', halt_at = now(), halt_id = $2 where profile_id = $1", [page.profileId, HALT]);
    await expect(startPageBrowser(db(), { pageLabel: page.label, actor: "page-browser-update", ifNoHalt: true })).rejects.toThrow(SyncOwnerLeverError);
    await expect(startPageBrowser(db(), { pageLabel: page.label, actor: "page-browser-update", ifNoHalt: true })).rejects.toThrow(
      `its browser stands for the owner's decision (exit_ip_changed, halt ${HALT})`,
    );
    const browser = (await findPageBrowser(db(), page.profileId))!;
    expect(browser.ownerStopAt).not.toBeNull();
    expect(browser.haltId).toBe(HALT);
    expect(await pageRow(page.pageId)).toEqual({ paused_all: true, browser_stop_paused: true });
    expect(await commands(page.pageId)).toEqual([{ kind: "stopPage", halt_id: null }]);
    // The owner's own start names it, as before.
    const owner = await startPageBrowser(db(), { pageLabel: page.label, actor: "owner" });
    expect(owner.halt).toMatchObject({ id: HALT });
  });

  it("no halt: the stop and its pause lifted, a start that names no halt", async (context) => {
    if (!testDb) return context.skip();
    const page = await stoppedBrowserPage();
    const asked = await startPageBrowser(db(), { pageLabel: page.label, actor: "page-browser-update", ifNoHalt: true });
    expect(asked.halt).toBeNull();
    expect(await pageRow(page.pageId)).toEqual({ paused_all: false, browser_stop_paused: false });
    expect(await commands(page.pageId)).toEqual([{ kind: "stopPage", halt_id: null }, { kind: "restartBrowser", halt_id: null }]);
  });
});

describe("sync browser start --if-stop <command>", () => {
  it("the update's own stop in force: lifted, the start asked", async (context) => {
    if (!testDb) return context.skip();
    const page = await stoppedBrowserPage();
    const asked = await startPageBrowser(db(), { pageLabel: page.label, actor: "page-browser-update", ifNoHalt: true, ifStop: page.stopId });
    expect(asked.wasStopped).toBe(true);
    expect(await pageRow(page.pageId)).toEqual({ paused_all: false, browser_stop_paused: false });
  });

  it("an owner's stop asked since: refused, nothing changed — his stop and its pause stay", async (context) => {
    if (!testDb) return context.skip();
    const page = await stoppedBrowserPage();
    const [owner] = await stopPageBrowsers(db(), { pageLabel: page.label, actor: "owner" });
    await expect(startPageBrowser(db(), { pageLabel: page.label, actor: "page-browser-update", ifNoHalt: true, ifStop: page.stopId })).rejects.toThrow(
      `the stop in force is not command ${page.stopId}'s (the page's latest stop is command ${owner!.command.id})`,
    );
    expect((await findPageBrowser(db(), page.profileId))!.ownerStopAt).not.toBeNull();
    expect(await pageRow(page.pageId)).toEqual({ paused_all: true, browser_stop_paused: true });
    expect((await commands(page.pageId)).map((row) => row.kind)).toEqual(["stopPage", "stopPage"]);
    // The owner's own start decides it.
    await expect(startPageBrowser(db(), { pageLabel: page.label, actor: "owner" })).resolves.toMatchObject({ wasStopped: true });
  });
});

describe("sync browser snapshot --if-no-owner-stop [command]", () => {
  async function runningBrowserPage() {
    const label = `upd-${randomUUID().slice(0, 8)}`;
    const { pageId } = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: null, label });
    const profileId = randomUUID();
    await insertPageBrowser(db(), {
      profileId, container: `page-browser-${label}`, pageId,
      ...sealPageBrowserSecrets(harnessConfig(testDb!.connectionString), { engineToken: "e", apiToken: "a", vncPassword: "v" }),
    });
    await testDb!.pool.query("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
    return { label, pageId, profileId };
  }

  it("no stop stands: the update's stop, recorded", async (context) => {
    if (!testDb) return context.skip();
    const page = await runningBrowserPage();
    const [stop] = await stopPageBrowsers(db(), { pageLabel: page.label, actor: "page-browser-update", snapshot: true, ifNoOwnerStop: true });
    expect(stop!.already).toBe(false);
  });

  it("an owner's stop stands: refused, nothing changed — the update never supersedes it", async (context) => {
    if (!testDb) return context.skip();
    const page = await runningBrowserPage();
    const [owner] = await stopPageBrowsers(db(), { pageLabel: page.label, actor: "owner" });
    const rows = async () => ({
      page: (await testDb!.pool.query("select * from sync_pages where page_id = $1", [page.pageId])).rows,
      browser: (await testDb!.pool.query("select * from page_browsers where page_id = $1", [page.pageId])).rows,
      audit: (await testDb!.pool.query("select count(*)::int as n from audit_events")).rows,
    });
    const before = await rows();
    await expect(stopPageBrowsers(db(), { pageLabel: page.label, actor: "page-browser-update", snapshot: true, ifNoOwnerStop: true })).rejects.toThrow(
      `an owner's stop stands on its browser (the page's latest stop is command ${owner!.command.id})`,
    );
    expect((await commands(page.pageId)).map((row) => row.kind)).toEqual(["stopPage"]);
    expect(await rows()).toEqual(before);
    // Named as the update's own (asked again): allowed.
    await expect(stopPageBrowsers(db(), { pageLabel: page.label, actor: "page-browser-update", snapshot: true, ifNoOwnerStop: owner!.command.id })).resolves.toHaveLength(1);
  });

  it("a page its owner moved to Node, or whose browser's leave is pending: refused, nothing changed — the update never pauses it", async (context) => {
    if (!testDb) return context.skip();
    const page = await runningBrowserPage();
    const rows = async () => ({
      page: (await testDb!.pool.query("select * from sync_pages where page_id = $1", [page.pageId])).rows,
      browser: (await testDb!.pool.query("select * from page_browsers where page_id = $1", [page.pageId])).rows,
      commands: await commands(page.pageId),
    });
    await testDb!.pool.query("update sync_pages set transport = 'node', browser_leave_generation = null, browser_leave_requested_at = null where page_id = $1", [page.pageId]);
    const onNode = await rows();
    await expect(stopPageBrowsers(db(), { pageLabel: page.label, actor: "page-browser-update", snapshot: true, ifNoOwnerStop: true })).rejects.toThrow(
      `${page.label} is not on its browser (transport node): the update's stop is asked only of a page on its browser — refused, nothing changed`,
    );
    expect(await rows()).toEqual(onNode);
    expect(onNode.page[0]).toMatchObject({ paused_all: false });
    await testDb!.pool.query("update sync_pages set transport = 'browser', browser_leave_generation = 7, browser_leave_requested_at = now() where page_id = $1", [page.pageId]);
    const leaving = await rows();
    await expect(stopPageBrowsers(db(), { pageLabel: page.label, actor: "page-browser-update", snapshot: true, ifNoOwnerStop: true })).rejects.toThrow(
      "(transport browser, a leave of it pending since generation 7)",
    );
    expect(await rows()).toEqual(leaving);
  });
});
