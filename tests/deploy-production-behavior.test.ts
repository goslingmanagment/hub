import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const deployPath = path.join(repoRoot, "scripts/deploy-production.sh");
const infrastructurePath = path.join(repoRoot, "scripts/deploy-infrastructure.mjs");
const revision = "0123456789ab";
const checksum = "a".repeat(64);
const configHash = "b".repeat(64);
const imageId = `sha256:${"c".repeat(64)}`;
const containerId = "d".repeat(64);
const digest = `ghcr.io/example/hub@sha256:${"e".repeat(64)}`;
const candidateTag = "example/hub:production-candidate-fixture";
const currentPostgres = `${containerId}|${configHash}|${imageId}|running|healthy|agency-hub`;

function resolvedConfig() {
  return {
    name: "agency-hub",
    services: {
      postgres: {
        image: "postgres:16",
        environment: { POSTGRES_PASSWORD: "fixture-secret-never-log", POSTGRES_DB: "hub" },
        volumes: [{ type: "volume", source: "postgres_data", target: "/var/lib/postgresql/data" }],
        networks: { default: null },
      },
      api: { image: "example/hub:production", environment: { APP_FLAG: "old" } },
    },
    networks: { default: { name: "agency-hub_default" } },
    volumes: { postgres_data: { name: "agency-hub_postgres_data" } },
    configs: {},
    secrets: {},
  };
}

function fingerprintInput(input: string) {
  return spawnSync(process.execPath, [infrastructurePath], {
    input, encoding: "utf8", timeout: 5_000,
  });
}

function fingerprint(config: unknown) {
  const result = fingerprintInput(JSON.stringify(config));
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^[a-f0-9]{64}\n$/);
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

