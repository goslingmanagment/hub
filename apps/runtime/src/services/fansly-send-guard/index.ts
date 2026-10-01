import {
  captureFanslyPageSendGuard,
  completeFanslySendAttempt,
  confirmFanslySendGuardTerminated,
  journalUnpacedFanslySend,
  listFanslySendGuards,
  listHeldFanslySendGuards,
  markFanslySendAttemptSent,
  markFanslySendGuardClosed,
  type Database,
  type FanslySendGuardRow,
  type FanslySendHolderIdentity,
} from "@agency_hub_core/db";
import type { FanslySendGuard, FanslySendSource } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig } from "../effective-config.ts";
import {
  FanslySendGuardRegistry,
  type FanslySendGuardClock,
  type FanslySendGuardHooks,
  type FanslySendGuardLogger,
  type FanslySendGuardStore,
} from "./engine.ts";
import {
  buildFanslySendHolderIdentity,
  createDefaultFanslySendOsProbe,
  judgeFanslySendHolderTermination,
  type FanslySendHolderRole,
  type FanslySendOsProbe,
} from "./os-probe.ts";

export {
  FANSLY_SEND_BUSY_POLL_MS,
  FANSLY_SEND_JITTER_MAX,
  FANSLY_SEND_LEASE_MARGIN_MS,
  FanslyPageSendClosedError,
  FanslySendGuardRegistry,
  FanslySendGuardStoppedError,
  systemFanslySendGuardClock,
  type FanslySendGuardClock,
  type FanslySendGuardCounters,
  type FanslySendGuardHooks,
  type FanslySendGuardLogger,
  type FanslySendGuardStore,
  type FanslySendLeaseInfo,
} from "./engine.ts";
export {
  buildFanslySendHolderIdentity,
  containerIdFromMountinfo,
  createDefaultFanslySendOsProbe,
  createPortableFanslySendOsProbe,
  createProcFanslySendOsProbe,
  FanslySendProbeUnknownError,
  hostnameIsContainerId,
  judgeFanslySendHolderTermination,
  parseProcStatStartToken,
  type FanslySendHolderRole,
  type FanslySendOsProbe,
  type FanslySendTerminationEvidence,
} from "./os-probe.ts";

/** The guard store over the 0225 tables. */
export function createPgFanslySendGuardStore(db: Database): FanslySendGuardStore {
  return {
    capture: (input) => captureFanslyPageSendGuard(db, input),
    journalUnpaced: (input) => journalUnpacedFanslySend(db, input),
    markSent: (input) => markFanslySendAttemptSent(db, input),
    complete: (input) => completeFanslySendAttempt(db, input),
    markClosed: (input) => markFanslySendGuardClosed(db, input),
  };
}

export interface CreateFanslySendGuardsInput {
  db: Database;
  config: AppConfig;
  logger: FanslySendGuardLogger;
  role: FanslySendHolderRole;
  probe?: FanslySendOsProbe;
  clock?: FanslySendGuardClock;
  random?: () => number;
  hooks?: FanslySendGuardHooks;
  /** S, read fresh before every capture. Default: the live effective config. */
  readSettingMs?: () => Promise<number>;
  leaseMarginMs?: number;
}

/** The process's registry. S is read fresh before every capture, so a live
 *  change of `fanslyDefaultDelayMs` applies from the next request. */
export function createFanslySendGuards(input: CreateFanslySendGuardsInput): FanslySendGuardRegistry {
  const probe = input.probe ?? createDefaultFanslySendOsProbe();
  let identity: FanslySendHolderIdentity | null = null;
  return new FanslySendGuardRegistry({
    store: createPgFanslySendGuardStore(input.db),
    readSettingMs: input.readSettingMs
      ?? (async () => (await loadEffectiveConfig(input.db, input.config)).fanslyDefaultDelayMs),
    identity: () => {
      identity ??= buildFanslySendHolderIdentity(probe, input.role);
      return identity;
    },
    logger: input.logger,
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.random ? { random: input.random } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.leaseMarginMs === undefined ? {} : { leaseMarginMs: input.leaseMarginMs }),
  });
}

type GuardHost = {
  db: Database;
  config: AppConfig;
  logger: FanslySendGuardLogger;
  fanslySendGuards?: FanslySendGuardRegistry | undefined;
};

const implicitRegistries = new WeakMap<object, FanslySendGuardRegistry>();

/** The context's registry. createAppContext always sets one; a context built
 *  elsewhere (tests, scripts) gets a database-backed one on first use. */
export function getFanslySendGuards(app: GuardHost): FanslySendGuardRegistry {
  if (app.fanslySendGuards) return app.fanslySendGuards;
  let registry = implicitRegistries.get(app);
  if (!registry) {
    registry = createFanslySendGuards({ db: app.db, config: app.config, logger: app.logger, role: "cli" });
    implicitRegistries.set(app, registry);
  }
  return registry;
}

