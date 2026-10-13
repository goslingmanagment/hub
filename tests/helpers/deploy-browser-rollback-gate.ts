import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The rollback gate of deploy-production.sh for pages on their browser
// (Project Browser PR 14, Astra's reviews), run for real in bash: its remote
// commands run in a local bash against a `docker` that answers
// `docker image inspect` of the rollback target with a scripted label (or
// fails), and runs the command it is given inside the "postgres container"
// (here: the same bash), where `psql` writes the SQL it was given and answers
// with a scripted count.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const DEPLOY_SCRIPT = readFileSync(path.join(repoRoot, "scripts/deploy-production.sh"), "utf8");
export const ROLLBACK_BROWSER_GATE = "verify_rollback_target_runs_no_browser_page";

export function rollbackBrowserGateFunction(): string {
  const match = DEPLOY_SCRIPT.match(new RegExp(`^${ROLLBACK_BROWSER_GATE}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m"));
  if (!match) throw new Error(`Missing deploy function: ${ROLLBACK_BROWSER_GATE}`);
  return match[0];
}

const stubs = [
  "set -euo pipefail",
  "log() { printf '%s\\n' \"$*\" >&2; }",
  "fail() { printf 'error: %s\\n' \"$*\" >&2; exit 1; }",
  "run_remote() {",
  "  printf '%s\\n--\\n' \"$1\" >> \"$TEST_COMMAND_LOG\"",
  "  if [[ \"$TEST_REMOTE_FAIL\" == \"1\" ]]; then return 1; fi",
  "  PATH=\"$TEST_BIN:$PATH\" bash -c \"$1\"",
  "}",
].join("\n");

// `docker image inspect --format <template> <tag>`: the target's label.
// `docker compose … exec -T postgres sh -c '<script>'`: the script runs here.
const fakeDocker = [
  "#!/usr/bin/env bash",
  "if [[ \"$1\" == \"image\" ]]; then",
  "  printf '%s\\n' \"$*\" >> \"$TEST_IMAGE_LOG\"",
  "  if [[ \"$TEST_IMAGE_FAILS\" == \"1\" ]]; then printf 'Error: No such image\\n' >&2; exit 1; fi",
  "  printf '%s\\n' \"$TEST_IMAGE_LABEL\"",
  "  exit 0",
  "fi",
  "script=\"${@: -1}\"",
  "POSTGRES_PASSWORD=pw POSTGRES_USER=hub POSTGRES_DB=hub PATH=\"$TEST_BIN:$PATH\" sh -c \"$script\"",
  "",
].join("\n");

const fakePsql = [
  "#!/usr/bin/env bash",
  "cat > \"$TEST_SQL_FILE\"",
  "printf '%s\\n' \"$TEST_SQL_ANSWER\"",
  "",
].join("\n");

export interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The remote commands it ran. */
  commands: string[];
  /** The `docker image …` calls it made (their arguments). */
  images: string[];
  /** The SQL psql was given (null: none ran). */
  sql: string | null;
}

/** The rollback target of the runs: the image the deploy tagged before it
 *  replaced it. */
export const ROLLBACK_IMAGE = "example/hub:production-rollback-fixture";

/**
 * Run the gate. `applied`: the schema baseline before the deploy; `after`:
 * the schema the rollback captured (default: `applied` and 0277, 0278);
 * `label`: what the rollback image says in `agency-hub.sync-page-transport`
 * (default "": an image from before the label); `imageFails`: the image
 * cannot be inspected; `answer`: the count the database gives; `remoteFails`:
 * no remote command runs at all.
 */
export function runRollbackBrowserGate(
  options: { applied: string[]; after?: string[]; label?: string; imageFails?: boolean; answer?: string; remoteFails?: boolean },
): GateRun {
  const root = mkdtempSync(path.join(tmpdir(), "hub rollback browser gate "));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
    writeFileSync(path.join(bin, "psql"), fakePsql, { mode: 0o755 });
    mkdirSync(path.join(root, "app"));
    const baseline = path.join(root, "schema-before.txt");
    writeFileSync(baseline, [...options.applied, ""].join("\n"));
    const after = path.join(root, "schema-after.txt");
    writeFileSync(after, [...(options.after ?? [...options.applied, "0277_sync_pages_transport.sql", "0278_sync_pages_browser_leave.sql"]), ""].join("\n"));
    const commandLog = path.join(root, "commands.log");
    const imageLog = path.join(root, "images.log");
    const sqlFile = path.join(root, "query.sql");
    writeFileSync(commandLog, "");
    writeFileSync(imageLog, "");
    const result = spawnSync("bash", ["-c", [stubs, rollbackBrowserGateFunction(), ROLLBACK_BROWSER_GATE, 'log "gate passed"'].join("\n")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        SCHEMA_BEFORE_FILE: baseline,
        SCHEMA_AFTER_FILE: after,
        ROLLBACK_IMAGE_TAG: ROLLBACK_IMAGE,
        TEST_IMAGE_LOG: imageLog,
        TEST_IMAGE_LABEL: options.label ?? "",
        TEST_IMAGE_FAILS: options.imageFails === true ? "1" : "0",
        REMOTE_APP_DIR_ESCAPED: `'${path.join(root, "app")}'`,
        REMOTE_COMPOSE: "docker compose --env-file .env.production -f docker-compose.production.yml",
        TEST_COMMAND_LOG: commandLog,
        TEST_BIN: bin,
        TEST_SQL_FILE: sqlFile,
        TEST_SQL_ANSWER: options.answer ?? "0",
        TEST_REMOTE_FAIL: options.remoteFails === true ? "1" : "0",
      },
    });
    let sql: string | null = null;
    try {
      sql = readFileSync(sqlFile, "utf8");
    } catch {
      sql = null;
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      commands: readFileSync(commandLog, "utf8").split("\n--\n").filter((command) => command.trim().length > 0),
      images: readFileSync(imageLog, "utf8").split("\n").filter((line) => line.length > 0),
      sql,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
