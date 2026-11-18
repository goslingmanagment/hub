import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { Database, SyncAttemptRow, SyncWorkRow } from "@agency_hub_core/db";
import type {
  FanslySendCheck,
  FanslyWireOutcome,
  FanslyWireId,
  FanslyWireRequest,
  FanslyWritePermission,
} from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import { loadEffectiveConfig, loadEffectiveConfigField } from "../../services/effective-config.ts";
import type { RequestPlan } from "./resource.ts";

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
 * one read of its `config_settings` row layered over the boot config. An override
 * that fails validation is skipped (the env value stays); a database error
 * throws, which closes admission until the next read succeeds.
 */
export function createEffectiveConfigPauseSource(db: Database, rawConfig: AppConfig): PauseSource {
  return {
    async readSettingMs() {
      return loadEffectiveConfigField(db, rawConfig, "fanslyDefaultDelayMs");
    },
  };
}

// ── the live settings resources read ────────────────────────────────────────

/** The live effective config a resource reads at a step (a re-walk cycle, …):
 *  the same overlay the pause comes from, read fresh on every call. */
export interface SettingsSource {
  /** One live field, read fresh through its own `config_settings` row; throws
   *  when it cannot be read. */
  field<K extends keyof AppConfig & string>(key: K): Promise<AppConfig[K]>;
  /** The whole scope, for a step that also needs a field that is not live
   *  (the write module's derive: the switch and the files' root). */
  read(): Promise<AppConfig>;
}

