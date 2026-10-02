import { Pool } from "pg";
import { createDb } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";
import { readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { inspectFanslyBinding, isNativeAccountId } from "../../apps/runtime/src/services/egress/fansly-binding-preflight.ts";
import { refuseEngineOwnedPage } from "./engine-owned.ts";
import { withFanslyScriptSendGuard } from "./send-guard.ts";

/** The send guard's wait plus the request, inside the CLI's 35 s process
 *  deadline with room left to write the completion. */
const GUARDED_REQUEST_BUDGET_MS = 20_000;

export function parseBindingPreflightArgs(args: string[]) {
  if (args.length !== 2 || args[0] !== "--page" || args[1] !== "lilly-1") {
    throw new Error("invalid_binding_preflight_arguments");
  }
  return { pageLabel: "lilly-1" as const };
}

export async function runBindingPreflight(pageLabel: "lilly-1", signal: AbortSignal) {
  const config = loadConfig(process.env, { loadDotEnv: false });
  const pool = new Pool({
    connectionString: config.databaseUrl, max: 1,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000, application_name: "hub-fansly-w0-binding",
    options: "-c default_transaction_read_only=on",
  });
  const controller = new AbortController();
  pool.on("error", () => controller.abort());
  let context: Awaited<ReturnType<typeof readProbeSnapshot>> | undefined;
  try {
    const db = createDb(pool);
    await refuseEngineOwnedPage(db, pageLabel);
    context = await readProbeSnapshot(db, config, pageLabel);
    const snapshot = context;
    const startedAt = new Date().toISOString();
    // Plan §2.5: the request waits for the page's send guard (source
    // `binding_preflight`) on a writable connection of its own.
    const inspection = await withFanslyScriptSendGuard(config, {
      pageId: snapshot.pageId, source: "binding_preflight", applicationName: "hub-fansly-w0-binding-guard",
    }, (sendGuard) => inspectFanslyBinding({
      session: snapshot.session, expectedAccountId: snapshot.expectedAccountId,
      egress: snapshot.egress, sendGuard,
      signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(GUARDED_REQUEST_BUDGET_MS)]),
    }));
    return {
      schemaVersion: 1, evidenceKind: "w0_rest_identity_preflight", pageLabel, pageId: context.pageId,
      expectedAccountId: isNativeAccountId(context.expectedAccountId) ? context.expectedAccountId : null,
      credentialRouteGeneration: context.generation,
      startedAt, finishedAt: new Date().toISOString(), ...inspection,
    };
  } finally {
    try { await context?.egress.dispatcher?.destroy(); }
    finally { await pool.end(); }
  }
}
