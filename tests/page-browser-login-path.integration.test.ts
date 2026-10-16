import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getSyncPageManualLogin, insertPageBrowser, setPageBrowserSettings, type Database } from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import { Operator } from "../apps/page-browser/src/operator/operator.ts";
import { forgetSecrets } from "../apps/page-browser/src/shared/secrets.ts";
import { setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { SyncEngineHost } from "../apps/runtime/src/sync/engine/host.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  BrowserModel,
  FakeChrome,
  FakeChromeControl,
  fakeIpify,
  FakeSocks,
  HolderUnderS6,
  RPC_TOKEN,
  SOCKS_PASSWORD,
  SOCKS_USER,
  tempDir,
  tlsLikeServer,
  until,
  writeExtensionPackage,
  writeNetSelftest,
} from "./helpers/page-browser-fakes.ts";
import { FakeLoginSite } from "./helpers/page-browser-login-site.ts";
import { linkSettings } from "./helpers/page-browser-operator.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  CountingConnectProxy,
  ensureHarnessSettingTable,
  FakeChats,
  FakeFanslyServer,
  HARNESS_OWN_REF,
  harnessConfig,
  harnessHostOptions,
  harnessIdentityRegistry,
  harnessRng,
  harnessRoutes,
  seedHarnessPage,
  until as eventually,
} from "./helpers/sync-engine.ts";

// The owner's login through the whole path (Project Browser plan §4.8; stage
// 3 PR 15), and the proof that what the owner types reaches the browser and
// nothing else: the dashboard's calls to the real API (its routes, its
// logger), the API's calls to the real operator (its RPC, journals, buffer,
// login desk) in front of a scripted Chrome with a fake Fansly login, the
// real engine (its host, the login driver, the site path of a page on Node)
// admitting the site's own login requests — all on one test database.
// Markers stand for the login, the password and the code: after the run,
// every table of the database, every line the API, the engine and the
// operator logged, every file of the operator's journals, buffer and state
// is searched for them. Only the browser holds them.
//
// And the browser's own screen (KasmVNC): HTTP and WebSocket passed to the
// container with the page's screen password, only under the owner's session
// and only while the login is open; the owner's cookie never goes there.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const S = 300;
const LOGIN_MARKER = "pb15-path-login-7c3e19";
const PASSWORD_MARKER = "pb15-path-password-5a9f02e1";
const WRONG_MARKER = "pb15-path-wrong-b81d44";
const CODE_MARKER = "604917";
const API_TOKEN = "api-token-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const VNC_PASSWORD = "vnc-password-of-the-path-test-2c8e";
const SITE_TOKEN = "fansly-token-PaThTeSt0123456789abc";
const SITE_CLIENT = "720167541418239555";
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const MARKERS = [LOGIN_MARKER, PASSWORD_MARKER, WRONG_MARKER, CODE_MARKER];
/** A wrong code from the e-mail of a new device's login. */
const WRONG_CODE_MARKER = "pb-email-wrong-code-6d2b";

let testDb: StartedTestDatabase | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setLogSink(null);
  forgetSecrets();
}, 90_000);

function db(): Database {
  return testDb!.db as unknown as Database;
}

/** A logger that keeps every line, whatever its level. */
function capturing(lines: string[]) {
  return createLogger("trace", new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  }));
}

/** KasmVNC as the API reaches it: basic authorization of its user `owner`,
 *  its web client's files, its WebSocket. What it was sent is kept. */
async function fakeScreen(): Promise<{ port: number; requests: Array<{ path: string; headers: IncomingMessage["headers"] }>; close: () => Promise<void> }> {
  const requests: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
  const expected = `Basic ${Buffer.from(`owner:${VNC_PASSWORD}`).toString("base64")}`;
  const server: Server = createHttpServer((req, res) => {
    requests.push({ path: req.url ?? "", headers: req.headers });
    if (req.headers.authorization !== expected) return void res.writeHead(401, { "www-authenticate": 'Basic realm="kasm"' }).end();
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "kasm=1" }).end("<html>kasm screen</html>");
  });
  const upgraded = new Set<Socket>();
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    upgraded.add(socket);
    socket.on("end", () => socket.destroy());
    socket.on("close", () => upgraded.delete(socket));
    requests.push({ path: req.url ?? "", headers: req.headers });
    if (req.headers.authorization !== expected) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Every file under `dir`, as bytes. */
