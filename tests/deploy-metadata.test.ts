import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("../scripts/deploy-metadata.sh", import.meta.url));
// Fixture of the deployed checksum protocol before CI image publication. The
// golden digest prevents a helper extraction from invalidating existing bases.
const manifestFiles = [
  "Dockerfile",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/dashboard/package.json",
  "apps/runtime/package.json",
  "packages/contracts/package.json",
  "packages/db/package.json",
  "packages/fansly/package.json",
  "packages/platform-core/package.json",
  "packages/shared/package.json",
];
const legacyChecksum = "856635826024b355bd11f3aa8a85e99b33fa8d8757e816a5e22960d1a26745c9";

describe("shared deploy image metadata", () => {
  let fixtureRoot: string;

  function git(...args: string[]) {
    const result = spawnSync("git", ["-C", fixtureRoot, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function metadata() {
    return spawnSync("bash", [helperPath, fixtureRoot], { encoding: "utf8" });
  }

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "hub deploy metadata "));
    for (const file of manifestFiles) {
      const filePath = path.join(fixtureRoot, file);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `manifest:${file}\n`);
    }
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("preserves the deployed checksum bytes and emits only safe output records", () => {
    const result = metadata();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`source_revision=unknown\ndependency_checksum=${legacyChecksum}\n`);
  });

  it("changes the checksum when dependency bytes change", () => {
    writeFileSync(path.join(fixtureRoot, "apps/runtime/package.json"), "changed dependency\n");
    const result = metadata();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^source_revision=unknown\ndependency_checksum=[a-f0-9]{64}\n$/);
    expect(result.stdout).not.toContain(legacyChecksum);
  });

  it("refuses a missing dependency manifest without publishing a partial checksum", () => {
    unlinkSync(path.join(fixtureRoot, "packages/shared/package.json"));
    const result = metadata();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Dependency checksum file is missing: packages/shared/package.json");
  });

  it("remains fail closed when sourced by a caller without errexit or pipefail", () => {
    unlinkSync(path.join(fixtureRoot, "packages/shared/package.json"));
    const result = spawnSync("bash", ["-c", 'source "$1"; if calculate_dependency_checksum "$2"; then exit 23; else exit 0; fi', "test", helperPath, fixtureRoot], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Dependency checksum file is missing");
  });

  it("never falls back to another directory when the requested checkout is missing", () => {
    const result = spawnSync("bash", ["-c", 'source "$1"; if calculate_dependency_checksum "$2"; then exit 23; else exit 0; fi', "test", helperPath, path.join(fixtureRoot, "missing")], { encoding: "utf8", cwd: fixtureRoot });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("uses clean commit revisions and preserves the tracked-only dirty convention", () => {
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=Metadata Test", "-c", "user.email=metadata-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture");
    const revision = git("rev-parse", "--short=12", "HEAD");
    expect(metadata().stdout).toBe(`source_revision=${revision}\ndependency_checksum=${legacyChecksum}\n`);

    writeFileSync(path.join(fixtureRoot, "untracked.txt"), "untracked content\n");
    expect(metadata().stdout).toContain(`source_revision=${revision}\n`);

    writeFileSync(path.join(fixtureRoot, "package.json"), "changed\n");
    expect(metadata().stdout).toContain(`source_revision=${revision}-dirty\n`);
  });

  it("supports deploy's no-argument calls using ROOT_DIR without changing the caller", () => {
    const result = spawnSync("bash", ["-c", 'source "$1"; ROOT_DIR="$2"; calculate_dependency_checksum; printf "source="; calculate_source_revision; printf "\\n"', "test", helperPath, fixtureRoot], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${legacyChecksum}\nsource=unknown\n`);
  });
});
