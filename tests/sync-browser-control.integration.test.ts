import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPageBrowserCommand,
  insertPageBrowser,
  insertPageBrowserCommand,
  latchPageBrowserHalt,
  type Database,
} from "@agency_hub_core/db";

import type { Command, State } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import type { PageBrowserRpcClient } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { BrowserControl } from "../apps/runtime/src/sync/fansly/browser-control.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { quietLogger } from "./helpers/sync-engine-host.ts";
import { harnessConfig, seedHarnessPage } from "./helpers/sync-engine.ts";

// One guard for every start of a page's browser (Project Browser PR 17,
// Astra round 1, P1-1 and P1-2), read fresh right before the command goes,
// on a page's control with a stand-in for its link: a start — the slot's
// own or the owner's — never goes to a page that left its browser (its old
// slot still running), whose leave is pending, of a newer owner, that the
// owner paused or stopped, that a person logs in, or whose browser stands
// for the owner's decision — latched in Hub, or heard on the link and not
// latched yet (an operator that started again stands with no reason).

const GENERATION = 5n;

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

function stands(patch: Partial<State> = {}): State {
  return {
    type: "state", step: "exit_closed", stopReason: null, retryAtWall: null, exitOpen: false, mode: "automation",
    sessionFingerprint: null, accountId: null, exitIp: null, chromeVersion: "155", operatorVersion: "op",
    buffer: { bytes: 0, oldestAgeMs: 0 }, selfTest: null, ...patch,
  };
}

interface Link {
  client: PageBrowserRpcClient;
  sent: Array<{ kind: string; commandId: string }>;
  setState(state: State): void;
}

/** A stand-in for the page's link: its state, its hand-over, the commands sent. */
function link(initial: State): Link {
  let state = initial;
  const listeners = new Set<(state: State) => void>();
  const sent: Link["sent"] = [];
  const client = {
    get state() {
      return state;
    },
    quiesced: { type: "quiesced", previousGeneration: 0, lastSendMono: null, lastSendWall: null },
    onState(listener: (state: State) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async command(kind: Command["command"]["kind"], _notAfter: number, _waitMs: number, commandId = randomUUID()) {
      sent.push({ kind, commandId });
      return { type: "commandResult", commandId, ok: true, detail: `${kind}: done` };
    },
  } as unknown as PageBrowserRpcClient;
  return {
    client,
    sent,
    setState(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

async function browserPage(transport: "node" | "browser" = "browser") {
  const label = `ctl-${randomUUID().slice(0, 8)}`;
  const { pageId } = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: null, label });
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId, container: `page-browser-${label}`, pageId,
    ...sealPageBrowserSecrets(harnessConfig(testDb!.connectionString), { engineToken: "e", apiToken: "a", vncPassword: "v" }),
  });
  await testDb!.pool.query("update sync_pages set transport = $2, owner_generation = $3 where page_id = $1", [pageId, transport, GENERATION.toString()]);
  return { pageId, profileId };
}

function control(page: { pageId: number; profileId: string }, l: Link): BrowserControl {
  const clock = { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: async () => undefined };
  const made = new BrowserControl({
    db: db(), pageId: page.pageId, profileId: page.profileId, generation: GENERATION, client: l.client,
    bridge: { toKernel: (ms) => ms, fromKernel: (ms) => ms }, clock, logger: quietLogger, metrics: { increment: () => undefined },
    role: "slot", timing: { everyMs: 60_000, startEveryMs: 0 },
  });
  made.start();
  return made;
}

async function ownersStart(pageId: number) {
  return (await insertPageBrowserCommand(db(), { pageId, kind: "restartBrowser", requestedBy: "cli@test", ttlMs: 60_000 }))!;
}

const CONFLICTS: Array<[string, (page: { pageId: number; profileId: string }, l: Link) => Promise<void>, RegExp]> = [
  ["the page switched to Node, its old slot not ended yet", async (page) => {
    await testDb!.pool.query("update sync_pages set transport = 'node' where page_id = $1", [page.pageId]);
  }, /not on its browser \(its transport is node\)/],
  ["a leave of its browser pending", async (page) => {
    await testDb!.pool.query("update sync_pages set browser_leave_generation = 5, browser_leave_requested_at = clock_timestamp() where page_id = $1", [page.pageId]);
  }, /a leave of the page's browser is pending/],
  ["a newer owner of the page", async (page) => {
    await testDb!.pool.query("update sync_pages set owner_generation = 6 where page_id = $1", [page.pageId]);
  }, /superseded/],
  ["the owner's pause", async (page) => {
    await testDb!.pool.query("update sync_pages set paused_all = true, pause_note = 'maintenance' where page_id = $1", [page.pageId]);
  }, /the page is paused/],
  ["a login of the page's browser open", async (_page, l) => {
    l.setState(stands({ mode: "manual_login" }));
  }, /a login of the page's browser is open/],
  ["the owner's stop", async (page) => {
    await testDb!.pool.query("update page_browsers set owner_stop_at = clock_timestamp(), owner_stop_by = 'cli' where profile_id = $1", [page.profileId]);
  }, /the owner stopped the page's browser/],
];

describe("one guard for every start of a page's browser (Astra PR 17, P1-2)", () => {
  for (const [what, make, reason] of CONFLICTS) {
    it(`${what}: the owner's start is refused with its reason, and the slot starts nothing`, async (context) => {
      if (!testDb) return context.skip();
      const page = await browserPage();
      const l = link(stands());
      const ctl = control(page, l);
      try {
        await make(page, l);
        const asked = await ownersStart(page.pageId);
        await ctl.tick();
        const ran = await getPageBrowserCommand(db(), asked.id);
        expect(ran).toMatchObject({ ok: false, takenGeneration: GENERATION });
        expect(ran!.detail).toMatch(reason);
        // The slot's own start, on a browser that stands: none either.
        await ctl.tick();
        await ctl.tick();
        expect(l.sent.filter((command) => command.kind === "restartBrowser"), what).toEqual([]);
      } finally {
        await ctl.stop();
      }
    });
  }

  it("nothing in the way: the slot starts a browser that stands, and the owner's start runs by its own id", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands());
    const ctl = control(page, l);
    try {
      await ctl.tick();
      expect(l.sent.map((command) => command.kind)).toEqual(["restartBrowser"]);
      const asked = await ownersStart(page.pageId);
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: true, detail: "restartBrowser: done" });
      expect(l.sent.at(-1)).toEqual({ kind: "restartBrowser", commandId: asked.commandId });
    } finally {
      await ctl.stop();
    }
  });
});

