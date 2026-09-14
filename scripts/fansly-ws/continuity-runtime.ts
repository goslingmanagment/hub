import { Pool } from "pg";

import { createDb } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";
import { readProbeGeneration, readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { openFanslyProbeSocket } from "../../apps/runtime/src/services/egress/fansly-probe-socket.ts";
import { readCorrelationKey } from "./correlation-key.ts";
import { observeFanslyContinuity, type parseContinuityArgs } from "./continuity.ts";

export async function runStoredFanslyContinuity(
  args: ReturnType<typeof parseContinuityArgs>,
  controller: AbortController,
  writeLine: (line: string) => void,
) {
  const key = await readCorrelationKey(args.correlationKeyFile);
  const config = loadConfig(process.env, { loadDotEnv: false });
  const pool = new Pool({
    connectionString: config.databaseUrl, max: 1,
    connectionTimeoutMillis: 5_000, statement_timeout: 5_000,
    query_timeout: 5_000, idle_in_transaction_session_timeout: 5_000,
    application_name: "hub-fansly-w0-continuity",
    options: "-c default_transaction_read_only=on",
  });
  pool.on("error", () => controller.abort());
  const db = createDb(pool);
  let context: Awaited<ReturnType<typeof readProbeSnapshot>> | undefined;
  try {
    context = await readProbeSnapshot(db, config, args.pageLabel);
    const ownedContext = context;
    return await observeFanslyContinuity({
      ...args, token: context.token, generation: context.generation, key, controller, writeLine,
      connect: () => openFanslyProbeSocket(ownedContext.egress),
      readGeneration: () => readProbeGeneration(db, args.pageLabel),
    });
  } finally {
    await context?.egress.dispatcher?.destroy();
    await pool.end();
  }
}
