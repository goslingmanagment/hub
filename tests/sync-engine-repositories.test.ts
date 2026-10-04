import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sortDemandSignals } from "@agency_hub_core/db";

// Fansly Sync Engine core repositories (design §2.10): the structural pins.
//
// I17 — a page is `live` only by its birth: Fansly onboarding creates the
// page's row live in the transaction that creates the page
// (`createLiveSyncPage`, step 4 S4-05), and nothing else calls it. Nothing
// makes an existing page `handover` or `live`, takes a page out of `live`, or
// flips a send guard row's owner: the step-3 switch, its rollback and the
// switch capability that opened those transitions are gone (step 4 S4-21), and
// `setSyncPageMode` knows `off ↔ shadow` alone.

const root = join(__dirname, "..");

function grepFiles(pattern: string, dirs: readonly string[]): string {
  try {
    return execFileSync(
      "grep",
      ["-rlE", pattern, "--include=*.ts", "--exclude-dir=node_modules", "--exclude-dir=dist", ...dirs],
      { cwd: root, encoding: "utf8" },
    );
  } catch {
    // grep exits 1 when nothing matches.
    return "";
  }
}

function filesMatching(pattern: string, dirs: readonly string[]): string[] {
  return grepFiles(pattern, dirs).split("\n").filter(Boolean).sort();
}

const SOURCES = ["apps/runtime/src", "packages"] as const;

describe("Fansly Sync Engine repository boundaries", () => {
  it("has no switch capability and no mode change but off ↔ shadow (I17, step 4 S4-21)", () => {
    expect(filesMatching("SyncSwitchCapability|issueSyncSwitchCapability|capability_required", SOURCES)).toEqual([]);
    const pages = readFileSync(join(root, "packages/db/src/repositories/sync/pages.ts"), "utf8");
    expect(pages).toContain('const OWNER_TRANSITIONS: ReadonlySet<string> = new Set(["off>shadow", "shadow>off"]);');
    expect(pages).not.toMatch(/[a-z]+>(handover|live)|(handover|live)>[a-z]+/);
    // The one statement that changes a mode is setSyncPageMode's, behind that set.
    expect(pages.match(/set mode = \$\{input\.to\}/g)).toHaveLength(1);
    expect(pages).toMatch(/if \(!OWNER_TRANSITIONS\.has\(`\$\{from\}>\$\{input\.to\}`\)\) \{\s+return \{ kind: "refused", from, to: input\.to, reason: "transition_not_allowed" \};/);
  });

  it("flips no send guard row's owner: a row keeps the engine it was born or switched to (step 4 S4-21)", () => {
    expect(filesMatching("set owner_engine|handFanslySendGuard", SOURCES)).toEqual([]);
  });

  it("creates a page live only at its onboarding (I17, step 4 S4-05)", () => {
    expect(filesMatching("createLiveSyncPage\\(", SOURCES)).toEqual([
      "apps/runtime/src/services/page-onboarding.ts",
      "packages/db/src/repositories/sync/pages.ts",
    ]);
    // The only insert of a row that is born live.
    expect(filesMatching("'live', clock_timestamp\\(\\)", SOURCES)).toEqual([
      "packages/db/src/repositories/sync/pages.ts",
    ]);
  });

  it("writes sync_pages only through the sync repositories, and the mode only through setSyncPageMode", () => {
    expect(filesMatching("update sync_pages", SOURCES)).toEqual([
      "packages/db/src/repositories/sync/attempts.ts",
      // The old hold columns, rewritten from the hold set for the previous
      // image (step 4 S4-30; the file goes with the columns).
      "packages/db/src/repositories/sync/holds-legacy.ts",
      "packages/db/src/repositories/sync/pages.ts",
    ]);
    // The hold set is written by the hold writers alone (and re-read from the
    // old columns at an acquisition).
    expect(filesMatching("(insert into|update|delete from) sync_holds\\b", SOURCES)).toEqual([
      "packages/db/src/repositories/sync/holds-legacy.ts",
      "packages/db/src/repositories/sync/pages.ts",
    ]);
    expect(filesMatching("set mode = \\$\\{", ["packages/db/src/repositories/sync"])).toEqual([
      "packages/db/src/repositories/sync/pages.ts",
    ]);
  });

  it("reads the step-1 guard owner (0229) in the live gate", () => {
    expect(filesMatching("g\\.owner_engine as \"ownerEngine\"", ["packages/db/src/repositories/sync"])).toEqual([
      "packages/db/src/repositories/sync/pages.ts",
    ]);
  });

  it("captures the step-1 guard only while the legacy engine owns it (0229, design §2.7)", () => {
    // The capture statement is the only writer of a holder; it requires the
    // legacy owner, so a page of the engine refuses every legacy sender.
    expect(filesMatching("set holder_token = \\$\\{", SOURCES)).toEqual([
      "packages/db/src/repositories/fansly-send-guard.ts",
    ]);
    expect(filesMatching("and g\\.owner_engine = 'legacy'", SOURCES)).toEqual([
      "packages/db/src/repositories/fansly-send-guard.ts",
    ]);
  });
});

describe("sortDemandSignals", () => {
  it("orders new work rows by resource, then subject (the lock order of §3.7)", () => {
    const sorted = sortDemandSignals([
      { resource: "transactions.head", subject: "" },
      { resource: "dm-messages.head", subject: "g2" },
      { resource: "dm-messages.head" },
      { resource: "dm-messages.head", subject: "g10" },
      { resource: "dm-conversations.find", subject: "g9" },
    ]);
    expect(sorted.map((signal) => `${signal.resource}/${signal.subject ?? ""}`)).toEqual([
      "dm-conversations.find/g9",
      "dm-messages.head/",
      "dm-messages.head/g10",
      "dm-messages.head/g2",
      "transactions.head/",
    ]);
  });
});
