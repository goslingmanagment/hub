import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { syncPages } from "@agency_hub_core/db";

import { sourceFiles, syncPageRowWriters } from "./helpers/sync-page-row-writers.ts";

// The old hold columns of the page row (step 4, S4-32 — the second of the
// three releases that take them away; owner decision №26).
//
// A page's holds are its rows of `sync_holds`. Until this release every hold
// write also rewrote the hold slot of `sync_pages` (`hold_kind`, `hold_until`,
// `hold_since`, `hold_detail`) and `resource_holds` from the rows, for the
// hold-set release, which lets those columns win over the rows. That rewrite
// is gone, with its file and the drizzle fields: the columns stay in the
// database, stale, until the next release drops them, and NOTHING in `apps`,
// `packages` or `scripts` names them — which is what makes that drop
// compatible with this image. Pinned here; the migrations (and their pin
// tests) are the one place that still does. What it means on a Postgres:
// tests/sync-hold-set.integration.test.ts.

const OLD_HOLD_COLUMNS = ["hold_kind", "hold_until", "hold_since", "hold_detail", "resource_holds"] as const;
/** The key the route state had inside `resource_holds`. */
const OLD_ROUTE_STATE_KEY = "route:state";

/** Every text file of the three trees but the migrations (and built output). */
const ALL = ["apps", "packages", "scripts"]
  .flatMap((root) => sourceFiles(root, /\.(ts|tsx|mts|mjs|cjs|js|sql|sh|json|md|css|html|ya?ml)$/))
  .sort();

/** `file:line` of every line of `ALL` that matches. */
function linesNaming(pattern: RegExp): string[] {
  return ALL.flatMap((file) => readFileSync(file, "utf8").split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])));
}

