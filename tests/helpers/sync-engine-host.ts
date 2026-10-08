import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  acquireSyncPageOwnership,
  createFanslyPage,
  createModel,
  ensureFanslyPageSendGuard,
  ensureSyncPage,
  type Database,
  type FanslySendHolderIdentity,
  type SyncPageMode,
} from "@agency_hub_core/db";
import { buildFanslyWireUrl, type FanslyWireOutcome, type FanslyWireRequest } from "@agency_hub_core/fansly";
import { loadConfig, type AppConfig } from "@agency_hub_core/shared";
import type { Pool } from "pg";

import {
  createDefaultFanslySendOsProbe,
  type FanslySendOsProbe,
} from "../../apps/runtime/src/services/fansly-send-guard/os-probe.ts";
import { SyncActor, type ActorDeps } from "../../apps/runtime/src/sync/engine/actor.ts";
import type {
  CaptureCodec,
  ChatUnavailableHook,
  SyncFaultHook,
  SyncLogger,
  ThreadChainChangedHook,
  WorkClosedHook,
} from "../../apps/runtime/src/sync/engine/commit.ts";
import { createPacer } from "../../apps/runtime/src/sync/engine/pacer.ts";
import {
  systemClock,
  type AlertSink,
  type Metrics,
  type OwnershipSession,
  type PageTransport,
  type SendHooks,
  type SettingsSource,
  type SyncAlertInput,
  type SyncAlertKey,
  type SyncMetricLabels,
  type TransportOutcome,
  type Wake,
} from "../../apps/runtime/src/sync/engine/ports.ts";
import {
  createEngineRegistry,
  type EngineRegistry,
  type EngineResourceSpec,
  type RequestPlan,
  type ResourceModule,
} from "../../apps/runtime/src/sync/engine/resource.ts";
import {
  onHistoryChatUnavailable,
  onHistoryThreadChainChanged,
  onHistoryWorkClosed,
} from "../../apps/runtime/src/sync/requests/history.ts";

// Shared doubles of the Fansly Sync Engine host and actor for the integration
// tests: a page with its sync row, test-only registry entries, a scripted live
// transport that never touches a network, a lock session the test controls,
// and recording alert/metric sinks.

const debugLog = process.env.SYNC_TEST_DEBUG === "1"
  ? (level: string) => (obj: object, msg?: string) => console.log(level, msg ?? "", JSON.stringify(obj, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))
  : () => () => undefined;

/** Silent; `SYNC_TEST_DEBUG=1` prints it. */
export const quietLogger: SyncLogger = {
  debug: debugLog("debug"),
  info: debugLog("info"),
  warn: debugLog("warn"),
  error: debugLog("error"),
};

export class RecordingAlerts implements AlertSink {
  opened: SyncAlertInput[] = [];
  resolved: SyncAlertKey[] = [];
  async open(input: SyncAlertInput): Promise<void> {
    this.opened.push(input);
  }
  async resolve(input: SyncAlertKey): Promise<void> {
    this.resolved.push(input);
  }
}

