import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { createDb } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";
import { readProbeGeneration, readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { openFanslyProbeSocket } from "../../apps/runtime/src/services/egress/fansly-probe-socket.ts";
import { createProbeTransportDiagnostics } from "../../apps/runtime/src/services/egress/fansly-probe-diagnostics.ts";
import { correlationKeyFingerprint, readCorrelationKey } from "./correlation-key.ts";
import { observeFanslyProbe, MAX_PROBE_DURATION_MS } from "./probe-observer.ts";
import { readBindingReceipt, verifyBindingBeforeConnect } from "./binding-receipt.ts";

export { readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";

export function parseProbeArgs(args: string[]) {
  if (![4, 6, 8].includes(args.length) || args[0] !== "--page" || args[2] !== "--seconds"
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args[1] ?? "")
    || !/^\d{1,3}$/.test(args[3] ?? "")) {
    throw new Error("invalid_probe_arguments");
  }
  const durationMs = Number(args[3]) * 1_000;
  if (durationMs < 5_000 || durationMs > MAX_PROBE_DURATION_MS) {
    throw new Error("invalid_probe_duration");
  }
  const optional: { correlationKeyFile?: string; bindingReceiptFile?: string } = {};
  for (let index = 4; index < args.length; index += 2) {
    const key = args[index] === "--correlation-key-file" ? "correlationKeyFile"
      : args[index] === "--binding-receipt-file" ? "bindingReceiptFile" : null;
    const path = args[index + 1];
    if (key === null || optional[key] !== undefined || !path
      || path.startsWith("-") || /[\r\n\0]/.test(path)) {
      throw new Error("invalid_probe_arguments");
    }
    optional[key] = path;
  }
  return { pageLabel: args[1]!, durationMs, ...optional };
}

/** Reuse the trusted runtime configuration without exporting the provider token.
 * No providers are booted; credential reads use verified READ ONLY snapshots. */
export async function runStoredFanslyProbe(input: {
  pageLabel: string;
  durationMs: number;
  controller: AbortController;
  correlationKeyFile?: string;
  bindingReceiptFile?: string;
}) {
  const binding = input.bindingReceiptFile === undefined ? undefined
    : await readBindingReceipt(input.bindingReceiptFile);
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
  let before: Awaited<ReturnType<typeof readProbeSnapshot>> | undefined;

  try {
    before = await readProbeSnapshot(db, config, input.pageLabel);
    const context = before;
    const bindingPreflight = binding === undefined ? undefined
      : await verifyBindingBeforeConnect(binding, before, input.pageLabel,
        () => readProbeGeneration(db, input.pageLabel));
    let connectionAttempts = 0;
    const transportDiagnostics = createProbeTransportDiagnostics();
    const observation = await observeFanslyProbe({
      connect: () => {
        connectionAttempts++;
        return openFanslyProbeSocket(context.egress, transportDiagnostics);
      },
      token: before.token,
      key,
      durationMs: input.durationMs,
      signal: input.controller.signal,
      transportDiagnostics,
    });
    let generationUnchanged: boolean | null = null;
    if (!input.controller.signal.aborted) {
      try {
        generationUnchanged = before.generation === await readProbeGeneration(db, input.pageLabel);
      } catch { /* Failed post-read leaves continuity unknown. */ }
    }
    return {
      schemaVersion: 1,
      evidenceKind: "live_socket_probe",
      correlationKeyFingerprint: correlationKeyFingerprint(key),
      pageLabel: input.pageLabel,
      credentialSource: "existing_rest_session",
      credentialRouteGeneration: before.generation,
      ...(bindingPreflight === undefined ? {} : { bindingPreflight }),
      generationUnchanged,
      accountBinding: "unverified",
      completeness: "unverified",
      readerLatencyMeasured: false,
      restRequests: 0,
      connectionAttempts,
      observation,
    };
  } finally {
    // Keep cleanup best-effort; the isolated process also has a hard deadline.
    await Promise.allSettled([before?.egress.dispatcher?.destroy()]);
    await pool.end();
  }
}
