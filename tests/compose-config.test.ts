import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getServiceBlock(text: string, serviceName: string) {
  const match = text.match(
    new RegExp(
      `^  ${serviceName}:\\n([\\s\\S]*?)(?=^  [^\\s].*:|^volumes:|\\Z)`,
      "m",
    ),
  );

  return match?.[0] ?? null;
}

async function readComposeFile(relativePath: string) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

describe("compose config", () => {
  for (const composePath of ["docker-compose.yml", "docker-compose.test.yml"]) {
    it(`${composePath} boots the schema before runtime services`, async () => {
      const text = await readComposeFile(composePath);
      const migrator = getServiceBlock(text, "migrator");
      const api = getServiceBlock(text, "api");
      const worker = getServiceBlock(text, "worker");

      expect(migrator).toContain('command: ["node", "packages/db/dist/migrate.js"]');
      expect(migrator).toContain("postgres:");
      expect(migrator).toContain("condition: service_healthy");

      expect(api).toContain('command: ["node", "apps/runtime/dist/startup.js", "api"]');
      expect(api).toContain("migrator:");
      expect(api).toContain("condition: service_completed_successfully");

      expect(worker).toContain('command: ["node", "apps/runtime/dist/startup.js", "worker"]');
      expect(worker).toContain("migrator:");
      expect(worker).toContain("condition: service_completed_successfully");
    });
  }
});
