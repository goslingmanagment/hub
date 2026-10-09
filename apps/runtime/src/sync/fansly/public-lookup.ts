import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  applyFanslyPublicLookupAnswer,
  completeFanslySendAttempt,
  FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS,
  FANSLY_PUBLIC_LOOKUP_SEND_SOURCE,
  insertObservation,
  journalUnpacedFanslySend,
  markFanslySendAttemptSent,
  pickFanslyPublicLookupBatch,
  readFanslyPublicEgress,
  readFanslyPublicLookupClocks,
  readFanslyPublicLookupState,
  stopFanslyPublicLookup,
  type Database,
  type FanslyPublicLookupApplyResult,
  type FanslyPublicLookupClocks,
  type FanslyPublicLookupStopReason,
  type FanslySendHolderIdentity,
} from "@agency_hub_core/db";
import {
  buildFanslyPublicWireRequest,
  FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND,
  FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS,
  FanslyCredentialsRefusedError,
  fanslyPublicWireSpec,
  readFanslyWireResponse,
  sendFanslyWireRequest,
  type FanslyAccount,
  type FanslyPublicWireSpecFor,
  type FanslyWireOutcome,
  type FanslyWireRead,
} from "@agency_hub_core/fansly";
import type { EgressContext } from "@agency_hub_core/platform-core";
import { parseRetryAfterInstant, sanitizeError, type AppConfig } from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import { loadEffectiveConfig } from "../../services/effective-config.ts";
import { FanslyPublicEgressUnavailableError, isFanslyPublicOrigin } from "../../services/egress/fansly-public.ts";
import { resolveEgress } from "../../services/egress/resolver.ts";
import {
  buildFanslySendHolderIdentity,
  createDefaultFanslySendOsProbe,
} from "../../services/fansly-send-guard/os-probe.ts";
import {
  notifySyncEngineIncident,
  resolveSyncEngineIncident,
  SYNC_ENGINE_PUBLIC_LOOKUP_SUBKEY,
} from "../../services/notification-incidents.ts";
import type { SyncLogger } from "../engine/commit.ts";
import { REQUEST_TIMEOUT_MS } from "../engine/pacer.ts";
import { replaceJournalLoneSurrogates } from "./lib/journal-lone-surrogates.ts";

// The session-less public Fansly account reader (arena "vanished chat" R5,
// plan §7; owner decisions Р1 «да, через прокси», Р2 (а), Р3 (а)). One reader
// for the whole host, in the `sync` process beside the page actors, never one
// of them:
//
//   - WHAT: `GET /account?ids=` WITHOUT any session — the request the public
//     builder makes (`buildFanslyPublicWireRequest`: a `credentials: none`
//     spec, no session, no cookie; a session-bearing spec is refused before
//     anything is built) — through the reader's own egress (`fansly_public`:
//     its own proxy, never a page's, Fansly's API host only). An account it
//     returns exists; one it omits is not served to anybody.
//   - WHEN: enabled by the owner (`fanslyPublicLookupEnabled`, off by
//     default), with its proxy configured; one request in flight across every
//     process (advisory lock (58216, 1) for the whole pass); at least
//     S × (1 + u) between its own requests (S the owner's Fansly pause, u ∈
//     [0, 0.2) drawn after each), and a budget of 1 a minute and 50 a day
//     counted from its own journal. No page's budget is touched: it journals
//     with `page_id` null and holds no page.
//   - WHOM: the owner's one-off queue (`recheck-marks`: the legacy deleted
//     marks), the partner of an established unavailability episode, a fan a
//     page's lookup missed (`page_fans.account_probe_resolved = false`) — the
//     last two when never checked or checked over 7 days ago. One id once,
//     however many pages name it; up to `fanslyPublicLookupBatchSize` (≤ 100)
//     ids a request.
//   - JOURNAL BEFORE PARSE: `fansly_send_log` (source `public_lookup`,
//     `page_id` null) before the send and completed after it; the raw answer
//     in `observations` (`account_id` null, kind `account_lookup_public`, or
//     `:failed` for a body that is not a successful envelope) committed before
//     the contract reads it — the contract of PAGELESS_FAN_OBSERVATION_KINDS
//     (services/erasure/index.ts): every asked id in `requestedIds`, the
//     answer as JSON, no catalog copy. Then the answer is applied: every asked
//     fan gets `public_checked_at`/`public_found`; a found account loses the
//     legacy deleted mark (Р2 (а)); a missing one keeps it, and none is set.
//   - STOP: the first 429, 401/403, network failure (sent or not) or answer
//     off the contract stops the reader with an owner incident (a global
//     latch, `fansly_sync_engine` / `public_lookup`); a Retry-After is kept
//     and honoured; no session and no other egress is ever tried; only the
//     owner's `sync public-lookup resume` resumes it. A failure changes no
//     fan's data. If it is the very first batch the reader ever sent, the
//     incident says so.

