import { readdirSync, readFileSync } from "node:fs";

// Every statement of the sources that inserts or updates a row of
// `sync_pages`, by the function it sits in (step 4, S4-32 and S4-33). No
// statement names the old hold columns the page row had until they were
// dropped: tests/sync-old-hold-columns.test.ts pins this list,
// tests/sync-hold-set.integration.test.ts runs every function of it on a
// Postgres whose pages went through the drop with holds in those columns.

const SOURCE_FILE = /\.(ts|tsx|mts|mjs|js|sql|sh)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "migrations"]);

/** The source files under `dir` (not the migrations, not built output). */
export function sourceFiles(dir: string, pattern: RegExp = SOURCE_FILE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

export interface SyncPageRowWriter {
  file: string;
  /** The function the statement sits in (`<top level>` outside one). */
  name: string;
  statement: "insert" | "update";
}

/** The writers of the page row in `apps`, `packages` and `scripts`, in file
 *  and source order. */
export function syncPageRowWriters(): SyncPageRowWriter[] {
  return ["apps", "packages", "scripts"].flatMap((root) => sourceFiles(root)).sort().flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/\b(insert\s+into|update)\s+(?:only\s+)?sync_pages\b/g)].map((match): SyncPageRowWriter => {
      const before = text.slice(0, match.index);
      const enclosing = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].at(-1);
      return { file, name: enclosing?.[1] ?? "<top level>", statement: match[1]!.startsWith("insert") ? "insert" : "update" };
    });
  });
}
