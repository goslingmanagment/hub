import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { Database } from "@agency_hub_core/db";
import type {
  FanslySendCheck,
  FanslySendRefusalReason,
  FanslyWireOutcome,
  FanslyWireRequest,
} from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig } from "../../services/effective-config.ts";

// The ports of the Fansly Sync Engine (design §3.2): everything the engine
// needs from the outside world, as interfaces, so the pacer, the scheduler and
// the actor run the same code against the real process and against the fakes
// of the tests (fake clock, seeded RNG, counting transport). The production
// implementations that are a few lines each live here too; the ones with
// state (the ownership session, LISTEN wake, alerts) live with the host.

// ── time and chance ─────────────────────────────────────────────────────────

export interface Clock {
  /** Monotonic milliseconds (`performance.now()`): every pace decision. */
  monoNow(): number;
  /** Wall clock, for the journal (`sync_attempts.sent_at`) and status only. */
  wallNow(): Date;
  /** Sleep `ms`; rejects with the signal's reason when it aborts. May resolve
   *  early (timers do): callers re-check their condition after every sleep. */
  sleep(ms: number, signal?: AbortSignal | null): Promise<void>;
}

/** Uniform in [0, 1). Injectable: tests seed it. */
export interface Rng {
  next(): number;
}

export const systemClock: Clock = {
  monoNow: () => performance.now(),
  wallNow: () => new Date(),
  async sleep(ms, signal) {
    if (!(ms > 0)) {
      signal?.throwIfAborted();
      return;
    }
    try {
      await delay(ms, undefined, signal ? { signal } : undefined);
    } catch (error) {
      // node:timers wraps the reason in an AbortError; keep the caller's.
      signal?.throwIfAborted();
      throw error;
    }
  },
};

const RNG_RESOLUTION = 2 ** 31;

/** Production jitter source (design §3.3): `crypto.randomInt`-backed, uniform
 *  on a 2^-31 grid of [0, 1). */
export const cryptoRng: Rng = {
  next: () => randomInt(0, RNG_RESOLUTION) / RNG_RESOLUTION,
};

// ── the pause setting (I4) ──────────────────────────────────────────────────

/** The owner's "Пауза между запросами Fansly" (`fanslyDefaultDelayMs`), read
 *  fresh on every call. Throws when it cannot be read: no admission then. */
export interface PauseSource {
  readSettingMs(): Promise<number>;
}

/**
 * The step-1 send guard's reader, so both engines always pace by the same S:
 * one `getConfigOverrides` read layered over the boot config. An override
 * that fails validation is skipped (the env value stays); a database error
 * throws, which closes admission until the next read succeeds.
 */
export function createEffectiveConfigPauseSource(db: Database, rawConfig: AppConfig): PauseSource {
  return {
    async readSettingMs() {
      return (await loadEffectiveConfig(db, rawConfig)).fanslyDefaultDelayMs;
    },
  };
}

// ── the live settings resources read ────────────────────────────────────────

/** The live effective config a resource reads at a step (a re-walk cycle, …):
 *  the same overlay the pause comes from, read fresh on every call. */
export interface SettingsSource {
  read(): Promise<AppConfig>;
}

export function createEffectiveConfigSettingsSource(db: Database, rawConfig: AppConfig): SettingsSource {
  return {
    read: () => loadEffectiveConfig(db, rawConfig),
  };
}

// ── wake and ownership ──────────────────────────────────────────────────────

export interface Wake {
  /** Resolve on a `fansly_sync_work` NOTIFY for the page, or after `ms`
   *  (actors re-read at least once a second, so a lost NOTIFY costs ≤ 1 s). */
  wait(pageId: number, ms: number, signal: AbortSignal): Promise<"notified" | "timeout">;
}

/** The host's dedicated lock session (one `pg.Client` holds every page lock
 *  of the process: advisory lock `(58215, pageId)`). */
export interface OwnershipSession {
  /** False after the client emitted `error` or `end` (a synchronous flag, read
   *  by the send check right before the headers are written). */
  alive(): boolean;
  /** `select 1` on the lock session; one in flight per host, a result younger
   *  than 1 s is shared by all actors. A timeout is NOT ownership loss: it
   *  only skips the admission that asked (design §3.5). */
  ping(timeoutMs: number): Promise<"ok" | "timeout">;
  /** `pg_locks` re-check after a ping timeout. */
  stillHolds(pageId: number): Promise<boolean>;
  /** `pg_try_advisory_lock(58215, pageId)`. */
  tryLock(pageId: number): Promise<boolean>;
  unlock(pageId: number): Promise<void>;
}

// ── alerts and metrics ──────────────────────────────────────────────────────

/** The five alerts of plan §10 as subKeys of the one incident kind
 *  `fansly_sync_engine` (design §9.6). */
export const SYNC_ALERT_SUB_KEYS = ["page_stopped", "live_degraded", "freshness", "stuck", "process"] as const;
export type SyncAlertSubKey = (typeof SYNC_ALERT_SUB_KEYS)[number];

export interface SyncAlertKey {
  subKey: SyncAlertSubKey;
  /** Null for the process-wide alert 5. */
  pageId: number | null;
}

