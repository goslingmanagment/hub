import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { syncPages } from "@agency_hub_core/db";

import { sourceFiles, syncPageRowWriters } from "./helpers/sync-page-row-writers.ts";

// The old hold columns of the page row (step 4, S4-33 — the last of the
// three releases that took them away; owner decision №26).
//
// A page's holds are its rows of `sync_holds`. The hold slot of `sync_pages`
// (`hold_kind`, `hold_until`, `hold_since`, `hold_detail`) and
// `resource_holds` were written through S4-31, left stale by S4-32 — which
// stopped naming them anywhere — and are dropped by the migration of this
// release, with the slot's two CHECKs. NOTHING in `apps`, `packages` or
// `scripts` names them, as nothing did in the release before: that is what
// makes the drop compatible with that image, and its migration rollback
// compatible. Pinned here. The migrations name them, and so do the three
// tests of those migrations (this file, tests/sync-engine-migrations.test.ts
// and tests/sync-hold-set.integration.test.ts, which runs the drop and what
// is left of the page table on a Postgres) — and nothing else.

const OLD_HOLD_COLUMNS = ["hold_kind", "hold_until", "hold_since", "hold_detail", "resource_holds"] as const;
/** The key the route state had inside `resource_holds`. */
const OLD_ROUTE_STATE_KEY = "route:state";

const TEXT_FILE = /\.(ts|tsx|mts|mjs|cjs|js|sql|sh|json|md|css|html|ya?ml)$/;

/** Every text file of the three trees but the migrations (and built output). */
const ALL = ["apps", "packages", "scripts"].flatMap((root) => sourceFiles(root, TEXT_FILE)).sort();

/** Every text file of the tests. */
const TESTS = sourceFiles("tests", TEXT_FILE).sort();

/** The tests of the migrations that made and dropped the columns. */
const MIGRATION_TESTS = [
  "tests/sync-engine-migrations.test.ts",
  "tests/sync-hold-set.integration.test.ts",
  "tests/sync-old-hold-columns.test.ts",
];

/** `file:line` of every line of `files` that matches. */
function linesNaming(pattern: RegExp, files: readonly string[] = ALL): string[] {
  return files.flatMap((file) => readFileSync(file, "utf8").split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])));
}

function filesNaming(pattern: RegExp, files: readonly string[]): string[] {
  return [...new Set(linesNaming(pattern, files).map((hit) => hit.slice(0, hit.lastIndexOf(":"))))];
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
    expect(filesNaming(/hold_until/, ALL)).toEqual([
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
    // Nor the slot's two CHECKs, which went with the columns.
    expect(linesNaming(/sync_pages_hold_(kind|pair)_check/)).toEqual([]);

    expect(existsSync("packages/db/src/repositories/sync/holds-legacy.ts")).toBe(false);
    expect(linesNaming(
      /holds-legacy|mirrorSyncHoldsToLegacyColumns|legacyHoldColumnsOf|SyncLegacyHoldColumns|reconcileSyncHoldsWithLegacyColumns|holdRowsOfLegacyColumns|sameLegacyHoldColumns|SyncLegacyHoldsUnreadableError/,
    )).toEqual([]);
  });

  it("the page row is never read by `*`: a column dropped, or added later, changes no result", () => {
    expect(linesNaming(/\bsp\.\*|\*\s+from\s+sync_pages\b|(to_jsonb|row_to_json)\((sp|sync_pages)\)/)).toEqual([]);
    for (const file of ["packages/db/src/repositories/sync/pages.ts", "packages/db/src/repositories/sync/attempts.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/returning\s+\*/);
    }
  });
});

