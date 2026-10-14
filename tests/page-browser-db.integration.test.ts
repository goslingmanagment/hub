import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertBrowserLeft,
  bindPageBrowser,
  clearPageBrowserUndrained,
  confirmBrowserLeave,
  getSyncPageBrowserLeave,
  listSyncPageSenders,
  lockOwnedPage,
  markPageBrowserUndrained,
  findPageBrowser,
  findPageBrowserByPage,
  getSyncPageTransport,
  insertObservation,
  insertPageBrowser,
  insertSiteAdmission,
  listSyncPageTransports,
  pageBrowserEnvOf,
  recordPageBrowserHandover,
  recordPageBrowserLinkError,
  recordPageBrowserState,
  setPageBrowserSettings,
  setSyncPageTransport,
  storeProxyConfig,
  type Database,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import {
  openPageBrowserSecret,
  PageBrowserNotConfiguredError,
  pageBrowserRpcUrl,
  readPageBrowserLinkRevision,
  readPageBrowserLinkSettings,
  sealPageBrowserSecrets,
} from "../apps/runtime/src/services/egress/page-browser-link.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { runRollbackBrowserGate } from "./helpers/deploy-browser-rollback-gate.ts";
import { HARNESS_ENCRYPTION_KEY, HARNESS_OWN_REF, harnessConfig, seedHarnessPage } from "./helpers/sync-engine.ts";

// The data of PR 12 (Project Browser plan §3.4; 0272–0275): send_mark's
// `transport_reported` and the operator's request id on sync_attempts, the
// observation source `browser_site`, the page_browsers table with its
// sealed secrets, and the hello's settings read from them. And of PR 14
// (0277): a page's transport and the operator's word on a hand-over.

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

const config = () => harnessConfig(testDb!.connectionString);
const ENV = { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } };

async function page(label: string, proxyUrl: string | null = "socks5://127.0.0.1:1080") {
  return seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl, label });
}

async function profile(pageId: number | null, container = `page-browser-${randomUUID().slice(0, 8)}`) {
  const profileId = randomUUID();
  await insertPageBrowser(db(), {
    profileId,
    container,
    pageId,
    ...sealPageBrowserSecrets(config(), { engineToken: "engine-token", apiToken: "api-token", vncPassword: "vnc-password" }),
  });
  return profileId;
}

describe("sync_attempts (0272)", () => {
  it("takes send_mark 'transport_reported' and no unknown mark; a site admission keeps the operator's request id", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("attempts-page");
    await testDb.pool.query("update sync_pages set owner_generation = 1 where page_id = $1", [pageId]);
    const siteRequestId = randomUUID();
    const admitted = await insertSiteAdmission(db(), {
      pageId,
      generation: 1n,
      origin: "site",
      operation: "site.other",
      request: { method: "GET", host: "api", path: "/api/v1/x", siteRequestId },
      browserRequestId: siteRequestId,
      settingMs: 2_500,
      jitterU: 0.1,
      pauseMs: 2_750,
    });
    const stored = await testDb.pool.query("select browser_request_id from sync_attempts where id = $1", [admitted.attemptId]);
    expect(stored.rows[0]).toEqual({ browser_request_id: siteRequestId });
    await testDb.pool.query("update sync_attempts set outcome = 'response', sent_at = clock_timestamp(), send_mark = 'transport_reported' where id = $1", [admitted.attemptId]);
    await expect(testDb.pool.query("update sync_attempts set send_mark = 'browser_guess' where id = $1", [admitted.attemptId]))
      .rejects.toThrow(/sync_attempts_send_mark_check/);
    const constraint = await testDb.pool.query("select convalidated from pg_constraint where conname = 'sync_attempts_send_mark_check'");
    expect(constraint.rows[0]).toEqual({ convalidated: true });
  });
});

describe("observations.source (0274)", () => {
  it("takes 'browser_site' and still refuses an unknown source", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("observations-page");
    const payload = { success: true, response: [] };
    const inserted = await insertObservation(db(), {
      source: "browser_site",
      producer: "fansly-site:site.other",
      platform: "fansly",
      accountId: pageId,
      nativeAccountRef: HARNESS_OWN_REF,
      kind: "fansly.site.site.other",
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `fansly-site:${pageId}:${randomUUID()}:1`,
    });
    expect(inserted.observationId).toBeGreaterThan(0);
    await expect(testDb.pool.query(
      `insert into observations (source, producer, platform, account_id, kind, payload, payload_hash, idempotency_key, received_at)
       values ('chrome_guess', 'x', 'fansly', $1, 'k', '{}'::jsonb, '\\x00', $2, now())`,
      [pageId, randomUUID()],
    )).rejects.toThrow(/observations_source_check/);
  });
});

