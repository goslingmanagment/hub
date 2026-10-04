import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appPlatformRegistry,
  fanslyPlatformAdapter,
  onlyfansPlatformAdapter,
} from "../apps/runtime/src/platforms/registry.ts";
import {
  assertLegacyExecutorPage,
  isLegacyExecutorPlatform,
  LegacyExecutorBoundaryError,
  legacyExecutorPlatforms,
} from "../apps/runtime/src/sync/onlyfans/boundary.ts";

// Step 4, S4-19 (plan §12 `onlyfans/boundary.ts`): what is left of the legacy
// page-sync executor (`apps/runtime/src/services/sync/`) serves OnlyFans only.
// Its platform set is what the platform registry declares — the adapters with
// a legacy stream — and the planner and the executor take it from the
// boundary, scope every page-sync query with it and assert it on what comes
// back. The ratchet below keeps the directory free of anything that could run
// a Fansly page: a change here is a review of the boundary.

const ROOT = join(__dirname, "..");
const LEGACY_SYNC = "apps/runtime/src/services/sync";

const legacyFiles = readdirSync(join(ROOT, LEGACY_SYNC)).filter((name) => name.endsWith(".ts")).sort();
const read = (file: string) => readFileSync(join(ROOT, LEGACY_SYNC, file), "utf8");
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the legacy executor's platform set", () => {
  it("is OnlyFans only", () => {
    expect(legacyExecutorPlatforms()).toEqual(["onlyfans"]);
    expect(isLegacyExecutorPlatform("onlyfans")).toBe(true);
    expect(isLegacyExecutorPlatform("fansly")).toBe(false);
  });

  it("is what the registry declares, not a list of names: a platform is served while its adapter declares a stream", () => {
    const withFanslyStream = {
      all: () => [
        onlyfansPlatformAdapter,
        { ...fanslyPlatformAdapter, capabilities: { ...fanslyPlatformAdapter.capabilities, streams: ["light" as const] } },
      ],
    } as unknown as typeof appPlatformRegistry;
    expect(legacyExecutorPlatforms(withFanslyStream)).toEqual(["onlyfans", "fansly"]);
    expect(isLegacyExecutorPlatform("fansly", withFanslyStream)).toBe(true);

    const withNone = {
      all: () => [{ ...onlyfansPlatformAdapter, capabilities: { ...onlyfansPlatformAdapter.capabilities, streams: [] } }],
    } as unknown as typeof appPlatformRegistry;
    expect(legacyExecutorPlatforms(withNone)).toEqual([]);
  });

  it("passes a served page and stops a page of any other platform, naming the page, the platform and the site", () => {
    expect(() => assertLegacyExecutorPage({ pageId: 8, platform: "onlyfans" }, "planner")).not.toThrow();
    expect(() => assertLegacyExecutorPage({ pageId: 8, platform: "onlyfans" }, "executor")).not.toThrow();

    for (const site of ["planner", "executor"] as const) {
      let caught: unknown;
      try {
        assertLegacyExecutorPage({ pageId: 4, platform: "fansly" }, site);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LegacyExecutorBoundaryError);
      expect(caught).toMatchObject({ name: "LegacyExecutorBoundaryError", pageId: 4, platform: "fansly", site });
      expect((caught as Error).message).toBe(
        `The legacy page-sync ${site} met page 4 of platform fansly, which the legacy executor does not serve`,
      );
    }
  });
});

