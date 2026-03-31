import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runMigrations } from "../packages/db/src/migrate-runner.ts";

describe("runMigrations", () => {
  it("prefers cwd-relative migrations when packages/db/migrations exists", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-cwd-"));
    const originalCwd = process.cwd();
    const db = {
      query: vi.fn(async (text: string) => {
        if (text.includes("select 1 from schema_migrations where id = $1")) {
          return {
            rowCount: 1,
            rows: [],
          };
        }

        return {
          rowCount: 0,
          rows: [],
        };
      }),
    };

    try {
      const migrationsDir = path.join(tempDir, "packages/db/migrations");
      await mkdir(migrationsDir, { recursive: true });
      await writeFile(path.join(migrationsDir, "9999_cwd.sql"), "select 1;\n");
      process.chdir(tempDir);

      await expect(runMigrations({ db: db as never })).resolves.toBeUndefined();
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("create table if not exists schema_migrations"));
      expect(db.query).toHaveBeenCalledWith(
        "select 1 from schema_migrations where id = $1",
        ["9999_cwd.sql"],
      );
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to module-relative migrations when cwd has no packages/db/migrations", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-fallback-"));
    const originalCwd = process.cwd();
    const db = {
      query: vi.fn(async (text: string) => {
        if (text.includes("select 1 from schema_migrations where id = $1")) {
          return {
            rowCount: 1,
            rows: [],
          };
        }

        return {
          rowCount: 0,
          rows: [],
        };
      }),
    };

    try {
      process.chdir(tempDir);

      await expect(runMigrations({ db: db as never })).resolves.toBeUndefined();
      expect(db.query).toHaveBeenCalledWith(
        "select 1 from schema_migrations where id = $1",
        ["0000_baseline.sql"],
      );
    } finally {
      process.chdir(originalCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when the resolved migrations directory has no SQL files", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-empty-migrations-"));
    const db = {
      query: vi.fn(async () => ({
        rowCount: 0,
        rows: [],
      })),
    };

    try {
      await expect(runMigrations({
        db: db as never,
        migrationsDir: tempDir,
      })).rejects.toThrow(`No SQL migrations were found in ${tempDir}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails directly when an explicit migrationsDir does not exist", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-missing-migrations-"));
    const missingDir = path.join(tempDir, "missing");
    const db = {
      query: vi.fn(async () => ({
        rowCount: 0,
        rows: [],
      })),
    };

    try {
      await expect(runMigrations({
        db: db as never,
        migrationsDir: missingDir,
      })).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
