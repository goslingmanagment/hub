import { sql } from "drizzle-orm";

import type { Database, SyncWorkRow } from "@agency_hub_core/db";
import {
  buildFanslyWireUrl,
  fanslyWireSpec,
  type FanslyWireId,
  type FanslyWireRequest,
} from "@agency_hub_core/fansly";

import { REQUEST_TIMEOUT_MS } from "./pacer.ts";
import type { Clock, Rng, SendHooks, TransportOutcome } from "./ports.ts";
import type { RequestPlan } from "./resource.ts";

// Shadow mode (design §3.12): the actor runs the same scheduler and the same
// pacer, takes the same ownership and journals every step, but nothing leaves
// the process. The shadow transport has no socket, no dispatcher, no
// credentials: it asks the admission's send check exactly where undici would
// (at the simulated "request start"), then waits a latency sampled from the
// page's recent legacy durations and answers `{kind:'shadow'}`. The commit
// side (`commit.settleShadow`) writes only `sync_attempts`, `sync_work` and
// nothing of the page's live facts (I14).

/** The latency of a simulated request when the legacy journal has none. */
export const SHADOW_DEFAULT_LATENCY_MS = 600;
/** How long a page's legacy latency percentiles are reused. */
export const SHADOW_LATENCY_REFRESH_MS = 600_000;
/** The legacy journal window the percentiles are read from. */
export const SHADOW_LATENCY_WINDOW_MS = 86_400_000;
/** The host of a shadow request line: never dialled, never journaled (the
 *  attempt stores the path and query only). */
const SHADOW_BASE_URL = "https://shadow.invalid/api/v1";

/** Builds the request of a plan and sends it — the actor's view of a page's
 *  transport (live: `fansly/transport.ts`; shadow: below). */
export interface PageTransport {
  /** The request of one plan, built right before its admission; `context`
   *  names the work it is for (a CDN hop reads the work's secret URL). Throws
   *  `UnsendableRequestError` for a request that can never be sent. */
  prepare(request: RequestPlan, context?: { work: SyncWorkRow }): Promise<FanslyWireRequest>;
  /** At most one physical request (none in shadow). */
  send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome>;
  /** Live: the digest of the page's stored credentials now (the session and
   *  the proxy; `readFanslyPageGeneration`), from a read-only snapshot. The
   *  actor compares it with the trusted digest (checks-only, G2) and with the
   *  latest refusal a credentials hold names (the verify it admits, A3).
   *  Absent where the transport stores none. */
  storedCredentialsGeneration?(): Promise<string | null>;
  close(): Promise<void>;
}

export interface ShadowLatencySource {
  sampleMs(spec: FanslyWireId): Promise<number>;
}

export function fixedShadowLatency(ms: number): ShadowLatencySource {
  return { sampleMs: async () => ms };
}

/**
 * The page's recent legacy durations of the matching operation
 * (`sync_http_attempts.duration_ms`, p50 and p95 over the last day, cached
 * for ten minutes): a sample is uniform between the two. Without data, or
 * when the read fails, `SHADOW_DEFAULT_LATENCY_MS`.
 */
export function createLegacyShadowLatency(input: {
  db: Database;
  pageId: number;
  clock: Clock;
  rng: Rng;
}): ShadowLatencySource {
  let cache: { readAtMono: number; byOperation: Map<string, { p50: number; p95: number }> } | null = null;
  async function percentiles(): Promise<Map<string, { p50: number; p95: number }>> {
    const now = input.clock.monoNow();
    if (cache !== null && now - cache.readAtMono < SHADOW_LATENCY_REFRESH_MS) return cache.byOperation;
    const byOperation = new Map<string, { p50: number; p95: number }>();
    try {
      const result = await input.db.execute<{ operation: string; p50: number | string; p95: number | string }>(sql`
        select a.operation,
               percentile_disc(0.5) within group (order by a.duration_ms) as p50,
               percentile_disc(0.95) within group (order by a.duration_ms) as p95
          from sync_http_attempts a
         where a.page_id = ${input.pageId}
           and a.started_at > now() - ${SHADOW_LATENCY_WINDOW_MS}::double precision * interval '1 millisecond'
           and a.duration_ms is not null
         group by a.operation
      `);
      for (const row of result.rows) {
        byOperation.set(row.operation, { p50: Number(row.p50), p95: Number(row.p95) });
      }
    } catch {
      // Latency is a simulation detail: an unreadable journal is the default.
    }
    cache = { readAtMono: now, byOperation };
    return byOperation;
  }
  return {
    async sampleMs(spec) {
      const operation = fanslyWireSpec(spec).legacyOperation;
      const found = (await percentiles()).get(operation);
      if (found === undefined || !(found.p50 >= 0) || !(found.p95 >= found.p50)) return SHADOW_DEFAULT_LATENCY_MS;
      return Math.round(found.p50 + (found.p95 - found.p50) * input.rng.next());
    },
  };
}

export class ShadowTransport implements PageTransport {
  readonly #clock: Clock;
  readonly #latency: ShadowLatencySource;
  /** Simulated sends so far (tests). */
  sends = 0;

  constructor(input: { clock: Clock; latency: ShadowLatencySource }) {
    this.#clock = input.clock;
    this.#latency = input.latency;
  }

  /** The request line only: no headers, no credentials are read. */
  async prepare(request: RequestPlan): Promise<FanslyWireRequest> {
    return {
      spec: request.spec,
      url: buildFanslyWireUrl(request.spec, request.params as never, SHADOW_BASE_URL),
      headers: {},
      timeoutMs: REQUEST_TIMEOUT_MS,
    };
  }

  /** Ask the send check after a 0 ms "connect" (a refusal is
   *  `aborted_before_send`, as live), then simulate the answer's latency. A
   *  cancel during that wait ends it early; the simulated send stands. */
  async send(req: FanslyWireRequest, hooks: SendHooks, signal: AbortSignal): Promise<TransportOutcome> {
    if (signal.aborted) return { kind: "aborted_before_send", refusal: "lease_inactive" };
    await this.#clock.sleep(0);
    const refusal = hooks.check();
    if (refusal !== null) return { kind: "aborted_before_send", refusal: refusal.reason };
    this.sends += 1;
    const latencyMs = Math.max(0, await this.#latency.sampleMs(req.spec));
    const started = this.#clock.monoNow();
    try {
      await this.#clock.sleep(latencyMs, signal);
    } catch {
      // Cancelled: the simulated request ends here.
    }
    return { kind: "shadow", simulatedLatencyMs: Math.max(0, Math.round(this.#clock.monoNow() - started)) };
  }

  async close(): Promise<void> {}
}
