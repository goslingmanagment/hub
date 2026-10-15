// The runner's side of the stand's Fansly control (fansly/control.ts): its
// journal — the truth of what arrived — its faults and its settings.

import { request } from "node:http";

import type { FrontConfig, SiteBehaviour } from "../fansly/front.ts";
import type { JournalEvent, JournalPage } from "../fansly/journal.ts";

export type { JournalEvent, SiteBehaviour };

function json(host: string, port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host, port, method, path, timeout: 30_000, headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 300) return reject(new Error(`stand fansly ${method} ${path}: ${res.statusCode ?? 0} ${raw.slice(0, 300)}`));
          try {
            resolve(raw === "" ? null : JSON.parse(raw));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`stand fansly ${method} ${path}: no answer`)));
    req.end(payload);
  });
}

export interface StandState {
  mono: number;
  config: FrontConfig;
  socks: { down: boolean; refuseAuth: boolean; connectDelayMs: number; hold: { host: string; ms: number } | null; open: number };
  sockets: Array<{ wsId: string; socksId: number | null; from: string | null; received: number }>;
  lastSeq: number;
}

export class StandFansly {
  readonly host: string;
  readonly port: number;

  constructor(host: string, port = 8080) {
    this.host = host;
    this.port = port;
  }

  async health(): Promise<boolean> {
    try {
      await json(this.host, this.port, "GET", "/health");
      return true;
    } catch {
      return false;
    }
  }

  /** The journal's last number: a run reads what came after it. */
  async mark(): Promise<number> {
    return (await this.state()).lastSeq;
  }

  /** Everything after `since`, however long. */
  async journal(since: number): Promise<JournalEvent[]> {
    const events: JournalEvent[] = [];
    let cursor = since;
    for (;;) {
      const page = (await json(this.host, this.port, "GET", `/journal?since=${cursor}&limit=20000`)) as JournalPage;
      if (page.firstKept > cursor + 1) throw new Error(`the stand's journal dropped events ${cursor + 1}…${page.firstKept - 1}: the run is longer than the journal keeps`);
      events.push(...page.events);
      if (page.events.length === 0 || page.next === cursor) return events;
      cursor = page.next;
    }
  }

  async state(): Promise<StandState> {
    return (await json(this.host, this.port, "GET", "/state")) as StandState;
  }

  async config(settings: Partial<Omit<FrontConfig, "wsPush">> & { wsPush?: { perMinute: number; bytes?: number } }): Promise<void> {
    await json(this.host, this.port, "POST", "/config", settings);
  }

  async socks(fault: { down?: boolean; refuseAuth?: boolean; connectDelayMs?: number; hold?: { host: string; ms: number } | null; extraLogin?: { username: string; password: string } | null }): Promise<void> {
    await json(this.host, this.port, "POST", "/socks", fault);
  }

  /** Every connection of the front dropped — or every one of `host` (the
   *  next request there reconnects). */
  async drop(host?: string): Promise<void> {
    await json(this.host, this.port, "POST", "/drop", host === undefined ? {} : { host });
  }

  async reset(): Promise<void> {
    await json(this.host, this.port, "POST", "/reset", {});
  }

  async push(bytes: number, wsId?: string): Promise<number> {
    return ((await json(this.host, this.port, "POST", "/ws/push", wsId === undefined ? { bytes } : { bytes, wsId })) as { sent: number }).sent;
  }
}
