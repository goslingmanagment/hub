import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Socket } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findOnboardingProfile, registerPageBrowserProfile, type Database } from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";

import { Operator } from "../apps/page-browser/src/operator/operator.ts";
import { forgetSecrets } from "../apps/page-browser/src/shared/secrets.ts";
import { setLogSink } from "../apps/page-browser/src/shared/util.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import { BrowserOnboardingTask } from "../apps/runtime/src/sync/fansly/browser-onboarding.ts";
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
import { createTestAppContext } from "./helpers/runtime.ts";
import { harnessConfig, until as eventually } from "./helpers/sync-engine.ts";

// A new page connected through its own browser, the whole path (Project
// Browser plan §3.2 «Подключение новой страницы через браузер»; stage 3 PR
// 16), and the proof that what the owner types reaches the browser and
// nothing else — PR 15's proof, on the onboarding's path: the dashboard's
// calls to the real API (its routes, its logger), the API's calls to the
// real operator (its RPC, journals, buffer, login desk) in front of a
// scripted Chrome with a fake Fansly login, the real onboarding link of the
// engine (the profile key: the site's login requests admitted and journaled
// without a page, the account read through the browser into observations),
// the page created and the profile bound — all on one test database.
// Markers stand for the login, the password, the code and the proxy's
// password: after the run, every table of the database, every line the API,
// the engine and the operator logged, every file of the operator's journals,
// buffer and state is searched for them.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const S = 300;
const LOGIN_MARKER = "pb16-path-login-3f8a21";
const PASSWORD_MARKER = "pb16-path-password-6d0c9e47";
const WRONG_MARKER = "pb16-path-wrong-a1f3c2";
const CODE_MARKER = "582093";
const API_TOKEN = "api-token-1a2b3c4d5e6f708192a3b4c5d6e7f809";
const VNC_PASSWORD = "vnc-password-of-the-onboarding-path-9d1f";
const SITE_TOKEN = "fansly-token-OnBoArDiNg0123456789xyz";
const SITE_CLIENT = "720167541418239777";
const ACCOUNT = "300000000000000916";
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const MARKERS = [LOGIN_MARKER, PASSWORD_MARKER, WRONG_MARKER, CODE_MARKER, SOCKS_PASSWORD];
const HOLDER = { host: "sync-path", pid: process.pid, pidStart: "1", pidNs: "ns", bootId: "boot", instance: randomUUID(), role: "sync" };

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

