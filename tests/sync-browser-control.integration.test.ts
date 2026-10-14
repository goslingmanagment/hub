import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findPageBrowser,
  getPageBrowserCommand,
  insertPageBrowser,
  insertPageBrowserCommand,
  recordPageBrowserState,
  setSyncPageManualLogin,
  type Database,
} from "@agency_hub_core/db";

import type { Command, State } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import type { PageBrowserRpcClient } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { BrowserControl } from "../apps/runtime/src/sync/fansly/browser-control.ts";
import { BrowserLoginDriver } from "../apps/runtime/src/sync/fansly/browser-login.ts";
import { BrowserRecorder } from "../apps/runtime/src/sync/fansly/browser-record.ts";
import { startPageBrowser, stopPageBrowsers } from "../apps/runtime/src/sync/browser-levers.ts";
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
  sent: Array<{ kind: string; commandId: string; haltId?: string }>;
  setState(state: State): void;
}

const HALT = "33333333-3333-4333-8333-333333333333";
/** A halt the operator holds on its volume (`state.halt`). */
function held(reason = "header_mismatch", id = HALT): NonNullable<State["halt"]> {
  return { id, reason: reason as NonNullable<State["halt"]>["reason"], atWall: Date.now() - 60_000 };
}

/** A stand-in for the page's link: its state, its hand-over, the commands sent. */
function link(initial: State): Link {
  let state = initial;
  const listeners = new Set<(state: State) => void>();
  const sent: Link["sent"] = [];
  const client = {
    up: true,
    get state() {
      return state;
    },
    quiesced: { type: "quiesced", previousGeneration: 0, lastSendMono: null, lastSendWall: null },
    onState(listener: (state: State) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAlarm: () => () => undefined,
    onLink: () => () => undefined,
    async command(command: Command["command"]["kind"] | Command["command"], _notAfter: number, _waitMs: number, commandId = randomUUID()) {
      const kind = typeof command === "string" ? command : command.kind;
      const haltId = typeof command === "object" && command.kind === "clearHalt" ? command.haltId : undefined;
      sent.push({ kind, commandId, ...(haltId === undefined ? {} : { haltId }) });
      // As the operator: its held halt refuses a start (the login's for
      // login_required aside), and only a clearHalt naming it clears it.
      const halt = state.halt ?? null;
      if (kind === "clearHalt") {
        if (halt !== null && halt.id !== haltId) return { type: "commandResult", commandId, ok: false, detail: `the halt held is ${halt.id}: nothing cleared` };
        state = { ...state, halt: null, stopReason: halt !== null && state.stopReason === halt.reason ? null : state.stopReason };
        return { type: "commandResult", commandId, ok: true, detail: "cleared" };
      }
      if ((kind === "restartBrowser" || kind === "openExit") && halt !== null && !(halt.reason === "login_required" && state.mode === "manual_login")) {
        return { type: "commandResult", commandId, ok: false, detail: "halted for the owner's decision: clearHalt first" };
      }
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

function loginDriver(page: { pageId: number; profileId: string }, l: Link, transport: "node" | "browser"): BrowserLoginDriver {
  const clock = { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: async () => undefined };
  return new BrowserLoginDriver({
    db: db(), pageId: page.pageId, profileId: page.profileId, generation: GENERATION, transport, client: l.client,
    bridge: { toKernel: (ms) => ms, fromKernel: (ms) => ms }, clock, logger: quietLogger, metrics: { increment: () => undefined },
    timing: { everyMs: 60_000, restartEveryMs: 0 },
  });
}

function control(page: { pageId: number; profileId: string }, l: Link, role: "slot" | "leave" | "login" = "slot"): BrowserControl {
  const clock = { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: async () => undefined };
  const made = new BrowserControl({
    db: db(), pageId: page.pageId, profileId: page.profileId, generation: GENERATION, client: l.client,
    bridge: { toKernel: (ms) => ms, fromKernel: (ms) => ms }, clock, logger: quietLogger, metrics: { increment: () => undefined },
    role, timing: { everyMs: 60_000, startEveryMs: 0, stopEveryMs: 0 },
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
  ["a login of the page's browser open in Hub, its operator not in it yet", async (page) => {
    await testDb!.pool.query("update sync_pages set manual_login = 'wanted' where page_id = $1", [page.pageId]);
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
        if (reason.source.includes("superseded")) {
          // A superseded owner leaves the owner's command to the newer one (Astra round 2).
          expect(ran).toMatchObject({ takenAt: null, doneAt: null });
        } else if (what.includes("open in Hub")) {
          // The owner's start during an open login: the login brings the browser up.
          expect(ran).toMatchObject({ outcome: "ok", detail: expect.stringContaining("the open login") });
        } else {
          expect(ran).toMatchObject({ ok: false, takenGeneration: GENERATION });
          expect(ran!.detail).toMatch(reason);
        }
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
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ outcome: "ok", ok: true, detail: "restartBrowser: restartBrowser: done" });
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

describe("a halt for the owner's decision is the operator's (Astra PR 17, round 3)", () => {
  const mirrored = (page: { profileId: string }, halt: NonNullable<State["halt"]> | null) =>
    recordPageBrowserState(db(), {
      profileId: page.profileId, step: "exit_closed", stopReason: null, mode: "automation", exitOpen: false, sessionFingerprint: null, accountId: null,
      exitIp: null, chromeVersion: "155", operatorVersion: "op", selfTest: null, buffer: { bytes: 0, oldestAgeMs: 0 },
      halt: halt === null ? null : { id: halt.id, reason: halt.reason, at: new Date(halt.atWall) },
    });
  const label = async (pageId: number) => (await testDb!.pool.query<{ label: string }>("select label from pages where id = $1", [pageId])).rows[0]!.label;

  it("a slot does not ask a browser whose operator holds one (its restart says no reason); the owner's start clears the halt he decided on by its id, then starts it — the mirror rewritten meanwhile changes nothing", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ halt: held() }));
    const ctl = control(page, l);
    try {
      await mirrored(page, held());
      await ctl.tick();
      await ctl.tick();
      expect(l.sent).toEqual([]);
      const asked = await startPageBrowser(db(), { pageLabel: await label(page.pageId), actor: "cli@test" });
      expect(asked.halt).toMatchObject({ id: HALT, reason: "header_mismatch" });
      // The recorder writes the unchanged state again (Astra round 3: it re-latched the old halt).
      await mirrored(page, held());
      await ctl.tick();
      expect(l.sent.map((command) => [command.kind, command.haltId ?? null])).toEqual([["clearHalt", HALT], ["restartBrowser", null]]);
      expect(await getPageBrowserCommand(db(), asked.command.id)).toMatchObject({ outcome: "ok", ok: true });
    } finally {
      await ctl.stop();
    }
  });

  it("the owner's start names the halt he saw: a newer halt held since is not cleared, and nothing starts", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ halt: held("header_mismatch", "44444444-4444-4444-8444-444444444444") }));
    const ctl = control(page, l);
    try {
      await mirrored(page, held());
      const asked = await startPageBrowser(db(), { pageLabel: await label(page.pageId), actor: "cli@test" });
      await ctl.tick();
      expect(l.sent.map((command) => command.kind)).toEqual(["clearHalt"]);
      expect(await getPageBrowserCommand(db(), asked.command.id)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("nothing cleared") });
    } finally {
      await ctl.stop();
    }
  });

  for (const transport of ["node", "browser"] as const) {
    it(`the owner's start during an open login on ${transport} clears a strict halt, and the login starts the browser (Astra round 3, P1-2)`, async (context) => {
      if (!testDb) return context.skip();
      const page = await browserPage(transport);
      const l = link(stands({ mode: "manual_login", stopReason: "header_mismatch", halt: held() }));
      const ctl = control(page, l, transport === "node" ? "login" : "slot");
      const login = loginDriver(page, l, transport);
      try {
        await db().transaction(async (raw) => setSyncPageManualLogin(raw as unknown as Database, { pageId: page.pageId, to: "wanted", by: "owner:test" }));
        await mirrored(page, held());
        // The login stands by: its operator holds a halt that is not its own.
        await login.drive();
        expect(l.sent).toEqual([]);
        const asked = await startPageBrowser(db(), { pageLabel: await label(page.pageId), actor: "cli@test" });
        await ctl.tick();
        expect(l.sent.map((command) => command.kind)).toEqual(["clearHalt"]);
        expect(await getPageBrowserCommand(db(), asked.command.id)).toMatchObject({ outcome: "ok", detail: expect.stringContaining("the open login") });
        await login.drive();
        expect(l.sent.map((command) => command.kind)).toEqual(["clearHalt", "restartBrowser"]);
      } finally {
        await ctl.stop();
      }
    });
  }

  it("a command taken, then left by an owner superseded before it sent anything, is given back — the newer owner runs it (Astra round 3, P1-3)", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ step: "ready", exitOpen: true }));
    // The owner is superseded right after it took the command.
    let fired = false;
    const base = db();
    const hooked = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop !== "execute") return Reflect.get(target, prop, receiver);
        return async (query: Parameters<Database["execute"]>[0]) => {
          const result = await target.execute(query);
          const row = (result as { rows?: Array<Record<string, unknown>> }).rows?.[0];
          if (!fired && row !== undefined && row.takenGeneration != null) {
            fired = true;
            await testDb!.pool.query("update sync_pages set owner_generation = 6 where page_id = $1", [page.pageId]);
          }
          return result;
        };
      },
    }) as Database;
    const clock = { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: async () => undefined };
    const make = (database: Database, generation: bigint) => new BrowserControl({
      db: database, pageId: page.pageId, profileId: page.profileId, generation, client: l.client,
      bridge: { toKernel: (ms) => ms, fromKernel: (ms) => ms }, clock, logger: quietLogger, metrics: { increment: () => undefined },
      role: "slot", timing: { everyMs: 60_000, startEveryMs: 0, stopEveryMs: 0 },
    });
    const asked = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "selfTest", requestedBy: "cli", ttlMs: 60_000 }))!;
    const old = make(hooked, GENERATION);
    await old.tick();
    expect(fired).toBe(true);
    expect(l.sent).toEqual([]);
    expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ takenAt: null, sentAt: null, doneAt: null });
    const newer = make(db(), 6n);
    await newer.tick();
    expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ takenGeneration: 6n, outcome: "ok" });
    expect(l.sent.map((command) => command.kind)).toEqual(["closeExit", "selfTest", "openExit"]);
  });

  it("a command sent and not answered ends unknown, and nobody sends it again", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage();
    const l = link(stands({ step: "ready", exitOpen: true }));
    (l.client as unknown as { command: () => Promise<null> }).command = async () => null;
    const ctl = control(page, l);
    try {
      const asked = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "selfTest", requestedBy: "cli", ttlMs: 60_000 }))!;
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ outcome: "unknown", ok: null, sentAt: expect.any(Date) });
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

