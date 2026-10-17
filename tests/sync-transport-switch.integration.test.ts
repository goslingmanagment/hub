// The transport switch of a page (Project Browser plan §3.2 «Выбор транспорта
// страницы», «Переключение транспорта страницы и откат», §4.7, owner
// decision №12; stage 3 PR 14, row 14's checks) on a real host: the page's
// Node transport over a fake Fansly origin behind a CONNECT proxy, its
// browser a fake operator (the operator's own RPC server).
// - Both ways with a request in flight: the request finishes and is
//   committed by the owner that admitted it; no admission of the transport
//   the page left commits after the switch, and nothing is sent through it
//   once its slot ended; the new transport's first send is ≥ 1.2 × S after
//   the last send of the old one (S at least the owner's 2 s minimum).
// - A page that leaves its browser has its operator stop it; a page on Node
//   never links to its browser.
// - The rollback of a page connected through its browser, its Chrome down
//   and no Node session stored: prepare (a credentials hold that admits only
//   a candidate check), the identity check through Node by the session the
//   owner sends, its storing and trusting in one transaction (a CAS: a base
//   moved in between stores nothing), then the verify lifts the hold and the
//   page works on Node.


import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  findPageBrowserByPage,
  getSyncPageTransport,
  LiveGateClosedError,
  lockOwnedPage,
  setPageBrowserSettings,
  setSyncPageTransport,
  storeFanslySession,
  type Database,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { updatePageCredentials } from "../apps/runtime/src/services/connections.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import {
  checkFanslyIdentityThroughEngine,
  FanslyCredentialsChangedError,
  saveVerifiedFanslyCredentials,
} from "../apps/runtime/src/services/sync-engine-account.ts";
import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { readBrowserCredentialsGeneration } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import { changeSyncPageTransport } from "../apps/runtime/src/sync/page-transport.ts";
import { SESSION_A } from "./helpers/page-browser-operator.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { CountingConnectProxy, HARNESS_ENCRYPTION_KEY, until, type FakeRoute } from "./helpers/sync-engine.ts";
import {
  FLOOR_S,
  S,
  attempts,
  audits,
  cleanups,
  credentialsHold,
  db,
  leftBy,
  marksOf,
  nodeGeneration,
  rig,
  sendsOf,
  session,
  startHost,
  testDb,
  trusted,
  useSwitchHarness,
} from "./helpers/sync-transport-switch.ts";

useSwitchHarness();

