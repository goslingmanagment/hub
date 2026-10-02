import type { Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import type { SyncChainContext } from "../fansly/lib/chain-rebuild.ts";

// What the step-3 switch and rollback CLIs run on (design step 3 §3.5 items
// 7–8). Everything outside the database is a port, so the integration tests
// drive the very same code with scaled timing.

/** The switch's and the rollback's waits. Production values are the design's;
 *  tests scale them down. */
export interface SwitchTiming {
  /** Phase A: the guard flip is retried this often … */
  guardRetryMs: number;
  /** … for at most this long (a legacy request still in flight). */
  guardTimeoutMs: number;
  /** Phase B: the legacy stop evidence is re-read this often … */
  stopRetryMs: number;
  /** … for at most this long. */
  stopTimeoutMs: number;
  /** Phase C: a new live owner with a fresh heartbeat within this long. */
  ownerTimeoutMs: number;
  /** Phase C/rollback: re-read period of the owner state. */
  ownerRetryMs: number;
  /** Rollback step 2: the live owner's safe release within this long. */
  releaseTimeoutMs: number;
  /** The first switched page opens its history requests this long after C. */
  firstPageRequestsDelayMs: number;
}

export const SWITCH_TIMING: SwitchTiming = {
  guardRetryMs: 250,
  guardTimeoutMs: 5 * 60_000,
  stopRetryMs: 2_000,
  stopTimeoutMs: 5 * 60_000,
  ownerTimeoutMs: 2 * 60_000,
  ownerRetryMs: 1_000,
  releaseTimeoutMs: 60_000,
  firstPageRequestsDelayMs: 60 * 60_000,
};

export interface SwitchContext {
  db: Database;
  /** The env config the live pause key is layered over (S, the history ETA). */
  rawConfig: AppConfig;
  logger: SyncChainContext["logger"];
  /** Who runs the CLI (`cli@<host> pid <pid>`): audit rows and `mode_changed_by`. */
  actor: string;
  /** This CLI's build identity (`process.env.GIT_SHA`, set by the image). */
  buildSha: string | null;
  /** Whether this build runs a live loop (`LIVE_LOOP_ENABLED`). */
  liveLoopEnabled: boolean;
  timing: SwitchTiming;
  /** One line of the CLI's progress. */
  print(line: string): void;
  sleep(ms: number): Promise<void>;
  readFile(path: string): Promise<string>;
  /** The rollback's last step: the legacy engine is asked to run every stream
   *  of the page (`requestPageSync(scope 'all', reason 'recovery')` with the
   *  CLI's pg-boss client). */
  requestLegacyRecovery(pageLabel: string): Promise<void>;
  /** TESTS ONLY: the legacy night window (default 00:00–05:00 UTC by the
   *  database clock). The CLI never passes it. */
  inNightWindow?: (at: Date) => boolean;
}

/** Exit codes of the switch and rollback CLIs (design §3.5 item 8). */
export const SWITCH_EXIT = {
  done: 0,
  /** A or B timed out: the switch reverted the page to `shadow`. */
  reverted: 2,
  /** The rollback (or B) waits for a stop confirmation of the engine's owner. */
  waitsForStop: 3,
  /** C timed out: the page is `live` with the guard handed and no owner. */
  noLiveOwner: 4,
  /** The rollback refuses under an auth/identity hold. */
  authHold: 5,
} as const;

/** A duration for the operator's line, in whole seconds (rounded up). */
export function wholeSeconds(ms: number): number {
  return Math.ceil(ms / 1_000);
}

export class SwitchRefusedError extends Error {
  constructor(message: string, readonly checks: unknown = null) {
    super(message);
    this.name = "SwitchRefusedError";
  }
}
