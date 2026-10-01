import { getConfigOverrides, type Database } from "@agency_hub_core/db";
import { applyBootOverrides, type AppConfig, type SkippedOverride } from "@agency_hub_core/shared";

const BOOT_OVERRIDE_READ_ATTEMPTS = 3;

export interface BootConfigLogger {
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface BootConfig {
  /** The env config with the staged ('boot') DB overrides applied. */
  config: AppConfig;
  /** Boot-apply overrides rejected at start; the heartbeat publishes them. */
  bootSkipped: SkippedOverride[];
}

/** Apply the staged ('boot') DB overrides onto the env config exactly once, at
 *  process start, before anything reads config. Every long-lived role boots
 *  through here, so each reports the same `running` values in its heartbeat
 *  (a role that skipped this step would show drift and keep `pendingApply`
 *  set for every boot override). With no boot overrides in the DB this is a
 *  no-op and `config` equals the env config.
 *
 *  W5.5 (A31): a read failure used to fall back to env config — i.e. boot with
 *  EVERY staged cutover flag silently off. A crash-looping container is
 *  visible; a "healthy" process running pre-cutover code paths is not. The
 *  read is retried (the caller has already proven the schema ready, so
 *  failures here are transient), then rethrown: fail closed, never fail open. */
export async function loadBootConfig(
  db: Database,
  rawConfig: AppConfig,
  logger: BootConfigLogger,
): Promise<BootConfig> {
  const overrides = await readBootOverrides(db, logger);
  const applied = applyBootOverrides(rawConfig, overrides);
  return { config: applied.config, bootSkipped: applied.skipped };
}

async function readBootOverrides(db: Database, logger: BootConfigLogger) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await getConfigOverrides(db);
    } catch (err) {
      if (attempt >= BOOT_OVERRIDE_READ_ATTEMPTS) {
        logger.error(
          { err, attempts: BOOT_OVERRIDE_READ_ATTEMPTS },
          "boot override read failed after retries; refusing fail-open boot",
        );
        throw err;
      }
      logger.warn({ err, attempt }, "boot override read failed; retrying");
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
}