describe("the login's own start goes under the same guard (PR 15's driver, PR 17)", () => {
  async function seeded(transport: "node" | "browser") {
    const page = await browserPage(transport);
    const label = (await testDb!.pool.query<{ label: string }>("select label from pages where id = $1", [page.pageId])).rows[0]!.label;
    return { ...page, label };
  }

  const driver = loginDriver;

  const starts = (l: Link) => l.sent.filter((command) => command.kind === "restartBrowser").length;
  const loginOpen = (pageId: number) => db().transaction(async (raw) => setSyncPageManualLogin(raw as unknown as Database, { pageId, to: "wanted", by: "owner:test" }));

  for (const transport of ["node", "browser"] as const) {
    it(`a page on ${transport}: a merely stopped browser is started by the login; one the owner stopped is not, until his start`, async (context) => {
      if (!testDb) return context.skip();
      const page = await seeded(transport);
      const l = link(stands({ mode: "manual_login" }));
      const login = driver(page, l, transport);
      await loginOpen(page.pageId);
      await login.drive();
      expect(starts(l)).toBe(1);
      // The owner stops the browser during the login (his lever): the
      // operator stands stopped by him — the login does not start it again.
      await stopPageBrowsers(db(), { pageLabel: page.label, actor: "cli@test" });
      l.setState(stands({ mode: "manual_login", stopReason: "owner_stop" }));
      await login.drive();
      await login.drive();
      expect(starts(l)).toBe(1);
      // His start lifts the stop: the login starts the browser it needs.
      await startPageBrowser(db(), { pageLabel: page.label, actor: "cli@test" });
      await login.drive();
      expect(starts(l)).toBe(2);
    });
  }

  it("a browser whose operator holds another halt for the owner is not started by the login, even when it stands with no reason (restarted)", async (context) => {
    if (!testDb) return context.skip();
    const page = await seeded("browser");
    const l = link(stands({ mode: "manual_login", halt: held("exit_ip_changed") }));
    const login = driver(page, l, "browser");
    await loginOpen(page.pageId);
    await login.drive();
    await login.drive();
    expect(starts(l)).toBe(0);
  });

  it("a browser Fansly signed out (login_required) is the one halt the login starts — said by its stop reason or held on its volume", async (context) => {
    if (!testDb) return context.skip();
    const page = await seeded("browser");
    const l = link(stands({ mode: "manual_login", stopReason: "login_required" }));
    const login = driver(page, l, "browser");
    await loginOpen(page.pageId);
    await login.drive();
    expect(starts(l)).toBe(1);
    l.setState(stands({ mode: "manual_login", halt: held("login_required") }));
    await login.drive();
    expect(starts(l)).toBe(2);
  });

  it("no start for a leave pending, a newer owner, or a login no longer wanted", async (context) => {
    if (!testDb) return context.skip();
    const page = await seeded("browser");
    const l = link(stands({ mode: "manual_login" }));
    const login = driver(page, l, "browser");
    await loginOpen(page.pageId);
    await testDb.pool.query("update sync_pages set owner_generation = 6 where page_id = $1", [page.pageId]);
    await login.drive();
    expect(starts(l)).toBe(0);
    await testDb.pool.query("update sync_pages set owner_generation = 5, browser_leave_generation = 5, browser_leave_requested_at = clock_timestamp() where page_id = $1", [page.pageId]);
    await login.drive();
    expect(starts(l)).toBe(0);
    await testDb.pool.query("update sync_pages set browser_leave_generation = null, browser_leave_requested_at = null where page_id = $1", [page.pageId]);
    await login.drive();
    expect(starts(l)).toBe(1);
  });
  it("a halt the operator holds after a login_required is not started by the login, whatever Hub mirrors (Astra rounds 2 and 3)", async (context) => {
    if (!testDb) return context.skip();
    const page = await seeded("node");
    const l = link(stands({ mode: "manual_login", stopReason: "login_required", halt: held("login_required") }));
    const login = driver(page, l, "node");
    await loginOpen(page.pageId);
    await login.drive();
    expect(starts(l)).toBe(1);
    // A guard fails in the started browser: the operator holds the stricter
    // halt; it starts again with no reason (its mirror in Hub never written).
    l.setState(stands({ mode: "manual_login", halt: held("header_mismatch", "55555555-5555-4555-8555-555555555555") }));
    await login.drive();
    await login.drive();
    expect(starts(l)).toBe(1);
  });

  it("the halt the operator says right now holds the login's start, whatever it said just before (Astra round 2, P1-1)", async (context) => {
    if (!testDb) return context.skip();
    const page = await seeded("browser");
    const l = link(stands({ mode: "manual_login" }));
    const login = driver(page, l, "browser");
    await loginOpen(page.pageId);
    // The browser stands when the driver looks; while the latch is read, the
    // operator says a halt.
    let reads = 0;
    const halted = stands({ mode: "manual_login", stopReason: "header_mismatch" });
    const plain = stands({ mode: "manual_login" });
    Object.defineProperty(l.client, "state", { get: () => (++reads <= 1 ? plain : halted), configurable: true });
    await login.drive();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(starts(l)).toBe(0);
  });
});

