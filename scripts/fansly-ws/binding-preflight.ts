import { Pool } from "pg";
import { createDb } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";
import { readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { inspectFanslyBinding, isNativeAccountId } from "../../apps/runtime/src/services/egress/fansly-binding-preflight.ts";

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
    context = await readProbeSnapshot(createDb(pool), config, pageLabel);
    const startedAt = new Date().toISOString();
    const inspection = await inspectFanslyBinding({
      session: context.session, expectedAccountId: context.expectedAccountId,
      egress: context.egress, signal: AbortSignal.any([signal, controller.signal]),
    });
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
