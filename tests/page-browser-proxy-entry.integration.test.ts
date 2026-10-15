import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { findOnboardingProfile, findPageBrowserDraft, type Database } from "@agency_hub_core/db";
import { createLogger, encryptJson } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { onboardingProxyOf } from "../apps/runtime/src/services/page-browser-onboarding.ts";
import { buildSyncBrowserProfileCommandGroup } from "../apps/runtime/src/sync/browser-profile-cli.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeSocks } from "./helpers/page-browser-fakes.ts";
import { fakeIpInfoService, GEOJS_BERLIN, IPINFO_BERLIN, localCheckOptions } from "./helpers/proxy-check-fakes.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { harnessConfig } from "./helpers/sync-engine.ts";

// A page's server browser started in the dashboard (Project Browser, owner
// decision 2026-10-15), against the real API and CLI on a test database: the
// owner pastes the proxy in one field (any common format), checks it through
// a local SOCKS5 test server — works or why not, its exit and place, the
// environment proposed —, confirms the environment and saves a draft; the
// CLI add-profile runs (`draft`, then `add --from-draft`) registers the
// profile from the draft and consumes it. The proxy's password is answered
// nowhere, stored only sealed, logged nowhere.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORD = "proxy-entry-password-5e1b77";
const USER = "user-zone-de";
const HOST = "hub.test";
const ORIGIN = `https://${HOST}`;
const ENV = { timeZone: "Europe/Berlin", languages: ["de-DE", "de", "en-US", "en"], geolocation: { latitude: 52.5244, longitude: 13.4105, accuracyM: 1000 } };

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

async function rig() {
  const socks = new FakeSocks(USER, PASSWORD);
  await socks.start();
  cleanups.push(() => socks.stop());
  const ipinfo = await fakeIpInfoService(() => ({ status: 200, body: IPINFO_BERLIN }));
  cleanups.push(ipinfo.close);
  const geojs = await fakeIpInfoService(() => ({ status: 200, body: GEOJS_BERLIN }));
  cleanups.push(geojs.close);
  const lines: string[] = [];
  const app = createTestAppContext(testDb!, {
    logger: createLogger("trace", new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } })),
    pageBrowserProxyCheck: { options: { ...localCheckOptions(socks, ipinfo, geojs), resolve: async () => "127.0.0.1" }, allowLoopback: true },
  });
  await createUserAccount(app, { username: "owner-entry", role: "owner", password: "synthetic-password" }, { source: "cli" });
  await createUserAccount(app, { username: "lead-entry", role: "team_lead", password: "synthetic-password" }, { source: "cli" });
  const server = await buildApiServer(app);
  cleanups.push(() => server.close());
  const cookieOf = async (username: string) => {
    const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
    const header = response.headers["set-cookie"];
    return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
  };
  const cookie = await cookieOf("owner-entry");
  const lead = await cookieOf("lead-entry");
  const as = (who: string) => ({ cookie: who, host: HOST, origin: ORIGIN });
  return { socks, ipinfo, app, server, lines, cookie, lead, as };
}

type Rig = Awaited<ReturnType<typeof rig>>;

const check = (r: Rig, source: Record<string, unknown>, who = r.cookie) =>
  r.server.inject({ method: "POST", url: "/api/v1/page-browser/proxy-check", headers: r.as(who), payload: { source } });
const save = (r: Rig, name: string, body: Record<string, unknown>, headers: Record<string, string> = r.as(r.cookie)) =>
  r.server.inject({ method: "PUT", url: `/api/v1/page-browser/drafts/${name}`, headers, payload: body });

/** A page Hub has, its proxy sealed as egress_endpoints keeps one. */
async function pageWithProxy(label: string, url: string, auth: { username: string; password: string } | null): Promise<number> {
  const config = harnessConfig(testDb!.connectionString);
  const model = await testDb!.pool.query<{ id: string }>("insert into models (slug, name) values ($1, $1) on conflict (slug) do update set name = excluded.name returning id", [`m-${label}`]);
  const page = await testDb!.pool.query<{ id: string }>("insert into pages (model_id, platform, label) values ($1, 'fansly', $2) returning id", [model.rows[0]!.id, label]);
  const sealed = auth === null ? null : JSON.stringify(encryptJson(auth, config.encryptionKey, config.encryptionKeyVersion));
  await testDb!.pool.query("insert into egress_endpoints (platform_account_id, url, encrypted_auth, key_version) values ($1, $2, $3, $4)", [page.rows[0]!.id, url, sealed, sealed === null ? null : config.encryptionKeyVersion]);
  return Number(page.rows[0]!.id);
}

