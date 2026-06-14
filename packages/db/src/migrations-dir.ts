import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_RELATIVE_MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const MIGRATION_FILENAME_PATTERN = /^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$/;

function isFallbackableMigrationsError(error: unknown) {
  if (error instanceof Error && error.message.startsWith("No SQL migrations were found in ")) {
    return true;
  }

  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function listMigrationFiles(migrationsDir: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql") && !file.startsWith("."));
  const invalidFiles = files.filter((file) => !MIGRATION_FILENAME_PATTERN.test(file));

  if (invalidFiles.length > 0) {
    throw new Error(
      `Invalid SQL migration filename(s) in ${migrationsDir}: ${invalidFiles.join(", ")}. `
        + "Expected names to match /^[0-9]{4}_[a-z0-9][a-z0-9_-]*\\.sql$/",
    );
  }

  const validFiles = files
    .sort();

  if (validFiles.length === 0) {
    throw new Error(`No SQL migrations were found in ${migrationsDir}`);
  }

  return validFiles;
}

export async function resolveMigrationFiles(input?: {
  migrationsDir?: string;
}) {
  if (input?.migrationsDir) {
    return {
      files: await listMigrationFiles(input.migrationsDir),
      migrationsDir: input.migrationsDir,
    };
  }

  const candidates = [...new Set([
    path.resolve(process.cwd(), "packages/db/migrations"),
    MODULE_RELATIVE_MIGRATIONS_DIR,
  ])];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return {
        files: await listMigrationFiles(candidate),
        migrationsDir: candidate,
      };
    } catch (error) {
      if (!isFallbackableMigrationsError(error)) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError ?? new Error("No SQL migrations were found");
}
