// The credit guard of every OFAPI REST lane (the DM chats list, audience, fan
// identities, link stats, chargebacks, the transactions backfill, the fan
// account check): the per-chunk request cap, the one day credit budget and the
// balance floor, checked before every request.

import {
  getOfapiCreditState,
  getOfapiDayCreditsSpent,
  recordOfapiPhysicalCreditUsage,
  reserveOfapiDayCredits,
  settleOfapiDayCreditReservation,
  type OfapiDayBudgetScope,
} from "@agency_hub_core/db";
import { OFAPI_MIRROR_BUDGET_DEFAULTS } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import type { OfapiListPage } from "./ofapi.ts";

// A chunk, not a ceiling: a stream that used it yields and its next chunk is
// scheduled right away. Money is held by the day's one credit budget + floor.
const REQUESTS_PER_CHUNK = 25;
export const DEFAULT_CREDIT_FLOOR = 500;
// Daily-budget / balance-floor blocks park the stream for a while instead of
// hot-looping yields; budgets refill at UTC midnight (or after a top-up).
export const BUDGET_BLOCK_RETRY_DELAY_MS = 60 * 60 * 1000;

export type OfapiBudgetBlock = "ofapi_request_budget" | "ofapi_daily_credit_budget" | "ofapi_credit_floor";

// The per-request reservation estimate: the standard uncached account-scoped
// read costs 1 credit; recordResponse settles to the _meta-reported actuals.
const OFAPI_REQUEST_CREDIT_ESTIMATE = 1;

/**
 * Audit F7: a sub-floor balance only parks while the observation is fresh.
 * Parked streams make no requests, so nothing would ever refresh a stale
 * balance and a floor crossing would outlive an account top-up — with the
 * optional balance ping off, permanently. Once the observation is older than
 * the park delay, one probe request per park cycle is let through; its _meta
 * (via the ledger sink or the settle path) refreshes the balance and the
 * stream resumes or re-parks on real data.
 */
export const OFAPI_FLOOR_BALANCE_FRESHNESS_MS = BUDGET_BLOCK_RETRY_DELAY_MS;

export function isOfapiCreditFloorBlocking(input: {
  creditFloor: number;
  lastBalance: number | null;
  lastBalanceAt: Date | null;
  now?: Date;
}) {
  if (
    input.creditFloor <= 0 ||
    input.lastBalance === null ||
    input.lastBalance >= input.creditFloor
  ) {
    return false;
  }
  const nowMs = (input.now ?? new Date()).getTime();
  return input.lastBalanceAt !== null &&
    nowMs - input.lastBalanceAt.getTime() < OFAPI_FLOOR_BALANCE_FRESHNESS_MS;
}

/**
 * D4/D6 budget guard, checked before every REST request. The per-chunk request
 * cap yields like a normal budget exhaustion; daily-budget and floor blocks add
 * a retry delay so the stream parks instead of spinning. Streams with their own
 * ceiling (audience, D6) pass `budgetScope: "audience"`. With the ledger on,
 * dedicated lanes atomically reserve both their own counter and the shared
 * physical cap; without it they fall back to the global day counter.
 *
 * Audit F9: the day-budget check is reserve-before-request — the comparison
 * and the counter increment are one conditional update, so concurrent streams
 * near the cap can never pass the check together and overspend. recordResponse
 * settles each reservation to the server-reported actuals; a request that
 * throws in between leaks at most the 1-credit estimate until the UTC-day
 * rollover (conservative direction).
 *
 * One day budget for all OFAPI spend (`ofapiMirrorGlobalDailyCreditBudget`)
 * plus the balance floor. A dedicated lane (audience, backfill, link stats)
 * keeps its own counter only to attribute spend in reports; it has no quota
 * of its own.
 *
 * `freeReads` (the link series: the vendor's stored caches cost 0 credits) —
 * money admission becomes an observation instead of a reservation:
 *   - the credit floor is not checked: a low balance must not stop a lane
 *     that spends nothing;
 *   - no credit is reserved, on the lane's counter or on the shared day cap:
 *     an exhausted shared cap must not stop it either, and a request that
 *     fails leaves nothing on the lane's counter;
 *   - the lane stops only if what the vendor ACTUALLY charged it today
 *     (recorded by the client's ledger sink, or here from the response's
 *     _meta when no sink accounted it) reaches the day budget: if stored
 *     reads ever start costing credits, that is the end of the assumption.
 * Everything the client enforces before a request (credential, pacing) is
 * unchanged.
 */
