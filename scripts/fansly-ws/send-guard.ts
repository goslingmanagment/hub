import { Pool } from "pg";

import { createDb } from "@agency_hub_core/db";
import type { FanslySendGuard, FanslySendSource } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import {
  createFanslySendGuards,
  settlesWithin,
  type FanslySendGuardLogger,
} from "../../apps/runtime/src/services/fansly-send-guard/index.ts";

// Plan §2.4/§2.5: every request the hub sends for a Fansly page passes the
// page's send guard, these W0 operator scripts included. They read the page
// through a READ ONLY pool; the guard's capture, journal row and completion
// are writes, so the guard alone gets this one writable connection. A
// database role that cannot write makes the capture fail, and then nothing is
// sent: the script fails closed.
//
// The script runs in a container of its own, so a holder it leaves behind
// (the process killed past its deadline) is not released by the api's or the
// worker's sweeper: the page stays closed with an alert until
// `fansly-send-guard confirm-terminated` confirms the container is gone.

/** A probe handshake's send window from its capture. */
export const PROBE_HANDSHAKE_WINDOW_MS = 20_000;
/** How long the end of a script waits for its completions to be written; past
 *  it the page stays closed (with its alert) until a confirmation, and the
 *  one-shot process exits anyway. */
const SCRIPT_GUARD_DRAIN_MS = 5_000;

/** Silent: these scripts export nothing but their receipts (a database error
 *  can carry SQL and parameters). The journal is the evidence. */
const silentLogger: FanslySendGuardLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Run `work` with the send guard of `pageId` for `source` on a dedicated
 * writable connection. Every capture is completed before the connection ends
 * (the registry drains), and the connection ends whatever happens.
 */
export async function withFanslyScriptSendGuard<T>(
  config: AppConfig,
  input: { pageId: number; source: FanslySendSource; applicationName: string },
  work: (guard: FanslySendGuard) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000,
    application_name: input.applicationName,
  });
  pool.on("error", () => undefined);
  const db = createDb(pool);
  const guards = createFanslySendGuards({
    db,
    config,
    logger: silentLogger,
    role: "script",
  });
  try {
    // Fail closed before any capture: a connection that cannot write the
    // guard could not release a capture either.
    const writable = await pool.query<{ writable: boolean }>(`
      select current_setting('transaction_read_only') = 'off'
         and has_table_privilege('fansly_page_send_guards', 'UPDATE')
         and has_table_privilege('fansly_page_send_guards', 'INSERT')
         and has_table_privilege('fansly_send_log', 'INSERT')
         and has_table_privilege('fansly_send_log', 'UPDATE') as writable`);
    if (writable.rows[0]?.writable !== true) {
      throw new Error("fansly_send_guard_not_writable");
    }
    return await work(guards.forPage(input.pageId, input.source));
  } finally {
    try {
      await settlesWithin(guards.close(), SCRIPT_GUARD_DRAIN_MS);
    } finally {
      await settlesWithin(pool.end(), SCRIPT_GUARD_DRAIN_MS);
    }
  }
}