describe("page_browsers (0275)", () => {
  it("keeps a profile's container, its page, the operator's last state and its sealed secrets", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("profile-page");
    const profileId = await profile(null, "page-browser-profile-page");
    expect(await findPageBrowserByPage(db(), pageId)).toBeNull();
    expect(await bindPageBrowser(db(), { profileId, pageId })).toBe(true);
    const bound = (await findPageBrowserByPage(db(), pageId))!;
    expect(bound).toMatchObject({ profileId, pageId, container: "page-browser-profile-page", mode: "automation", step: null, linkError: null });
    // Sealed, never stored in the clear; opened with the process's keys.
    expect(bound.encryptedEngineToken).not.toContain("engine-token");
    expect(openPageBrowserSecret(config(), bound.encryptedEngineToken)).toBe("engine-token");
    expect(openPageBrowserSecret(config(), bound.encryptedApiToken)).toBe("api-token");
    expect(openPageBrowserSecret(config(), bound.encryptedVncPassword)).toBe("vnc-password");

    const fingerprint = "c".repeat(64);
    await recordPageBrowserState(db(), {
      profileId,
      step: "exit_open",
      stopReason: null,
      mode: "manual_login",
      exitOpen: true,
      sessionFingerprint: fingerprint,
      accountId: HARNESS_OWN_REF,
      exitIp: "203.0.113.7",
      chromeVersion: "155.0.0.0",
      operatorVersion: "1",
      selfTest: { ok: true, at: new Date("2026-10-13T10:00:00Z"), failed: null },
      buffer: { bytes: 4096, oldestAgeMs: 1500 },
    });
    await recordPageBrowserLinkError(db(), { profileId, linkError: "protocol_version" });
    const recorded = (await findPageBrowser(db(), profileId))!;
    expect(recorded).toMatchObject({
      step: "exit_open", mode: "manual_login", exitOpen: true, sessionFingerprint: fingerprint, selftestOk: true,
      bufferBytes: 4096, bufferOldestAgeMs: 1500, linkError: "protocol_version",
    });
    expect(recorded.lastStateAt).toBeInstanceOf(Date);
    expect(recorded.selftestAt?.toISOString()).toBe("2026-10-13T10:00:00.000Z");
  });

  it("one profile a page, one container a profile; checks on the container, the mode and the fingerprint", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("unique-page");
    await profile(pageId, "page-browser-unique");
    // Through the query builder: the database's error is the cause.
    await expect(profile(pageId)).rejects.toMatchObject({ cause: { constraint: "page_browsers_page_key" } });
    await expect(profile(null, "page-browser-unique")).rejects.toMatchObject({ cause: { constraint: "page_browsers_container_key" } });
    await expect(profile(null, "Not A Container")).rejects.toMatchObject({ cause: { constraint: "page_browsers_container_check" } });
    const other = await profile(null);
    await expect(testDb.pool.query("update page_browsers set mode = 'puppet' where profile_id = $1", [other])).rejects.toThrow(/page_browsers_mode_check/);
    await expect(testDb.pool.query("update page_browsers set session_fingerprint = 'token' where profile_id = $1", [other])).rejects.toThrow(/page_browsers_fingerprint_check/);
  });
});

