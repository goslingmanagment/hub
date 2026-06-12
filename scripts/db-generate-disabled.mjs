import { readdir } from "node:fs/promises";

async function suggestNextMigrationPrefix() {
  try {
    const migrationsDir = new URL("../packages/db/migrations/", import.meta.url);
    const files = await readdir(migrationsDir);
    const maxPrefix = files
      .filter((file) => file.endsWith(".sql"))
      .map((file) => Number.parseInt(file.split("_", 1)[0] ?? "", 10))
      .filter(Number.isFinite)
      .reduce((max, prefix) => Math.max(max, prefix), -1);

    if (maxPrefix >= 0) {
      return String(maxPrefix + 1).padStart(4, "0");
    }
  } catch {
    // Keep the failure message useful even if the migrations folder is unavailable.
  }

  return "next-numbered";
}

const nextPrefix = await suggestNextMigrationPrefix();

console.error([
  "`pnpm db:generate` is disabled for this repo.",
  "",
  "Database migrations are hand-written numbered SQL files in `packages/db/migrations`.",
  `Add the next migration manually, for example \`${nextPrefix}_short_description.sql\`, then run \`pnpm db:migrate\`.`,
  "",
  "Do not run `drizzle-kit generate` here: this repo intentionally does not keep a Drizzle migration journal in `packages/db/migrations/meta`.",
].join("\n"));

process.exitCode = 1;
