import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject, vi } from "vitest";
import { EarningsAuditReader } from "../../scripts/fansly-events/earnings-audit-reader.ts";
import type { StartedTestDatabase } from "./db.ts";

/** Exercise the production stdin/stdout protocol using the suite's psql 16. */
export async function earningsAuditPsql(db: StartedTestDatabase) {
  const container = inject("testDbContainerId");
  const database = new URL(db.connectionString).pathname.slice(1);
  if (!container || !/^[a-z0-9_]+$/i.test(container + database)) {
    throw new Error("Docker Postgres is required for the real psql audit transport");
  }
  await db.pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_only') THEN CREATE ROLE read_only; END IF;
    END $$;
    GRANT EXECUTE ON FUNCTION fansly_earnings_audit_scope(text,timestamptz,timestamptz) TO read_only;
    GRANT EXECUTE ON FUNCTION fansly_earnings_audit_observations(jsonb,timestamptz,bigint,integer) TO read_only;
    GRANT EXECUTE ON FUNCTION fansly_earnings_audit_projection(jsonb,bigint,text,integer) TO read_only;
  `);
  const directory = await mkdtemp(join(tmpdir(), "hub-audit-psql-"));
  await writeFile(join(directory, "ssh"), `#!/bin/sh
exec docker exec -i -e 'PGOPTIONS=-c role=read_only' ${container} \
  timeout --kill-after=1s 120s psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d ${database}
`, { mode: 0o700 });
  vi.stubEnv("PATH", directory + ":" + process.env.PATH);
  return {
    reader: () => new EarningsAuditReader("fixture"),
    async close() {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