describe("the hello's settings (services/egress/page-browser-link.ts)", () => {
  it("reads the page's token, account and SOCKS5 (its auth opened, its host resolved to an IP)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("hello-page", null);
    await storeProxyConfig(db(), pageId, {
      url: "socks5://proxy.example.test:1085",
      encryptedAuth: JSON.stringify(encryptJson({ username: "u-1", password: "p-1" }, HARNESS_ENCRYPTION_KEY, 1)),
      keyVersion: 1,
    });
    await profile(pageId, "page-browser-hello-page");
    const resolved: string[] = [];
    const settings = await readPageBrowserLinkSettings({ db: db(), config: config() }, pageId, { pinnedExitIp: "203.0.113.9", env: ENV }, {
      resolve: async (host) => {
        resolved.push(host);
        return "192.0.2.10";
      },
    });
    expect(resolved).toEqual(["proxy.example.test"]);
    expect(settings).toEqual({
      token: "engine-token",
      pageId,
      expectedAccountId: HARNESS_OWN_REF,
      pinnedExitIp: "203.0.113.9",
      socks5: { ip: "192.0.2.10", port: 1085, username: "u-1", password: "p-1" },
      env: ENV,
    });
    expect(pageBrowserRpcUrl("page-browser-hello-page")).toBe("ws://page-browser-hello-page:7700/rpc");
    expect(() => pageBrowserRpcUrl("evil host/")).toThrow();
  });

  it("the settings' revision moves with the stored rows, not with what the proxy's name resolves to", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("revision-page", "socks5://proxy.example.test:1085");
    await profile(pageId, "page-browser-revision-page");
    const settings = { pinnedExitIp: "203.0.113.9", env: ENV };
    const first = await readPageBrowserLinkRevision({ db: db() }, pageId, settings);
    expect(await readPageBrowserLinkRevision({ db: db() }, pageId, settings)).toBe(first);
    await storeProxyConfig(db(), pageId, { url: "socks5://proxy.example.test:1086", encryptedAuth: null, keyVersion: null });
    const moved = await readPageBrowserLinkRevision({ db: db() }, pageId, settings);
    expect(moved).not.toBe(first);
    expect(await readPageBrowserLinkRevision({ db: db() }, pageId, { ...settings, pinnedExitIp: "203.0.113.10" })).not.toBe(moved);
  });

  it("refuses a page without a browser profile or with a proxy that is not SOCKS5", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("refused-page", "http://127.0.0.1:3128");
    const read = () => readPageBrowserLinkSettings({ db: db(), config: config() }, pageId, { pinnedExitIp: "203.0.113.9", env: ENV });
    await expect(read()).rejects.toBeInstanceOf(PageBrowserNotConfiguredError);
    await profile(pageId);
    await expect(read()).rejects.toThrow(/not a SOCKS5/);
  });
});

