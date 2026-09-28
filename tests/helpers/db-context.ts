/** Shared by global setup and isolated workers. Keep this module free of
 * runtime dependencies: importing the setup would load Testcontainers in
 * every test file that only needs an already-provided database. */

/** The migrated database every test database is cloned from. Nothing stays
 * connected to it after setup: `CREATE DATABASE ... TEMPLATE` refuses a
 * template that has live sessions. */
export const TEMPLATE_DATABASE = "hub_template";

/** Vitest `provide` key carrying the admin connection string (the cluster's own
 * `postgres` database) to every worker. */
export const TEST_DB_ADMIN_URL_KEY = "testDbAdminUrl";

/** Password of the disposable `read_only` login role global setup creates.
 * Roles are cluster-wide, so every test database (and every test file running
 * at the same time) sees this one role: suites grant to it in their own
 * database and log in with this password, and never create, alter or drop it. */
export const READ_ONLY_ROLE_PASSWORD = "read-only-test";

declare module "vitest" {
  interface ProvidedContext {
    /** Null when Docker was unavailable and no cluster could be started. */
    testDbAdminUrl: string | null;
    /** Existing Postgres 16 container, for tests exercising its real psql client. */
    testDbContainerId: string | null;
  }
}
