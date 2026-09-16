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

declare module "vitest" {
  interface ProvidedContext {
    /** Null when Docker was unavailable and no cluster could be started. */
    testDbAdminUrl: string | null;
    /** Existing Postgres 16 container, for tests exercising its real psql client. */
    testDbContainerId: string | null;
  }
}
