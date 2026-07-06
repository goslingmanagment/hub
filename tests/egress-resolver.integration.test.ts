import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createModel } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createEgressPacer } from "../apps/runtime/src/services/egress/pacer.ts";
import { resolveEgress } from "../apps/runtime/src/services/egress/resolver.ts";
import { onboardFanslyPage } from "../apps/runtime/src/services/page-onboarding.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

async function seedFanslyPage(label: string, proxyUrl?: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const app = {
    db: appContext.db,
    config: appContext.config,
    adapter: {
      async verifySession() {
        return {
          parsed: {
            account: {
              id: `acct-${label}`,
              username: label,
              displayName: label,
              followCount: 0,
              subscriberCount: 0,
            },
          },
          raw: null,
        };
      },
    },
  } as never;
  const { page } = await onboardFanslyPage(app, {
    modelSlug: model.slug,
    label,
    session: { authorization: `token-${label}` },
    ...(proxyUrl ? { proxy: { url: proxyUrl } } : {}),
  });
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
  it("resolves page scopes onto the page's proxy identity", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const proxied = await seedFanslyPage("egress-proxied", "socks5://proxy.example:1080");
    const proxiedContext = await resolveEgress(appContext, { kind: "page", pageId: proxied.id });
    expect(proxiedContext.egressKey).toBe("socks5://proxy.example:1080");
    expect(proxiedContext.dispatcher).not.toBeNull();
    await proxiedContext.close();

    const direct = await seedFanslyPage("egress-direct");
    const directContext = await resolveEgress(appContext, { kind: "page", pageId: direct.id });
    expect(directContext.egressKey).toBe("direct");
    expect(directContext.dispatcher).not.toBeNull();
    await directContext.close();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("records the vendor address policies: ofapi vendor-direct, fansly refused, unknown throws", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const vendorContext = await resolveEgress(appContext, { kind: "vendor", vendor: "ofapi" });
    expect(vendorContext.egressKey).toBe("vendor:ofapi");
    expect(vendorContext.dispatcher).toBeNull();
    await vendorContext.close();

    await expect(resolveEgress(appContext, { kind: "vendor", vendor: "fansly" }))
      .rejects.toThrow(/must be page-scoped/);
    await expect(resolveEgress(appContext, { kind: "vendor", vendor: "myspace" }))
      .rejects.toThrow(/Unknown egress vendor/);
    await expect(resolveEgress(appContext, { kind: "page", pageId: 999_999 }))
      .rejects.toThrow(/not found/);
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

  it("bulk backlog lives in bulk's class row — the vendor horizon stays imminent-send-short", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const capMs = 200;
    const pacer = createEgressPacer(pacedApp(capMs), { vendor: "ofapi" });

    // Six concurrent bulk pacers: a saturated backfill. Each is two-phase —
    // it claims the vendor row only when its class slot arrives.
    const bulkRuns = Array.from({ length: 6 }, () => pacer.pace("bulk"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const now = Date.now();
    const classNext = (await readRow("class:bulk")).getTime();
    const vendorNext = (await readRow("vendor_global")).getTime();
    // The queue is parked on class:bulk (≈ 6 slots deep)…
    expect(classNext - now).toBeGreaterThan(capMs * 3);
    // …while the vendor row holds only imminent sends.
    expect(vendorNext - now).toBeLessThanOrEqual(capMs * 2);

    // An interactive arrival therefore pays vendor arithmetic, not the queue.
    const interactive = await pacer.plan("interactive");
    expect(interactive.waitMs).toBeLessThanOrEqual(capMs * 3);

    await Promise.all(bulkRuns);
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
    // Ten higher-class plans land while bulk is in flight.
    for (let i = 0; i < 10; i += 1) {
      await pacer.plan("interactive");
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
    await pacer.plan("interactive");
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

describe("raw-fetch ratchet (Stage 26)", () => {
  it("holds its budget", () => {
    const output = execFileSync(
      "node",
      [join(__dirname, "..", "scripts", "check-raw-fetch.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toMatch(/raw fetch\( sites: \d+ \(budget \d+\)/);
  });
});