describe("the owner's stop over a stale link (Astra round 2, P1-3)", () => {
  async function stoppedByOwner(transport: "node" | "browser") {
    const page = await browserPage(transport);
    await testDb!.pool.query("update page_browsers set owner_stop_at = clock_timestamp(), owner_stop_by = 'cli' where profile_id = $1", [page.profileId]);
    return page;
  }

  it("a login link whose login ended neither keeps the stop nor runs a stop command", async (context) => {
    if (!testDb) return context.skip();
    const page = await stoppedByOwner("node");
    const l = link(stands({ step: "site_loaded", exitOpen: true, mode: "manual_login" }));
    const ctl = control(page, l, "login");
    try {
      // manual_login is off: the login this link was opened for is over.
      const asked = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "stopPage", requestedBy: "cli", ttlMs: 60_000 }))!;
      await ctl.tick();
      await ctl.tick();
      expect(l.sent).toEqual([]);
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ takenAt: null, doneAt: null });
      // The login open: both run.
      await testDb.pool.query("update sync_pages set manual_login = 'wanted' where page_id = $1", [page.pageId]);
      await ctl.tick();
      expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ ok: true });
      await ctl.tick();
      expect(l.sent.map((command) => command.kind)).toEqual(["stopPage", "stopPage"]);
    } finally {
      await ctl.stop();
    }
  });

  for (const role of ["slot", "login"] as const) {
    it(`a ${role} of a superseded owner neither keeps the stop nor takes a stop command (left to the newer owner)`, async (context) => {
      if (!testDb) return context.skip();
      const page = await stoppedByOwner(role === "slot" ? "browser" : "node");
      await testDb.pool.query("update sync_pages set manual_login = 'wanted', owner_generation = 6 where page_id = $1", [page.pageId]);
      const l = link(stands({ step: "ready", exitOpen: true }));
      const ctl = control(page, l, role);
      try {
        const asked = (await insertPageBrowserCommand(db(), { pageId: page.pageId, kind: "stopPage", requestedBy: "cli", ttlMs: 60_000 }))!;
        await ctl.tick();
        await ctl.tick();
        expect(l.sent).toEqual([]);
        expect(await getPageBrowserCommand(db(), asked.id)).toMatchObject({ takenAt: null, doneAt: null });
      } finally {
        await ctl.stop();
      }
    });
  }
});

