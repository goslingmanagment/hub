import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { createDb } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";
import { readProbeSnapshot, type resolveFanslyProbeContext } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { openFanslyProbeSocket } from "../../apps/runtime/src/services/egress/fansly-probe-socket.ts";
import { correlationKeyFingerprint, readCorrelationKey } from "./correlation-key.ts";
import { observeFanslyProbe, MAX_PROBE_DURATION_MS } from "./probe-observer.ts";

export { readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";

export function parseProbeArgs(args: string[]) {
  if (![4, 6].includes(args.length) || args[0] !== "--page" || args[2] !== "--seconds"
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args[1] ?? "")
    || !/^\d{1,3}$/.test(args[3] ?? "")) {
    throw new Error("invalid_probe_arguments");
  }
  const durationMs = Number(args[3]) * 1_000;
  if (durationMs < 5_000 || durationMs > MAX_PROBE_DURATION_MS) {
    throw new Error("invalid_probe_duration");
  }
  if (args.length === 6) {
    const keyPath = args[5];
    if (args[4] !== "--correlation-key-file" || !keyPath
      || keyPath.startsWith("-") || /[\r\n\0]/.test(keyPath)) {
      throw new Error("invalid_probe_arguments");
    }
    return { pageLabel: args[1]!, durationMs, correlationKeyFile: keyPath };
  }
  return { pageLabel: args[1]!, durationMs };
}

/** Reuse the trusted runtime configuration without exporting the provider token.
 * No providers are booted; credential reads use verified READ ONLY snapshots. */
export async function runStoredFanslyProbe(input: {
  pageLabel: string;
  durationMs: number;
  controller: AbortController;
  correlationKeyFile?: string;
}) {
  const key = input.correlationKeyFile === undefined
    ? randomBytes(32) : await readCorrelationKey(input.correlationKeyFile);
  const config = loadConfig(process.env, { loadDotEnv: false });
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000,
    application_name: "hub-fansly-w0-probe",
    options: "-c default_transaction_read_only=on",
  });
  pool.on("error", () => input.controller.abort());
  const db = createDb(pool);
  const contexts: Awaited<ReturnType<typeof resolveFanslyProbeContext>>[] = [];

  async function readContext() {
    const context = await readProbeSnapshot(db, config, input.pageLabel);
    contexts.push(context);
    return context;
  }

  try {
    const before = await readContext();
    let connectionAttempts = 0;
    const observation = await observeFanslyProbe({
      connect: () => {
        connectionAttempts++;
        return openFanslyProbeSocket(before.egress);
      },
      token: before.token,
      key,
      durationMs: input.durationMs,
      signal: input.controller.signal,
    });
    let generationUnchanged: boolean | null = null;
    if (!input.controller.signal.aborted) {
      try {
        const after = await readContext();
        generationUnchanged = before.generation === after.generation;
      } catch { /* Failed post-read leaves continuity unknown. */ }
    }
    return {
      schemaVersion: 1,
      evidenceKind: "live_socket_probe",
      correlationKeyFingerprint: correlationKeyFingerprint(key),
      pageLabel: input.pageLabel,
      credentialSource: "existing_rest_session",
      credentialRouteGeneration: before.generation,
      generationUnchanged,
      accountBinding: "unverified",
      completeness: "unverified",
      readerLatencyMeasured: false,
      restRequests: 0,
      connectionAttempts,
      observation,
    };
  } finally {
    // Each context owns a fresh dispatcher, independent of the REST adapter.
    // An upgraded WS may outlive dispatcher destruction: the isolated process
    // must also have a hard deadline, including during cleanup.
    await Promise.allSettled(contexts.map((context) => context.egress.dispatcher?.destroy()));
    await pool.end();
  }
}
