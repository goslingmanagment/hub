import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENGINE_OWNED_SYNC_PAGE_MODES,
  engineOwnsFanslyPageSql,
  FANSLY_SYNC_ENGINE_HYDRATION_LANE,
  legacyOwnsFanslyPageSql,
  SYNC_PAGE_MODES,
} from "@agency_hub_core/db";

import {
  FANSLY_PAGE_ON_SYNC_ENGINE_CODE,
  FanslyPageOnSyncEngineError,
} from "../apps/runtime/src/services/sync-engine-guard.ts";
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

  it("the AI fast lane holds an engine page", () => {
    expect(functionBody("packages/db/src/repositories/ai-media-descriptions.ts", "getFanslyFastLanePageSyncGate"))
      .toContain("engineOwnsFanslyPageSql(sql`${input.pageId}`)} as held");
  });

  it("the hydration dispatcher and auto-approval skip engine pages; the sweeps skip engine rows", () => {
    const hydration = "packages/db/src/repositories/agent-hydration.ts";
    for (const name of ["listDispatchableAgentHydrationRequests", "listAutoApprovableAgentHydrationRequests"]) {
      expect(functionBody(hydration, name)).toContain('legacyOwnsFanslyPageSql(sql.raw("r.page_id"))');
    }
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

  it("the deletion window drift pass leaves engine pages out", () => {
    expect(functionBody("packages/db/src/repositories/fansly-ws-deletions.ts", "listFanslyWsDeletionWindowDrift"))
      .toContain('legacyOwnsFanslyPageSql(sql.raw("t.platform_account_id"))');
  });
});

describe("the legacy processes ask before they act", () => {
  it.each([
    ["apps/runtime/src/services/fansly-ws/worker.ts", "startFanslyWsWorker", "listEngineOwnedFanslyPages(app.db)"],
    ["apps/runtime/src/services/fansly-ws/worker.ts", "runPage", "isFanslyPageEngineOwned(owner.db, stored.page.id)"],
    ["apps/runtime/src/services/fansly-ws/worker.ts", "runPage", "isFanslyPageOwnedBySyncEngineError(error)"],
    [
      "apps/runtime/src/services/projections/fansly-ws-hints.ts",
      "runFanslyWsHintProjection",
      "isFanslyPageEngineOwned(app.db, accountId)",
    ],
    [
      "apps/runtime/src/services/projections/ai-media-candidates.ts",
      "runAiMediaCandidatesProjection",
      "isFanslyPageEngineOwned(app.db, accountId)",
    ],
    ["apps/runtime/src/services/ai-media-describe/fansly-source.ts", "maybeAccelerate", "isFanslyPageEngineOwned(app.db, row.pageId)"],
    ["apps/runtime/src/services/ai-media-describe/worker.ts", "downloadAiMediaThroughPageEgress", "isFanslyPageEngineOwned(app.db, input.pageId)"],
    ["apps/runtime/src/services/fansly-ws-deletions.ts", "applyFanslyWsDeletions", "listEngineOwnedFanslyPages(db)"],
    ["apps/runtime/src/services/connections.ts", "updatePageCredentials", "assertLegacyOwnsFanslyPage(app, stored.page"],
    ["apps/runtime/src/services/page-proxies.ts", "setPageProxy", "assertLegacyOwnsFanslyPageLabels(app, [pageLabel]"],
    ["apps/runtime/src/services/fansly-replay-probe.ts", "runFanslyReplayProbe", "assertLegacyOwnsFanslyPageLabels(app, options.pageLabels"],
    ["apps/runtime/src/services/fansly-endpoint-probe.ts", "runFanslyEndpointProbe", "assertLegacyOwnsFanslyPageLabels(app, options.pageLabels"],
    ["apps/runtime/src/services/fansly-page-alias-backfill.ts", "backfillFanslyPageAliases", "assertLegacyOwnsFanslyPageLabels(app, requestedPageLabels"],
    ["apps/runtime/src/services/fansly-page-alias-backfill.ts", "backfillFanslyPageAliases", "listEngineOwnedFanslyPages(app.db)"],
    ["apps/runtime/src/services/fansly-ws-policy-repair.ts", "inspectBinding", "assertLegacyOwnsFanslyPageLabels(app, [label]"],
  ])("%s %s", (path, name, check) => {
    expect(functionBody(path, name)).toContain(check);
  });

  it("the verify route, the CLI verify and the targeted backfill CLI refuse an engine page", () => {
    // Before the page's context is resolved (which may open a proxy incident).
    expect(source("apps/runtime/src/modules/catalog/index.ts")).toMatch(
      /assertLegacyOwnsFanslyPageLabels\(appContext, \[request\.params\.pageLabel\][^;]*;\s*const pageContext = await resolvePageContext\(/,
    );
    const cli = source("apps/runtime/src/cli.ts");
    expect(cli).toMatch(
      /assertLegacyOwnsFanslyPageLabels\(app, \[options\.page\], SYNC_ENGINE_HINTS\.verify\);\s*const context = await resolvePageContext\(/,
    );
    // `dm backfill-thread`: before the job is queued.
    const refusal = cli.indexOf("await assertLegacyOwnsFanslyPageId(app, thread.platformAccountId, SYNC_ENGINE_HINTS.history);");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(cli.indexOf("const jobId = await queueTargetedThreadBackfill("));
  });

  it.each([
    "scripts/fansly-ws/binding-preflight.ts",
    "scripts/fansly-ws/continuity-runtime.ts",
    "scripts/fansly-ws/probe.ts",
  ])("the operator script %s checks before its snapshot", (path) => {
    expect(source(path)).toMatch(/await refuseEngineOwnedPage\(db, [^)]+\);\s*\S+ = await readProbeSnapshot\(/);
  });
});

describe("the refusal", () => {
  it("is a 409 with the page, the mode and the hint", () => {
    const error = new FanslyPageOnSyncEngineError({ pageId: 4, pageLabel: "lilly-1", mode: "live", hint: "ask the engine" });
    expect(error).toMatchObject({ statusCode: 409, code: FANSLY_PAGE_ON_SYNC_ENGINE_CODE, pageId: 4, mode: "live" });
    expect(FANSLY_PAGE_ON_SYNC_ENGINE_CODE).toBe("fansly_page_on_sync_engine");
    expect(error.message).toBe(
      "Page lilly-1 is on the Fansly Sync Engine (mode live): the legacy engine sends nothing for it; ask the engine",
    );
  });
});