describe("nothing in apps, packages and scripts names an old hold column of the page row", () => {
  it("scans the three trees, the migrations excepted", () => {
    expect(ALL.length).toBeGreaterThan(500);
    expect(ALL).toContain("packages/db/src/repositories/sync/pages.ts");
    expect(ALL).toContain("packages/db/src/schema.ts");
    expect(ALL).toContain("apps/runtime/src/sync/README.md");
    expect(ALL).toContain("apps/runtime/src/sync/budgets-calibration.sql");
    expect(ALL).toContain("scripts/deploy-production.sh");
    expect(ALL.filter((file) => file.includes("/migrations/"))).toEqual([]);
  });

  it("no line names the hold slot's kind, start or detail, the resource-hold map or its route-state key", () => {
    // rg -n "hold_kind|hold_since|hold_detail|resource_holds|route:state" apps packages scripts -g '!packages/db/migrations/*'
    expect(linesNaming(/hold_kind|hold_since|hold_detail|resource_holds|route:state/)).toEqual([]);
    expect(OLD_ROUTE_STATE_KEY).toBe("route:state");
  });

  it("`hold_until` is named only as two namesakes: another table's column and a report's column over the hold set", () => {
    // rg -n "hold_until" apps packages scripts -g '!packages/db/migrations/*'
    const named = linesNaming(/hold_until/);
    expect([...new Set(named.map((hit) => hit.slice(0, hit.lastIndexOf(":"))))]).toEqual([
      "apps/runtime/src/sync/budgets-calibration.sql",
      "packages/db/src/schema.ts",
    ]);

    // `page_sync_provider_holds.hold_until` (0219): the legacy queue's
    // cooldown, a table of its own that stays as a record.
    const schema = readFileSync("packages/db/src/schema.ts", "utf8");
    expect(schema.match(/hold_until/g)).toHaveLength(1);
    const providerHolds = schema.slice(schema.indexOf('pgTable("page_sync_provider_holds"'));
    expect(providerHolds.slice(0, providerHolds.indexOf("\n});"))).toContain('timestamp("hold_until", { withTimezone: true }).notNull()');

    // The calibration report's column: the end of a route's hold, read from
    // `sync_holds.until`. Of the page row it reads its id and mode alone.
    const report = readFileSync("apps/runtime/src/sync/budgets-calibration.sql", "utf8");
    expect(report).toContain("max(h.until) filter (where h.kind = 'route_hold') as hold_until,");
    for (const line of report.split("\n").filter((text) => /hold_until/.test(text))) {
      expect(line, line).toMatch(/\bas hold_until,$|\b(rs|v)\.hold_until\b/);
    }
    expect([...new Set(report.match(/\bsp\.[a-z_]+/g))].sort()).toEqual(["sp.mode", "sp.page_id"]);
  });

  it("the drizzle table maps none of them, and nothing of the rewrite is left", () => {
    const mapped = Object.values(syncPages as unknown as Record<string, { name?: unknown }>).map((column) => column.name);
    expect(mapped).toContain("network_failure_streak");
    for (const column of OLD_HOLD_COLUMNS) expect(mapped, column).not.toContain(column);
    // Nor the slot's two CHECKs, which go with the columns.
    expect(linesNaming(/sync_pages_hold_(kind|pair)_check/)).toEqual([]);

    expect(existsSync("packages/db/src/repositories/sync/holds-legacy.ts")).toBe(false);
    expect(linesNaming(
      /holds-legacy|mirrorSyncHoldsToLegacyColumns|legacyHoldColumnsOf|SyncLegacyHoldColumns|reconcileSyncHoldsWithLegacyColumns|holdRowsOfLegacyColumns|sameLegacyHoldColumns|SyncLegacyHoldsUnreadableError/,
    )).toEqual([]);
  });

  it("the page row is never read by `*`: a stale column reaches no reader", () => {
    expect(linesNaming(/\bsp\.\*|\*\s+from\s+sync_pages\b|(to_jsonb|row_to_json)\((sp|sync_pages)\)/)).toEqual([]);
    for (const file of ["packages/db/src/repositories/sync/pages.ts", "packages/db/src/repositories/sync/attempts.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/returning\s+\*/);
    }
  });
});

describe("the statements that write the page row", () => {
  it("are these, in the sync repositories alone — each runs over stale old columns in tests/sync-hold-set.integration.test.ts", () => {
    const writers = syncPageRowWriters();
    expect([...new Set(writers.map((writer) => writer.file))]).toEqual([
      "packages/db/src/repositories/sync/attempts.ts",
      "packages/db/src/repositories/sync/pages.ts",
    ]);
    expect(writers.map((writer) => `${writer.statement} ${writer.name}`)).toEqual([
      "update insertAdmission",
      "update captureAttempt",
      "insert ensureSyncPage",
      "insert ensureFanslySyncPages",
      "update setSyncPageMode",
      "insert createLiveSyncPage",
      "update trustSyncPageCredentials",
      "update acquireSyncPageOwnership",
      "update heartbeatSyncPageOwner",
      "update writeSafeRelease",
      "update confirmSyncOwnersStopped",
      "update recordSyncPageIdentityProof",
      "update setNetworkFailureStreak",
      "update addSyncPageLiftedDmExclusion",
      "update removeSyncPageLiftedDmExclusion",
      "update setPagePause",
      "update adjustPausedResources",
      "update setRegistryOverride",
      "update advanceWsRouterCursor",
    ]);
  });

  it("a hold write is not one of them: it locks the page row and writes the hold rows", () => {
    const pages = readFileSync("packages/db/src/repositories/sync/pages.ts", "utf8");
    expect(pages.match(/writeHoldSet\(db, input,/g)).toHaveLength(4);
    const holdWrite = pages.slice(pages.indexOf("async function writeHoldSet<T>("), pages.indexOf("export async function setPageHold("));
    expect(holdWrite).toContain("await lockPageForHoldWrite(tx, input.pageId, input.generation);");
    expect(holdWrite).toContain("return write(tx);");
    const lock = pages.slice(pages.indexOf("async function lockPageForHoldWrite("), pages.indexOf("async function writeHoldSet<T>("));
    expect(lock).toMatch(/select owner_generation::text as generation from sync_pages where page_id = \$\{pageId\} for no key update/);
    // The lock is `for no key update`; neither function writes a table itself.
    expect(`${lock}${holdWrite}`).not.toMatch(/\b(insert into|delete from|update [a-z_]+\s+set)\b/);
  });
});

describe("what the operator is told", () => {
  const migrations = readdirSync("packages/db/migrations").filter((file) => file.endsWith(".sql"));
  const holdSet = migrations.find((file) => file.endsWith("_sync_holds.sql"))!;
  const dropHoldStep = migrations.find((file) => file.endsWith("_sync_pages_drop_hold_step.sql"))!;
  const squash = (text: string) => text.replace(/\s+/g, " ");

  it("the README: the columns are stale, the previous release is the rollback target, the hold-set release is none", () => {
    const readme = squash(readFileSync("apps/runtime/src/sync/README.md", "utf8"));
    expect(readme).toContain("**The page row holds nothing; its old hold columns are stale**");
    expect(readme).toContain("**Read a page's holds from `sync_holds` or `sync page status`, never from the page row**");
    expect(readme).toContain("**The release before this one** (S4-31:");
    expect(readme).toContain(
      "**The hold-set release (S4-30, the one that brought `sync_holds`) and every image older than it are NOT rollback targets any more.**",
    );
    expect(readme).toContain(`never in a deploy that still has \`${holdSet}\` or \`${dropHoldStep}\` to apply`);
  });

  it("the deploy: neither migration arms an automatic rollback any more", () => {
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    const compatible = deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0] ?? "";
    expect(compatible).toContain('"0239_retire_fansly_legacy_sync_states.sql"');
    for (const migration of [holdSet, dropHoldStep]) {
      expect(compatible, migration).not.toContain(`"${migration}"`);
      // The reason stays where the entry was.
      expect(compatible, migration).toContain(migration);
    }
    expect(squash(compatible.replaceAll("\n  #", ""))).toContain("keeps the automatic rollback off rather than fail open");
  });

  // The engine's runbook (docs/runbooks/sync.md) is another branch of the
  // same step: where the tree has it, it says the same.
  it.runIf(existsSync("docs/runbooks/sync.md"))("the runbook: the hold-set release is no rollback target", () => {
    const runbook = squash(readFileSync("docs/runbooks/sync.md", "utf8"));
    expect(runbook).toContain("NOT a rollback target");
    expect(runbook).toContain("`sync_holds`");
    expect(runbook).toMatch(/old hold columns of `sync_pages` are stale/);
  });
});
