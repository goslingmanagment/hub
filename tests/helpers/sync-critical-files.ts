import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// The shell expands the script's patterns before vitest sees them. They are
// all top-level tests/ files with at most a `*`; anything else fails here
// instead of silently resolving fewer files.
function globToRegExp(pattern: string): RegExp {
  if (!/^tests\/[^/]+$/.test(pattern) || /[?[\]{}]/.test(pattern)) throw new Error(`Unsupported pattern in test:sync-critical:db: ${pattern}`);
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+^$()|\\/]/g, "\\$&")).join("[^/]*")}$`);
}

/**
 * The repo-relative files `pnpm test:sync-critical:db` resolves: its
 * positional patterns minus its --exclude patterns, as package.json says.
 */
export function syncCriticalDbFiles(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = manifest.scripts["test:sync-critical:db"];
  if (!script) throw new Error("package.json has no test:sync-critical:db script");
  const tokens = script.split(/\s+/);
  const start = tokens.indexOf("run");
  if (start < 1 || tokens[start - 1] !== "vitest") throw new Error(`Unexpected test:sync-critical:db script: ${script}`);
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--exclude") exclude.push(globToRegExp(tokens[++index] ?? ""));
    else if (!token.startsWith("-")) include.push(globToRegExp(token));
  }
  const candidates = readdirSync(path.join(repoRoot, "tests")).map(name => `tests/${name}`);
  return candidates
    .filter(file => include.some(pattern => pattern.test(file)) && !exclude.some(pattern => pattern.test(file)))
    .sort();
}
