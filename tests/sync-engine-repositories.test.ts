import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sortDemandSignals } from "@agency_hub_core/db";

// Fansly Sync Engine core repositories (design §2.10): the structural pins.
//
// I17 — nothing but the step-3 switch can make an existing page
// `handover`/`live`. `setSyncPageMode` moves a page there only with a switch
// capability, and the capability is issued by `issueSyncSwitchCapability`
// alone. Its one sanctioned production caller is the switch/rollback CLI
// (S3-05, `sync/cli/switch.ts`); otherwise only tests issue one. The one other
// way to `live` is a page's birth: Fansly onboarding creates the page's row
// live in the transaction that creates the page (`createLiveSyncPage`, step 4
// S4-05), and nothing else calls it.

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
  it("issues the switch capability nowhere outside its own module (I17)", () => {
    expect(filesMatching("issueSyncSwitchCapability", SOURCES)).toEqual([
      "apps/runtime/src/sync/cli/switch.ts",
      "packages/db/src/repositories/sync/pages.ts",
    ]);
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
    // legacy owner, so a page the switch gave away refuses every legacy sender.
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