describe("the switch, both ways, with a request in flight", () => {
  it("node → browser: the request in flight finishes on Node; nothing more goes through Node; the browser's first send is ≥ 1.2 × S later", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const host = await startHost(r);
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 2, 15_000, "the page running on Node");
    const nodeOwner = host.state(r.page.pageId);
    expect(nodeOwner.kind).toBe("running");
    const g1 = nodeOwner.kind === "running" ? nodeOwner.generation : 0n;
    // A Node page never links to its browser.
    expect(r.operator.links).toEqual([]);

    // A slow origin: the next request is in flight for 1.5 s.
    r.server.answerDelayMs = 1_500;
    const arrived = r.server.arrivals.length;
    await until(async () => r.server.arrivals.length > arrived, 10_000, "a request in flight");
    const inFlight = r.server.arrivals.at(-1)!;
    expect(inFlight.status).toBeNull();
    const changed = await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "browser", prepare: false, actor: "test" });
    const switchedWall = Date.now();
    expect(changed).toMatchObject({ from: "node", to: "browser", changed: true, prepared: null });
    const nodeAdmissionsAtSwitch = (await attempts(r.page.pageId)).filter((row) => row.generation === g1.toString()).length;

    // The browser: its identity check first (the trusted digest is Node's),
    // then the polls.
    const g2 = g1 + 1n;
    await until(async () => sendsOf(await attempts(r.page.pageId), g2).length >= 3, 30_000, "the page running on its browser");
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running", generation: g2 });

    const physical = [...r.operator.physical];
    const rows = await attempts(r.page.pageId);
    // No admission of Node after the switch; the one in flight was answered and committed.
    expect(rows.filter((row) => row.generation === g1.toString())).toHaveLength(nodeAdmissionsAtSwitch);
    const lastNode = sendsOf(rows, g1).at(-1)!;
    expect(lastNode.outcome).toBe("response");
    expect(inFlight.status).toBe(200);
    // Nothing reached the origin through Node after the switch.
    expect(r.server.arrivals.filter((arrival) => arrival.wallMs > switchedWall)).toEqual([]);
    expect(r.server.arrivals.at(-1)!.seq).toBe(inFlight.seq);
    // The browser's sends are the new owner's, and the pause between the two
    // senders is the takeover floor's.
    const browserSends = sendsOf(rows, g2);
    expect(browserSends.length).toBeGreaterThanOrEqual(3);
    expect(marksOf(browserSends)).toEqual(["transport_reported"]);
    const browserAdmissions = new Set(rows.filter((row) => row.generation === g2.toString()).map((row) => row.id));
    expect(physical.every((request) => browserAdmissions.has(request.attemptId))).toBe(true);
    expect(physical.map((request) => request.attemptId)).toEqual(expect.arrayContaining(browserSends.map((row) => row.id)));
    expect(browserSends[0]!.resource).toBe("account.verify");
    expect(browserSends[0]!.sentAt!.getTime() - lastNode.sentAt!.getTime()).toBeGreaterThanOrEqual(1.2 * FLOOR_S);
    expect(r.operator.physical[0]!.generation).toBe(Number(g2));
    // The hand-over: the operator's quiesced for the new owner, recorded.
    await until(async () => (await findPageBrowserByPage(db(), r.page.pageId))!.handoverGeneration === g2, 5_000, "the hand-over");
    // A page coming to its browser does not stop it.
    expect(r.operator.commands).toEqual([]);
    expect(await audits(r.page.pageId)).toEqual([expect.objectContaining({ from: "node", to: "browser", changed: true, prepare: false })]);
  }, 90_000);

  it("browser → node: the request in flight finishes in the browser; the operator stops the page; Node's first send is ≥ 1.2 × S later", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    // The page runs on its browser, whose session the engine trusts.
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    const browserTrusted = await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A);
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1", [r.page.pageId, browserTrusted]);
    const host = await startHost(r);
    await until(async () => r.operator.physical.length >= 2, 20_000, "the page running on its browser");
    const g1 = (host.state(r.page.pageId) as { generation: bigint }).generation;
    expect(r.server.arrivals).toEqual([]);

    // The browser holds the next request 1.5 s after its grant: in flight.
    r.operator.sendDelayMs = 1_500;
    const sent = r.operator.physical.length;
    const granted = r.operator.checkResults.filter((result) => result.admit).length;
    await until(async () => r.operator.checkResults.filter((result) => result.admit).length > granted, 10_000, "a request granted");
    expect(r.operator.physical.length).toBe(sent);
    const inFlight = r.operator.checkResults.filter((result) => result.admit).at(-1)!.attemptId;
    await changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" });
    const grantsAtSwitch = r.operator.checkResults.filter((result) => result.admit).length;
    const browserAdmissionsAtSwitch = (await attempts(r.page.pageId)).filter((row) => row.generation === g1.toString()).length;

    // The leave first (its own generation: the operator stops the page, what
    // it kept is taken), then Node: the verify of the stored session (the
    // trusted digest is the browser's), then the polls.
    await until(async () => r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page running on Node");
    const leaveGeneration = g1 + 1n;
    const g2 = g1 + 2n;
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "running", generation: g2 });
    expect(await leftBy(r.page.pageId)).toEqual({ by: "operator", generation: leaveGeneration.toString(), pending: null });

    const rows = await attempts(r.page.pageId);
    // No admission and no grant of the browser after the switch; the one in
    // flight went and was committed with the instant the browser reported.
    expect(rows.filter((row) => row.generation === g1.toString())).toHaveLength(browserAdmissionsAtSwitch);
    expect(r.operator.checkResults.filter((result) => result.admit)).toHaveLength(grantsAtSwitch);
    const inFlightRow = rows.find((row) => row.id === inFlight)!;
    expect(inFlightRow).toMatchObject({ generation: g1.toString(), outcome: "response", sendMark: "transport_reported" });
    expect(r.operator.physical.map((request) => request.attemptId)).toContain(inFlight);
    // The operator was told to stop the page, by the leave, after the
    // request in flight.
    expect(r.operator.commands.map((command) => command.command.kind)).toEqual(["stopPage"]);
    expect(r.operator.commands[0]!.ownerGeneration).toBe(Number(leaveGeneration));
    expect(r.operator.state).toMatchObject({ stopReason: "owner_stop", exitOpen: false });
    const lastBrowser = sendsOf(rows, g1).at(-1)!;
    expect(lastBrowser.id).toBe(inFlight);
    const nodeSends = sendsOf(rows, g2);
    expect(nodeSends[0]!.resource).toBe("account.verify");
    expect(marksOf(nodeSends)).toEqual(["request_start"]);
    expect(nodeSends[0]!.sentAt!.getTime() - lastBrowser.sentAt!.getTime()).toBeGreaterThanOrEqual(1.2 * FLOOR_S);
    expect(await trusted(r.page.pageId)).toBe(await nodeGeneration(r.page));
  }, 90_000);

  it("an admission of the sender the page left commits nothing: the admission's lock checks the page's transport", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const lock = (transport?: "node" | "browser") => db().transaction(async (raw) => lockOwnedPage(raw as unknown as Database, {
      pageId: r.page.pageId, generation: 0n, lock: "no_key_update", live: true, ...(transport === undefined ? {} : { transport }),
    }));
    await expect(lock("node")).resolves.toMatchObject({ mode: "live" });
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    const refused = await lock("node").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LiveGateClosedError);
    expect((refused as LiveGateClosedError).reason).toBe("transport");
    await expect(lock("browser")).resolves.toMatchObject({ mode: "live" });
    // Without a transport (no slot's sender named): as before.
    await expect(lock()).resolves.toMatchObject({ mode: "live" });
  }, 30_000);
});