function filesUnder(dir: string): Buffer[] {
  const out: Buffer[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...filesUnder(path));
    else if (stat.isFile()) out.push(readFileSync(path));
  }
  return out;
}

/** Every row of every table of the database, as text. */
async function everyRow(): Promise<string> {
  const tables = (await testDb!.pool.query<{ name: string }>(
    "select quote_ident(table_schema) || '.' || quote_ident(table_name) as name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE'",
  )).rows.map((row) => row.name);
  expect(tables.length).toBeGreaterThan(50);
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await testDb!.pool.query<{ row: string }>(`select row_to_json(t)::text as row from ${table} t`);
    parts.push(...rows.rows.map((row) => row.row));
  }
  return parts.join("\n");
}

interface Rig {
  operator: Operator;
  site: FakeLoginSite;
  model: BrowserModel;
  operatorLines: string[];
  operatorDir: string;
  rpcPort: number;
  page: { pageId: number; pageLabel: string };
  server: Awaited<ReturnType<typeof buildApiServer>>;
  cookie: string;
  leadCookie: string;
  apiLines: string[];
  engineLines: string[];
  screen: Awaited<ReturnType<typeof fakeScreen>>;
  fansly: FakeFanslyServer;
}

async function rig(): Promise<Rig> {
  // The browser: a scripted Chrome with Fansly's login behind the real operator.
  const temp = tempDir();
  cleanups.push(temp.remove);
  const operatorLines: string[] = [];
  setLogSink((line) => operatorLines.push(line));
  const chrome = new FakeChrome();
  await chrome.boot();
  await chrome.shutdown();
  cleanups.push(() => chrome.close());
  const model = new BrowserModel(chrome);
  const site = new FakeLoginSite(model, { login: LOGIN_MARKER, password: PASSWORD_MARKER, code: CODE_MARKER, token: SITE_TOKEN, clientId: SITE_CLIENT });
  const holder = new HolderUnderS6(join(temp.dir, "holder.sock"), chrome);
  await holder.start();
  cleanups.push(() => holder.stop());
  const socks = new FakeSocks(SOCKS_USER, SOCKS_PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const ipify = await fakeIpify(() => "203.0.113.7");
  cleanups.push(ipify.close);
  socks.routes.set("api.ipify.org:443", ipify.port);
  const apiHost = await tlsLikeServer();
  cleanups.push(apiHost.close);
  socks.routes.set("apiv3.fansly.com:443", apiHost.port);
  const control = new FakeChromeControl(chrome);
  const chromeEnv = join(temp.dir, "chrome-env");
  control.onStart = () => model.chromeStarts(chromeEnv);
  const netSelftest = join(temp.dir, "net-selftest.json");
  writeNetSelftest(netSelftest);
  const extensionDir = join(temp.dir, "extension");
  writeExtensionPackage(extensionDir);
  const operator = new Operator({
    config: {
      holderSock: holder.socketPath,
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      rpcHost: "127.0.0.1",
      rpcPort: 0,
      rpcToken: RPC_TOKEN,
      apiToken: API_TOKEN,
      netSelftestPath: netSelftest,
      chromeEnvPath: chromeEnv,
      logDir: join(temp.dir, "logs"),
      stateDir: join(temp.dir, "state"),
      bufferDir: join(temp.dir, "buffer"),
      extensionDir,
      heartbeatPath: join(temp.dir, "alive"),
      operatorVersion: "test",
    },
    chrome: control,
      display: async () => control.geometry,
    exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
    loginTimings: { settleMs: 3000, pollMs: 20 },
    timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
  });
  const ports = await operator.start();
  cleanups.push(() => operator.stop());
  model.proxyPort = ports.proxyPort;
  // A hang guard, not a speed check (a loaded CI machine).
  await until(() => operator.cdp.linked, 30_000, "the holder link");

  // The page on Node, with its browser's profile.
  const fansly = await FakeFanslyServer.start();
  const proxy = await CountingConnectProxy.start();
  cleanups.push(async () => {
    await fansly.close();
    await proxy.close();
  });
  for (const route of harnessRoutes(new FakeChats())) fansly.route(route);
  const label = `path-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: proxy.url, label });
  const config = harnessConfig(testDb!.connectionString, fansly.apiBaseUrl);
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config, { engineToken: RPC_TOKEN, apiToken: API_TOKEN, vncPassword: VNC_PASSWORD }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });

  // The engine: the page's host, linked to the real operator for the login.
  const engineLines: string[] = [];
  const host = new SyncEngineHost({
    ...harnessHostOptions({ db: db(), pool: testDb!.pool, connectionString: testDb!.connectionString, config, rng: harnessRng(15), registry: harnessIdentityRegistry(), logger: capturing(engineLines) }),
    browserOverrides: {
      url: () => `ws://127.0.0.1:${ports.rpcPort}/rpc`,
      settings: async (pageId) => linkSettings({ pageId, token: RPC_TOKEN, expectedAccountId: HARNESS_OWN_REF, socks5: { ip: "127.0.0.1", port: socks.port, username: SOCKS_USER, password: SOCKS_PASSWORD }, env: ENV }),
      rpcTiming: { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 },
      loginTiming: { everyMs: 100, commandWaitMs: 5_000, unreachableEndMs: 2_000, restartEveryMs: 1_000 },
    },
  });
  cleanups.push(() => host.stop());
  await host.start();

  // The API: its own logger kept, the page's browser at the operator and the screen.
  const screen = await fakeScreen();
  cleanups.push(screen.close);
  const apiLines: string[] = [];
  const app = createTestAppContext(testDb!, {
    logger: capturing(apiLines),
    pageBrowserEndpoints: { rpcUrl: () => `ws://127.0.0.1:${ports.rpcPort}/rpc`, screen: () => ({ host: "127.0.0.1", port: screen.port }) },
  });
  await createUserAccount(app, { username: "owner-pb15", role: "owner", password: "synthetic-password" }, { source: "cli" });
  await createUserAccount(app, { username: "lead-pb15", role: "team_lead", password: "synthetic-password" }, { source: "cli" });
  const server = await buildApiServer(app);
  cleanups.push(() => server.close());
  const cookieOf = async (username: string) => {
    const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
    const header = response.headers["set-cookie"];
    return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
  };
  return {
    operator, site, model, operatorLines, operatorDir: temp.dir, rpcPort: ports.rpcPort,
    page: { pageId: page.pageId, pageLabel: page.pageLabel }, server,
    cookie: await cookieOf("owner-pb15"), leadCookie: await cookieOf("lead-pb15"),
    apiLines, engineLines, screen, fansly,
  };
}

