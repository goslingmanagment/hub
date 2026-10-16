// The exit is already closed. Give the current Chrome one short chance to
// write its profile, then require its process to be down before its gate
// ownership is released. Called inside the operator's Chrome serial queue.
import { performance } from "node:perf_hooks";
import type { Cdp } from "../cdp/client.ts";
import type { Logger } from "../shared/util.ts";
import type { ChromeControl } from "./chrome.ts";

const MAX_QUIT_MS = 2000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bounded<T>(operation: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation.catch(() => fallback), new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(1, ms)); })]);
  } finally { clearTimeout(timer); }
}

export async function quitChromeAfterFailure(cdp: Pick<Cdp, "cdpUp" | "send">, chrome: ChromeControl, requestedMs: number, log: Logger): Promise<void> {
  const waitMs = Number.isFinite(requestedMs) ? Math.max(1, Math.min(requestedMs, MAX_QUIT_MS)) : MAX_QUIT_MS;
  const began = performance.now();
  const left = () => Math.max(0, waitMs - (performance.now() - began));
  const couldClose = cdp.cdpUp;
  let answered = false;
  if (couldClose) {
    try {
      // The command has the same deadline as the process wait, not an
      // additional deadline: a stuck CDP consumes no second grace period.
      await bounded(cdp.send("Browser.close", {}, undefined, waitMs).then(() => { answered = true; }), left(), undefined);
    } catch { /* no answer: the process may still have exited */ }
    do {
      const up = await bounded(chrome.isUp(), Math.min(100, left()), true);
      if (!up) {
        log("chrome.failure_quit", { outcome: "exited_after_close", answered, elapsedMs: Math.round(performance.now() - began), deadlineMs: waitMs });
        return;
      }
      if (left() <= 0) break;
      await delay(Math.min(25, left()));
    } while (left() > 0);
  }
  // kill() resolves only when s6 observed the process down. A failure is
  // propagated: the caller must not declare the browser's ownership gone.
  await chrome.kill();
  log("chrome.failure_quit", { outcome: "killed", why: couldClose ? "quit_deadline" : "cdp_unavailable", answered, elapsedMs: Math.round(performance.now() - began), deadlineMs: waitMs });
}
