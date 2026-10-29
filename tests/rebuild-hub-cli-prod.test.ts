import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every verified deploy pins a new `hub` CLI install, a full pnpm tree of ~40k
// files, and 109 had piled up by 2026-10-29. After a good switch the rebuild
// removes old installs. It must never take the new one, the one the link
// pointed at before (the rollback), one another run may still be building, or
// anything it did not make.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const NAME = "hub-agent-cli-prod";
const HASH = "ab12".repeat(16);
const gitEnv = {
  GIT_AUTHOR_NAME: "ci", GIT_AUTHOR_EMAIL: "ci@example.invalid",
  GIT_COMMITTER_NAME: "ci", GIT_COMMITTER_EMAIL: "ci@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
/** An old install, named by the 12 hex of a made-up revision. */
const old = (n: number) => `${NAME}-${n.toString(16).padStart(12, "0")}`;
/** A modification time `hours` back, in the seconds utimes takes. */
const hoursAgo = (hours: number) => Date.now() / 1000 - hours * 3600;

describe("production hub CLI rebuild: old installs", () => {
  let root = "";
  let repo = "";
  let bin = "";
  let sha = "";
  let current = "";
  let shares = 0;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "hub-cli-prod-"));
    // A revision whose CLI is a stub: `capabilities` answers $TEST_SERVED_HASH,
    // or the hash the revision compiles to.
    repo = path.join(root, "repo");
    const file = (relative: string, content: string) => {
      mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
      writeFileSync(path.join(repo, relative), content);
    };
    file("scripts/rebuild-hub-cli-prod.sh", readFileSync(path.join(repoRoot, "scripts/rebuild-hub-cli-prod.sh"), "utf8"));
    file("packages/contracts/src/contract-hash.ts", `export const KERNEL_CONTRACT_HASH = "${HASH}";\n`);
    file("packages/hub-agent-cli/bin/hub.mjs",
      `process.stdout.write(JSON.stringify({ ok: true, data: { contract: { contractHash: process.env.TEST_SERVED_HASH || "${HASH}" } } }));\n`);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...gitEnv }, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-qm", "cli");
    sha = git("rev-parse", "HEAD");
    current = `${NAME}-${sha.slice(0, 12)}`;
    // The stub tree needs no dependencies.
    bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(path.join(bin, "pnpm"), 0o755);
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  /** A share directory of installs, each `hours` old, the link on `linked`. */
  function share(installs: Record<string, number>, linked: string) {
    const dir = path.join(root, `share-${++shares}`);
    mkdirSync(dir);
    for (const [name, hours] of Object.entries(installs)) {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, ".source-revision"), "made up\n");
      utimesSync(path.join(dir, name), hoursAgo(hours), hoursAgo(hours));
    }
    symlinkSync(path.join(dir, linked), path.join(dir, NAME));
    return dir;
  }

  function rebuild(dir: string, env: Record<string, string> = {}) {
    const { HUB_CLI_PROD_KEEP: _inherited, ...inherited } = process.env;
    return spawnSync("bash", [path.join(repo, "scripts/rebuild-hub-cli-prod.sh"), sha], {
      encoding: "utf8",
      env: {
        ...inherited,
        ...gitEnv,
        // HOME too, so no default can reach this machine's real installs.
        HOME: root,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HUB_CLI_PROD_SHARE: dir,
        HUB_CLI_BIN_LINK: path.join(`${dir}-bin`, "hub"),
        ...env,
      },
    });
  }

  it("keeps the new install, the previous one, one touched in the last hour and anything it did not make", () => {
    const dir = share({ [old(1)]: 5, [old(2)]: 3, [old(3)]: 30, [old(4)]: 0.2 }, old(1));
    mkdirSync(path.join(dir, "hub-w0-private"));
    mkdirSync(path.join(dir, `${NAME}-notes`));
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep"), "");
    symlinkSync(outside, path.join(dir, old(5)));
    lutimesSync(path.join(dir, old(5)), hoursAgo(5), hoursAgo(5));
    // Left by a run that died hours ago, and one another run is extracting now.
    mkdirSync(path.join(dir, `${old(6)}.staging.4242`));
    utimesSync(path.join(dir, `${old(6)}.staging.4242`), hoursAgo(2), hoursAgo(2));
    mkdirSync(path.join(dir, `${old(7)}.staging.4343`));

    const result = rebuild(dir);

    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(path.join(dir, NAME))).toBe(path.join(dir, current));
    expect(readdirSync(dir).sort()).toEqual([
      NAME, current, old(1), old(4), old(5), `${old(7)}.staging.4343`, `${NAME}-notes`, "hub-w0-private",
    ].sort());
    expect(readdirSync(outside)).toEqual(["keep"]);
  });

  it("keeps the newest other installs up to HUB_CLI_PROD_KEEP, the previous one however old", () => {
    const dir = share({ [old(1)]: 9, [old(2)]: 6, [old(3)]: 7, [old(4)]: 8 }, old(1));

    const result = rebuild(dir, { HUB_CLI_PROD_KEEP: "3" });

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([NAME, current, old(1), old(2)].sort());
  });

  it("removes nothing when the new CLI fails verification or HUB_CLI_PROD_KEEP is below 2", () => {
    const dir = share({ [old(1)]: 5, [old(2)]: 6, [old(3)]: 7 }, old(1));

    const mismatch = rebuild(dir, { TEST_SERVED_HASH: "f".repeat(64) });

    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("Contract hash mismatch");
    // The failed build stays where it was extracted; the link does not move.
    const left = [NAME, current, old(1), old(2), old(3)].sort();
    expect(readdirSync(dir).sort()).toEqual(left);
    expect(readlinkSync(path.join(dir, NAME))).toBe(path.join(dir, old(1)));

    for (const keep of ["1", "two"]) {
      const refused = rebuild(dir, { HUB_CLI_PROD_KEEP: keep });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("HUB_CLI_PROD_KEEP");
    }
    expect(readdirSync(dir).sort()).toEqual(left);
  });
});