describe("the owner's login through the whole path (plan §4.8; PR 15)", () => {
  it("dashboard → API → operator → the site, its login under the engine's admission; then nothing typed anywhere but in the browser", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const base = `/api/v1/page-browser/pages/${r.page.pageLabel}/login`;
    // As the dashboard's own page asks: its cookie, its origin (item 7 of
    // Astra's review: a change from another origin is refused).
    const as = (cookie: string) => ({ cookie, host: "hub.test", origin: "https://hub.test" });
    await eventually(async () => r.fansly.arrivals.length >= 1, 60_000, "the page running on Node");

    // Only the owner: a lead is refused, nobody is refused.
    expect((await r.server.inject({ method: "GET", url: base, headers: as(r.leadCookie) })).statusCode).toBe(403);
    expect((await r.server.inject({ method: "GET", url: base })).statusCode).toBe(401);
    // Closed: no screen, no step, no screenshot.
    const closed = await r.server.inject({ method: "GET", url: base, headers: as(r.cookie) });
    expect(closed.json()).toMatchObject({ transport: "node", login: { state: "off" }, browser: { ready: true, problem: null, reachable: null }, screen: null });
    expect((await r.server.inject({ method: "POST", url: `${base}/submit`, headers: as(r.cookie), payload: { login: LOGIN_MARKER, password: PASSWORD_MARKER } })).json()).toMatchObject({ error: "login_not_open" });

    r.site.screen = "landing";
    // Open: the page paused, its browser into the manual login and started.
    expect((await r.server.inject({ method: "POST", url: `${base}/start`, headers: as(r.cookie) })).json()).toEqual({ state: "wanted", changed: true });
    await until(() => r.operator.page.step === "site_loaded" && r.operator.state.mode === "manual_login", 60_000, "the login screen up");
    r.site.setTab(r.operator.control.workTab!.sessionId);
    const shown = await r.server.inject({ method: "GET", url: base, headers: as(r.cookie) });
    expect(shown.json()).toMatchObject({ login: { state: "wanted" }, browser: { reachable: true }, screen: { screen: "landing", fields: [] }, refused: null });
    expect((await r.server.inject({ method: "POST", url: `${base}/open`, headers: as(r.leadCookie) })).statusCode).toBe(403);
    expect((await r.server.inject({ method: "POST", url: `${base}/open`, headers: { cookie: r.cookie, host: "hub.test", origin: "https://evil.test" } })).statusCode).toBe(403);
    expect((await r.server.inject({ method: "POST", url: `${base}/open`, headers: as(r.cookie) })).json()).toMatchObject({ screen: { screen: "login", fields: ["login", "password"] }, refused: null });
    expect(r.site.inserted).toEqual([]);
    expect(r.site.posts).toEqual([]);
    const shot = await r.server.inject({ method: "GET", url: `${base}/screenshot`, headers: as(r.cookie) });
    expect(shot.statusCode).toBe(200);
    expect(shot.headers["content-type"]).toBe("image/jpeg");
    expect(shot.headers["cache-control"]).toBe("private, no-store");
    expect(shot.rawPayload.toString()).toBe("FAKEJPEG:login");

    // A wrong password: the site's error. Then the login, then the code.
    const wrong = await r.server.inject({ method: "POST", url: `${base}/submit`, headers: as(r.cookie), payload: { login: LOGIN_MARKER, password: WRONG_MARKER } });
    expect(wrong.json()).toMatchObject({ screen: { screen: "error", siteError: "Invalid username or password" }, refused: null, unreachable: false });
    const submitted = await r.server.inject({ method: "POST", url: `${base}/submit`, headers: as(r.cookie), payload: { login: LOGIN_MARKER, password: PASSWORD_MARKER } });
    expect(submitted.json()).toMatchObject({ screen: { screen: "code", fields: ["code"] } });
    // A malformed one is refused without its value in the answer.
    const malformed = await r.server.inject({ method: "POST", url: `${base}/code`, headers: as(r.cookie), payload: { code: `${CODE_MARKER}\n${PASSWORD_MARKER}` } });
    expect(malformed.statusCode).toBe(400);
    const coded = await r.server.inject({ method: "POST", url: `${base}/code`, headers: as(r.cookie), payload: { code: CODE_MARKER } });
    expect(coded.json()).toMatchObject({ screen: { screen: "success", fields: [] } });
    // The site's own login requests went under the engine's admission.
    const logins = (await testDb.pool.query<{ path: string; origin: string; outcome: string }>(
      "select request->>'path' as path, origin, outcome from sync_attempts where page_id = $1 and origin = 'login' order by id", [r.page.pageId],
    )).rows;
    expect(logins.map((row) => row.path)).toEqual(["/api/v1/login", "/api/v1/login", "/api/v1/login/twofa"]);

    // The browser's screen: only the owner, only now; the screen password
    // in, the owner's cookie out, the screen's challenge never back.
    const address = await r.server.listen({ port: 0, host: "127.0.0.1" });
    const port = Number(new URL(address).port);
    const page = await new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: `/api/v1/page-browser/pages/${r.page.pageLabel}/screen/index.html?resize=remote`, headers: { cookie: r.cookie } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(page).toMatchObject({ status: 200, body: "<html>kasm screen</html>" });
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(r.screen.requests.at(-1)).toMatchObject({ path: "/index.html?resize=remote" });
    expect(r.screen.requests.at(-1)!.headers.cookie).toBeUndefined();
    const upgrade = (origin: string, cookie: string) => new Promise<string>((resolve) => {
      const socket = tcpConnect({ host: "127.0.0.1", port }, () => {
        socket.write(`GET /api/v1/page-browser/pages/${r.page.pageLabel}/screen/websockify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let got = "";
      socket.on("data", (data) => {
        got += data.toString();
        if (got.includes("\r\n\r\n") && !got.includes("echo:") && got.startsWith("HTTP/1.1 101")) socket.write("ping");
        if (got.includes("echo:ping") || !got.startsWith("HTTP/1.1 101")) {
          socket.destroy();
          resolve(got);
        }
      });
      socket.on("close", () => resolve(got));
      socket.on("error", () => resolve(got));
    });
    expect(await upgrade(`http://127.0.0.1:${port}`, r.cookie)).toContain("echo:ping");
    expect(r.screen.requests.at(-1)).toMatchObject({ path: "/websockify" });
    expect(r.screen.requests.at(-1)!.headers.cookie).toBeUndefined();
    expect(await upgrade("https://evil.example", r.cookie)).toMatch(/^HTTP\/1\.1 403/);
    expect(await upgrade(`http://127.0.0.1:${port}`, r.leadCookie)).toMatch(/^HTTP\/1\.1 403/);
    expect(await upgrade(`http://127.0.0.1:${port}`, "agency_hub_core_session=nope")).toMatch(/^HTTP\/1\.1 401/);

    // Closed: the browser stopped, the automation back, the page unpaused.
    expect((await r.server.inject({ method: "POST", url: `${base}/finish`, headers: as(r.cookie) })).json()).toEqual({ state: "ending", changed: true });
    await eventually(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 60_000, "the login closed");
    expect(await getSyncPageManualLogin(db(), r.page.pageId)).toMatchObject({ pausedAll: false });
    expect(r.operator.state).toMatchObject({ mode: "automation", step: "exit_closed", exitOpen: false, stopReason: "owner_stop" });
    // Closed: the screen is not the owner's any more.
    expect(await upgrade(`http://127.0.0.1:${port}`, r.cookie)).toMatch(/^HTTP\/1\.1 409/);

    // What was typed reached the browser…
    expect(r.site.inserted).toEqual([LOGIN_MARKER, WRONG_MARKER, LOGIN_MARKER, PASSWORD_MARKER, CODE_MARKER]);
    // …and nothing else: no row, no log line, no file of the operator.
    await r.operator.journals.flushed();
    await r.operator.buffer.flush();
    const rows = await everyRow();
    const files = filesUnder(r.operatorDir);
    expect(files.length).toBeGreaterThan(3);
    for (const marker of MARKERS) {
      expect(rows.includes(marker), `${marker} in the database`).toBe(false);
      expect(r.apiLines.join("").includes(marker), `${marker} in the API's log`).toBe(false);
      expect(r.engineLines.join("").includes(marker), `${marker} in the engine's log`).toBe(false);
      expect(r.operatorLines.join("\n").includes(marker), `${marker} in the operator's log`).toBe(false);
      for (const file of files) expect(file.includes(marker), `${marker} in a file of the operator`).toBe(false);
    }
    // The facts are there: the steps in the audit, the API's own lines.
    const audit = (await testDb.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'admin.page_browser_login' order by id",
    )).rows.map((row) => `${String(row.metadata.step)}:${String(row.metadata.screen ?? row.metadata.to)}`);
    expect(audit).toEqual(["open:wanted", "open_dialog:login", "submit:error", "submit:code", "code:success", "close:ending"]);
    expect(r.apiLines.length).toBeGreaterThan(0);
    expect(r.engineLines.join("")).toContain("Fansly sync browser login");
  }, 240_000);

  it("a login from a new device (owner decision 2026-10-15): the form asks for the code Fansly e-mailed, it goes as the site's own POST /login/twofa under the engine's admission — and nowhere else", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    r.site.newDevice = true;
    const base = `/api/v1/page-browser/pages/${r.page.pageLabel}/login`;
    const as = { cookie: r.cookie, host: "hub.test", origin: "https://hub.test" };
    await eventually(async () => r.fansly.arrivals.length >= 1, 60_000, "the page running on Node");

    expect((await r.server.inject({ method: "POST", url: `${base}/start`, headers: as })).json()).toEqual({ state: "wanted", changed: true });
    await until(() => r.operator.page.step === "site_loaded" && r.operator.state.mode === "manual_login", 60_000, "the login screen up");
    r.site.setTab(r.operator.control.workTab!.sessionId);
    const submitted = await r.server.inject({ method: "POST", url: `${base}/submit`, headers: as, payload: { login: LOGIN_MARKER, password: PASSWORD_MARKER } });
    expect(submitted.json()).toEqual({ screen: { screen: "code", screenVersion: "fansly-login/3", fields: ["code"], siteError: null, codeFrom: "email" }, refused: null, unreachable: false });
    // The login's page as the dashboard reads it says so too.
    expect((await r.server.inject({ method: "GET", url: base, headers: as })).json()).toMatchObject({ screen: { screen: "code", codeFrom: "email" } });
    // A wrong code: the site's error at the same form, still the e-mail's code.
    const wrong = await r.server.inject({ method: "POST", url: `${base}/code`, headers: as, payload: { code: WRONG_CODE_MARKER } });
    expect(wrong.json()).toMatchObject({ screen: { screen: "error", fields: ["code"], siteError: "Invalid code", codeFrom: "email" } });
    const coded = await r.server.inject({ method: "POST", url: `${base}/code`, headers: as, payload: { code: CODE_MARKER } });
    expect(coded.json()).toEqual({ screen: { screen: "success", screenVersion: "fansly-login/3", fields: [], siteError: null }, refused: null, unreachable: false });
    // The site's own login requests went under the engine's admission: the
    // e-mail's code by the 2FA code's operation, the manual login's only.
    const logins = (await testDb.pool.query<{ path: string; route: string }>(
      "select request->>'path' as path, operation as route from sync_attempts where page_id = $1 and origin = 'login' order by id", [r.page.pageId],
    )).rows;
    expect(logins).toEqual([{ path: "/api/v1/login", route: "auth.login" }, { path: "/api/v1/login/twofa", route: "auth.twofa" }, { path: "/api/v1/login/twofa", route: "auth.twofa" }]);

    expect((await r.server.inject({ method: "POST", url: `${base}/finish`, headers: as })).json()).toEqual({ state: "ending", changed: true });
    await eventually(async () => (await getSyncPageManualLogin(db(), r.page.pageId))?.value === "off", 60_000, "the login closed");
    expect(r.operator.state).toMatchObject({ mode: "automation" });

    // What was typed reached the browser — and nothing else.
    expect(r.site.inserted).toEqual([LOGIN_MARKER, PASSWORD_MARKER, WRONG_CODE_MARKER, CODE_MARKER]);
    await r.operator.journals.flushed();
    await r.operator.buffer.flush();
    const rows = await everyRow();
    const files = filesUnder(r.operatorDir);
    expect(files.length).toBeGreaterThan(3);
    for (const marker of [LOGIN_MARKER, PASSWORD_MARKER, CODE_MARKER, WRONG_CODE_MARKER]) {
      expect(rows.includes(marker), `${marker} in the database`).toBe(false);
      expect(r.apiLines.join("").includes(marker), `${marker} in the API's log`).toBe(false);
      expect(r.engineLines.join("").includes(marker), `${marker} in the engine's log`).toBe(false);
      expect(r.operatorLines.join("\n").includes(marker), `${marker} in the operator's log`).toBe(false);
      for (const file of files) expect(file.includes(marker), `${marker} in a file of the operator`).toBe(false);
    }
    // The facts are there: which code the screen asked for, in the audit.
    const audit = (await testDb.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'admin.page_browser_login' order by id",
    )).rows.map((row) => `${String(row.metadata.step)}:${String(row.metadata.screen ?? row.metadata.to)}${row.metadata.codeFrom === undefined ? "" : `:${String(row.metadata.codeFrom)}`}`);
    expect(audit).toEqual(["open:wanted", "submit:code:email", "code:error:email", "code:success", "close:ending"]);
  }, 240_000);
});
