// G5 slice 3c-2 / decision #239 — a killed run leaves a tombstone that says so.
//
// PRODUCTION RUN 1 IS THE REASON THIS FILE EXISTS. `capture:backfill --table
// observations --month 2026-07 --execute` started 2026-08-18 20:29, stamped
// 362,804 rows, and was killed when the #87 deploy recreated its container. Its
// `capture_rewrite_runs` row was still `verdict = 'running', completed_at NULL`
// eight days later — so the ledger asserted an in-flight run that had not
// existed for a week, and the ONE piece of evidence the runbook tells an
// operator to read said the opposite of the truth.
//
// The `catch` in runCaptureBackfill already settles a run that THROWS. A signal
// is not a throw: SIGTERM's default action terminates the process outright, and
// nothing in the try/catch ever runs.
//
// WHY IT SETTLES IMMEDIATELY RATHER THAN ASKING THE WALK TO STOP. Docker sends
// SIGTERM and follows it with SIGKILL after ten seconds by default. A flag the
// batch loop checks would be the tidier shape and would lose the tombstone
// exactly when it matters most — a batch in the middle of a slow UPDATE on a
// starved box does not come back inside that window. So the handler writes the
// verdict on its own connection, first, and only then lets the process go.
// `stopRequested` is still exposed and the loop still honours it, so a fast
// walk stops cleanly and its normal settle finds the row already closed —
// harmless, because settling is an idempotent UPDATE of the same row.
//
// The exit code is the conventional 128 + signal number: a killed process must
// not look successful to whatever launched it.
//
// THE WRITE IS CONDITIONAL ON THE ROW STILL BEING `running`. A signal can arrive
// in the window between the walk's own settle and this guard being released, and
// an unconditional write there would rewrite a COMPLETED run as `failed` —
// inventing a failure, which is a worse lie than the stale `running` row this
// mechanism exists to prevent. `settleRunningCaptureRewriteRun` carries the
// predicate; a `false` return means the run had already settled itself and this
// handler correctly did nothing.

import { settleRunningCaptureRewriteRun } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

type Ctx = Pick<AppContext, "db" | "logger">;

export const SETTLE_ON_SIGNALS = ["SIGTERM", "SIGINT"] as const;
export type SettleSignal = (typeof SETTLE_ON_SIGNALS)[number];

const SIGNAL_NUMBER: Record<SettleSignal, number> = { SIGTERM: 15, SIGINT: 2 };

export interface RunSettleGuard {
  /** True once a signal has been seen; the walk checks it and stops. */
  stopRequested: () => boolean;
  /** Remove the handlers. Always call this in a `finally`. */
  release: () => void;
}

export interface SettleGuardHooks {
  /** Injected in tests; defaults to the real process. */
  on?: (signal: SettleSignal, handler: () => void) => void;
  off?: (signal: SettleSignal, handler: () => void) => void;
  exit?: (code: number) => void;
}

/**
 * Settle `runId` to `failed` if this process is signalled, then exit.
 *
 * `summary()` is a thunk rather than a value because the interesting part of a
 * killed run is how far it got, and that is only known at the moment it is
 * killed.
 */
export function settleRunOnSignal(
  app: Ctx,
  input: {
    runId: number;
    scopeRef: string;
    summary: () => Record<string, unknown>;
  },
  hooks: SettleGuardHooks = {},
): RunSettleGuard {
  const on = hooks.on ?? ((signal, handler) => { process.on(signal, handler); });
  const off = hooks.off ?? ((signal, handler) => { process.off(signal, handler); });
  const exit = hooks.exit ?? ((code) => { process.exit(code); });

  let requested = false;
  const handlers = new Map<SettleSignal, () => void>();

  const release = () => {
    for (const [signal, handler] of handlers) {
      off(signal, handler);
    }
    handlers.clear();
  };

  for (const signal of SETTLE_ON_SIGNALS) {
    const handler = () => {
      if (requested) {
        // A second signal is an operator saying "I meant it". Do not queue a
        // second settle behind the first one's connection.
        return;
      }
      requested = true;
      app.logger.warn(
        { scope: input.scopeRef, runId: input.runId, signal },
        "capture rewrite run signalled — settling its ledger row to failed",
      );
      void settleRunningCaptureRewriteRun(app.db, {
        id: input.runId,
        verdict: "failed",
        summary: {
          ...input.summary(),
          killedBySignal: signal,
        },
      })
        .then((settled) => {
          if (!settled) {
            app.logger.info(
              { scope: input.scopeRef, runId: input.runId, signal },
              "capture rewrite run had already settled itself — signal handler left it alone",
            );
          }
        })
        .catch((error: unknown) => {
          app.logger.error(
            { scope: input.scopeRef, runId: input.runId, signal, err: error },
            "capture rewrite run settle FAILED after signal — the ledger row stays `running`",
          );
        })
        .finally(() => {
          release();
          exit(128 + SIGNAL_NUMBER[signal]);
        });
    };
    handlers.set(signal, handler);
    on(signal, handler);
  }

  return { stopRequested: () => requested, release };
}
