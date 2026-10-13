import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bindPageBrowser,
  findPageBrowser,
  findPageBrowserByPage,
  insertObservation,
  insertPageBrowser,
  insertSiteAdmission,
  recordPageBrowserLinkError,
  recordPageBrowserState,
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
import { HARNESS_ENCRYPTION_KEY, HARNESS_OWN_REF, harnessConfig, seedHarnessPage } from "./helpers/sync-engine.ts";

// The data of PR 12 (Project Browser plan §3.4; 0272–0275): send_mark's
// `transport_reported` and the operator's request id on sync_attempts, the
// observation source `browser_site`, the page_browsers table with its
// sealed secrets, and the hello's settings read from them.

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