describe("a page on its browser, which is not ready", () => {
  it("is not taken: no owner generation is spent on it, nothing is linked or sent; ready again, it runs", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    // The pin is gone: the hello has no settings to carry.
    await setPageBrowserSettings(db(), { profileId: r.profileId, pinnedExitIp: null });
    const owner = async () => (await testDb!.pool.query<{ generation: string; beat: Date | null }>(
      "select owner_generation::text as generation, owner_heartbeat_at as beat from sync_pages where page_id = $1", [r.page.pageId],
    )).rows[0]!;
    const before = await owner();
    const host = await startHost(r);
    await until(async () => host.state(r.page.pageId).kind === "waiting", 10_000, "the page waiting");
    // Longer than the host's retry (5 s): every try would have taken the page.
    await sleep(6_500);
    expect(host.state(r.page.pageId)).toMatchObject({ kind: "waiting", reason: "browser_not_ready" });
    // No owner beats (alert 1 after its bound), and nothing reached the operator or Fansly.
    expect(await owner()).toEqual(before);
    expect(r.operator.hellos).toEqual([]);
    expect(r.server.arrivals).toEqual([]);

    await setPageBrowserSettings(db(), { profileId: r.profileId, pinnedExitIp: "203.0.113.7" });
    await until(async () => r.operator.physical.length >= 1, 30_000, "the page running on its browser");
    expect(r.server.arrivals).toEqual([]);
  }, 90_000);
});