/** The send guard of one Fansly page for one kind of sender. */
export function fanslyPageSendGuard(app: GuardHost, pageId: number, source: FanslySendSource): FanslySendGuard {
  return getFanslySendGuards(app).forPage(pageId, source);
}

/** The guard of a check of an unknown session: journaled, unpaced. */
export function fanslyUnpacedSendGuard(app: GuardHost, source: FanslySendSource): FanslySendGuard {
  return getFanslySendGuards(app).withoutPage(source);
}

export const FANSLY_SEND_GUARD_SWEEP_INTERVAL_MS = 10_000;
/** stop() waits at most this long for a pass in flight: inside the api's and
 *  the worker's stop grace, beside the other bounded stops. A pass cut off by
 *  the exit wrote nothing half-way — each release or close is one statement. */
export const FANSLY_SEND_GUARD_SWEEPER_STOP_TIMEOUT_MS = 5_000;

export interface FanslySendGuardSweeper {
  /** One pass (tests drive it directly). */
  sweepOnce(): Promise<FanslySendGuardSweepResult>;
  /** Stops the ticks and waits for the pass in flight, bounded by
   *  `timeoutMs` (default FANSLY_SEND_GUARD_SWEEPER_STOP_TIMEOUT_MS). */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface FanslySendGuardSweepResult {
  confirmed: Array<{ pageId: number; evidence: string }>;
  closed: number[];
}

/**
 * The termination check every long-lived process runs (~10 s). For each page
 * whose holder overran its lease: if this host can PROVE the holder's process
 * is gone (another kernel boot; an earlier run of this very container; or the
 * same host and pid namespace with the pid gone or reused), release the page
 * with another 1.2 × S and journal `confirmed_terminated`; otherwise record the
 * page as closed. A live holder is never released.
 */
export function startFanslySendGuardSweeper(
  app: { db: Database; logger: FanslySendGuardLogger },
  input: {
    registry: FanslySendGuardRegistry;
    probe?: FanslySendOsProbe;
    intervalMs?: number;
    random?: () => number;
  },
): FanslySendGuardSweeper {
  const probe = input.probe ?? createDefaultFanslySendOsProbe();
  const intervalMs = input.intervalMs ?? FANSLY_SEND_GUARD_SWEEP_INTERVAL_MS;
  const random = input.random ?? Math.random;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  const sweepOnce = async (): Promise<FanslySendGuardSweepResult> => {
    const identity = input.registry.holderIdentity();
    const result: FanslySendGuardSweepResult = { confirmed: [], closed: [] };
    const rows = await listHeldFanslySendGuards(app.db, { expiredOnly: true });
    for (const row of rows) {
      if (row.holderToken === null) continue;
      const evidence = judgeFanslySendHolderTermination(row, { identity, probe });
      if (evidence) {
        const detail = `${evidence}; confirmed by ${identity.role}@${identity.host} pid ${identity.pid}`;
        const released = await confirmFanslySendGuardTerminated(app.db, {
          pageId: row.pageId,
          token: row.holderToken,
          evidence: detail,
          requireExpiredLease: true,
        });
        if (released) {
          result.confirmed.push({ pageId: row.pageId, evidence });
          app.logger.warn({
            component: "fansly_send_guard",
            pageId: row.pageId,
            holderHost: row.holderHost,
            holderPid: row.holderPid,
            holderRole: row.holderRole,
            evidence,
          }, "Fansly send guard released a page whose holder is confirmed terminated; next request after 1.2 × S");
        }
      } else if (row.closedReason === null) {
        const marked = await markFanslySendGuardClosed(app.db, {
          pageId: row.pageId,
          token: row.holderToken,
          reason: "lease_expired_unconfirmed",
        });
        if (marked) {
          result.closed.push(row.pageId);
          app.logger.error({
            component: "fansly_send_guard",
            pageId: row.pageId,
            holderHost: row.holderHost,
            holderPid: row.holderPid,
            holderRole: row.holderRole,
            holderSource: row.holderSource,
            leaseUntil: row.leaseUntil?.toISOString() ?? null,
          }, "Fansly page closed: its request holder overran the lease and is not confirmed terminated");
        }
      }
    }
    return result;
  };

  const schedule = () => {
    if (stopped) return;
    const spread = 0.8 + random() * 0.4;
    timer = setTimeout(() => {
      timer = null;
      running = sweepOnce()
        .catch((error: unknown) => {
          app.logger.warn({ component: "fansly_send_guard", err: error }, "Fansly send guard sweep failed");
        })
        .finally(() => {
          running = null;
          schedule();
        });
    }, Math.max(1, Math.floor(intervalMs * spread)));
    timer.unref?.();
  };
  schedule();

  return {
    sweepOnce,
    async stop(options = {}) {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const inFlight = running;
      if (!inFlight) return;
      const timeoutMs = options.timeoutMs ?? FANSLY_SEND_GUARD_SWEEPER_STOP_TIMEOUT_MS;
      if (!await settlesWithin(inFlight, timeoutMs)) {
        app.logger.warn(
          { component: "fansly_send_guard", timeoutMs },
          "Fansly send guard sweeper stop timed out on a pass in flight; the next process's sweeper repeats it",
        );
      }
    },
  };
}

/** Whether `promise` settles within `timeoutMs` (it is never rejected here:
 *  the callers' chains catch their own errors). */
export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        deadline.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/** `fansly-send-guard status`. */
export async function readFanslySendGuardStatus(db: Database): Promise<FanslySendGuardRow[]> {
  return listFanslySendGuards(db);
}

/**
 * `fansly-send-guard confirm-terminated --running-hosts h1,h2,…`: a Docker-level
 * confirmation. Every holder whose host is not among the hostnames of the
 * containers that are running (and is not this process's own host) is gone with
 * its container. By default only holders past their lease are released: such a
 * capture is older than the listing of the hostnames, so its container was
 * listed had it been running.
 *
 * `includeUnexpired` also releases holders whose lease still runs (a deploy
 * that just removed the containers) — but only those captured before
 * `capturedBefore`, the instant (DB clock = the host's clock) taken right
 * BEFORE the running containers were listed. A container that started after
 * the listing, and captured since, is never mistaken for a gone one.
 * `dryRun` reports without writing.
 */
export async function confirmFanslySendGuardHostsTerminated(
  db: Database,
  input: {
    runningHosts: readonly string[];
    ownHost: string;
    confirmer: string;
    includeUnexpired: boolean;
    capturedBefore?: Date | null;
    dryRun: boolean;
  },
): Promise<Array<{ pageId: number; pageLabel: string | null; holderHost: string | null; released: boolean }>> {
  const running = new Set([...input.runningHosts.map((host) => host.trim()).filter(Boolean), input.ownHost]);
  if (running.size < 2) {
    throw new Error("confirm-terminated needs the hostnames of the running containers (--running-hosts)");
  }
  const capturedBefore = input.capturedBefore ?? null;
  if (input.includeUnexpired && (capturedBefore === null || Number.isNaN(capturedBefore.getTime()))) {
    throw new Error(
      "--include-unexpired needs --captured-before: the instant taken before the running hostnames were listed",
    );
  }
  const rows = await listHeldFanslySendGuards(db, { expiredOnly: !input.includeUnexpired });
  const outcomes: Array<{ pageId: number; pageLabel: string | null; holderHost: string | null; released: boolean }> = [];
  for (const row of rows) {
    if (row.holderToken === null || row.holderHost === null || running.has(row.holderHost)) continue;
    // A live lease is released only for a capture older than the listing.
    if (!row.leaseExpired && !(capturedBefore && row.capturedAt && row.capturedAt < capturedBefore)) continue;
    const released = input.dryRun
      ? false
      : await confirmFanslySendGuardTerminated(db, {
        pageId: row.pageId,
        token: row.holderToken,
        evidence: `host_not_running; confirmed by ${input.confirmer}`,
        requireExpiredLease: row.leaseExpired,
      });
    outcomes.push({ pageId: row.pageId, pageLabel: row.pageLabel, holderHost: row.holderHost, released });
  }
  return outcomes;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `fansly-send-guard confirm-terminated --holder-token <uuid>`: an operator's
 * Docker-level confirmation of ONE holder (its token from `status`) that no
 * automatic rule can prove gone — e.g. its container restarted under the same
 * hostname but runs no sweeper, or its hostname is not its container's id. The
 * operator has checked that the holder's process is gone: its container is
 * gone, or started again after the holder's `captured_at`
 * (`docker inspect -f '{{.State.StartedAt}}' <container>`). Only a holder past
 * its lease is released; `dryRun` checks without writing.
 */
export async function confirmFanslySendGuardHolderTerminated(
  db: Database,
  input: { token: string; confirmer: string; dryRun: boolean },
): Promise<{ pageId: number; pageLabel: string | null; holderHost: string | null; released: boolean }> {
  const token = input.token.trim().toLowerCase();
  if (!UUID_PATTERN.test(token)) {
    throw new Error(`--holder-token expects a holder token (a uuid) from \`fansly-send-guard status\`, received "${input.token}"`);
  }
  const rows = await listHeldFanslySendGuards(db, { expiredOnly: false });
  const row = rows.find((candidate) => candidate.holderToken === token);
  if (!row) {
    throw new Error(`No Fansly page is held by token ${token}; it completed or was released already`);
  }
  if (!row.leaseExpired) {
    throw new Error(
      `The lease of token ${token} runs until ${row.leaseUntil?.toISOString() ?? "?"}; `
      + "a holder is released by token only past its lease",
    );
  }
  const released = input.dryRun
    ? false
    : await confirmFanslySendGuardTerminated(db, {
      pageId: row.pageId,
      token,
      evidence: `operator_confirmed_holder; confirmed by ${input.confirmer}`,
      requireExpiredLease: true,
    });
  return { pageId: row.pageId, pageLabel: row.pageLabel, holderHost: row.holderHost, released };
}