/** The reader's advisory lock `(58216, 1)`: one pass — one request — at a
 *  time across every process (58211–58215 are taken). */
export const PUBLIC_LOOKUP_LOCK_NAMESPACE = 58_216;
export const PUBLIC_LOOKUP_LOCK_KEY = 1;

/** Its budget: one request a minute, fifty a day (rolling 24 hours). This is
 *  the hub's budget, not a known Fansly limit. */
export const PUBLIC_LOOKUP_MINUTE_MS = 60_000;
export const PUBLIC_LOOKUP_DAY_BUDGET = 50;
export const PUBLIC_LOOKUP_DAY_MS = 24 * 60 * 60_000;
/** The jitter u of its pause S × (1 + u): u ∈ [0, 0.2), as a page's. */
export const PUBLIC_LOOKUP_JITTER_MAX = 0.2;
/** A journaled attempt without a completion counts as in flight this long
 *  (the request's budget and a margin), then at that upper bound. */
export const PUBLIC_LOOKUP_IN_FLIGHT_BOUND_MS = REQUEST_TIMEOUT_MS + 10_000;
/** How often an idle, disabled or stopped reader looks again. */
export const PUBLIC_LOOKUP_POLL_MS = 30_000;
/** A failed answer's body is journaled up to this many characters. */
const FAILED_BODY_MAX_CHARS = 64 * 1024;
const DETAIL_MAX_CHARS = 300;

export type PublicLookupWaitReason = "in_flight" | "minute_budget" | "pace" | "day_budget" | "retry_after";

/**
 * When the reader may send next, and what holds it: the latest of — an
 * attempt still in flight, the minute budget (the newest capture + 1 min),
 * the pause (the newest completion + S × (1 + u)), the day budget (the oldest
 * of 50 attempts in 24 h + 24 h) and a Retry-After. `why` null: now.
 */
export function publicLookupNextSendAt(input: {
  now: Date;
  clocks: FanslyPublicLookupClocks;
  settingMs: number;
  u: number;
  retryNotBefore: Date | null;
}): { at: Date; why: PublicLookupWaitReason | null } {
  const { clocks } = input;
  const holds: Array<{ at: number; why: PublicLookupWaitReason }> = [];
  if (clocks.inFlightSince !== null) {
    holds.push({ at: clocks.inFlightSince.getTime() + PUBLIC_LOOKUP_IN_FLIGHT_BOUND_MS, why: "in_flight" });
  }
  if (clocks.lastCapturedAt !== null) {
    holds.push({ at: clocks.lastCapturedAt.getTime() + PUBLIC_LOOKUP_MINUTE_MS, why: "minute_budget" });
  }
  if (clocks.lastCompletedAt !== null) {
    holds.push({ at: clocks.lastCompletedAt.getTime() + Math.ceil(input.settingMs * (1 + input.u)), why: "pace" });
  }
  if (clocks.sentLastDay >= PUBLIC_LOOKUP_DAY_BUDGET && clocks.oldestLastDay !== null) {
    holds.push({ at: clocks.oldestLastDay.getTime() + PUBLIC_LOOKUP_DAY_MS, why: "day_budget" });
  }
  if (input.retryNotBefore !== null) {
    holds.push({ at: input.retryNotBefore.getTime(), why: "retry_after" });
  }
  const latest = holds.reduce<{ at: number; why: PublicLookupWaitReason } | null>(
    (max, hold) => (max === null || hold.at > max.at ? hold : max),
    null,
  );
  return latest === null || latest.at <= input.now.getTime()
    ? { at: input.now, why: null }
    : { at: new Date(latest.at), why: latest.why };
}

/** A failure that stops the reader. */
export interface PublicLookupFailure {
  reason: FanslyPublicLookupStopReason;
  httpStatus: number | null;
  detail: string;
  retryNotBefore: Date | null;
}