export interface SyncAlertInput extends SyncAlertKey {
  /** Why, from a closed per-subKey vocabulary (`rate_limit`, `pace_violation`,
   *  `quarantined`, `handover_stuck`, …). */
  detail: string;
  /** A shadow page's alert is a metric, never a page (design §3.12, D14). */
  shadow: boolean;
  context?: Readonly<Record<string, unknown>>;
  /** When the condition happened (a pace violation's send); default: now. An
   *  occurrence older than the latch's last resolution reopens nothing. */
  occurredAt?: Date;
}

export interface AlertSink {
  open(input: SyncAlertInput): Promise<void>;
  resolve(input: SyncAlertKey): Promise<void>;
}

export type SyncMetricLabels = Readonly<Record<string, string | number | boolean>>;

/** In-process counters of the engine (`not_implemented` resources, pacer
 *  refusals, shadow alerts …). The golden signals of design §9.5 are computed
 *  from the database, not from these. */
export interface Metrics {
  increment(name: string, labels?: SyncMetricLabels, by?: number): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
};

// ── transport ───────────────────────────────────────────────────────────────

/**
 * Why a send check refused a dispatch: the step-1 send-guard vocabulary
 * (`packages/fansly/src/send-guard.ts`), which the engine extends with `pace`
 * and `takeover_floor`. `lease_used` = a second physical request of one
 * admission; `lease_inactive` = ownership lost or the process is stopping.
 */
export type SendRefusal = FanslySendRefusalReason;

/** The hooks of one admission. `check` is synchronous and runs at undici's
 *  `onRequestStart`, immediately before the request headers are written; a
 *  non-null result aborts the dispatch and writes nothing. */
export interface SendHooks {
  check: FanslySendCheck;
}

/** What one physical request came to. The wire outcomes are the wire layer's
 *  (`sendFanslyWireRequest`); `shadow` is the shadow transport's, which sends
 *  nothing and only simulates the latency. */
export type TransportOutcome =
  | FanslyWireOutcome
  | { kind: "shadow"; simulatedLatencyMs: number };

/** Implemented by `fansly/transport.ts` (live, built only by the live loop)
 *  and `engine/shadow.ts`. One call = at most one physical request. */
export interface Transport {
  send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome>;
}

/**
 * A request its transport cannot build at all, whatever the moment: the work
 * carries no secret to send it with, or its URL names a host the engine never
 * sends to. Thrown by `PageTransport.prepare` BEFORE anything is admitted; the
 * actor closes the work without a request, `result` as its answer (a retry
 * would meet the same refusal).
 */
/** The page's stored credentials are not the ones the engine verified (or it
 *  verified none yet): the live transport refuses every request but the
 *  identity checks (`account.verify`, `account.identity`) before its
 *  admission, and the actor asks for one `account.verify` (step-3 §3.5 item
 *  3, G1/G2). */
export class CredentialsGenerationChangedError extends Error {
  constructor(
    readonly pageId: number,
    /** The digest of the credentials stored now. */
    readonly storedGeneration: string,
    /** The digest the engine verified last (null: none yet). */
    readonly verifiedGeneration: string | null,
  ) {
    super(
      verifiedGeneration === null
        ? `Fansly sync page ${pageId}: the stored credentials were not verified by the engine yet`
        : `Fansly sync page ${pageId}: the stored credentials changed since the last identity check`,
    );
    this.name = "CredentialsGenerationChangedError";
  }
}

export class UnsendableRequestError extends Error {
  constructor(readonly reason: string, readonly result: unknown = { failure: reason }) {
    super(`Fansly sync request cannot be sent: ${reason}`);
    this.name = "UnsendableRequestError";
  }
}

/** The box of `sync_work.secret_params` (design J7): a signed CDN URL, a
 *  candidate identity — sealed with the app's key, the box of the page
 *  credentials. The `sync` process holds one; an apply that learns a work's
 *  next secret (a redirect's URL) seals it with it. Only the live transport
 *  opens a secret (`decryptSyncWorkSecret`). */
export interface SecretBox {
  seal(value: unknown): string;
}

// ── the page's socket (step 3) ──────────────────────────────────────────────

/** Where the page's WebSocket owner is (design S3-03 `FanslyWsSource`):
 *  `owning` — it holds the socket lock `(58213, page)` and has no socket yet;
 *  `down` — its socket closed; `blocked_generation` — the platform refused the
 *  session's auth frame and nothing reconnects until the credentials change. */
export type WsSourceState = "idle" | "owning" | "connecting" | "open" | "down" | "blocked_generation" | "stopped";

/**
 * The page's WebSocket owner as the engine sees it on a live page (design
 * S3-03/S3-04): `ws.connect` plans by its state, and the live transport sends
 * an admitted `ws.upgrade` through its handshake — the one physical Upgrade,
 * whose send check is the admission's (I1–I3). The socket's frames are not
 * requests.
 */
export interface LivePageSocket {
  readonly state: WsSourceState;
  /** The reconnect ladder's earliest instant for the next Upgrade (null or
   *  absent: now). The `ws.connect` demand carries it as its due time; a plan
   *  that finds its row due earlier (a refused admission reopens a row at
   *  once, a merged demand pulls it forward) waits until then. */
  readonly connectNotBefore?: Date | null;
  /** The Upgrade of one admitted `ws.upgrade` step: `hooks.check` runs at
   *  undici's `onRequestStart`; resolves when the handshake settles (101 or
   *  another status, an error, a refusal). Never throws for an outcome. */
  handshake(hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome>;
}

/** The live page's socket owner now, or null (none in this process). */
export type LivePageSocketRef = () => LivePageSocket | null;