describe("sync_pages.transport and the hand-over mark (0277)", () => {
  it("every page is on node until the lever says otherwise; the change is made under the page's row lock and wakes its actor", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("transport-page");
    expect(await getSyncPageTransport(db(), pageId)).toBe("node");
    expect([...(await listSyncPageTransports(db())).values()]).toEqual(["node"]);

    const listener = await testDb.pool.connect();
    const woken: string[] = [];
    try {
      await listener.query("listen fansly_sync_work");
      listener.on("notification", (message) => woken.push(message.payload ?? ""));
      const changed = await db().transaction(async (tx) => setSyncPageTransport(tx as unknown as Database, { pageId, to: "browser" }));
      expect(changed).toEqual({ kind: "changed", from: "node", to: "browser", leave: null });
      expect(await getSyncPageTransport(db(), pageId)).toBe("browser");
      expect(await listSyncPageTransports(db())).toEqual(new Map([[pageId, "browser"]]));
      await expect.poll(() => woken).toContain(String(pageId));
    } finally {
      listener.release();
    }

    expect(await db().transaction(async (tx) => setSyncPageTransport(tx as unknown as Database, { pageId, to: "browser" })))
      .toEqual({ kind: "unchanged", transport: "browser", leave: null });
    // Leaving the browser records a pending leave at the page's owner generation (0278).
    expect(await db().transaction(async (tx) => setSyncPageTransport(tx as unknown as Database, { pageId, to: "node" })))
      .toEqual({ kind: "changed", from: "browser", to: "node", leave: 0n });
    expect(await db().transaction(async (tx) => setSyncPageTransport(tx as unknown as Database, { pageId: 999_999, to: "browser" })))
      .toEqual({ kind: "no_page" });
    await expect(setSyncPageTransport(db(), { pageId, to: "carrier-pigeon" as never })).rejects.toThrow(/Unknown Fansly sync page transport/);
    // The column itself takes the two values and no other.
    await expect(testDb.pool.query("update sync_pages set transport = 'undici' where page_id = $1", [pageId]))
      .rejects.toThrow(/sync_pages_transport_check/);
  });

  it("a change rolled back with its transaction changes nothing", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("transport-rollback");
    await expect(db().transaction(async (tx) => {
      await setSyncPageTransport(tx as unknown as Database, { pageId, to: "browser" });
      throw new Error("the lever's audit row failed");
    })).rejects.toThrow(/audit row failed/);
    expect(await getSyncPageTransport(db(), pageId)).toBe("node");
    expect(await getSyncPageTransport(db(), 999_999)).toBeNull();
  });

  it("keeps the pinned exit IP and the environment the hello carries; refuses what is not one", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("settings-page");
    const profileId = await profile(pageId, "page-browser-settings-page");
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ pinnedExitIp: null, pinnedExitIpAt: null, env: null });
    expect(await setPageBrowserSettings(db(), { profileId, pinnedExitIp: "203.0.113.9", env: ENV })).toBe(true);
    const set = (await findPageBrowser(db(), profileId))!;
    expect(set.pinnedExitIp).toBe("203.0.113.9");
    expect(set.pinnedExitIpAt).toBeInstanceOf(Date);
    expect(pageBrowserEnvOf(set.env)).toEqual(ENV);
    // A field left out keeps its value; a pin taken away takes its instant.
    expect(await setPageBrowserSettings(db(), { profileId, pinnedExitIp: null })).toBe(true);
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ pinnedExitIp: null, pinnedExitIpAt: null });
    expect(pageBrowserEnvOf((await findPageBrowser(db(), profileId))!.env)).toEqual(ENV);
    await expect(setPageBrowserSettings(db(), { profileId, pinnedExitIp: "not-an-ip" })).rejects.toThrow(/Not an IP/);
    await expect(setPageBrowserSettings(db(), { profileId, env: { ...ENV, languages: [] } })).rejects.toThrow(/Not a browser environment/);
    expect(pageBrowserEnvOf({ timeZone: "UTC", languages: ["en"], geolocation: { latitude: 91, longitude: 0, accuracyM: 1 } })).toBeNull();
    await expect(testDb.pool.query("update page_browsers set env = '[]'::jsonb where profile_id = $1", [profileId]))
      .rejects.toThrow(/page_browsers_env_check/);
    expect(await setPageBrowserSettings(db(), { profileId: "00000000-0000-4000-8000-00000000dead", pinnedExitIp: "203.0.113.9" })).toBe(false);
  });

  it("keeps the newest owner generation the operator answered with quiesced, never an earlier one", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("handover-page");
    const profileId = await profile(pageId, "page-browser-handover-page");
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ handoverGeneration: null, handoverQuiescedAt: null, handoverLastSendAt: null });

    const lastSendAt = new Date("2026-10-13T10:00:00.500Z");
    expect(await recordPageBrowserHandover(db(), { profileId, generation: 7n, lastSendAt })).toBe(true);
    const first = (await findPageBrowser(db(), profileId))!;
    expect(first.handoverGeneration).toBe(7n);
    expect(first.handoverLastSendAt?.toISOString()).toBe(lastSendAt.toISOString());
    expect(first.handoverQuiescedAt).toBeInstanceOf(Date);

    // Said again for the same owner: there already. An earlier owner's word
    // written late: not taken.
    expect(await recordPageBrowserHandover(db(), { profileId, generation: 7n, lastSendAt: null })).toBe(true);
    expect(await recordPageBrowserHandover(db(), { profileId, generation: 6n, lastSendAt: null })).toBe(false);
    expect((await findPageBrowser(db(), profileId))!.handoverLastSendAt?.toISOString()).toBe(lastSendAt.toISOString());

    expect(await recordPageBrowserHandover(db(), { profileId, generation: 8n, lastSendAt: null })).toBe(true);
    expect(await findPageBrowser(db(), profileId)).toMatchObject({ handoverGeneration: 8n, handoverLastSendAt: null });
    expect(await recordPageBrowserHandover(db(), { profileId: "00000000-0000-4000-8000-00000000dead", generation: 1n, lastSendAt: null })).toBe(false);
  });
});

