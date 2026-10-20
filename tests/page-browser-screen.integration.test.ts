import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getSyncPageManualLogin, insertPageBrowser, setPageBrowserSettings, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import type * as Auth from "../apps/runtime/src/services/auth.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { ensureHarnessSettingTable, harnessConfig, seedHarnessPage, until } from "./helpers/sync-engine.ts";

// The browser's own screen (KasmVNC) after it was opened, and the login's
// changes from another origin (Project Browser PR 15; Astra's review, items 2
// and 7), against the real API on a test database — no engine (a login the
// owner closes stays `ending`), no operator (the screen is a fake KasmVNC):
// - an open screen closes when the owner closes the login, before the
//   closing is written (the engine brings the automation back only once it
//   reads it), and none opens while it is written; and it closes when its
//   session is revoked or expired, or its login is no longer the open one;
// - each screen watches itself, without waiting on the database (Astra's
//   review, round 2): it closes at its session's expiry known when it
//   opened, and when a look of it does not answer by its deadline; a look
//   that stands does not hold back another screen's close;
// - a change of the login is taken only from a page of the API's own origin.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/** The sessions whose look never answers (the screen's revalidation read),
 *  and every session a look asked of. */
const looks = vi.hoisted(() => ({ stalled: new Set<string>(), asked: [] as string[] }));
vi.mock("../apps/runtime/src/services/auth.ts", async (importOriginal) => {
  const real = await importOriginal<typeof Auth>();
  return {
    ...real,
    ownerSessionExpiry: (app: Parameters<typeof real.ownerSessionExpiry>[0], token: string) => {
      looks.asked.push(token);
      return looks.stalled.has(token) ? new Promise<never>(() => undefined) : real.ownerSessionExpiry(app, token);
    },
  };
});

const S = 300;
const API_TOKEN = "api-token-screen-test-0f1e2d3c4b5a6978";
const VNC_PASSWORD = "vnc-password-of-the-screen-test-9d1a";
const RPC_TOKEN = "rpc-token-screen-test-a1b2c3d4e5f60718293a";
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const WATCH_MS = 100;
/** Hang guards, not speed checks (a loaded CI machine): one awaited event,
 *  and a test of several. */
const WAIT_MS = 30_000;
const LONG_TEST_MS = 120_000;

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
  looks.stalled.clear();
  looks.asked.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60_000);

function db(): Database {
  return testDb!.db as unknown as Database;
}

/** KasmVNC's WebSocket as the API reaches it: it echoes, and says when a
 *  connection of it closed. Like KasmVNC 1.5 it refuses a WebSocket with no
 *  `Origin` (404, "missing Sec-WebSocket-Origin header"; the pilot's first
 *  screen, 2026-10-15), and keeps the origins it was given. */
async function fakeScreen(): Promise<{ port: number; open: Set<Socket>; origins: string[]; close: () => Promise<void> }> {
  const open = new Set<Socket>();
  const origins: string[] = [];
  const server: Server = createHttpServer((_req, res) => void res.writeHead(200).end("kasm"));
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    const origin = req.headers.origin ?? req.headers["sec-websocket-origin"];
    if (typeof origin !== "string" || origin === "") {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    origins.push(origin);
    open.add(socket);
    socket.on("end", () => socket.destroy());
    socket.on("close", () => open.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data])));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    open,
    origins,
    close: () => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

interface Rig {
  pageId: number;
  label: string;
  server: Awaited<ReturnType<typeof buildApiServer>>;
  port: number;
  screen: Awaited<ReturnType<typeof fakeScreen>>;
  login(): Promise<string>;
}

async function rig(watch: { everyMs?: number; deadlineMs?: number } = {}): Promise<Rig> {
  const label = `screen-${randomUUID().slice(0, 8)}`;
  const page = await seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: "http://127.0.0.1:9", label });
  const config = harnessConfig(testDb!.connectionString, "http://127.0.0.1:9/api/v1");
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container: `page-browser-${label}`,
    pageId: page.pageId,
    ...sealPageBrowserSecrets(config, { engineToken: RPC_TOKEN, apiToken: API_TOKEN, vncPassword: VNC_PASSWORD }),
  });
  await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.7", env: ENV });
  const screen = await fakeScreen();
  cleanups.push(screen.close);
  const app = createTestAppContext(testDb!, {
    pageBrowserEndpoints: { rpcUrl: () => "ws://127.0.0.1:9/rpc", screen: () => ({ host: "127.0.0.1", port: screen.port }) },
    pageBrowserScreenWatch: { everyMs: WATCH_MS, deadlineMs: 1_000, ...watch },
  });
  await createUserAccount(app, { username: "owner-screen", role: "owner", password: "synthetic-password" }, { source: "cli" });
  const server = await buildApiServer(app);
  cleanups.push(() => server.close());
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  return {
    pageId: page.pageId,
    label: page.pageLabel,
    server,
    port: Number(new URL(address).port),
    screen,
    login: async () => {
      const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "owner-screen", password: "synthetic-password" } });
      const header = response.headers["set-cookie"];
      return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
    },
  };
}