export class RecordingMetrics implements Metrics {
  readonly counts = new Map<string, number>();
  increment(name: string, _labels?: SyncMetricLabels, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }
  get(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

/** A lock session whose liveness and pings the test scripts. */
export class FakeOwnershipSession implements OwnershipSession {
  isAlive = true;
  holdsLock = true;
  pings: Array<"ok" | "timeout"> = [];
  pingCalls = 0;
  alive(): boolean {
    return this.isAlive;
  }
  async ping(): Promise<"ok" | "timeout"> {
    this.pingCalls += 1;
    return this.pings.shift() ?? "ok";
  }
  async stillHolds(): Promise<boolean> {
    return this.isAlive && this.holdsLock;
  }
  async tryLock(): Promise<boolean> {
    return this.isAlive;
  }
  async unlock(): Promise<void> {}
}

/** A wake that returns at once (the actor's loop re-reads immediately). */
export const immediateWake: Wake = {
  async wait(_pageId, ms, signal) {
    await sleep(Math.min(ms, 20), undefined, { signal }).catch(() => undefined);
    return "timeout";
  },
};

/** A config for host tests. */
export function testConfig(connectionString: string): AppConfig {
  return loadConfig({
    DATABASE_URL: connectionString,
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    LOG_LEVEL: "silent",
  }, { loadDotEnv: false });
}

/** A container's id; its first 12 hex digits are its hostname (Docker's
 *  default), which is what lets the OS proof judge an earlier run of it. */
export const TEST_CONTAINER_ID = `a1b2c3d4e5f6${"0".repeat(52)}`;

/** The OS probe of a process that runs as one run of the test container:
 *  its hostname and container id, the given pid namespace, no boot id. Two
 *  probes with different namespaces are two runs of the same container (a
 *  restart: `pid_namespace_replaced`). */
export function containerRunProbe(pidNamespace: string): FanslySendOsProbe {
  return {
    ...createDefaultFanslySendOsProbe(),
    hostname: () => TEST_CONTAINER_ID.slice(0, 12),
    containerId: () => TEST_CONTAINER_ID,
    pidNamespace: () => pidNamespace,
    bootId: () => null,
  };
}

export function testOwner(overrides: Partial<FanslySendHolderIdentity> = {}): FanslySendHolderIdentity {
  return {
    host: "sync-test-host",
    pid: 4242,
    pidStart: "start-4242",
    pidNs: null,
    bootId: null,
    instance: randomUUID(),
    role: "sync",
    ...overrides,
  };
}

export interface TestDbHandles {
  db: Database;
  pool: Pool;
}

export async function seedSyncPage(
  handles: TestDbHandles,
  options: { label?: string; mode?: SyncPageMode; guard?: "legacy" | "fansly_sync_engine" | null } = {},
): Promise<{ pageId: number; label: string }> {
  const { db, pool } = handles;
  const label = options.label ?? `sync-${randomUUID().slice(0, 8)}`;
  const model = await createModel(db, { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db, { modelId: model!.id, label });
  const pageId = page!.id;
  await ensureSyncPage(db, { pageId });
  if (options.mode !== undefined) await setModeDirect(pool, pageId, options.mode);
  if (options.guard !== undefined && options.guard !== null) {
    await ensureFanslyPageSendGuard(db, pageId);
    await pool.query("update fansly_page_send_guards set owner_engine = $1 where page_id = $2", [options.guard, pageId]);
  }
  return { pageId, label };
}

/** Write a mode directly (tests only: no lever reaches `live` or `handover`
 *  — a page is born live at onboarding, I17). A `live` page gets its import
 *  mark stamped, as a page's birth leaves it (the host starts no live loop
 *  without it, S3-05); `importedLegacy: false` leaves it out. */
export async function setModeDirect(
  pool: Pool,
  pageId: number,
  mode: SyncPageMode,
  options: { importedLegacy?: boolean } = {},
): Promise<void> {
  const imported = mode === "live" && options.importedLegacy !== false;
  await pool.query(
    `update sync_pages set mode = $1, mode_changed_at = clock_timestamp(), mode_changed_by = 'test',
            legacy_imported_at = case when $3::boolean then coalesce(legacy_imported_at, clock_timestamp()) else null end
      where page_id = $2`,
    [mode, pageId, imported],
  );
}

/** A test-only registry entry. */
export function testSpec(
  key: string,
  module: ResourceModule,
  overrides: Partial<Omit<EngineResourceSpec, "key" | "module">> = {},
): EngineResourceSpec {
  return {
    key,
    kind: "trigger",
    class: "urgent",
    http: true,
    evidence: false,
    fence: "none",
    ...overrides,
    module: async () => module,
  };
}

export function testRegistry(specs: readonly EngineResourceSpec[], metrics?: Metrics): EngineRegistry {
  return createEngineRegistry(specs, metrics === undefined ? {} : { metrics });
}

/** A plan that asks for `/polls` (a journal-first route: any answer passes). */
export const pollsRequest: RequestPlan = { spec: "polls", params: {} };

export function okResponse(response: unknown = { polls: [] }): FanslyWireOutcome {
  const bodyText = JSON.stringify({ success: true, response });
  return { kind: "response", status: 200, headers: {}, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

export function statusResponse(status: number, body: unknown = { success: false }): FanslyWireOutcome {
  const bodyText = JSON.stringify(body);
  return { kind: "response", status, headers: {}, bodyText, bodyBytes: bodyText.length, sendMark: "request_start" };
}

/**
 * A live transport that never opens a socket: it asks the send check exactly
 * where undici would, records each request that passed it (the test's "origin
 * arrival log", monotonic), waits `latencyMs` and answers from `respond`.
 */
export class ScriptedLiveTransport implements PageTransport {
  readonly hits: Array<{ mono: number; wall: Date; spec: string }> = [];
  refusals = 0;
  latencyMs = 0;
  respond: (req: FanslyWireRequest, index: number) => FanslyWireOutcome = () => okResponse();
  /** Runs right after a request passed the check (the child-process variant
   *  records it in the database). */
  onHit: ((req: FanslyWireRequest) => Promise<void>) | null = null;
  closed = false;

  async prepare(request: RequestPlan): Promise<FanslyWireRequest> {
    return {
      spec: request.spec,
      url: buildFanslyWireUrl(request.spec, request.params as never, "https://fansly.invalid/api/v1"),
      headers: {},
      timeoutMs: 20_000,
    };
  }

  async send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
    await sleep(0);
    const refusal = hooks.check();
    if (refusal !== null) {
      this.refusals += 1;
      return { kind: "aborted_before_send", refusal: refusal.reason };
    }
    this.hits.push({ mono: performance.now(), wall: new Date(), spec: req.spec });
    if (this.onHit !== null) await this.onHit(req);
    if (this.latencyMs > 0) await sleep(this.latencyMs, undefined, { signal }).catch(() => undefined);
    return this.respond(req, this.hits.length - 1);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface TestActorOptions {
  db: Database;
  pageId: number;
  registry: EngineRegistry;
  settingMs?: number;
  /** Default: a `ScriptedLiveTransport` answering every request 200. */
  transport?: PageTransport;
  ownership?: OwnershipSession;
  alerts?: AlertSink;
  metrics?: Metrics;
  faults?: SyncFaultHook;
  wake?: Wake;
  /** The previous owner's stop is taken as confirmed (stands for the OS proof
   *  of a dead process); default true. */
  confirmPrevious?: boolean;
  owner?: FanslySendHolderIdentity;
  floorDelayMs?: number;
  /** The page's native account id the commits see (default a placeholder). */
  ownRef?: string | null;
  /** The journal codec (default: the response verbatim). */
  capture?: CaptureCodec;
  /** The live settings resources read (default: the registry defaults). */
  settings?: SettingsSource;
  /** The history-request hooks of the commits (default: the production
   *  ones, as `main.ts` wires them; null: none). */
  onThreadChainChanged?: ThreadChainChangedHook | null;
  onWorkClosed?: WorkClosedHook | null;
  onChatUnavailable?: ChatUnavailableHook | null;
  /** The route budgets' time scale (default 0: no route budget — the test
   *  pause is 30 ms; `routeTestScale(settingMs)` keeps the production
   *  ratios). */
  routeTimeScale?: number;
}

/** The route time scale that keeps the production ratio of the route budgets
 *  to the owner's pause (S = 2 500 ms) at a test pause of `settingMs`. */
export function routeTestScale(settingMs: number): number {
  return settingMs / 2_500;
}

/** Acquire the page and build an actor on it with a small test setting. */
export async function makeTestActor(options: TestActorOptions): Promise<{
  actor: SyncActor;
  deps: ActorDeps;
  generation: bigint;
  stop: AbortController;
  abort: AbortController;
}> {
  const acquired = await acquireSyncPageOwnership(options.db, {
    pageId: options.pageId,
    owner: options.owner ?? testOwner(),
    judgePreviousOwner: () => (options.confirmPrevious === false ? null : "test_confirmed_dead"),
  });
  if (acquired.kind !== "acquired") throw new Error(`could not acquire page ${options.pageId}: ${acquired.kind}`);
  const ownership = options.ownership ?? new FakeOwnershipSession();
  const settingMs = options.settingMs ?? 30;
  const pacer = createPacer({
    clock: systemClock,
    rng: { next: () => 0.5 },
    pause: { readSettingMs: async () => settingMs },
    ownership,
    minSettingMs: 1,
  });
  pacer.initTakeover(options.floorDelayMs ?? 0);
  const deps: ActorDeps = {
    db: options.db,
    pageId: options.pageId,
    ownRef: options.ownRef === undefined ? "fansly-own-ref" : options.ownRef,
    generation: acquired.generation,
    registry: options.registry,
    clock: systemClock,
    rng: { next: () => 0.5 },
    alerts: options.alerts ?? new RecordingAlerts(),
    metrics: options.metrics ?? new RecordingMetrics(),
    logger: quietLogger,
    pacer,
    transport: options.transport ?? new ScriptedLiveTransport(),
    ownership,
    wake: options.wake ?? immediateWake,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.capture === undefined ? {} : { capture: options.capture }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.onThreadChainChanged === null ? {} : { onThreadChainChanged: options.onThreadChainChanged ?? onHistoryThreadChainChanged }),
    ...(options.onWorkClosed === null ? {} : { onWorkClosed: options.onWorkClosed ?? onHistoryWorkClosed }),
    ...(options.onChatUnavailable === null ? {} : { onChatUnavailable: options.onChatUnavailable ?? onHistoryChatUnavailable }),
    routeTimeScale: options.routeTimeScale ?? 0,
  };
  return {
    actor: new SyncActor(deps),
    deps,
    generation: acquired.generation,
    stop: new AbortController(),
    abort: new AbortController(),
  };
}

/** Poll `probe` until it returns non-null, or fail after `timeoutMs`. */
export async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Row counts of every public table (what a run changed). */
export async function tableCounts(pool: Pool): Promise<Map<string, number>> {
  const tables = await pool.query<{ name: string }>(
    "select quote_ident(tablename) as name from pg_tables where schemaname = 'public' order by tablename",
  );
  const counts = new Map<string, number>();
  for (const { name } of tables.rows) {
    const result = await pool.query<{ n: number }>(`select count(*)::int as n from ${name}`);
    counts.set(name, Number(result.rows[0]?.n ?? 0));
  }
  return counts;
}

/** Count rows with a query returning `n`. */
export async function countRows(pool: Pool, text: string, values: unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

export function changedTables(before: Map<string, number>, after: Map<string, number>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => (before.get(name) ?? 0) !== (after.get(name) ?? 0)).sort();
}

// ── registries shared with the child process (tests/helpers/sync-engine-child.ts) ──

export const CHILD_POLL_KEY = "own.poll";
export const CRASH_READ_KEY = "crash.read";

/** The registry of the `host` mode: one planned poll, always due. */
export function childPollRegistry() {
  const poll: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
  };
  return testRegistry([testSpec(CHILD_POLL_KEY, poll, { kind: "poll", class: "planned", period: { everyMs: 100 } })]);
}

/** The live registry of the crash tests: one read whose apply journals its
 *  effect (a second apply of the same observation would violate the key). */
export function crashRegistry() {
  const read: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async (tx, input) => {
      await tx.execute(
        `insert into sync_test_effects (observation_id, attempt_id) values (${input.observation.id}, ${input.attempt.id})` as never,
      );
      return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
    },
  };
  return testRegistry([testSpec(CRASH_READ_KEY, read)]);
}

/** A live transport whose every request that passed its check is recorded in
 *  `sync_test_hits` (the arrival log the parent reads across processes). */
export function recordingTransport(db: Database): ScriptedLiveTransport {
  const transport = new ScriptedLiveTransport();
  transport.onHit = async () => {
    await db.execute(`insert into sync_test_hits (pid) values (${process.pid})` as never);
  };
  return transport;
}

