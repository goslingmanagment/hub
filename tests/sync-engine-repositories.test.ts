import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sortDemandSignals } from "@agency_hub_core/db";

// Fansly Sync Engine core repositories (design §2.10): the structural pins.
//
// I17 — no build before the step-3 switch can make a page `handover`/`live`.
// `setSyncPageMode` moves a page there only with a switch capability, and the
// capability is issued by `issueSyncSwitchCapability` alone. Its one sanctioned
// production caller will be the switch/rollback CLI of S3-05, which adds itself
// to the list below in that PR; until then only tests may issue one.

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

  it("reads the step-1 guard owner in the live gate, failing closed before 0229 adds it", () => {
    expect(filesMatching("to_jsonb\\(g\\) ->> 'owner_engine'", SOURCES)).toEqual([
      "packages/db/src/repositories/sync/pages.ts",
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