/** What one send's outcome means, read against the request: the accounts it
 *  found, nothing at all (never sent), or the failure that stops the reader. */
export type PublicLookupVerdict =
  | { kind: "answer"; foundIds: string[] }
  | { kind: "unsent" }
  | { kind: "failure"; failure: PublicLookupFailure };

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > DETAIL_MAX_CHARS ? `${single.slice(0, DETAIL_MAX_CHARS - 1)}…` : single;
}

/**
 * The verdict of one outcome (`read`: the wire layer's reading of a response,
 * taken after the journal). An answer must be a successful envelope whose
 * accounts all carry an id that was asked for; anything else is a failure:
 * 429 → `rate_limited`, 401/403 → `auth_refused`, a transport error or
 * timeout → `network`, every other status or body → `off_contract`. A
 * Retry-After of any failed answer is kept.
 */
export function publicLookupVerdict(
  outcome: FanslyWireOutcome,
  read: FanslyWireRead<FanslyAccount[]> | null,
  requestedIds: readonly string[],
  now: Date,
): PublicLookupVerdict {
  if (outcome.kind === "aborted_before_send") return { kind: "unsent" };
  if (outcome.kind !== "response") {
    return {
      kind: "failure",
      failure: {
        reason: "network",
        httpStatus: null,
        detail: clip(`${outcome.kind}${outcome.sent ? " after the request was sent" : " before the request was sent"}: ${outcome.message}`),
        retryNotBefore: null,
      },
    };
  }
  if (read === null) {
    return {
      kind: "failure",
      failure: { reason: "off_contract", httpStatus: outcome.status, detail: "the answer was not read", retryNotBefore: null },
    };
  }
  const retryAfter = read.kind === "http_error" ? parseRetryAfterInstant(read.retryAfter, now.getTime()) : null;
  switch (read.kind) {
    case "accepted": {
      const asked = new Set(requestedIds);
      const stray = read.value.map((account) => account.id).filter((id) => !asked.has(id));
      if (stray.length > 0) {
        return {
          kind: "failure",
          failure: {
            reason: "off_contract",
            httpStatus: read.status,
            detail: `the answer names ${stray.length} account(s) that were not asked for`,
            retryNotBefore: null,
          },
        };
      }
      return { kind: "answer", foundIds: [...new Set(read.value.map((account) => account.id))] };
    }
    case "contract_violation":
      return {
        kind: "failure",
        failure: {
          reason: "off_contract",
          httpStatus: read.status,
          detail: clip(`${read.violation.field}: ${read.violation.detail}`),
          retryNotBefore: null,
        },
      };
    case "envelope_unsuccessful":
      return {
        kind: "failure",
        failure: {
          reason: "off_contract",
          httpStatus: read.status,
          detail: clip(`HTTP ${read.status} without a successful envelope${read.envelope?.error?.details ? `: ${read.envelope.error.details}` : ""}`),
          retryNotBefore: null,
        },
      };
    case "http_error": {
      const reason: FanslyPublicLookupStopReason = read.status === 429
        ? "rate_limited"
        : read.status === 401 || read.status === 403 ? "auth_refused" : "off_contract";
      const details = read.envelope?.error?.details ?? read.envelope?.error?.message;
      return {
        kind: "failure",
        failure: {
          reason,
          httpStatus: read.status,
          detail: clip(`HTTP ${read.status}${details ? `: ${details}` : ""}`),
          retryNotBefore: retryAfter,
        },
      };
    }
  }
}

/** The incident the reader opens when it stops (one line, ≤ 240 characters). */
export function publicLookupIncidentSummary(input: {
  failure: PublicLookupFailure;
  firstBatch: boolean;
  ids: number;
}): string {
  const status = input.failure.httpStatus === null ? "" : ` (HTTP ${input.failure.httpStatus})`;
  const first = input.firstBatch ? ` on its FIRST batch (${input.ids} ids): decide before resuming` : ` (${input.ids} ids)`;
  const retry = input.failure.retryNotBefore === null ? "" : `; Retry-After ${input.failure.retryNotBefore.toISOString()}`;
  return `Public account reader stopped: ${input.failure.reason}${status}${first}${retry}. No fan changed. `
    + "Resume: sync public-lookup resume.";
}