describe("the self-test closes an exit only the guard would open again", () => {
  it("a page in a login, paused or leaving: its open exit is not closed for a test", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ step: "ready", exitOpen: true }));
    const ctl = control(page, l);
    try {
      await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [page.pageId]);
      const asked = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "selfTest", requestedBy: "cli", ttlMs: 60_000 }))!;
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: false, detail: expect.stringContaining("not run: the page is paused") });
      expect(l.sent).toEqual([]);
      await testDb.pool.query("update sync_pages set paused_all = false where page_id = $1", [page.pageId]);
      const again = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "selfTest", requestedBy: "cli", ttlMs: 60_000 }))!;
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), again.id)).toMatchObject({ ok: true });
      expect(l.sent.map((command) => command.kind)).toEqual(["closeExit", "selfTest", "openExit"]);
    } finally {
      await ctl.stop();
    }
  });
});

describe("a halt for the owner's decision holds every start but his (Astra PR 17, P1-1)", () => {
  it("latched in Hub: an operator that started again (no reason) is not started; the owner's start is", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    await latchPageBrowserHalt(db(), { profileId: page.profileId, reason: "header_mismatch" });
    const l = link(stands());
    const ctl = control(page, l);
    try {
      await ctl.tick();
      await ctl.tick();
      expect(l.sent).toEqual([]);
      // The owner's start in the CLI lifts the latch in its transaction; a
      // start asked with the latch still there is refused.
      const early = await ownersStart(page.pageId);
      await ctl.tick();
      expect((await getPageBrowserCommand(db(), early.id))!.detail).toMatch(/stands for the owner's decision \(header_mismatch\)/);
      await testDb.pool.query("update page_browsers set halt_reason = null, halt_at = null where profile_id = $1", [page.profileId]);
      const asked = await ownersStart(page.pageId);
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: true });
      expect(l.sent.map((command) => command.kind)).toEqual(["restartBrowser"]);
    } finally {
      await ctl.stop();
    }
  });

  it("heard on the link before Hub has latched it: the operator's restart does not start it", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ step: "ready", exitOpen: true }));
    const ctl = control(page, l);
    try {
      // The halt, then an operator that started again: it stands with no reason.
      l.setState(stands({ stopReason: "unknown_ws_message" }));
      l.setState(stands());
      await ctl.tick();
      await ctl.tick();
      expect(l.sent).toEqual([]);
      // The owner's start (his decision) runs, and the slot's own hold ends with it.
      const asked = await ownersStart(page.pageId);
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: true });
      l.setState(stands({ stopReason: "owner_stop" }));
      await ctl.tick();
      expect(l.sent.map((command) => command.kind)).toEqual(["restartBrowser", "restartBrowser"]);
    } finally {
      await ctl.stop();
    }
  });
});

describe("the owner's stop is confirmed by its own request (Astra PR 17, P1-3)", () => {
  it("a stop command runs only while the owner's stop stands, by its id; its answer is the confirmation", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ step: "ready", exitOpen: true }));
    const command = vi.spyOn(l.client, "command");
    const ctl = control(page, l);
    try {
      const lifted = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "stopPage", requestedBy: "cli", ttlMs: 60_000 }))!;
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), lifted.id)).toMatchObject({ ok: false, detail: expect.stringContaining("the owner's stop was lifted") });
      expect(command).not.toHaveBeenCalled();
      await testDb.pool.query("update page_browsers set owner_stop_at = clock_timestamp(), owner_stop_by = 'cli' where profile_id = $1", [page.profileId]);
      const asked = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "stopPage", requestedBy: "cli", ttlMs: 60_000 }))!;
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: true, takenGeneration: GENERATION, detail: "stopPage: done" });
      expect(l.sent).toEqual([{ kind: "stopPage", commandId: asked.commandId }]);
    } finally {
      await ctl.stop();
    }
  });
});
