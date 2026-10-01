import { Pool } from "pg";

import { createDb } from "@agency_hub_core/db";
import { loadConfig } from "@agency_hub_core/shared";
import { readProbeGeneration, readProbeSnapshot } from "../../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { openFanslyProbeSocket } from "../../apps/runtime/src/services/egress/fansly-probe-socket.ts";
import { createProbeTransportDiagnostics } from "../../apps/runtime/src/services/egress/fansly-probe-diagnostics.ts";
import { readCorrelationKey } from "./correlation-key.ts";
import { observeFanslyContinuity, type parseContinuityArgs } from "./continuity.ts";
import { readBindingReceipt, verifyBindingBeforeConnect } from "./binding-receipt.ts";
import { PROBE_HANDSHAKE_WINDOW_MS, withFanslyScriptSendGuard } from "./send-guard.ts";

export async function runStoredFanslyContinuity(
  args: ReturnType<typeof parseContinuityArgs>,
  controller: AbortController,
  writeLine: (line: string) => void,
) {
  const binding = await readBindingReceipt(args.bindingReceiptFile);
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
    const bindingPreflight = await verifyBindingBeforeConnect(binding, context, args.pageLabel,
      () => readProbeGeneration(db, args.pageLabel));
    const ownedContext = context;
    const transportDiagnostics = createProbeTransportDiagnostics();
    // Plan §2.5: the one handshake waits for the page's send guard (source
    // `ws_probe`), on a writable connection of its own.
    return await withFanslyScriptSendGuard(config, {
      pageId: ownedContext.pageId, source: "ws_probe", applicationName: "hub-fansly-w0-continuity-guard",
    }, async (sendGuard) => {
      const lease = await sendGuard.acquire({
        operation: "ws_probe", requestTimeoutMs: PROBE_HANDSHAKE_WINDOW_MS, signal: controller.signal,
      });
      try {
        return await observeFanslyContinuity({
          ...args, token: ownedContext.token, generation: ownedContext.generation, key, controller, writeLine,
          bindingPreflight,
          connect: () => openFanslyProbeSocket(ownedContext.egress, lease, transportDiagnostics),
          transportDiagnostics,
          readGeneration: () => readProbeGeneration(db, args.pageLabel),
        });
      } finally {
        await lease.complete({ outcome: lease.sent ? "transport_error" : "aborted_before_send" });
      }
    });
  } finally {
    try { await context?.egress.dispatcher?.destroy(); }
    finally { await pool.end(); }
  }
}
