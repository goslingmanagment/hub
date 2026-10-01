// One OS process of the send-guard acceptance test (plan §2.5 p.3 (a)), run by
// tests/fansly-send-guard.integration.test.ts with `node --import tsx/esm`.
//
// It is a small legacy-engine process: the real FanslyAdapter, the real
// database-backed guard registry and (optionally) the real termination
// sweeper. Several sources loop requests against one page concurrently until
// the deadline; test hooks stretch the time between capture and send, block
// the process synchronously right after its last token check, or hang a
// sender before its completion. On exit it prints one JSON summary line.

import { writeFileSync } from "node:fs";

import { createDb, createPool } from "../../packages/db/src/index.ts";
import { FanslyAdapter } from "../../packages/fansly/src/adapter.ts";
import type { FanslySendSource } from "../../packages/fansly/src/send-guard.ts";
import type { AppConfig } from "../../packages/shared/src/index.ts";
import {
  createFanslySendGuards,
  startFanslySendGuardSweeper,
  type FanslySendGuardLogger,
  type FanslySendLeaseInfo,
} from "../../apps/runtime/src/services/fansly-send-guard/index.ts";

export interface FanslySendGuardChildConfig {
  name: string;
  databaseUrl: string;
  pageId: number;
  baseUrl: string;
  proxyUrl: string;
  settingMs: number;
  leaseMarginMs: number;
  durationMs: number;
  /** Each source loops requests from `startDelayMs` on; `captureDelay: false`
   *  sends right after its capture. */
  sources: Array<{
    source: FanslySendSource;
    requestTimeoutMs: number;
    startDelayMs?: number;
    captureDelay?: boolean;
  }>;
  /** Pause between capture and send: `longProbability` of uniform
   *  0..longMaxMs, else uniform 0..shortMaxMs. */
  captureDelay: { longProbability: number; longMaxMs: number; shortMaxMs: number };
  /** Freeze the whole process (event loop included) right after the send check
   *  passed, on the nth send of `source`. */
  blockAfterSendCheck: { source: FanslySendSource; nth: number; blockMs: number; markerPath: string } | null;
  /** Never write the completion of the nth lease: a hung sender. */
  hangBeforeCompletion: { nth: number; markerPath: string } | null;
  sweepIntervalMs: number | null;
}

const config = JSON.parse(process.env.FANSLY_SEND_GUARD_CHILD_CONFIG ?? "null") as FanslySendGuardChildConfig | null;
if (!config) {
  throw new Error("FANSLY_SEND_GUARD_CHILD_CONFIG is required");
}

const errors: Record<string, number> = {};
const warnings: Record<string, number> = {};
const logger: FanslySendGuardLogger = {
  info: () => undefined,
  warn: (_object, message) => {
    warnings[message] = (warnings[message] ?? 0) + 1;
  },
  error: (_object, message) => {
    warnings[message] = (warnings[message] ?? 0) + 1;
  },
};

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sendsBySource = new Map<string, number>();
let leases = 0;
const pool = createPool(config.databaseUrl, { onBackgroundError: () => undefined });
const db = createDb(pool);
const registry = createFanslySendGuards({
  db,
  config: {} as AppConfig,
  logger,
  role: "test",
  readSettingMs: async () => config.settingMs,
  leaseMarginMs: config.leaseMarginMs,
  hooks: {
    async afterCapture(lease: FanslySendLeaseInfo) {
      if (config.sources.find((entry) => entry.source === lease.source)?.captureDelay === false) return;
      const { longProbability, longMaxMs, shortMaxMs } = config.captureDelay;
      const delayMs = Math.random() < longProbability ? Math.random() * longMaxMs : Math.random() * shortMaxMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
    afterSendCheck(lease: FanslySendLeaseInfo) {
      const sends = (sendsBySource.get(lease.source) ?? 0) + 1;
      sendsBySource.set(lease.source, sends);
      const block = config.blockAfterSendCheck;
      if (block && block.source === lease.source && block.nth === sends) {
        writeFileSync(block.markerPath, JSON.stringify({ token: lease.token, pid: process.pid, at: Date.now() }));
        sleepSync(block.blockMs);
      }
    },
    async beforeCompletion(lease: FanslySendLeaseInfo) {
      leases += 1;
      const hang = config.hangBeforeCompletion;
      if (hang && hang.nth === leases) {
        writeFileSync(hang.markerPath, JSON.stringify({ token: lease.token, pid: process.pid, at: Date.now() }));
        await new Promise<never>(() => undefined);
      }
    },
  },
});
const sweeper = config.sweepIntervalMs === null
  ? null
  : startFanslySendGuardSweeper({ db, logger }, { registry, intervalMs: config.sweepIntervalMs });

const adapter = new FanslyAdapter({ baseUrl: config.baseUrl });
const deadline = Date.now() + config.durationMs;
let responses = 0;

async function runSource(source: FanslySendSource, requestTimeoutMs: number, startDelayMs: number) {
  await new Promise((resolve) => setTimeout(resolve, startDelayMs));
  const context = {
    session: { authorization: `synthetic-${config!.name}` },
    proxy: { url: config!.proxyUrl },
    egressKey: config!.proxyUrl,
    requestTimeoutMs,
    remainingAttempts: () => 1,
    sendGuard: registry.forPage(config!.pageId, source),
  };
  while (Date.now() < deadline) {
    try {
      await adapter.getAccountMe(context);
      responses += 1;
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      errors[name] = (errors[name] ?? 0) + 1;
      // A closed page or a lost database: try again shortly, like a chunk retry.
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 30));
  }
}

await Promise.all(config.sources.map(({ source, requestTimeoutMs, startDelayMs }) =>
  runSource(source, requestTimeoutMs, startDelayMs ?? 0)));
await sweeper?.stop();
await registry.close();
await adapter.close();
await pool.end();
process.stdout.write(`${JSON.stringify({
  name: config.name,
  pid: process.pid,
  responses,
  counters: registry.counters,
  errors,
  warnings,
})}\n`);