export function createEffectiveConfigSettingsSource(db: Database, rawConfig: AppConfig): SettingsSource {
  return {
    field: (key) => loadEffectiveConfigField(db, rawConfig, key),
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
 *  `fansly_sync_engine` (design §9.6), and a route's own incident (step 3b
 *  D5: a 429 holds one route of a page; one latch per page+route). */
export const SYNC_ALERT_SUB_KEYS = ["page_stopped", "live_degraded", "freshness", "stuck", "process", "route_limited"] as const;
export type SyncAlertSubKey = (typeof SYNC_ALERT_SUB_KEYS)[number];

export interface SyncAlertKey {
  subKey: SyncAlertSubKey;
  /** Null for the process-wide alert 5. */
  pageId: number | null;
  /** `route_limited` only: the canonical route (`fansly/routes.ts`). */
  route?: string;
}

export interface SyncAlertInput extends SyncAlertKey {
  /** Why, from a closed per-subKey vocabulary (`rate_limit`, `pace_violation`,
   *  `quarantined`, `handover_stuck`, …). */
  detail: string;
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
 *  refusals …). The golden signals of design §9.5 are computed from the
 *  database, not from these. */
export interface Metrics {
  increment(name: string, labels?: SyncMetricLabels, by?: number): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
};

// ── transport ───────────────────────────────────────────────────────────────

/** The hooks of one admission. `check` is synchronous and runs at undici's
 *  `onRequestStart`, immediately before the request headers are written; a
 *  non-null result aborts the dispatch and writes nothing. Passing it IS the
 *  send.
 *
 *  `grant` is the same check for a sender outside the process (a page's
 *  browser, Project Browser plan §3.2): every condition of `check`, asked
 *  synchronously right before the sender is told it may send, but no send
 *  mark — the sender may still not send (a session that changed, a deadline
 *  passed on its side), and the send counts at the instant it reports
 *  (`transport_reported`) or at the completion. A transport asks one of the
 *  two, once per admission: a second ask is refused (`lease_used`). */
export interface SendHooks {
  check: FanslySendCheck;
  grant: FanslySendCheck;
  /** A sender outside the process (a page's browser) tells when it let the
   *  request go after its own sight of the page's quiet (plan-b Б12), on
   *  the engine's monotonic clock. */
  released?: (mono: number) => void;
  /** A write (wall posts PR 7): asked by a sender outside the process right
   *  before `grant` — whether the command it was admitted for, its approval
   *  and the page's publishing still stand, read fresh. Null: they do; else
   *  why not, and nothing is granted. Absent: no write is granted. */
  confirmWrite?: () => Promise<string | null>;
}

/**
 * What a transport knows of the admission it sends under (Project Browser,
 * plan §3.2): a sender outside the process is told the attempt, the owner it
 * belongs to and the deadline it must send by, and refuses a request of an
 * earlier owner or past that deadline on its own side too.
 */
export interface SendAdmission {
  /** `sync_attempts.id`: the sender keeps its outcome under it. */
  attemptId: number;
  /** The page's owner generation (`sync_pages.owner_generation`). */
  ownerGeneration: bigint;
  /** When the admission was issued (taken before its transaction), on the
   *  engine's monotonic clock (`Clock.monoNow`). */
  issuedMono: number;
  /** The absolute deadline of the send (issue + `SEND_WINDOW_MS`), on the
   *  engine's monotonic clock — never a remainder. `Clock.monoNow` is the
   *  kernel's CLOCK_MONOTONIC shifted by a constant (`performance.now()`), so
   *  a transport that hands it to another process converts it by that one
   *  shift (`services/egress/page-browser-rpc.ts` `kernelMonoBridge`). */
  sendDeadlineMono: number;
  /** The admission's pause (S × (1 + u)): a sender outside the process keeps
   *  it by its own sight of the page's sends before it lets the request go
   *  (plan-b Б12). Absent: nothing to keep there. */
  pauseMs?: number;
}

/** What one physical request came to: the wire layer's outcomes
 *  (`sendFanslyWireRequest`). */
export type TransportOutcome = FanslyWireOutcome;

/** Builds the request of a plan and sends it — the actor's view of a page's
 *  transport. Implemented by `fansly/transport.ts`, built only by the host's
 *  live loop. */
export interface PageTransport {
  /** The request of one plan, built right before its admission; `context`
   *  names the work it is for (a CDN hop reads the work's secret URL). Throws
   *  `UnsendableRequestError` for a request that can never be sent, and
   *  `PageTransportUnavailableError` while the transport cannot take one now
   *  (nothing is admitted either way). */
  prepare(request: RequestPlan, context?: { work: SyncWorkRow }): Promise<FanslyWireRequest>;
  /** At most one physical request, under `admission`; the transport asks
   *  `hooks.check` (it writes the request itself) or `hooks.grant` (a sender
   *  outside the process writes it), never both. */
  send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal, admission: SendAdmission): Promise<TransportOutcome>;
  /** The outcome of `attemptId` is committed (captured, or settled as not
   *  sent): a sender that keeps outcomes until they are acknowledged (a
   *  page's browser keeps them on disk) may drop it now. Never throws. */
  settled?(attemptId: number): void;
  /** The outcomes the sender keeps until they are acknowledged (a page's
   *  browser keeps them on disk, plan §3.2 «Приём буфера и восстановление»):
   *  asked at the actor's start before its recovery closes anything
   *  `unknown`, and those nothing waits for taken every lap. Absent where the
   *  transport keeps none (undici): recovery is as it always was. */
  held?: HeldOutcomeSource;
  /** The digest of the page's stored credentials now (the session and the
   *  proxy; `readFanslyPageGeneration`), from a read-only snapshot. The actor
   *  compares it with the trusted digest (checks-only, G2) and with the
   *  latest refusal a credentials hold names (the verify it admits, A3).
   *  Absent where the transport stores none. */
  storedCredentialsGeneration?(): Promise<string | null>;
  /** Whether this sender takes a write of this permission now (wall posts
   *  PR 6, spec §2.2): a page's browser whose operator said at hello that it
   *  takes writes and holds the permission the engine set (PR 7). Absent
   *  (Node) or false: no write is planned for it — the write's plan waits,
   *  and `prepare` refuses one before anything is admitted. */
  canWrite?(permission: FanslyWritePermission, spec?: FanslyWireId): boolean;
  /** How many upload parts this sender takes at once beside the page's
   *  managed request, outside its pause (vault packs, 0347: a part goes to
   *  the storage, not Fansly) — the actor's storage lane sends up to that
   *  many (engine/part-lane.ts). 0 or absent: a part goes in the page's turn,
   *  one at a time, under the pacer. */
  parallelParts?(): number;
  /** A newly loaded browser must witness an engine identity read in this
   *  Chrome start even when its saved session's digest is already trusted.
   *  Absent: a test's stand-in; never grants permission around a page/route
   *  hold. */
  needsSessionConfirmation?(): boolean;
  close(): Promise<void>;
}

// ── outcomes a sender keeps (Project Browser, plan §3.2; PR 13) ────────────

/** What a sender that keeps outcomes until they are acknowledged holds of
 *  one attempt (`HeldOutcomeSource`). Taking it is never a permission to
 *  send anything again: it is the outcome of a request that was sent (or
 *  was not), and only that is committed. */
export type HeldAnswer =
  /** It never left, by the sender's own record: closed as not sent. */
  | { kind: "not_sent"; attemptId: number }
  /** Nothing tells whether it left: `unknown`, as without such a sender. */
  | { kind: "unknown"; attemptId: number }
  /** An engine request's outcome, as `send` would have returned it for the
   *  attempt's row. */
  | { kind: "request"; attemptId: number; resolve(attempt: SyncAttemptRow): Promise<HeldRequestOutcome> };

