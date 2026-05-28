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
    expect(api).toContain("image: ${RUNTIME_IMAGE:-agency_hub_core/runtime:production}");
    expect(api).toContain(".env.production");
    expect(worker).toContain("image: ${RUNTIME_IMAGE:-agency_hub_core/runtime:production}");
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
    expect(schemaCapture).toContain("BEGIN;");
    expect(schemaCapture).toContain("pg_advisory_xact_lock(31415, 27182)");
    expect(schemaCapture).toContain("deploy_schema_migrations");
    expect(schemaCapture).toContain("EXECUTE \\$q\\$insert into deploy_schema_migrations select id from schema_migrations order by id\\$q\\$");
    expect(schemaCapture).toContain("COMMIT;");
    expect(schemaCapture).toContain("to_regclass");
    expect(schemaCapture).not.toContain("INSERT INTO deploy_schema_migrations EXECUTE");
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
    const rollback = getShellFunction(text, "rollback_remote_stack");
    const recreateIndex = text.indexOf("log \"Recreating the remote production stack\"");
    const stackMarkedIndex = text.indexOf("STACK_RECREATED=1", recreateIndex);
    const composeUpIndex = text.indexOf("${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build", recreateIndex);
    const composeFailedIndex = text.indexOf("ROLLBACK_COMPOSE_RECREATE_FAILED=1", recreateIndex);
    const failIndex = text.indexOf("fail \"docker compose failed while recreating the production stack\"", recreateIndex);
    const restoreBeforePostgresIndex = rollback!.indexOf("restore_remote_release_files");
    const startPostgresIndex = rollback!.indexOf("${REMOTE_COMPOSE} up -d postgres");

    expect(rollback).not.toBeNull();
    expect(recreateIndex).toBeGreaterThan(-1);
    expect(stackMarkedIndex).toBeGreaterThan(recreateIndex);
    expect(composeUpIndex).toBeGreaterThan(stackMarkedIndex);
    expect(composeFailedIndex).toBeGreaterThan(composeUpIndex);
    expect(failIndex).toBeGreaterThan(composeFailedIndex);
    expect(rollback).toContain("ROLLBACK_COMPOSE_RECREATE_FAILED:-0");
    expect(rollback).toContain("${REMOTE_COMPOSE} up -d postgres");
    expect(restoreBeforePostgresIndex).toBeGreaterThan(-1);
    expect(startPostgresIndex).toBeGreaterThan(restoreBeforePostgresIndex);
    expect(rollback).toContain("Rollback skipped; unable to capture current schema migration state");
  });

  it("deploy-production.sh restores captured release files before rollback recreate", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const rollback = getShellFunction(text, "rollback_remote_stack");

    expect(rollback).not.toBeNull();
    expect(text).toContain("capture_remote_release_files");
    expect(text).toContain("ROLLBACK_RELEASE_ARCHIVE=");
    expect(text).toContain("ROLLBACK_RELEASE_FILES_CAPTURED=1");
    expect(text).toContain("[[ -e docker-compose.production.yml ]]");
    expect(text).toContain('files+=(\\"\\$file\\")');
    expect(text).toContain('<"$ROLLBACK_RELEASE_ARCHIVE" || return 1');
    expect(rollback).toContain("restore_remote_release_files");
    expect(rollback!.indexOf("restore_remote_release_files")).toBeLessThan(
      rollback!.indexOf("${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build"),
    );
  });

  it("deploy-production.sh captures rollback images from running containers", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const captureRollbackImage = getShellFunction(text, "capture_remote_rollback_image");

    expect(captureRollbackImage).not.toBeNull();
    expect(text).toContain('REMOTE_RUNTIME_IMAGE_ENV="RUNTIME_IMAGE=$(printf \'%q\' "$IMAGE_TAG")"');
    expect(captureRollbackImage).toContain("${REMOTE_COMPOSE} ps -q api");
    expect(captureRollbackImage).toContain("${REMOTE_COMPOSE} ps -q worker");
    expect(captureRollbackImage).toContain("docker inspect -f '{{.Image}}'");
    expect(captureRollbackImage).not.toContain("docker image inspect $(printf '%q' \"$IMAGE_TAG\")");
  });

  it("deploy-production.sh restores release files on pre-recreate validation failures", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const failAfterReleaseSync = getShellFunction(text, "fail_after_release_sync");
    const syncIndex = text.indexOf("log \"Syncing release files");
    const syncFailIndex = text.indexOf("fail_after_release_sync \"Unable to sync release files to remote\"");
    const validationIndex = text.indexOf("log \"Validating remote prerequisites\"");
    const validationFailIndex = text.indexOf("fail_after_release_sync \"Remote prerequisite validation failed after syncing release files\"");
    const envFailIndex = text.indexOf("fail_after_release_sync \"Unable to read monitoring token after syncing release files\"");

    expect(failAfterReleaseSync).not.toBeNull();
    expect(failAfterReleaseSync).toContain("restore_remote_release_files");
    expect(syncIndex).toBeGreaterThan(-1);
    expect(syncFailIndex).toBeGreaterThan(syncIndex);
    expect(validationIndex).toBeGreaterThan(syncIndex);
    expect(validationFailIndex).toBeGreaterThan(validationIndex);
    expect(envFailIndex).toBeGreaterThan(validationIndex);
  });

  it("deploy-production.sh promotes candidate images only after validation", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const candidateIndex = text.indexOf("IMAGE_CANDIDATE_TAG=");
    const buildCandidateIndex = text.indexOf('docker build --platform="${BUILD_PLATFORM}" -t "$IMAGE_CANDIDATE_TAG"');
    const loadCandidateIndex = text.indexOf('docker save "$IMAGE_CANDIDATE_TAG"');
    const validationIndex = text.indexOf("log \"Validating remote prerequisites\"");
    const schemaCaptureIndex = text.indexOf("Captured remote schema migration state for rollback safety");
    const recreateIndex = text.indexOf("log \"Recreating the remote production stack\"");
    const promoteIndex = text.indexOf(
      'docker tag $(printf \'%q\' "$IMAGE_CANDIDATE_TAG") $(printf \'%q\' "$IMAGE_TAG")',
      recreateIndex,
    );
    const deployComposeUpIndex = text.indexOf(
      "${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build",
      promoteIndex,
    );

    expect(candidateIndex).toBeGreaterThan(-1);
    expect(buildCandidateIndex).toBeGreaterThan(candidateIndex);
    expect(loadCandidateIndex).toBeGreaterThan(buildCandidateIndex);
    expect(validationIndex).toBeGreaterThan(loadCandidateIndex);
    expect(recreateIndex).toBeGreaterThan(schemaCaptureIndex);
    expect(promoteIndex).toBeGreaterThan(schemaCaptureIndex);
    expect(deployComposeUpIndex).toBeGreaterThan(promoteIndex);
  });

  it("deploy-production.sh allows rollback across known data-only migrations", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const rollback = getShellFunction(text, "rollback_remote_stack");

    expect(text).toContain("ROLLBACK_COMPATIBLE_MIGRATIONS=(");
    expect(text).toContain("0013_backfill_egress_rate_limit_scope_key.sql");
    expect(text).toContain("0014_repair_light_trusted_sync_states.sql");
    expect(text).toContain("0015_repair_egress_rate_limit_scope_key.sql");
    expect(text).toContain("0016_canonical_proxy_egress_key_function.sql");
    expect(text).toContain("0017_reapply_egress_rate_limit_scope_key_repair.sql");
    expect(text).toContain("0018_notification_incident_recovery_watermarks.sql");
    expect(text).toContain("schema_migration_delta_allows_rollback");
    expect(rollback).toContain("Schema migrations changed only by rollback-compatible data migrations");
    expect(rollback).toContain("Rollback skipped; schema_migrations changed during this deploy");
  });
});
