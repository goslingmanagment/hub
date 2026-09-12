import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getServiceBlock(text: string, serviceName: string) {
  // NB: JS regex has no \Z end-of-input anchor — a literal \Z matches the
  // letter "Z" (the W3 `TZ: UTC` pin exposed this by cutting blocks at "T").
  // (?![\s\S]) is the true end-of-input.
  const match = text.match(
    new RegExp(
      `^  ${serviceName}:\\n([\\s\\S]*?)(?=^  [^\\s].*:|^volumes:|(?![\\s\\S]))`,
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

    it(`${composePath} keeps local services opt-in and bounds their logs`, async () => {
      const text = await readComposeFile(composePath);
      const postgres = getServiceBlock(text, "postgres");

      expect(text).toContain("x-local-logging: &local-logging");
      expect(text).toContain("driver: local");
      expect(text).toContain('max-size: "10m"');
      expect(text).toContain('max-file: "3"');
      expect(postgres).not.toContain("restart: unless-stopped");

      for (const service of ["postgres", "migrator", "api", "worker"]) {
        expect(getServiceBlock(text, service)).toContain("logging: *local-logging");
      }
    });
  }

  it("keeps Docker caches architecture-scoped and smoke-tests the final browser runtime", async () => {
    const dockerfile = await readComposeFile("Dockerfile");
    const dockerignore = await readComposeFile(".dockerignore");
    const ciWorkflow = await readComposeFile(".github/workflows/ci.yml");
    const deploy = await readComposeFile("scripts/deploy-production.sh");
    const fullBuild = getShellFunction(deploy, "build_full_candidate_image");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const sourceCopyIndex = dockerfile.indexOf("COPY apps ./apps");

    expect(dockerfile.startsWith("# syntax=docker/dockerfile:1.7\n")).toBe(true);
    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toContain("ARG BUILDARCH");
    expect(dockerfile).toContain("id=agency-hub-corepack-target-${TARGETARCH}");
    expect(dockerfile).toContain("id=agency-hub-pnpm-target-${TARGETARCH}");
    expect(dockerfile).toContain("id=agency-hub-corepack-build-${BUILDARCH}");
    expect(dockerfile).toContain("id=agency-hub-pnpm-build-${BUILDARCH}");
    expect(dockerfile).toContain("target=/pnpm/store,sharing=locked");
    expect(dockerfile).toContain("install --with-deps --only-shell chromium");
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/* /tmp/*");
    expect(dockerfile).toContain(
      "COPY scripts/smoke-playwright-runtime.mjs ./scripts/smoke-playwright-runtime.mjs",
    );
    expect(dockerignore.split(/\r?\n/)).toContain("**/node_modules");
    expect(dockerignore.split(/\r?\n/)).toContain("packages/**/dist");
    expect(ciWorkflow).toContain(
      "docker run --rm --entrypoint node agency_hub_core/runtime:ci scripts/smoke-playwright-runtime.mjs",
    );
    expect(fullBuild).toContain("DOCKER_BUILDKIT=1 docker build");
    expect(sourceCopyIndex).toBeGreaterThan(installIndex);
  });

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

  it("docker-compose.production.yml bounds every service's container logs", async () => {
    const text = await readComposeFile("docker-compose.production.yml");
    expect(text).toContain("x-production-logging: &production-logging");
    expect(text).toContain("driver: local");
    expect(text).toContain('max-size: "20m"');
    expect(text).toContain('max-file: "5"');
    const servicesBlock = text.match(/^services:\n([\s\S]*?)(?=^volumes:|(?![\s\S]))/m)?.[1] ?? "";
    const serviceNames = [...servicesBlock.matchAll(/^ {2}([a-z0-9][a-z0-9_-]*):$/gm)]
      .map((m) => m[1])
      .filter((name): name is string => typeof name === "string");
    expect(serviceNames).toContain("worker");
    expect(serviceNames.length).toBeGreaterThanOrEqual(4);
    for (const service of serviceNames) {
      expect(getServiceBlock(text, service), `${service} must declare bounded logging`).toContain("logging: *production-logging");
    }
  });

  it("production Postgres suppresses raw bind values without replacing VPS tuning", async () => {
    const text = await readComposeFile("docker-compose.production.yml");
    const postgres = getServiceBlock(text, "postgres");
    const command = postgres?.match(/^ {4}command: (\[[^\n]+\])$/m)?.[1];

    // These are separate PostgreSQL log paths. A positive byte limit still
    // leaks raw values; zero disables bind logging. Keep unrelated tuning in
    // the existing volume's auto.conf, including the slow-query threshold.
    expect(JSON.parse(command ?? "null")).toEqual([
      "postgres",
      "-c", "log_parameter_max_length=0",
      "-c", "log_parameter_max_length_on_error=0",
    ]);
  });

  it("requires one explicit host directory for read-only OFAPI export artifacts", async () => {
    const compose = await readComposeFile("docker-compose.production.yml");
    const productionEnv = await readComposeFile(".env.production.example");
    const gitignore = await readComposeFile(".gitignore");
    const dockerignore = await readComposeFile(".dockerignore");
    const api = getServiceBlock(compose, "api");
    const worker = getServiceBlock(compose, "worker");
    const requiredMount = "${OFAPI_EXPORT_ARTIFACT_HOST_DIR:?Set "
      + "OFAPI_EXPORT_ARTIFACT_HOST_DIR to an absolute host path in .env.production}:"
      + "${OFAPI_EXPORT_ARTIFACT_DIR:-/var/lib/agency-hub/ofapi-export-artifacts}:ro";

    expect(api).toContain(requiredMount);
    expect(worker).toContain(requiredMount);
    expect(compose).not.toContain("OFAPI_EXPORT_ARTIFACT_HOST_DIR:-./");
    expect(productionEnv).toContain(
      "OFAPI_EXPORT_ARTIFACT_HOST_DIR=/opt/agency-hub-artifacts/ofapi-export",
    );
    expect(productionEnv).toContain("mode 0700");
    expect(productionEnv).toContain("CSVs must be 0600");
    expect(gitignore.split(/\r?\n/)).toContain("/ofapi-export-artifacts/");
    expect(dockerignore.split(/\r?\n/)).toContain("/ofapi-export-artifacts/");
  });

  // Review finding: the scheduler is the only cron timekeeper — a wedged (not
  // crashed) one silently stalls the planner, sweeps and reports. Its health
  // file refreshes only after a successful heartbeat upsert, so mtime
  // freshness certifies event loop + DB together.
  it("docker-compose.production.yml gives the scheduler a heartbeat-file healthcheck", async () => {
    const text = await readComposeFile("docker-compose.production.yml");
    const scheduler = getServiceBlock(text, "scheduler");

    expect(scheduler).toContain("SCHEDULER_HEALTH_FILE");
    expect(scheduler).toContain("healthcheck:");
    expect(scheduler).toContain("stale scheduler health file");
  });

  it("deploy-production.sh reads monitoring token without executing env files", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const envReader = getShellFunction(text, "read_remote_env_value");

    expect(text).not.toContain("source .env.production");
    expect(envReader).toContain("awk -v key=");
    expect(text).toContain('read_remote_env_value "HEALTH_SYNC_MONITORING_TOKEN"');
  });

  it("deploy-production.sh defaults to full builds without dist-only fallback", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const buildCandidate = getShellFunction(text, "build_candidate_image");
    const fullBranch = buildCandidate?.match(/full\)([\s\S]*?);;\n {4}dist-only\)/)?.[1] ?? "";

    expect(text).toContain('BUILD_MODE="${DEPLOY_BUILD_MODE:-full}"');
    expect(text).toContain("--mode <mode>          Build mode: full, dist-only, or auto. Default: full");
    expect(text).not.toContain('BUILD_MODE="${DEPLOY_BUILD_MODE:-auto}"');
    expect(fullBranch).toContain("build_full_candidate_image");
    expect(fullBranch).toContain("load_candidate_image");
    expect(fullBranch).not.toContain("build_dist_only_candidate_image");
    expect(buildCandidate).toContain("because --mode auto was set");
  });

  it("deploy-production.sh uses local and remote deploy locks with metadata cleanup", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const localLock = getShellFunction(text, "acquire_local_deploy_lock");
    const remoteLock = getShellFunction(text, "acquire_remote_deploy_lock");
    const cleanup = getShellFunction(text, "cleanup_deploy");

    expect(text).toContain('REMOTE_DEPLOY_LOCK_DIR="${APP_DIR%/}/.deploy.lock"');
    expect(localLock).toContain('mkdir "$LOCAL_DEPLOY_LOCK_DIR"');
    expect(localLock).toContain("agency-hub-deploy-production-${root_hash}.lock");
    expect(localLock).toContain("candidate_tag");
    expect(localLock).toContain("only after confirming no deploy is active");
    expect(remoteLock).toContain("mkdir ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}");
    expect(remoteLock).toContain("source_revision");
    expect(remoteLock).toContain("dependency_checksum");
    expect(remoteLock).toContain("remove only after confirming no deploy is active");
    expect(cleanup).toContain("release_remote_deploy_lock");
    expect(cleanup).toContain('rm -rf "$LOCAL_DEPLOY_LOCK_DIR"');
    expect(text).toContain("trap cleanup_deploy EXIT");
  });

  it("deploy-production.sh rebuilds the pinned hub CLI only after every health gate, never fatally", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const rebuild = getShellFunction(text, "rebuild_local_hub_cli");

    expect(rebuild).toContain('"${SCRIPT_DIR}/rebuild-hub-cli-prod.sh" "$APP_SOURCE_REVISION"');
    expect(rebuild).toContain("unknown|*-dirty)");
    expect(text).toContain("--skip-hub-cli-rebuild");
    expect(text).toContain("DEPLOY_SKIP_HUB_CLI_REBUILD");
    expect(text).toContain('rebuild_local_hub_cli || log "WARNING');
    expect(text).not.toContain("rebuild_local_hub_cli || fail");
    expect(text.indexOf("rebuild_local_hub_cli || log")).toBeGreaterThan(text.indexOf("verify_post_deploy_image_labels\n"));
    expect(text.indexOf("rebuild_local_hub_cli || log")).toBeGreaterThan(text.indexOf("publish_remote_clean_full_base_image \\"));
  });

  it("deploy-production.sh derives per-run release tags and one dependency-keyed clean full base", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const initializer = getShellFunction(text, "initialize_deploy_metadata_and_tags");

    expect(initializer).toContain("DEPLOY_RUN_ID=");
    expect(initializer).toContain('IMAGE_CANDIDATE_TAG="${IMAGE_TAG}-candidate-${source_tag_component}-${DEPLOY_RUN_ID}"');
    expect(initializer).toContain('CLEAN_FULL_BASE_TAG="${IMAGE_TAG}-full-${APP_DEPENDENCY_CHECKSUM}"');
    expect(initializer).toContain('ROLLBACK_IMAGE_TAG="${IMAGE_TAG}-rollback-${source_tag_component}-${DEPLOY_RUN_ID}"');
    expect(text).not.toContain('IMAGE_CANDIDATE_TAG="${IMAGE_TAG}-candidate"');
    expect(text).not.toContain("DIST_BASE_TAG");
    expect(initializer).toContain("clean_full_base=${CLEAN_FULL_BASE_TAG}");
  });

  it("deploy-production.sh validates and builds from the same canonical Node base image", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const ensureBase = getShellFunction(text, "ensure_node_base_image");
    const buildFull = getShellFunction(text, "build_full_candidate_image");

    expect(text).not.toContain("agency_hub_core/node:22-bookworm-slim");
    expect(ensureBase).toContain('docker image inspect "$NODE_BASE_IMAGE"');
    expect(ensureBase).toContain('docker run --rm --platform="${BUILD_PLATFORM}" "$NODE_BASE_IMAGE" node -p "process.platform + \'/\' + process.arch"');
    expect(ensureBase).not.toContain("NODE_BASE_CACHE");
    expect(ensureBase).toContain("linux/x64");
    expect(ensureBase).toContain("failed ${BUILD_PLATFORM} runtime validation");
    expect(ensureBase).toContain('docker pull --platform="${BUILD_PLATFORM}" "$NODE_BASE_IMAGE"');
    expect(buildFull).toContain('--build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}"');
    expect(buildFull).not.toContain("NODE_BASE_CACHE");
  });

  it("accepts but ignores the deprecated Node base cache flag and environment variable", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const script = path.join(repoRoot, "scripts/deploy-production.sh");
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.DEPLOY_NODE_BASE_CACHE_IMAGE;

    const flagResult = spawnSync(
      "bash",
      [script, "--node-base-cache-image", "legacy.invalid/team/node:22", "--help"],
      { encoding: "utf8", env: cleanEnv },
    );
    expect(flagResult.status, flagResult.stderr).toBe(0);
    expect(flagResult.stdout).toContain("Usage:");
    expect(flagResult.stderr).toContain("deprecated and ignored");

    const envResult = spawnSync("bash", [script, "--help"], {
      encoding: "utf8",
      env: {
        ...cleanEnv,
        DEPLOY_NODE_BASE_CACHE_IMAGE: "legacy.invalid/team/node:22",
      },
    });
    expect(envResult.status, envResult.stderr).toBe(0);
    expect(envResult.stdout).toContain("Usage:");
    expect(envResult.stderr).toContain("deprecated and ignored");

    const legacyOption = text.match(/^ {4}--node-base-cache-image\)([\s\S]*?)\n\s+;;/m)?.[0];
    expect(legacyOption).toContain("shift 2");
    expect(legacyOption).not.toContain("NODE_BASE_IMAGE=");
    expect(legacyOption).not.toContain("docker");
    expect(text).not.toContain('NODE_BASE_IMAGE=${NODE_BASE_CACHE_IMAGE}');
  });

  it("deploy-production.sh runs migration preflight before building candidate images", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const preflight = getShellFunction(text, "preflight_migration_files");
    const mainStart = text.indexOf('ROLLBACK_RELEASE_ARCHIVE="${TEMP_DIR}/rollback-release-files.tar"');
    const preflightCallIndex = text.indexOf("preflight_migration_files", mainStart);
    const buildCallIndex = text.indexOf("build_candidate_image", preflightCallIndex);

    expect(preflight).toContain("packages/db/migrations");
    expect(preflight).toContain("-name '.*.sql'");
    expect(preflight).toContain("hidden SQL migration files are not allowed");
    expect(preflight).toContain("^[0-9]{4}_[a-z0-9][a-z0-9_-]*\\.sql$");
    expect(preflightCallIndex).toBeGreaterThan(mainStart);
    expect(buildCallIndex).toBeGreaterThan(preflightCallIndex);
  });

  it("deploy-production.sh verifies running API and worker image labels after health checks", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const verifier = getShellFunction(text, "verify_service_image_labels");
    const workerHealthIndex = text.indexOf("wait_for_worker_health || fail");
    const labelCheckIndex = text.indexOf("verify_post_deploy_image_labels", workerHealthIndex);

    expect(verifier).toContain("agency-hub.source-revision");
    expect(verifier).toContain("agency-hub.dependency-checksum");
    expect(verifier).toContain("APP_SOURCE_REVISION");
    expect(verifier).toContain("APP_DEPENDENCY_CHECKSUM");
    expect(labelCheckIndex).toBeGreaterThan(workerHealthIndex);
  });

  it(".dockerignore excludes AppleDouble metadata files", async () => {
    const dockerignore = await readComposeFile(".dockerignore");

    expect(dockerignore.split(/\r?\n/)).toContain("._*");
  });

  it("keeps local OFAPI export artifacts out of Git and Docker contexts", async () => {
    const [gitignore, dockerignore] = await Promise.all([
      readComposeFile(".gitignore"),
      readComposeFile(".dockerignore"),
    ]);

    expect(gitignore.split(/\r?\n/)).toContain("/ofapi-export-artifacts/");
    expect(dockerignore.split(/\r?\n/)).toContain("/ofapi-export-artifacts/");
  });

  it("deploy-production.sh fails loudly when schema baseline capture breaks", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const schemaCapture = getShellFunction(text, "capture_remote_schema_migrations");
    const rollback = getShellFunction(text, "rollback_remote_stack");

    expect(schemaCapture).toContain("set -euo pipefail");
    expect(schemaCapture).toContain("BEGIN;");
    expect(schemaCapture).toContain("max_attempts=30");
    expect(schemaCapture).toContain("pg_try_advisory_xact_lock(31415, 27182)");
    expect(schemaCapture).toContain("IF NOT pg_try_advisory_xact_lock(31415, 27182) THEN");
    expect(schemaCapture).toContain('attempt_output="${output_file}.attempt"');
    expect(schemaCapture).toContain('mv "$attempt_output" "$output_file" || return 1');
    expect(schemaCapture).toContain("sleep 1");
    expect(schemaCapture).toContain("deploy_schema_migrations");
    expect(schemaCapture).toContain("EXECUTE \\$q\\$insert into deploy_schema_migrations select id from schema_migrations order by id\\$q\\$");
    expect(schemaCapture).toContain("COMMIT;");
    expect(schemaCapture).toContain("to_regclass");
    expect(schemaCapture).not.toContain("INSERT INTO deploy_schema_migrations EXECUTE");
    expect(schemaCapture).not.toContain("$$public$$");
    expect(schemaCapture).not.toContain("$$schema_migrations$$");
    expect(schemaCapture).not.toContain("PERFORM pg_advisory_xact_lock");
    expect(schemaCapture).not.toContain("|| true");
    expect(schemaCapture).not.toContain("2>/dev/null");
    expect(rollback).toContain('SCHEMA_BASELINE_CAPTURED:-0');
    expect(rollback).toContain("schema migration baseline was not captured");
    expect(rollback).toContain("unable to capture current schema migration state");
  });

  it("makes legacy OnlyFans DM retirement a prerequisite for deploy and rollback", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const quiesce = getShellFunction(text, "quiesce_remote_legacy_sync_services") ?? "";
    const restore = getShellFunction(text, "restore_quiesced_sync_services") ?? "";
    const migrate = getShellFunction(text, "run_pre_recreate_safe_migrations") ?? "";
    const verify = getShellFunction(text, "verify_remote_legacy_onlyfans_dm_messages_retired");
    const rollback = getShellFunction(text, "rollback_remote_stack");
    const baselineIndex = text.indexOf('SCHEMA_BASELINE_CAPTURED=1');
    const quiesceIndex = text.indexOf("quiesce_remote_legacy_sync_services", baselineIndex);
    const migrationIndex = text.indexOf("run_pre_recreate_safe_migrations", quiesceIndex);
    const verifyIndex = text.indexOf("verify_remote_legacy_onlyfans_dm_messages_retired", migrationIndex);
    const promoteIndex = text.indexOf('log "Recreating the remote production stack"', verifyIndex);

    expect(quiesce).toContain("stop -t 75 scheduler worker");
    expect(quiesce).toContain("LEGACY_SYNC_QUIESCED=1");
    expect(quiesce.indexOf("LEGACY_SYNC_QUIESCED=1"))
      .toBeLessThan(quiesce.indexOf("stop -t 75 scheduler worker"));
    expect(restore).toContain("up -d scheduler worker");
    expect(text).toContain('LEGACY_SYNC_QUIESCED:-0');
    expect(text).toContain("restore_quiesced_sync_services");
    expect(migrate).toContain("--through 0097_retire_onlyfans_legacy_dm_messages.sql");
    expect(verify).toContain("LEFT JOIN page_sync_states");
    expect(verify).toContain("st.page_id IS NULL");
    expect(verify).toContain('[[ "$unsafe_count" == "0" ]]');
    expect(rollback).toContain("verify_remote_legacy_onlyfans_dm_messages_retired");
    expect(rollback).toContain("could resurrect the paid crawler");
    expect(text).toContain('"0097_retire_onlyfans_legacy_dm_messages.sql"');
    expect(quiesceIndex).toBeGreaterThan(baselineIndex);
    expect(migrationIndex).toBeGreaterThan(quiesceIndex);
    expect(verifyIndex).toBeGreaterThan(migrationIndex);
    expect(promoteIndex).toBeGreaterThan(verifyIndex);
  });

  it("enables lifecycle-v2 only through exact first-cutover evidence and keeps it monotonic", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const evidenceVerifier = await readComposeFile("scripts/verify-desktop-lifecycle-v2-evidence.mjs");
    const health = await readComposeFile("apps/runtime/src/services/health.ts");
    const startup = await readComposeFile("apps/runtime/src/startup.ts");
    const waitForApi = getShellFunction(text, "wait_for_api_health");
    const capabilityGate = getShellFunction(text, "verify_candidate_lifecycle_capability");
    const manifestDigestGate = getShellFunction(text, "verify_approved_lifecycle_manifest_digest");
    const inventoryGate = getShellFunction(text, "verify_candidate_lifecycle_inventory");
    const postDeployCapability = getShellFunction(text, "verify_post_deploy_lifecycle_capability");
    const preRecreateMigration = getShellFunction(text, "run_pre_recreate_safe_migrations");
    const forbidRollback = getShellFunction(text, "forbid_rollback_for_pending_pre_recreate_migrations");
    const rollback = getShellFunction(text, "rollback_remote_stack");
    const mainStart = text.indexOf('ROLLBACK_RELEASE_ARCHIVE="${TEMP_DIR}/rollback-release-files.tar"');
    const initializeIndex = text.indexOf("initialize_deploy_metadata_and_tags", mainStart);
    const buildIndex = text.indexOf("build_candidate_image", initializeIndex);
    const capabilityGateIndex = text.indexOf("verify_candidate_lifecycle_capability", buildIndex);
    const schemaCaptureIndex = text.indexOf('capture_remote_schema_migrations "$SCHEMA_BEFORE_FILE"', capabilityGateIndex);
    const forbidRollbackIndex = text.indexOf("forbid_rollback_for_pending_pre_recreate_migrations", schemaCaptureIndex);
    const preRecreateMigrationIndex = text.indexOf("run_pre_recreate_safe_migrations", forbidRollbackIndex);
    const releaseSyncIndex = text.indexOf('log "Syncing release files', preRecreateMigrationIndex);
    const recreateIndex = text.indexOf('log "Recreating the remote production stack"', initializeIndex);
    const inventoryRecheckIndex = text.indexOf("verify_candidate_lifecycle_inventory", recreateIndex);
    const lifecycleRollbackForbiddenIndex = text.indexOf("ROLLBACK_FORBIDDEN=1", recreateIndex);
    const promoteIndex = text.indexOf('docker tag $(printf', recreateIndex);
    const healthWaitIndex = text.indexOf("wait_for_api_health", recreateIndex);
    const postDeployCapabilityIndex = text.indexOf("verify_post_deploy_lifecycle_capability", healthWaitIndex);

    expect(text).not.toContain("prepare_lifecycle_cutover");
    expect(text).not.toContain("desktop-lifecycle-v2 cutover is blocked");
    expect(health).toContain("[...PUBLIC_RUNTIME_CAPABILITIES]");
    expect(capabilityGate).toContain("print-public-capabilities");
    expect(capabilityGate).toContain("print-desktop-lifecycle-v2-evidence");
    expect(capabilityGate).toContain("verify-desktop-lifecycle-v2-evidence.mjs");
    expect(capabilityGate).toContain("verify_approved_lifecycle_manifest_digest");
    expect(manifestDigestGate).toContain("shasum -a 256");
    expect(manifestDigestGate).toContain("APPROVED_DESKTOP_LIFECYCLE_V2_EVIDENCE_SHA256");
    expect(capabilityGate).toContain("EXTENSION_PERSONA_RECEIPT");
    expect(capabilityGate).toContain("DESKTOP_PERSONA_RECEIPT");
    expect(capabilityGate).toContain("DESKTOP_DIAGNOSTICS_RECEIPT");
    expect(evidenceVerifier.match(/"--hostname"/g)).toHaveLength(2);
    expect(evidenceVerifier.match(/"github\.com"/g)).toHaveLength(2);
    expect(capabilityGate).toContain("'[]->[]'");
    expect(capabilityGate).toContain("'[]->[\"desktop-lifecycle-v2\"]'");
    expect(capabilityGate).toContain("'[\"desktop-lifecycle-v2\"]->[\"desktop-lifecycle-v2\"]'");
    expect(capabilityGate).toContain("'[\"desktop-lifecycle-v2\"]->[]'");
    expect(capabilityGate).toContain("would regress the already-enabled");
    expect(capabilityGate).toContain("LIFECYCLE_FIRST_ENABLE=1");
    expect(inventoryGate).toContain("verify-desktop-lifecycle-v2-inventory");
    expect(inventoryGate).toContain("--no-deps api");
    expect(startup).toContain("loadConfig(process.env, { loadDotEnv: false })");
    expect(postDeployCapability).toContain("desktop-lifecycle-v2");
    expect(capabilityGate).not.toContain("DEPLOY_EXTENSION_PERSONA_CAS_STATUS");
    expect(capabilityGateIndex).toBeGreaterThan(buildIndex);
    expect(preRecreateMigration).toContain("RUNTIME_IMAGE=");
    expect(preRecreateMigration).toContain("--no-deps api node packages/db/dist/migrate.js --through 0097_retire_onlyfans_legacy_dm_messages.sql");
    expect(preRecreateMigration).toContain("current API was left running");
    expect(forbidRollback).toContain("SCHEMA_BEFORE_FILE");
    expect(forbidRollback).toContain("is_rollback_compatible_migration");
    expect(forbidRollback).toContain("ROLLBACK_FORBIDDEN=1");
    expect(rollback).toContain('ROLLBACK_FORBIDDEN:-0');
    expect(schemaCaptureIndex).toBeGreaterThan(capabilityGateIndex);
    expect(forbidRollbackIndex).toBeGreaterThan(schemaCaptureIndex);
    expect(preRecreateMigrationIndex).toBeGreaterThan(schemaCaptureIndex);
    expect(releaseSyncIndex).toBeGreaterThan(preRecreateMigrationIndex);
    expect(text).not.toContain("DEPLOY_EXTENSION_PERSONA_CAS_STATUS");
    expect(text).not.toContain(".desktop-lifecycle-v2-cutover-complete");
    expect(text).not.toContain("mark_lifecycle_cutover_complete");
    expect(text).not.toContain("DEPLOY_DESKTOP_LIFECYCLE");
    expect(text).toContain("API_HEALTH_MAX_WAIT_SECONDS=1200");
    expect(text).not.toContain("API_HEALTH_ATTEMPTS");
    expect(waitForApi).toContain("SECONDS + API_HEALTH_MAX_WAIT_SECONDS");
    expect(waitForApi).toContain('curl_status "$health_file" "$url" 5');
    expect(initializeIndex).toBeGreaterThan(mainStart);
    expect(recreateIndex).toBeGreaterThan(initializeIndex);
    expect(inventoryRecheckIndex).toBeGreaterThan(recreateIndex);
    expect(lifecycleRollbackForbiddenIndex).toBeGreaterThan(inventoryRecheckIndex);
    expect(promoteIndex).toBeGreaterThan(lifecycleRollbackForbiddenIndex);
    expect(postDeployCapabilityIndex).toBeGreaterThan(healthWaitIndex);
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
    const buildCandidateFunction = getShellFunction(text, "build_candidate_image");
    const buildCandidateCallIndex = text.lastIndexOf("build_candidate_image");
    const releaseSyncIndex = text.indexOf("log \"Syncing release files");
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
    expect(buildCandidateFunction).toContain("build_full_candidate_image");
    expect(buildCandidateFunction).toContain("build_dist_only_candidate_image");
    expect(buildCandidateFunction).toContain("load_candidate_image");
    expect(buildCandidateCallIndex).toBeGreaterThan(candidateIndex);
    expect(releaseSyncIndex).toBeGreaterThan(buildCandidateCallIndex);
    expect(validationIndex).toBeGreaterThan(releaseSyncIndex);
    expect(recreateIndex).toBeGreaterThan(schemaCaptureIndex);
    expect(promoteIndex).toBeGreaterThan(schemaCaptureIndex);
    expect(deployComposeUpIndex).toBeGreaterThan(promoteIndex);
  });

  it("production Dockerfile and deploy script label dependency-compatible images", async () => {
    const dockerfile = await readComposeFile("Dockerfile");
    const deploy = await readComposeFile("scripts/deploy-production.sh");
    const fullBuild = getShellFunction(deploy, "build_full_candidate_image");
    const distBuild = getShellFunction(deploy, "build_dist_only_candidate_image");
    const publishCleanBase = getShellFunction(deploy, "publish_remote_clean_full_base_image");

    expect(dockerfile).toContain("ARG NODE_BASE_IMAGE=node:22-bookworm-slim");
    expect(dockerfile).toContain("FROM ${NODE_BASE_IMAGE} AS target-base");
    expect(dockerfile).toContain("LABEL agency-hub.dependency-checksum=");
    expect(dockerfile).toContain("LABEL agency-hub.source-revision=");
    expect(dockerfile).toContain("install --with-deps --only-shell chromium");
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/* /tmp/*");
    expect(dockerfile).not.toContain("install --with-deps chromium");
    expect(fullBuild).toContain('--build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}"');
    expect(fullBuild).toContain('--build-arg "APP_DEPENDENCY_CHECKSUM=${APP_DEPENDENCY_CHECKSUM}"');
    expect(fullBuild).toContain('--build-arg "APP_SOURCE_REVISION=${APP_SOURCE_REVISION}"');
    expect(distBuild).toContain("from pinned clean full image ${CLEAN_FULL_BASE_TAG}");
    expect(distBuild).not.toContain("docker tag");
    expect(distBuild).toContain("--build-arg APP_DEPENDENCY_CHECKSUM=");
    expect(distBuild).toContain("--build-arg APP_SOURCE_REVISION=");
    expect(publishCleanBase).toContain("CANDIDATE_IS_FULL_BUILD");
    expect(publishCleanBase).toContain("docker tag $(printf '%q' \"$IMAGE_CANDIDATE_TAG\") $(printf '%q' \"$CLEAN_FULL_BASE_TAG\")");
  });

  it("deploy-production.sh guards dist-only fallback with dependency checksum labels", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const validator = getShellFunction(text, "validate_dist_only_base");
    const autoBuild = getShellFunction(text, "build_candidate_image");
    const pruneMetadata = getShellFunction(text, "prune_macos_metadata_files");
    const createContext = getShellFunction(text, "create_dist_overlay_context");

    expect(text).toContain("export COPYFILE_DISABLE=1");
    expect(validator).toContain("read_remote_clean_full_base_dependency_checksum");
    expect(validator).toContain('docker image inspect $(printf \'%q\' "$CLEAN_FULL_BASE_TAG")');
    expect(validator).toContain("ALLOW_UNLABELED_DIST_BASE");
    expect(validator).toContain("Dist-only deploy cannot prove dependency compatibility");
    expect(validator).toContain("Dist-only deploy refused: dependency checksum changed");
    expect(autoBuild).toContain("Full Docker build failed before release sync; attempting dist-only fallback");
    expect(pruneMetadata).toContain("-name '._*'");
    expect(pruneMetadata).toContain("-name '.DS_Store'");
    expect(createContext).toContain('prune_macos_metadata_files "$DIST_CONTEXT_DIR"');
  });

  it("deploy-production.sh keeps every dist-only image to one minimal overlay", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const createContext = getShellFunction(text, "create_dist_overlay_context");
    const overlayBlock = text.match(/DIST_OVERLAY_PATHS=\(\n([\s\S]*?)\n\)/)?.[1] ?? "";
    const overlayPaths = overlayBlock.trim().split(/\s+/).filter(Boolean);

    expect(overlayPaths).toEqual([
      "apps/dashboard/dist",
      "apps/runtime/dist",
      "packages/db/dist",
      "packages/db/migrations",
    ]);
    expect(createContext).toContain("FROM ${CLEAN_FULL_BASE_TAG}");
    expect(createContext).not.toContain("WORKDIR /app");
    expect(createContext).toContain("COPY apps/dashboard/dist /app/apps/dashboard/dist");
    expect(createContext).toContain("COPY apps/runtime/dist /app/apps/runtime/dist");
    expect(createContext).toContain("COPY packages/db/dist /app/packages/db/dist");
    expect(createContext).toContain("COPY packages/db/migrations /app/packages/db/migrations");
    expect(createContext).not.toContain("packages/contracts/dist");
    expect(createContext).not.toContain("packages/fansly/dist");
    expect(createContext).not.toContain("packages/platform-core/dist");
    expect(createContext).not.toContain("packages/shared/dist");
  });

  it("deploy-production.sh publishes the clean full base only after production verification", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const buildCandidate = getShellFunction(text, "build_candidate_image");
    const dashboardIndex = text.indexOf('grep -q \'id="root"\' "$DASHBOARD_FILE"');
    const publishIndex = text.lastIndexOf("publish_remote_clean_full_base_image");
    const successIndex = text.indexOf('log "Deployment verified successfully"');

    expect(buildCandidate).toContain("CANDIDATE_IS_FULL_BUILD=1");
    expect(buildCandidate).toContain("CANDIDATE_IS_FULL_BUILD=0");
    expect(publishIndex).toBeGreaterThan(dashboardIndex);
    expect(successIndex).toBeGreaterThan(publishIndex);
  });

  it("deploy-production.sh allows rollback across known compatible migrations", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const rollback = getShellFunction(text, "rollback_remote_stack");

    expect(text).toContain("ROLLBACK_COMPATIBLE_MIGRATIONS=(");
    expect(text).toContain("0013_backfill_egress_rate_limit_scope_key.sql");
    expect(text).toContain("0014_repair_light_trusted_sync_states.sql");
    expect(text).toContain("0015_repair_egress_rate_limit_scope_key.sql");
    expect(text).toContain("0016_canonical_proxy_egress_key_function.sql");
    expect(text).toContain("0017_reapply_egress_rate_limit_scope_key_repair.sql");
    expect(text).toContain("0018_notification_incident_recovery_watermarks.sql");
    expect(text.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
      .toContain('"0186_ops_metrics_recent_series.sql"');
    expect(text).toContain("schema_migration_delta_allows_rollback");
    expect(rollback).toContain("Schema migrations changed only by rollback-compatible data migrations");
    expect(rollback).toContain("Rollback skipped; schema_migrations changed during this deploy");
  });

  // Pre-deploy audit B8: crash-recovery invariants. A deploy must not report
  // green with a dead worker, a failed startup must exit (not zombie-hang on
  // pg-boss handles), and every PgBoss instance needs an 'error' listener so
  // a transient Postgres blip cannot crash the process via an unhandled
  // EventEmitter 'error' throw.
  it("deploy-production.sh gates the deploy on worker container health (audit B8)", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const workerGate = getShellFunction(text, "wait_for_worker_health");

    expect(workerGate).toContain("ps -q worker");
    expect(workerGate).toContain(".State.Health.Status");
    expect(text).toMatch(/wait_for_worker_health \|\| fail/);
  });

  it("deploy-production.sh gates the deploy on scheduler container health", async () => {
    const text = await readComposeFile("scripts/deploy-production.sh");
    const schedulerGate = getShellFunction(text, "wait_for_scheduler_health");

    expect(schedulerGate).toContain("ps -q scheduler");
    expect(schedulerGate).toContain(".State.Health.Status");
    expect(text).toMatch(/wait_for_scheduler_health \|\| fail/);
  });

  it("startup.ts exits explicitly when main() fails (audit B8)", async () => {
    const text = await readComposeFile("apps/runtime/src/startup.ts");
    const catchBlock = text.slice(text.indexOf("main().catch"));

    expect(catchBlock).toContain("process.exit(1)");
    expect(catchBlock).not.toContain("process.exitCode");
  });

  it("every PgBoss instance attaches an error listener (audit B8)", async () => {
    const sources = await Promise.all([
      "apps/runtime/src/worker-runtime.ts",
      "apps/runtime/src/api/server.ts",
      "apps/runtime/src/cli.ts",
    ].map((file) => readComposeFile(file)));

    for (const source of sources) {
      const instantiations = source.split(/new PgBoss\(/).slice(1);
      expect(instantiations.length).toBeGreaterThan(0);
      for (const tail of instantiations) {
        // The listener (or the CLI helper that attaches one) must follow the
        // instantiation before any boss.start() call.
        const beforeStart = tail.split("boss.start()")[0]!;
        expect(beforeStart).toMatch(/boss\.on\("error"|attachCliPgBossErrorLogger\(boss\)/);
      }
    }
  });

  it("every long-lived role runs pg-boss maintenance hourly (S7 retention pin)", async () => {
    // Deletion happens on a maintenance pass, so the effective cadence is
    // deleteAfterSeconds PLUS up to one interval. pg-boss defaults the interval
    // to 24h: leaving it there would stretch the 24h heartbeat retention in
    // services/queue-retention.ts to as much as 48h. All three roles share one
    // pgboss schema, so all three must agree.
    for (const file of [
      "apps/runtime/src/api/server.ts",
      "apps/runtime/src/worker-runtime.ts",
      "apps/runtime/src/scheduler-runtime.ts",
    ]) {
      const source = await readComposeFile(file);
      const instantiations = source.split(/new PgBoss\(\{/).slice(1);

      expect(instantiations).toHaveLength(1);
      const constructorArgs = instantiations[0]!.split("});")[0]!;
      expect(constructorArgs).toContain("maintenanceIntervalSeconds: 3600");
    }
  });
});
