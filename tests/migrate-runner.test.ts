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

  it("acquires and releases the advisory lock around direct migration runs", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-lock-"));
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
      await writeFile(path.join(tempDir, "0001_lock_probe.sql"), "select 1;\n");

      await expect(runMigrations({
        db: db as never,
        migrationsDir: tempDir,
      })).resolves.toBeUndefined();

      expect(db.query).toHaveBeenCalledWith("select pg_advisory_lock($1, $2)", [31415, 27182]);
      expect(db.query).toHaveBeenCalledWith("select pg_advisory_unlock($1, $2)", [31415, 27182]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs explicitly marked idempotent concurrent-index migrations outside a transaction", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-concurrent-"));
    const migration = "-- agency-hub:no-transaction\n"
      + "-- agency-hub:statement\nselect 1;\n"
      + "-- agency-hub:statement\n-- agency-hub:execute-returned-statements\nselect 'generated' as statement;\n";
    const db = {
      query: vi.fn(async (text: string) => text === "select 'generated' as statement;"
        ? { rowCount: 1, rows: [{ statement: "create index concurrently if not exists probe_idx on probe(id);" }] }
        : { rowCount: 0, rows: [] }),
    };

    try {
      await writeFile(path.join(tempDir, "0001_concurrent.sql"), migration);
      await expect(runMigrations({
        db: db as never,
        migrationsDir: tempDir,
      })).resolves.toBeUndefined();

      expect(db.query).toHaveBeenCalledWith(
        "create index concurrently if not exists probe_idx on probe(id);",
      );
      expect(db.query).toHaveBeenCalledWith(
        "insert into schema_migrations (id) values ($1)",
        ["0001_concurrent.sql"],
      );
      expect(db.query).not.toHaveBeenCalledWith("begin");
      expect(db.query).not.toHaveBeenCalledWith("commit");
      expect(db.query).not.toHaveBeenCalledWith("rollback");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies an exact bounded prefix for a pre-recreate long migration", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-through-"));
    const db = {
      query: vi.fn(async (text: string) => ({ rowCount: 0, rows: [], command: text })),
    };

    try {
      await writeFile(path.join(tempDir, "0001_first.sql"), "select 1;\n");
      await writeFile(path.join(tempDir, "0002_long.sql"), "select 2;\n");
      await writeFile(path.join(tempDir, "0003_future.sql"), "select 3;\n");

      await runMigrations({
        db: db as never,
        migrationsDir: tempDir,
        through: "0002_long.sql",
      });

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("select 1;"));
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining("select 2;"));
      expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining("select 3;"));
      expect(db.query).not.toHaveBeenCalledWith(
        "insert into schema_migrations (id) values ($1)",
        ["0003_future.sql"],
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores dotfile SQL metadata in migrations directories", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-dotfiles-"));
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
      await writeFile(path.join(tempDir, "._0001_real.sql"), "select broken;\n");
      await writeFile(path.join(tempDir, ".hidden.sql"), "select broken;\n");
      await writeFile(path.join(tempDir, "0001_real.sql"), "select 1;\n");

      await expect(runMigrations({
        db: db as never,
        migrationsDir: tempDir,
      })).resolves.toBeUndefined();

      expect(db.query).toHaveBeenCalledWith(
        "select 1 from schema_migrations where id = $1",
        ["0001_real.sql"],
      );
      expect(db.query).not.toHaveBeenCalledWith(
        "select 1 from schema_migrations where id = $1",
        ["._0001_real.sql"],
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    "0034-foo.sql",
    "0034_Foo.sql",
    "0034foo.sql",
  ])("fails loudly for malformed visible migration filename %s", async (filename) => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "agency-hub-migrations-invalid-"));
    const db = {
      query: vi.fn(async () => ({
        rowCount: 0,
        rows: [],
      })),
    };

    try {
      await writeFile(path.join(tempDir, filename), "select 1;\n");

      await expect(runMigrations({
        db: db as never,
        migrationsDir: tempDir,
      })).rejects.toThrow(
        `Invalid SQL migration filename(s) in ${tempDir}: ${filename}`,
      );
    } finally {
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