describe("a leave of a page's browser (0278)", () => {
  const transport = (pageId: number, to: "node" | "browser") => db().transaction(async (tx) => setSyncPageTransport(tx as unknown as Database, { pageId, to }));

  it("is pending from the switch until its operator confirms it under the owner's fence — the pending one only", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("leave-page");
    await testDb.pool.query("update sync_pages set owner_generation = 4 where page_id = $1", [pageId]);
    await transport(pageId, "browser");
    expect(await getSyncPageBrowserLeave(db(), pageId)).toBeNull();
    expect(await transport(pageId, "node")).toMatchObject({ leave: 4n });
    expect(await getSyncPageBrowserLeave(db(), pageId)).toMatchObject({ generation: 4n });
    expect((await listSyncPageSenders(db())).get(pageId)).toMatchObject({ transport: "node", leave: { generation: 4n } });
    // The leave's owner took the page: generation 5.
    await testDb.pool.query("update sync_pages set owner_generation = 5 where page_id = $1", [pageId]);
    const confirm = (leaveGeneration: bigint, generation: bigint) => db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await lockOwnedPage(tx, { pageId, generation: 5n, lock: "no_key_update" });
      return confirmBrowserLeave(tx, { pageId, leaveGeneration, generation });
    });
    // Another leave than the pending one, or an owner that is not the page's: nothing.
    expect(await confirm(3n, 5n)).toBe(false);
    expect(await confirm(4n, 6n)).toBe(false);
    expect(await confirm(4n, 5n)).toBe(true);
    expect(await getSyncPageBrowserLeave(db(), pageId)).toBeNull();
    const row = (await testDb.pool.query("select browser_left_by as by, browser_left_generation::text as g from sync_pages where page_id = $1", [pageId])).rows[0];
    expect(row).toEqual({ by: "operator", g: "5" });
    // Back on the browser: a pending leave is dropped.
    await transport(pageId, "browser");
    expect(await transport(pageId, "node")).toMatchObject({ leave: 5n });
    await transport(pageId, "browser");
    expect(await getSyncPageBrowserLeave(db(), pageId)).toBeNull();
  });

  it("the owner's word confirms the pending leave; the buffer is marked not drained until the operator keeps nothing", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await page("owner-leave-page");
    const profileId = await profile(pageId, "page-browser-owner-leave-page");
    expect(await db().transaction(async (tx) => assertBrowserLeft(tx as unknown as Database, { pageId }))).toBeNull();
    await transport(pageId, "browser");
    await transport(pageId, "node");
    expect(await db().transaction(async (tx) => assertBrowserLeft(tx as unknown as Database, { pageId }))).toBe(0n);
    expect(await getSyncPageBrowserLeave(db(), pageId)).toBeNull();
    expect((await testDb.pool.query("select browser_left_by as by from sync_pages where page_id = $1", [pageId])).rows[0]).toEqual({ by: "owner" });
    expect(await markPageBrowserUndrained(db(), { pageId })).toBe(true);
    const since = (await findPageBrowser(db(), profileId))!.bufferUndrainedSince;
    expect(since).toBeInstanceOf(Date);
    // Marked again: its first instant is kept.
    await markPageBrowserUndrained(db(), { pageId });
    expect((await findPageBrowser(db(), profileId))!.bufferUndrainedSince?.getTime()).toBe(since!.getTime());
    expect(await clearPageBrowserUndrained(db(), { profileId })).toBe(true);
    expect(await clearPageBrowserUndrained(db(), { profileId })).toBe(false);
    expect((await findPageBrowser(db(), profileId))!.bufferUndrainedSince).toBeNull();
    // The check: a pending leave has its instant; a confirmation names who.
    await expect(testDb.pool.query("update sync_pages set browser_leave_generation = 1 where page_id = $1", [pageId])).rejects.toThrow(/sync_pages_browser_leave_check/);
    await expect(testDb.pool.query("update sync_pages set browser_left_by = 'robot' where page_id = $1", [pageId])).rejects.toThrow(/sync_pages_browser_leave_check/);
  });

  it("the deploy's rollback gate counts, read-only, every page on its browser or leaving it", async (context) => {
    if (!testDb) return context.skip();
    const sql = runRollbackBrowserGate({ applied: ["0276_page_browser_intake.sql"], answer: "0" }).sql!;
    const count = async () => {
      const client = await testDb!.pool.connect();
      try {
        const results = (await client.query(sql)) as unknown as Array<{ rows: Array<{ count: string }> }>;
        return Number(results.find((result) => result.rows.length === 1)!.rows[0]!.count);
      } finally {
        client.release();
      }
    };
    const seed = (label: string, ownRef: string) => seedHarnessPage({ db: db(), pool: testDb!.pool }, { mode: "live", proxyUrl: "socks5://127.0.0.1:1080", label, ownRef });
    const plain = await seed("gate-node", "300000000000000011");
    const onBrowser = await seed("gate-browser", "300000000000000012");
    const leaving = await seed("gate-leaving", "300000000000000013");
    expect(await count()).toBe(0);
    await transport(onBrowser.pageId, "browser");
    await transport(leaving.pageId, "browser");
    await transport(leaving.pageId, "node");
    expect(await count()).toBe(2);
    await db().transaction(async (tx) => assertBrowserLeft(tx as unknown as Database, { pageId: leaving.pageId }));
    expect(await count()).toBe(1);
    void plain;
  });
});
