import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { routeSchemas } from "@agency_hub_core/contracts";

import { checkContractArtifacts } from "../packages/contracts/src/generate.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

async function copyCommittedArtifacts(targetDir: string, options?: { withGit?: boolean; withDocs?: boolean }) {
  await mkdir(path.join(targetDir, "packages/contracts/src"), { recursive: true });
  await cp(
    path.join(ROOT, "packages/contracts/src/contract-hash.ts"),
    path.join(targetDir, "packages/contracts/src/contract-hash.ts"),
  );
  await cp(path.join(ROOT, "packages/sdk"), path.join(targetDir, "packages/sdk"), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules`),
  });
  if (options?.withDocs ?? true) {
    await mkdir(path.join(targetDir, "reference"), { recursive: true });
    await mkdir(path.join(targetDir, "docs/generated"), { recursive: true });
    await cp(
      path.join(ROOT, "reference/agency-hub.openapi.json"),
      path.join(targetDir, "reference/agency-hub.openapi.json"),
    );
    await cp(
      path.join(ROOT, "docs/generated/authorization-policy.md"),
      path.join(targetDir, "docs/generated/authorization-policy.md"),
    );
  }
  if (options?.withGit) {
    await mkdir(path.join(targetDir, ".git"), { recursive: true });
  }
}

describe("contracts:check (non-mutating freshness guard)", () => {
  it("passes on the clean repository without mutating generated files", async () => {
    const hashPath = path.join(ROOT, "packages/contracts/src/contract-hash.ts");
    const beforeStat = await stat(hashPath);
    const beforeHash = await readFile(hashPath, "utf8");

    const result = await checkContractArtifacts({ rootDir: ROOT });
    expect(result.ok).toBe(true);
    expect(result.drifted).toEqual([]);
    expect(result.checked).toContain("reference/agency-hub.openapi.json");
    expect(result.checked).toContain("packages/contracts/src/contract-hash.ts");
    expect(result.checked).toContain("docs/generated/authorization-policy.md");
    expect(result.checked).toContain("packages/sdk/src/meta.ts");

    const afterStat = await stat(hashPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readFile(hashPath, "utf8")).toBe(beforeHash);
  }, 30_000);

  it("fails non-mutatingly when routes.ts drifts without running contracts:generate", async () => {
    const hashPath = path.join(ROOT, "packages/contracts/src/contract-hash.ts");
    const openapiPath = path.join(ROOT, "reference/agency-hub.openapi.json");
    const beforeHash = await readFile(hashPath, "utf8");
    const beforeOpenApi = await readFile(openapiPath, "utf8");

    const responseMap = routeSchemas.health.response as Record<number, z.ZodObject<z.ZodRawShape>>;
    const original200 = responseMap[200];
    if (!original200) {
      throw new Error("Expected health 200 response schema");
    }
    responseMap[200] = original200.extend({
      unregeneratedDriftProbe: z.string().optional(),
    });

    try {
      const result = await checkContractArtifacts({ rootDir: ROOT });
      expect(result.ok).toBe(false);
      expect(result.drifted).toEqual(expect.arrayContaining([
        { path: "reference/agency-hub.openapi.json", reason: "stale" },
        { path: "packages/contracts/src/contract-hash.ts", reason: "stale" },
        { path: "packages/sdk/src/meta.ts", reason: "stale" },
      ]));
    } finally {
      responseMap[200] = original200;
    }

    // Confirm check mode did not overwrite any committed artifact.
    expect(await readFile(hashPath, "utf8")).toBe(beforeHash);
    expect(await readFile(openapiPath, "utf8")).toBe(beforeOpenApi);
  }, 30_000);

  it("CLI rejects stale artifacts in container-style trees and extra files under packages/sdk without mutating", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hub-contracts-check-"));
    try {
      // Container-style layout: no .git, reference/, or docs/ (mirrors .dockerignore).
      await copyCommittedArtifacts(tmpDir, { withGit: false, withDocs: false });

      const cleanRun = await execFileAsync(process.execPath, [
        "--import",
        "tsx/esm",
        path.join(ROOT, "packages/contracts/src/generate.ts"),
        "--check",
        "--root",
        tmpDir,
      ], { cwd: ROOT });
      expect(cleanRun.stderr).not.toContain("[contracts:check]");

      // Introduce stale contract-hash + unexpected extra SDK file.
      const staleHash = '// stale\nexport const KERNEL_CONTRACT_HASH = "0000";\n';
      const hashFile = path.join(tmpDir, "packages/contracts/src/contract-hash.ts");
      const extraSdkFile = path.join(tmpDir, "packages/sdk/src/stale-extra.ts");
      await writeFile(hashFile, staleHash, "utf8");
      await writeFile(extraSdkFile, "export const stale = true;\n", "utf8");

      let failed = false;
      let stderr = "";
      try {
        await execFileAsync(process.execPath, [
          "--import",
          "tsx/esm",
          path.join(ROOT, "packages/contracts/src/generate.ts"),
          "--check",
          "--root",
          tmpDir,
        ], { cwd: ROOT });
      } catch (error) {
        failed = true;
        stderr = (error as { stderr?: string }).stderr ?? "";
      }

      expect(failed).toBe(true);
      expect(stderr).toContain("[contracts:check] stale: packages/contracts/src/contract-hash.ts");
      expect(stderr).toContain("[contracts:check] extra: packages/sdk/src/stale-extra.ts");
      // Strictly non-mutating: stale file content remains unchanged.
      expect(await readFile(hashFile, "utf8")).toBe(staleHash);
      expect(await readFile(extraSdkFile, "utf8")).toBe("export const stale = true;\n");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 45_000);

  it("wires contracts:check into production artifact builds before bundling", async () => {
    const buildScript = await readFile(path.join(ROOT, "scripts/build-production.mjs"), "utf8");
    const checkPos = buildScript.indexOf("await verifyContractsFresh()");
    const cleanPos = buildScript.indexOf('cleanDist("apps/runtime/dist")');
    expect(checkPos).toBeGreaterThan(-1);
    expect(cleanPos).toBeGreaterThan(checkPos);
    expect(buildScript).toContain('packages/contracts/src/generate.ts');
    expect(buildScript).toContain('"--check"');
  });
});
