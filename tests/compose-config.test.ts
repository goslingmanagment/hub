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

function getShellFunction(text: string, functionName: string) {
  const match = text.match(
    new RegExp(
      `^${functionName}\\(\\) \\{\\n([\\s\\S]*?)(?=^}\\n)`,
      "m",
    ),
  );

  return match ? `${match[0]}}\n` : null;
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

  it("docker-compose.production.yml keeps the API behind loopback and uses worker readiness health", async () => {
    const text = await readComposeFile("docker-compose.production.yml");
    const postgres = getServiceBlock(text, "postgres");
    const api = getServiceBlock(text, "api");
    const worker = getServiceBlock(text, "worker");

    expect(postgres).not.toContain("env_file:");
    expect(postgres).toContain("POSTGRES_PASSWORD");
    expect(api).toContain('"127.0.0.1:3000:3000"');
    expect(api).toContain(".env.production");
    expect(worker).toContain("WORKER_HEALTH_FILE");
    expect(worker).toContain("stale worker health file");
  });

  it("deploy-production.sh reads monitoring token without executing env files", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const envReader = getShellFunction(text, "read_remote_env_value");

    expect(text).not.toContain("source .env.production");
    expect(envReader).toContain("awk -v key=");
    expect(text).toContain('read_remote_env_value "HEALTH_SYNC_MONITORING_TOKEN"');
  });

  it("deploy-production.sh fails loudly when schema baseline capture breaks", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const schemaCapture = getShellFunction(text, "capture_remote_schema_migrations");
    const rollback = getShellFunction(text, "rollback_remote_stack");

    expect(schemaCapture).toContain("set -euo pipefail");
    expect(schemaCapture).toContain("to_regclass");
    expect(schemaCapture).not.toContain("$$public$$");
    expect(schemaCapture).not.toContain("$$schema_migrations$$");
    expect(schemaCapture).not.toContain("|| true");
    expect(schemaCapture).not.toContain("2>/dev/null");
    expect(rollback).toContain('SCHEMA_BASELINE_CAPTURED:-0');
    expect(rollback).toContain("schema migration baseline was not captured");
    expect(rollback).toContain("unable to capture current schema migration state");
  });

  it("deploy-production.sh routes compose recreate failures through rollback handling", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const recreateIndex = text.indexOf("log \"Recreating the remote production stack\"");
    const stackMarkedIndex = text.indexOf("STACK_RECREATED=1", recreateIndex);
    const composeUpIndex = text.indexOf("${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build", recreateIndex);
    const failIndex = text.indexOf("fail \"docker compose failed while recreating the production stack\"", recreateIndex);

    expect(recreateIndex).toBeGreaterThan(-1);
    expect(stackMarkedIndex).toBeGreaterThan(recreateIndex);
    expect(composeUpIndex).toBeGreaterThan(stackMarkedIndex);
    expect(failIndex).toBeGreaterThan(composeUpIndex);
  });
});