describe("the recorder's mirror of the operator's halt (Astra round 3)", () => {
  it("follows what the operator holds, written with its state; a write that failed loses nothing — the next state brings it", async (context) => {
    if (!testDb) return context.skip();
    const page = await browserPage("node");
    const l = link(stands());
    let failing = false;
    const base = db();
    const flaky = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop !== "execute") return Reflect.get(target, prop, receiver);
        return async (query: Parameters<Database["execute"]>[0]) => {
          if (failing) throw new Error("the database is away");
          return target.execute(query);
        };
      },
    }) as Database;
    const clock = { monoNow: () => performance.now(), wallNow: () => new Date(), sleep: async () => undefined };
    const recorder = new BrowserRecorder({
      db: flaky, pageId: page.pageId, profileId: page.profileId, client: l.client, clock, logger: quietLogger, metrics: { increment: () => undefined },
      timing: { stateRefreshMs: 0 },
    });
    recorder.start();
    try {
      failing = true;
      l.setState(stands({ stopReason: "header_mismatch", halt: held() }));
      await recorder.flushed();
      expect((await findPageBrowser(db(), page.profileId))?.haltId).toBeNull();
      failing = false;
      // The operator says its state again (every few seconds): the mirror catches up.
      l.setState(stands({ stopReason: "header_mismatch", halt: held() }));
      await recorder.flushed();
      expect(await findPageBrowser(db(), page.profileId)).toMatchObject({ haltReason: "header_mismatch", haltId: HALT });
      // Cleared at the operator: gone from the mirror with its next state.
      l.setState(stands({ halt: null }));
      await recorder.flushed();
      expect(await findPageBrowser(db(), page.profileId)).toMatchObject({ haltReason: null, haltId: null });
    } finally {
      await recorder.stop();
    }
  });
});