function cli(printed: string[]) {
  const config = harnessConfig(testDb!.connectionString);
  return buildSyncBrowserProfileCommandGroup({
    openContext: async () => ({ db: db(), rawConfig: config, close: async () => undefined }),
    print: (line) => void printed.push(line),
    readStdin: async () => "engine-token-of-the-entry-test-0123\napi-token-of-the-entry-test-456789\nvnc-password-of-the-entry-test-ab\n",
    resolve: async () => "127.0.0.1",
  });
}

describe("a page's browser started in the dashboard (owner decision 2026-10-15)", () => {
  it("the owner's «Проверить прокси»: one pasted field in any format, through the proxy to the IP-info service — works, its exit and place, the environment proposed; why not, plainly; the password answered nowhere", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    // The owner's only, and from the dashboard's own pages.
    expect((await check(r, { kind: "text", proxy: { text: `127.0.0.1:${r.socks.port}:${USER}:${PASSWORD}` } }, r.lead)).statusCode).toBe(403);
    expect((await r.server.inject({ method: "POST", url: "/api/v1/page-browser/proxy-check", headers: { cookie: r.cookie, host: HOST }, payload: { source: { kind: "text", proxy: { text: "x" } } } })).json()).toMatchObject({ error: "cross_origin" });
    for (const text of [
      `127.0.0.1:${r.socks.port}:${USER}:${PASSWORD}`,
      `${USER}:${PASSWORD}:127.0.0.1:${r.socks.port}`,
      `socks5://${USER}:${PASSWORD}@127.0.0.1:${r.socks.port}`,
      `  ${USER}:${PASSWORD}@127.0.0.1:${r.socks.port}\n`,
    ]) {
      const answer = await check(r, { kind: "text", proxy: { text } });
      expect(answer.statusCode, text).toBe(200);
      expect(answer.json(), text).toMatchObject({
        ok: true,
        spoken: "socks5",
        proxy: { scheme: "socks5", host: "127.0.0.1", port: r.socks.port, username: USER, passwordSet: true },
        socksEndpoint: `127.0.0.1:${r.socks.port}`,
        exit: { ip: "203.0.113.7", countryCode: "DE", city: "Berlin", region: "Land Berlin", isp: "Example Mobile GmbH", asn: "AS64500", timeZone: "Europe/Berlin" },
        ipInfoService: "ipinfo.io",
        env: ENV,
      });
      expect(answer.body).not.toContain(PASSWORD);
    }
    // A wrong password; a pasted HTTP proxy whose port speaks SOCKS5; text
    // that does not read, or reads two ways.
    expect((await check(r, { kind: "text", proxy: { text: `127.0.0.1:${r.socks.port}:${USER}:wrong` } })).json()).toMatchObject({ ok: false, problem: { code: "wrong_login" }, spoken: "socks5", exit: null });
    expect((await check(r, { kind: "text", proxy: { text: `http://${USER}:${PASSWORD}@127.0.0.1:${r.socks.port}` } })).json()).toMatchObject({ ok: true, spoken: "socks5", proxy: { scheme: "http" } });
    expect((await check(r, { kind: "text", proxy: { text: "127.0.0.1" } })).json()).toMatchObject({ reason: "proxy_unreadable" });
    expect((await check(r, { kind: "text", proxy: { text: "gate.example.com:1080:john.doe:5555" } })).json()).toMatchObject({ reason: "proxy_ambiguous" });
    // IPv6: said before any connection.
    expect((await check(r, { kind: "text", proxy: { text: `[2001:db8::1]:1080:${USER}:${PASSWORD}` } })).json()).toMatchObject({ ok: false, problem: { code: "ipv6" }, spoken: null });
    // It reached the IP-info services only.
    expect(new Set(r.socks.connects)).toEqual(new Set(["ipinfo.io:443"]));
    expect(r.lines.join("")).not.toContain(PASSWORD);
  }, 60_000);

  it("a new page's draft: its proxy sealed, shown masked; refused for a proxy a page's browser cannot use, a bad environment, a name a page has; deleted by the owner", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const text = `127.0.0.1:${r.socks.port}:${USER}:${PASSWORD}`;
    expect((await save(r, "ari-2", { existingPage: false, proxy: { text }, env: ENV }, { cookie: r.lead, host: HOST, origin: ORIGIN })).statusCode).toBe(403);
    expect((await save(r, "ari-2", { existingPage: false, env: ENV })).json()).toMatchObject({ reason: "no_proxy" });
    expect((await save(r, "ari-2", { existingPage: false, proxy: { text: `http://${USER}:${PASSWORD}@127.0.0.1:8080` }, env: ENV })).json()).toMatchObject({ reason: "proxy_unusable" });
    expect((await save(r, "ari-2", { existingPage: false, proxy: { text }, env: { ...ENV, languages: ["de_DE"] } })).json()).toMatchObject({ reason: "env_invalid" });
    const saved = await save(r, "ari-2", { existingPage: false, proxy: { text }, env: ENV });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      name: "ari-2", page: null, revision: 1, env: ENV,
      proxy: { scheme: "socks5", host: "127.0.0.1", port: r.socks.port, username: USER, passwordSet: true },
      command: "scripts/deploy-page-browser.sh add-profile <host> --page ari-2 --image <образ>",
    });
    expect(saved.body).not.toContain(PASSWORD);
    // Saved again without a proxy: the one given stays; its revision moves.
    expect((await save(r, "ari-2", { existingPage: false, env: { ...ENV, timeZone: "Europe/Paris" } })).json()).toMatchObject({ revision: 2, env: { timeZone: "Europe/Paris" }, proxy: { passwordSet: true } });
    // Listed, and checked as stored.
    const listed = await r.server.inject({ method: "GET", url: "/api/v1/page-browser/drafts", headers: { cookie: r.cookie } });
    expect(listed.json()).toMatchObject({ drafts: [{ name: "ari-2", revision: 2 }], pages: [] });
    expect(listed.body).not.toContain(PASSWORD);
    expect((await check(r, { kind: "draft", name: "ari-2" })).json()).toMatchObject({ ok: true, exit: { ip: "203.0.113.7" } });
    // Sealed in the database, never in the clear.
    const row = (await testDb.pool.query<{ proxy_url: string; proxy_auth: string; proxy_key_version: number }>("select proxy_url, proxy_auth, proxy_key_version from page_browser_drafts where name = 'ari-2'")).rows[0]!;
    expect(row.proxy_url).toBe(`socks5://127.0.0.1:${r.socks.port}`);
    expect(row.proxy_auth).not.toContain(PASSWORD);
    expect(row.proxy_auth).not.toContain(USER);
    // A name a page has is that page's: refused.
    await pageWithProxy("ari-3", "socks5://203.0.113.60:1080", { username: "u", password: "p" });
    expect((await save(r, "ari-3", { existingPage: false, proxy: { text }, env: ENV })).statusCode).toBe(409);
    // Deleted.
    expect((await r.server.inject({ method: "DELETE", url: "/api/v1/page-browser/drafts/ari-2", headers: r.as(r.cookie) })).json()).toEqual({ deleted: true });
    expect(await findPageBrowserDraft(db(), "ari-2")).toBeNull();
    const audit = (await testDb.pool.query<{ metadata: Record<string, unknown> }>("select metadata from audit_events where event_type = 'admin.page_browser_onboarding' order by id")).rows.map((row) => row.metadata.step);
    expect(audit).toEqual(["draft", "draft", "draft_delete"]);
    expect(JSON.stringify((await testDb.pool.query("select metadata from audit_events")).rows)).not.toContain(PASSWORD);
  }, 60_000);

  it("an existing page that moves to its browser: its own proxy shown and checked, no proxy given; the draft refused for a page whose proxy is not SOCKS5", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    await pageWithProxy("lilly-1", `socks5://127.0.0.1:${r.socks.port}`, { username: USER, password: PASSWORD });
    await pageWithProxy("eva-1", "http://203.0.113.70:8080", { username: "u", password: "p" });
    const listed = await r.server.inject({ method: "GET", url: "/api/v1/page-browser/drafts", headers: { cookie: r.cookie } });
    expect(listed.json().pages).toEqual([
      { pageId: expect.any(Number), label: "eva-1", proxy: { scheme: "http", host: "203.0.113.70", port: 8080, username: "u", passwordSet: true } },
      { pageId: expect.any(Number), label: "lilly-1", proxy: { scheme: "socks5", host: "127.0.0.1", port: r.socks.port, username: USER, passwordSet: true } },
    ]);
    expect(listed.body).not.toContain(PASSWORD);
    expect((await check(r, { kind: "page", pageLabel: "lilly-1" })).json()).toMatchObject({ ok: true, exit: { ip: "203.0.113.7" }, env: ENV });
    expect((await save(r, "lilly-1", { existingPage: true, proxy: { text: "1.2.3.4:1080:u:p" }, env: ENV })).json()).toMatchObject({ reason: "proxy_of_page" });
    expect((await save(r, "eva-1", { existingPage: true, env: ENV })).json()).toMatchObject({ reason: "proxy_unusable" });
    expect((await save(r, "lilly-1", { existingPage: true, env: ENV })).json()).toMatchObject({
      name: "lilly-1", page: { label: "lilly-1" }, proxy: { host: "127.0.0.1", passwordSet: true },
      command: "scripts/deploy-page-browser.sh add-profile <host> --page lilly-1 --image <образ> --existing",
    });
  }, 60_000);

  it("add-profile's CLI: `draft` gives the SOCKS5's ip:port and the environment, no secret; `add --from-draft` registers the profile with the draft's proxy and consumes it — only the revision read, only the kind it is; PR 16's typed add refused while a draft stands", async (context) => {
    if (!testDb) return context.skip();
    const r = await rig();
    const text = `${USER}:${PASSWORD}@proxy.example.test:${r.socks.port}`;
    expect((await save(r, "ari-2", { existingPage: false, proxy: { text }, env: ENV })).statusCode).toBe(200);
    const printed: string[] = [];
    await cli(printed).parseAsync(["browser-profile", "draft", "--name", "ari-2"], { from: "user" });
    const drafted = JSON.parse(printed.at(-1)!);
    expect(drafted).toEqual({ name: "ari-2", existingPage: false, page: null, socks: `127.0.0.1:${r.socks.port}`, env: ENV, revision: 1 });
    expect(printed.join("")).not.toContain(PASSWORD);
    const add = (profileId: string, extra: string[], page: string[] = ["--new-page", "ari-2"]) => cli(printed).parseAsync([
      "browser-profile", "add", "--profile", profileId, "--container", "page-browser-ari-2", "--socks", drafted.socks, ...extra, "--secrets-stdin", ...page,
    ], { from: "user" });
    // PR 16's typed add: refused while the owner's draft stands.
    const typed = randomUUID();
    await expect(add(typed, ["--env", JSON.stringify(ENV)])).rejects.toThrow(/takes it from his draft/);
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ outcome: "refused" });
    // The draft changed since it was read: refused, nothing written.
    expect((await save(r, "ari-2", { existingPage: false, env: ENV })).json()).toMatchObject({ revision: 2 });
    const stale = randomUUID();
    await expect(add(stale, ["--from-draft", "ari-2", "--draft-revision", "1"])).rejects.toThrow(/changed the draft of ari-2 meanwhile/);
    expect(await findOnboardingProfile(db(), stale)).toBeNull();
    // As an existing page: the draft is a new page's.
    await expect(add(stale, ["--from-draft", "ari-2", "--draft-revision", "2"], ["--page", "ari-2"])).rejects.toThrow(/no active page ari-2/);
    // The revision read: registered with the draft's proxy, the draft gone.
    const profileId = randomUUID();
    await add(profileId, ["--from-draft", "ari-2", "--draft-revision", "2"]);
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ profileId, socksEndpoint: `127.0.0.1:${r.socks.port}`, boundTo: null, fromDraft: { name: "ari-2", revision: 2 } });
    const profile = (await findOnboardingProfile(db(), profileId))!;
    expect(profile).toMatchObject({ pageId: null, socksEndpoint: `127.0.0.1:${r.socks.port}`, env: ENV, proxy: { url: `socks5://proxy.example.test:${r.socks.port}` } });
    expect(onboardingProxyOf(r.app, profile)).toEqual({ url: `socks5://proxy.example.test:${r.socks.port}`, username: USER, password: PASSWORD });
    expect(await findPageBrowserDraft(db(), "ari-2")).toBeNull();
    // The profile's proxy is checked as given (`profile`).
    expect((await check(r, { kind: "profile", profileId })).json()).toMatchObject({ ok: true });
    // An existing page's draft binds its profile with the draft's environment.
    await pageWithProxy("lilly-1", `socks5://127.0.0.1:${r.socks.port}`, { username: USER, password: PASSWORD });
    expect((await save(r, "lilly-1", { existingPage: true, env: { ...ENV, timeZone: "Europe/Vienna" } })).statusCode).toBe(200);
    await cli(printed).parseAsync(["browser-profile", "draft", "--name", "lilly-1"], { from: "user" });
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ existingPage: true, page: "lilly-1", socks: `127.0.0.1:${r.socks.port}`, revision: 1 });
    const pilot = randomUUID();
    await cli(printed).parseAsync([
      "browser-profile", "add", "--profile", pilot, "--container", "page-browser-lilly-1", "--socks", `127.0.0.1:${r.socks.port}`,
      "--from-draft", "lilly-1", "--draft-revision", "1", "--secrets-stdin", "--page", "lilly-1",
    ], { from: "user" });
    expect(await findOnboardingProfile(db(), pilot)).toMatchObject({ proxy: null, env: { timeZone: "Europe/Vienna" }, pageId: expect.any(Number) });
    expect(await findPageBrowserDraft(db(), "lilly-1")).toBeNull();
    // Hub's draft for a name it has none of: what add-profile says.
    await expect(cli(printed).parseAsync(["browser-profile", "draft", "--name", "eva-1"], { from: "user" })).rejects.toThrow(/start it in the dashboard/);
    // The password nowhere but sealed.
    const everything = (await testDb.pool.query<{ row: string }>("select row_to_json(t)::text as row from page_browsers t union all select row_to_json(t)::text from audit_events t union all select row_to_json(t)::text from page_browser_drafts t")).rows.map((row) => row.row).join("\n");
    expect(everything).not.toContain(PASSWORD);
  }, 60_000);
});
