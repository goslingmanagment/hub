// Chrome's process, through s6 (plan §3.1): Chrome runs as pb-chrome, and
// the operator — pb-operator — cannot start or signal another user's
// process. The image lets pb-operator control that one service
// (s6/scripts/chrome-control); this is the only way the operator touches
// Chrome's process.
//
// - start: `s6-svc -o` — up once: a Chrome that dies stays down, and the
//   operator decides about the next start (plan §4.1), not s6;
// - stop: `s6-svc -d` — SIGTERM, SIGKILL after 5 s (s6-rc.d/chrome/timeout-kill);
// - kill: `s6-svc -K -d` — SIGKILL to Chrome's whole process group at once.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { sleep } from "../shared/util.ts";

export interface ChromeControl {
  /** Start Chrome once: s6 does not restart it when it dies. */
  start(): Promise<void>;
  /** A planned stop; resolves once Chrome is down. */
  stop(): Promise<void>;
  /** At once; resolves once Chrome is down. */
  kill(): Promise<void>;
  isUp(): Promise<boolean>;
  /** The pid of Chrome's network service, null when there is none. */
  networkServicePid(): number | null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

export class S6Chrome implements ChromeControl {
  readonly #service: string;
  readonly #chromeUid: number;

  constructor(service = "/run/service/chrome", chromeUid = 1001) {
    this.#service = service;
    this.#chromeUid = chromeUid;
  }

  async start(): Promise<void> {
    await run("/command/s6-svc", ["-o", this.#service]);
  }

  async stop(): Promise<void> {
    await run("/command/s6-svc", ["-d", this.#service]);
    await this.#waitDown(8000);
  }

  async kill(): Promise<void> {
    await run("/command/s6-svc", ["-K", "-d", this.#service]);
    await this.#waitDown(3000);
  }

  async isUp(): Promise<boolean> {
    const state = (await run("/command/s6-svstat", ["-o", "up", this.#service])).trim();
    if (state === "true") return true;
    if (state === "false") return false;
    throw new Error("s6 did not report whether Chrome is up");
  }

  async #waitDown(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (await this.isUp()) {
      if (Date.now() > deadline) throw new Error(`Chrome is still up ${timeoutMs} ms after the stop`);
      await sleep(100);
    }
  }

  /** Chrome restarts a crashed network service by itself and says nothing
   *  over CDP (stage 1, §3.2): the operator watches its pid. */
  networkServicePid(): number | null {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = readFileSync(`/proc/${name}/status`, "utf8");
        if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== this.#chromeUid) continue;
        if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes("--utility-sub-type=network.mojom.NetworkService")) return Number(name);
      } catch {
        // gone meanwhile
      }
    }
    return null;
  }
}
