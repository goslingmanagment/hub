// The browser's health while it is under control (stage 1, §3.2). Chrome's
// network service once crashed on the stand: Chrome restarted it by itself,
// the CDP connection stayed up — and the page never answered again. None of
// that is a lost connection, so every 2 s: the work tab is there and answers
// a trivial evaluate within 5 s (three misses in a row: hung — a busy page
// on its container's CPU can miss one or two, and a lost browser is a
// restart of Chrome; an error that says the target is gone or crashed is a
// miss too, any other error answer — a context replaced by a navigation —
// shows a live renderer), and the network service is still the same
// process. Any of that failing is treated as a lost browser.

import { CdpError, type Cdp } from "../cdp/client.ts";
import type { BrowserControl } from "../cdp/control.ts";
import type { ChromeControl } from "./chrome.ts";

/** Misses in a row that make a hung tab. */
export const HEALTH_MISSES = 3;

/** CDP's answers for a tab that is no more. */
const DEAD_TARGET = /crash|no target|no session|not found|detached|closed/i;

export interface HealthOptions {
  everyMs: number;
  answerMs: number;
  onUnhealthy: (reason: string) => void;
}

export class HealthProbe {
  readonly #cdp: Cdp;
  readonly #control: BrowserControl;
  readonly #chrome: ChromeControl;
  readonly #options: HealthOptions;
  #timer: NodeJS.Timeout | null = null;
  #probing = false;
  #misses = 0;
  #networkPid: number | null = null;

  constructor(cdp: Cdp, control: BrowserControl, chrome: ChromeControl, options: HealthOptions) {
    this.#cdp = cdp;
    this.#control = control;
    this.#chrome = chrome;
    this.#options = options;
  }

  start(): void {
    this.stop();
    this.#misses = 0;
    this.#networkPid = this.#chrome.networkServicePid();
    this.#timer = setInterval(() => void this.#tick(), this.#options.everyMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #tick(): Promise<void> {
    if (this.#probing || !this.#timer) return;
    const tab = this.#control.workTab;
    if (!tab) {
      this.stop();
      this.#options.onUnhealthy("the work tab is gone");
      return;
    }
    this.#probing = true;
    try {
      let answered = true;
      try {
        await this.#cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }, tab.sessionId, this.#options.answerMs);
      } catch (error) {
        answered = error instanceof CdpError && !DEAD_TARGET.test(error.message);
      }
      if (!this.#timer) return;
      this.#misses = answered ? 0 : this.#misses + 1;
      const pid = this.#chrome.networkServicePid();
      const restarted = this.#networkPid !== null && pid !== null && pid !== this.#networkPid;
      if (this.#networkPid === null) this.#networkPid = pid;
      if (restarted || this.#misses >= HEALTH_MISSES) {
        this.stop();
        this.#options.onUnhealthy(restarted ? "Chrome's network service restarted" : "the work tab stopped answering");
      }
    } finally {
      this.#probing = false;
    }
  }
}