describe("a new page connected through its own browser, the whole path (plan §3.2; PR 16)", () => {
  it("dashboard → API → the browser's login under the engine's profile key → the account read through it → the page born bound; then nothing typed anywhere but in the browser", async (context) => {
    if (!testDb) return context.skip();
    // The browser: a scripted Chrome with Fansly's login behind the real operator.
    const temp = tempDir();
    cleanups.push(temp.remove);
    const operatorLines: string[] = [];
    setLogSink((line) => operatorLines.push(line));
    const chrome = new FakeChrome();
    await chrome.boot();
    await chrome.shutdown();
    cleanups.push(() => chrome.shutdown());
    const model = new BrowserModel(chrome);
    model.hubBody = Buffer.from(JSON.stringify({ success: true, response: { account: { id: ACCOUNT, username: "ari2", displayName: "Ari Two", createdAt: 0, followCount: 3, subscriberCount: 5 } } }));
    const site = new FakeLoginSite(model, { login: LOGIN_MARKER, password: PASSWORD_MARKER, code: CODE_MARKER, token: SITE_TOKEN, clientId: SITE_CLIENT, readsOnLoad: true });
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
      exitIpTarget: { host: "api.ipify.org", port: 443, path: "/", wrap: (socket: Socket) => socket },
      loginTimings: { settleMs: 3000, pollMs: 20 },
      timings: { replayWaitMs: 2000, chromeUpMs: 5000, attachMs: 3000, envCheckMs: 3000, stateEveryMs: 200, healthEveryMs: 100, healthAnswerMs: 300, selfTestProbeMs: 2000, exitIpTimeoutMs: 2000, quitWaitMs: 1000 },
    });
    const ports = await operator.start();
    cleanups.push(() => operator.stop());
    model.proxyPort = ports.proxyPort;
    await until(() => operator.cdp.linked, 3000, "the holder link");

    // The profile as add-profile registers it: a new page's, its page empty.
    const config = harnessConfig(testDb.connectionString, "https://apiv3.fansly.com/api/v1");
    const profileId = randomUUID();
    await registerPageBrowserProfile(db(), {
      profileId,
      container: "page-browser-ari-2",
      ...sealPageBrowserSecrets(config, { engineToken: RPC_TOKEN, apiToken: API_TOKEN, vncPassword: VNC_PASSWORD }),
      socksEndpoint: `127.0.0.1:${socks.port}`,
      env: ENV,
    });

    // The engine's onboarding task: the real settings (the proxy given in the
    // dashboard, the pin), the operator's RPC on this machine.
    const engineLines: string[] = [];
    const task = new BrowserOnboardingTask({
      db: db(),
      connectionString: testDb.connectionString,
      config,
      logger: capturing(engineLines),
      pause: { readSettingMs: async () => S },
      holder: HOLDER,
      overrides: {
        url: () => `ws://127.0.0.1:${ports.rpcPort}/rpc`,
        rpcTiming: { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 },
        timing: { everyMs: 100, driveEveryMs: 50, commandWaitMs: 5_000, unreachableEndMs: 2_000, restartEveryMs: 1_000, lockRetryMs: 200 },
        pacerFactory: (deps) => new Pacer({ ...deps, minSettingMs: S }),
        // The route budgets at a test's scale (auth.login 200 ms apart): the
        // owner's second try of the password comes within a second here.
        routeTimeScale: 0.05,
      },
    });
    cleanups.push(() => task.stop());
    task.start();

    // The API.
    const apiLines: string[] = [];
    const app = createTestAppContext(testDb, {
      fanslyBaseUrl: "https://apiv3.fansly.com/api/v1",
      logger: capturing(apiLines),
      pageBrowserEndpoints: { rpcUrl: () => `ws://127.0.0.1:${ports.rpcPort}/rpc`, screen: () => ({ host: "127.0.0.1", port: 1 }) },
      // The proxy test: the local SOCKS5 taken, the exit IP as api.ipify.org
      // would name it.
      pageBrowserProxyTest: async () => "203.0.113.7",
    });
    await createUserAccount(app, { username: "owner-pb16", role: "owner", password: "synthetic-password" }, { source: "cli" });
    await createUserAccount(app, { username: "lead-pb16", role: "team_lead", password: "synthetic-password" }, { source: "cli" });
    const server = await buildApiServer(app);
    cleanups.push(() => server.close());
    const cookieOf = async (username: string) => {
      const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
      const header = response.headers["set-cookie"];
      return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
    };
    const cookie = await cookieOf("owner-pb16");
    const leadCookie = await cookieOf("lead-pb16");
    const as = (who: string) => ({ cookie: who, host: "hub.test", origin: "https://hub.test" });
    const base = `/api/v1/page-browser/profiles/${profileId}`;
    await testDb.pool.query("insert into models (slug, name) values ('ari', 'Ari')");

    // The new profile, listed for the owner only.
    expect((await server.inject({ method: "GET", url: "/api/v1/page-browser/profiles", headers: as(leadCookie) })).statusCode).toBe(403);
    const listed = await server.inject({ method: "GET", url: "/api/v1/page-browser/profiles", headers: as(cookie) });
    expect(listed.json()).toMatchObject({ profiles: [{ profileId, name: "ari-2", onboarding: "off", proxySet: false, pinnedExitIp: null, envSet: true }] });
    // Its login is not open before a proxy and a pin.
    expect((await server.inject({ method: "POST", url: `${base}/login/start`, headers: as(cookie) })).json()).toMatchObject({ error: "browser_not_ready" });

    // The proxy: only the SOCKS5 its container admits; a change only from
    // the dashboard's own pages.
    const proxy = { url: `socks5://127.0.0.1:${socks.port}`, username: SOCKS_USER, password: SOCKS_PASSWORD };
    expect((await server.inject({ method: "POST", url: `${base}/proxy`, headers: { cookie, host: "hub.test", origin: "https://evil.example" }, payload: { proxy } })).statusCode).toBe(403);
    const other = await server.inject({ method: "POST", url: `${base}/proxy`, headers: as(cookie), payload: { proxy: { ...proxy, url: "socks5://127.0.0.1:1" } } });
    expect(other.statusCode).toBe(400);
    expect(other.json().message).toContain(`was made for the SOCKS5 127.0.0.1:${socks.port}`);
    expect((await server.inject({ method: "POST", url: `${base}/proxy`, headers: as(cookie), payload: { proxy } })).json()).toEqual({ exitIp: "203.0.113.7" });
    expect((await server.inject({ method: "POST", url: `${base}/pin`, headers: as(cookie), payload: { ip: "203.0.113.7" } })).json()).toEqual({ pinnedExitIp: "203.0.113.7" });

    // The login: the engine puts the browser into the manual login and starts it.
    expect((await server.inject({ method: "POST", url: `${base}/login/start`, headers: as(cookie) })).json()).toEqual({ state: "login", changed: true });
    await until(() => operator.page.step === "site_loaded" && operator.state.mode === "manual_login", 20_000, "the login screen up");
    site.setTab(operator.control.workTab!.sessionId);
    // The browser's own word: its exit through the pinned IP, its self-test.
    await eventually(async () => (await findOnboardingProfile(db(), profileId))!.exitIp === "203.0.113.7", 10_000, "the exit IP recorded");
    const shown = await server.inject({ method: "GET", url: base, headers: as(cookie) });
    expect(shown.json()).toMatchObject({
      profile: { onboarding: "login", proxySet: true, pinnedExitIp: "203.0.113.7", operator: { exitIp: "203.0.113.7", exitOpen: true, mode: "manual_login", selfTest: { ok: true } } },
      proxy: { url: `socks5://127.0.0.1:${socks.port}`, username: SOCKS_USER },
      login: { state: "login" },
      browser: { ready: true, problem: null, reachable: true },
      screen: { screen: "login", fields: ["login", "password"] },
    });
    expect(shown.body).not.toContain(SOCKS_PASSWORD);
    const shot = await server.inject({ method: "GET", url: `${base}/login/screenshot`, headers: as(cookie) });
    expect(shot.statusCode).toBe(200);
    expect(shot.rawPayload.toString()).toBe("FAKEJPEG:login");

    // A wrong password, then the login and the code.
    expect((await server.inject({ method: "POST", url: `${base}/login/submit`, headers: as(cookie), payload: { login: LOGIN_MARKER, password: WRONG_MARKER } })).json())
      .toMatchObject({ screen: { screen: "error", siteError: "Invalid username or password" } });
    expect((await server.inject({ method: "POST", url: `${base}/login/submit`, headers: as(cookie), payload: { login: LOGIN_MARKER, password: PASSWORD_MARKER } })).json())
      .toMatchObject({ screen: { screen: "code", fields: ["code"] } });
    expect((await server.inject({ method: "POST", url: `${base}/login/code`, headers: as(cookie), payload: { code: CODE_MARKER } })).json())
      .toMatchObject({ screen: { screen: "success", fields: [] } });
    // The site's own login requests: admitted one at a time by the profile
    // key, journaled without a page.
    await eventually(async () => (await testDb!.pool.query("select 1 from fansly_send_log where browser_profile_id = $1 and operation like 'site:%' and completed_at is not null", [profileId])).rows.length >= 1, 10_000, "the site's read after the login");
    const sends = (await testDb.pool.query<{ page_id: string | null; source: string; operation: string; outcome: string }>(
      "select page_id, source, operation, outcome from fansly_send_log where browser_profile_id = $1 order by id", [profileId],
    )).rows;
    expect(sends.filter((row) => row.operation.startsWith("login:")).map((row) => row.operation)).toEqual(["login:auth.login", "login:auth.login", "login:auth.twofa"]);
    expect(sends.every((row) => row.page_id === null && row.source === "onboarding")).toBe(true);

    // The account checked before the login is closed: refused.
    const tooEarly = await server.inject({ method: "POST", url: "/api/v1/admin/credentials/verify", headers: as(cookie), payload: { platform: "fansly", browserProfileId: profileId } });
    expect(tooEarly.json()).toMatchObject({ error: "onboarding_not_open" });
    // The login closed: the automation back.
    expect((await server.inject({ method: "POST", url: `${base}/login/finish`, headers: as(cookie) })).json()).toEqual({ state: "open", changed: true });
    await until(() => operator.state.mode === "automation" && operator.page.step === "site_loaded", 20_000, "the automation back at the site");

    // The owner's credentials check, through the browser.
    const verified = await server.inject({ method: "POST", url: "/api/v1/admin/credentials/verify", headers: as(cookie), payload: { platform: "fansly", browserProfileId: profileId } });
    expect(verified.json()).toEqual({ valid: true, platform: "fansly", username: "ari2", displayName: "Ari Two" });
    // A label the profile was not made for is refused; nothing is created.
    const wrongLabel = await server.inject({ method: "POST", url: "/api/v1/admin/pages", headers: as(cookie), payload: { platform: "fansly", browserProfileId: profileId, modelSlug: "ari", label: "ari-3" } });
    expect(wrongLabel.statusCode).toBe(400);
    expect((await testDb.pool.query("select 1 from pages where label = 'ari-3'")).rows).toEqual([]);

    // The page: created through the browser and bound.
    const created = await server.inject({ method: "POST", url: "/api/v1/admin/pages", headers: as(cookie), payload: { platform: "fansly", browserProfileId: profileId, modelSlug: "ari", label: "ari-2" } });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ page: { label: "ari-2" }, verified: true, syncQueued: true });
    const page = (await testDb.pool.query<{ id: string; platform_account_id: string | null }>("select id, external_page_id as platform_account_id from pages where label = 'ari-2'")).rows[0]!;
    expect(page.platform_account_id).toBe(ACCOUNT);
    const bound = (await findOnboardingProfile(db(), profileId))!;
    expect(bound).toMatchObject({ pageId: Number(page.id), onboarding: "off", proxy: null });
    const syncPage = (await testDb.pool.query<{ transport: string; credentials_generation: string | null; identity_account_id: string; mode: string }>(
      "select transport, credentials_generation, identity_account_id, mode from sync_pages where page_id = $1", [page.id],
    )).rows[0]!;
    expect(syncPage).toEqual({ transport: "browser", credentials_generation: null, identity_account_id: ACCOUNT, mode: "live" });
    // No session of the page in Hub; its proxy is the one given.
    expect((await testDb.pool.query("select 1 from page_credentials where platform_account_id = $1", [page.id])).rows).toEqual([]);
    expect((await testDb.pool.query<{ url: string }>("select url from egress_endpoints where platform_account_id = $1", [page.id])).rows[0]!.url).toBe(`socks5://127.0.0.1:${socks.port}`);
    // Two account reads through the browser (the check, the creation), each
    // journaled without a page and in observations.
    const identities = (await testDb.pool.query<{ source: string; operation: string; page_id: string | null }>(
      "select source, operation, page_id from fansly_send_log where browser_profile_id = $1 and operation = 'account_me' order by id", [profileId],
    )).rows;
    expect(identities).toEqual([{ source: "credentials_verify", operation: "account_me", page_id: null }, { source: "onboarding", operation: "account_me", page_id: null }]);
    expect((await testDb.pool.query("select 1 from observations where producer = 'fansly-onboarding:account.me' and native_account_ref = $1 and account_id is null", [ACCOUNT])).rows).toHaveLength(2);
    // The link to the profile closes once bound.
    await eventually(async () => !task.links.has(profileId), 10_000, "the onboarding link closed");
    // A bound profile is no onboarding's any more.
    expect((await server.inject({ method: "GET", url: base, headers: as(cookie) })).json()).toMatchObject({ error: "profile_bound" });

    // What was typed reached the browser…
    expect(site.inserted).toEqual([LOGIN_MARKER, WRONG_MARKER, LOGIN_MARKER, PASSWORD_MARKER, CODE_MARKER]);
    // …and nothing else: no row, no log line, no file of the operator.
    await operator.journals.flushed();
    await operator.buffer.flush();
    const rows = await everyRow();
    const files = filesUnder(temp.dir);
    expect(files.length).toBeGreaterThan(3);
    for (const marker of MARKERS) {
      expect(rows.includes(marker), `${marker} in the database`).toBe(false);
      expect(apiLines.join("").includes(marker), `${marker} in the API's log`).toBe(false);
      expect(engineLines.join("").includes(marker), `${marker} in the engine's log`).toBe(false);
      expect(operatorLines.join("\n").includes(marker), `${marker} in the operator's log`).toBe(false);
      for (const file of files) expect(file.includes(marker), `${marker} in a file of the operator`).toBe(false);
    }
    // Nor the tokens and the screen password in the clear.
    for (const secret of [RPC_TOKEN, API_TOKEN, VNC_PASSWORD]) expect(rows.includes(secret), "a browser secret in the database").toBe(false);
    // The facts are there: the steps in the audit.
    const audit = (await testDb.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'admin.page_browser_onboarding' order by id",
    )).rows.map((row) => `${String(row.metadata.step)}:${String(row.metadata.screen ?? row.metadata.to ?? "")}`);
    expect(audit).toEqual(["proxy:", "pin:", "open:login", "submit:error", "submit:code", "code:success", "close:open", "bind:"]);
    expect(engineLines.join("")).toContain("Fansly sync browser onboarding");
  }, 180_000);
});
