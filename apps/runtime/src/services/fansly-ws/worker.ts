import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  acquireFanslyWsOwnership, beginFanslyWsConnection, captureFanslyWsFrame,
  findPageByLabel, finishFanslyWsConnection, guardFanslyWsConnection,
  settleFanslyWsDecode, replayFanslyWsDecode, isFanslyWsGenerationBlocked, type Database,
} from "@agency_hub_core/db";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { readFanslyPageGeneration, readProbeGeneration, readProbeSnapshot } from "../egress/fansly-probe-context.ts";
import { openFanslyReceiverSocket } from "../egress/fansly-receiver-socket.ts";
import { receiveFanslyConnection, type FanslyWsStopReason } from "./connection.ts";

export function fanslyWsPages(config: Pick<AppContext["config"], "fanslyWsCaptureEnabled" | "fanslyWsCapturePageAllowlist">) {
  if (config.fanslyWsCaptureEnabled !== true) return new Set<string>();
  return new Set((config.fanslyWsCapturePageAllowlist ?? "").split(",")
    .map((label) => label.trim()).filter((label) => label !== "" && label !== "none"));
}

/** Worker-local supervisor. The only cross-process authority is each page's
 * dedicated PostgreSQL session. Live config is read at most every ten seconds. */
export function startFanslyWsWorker(app: AppContext) {
  const pages = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let stopped = false;
  let polling = false;
  let configReadAt = Date.now();
  const stopPages = (reason: "disabled" | "guard_unavailable") => {
    for (const page of pages.values()) page.controller.abort(reason);
  };
  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      const config = await loadEffectiveConfig(app.db, app.config);
      if (stopped) return;
      configReadAt = Date.now();
      const desired = fanslyWsPages(config);
      for (const [label, page] of pages) if (!desired.has(label)) page.controller.abort("disabled");
      for (const label of desired) {
        if (pages.has(label)) continue;
        const controller = new AbortController();
        const done = runPage(app, label, controller.signal).catch(() => {
          app.logger.warn({ pageLabel: label }, "Fansly B0 stopped; inspect connection receipts");
        }).finally(() => pages.delete(label));
        pages.set(label, { controller, done });
      }
    } catch { stopPages("guard_unavailable"); }
    finally { polling = false; }
  }
  const timer = setInterval(() => {
    if (Date.now() - configReadAt > 20_000) stopPages("guard_unavailable");
    void poll();
  }, 10_000);
  void poll();
  return {
    async stop() {
      stopped = true; clearInterval(timer); stopPages("disabled");
      await Promise.all([...pages.values()].map((page) => page.done));
    },
  };
}

async function runPage(app: AppContext, label: string, signal: AbortSignal) {
  let failures = 0;
  let previousGeneration: string | null = null;
  while (!signal.aborted) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason === "guard_unavailable" ? "guard_unavailable" : "disabled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let owner: Awaited<ReturnType<typeof acquireFanslyWsOwnership>> = null;
    let context: Awaited<ReturnType<typeof readProbeSnapshot>> | undefined;
    let connectionId: string | undefined;
    let reason: FanslyWsStopReason = "guard_unavailable";
    // Guard/status and capture share the lock-owning session without nested
    // transactions interleaving. No queue of business tasks or new dispatch authority.
    let pending: Promise<unknown> = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const next = pending.then(operation);
      pending = next.catch(() => undefined);
      return next;
    };
    try {
      const stored = await findPageByLabel(app.db, label);
      if (!stored || signal.aborted) return;
      owner = await acquireFanslyWsOwnership(app.config.databaseUrl, stored.page.id,
        () => controller.abort("ownership_lost"));
      if (!owner) { await pause(signal, 10_000); continue; }
      context = await readProbeSnapshot(owner.db, app.config, label);
      if (context.pageId !== stored.page.id || !context.expectedAccountId) throw new Error("fansly_ws_identity_changed");
      if (context.generation !== previousGeneration) { failures = 0; previousGeneration = context.generation; }
      const { pageId, generation, expectedAccountId, token, egress } = context;
      const owned = owner;
      if (await isFanslyWsGenerationBlocked(owned.db, pageId, generation)) {
        // Persisted refusal survives restarts. Only a different generation can
        // retry; disable/re-enable does not erase this evidence.
        reason = "auth_refused";
        throw new Error("fansly_ws_generation_blocked");
      }
      await replayFanslyWsDecode(owned.db, pageId).catch(() => undefined);
      if (controller.signal.aborted) throw new Error("fansly_ws_stopped");
      connectionId = randomUUID();
      const id = connectionId;
      await beginFanslyWsConnection(owned.db, { id, pageId, generation });
      const validate = async (db: Database) => {
        if (!owned.alive || controller.signal.aborted) throw new Error("fansly_ws_stopped");
        if (await readFanslyPageGeneration(db, label) !== generation) {
          controller.abort("generation_changed"); throw new Error("fansly_ws_generation_changed");
        }
      };
      // Check once more before opening, then at capture commit and every 5s.
      await validate(owned.db);
      reason = await receiveFanslyConnection({
        open: () => openFanslyReceiverSocket(egress), token, signal: controller.signal,
        onStable: () => { failures = 0; },
        capture: (frame, ordinal, receivedAt) => serial(() => captureFanslyWsFrame(owned.db, {
          connectionId: id, pageId, generation, accountRef: expectedAccountId,
          frame, ordinal, receivedAt, validate,
        })),
        settle: (observationId, nodes) => serial(() => settleFanslyWsDecode(owned.db, observationId, nodes)),
        guard: (verified) => serial(async () => {
          await validate(owned.db);
          await guardFanslyWsConnection(owned.db, id, verified);
          // Metadata repair cannot interrupt a healthy raw journal. Ownership
          // and status checks above remain fail-closed; pending debt survives.
          await replayFanslyWsDecode(owned.db, pageId).catch(() => undefined);
        }),
      });
    } catch {
      // Never log credential/dispatcher/SQL error objects. The attempt row is
      // the evidence; a failed initial resolution made no provider request.
      app.logger.warn({ pageLabel: label }, "Fansly B0 unavailable; polling continues");
    } finally {
      controller.abort("disabled");
      if (owner) {
        if (connectionId) await serial(() => finishFanslyWsConnection(owner!.db, connectionId!, reason)).catch(() => undefined);
        await owner.close();
      }
      if (context) await context.egress.dispatcher?.destroy().catch(() => undefined);
      signal.removeEventListener("abort", abort);
    }
    if (signal.aborted) return;
    if (reason === "auth_refused") {
      // Fail closed for this generation, including worker restarts (journal
      // check below). REST authority remains independent; no logout/revoke.
      while (!signal.aborted) {
        await pause(signal, 10_000);
        try { if (await readProbeGeneration(app.db, label) !== previousGeneration) break; }
        catch { /* unavailable is not a new credential generation */ }
      }
    } else {
      failures++;
      const backoff = failures >= 10 ? 30 * 60_000 : Math.min(60_000, 1_500 * 2 ** Math.min(failures, 6));
      await pause(signal, backoff * (0.8 + Math.random() * 0.4));
    }
  }
}

async function pause(signal: AbortSignal, ms: number) {
  await sleep(ms, undefined, { signal }).catch(() => undefined);
}
