import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// The nightly pulls of the hub and ContentOps keep their newest N dated copies on the Mac and remove
// the older ones (the hub's reached 22 GB in six days with none removed). These are the only copies
// of the data off the server, so the removal must take nothing but old dated copies: never the copy
// the run has just made, never a run's .incoming-<UTC>/, the logs, the scripts or a link.

const script = fileURLToPath(new URL("../scripts/backup/keep-copies.sh", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "keep-copies-"));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A dated copy name for 2026-11-<day> 02:20 UTC. */
const copy = (day: number) => `202611${String(day).padStart(2, "0")}T022005Z`;

let dirs = 0;
/** A backup directory with these dated copies and the things that live beside them. */
function backups(days: number[]) {
  const dir = path.join(root, `backups-${++dirs}`);
  for (const day of days) {
    mkdirSync(path.join(dir, copy(day)), { recursive: true });
    writeFileSync(path.join(dir, copy(day), "hub-business.dump"), "dump");
  }
  mkdirSync(path.join(dir, ".incoming-20261101T022005Z"));
  mkdirSync(path.join(dir, "logs"));
  mkdirSync(path.join(dir, "20261101T022005Z-kept-by-hand"));
  writeFileSync(path.join(dir, "pull-backup.sh"), "#!/usr/bin/env bash\n");
  // A link with a copy's name, to a directory outside: neither the link nor its target goes.
  mkdirSync(path.join(root, `outside-${dirs}`));
  symlinkSync(path.join(root, `outside-${dirs}`), path.join(dir, "20261102T022005Z"));
  return dir;
}

// /bin/bash, as launchd runs the pulls: bash 3.2 on the Mac.
function keep(dir: string, count: string, newest: string) {
  return spawnSync("/bin/bash", [script, dir, count, path.join(dir, newest)], { encoding: "utf8" });
}

const entries = (dir: string) => readdirSync(dir).sort();
/** The dated copies left, without the link that only looks like one. */
const copies = (dir: string) => entries(dir).filter((name) => /^\d{8}T\d{6}Z$/.test(name) && name !== "20261102T022005Z");

describe("backup copies: keep the newest N", () => {
  it("removes the oldest dated copies beyond N and nothing else", () => {
    const dir = backups([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    const run = keep(dir, "7", copy(17));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("2\n");
    expect(entries(dir)).toEqual([
      ".incoming-20261101T022005Z", "20261101T022005Z-kept-by-hand", "20261102T022005Z",
      copy(11), copy(12), copy(13), copy(14), copy(15), copy(16), copy(17), "logs", "pull-backup.sh",
    ]);
    expect(existsSync(path.join(root, `outside-${dirs}`))).toBe(true);
  });

  it("removes nothing while there are no more than N", () => {
    const dir = backups([12, 13, 14, 15, 16, 17]);
    const run = keep(dir, "7", copy(17));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("0\n");
    expect(copies(dir)).toEqual([copy(12), copy(13), copy(14), copy(15), copy(16), copy(17)]);
  });

  it("keeps the run's own copy even when a wrong clock gave it the oldest name", () => {
    const dir = backups([3, 12, 13, 14, 15, 16, 17]);
    const run = keep(dir, "3", copy(3));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("4\n");
    expect(copies(dir)).toEqual([copy(3), copy(16), copy(17)]);
  });

  it("with N = 1 leaves only the run's own copy", () => {
    const dir = backups([14, 15, 16, 17]);
    const run = keep(dir, "1", copy(17));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("3\n");
    expect(copies(dir)).toEqual([copy(17)]);
  });

  it("refuses a count that is not a whole number of copies, or a copy that is not there, and removes nothing", () => {
    const dir = backups([13, 14, 15, 16, 17]);
    const before = entries(dir);
    for (const count of ["0", "-1", "7x", "", " 7"]) {
      const run = keep(dir, count, copy(17));
      expect(run.status, `keep ${JSON.stringify(count)}`).not.toBe(0);
    }
    const missing = keep(dir, "2", copy(18));
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("nothing removed");
    expect(entries(dir)).toEqual(before);
  });
});
