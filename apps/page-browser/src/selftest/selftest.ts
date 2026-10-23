// The self-test with the exit closed (plan §4.1, step 5): every protective
// mechanism is checked on its own, and the answer shows which one stopped
// the request. The whole test takes at most 10 s (plan §4.14); with the exit
// closed it sends nothing to Fansly.
//
//   proxy_closed  a permitted request reaches the operator's interception,
//                 goes on to its proxy and gets the closed exit's refusal:
//                 Chrome sees net::ERR_TUNNEL_CONNECTION_FAILED, and the
//                 proxy's journal has the refusal;
//   os_rules      the kernel lets Chrome's user reach nothing but the proxy:
//                 the result of the net-selftest service (s6), written at the
//                 container's start, all checks passed;
//   dnr_never     the rules extension cancels a request the map closes one
//                 by one (POST /api/v1/message/typing — spec §2.5) before
//                 the interception: net::ERR_BLOCKED_BY_CLIENT, never paused.
//                 Not the read mark `/message/ack` any more: that path is
//                 open to the operator's check of its body (owner decision
//                 2026-10-23), so the extension lets its POST through;
//   dnr_write     the extension cancels an unknown write the same way.
//
// The rules extension is in the image since PR 6 and is required: a missing
// one — not installed yet, or not loaded — fails the test, and the exit
// stays closed. Its policy allows no other extension, so the one that
// cancels the probes is the image's.

import { monoMs, wallMs, errorMessage } from "../shared/util.ts";
import type { ProbeKind, ProbeOutcome } from "./probes.ts";

export type Mechanism = "proxy_closed" | "os_rules" | "dnr_never" | "dnr_write";
export const MECHANISMS: readonly Mechanism[] = ["proxy_closed", "os_rules", "dnr_never", "dnr_write"];

export type CheckStatus = "passed" | "failed" | "not_installed";
export interface Check {
  status: CheckStatus;
  /** What was seen, in words (no secrets). */
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  atWall: number;
  durationMs: number;
  /** The first mechanism that failed. */
  failed: Mechanism | null;
  checks: Record<Mechanism, Check>;
}

export type ExtensionChecks = "not_installed" | "required";
/** The image carries the rules extension (PR 6): its checks must pass.
 *  ("not_installed" is left for tests of an image without it.) */
export const EXTENSION_CHECKS: ExtensionChecks = "required";

export const NEVER_PATH = "/api/v1/message/typing";
export const UNKNOWN_WRITE_PATH = "/api/v1/pb-selftest-unknown";
const PERMITTED_PATH = "/api/v1/pb-selftest";

export interface SelfTestDeps {
  probe: (kind: ProbeKind, method: "GET" | "POST", path: string, marker: string, deadlineMono: number) => Promise<ProbeOutcome>;
  /** Closed-exit refusals of the probes' host (port 443) since `sinceMono`. */
  closedExitRefusalsSince: (sinceMono: number) => number;
  /** The kernel check's result file, parsed (throws when unreadable). */
  readKernelResult: () => unknown;
  extension: ExtensionChecks;
  /** The whole test (plan §4.14: 10 s). */
  maxMs: number;
  /** One probe at most (it must end well within the whole test). */
  probeMs?: number;
}

