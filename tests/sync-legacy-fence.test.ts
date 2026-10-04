import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENGINE_OWNED_SYNC_PAGE_MODES,
  FANSLY_SYNC_ENGINE_HYDRATION_LANE,
  SYNC_PAGE_MODES,
} from "@agency_hub_core/db";

// The fence between the legacy page-sync executor and a Fansly page (plan
// §12, I21). Through step 3 it was a predicate over `sync_pages` in every
// legacy picker (S3-01: a page in `handover`/`live` is the engine's). Since
// step 4 (S4-21) it is the executor's platform set — the platforms whose
// adapter declares a stream, OnlyFans — handed to every query that picks
// work, and the Fansly pages' legacy rows are parked `retired` (0239). The
// behaviour is pinned by tests/sync-legacy-fence.integration.test.ts; this
// file pins the TEXT, so a later edit cannot quietly drop the scope from a
// picker, make it optional again, or bring a `sync_pages` fence back.

const root = join(__dirname, "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The text of one top-level function: from its declaration to the first
 *  closing brace at column 0. */
function functionBody(path: string, name: string): string {
  const text = source(path);
  const start = text.search(new RegExp(`\\n(export )?(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in ${path}`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end < 0 ? undefined : end);
}

/** Every TypeScript source under `dir`. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => join(dir, path));
}

describe("the engine's modes", () => {
  it("owns a page in handover and live only, never shadow or off (J8)", () => {
    expect([...ENGINE_OWNED_SYNC_PAGE_MODES]).toEqual(["handover", "live"]);
    expect(SYNC_PAGE_MODES.filter((mode) => !(ENGINE_OWNED_SYNC_PAGE_MODES as readonly string[]).includes(mode)))
      .toEqual(["off", "shadow"]);
  });
});

describe("the legacy pickers carry the executor's platform set", () => {
  const pageSync = "packages/db/src/repositories/page-sync.ts";

  it.each([
    ["listRunnablePageSync", 'and ${pageSyncPlatformScopeSql("st.page_id", options.platforms)}'],
    ["markPageSyncEnqueued", 'and ${pageSyncPlatformScopeSql("page_id", options.platforms)}'],
    ["acquirePageSyncLease", 'and ${pageSyncPlatformScopeSql("st.page_id", input.platforms)}'],
  ])("%s filters by it and cannot be called without it", (name, predicate) => {
    const body = functionBody(pageSync, name);
    expect(body).toContain(predicate);
    expect(body).toContain("platforms: PageSyncPlatformScope;");
    expect(body).not.toContain("platforms?: PageSyncPlatformScope");
  });

  it("an empty set matches no page; only the queries that maintain state may leave it out", () => {
    const scope = functionBody(pageSync, "pageSyncPlatformScopeSql");
    expect(scope).toContain("if (platforms.length === 0) return sql`false`;");
    expect(scope).toContain("where scoped.platform in (");
    // The optional scope is left to the queries that read, seed, schedule and
    // repair state and never hand a page to a worker.
    const optional = [...source(pageSync).matchAll(/\n(?:export )?(?:async )?function (\w+)\([\s\S]*?\n\}\n/g)]
      .filter(([text]) => text.includes("platforms?: PageSyncPlatformScope"))
      .map(([, name]) => name)
      .sort();
    expect(optional).toEqual([
      "ensurePageSyncStates",
      "listPageSyncStatesInternal",
      "reclaimExpiredPageSync",
      "refreshPageSyncDependencies",
      "repairLegacyLightTrustedPageSyncStates",
      "scheduleDuePageSync",
    ]);
  });

  it("the planner and the executor pass the registry's set at every call", () => {
    const planner = source("apps/runtime/src/services/sync/planner.ts");
    expect(planner).toContain("const platforms = legacyExecutorPlatforms();");
    expect(planner).toContain("await listRunnablePageSync(app.db, now, { platforms });");
    expect(planner).toContain("await markPageSyncEnqueued(app.db, page.pageId, now, { platforms });");
    const executor = source("apps/runtime/src/services/sync/executor.ts");
    expect(executor.match(/listRunnablePageSync\(app\.db, new Date\(\), \{ platforms: legacyExecutorPlatforms\(\) \}\)/g)).toHaveLength(2);
    expect(executor.match(/listRunnablePageSync\(/g)).toHaveLength(2);
    expect(functionBody("apps/runtime/src/services/sync/executor.ts", "executeNextSyncPageChunk")).toMatch(
      /const platforms = legacyExecutorPlatforms\(\);[\s\S]*?await acquirePageSyncLease\(app\.db, \{[\s\S]{0,240}?\n {4}platforms,\n {2}\}\);/,
    );
    // No other runtime caller of a picker.
    for (const name of ["listRunnablePageSync", "markPageSyncEnqueued", "acquirePageSyncLease"]) {
      const callers = sourcesUnder("apps/runtime/src").filter((path) => new RegExp(`\\b${name}\\(`).test(source(path)));
      expect(callers.sort(), name).toEqual(
        name === "markPageSyncEnqueued"
          ? ["apps/runtime/src/services/sync/planner.ts"]
          : name === "acquirePageSyncLease"
            ? ["apps/runtime/src/services/sync/executor.ts"]
            : ["apps/runtime/src/services/sync/executor.ts", "apps/runtime/src/services/sync/planner.ts"],
      );
    }
  });

  it("no legacy query reads sync_pages: the mode fence is gone, with the lease by stream name", () => {
    for (const path of [
      pageSync,
      "packages/db/src/repositories/sync.ts",
      "packages/db/src/repositories/agent-hydration.ts",
      ...sourcesUnder("apps/runtime/src/services/sync"),
    ]) {
      expect(source(path), path).not.toMatch(/\b(from|join|update|into)\s+sync_pages\b/i);
      expect(source(path), path).not.toMatch(/isFanslyPageEngineOwned|OwnsFanslyPageSql/);
    }
    expect(source(pageSync)).not.toMatch(/TargetedPageSyncLease/);
    // The legacy Fansly sync deadman read the fenced rows; it went with them.
    expect(source("packages/db/src/repositories/sync.ts")).not.toMatch(/SyncLiveness/);
    expect(source("apps/runtime/src/services/ops-watchdog.ts")).not.toMatch(/syncStalled|SyncLiveness/);
  });

  it("the hydration dispatcher lists every approval and its lane table refuses a platform without an executor; the sweeps skip engine rows", () => {
    const hydration = "packages/db/src/repositories/agent-hydration.ts";
    expect(functionBody(hydration, "listDispatchableAgentHydrationRequests")).not.toMatch(/sync_pages|platform/);
    const service = source("apps/runtime/src/services/agent-hydration.ts");
    expect(service).toMatch(
      /const dispatcher = LANE_DISPATCHERS\[platform\];[\s\S]{0,400}?return refuse\("no executor lane serves this platform"\);/,
    );
    // The auto-approval that also skipped them is gone with the legacy Fansly
    // hydration lane (step 4, S4-15).
    expect(source(hydration)).not.toContain("listAutoApprovableAgentHydrationRequests");
    for (const name of [
      "listStuckAgentHydrationDispatches",
      "listDispatchingAgentHydrationRequests",
      "listExpirableAgentHydrationRequests",
    ]) {
      expect(functionBody(hydration, name)).toContain("${LEGACY_SWEEPABLE}");
    }
    expect(source(hydration)).toContain(
      "const LEGACY_SWEEPABLE = sql`r.execution_lane is distinct from ${FANSLY_SYNC_ENGINE_HYDRATION_LANE}`;",
    );
    expect(FANSLY_SYNC_ENGINE_HYDRATION_LANE).toBe("fansly_sync_engine");
  });
});

describe("the step-3 switch, its roll-back and the legacy import are gone (step 4, S4-21)", () => {
  // The deletion's proof, kept true: none of these names anywhere in the
  // sources or the tests. Spelled in halves so this file is no hit itself.
  const GONE = [
    ["import", "Legacy"],
    ["legacyOwns", "FanslyPageSql"],
    ["assertLegacyOwns", "FanslyPage"],
    ["sync ", "rollback"],
    ["legacy", "-stop"],
  ].map(([head, tail]) => `${head}${tail}`);

  it.each(GONE)("%s names nothing in apps, packages or tests", (name) => {
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        ["-rlF", name, "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.vite", "apps", "packages", "tests"],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      // grep exits 1 when nothing matches.
    }
    expect(hits.split("\n").filter(Boolean)).toEqual([]);
  });

  it("their files and the database's side of them are gone", () => {
    for (const path of [
      "apps/runtime/src/sync/switch",
      "apps/runtime/src/sync/cli/switch.ts",
      "packages/db/src/repositories/sync/legacy-import.ts",
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    const repositories = sourcesUnder("packages/db/src/repositories").map(source).join("\n");
    for (const name of [
      "handFanslySendGuardToEngine", "handFanslySendGuardBackToLegacy", "markSyncPageLegacyImported",
      "setSyncRequestsEnabledAt", "importWorkCursor", "importWorkBreaker", "lockBreakerImportFence",
      "cancelLiveWorkForRollback", "supersedeShadowWork", "markPageThreadsUnverified",
      "listOpenLegacyHydrationRequestsForPage", "listFanslyDmRawPayloadsAfterId",
      "listFanslyPurchaseHistoryCapturedContentIds", "listFanslyMessagePurchaseTargetsAfterId",
    ]) {
      expect(repositories, name).not.toContain(name);
    }
    // The audit rows the switch wrote stay as records; nothing writes one.
    expect(sourcesUnder("apps/runtime/src").map(source).join("\n")).not.toMatch(/admin\.sync_(switch|rollback)/);
  });
});

describe("the legacy processes ask before they act", () => {
  it.each([
    ["apps/runtime/src/services/ai-media-describe/worker.ts", "downloadAiMediaThroughPageEgress", "isFanslyPageEngineOwned(app.db, input.pageId)"],
    // S3-05, S4-19: the /account/me levers go through the engine and refuse a
    // page being switched, or one the engine does not run, before anything is
    // resolved or sent — no legacy `/account/me` is left behind them.
    ["apps/runtime/src/services/connections.ts", "updatePageCredentials", "await assertFanslyPageOnEngine(app, stored.page);"],
    ["apps/runtime/src/services/page-proxies.ts", "setPageProxy", "await assertFanslyPageOnEngine(app, known.page);"],
  ])("%s %s", (path, name, check) => {
    expect(functionBody(path, name)).toContain(check);
  });

  // Step 4 (S4-20): the legacy senders that were fenced here are deleted with
  // the adapter's HTTP — the probes (`sync probe` is the engine's) and the
  // alias backfill (`sync work enqueue --resource fan-profiles.alias-backfill`)
  // — and the describer's page-egress download asks for no send guard: it
  // sends no Fansly request at all.
  it("the probes, the alias backfill and the adapter are gone, and no runtime code asks for a page's send guard", () => {
    for (const path of [
      "packages/fansly/src/adapter.ts",
      "apps/runtime/src/services/fansly-endpoint-probe.ts",
      "apps/runtime/src/services/fansly-replay-probe.ts",
      "apps/runtime/src/services/fansly-page-alias-backfill.ts",
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    const cli = source("apps/runtime/src/cli.ts");
    for (const command of ["fansly:endpoint-probe", "fansly:replay-probe", "fansly-page-alias-backfill"]) {
      expect(cli, command).not.toContain(command);
    }
    expect(source("apps/runtime/src/bootstrap.ts")).not.toMatch(/FanslyAdapter|\badapter\b/);
    const describer = source("apps/runtime/src/services/ai-media-describe/worker.ts");
    expect(describer).not.toMatch(/SendGuard/);
    expect(functionBody("apps/runtime/src/services/ai-media-describe/worker.ts", "downloadAiMediaThroughPageEgress"))
      .toContain("return await downloadMediaForDescribe({ url: input.url, dispatcher: egress.dispatcher });");
    const download = source("apps/runtime/src/services/egress/media-download.ts");
    expect(download).not.toMatch(/SendGuard|SendLease|\.acquire\(/);
    expect(functionBody("apps/runtime/src/services/egress/media-download.ts", "downloadMediaForDescribe")).toMatch(
      /if \(isFanslyHost\(current\.hostname\)\) \{[\s\S]{0,200}?return \{ ok: false, reason: "send_guard", httpStatus: null \};/,
    );
  });

  // Step 4 (S4-10): the legacy executor runs no Fansly stream, so the AI
  // describer's candidates and source wake none; since S4-14 they file no
  // accelerator read either (the head read is the engine's WS confirmation).
  it.each([
    "apps/runtime/src/services/projections/ai-media-candidates.ts",
    "apps/runtime/src/services/ai-media-describe/fansly-source.ts",
  ])("%s wakes no legacy DM stream and files no accelerator read", (path) => {
    expect(source(path)).not.toContain("requestPageSync");
    expect(source(path)).not.toContain("requestAiMediaAcceleratorRead");
  });

  it("the verify route and the CLI verify go through the engine (S3-05) and have no legacy fallback (S4-19); the targeted backfill CLI is gone (S4-15)", () => {
    // The route: the engine's answer or a refusal — the page's context (which
    // may open a proxy incident) is never resolved, and nothing sends.
    const route = functionBody("apps/runtime/src/modules/catalog/index.ts", "registerCatalogRoutes");
    const verify = route.slice(route.indexOf('server.post("/api/v1/admin/pages/:pageLabel/verify"'), route.indexOf('server.patch("/api/v1/admin/pages/:pageLabel/credentials"'));
    expect(verify).toMatch(
      /const onEngine = await verifyPageOnEngine\(appContext, request\.params\.pageLabel\);\s*if \(onEngine !== null\) return onEngine;/,
    );
    expect(verify).not.toMatch(/resolvePageContext|adapter|SendGuard/);
    const cli = source("apps/runtime/src/cli.ts");
    expect(cli).toMatch(
      /const onEngine = await verifyPageOnEngine\(app, options\.page\);[\s\S]{0,300}?return;\s*\}/,
    );
    // No sender behind the levers any more: the legacy `/account/me` of the
    // adapter and its page send guard are reached by none of them.
    for (const path of [
      "apps/runtime/src/modules/catalog/index.ts",
      "apps/runtime/src/cli.ts",
      "apps/runtime/src/services/connections.ts",
      "apps/runtime/src/services/page-proxies.ts",
      "apps/runtime/src/services/sync-engine-account.ts",
    ]) {
      expect(source(path), path).not.toMatch(/refreshPageMetadata|adapter\.verifySession|adapter\.getAccountMe|fanslyPageSendGuard/);
    }
    expect(functionBody("apps/runtime/src/services/sync-engine-account.ts", "assertFanslyPageOnEngine")).toContain(
      "if (!ownership.owned) throw new LegacySyncRetiredError(",
    );
    // `dm backfill-thread` queued a legacy read of one thread; nothing queues one now.
    expect(cli).not.toContain("backfill-thread");
    expect(cli).not.toContain("sync.thread.backfill");
  });
});