const HOST = "hub.test";
const ORIGIN = `https://${HOST}`;

function change(r: Rig, cookie: string, what: "start" | "finish", origin: string | null = ORIGIN) {
  return r.server.inject({
    method: "POST",
    url: `/api/v1/page-browser/pages/${r.label}/login/${what}`,
    headers: { cookie, host: HOST, ...(origin === null ? {} : { origin }) },
  });
}

/** The screen's WebSocket opened by the owner's page; it echoes. */
async function openScreen(r: Rig, cookie: string): Promise<{ socket: Socket; closed: () => boolean; echo: (text: string) => Promise<string> }> {
  let closed = false;
  let got = "";
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = tcpConnect({ host: "127.0.0.1", port: r.port }, () => {
      s.write(`GET /api/v1/page-browser/pages/${r.label}/screen/websockify HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nOrigin: http://127.0.0.1:${r.port}\r\nCookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    s.on("data", (data) => {
      got += data.toString();
      if (got.startsWith("HTTP/1.1 101") && got.includes("\r\n\r\n")) resolve(s);
      else if (got.includes("\r\n\r\n")) reject(new Error(`no screen: ${got.split("\r\n")[0]}`));
    });
    s.on("close", () => (closed = true));
    s.on("error", () => undefined);
  });
  return {
    socket,
    closed: () => closed,
    echo: async (text) => {
      const before = got.length;
      socket.write(text);
      await until(async () => got.length > before || closed, WAIT_MS, "the echo");
      return got.slice(before);
    },
  };
}

describe("the browser's screen once open (Astra's review of PR 15, item 2)", () => {
  it("closes when its session is revoked or expired, or its login is no longer the open one", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const first = await r.login();
    const second = await r.login();
    const third = await r.login();
    expect((await change(r, first, "start")).json()).toMatchObject({ state: "wanted" });
    const revoked = await openScreen(r, first);
    const expired = await openScreen(r, second);
    const kept = await openScreen(r, third);
    expect(await revoked.echo("a")).toBe("echo:a");

    // The owner logs the first session out: its screen goes, the others stay.
    expect((await r.server.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: first, host: HOST, origin: ORIGIN } })).statusCode).toBeLessThan(300);
    await until(async () => revoked.closed(), WAIT_MS, "the revoked session's screen closed");
    expect(expired.closed()).toBe(false);
    // The second session expires.
    await testDb.pool.query("update auth_sessions set expires_at = now() - interval '1 second' where id = (select min(id) from auth_sessions where revoked_at is null)");
    await until(async () => expired.closed(), WAIT_MS, "the expired session's screen closed");
    expect(await kept.echo("b")).toBe("echo:b");
    // The login is closed by other means than the owner's form (the engine
    // ends only a closing one; here the row itself): the last screen goes.
    await testDb.pool.query("update sync_pages set manual_login = 'off', manual_login_changed_at = clock_timestamp() where page_id = $1", [r.pageId]);
    await until(async () => kept.closed() && r.screen.open.size === 0, WAIT_MS, "the last screen closed");
  }, LONG_TEST_MS);
});

describe("a change of the login from another origin (Astra's review of PR 15, item 7)", () => {
  it("is refused before anything is read: no Origin, another origin of the same site, `null`; the dashboard's own is taken", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const cookie = await r.login();
    for (const origin of [null, "https://evil.gosling-agency.ru", "null", `http://${HOST}.evil.example`, "https://hub.test:8443"]) {
      const refused = await change(r, cookie, "start", origin);
      expect(refused.statusCode, String(origin)).toBe(403);
      expect(refused.json(), String(origin)).toMatchObject({ error: "cross_origin" });
    }
    expect((await getSyncPageManualLogin(db(), r.pageId))?.value).toBe("off");
    const steps = [
      { url: "submit", payload: { login: "pb15-csrf-login", password: "pb15-csrf-password" } },
      { url: "code", payload: { code: "123456" } },
    ];
    for (const step of steps) {
      const refused = await r.server.inject({ method: "POST", url: `/api/v1/page-browser/pages/${r.label}/login/${step.url}`, headers: { cookie, host: HOST, origin: "https://evil.gosling-agency.ru" }, payload: step.payload });
      expect(refused.statusCode, step.url).toBe(403);
      expect(refused.json()).toMatchObject({ error: "cross_origin" });
    }
    expect((await change(r, cookie, "start")).json()).toEqual({ state: "wanted", changed: true });
    expect((await change(r, cookie, "finish", "https://evil.gosling-agency.ru")).statusCode).toBe(403);
    expect((await getSyncPageManualLogin(db(), r.pageId))?.value).toBe("wanted");
    expect((await change(r, cookie, "finish")).json()).toEqual({ state: "ending", changed: true });
  }, LONG_TEST_MS);
});
