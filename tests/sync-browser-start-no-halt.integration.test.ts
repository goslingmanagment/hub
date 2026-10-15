import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findPageBrowser, insertPageBrowser, type Database } from "@agency_hub_core/db";

import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
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

  it("the CLI's flag", async (context) => {
    if (!testDb) return context.skip();
    const start = buildSyncEngineCommandGroup().commands.find((command) => command.name() === "browser")!.commands.find((command) => command.name() === "start")!;
    expect(start.options.map((option) => option.long)).toContain("--if-no-halt");
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

  it("the owner started the browser since: refused — the update starts nothing it did not stop", async (context) => {
    if (!testDb) return context.skip();
    const page = await stoppedBrowserPage();
    await startPageBrowser(db(), { pageLabel: page.label, actor: "owner" });
    await expect(startPageBrowser(db(), { pageLabel: page.label, actor: "page-browser-update", ifNoHalt: true, ifStop: page.stopId })).rejects.toThrow(
      "the browser is not stopped by the owner now",
    );
    expect((await commands(page.pageId)).map((row) => row.kind)).toEqual(["stopPage", "restartBrowser"]);
  });

  it("the CLI's option", async (context) => {
    if (!testDb) return context.skip();
    const start = buildSyncEngineCommandGroup().commands.find((command) => command.name() === "browser")!.commands.find((command) => command.name() === "start")!;
    expect(start.options.map((option) => option.long)).toContain("--if-stop");
  });
});