export interface HeldRequestOutcome {
  outcome: TransportOutcome;
  /** The answer came under the session the request was prepared for. One
   *  of another session is never the attempt's answer (plan §3.2). */
  sameSession: boolean;
  /** Everything it carried arrived (its body whole). */
  whole: boolean;
  /** When the sender reported it left, on the wall clock (null: not
   *  reported). */
  sentWall: Date | null;
}

export interface HeldOutcomeSource {
  /** What the sender holds of these attempts, its outcomes resent on the way
   *  (waiting at most `waitMs` for it to be reachable). Null: it could not
   *  be asked — they are `unknown`, as without it. */
  recover(attemptIds: readonly number[], waitMs: number): Promise<Map<number, HeldAnswer> | null>;
  /** At most `max` of the outcomes delivered that nothing waited for (after
   *  a restart, another session's answer, a reply a lost COMMIT
   *  acknowledgement left unapplied), taken out of the sender's queue. */
  takeLate(max: number): HeldAnswer[];
  /** The sender still holds the outcomes of these attempts but nothing here
   *  keeps them now (a commit that failed): asked for again (`recover`) —
   *  the sender does not deliver an outcome twice on one connection. */
  retry(attemptIds: readonly number[]): void;
  /** What the outcome carried is committed: the sender may drop it. */
  acknowledge(attemptId: number): void;
}

/**
 * A request its transport cannot build at all, whatever the moment: the work
 * carries no secret to send it with, or its URL names a host the engine never
 * sends to. Thrown by `PageTransport.prepare` BEFORE anything is admitted; the
 * actor closes the work without a request, `result` as its answer (a retry
 * would meet the same refusal).
 */
/** The page's credentials are not the ones the engine verified (or it
 *  verified none yet): the live transport refuses every request but the
 *  identity check (`account.verify`) before its admission, and the actor asks for one `account.verify` (step-3 §3.5 item
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

/** The transport cannot take a request now (a page's browser: no link to its
 *  operator, the operator not ready, a backoff after it could not take one):
 *  thrown by `prepare` before anything is admitted. Not the platform's
 *  failure — no network hold, no breaker: the actor waits and asks again. */
export class PageTransportUnavailableError extends Error {
  constructor(readonly reason: string, readonly retryInMs: number, readonly code: "unavailable" | "session_unknown" = "unavailable") {
    super(`The page transport cannot take a request now: ${reason}`);
    this.name = "PageTransportUnavailableError";
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

/** Where a browser page's socket is (`ws/browser-source.ts`): `open` while
 *  the site's connection is open, `idle` otherwise, `stopped` with its slot. */
export type WsSourceState = "idle" | "open" | "stopped";


// ── a page's own site requests (Project Browser, plan §3.2, spec §3) ────────

/** How a site request ended, as its answer is committed (variant Б: an
 *  observed hop's end, `commitObservedSiteEnd`). `sentMono`: when it left,
 *  as the browser reported it, on the engine's monotonic clock (absent or
 *  null: not reported). */
export type SiteRequestEnd =
  | { kind: "response"; status: number; retryAfterMs: number | null; sentMono?: number | null }
  | { kind: "transport_error"; sent: boolean; message: string; sentMono?: number | null }
  | { kind: "aborted_before_send"; reason: string };

/** The page browser's side of the site path: what it tells of the site's
 *  own traffic. Absent on a page without a browser: nothing of the site path
 *  runs there. */
export interface SiteAdmissionPort {
  /** Variant Б (protocol minor 4): what the page's browser tells of the
   *  site's own traffic it let go — observed, never admitted. One listener;
   *  null removes it. */
  onObserved(listener: ((event: SiteObservation) => void) | null): void;
}

/** One hop of an observed site request, as the engine takes it once: the
 *  operator's key (minted when it first followed the request, the same over
 *  its redirects) and the hop under it. */
export interface ObservedSiteKey {
  requestKey: string;
  hop: number;
}

/** One fact of the site's own traffic, observed (variant Б), on the engine's
 *  clocks: its hop (`key`), and what to call once it is committed (`ack` —
 *  the operator keeps it until then and tells it again). */
export type SiteObservation = { key: ObservedSiteKey; ack: () => void } & (
  | {
    kind: "sent";
    id: string;
    method: string;
    host: string;
    path: string;
    route: string;
    sessionFingerprint: string | null;
    /** The send, monotonic — rounded late: the pause never runs from before it. */
    sentMono: number;
    sentWall: Date;
  }
  | {
    kind: "ended";
    id: string;
    status: number | null;
    retryAfterMs: number | null;
    error: string | null;
  }
);
