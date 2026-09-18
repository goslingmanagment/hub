import path from "node:path";
import { expect, it } from "vitest";
import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { startIntegrationTestDatabase } from "./helpers/db.ts";

it("upgrades populated identities without losing credentials or releasing disabled logins", async (context) => {
  const testDb = await startIntegrationTestDatabase({ through: "0201_fan_earnings_content_revision.sql" });
  if (!testDb) { context.skip(); return; }
  const client = await testDb.pool.connect();
  try {
    await client.query(`
      insert into users (username, role, password_hash, disabled_at) values
        ('Nikita', 'chatter', 'existing-password-hash', null),
        ('Olga', 'chatter', 'disabled-password-hash', '2026-09-01T00:00:00Z');
      insert into auth_sessions (user_id, token_digest, expires_at)
        select id, 'existing-session-digest', '2027-01-01T00:00:00Z' from users where username = 'Nikita';
    `);
    const beforeUsers = await client.query("select * from users order by id");
    const beforeSessions = await client.query("select * from auth_sessions order by id");
    const beforeHistory = await client.query("select * from schema_migrations order by id");
    await runMigrations({ db: client, migrationsDir: path.resolve("packages/db/migrations") });

    expect((await client.query("select * from users order by id")).rows)
      .toEqual(beforeUsers.rows.map((user) => ({ ...user, deleted_at: null })));
    expect((await client.query("select * from auth_sessions order by id")).rows).toEqual(beforeSessions.rows);
    expect((await client.query("select * from schema_migrations where id <= '0201_fan_earnings_content_revision.sql' order by id")).rows)
      .toEqual(beforeHistory.rows);
    for (const username of ["nikita", "OLGA"]) {
      await expect(client.query("insert into users (username, role) values ($1, 'chatter')", [username]))
        .rejects.toMatchObject({ code: "23505" });
    }

    // Only permanent deletion frees the login, and the old FK still addresses
    // its retained historical row. Credential revocation itself is a service
    // invariant covered by user-identity-reuse.integration.test.ts.
    const original = beforeUsers.rows[0]!;
    await client.query("update users set deleted_at = now(), disabled_at = now(), password_hash = null where id = $1", [original.id]);
    const replacement = await client.query("insert into users (username, role) values ('NIKITA', 'chatter') returning id");
    expect(replacement.rows[0]!.id).not.toBe(original.id);
    expect((await client.query("select user_id from auth_sessions")).rows[0]!.user_id).toBe(original.id);

    for (const change of [
      "deleted_at = null", "deleted_at = deleted_at + interval '1 second'", "disabled_at = null",
      "password_hash = 'new-password-hash'", "username = 'renamed'", "id = id + 1000",
    ]) {
      await expect(client.query(`update users set ${change} where id = $1`, [original.id]))
        .rejects.toMatchObject({ code: "P0001" });
    }
  } finally {
    client.release();
    await testDb.stop();
  }
}, 60_000);
