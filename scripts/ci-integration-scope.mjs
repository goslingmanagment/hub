import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Does this pull request need the integration shards? The owner's rule
// (2026-10-18): a PR runs them only when it touches DB, schema/migrations,
// sync or network code — or the integration suite, its harness and toolchain.
// Everything else is proven by the static checks on the PR, and by the full
// suite that every push to main runs: main's Quality Gate gates the deploy
// (scripts/main-ci-gate.sh). The label ci:full forces the shards on a PR.
//
// The decision reads the PR's own change: the merge commit GitHub tests
// (HEAD) against its first parent, the base branch's tip. Anything that
// cannot be read is a reason to run the shards, never to skip them.

/** Path rules, first match wins. A matching path needs the shards. */
export const INTEGRATION_PATHS = [
  // DB: schema, migrations, repositories, the client.
  { test: file => file.startsWith("packages/db/"), reason: "DB package" },
  // Sync: the engine, the platform wire and the page browser it drives (the
  // sync-browser integration tests run the operator against a real DB).
  { test: file => file.startsWith("apps/runtime/src/sync/"), reason: "sync engine" },
  { test: file => file.startsWith("packages/fansly/"), reason: "Fansly wire" },
  { test: file => file.startsWith("apps/page-browser/src/"), reason: "page browser operator" },
  // The runtime's composition roots wire the DB, the queues and the egress.
  { test: file => /^apps\/runtime\/src\/[^/]+$/.test(file), reason: "runtime entry point" },
  // Network: egress, proxies and the shared HTTP client.
  { test: file => file.startsWith("apps/runtime/src/services/egress/"), reason: "egress" },
  { test: file => /^packages\/shared\/src\/(?:http-client|proxy)\.ts$/.test(file), reason: "network client" },
  // The integration suite itself, its harness and fixtures.
  { test: file => /^tests\/(?:.+\/)?[^/]+\.integration\.test\.ts$/.test(file), reason: "integration test" },
  { test: file => ["tests/schema-guard.test.ts", "tests/http-client.test.ts"].includes(file), reason: "integration test" },
  { test: file => file.startsWith("tests/helpers/") || file.startsWith("tests/fixtures/") || file.startsWith("tests/ci/"), reason: "integration harness" },
  { test: file => ["vitest.config.ts", "docker-compose.test.yml"].includes(file), reason: "integration harness" },
  // Toolchain: dependencies, patches and the CI that runs the shards.
  { test: file => file === "package.json" || file.endsWith("/package.json"), reason: "dependencies" },
  { test: file => ["pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file) || file.startsWith("patches/"), reason: "dependencies" },
  { test: file => file === ".github/workflows/ci.yml" || file.startsWith("scripts/ci-"), reason: "CI" },
];

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

// Any other source that talks to the database is DB code: an import of the DB
// package (or a path into it), drizzle, pg or pg-boss. Unit tests and the
// dashboard are never DB code here: unit tests run in the static checks.
const DB_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](?:@agency_hub_core\/db(?:\/[^"']*)?|drizzle-orm(?:\/[^"']*)?|pg|pg-boss|[^"']*\/packages\/db\/[^"']*)["']/;

export function importsDatabase(source) {
  return DB_IMPORT.test(source);
}

function contentMayNeed(file) {
  return SOURCE_FILE.test(file) && !file.startsWith("tests/") && !file.startsWith("apps/dashboard/");
}

/**
 * The verdict for a list of changed paths. `readSource(file)` returns the
 * file's text (the new one, or the old one for a deleted file) or null.
 */
export function integrationScope(files, readSource) {
  const reasons = [];
  for (const file of files) {
    // Prose (a README beside the code) is never what the suite runs.
    if (file.endsWith(".md")) continue;
    const rule = INTEGRATION_PATHS.find(item => item.test(file));
    if (rule) {
      reasons.push(`${file} (${rule.reason})`);
    } else if (contentMayNeed(file)) {
      const source = readSource(file);
      if (source === null || importsDatabase(source)) reasons.push(`${file} (${source === null ? "unreadable" : "DB code"})`);
    }
  }
  return { needed: reasons.length > 0 || files.length === 0, reasons, files: files.length };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The PR's change: the tested merge commit against the base branch's tip. */
export function changedFiles(base = "HEAD^1", head = "HEAD") {
  const out = git(["diff", "--name-only", "--no-renames", "-z", base, head]);
  return out.split("\0").filter(Boolean);
}

export function readChangedSource(file, base = "HEAD^1", head = "HEAD") {
  for (const revision of [head, base]) {
    try {
      return git(["show", `${revision}:${file}`]);
    } catch {
      // Absent at this revision: a deleted file is read from the base.
    }
  }
  return null;
}

/** The step's decision from its environment; every doubt runs the shards. */
export function decide(env, readChanges) {
  if (env.SCOPE_EVENT !== "pull_request") return { needed: true, summary: "not a pull request: the full suite runs." };
  if (env.SCOPE_FORCE === "true") return { needed: true, summary: "label ci:full: the full suite runs." };
  let scope;
  try {
    scope = readChanges();
  } catch (error) {
    return { needed: true, summary: `the PR's change could not be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)}): the full suite runs.` };
  }
  if (!scope.needed) {
    return { needed: false, summary: `no DB/sync/network change among ${scope.files} changed file(s): integration is left to main.` };
  }
  if (scope.files === 0) return { needed: true, summary: "the PR changes no file: the full suite runs." };
  const shown = scope.reasons.slice(0, 10).map(reason => `- ${reason}`).join("\n");
  const more = scope.reasons.length > 10 ? `\n- … and ${scope.reasons.length - 10} more` : "";
  return { needed: true, summary: `the PR touches DB/sync/network code:\n${shown}${more}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = decide(process.env, () => integrationScope(changedFiles(), file => readChangedSource(file)));
  appendFileSync(process.env.GITHUB_OUTPUT, `integration_needed=${verdict.needed}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Integration ${verdict.needed ? "needed" : "skipped"}: ${verdict.summary}\n`);
  console.log(`Integration ${verdict.needed ? "needed" : "not needed"}: ${verdict.summary}`);
}