export function createOfapiRestGuard(app: AppContext, options?: {
  maxRequestsPerRun?: number;
  budgetScope?: OfapiDayBudgetScope;
  freeReads?: boolean;
}) {
  const maxRequestsPerRun = Math.max(
    1,
    options?.maxRequestsPerRun ?? app.config.ofapiDmBootstrapMaxRequestsPerRun ?? REQUESTS_PER_CHUNK,
  );
  // The one day budget: every lane and mirror admission share it.
  const globalDailyCreditBudget = Math.max(
    1,
    app.config.ofapiMirrorGlobalDailyCreditBudget ??
      OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget,
  );
  const creditFloor = Math.max(0, app.config.ofapiCreditFloor ?? DEFAULT_CREDIT_FLOOR);
  // Dedicated counters (audience, backfill, link stats) attribute spend; they
  // are reserved in the same statement as the shared day budget.
  const scope: OfapiDayBudgetScope =
    options?.budgetScope === "audience" || options?.budgetScope === "backfill" ||
      options?.budgetScope === "link_stats"
      ? options.budgetScope
      : "global";
  let requestsUsed = 0;
  let reservationReceipt: Awaited<ReturnType<typeof reserveOfapiDayCredits>> = null;

  if (options?.freeReads === true) {
    // The lane's own counter: with no reservations on it,
    // it holds actual charges only, and the global-counter fallback (all
    // OFAPI spend of the day) would be the wrong thing to hold a quota to.
    const lane = options.budgetScope;
    if (lane === undefined || lane === "global") {
      throw new Error("OFAPI free-read guard needs a dedicated budget scope");
    }
    return {
      get requestsUsed() {
        return requestsUsed;
      },
      abandonPendingReservation() {
        // Nothing was reserved, so a failed request leaves nothing behind.
        return false;
      },
      async resolveBlock(): Promise<OfapiBudgetBlock | null> {
        if (requestsUsed >= maxRequestsPerRun) {
          return "ofapi_request_budget";
        }
        return await getOfapiDayCreditsSpent(app.db, lane) >= globalDailyCreditBudget
          ? "ofapi_daily_credit_budget"
          : null;
      },
      async recordResponse(page: OfapiListPage) {
        requestsUsed += 1;
        // The client's ledger sink recorded every physical attempt already,
        // on the shared counter and on this lane.
        if (page.creditSpendAccounted === true) {
          return;
        }
        // No sink accounted it (a client without one): take
        // the vendor's own word. A response that names no charge is free —
        // that is the lane's premise — and a balance it reports is still a
        // reconciliation anchor.
        const creditsUsed = page.meta?.creditsUsed ?? 0;
        const balance = page.meta?.creditBalance ?? null;
        if (creditsUsed > 0 || balance !== null) {
          await recordOfapiPhysicalCreditUsage(app.db, {
            creditsUsed,
            balance,
            budgetScope: lane,
          });
        }
      },
    };
  }

  return {
    get requestsUsed() {
      return requestsUsed;
    },
    abandonPendingReservation() {
      // A transport/classified request failure has no response to settle.
      // Clear only the in-memory lifecycle token; the DB estimate deliberately
      // remains charged until UTC rollover as a conservative unknown outcome.
      const abandoned = reservationReceipt !== null;
      reservationReceipt = null;
      return abandoned;
    },
    async resolveBlock(): Promise<OfapiBudgetBlock | null> {
      if (requestsUsed >= maxRequestsPerRun) {
        return "ofapi_request_budget";
      }
      if (reservationReceipt !== null) {
        throw new Error("OFAPI day-budget reservation is still pending settlement");
      }

      const credit = await getOfapiCreditState(app.db);
      if (isOfapiCreditFloorBlocking({
        creditFloor,
        lastBalance: credit.lastBalance,
        lastBalanceAt: credit.lastBalanceAt,
      })) {
        return "ofapi_credit_floor";
      }

      const receipt = await reserveOfapiDayCredits(app.db, scope === "global"
        ? { scope, estimate: OFAPI_REQUEST_CREDIT_ESTIMATE, budget: globalDailyCreditBudget }
        : {
          scope,
          estimate: OFAPI_REQUEST_CREDIT_ESTIMATE,
          // The lane's counter only attributes; the shared budget decides.
          budget: Number.MAX_SAFE_INTEGER,
          globalBudget: globalDailyCreditBudget,
        });
      if (receipt) reservationReceipt = receipt;
      return receipt ? null : "ofapi_daily_credit_budget";
    },
    async recordResponse(page: OfapiListPage) {
      requestsUsed += 1;
      const receipt = reservationReceipt;
      reservationReceipt = null;
      if (!receipt) {
        throw new Error("OFAPI response cannot settle without a day-budget receipt");
      }
      const actualCredits = page.meta?.creditsUsed ?? OFAPI_REQUEST_CREDIT_ESTIMATE;
      // The client's onCreditSpend sink already recorded every physical
      // attempt in both the global counter and the attributed dedicated lane.
      // Release only the original reservation here; retry spend must not
      // disappear behind the final logical response. Custom clients without the
      // sink retain the final-response settlement, balance included.
      const accounted = page.creditSpendAccounted === true;
      const creditsDelta = accounted
        ? -OFAPI_REQUEST_CREDIT_ESTIMATE
        : actualCredits - OFAPI_REQUEST_CREDIT_ESTIMATE;
      await settleOfapiDayCreditReservation(app.db, accounted
        ? { scope, receipt, creditsDelta }
        : { scope, receipt, creditsDelta, balance: page.meta?.creditBalance ?? null });
      if (scope !== "global") {
        await settleOfapiDayCreditReservation(app.db, { scope: "global", receipt, creditsDelta });
      }
    },
  };
}
