import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENGINE_OWNED_SYNC_PAGE_MODES,
  engineOwnsFanslyPageSql,
  FANSLY_SYNC_ENGINE_HYDRATION_LANE,
  legacyOwnsFanslyPageSql,
  SYNC_PAGE_MODES,
} from "@agency_hub_core/db";

import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";

// Step-3 design §3.1 (S3-01): the legacy fences of a page the Fansly Sync
// Engine owns. The behaviour is pinned by tests/sync-legacy-fence.integration.
// test.ts; this file pins the TEXT, so a later edit cannot quietly drop a
// fence from a legacy scheduler or lever: one predicate, named `handover` and
// `live` only (J8: `shadow` never fences legacy), in every place the design
// lists.

const root = join(__dirname, "..");
const dialect = new PgDialect();

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

function rendered(fragment: ReturnType<typeof sql>) {
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql.replace(/\s+/g, " ").trim(), params: query.params };
}

describe("the legacy-owns predicate", () => {
  it("names handover and live only, never shadow or off (J8)", () => {
    expect([...ENGINE_OWNED_SYNC_PAGE_MODES]).toEqual(["handover", "live"]);
    expect(SYNC_PAGE_MODES.filter((mode) => !(ENGINE_OWNED_SYNC_PAGE_MODES as readonly string[]).includes(mode)))
      .toEqual(["off", "shadow"]);
  });

  it("is one not-exists over sync_pages with its own alias", () => {
    expect(rendered(engineOwnsFanslyPageSql(sql.raw("st.page_id")))).toEqual({
      sql: "exists ( select 1 from sync_pages engine_owned_page where engine_owned_page.page_id = st.page_id"
        + " and engine_owned_page.mode in ('handover', 'live') )",
      params: [],
    });
    expect(rendered(legacyOwnsFanslyPageSql(sql.raw("st.page_id")))).toEqual({
      sql: "not exists ( select 1 from sync_pages engine_owned_page where engine_owned_page.page_id = st.page_id"
        + " and engine_owned_page.mode in ('handover', 'live') )",
      params: [],
    });
    // A bound page id is a parameter, not text.
    expect(rendered(legacyOwnsFanslyPageSql(sql`${42}`)).params).toEqual([42]);
  });
});

describe("the legacy schedulers carry the predicate", () => {
  const pageSync = "packages/db/src/repositories/page-sync.ts";

  it.each([
    ["listRunnablePageSync", 'legacyOwnsFanslyPageSql(sql.raw("st.page_id"))'],
    ["markPageSyncEnqueued", "legacyOwnsFanslyPageSql(sql`${pageId}`)"],
    ["acquirePageSyncLease", 'legacyOwnsFanslyPageSql(sql.raw("st.page_id"))'],
    ["acquireTargetedPageSyncLease", 'legacyOwnsFanslyPageSql(sql.raw("st.page_id"))'],
  ])("%s", (name, predicate) => {
    expect(functionBody(pageSync, name)).toContain(predicate);
  });

  it("the sync_silent deadman leaves engine pages out of both halves", () => {
    const body = functionBody("packages/db/src/repositories/sync.ts", "getFanslySyncLiveness");
    expect(body).toContain('legacyOwnsFanslyPageSql(sql.raw("r.page_id"))');
    expect(body).toContain('legacyOwnsFanslyPageSql(sql.raw("st.page_id"))');
  });

  it("the hydration dispatcher skips engine pages; the sweeps skip engine rows", () => {
    const hydration = "packages/db/src/repositories/agent-hydration.ts";
    expect(functionBody(hydration, "listDispatchableAgentHydrationRequests"))
      .toContain('legacyOwnsFanslyPageSql(sql.raw("r.page_id"))');
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
