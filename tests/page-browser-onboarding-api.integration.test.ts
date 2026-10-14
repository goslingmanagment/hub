import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { bindOnboardedProfile, findOnboardingProfile, registerPageBrowserProfile, type Database } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { sealPageBrowserSecrets } from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { harnessConfig, until } from "./helpers/sync-engine.ts";

// The API of a new page's onboarding through its browser (Project Browser
// PR 16) on its own, against the real API on a test database — no engine (a
// closing onboarding stays `closing`), no operator (the screen is a fake
// KasmVNC): the owner's only, changes from the dashboard's own origin only,
// a profile no page has only; the proxy the container admits only; the
// browser's screen open only while its login is, closed before the login's
// closing is written and once the profile is bound.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };
const HOST = "hub.test";
const ORIGIN = `https://${HOST}`;

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
}, 60_000);

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function fakeScreen(): Promise<{ port: number; open: Set<Socket>; close: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server: Server = createHttpServer((_req, res) => void res.writeHead(200).end("kasm"));
  server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
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
    close: () => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function rig() {
  const config = harnessConfig(testDb!.connectionString);
  const profileId = randomUUID();
  await registerPageBrowserProfile(db(), {
    profileId,
    container: "page-browser-ari-2",
    ...sealPageBrowserSecrets(config, { engineToken: "engine-token-of-the-api-test-0123", apiToken: "api-token-of-the-api-test-4567", vncPassword: "vnc-password-of-the-api-test-89ab" }),
    socksEndpoint: "203.0.113.50:1080",
    env: ENV,
  });
  const screen = await fakeScreen();
  cleanups.push(screen.close);
  const app = createTestAppContext(testDb!, {
    pageBrowserEndpoints: { rpcUrl: () => "ws://127.0.0.1:9/rpc", screen: () => ({ host: "127.0.0.1", port: screen.port }) },
    pageBrowserScreenWatch: { everyMs: 100, deadlineMs: 1_000 },
    pageBrowserProxyTest: async () => "203.0.113.9",
  });
  await createUserAccount(app, { username: "owner-onb", role: "owner", password: "synthetic-password" }, { source: "cli" });
  await createUserAccount(app, { username: "lead-onb", role: "team_lead", password: "synthetic-password" }, { source: "cli" });
  const server = await buildApiServer(app);
  cleanups.push(() => server.close());
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const cookieOf = async (username: string) => {
    const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
    const header = response.headers["set-cookie"];
    return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
  };
  return { profileId, server, port: Number(new URL(address).port), screen, cookie: await cookieOf("owner-onb"), lead: await cookieOf("lead-onb") };
}

type Rig = Awaited<ReturnType<typeof rig>>;

function post(r: Rig, path: string, payload?: unknown, headers: Record<string, string> = { cookie: r.cookie, host: HOST, origin: ORIGIN }) {
  return r.server.inject({ method: "POST", url: `/api/v1/page-browser/profiles/${r.profileId}${path}`, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

async function openScreen(r: Rig): Promise<{ closed: () => boolean; echo: (text: string) => Promise<string> }> {
  let closed = false;
  let got = "";
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = tcpConnect({ host: "127.0.0.1", port: r.port }, () => {
      s.write(`GET /api/v1/page-browser/profiles/${r.profileId}/screen/websockify HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nOrigin: http://127.0.0.1:${r.port}\r\nCookie: ${r.cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
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
    closed: () => closed,
    echo: async (text) => {
      const before = got.length;
      socket.write(text);
      await until(async () => got.length > before || closed, 3_000, "the echo");
      return got.slice(before);
    },
  };
}

describe("a new page's onboarding through its browser, the API (PR 16)", () => {
  it("takes the owner's changes only, from the dashboard's own origin, of a profile no page has", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    expect((await post(r, "/pin", { ip: "203.0.113.9" }, { cookie: r.lead, host: HOST, origin: ORIGIN })).statusCode).toBe(403);
    expect((await post(r, "/pin", { ip: "203.0.113.9" }, { cookie: r.cookie, host: HOST })).json()).toMatchObject({ error: "cross_origin" });
    expect((await post(r, "/pin", { ip: "not-an-ip" })).statusCode).toBe(400);
    // Not ready: no proxy, no pin.
    expect((await post(r, "/login/start")).json()).toMatchObject({ error: "browser_not_ready" });
    // A proxy that is not the container's SOCKS5, or not a SOCKS5 at all.
    expect((await post(r, "/proxy", { proxy: { url: "socks5://203.0.113.51:1080", username: "u", password: "p" } })).json().message).toContain("was made for the SOCKS5 203.0.113.50:1080");
    expect((await post(r, "/proxy", { proxy: { url: "http://203.0.113.50:1080" } })).json().message).toContain("SOCKS5 proxy only");
    expect((await post(r, "/proxy", { proxy: { url: "socks5://203.0.113.50:1080", username: "u", password: "proxy-password-not-shown" } })).json()).toEqual({ exitIp: "203.0.113.9" });
    expect((await post(r, "/pin", { ip: "203.0.113.9" })).json()).toEqual({ pinnedExitIp: "203.0.113.9" });
    const view = await r.server.inject({ method: "GET", url: `/api/v1/page-browser/profiles/${r.profileId}`, headers: { cookie: r.cookie } });
    expect(view.json()).toMatchObject({ profile: { name: "ari-2", proxySet: true, pinnedExitIp: "203.0.113.9" }, proxy: { username: "u" }, browser: { ready: true }, login: { state: "off" }, identity: { pending: false, ok: null } });
    expect(view.body).not.toContain("proxy-password-not-shown");
    expect((await post(r, "/login/start")).json()).toEqual({ state: "login", changed: true });
    // The proxy does not change under an open login.
    expect((await post(r, "/proxy", { proxy: { url: "socks5://203.0.113.50:1080" } })).json()).toMatchObject({ error: "login_open" });
    // Given up; then bound: every lever of the profile is refused.
    expect((await post(r, "/close")).json()).toEqual({ state: "closing", changed: true });
    expect((await post(r, "/login/start")).json()).toMatchObject({ error: "onboarding_refused" });
    const model = await testDb.pool.query<{ id: string }>("insert into models (slug, name) values ('ari', 'Ari') returning id");
    const page = await testDb.pool.query<{ id: string }>("insert into pages (model_id, platform, label) values ($1, 'fansly', 'ari-2') returning id", [model.rows[0]!.id]);
    await testDb.pool.query("update page_browsers set onboarding = 'off' where profile_id = $1", [r.profileId]);
    await db().transaction(async (tx) => expect(await bindOnboardedProfile(tx as unknown as Database, { profileId: r.profileId, pageId: Number(page.rows[0]!.id) })).toBe(true));
    for (const path of ["/pin", "/login/start", "/login/finish", "/close"]) {
      expect((await post(r, path, path === "/pin" ? { ip: "203.0.113.9" } : undefined)).json(), path).toMatchObject({ error: "profile_bound" });
    }
    // A page's pin is not the onboarding's: untouched.
    expect((await findOnboardingProfile(db(), r.profileId))!.pinnedExitIp).toBe("203.0.113.9");
    // Bound: it is no longer listed.
    expect((await r.server.inject({ method: "GET", url: "/api/v1/page-browser/profiles", headers: { cookie: r.cookie } })).json()).toEqual({ profiles: [] });
  });

  it("opens the browser's screen only while its login is open, and closes it before the login's closing is written, and once bound", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await post(r, "/proxy", { proxy: { url: "socks5://203.0.113.50:1080" } });
    await post(r, "/pin", { ip: "203.0.113.9" });
    await expect(openScreen(r)).rejects.toThrow(/409/);
    await post(r, "/login/start");
    const screen = await openScreen(r);
    expect(await screen.echo("ping")).toBe("echo:ping");
    // The profile's row held: the closing cannot be written while it is —
    // and the screen is closed already.
    const holder = await testDb.pool.connect();
    await holder.query("begin");
    await holder.query("select 1 from page_browsers where profile_id = $1 for update", [r.profileId]);
    const finishing = post(r, "/login/finish");
    try {
      await until(async () => screen.closed() && r.screen.open.size === 0, 5_000, "the screen closed");
      expect((await findOnboardingProfile(db(), r.profileId))!.onboarding).toBe("login");
      await expect(openScreen(r)).rejects.toThrow(/409/);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect((await finishing).json()).toEqual({ state: "open", changed: true });
    await expect(openScreen(r)).rejects.toThrow(/409/);
    // Opened again; then the profile bound: the screen's own watch closes it.
    await post(r, "/login/start");
    const again = await openScreen(r);
    const model = await testDb.pool.query<{ id: string }>("insert into models (slug, name) values ('ari', 'Ari') returning id");
    const page = await testDb.pool.query<{ id: string }>("insert into pages (model_id, platform, label) values ($1, 'fansly', 'ari-2') returning id", [model.rows[0]!.id]);
    await testDb.pool.query("update page_browsers set onboarding = 'off' where profile_id = $1", [r.profileId]);
    await db().transaction(async (tx) => bindOnboardedProfile(tx as unknown as Database, { profileId: r.profileId, pageId: Number(page.rows[0]!.id) }));
    await until(async () => again.closed() && r.screen.open.size === 0, 5_000, "the screen closed once bound");
  }, 60_000);

  it("refuses the page's creation through the browser for a model that does not exist, a profile that is gone, or a label it was not made for — nothing bound", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const create = (payload: Record<string, unknown>) => r.server.inject({ method: "POST", url: "/api/v1/admin/pages", headers: { cookie: r.cookie }, payload: { platform: "fansly", ...payload } });
    expect((await create({ browserProfileId: r.profileId, modelSlug: "nope", label: "ari-2" })).statusCode).toBe(404);
    await testDb.pool.query("insert into models (slug, name) values ('ari', 'Ari')");
    expect((await create({ browserProfileId: randomUUID(), modelSlug: "ari", label: "ari-2" })).statusCode).toBe(404);
    expect((await create({ browserProfileId: r.profileId, modelSlug: "ari", label: "ari-3" })).json().message).toContain('its label must be "ari-2"');
    // The onboarding is not open: the account cannot be checked, nothing is created.
    expect((await create({ browserProfileId: r.profileId, modelSlug: "ari", label: "ari-2" })).json()).toMatchObject({ error: "browser_not_ready" });
    expect((await testDb.pool.query("select 1 from pages where label like 'ari-%'")).rows).toEqual([]);
    expect((await findOnboardingProfile(db(), r.profileId))!.pageId).toBeNull();
    // The Node path is the same as before: a pasted session needs its proxy.
    expect((await r.server.inject({ method: "POST", url: "/api/v1/admin/credentials/verify", headers: { cookie: r.cookie }, payload: { platform: "fansly", session: { authorization: "x" } } })).statusCode).toBe(400);
  });
});