/** The owner incident port (the global `public_lookup` latch). */
export interface PublicLookupIncidents {
  open(input: { reason: FanslyPublicLookupStopReason; summary: string; at: Date }): Promise<void>;
  resolve(input: { at: Date }): Promise<void>;
}

export function publicLookupIncidents(app: { db: Database; logger: SyncLogger }): PublicLookupIncidents {
  return {
    async open(input) {
      await notifySyncEngineIncident(app, {
        subKey: SYNC_ENGINE_PUBLIC_LOOKUP_SUBKEY,
        pageId: null,
        pageLabel: null,
        detail: input.reason,
        errorSummary: input.summary,
        occurredAt: input.at,
      });
    },
    async resolve(input) {
      await resolveSyncEngineIncident(app, {
        subKey: SYNC_ENGINE_PUBLIC_LOOKUP_SUBKEY,
        pageId: null,
        pageLabel: null,
        recoveredAt: input.at,
      });
    },
  };
}

/** What one pass did. */
export type PublicLookupPass =
  | { kind: "disabled" }
  /** Another process holds the reader's lock (its pass is the one in flight). */
  | { kind: "busy" }
  | { kind: "stopped"; reason: FanslyPublicLookupStopReason | null }
  | { kind: "no_egress"; reason: string }
  | { kind: "wait"; until: Date; why: PublicLookupWaitReason }
  | { kind: "idle" }
  /** The builder refused the request: nothing was journaled or sent. */
  | { kind: "refused"; error: FanslyCredentialsRefusedError }
  /** Nothing left the process (the send was refused before its headers). */
  | { kind: "unsent"; ids: number }
  | { kind: "answered"; ids: number; observationId: number; applied: FanslyPublicLookupApplyResult }
  | { kind: "failed"; ids: number; failure: PublicLookupFailure; observationId: number | null; firstBatch: boolean };

type PublicSpec = FanslyPublicWireSpecFor<"accounts.public_by_ids">;

export type PublicLookupSend = (
  dispatcher: Dispatcher,
  request: { url: string; headers: Record<string, string>; timeoutMs: number },
  hooks: { check: () => null },
  signal: AbortSignal,
) => Promise<FanslyWireOutcome>;

export interface PublicLookupReaderDeps {
  db: Database;
  /** The pool the lock's session comes from. */
  pool: Pick<Pool, "connect">;
  /** The boot config (the base URL, the encryption keys of the proxy). */
  config: AppConfig;
  /** The live overlay's baseline: the switch, the batch and S are read live. */
  rawConfig: AppConfig;
  logger: SyncLogger;
  now?: () => Date;
  random?: () => number;
  /** The egress (default: the resolver's `fansly_public` scope). */
  openEgress?: () => Promise<EgressContext<Dispatcher>>;
  /** The one physical send (default: the wire layer's). Tests mock the network here. */
  send?: PublicLookupSend;
  /** The spec the reader builds its request from (default: the public lookup).
   *  Tests pass a session-bearing one to see it refused. */
  spec?: PublicSpec;
  incidents?: PublicLookupIncidents;
  holder?: FanslySendHolderIdentity;
  pollMs?: number;
}

/** The reader. `runOnce` is one pass (tests drive it); `start`/`stop` run it
 *  in the `sync` process. */
export class FanslyPublicLookupReader {
  readonly #d: PublicLookupReaderDeps;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #send: PublicLookupSend;
  readonly #spec: PublicSpec;
  readonly #incidents: PublicLookupIncidents;
  #holder: FanslySendHolderIdentity | null;
  /** u of the pause before the next request, drawn after each send. */
  #u: number;
  #stopping = false;
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(deps: PublicLookupReaderDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#random = deps.random ?? Math.random;
    this.#send = deps.send ?? ((dispatcher, request, hooks, signal) => sendFanslyWireRequest(dispatcher, request, hooks, signal));
    this.#spec = deps.spec ?? fanslyPublicWireSpec("accounts.public_by_ids");
    this.#incidents = deps.incidents ?? publicLookupIncidents(deps);
    this.#holder = deps.holder ?? null;
    this.#u = this.#drawU();
  }

