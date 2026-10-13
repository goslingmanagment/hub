// The steps of a page's start (plan §4.1) and why a page stands (spec §6.1).
// The operator goes through the steps strictly in order; any failure sends
// it back to the first. Steps 8–10 (site loaded, session confirmed, ready)
// belong to later PRs: this operator stops at step 7, the exit open.

export const STEPS = [
  "exit_closed",
  "env_applied",
  "chrome_started",
  "control_attached",
  "selftest_passed",
  "exit_ip_verified",
  "exit_open",
  "site_loaded",
  "session_confirmed",
  "ready",
] as const;
export type Step = (typeof STEPS)[number];

/** Spec §6.1's reasons, and two more, to be added there before an engine
 *  reads these:
 *  - `env_mismatch` (PR 5): the page's environment could not be handed to
 *    Chrome, or the browser does not show it (plan §4.1, step 2; spec §10);
 *  - `buffer_unavailable` (PR 11): the buffer could not be opened — locked,
 *    a failing disk, a corrupt file, a format newer than the operator. The
 *    page stands with the exit closed until it opens (spec §5). */
export const STOP_REASONS = [
  "selftest_failed",
  "env_mismatch",
  "exit_ip_changed",
  "proxy_unavailable",
  "proxy_auth",
  "cdp_lost",
  "holder_overflow",
  "buffer_full",
  "disk_full",
  "buffer_unavailable",
  "chrome_crashed",
  "unknown_ws_message",
  "header_mismatch",
  "login_required",
  "owner_stop",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

export function atLeast(step: Step, than: Step): boolean {
  return stepIndex(step) >= stepIndex(than);
}

/** Plan §4.1 and §4.14: a failed start is tried again after 10 s, 30 s,
 *  2 min, then every 5 min. */
export const RESTART_BACKOFF_MS: readonly number[] = [10_000, 30_000, 120_000, 300_000];

/** The wait before the next try after `failures` failed starts in a row. */
export function restartDelayMs(failures: number, ladder: readonly number[] = RESTART_BACKOFF_MS): number {
  if (ladder.length === 0) throw new Error("an empty backoff ladder");
  const index = Math.min(Math.max(failures, 1), ladder.length) - 1;
  return ladder[index]!;
}