describe("sync ownership confirm-stopped waits for the browser pages' hand-over (plan §4.7)", () => {
  it("prints nothing more while every page is on Node; for a browser page, waits until its operator's quiesced for the current owner", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const printed: string[] = [];
    const cli = () => buildSyncEngineCommandGroup({
      openContext: async () => ({ db: db(), rawConfig: r.config, close: async () => undefined }),
      print: (line) => printed.push(line),
    });
    const confirm = (waitMs: number) => cli().parseAsync(
      ["ownership", "confirm-stopped", "--running-hosts", "sync-a,sync-b", "--quiesced-wait-ms", String(waitMs)], { from: "user" },
    );
    // Node pages only: the output is as it always was.
    await confirm(5_000);
    expect(printed).toEqual(["page\tgeneration\towner_host\tconfirmed"]);

    printed.length = 0;
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    let release!: () => void;
    r.operator.holdQuiesce = new Promise<void>((resolve) => (release = resolve));
    const host = await startHost(r);
    await until(async () => host.state(r.page.pageId).kind === "running", 10_000, "the browser page taken");
    const generation = (host.state(r.page.pageId) as { generation: bigint }).generation;
    // The operator has not answered the new owner yet: the wait runs out.
    const started = Date.now();
    await confirm(1_500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(printed.slice(1)).toEqual(["browser_page\towner_generation\tquiesced", `${r.page.pageLabel}\t${generation}\tfalse`]);
    expect(r.operator.sends).toEqual([]);

    printed.length = 0;
    setTimeout(release, 500);
    await confirm(10_000);
    expect(printed.slice(1)).toEqual(["browser_page\towner_generation\tquiesced", `${r.page.pageLabel}\t${generation}\ttrue`]);
  }, 60_000);
});