  #drawU(): number {
    return Math.min(Math.max(this.#random(), 0), 0.999_999) * PUBLIC_LOOKUP_JITTER_MAX;
  }

  #holderIdentity(): FanslySendHolderIdentity {
    this.#holder ??= buildFanslySendHolderIdentity(createDefaultFanslySendOsProbe(), "sync");
    return this.#holder;
  }

  /** One pass under the reader's lock: at most one request. */
  async runOnce(): Promise<PublicLookupPass> {
    const effective = await loadEffectiveConfig(this.#d.db, this.#d.rawConfig);
    if (effective.fanslyPublicLookupEnabled !== true) return { kind: "disabled" };
    const client = await this.#d.pool.connect();
    // A session lock survives a release back to the pool: whenever the unlock
    // is not certain, the connection is destroyed so Postgres drops it.
    let destroy = false;
    try {
      let locked: boolean;
      try {
        const result = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock($1, $2) as locked",
          [PUBLIC_LOOKUP_LOCK_NAMESPACE, PUBLIC_LOOKUP_LOCK_KEY],
        );
        locked = result.rows[0]?.locked === true;
      } catch (error) {
        destroy = true;
        throw error;
      }
      if (!locked) return { kind: "busy" };
      try {
        return await this.#pass(effective);
      } finally {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>(
            "select pg_advisory_unlock($1, $2) as unlocked",
            [PUBLIC_LOOKUP_LOCK_NAMESPACE, PUBLIC_LOOKUP_LOCK_KEY],
          );
          destroy = unlocked.rows[0]?.unlocked !== true;
        } catch {
          destroy = true;
        }
      }
    } finally {
      client.release(destroy);
    }
  }

  async #pass(effective: AppConfig): Promise<PublicLookupPass> {
    const db = this.#d.db;
    const state = await readFanslyPublicLookupState(db);
    if (state.stoppedAt !== null) return { kind: "stopped", reason: state.stopReason };
    if (await readFanslyPublicEgress(db) === null) return { kind: "no_egress", reason: "not_configured" };

    const now = this.#now();
    const clocks = await readFanslyPublicLookupClocks(db, { now, inFlightBoundMs: PUBLIC_LOOKUP_IN_FLIGHT_BOUND_MS });
    const next = publicLookupNextSendAt({
      now,
      clocks,
      settingMs: effective.fanslyDefaultDelayMs,
      u: this.#u,
      retryNotBefore: state.retryNotBefore,
    });
    if (next.why !== null) return { kind: "wait", until: next.at, why: next.why };

    const limit = Math.min(Math.max(Math.trunc(effective.fanslyPublicLookupBatchSize ?? FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS), 1),
      FANSLY_PUBLIC_ACCOUNT_LOOKUP_MAX_IDS);
    const batch = await pickFanslyPublicLookupBatch(db, {
      limit,
      recheckBefore: new Date(now.getTime() - FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS),
    });
    if (batch.length === 0) return { kind: "idle" };
    const ids = batch.map((candidate) => candidate.platformUserId);
    const params = { ids };

    // Built before anything is journaled: a spec that carries a session is
    // refused here, and nothing is written or sent.
    let request: ReturnType<typeof buildFanslyPublicWireRequest>;
    try {
      request = buildFanslyPublicWireRequest(this.#spec, params, {
        baseUrl: this.#d.config.fanslyBaseUrl,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof FanslyCredentialsRefusedError) {
        this.#d.logger.error({ component: "fansly_public_lookup", err: error }, "Public lookup request refused before it was built");
        return { kind: "refused", error };
      }
      throw error;
    }
    if (!isFanslyPublicOrigin(new URL(request.url).origin)) {
      return { kind: "no_egress", reason: "base_url_not_fansly_api" };
    }

    let egress: EgressContext<Dispatcher>;
    try {
      egress = await (this.#d.openEgress ?? (() => resolveEgress(this.#d, { kind: "fansly_public" })))();
    } catch (error) {
      if (error instanceof FanslyPublicEgressUnavailableError) return { kind: "no_egress", reason: error.reason };
      throw error;
    }

    const token = randomUUID();
    const sent: { at: Date | null; offsetMs: number | null; marking: Promise<void> } = {
      at: null,
      offsetMs: null,
      marking: Promise.resolve(),
    };
    let outcome: FanslyWireOutcome;
    try {
      if (egress.dispatcher === null) {
        return { kind: "no_egress", reason: "no_dispatcher" };
      }
      await journalUnpacedFanslySend(db, {
        token,
        source: FANSLY_PUBLIC_LOOKUP_SEND_SOURCE,
        operation: this.#spec.legacyOperation,
        holder: this.#holderIdentity(),
      });
      const issuedAt = performance.now();
      outcome = await this.#send(egress.dispatcher, request, {
        check: () => {
          const at = new Date();
          const offsetMs = Math.max(0, Math.ceil(performance.now() - issuedAt));
          sent.at = at;
          sent.offsetMs = offsetMs;
          sent.marking = markFanslySendAttemptSent(db, { token, sentAt: at, sendOffsetMs: offsetMs }).catch((error: unknown) => {
            this.#d.logger.warn({ component: "fansly_public_lookup", err: error },
              "Public lookup could not record its send moment yet; the completion will");
          });
          return null;
        },
      }, new AbortController().signal);
    } finally {
      await egress.close().catch(() => undefined);
    }
    this.#u = this.#drawU();

    // The raw answer is committed before anything reads it (and before the
    // journal row is completed: the answer is the fact, the completion its
    // telemetry); the verdict is dated after that commit.
    let observationId: number | null = null;
    let unjournaled: unknown = null;
    if (outcome.kind === "response") {
      try {
        observationId = await this.#journal(token, ids, outcome);
      } catch (error) {
        unjournaled = error;
      }
    }
    await sent.marking;
    await completeFanslySendAttempt(db, {
      pageId: null,
      token,
      nextU: 0,
      outcome: outcome.kind,
      outcomeDetail: outcome.kind === "aborted_before_send" ? outcome.refusal : null,
      httpStatus: outcome.kind === "response" ? outcome.status : null,
      sentAt: sent.at,
      sendOffsetMs: sent.offsetMs,
    }).catch((error: unknown) => {
      this.#d.logger.warn({ component: "fansly_public_lookup", err: sanitizeError(error) },
        "Public lookup could not complete its journal row; it counts in flight until its upper bound");
    });
    const answeredAt = this.#now();
    if (outcome.kind === "response" && unjournaled !== null) {
      // An answer that is not journaled is never read: it changes no fan, and
      // the reader stops as for an answer off the contract (or by its status).
      const failure: PublicLookupFailure = {
        reason: outcome.status === 429 ? "rate_limited" : outcome.status === 401 || outcome.status === 403 ? "auth_refused" : "off_contract",
        httpStatus: outcome.status,
        detail: clip(`HTTP ${outcome.status}; the answer could not be journaled: ${sanitizeError(unjournaled).message}`),
        retryNotBefore: parseRetryAfterInstant(outcome.headers["retry-after"] ?? null, answeredAt.getTime()),
      };
      const firstBatch = state.firstAnswerAt === null;
      await this.#stop(failure, { at: answeredAt, firstBatch, ids: ids.length });
      return { kind: "failed", ids: ids.length, failure, observationId: null, firstBatch };
    }
    const read = outcome.kind === "response"
      ? readFanslyWireResponse(this.#spec, params, outcome) as FanslyWireRead<FanslyAccount[]>
      : null;
    const verdict = publicLookupVerdict(outcome, read, ids, answeredAt);
    if (verdict.kind === "unsent") return { kind: "unsent", ids: ids.length };
    if (verdict.kind === "failure") {
      const firstBatch = state.firstAnswerAt === null;
      await this.#stop(verdict.failure, { at: answeredAt, firstBatch, ids: ids.length });
      return { kind: "failed", ids: ids.length, failure: verdict.failure, observationId, firstBatch };
    }
    const applied = await db.transaction(async (tx) => applyFanslyPublicLookupAnswer(tx as unknown as Database, {
      fanIds: batch.map((candidate) => candidate.fanId),
      foundPlatformUserIds: verdict.foundIds,
      answeredAt,
    }));
    this.#d.logger.info({
      component: "fansly_public_lookup",
      ids: ids.length,
      found: applied.found,
      notFound: applied.notFound,
      marksCleared: applied.marksCleared,
      observationId,
    }, "Public account lookup answered");
    return { kind: "answered", ids: ids.length, observationId: observationId!, applied };
  }

  /** The raw answer, page-less (the PAGELESS_FAN_OBSERVATION_KINDS contract):
   *  a successful envelope under `account_lookup_public` as JSON, anything
   *  else under `account_lookup_public:failed` as its text; every asked id in
   *  `requestedIds`. */
  async #journal(token: string, requestedIds: readonly string[], outcome: Extract<FanslyWireOutcome, { kind: "response" }>): Promise<number> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(outcome.bodyText);
    } catch {
      decoded = undefined;
    }
    const envelope = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
    const succeeded = outcome.status >= 200 && outcome.status <= 299 && envelope !== null
      && envelope.success === true && Object.hasOwn(envelope, "response");
    const text = outcome.bodyText.length > FAILED_BODY_MAX_CHARS ? outcome.bodyText.slice(0, FAILED_BODY_MAX_CHARS) : outcome.bodyText;
    const body = succeeded
      ? { requestedIds: [...requestedIds], status: outcome.status, answer: envelope }
      : {
        requestedIds: [...requestedIds],
        status: outcome.status,
        contentType: outcome.headers["content-type"] ?? null,
        retryAfter: outcome.headers["retry-after"] ?? null,
        bodyText: text,
        truncated: text.length < outcome.bodyText.length,
      };
    const payload = replaceJournalLoneSurrogates(body).value;
    const inserted = await insertObservation(this.#d.db, {
      source: "pull",
      producer: "fansly-public-lookup",
      platform: "fansly",
      accountId: null,
      nativeAccountRef: null,
      kind: succeeded ? FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND : `${FANSLY_PUBLIC_ACCOUNT_LOOKUP_KIND}:failed`,
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
      idempotencyKey: `fansly-public-lookup:${token}`,
    });
    return inserted.observationId;
  }

  /** Stop the reader and open the owner's incident (only when this call
   *  stopped it). A failure writes nothing about any fan. */
  async #stop(failure: PublicLookupFailure, input: { at: Date; firstBatch: boolean; ids: number }): Promise<void> {
    const stopped = await stopFanslyPublicLookup(this.#d.db, {
      at: input.at,
      reason: failure.reason,
      httpStatus: failure.httpStatus,
      detail: input.firstBatch ? `first batch: ${failure.detail}` : failure.detail,
      retryNotBefore: failure.retryNotBefore,
    });
    this.#d.logger.warn({
      component: "fansly_public_lookup",
      reason: failure.reason,
      httpStatus: failure.httpStatus,
      firstBatch: input.firstBatch,
      retryNotBefore: failure.retryNotBefore?.toISOString() ?? null,
    }, "Public account reader stopped until the owner resumes it");
    if (!stopped) return;
    await this.#incidents.open({
      reason: failure.reason,
      summary: publicLookupIncidentSummary({ failure, firstBatch: input.firstBatch, ids: input.ids }),
      at: input.at,
    }).catch((error: unknown) => {
      this.#d.logger.error({ component: "fansly_public_lookup", err: sanitizeError(error) },
        "Public account reader could not open its incident");
    });
  }

  /** How long to wait after a pass before the next. */
  delayAfter(pass: PublicLookupPass): number {
    const poll = this.#d.pollMs ?? PUBLIC_LOOKUP_POLL_MS;
    if (pass.kind === "wait") {
      return Math.min(Math.max(pass.until.getTime() - this.#now().getTime(), 1_000), PUBLIC_LOOKUP_MINUTE_MS);
    }
    if (pass.kind === "answered" || pass.kind === "unsent") return 1_000;
    return poll;
  }

  start(): void {
    if (this.#loop !== null) return;
    this.#stopping = false;
    this.#loop = this.#run();
  }

  /** Stop: the pass in flight finishes (its request is bounded by its own
   *  timeout), then nothing more. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    await this.#loop;
    this.#loop = null;
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      let delay = this.#d.pollMs ?? PUBLIC_LOOKUP_POLL_MS;
      try {
        delay = this.delayAfter(await this.runOnce());
      } catch (error) {
        this.#d.logger.error({ component: "fansly_public_lookup", err: sanitizeError(error) },
          "Public account reader pass failed; it tries again later");
      }
      if (this.#stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }
}

/** The reader of the `sync` process over its context. */
export function createFanslyPublicLookupReader(context: {
  db: Database;
  pool: Pick<Pool, "connect">;
  config: AppConfig;
  rawConfig: AppConfig;
  logger: SyncLogger;
}): FanslyPublicLookupReader {
  return new FanslyPublicLookupReader(context);
}
