import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel, createOnlyFansPage } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createEgressPacer } from "../apps/runtime/src/services/egress/pacer.ts";
import { resolveEgress } from "../apps/runtime/src/services/egress/resolver.ts";
import {
  FanslyPublicEgressUnavailableError,
  readFanslyPublicProxy,
  removeFanslyPublicProxy,
  saveFanslyPublicProxy,
} from "../apps/runtime/src/services/egress/fansly-public.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { buildSyncPublicLookupCommandGroup } from "../apps/runtime/src/sync/cli/public-lookup.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

async function seedFanslyPage(label: string, proxyUrl: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  if (!model) {
    throw new Error(`Failed to seed model for ${label}`);
  }
  const page = await createFanslyPage(appContext.db, { modelId: model.id, label });
  if (!page) {
    throw new Error(`Failed to seed Fansly page ${label}`);
  }
  await saveProxy(appContext, page.id, { url: proxyUrl });
  return page;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
});

describe("egress resolver (Stage 26)", () => {
  it("resolves page scopes onto the page's proxy identity and refuses proxyless Fansly pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const proxied = await seedFanslyPage(
      "egress-proxied",
      "socks5://proxy.example.internal:1080",
    );
    const proxiedContext = await resolveEgress(appContext, { kind: "page", pageId: proxied.id });
    expect(proxiedContext.egressKey).toBe("socks5://proxy.example.internal:1080");
    expect(proxiedContext.dispatcher).not.toBeNull();
    await proxiedContext.close();

    // W3.1 (decision #124, reversing the Stage-26 recorded direct fallback):
    // a Fansly page without a proxy is REFUSED, never direct-dispatched.
    // A proxyless page can only be legacy/corrupt stored state now. Seed that
    // state directly instead of teaching the onboarding boundary to create it.
    const directModel = await createModel(appContext.db, {
      slug: "model-egress-direct",
      name: "Model egress-direct",
    });
    if (!directModel) {
      throw new Error("Failed to seed legacy proxyless model");
    }
    const direct = await createFanslyPage(appContext.db, {
      modelId: directModel.id,
      label: "egress-direct",
    });
    if (!direct) {
      throw new Error("Failed to seed legacy proxyless Fansly page");
    }
    await expect(resolveEgress(appContext, { kind: "page", pageId: direct.id }))
      .rejects.toThrow(/fail-closed/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resolves a page_candidate scope onto the candidate proxy — for one identity check of a Fansly page, never a vendor-side one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedFanslyPage("egress-candidate", "socks5://proxy.example.internal:1080");
    const candidate = await resolveEgress(appContext, {
      kind: "page_candidate",
      pageId: page.id,
      proxy: { url: "http://candidate.example.internal:3128" },
    });
    // The candidate's own address identity, never the stored proxy's.
    expect(candidate.egressKey).toBe("http://candidate.example.internal:3128");
    expect(candidate.dispatcher).not.toBeNull();
    await candidate.close();

    const model = await createModel(appContext.db, { slug: "model-egress-of", name: "Model egress-of" });
    const ofPage = await createOnlyFansPage(appContext.db, { modelId: model!.id, label: "egress-of" });
    await expect(resolveEgress(appContext, { kind: "page_candidate", pageId: ofPage!.id, proxy: { url: "http://candidate.example.internal:3128" } }))
      .rejects.toThrow(/vendor-side/);
    await expect(resolveEgress(appContext, { kind: "page_candidate", pageId: 999_999, proxy: { url: "http://candidate.example.internal:3128" } }))
      .rejects.toThrow(/not found/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resolves a fansly_candidate scope onto the candidate proxy without a page — unpaced, never direct, its target checked", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Step 4 S4-05: the no-page identity check (onboarding, the create-page
    // check) rides the proxy the page will get; there is no page to look up.
    const candidate = await resolveEgress(appContext, {
      kind: "fansly_candidate",
      proxy: { url: "http://candidate.example.internal:3128" },
    });
    expect(candidate.egressKey).toBe("http://candidate.example.internal:3128");
    expect(candidate.dispatcher).not.toBeNull();
    // Owner decision №4: paced against no page.
    await expect(candidate.pace("interactive")).resolves.toBe(0);
    await candidate.close();

    await expect(resolveEgress(appContext, { kind: "fansly_candidate", proxy: { url: "socks5://127.0.0.1:1080" } }))
      .rejects.toThrow(/Proxy host must not be loopback/);
    await expect(resolveEgress(appContext, { kind: "fansly_candidate", proxy: { url: "http://10.0.0.7:3128" } }))
      .rejects.toThrow(/Proxy host must not be loopback/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resolves fansly_public onto the reader's own stored proxy only: none configured, a page's proxy or a private target is refused", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Arena R5 (plan §7): no proxy configured — no transport, nothing sent.
    await expect(resolveEgress(appContext, { kind: "fansly_public" })).rejects.toThrow(FanslyPublicEgressUnavailableError);
    await expect(resolveEgress(appContext, { kind: "fansly_public" })).rejects.toThrow(/not_configured/);

    // A page's proxy (same address and user) is refused when it is set …
    await seedFanslyPage("egress-public-page", "socks5://page-proxy.example.internal:1080");
    await expect(saveFanslyPublicProxy(appContext, {
      proxy: { url: "socks5://page-proxy.example.internal:1080" },
      actor: "test",
      note: "a page's",
    })).rejects.toThrow(/shares_page_proxy.*egress-public-page/);
    // … a loopback or private target too …
    await expect(saveFanslyPublicProxy(appContext, {
      proxy: { url: "http://10.0.0.7:3128" },
      actor: "test",
      note: "private",
    })).rejects.toThrow(/Proxy host must not be loopback/);
    expect((await testDb.pool.query("select count(*)::int as n from fansly_public_egress")).rows[0]!.n).toBe(0);

    // … while another user of the same gateway is another exit, and is accepted.
    const view = await saveFanslyPublicProxy(appContext, {
      proxy: { url: "socks5://page-proxy.example.internal:1080", username: "public-reader", password: "fake-password" },
      actor: "test",
      note: "the reader's own",
    });
    expect(view).toMatchObject({ configured: true, route: "socks5://page-proxy.example.internal:1080 (auth)", sharedWithPages: [] });
    // Stored as a page's proxy is: the URL, the auth encrypted, never in clear.
    const stored = (await testDb.pool.query<{ url: string; encrypted_auth: string; key_version: number }>(
      "select url, encrypted_auth, key_version from fansly_public_egress",
    )).rows[0]!;
    expect(stored.url).toBe("socks5://page-proxy.example.internal:1080");
    expect(stored.encrypted_auth).not.toContain("fake-password");
    expect(stored.key_version).toBe(appContext.config.encryptionKeyVersion);
    const audit = (await testDb.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'admin.fansly_public_egress_set'",
    )).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain("fake-password");

    const resolved = await resolveEgress(appContext, { kind: "fansly_public" });
    expect(resolved.egressKey).toBe("fansly-public:socks5://page-proxy.example.internal:1080");
    expect(resolved.dispatcher).not.toBeNull();
    // The reader paces itself.
    await expect(resolved.pace("bulk")).resolves.toBe(0);
    // Fansly's API host only: anything else is refused before a connection.
    await expect(resolved.dispatcher!.request({ origin: "https://api.ipify.org", path: "/", method: "GET" }))
      .rejects.toThrow(/only https:\/\/apiv3\.fansly\.com/);
    await resolved.close();

    // Should a page get the same proxy later, the resolver refuses it again.
    await saveProxy(appContext, (await seedFanslyPage("egress-public-late", "http://late.example.internal:3128")).id, {
      url: "socks5://page-proxy.example.internal:1080",
      username: "public-reader",
      password: "fake-password",
    });
    await expect(resolveEgress(appContext, { kind: "fansly_public" })).rejects.toThrow(/shares_page_proxy.*egress-public-late/);

    expect(await removeFanslyPublicProxy(appContext, { actor: "test", note: "gone" })).toBe(true);
    expect(await removeFanslyPublicProxy(appContext, { actor: "test", note: "gone again" })).toBe(false);
    await expect(resolveEgress(appContext, { kind: "fansly_public" })).rejects.toThrow(/not_configured/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("sets, shows and removes the reader's proxy from the owner's CLI, the password from stdin, nothing echoed or sent", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const printed: string[] = [];
    const trap = await armNoOutboundTrap(testDb);
    try {
      const cli = buildSyncPublicLookupCommandGroup({
        openContext: async () => ({
          db: appContext.db,
          config: appContext.config,
          rawConfig: appContext.config,
          logger: appContext.logger,
          close: async () => undefined,
        }),
        print: (line) => printed.push(line),
        readStdin: async () => "fake-stdin-password\n",
      });
      await cli.parseAsync(["public-lookup", "proxy", "show"], { from: "user" });
      expect(printed.at(-1)).toMatch(/not configured — the public account reader sends nothing/);
      await cli.parseAsync([
        "public-lookup", "proxy", "set",
        "--proxy-url", "http://reader.example.internal:3128",
        "--proxy-username", "reader",
        "--proxy-password-stdin",
        "--note", "owner's dedicated proxy",
      ], { from: "user" });
      await cli.parseAsync(["public-lookup", "proxy", "show"], { from: "user" });
      expect(printed.join("\n")).toContain("public egress: http://reader.example.internal:3128 (auth)");
      expect(printed.join("\n")).not.toContain("fake-stdin-password");
      const proxy = await readFanslyPublicProxy(appContext);
      // The trailing newline of `op read` is not part of the password.
      expect(proxy).toMatchObject({ username: "reader", password: "fake-stdin-password" });
      await expect(cli.parseAsync([
        "public-lookup", "proxy", "set", "--proxy-url", "http://reader.example.internal:3128",
        "--proxy-password-stdin", "--proxy-password-env", "X", "--note", "two sources",
      ], { from: "user" })).rejects.toThrow(/only one of/);
      await cli.parseAsync(["public-lookup", "proxy", "remove", "--note", "rotated"], { from: "user" });
      expect(await readFanslyPublicProxy(appContext)).toBeNull();
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("records service-vendor identity while preserving OFAPI/Fansly policies", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const vendorContext = await resolveEgress(appContext, { kind: "vendor", vendor: "ofapi" });
    expect(vendorContext.egressKey).toBe("vendor:ofapi");
    expect(vendorContext.dispatcher).toBeNull();
    await vendorContext.close();

    const elevenlabs = await resolveEgress(appContext, { kind: "vendor", vendor: "elevenlabs" });
    const telegram = await resolveEgress(appContext, { kind: "vendor", vendor: "telegram" });
    expect(elevenlabs.egressKey).toBe(
      "service:socks5://proxy.example.internal:1080",
    );
    expect(telegram.egressKey).toBe(elevenlabs.egressKey);
    expect(elevenlabs.dispatcher).not.toBeNull();
    expect(telegram.dispatcher).not.toBeNull();
    expect(telegram.dispatcher).not.toBe(elevenlabs.dispatcher);
    await expect(elevenlabs.pace("interactive")).resolves.toBe(0);
    await expect(telegram.pace("bulk")).resolves.toBe(0);
    await telegram.close();
    await elevenlabs.close();

    await expect(resolveEgress(appContext, { kind: "vendor", vendor: "fansly" }))
      .rejects.toThrow(/must be page-scoped/);
    await expect(resolveEgress(appContext, { kind: "vendor", vendor: "myspace" }))
      .rejects.toThrow(/Unknown egress vendor/);
    await expect(resolveEgress(appContext, { kind: "page", pageId: 999_999 }))
      .rejects.toThrow(/not found/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("fails closed when the service tuple is absent and allows only Telegram's transition fallback", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const missing = createTestAppContext(testDb, {
      serviceEgressProxyUrl: null,
      serviceEgressProxyUsername: null,
      serviceEgressProxyPassword: null,
    });
    await expect(resolveEgress(missing, { kind: "vendor", vendor: "elevenlabs" }))
      .rejects.toThrow(/requires the service proxy/);
    await expect(resolveEgress(missing, { kind: "vendor", vendor: "telegram" }))
      .rejects.toThrow(/no transition legacy page route/);

    await seedFanslyPage(
      "fake-telegram-legacy",
      "socks5://legacy-proxy.example.internal:1080",
    );
    const transition = createTestAppContext(testDb, {
      telegramProxyPageLabel: "fake-telegram-legacy",
      serviceEgressProxyUrl: null,
      serviceEgressProxyUsername: null,
      serviceEgressProxyPassword: null,
    });
    const legacy = await resolveEgress(transition, {
      kind: "vendor",
      vendor: "telegram",
    });
    expect(legacy.egressKey).toBe(
      "legacy-page:socks5://legacy-proxy.example.internal:1080",
    );
    expect(legacy.dispatcher).not.toBeNull();
    await legacy.close();
    await expect(resolveEgress(transition, {
      kind: "vendor",
      vendor: "elevenlabs",
    })).rejects.toThrow(/requires the service proxy/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("gives the dedicated tuple strict precedence over a configured legacy label", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext.config.telegramProxyPageLabel = "page-that-does-not-exist";
    const telegram = await resolveEgress(appContext, {
      kind: "vendor",
      vendor: "telegram",
    });
    expect(telegram.egressKey).toBe(
      "service:socks5://proxy.example.internal:1080",
    );
    await telegram.close();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

describe("class-aware pacing properties (Stage 26)", () => {
  // The test helper zeroes ofapiRestDelayMs (no sleeping in suites); pacing
  // properties need a real cap, so they pin their own paced app view.
  function pacedApp(capMs = 500) {
    return {
      db: appContext.db,
      config: { ...appContext.config, ofapiRestDelayMs: capMs },
    } as never as AppContext;
  }

  async function readRow(scope: string) {
    const { rows } = await testDb!.pool.query<{ next_available_at: Date }>(
      `select next_available_at from sync_rate_limits
       where egress_key = 'vendor:ofapi' and scope = $1`,
      [scope],
    );
    return rows[0]!.next_available_at;
  }

  async function readShadowRow(scope: string) {
    const { rows } = await testDb!.pool.query<{ next_available_at: Date }>(
      `select next_available_at from sync_rate_limits
       where egress_key = 'shadow:vendor:ofapi' and scope = $1`,
      [scope],
    );
    return rows[0]!.next_available_at;
  }

  it("bulk backlog lives in bulk's class row — the vendor horizon stays imminent-send-short", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const capMs = 200;
    const pacer = createEgressPacer(pacedApp(capMs), { vendor: "ofapi" });

    // Six concurrent bulk pacers: a saturated backfill. Each is two-phase —
    // it claims the vendor row only when its class slot arrives.
    // `backlogStart` is captured BEFORE the pacers so the depth assertion below
    // measures how far the backlog pushed the class row, not how much of that
    // horizon is left after this test's own setup. Measured from `now` it was
    // machine-speed-dependent: on a loaded CI runner the row reads consumed
    // enough of the ~1200 ms budget to fail (observed 193 ms and even -60 ms
    // remaining), while the same shard passed locally.
    const backlogStart = Date.now();
    const bulkRuns = Array.from({ length: 6 }, () => pacer.pace("bulk"));
    try {
      // The queue parks on class:bulk (≈ 6 slots deep). Wait for the claims
      // instead of a fixed pause: on a loaded runner six concurrent claims
      // took longer than 60 ms (the row was one slot deep).
      await vi.waitFor(async () => {
        expect((await readRow("class:bulk")).getTime() - backlogStart).toBeGreaterThan(capMs * 3);
      }, { timeout: 5_000, interval: 20 });

      // …while the vendor row holds only imminent sends.
      const now = Date.now();
      const vendorNext = (await readRow("vendor_global")).getTime();
      expect(vendorNext - now).toBeLessThanOrEqual(capMs * 2);

      // An interactive arrival therefore pays vendor arithmetic, not the queue.
      const interactiveWaitMs = await pacer.pace("interactive");
      expect(interactiveWaitMs).toBeLessThanOrEqual(capMs * 3);
    } finally {
      // A failed assertion must not leave the pacers claiming slots in the
      // next tests' rows.
      await Promise.allSettled(bulkRuns);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shadow plan() never moves the enforce rows and keeps bulk out of shadow's vendor row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const capMs = 200;
    const pacer = createEgressPacer(pacedApp(capMs), { vendor: "ofapi", mode: "shadow" });

    // Seed + snapshot the ENFORCE rows via one real pace.
    await pacer.pace("interactive");
    const vendorBefore = (await readRow("vendor_global")).getTime();
    const classBefore = (await readRow("class:bulk")).getTime();

    // A saturated shadow burst — the ofapi.ts shadow path under bulk load.
    await Promise.all(Array.from({ length: 6 }, () => pacer.plan("bulk")));
    const interactive = await pacer.plan("interactive");

    // Enforce rows untouched byte-for-byte.
    expect((await readRow("vendor_global")).getTime()).toBe(vendorBefore);
    expect((await readRow("class:bulk")).getTime()).toBe(classBefore);

    // Shadow's own universe keeps the Stage 26 shape: the bulk backlog parks
    // on shadow class:bulk; shadow vendor holds no bulk claims, so an
    // interactive shadow read pays vendor arithmetic, not the queue.
    const now = Date.now();
    expect((await readShadowRow("class:bulk")).getTime() - now).toBeGreaterThan(capMs * 3);
    expect(interactive.waitMs).toBeLessThanOrEqual(capMs * 2);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the vendor cap spaces same-class reservations at the preserved rate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const pacer = createEgressPacer(pacedApp(), { vendor: "ofapi" });
    const first = await pacer.plan("interactive");
    const second = await pacer.plan("interactive");
    const spacing = second.scheduledAt.getTime() - first.scheduledAt.getTime();
    expect(spacing).toBeGreaterThanOrEqual(500);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("aging floor: a bulk pace completes within bounded time despite an interactive burst", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const capMs = 150;
    const pacer = createEgressPacer(pacedApp(capMs), { vendor: "ofapi" });

    const startedAt = Date.now();
    const bulkRun = pacer.pace("bulk");
    // Ten higher-class sends land while bulk is in flight (real enforce
    // contention — shadow plan() no longer touches these rows).
    for (let i = 0; i < 10; i += 1) {
      await pacer.pace("interactive");
    }
    await bulkRun;
    // Bulk's class slot was claimed at reservation; its final vendor claim is
    // scheduled at claim time too — later arrivals cannot push it, so the
    // total is bounded by row arithmetic, not starvation.
    expect(Date.now() - startedAt).toBeLessThanOrEqual(capMs * 14);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("seeds class rows with their priority_class recorded (introspectable)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const pacer = createEgressPacer(pacedApp(), { vendor: "ofapi" });
    await pacer.pace("interactive");
    const { rows } = await testDb.pool.query<{ scope: string; priority_class: string }>(
      `select scope, priority_class from sync_rate_limits
       where egress_key = 'vendor:ofapi' order by scope`,
    );
    expect(rows).toEqual(expect.arrayContaining([
      { scope: "vendor_global", priority_class: "bulk" },
      { scope: "class:interactive", priority_class: "interactive" },
      { scope: "class:commands", priority_class: "commands" },
      { scope: "class:bulk", priority_class: "bulk" },
    ]));
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
