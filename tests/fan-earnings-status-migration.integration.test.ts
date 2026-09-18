import { expect, it } from "vitest";
import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";
import { earningsShadowFixture } from "./helpers/earnings-shadow-fixture.ts";

it("keeps pre-migration signals strict and grants only the bounded metadata function", async () => {
  const db = await startIntegrationTestDatabase({ through: "0200_users_username_lower_uidx.sql" });
  if (!db) throw new Error("Docker Postgres required");
  try {
    const f = await earningsShadowFixture(db);
    await db.pool.query(`insert into subject_refresh_state
      (page_id, plane, subject_ref, requested_revision, applied_revision, dirty_reason)
      values ($1, 'fan_earnings_lifetime', 'fan-a', 4, 3, 'semantic_transaction_change')`, [f.page.id]);
    await db.pool.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'read_only') then create role read_only; end if;
      end $$`);
    const client = await db.pool.connect();
    try { await runMigrations({ db: client }); } finally { client.release(); }
    expect((await f.rows())[0]).toMatchObject({
      requested_revision: 4n, applied_revision: 3n, earnings_content_revision: 4n,
    });
    const privileges = await db.pool.query(`select
      has_function_privilege('read_only', 'fansly_earnings_refresh_status(text,text)', 'execute') as allowed,
      has_table_privilege('read_only', 'subject_refresh_state', 'select') as base_allowed`);
    expect(privileges.rows[0]).toEqual({ allowed: true, base_allowed: false });
  } finally { await db.stop(); }
}, 30000);