describe("the rollback of a page connected through its browser (owner decision №12)", () => {
  /** Another account's session: its `/account/me` is someone else. */
  const another: FakeRoute = (request) => (request.url.pathname === "/api/v1/account/me" && request.headers.authorization === "another-token"
    ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, response: { account: { id: "399999999999999999", username: "someone-else", displayName: null, createdAt: 0, followCount: 0, subscriberCount: 0 } } }) }
    : null);

  it("Chrome down, no Node session: prepare, the identity check through Node by the owner's session, stored and trusted in one transaction", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig({ first: [another], session: null });
    // Connected through its browser: no Node session; its browser's session
    // is the trusted one. Chrome is down: the operator has no session, its
    // exit is closed.
    await testDb.pool.query("delete from page_credentials where platform_account_id = $1", [r.page.pageId]);
    await db().transaction(async (raw) => setSyncPageTransport(raw as unknown as Database, { pageId: r.page.pageId, to: "browser" }));
    await testDb.pool.query("update sync_pages set credentials_generation = $2 where page_id = $1",
      [r.page.pageId, await readBrowserCredentialsGeneration(db(), r.page.pageId, SESSION_A)]);
    r.operator.state = { ...r.operator.state, step: "exit_closed", stopReason: "chrome_crashed", exitOpen: false, sessionFingerprint: null };
    const host = await startHost(r);
    await until(async () => r.operator.links.includes(true), 10_000, "the link to the operator");
    await sleep(1_000);
    expect(r.operator.sends).toEqual([]);

    // Without --prepare there is no way back: nothing to send with on Node.
    await expect(changeSyncPageTransport(db(), { pageLabel: r.page.pageLabel, to: "node", prepare: false, actor: "test" }))
      .rejects.toBeInstanceOf(SyncOwnerLeverError);
    expect(await getSyncPageTransport(db(), r.page.pageId)).toBe("browser");

    // Prepare, through the owner's CLI (audited).
    const printed: string[] = [];
    const cli = buildSyncEngineCommandGroup({
      openContext: async () => ({ db: db(), rawConfig: r.config, close: async () => undefined }),
      print: (line) => printed.push(line),
    });
    await cli.parseAsync(["page", "transport", r.page.pageLabel, "node", "--prepare", "--note", "rollback drill"], { from: "user" });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ page: r.page.pageLabel, from: "browser", to: "node", changed: true, prepared: { hold: "auth", refusedDigest: null } });
    expect(await audits(r.page.pageId)).toEqual([expect.objectContaining({ from: "browser", to: "node", prepare: true, note: "rollback drill" })]);
    expect(await credentialsHold(r.page.pageId)).toMatchObject({ kind: "auth", detail: { reason: "transport_prepare", credentialsGeneration: null } });
    // The browser slot ends: its operator stops the page (exit closed first).
    await until(async () => r.operator.commands.some((command) => command.command.kind === "stopPage"), 10_000, "the operator told to stop");
    const g1 = BigInt(r.operator.commands[0]!.ownerGeneration);
    await until(async () => host.state(r.page.pageId).kind === "running"
      && (host.state(r.page.pageId) as { generation: bigint }).generation === g1 + 1n, 10_000, "the page on Node");
    // Under the hold, with no session: nothing goes at all.
    await sleep(1_500);
    expect(r.server.arrivals).toEqual([]);

    const app: AppContext = createTestAppContext(testDb, { fanslySendGuardSettingMs: S });
    const page = { id: r.page.pageId, label: r.page.pageLabel };
    const storedSessions = async () => Number((await testDb!.pool.query<{ n: number }>(
      "select count(*)::int as n from page_credentials where platform_account_id = $1", [page.id])).rows[0]!.n);

    // Another account's session: refused, nothing stored, nothing trusted.
    const before = await trusted(page.id);
    await expect(updatePageCredentials(app, page.label, { platform: "fansly", session: session("another-token") })).rejects.toThrow(/identity mismatch/i);
    expect(r.identityTokens).toEqual(["another-token"]);
    expect(await storedSessions()).toBe(0);
    expect(await trusted(page.id)).toBe(before);

    // The owner's session, checked; the base it stood on moves before the
    // save (another proxy): nothing is stored, nothing trusted — one CAS.
    const checked = await checkFanslyIdentityThroughEngine(app, page, { session: session("owner-token") });
    expect(r.identityTokens.at(-1)).toBe("owner-token");
    const other = await CountingConnectProxy.start();
    cleanups.push(() => other.close());
    await saveProxy({ config: app.config, db: db() }, page.id, { url: other.url });
    const store = async (tx: Database) => {
      await storeFanslySession(tx, page.id, JSON.stringify(encryptJson(session("owner-token"), HARNESS_ENCRYPTION_KEY, 1)), 1);
    };
    await expect(saveVerifiedFanslyCredentials(app, page, checked, store)).rejects.toBeInstanceOf(FanslyCredentialsChangedError);
    expect(await storedSessions()).toBe(0);
    expect(await trusted(page.id)).toBe(before);

    // The owner's credentials change, as the dashboard sends it: the check
    // through Node by that session, then stored and trusted together.
    await expect(updatePageCredentials(app, page.label, { platform: "fansly", session: session("owner-token") }))
      .resolves.toMatchObject({ updated: true, verified: true });
    expect(r.identityTokens.filter((token) => token === "owner-token").length).toBeGreaterThanOrEqual(2);
    expect(await storedSessions()).toBe(1);
    expect(await trusted(page.id)).toBe(await nodeGeneration(r.page));
    // The verify of what is stored lifts the hold; ordinary work on Node.
    await until(async () => (await credentialsHold(page.id)) === null && r.server.arrivalsAt("/api/v1/polls").length >= 1, 30_000, "the page working on Node");
    expect(r.identityTokens.at(-1)).toBe("owner-token");
    expect(r.operator.sends).toEqual([]);
  }, 120_000);
});