describe("the planner and the executor stand on the boundary", () => {
  it("the planner scopes its seeding, scheduling and listing to the set and asserts it before the first wake-up", () => {
    const planner = withoutComments(read("planner.ts"));
    expect(planner).toContain('from "../../sync/onlyfans/boundary.ts"');
    expect(planner).toContain("const platforms = legacyExecutorPlatforms();");
    expect(planner).toContain("await ensurePageSyncStates(app.db, { now, platforms, ...dependencyInput });");
    expect(planner).toContain("await scheduleDuePageSync(app.db, { now, platforms, ...dependencyInput });");
    expect(planner).toContain("await listRunnablePageSync(app.db, now, { platforms });");
    const asserted = planner.indexOf('assertLegacyExecutorPage(page, "planner");');
    const firstWake = planner.indexOf("sendSyncPageWakeup(boss,");
    expect(asserted).toBeGreaterThan(-1);
    expect(firstWake).toBeGreaterThan(asserted);
    // One wake-up site, so nothing is woken past the assertion.
    expect(planner.match(/sendSyncPageWakeup\(/g)).toHaveLength(1);
  });

  it("the executor scopes its seeding and its lease to the set and asserts it before it opens a run", () => {
    const executor = withoutComments(read("executor.ts"));
    expect(executor).toContain('from "../../sync/onlyfans/boundary.ts"');
    expect(executor).toContain("const platforms = legacyExecutorPlatforms();");
    expect(executor).toContain("await ensurePageSyncStates(app.db, { pageId: platformAccountId, platforms, ...dependencyInput });");
    const lease = executor.slice(executor.indexOf("await acquirePageSyncLease(app.db, {"), executor.indexOf("if (!taskLease)"));
    expect(lease).toMatch(/\n\s+platforms,\n/);
    const asserted = executor.indexOf(
      'assertLegacyExecutorPage({ pageId: storedPage.page.id, platform: storedPage.page.platform }, "executor");',
    );
    const run = executor.indexOf("await createChunkTelemetry(app, taskLease, storedPage);");
    expect(asserted).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(asserted);
    // One lease site and one run site: no chunk starts past the assertion.
    expect(executor.match(/acquirePageSyncLease\(/g)).toHaveLength(1);
    expect(executor.match(/createChunkTelemetry\(app, taskLease, storedPage\)/g)).toHaveLength(1);
  });
});

describe("the legacy executor holds nothing of Fansly (ratchet)", () => {
  it("has no Fansly module", () => {
    expect(legacyFiles).toEqual([
      "chunk-budget.ts",
      "cursor-state.ts",
      "dependencies.ts",
      "errors.ts",
      "executor-handlers.ts",
      "executor-types.ts",
      "executor.ts",
      // The status readers' view of a legacy followers_reconcile row (no
      // handler, no request); goes with the legacy Fansly status surfaces.
      "followers-reconcile-floor.ts",
      "observability.ts",
      "ofapi-audience-sync.ts",
      "ofapi-dm-sync.ts",
      "ofapi-fan-identities.ts",
      "onlyfans-dm-polling.ts",
      "onlyfans-top-spenders.ts",
      "planner.ts",
      "posts.ts",
      "shared.ts",
      "view.ts",
    ]);
    expect(legacyFiles.filter((name) => name.startsWith("fansly"))).toEqual([]);
  });

  it("has no Fansly handler: the registry routes no Fansly stream, and no chunk handler is named for Fansly", () => {
    expect(fanslyPlatformAdapter.capabilities.streams).toEqual([]);
    expect(fanslyPlatformAdapter.pull).toEqual({});
    expect(appPlatformRegistry.get("fansly").syncScopes).toEqual({});
    const exported = legacyFiles.flatMap((file) =>
      [...withoutComments(read(file)).matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]!));
    expect(exported.filter((name) => /fansly/i.test(name))).toEqual([]);
    // Every handler the registry dispatches lives in the two handler modules
    // and is one of OnlyFans' streams.
    const handlers = Object.entries(onlyfansPlatformAdapter.pull).map(([stream, handler]) => [stream, handler!.name]);
    expect(handlers).toEqual([
      ["light", "onlyfansLightChunk"],
      ["transactions", "onlyfansTransactionsChunk"],
      ["fan_identities", "executeFanIdentitiesChunk"],
      ["top_spenders", "onlyfansTopSpendersChunk"],
      ["subscribers", "onlyfansSubscribersChunk"],
      ["dm_conversations", "onlyfansDmConversationsChunk"],
      ["posts", "onlyfansPostsChunk"],
    ]);
  });

  it("imports nothing of the Fansly HTTP package, the Fansly adapter or the Fansly send guard", () => {
    for (const file of legacyFiles) {
      const source = withoutComments(read(file));
      expect(source, file).not.toMatch(/@agency_hub_core\/fansly/);
      expect(source, file).not.toMatch(/\badapter\./);
      expect(source, file).not.toMatch(/fansly-send-guard|fanslyPageSendGuard|fanslyUnpacedSendGuard/);
      expect(source, file).not.toMatch(/services\/fansly\.ts|from "\.\.\/fansly\.ts"/);
    }
  });

  it("the design's proof: no Fansly platform branch, no Fansly error class, no legacy page metadata refresh", () => {
    // The design's rg over apps/runtime/src/services/sync, as a pin (either
    // comparison operator: a negated branch is a branch too).
    for (const file of legacyFiles) {
      expect(read(file), file).not.toMatch(/platform\s*[!=]==\s*"fansly"|FanslyApiError|refreshPageMetadata/);
    }
  });

  it("takes from the engine only its pure rules: the window and cursor rules OnlyFans shares, and the journal's body rules", () => {
    const engineImports = legacyFiles.flatMap((file) =>
      [...read(file).matchAll(/from "(\.\.\/\.\.\/sync\/[^"]+)"/g)].map((match) => `${file} <- ${match[1]}`)).sort();
    expect(engineImports).toEqual([
      // The month-window bootstrap and trailing week of OnlyFans top spenders.
      "executor-handlers.ts <- ../../sync/fansly/lib/money-rules.ts",
      "executor.ts <- ../../sync/onlyfans/boundary.ts",
      "planner.ts <- ../../sync/onlyfans/boundary.ts",
      // The posts cursor shape the OnlyFans posts stream keeps at rest.
      "posts.ts <- ../../sync/fansly/lib/posts-rules.ts",
      // The legacy capture seam's body rules (CDN tokens, lone surrogates).
      "shared.ts <- ../../sync/fansly/lib/cdn-tokens.ts",
      "shared.ts <- ../../sync/fansly/lib/journal-lone-surrogates.ts",
    ]);
  });
});
