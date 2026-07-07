import { FanslyApiError } from "@agency_hub_core/fansly";

import type { AppContext } from "../bootstrap.ts";
import { resolvePageContext } from "./page-context.ts";
import { createSyncRateLimitWaiter } from "./sync/rate-limiter.ts";

// Stage 6 — Fansly server-replay gate.
// Fires one read-only call per endpoint family against an owner-chosen page,
// through that page's production egress + pacing, and classifies whether core's
// single pasted `fansly-client-check` validates server-side. Read-only: writes
// nothing to Fansly and nothing to Postgres beyond ordinary sync telemetry.
// See docs/project-kernel/pass3/stages/stage-06-fansly-server-replay-gate.md.

export type ReplayProbeFamily =
  | "earnings/stats/accounts"
  | "earnings/monthlystats/accounts"
  | "media/orderhistory";

export type ReplayProbeVerdict =
  | "replayable"
  | "auth-rejected"
  | "route-rejected"
  | "transport-error"
  /** Dry-run rows: no call fired — never counts toward a verdict. */
  | "skipped";

export interface ReplayProbeResult {
  page: string;
  family: ReplayProbeFamily;
  attempt: number;
  verdict: ReplayProbeVerdict;
  httpStatus: number | null;
  errorCode: number | null;
  itemCount: number | null;
  wallClockMs: number;
  message: string | null;
}

export interface ReplayProbeOptions {
  pageLabels: string[];
  calls?: number;
  dryRun?: boolean;
  // Optional well-formed-call inputs (a page's own fan / media ids). When absent
  // the calls still fire (bare) — a bare call distinguishes auth rejection from
  // route-level rejection, which is the load-bearing signal. Supplying them makes
  // the call well-formed and lets an empty-but-200 count as `replayable`.
  correlationAccountId?: string | null;
  mediaAccountIds?: string | null;
  accountMediaId?: string | null;
  accountMediaBundleId?: string | null;
}

const FAMILIES: ReplayProbeFamily[] = [
  "earnings/stats/accounts",
  "earnings/monthlystats/accounts",
  "media/orderhistory",
];

/**
 * Classify one probe call. `auth-rejected` (401/403) is the signal that the
 * session-check did NOT validate server-side on this route → the family is
 * non-replayable. Any non-auth outcome (200, or a 4xx route/param rejection)
 * means the session was accepted → the family is replayable.
 */
function classify(error: unknown): {
  verdict: ReplayProbeVerdict;
  httpStatus: number | null;
  errorCode: number | null;
  message: string;
} {
  if (error instanceof FanslyApiError) {
    const status = error.status ?? null;
    if (status === 401 || status === 403) {
      return { verdict: "auth-rejected", httpStatus: status, errorCode: error.code ?? null, message: error.message };
    }
    // Any other HTTP/provider rejection means we got past auth: the check validated.
    return { verdict: "route-rejected", httpStatus: status, errorCode: error.code ?? null, message: error.message };
  }
  return {
    verdict: "transport-error",
    httpStatus: null,
    errorCode: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function runFanslyReplayProbe(
  app: AppContext,
  options: ReplayProbeOptions,
): Promise<ReplayProbeResult[]> {
  const calls = options.calls ?? 1;
  if (!Number.isInteger(calls) || calls < 1) {
    // NaN (from a garbage --calls) used to fire ZERO probes and still print
    // the green "no auth rejections" line — a false gate signal (review R1-5).
    throw new Error("replay-probe calls must be a positive integer");
  }
  const now = new Date();
  const results: ReplayProbeResult[] = [];

  for (const pageLabel of options.pageLabels) {
    const context = await resolvePageContext(app, pageLabel);
    if (context.platform !== "fansly") {
      throw new Error(`Page "${pageLabel}" is not a Fansly page (platform=${context.platform})`);
    }

    const rateLimitWaiter = createSyncRateLimitWaiter(app, { egressKey: context.egressKey });
    const requestContext = {
      session: context.session,
      proxy: context.proxy,
      egressKey: context.egressKey,
      rateLimitWaiter,
    };

    for (let attempt = 1; attempt <= calls; attempt += 1) {
      for (const family of FAMILIES) {
        if (options.dryRun) {
          results.push({
            page: pageLabel,
            family,
            attempt,
            verdict: "skipped",
            httpStatus: null,
            errorCode: null,
            itemCount: null,
            wallClockMs: 0,
            message: "dry-run (not called)",
          });
          continue;
        }

        const startedAt = Date.now();
        try {
          let items: unknown;
          if (family === "earnings/stats/accounts") {
            ({ items } = await app.adapter.getEarningsStatsAccountsPage(requestContext, {
              correlationAccountId: options.correlationAccountId ?? null,
              after: new Date(0),
              before: now,
            }));
          } else if (family === "earnings/monthlystats/accounts") {
            ({ items } = await app.adapter.getEarningsMonthlyStatsAccountsPage(requestContext, {
              correlationAccountId: options.correlationAccountId ?? null,
              after: new Date(0),
              before: now,
            }));
          } else {
            ({ items } = await app.adapter.getMediaOrderHistoryPage(requestContext, {
              accountIds: options.mediaAccountIds ?? null,
              accountMediaId: options.accountMediaId ?? null,
              accountMediaBundleId: options.accountMediaBundleId ?? null,
              limit: 100,
            }));
          }

          results.push({
            page: pageLabel,
            family,
            attempt,
            verdict: "replayable",
            httpStatus: 200,
            errorCode: null,
            itemCount: Array.isArray(items) ? items.length : null,
            wallClockMs: Date.now() - startedAt,
            message: null,
          });
        } catch (error) {
          const classified = classify(error);
          results.push({
            page: pageLabel,
            family,
            attempt,
            verdict: classified.verdict,
            httpStatus: classified.httpStatus,
            errorCode: classified.errorCode,
            itemCount: null,
            wallClockMs: Date.now() - startedAt,
            message: classified.message,
          });
        }
      }
    }
  }

  return results;
}

/** Collapse per-attempt results into a per-(page,family) verdict summary. */
export function summarizeReplayProbe(results: ReplayProbeResult[]): string {
  const lines: string[] = [];
  lines.push("VERDICT TABLE — Stage 6 fansly:replay-probe");
  lines.push("page | family | verdict | http | code | items | ms | note");
  for (const r of results) {
    lines.push(
      [
        r.page,
        r.family,
        r.verdict,
        r.httpStatus ?? "—",
        r.errorCode ?? "—",
        r.itemCount ?? "—",
        r.wallClockMs,
        r.message ?? "",
      ].join(" | "),
    );
  }
  const probed = results.filter((r) => r.verdict !== "skipped");
  const authRejected = probed.filter((r) => r.verdict === "auth-rejected");
  lines.push("");
  if (probed.length === 0) {
    lines.push(
      "→ NO PROBES FIRED (dry-run or zero calls) — no replayability verdict. " +
        "Re-run without --dry-run before filling the stage-06 table.",
    );
  } else if (authRejected.length === 0) {
    lines.push(
      "→ No auth rejections: every probed family accepted the pasted session server-side (replayable). " +
        "Fill the stage-06 verdict table and clear Stages 16/17.",
    );
  } else {
    const families = [...new Set(authRejected.map((r) => r.family))].join(", ");
    lines.push(
      `→ AUTH REJECTION on: ${families}. These families are NOT replayable with the pasted check — ` +
        "escalate per Q2 part 2 (per-endpoint) before Stage 16 covers them.",
    );
  }
  return lines.join("\n");
}