function shellFunction(name: string) {
  const text = readFileSync(deployPath, "utf8");
  const match = text.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)(?=^}\\n)`, "m"));
  if (!match) throw new Error(`Missing deploy function: ${name}`);
  return `${match[0]}}\n`;
}

// No test sources deploy's main. All production access terminates at these
// stubs; fixtures and command traces survive command-substitution subshells.
const shellPrelude = String.raw`
set -euo pipefail
log() { printf '%s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }
run_remote() {
  printf '%s\n' "$1" >> "$TEST_COMMAND_LOG"
  if [[ -n "$TEST_REMOTE_FAILURE_PATTERN" && "$1" == *"$TEST_REMOTE_FAILURE_PATTERN"* ]]; then return 23; fi
  case "$1" in
    *"docker pull "*) return 0 ;;
    *"agency-hub.source-revision"*) printf '%s\n' "$TEST_IMAGE_METADATA" ;;
    *"docker tag "*) return 0 ;;
    *"--current config --format json"*) if [[ -n "$TEST_CURRENT_COMPOSE_JSON" ]]; then printf '%s\n' "$TEST_CURRENT_COMPOSE_JSON"; else printf '%s\n' "$TEST_COMPOSE_JSON"; fi ;;
    *"config --format json"*) printf '%s\n' "$TEST_COMPOSE_JSON" ;;
    *"config --hash postgres"*) printf '%s\n' "$TEST_CONFIG_HASH" ;;
    *"config --images postgres"*) printf '%s\n' "$TEST_EXPECTED_IMAGE" ;;
    *"com.docker.compose.config-hash"*) printf '%s\n' "$TEST_POSTGRES_METADATA" ;;
    *"com.docker.compose.project"*) printf '%s\n' "$TEST_PROJECT" ;;
    *) printf 'Unexpected remote command\n' >&2; return 97 ;;
  esac
}
ssh() {
  printf 'ssh %s\n' "$*" >> "$TEST_COMMAND_LOG"
  if [[ "$TEST_SSH_FAILURE" == "1" ]]; then return 24; fi
  cat > "$TEST_STAGED_COMPOSE"
}
SSH_ARGS=()
`;

describe("production deploy behavior without production access", () => {
  let fixtureRoot: string;
  let commandLog: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "hub deploy behavior "));
    commandLog = path.join(fixtureRoot, "commands.log");
    writeFileSync(commandLog, "");
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEPLOY_")));
    return {
      ...inherited,
      BUILD_MODE: "pull", RECREATE_SCOPE: "apps", BUILD_PLATFORM: "linux/amd64",
      PULL_IMAGE: digest, IMAGE_CANDIDATE_TAG: candidateTag,
      APP_SOURCE_REVISION: revision, APP_DEPENDENCY_CHECKSUM: checksum,
      ROOT_DIR: fixtureRoot, SCRIPT_DIR: path.join(repoRoot, "scripts"),
      REMOTE: "root@fixture.invalid", REMOTE_APP_DIR_ESCAPED: "/opt/agency-hub",
      REMOTE_COMPOSE: "docker compose --current", REMOTE_CANDIDATE_COMPOSE: "docker compose --candidate",
      REMOTE_RUNTIME_IMAGE_ENV: "RUNTIME_IMAGE=fixture", DEPLOY_RUN_ID: "fixture-123",
      INFRASTRUCTURE_BASELINE: fingerprint(resolvedConfig()), POSTGRES_BASELINE: "",
      TEST_COMMAND_LOG: commandLog, TEST_STAGED_COMPOSE: path.join(fixtureRoot, "staged.yml"),
      TEST_IMAGE_METADATA: `linux/amd64|${revision}|${checksum}`,
      TEST_CURRENT_COMPOSE_JSON: "", TEST_COMPOSE_JSON: JSON.stringify(resolvedConfig()), TEST_CONFIG_HASH: `postgres ${configHash}`,
      TEST_EXPECTED_IMAGE: imageId, TEST_POSTGRES_METADATA: currentPostgres, TEST_PROJECT: "agency-hub",
      TEST_CALCULATED_CHECKSUM: checksum,
      TEST_REMOTE_FAILURE_PATTERN: "", TEST_SSH_FAILURE: "0",
      ...overrides,
    };
  }

  function runFunctions(names: string[], invocation: string, overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync("bash", ["-c", [shellPrelude, ...names.map(shellFunction), invocation].join("\n")], {
      encoding: "utf8", env: environment(overrides), timeout: 5_000,
    });
  }

  function commands() {
    return readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean);
  }

  it.each([
    "", "ghcr.io/example/hub:latest", `ghcr.io/example/hub@sha256:${"e".repeat(63)}`,
    `ghcr.io/example/hub@sha256:${"E".repeat(64)}`, `docker.io/example/hub@sha256:${"e".repeat(64)}`,
    `${digest}\n`, `${digest}; echo injected`, ` ${digest}`,
  ])("rejects a noncanonical pull reference before SSH: %j", (reference) => {
    const result = spawnSync("bash", ["-c", String.raw`
      ssh() { printf 'unexpected SSH\n' >> "$TEST_COMMAND_LOG"; return 99; }
      export -f ssh
      bash "$1" --mode pull --pull-image "$2" root@localhost
    `, "fixture", deployPath, reference], { encoding: "utf8", env: environment(), timeout: 5_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Pull mode requires");
    expect(commands()).toEqual([]);
  });

  it("pulls, inspects and tags the same immutable reference in order", () => {
    const result = runFunctions(["pull_candidate_image"], "pull_candidate_image");
    expect(result.status, result.stderr).toBe(0);
    const calls = commands();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain(`docker pull --platform=linux/amd64 ${digest}`);
    expect(calls[1]).toContain("docker image inspect --format");
    expect(calls[1]).toContain(digest);
    expect(calls[2]).toBe(`set -euo pipefail; docker tag ${digest} ${candidateTag}`);
    expect(calls.join("\n")).not.toMatch(/compose|stop|force-recreate/);
  });

  it.each([
    `linux/arm64|${revision}|${checksum}`,
    `linux/amd64|fedcba987654|${checksum}`,
    `linux/amd64|${revision}|${"f".repeat(64)}`,
    "linux/amd64|<no value>|<no value>", "", `linux/amd64|${revision}|${checksum}|extra`,
  ])("rejects mismatched or malformed image metadata before tagging: %j", (metadata) => {
    const result = runFunctions(["pull_candidate_image"], "pull_candidate_image", { TEST_IMAGE_METADATA: metadata });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match this checkout");
    expect(commands()).toHaveLength(2);
    expect(commands().join("\n")).not.toContain("docker tag");
  });

  it.each(["docker pull", "docker image inspect", "docker tag"])("propagates remote %s failure", (pattern) => {
    const result = runFunctions(["pull_candidate_image"], "pull_candidate_image", { TEST_REMOTE_FAILURE_PATTERN: pattern });
    expect(result.status).not.toBe(0);
    expect(commands().at(-1)).toContain(pattern);
    expect(result.stderr).not.toContain("identity verified");
  });

  function initCheckout() {
    writeFileSync(path.join(fixtureRoot, ".gitignore"), "commands.log\nstaged.yml\napps/runtime/dist/\n");
    writeFileSync(path.join(fixtureRoot, "package.json"), "{}\n");
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", fixtureRoot, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "--quiet");
    git("add", ".gitignore", "package.json");
    git("-c", "user.name=Deploy Test", "-c", "user.email=deploy@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture");
    return git("rev-parse", "--short=12", "HEAD");
  }

  function validateCheckout(expectedRevision: string, overrides: NodeJS.ProcessEnv = {}) {
    return runFunctions(["validate_pull_checkout"], String.raw`
      source "$SCRIPT_DIR/deploy-metadata.sh"
      calculate_dependency_checksum() { printf '%s\n' "$TEST_CALCULATED_CHECKSUM"; }
      validate_pull_checkout
    `, { APP_SOURCE_REVISION: expectedRevision, ...overrides });
  }

  it("accepts a clean matching checkout and unrelated evidence/ignored build outputs", () => {
    const head = initCheckout();
    mkdirSync(path.join(fixtureRoot, "investigations"));
    writeFileSync(path.join(fixtureRoot, "investigations/read-only-evidence.txt"), "evidence");
    mkdirSync(path.join(fixtureRoot, "apps/runtime/dist"), { recursive: true });
    writeFileSync(path.join(fixtureRoot, "apps/runtime/dist/api.js"), "compiled");
    const result = validateCheckout(head);
    expect(result.status, result.stderr).toBe(0);
    expect(commands()).toEqual([]);
  });

  it("rejects a stale checkout revision", () => {
    initCheckout();
    const result = validateCheckout(revision);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unchanged, clean checkout");
  });

  it("rejects tracked changes and dependency changes since metadata capture", () => {
    const head = initCheckout();
    const changedDependencies = validateCheckout(head, { TEST_CALCULATED_CHECKSUM: "f".repeat(64) });
    expect(changedDependencies.status).not.toBe(0);
    expect(changedDependencies.stderr).toContain("Dependency manifests changed");
    writeFileSync(path.join(fixtureRoot, "package.json"), '{"changed":true}\n');
    const dirty = validateCheckout(head);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("unchanged, clean checkout");
  });

  it.each(["packages/db/migrations/9999_unpublished.sql", "scripts/unpublished.mjs", "docker-compose.production.yml"])(
    "rejects untracked release input %s", (relativePath) => {
      const head = initCheckout();
      const filename = path.join(fixtureRoot, relativePath);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, "unpublished source\n");
      const result = validateCheckout(head);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("untracked release inputs");
    },
  );

  it("stages candidate Compose using the actual project name and production project directory", () => {
    writeFileSync(path.join(fixtureRoot, "docker-compose.production.yml"), "fixture compose bytes\n");
    const result = runFunctions(["prepare_remote_infrastructure_check"], String.raw`
      prepare_remote_infrastructure_check
      printf '%s\n%s\n' "$REMOTE_CANDIDATE_COMPOSE" "$INFRASTRUCTURE_BASELINE"
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--project-name agency-hub --project-directory /opt/agency-hub --env-file /opt/agency-hub/.env.production");
    expect(result.stdout).toContain("-f /tmp/agency-hub-infra-fixture-123/docker-compose.production.yml");
    expect(readFileSync(path.join(fixtureRoot, "staged.yml"), "utf8")).toBe("fixture compose bytes\n");
    expect(result.stdout).not.toContain("fixture-secret-never-log");
  });

  it.each(["", "<no value>", "bad project; echo injected"])("rejects an invalid existing Compose project %j before staging", (project) => {
    const result = runFunctions(["prepare_remote_infrastructure_check"], "prepare_remote_infrastructure_check", { TEST_PROJECT: project });
    expect(result.status).not.toBe(0);
    expect(commands()).toHaveLength(1);
    expect(result.stderr).toContain("Cannot identify existing Compose project");
  });

  it("accepts healthy unchanged PostgreSQL and binds its identity for the second guard", () => {
    const result = runFunctions(["verify_remote_infrastructure_unchanged"], String.raw`
      verify_remote_infrastructure_unchanged
      [[ "$POSTGRES_BASELINE" == "$TEST_POSTGRES_METADATA" ]]
      verify_remote_infrastructure_unchanged
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(commands()).toHaveLength(8);
    expect(commands().join("\n")).not.toMatch(/docker tag|force-recreate| stop /);
  });

  it("checks the synchronized Compose file at promotion even when the staged copy is unchanged", () => {
    const changed = resolvedConfig();
    changed.services.postgres.image = "postgres:17";
    const result = runFunctions(["verify_remote_infrastructure_unchanged"], String.raw`
      verify_remote_infrastructure_unchanged
      verify_remote_infrastructure_unchanged "$REMOTE_COMPOSE"
    `, { TEST_CURRENT_COMPOSE_JSON: JSON.stringify(changed) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("shared Compose configuration differs");
    expect(commands().at(-1)).toContain("--current config --format json");
  });

  it.each([
    ["config hash drift", `${containerId}|${"f".repeat(64)}|${imageId}|running|healthy|agency-hub`],
    ["image drift", `${containerId}|${configHash}|sha256:${"f".repeat(64)}|running|healthy|agency-hub`],
    ["stopped", `${containerId}|${configHash}|${imageId}|exited|healthy|agency-hub`],
    ["unhealthy", `${containerId}|${configHash}|${imageId}|running|unhealthy|agency-hub`],
    ["missing health", `${containerId}|${configHash}|${imageId}|running||agency-hub`],
    ["missing container", ""],
  ])("refuses PostgreSQL %s", (_case, metadata) => {
    const result = runFunctions(["verify_remote_infrastructure_unchanged"], "verify_remote_infrastructure_unchanged", { TEST_POSTGRES_METADATA: metadata });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PostgreSQL is unavailable, unhealthy, or differs");
    expect(commands().join("\n")).not.toContain("docker tag");
  });

  it("refuses replacement of an otherwise identical PostgreSQL container during deployment", () => {
    const result = runFunctions(["verify_remote_infrastructure_unchanged"], String.raw`
      verify_remote_infrastructure_unchanged
      TEST_POSTGRES_METADATA="$TEST_REPLACEMENT_POSTGRES"
      verify_remote_infrastructure_unchanged
    `, { TEST_REPLACEMENT_POSTGRES: currentPostgres.replace(containerId, "f".repeat(64)) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("container changed during deployment");
  });

  it.each([
    { TEST_COMPOSE_JSON: "" }, { TEST_COMPOSE_JSON: '{"secret":"fixture-secret-never-log"' },
    { TEST_CONFIG_HASH: "postgres <no value>" }, { TEST_EXPECTED_IMAGE: "" },
    { TEST_REMOTE_FAILURE_PATTERN: "config --format json" },
    { TEST_REMOTE_FAILURE_PATTERN: "config --hash postgres" },
    { TEST_REMOTE_FAILURE_PATTERN: "config --images postgres" },
    { TEST_REMOTE_FAILURE_PATTERN: "com.docker.compose.config-hash" },
  ])("fails closed on failed or malformed infrastructure observations %j", (overrides) => {
    const result = runFunctions(["verify_remote_infrastructure_unchanged"], "verify_remote_infrastructure_unchanged", overrides);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("fixture-secret-never-log");
  });

  it("rejects changed shared infrastructure before inspecting or mutating PostgreSQL", () => {
    const changed = resolvedConfig();
    changed.networks.default.name = "other_network";
    const result = runFunctions(["verify_remote_infrastructure_unchanged"], "verify_remote_infrastructure_unchanged", { TEST_COMPOSE_JSON: JSON.stringify(changed) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("shared Compose configuration differs");
    expect(commands()).toHaveLength(1);
  });

  it("leaves explicitly requested stack scope outside the app-only infrastructure guard", () => {
    const result = runFunctions(["prepare_remote_infrastructure_check", "verify_remote_infrastructure_unchanged"],
      "prepare_remote_infrastructure_check; verify_remote_infrastructure_unchanged", { RECREATE_SCOPE: "stack" });
    expect(result.status, result.stderr).toBe(0);
    expect(commands()).toEqual([]);
  });
});

describe("resolved Compose infrastructure fingerprint", () => {
  it("ignores object key order and application-only changes while emitting no secret", () => {
    const original = resolvedConfig();
    const reordered = {
      secrets: {}, configs: {}, volumes: original.volumes, networks: original.networks,
      services: {
        api: { image: "example/hub:new", environment: { APP_FLAG: "new" } },
        postgres: { ...original.services.postgres, environment: { POSTGRES_DB: "hub", POSTGRES_PASSWORD: "fixture-secret-never-log" } },
      },
      name: original.name,
    };
    expect(fingerprint(reordered)).toBe(fingerprint(original));
  });

  it.each([
    ["project", { name: "different-project" }],
    ["network", { networks: { default: { name: "another-network" } } }],
    ["volume", { volumes: { postgres_data: { name: "another-volume" } } }],
    ["config", { configs: { database: { file: "/other.conf" } } }],
    ["secret", { secrets: { database: { file: "/other-secret" } } }],
  ])("detects changed %s configuration", (_section, replacement) => {
    expect(fingerprint({ ...resolvedConfig(), ...replacement })).not.toBe(fingerprint(resolvedConfig()));
  });

  it("detects added, changed and removed non-app services", () => {
    const original = resolvedConfig();
    const withRedis = { ...original, services: { ...original.services, redis: { image: "redis:7" } } };
    const changedRedis = { ...original, services: { ...original.services, redis: { image: "redis:8" } } };
    expect(fingerprint(withRedis)).not.toBe(fingerprint(original));
    expect(fingerprint(changedRedis)).not.toBe(fingerprint(withRedis));
  });

  it("detects changed PostgreSQL configuration even if application configuration is unchanged", () => {
    const changed = resolvedConfig();
    changed.services.postgres.image = "postgres:17";
    expect(fingerprint(changed)).not.toBe(fingerprint(resolvedConfig()));
    changed.services.postgres.image = "postgres:16";
    changed.services.postgres.environment.POSTGRES_PASSWORD = "new-secret";
    expect(fingerprint(changed)).not.toBe(fingerprint(resolvedConfig()));
  });

  it.each(["", '{"token":"fixture-secret-never-log"', "null", "[]", "{}", '{"name":"hub","services":{"postgres":[]}}'])(
    "rejects malformed configuration without exposing input fragments: %j", (input) => {
      const result = fingerprintInput(input);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Unable to fingerprint resolved Compose infrastructure\n");
    },
  );
});