export async function runSelfTest(deps: SelfTestDeps): Promise<SelfTestResult> {
  const startedMono = monoMs();
  const endMono = startedMono + deps.maxMs;
  const probeMs = deps.probeMs ?? 4000;
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const probeDeadline = () => Math.min(endMono, monoMs() + probeMs);

  const proxyClosed = await checkProxyClosed(deps, run, probeDeadline);
  const osRules = checkOsRules(deps);
  let never: Check = { status: "not_installed", detail: "this image has no rules extension" };
  let write: Check = { status: "not_installed", detail: "this image has no rules extension" };
  if (deps.extension === "required") {
    // On the first start of a profile the policy is still installing the
    // extension: tried again while the test's time lasts.
    for (let attempt = 0; ; attempt++) {
      never = await checkBlocked(deps, "never", NEVER_PATH, `${run}-never${attempt}`, probeDeadline);
      write = await checkBlocked(deps, "write", UNKNOWN_WRITE_PATH, `${run}-write${attempt}`, probeDeadline);
      if ((never.status === "passed" && write.status === "passed") || monoMs() + 700 >= endMono) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const checks: Record<Mechanism, Check> = { proxy_closed: proxyClosed, os_rules: osRules, dnr_never: never, dnr_write: write };
  const failed = MECHANISMS.find((mechanism) => checks[mechanism].status === "failed") ?? null;
  return { ok: failed === null, atWall: wallMs(), durationMs: Math.round(monoMs() - startedMono), failed, checks };
}

async function checkProxyClosed(deps: SelfTestDeps, run: string, deadline: () => number): Promise<Check> {
  const since = monoMs();
  let outcome: ProbeOutcome;
  try {
    outcome = await deps.probe("permitted", "GET", PERMITTED_PATH, `${run}-exit`, deadline());
  } catch (error) {
    return { status: "failed", detail: `the probe could not be sent: ${errorMessage(error)}` };
  }
  const refusals = deps.closedExitRefusalsSince(since);
  if (outcome.errorText === null) return { status: "failed", detail: "the probe did not end in time (still queued)" };
  if (outcome.answered) return { status: "failed", detail: "the probe was answered: it went out" };
  if (!outcome.paused) return { status: "failed", detail: `the probe never reached the interception (${outcome.errorText})` };
  if (!outcome.errorText.includes("ERR_TUNNEL_CONNECTION_FAILED")) return { status: "failed", detail: `the probe failed otherwise: ${outcome.errorText}` };
  if (refusals < 1) return { status: "failed", detail: "the proxy's journal has no closed-exit refusal for the probe" };
  return { status: "passed", detail: `refused by the closed exit (${outcome.errorText})` };
}

async function checkBlocked(deps: SelfTestDeps, kind: ProbeKind, path: string, marker: string, deadline: () => number): Promise<Check> {
  let outcome: ProbeOutcome;
  try {
    outcome = await deps.probe(kind, "POST", path, marker, deadline());
  } catch (error) {
    return { status: "failed", detail: `the probe could not be sent: ${errorMessage(error)}` };
  }
  if (outcome.errorText === null) return { status: "failed", detail: "the probe did not end in time (still queued)" };
  if (outcome.answered) return { status: "failed", detail: "the probe was answered: it went out" };
  // The operator fails what reaches it with the same error: only a request
  // that never paused was stopped by the extension.
  if (outcome.paused) return { status: "failed", detail: "the extension let it through: the operator stopped it" };
  if (!outcome.errorText.includes("ERR_BLOCKED_BY_CLIENT")) return { status: "failed", detail: `the probe failed otherwise: ${outcome.errorText}` };
  return { status: "passed", detail: "cancelled by the extension" };
}

function checkOsRules(deps: SelfTestDeps): Check {
  let result: unknown;
  try {
    result = deps.readKernelResult();
  } catch (error) {
    return { status: "failed", detail: `no result of the kernel check: ${errorMessage(error)}` };
  }
  const report = (result ?? {}) as { ok?: unknown; results?: unknown };
  if (!Array.isArray(report.results) || report.results.length === 0) return { status: "failed", detail: "the kernel check's result has no checks" };
  const missed = report.results.filter((entry) => (entry as { pass?: unknown }).pass !== true).map((entry) => {
    const { user, what } = entry as { user?: unknown; what?: unknown };
    return `${String(user ?? "?")}: ${String(what ?? "?")}`;
  });
  if (report.ok !== true || missed.length > 0) return { status: "failed", detail: `the kernel check failed: ${missed.join("; ") || "not ok"}` };
  return { status: "passed", detail: `${report.results.length} kernel checks passed` };
}
