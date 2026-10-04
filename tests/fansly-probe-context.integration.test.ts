import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDb, createFanslyPage, createModel, createOnlyFansPage, createPool,
  storeFanslySession, type Database,
} from "@agency_hub_core/db";
import { encryptJson } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { readProbeGeneration, readProbeSnapshot, resolveFanslyProbeContext } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import * as resolver from "../apps/runtime/src/services/egress/resolver.ts";
import { resolvePageContext, saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { READ_ONLY_ROLE_PASSWORD } from "./helpers/db-context.ts";
import { createTestAppContext } from "./helpers/runtime.ts";


let testDb: StartedTestDatabase;
let app: Pick<AppContext, "db" | "config">;
const realResolveEgress = resolver.resolveEgress;
const resolveSpy = vi.spyOn(resolver, "resolveEgress");
let readOnlyPool: ReturnType<typeof createPool>;

beforeAll(async () => {
  testDb = await startTestDatabase();
  // The cluster-wide read_only login role comes from global setup; grants are
  // per database, so these stay inside this suite's clone.
  await testDb.pool.query("grant usage on schema public to read_only");
  await testDb.pool.query("grant select on pages, page_credentials, egress_endpoints to read_only");
  const connection = new URL(testDb.connectionString);
  connection.username = "read_only";
  connection.password = READ_ONLY_ROLE_PASSWORD;
  readOnlyPool = createPool(connection.toString());
}, 120_000);
afterAll(async () => {
  await readOnlyPool?.end();
  await testDb?.stop();
});
beforeEach(async () => {
  resolveSpy.mockReset().mockImplementation(realResolveEgress);
  await resetIntegrationDatabase(testDb.pool);
  const context = createTestAppContext(testDb);
  app = { db: context.db, config: { ...context.config, egressPacerMode: "enforce" } };
});

async function storeBundle(pageId: number, bundle: unknown) {
  await storeFanslySession(app.db, pageId, JSON.stringify(encryptJson(
    bundle, app.config.encryptionKey, app.config.encryptionKeyVersion,
  )), app.config.encryptionKeyVersion);
}

async function seed(label: string, bundle: unknown = { platform: "fansly", session: { authorization: "test-token" } }) {
  const model = (await createModel(app.db, { slug: label, name: label }))!;
  const page = (await createFanslyPage(app.db, { modelId: model.id, label }))!;
  await storeBundle(page.id, bundle);
  await saveProxy(app, page.id, {
    url: "socks5://proxy.example.internal:1080", username: "proxy-user", password: "proxy-password",
  });
  return page;
}

function readProbe(label: string) {
  return app.db.transaction((tx) => resolveFanslyProbeContext({ ...app, db: tx as Database }, label), {
    isolationLevel: "repeatable read", accessMode: "read only",
  });
}

async function snapshot() {
  const result = await testDb.pool.query(`select jsonb_build_object(
    'pages', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from pages t),
    'credentials', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from page_credentials t),
    'proxies', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from egress_endpoints t),
    'incidents', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from notification_incidents t),
    'deliveries', (select coalesce(jsonb_agg(to_jsonb(t) order by id), '[]') from telegram_delivery_attempts t),
    'pacing', (select coalesce(jsonb_agg(to_jsonb(t) order by provider, scope, egress_key), '[]') from sync_rate_limits t),
    'observations', (select count(*) from observations),
    'events', (select count(*) from domain_events)
  ) as state`);
  return result.rows[0].state;
}

describe("Fansly stored probe context", () => {
  it("checks the same generation without creating dispatchers or changing any rows", async () => {
    const page = await seed("generation-only");
    const context = await readProbe(page.label);
    await context.egress.close();
    resolveSpy.mockClear();
    const before = await snapshot();
    expect(await readProbeGeneration(app.db, page.label)).toBe(context.generation);
    expect(await readProbeGeneration(app.db, page.label)).toBe(context.generation);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await storeBundle(page.id, { authorization: "rotated-token" });
    expect(await readProbeGeneration(app.db, page.label)).not.toBe(context.generation);
    await testDb.pool.query("update pages set status = 'deleted', deleted_at = now() where id = $1", [page.id]);
    await expect(readProbeGeneration(app.db, page.label)).rejects.toThrow(/not found/);
  });
  it("uses the existing application/admin connection in a read-only, repeatable-read snapshot", async () => {
    const page = await seed("runtime-db-role");
    const before = await snapshot();
    resolveSpy.mockImplementationOnce(async (snapshotApp, scope) => {
      const identity = await snapshotApp.db.execute(`select current_user as role,
        current_setting('transaction_read_only') as read_only,
        current_setting('transaction_isolation') as isolation`);
      expect(identity.rows[0]).toEqual({
        role: new URL(testDb.connectionString).username,
        read_only: "on", isolation: "repeatable read",
      });
      return realResolveEgress(snapshotApp, scope);
    });
    const context = await readProbeSnapshot(app.db, app.config, page.label);
    try {
      expect(context).toMatchObject({ pageId: page.id, token: "test-token" });
      expect(resolveSpy).toHaveBeenCalledOnce();
      expect(await snapshot()).toEqual(before);
    } finally {
      await context.egress.close();
    }
  });

  it("rejects an accidental write even when the runtime connection is an admin", async () => {
    const page = await seed("runtime-write-guard");
    const before = await snapshot();
    resolveSpy.mockImplementationOnce(async (snapshotApp, scope) => {
      await snapshotApp.db.execute("update pages set label = 'unexpected-write'");
      return realResolveEgress(snapshotApp, scope);
    });
    await expect(readProbeSnapshot(app.db, app.config, page.label))
      .rejects.toMatchObject({ cause: { code: "25006" } });
    expect(await snapshot()).toEqual(before);
  });

  it("reads through an actual read_only login with only the required SELECT grants", async () => {
    const page = await seed("read-only-login");
    const before = await snapshot();
    const context = await readProbeSnapshot(createDb(readOnlyPool), app.config, page.label);
    try {
      expect(context).toMatchObject({ pageId: page.id, token: "test-token" });
      expect(resolveSpy).toHaveBeenCalledOnce();
      expect(await snapshot()).toEqual(before);
    } finally {
      await context.egress.close();
    }
  });

  it("refuses a missing credential-table privilege without fallback or egress", async () => {
    const page = await seed("missing-db-privilege");
    await testDb.pool.query("revoke select on page_credentials from read_only");
    const before = await snapshot();
    try {
      await expect(readProbeSnapshot(createDb(readOnlyPool), app.config, page.label))
        .rejects.toMatchObject({ cause: { code: "42501" } });
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    } finally {
      await testDb.pool.query("grant select on page_credentials to read_only");
    }
  });

  it.each([
    ["modern", { platform: "fansly", session: { authorization: "test-token", fanslyClientId: "client" } }],
    ["legacy", { token: "test-token", "fansly-client-id": "client" }],
  ])("decodes %s credentials without writes or pacing and owns a fresh dispatcher", async (label, bundle) => {
    const page = await seed(String(label), bundle);
    const before = await snapshot();
    const first = await readProbe(page.label);
    const second = await readProbe(page.label);
    try {
      expect(first.token).toBe("test-token");
      expect(first.pageId).toBe(page.id);
      expect(first.generation).toMatch(/^[a-f0-9]{64}$/);
      expect(second.generation).toBe(first.generation);
      expect(first.egress.egressKey).toBe("socks5://proxy.example.internal:1080");
      expect(first.egress.dispatcher).not.toBeNull();
      expect(second.egress.dispatcher).not.toBe(first.egress.dispatcher);
      const normal = await resolvePageContext(createTestAppContext(testDb), page.label);
      expect(normal).toMatchObject({ platform: "fansly", session: { authorization: first.token } });
      expect(await snapshot()).toEqual(before);
    } finally {
      await first.egress.close();
      await second.egress.close();
    }
  });

  it.each([
    ["empty", { platform: "fansly", session: { authorization: " \t" } }, /nonempty/],
    ["missing-token", { platform: "fansly", session: {} }, /nonempty/],
    ["missing-session", { platform: "fansly" }, /nonempty/],
    ["foreign-bundle", { platform: "onlyfans", token: "foreign" }, /OnlyFans credentials/],
  ])("refuses %s credentials before egress without creating an incident", async (label, bundle, error) => {
    const page = await seed(String(label), bundle);
    const before = await snapshot();
    await expect(readProbe(page.label)).rejects.toThrow(error as RegExp);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("refuses missing, deleted, OnlyFans, proxyless and credentialless pages before egress", async () => {
    const proxied = await seed("proxied");
    const proxyless = await seed("proxyless");
    const credentialless = await seed("credentialless");
    const deleted = await seed("deleted");
    const onlyfans = (await createOnlyFansPage(app.db, { modelId: proxied.modelId, label: "onlyfans" }))!;
    await testDb.pool.query("delete from egress_endpoints where platform_account_id = $1", [proxyless.id]);
    await testDb.pool.query("delete from page_credentials where platform_account_id = $1", [credentialless.id]);
    await testDb.pool.query("update pages set status = 'deleted', deleted_at = now() where id = $1", [deleted.id]);
    const before = await snapshot();
    for (const [label, error] of [
      ["absent", /not found/], [deleted.label, /not found/], [onlyfans.label, /not a Fansly/],
      [proxyless.label, /no assigned proxy/], [credentialless.label, /no stored platform credentials/],
    ] as const) await expect(readProbe(label)).rejects.toThrow(error);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("refuses malformed credentials and proxy configuration before egress", async () => {
    const page = await seed("malformed");
    await testDb.pool.query("update page_credentials set encrypted_session = 'invalid' where platform_account_id = $1", [page.id]);
    let before = await snapshot();
    await expect(readProbe(page.label)).rejects.toThrow(/invalid stored platform credentials/);
    expect(await snapshot()).toEqual(before);
    await storeBundle(page.id, { authorization: "test-token" });
    await testDb.pool.query("update egress_endpoints set url = 'ftp://proxy.invalid:21' where platform_account_id = $1", [page.id]);
    before = await snapshot();
    await expect(readProbe(page.label)).rejects.toThrow(/Unsupported proxy protocol/);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("keeps token and proxy in one snapshot across a concurrent rotation, then detects the new generation", async () => {
    const page = await seed("rotating");
    const initial = await readProbe(page.label);
    await initial.egress.close();
    resolveSpy.mockImplementationOnce(async (snapshotApp, scope) => {
      // This committed writer is deliberately outside the caller's transaction.
      await storeBundle(page.id, { authorization: "rotated-token" });
      await testDb.pool.query("update pages set external_page_id = '456' where id = $1", [page.id]);
      await saveProxy(app, page.id, { url: "http://new-proxy.example.internal:8080" });
      return realResolveEgress(snapshotApp, scope);
    });
    const during = await readProbe(page.label);
    const after = await readProbe(page.label);
    try {
      expect(during.token).toBe("test-token");
      expect(during.generation).toBe(initial.generation);
      expect(during.expectedAccountId).toBe(initial.expectedAccountId);
      expect(during.egress.egressKey).toBe(initial.egress.egressKey);
      expect(after.token).toBe("rotated-token");
      expect(after.expectedAccountId).toBe("456");
      expect(after.generation).not.toBe(initial.generation);
      expect(after.egress.egressKey).toBe("http://new-proxy.example.internal:8080");
    } finally {
      await during.egress.close();
      await after.egress.close();
    }
  });

  it("changes the generation for credential-only and proxy-auth-only rotations", async () => {
    const page = await seed("generation");
    async function generation() {
      const context = await readProbe(page.label);
      await context.egress.close();
      return context.generation;
    }
    const initial = await generation();
    await storeBundle(page.id, { authorization: "rotated-token" });
    const credentialsChanged = await generation();
    expect(credentialsChanged).not.toBe(initial);
    await saveProxy(app, page.id, {
      url: "socks5://proxy.example.internal:1080", username: "proxy-user", password: "new-password",
    });
    expect(await generation()).not.toBe(credentialsChanged);
  });
});
