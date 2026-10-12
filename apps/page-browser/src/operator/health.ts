// The browser's health while it is under control (stage 1, §3.2). Chrome's
// network service once crashed on the stand: Chrome restarted it by itself,
// the CDP connection stayed up — and the page never answered again. None of
// that is a lost connection, so every 2 s: the work tab answers a trivial
// evaluate within 5 s (two misses in a row: hung), and the network service
// is still the same process. Either failing is treated as a lost browser.

import { CdpUnanswered, type Cdp } from "../cdp/client.ts";
import type { BrowserControl } from "../cdp/control.ts";
import type { ChromeControl } from "./chrome.ts";

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
    const tab = this.#control.workTab;
    if (this.#probing || !tab || !this.#timer) return;
    this.#probing = true;
    try {
      let answered = true;
      try {
        await this.#cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }, tab.sessionId, this.#options.answerMs);
      } catch (error) {
        // Any answer counts, an error too: the renderer handles commands.
        answered = !(error instanceof CdpUnanswered);
      }
      if (!this.#timer) return;
      this.#misses = answered ? 0 : this.#misses + 1;
      const pid = this.#chrome.networkServicePid();
      const restarted = this.#networkPid !== null && pid !== null && pid !== this.#networkPid;
      if (this.#networkPid === null) this.#networkPid = pid;
      if (restarted || this.#misses >= 2) {
        this.stop();
        this.#options.onUnhealthy(restarted ? "Chrome's network service restarted" : "the work tab stopped answering");
      }
    } finally {
      this.#probing = false;
    }
  }
}