describe("of the tests, only those of the migrations name an old hold column", () => {
  it("scans every test, helper and fixture", () => {
    expect(TESTS.length).toBeGreaterThan(400);
    for (const file of MIGRATION_TESTS) expect(TESTS, file).toContain(file);
    expect(TESTS).toContain("tests/helpers/sync-holds.ts");
  });

  it("the hold slot's kind, start and detail, the resource-hold map, its route-state key and the two CHECKs", () => {
    // rg -l "hold_kind|hold_since|hold_detail|resource_holds|route:state|sync_pages_hold_" tests
    expect(filesNaming(/hold_kind|hold_since|hold_detail|resource_holds|route:state|sync_pages_hold_/, TESTS)).toEqual(MIGRATION_TESTS);
  });

  it("`hold_until`: they, and the test of the legacy queue's cooldown table, which has a column of that name", () => {
    // rg -l "hold_until" tests
    expect(filesNaming(/hold_until/, TESTS)).toEqual(["tests/page-sync-provider-cooldown.integration.test.ts", ...MIGRATION_TESTS]);
    const cooldown = readFileSync("tests/page-sync-provider-cooldown.integration.test.ts", "utf8");
    for (const line of cooldown.split("\n").filter((text) => /hold_until/.test(text))) {
      expect(line, line).toContain("insert into page_sync_provider_holds (page_id, hold_until, reason, stream, armed_at)");
    }
  });

  it("the image that rewrote the columns is no rollback target, and its rewrite is kept by no helper", () => {
    // rg -n "sync-holds-previous-image|mirrorHoldsAsPreviousImage|previousImageHoldColumnsOf" tests
    expect(existsSync("tests/helpers/sync-holds-previous-image.ts")).toBe(false);
    expect(filesNaming(/sync-holds-previous-image|mirrorHoldsAsPreviousImage|previousImageHoldColumnsOf/, TESTS))
      .toEqual(["tests/sync-old-hold-columns.test.ts"]);
  });
});

describe("the statements that write the page row", () => {
  it("are these, in the sync repositories alone — each runs after the drop in tests/sync-hold-set.integration.test.ts", () => {
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
  const dropOldColumns = migrations.find((file) => file.endsWith("_sync_pages_drop_old_hold_columns.sql"))!;
  const squash = (text: string) => text.replace(/\s+/g, " ");

  it("the README: the columns are gone, the release before the drop is the one rollback target, no older image is one", () => {
    const readme = squash(readFileSync("apps/runtime/src/sync/README.md", "utf8"));
    expect(readme).toContain("**The page row holds nothing, and it has no hold column**");
    expect(readme).toContain(`\`${dropOldColumns}\` dropped those five columns and the slot's two CHECKs`);
    expect(readme).toContain("**Read a page's holds from `sync_holds` or `sync page status`**: a query that selects one of the old columns fails.");
    expect(readme).toContain("**The release before this one** (S4-32) is a safe rollback target, and the only one.");
    expect(readme).toContain("**Every image older than that is NOT a rollback target any more.**");
    // The one thing the deploy cannot check by itself.
    expect(readme).toContain("**never in the deploy that brings S4-32**");
    expect(readme).toContain("check that every running service's image is a build with S4-32");
    expect(readme).toContain(`\`${holdSet}\` and \`${dropHoldStep}\` stay out of \`ROLLBACK_COMPATIBLE_MIGRATIONS\``);
    // Nothing of the release before is left standing as "this release".
    expect(readme).not.toMatch(/old hold columns are stale|still in the database until the next release/);
  });

  it("the deploy: the drop arms the automatic rollback, the two migrations before it do not", () => {
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    const compatible = deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0] ?? "";
    expect(compatible).toContain('"0239_retire_fansly_legacy_sync_states.sql"');
    for (const migration of [holdSet, dropHoldStep]) {
      expect(compatible, migration).not.toContain(`"${migration}"`);
      // The reason stays where the entry was.
      expect(compatible, migration).toContain(migration);
    }
    const reasons = squash(compatible.replaceAll("\n  #", ""));
    expect(reasons).toContain("keeps the automatic rollback off rather than fail open");

    // The drop is the list's last entry, under its reason: the image before
    // it names none of the columns — the S4-32 image, and that one alone.
    expect(compatible.endsWith(`  "${dropOldColumns}"\n)`)).toBe(true);
    expect(reasons).toContain("The previous image (S4-32) names none of them");
    expect(reasons).toContain("That is true of the S4-32 image ALONE");
    expect(reasons).toContain("never in the deploy that brings S4-32");
  });

  // The engine's runbook (docs/runbooks/sync.md) is another branch of the
  // same step: where the tree has it, it says the same.
  it.runIf(existsSync("docs/runbooks/sync.md"))("the runbook: the columns are dropped, and only the release before the drop is a rollback target", () => {
    const runbook = squash(readFileSync("docs/runbooks/sync.md", "utf8"));
    expect(runbook).toContain("NOT a rollback target");
    expect(runbook).toContain("`sync_holds`");
    expect(runbook).toMatch(/old hold columns of `sync_pages` are dropped/);
  });
});
