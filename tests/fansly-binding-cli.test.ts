import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "binding-cli-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("pre-connect binding refusal output", () => {
  it.each(["probe", "continuity"])("%s CLI retains a sanitized zero-attempt receipt before config or DB access", async (kind) => {
    const receipt = join(directory, "receipt.json");
    await writeFile(receipt, JSON.stringify({ authorization: "SYNTHETIC_SECRET" }), { mode: 0o600 });
    const args = kind === "probe" ? ["--page", "lilly-1", "--seconds", "5"]
      : ["--page", "lilly-1", "--phase", "continuous", "--correlation-key-file", join(directory, "absent-key")];
    const env = { ...process.env, DATABASE_URL: "invalid-must-not-be-used" };
    try {
      await exec(process.execPath, ["--import", "tsx/esm", `scripts/fansly-ws/${kind}-cli.ts`,
        ...args, "--binding-receipt-file", receipt], { cwd: root, env, timeout: 10_000, maxBuffer: 8192 });
      throw new Error("Refusal unexpectedly succeeded");
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      expect(failed.code).toBe(2);
      expect(JSON.parse(failed.stdout)).toEqual({ schemaVersion: 1, evidenceKind: "w0_binding_refusal",
        reason: "invalid_binding_receipt", connectionAttempts: 0, restRequests: 0 });
      expect(failed.stdout + failed.stderr).not.toContain("SYNTHETIC_SECRET");
      // tsx may emit a Node deprecation warning; the generic failure path must
      // still remain distinct from this recognized pre-connect refusal.
      expect(failed.stderr).not.toMatch(/Fansly probe failed|Continuity observation failed/);
    }
  });
});
