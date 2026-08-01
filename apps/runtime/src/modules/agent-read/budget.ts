import { AgentBudgetExhaustedError } from "./errors.ts";
import { TooManyRequestsError } from "../../services/errors.ts";

/**
 * Per-key in-flight concurrency: at most two requests at a time.
 *
 * WHY A COUNTER AND NOT A MAP OF SETS: the retention-deleters pin greps the
 * runtime TEXTUALLY for SQL deletes, and a Map removal reads the same to that
 * grep, so in-memory removal is banned in new modules. A gauge that increments
 * and decrements needs no removal at all, and an entry that settles back to zero
 * costs one integer per key that has ever called — bounded by the number of
 * issued keys, which the owner mints by hand.
 *
 * The gauge is PROCESS-LOCAL by design. It is a politeness limit protecting this
 * instance's connection pool, not a security control; the security control is the
 * daily budget, which lives in Postgres precisely because it must be shared.
 */

export const AGENT_CONCURRENCY_LIMIT = 2;

const inFlightByKey = new Map<number, number>();

export function agentConcurrencyInUse(agentKeyId: number): number {
  return inFlightByKey.get(agentKeyId) ?? 0;
}

/** Reserves a slot, or throws 429. */
export function acquireAgentSlot(agentKeyId: number): void {
  const current = inFlightByKey.get(agentKeyId) ?? 0;
  if (current >= AGENT_CONCURRENCY_LIMIT) {
    throw new TooManyRequestsError(
      `agent key already has ${AGENT_CONCURRENCY_LIMIT} requests in flight`,
    );
  }
  inFlightByKey.set(agentKeyId, current + 1);
}

/** Releases a slot. Clamped at zero: a double release must never make the gauge
 *  negative and hand out a third slot. The entry stays at zero rather than being
 *  removed (see the header). */
export function releaseAgentSlot(agentKeyId: number): void {
  const current = inFlightByKey.get(agentKeyId) ?? 0;
  inFlightByKey.set(agentKeyId, Math.max(0, current - 1));
}

/** Test seam. Never called by the server. */
export function resetAgentConcurrencyForTests(): void {
  for (const key of inFlightByKey.keys()) {
    inFlightByKey.set(key, 0);
  }
}

/**
 * Per-route request-per-minute ceilings (§8).
 *
 * Only three operations have one; the rest are bounded by the concurrency gauge
 * and the daily budget. A route without a number here is deliberately unlimited
 * per minute, not accidentally so.
 */
export const AGENT_ROUTE_RPM = {
  agentThreadMessages: 60,
  agentSearchMessages: 20,
  agentDatasetQuery: 20,
} as const satisfies Readonly<Record<string, number>>;

/**
 * Turns a budget verdict into either nothing or the 429 that stops the request.
 *
 * The distinction the contract draws: a request refused BEFORE it ran gets 429;
 * a request that ran and exhausted its reservation MID-RESPONSE is truncated
 * honestly with `cappedBy: "budget"` and a next cursor, and it is the FOLLOWING
 * call that gets the 429.
 */
export function assertWithinAgentBudget(state: {
  withinBudget: boolean;
  requests: number;
  dailyRequestBudget: number;
  rowsReturned: number;
  dailyRowBudget: number;
}): void {
  if (state.withinBudget) {
    return;
  }
  throw new AgentBudgetExhaustedError(
    state.requests > state.dailyRequestBudget
      ? "agent key daily request budget exhausted"
      : "agent key daily row budget exhausted",
  );
}
