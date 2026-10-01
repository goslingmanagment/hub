import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
    *"docker pull "*|*"start scheduler worker"*|*"up -d --no-deps --force-recreate --no-build sync"*) return 0 ;;
    *"ps -q sync"*) next_sync_status ;;
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
# Each sync health probe answers the next status of TEST_SYNC_STATUSES (the
# last one repeats). The probe runs in a command substitution, so the position
# lives in a file.
next_sync_status() {
  local index=0
  [[ -f "$TEST_COMMAND_LOG.sync" ]] && index="$(cat "$TEST_COMMAND_LOG.sync")"
  printf '%s\n' $((index + 1)) > "$TEST_COMMAND_LOG.sync"
  set -- $TEST_SYNC_STATUSES
  (( index < $# )) || index=$(($# - 1))
  shift "$index"
  printf '%s' "$1"
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
  let infrastructureBaseline: string;

  beforeAll(() => {
    // The baseline input is the constant `resolvedConfig()` and the script is a
    // pure hash of it: one node spawn serves every case. The script itself is
    // exercised in "resolved Compose infrastructure fingerprint" below.
    infrastructureBaseline = fingerprint(resolvedConfig());
  });

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
      INFRASTRUCTURE_BASELINE: infrastructureBaseline, POSTGRES_BASELINE: "",
      TEST_COMMAND_LOG: commandLog, TEST_STAGED_COMPOSE: path.join(fixtureRoot, "staged.yml"),
      TEST_IMAGE_METADATA: `linux/amd64|${revision}|${checksum}`,
      TEST_CURRENT_COMPOSE_JSON: "", TEST_COMPOSE_JSON: JSON.stringify(resolvedConfig()), TEST_CONFIG_HASH: `postgres ${configHash}`,
      TEST_EXPECTED_IMAGE: imageId, TEST_POSTGRES_METADATA: currentPostgres, TEST_PROJECT: "agency-hub",
      TEST_CALCULATED_CHECKSUM: checksum,
      TEST_REMOTE_FAILURE_PATTERN: "", TEST_SSH_FAILURE: "0", TEST_SYNC_STATUSES: "healthy",
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

  // Plan §2.5: the per-page Fansly send guard. Run the hook's remote command
  // for real in a local bash, against `docker` and `date` shims that log what
  // they were asked: what it lists, in which order, and what it confirms.
  function sendGuardHook(options: { inspectFails?: boolean; running?: string; execFails?: boolean } = {}) {
    const bin = path.join(fixtureRoot, "bin");
    const calls = path.join(fixtureRoot, "docker-calls.log");
    mkdirSync(bin);
    writeFileSync(calls, "");
    writeFileSync(path.join(bin, "date"), [
      "#!/usr/bin/env bash",
      `printf 'date %s\\n' "$*" >> ${JSON.stringify(calls)}`,
      "printf '2026-10-01T12:00:00.123Z\\n'",
    ].join("\n"), { mode: 0o755 });
    writeFileSync(path.join(bin, "docker"), [
      "#!/usr/bin/env bash",
      `printf 'docker %s\\n' "$*" >> ${JSON.stringify(calls)}`,
      'case "$1" in',
      `  ps) printf ${JSON.stringify(options.running ?? "c1\\nc2\\nc3\\n")} ;;`,
      `  inspect) ${options.inspectFails ? "exit 1" : 'shift 3; for id in "$@"; do printf "host-%s\\n" "$id"; done'} ;;`,
      `  compose) ${options.execFails ? "exit 2" : "printf 'page\\tholder_host\\treleased\\nlilly-1\\told-worker\\ttrue\\n'"} ;;`,
      "esac",
    ].join("\n"), { mode: 0o755 });
    const result = runFunctions(["confirm_remote_fansly_send_guard_terminations"], String.raw`
      run_remote() { printf '%s\n' "$1" >> "$TEST_COMMAND_LOG"; PATH="$TEST_BIN:$PATH" bash -c "$1"; }
      confirm_remote_fansly_send_guard_terminations
    `, { TEST_BIN: bin, REMOTE_APP_DIR_ESCAPED: `'${fixtureRoot}'`, REMOTE_COMPOSE: "docker compose --current" });
    return { result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
  }

  it("confirms the send-guard holders of every container that is not running, captured before the listing", () => {
    const { result, calls } = sendGuardHook();
    expect(result.status, result.stderr).toBe(0);
    // The instant first, then the listing, then the confirmation in the new api.
    expect(calls).toEqual([
      "date -u +%Y-%m-%dT%H:%M:%S.%3NZ",
      "docker ps -q",
      "docker inspect -f {{.Config.Hostname}} c1 c2 c3",
      "docker compose --current exec -T api node apps/runtime/dist/cli.js fansly-send-guard confirm-terminated "
        + "--running-hosts host-c1,host-c2,host-c3 --include-unexpired --captured-before 2026-10-01T12:00:00.123Z",
    ]);
    expect(result.stderr).toContain("Fansly send guard: confirmed the holders of stopped containers terminated");
    expect(result.stderr).toContain("lilly-1\told-worker\ttrue");
  });

  it.each([
    ["an inspect failure (an incomplete list could free a live holder)", { inspectFails: true }],
    ["no running container at all", { running: "" }],
  ])("confirms nothing after %s", (_label, options) => {
    const { result, calls } = sendGuardHook(options);
    expect(result.status).not.toBe(0);
    expect(calls.join("\n")).not.toContain("confirm-terminated");
  });

  it("returns non-zero for a failed confirmation (the main flow only logs it)", () => {
    const { result, calls } = sendGuardHook({ execFails: true });
    expect(result.status).not.toBe(0);
    expect(calls.at(-1)).toContain("confirm-terminated");
    expect(result.stderr).not.toContain("confirmed the holders");
  });

  // Sync Engine design §3.6 rule (e): the same shape for the sync container's
  // page owners — the instant, then the running sync containers' hostnames,
  // then the confirmation in the new api, bounded by the instant.
  function syncOwnerHook(options: { running?: string; execFails?: boolean } = {}) {
    const bin = path.join(fixtureRoot, "bin");
    const calls = path.join(fixtureRoot, "docker-calls.log");
    mkdirSync(bin);
    writeFileSync(calls, "");
    writeFileSync(path.join(bin, "date"), [
      "#!/usr/bin/env bash",
      `printf 'date %s\\n' "$*" >> ${JSON.stringify(calls)}`,
      "printf '2026-10-02T09:00:00.456Z\\n'",
    ].join("\n"), { mode: 0o755 });
    writeFileSync(path.join(bin, "docker"), [
      "#!/usr/bin/env bash",
      `printf 'docker %s\\n' "$*" >> ${JSON.stringify(calls)}`,
      'case "$1" in',
      '  inspect) shift 3; for id in "$@"; do printf "host-%s\\n" "$id"; done ;;',
      '  compose)',
      '    if [[ "$*" == *" ps -q sync"* ]]; then',
      `      printf ${JSON.stringify(options.running ?? "s1\\n")}`,
      "    else",
      `      ${options.execFails ? "exit 2" : "printf 'page\\tgeneration\\towner_host\\tconfirmed\\nlilly-1\\t3\\told-sync\\ttrue\\n'"}`,
      "    fi ;;",
      "esac",
    ].join("\n"), { mode: 0o755 });
    const result = runFunctions(["confirm_sync_owner_handover"], String.raw`
      run_remote() { printf '%s\n' "$1" >> "$TEST_COMMAND_LOG"; PATH="$TEST_BIN:$PATH" bash -c "$1"; }
      confirm_sync_owner_handover
    `, { TEST_BIN: bin, REMOTE_APP_DIR_ESCAPED: `'${fixtureRoot}'`, REMOTE_COMPOSE: "docker compose --current" });
    return { result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
  }

  it("confirms the page owners of every sync container that is not running, acquired before the listing", () => {
    const { result, calls } = syncOwnerHook();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      "date -u +%Y-%m-%dT%H:%M:%S.%3NZ",
      "docker compose --current ps -q sync",
      "docker inspect -f {{.Config.Hostname}} s1",
      "docker compose --current exec -T api node apps/runtime/dist/cli.js sync ownership confirm-stopped "
        + "--running-hosts host-s1 --acquired-before 2026-10-02T09:00:00.456Z",
    ]);
    expect(result.stderr).toContain("Sync engine: confirmed the page owners of stopped sync containers");
    expect(result.stderr).toContain("lilly-1\t3\told-sync\ttrue");
  });

  it("confirms no sync owner when no sync container runs", () => {
    const { result, calls } = syncOwnerHook({ running: "" });
    expect(result.status).not.toBe(0);
    expect(calls.join("\n")).not.toContain("confirm-stopped");
  });

  it("returns non-zero for a failed sync owner confirmation (the main flow only logs it)", () => {
    const { result, calls } = syncOwnerHook({ execFails: true });
    expect(result.status).not.toBe(0);
    expect(calls.at(-1)).toContain("confirm-stopped");
    expect(result.stderr).not.toContain("confirmed the page owners");
  });

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

  it("restores existing sync containers without converging dependencies when the final guard rejects image drift", () => {
    const result = runFunctions([
      "verify_remote_infrastructure_unchanged", "restore_quiesced_sync_services", "fail", "fail_after_release_sync",
    ], String.raw`
      restore_remote_release_files() { printf 'restore release files\n' >> "$TEST_COMMAND_LOG"; }
      STACK_RECREATED=0
      LEGACY_SYNC_QUIESCED=1
      verify_remote_infrastructure_unchanged
      TEST_EXPECTED_IMAGE="$TEST_DRIFT_IMAGE"
      verify_remote_infrastructure_unchanged "$REMOTE_COMPOSE" || fail_after_release_sync "refused drift"
    `, { TEST_DRIFT_IMAGE: `sha256:${"f".repeat(64)}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refused drift");
    const calls = commands();
    expect(calls.at(-2)).toBe("restore release files");
    expect(calls.at(-1)).toContain("--current start scheduler worker");
    expect(calls.join("\n")).not.toMatch(/ up |docker tag|force-recreate/);
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

  it.each(["mkdir", "dockerfile", "copy"])("rejects a dist context after %s failure even in a conditional caller", (failure) => {
    const paths = ["apps/dashboard/dist", "apps/runtime/dist", "packages/db/dist", "packages/db/migrations"];
    for (const entry of paths) {
      mkdirSync(path.join(fixtureRoot, entry), { recursive: true });
      writeFileSync(path.join(fixtureRoot, entry, "fixture.txt"), "fixture");
    }
    const result = runFunctions(["copy_dist_overlay_path", "prune_macos_metadata_files", "create_dist_overlay_context"], String.raw`
      TEMP_DIR="$ROOT_DIR"
      CLEAN_FULL_BASE_TAG="fixture:base"
      DIST_OVERLAY_PATHS=(apps/dashboard/dist apps/runtime/dist packages/db/dist packages/db/migrations)
      mkdir() { [[ "$TEST_CONTEXT_FAILURE" != mkdir ]] || return 23; command mkdir "$@"; }
      cat() { [[ "$TEST_CONTEXT_FAILURE" != dockerfile ]] || return 23; command cat "$@"; }
      cp() {
        printf 'copy\n' >> "$TEST_COMMAND_LOG"
        command cp "$@"
        [[ "$TEST_CONTEXT_FAILURE" != copy ]] || return 23
      }
      if create_dist_overlay_context; then exit 0; else exit 51; fi
    `, { TEST_CONTEXT_FAILURE: failure });
    expect(result.status, result.stderr).toBe(51);
    expect(commands()).toHaveLength(failure === "copy" ? 1 : 0);
  });

  it("preserves lock ownership state and reports release failure to its conditional caller", () => {
    const result = runFunctions(["release_remote_deploy_lock"], String.raw`
      REMOTE_DEPLOY_LOCK_ACQUIRED=1
      REMOTE_DEPLOY_LOCK_DIR_ESCAPED=/opt/agency-hub/.deploy.lock
      REMOTE_DEPLOY_LOCK_DIR=/opt/agency-hub/.deploy.lock
      release_remote_deploy_lock || log "lock release failed"
      [[ "$REMOTE_DEPLOY_LOCK_ACQUIRED" == 1 ]]
    `, { TEST_REMOTE_FAILURE_PATTERN: "remote lock owner changed" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("lock release failed");
    expect(commands()).toHaveLength(1);
  });

  // Design §9.3 [A3]: the app-scope recreate leaves sync alone; it is
  // recreated on its own, without touching its dependencies, once the api is
  // healthy. A stack recreate already started it after API health.
  it("recreates only the sync container in app scope, and nothing in stack scope", () => {
    const apps = runFunctions(["recreate_sync_service"], "recreate_sync_service");
    expect(apps.status, apps.stderr).toBe(0);
    expect(commands()).toEqual([
      "set -euo pipefail; cd /opt/agency-hub && docker compose --current up -d --no-deps --force-recreate --no-build sync",
    ]);

    writeFileSync(commandLog, "");
    const stack = runFunctions(["recreate_sync_service"], "recreate_sync_service", { RECREATE_SCOPE: "stack" });
    expect(stack.status, stack.stderr).toBe(0);
    expect(stack.stderr).toContain("Stack recreate already started the sync container");
    expect(commands()).toEqual([]);
  });

  it("propagates a failed sync recreate to its caller", () => {
    const result = runFunctions(["recreate_sync_service"], String.raw`
      if recreate_sync_service; then exit 0; else exit 51; fi
    `, { TEST_REMOTE_FAILURE_PATTERN: "--no-deps --force-recreate --no-build sync" });
    expect(result.status, result.stderr).toBe(51);
  });

  it("waits for the sync container healthcheck to report healthy", () => {
    const result = runFunctions(["wait_for_sync_container_health"], String.raw`
      sleep() { :; }
      wait_for_sync_container_health
    `, { TEST_SYNC_STATUSES: "missing starting starting healthy" });
    expect(result.status, result.stderr).toBe(0);
    expect(commands()).toHaveLength(4);
    expect(commands().every((command) => command.includes("--current ps -q sync"))).toBe(true);
    expect(result.stderr).toContain("Sync container status: missing");
  });

  it.each(["unhealthy", "restarting", "missing"])("fails the sync health gate when the container stays %s", (status) => {
    const result = runFunctions(["wait_for_sync_container_health"], String.raw`
      sleep() { :; }
      if wait_for_sync_container_health; then exit 0; else exit 51; fi
    `, { TEST_SYNC_STATUSES: status });
    expect(result.status, result.stderr).toBe(51);
    expect(commands()).toHaveLength(60);
    expect(result.stderr).toContain(`Sync container last observed status: ${status}`);
  });

  // fail() dumps diagnostics after the rollback restored the previous release
  // files, which may predate the sync service. Compose refuses a whole `logs`
  // call naming a service its files lack, so the dump's remote command runs
  // here against a docker that refuses the same way.
  describe("remote diagnostics after a rollback", () => {
    const preSyncServices = "postgres api worker scheduler";
    const fakeDocker = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_DOCKER_LOG"
[[ $# -gt 0 && "$1" == compose ]] || exit 0
shift
while (( $# > 0 )); do
  case "$1" in ps|logs|config) break ;; esac
  shift
done
(( $# > 0 )) || exit 0
subcommand="$1"
shift
case "$subcommand" in
  ps) printf 'NAME SERVICE STATUS\n' ;;
  config) [[ "$*" == --services ]] && printf '%s\n' $TEST_COMPOSE_SERVICES ;;
  logs)
    for argument in "$@"; do
      [[ "$argument" == -* ]] && continue
      [[ " $TEST_COMPOSE_SERVICES " == *" $argument "* ]] || { printf 'no such service: %s\n' "$argument" >&2; exit 1; }
    done
    for argument in "$@"; do
      [[ "$argument" == -* ]] || printf '%s-1 | log of %s\n' "$argument" "$argument"
    done
    ;;
esac
`;
    // The remote command runs as run_remote would send it, in the app dir.
    const executeRemote = String.raw`
      run_remote() {
        printf '%s\n' "$1" >> "$TEST_COMMAND_LOG"
        PATH="$TEST_FAKE_BIN:$PATH" bash -c "$1"
      }
    `;

    function installFakeDocker() {
      const bin = path.join(fixtureRoot, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
      const log = path.join(fixtureRoot, "docker.log");
      writeFileSync(log, "");
      return { bin, log };
    }

    function runDiagnostics(services: string) {
      const docker = installFakeDocker();
      const appDir = path.join(fixtureRoot, "app");
      mkdirSync(appDir);
      const result = runFunctions(["dump_remote_diagnostics"], `${executeRemote}\ndump_remote_diagnostics`, {
        REMOTE_APP_DIR_ESCAPED: `'${appDir}'`, TEST_FAKE_BIN: docker.bin, TEST_DOCKER_LOG: docker.log,
        TEST_COMPOSE_SERVICES: services,
      });
      return { result, calls: readFileSync(docker.log, "utf8").trim().split("\n") };
    }

    it("the fake docker refuses a logs call naming a missing service, as Compose does", () => {
      const docker = installFakeDocker();
      const refused = spawnSync(path.join(docker.bin, "docker"), ["compose", "logs", "--tail=200", "postgres", "sync"], {
        encoding: "utf8", env: { ...process.env, TEST_COMPOSE_SERVICES: preSyncServices, TEST_DOCKER_LOG: docker.log },
      });
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toBe("no such service: sync\n");
    });

    it("still prints the postgres, api and worker logs when the restored release has no sync service", () => {
      const { result, calls } = runDiagnostics(preSyncServices);
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([
        "compose --current ps",
        "compose --current logs --tail=200 postgres api worker",
        "compose --current config --services",
      ]);
      expect(result.stdout).toContain("postgres-1 | log of postgres");
      expect(result.stdout).toContain("api-1 | log of api");
      expect(result.stdout).toContain("worker-1 | log of worker");
      expect(result.stderr).not.toContain("no such service");
      expect(result.stderr).not.toContain("Unable to collect remote diagnostics");
    });

    it("adds the sync logs in a call of their own when the release defines the sync service", () => {
      const { result, calls } = runDiagnostics(`${preSyncServices} sync`);
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([
        "compose --current ps",
        "compose --current logs --tail=200 postgres api worker",
        "compose --current config --services",
        "compose --current logs --tail=200 sync",
      ]);
      expect(result.stdout).toContain("worker-1 | log of worker");
      expect(result.stdout).toContain("sync-1 | log of sync");
      expect(result.stderr).not.toContain("no such service");
    });
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

  // The first release with the sync service is an app-scope deploy: adding,
  // changing or dropping it must not read as an infrastructure change.
  it("treats the sync service as application configuration", () => {
    const original = resolvedConfig();
    const withSync = {
      ...original,
      services: { ...original.services, sync: { image: "example/hub:production", command: ["node", "apps/runtime/dist/startup.js", "sync"] } },
    };
    const changedSync = {
      ...original,
      services: { ...original.services, sync: { image: "example/hub:new", stop_grace_period: "45s" } },
    };
    expect(fingerprint(withSync)).toBe(fingerprint(original));
    expect(fingerprint(changedSync)).toBe(fingerprint(original));
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
