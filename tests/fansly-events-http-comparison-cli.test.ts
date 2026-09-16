import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measurementArtifact, measurementFixture } from "./helpers/fansly-http-measurement.ts";

const execute = promisify(execFile);
let directory: string;
let paths: string[];
let output: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fansly-http-comparison-"));
  paths = [join(directory, "baseline.json"), join(directory, "current.json")];
  for (const [i, report] of [measurementFixture(), measurementFixture("2026-09-08", "2026-09-09")].entries()) {
    const { bytes, manifest } = measurementArtifact(report);
    await writeFile(paths[i]!, bytes, { mode: 0o600 });
    await writeFile(`${paths[i]}.manifest.json`, JSON.stringify(manifest), { mode: 0o600 });
  }
  output = join(directory, "comparison.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function run() {
  return execute(process.execPath, ["--import", "tsx/esm", "scripts/fansly-events/compare-http-cli.ts", ...paths, output, "lilly-1"], {
    timeout: 10_000,
  });
}

describe("offline HTTP comparison command", () => {
  it("writes a private result with bound artifact hashes and no paths in stdout", async () => {
    const result = await run();
    expect(result.stdout).not.toContain(directory);
    expect(result.stderr).not.toContain("HTTP comparison failed");
    expect(result.stderr).not.toContain(directory);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      schemaVersion: 1, eligibleForObservedCountComparison: true, observedRecordedAttemptDelta: 0,
      causalSavings: "unverified", readerLatency: "unmeasured",
    });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("preserves existing evidence", async () => {
    await writeFile(output, "retained evidence", { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(output, "utf8")).toBe("retained evidence");
  });

  it.each(["report", "manifest", "permissions", "symlink"])("fails closed for %s without leaking inputs", async (kind) => {
    if (kind === "report") await writeFile(paths[0]!, "secret-sentinel");
    if (kind === "manifest") await writeFile(`${paths[0]}.manifest.json`, "secret-sentinel");
    if (kind === "permissions") await chmod(paths[0]!, 0o644);
    if (kind === "symlink") {
      const link = join(directory, "secret-sentinel");
      await symlink(paths[0]!, link);
      paths[0] = link;
    }
    const error = await run().then(() => null, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: 1, stdout: "" });
    expect((error as { stderr: string }).stderr).not.toContain(directory);
    expect((error as { stderr: string }).stderr).not.toContain("secret-sentinel");
    await expect(stat(output)).rejects.toThrow();
  });
});
